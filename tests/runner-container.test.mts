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
import { makeCanary } from '@ecclium/mcp-churchtools-testkit';
import { afterAll, describe, expect, it } from 'vitest';

import { exitCodes } from '../packages/cli/src/exit-codes.ts';
import { runnerSignals } from '../packages/cli/src/runner/host.ts';
import { exitCodeOf } from '../packages/cli/src/runner/run-once.ts';
import { stateFolders } from '../packages/core/src/config/state-dir.ts';
import { transportLimits } from '../packages/core/src/http/transport.ts';
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
    const state = documented.get('ECCLIUM_STATE_DIR');
    for (const { path } of paths) {
      if (path === '/tmp') continue;
      const used =
        path === `${state ?? ''}/${stateFolders.stop}` ||
        [...documented.values()].some((value) => liesWithin(value, path));
      expect(used, path).toBe(true);
    }
  });

  it('mounts the kill switches over the folder stop of the state', () => {
    expect(paths.map(({ path }) => path)).toContain(
      `${documented.get('ECCLIUM_STATE_DIR') ?? ''}/${stateFolders.stop}`,
    );
  });
});

describe('the folders in the folder of state', () => {
  it('are the folders the code keeps there', () => {
    const named = folderRows.map(([folder = '']) => plain(folder));
    expect(named.sort()).toEqual(Object.values(stateFolders).sort());
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
    folder(`${value('ECCLIUM_STATE_DIR')}/${stateFolders.stop}`, 0o755);
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

  // A write of a run to a page named by its ID, counted in the code on
  // 13.11.2026: the state of the page, then the rights, the page and the
  // name of the category for the plan, then the page, the name, the update
  // and the read after it for the commit, each within the total time of
  // the transport, and two counts in the store of quotas. A signal never
  // stops it, so the grace of the container must cover all of it. The
  // search of a page by its title, which may come before, is not covered
  // (ADR 0036, residual risks).
  it('covers a write that has begun with the grace of the lock', () => {
    const requestsOfAWrite = 8;
    const quotaCountsOfAWrite = 2;
    expect(routineLockLimits.graceMs).toBeGreaterThanOrEqual(
      requestsOfAWrite * transportLimits.totalMs +
        quotaCountsOfAWrite * quotaTimeoutMs,
    );
    const text = signalSection.join('\n');
    const seconds =
      (requestsOfAWrite * transportLimits.totalMs +
        quotaCountsOfAWrite * quotaTimeoutMs) /
      1000;
    expect(text).toContain(
      `bis zu acht Anfragen an ChurchTools mit je höchstens ${String(transportLimits.totalMs / 1000)} Sekunden`,
    );
    expect(text).toContain(
      `zusammen also höchstens ${String(seconds)} Sekunden`,
    );
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
