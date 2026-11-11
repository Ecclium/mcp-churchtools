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
  utimesSync,
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
import {
  createLogger,
  createStderrWriter,
  systemClock,
} from '@ecclium/mcp-churchtools-core/composition';
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
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ExitCode, exitCodes } from '../exit-codes.js';
import { run } from '../main.js';
import { maxWaitMs, minWaitMs, runDaemon, waitBefore } from './daemon.js';
import type { RunnerHost } from './host.js';
import type { openRunnerProcess, RunnerProcess } from './process.js';
import { runOnce, type RunOnceOptions } from './run-once.js';
import type { RunnerMode } from './start.js';
import {
  daemonStartText,
  modelKeyText,
  refusedText,
  runnerProcessTexts,
  runnerStartTexts,
} from './texts.js';

// The mode of a folder, through its descriptor.
const fstatMode = (path: string): number => {
  const fd = openSync(path, 'r');
  try {
    return fstatSync(fd).mode & 0o777;
  } finally {
    closeSync(fd);
  }
};

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
  onPatch: () => void = () => undefined,
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
      // While the write is under way, such as for a signal.
      onPatch();
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

/**
 * A process that only the test drives: its signals, its faults, its end
 * and the waits of the daemon, which pass at once and move the clock.
 */
const testHost = (advance: (ms: number) => void) => {
  const signals = new Map<string, (() => void)[]>();
  const faults: ((kind: 'exception' | 'rejection', value: unknown) => void)[] =
    [];
  const exits: ExitCode[] = [];
  const waits: number[] = [];
  // What happens at each wait, by its number from 1: by default the wait
  // passes; a test sends a signal here to end the daemon.
  let atWait: (count: number) => void = () => undefined;
  const send = (signal: 'SIGTERM' | 'SIGINT' | 'SIGHUP'): void => {
    for (const listener of [...(signals.get(signal) ?? [])]) listener();
  };
  const host: RunnerHost = Object.freeze({
    onSignal: (
      signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP',
      listener: () => void,
    ) => {
      const list = signals.get(signal) ?? [];
      list.push(listener);
      signals.set(signal, list);
      return () => {
        signals.set(
          signal,
          (signals.get(signal) ?? []).filter((item) => item !== listener),
        );
      };
    },
    onFault: (
      listener: (kind: 'exception' | 'rejection', value: unknown) => void,
    ) => {
      faults.push(listener);
      return () => {
        faults.splice(faults.indexOf(listener), 1);
      };
    },
    exit: (code: ExitCode) => {
      exits.push(code);
    },
    wait: (ms: number, signal: AbortSignal) => {
      waits.push(ms);
      advance(ms);
      atWait(waits.length);
      return signal.aborted ? Promise.resolve() : Promise.resolve();
    },
  });
  return {
    host,
    send,
    exits,
    waits,
    faults,
    listening: () =>
      [...signals.values()].reduce((sum, list) => sum + list.length, 0) +
      faults.length,
    onWait: (react: (count: number) => void) => {
      atWait = react;
    },
  };
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
    // What happens while the model answers and while a page is written,
    // such as a signal.
    onModel: (): void => undefined,
    onPatch: (): void => undefined,
    // What happens at each line of the log of a call, such as a signal.
    onLog: (() => undefined) as (line: string) => void,
    // Whether the endpoint of the model answers with 503.
    modelDown: false,
  };
  // Frozen, function and all, as the core takes a clock.
  const clock = Object.freeze({
    now: Object.freeze(() => now + state.laterMs),
  });
  const driver = testHost((ms) => {
    state.laterMs += ms;
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
    serve(double, pages, state.unavailable, state.rights, () => {
      state.onPatch();
    });
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
      .reply(() => {
        state.onModel();
        if (state.modelDown) {
          return {
            statusCode: 503,
            data: '{}',
            responseOptions: { headers: jsonHeaders },
          };
        }
        return {
          statusCode: 200,
          data: chatCompletion({ content: JSON.stringify(state.answer) }),
          responseOptions: { headers: jsonHeaders },
        };
      })
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
        const line = Buffer.from(buffer)
          .subarray(offset, offset + length)
          .toString('utf8');
        logs.push(line);
        state.onLog(line);
        return length;
      },
      createTransport,
      createModelTransport,
      clock,
      host: driver.host,
    });
    stdout.push(...out);
    stderr.push(...err);
    return { code, stdout: out, stderr: err };
  };

  // The daemon, which runs until the test sends a signal at a wait.
  const daemon = async (
    more: CallOptions & {
      readonly openProcess?: typeof openRunnerProcess;
    } = {},
  ) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runDaemon({
      environment,
      execArgv: [],
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
      host: driver.host,
      ...(more.openProcess === undefined
        ? {}
        : { openProcess: more.openProcess }),
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
        host: driver.host,
      },
      runner: {
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
        host: driver.host,
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
    daemon,
    driver,
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

// SIGTERM and SIGINT abort reading and the model at once and never a
// write that has begun; a second signal ends the process at once, but
// never while a write runs (ADR 0033, decided on 10. and 11.11.2026).
describe('the signals of ecclium run-once', () => {
  it.each([
    ['SIGTERM', exitCodes.terminated, 'process_sigterm'],
    ['SIGINT', exitCodes.interrupted, 'process_sigint'],
    ['SIGHUP', exitCodes.hungUp, 'process_sighup'],
  ] as const)(
    'stops at %s while the model answers: writes nothing, keeps the trigger open and ends with %i',
    async (signal, exit, event) => {
      // A draft, whose later try needs no clock of ChurchTools.
      const t = setup(draftOnly);
      t.state.onModel = () => {
        t.driver.send(signal);
      };
      const { code, stderr } = await t.call(due);
      expect(code).toBe(exit);
      expect(stderr).toContain(runnerProcessTexts.signal);
      expect(existsSync(join(t.draftsDir, draftName))).toBe(false);
      expect(t.driver.exits).toEqual([]);
      expect(t.logs.join('')).toContain(`"event":"${event}"`);
      // The try counted, and the trigger stays open for a later one.
      expect(t.runLines()).toEqual([
        expect.objectContaining({
          runResult: 'failed',
          runStep: 'model',
          errorCode: 'network',
          attempt: 1,
        }),
      ]);
      t.state.onModel = () => undefined;
      t.state.laterMs = 30 * 60_000;
      expect((await t.call(due)).code).toBe(exitCodes.ok);
      expect(existsSync(join(t.draftsDir, draftName))).toBe(true);
      // Every listener of the process is gone again.
      expect(t.driver.listening()).toBe(0);
      t.assertNothingLeaked();
    },
  );

  it('ends a write that has begun also after a second signal, and only then with 143', async () => {
    const t = setup();
    t.state.onPatch = () => {
      t.driver.send('SIGTERM');
      t.driver.send('SIGTERM');
    };
    const { code } = await t.call(due);
    expect(code).toBe(exitCodes.terminated);
    // The write ended whole, with its audit line and the end of its run.
    expect(t.driver.exits).toEqual([]);
    expect(t.patches()).toHaveLength(1);
    expect(t.pageText()).toContain('Gottesdienst: Mesmer');
    expect(t.runLines()).toEqual([
      expect.objectContaining({ runResult: 'written' }),
    ]);
    t.assertNothingLeaked();
  });

  it('cuts neither the end of the trigger nor the audit line nor the notice after a write at a second signal', async () => {
    const t = setup({
      routines: { [wikiRoutine]: { notify: ['stdout', 'file'] } },
    });
    t.state.onPatch = () => {
      t.driver.send('SIGTERM');
    };
    // After the write has returned, before its trigger closes.
    t.state.onLog = (line) => {
      if (line.includes('"event":"run_written"')) t.driver.send('SIGTERM');
    };
    const { code, stdout } = await t.call(due);
    expect(code).toBe(exitCodes.terminated);
    expect(t.driver.exits).toEqual([]);
    expect(t.logs.join('')).toContain('"event":"run_written"');
    expect(t.runLines()).toEqual([
      expect.objectContaining({ runResult: 'written' }),
    ]);
    expect(jsonLines(stdout)).toHaveLength(1);
    expect(t.notices()).toHaveLength(1);
    // The trigger is closed: a later call writes nothing.
    t.state.onPatch = () => undefined;
    t.state.onLog = () => undefined;
    expect((await t.call(due)).code).toBe(exitCodes.ok);
    expect(t.patches()).toHaveLength(1);
  });

  it('ends at once at a second signal while no write runs', async () => {
    const t = setup();
    t.state.onModel = () => {
      t.driver.send('SIGTERM');
      t.driver.send('SIGINT');
    };
    const { code } = await t.call(due);
    expect(t.driver.exits).toEqual([exitCodes.interrupted]);
    // The host of the test does not end the process; the call ends as the
    // first signal says.
    expect(code).toBe(exitCodes.terminated);
    expect(t.patches()).toEqual([]);
  });

  it('ends with 70 after a fault nothing caught, with one line and its code', async () => {
    const t = setup();
    t.state.onModel = () => {
      for (const listener of [...t.driver.faults]) {
        listener('rejection', new Error('a value that never shows'));
      }
    };
    await t.call(due);
    expect(t.driver.exits).toEqual([exitCodes.internal]);
    expect(t.logs.join('')).toContain('"event":"process_unhandled_rejection"');
    expect(t.logs.join('')).not.toContain('a value that never shows');
  });
});

// What a call of the runner deletes past its retention at its start, as
// the server does (ADR 0028, ADR 0031).
describe('the retention in ecclium run-once', () => {
  it('deletes an audit file past its retention and a day key of the snapshots past 30 days', async () => {
    const t = setup();
    const auditDir = privateDir(join(t.stateDir, 'audit'));
    const oldAudit = privateFile(
      join(auditDir, 'audit-2025-01-01-000000-1-1.jsonl'),
      '',
    );
    // A file counts by its name and its last change.
    utimesSync(
      oldAudit,
      new Date(Date.UTC(2025, 0, 1)),
      new Date(Date.UTC(2025, 0, 1)),
    );
    // The day keys of the snapshots, one past 30 days and one within.
    const snapshotDays = privateDir(join(t.base, 'keys', 'snapshot'));
    const dayFile = (day: string): string =>
      privateFile(join(snapshotDays, `default.${day}.key`), 'k'.repeat(32));
    const old = dayFile('2026-09-01');
    const kept = dayFile('2026-11-01');
    const { code } = await t.call(due);
    expect(code).toBe(exitCodes.ok);
    expect(existsSync(oldAudit)).toBe(false);
    // The deletion of the day keys runs beside the pass.
    await vi.waitFor(() => {
      expect(existsSync(old)).toBe(false);
    });
    expect(existsSync(kept)).toBe(true);
    expect(t.logs.join('')).toContain('"event":"audit_files_deleted"');
    t.assertNothingLeaked();
  });

  it('deletes nothing in a preview', async () => {
    const t = setup();
    const auditDir = privateDir(join(t.stateDir, 'audit'));
    const oldAudit = privateFile(
      join(auditDir, 'audit-2025-01-01-000000-1-1.jsonl'),
      '',
    );
    utimesSync(
      oldAudit,
      new Date(Date.UTC(2025, 0, 1)),
      new Date(Date.UTC(2025, 0, 1)),
    );
    const snapshotDays = privateDir(join(t.base, 'keys', 'snapshot'));
    const day = '2026-09-01';
    const oldDay = privateFile(
      join(snapshotDays, `default.${day}.key`),
      'k'.repeat(32),
    );
    expect((await t.call(preview(wikiRoutine))).code).toBe(exitCodes.ok);
    // Long enough for a deletion beside the call, which a preview starts
    // none of.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(existsSync(oldAudit)).toBe(true);
    expect(existsSync(oldDay)).toBe(true);
  });
});

// The metrics file mirrors each routine and the head of the chain of the
// audit file; it never decides about a run (ADR 0028, ADR 0033).
describe('the metrics file of the runner', () => {
  const sha256 = (text: string): string =>
    createHash('sha256').update(text).digest('hex');

  // The last whole line of the audit files of a test, with its file.
  const lastAuditLine = (stateDir: string) => {
    const dir = join(stateDir, 'audit');
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .sort();
    for (const file of files.reverse()) {
      const lines = readFileSync(join(dir, file), 'utf8')
        .split('\n')
        .filter((line) => line !== '');
      const last = lines.at(-1);
      if (last !== undefined) return { file, line: last, seq: lines.length };
    }
    return undefined;
  };

  const withMetrics = (options: SetupOptions = {}) => {
    const t = setup(options);
    const metricsFile = join(t.base, 'metrics', 'runner.prom');
    t.environment['ECCLIUM_RUNNER_METRICS_FILE'] = metricsFile;
    return { t, metricsFile };
  };

  it('writes the next look, the last success and status and the head of the chain, privately', async () => {
    const { t, metricsFile } = withMetrics();
    expect((await t.call(due)).code).toBe(exitCodes.ok);
    const { text, mode } = readWithMode(metricsFile);
    expect(mode).toBe(0o600);
    expect(fstatMode(join(t.base, 'metrics'))).toBe(0o700);
    // The next Monday at 06:00 in Zurich.
    expect(text).toContain(
      `ecclium_runner_next_run_timestamp_seconds{routine="${wikiRoutine}"} ${String(Date.UTC(2026, 10, 16, 5) / 1000)}\n`,
    );
    expect(text).toContain(
      `ecclium_runner_last_success_timestamp_seconds{routine="${wikiRoutine}"} ${String(now / 1000)}\n`,
    );
    expect(text).toContain(
      `ecclium_runner_last_status{routine="${wikiRoutine}",status="written"} 1\n`,
    );
    const last = lastAuditLine(t.stateDir);
    expect(last).toBeDefined();
    expect(text).toContain(
      `ecclium_runner_audit_chain_head{file="${last?.file ?? ''}",hash="${sha256(last?.line ?? '')}"} ${String(last?.seq ?? 0)}\n`,
    );
    t.assertNothingLeaked();
    assertNoCanary([text], [t.runnerToken, t.accountToken], 'the metrics');
  });

  it('names a routine that does not start as refused, with its code', async () => {
    const { t, metricsFile } = withMetrics({
      routines: {
        [wikiRoutine]: {},
        'ohne-modell': { target: 'draft', model: 'unbekannt' },
      },
    });
    expect((await t.call(due)).code).toBe(exitCodes.invalidConfig);
    const { text } = readWithMode(metricsFile);
    expect(text).toContain(
      'ecclium_runner_last_status{routine="ohne-modell",status="refused",code="run_model_unknown"} 1\n',
    );
    expect(text).not.toContain(
      'ecclium_runner_next_run_timestamp_seconds{routine="ohne-modell"}',
    );
  });

  it('carries the values of the routines a call did not run, and writes none for a preview', async () => {
    const { t, metricsFile } = withMetrics({
      routines: {
        [wikiRoutine]: {},
        [draftRoutine]: { target: 'draft', notify: ['file'] },
      },
    });
    expect((await t.call(byHand(wikiRoutine))).code).toBe(exitCodes.ok);
    const first = readWithMode(metricsFile).text;
    expect(first).toContain(
      `ecclium_runner_last_status{routine="${wikiRoutine}",status="written"} 1\n`,
    );
    expect(first).not.toContain(`routine="${draftRoutine}",status=`);
    // A later call by hand of the other routine keeps what the first said.
    t.state.laterMs = 60_000;
    expect((await t.call(byHand(draftRoutine))).code).toBe(exitCodes.ok);
    const second = readWithMode(metricsFile).text;
    expect(second).toContain(
      `ecclium_runner_last_status{routine="${wikiRoutine}",status="written"} 1\n`,
    );
    expect(second).toContain(
      `ecclium_runner_last_status{routine="${draftRoutine}",status="drafted"} 1\n`,
    );
    expect(second).toContain(
      `ecclium_runner_last_success_timestamp_seconds{routine="${wikiRoutine}"} ${String(now / 1000)}\n`,
    );
    // A preview leaves the file as it is.
    t.state.laterMs = 120_000;
    expect((await t.call(preview(wikiRoutine))).code).toBe(exitCodes.ok);
    expect(readWithMode(metricsFile).text).toBe(second);
  });

  it('starts anew from a file that is not its own, and never names its lines', async () => {
    const { t, metricsFile } = withMetrics();
    privateDir(join(t.base, 'metrics'));
    privateFile(
      metricsFile,
      'ecclium_runner_last_status{routine="fremd",status="written"} 1\nnode_cpu 1\n',
    );
    expect((await t.call(due)).code).toBe(exitCodes.ok);
    const { text } = readWithMode(metricsFile);
    expect(text).not.toContain('fremd');
    expect(text).not.toContain('node_cpu');
    expect(text).toContain(`routine="${wikiRoutine}",status="written"`);
  });

  it('does not start with 78 when the folder of the file is not private, and reads nothing', async () => {
    const { t } = withMetrics();
    mkdirSync(join(t.base, 'metrics'), { mode: 0o755 });
    chmodSync(join(t.base, 'metrics'), 0o755);
    const { code, stderr } = await t.call(due);
    expect(code).toBe(exitCodes.invalidConfig);
    expect(stderr.join('\n')).toContain(
      'Der Ordner der Metrikdatei aus ‹ECCLIUM_RUNNER_METRICS_FILE› lässt sich nicht als privater Ordner verwenden',
    );
    expect(t.plugin.calls()).toEqual([]);
    expect(t.runLines()).toEqual([]);
    t.assertNothingLeaked();
  });

  it('ends with 74 when the file cannot be written, after the runs themselves', async () => {
    const { t, metricsFile } = withMetrics();
    // A folder in the place of the file.
    privateDir(join(t.base, 'metrics'));
    privateDir(metricsFile);
    const { code, stderr } = await t.call(due);
    expect(code).toBe(exitCodes.ioError);
    expect(stderr).toContain(runnerProcessTexts.metrics_failed);
    expect(t.patches()).toHaveLength(1);
    t.assertNothingLeaked();
  });
});

// The daemon runs the same pass at each trigger and ends only after a
// signal, a halt of writes or a fault (ADR 0033, ADR 0034).
describe('ecclium runner', () => {
  it('runs a due routine once, looks again within 15 minutes and ends after SIGTERM with 143', async () => {
    const t = setup({
      routines: {
        [wikiRoutine]: {},
        'nie-faellig': {
          target: 'draft',
          notify: ['file'],
          schedule: '0 6 1 1 *',
        },
      },
    });
    t.driver.onWait((count) => {
      if (count === 3) t.driver.send('SIGTERM');
    });
    const { code, stderr } = await t.daemon();
    expect(code).toBe(exitCodes.terminated);
    expect(stderr[0]).toBe(daemonStartText({ routines: 2, refused: 0 }));
    // One write for the trigger of the week, whatever the number of looks.
    expect(t.patches()).toHaveLength(1);
    expect(t.runLines()).toHaveLength(1);
    expect(t.driver.waits).toHaveLength(3);
    for (const wait of t.driver.waits) {
      expect(wait).toBeGreaterThanOrEqual(1_000);
      expect(wait).toBeLessThanOrEqual(15 * 60_000);
    }
    // A pass where nothing was due says nothing.
    expect(
      stderr.filter((line) => line.startsWith('Durchgang beendet')),
    ).toEqual([
      'Durchgang beendet: 1 Lauf, 0 übersprungen, 0 Routinen starten nicht.',
    ]);
    expect(t.driver.listening()).toBe(0);
    t.assertNothingLeaked();
  });

  it('tries a run that failed for a passing reason again at a later look', async () => {
    const t = setup(draftOnly);
    t.state.modelDown = true;
    t.driver.onWait((count) => {
      if (count === 1) t.state.modelDown = false;
      if (count === 4) t.driver.send('SIGTERM');
    });
    const daemonRun = await t.daemon();
    expect(daemonRun.code).toBe(exitCodes.terminated);
    expect(t.runLines().map((line) => line['runResult'])).toEqual([
      'failed',
      'drafted',
    ]);
    expect(t.runLines().map((line) => line['attempt'])).toEqual([1, 2]);
  });

  it('names the routines that do not start at every pass and runs the others', async () => {
    const t = setup({
      routines: {
        [wikiRoutine]: {},
        'ohne-modell': { target: 'draft', model: 'unbekannt' },
      },
    });
    t.driver.onWait((count) => {
      if (count === 2) t.driver.send('SIGINT');
    });
    const { code, stderr } = await t.daemon();
    expect(code).toBe(exitCodes.interrupted);
    const refusedLine = refusedText({
      routineId: 'ohne-modell',
      code: 'run_model_unknown',
      field: 'generate.model',
    });
    // At the start, and at the pass after the first wait; the signal at
    // the second wait ends the daemon before another pass.
    expect(stderr.filter((line) => line === refusedLine)).toHaveLength(2);
    expect(t.patches()).toHaveLength(1);
  });

  it('does not start with 78 when no routine starts', async () => {
    const t = setup({
      routines: { 'ohne-modell': { target: 'draft', model: 'unbekannt' } },
      entries: [],
    });
    const { code, stderr } = await t.daemon();
    expect(code).toBe(exitCodes.invalidConfig);
    expect(stderr).toContain(runnerProcessTexts.no_routine);
    expect(t.driver.waits).toEqual([]);
    expect(t.runLines()).toEqual([]);
  });

  it('starts through the command line with ecclium runner and ends after a signal', async () => {
    const t = setup();
    t.driver.onWait(() => {
      t.driver.send('SIGTERM');
    });
    const { code } = await t.cli(['runner']);
    expect(code).toBe(exitCodes.terminated);
    expect(t.patches()).toHaveLength(1);
    t.assertNothingLeaked();
  });
});

// The daemon around a process that a test opens, for what a real process
// cannot be brought to on doubles: the halt of writes after a line of the
// audit that did not reach the file (ADR 0029).
describe('ecclium runner around a process of the test', () => {
  const fakeProcess =
    (
      t: ReturnType<typeof setup>,
      over: Partial<RunnerProcess> = {},
    ): typeof openRunnerProcess =>
    () => ({
      ok: true,
      process: {
        logger: createLogger({
          writer: createStderrWriter({
            writeSync: (_fd, _buffer, _offset, length) => length,
          }),
          clock: systemClock,
          minLevel: 'info',
        }),
        clock: { now: () => now + t.state.laterMs },
        sweep: () => undefined,
        tick: () => undefined,
        pass: () => Promise.resolve({ routines: [], severity: 'ok' }),
        preview: () => Promise.reject(new Error('no preview')),
        after: () =>
          Promise.resolve({
            next: new Map([[wikiRoutine, now + t.state.laterMs + 90_000]]),
          }),
        writesHalted: () => false,
        close: () => undefined,
        ...over,
      },
    });

  it('ends with 75 after the pass in which writes became halted, so that a restart lifts the halt', async () => {
    const t = setup();
    let closed = 0;
    const { code, stderr } = await t.daemon({
      openProcess: fakeProcess(t, {
        writesHalted: () => true,
        close: () => {
          closed += 1;
        },
      }),
    });
    expect(code).toBe(exitCodes.tempFail);
    expect(stderr).toContain(runnerProcessTexts.halted);
    expect(t.driver.waits).toEqual([]);
    expect(closed).toBe(1);
    expect(t.driver.listening()).toBe(0);
  });

  it('waits until the earliest next look, says when the metrics file failed, and goes on', async () => {
    const t = setup();
    t.driver.onWait((count) => {
      if (count === 2) t.driver.send('SIGTERM');
    });
    const { code, stderr } = await t.daemon({
      openProcess: fakeProcess(t, {
        after: () =>
          Promise.resolve({
            next: new Map([
              [wikiRoutine, now + t.state.laterMs + 90_000],
              ['other', now + t.state.laterMs + 3 * 3_600_000],
            ]),
            metrics: false,
          }),
      }),
    });
    expect(code).toBe(exitCodes.terminated);
    expect(t.driver.waits).toEqual([90_000, 90_000]);
    expect(
      stderr.filter((line) => line === runnerProcessTexts.metrics_failed),
    ).toHaveLength(2);
  });

  it('ends with the code of the process when it does not open', async () => {
    const t = setup();
    const { code } = await t.daemon({
      openProcess: () => ({ ok: false, code: exitCodes.invalidConfig }),
    });
    expect(code).toBe(exitCodes.invalidConfig);
  });
});

describe('waitBefore', () => {
  it('waits until the earliest next look, at least a second and at most 15 minutes', () => {
    const start = Date.UTC(2026, 10, 11, 7);
    expect(waitBefore(start, new Map([['a', start + 60_000]]))).toBe(60_000);
    expect(
      waitBefore(
        start,
        new Map([
          ['a', start + 600_000],
          ['b', start + 120_000],
        ]),
      ),
    ).toBe(120_000);
    expect(waitBefore(start, new Map([['a', start - 5_000]]))).toBe(minWaitMs);
    expect(waitBefore(start, new Map([['a', start + 86_400_000]]))).toBe(
      maxWaitMs,
    );
    expect(waitBefore(start, new Map())).toBe(maxWaitMs);
    expect(waitBefore(start, new Map([['a', Number.NaN]]))).toBe(maxWaitMs);
    expect(waitBefore(Number.NaN, new Map([['a', start]]))).toBe(maxWaitMs);
  });
});

// One run of a routine in the audit, for the people who lead a
// congregation (ADR 0028, ADR 0033).
describe('ecclium audit show --run', () => {
  it('shows routine, period, try, begin and end, the outcome, the reads per tool and the writes per way', async () => {
    const t = setup();
    expect((await t.call(due)).code).toBe(exitCodes.ok);
    const runId = String(t.runLines()[0]?.['runId']);
    const { code, stdout } = await t.cli(['audit', 'show', '--run', runId]);
    expect(code).toBe(exitCodes.ok);
    const lines = stdout.split('\n');
    expect(lines[0]).toBe(`Lauf ‹${runId}›, Zeiten in UTC`);
    expect(lines).toContain(`  Routine   ‹${wikiRoutine}›`);
    expect(lines).toContain('  Periode   ‹2026-W46›, Versuch 1');
    expect(lines).toContain('  Beginn    11.11.2026 07:00:00');
    expect(lines).toContain('  Ausgang   geschrieben');
    expect(lines).toContain('Lesungen je Tool');
    expect(lines).toContain(
      '  ct_test_events  2 Aufrufe: 2 ausgeführt, 0 mit Fehler, 0 abgelehnt',
    );
    expect(lines).toContain(
      '  ct_test_assignments  3 Aufrufe: 3 ausgeführt, 0 mit Fehler, 0 abgelehnt',
    );
    expect(lines).toContain(
      '  ct_wiki_page_append_section  Richtlinie, geschrieben und zurückgelesen: 1',
    );
    // An ID in capitals is the same run.
    expect(
      (await t.cli(['audit', 'show', '--run', runId.toUpperCase()])).stdout,
    ).toBe(stdout);
    // Nothing of the content of the run, nothing of its account.
    expect(stdout).not.toContain('Gottesdienst');
    t.assertNothingLeaked();
  });

  it('says so for a run no line names', async () => {
    const t = setup();
    expect((await t.call(due)).code).toBe(exitCodes.ok);
    const { code, stdout } = await t.cli([
      'audit',
      'show',
      '--run',
      '00000000-0000-4000-8000-0000000000ff',
    ]);
    expect(code).toBe(exitCodes.ok);
    expect(stdout).toContain('Keine Zeile nennt diesen Lauf.');
  });

  it('refuses another ID and --run with --object with 64, never repeating the value', async () => {
    const t = setup();
    const wrong = await t.cli(['audit', 'show', '--run', 'lauf-geheim-42']);
    expect(wrong.code).toBe(exitCodes.usage);
    expect(wrong.stderr).toContain('keine Kennung eines Laufs');
    expect(wrong.stderr).not.toContain('lauf-geheim-42');
    const both = await t.cli([
      'audit',
      'show',
      '--run',
      '00000000-0000-4000-8000-0000000000ff',
      '--object',
      'person:42',
    ]);
    expect(both.code).toBe(exitCodes.usage);
    expect(both.stderr).toContain(
      '‹--run› und ‹--object› gehen nicht zusammen',
    );
  });
});

describe('ecclium audit show --run with a range of days', () => {
  it('says that the end can lie outside the range', async () => {
    const t = setup();
    expect((await t.call(due)).code).toBe(exitCodes.ok);
    const runId = String(t.runLines()[0]?.['runId']);
    const { code, stdout } = await t.cli([
      'audit',
      'show',
      '--run',
      runId,
      '--until',
      '2026-11-10',
    ]);
    expect(code).toBe(exitCodes.ok);
    expect(stdout).toContain('Keine Zeile nennt diesen Lauf.');
    const within = await t.cli([
      'audit',
      'show',
      '--run',
      runId,
      '--since',
      '2026-11-11',
    ]);
    expect(within.stdout).toContain(
      '  Beginn    11.11.2026 07:00:00, erste Zeile im Zeitraum',
    );
  });
});
