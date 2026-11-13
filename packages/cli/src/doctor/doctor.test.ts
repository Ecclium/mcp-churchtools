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

import { loadConfig } from '@ecclium/mcp-churchtools-core';
import type {
  DirectProbe,
  DirectProbeOptions,
  EgressTargetProbe,
  EgressTargetProbeOptions,
  HttpTransport,
  HttpTransportOptions,
} from '@ecclium/mcp-churchtools-core/http';
import {
  assertNoCanary,
  createChurchToolsDouble,
  doubleModelEndpoint,
  doubleOrigin,
  makeCanary,
  type MockedHttpTransport,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { exitCodes } from '../exit-codes.js';
import { run } from '../main.js';
import { createRunnerCatalog } from '../runner/start.js';
import { runDoctor } from './doctor.js';
import type { EgressProbes } from './egress.js';

// `ecclium doctor` over real temporary folders, the loader of the runner,
// the double of ChurchTools for ct_whoami with the token of each account
// and checks of the outbound path that the test plays. A canary in every
// folder, token and key, so that a path or a secret in the report would
// show. All data are made up.

const wikiRoutine = 'wochen-bericht';
const draftRoutine = 'termin-entwurf';
const json = { headers: { 'content-type': 'application/json' } };
const day = Date.parse('2026-11-13T10:00:00Z');

const template = [
  '### Termine {{period}}',
  '',
  '{{#termine}}',
  '- {{datum}}: {{titel}}',
  '{{/termine}}',
  '',
].join('\n');

const routineValueOf = (
  id: string,
  target: 'wiki' | 'draft',
  model = 'default',
) => ({
  schema: 'routine.v1',
  id,
  schedule: '0 6 * * MON',
  inputs: [
    {
      name: 'termine',
      tool: 'ct_events_list',
      params: { from: '+0d', to: '+14d' },
      maxItems: 30,
    },
  ],
  generate: {
    prompt: `prompts/${id}.md`,
    model,
    output: {
      blocks: {
        termine: {
          maxItems: 10,
          fields: {
            datum: { type: 'date' },
            titel: { type: 'text', maxLength: 80 },
          },
        },
      },
    },
  },
  template: `templates/${id}.md`,
  output:
    target === 'draft'
      ? { target: 'draft', channel: 'file', idempotencyKey: `${id}:{isoWeek}` }
      : {
          target: 'wiki',
          tool: 'ct_wiki_page_append_section',
          scope: { category: 'Berichte', page: 'Termine' },
          idempotencyKey: `${id}:{isoWeek}`,
        },
  notify: [{ channel: 'stdout' }],
});

const cleanup: string[] = [];
const open: MockedHttpTransport[] = [];
afterEach(async () => {
  await Promise.all(
    open.splice(0).map((double) => double.close().catch(() => undefined)),
  );
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const privateDir = (path: string): string => {
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
};

const privateFile = (path: string, text: string): string => {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
};

// The rights the tools require, from the catalog of the runner, as a
// granted answer of ChurchTools; the right to edit categories lists them.
const catalog = createRunnerCatalog({ readOnly: false });
const rightsOf = (
  tools: readonly string[],
  categories: readonly number[],
): Record<string, Record<string, true | number[]>> => {
  const granted: Record<string, Record<string, true | number[]>> = {};
  for (const tool of tools) {
    for (const { module, right } of catalog.get(tool)?.meta.requiredRights ??
      []) {
      granted[module] ??= {};
      granted[module][right] =
        module === 'churchwiki' && right === 'edit category'
          ? [...categories]
          : true;
    }
  }
  return granted;
};

/** What a test sets up differently. */
interface SetupOptions {
  /** The routines by ID, with their output and model. */
  readonly routines?: Readonly<
    Record<string, { target: 'wiki' | 'draft'; model?: string }>
  >;
  /** Further fields of the entry of the wiki routine. */
  readonly entry?: Readonly<Record<string, unknown>>;
  /** Variables to set or, with undefined, to leave out. */
  readonly extra?: Readonly<Record<string, string | undefined>>;
  /** The rights of the accounts, by alias; by default what they need. */
  readonly rights?: Readonly<Record<string, unknown>>;
  /** The status of whoami for an alias, 200 by default. */
  readonly whoamiStatus?: Readonly<Record<string, number>>;
}

const setup = (options: SetupOptions = {}) => {
  const pathCanary = makeCanary('token');
  const base = mkdtempSync(
    join(tmpdir(), `ecclium-doctor-${pathCanary.cores[0] ?? ''}-`),
  );
  cleanup.push(base);
  const stateDir = privateDir(join(base, 'state'));
  // The folder of the kill switches, which the runner requires
  // (ADR 0036).
  const stopDir = privateDir(join(stateDir, 'stop'));
  const keysDir = privateDir(join(base, 'keys'));
  const tokensDir = privateDir(join(base, 'tokens'));
  const configDir = privateDir(join(base, 'config'));
  const routinesDir = privateDir(join(base, 'routines'));
  privateDir(join(routinesDir, 'prompts'));
  privateDir(join(routinesDir, 'templates'));
  const tokens: Record<string, ReturnType<typeof makeCanary>> = {
    runner: makeCanary('token'),
    berichte: makeCanary('token'),
  };
  for (const [alias, token] of Object.entries(tokens)) {
    privateFile(join(tokensDir, `ct_token_${alias}`), `${token.value}\n`);
  }
  const modelKey = makeCanary('token');
  const modelKeyFile = privateFile(
    join(configDir, 'model-key'),
    `${modelKey.value}\n`,
  );
  const markerFile = privateFile(
    join(configDir, 'marker-key'),
    `${createHash('sha256').update('doctor-marker').digest('hex')}\n`,
  );
  const pseudonymFile = privateFile(
    join(configDir, 'pseudonym-key'),
    `${createHash('sha256').update('doctor-pseudonym').digest('hex')}\n`,
  );
  const policyFile = privateFile(
    join(configDir, 'policy.json'),
    JSON.stringify({
      schema: 'policy.v1',
      interactive: { inquiriesTo: 'Sekretariat' },
      unattended: [
        {
          routine: wikiRoutine,
          credential: 'berichte',
          modelRedaction: 'standard',
          target: { kind: 'wiki_category', id: 7, name: 'Berichte' },
          tools: ['ct_wiki_page_append_section'],
          maxPerRun: 1,
          maxPerDay: 5,
          ...options.entry,
        },
      ],
    }),
  );
  const providersFile = privateFile(
    join(configDir, 'providers.json'),
    JSON.stringify({
      schema: 'providers.v1',
      providers: [
        {
          alias: 'default',
          vendor: 'example',
          model: 'example-model-1',
          hostingCountry: 'CH',
          endpoint: doubleModelEndpoint,
          structuredOutput: true,
          apiKeyFile: modelKeyFile,
        },
        {
          alias: 'reserve',
          vendor: 'example',
          model: 'example-model-2',
          hostingCountry: 'DE',
          endpoint: 'https://reserve.example.org/v1/chat/completions',
          structuredOutput: true,
          apiKeyFile: modelKeyFile,
        },
      ],
    }),
  );
  for (const [id, routine] of Object.entries(
    options.routines ?? {
      [wikiRoutine]: { target: 'wiki' },
      [draftRoutine]: { target: 'draft' },
    },
  )) {
    privateFile(
      join(routinesDir, `${id}.yaml`),
      JSON.stringify(routineValueOf(id, routine.target, routine.model)),
    );
    privateFile(join(routinesDir, 'prompts', `${id}.md`), 'Fasse zusammen.\n');
    privateFile(join(routinesDir, 'templates', `${id}.md`), template);
  }
  const environment: Record<string, string | undefined> = {
    ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
    ECCLIUM_TIME_ZONE: 'Europe/Zurich',
    ECCLIUM_POLICY_FILE: policyFile,
    ECCLIUM_ROUTINES_DIR: routinesDir,
    ECCLIUM_STATE_DIR: stateDir,
    ECCLIUM_KILL_SWITCH_DIR: stopDir,
    ECCLIUM_RUNNER_TOKENS_DIR: tokensDir,
    ECCLIUM_PROVIDERS_FILE: providersFile,
    ECCLIUM_READ_ONLY: 'false',
    ECCLIUM_KEYS_DIR: keysDir,
    ECCLIUM_MARKER_KEY_FILE: markerFile,
    ECCLIUM_PSEUDONYM_KEY_FILE: pseudonymFile,
    ECCLIUM_DRAFTS_DIR: join(base, 'drafts'),
    ECCLIUM_EGRESS_PROXY: 'http://egress:3128',
  };
  for (const [name, value] of Object.entries(options.extra ?? {})) {
    if (value === undefined) Reflect.deleteProperty(environment, name);
    else environment[name] = value;
  }

  const rights: Readonly<Record<string, unknown>> = {
    runner: rightsOf(['ct_events_list'], []),
    berichte: rightsOf(['ct_events_list', 'ct_wiki_page_append_section'], [7]),
    ...options.rights,
  };
  const requests: string[] = [];
  const createTransport = (given: HttpTransportOptions): HttpTransport => {
    const double = createChurchToolsDouble({
      token: given.token,
      origin: given.origin,
      logger: given.logger,
    });
    open.push(double);
    for (const [alias, token] of Object.entries(tokens)) {
      const headers = { authorization: `Login ${token.value}` };
      double
        .intercept({
          path: '/api/whoami?only_allow_authenticated=true',
          method: 'GET',
          headers,
        })
        .reply(() => {
          requests.push(`whoami ${alias}`);
          return {
            statusCode: options.whoamiStatus?.[alias] ?? 200,
            data: JSON.stringify({
              data: {
                id: 7,
                guid: '00000000-0000-0000-0000-000000000007',
                firstName: 'Max',
                lastName: 'Mustermann',
                email: 'max.mustermann@example.org',
              },
            }),
            responseOptions: json,
          };
        })
        .persist();
      double
        .intercept({
          path: '/api/permissions/global',
          method: 'GET',
          headers,
        })
        .reply(() => {
          requests.push(`permissions ${alias}`);
          return {
            statusCode: 200,
            data: JSON.stringify({ data: rights[alias] }),
            responseOptions: json,
          };
        })
        .persist();
    }
    double
      .intercept({ path: () => true, method: 'GET' })
      .reply(() => {
        requests.push('other');
        return { statusCode: 401, data: '{}', responseOptions: json };
      })
      .persist();
    return double.transport;
  };

  // The checks of the outbound path, as a case answers them.
  const probesOf = (
    answers: {
      readonly target?: (
        options: EgressTargetProbeOptions,
      ) => EgressTargetProbe | undefined;
      readonly direct?: DirectProbe;
    } = {},
  ) => {
    const calls: unknown[] = [];
    const probes: EgressProbes = {
      target: (given) => {
        calls.push({ kind: 'target', ...given });
        return Promise.resolve(
          answers.target?.(given) ??
            (given.host === 'ecclium-doctor.invalid'
              ? { ok: false, reason: 'refused', status: 403 }
              : { ok: true }),
        );
      },
      direct: (given: DirectProbeOptions) => {
        calls.push({ kind: 'direct', ...given });
        return Promise.resolve(
          answers.direct ?? { connected: false, reason: 'no_connection' },
        );
      },
    };
    return { probes, calls };
  };

  const doctor = async (
    call: {
      readonly showValues?: boolean;
      readonly probes?: EgressProbes;
    } = {},
  ) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const logs: string[] = [];
    const decoder = new TextDecoder();
    const code = await runDoctor({
      environment,
      execArgv: [],
      showValues: call.showValues ?? false,
      output: {
        stdout: (line) => stdout.push(line) > 0,
        stderr: (line) => stderr.push(line) > 0,
      },
      probes: call.probes ?? probesOf().probes,
      createTransport,
      load: loadConfig,
      writeSync: (_fd, buffer, offset, length) => {
        logs.push(decoder.decode(buffer.subarray(offset, offset + length)));
        return length;
      },
      now: () => day,
    });
    assertNoCanary(
      [stdout, stderr, logs],
      [pathCanary, modelKey, ...Object.values(tokens)],
      'the report of ecclium doctor',
    );
    return { code, stdout, stderr, logs };
  };

  // The lines of the audit files of the command.
  const auditLines = (): readonly Record<string, unknown>[] => {
    const folder = join(stateDir, 'audit');
    return readdirSync(folder)
      .filter((name) => name.endsWith('.jsonl'))
      .flatMap((name) =>
        readFileSync(join(folder, name), 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => JSON.parse(line) as Record<string, unknown>),
      );
  };

  return {
    doctor,
    probesOf,
    requests,
    auditLines,
    environment,
    createTransport,
    stateDir,
    routinesDir,
    modelKeyFile,
  };
};

const findings = (lines: readonly string[]): readonly string[] =>
  lines.filter((line) => line.trimStart().startsWith('Befund: '));

const exampleHost = new URL(doubleOrigin).hostname;

describe('ecclium doctor', () => {
  it('passes a runner whose path, providers, routines and accounts are as they should be', async () => {
    const { doctor, probesOf, requests, auditLines } = setup();
    const { probes, calls } = probesOf();
    const { code, stdout, stderr } = await doctor({ probes });
    expect(stderr).toEqual([]);
    expect(code).toBe(exitCodes.ok);
    // Each target with TLS, the name outside the list without, and the
    // direct path to ChurchTools, never a token or a path.
    expect(calls).toEqual([
      {
        kind: 'target',
        proxy: 'http://egress:3128',
        host: exampleHost,
        port: 443,
        tls: true,
      },
      {
        kind: 'target',
        proxy: 'http://egress:3128',
        host: 'model.example.org',
        port: 443,
        tls: true,
      },
      {
        kind: 'target',
        proxy: 'http://egress:3128',
        host: 'reserve.example.org',
        port: 443,
        tls: true,
      },
      {
        kind: 'target',
        proxy: 'http://egress:3128',
        host: 'ecclium-doctor.invalid',
        port: 443,
        tls: false,
      },
      { kind: 'direct', host: exampleHost, port: 443 },
    ]);
    expect(stdout).toContain(
      '  ChurchTools: Tunnel über den Proxy und TLS in Ordnung.',
    );
    expect(stdout).toContain(
      '  Ein Ziel ausserhalb der Liste (‹ecclium-doctor.invalid›) weist der Proxy mit 403 ab, wie es sein soll.',
    );
    expect(stdout).toContain(
      '  Direkt, ohne den Proxy, kommt keine Verbindung zu ChurchTools zustande, wie es sein soll.',
    );
    expect(stdout).toContain(
      `  ‹default›: genutzt von ‹${draftRoutine}›, ‹${wikiRoutine}›.`,
    );
    expect(stdout).toContain(
      '  ‹reserve›: Keine Routine, die startet, nutzt ihn. Die Liste aus ‹ecclium init egress› nennt den Anbieter trotzdem.',
    );
    expect(stdout).toContain('Routinen: 2 starten, 0 starten nicht.');
    expect(stdout).toContain(
      `  Konto ‹runner›, das eigene Konto des Runners: Routinen, die starten: ‹${draftRoutine}›.`,
    );
    expect(stdout).toContain(
      `  Konto ‹berichte›: Routinen, die starten: ‹${wikiRoutine}›.`,
    );
    expect(
      stdout.filter(
        (line) =>
          line === '    Rechte: keine, die seine Routinen nicht brauchen.',
      ),
    ).toHaveLength(2);
    // The empty interactive part is a finding of the policy, which does
    // not count for the exit code.
    expect(findings(stdout)).toEqual([
      expect.stringContaining(
        'Befund: Der interaktive Teil hat keine Einträge.',
      ) as string,
    ]);
    expect(stdout.at(-2)).toBe(
      'Ergebnis: kein Befund zu Weg, Anbietern, Routinen und Konten. Die Befunde zur Richtlinie zählen nicht für den Exit-Code, weil sie oft gewollt sind.',
    );
    expect(stdout.at(-1)).toBe(
      'Nicht geprüft in dieser Fassung: die Uhrzeit, der Ablauf der Tokens, das Alter des Images und die Rechte des Kontos des Servers. Sie kommen mit einer späteren Fassung von ‹ecclium doctor›.',
    );
    // ct_whoami with each account, each with its line in the audit, in the
    // mode operator, and no other request.
    expect(requests).toEqual([
      'whoami runner',
      'permissions runner',
      'whoami berichte',
      'permissions berichte',
    ]);
    const lines = auditLines().filter((line) => line['tool'] === 'ct_whoami');
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line['mode'])).toEqual(['operator', 'operator']);
    // No host and no name of the account without --show-values.
    expect(stdout.join('\n')).not.toContain(exampleHost);
    expect(stdout.join('\n')).not.toContain('model.example.org');
    expect(stdout.join('\n')).not.toContain('Mustermann');
  });

  it('names host and port of each target only with --show-values', async () => {
    const { doctor } = setup();
    const { stdout } = await doctor({ showValues: true });
    expect(stdout).toContain(
      `  ChurchTools (‹${exampleHost}:443›): Tunnel über den Proxy und TLS in Ordnung.`,
    );
    expect(stdout.join('\n')).toContain('model.example.org');
  });

  it('reports rights the routines do not need, and an exception that holds', async () => {
    const { doctor } = setup({
      entry: { acceptRightsDrift: { from: '2026-11-12', until: '2026-11-19' } },
      rights: {
        berichte: {
          ...rightsOf(
            ['ct_events_list', 'ct_wiki_page_append_section'],
            [7, 8],
          ),
          churchcal: { view: true },
        },
      },
    });
    const { code, stdout } = await doctor();
    expect(code).toBe(exitCodes.dataError);
    expect(stdout).toContain(
      // In the order of ct_whoami, which sorts the modules by name.
      '    Befund: Rechte, die seine Routinen nicht brauchen: ‹churchcal› ‹view›, ‹churchwiki› ‹edit category›.',
    );
    expect(stdout).toContain(
      `    Die Ausnahme ‹acceptRightsDrift› der Routine ‹${wikiRoutine}› gilt bis 19.11.2026: Ihre Läufe schreiben trotz zu weiter Rechte.`,
    );
    expect(stdout).toContain(
      'Ergebnis: 1 Befund zu Weg, Anbietern, Routinen und Konten. Die Befunde zur Richtlinie zählen nicht für den Exit-Code, weil sie oft gewollt sind.',
    );
    // IDs of categories never show.
    expect(stdout.join('\n')).not.toMatch(/\b8\b/u);
  });

  it('reports an exception that holds although the rights fit, and one that no longer holds', async () => {
    const holding = setup({
      entry: { acceptRightsDrift: { from: '2026-11-12', until: '2026-11-19' } },
    });
    const first = await holding.doctor();
    expect(first.code).toBe(exitCodes.dataError);
    expect(first.stdout).toContain(
      `    Befund: Die Ausnahme ‹acceptRightsDrift› der Routine ‹${wikiRoutine}› gilt bis 19.11.2026, obwohl die Rechte passen. Entfernen Sie sie, damit sie keine spätere Drift verdeckt.`,
    );
    const ended = setup({
      entry: { acceptRightsDrift: { from: '2026-11-01', until: '2026-11-05' } },
    });
    const second = await ended.doctor();
    expect(second.code).toBe(exitCodes.ok);
    expect(second.stdout).toContain(
      `    Die Ausnahme ‹acceptRightsDrift› der Routine ‹${wikiRoutine}› gilt heute nicht, sie endet am 05.11.2026 oder beginnt später.`,
    );
  });

  it('counts the rights of a routine that does not start as too wide', async () => {
    const { doctor } = setup({
      routines: {
        [wikiRoutine]: { target: 'wiki', model: 'fehlt' },
        [draftRoutine]: { target: 'draft' },
      },
    });
    const { code, stdout } = await doctor();
    expect(code).toBe(exitCodes.dataError);
    expect(stdout).toContain('Routinen: 1 startet, 1 startet nicht.');
    expect(
      stdout.some((line) =>
        line.startsWith(`  Befund: Die Routine ‹${wikiRoutine}› startet nicht`),
      ),
    ).toBe(true);
    expect(stdout).toContain(
      `  Konto ‹berichte›: keine Routine, die startet; nicht starten: ‹${wikiRoutine}›.`,
    );
    expect(
      stdout.some((line) =>
        line.startsWith(
          '    Befund: Rechte, die seine Routinen nicht brauchen:',
        ),
      ),
    ).toBe(true);
  });

  it('reports a runner without a boundary in the network and checks no path', async () => {
    const { doctor, probesOf } = setup({
      extra: { ECCLIUM_EGRESS_PROXY: undefined, ECCLIUM_EGRESS: 'off' },
    });
    const { probes, calls } = probesOf();
    const { code, stdout } = await doctor({ probes });
    expect(code).toBe(exitCodes.dataError);
    expect(calls).toEqual([]);
    expect(stdout).toContain(warningsHeading);
    expect(stdout).toContain(
      '  Befund: Mit ‹ECCLIUM_EGRESS=off› geht der Runner ohne Grenze im Netz nach aussen, an jedes Ziel. ‹ecclium doctor› prüft den Weg dann nicht. Geben Sie dem Runner einen Proxy mit ‹ECCLIUM_EGRESS_PROXY› und der Vorlage für Squid.',
    );
  });

  it('reads a list that refuses every target as cut short or made for another configuration', async () => {
    const { doctor, probesOf } = setup();
    const { probes } = probesOf({
      target: () => ({ ok: false, reason: 'refused', status: 403 }),
    });
    const { code, stdout } = await doctor({ probes });
    expect(code).toBe(exitCodes.dataError);
    expect(
      findings(stdout).filter((line) => line.includes('mit 403 ab')),
    ).toHaveLength(3);
    expect(
      stdout.some((line) =>
        line.startsWith(
          '  Weil der Proxy jedes Ziel mit 403 abweist, ist die Liste der Ziele wohl unvollständig',
        ),
      ),
    ).toBe(true);
  });

  it('reports a proxy that lets a name outside the list through, or asks DNS for it, and a direct path that is open', async () => {
    const { doctor, probesOf } = setup();
    const open = probesOf({
      target: () => ({ ok: true }),
      direct: { connected: true },
    });
    const first = await doctor({ probes: open.probes });
    expect(first.code).toBe(exitCodes.dataError);
    expect(findings(first.stdout)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'Der Proxy gibt einen Tunnel zu ‹ecclium-doctor.invalid›',
        ) as string,
        expect.stringContaining(
          'Direkt, ohne den Proxy, steht eine Verbindung zu ChurchTools.',
        ) as string,
      ]),
    );
    const resolving = probesOf({
      target: (given) =>
        given.host === 'ecclium-doctor.invalid'
          ? { ok: false, reason: 'refused', status: 503 }
          : undefined,
      direct: { connected: false, reason: 'dns' },
    });
    const second = await doctor({ probes: resolving.probes });
    expect(second.code).toBe(exitCodes.dataError);
    expect(second.stdout).toContain(
      '  Befund: Für ‹ecclium-doctor.invalid›, einen Namen ausserhalb jeder Liste, antwortet der Proxy mit Status 503 statt 403. Er hat den Namen also aufzulösen oder zu erreichen versucht, statt ihn an der Liste abzuweisen, und kann über DNS nach aussen sprechen. Nehmen Sie die Vorlage für Squid unverändert.',
    );
    expect(second.stdout).toContain(
      '  Direkt, ohne den Proxy, löst der Name von ChurchTools nicht auf, und keine Verbindung kommt zustande. Ob eine Verbindung zu einer IP-Adresse durchkäme, zeigt das nicht.',
    );
  });

  it('stops at a proxy it does not reach and checks no further target', async () => {
    const { doctor, probesOf } = setup();
    const { probes, calls } = probesOf({
      target: () => ({ ok: false, reason: 'unreachable' }),
    });
    const { code, stdout } = await doctor({ probes });
    expect(code).toBe(exitCodes.dataError);
    expect(
      calls.filter((entry) => (entry as { kind: string }).kind === 'target'),
    ).toHaveLength(1);
    expect(stdout).toContain('  Anbieter ‹default›: nicht geprüft.');
    expect(stdout).toContain(
      '  Ein Ziel ausserhalb der Liste (‹ecclium-doctor.invalid›): nicht geprüft.',
    );
  });

  it('goes on with the other targets after a tunnel the proxy does not answer', async () => {
    const { doctor, probesOf } = setup();
    const { probes, calls } = probesOf({
      target: (given) =>
        given.host === 'model.example.org'
          ? { ok: false, reason: 'no_answer' }
          : undefined,
    });
    const { code, stdout } = await doctor({ probes });
    expect(code).toBe(exitCodes.dataError);
    expect(
      calls.filter((entry) => (entry as { kind: string }).kind === 'target'),
    ).toHaveLength(4);
    expect(stdout).toContain(
      '  Anbieter ‹reserve›: Tunnel über den Proxy und TLS in Ordnung.',
    );
  });

  it('reports a right the routines need and the account lacks', async () => {
    const { doctor } = setup({
      rights: { runner: { churchwiki: { view: true } } },
    });
    const { code, stdout } = await doctor();
    expect(code).toBe(exitCodes.dataError);
    expect(
      stdout.some((line) =>
        line.startsWith(
          '    Befund: Rechte, die seine Routinen brauchen und die ‹ct_whoami› nicht zeigt:',
        ),
      ),
    ).toBe(true);
  });

  it('reports an account whose token ChurchTools refuses', async () => {
    const { doctor } = setup({ whoamiStatus: { berichte: 401 } });
    const { code, stdout } = await doctor();
    expect(code).toBe(exitCodes.dataError);
    expect(stdout).toContain(
      '    Befund: Die Rechte liessen sich nicht lesen, Fehler ‹auth›. ChurchTools nimmt das Token des Kontos nicht an. Erneuern Sie das Token in der Datei des Kontos.',
    );
  });

  it('reports rights in a form the core does not know', async () => {
    const { doctor } = setup({ rights: { runner: { '': { view: true } } } });
    const { code, stdout } = await doctor();
    expect(code).toBe(exitCodes.dataError);
    expect(stdout).toContain(
      '    Befund: ChurchTools gab die Rechte in einer Form, die Ecclium nicht kennt. ‹ecclium doctor› prüft sie darum nicht.',
    );
  });

  it('reports the key of a model a routine uses that cannot be read', async () => {
    const { doctor, modelKeyFile } = setup();
    chmodSync(modelKeyFile, 0o644);
    const { code, stdout } = await doctor();
    expect(code).toBe(exitCodes.dataError);
    expect(
      findings(stdout).filter((line) =>
        line.startsWith(
          '  Befund: Das Modell ‹default› lässt sich nicht verwenden: Seine Datei des Schlüssels hat den Code ‹token_file_mode›.',
        ),
      ),
    ).toHaveLength(1);
  });

  it('checks no account when the routines do not load', async () => {
    const { doctor, routinesDir, requests } = setup();
    privateFile(join(routinesDir, 'kaputt.yaml'), 'schema: routine.v0\n');
    const { code, stdout } = await doctor();
    expect(code).toBe(exitCodes.dataError);
    expect(requests).toEqual([]);
    expect(stdout).toContain(
      'Konten des Runners: nicht geprüft, weil die Routinen nicht laden.',
    );
    expect(
      findings(stdout).filter((line) => line.startsWith('Befund: ')),
    ).toHaveLength(1);
  });

  it('checks no account when the audit file cannot be opened', async () => {
    const { doctor, stateDir, requests } = setup();
    // A folder of the audit the process may not write to; the loader looks
    // only at owner and mode of the folder of state.
    mkdirSync(join(stateDir, 'audit'), { mode: 0o500 });
    chmodSync(join(stateDir, 'audit'), 0o500);
    const { code, stdout, stderr } = await doctor();
    expect(code).toBe(exitCodes.dataError);
    expect(requests).toEqual([]);
    expect(stderr).toHaveLength(1);
    expect(stdout).toContain(
      'Befund: Konten des Runners: nicht geprüft, weil sich die Audit-Datei oder der Ordner der Zähler im Zustandsordner nicht verwenden lässt; den Grund nennt die Zeile auf stderr. Ohne Audit liest ‹ecclium doctor› nichts aus ChurchTools.',
    );
  });

  it('checks nothing and asks nothing with an invalid configuration', async () => {
    const { doctor, probesOf, requests } = setup({
      extra: { ECCLIUM_EGRESS_PROXY: undefined },
    });
    const { probes, calls } = probesOf();
    // Also with --show-values, which names hosts only, never the paths of
    // the report; the helper checks the canary in every folder.
    const { code, stdout } = await doctor({ probes, showValues: true });
    expect(code).toBe(exitCodes.invalidConfig);
    expect(calls).toEqual([]);
    expect(requests).toEqual([]);
    expect(stdout.at(-1)).toBe(
      'Mit dieser Konfiguration startet der Runner nicht, darum prüft ‹ecclium doctor› nichts weiter und fragt nichts an. Beheben Sie die Probleme und rufen Sie ‹ecclium doctor› erneut auf.',
    );
  });

  it('runs from the command line, with --show-values and no other option', async () => {
    const { environment, probesOf, createTransport } = setup();
    const { probes } = probesOf();
    const stdout: string[] = [];
    const decoder = new TextDecoder();
    const code = await run(
      ['doctor', '--show-values'],
      { ...environment },
      [],
      {
        writeSync: (fd, buffer, offset, length) => {
          if (fd === 1) {
            stdout.push(
              decoder.decode(buffer.subarray(offset, offset + length)),
            );
          }
          return length;
        },
        doctor: { probes, load: loadConfig, createTransport, now: () => day },
      },
    );
    expect(code).toBe(exitCodes.ok);
    expect(stdout.join('')).toContain(exampleHost);
    expect(
      run(['doctor', '--runner'], { ...environment }, [], {
        writeSync: (_fd, _buffer, _offset, length) => length,
      }),
    ).toBe(exitCodes.usage);
  });
});

const warningsHeading = 'Beim Start meldet der Runner:';
