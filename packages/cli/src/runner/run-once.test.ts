import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type ConfigSources,
  createToolCatalog,
  type EccliumConfig,
  loadConfig,
  toolsetNames,
} from '@ecclium/mcp-churchtools-core';
import type {
  HttpTransportOptions,
  ModelHttpTransportOptions,
} from '@ecclium/mcp-churchtools-core/http';
import {
  assertNoCanary,
  assertPlanted,
  type Canary,
  chatCompletion,
  createChurchToolsDouble,
  createModelEndpointDouble,
  createRoutinePlugin,
  doubleModelEndpoint,
  doubleOrigin,
  jsonHeaders,
  makeCanary,
  type MockedCall,
  type MockedHttpTransport,
} from '@ecclium/mcp-churchtools-testkit';
import { createCorePlugin } from '@ecclium/mcp-churchtools-tools';
import { afterEach, describe, expect, it } from 'vitest';

import { exitCodes } from '../exit-codes.js';
import { run } from '../main.js';
import { runOnce, type RunOnceOptions } from './run-once.js';
import type { RunnerMode } from './start.js';
import { modelKeyText, refusedText, runnerStartTexts } from './texts.js';

// Reads a file and its mode through one descriptor, so that both describe
// the same file and no check on its path comes before its use.
const readWithMode = (path: string): { text: string; mode: number } => {
  const fd = openSync(path, 'r');
  try {
    return { text: readFileSync(fd, 'utf8'), mode: fstatSync(fd).mode & 0o777 };
  } finally {
    closeSync(fd);
  }
};

// `ecclium run-once` end to end on doubles (ADR 0033, ADR 0034): the real
// loader of the configuration of the runner over real temporary folders,
// the real routines in their folder, the real store of the memory of runs,
// locks, audit file, drafts and notices, the read tools of the routine
// plugin of testkit, the double of ChurchTools, which keeps the pages of
// one category as state, and the double of the endpoint of a model. The
// parts prove themselves in their own tests; these prove the command. All
// data are made up.

// Wednesday 11.11.2026, 08:00 in Zurich: the Monday trigger of week 46,
// 09.11.2026 at 06:00, is due.
const now = Date.UTC(2026, 10, 11, 7);
const json = {
  headers: {
    'content-type': 'application/json',
    date: new Date(now).toUTCString(),
  },
};

const wikiRoutine = 'wochen-bericht';
const draftRoutine = 'termin-entwurf';
const writeTool = 'ct_wiki_page_append_section';
const pageTitle = 'Dienstplan-Auswertung';
const guid = '00000000-0000-4000-8000-0000000000c1';

// The template of every routine of the tests, with the one block.
const template = [
  '### Dienstplan {{period}}',
  '',
  '{{#unbesetzt}}',
  '- {{datum}}, {{termin}}: {{dienst}}',
  '{{/unbesetzt}}',
  '{{^unbesetzt}}',
  'Alles besetzt.',
  '{{/unbesetzt}}',
  '',
].join('\n');

/** What a routine of a test differs in. */
interface RoutineOptions {
  readonly target?: 'wiki' | 'draft';
  readonly schedule?: string;
  /** The inputs, by default the two read tools of the routine plugin. */
  readonly inputs?: readonly Record<string, unknown>[];
  readonly notify?: readonly ('stdout' | 'file')[];
  /** The alias of the model, `default` unless given. */
  readonly model?: string;
}

// The two read tools of the routine plugin of testkit, which ask
// ChurchTools nothing and list what they were called with.
const pluginInputs = [
  {
    name: 'termine',
    tool: 'ct_test_events',
    params: { from: '+0d', to: '+14d' },
    maxItems: 30,
  },
  {
    name: 'einteilungen',
    tool: 'ct_test_assignments',
    forEach: 'termine',
    params: { eventId: { field: 'id' } },
    maxItems: 60,
  },
];

const routineValueOf = (id: string, options: RoutineOptions = {}) => ({
  schema: 'routine.v1',
  id,
  schedule: options.schedule ?? '0 6 * * MON',
  inputs: options.inputs ?? pluginInputs,
  generate: {
    prompt: `prompts/${id}.md`,
    model: options.model ?? 'default',
    output: {
      blocks: {
        unbesetzt: {
          maxItems: 10,
          fields: {
            datum: { type: 'date' },
            termin: { type: 'text', maxLength: 80 },
            dienst: { type: 'text', maxLength: 80 },
          },
        },
      },
    },
  },
  template: `templates/${id}.md`,
  output:
    options.target === 'draft'
      ? { target: 'draft', channel: 'file', idempotencyKey: `${id}:{isoWeek}` }
      : {
          target: 'wiki',
          tool: writeTool,
          scope: { category: 'Berichte', page: pageTitle },
          idempotencyKey: `${id}:{isoWeek}`,
        },
  notify: (options.notify ?? ['stdout']).map((channel) => ({ channel })),
});

/** The entry of a routine in the unattended part of the policy. */
const entryOf = (
  routine: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  routine,
  credential: 'berichte',
  modelRedaction: 'standard',
  target: { kind: 'wiki_category', id: 7, name: 'Berichte' },
  tools: [writeTool],
  maxPerRun: 1,
  maxPerDay: 5,
  ...extra,
});

// What the account of the wiki routine needs, and nothing more, so that
// its write is no drift of rights.
const wikiRights = {
  churchwiki: { view: true, 'view category': [7], 'edit category': [7] },
};

/** One open service, as the model answers by default. */
const openService = {
  unbesetzt: [
    { datum: '2026-11-15', termin: 'Gottesdienst', dienst: 'Mesmer' },
  ],
};

/** A page of the double. */
interface FakePage {
  readonly categoryId: number;
  title: string;
  version: number;
  text: string;
}

const pagePath = /^\/api\/wiki\/categories\/(\d+)\/pages\/([0-9a-f-]{36})$/u;

// Answers every read and write of the wiki from the state, as the double
// of the test of the write of a run does. With `unavailable` every
// request gets 503, as from an instance in maintenance.
const serve = (
  double: MockedHttpTransport,
  pages: Map<string, FakePage>,
  unavailable: boolean,
  rights: Readonly<Record<string, unknown>>,
): void => {
  if (unavailable) {
    double
      .intercept({ path: () => true, method: () => true })
      .reply(503, '{}', json)
      .persist();
    return;
  }
  const pageOf = (path: string): FakePage | undefined => {
    const [, category, id] = pagePath.exec(path) ?? [];
    const found = id === undefined ? undefined : pages.get(id);
    return found?.categoryId === Number(category) ? found : undefined;
  };
  double
    .intercept({ path: '/api/permissions/global', method: 'GET' })
    .reply(() => ({
      statusCode: 200,
      data: JSON.stringify({ data: rights }),
      responseOptions: json,
    }))
    .persist();
  double
    .intercept({ path: '/api/wiki/categories', method: 'GET' })
    .reply(() => ({
      statusCode: 200,
      data: JSON.stringify({ data: [{ id: 7, name: 'Berichte' }] }),
      responseOptions: json,
    }))
    .persist();
  double
    .intercept({
      path: (path: string) => path.split('?')[0] === '/api/wiki/pages',
      method: 'GET',
    })
    .reply(() => {
      const data = [...pages.entries()].map(([id, page]) => ({
        guid: id,
        title: page.title,
        isMarkdown: true,
        version: page.version,
      }));
      return {
        statusCode: 200,
        data: JSON.stringify({
          data,
          meta: {
            count: data.length,
            pagination: {
              total: data.length,
              limit: 100,
              current: 1,
              lastPage: 1,
            },
          },
        }),
        responseOptions: json,
      };
    })
    .persist();
  double
    .intercept({ path: (path: string) => pagePath.test(path), method: 'GET' })
    .reply((opts) => {
      const found = pageOf(opts.path);
      if (found === undefined) {
        return { statusCode: 404, data: '{}', responseOptions: json };
      }
      return {
        statusCode: 200,
        data: JSON.stringify({
          data: {
            title: found.title,
            isMarkdown: true,
            version: found.version,
            text: found.text,
            wikiCategory: { id: found.categoryId },
          },
        }),
        responseOptions: json,
      };
    })
    .persist();
  double
    .intercept({ path: (path: string) => pagePath.test(path), method: 'PATCH' })
    .reply((opts) => {
      const found = pageOf(opts.path);
      if (found === undefined) {
        return { statusCode: 404, data: '{}', responseOptions: json };
      }
      const body =
        typeof opts.body === 'string'
          ? opts.body
          : Buffer.from(opts.body as Uint8Array).toString('utf8');
      found.text = (JSON.parse(body) as { text: string }).text;
      found.version += 1;
      return { statusCode: 200, data: '{}', responseOptions: json };
    })
    .persist();
};

// Every folder of a test and everything open, removed and closed after it.
const cleanup: string[] = [];
const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(
    open.splice(0).map((item) => item.close().catch(() => undefined)),
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

// A private file, with the mode set after the write, since the umask
// could take bits off the mode of the write.
const privateFile = (path: string, text: string): string => {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
};

/** What a test sets up differently. */
interface SetupOptions {
  /** The routines in their folder, by ID; by default the wiki routine. */
  readonly routines?: Readonly<Record<string, RoutineOptions>>;
  /** The entries of the unattended part, by default the wiki routine's. */
  readonly entries?: readonly Record<string, unknown>[];
  /** Variables to set or, with undefined, to leave out. */
  readonly extra?: Readonly<Record<string, string | undefined>>;
  /** Further aliases whose token files exist. */
  readonly aliases?: readonly string[];
  /**
   * Sets the level strict for the whole configuration as well. A run at
   * the level strict, as every run of a routine without an entry, needs
   * only the key of the pseudonyms, which every setup sets.
   */
  readonly strict?: boolean;
}

/** One call of the command. */
interface CallOptions {
  /** Replaces the loader, such as one that wraps the real one. */
  readonly load?: (sources: ConfigSources) => ReturnType<typeof loadConfig>;
  /** Replaces the reading of the key file of a model. */
  readonly readModelKey?: RunOnceOptions['readModelKey'];
  /** Uses the catalog of the runner itself, without the test plugin. */
  readonly ownCatalog?: boolean;
}

const setup = (options: SetupOptions = {}) => {
  // A canary in the name of every folder, so that a path in any output
  // would show.
  const pathCanary = makeCanary('token');
  const base = mkdtempSync(
    join(tmpdir(), `ecclium-run-once-${pathCanary.cores[0] ?? ''}-`),
  );
  cleanup.push(base);
  const stateDir = privateDir(join(base, 'state'));
  // The folder of the kill switches, which writing and every draft need
  // (ADR 0029, ADR 0033).
  const stopDir = privateDir(join(stateDir, 'stop'));
  const keysDir = privateDir(join(base, 'keys'));
  const tokensDir = privateDir(join(base, 'tokens'));
  const configDir = privateDir(join(base, 'config'));
  const routinesDir = privateDir(join(base, 'routines'));
  privateDir(join(routinesDir, 'prompts'));
  privateDir(join(routinesDir, 'templates'));
  const draftsDir = join(base, 'drafts');
  const notifyFile = join(base, 'notices.jsonl');

  // The own account of the runner and the account of the alias of the
  // wiki routine, each with a token that must show nowhere.
  const runnerToken = makeCanary('token');
  const accountToken = makeCanary('token');
  privateFile(join(tokensDir, 'ct_token_runner'), `${runnerToken.value}\n`);
  const accountFile = join(tokensDir, 'ct_token_berichte');
  const writeAccountFile = (): void => {
    privateFile(accountFile, `${accountToken.value}\n`);
  };
  writeAccountFile();
  const otherTokens = (options.aliases ?? []).map((alias) => {
    const token = makeCanary('token');
    privateFile(join(tokensDir, `ct_token_${alias}`), `${token.value}\n`);
    return token;
  });
  // The key of the model, a canary as well.
  const modelKey = makeCanary('token');
  const modelKeyFile = privateFile(
    join(configDir, 'model-key'),
    `${modelKey.value}\n`,
  );
  // Keys made from seeds instead of written out, so that no secret
  // scanner reads them as leaked ones. The pseudonyms of the level strict
  // need the one, the marking of what a run writes the other.
  const pseudonymFile = privateFile(
    join(configDir, 'pseudonym-key'),
    `${createHash('sha256').update('run-once-pseudonym').digest('hex')}\n`,
  );
  const markerFile = privateFile(
    join(configDir, 'marker-key'),
    `${createHash('sha256').update('run-once-marker').digest('hex')}\n`,
  );
  // JSON is YAML, so the loaders read these files as they are.
  const policyFile = privateFile(
    join(configDir, 'policy.json'),
    JSON.stringify({
      schema: 'policy.v1',
      interactive: { inquiriesTo: 'Sekretariat' },
      unattended: options.entries ?? [entryOf(wikiRoutine)],
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
      ],
    }),
  );
  const writeRoutine = (id: string, routine: RoutineOptions): void => {
    privateFile(
      join(routinesDir, `${id}.yaml`),
      JSON.stringify(routineValueOf(id, routine)),
    );
    privateFile(
      join(routinesDir, 'prompts', `${id}.md`),
      'Fasse die Dienste zusammen.\n',
    );
    privateFile(join(routinesDir, 'templates', `${id}.md`), template);
  };
  for (const [id, routine] of Object.entries(
    options.routines ?? { [wikiRoutine]: {} },
  )) {
    writeRoutine(id, routine);
  }

  const environment: Record<string, string | undefined> = {
    ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
    ECCLIUM_TIME_ZONE: 'Europe/Zurich',
    ECCLIUM_POLICY_FILE: policyFile,
    ECCLIUM_ROUTINES_DIR: routinesDir,
    ECCLIUM_STATE_DIR: stateDir,
    ECCLIUM_RUNNER_TOKENS_DIR: tokensDir,
    ECCLIUM_PROVIDERS_FILE: providersFile,
    ECCLIUM_READ_ONLY: 'false',
    ECCLIUM_KEYS_DIR: keysDir,
    ECCLIUM_MARKER_KEY_FILE: markerFile,
    ECCLIUM_DRAFTS_DIR: draftsDir,
    ECCLIUM_NOTIFY_FILE: notifyFile,
    // Every line the command can write, so that a leak in one shows.
    ECCLIUM_LOG_LEVEL: 'debug',
    ECCLIUM_PSEUDONYM_KEY_FILE: pseudonymFile,
    ...(options.strict === true ? { ECCLIUM_REDACTION: 'strict' } : {}),
  };
  for (const [name, value] of Object.entries(options.extra ?? {})) {
    if (value === undefined) Reflect.deleteProperty(environment, name);
    else environment[name] = value;
  }
  // The configuration must load, or every test below proves nothing.
  const loaded = loadConfig({ environment, transport: 'runner' });
  if (!loaded.ok) {
    throw new Error(
      `the configuration of the test is invalid: ${loaded.report.problems
        .map((problem) => problem.code)
        .join(', ')}`,
    );
  }

  // The wiki of ChurchTools, which every transport serves.
  const pages = new Map<string, FakePage>([
    [
      guid,
      { categoryId: 7, title: pageTitle, version: 3, text: `# ${pageTitle}` },
    ],
  ]);
  const state = {
    unavailable: false,
    answer: openService as unknown,
    rights: wikiRights as Readonly<Record<string, unknown>>,
    // How far the clock of the command runs ahead of the start of the test.
    laterMs: 0,
  };
  // Frozen, function and all, as the core takes a clock.
  const clock = Object.freeze({
    now: Object.freeze(() => now + state.laterMs),
  });
  // The calls of every transport, kept before it closes, since a closed
  // double forgets its calls.
  const churchtoolsCalls: MockedCall[] = [];
  const modelCalls: MockedCall[] = [];
  const createTransport = (given: HttpTransportOptions) => {
    // With the logger of the pipeline, so that the lines of the transport,
    // which holds the token, reach the log as in production.
    const double = createChurchToolsDouble({
      token: given.token,
      origin: given.origin,
      logger: given.logger,
      clock: given.clock,
    });
    open.push(double);
    serve(double, pages, state.unavailable, state.rights);
    return Object.freeze({
      ...double.transport,
      close: async () => {
        churchtoolsCalls.push(...double.calls());
        await double.transport.close();
      },
    });
  };
  const createModelTransport = (given: ModelHttpTransportOptions) => {
    const double = createModelEndpointDouble({
      key: given.key,
      endpoint: given.endpoint,
      logger: given.logger,
      clock: given.clock,
    });
    open.push(double);
    double
      .intercept({
        path: new URL(doubleModelEndpoint).pathname,
        method: 'POST',
      })
      .reply(() => ({
        statusCode: 200,
        data: chatCompletion({ content: JSON.stringify(state.answer) }),
        responseOptions: { headers: jsonHeaders },
      }))
      .persist();
    return Object.freeze({
      ...double.transport,
      close: async () => {
        modelCalls.push(...double.calls());
        await double.transport.close();
      },
    });
  };
  // The read tools of the routine plugin beside the tools of the core, as
  // the catalog of the runner holds them.
  const plugin = createRoutinePlugin();
  const createCatalog = (config: EccliumConfig) =>
    createToolCatalog({
      core: createCorePlugin({ writing: !config.readOnly }),
      plugins: [plugin.plugin],
      readOnly: config.readOnly,
      toolsets: new Set(
        toolsetNames.filter((name) => name !== 'docs' && name !== 'api'),
      ),
    });

  // Everything the command wrote, over all its calls.
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logs: string[] = [];

  const call = async (mode: RunnerMode, more: CallOptions = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runOnce({
      environment,
      execArgv: [],
      mode,
      output: {
        stdout: (line) => out.push(line) > 0,
        stderr: (line) => err.push(line) > 0,
      },
      ...(more.load === undefined ? {} : { load: more.load }),
      ...(more.readModelKey === undefined
        ? {}
        : { readModelKey: more.readModelKey }),
      ...(more.ownCatalog === true ? {} : { createCatalog }),
      writeSync: (_fd, buffer, offset, length) => {
        logs.push(
          Buffer.from(buffer)
            .subarray(offset, offset + length)
            .toString('utf8'),
        );
        return length;
      },
      createTransport,
      createModelTransport,
      clock,
    });
    stdout.push(...out);
    stderr.push(...err);
    return { code, stdout: out, stderr: err };
  };

  // The same through the command line, which reads the arguments and
  // writes through its own output.
  const cli = async (args: readonly string[]) => {
    const taken = new Map<number, number[]>();
    const code = await run(args, { ...environment }, [], {
      writeSync: (fd, buffer, offset, length) => {
        const bytes = taken.get(fd) ?? [];
        bytes.push(...buffer.subarray(offset, offset + length));
        taken.set(fd, bytes);
        return length;
      },
      runOnce: {
        createCatalog,
        writeSync: (_fd, buffer, offset, length) => {
          logs.push(
            Buffer.from(buffer)
              .subarray(offset, offset + length)
              .toString('utf8'),
          );
          return length;
        },
        createTransport,
        createModelTransport,
        clock,
      },
    });
    const text = (fd: number): string =>
      new TextDecoder().decode(new Uint8Array(taken.get(fd) ?? []));
    stdout.push(text(1));
    stderr.push(text(2));
    return { code, stdout: text(1), stderr: text(2) };
  };

  // The lines of the audit files of the test.
  const auditLines = (): Record<string, unknown>[] => {
    const dir = join(stateDir, 'audit');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .sort()
      .flatMap((name) =>
        readFileSync(join(dir, name), 'utf8')
          .split('\n')
          .filter((line) => line !== ''),
      )
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  };
  const runLines = () => auditLines().filter((line) => line['type'] === 'run');
  const patches = () => churchtoolsCalls.filter((c) => c.method === 'PATCH');
  const pageText = () => pages.get(guid)?.text ?? '';
  const notices = (): Record<string, unknown>[] =>
    existsSync(notifyFile)
      ? readFileSync(notifyFile, 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];

  // No token, no key and no path in anything the command gave out.
  const assertNothingLeaked = (): void => {
    const canaries: Canary[] = [
      runnerToken,
      accountToken,
      modelKey,
      pathCanary,
      ...otherTokens,
    ];
    assertPlanted(
      [
        readFileSync(join(tokensDir, 'ct_token_runner'), 'utf8'),
        readFileSync(modelKeyFile, 'utf8'),
      ],
      [runnerToken, modelKey],
      'the files of the test',
    );
    expect(base).toContain(pathCanary.cores[0]);
    assertNoCanary(stdout, canaries, 'stdout');
    assertNoCanary(stderr, canaries, 'stderr');
    assertNoCanary(logs, canaries, 'the log');
    assertNoCanary(notices(), canaries, 'the notices');
  };

  return {
    base,
    stateDir,
    stopDir,
    tokensDir,
    draftsDir,
    notifyFile,
    routinesDir,
    accountFile,
    writeAccountFile,
    environment,
    runnerToken,
    accountToken,
    state,
    pages,
    plugin,
    churchtoolsCalls,
    modelCalls,
    stdout,
    stderr,
    logs,
    call,
    cli,
    writeRoutine,
    auditLines,
    runLines,
    patches,
    pageText,
    notices,
    assertNothingLeaked,
  };
};

const due: RunnerMode = { kind: 'due' };
const byHand = (routineId: string): RunnerMode => ({
  kind: 'manual',
  routineId,
});
const preview = (routineId: string): RunnerMode => ({
  kind: 'preview',
  routineId,
});

// The JSON lines among lines of output, such as the notices on stdout.
const jsonLines = (lines: readonly string[]): Record<string, unknown>[] =>
  lines
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);

// The fields of the notice of a run that ended well, and nothing else.
const noticeKeys = ['time', 'routine', 'period', 'run', 'result'];

// The draft of the draft routine in week 46, and its line of the marking.
const draftName = `${draftRoutine}-2026-W46.md`;
const draftMarking = `Automatisch erstellt am 11.11.2026 durch Ecclium, Routine ${draftRoutine}, Lauf 2026-W46. Rückfragen an Sekretariat.`;

// The draft routine reads with the own account of the runner: the policy
// has no entry for it, so it reads at the level strict.
const draftOnly = {
  routines: { [draftRoutine]: { target: 'draft', notify: ['file'] } },
  entries: [],
  strict: true,
} as const;

describe('ecclium run-once --due with a routine into the wiki', () => {
  it('writes the section of a due routine once with the token of its account, and a second call writes nothing', async () => {
    const t = setup();
    const first = await t.call(due);
    expect(first.code).toBe(exitCodes.ok);
    expect(t.patches()).toHaveLength(1);
    expect(t.patches()[0]?.headers['authorization']).toBe(
      `Login ${t.accountToken.value}`,
    );
    expect(t.pageText()).toContain('### Dienstplan 2026-W46');
    expect(t.pageText()).toContain('Gottesdienst: Mesmer');
    expect(t.plugin.calls().length).toBeGreaterThan(0);
    expect(t.modelCalls).toHaveLength(1);
    expect(first.stderr).toContain(
      'Durchgang beendet: 1 Lauf, 0 übersprungen, 0 Routinen starten nicht.',
    );

    // The trigger is closed: the same call reads, asks and writes nothing.
    const reads = t.plugin.calls().length;
    const second = await t.call(due);
    expect(second.code).toBe(exitCodes.ok);
    expect(second.stdout).toEqual([]);
    expect(second.stderr).toContain(
      'Durchgang beendet: 0 Läufe, 0 übersprungen, 0 Routinen starten nicht.',
    );
    expect(t.patches()).toHaveLength(1);
    expect(t.plugin.calls()).toHaveLength(reads);
    expect(t.modelCalls).toHaveLength(1);
    expect(t.runLines()).toHaveLength(1);
    // The lines of the transports, which hold the tokens, are in the log
    // the check for canaries reads.
    expect(t.logs.join('')).toContain('"event":"http_response"');
    t.assertNothingLeaked();
  });

  it('ends every run with a line of the type run in the audit file, with its run, routine, period and try', async () => {
    const t = setup();
    const { stdout } = await t.call(due);
    const [notice] = jsonLines(stdout);
    expect(t.runLines()).toEqual([
      expect.objectContaining({
        type: 'run',
        mode: 'unattended',
        actor: { kind: 'runner', id: `runner:${wikiRoutine}` },
        runId: notice?.['run'],
        routineId: wikiRoutine,
        period: '2026-W46',
        attempt: 1,
        runResult: 'written',
        outcome: 'ok',
      }),
    ]);
    t.assertNothingLeaked();
  });

  it('sends one notice per run to stdout and to the file of the notices, without any content', async () => {
    const t = setup({
      routines: { [wikiRoutine]: { notify: ['stdout', 'file'] } },
    });
    const { code, stdout } = await t.call(due);
    expect(code).toBe(exitCodes.ok);
    expect(stdout).toHaveLength(1);
    const [notice] = jsonLines(stdout);
    expect(Object.keys(notice ?? {})).toEqual(noticeKeys);
    expect(notice).toEqual({
      time: new Date(now).toISOString(),
      routine: wikiRoutine,
      period: '2026-W46',
      run: t.runLines()[0]?.['runId'],
      result: 'written',
    });
    // The same line in the file, which only the user of the runner reads.
    expect(t.notices()).toEqual([notice]);
    const kept = readWithMode(t.notifyFile);
    expect(kept.mode).toBe(0o600);
    for (const text of [...stdout, kept.text]) {
      expect(text).not.toContain('Gottesdienst');
      expect(text).not.toContain('Mesmer');
      expect(text).not.toContain('Dienstplan');
    }
    t.assertNothingLeaked();
  });

  it('reads nothing for a routine that is not due and ends with 0', async () => {
    // Once a year: the last trigger lies more than 31 days back.
    const t = setup({ routines: { [wikiRoutine]: { schedule: '0 6 1 1 *' } } });
    const { code, stdout, stderr } = await t.call(due);
    expect(code).toBe(exitCodes.ok);
    expect(stdout).toEqual([]);
    expect(stderr).toContain(
      'Durchgang beendet: 0 Läufe, 0 übersprungen, 0 Routinen starten nicht.',
    );
    expect(t.plugin.calls()).toEqual([]);
    expect(t.modelCalls).toEqual([]);
    expect(t.churchtoolsCalls).toEqual([]);
    expect(t.runLines()).toEqual([]);
    t.assertNothingLeaked();
  });

  it('stops a routine at its kill switch before the first read, for good, with 77 and a refused audit line', async () => {
    const t = setup();
    writeFileSync(join(t.stopDir, `writes-off-routine-${wikiRoutine}`), '');
    const { code, stdout, stderr } = await t.call(due);
    expect(code).toBe(exitCodes.noPermission);
    expect(t.plugin.calls()).toEqual([]);
    expect(t.modelCalls).toEqual([]);
    expect(t.churchtoolsCalls).toEqual([]);
    expect(t.runLines()).toEqual([
      expect.objectContaining({
        type: 'run',
        routineId: wikiRoutine,
        outcome: 'denied',
        errorCode: 'policy_denied',
        runResult: 'failed',
        runStep: 'write',
        attempt: 1,
        period: '2026-W46',
      }),
    ]);
    // The notice names the step and the code of the failure.
    const [notice] = jsonLines(stdout);
    expect(jsonLines(stdout)).toHaveLength(1);
    expect(Object.keys(notice ?? {})).toEqual([...noticeKeys, 'step', 'code']);
    expect(notice).toMatchObject({
      result: 'failed',
      step: 'write',
      code: 'policy_denied',
    });
    expect(stderr.join('\n')).toContain(
      'gescheitert, Code ‹policy_denied›. Diese Auslösung ist damit abgeschlossen',
    );
    // The trigger is closed: the next call does not try again.
    const again = await t.call(due);
    expect(again.code).toBe(exitCodes.ok);
    expect(t.runLines()).toHaveLength(1);
    t.assertNothingLeaked();
  });

  it('names a routine that fails its preparation with its code, runs the others and ends with 78', async () => {
    const t = setup({
      routines: {
        [wikiRoutine]: {},
        'kaputt-test': {
          target: 'draft',
          inputs: [{ name: 'termine', tool: 'ct_unbekannt', maxItems: 10 }],
        },
      },
    });
    const { code, stderr } = await t.call(due);
    expect(code).toBe(exitCodes.invalidConfig);
    expect(stderr).toContain(
      refusedText({
        routineId: 'kaputt-test',
        code: 'run_tool_unknown',
        field: 'inputs[0].tool',
      }),
    );
    expect(stderr).toContain(
      'Durchgang beendet: 1 Lauf, 0 übersprungen, 1 Routine startet nicht.',
    );
    // The other routine ran and wrote.
    expect(t.patches()).toHaveLength(1);
    expect(t.runLines()).toEqual([
      expect.objectContaining({ routineId: wikiRoutine, runResult: 'written' }),
    ]);
    t.assertNothingLeaked();
  });

  it('queues a section whose account holds more rights than its routines need, in the queue it prepares, and ends with 0', async () => {
    const t = setup();
    // The calendars as well, which no routine of the account reads.
    t.state.rights = { ...wikiRights, churchcal: { 'view category': [1] } };
    const { code, stdout, stderr } = await t.call(due);
    expect(code).toBe(exitCodes.ok);
    expect(t.patches()).toEqual([]);
    expect(stderr.join('\n')).toContain(
      'in der Freigabe-Warteschlange, sie wartet auf Ihre Freigabe',
    );
    expect(jsonLines(stdout)).toEqual([
      expect.objectContaining({ result: 'queued' }),
    ]);
    expect(readdirSync(join(t.stateDir, 'queue'))).toHaveLength(1);
    expect(t.runLines()).toEqual([
      expect.objectContaining({ runResult: 'queued', outcome: 'ok' }),
    ]);
    t.assertNothingLeaked();
  });

  it('does not start while ECCLIUM_READ_ONLY is not false, with 78, and reads nothing', async () => {
    const t = setup({ extra: { ECCLIUM_READ_ONLY: 'true' } });
    const { code, stdout, stderr } = await t.call(due);
    expect(code).toBe(exitCodes.invalidConfig);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([runnerStartTexts.read_only_wiki(wikiRoutine)]);
    expect(t.plugin.calls()).toEqual([]);
    expect(t.modelCalls).toEqual([]);
    expect(t.churchtoolsCalls).toEqual([]);
    expect(t.auditLines()).toEqual([]);
    t.assertNothingLeaked();
  });

  it('does not start when the entries of a routine name two accounts, with 78, and reads nothing', async () => {
    const t = setup({
      entries: [
        entryOf(wikiRoutine),
        entryOf(wikiRoutine, {
          credential: 'andere',
          target: { kind: 'wiki_category', id: 8, name: 'Andere' },
        }),
      ],
      aliases: ['andere'],
    });
    const { code, stderr } = await t.call(due);
    expect(code).toBe(exitCodes.invalidConfig);
    expect(stderr).toEqual([runnerStartTexts.credential_mixed(wikiRoutine)]);
    expect(t.plugin.calls()).toEqual([]);
    expect(t.modelCalls).toEqual([]);
    expect(t.churchtoolsCalls).toEqual([]);
    expect(t.auditLines()).toEqual([]);
    t.assertNothingLeaked();
  });

  it('does not open a run whose token file the checks refuse at its start, with 78, and keeps the trigger open', async () => {
    const t = setup();
    // The loader still finds the file; the run, which reads it anew, does
    // not.
    const { code, stderr } = await t.call(due, {
      load: (sources) => {
        const loaded = loadConfig(sources);
        rmSync(t.accountFile);
        return loaded;
      },
    });
    expect(code).toBe(exitCodes.invalidConfig);
    expect(stderr.join('\n')).toContain(
      `Routine ‹${wikiRoutine}›, Periode ‹2026-W46›: nicht gestartet, Code ‹token_file_missing›.`,
    );
    expect(t.plugin.calls()).toEqual([]);
    expect(t.modelCalls).toEqual([]);
    expect(t.churchtoolsCalls).toEqual([]);
    expect(t.runLines()).toEqual([]);
    // No try counted: with the file back, the next call runs.
    t.writeAccountFile();
    const again = await t.call(due);
    expect(again.code).toBe(exitCodes.ok);
    expect(t.patches()).toHaveLength(1);
    expect(t.runLines()).toEqual([expect.objectContaining({ attempt: 1 })]);
    t.assertNothingLeaked();
  });
});

describe('ecclium run-once --due with a draft', () => {
  it('writes the draft with the line of its marking into a private file, and a later run of the period replaces it', async () => {
    const t = setup(draftOnly);
    const first = await t.call(due);
    expect(first.code).toBe(exitCodes.ok);
    expect(readdirSync(t.draftsDir)).toEqual([draftName]);
    const file = join(t.draftsDir, draftName);
    const written = readWithMode(file);
    const text = written.text;
    expect(text.startsWith('### Dienstplan 2026-W46\n')).toBe(true);
    expect(text).toContain('Gottesdienst: Mesmer');
    expect(text.endsWith(`\n\n${draftMarking}\n`)).toBe(true);
    expect(written.mode).toBe(0o600);
    expect(statSync(t.draftsDir).mode & 0o777).toBe(0o700);
    // A draft writes nothing in ChurchTools.
    expect(t.churchtoolsCalls).toEqual([]);
    expect(t.notices()).toEqual([
      expect.objectContaining({ routine: draftRoutine, result: 'drafted' }),
    ]);

    // The same period again, by hand and with another answer.
    t.state.answer = {
      unbesetzt: [
        { datum: '2026-11-15', termin: 'Gottesdienst', dienst: 'Sigrist' },
      ],
    };
    const second = await t.call(byHand(draftRoutine));
    expect(second.code).toBe(exitCodes.ok);
    expect(readdirSync(t.draftsDir)).toEqual([draftName]);
    const again = readWithMode(file);
    const replaced = again.text;
    expect(replaced).toContain('Gottesdienst: Sigrist');
    expect(replaced).not.toContain('Mesmer');
    expect(replaced.endsWith(`\n\n${draftMarking}\n`)).toBe(true);
    expect(again.mode).toBe(0o600);
    t.assertNothingLeaked();
  });

  it('writes a draft also while the configuration only reads', async () => {
    const t = setup({ ...draftOnly, extra: { ECCLIUM_READ_ONLY: 'true' } });
    const { code } = await t.call(due);
    expect(code).toBe(exitCodes.ok);
    expect(readdirSync(t.draftsDir)).toEqual([draftName]);
    t.assertNothingLeaked();
  });

  it('does not start a draft routine without the folder stop, also while the configuration only reads', async () => {
    const t = setup({ ...draftOnly, extra: { ECCLIUM_READ_ONLY: 'true' } });
    rmSync(t.stopDir, { recursive: true });
    const { code, stderr } = await t.call(due);
    expect(code).toBe(exitCodes.invalidConfig);
    expect(stderr).toContain(
      refusedText({ routineId: draftRoutine, code: 'runner_stop_dir_missing' }),
    );
    expect(t.plugin.calls()).toEqual([]);
    expect(t.modelCalls).toEqual([]);
    expect(existsSync(t.draftsDir)).toBe(false);
    t.assertNothingLeaked();
  });
});

describe('ecclium run-once <Routine>', () => {
  it('runs a routine by hand, without a try, closes its trigger, and runs it again although it is not due', async () => {
    const t = setup();
    const first = await t.call(byHand(wikiRoutine));
    expect(first.code).toBe(exitCodes.ok);
    expect(t.patches()).toHaveLength(1);
    const [line] = t.runLines();
    expect(line).toMatchObject({
      routineId: wikiRoutine,
      period: '2026-W46',
      runResult: 'written',
    });
    expect(line).not.toHaveProperty('attempt');

    // The run by hand closed the trigger: a pass reads nothing.
    const reads = t.plugin.calls().length;
    const pass = await t.call(due);
    expect(pass.code).toBe(exitCodes.ok);
    expect(t.plugin.calls()).toHaveLength(reads);
    expect(t.runLines()).toHaveLength(1);

    // By hand it runs although it is not due, and replaces its section.
    t.state.answer = {
      unbesetzt: [
        { datum: '2026-11-15', termin: 'Gottesdienst', dienst: 'Sigrist' },
      ],
    };
    const again = await t.call(byHand(wikiRoutine));
    expect(again.code).toBe(exitCodes.ok);
    expect(t.patches()).toHaveLength(2);
    expect(t.pageText()).toContain('Gottesdienst: Sigrist');
    expect(t.pageText()).not.toContain('Mesmer');
    expect(t.runLines()).toHaveLength(2);
    t.assertNothingLeaked();
  });

  it('refuses a routine that is not in the folder with 64, without its name, and reads nothing', async () => {
    const t = setup();
    const unknown = `fehlt-${(makeCanary('token').cores[0] ?? '').toLowerCase().slice(0, 12)}`;
    const { code, stdout, stderr } = await t.call(byHand(unknown));
    expect(code).toBe(exitCodes.usage);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([runnerStartTexts.routine_unknown]);
    expect(stderr.join('\n')).not.toContain(unknown);
    expect(t.plugin.calls()).toEqual([]);
    expect(t.auditLines()).toEqual([]);
    t.assertNothingLeaked();
  });
});

describe('the ID of a routine of ecclium run-once', () => {
  it('refuses an ID of another form with 64 before reading any file, and never repeats it', async () => {
    const t = setup();
    for (const given of [
      'Gross',
      '../routinen',
      '-vorne',
      'a'.repeat(64),
      '',
    ]) {
      const { code, stdout, stderr } = await t.call(byHand(given));
      expect(code).toBe(exitCodes.usage);
      expect(stdout).toEqual([]);
      expect(stderr).toEqual([runnerStartTexts.routine_invalid]);
    }
    expect(t.plugin.calls()).toEqual([]);
    expect(t.auditLines()).toEqual([]);
  });
});

describe('ecclium run-once <Routine> --preview', () => {
  it('prints the section on stdout and writes nothing, without an entry of the policy and while the configuration only reads', async () => {
    const t = setup({
      routines: { [wikiRoutine]: { notify: ['stdout', 'file'] } },
      entries: [],
      extra: { ECCLIUM_READ_ONLY: 'true' },
      strict: true,
    });
    const { code, stdout, stderr } = await t.call(preview(wikiRoutine));
    expect(code).toBe(exitCodes.ok);
    const shown = stdout.join('\n');
    // One line of stdout per line of the section, never an escaped break.
    expect(stdout).toContain('### Dienstplan 2026-W46');
    expect(shown).not.toContain('\\u{a}');
    expect(shown).toContain('Gottesdienst: Mesmer');
    expect(shown).not.toContain('Automatisch erstellt');
    // No notice, neither on stdout nor in the file.
    expect(jsonLines(stdout)).toEqual([]);
    expect(existsSync(t.notifyFile)).toBe(false);
    expect(stderr.join('\n')).toContain(
      `Routine ‹${wikiRoutine}›, Periode ‹2026-W46›: Vorschau auf stdout`,
    );
    // It read and asked the model, but sent nothing that writes.
    expect(t.plugin.calls().length).toBeGreaterThan(0);
    expect(t.modelCalls).toHaveLength(1);
    expect(t.churchtoolsCalls.filter((call) => call.method !== 'GET')).toEqual(
      [],
    );
    expect(t.pageText()).toBe(`# ${pageTitle}`);
    const [line] = t.runLines();
    expect(t.runLines()).toHaveLength(1);
    expect(line).toMatchObject({
      type: 'run',
      routineId: wikiRoutine,
      period: '2026-W46',
      runResult: 'preview',
      outcome: 'ok',
    });
    expect(line).not.toHaveProperty('attempt');
    t.assertNothingLeaked();
  });

  it('writes no draft and sends no notice for a draft routine', async () => {
    const t = setup(draftOnly);
    const { code, stdout } = await t.call(preview(draftRoutine));
    expect(code).toBe(exitCodes.ok);
    expect(stdout.join('\n')).toContain('Gottesdienst: Mesmer');
    expect(existsSync(t.draftsDir)).toBe(false);
    expect(existsSync(t.notifyFile)).toBe(false);
    // The routine is still due: a pass runs it.
    const pass = await t.call(due);
    expect(pass.code).toBe(exitCodes.ok);
    expect(readdirSync(t.draftsDir)).toEqual([draftName]);
    t.assertNothingLeaked();
  });
});

describe('the catalog of the runner itself', () => {
  it('reads with a read tool of the core in a preview, without ECCLIUM_TOOLSETS', async () => {
    const t = setup({
      routines: {
        [wikiRoutine]: {
          inputs: [
            {
              name: 'kategorien',
              tool: 'ct_wiki_categories_list',
              params: {},
              maxItems: 10,
            },
          ],
        },
      },
      entries: [],
      extra: { ECCLIUM_TOOLSETS: undefined },
    });
    const { code, stdout } = await t.call(preview(wikiRoutine), {
      ownCatalog: true,
    });
    expect(code).toBe(exitCodes.ok);
    expect(stdout).toContain('### Dienstplan 2026-W46');
    // The read went to ChurchTools with the own account of the runner.
    const reads = t.churchtoolsCalls.filter(
      (call) =>
        call.method === 'GET' && call.path.startsWith('/api/wiki/categories'),
    );
    expect(reads).toHaveLength(1);
    expect(reads[0]?.headers['authorization']).toBe(
      `Login ${t.runnerToken.value}`,
    );
    t.assertNothingLeaked();
  });
});

describe('a preview of a routine that does not start', () => {
  it('names what keeps the preview from running, not the missing entry of its target', async () => {
    // Without an entry for its target and with a model nobody offers: the
    // full preparation stops at the target, the preview at the model.
    const t = setup({
      routines: { [wikiRoutine]: { model: 'lang' } },
      entries: [],
    });
    const { code, stdout, stderr } = await t.call(preview(wikiRoutine));
    expect(code).toBe(exitCodes.invalidConfig);
    expect(stdout).toEqual([]);
    expect(stderr).toContain(
      refusedText({
        routineId: wikiRoutine,
        code: 'run_model_unknown',
        field: 'generate.model',
      }),
    );
    expect(stderr.join('\n')).not.toContain('run_target_unlisted');
    expect(t.plugin.calls()).toEqual([]);
  });
});

describe('a key file of a model that a call cannot use', () => {
  it('keeps only the routines of that model from starting, with 78, and reads nothing', async () => {
    const t = setup();
    const { code, stderr } = await t.call(
      { kind: 'due' },
      { readModelKey: () => ({ ok: false, code: 'token_file_mode' }) },
    );
    expect(code).toBe(exitCodes.invalidConfig);
    expect(stderr).toContain(modelKeyText('default', 'token_file_mode'));
    // Each due routine of the model is named on its own; the runner as a
    // whole did not stop.
    expect(
      stderr.some((line) =>
        line.includes('nicht gestartet, Code ‹token_file_mode›'),
      ),
    ).toBe(true);
    expect(stderr.join('\n')).not.toContain('Der Runner startet nicht');
    expect(t.plugin.calls()).toEqual([]);
    expect(t.runLines()).toEqual([]);
    t.assertNothingLeaked();
  });
});

describe('the exit codes of ecclium run-once', () => {
  it('gives 75 when ChurchTools answers a read with 503, and keeps the trigger open for a later try', async () => {
    const t = setup({
      routines: {
        'termine-lesen': {
          target: 'draft',
          notify: ['file'],
          inputs: [
            {
              name: 'termine',
              tool: 'ct_events_list',
              params: { from: '+0d', to: '+14d' },
              maxItems: 30,
            },
          ],
        },
      },
      entries: [],
    });
    t.state.unavailable = true;
    const { code, stderr } = await t.call(due);
    expect(code).toBe(exitCodes.tempFail);
    expect(stderr.join('\n')).toContain(
      'Ein späterer Aufruf versucht es noch einmal.',
    );
    // The read went out with the own account of the runner.
    expect(t.churchtoolsCalls.length).toBeGreaterThan(0);
    for (const call of t.churchtoolsCalls) {
      expect(call.headers['authorization']).toBe(
        `Login ${t.runnerToken.value}`,
      );
    }
    expect(t.modelCalls).toEqual([]);
    expect(t.runLines()).toEqual([
      expect.objectContaining({
        outcome: 'error',
        errorCode: 'upstream',
        runResult: 'failed',
        runStep: 'input',
        attempt: 1,
      }),
    ]);
    expect(existsSync(join(t.draftsDir, 'termine-lesen-2026-W46.md'))).toBe(
      false,
    );
    // Within the same window of 15 minutes no second try begins.
    expect((await t.call(due)).code).toBe(exitCodes.ok);
    expect(t.runLines()).toHaveLength(1);
    // Half an hour later the trigger is tried again.
    t.state.laterMs = 30 * 60_000;
    expect((await t.call(due)).code).toBe(exitCodes.tempFail);
    expect(t.runLines().map((line) => line['attempt'])).toEqual([1, 2]);
    t.assertNothingLeaked();
  });

  it('gives 65 when the answer of the model breaks the content policy, and writes nothing', async () => {
    const t = setup();
    t.state.answer = {
      unbesetzt: [
        {
          datum: '2026-11-15',
          termin: 'Gottesdienst',
          dienst: 'Fragen an erika.beispiel@example.org',
        },
      ],
    };
    const { code, stdout } = await t.call(due);
    expect(code).toBe(exitCodes.dataError);
    expect(t.patches()).toEqual([]);
    expect(t.runLines()).toEqual([
      expect.objectContaining({
        outcome: 'denied',
        errorCode: 'validation',
        contentViolations: ['contact'],
        runResult: 'failed',
      }),
    ]);
    // The notice holds the code, never the address.
    expect(stdout.join('\n')).not.toContain('erika.beispiel');
    t.assertNothingLeaked();
  });

  it('gives 74 when the file of the notices is a link, and leaves its target alone', async () => {
    const t = setup({ routines: { [wikiRoutine]: { notify: ['file'] } } });
    const target = join(t.base, 'elsewhere.jsonl');
    writeFileSync(target, '', { mode: 0o600 });
    symlinkSync(target, t.notifyFile);
    const { code, stderr } = await t.call(due);
    expect(code).toBe(exitCodes.ioError);
    // The write itself went through.
    expect(t.patches()).toHaveLength(1);
    expect(stderr.join('\n')).toContain(
      'Die Meldung des Laufs liess sich nicht ganz senden.',
    );
    expect(readFileSync(target, 'utf8')).toBe('');
    t.assertNothingLeaked();
  });
});

describe('ecclium run-once through the command line', () => {
  it('shows a preview for a routine with --preview, and writes nothing', async () => {
    const t = setup();
    const { code, stdout } = await t.cli([
      'run-once',
      wikiRoutine,
      '--preview',
    ]);
    expect(code).toBe(exitCodes.ok);
    expect(stdout).toContain('### Dienstplan 2026-W46');
    expect(stdout).toContain('Gottesdienst: Mesmer');
    expect(t.patches()).toEqual([]);
    expect(t.runLines()).toEqual([
      expect.objectContaining({ runResult: 'preview' }),
    ]);
    t.assertNothingLeaked();
  });

  it('runs a routine by hand without --preview', async () => {
    const t = setup();
    const { code } = await t.cli(['run-once', wikiRoutine]);
    expect(code).toBe(exitCodes.ok);
    expect(t.patches()).toHaveLength(1);
    expect(t.runLines()).toEqual([
      expect.not.objectContaining({ attempt: expect.anything() as unknown }),
    ]);
    t.assertNothingLeaked();
  });

  it('runs the routines that are due with --due', async () => {
    const t = setup();
    const { code } = await t.cli(['run-once', '--due']);
    expect(code).toBe(exitCodes.ok);
    expect(t.patches()).toHaveLength(1);
    expect(t.runLines()).toEqual([expect.objectContaining({ attempt: 1 })]);
    t.assertNothingLeaked();
  });
});
