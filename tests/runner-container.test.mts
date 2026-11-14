import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadConfig,
  variableNames,
  variables,
} from '@ecclium/mcp-churchtools-core';
import type { HttpTransportOptions } from '@ecclium/mcp-churchtools-core/http';
import {
  createChurchToolsDouble,
  makeCanary,
} from '@ecclium/mcp-churchtools-testkit';
import { afterAll, describe, expect, it } from 'vitest';

import { exitCodes } from '../packages/cli/src/exit-codes.ts';
import { adoptMarker } from '../packages/cli/src/marker/adopt.ts';
import { proposeRoutineEntry } from '../packages/cli/src/policy/routine.ts';
import { runQueue } from '../packages/cli/src/queue/queue.ts';
import { undoWrite } from '../packages/cli/src/undo/undo.ts';
import { runnerSignals } from '../packages/cli/src/runner/host.ts';
import { exitCodeOf } from '../packages/cli/src/runner/run-once.ts';
import { stateFolders } from '../packages/core/src/config/state-dir.ts';
import { transportLimits } from '../packages/core/src/http/transport.ts';
import { maxRunWriteRequests } from '../packages/core/src/pipeline/run-write.ts';
import { quotaTimeoutMs } from '../packages/core/src/quota/budget.ts';
import { routineLockLimits } from '../packages/core/src/schedule/lock.ts';
import { metricNames } from '../packages/runner/src/metrics.ts';
import { runnerSeverities } from '../packages/runner/src/outcome.ts';

// The runner container contract (ADR 0036) lives in the tables of the
// page for operators. These checks hold the tables and the code together
// in both directions: what the page names must exist in the code, and what
// the code has must stand on the page. The environment the page gives is
// loaded as a configuration of the runner, with every path moved below a
// folder of the test, so that the rules of the loader on which folder may
// lie inside which check the contract itself.

const runnerPage = readFileSync(
  new URL('../docs/betrieb/runner.md', import.meta.url),
  'utf8',
);
const doctorPage = readFileSync(
  new URL('../docs/betrieb/doctor.md', import.meta.url),
  'utf8',
);

/** The lines of a section, from its heading to the next of its level. */
const sectionOf = (text: string, heading: string): string[] => {
  const lines = text.split('\n');
  const start = lines.indexOf(heading);
  expect(start, `heading ${heading}`).toBeGreaterThanOrEqual(0);
  const level = /^#+/.exec(heading)?.[0].length ?? 0;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => {
    const hashes = /^(#+) /.exec(line)?.[1]?.length;
    return hashes !== undefined && hashes <= level;
  });
  return end === -1 ? rest : rest.slice(0, end);
};

/** The rows of the first table in some lines, without header and rule. */
const tableOf = (lines: readonly string[]): string[][] => {
  const start = lines.findIndex((line) => line.startsWith('|'));
  expect(start, 'a table').toBeGreaterThanOrEqual(0);
  const rows: string[][] = [];
  for (const line of lines.slice(start)) {
    if (!line.startsWith('|')) break;
    rows.push(
      line
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim()),
    );
  }
  // The header and the rule under it.
  return rows.slice(2);
};

/** The text of a cell without the backticks of code. */
const plain = (cell: string): string => cell.replace(/^`(.*)`$/, '$1');

const containerSection = sectionOf(runnerPage, '## Container');
const pathRows = tableOf(sectionOf(containerSection.join('\n'), '### Pfade'));
const variableRows = tableOf(
  sectionOf(containerSection.join('\n'), '### Variablen'),
);
const folderRows = tableOf(
  sectionOf(containerSection.join('\n'), '### Ordner im Zustandsordner'),
);
const signalSection = sectionOf(runnerPage, '## Signale');
const exitSection = sectionOf(runnerPage, '## Exit-Codes');

const documented = new Map(
  variableRows.map(([name = '', value = '']) => [plain(name), plain(value)]),
);
const paths = pathRows.map(([path = '', access = '']) => ({
  path: plain(path),
  access,
}));

// Whether a path is a folder or lies in it, by its parts.
const liesWithin = (path: string, folder: string): boolean =>
  path === folder || path.startsWith(`${folder}/`);

describe('the variables of the runner container', () => {
  it('names each variable once', () => {
    expect(documented.size).toBe(variableRows.length);
  });

  it('names only variables the runner may set', () => {
    for (const name of documented.keys()) {
      expect(variableNames).toContain(name);
      const row = variables.find((variable) => variable.name === name);
      expect(row?.runner, name).toBe(true);
      expect(row?.secret, name).toBe(false);
    }
  });

  it('names every path of the runner and its proxy', () => {
    const expected = variables
      .filter((variable) => variable.runner && variable.kind === 'path')
      .map((variable) => variable.name)
      .concat(['ECCLIUM_EGRESS_PROXY']);
    expect([...documented.keys()].sort()).toEqual([...expected].sort());
  });

  it('puts every path below a path of the table of paths', () => {
    for (const [name, value] of documented) {
      if (!value.startsWith('/')) continue;
      expect(
        paths.some(({ path }) => liesWithin(value, path)),
        `${name} ${value}`,
      ).toBe(true);
    }
  });
});

describe('the paths of the runner container', () => {
  it('writes only below /data, /keys and the tmpfs', () => {
    const writable = paths
      .filter(({ access }) => access.startsWith('schreibbar'))
      .map(({ path }) => path);
    expect(writable.sort()).toEqual(['/data', '/keys', '/tmp']);
    expect(
      paths
        .filter(({ access }) => !access.startsWith('schreibbar'))
        .every(({ access }) => access === 'nur lesbar'),
    ).toBe(true);
  });

  it('uses every path of the table', () => {
    for (const { path } of paths) {
      if (path === '/tmp') continue;
      const used = [...documented.values()].some((value) =>
        liesWithin(value, path),
      );
      expect(used, path).toBe(true);
    }
  });

  // The kill switches come with /config into every container, read-only,
  // never into the volume of the state, where Docker made a folder stop
  // of its own (ADR 0029, ADR 0036).
  it('keeps the kill switches in a read-only path of their own outside /data', () => {
    const switches = documented.get('ECCLIUM_KILL_SWITCH_DIR') ?? '';
    expect(paths.map(({ path }) => path)).toContain(switches);
    expect(paths.find(({ path }) => path === switches)?.access).toBe(
      'nur lesbar',
    );
    const config = paths.find(
      ({ path }) => liesWithin(switches, path) && path !== switches,
    );
    expect(config?.access).toBe('nur lesbar');
    expect(
      liesWithin(switches, documented.get('ECCLIUM_STATE_DIR') ?? ''),
    ).toBe(false);
  });
});

// The E2E job runs the runner after the contract (scripts/e2e/, ADR 0036):
// its compose file is the one place of the limits, and it sets the
// variables and paths of the tables with their values.
const e2eCompose = readFileSync(
  new URL('../scripts/e2e/compose.yaml', import.meta.url),
  'utf8',
);
const e2eRunner =
  /^ {2}runner:\n((?: {4}.*\n|\n)*)/m.exec(e2eCompose)?.[1] ?? '';

describe('the runner container of the E2E job', () => {
  it('runs with the limits of the table', () => {
    const rows = tableOf(sectionOf(containerSection.join('\n'), '### Grenzen'));
    const settings = rows.map(([, , setting = '']) => plain(setting));
    expect(settings.sort()).toEqual(['mem_limit: 256m', 'pids_limit: 32']);
    for (const setting of settings) {
      expect(e2eRunner).toMatch(new RegExp(`^ {4}${setting}$`, 'm'));
    }
    const values = Object.fromEntries(
      rows.map(([limit = '', value = '']) => [limit, value]),
    );
    expect(values).toEqual({ Prozesse: '32', Speicher: '256 MiB' });
  });

  it('sets each variable of the table it sets with the value of the table', () => {
    const set = [...e2eRunner.matchAll(/^ {6}(ECCLIUM_\w+): (\S+)$/gm)].map(
      ([, name = '', value = '']) => [name, value.replace(/^'(.*)'$/, '$1')],
    );
    expect(set.length).toBeGreaterThan(10);
    for (const [name = '', value] of set) {
      if (documented.has(name)) expect(value, name).toBe(documented.get(name));
    }
  });

  it('mounts the paths of the table read-only or writable as the table says', () => {
    expect(e2eRunner).toMatch(/^ {6}- \$\{E2E_WORK:\?\}\/config:\/config:ro$/m);
    expect(e2eRunner).toMatch(
      /^ {6}- \$\{E2E_WORK:\?\}\/secrets:\/run\/secrets:ro$/m,
    );
    expect(e2eRunner).toMatch(/^ {6}- data:\/data$/m);
    expect(e2eRunner).toMatch(/^ {6}- keys:\/keys$/m);
    expect(e2eRunner).toMatch(/^ {4}user: '65532:65532'$/m);
    expect(e2eRunner).toMatch(/^ {4}init: true$/m);
    // The hardening comes through the anchor; without the merge the runner
    // would write anywhere and keep its capabilities.
    expect(e2eRunner).toMatch(/^ {4}<<: \*locked$/m);
    const locked =
      /^x-locked: &locked\n((?: {2}.*\n)*)/m.exec(e2eCompose)?.[1] ?? '';
    expect(locked.split('\n').filter(Boolean)).toEqual([
      '  read_only: true',
      '  tmpfs: [/tmp]',
      '  cap_drop: [ALL]',
      '  security_opt: [no-new-privileges:true]',
    ]);
    expect(e2eRunner).toMatch(/^ {4}networks: \[runner-int\]$/m);
    expect(e2eRunner).not.toMatch(/ports:/);
  });
});

describe('the folders in the folder of state', () => {
  // The folder stop is only the default of a server over stdio; the runner
  // reads its kill switches from ECCLIUM_KILL_SWITCH_DIR (ADR 0036).
  it('are the folders the code keeps there, without the folder stop', () => {
    const named = folderRows.map(([folder = '']) => plain(folder));
    expect(named.sort()).toEqual(
      Object.values(stateFolders)
        .filter((folder) => folder !== stateFolders.stop)
        .sort(),
    );
  });
});

describe('the environment of the runner container', () => {
  const bases: string[] = [];
  afterAll(() => {
    for (const base of bases) rmSync(base, { recursive: true, force: true });
  });

  // Every path of the contract moved below one folder of the test, with
  // real files of the user in it, as the container holds them.
  const build = (): Record<string, string> => {
    const base = mkdtempSync(join(tmpdir(), 'ecclium-container-'));
    bases.push(base);
    const at = (path: string): string => `${base}${path}`;
    const folder = (path: string, mode: number): void => {
      mkdirSync(at(path), { recursive: true, mode });
      chmodSync(at(path), mode);
    };
    const file = (path: string, text: string, mode = 0o600): void => {
      writeFileSync(at(path), text, { mode });
      chmodSync(at(path), mode);
    };
    const hex = (seed: string): string =>
      `${createHash('sha256').update(seed).digest('hex')}\n`;
    const value = (name: string): string => {
      const found = documented.get(name);
      expect(found, name).toBeDefined();
      return found ?? '';
    };
    folder(value('ECCLIUM_STATE_DIR'), 0o700);
    // Only the folder of the variable: the load that writes shows that the
    // runner takes it, since there is no folder stop in the state.
    folder(value('ECCLIUM_KILL_SWITCH_DIR'), 0o755);
    folder(value('ECCLIUM_KEYS_DIR'), 0o700);
    folder(value('ECCLIUM_ROUTINES_DIR'), 0o755);
    folder(value('ECCLIUM_RUNNER_TOKENS_DIR'), 0o700);
    file(
      value('ECCLIUM_POLICY_FILE'),
      'schema: policy.v1\ninteractive:\n  inquiriesTo: Sekretariat\nunattended: []\n',
      0o644,
    );
    const modelKey = `${value('ECCLIUM_RUNNER_TOKENS_DIR')}/model_api_key`;
    file(modelKey, 'platzhalter-schluessel-ohne-wert\n');
    file(
      value('ECCLIUM_PROVIDERS_FILE'),
      [
        'schema: providers.v1',
        'providers:',
        '  - alias: default',
        '    vendor: example',
        '    model: example-model-1',
        '    hostingCountry: CH',
        '    endpoint: https://model.example.org/v1/chat/completions',
        '    structuredOutput: true',
        `    apiKeyFile: ${at(modelKey)}`,
        '',
      ].join('\n'),
      0o644,
    );
    file(
      `${value('ECCLIUM_RUNNER_TOKENS_DIR')}/ct_token_runner`,
      `${makeCanary('token').value}\n`,
    );
    file(value('ECCLIUM_PSEUDONYM_KEY_FILE'), hex('container-current'));
    file(value('ECCLIUM_PSEUDONYM_KEY_PREVIOUS_FILE'), hex('container-before'));
    file(value('ECCLIUM_MARKER_KEY_FILE'), hex('container-marker'));
    file(
      value('ECCLIUM_RUNNER_PING_URL_FILE'),
      'https://health.example.org/ping/container-contract\n',
    );
    const environment: Record<string, string> = {
      ECCLIUM_CHURCHTOOLS_URL: 'https://example.church.tools',
      ECCLIUM_TIME_ZONE: 'Europe/Zurich',
    };
    for (const [name, raw] of documented) {
      environment[name] = raw.startsWith('/') ? at(raw) : raw;
    }
    return environment;
  };

  it.each([
    ['reads only', {}],
    ['writes to the wiki', { ECCLIUM_READ_ONLY: 'false' }],
  ] as const)(
    'loads as a configuration of the runner when it %s',
    (_, extra) => {
      const result = loadConfig({
        environment: { ...build(), ...extra },
        transport: 'runner',
        execArgv: [],
      });
      expect(result.report.problems).toEqual([]);
      expect(result.ok).toBe(true);
    },
  );

  // The commands about a run run with the same environment as the runner
  // (ADR 0036). Each gets as far as its configuration lets it, without a
  // request to ChurchTools: an unknown run or routine, an empty queue. With
  // the token file of the server they all end with 78.
  const commands = (environment: Record<string, string>) => {
    const lines: string[] = [];
    const output = {
      stdout: (line: string) => lines.push(line) > 0,
      stderr: (line: string) => lines.push(line) > 0,
    };
    const runId = '00000000-0000-4000-8000-00000000c0de';
    const requests: unknown[] = [];
    const createTransport = (given: HttpTransportOptions) => {
      const double = createChurchToolsDouble({
        token: given.token,
        origin: given.origin,
      });
      return Object.freeze({
        ...double.transport,
        close: async () => {
          requests.push(...double.calls());
          await double.close();
        },
      });
    };
    const common = {
      environment,
      execArgv: [],
      output,
      writeSync: (_fd: number, _b: Uint8Array, _o: number, length: number) =>
        length,
    };
    return {
      lines,
      requests,
      run: async () => [
        await undoWrite({ ...common, runId, overwrite: false }),
        await runQueue({
          ...common,
          action: 'list',
          runner: true,
          createTransport,
        }),
        await adoptMarker({ ...common, runId }),
        await proposeRoutineEntry({
          ...common,
          routine: 'unbekannt-test',
          credential: 'berichte',
          createTransport,
        }),
      ],
    };
  };

  it('takes the commands about a run as far as their configuration lets them', async () => {
    const called = commands({ ...build(), ECCLIUM_READ_ONLY: 'false' });
    // 66 for a run no line names, 0 for an empty queue, 64 for a routine
    // the folder does not hold; 78 would be a configuration refused.
    expect(await called.run()).toEqual([
      exitCodes.noInput,
      exitCodes.ok,
      exitCodes.noInput,
      exitCodes.usage,
    ]);
    expect(called.requests).toEqual([]);
  });

  it('ends every command about a run with 78 while the token file of the server is set', async () => {
    const environment = build();
    const tokenFile = `${environment.ECCLIUM_RUNNER_TOKENS_DIR ?? ''}/ct_token_server`;
    writeFileSync(tokenFile, `${makeCanary('token').value}\n`, {
      mode: 0o600,
    });
    const called = commands({
      ...environment,
      ECCLIUM_READ_ONLY: 'false',
      ECCLIUM_CHURCHTOOLS_TOKEN_FILE: tokenFile,
    });
    expect(await called.run()).toEqual([
      exitCodes.invalidConfig,
      exitCodes.invalidConfig,
      exitCodes.invalidConfig,
      exitCodes.invalidConfig,
    ]);
    expect(called.requests).toEqual([]);
  });

  // Why /keys and /run/secrets stand outside /data: the loader refuses
  // both inside the folder of state, so that a backup of it holds no keys
  // and no tokens.
  it.each([
    ['ECCLIUM_KEYS_DIR', 'keys_dir_in_state_dir'],
    ['ECCLIUM_RUNNER_TOKENS_DIR', 'runner_tokens_dir_in_state_dir'],
  ] as const)('is refused with %s inside /data', (name, code) => {
    const environment = build();
    const inside = `${environment.ECCLIUM_STATE_DIR ?? ''}/inside`;
    mkdirSync(inside, { mode: 0o700 });
    const result = loadConfig({
      environment: { ...environment, [name]: inside },
      transport: 'runner',
      execArgv: [],
    });
    expect(result.report.problems.map((problem) => problem.code)).toContain(
      code,
    );
  });
});

describe('the signals of the runner', () => {
  it('end the process with the codes of the table', () => {
    const rows = tableOf(signalSection).map(([signal = '', code = '']) => [
      signal,
      Number(code),
    ]);
    expect(rows).toEqual(
      runnerSignals.map(({ signal, code }) => [signal, code]),
    );
  });

  // A write of a run once the core has found its page, as a test of the
  // pipeline counts it (maxRunWriteRequests): the rights and the page for
  // the plan, the page, the update and the read after it for the commit,
  // and for an entry of a whole category its name at the plan and at the
  // commit, each within the total time of the transport, and a read and a
  // raise of the counter of the day in the store of quotas. A signal never
  // stops it, so the grace of the container must cover it, with room for
  // two requests more. The search of the page before it ends on the signal
  // (ADR 0036).
  it('covers a write that has begun with the grace of the lock', () => {
    const spareRequests = 2;
    const quotaCountsOfAWrite = 2;
    expect(routineLockLimits.graceMs).toBeGreaterThanOrEqual(
      (maxRunWriteRequests + spareRequests) * transportLimits.totalMs +
        quotaCountsOfAWrite * quotaTimeoutMs,
    );
    const counts = ['fünf', 'sechs', 'sieben', 'acht'];
    const text = signalSection.join('\n');
    expect(text).toContain(
      `bis zu ${String(counts[maxRunWriteRequests - 5])} Anfragen an ChurchTools mit je höchstens ${String(transportLimits.totalMs / 1000)} Sekunden`,
    );
    expect(text).toContain(
      `je höchstens ${String(quotaTimeoutMs / 1000)} Sekunden`,
    );
    expect(text).toContain('Platz für zwei Anfragen mehr');
  });

  it('give a container at least the grace of the lock of a routine', () => {
    const text = signalSection.join('\n');
    const minutes = routineLockLimits.graceMs / 60_000;
    expect(Number.isInteger(minutes)).toBe(true);
    expect(text).toContain(`mindestens ${String(minutes)} Minuten`);
    expect(text).toContain(`stop_grace_period: ${String(minutes)}m`);
    expect(text).toContain(`--time ${String(minutes * 60)}`);
  });
});

describe('the exit codes of the runner', () => {
  it('are the codes of its severities, of a wrong call, of the proxy and of the signals', () => {
    const documentedCodes = tableOf(exitSection).map(([code = '']) =>
      Number(code),
    );
    const expected = new Set<number>([
      ...runnerSeverities.map((severity) => exitCodeOf(severity)),
      exitCodes.usage,
      exitCodes.unavailable,
      ...runnerSignals.map(({ code }) => code),
    ]);
    expect([...documentedCodes].sort((a, b) => a - b)).toEqual(
      [...expected].sort((a, b) => a - b),
    );
  });

  it('name the order of the worst code as the code does', () => {
    const order = runnerSeverities
      .filter((severity) => severity !== 'ok')
      .map((severity) => String(exitCodeOf(severity)))
      .reverse()
      .join(', ');
    expect(exitSection.join('\n')).toContain(`in der Reihenfolge ${order}.`);
  });
});

describe('the exit codes of ecclium doctor', () => {
  it('are the codes its command names, a wrong call and an internal error', () => {
    const folder = new URL('../packages/cli/src/doctor/', import.meta.url);
    const named = new Set<number>([exitCodes.usage, exitCodes.internal]);
    for (const name of readdirSync(folder)) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
      const source = readFileSync(new URL(name, folder), 'utf8');
      for (const [, key = ''] of source.matchAll(/exitCodes\.([a-zA-Z]+)/g)) {
        const code = (exitCodes as Record<string, number>)[key];
        expect(code, key).toBeDefined();
        named.add(code ?? -1);
      }
    }
    const documentedCodes = tableOf(sectionOf(doctorPage, '## Exit-Codes')).map(
      ([code = '']) => Number(code),
    );
    expect([...documentedCodes].sort((a, b) => a - b)).toEqual(
      [...named].sort((a, b) => a - b),
    );
  });
});

describe('the metrics file of the runner', () => {
  it('shows the metrics the code writes', () => {
    const section = sectionOf(runnerPage, '## Metrikdatei');
    const start = section.indexOf('```text');
    const end = section.indexOf('```', start + 1);
    const shown = new Set(
      section
        .slice(start + 1, end)
        .map((line) => /^([a-z_]+)\{/.exec(line)?.[1]),
    );
    expect([...shown].sort()).toEqual(Object.values(metricNames).sort());
  });
});
