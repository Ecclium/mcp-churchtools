import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createToolCatalog,
  describeRunTool,
  guardModelProvider,
  loadConfig,
  policyHashOf,
  type Trigger,
} from '@ecclium/mcp-churchtools-core';
import {
  type AuditFileWriter,
  createStderrWriter,
  createWriteHalt,
  openAuditFile,
  prepareDayKeyFolder,
  prepareQueueFolder,
  prepareQuotaFolder,
  prepareSnapshotFolder,
  type WriteHalt,
} from '@ecclium/mcp-churchtools-core/composition';
import type { HttpTransportOptions } from '@ecclium/mcp-churchtools-core/http';
import {
  createChurchToolsDouble,
  createMockModelProvider,
  createRoutinePlugin,
  doubleOrigin,
  makeCanary,
  type MockedCall,
  type MockedHttpTransport,
} from '@ecclium/mcp-churchtools-testkit';
import { createCorePlugin } from '@ecclium/mcp-churchtools-tools';
import {
  checkRoutine,
  executeRun,
  type LoadedRoutine,
  parseTemplate,
  prepareRun,
  type RunResult,
  type RunWriteCall,
  writeRun,
} from '@ecclium/mcp-churchtools-workflows';
import { afterEach, describe, expect, it } from 'vitest';

import { verifyAudit as runAuditVerify } from '../commands/audit-verify.js';
import { exitCodes } from '../exit-codes.js';
import { runQueue } from '../queue/queue.js';
import { composeRunPipeline } from './run-pipeline.js';
import { composeRun } from './run.js';

// A run of a routine from its reads into the wiki (ADR 0032, ADR 0033): the
// pipeline of the run with the token of its account, the run bound by the
// composition root, the engine of workflows and the real tool of the core
// that adds a section, against the double of ChurchTools, which keeps the
// pages of one category as state. The core and the engine prove their
// parts in their own tests; these prove the seams between them. All data
// are made up.

const now = Date.UTC(2026, 10, 11, 7);
const clock = Object.freeze({ now: Object.freeze(() => now) });
const json = {
  headers: {
    'content-type': 'application/json',
    date: new Date(now).toUTCString(),
  },
};

const routineId = 'dienstplan-test';
const tool = 'ct_wiki_page_append_section';
const pageTitle = 'Dienstplan-Auswertung';
const guid = '00000000-0000-4000-8000-0000000000c1';
const otherGuid = '00000000-0000-4000-8000-0000000000c2';
const pageKey = { kind: 'wiki_page', key: `7/${guid}` };

// Monday 09.11.2026 at 06:00 in Zurich, week 46, and the Monday after.
const week46: Trigger = {
  at: Date.UTC(2026, 10, 9, 5),
  period: { isoWeek: '2026-W46', date: '2026-11-09', month: '2026-11' },
};
const week47: Trigger = {
  at: Date.UTC(2026, 10, 16, 5),
  period: { isoWeek: '2026-W47', date: '2026-11-16', month: '2026-11' },
};

const routineValueOf = (
  id: string,
  inputs: readonly Record<string, unknown>[],
) => ({
  schema: 'routine.v1',
  id,
  schedule: '0 6 * * MON',
  inputs,
  generate: {
    prompt: `prompts/${id}.md`,
    model: 'default',
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
  output: {
    target: 'wiki',
    tool,
    scope: { category: 'Berichte', page: pageTitle },
    idempotencyKey: `${id}:{isoWeek}`,
  },
});

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

const loadRoutine = (value: unknown): LoadedRoutine => {
  const checked = checkRoutine(value);
  if (!checked.ok) throw new Error('the routine of the test is invalid');
  const parsed = parseTemplate(
    template,
    checked.routine.generate?.blocks ?? {},
  );
  if (!parsed.ok) throw new Error('the template of the test is invalid');
  return {
    routine: checked.routine,
    prompt: 'Fasse die Dienste zusammen.',
    template: parsed.template,
  };
};

// The routine that runs: the two read tools of the routine plugin of
// testkit, which ask ChurchTools nothing.
const running = loadRoutine(
  routineValueOf(routineId, [
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
  ]),
);

// Two routines that never run here and read appointments, whose tool
// needs a right of another module than the tools of the running one.
const calendarRoutine = (id: string): LoadedRoutine =>
  loadRoutine(
    routineValueOf(id, [
      { name: 'termine', tool: 'ct_appointments_list', maxItems: 10 },
    ]),
  );
const sameAccount = calendarRoutine('kalender-test');
const otherAccount = calendarRoutine('fremd-test');
// A routine of the same alias that its preparation refuses: it reads the
// calendars with a tool that is not stable for routines.
const unfitAccount = loadRoutine(
  routineValueOf('untauglich-test', [
    { name: 'kalender', tool: 'ct_calendars_list', maxItems: 10 },
  ]),
);

/** The entry of a routine in the unattended part of the policy. */
const entryOf = (
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  routine: routineId,
  credential: 'berichte',
  modelRedaction: 'standard',
  target: { kind: 'wiki_category', id: 7, name: 'Berichte' },
  tools: [tool],
  maxPerRun: 1,
  maxPerDay: 5,
  ...extra,
});

// What the account of the running routine needs: the tool that adds a
// section reads the wiki and edits its category; its read tools need
// nothing.
const wikiRights = {
  view: true,
  'view category': [7],
  'edit category': [7],
};

/** A page of the double. */
interface FakePage {
  readonly categoryId: number;
  title: string;
  version: number;
  text: string;
}

/** What the double holds, which a test changes between runs. */
interface FakeChurchTools {
  rights: Record<string, Record<string, unknown>>;
  readonly pages: Map<string, FakePage>;
  /**
   * Runs after each read of a page, with how often the double of the run
   * read one, so that a test can change the page between two reads.
   */
  onPageRead?: (page: FakePage, reads: number) => void;
}

const pagePath = /^\/api\/wiki\/categories\/(\d+)\/pages\/([0-9a-f-]{36})$/u;

// Answers every read and write of the wiki from the state, for as many
// calls as a test makes, as the double of the core test does.
const serve = (double: MockedHttpTransport, fake: FakeChurchTools): void => {
  let pageReads = 0;
  const pageOf = (path: string): FakePage | undefined => {
    const [, category, id] = pagePath.exec(path) ?? [];
    const found = id === undefined ? undefined : fake.pages.get(id);
    return found?.categoryId === Number(category) ? found : undefined;
  };
  double
    .intercept({ path: '/api/permissions/global', method: 'GET' })
    .reply(() => ({
      statusCode: 200,
      data: JSON.stringify({ data: fake.rights }),
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
    .reply((opts) => {
      const category = Number(
        new URL(opts.path, doubleOrigin).searchParams.get(
          'wiki_category_ids[]',
        ),
      );
      const data = [...fake.pages.entries()]
        .filter(([, page]) => page.categoryId === category)
        .map(([id, page]) => ({
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
      pageReads += 1;
      // The answer holds the page as it was at this read; a change of the
      // hook shows only at the next one.
      const answer = JSON.stringify({
        data: {
          title: found.title,
          isMarkdown: true,
          version: found.version,
          text: found.text,
          wikiCategory: { id: found.categoryId },
        },
      });
      fake.onPageRead?.(found, pageReads);
      return { statusCode: 200, data: answer, responseOptions: json };
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

// The text a PATCH sent.
const sentText = (call: MockedCall | undefined): string =>
  (JSON.parse(call?.body ?? '{}') as { text?: string }).text ?? '';

// The periods of the sections of the routine on a page, by the lines of
// their markings.
const periodsOn = (text: string): readonly string[] =>
  [...text.matchAll(/Routine dienstplan-test, Lauf (\S+), Prüfcode/gu)].map(
    (match) => match[1] ?? '',
  );

// Every folder and file of a test, removed after it.
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

const privateFile = (path: string, text: string): string => {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
};

const renderedOf = (result: RunResult) => {
  if (result.kind !== 'rendered') {
    throw new Error(`not rendered: ${JSON.stringify(result)}`);
  }
  return result;
};

/** What a test sets up differently. */
interface SetupOptions {
  /** The entries of the unattended part, by default the one of the routine. */
  readonly entries?: readonly Record<string, unknown>[];
  /** The rights of the account, by default exactly what its tools need. */
  readonly rights?: Record<string, Record<string, unknown>>;
}

/** What one run is made of. */
interface RunOptions {
  readonly trigger?: Trigger;
  /** What the model answers, by default one open service. */
  readonly answer?: unknown;
  /**
   * The routines the runner loaded, by default the running one; those that
   * pass their preparation count for the tools of the account.
   */
  readonly routines?: readonly LoadedRoutine[];
  /** Whether the configuration only reads, by default as it was loaded. */
  readonly readOnly?: boolean;
  /** The halt of writes, by default the one of the test. */
  readonly halt?: WriteHalt;
  /** The audit file, by default the one of the test. */
  readonly auditFile?: AuditFileWriter;
}

// The folders of state and keys, the files of the configuration and the
// state of the wiki, all new for each test, so that no counter of the day,
// entry of the queue or kill switch of one test reaches another.
const setup = (options: SetupOptions = {}) => {
  const base = mkdtempSync(join(tmpdir(), 'ecclium-run-write-'));
  cleanup.push(base);
  const stateDir = privateDir(join(base, 'state'));
  // The folder of the kill switches, which writing needs (ADR 0029).
  const stopDir = privateDir(join(stateDir, 'stop'));
  const keysDir = privateDir(join(base, 'keys'));
  const tokensDir = privateDir(join(base, 'tokens'));
  const configDir = privateDir(join(base, 'config'));
  // The token of the account of the alias, and the one of the server.
  const accountCanary = makeCanary('token');
  const serverCanary = makeCanary('token');
  const accountFile = privateFile(
    join(tokensDir, 'ct_token_berichte'),
    `${accountCanary.value}\n`,
  );
  // Keys made from seeds instead of written out, so that no secret scanner
  // reads them as leaked ones.
  const keyFile = privateFile(
    join(configDir, 'pseudonym-key'),
    `${createHash('sha256').update('run-write').digest('hex')}\n`,
  );
  const markerFile = privateFile(
    join(configDir, 'marker-key'),
    `${createHash('sha256').update('run-write-marker').digest('hex')}\n`,
  );
  // JSON is YAML, so the loader of the policy reads it as it is.
  const policyFile = privateFile(
    join(configDir, 'policy.json'),
    JSON.stringify({
      schema: 'policy.v1',
      interactive: { inquiriesTo: 'Sekretariat' },
      unattended: options.entries ?? [entryOf()],
    }),
  );
  const environment = {
    ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
    ECCLIUM_CHURCHTOOLS_TOKEN: serverCanary.value,
    ECCLIUM_READ_ONLY: 'false',
    ECCLIUM_TOOLSETS: 'wiki',
    ECCLIUM_REDACTION: 'strict',
    ECCLIUM_PSEUDONYM_KEY_FILE: keyFile,
    ECCLIUM_MARKER_KEY_FILE: markerFile,
    ECCLIUM_POLICY_FILE: policyFile,
    ECCLIUM_STATE_DIR: stateDir,
    ECCLIUM_KEYS_DIR: keysDir,
    ECCLIUM_RUNNER_TOKENS_DIR: tokensDir,
    ECCLIUM_TIME_ZONE: 'Europe/Zurich',
  };
  const loaded = loadConfig({ environment, transport: 'stdio' });
  if (!loaded.ok) throw new Error('the configuration of the test is invalid');
  const config = loaded.config;
  const policy = config.policy;

  // The folders the start over stdio prepares before it builds anything.
  const audit = openAuditFile({
    stateDir,
    clock,
    pid: process.pid,
    retentionMonths: config.auditRetentionMonths,
  });
  if (!audit.ok) throw new Error('no audit file');
  open.push({
    close: () => {
      audit.writer.close();
      return Promise.resolve();
    },
  });
  if (!prepareQuotaFolder(stateDir).ok) throw new Error('no quota folder');
  prepareDayKeyFolder(keysDir, 'snapshot');
  prepareSnapshotFolder(stateDir);
  prepareQueueFolder(stateDir);

  const fake: FakeChurchTools = {
    rights: options.rights ?? { churchwiki: wikiRights },
    pages: new Map([
      [
        guid,
        {
          categoryId: 7,
          title: pageTitle,
          version: 3,
          text: `# ${pageTitle}`,
        },
      ],
    ]),
  };
  // One double per transport, since each run closes its own; all of them
  // serve the same wiki.
  const doubles: MockedHttpTransport[] = [];
  const createTransport = (given: HttpTransportOptions) => {
    const double = createChurchToolsDouble({
      token: given.token,
      origin: given.origin,
    });
    open.push(double);
    serve(double, fake);
    doubles.push(double);
    return double.transport;
  };
  const lines: string[] = [];
  const writer = createStderrWriter({
    writeSync: (_fd, buffer, offset, length) => {
      lines.push(
        Buffer.from(buffer)
          .subarray(offset, offset + length)
          .toString('utf8'),
      );
      return length;
    },
  });
  // The tools of the core, which a server that writes to the wiki offers,
  // and the read tools of the routine plugin.
  const catalog = createToolCatalog({
    core: createCorePlugin({ writing: true }),
    plugins: [createRoutinePlugin().plugin],
    readOnly: false,
    toolsets: new Set(['wiki', 'calendars', 'events'] as const),
  });
  // The halt of writes of the process, which every run shares.
  const writeHalt = createWriteHalt();

  const patches = () =>
    doubles
      .flatMap((double) => double.calls())
      .filter((call) => call.method === 'PATCH');
  const parsed = () =>
    lines
      .join('')
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  const events = () => parsed().map((line) => line['event']);
  const text = () => fake.pages.get(guid)?.text ?? '';

  // Binds one run as the runner will: its pipeline with the token of its
  // account, the run over it, and the reads and the answer of the model.
  const bind = async (run: RunOptions = {}) => {
    const mock = createMockModelProvider({
      kind: 'obedient',
      respond: () =>
        run.answer ?? {
          unbesetzt: [
            { datum: '2026-11-15', termin: 'Gottesdienst', dienst: 'Mesmer' },
          ],
        },
    });
    const model = guardModelProvider(mock.provider);
    const context = {
      tool: (name: string) => describeRunTool(catalog, name),
      policy,
      models: new Set(['default']),
    };
    const prepared = prepareRun(running, context);
    if (!prepared.ok) throw new Error(`not prepared: ${prepared.code}`);
    // The routines the runner prepared; one it could not prepare never
    // counts for the tools of an account.
    const runs = (run.routines ?? [running]).flatMap((loaded) => {
      const result = prepareRun(loaded, context);
      return result.ok ? [result.run] : [];
    });
    const built = composeRunPipeline({
      config,
      catalog,
      writer,
      clock,
      auditFile: run.auditFile ?? audit.writer,
      createTransport,
      routineId,
      writeHalt: run.halt ?? writeHalt,
    });
    if (!built.ok) throw new Error(`no pipeline: ${built.code}`);
    open.push({ close: () => built.close() });
    const bound = composeRun({
      pipeline: built.pipeline,
      run: prepared.run,
      runs,
      config:
        run.readOnly === undefined
          ? config
          : Object.freeze({ ...config, readOnly: run.readOnly }),
      provider: model.info,
      logging: { writer, minLevel: 'info' },
      clock,
    });
    const signal = new AbortController().signal;
    const result = await executeRun(
      prepared.run,
      run.trigger ?? week46,
      { read: bound.read, model, policy, log: bound.log, clock },
      signal,
    );
    return { bound, result, signal };
  };

  // One whole run, from the reads to the write.
  const runOnce = async (run: RunOptions = {}) => {
    const { bound, result, signal } = await bind(run);
    const rendered = renderedOf(result);
    const written = await writeRun(
      rendered,
      { write: bound.write, log: bound.log, clock },
      signal,
    );
    return { bound, rendered, written, signal };
  };

  // `ecclium queue approve` as the operator calls it, with the same
  // configuration and the double of the test.
  const approveCommand = async (queueId: string) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    // The calls of the transports of the command, kept before it closes
    // them, since a closed double forgets its calls.
    const calls: MockedCall[] = [];
    const recording = (given: HttpTransportOptions) => {
      const transport = createTransport(given);
      const double = doubles.at(-1);
      return Object.freeze({
        ...transport,
        close: async () => {
          calls.push(...(double?.calls() ?? []));
          await transport.close();
        },
      });
    };
    // The command opens the audit file of the day itself, with the clock
    // and the process of the test, so the writer of the runs closes first.
    audit.writer.close();
    const code = await runQueue({
      environment,
      execArgv: [],
      action: 'approve',
      queueId,
      output: {
        stdout: (line) => stdout.push(line) > 0,
        stderr: (line) => stderr.push(line) > 0,
      },
      writeSync: (_fd, _buffer, _offset, length) => length,
      createTransport: recording,
      clock,
    });
    return {
      code,
      stdout,
      stderr,
      patches: calls.filter((call) => call.method === 'PATCH'),
    };
  };

  // Writes the policy again, as an operator who changes it between a run
  // and the approval of what it queued.
  const rewritePolicy = (entries: readonly unknown[]) => {
    privateFile(
      policyFile,
      JSON.stringify({
        schema: 'policy.v1',
        interactive: { inquiriesTo: 'Sekretariat' },
        unattended: entries,
      }),
    );
  };

  // The audit files of the test, checked by `ecclium audit verify`: its
  // report and its exit code, 0 without a finding.
  const verifyAudit = () => {
    const lines: string[] = [];
    const code = runAuditVerify({
      environment,
      logs: [],
      output: {
        stdout: (line) => lines.push(line) > 0,
        stderr: (line) => lines.push(line) > 0,
      },
      clock,
    });
    return { code, lines };
  };

  return {
    policy,
    fake,
    stopDir,
    audit: audit.writer,
    patches,
    parsed,
    events,
    text,
    bind,
    runOnce,
    approveCommand,
    accountCanary,
    accountFile,
    rewritePolicy,
    verifyAudit,
  };
};

// The lines of the audit of the write tool, from the copy on stderr.
const writeLines = (parsed: () => readonly Record<string, unknown>[]) =>
  parsed().filter(
    (line) => line['type'] === 'tool_call' && line['tool'] === tool,
  );

describe('a run from its reads into the wiki', () => {
  it('writes its section to the page it finds by its title, with the marking of the run and the audit of a run', async () => {
    const { policy, patches, parsed, runOnce } = setup();
    const { bound, written } = await runOnce();
    expect(written).toEqual({
      kind: 'written',
      target: pageKey,
      version: 4,
      undoId: expect.any(String) as unknown,
      attempts: 1,
    });
    expect(patches()).toHaveLength(1);
    const sent = sentText(patches()[0]);
    expect(sent.startsWith(`# ${pageTitle}\n\n### Dienstplan 2026-W46\n`)).toBe(
      true,
    );
    expect(sent).toContain('Gottesdienst: Mesmer');
    expect(sent.split('\n').at(-1)).toMatch(
      /^Automatisch erstellt am 11\.11\.2026 durch Ecclium, Routine dienstplan-test, Lauf 2026-W46, Prüfcode k1:[A-Z2-7]{13}\. Rückfragen an Sekretariat\.$/u,
    );
    const lines = writeLines(parsed);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      mode: 'unattended',
      actor: { kind: 'runner', id: `runner:${routineId}` },
      outcome: 'ok',
      writeState: 'verified',
      confirmation: 'policy',
      runId: bound.runId,
      routineId,
      policyHash: policyHashOf(policy),
      provider: { vendor: 'example' },
    });
  });

  it('skips the same section of its period, replaces its own section in place, and adds the one of the next period', async () => {
    const { patches, text, runOnce } = setup();
    expect((await runOnce()).written).toMatchObject({ kind: 'written' });

    // The same answer in a second run of the period: nothing is sent.
    expect((await runOnce()).written).toEqual({
      kind: 'skipped',
      target: pageKey,
    });
    expect(patches()).toHaveLength(1);

    // Another answer in the same period replaces the section of the run.
    const changed = {
      unbesetzt: [
        { datum: '2026-11-15', termin: 'Gottesdienst', dienst: 'Sigrist' },
      ],
    };
    expect((await runOnce({ answer: changed })).written).toMatchObject({
      kind: 'written',
      version: 5,
    });
    expect(text()).toContain('Gottesdienst: Sigrist');
    expect(text()).not.toContain('Mesmer');
    expect(periodsOn(text())).toEqual(['2026-W46']);

    // The next period adds a section of its own after it.
    const before = text();
    expect(
      (await runOnce({ answer: changed, trigger: week47 })).written,
    ).toMatchObject({ kind: 'written', version: 6 });
    expect(periodsOn(text())).toEqual(['2026-W46', '2026-W47']);
    expect(text().startsWith(before)).toBe(true);
    expect(patches()).toHaveLength(3);
  });
});

describe('the data of the reads of a run in its write', () => {
  // The only contact value of the routine plugin: an address in the free
  // text of a service, which the level standard keeps in the data.
  const address = 'max.mustermann@example.org';
  const answerWith = (dienst: string) => ({
    unbesetzt: [{ datum: '2026-11-15', termin: 'Jugendabend', dienst }],
  });

  it('writes a contact value the reads of the run gave, which the core finds in the data composeRun hands it', async () => {
    const { patches, runOnce } = setup();
    const { written } = await runOnce({
      answer: answerWith(`Fragen an ${address}`),
    });
    expect(written).toMatchObject({ kind: 'written' });
    expect(sentText(patches()[0]).replaceAll('\\', '')).toContain(
      `Fragen an ${address}`,
    );
  });

  it('refuses a contact value that no read of the run gave, before anything is sent', async () => {
    const { patches, bind } = setup();
    const { result } = await bind({
      answer: answerWith('Fragen an erika.beispiel@example.org'),
    });
    expect(result).toEqual({
      kind: 'failed',
      step: 'answer',
      code: 'run_content_refused',
      final: true,
      violations: ['contact'],
    });
    expect(patches()).toHaveLength(0);
  });
});

describe('the tools of the account of a run', () => {
  // The account may read the calendars as well, which only the second
  // routine of its alias needs.
  const entries = [
    entryOf(),
    entryOf({ routine: 'kalender-test' }),
    // Another alias, prepared as well, whose tools do not count.
    entryOf({ routine: 'fremd-test', credential: 'andere' }),
    entryOf({ routine: 'untauglich-test' }),
  ];
  const rights = {
    churchwiki: wikiRights,
    churchcal: { 'view category': [1] },
  };

  it('counts the tools of every routine of its alias, and of no other alias', async () => {
    const { patches, events, runOnce } = setup({ entries, rights });
    // Only the running routine: the right to read the calendars is drift.
    expect((await runOnce({ routines: [running] })).written).toMatchObject({
      kind: 'queued',
      target: pageKey,
    });
    // A routine of another alias needs the right as well, but does not
    // serve this account.
    expect(
      (await runOnce({ routines: [running, otherAccount] })).written,
    ).toMatchObject({ kind: 'queued' });
    // A routine of the alias that its preparation refuses never runs, so
    // its tools do not count either.
    expect(
      (await runOnce({ routines: [running, unfitAccount] })).written,
    ).toMatchObject({ kind: 'queued' });
    expect(
      events().filter((event) => event === 'run_rights_drift'),
    ).toHaveLength(3);
    expect(patches()).toHaveLength(0);
    // The second routine of the alias needs it: no drift.
    expect(
      (await runOnce({ routines: [running, sameAccount, otherAccount] }))
        .written,
    ).toMatchObject({ kind: 'written', target: pageKey });
    expect(patches()).toHaveLength(1);
  });
});

describe('the limits of a routine across its runs', () => {
  it('queues a second write of the same run beyond its limit per run, and the next run has a counter of its own', async () => {
    const { fake, patches, events, bind, verifyAudit } = setup({
      entries: [entryOf({ maxPerRun: 1, maxPerDay: 2 })],
    });
    const limits = () =>
      events().filter((event) => event === 'policy_limit_reached').length;
    fake.pages.set(otherGuid, {
      categoryId: 7,
      title: 'Wochenplan',
      version: 1,
      text: '# Wochenplan',
    });
    const first = await bind();
    const rendered = renderedOf(first.result);
    expect(
      await writeRun(
        rendered,
        { write: first.bound.write, log: first.bound.log, clock },
        first.signal,
      ),
    ).toMatchObject({ kind: 'written' });
    // A second write of the same run, to another page of the category.
    const other: RunWriteCall = {
      tool,
      period: rendered.period,
      section: rendered.section,
      page: { categoryId: 7, title: 'Wochenplan' },
    };
    expect(await first.bound.write(other, first.signal)).toMatchObject({
      ok: true,
      state: 'queued',
      target: { kind: 'wiki_page', key: `7/${otherGuid}` },
    });
    // Queued for its limit, not for another reason.
    expect(limits()).toBe(1);
    expect(patches()).toHaveLength(1);

    // The next run writes it, with the second place of the day.
    const second = await bind();
    expect(await second.bound.write(other, second.signal)).toMatchObject({
      ok: true,
      state: 'verified',
      target: { kind: 'wiki_page', key: `7/${otherGuid}` },
    });
    expect(patches()).toHaveLength(2);

    // A third run finds the day used up.
    const third = await bind({ trigger: week47 });
    expect(
      await writeRun(
        renderedOf(third.result),
        { write: third.bound.write, log: third.bound.log, clock },
        third.signal,
      ),
    ).toMatchObject({ kind: 'queued' });
    expect(limits()).toBe(2);
    expect(patches()).toHaveLength(2);
    // Three pipelines over one audit file keep one chain.
    const report = verifyAudit();
    expect(report.lines.length).toBeGreaterThan(0);
    expect(report.code).toBe(exitCodes.ok);
  });
});

describe('what stops the write of a run', () => {
  it('stops at the kill switch of its routine, for good, and not at the one of another routine', async () => {
    const { stopDir, patches, runOnce } = setup();
    const own = join(stopDir, `writes-off-routine-${routineId}`);
    writeFileSync(own, '');
    expect((await runOnce()).written).toEqual({
      kind: 'failed',
      code: 'policy_denied',
      final: true,
      sent: false,
    });
    expect(patches()).toHaveLength(0);
    rmSync(own);
    writeFileSync(join(stopDir, 'writes-off-routine-fremd-test'), '');
    expect((await runOnce()).written).toMatchObject({ kind: 'written' });
    expect(patches()).toHaveLength(1);
  });

  it('writes nothing while the configuration only reads', async () => {
    const { patches, runOnce } = setup();
    expect((await runOnce({ readOnly: true })).written).toEqual({
      kind: 'failed',
      code: 'policy_denied',
      final: true,
      sent: false,
    });
    expect(patches()).toHaveLength(0);
  });

  it('halts the writes of every later run after a write whose audit line was lost', async () => {
    const { audit, patches, bind, runOnce } = setup();
    // The audit file of the first run loses every line once its reads are
    // done, but still says it is ready, so that only the halt stops the
    // next run.
    const lose = { on: false };
    const losing: AuditFileWriter = Object.freeze({
      write: (line: string): boolean => !lose.on && audit.write(line),
      ready: () => audit.ready(),
      close: (): void => undefined,
      attach: (listener: Parameters<AuditFileWriter['attach']>[0]) =>
        audit.attach(listener),
      sweep: () => {
        audit.sweep();
      },
      tick: () => {
        audit.tick();
      },
      anchor: () => {
        audit.anchor();
      },
      counts: () => audit.counts(),
    });
    const first = await bind({ auditFile: losing });
    lose.on = true;
    const lost = await writeRun(
      renderedOf(first.result),
      { write: first.bound.write, log: first.bound.log, clock },
      first.signal,
    );
    // The write itself went through; only its line is missing.
    expect(lost).toMatchObject({ kind: 'written', version: 4 });
    expect(patches()).toHaveLength(1);

    // A later run of the same process shares the halt and writes nothing.
    // The trigger stays open: after a restart the halt is gone, and a later
    // run may write (ADR 0034).
    const halted = await runOnce({ trigger: week47 });
    expect(halted.written).toEqual({
      kind: 'failed',
      code: 'policy_denied',
      final: false,
      sent: false,
    });
    expect(patches()).toHaveLength(1);

    // A pipeline with a halt of its own is not stopped.
    const apart = await runOnce({ trigger: week47, halt: createWriteHalt() });
    expect(apart.written).toMatchObject({ kind: 'written' });
    expect(patches()).toHaveLength(2);
  });
});

describe('how a write of a run ends', () => {
  it('tries a conflict before the send once more, and writes then', async () => {
    const { fake, patches, events, runOnce } = setup();
    // Someone changes the page right after the run planned on it, before
    // the read right before the commit.
    fake.onPageRead = (page, reads) => {
      if (reads !== 1) return;
      page.text = `${page.text}\n\nNachtrag von Hand.`;
      page.version += 1;
    };
    const { written } = await runOnce();
    expect(written).toMatchObject({
      kind: 'written',
      target: pageKey,
      version: 5,
      attempts: 2,
    });
    expect(events()).toContain('run_write_retried');
    expect(patches()).toHaveLength(1);
    expect(sentText(patches()[0])).toContain('Nachtrag von Hand.');
  });

  it('queues a section a person changed, and leaves the page as it is', async () => {
    const { fake, patches, text, runOnce } = setup();
    expect((await runOnce()).written).toMatchObject({ kind: 'written' });
    const page = fake.pages.get(guid);
    if (page === undefined) throw new Error('no page');
    page.text = page.text.replace('Mesmer', 'Mesmer, von Hand');
    page.version += 1;
    const before = page.text;

    const queued = (await runOnce()).written;
    if (queued.kind !== 'queued') {
      throw new Error(`not queued: ${JSON.stringify(queued)}`);
    }
    expect(queued.target).toEqual(pageKey);
    expect(patches()).toHaveLength(1);
    expect(text()).toBe(before);
    // Its approval goes through `ecclium queue approve`, below.
  });
});

describe('the approval of a section a run queued', () => {
  // A run queues its section beside one a person changed.
  const queueOne = async (setupOf: ReturnType<typeof setup>) => {
    const { fake, runOnce } = setupOf;
    expect((await runOnce()).written).toMatchObject({ kind: 'written' });
    const page = fake.pages.get(guid);
    if (page === undefined) throw new Error('no page');
    page.text = page.text.replace('Mesmer', 'Mesmer, von Hand');
    page.version += 1;
    const queued = (await runOnce()).written;
    if (queued.kind !== 'queued') throw new Error('not queued');
    return queued.queueId;
  };

  it('writes with the account of the routine, as the run would, through ecclium queue approve', async () => {
    const setupOf = setup();
    const { text, approveCommand, accountCanary, verifyAudit } = setupOf;
    const queueId = await queueOne(setupOf);
    const before = text();
    const approved = await approveCommand(queueId);
    expect(approved.code).toBe(exitCodes.ok);
    // The changed section stays; the one of the run stands beside it.
    expect(text().startsWith(before)).toBe(true);
    // The runs and the command, each with a pipeline of its own, keep one
    // chain in the audit file.
    expect(verifyAudit().code).toBe(exitCodes.ok);
    expect(approved.patches).toHaveLength(1);
    expect(approved.patches[0]?.headers['authorization']).toBe(
      `Login ${accountCanary.value}`,
    );
    expect(periodsOn(text())).toEqual(['2026-W46', '2026-W46']);
  });

  it('writes nothing without the token file of the account, also not with the token of the server', async () => {
    const setupOf = setup();
    const { patches, approveCommand, accountFile } = setupOf;
    const queueId = await queueOne(setupOf);
    rmSync(accountFile);
    const refused = await approveCommand(queueId);
    expect(refused.code).toBe(exitCodes.invalidConfig);
    expect(refused.stderr.join('\n')).toContain(
      'Mit dem Token des Servers schreibt Ecclium den Abschnitt nicht.',
    );
    expect(refused.patches).toEqual([]);
    expect(patches()).toHaveLength(1);
  });

  it('writes nothing for a routine the policy no longer names, also not with the token of the server', async () => {
    const setupOf = setup();
    const { patches, approveCommand, rewritePolicy } = setupOf;
    const queueId = await queueOne(setupOf);
    // The entries of the routine are gone; another routine keeps the alias.
    rewritePolicy([entryOf({ routine: 'kalender-test' })]);
    const refused = await approveCommand(queueId);
    expect(refused.code).toBe(exitCodes.invalidConfig);
    expect(refused.stderr.join('\n')).toContain(
      'Die Richtlinie nennt für die Routine keinen Eintrag und damit kein Konto mehr.',
    );
    expect(refused.patches).toEqual([]);
    expect(patches()).toHaveLength(1);
  });
});
