import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '@ecclium/mcp-churchtools-core';
import {
  classify,
  defineTool,
  defineWriteTool,
  type IsoDate,
  type PlanOutcome,
  type Plugin,
  type PluginHost,
  type ProviderInfo,
  refersTo,
  type TenantAssignment,
  type TenantContext,
  type ToolDefinition,
  wikiPageGuidPattern,
  type WritePort,
  type WriteToolMeta,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  assertOnlyReads,
  createChurchToolsDouble,
  createMemoryApprovalQueue,
  createMemoryDayKeys,
  createMemoryQuotaStore,
  doubleOrigin,
  examplePlugin,
  makeCanary,
  type MockedHttpTransport,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createAuditSink } from '../audit/index.js';
import { canonicalOfWritten } from '../content/index.js';
import { createFileKeyProvider } from '../keys/file-provider.js';
import { KeyMaterial } from '../keys/index.js';
import { checkCodeOf, findMarkings, markingLineOf } from '../marker/index.js';
import { checkPolicy } from '../policy/check.js';
import { policyHashOf } from '../policy/hash.js';
import type { Policy } from '../policy/schema.js';
import { createQueueKeeper } from '../queue/index.js';
import { createToolCatalog } from '../registry/index.js';
import type { WriteSnapshots } from '../write/guard.js';
import { createMemoryNonceStore } from '../write/nonce-store.js';
import { createMemoryPlanStore } from '../write/plan-store.js';
import { policySentences } from '../write/policy-gate.js';
import { createRunWrites, type RunWrites } from '../write/run-writes.js';
import {
  createWriteHalt,
  haltWrites,
  type WriteHalt,
} from '../write/write-halt.js';
import {
  createToolPipeline,
  type RunCallRequest,
  type RunWriteRequest,
  type ToolRequest,
} from './pipeline.js';
import { maxRunWriteRequests } from './run-write.js';

// A write of a run of a routine through the whole pipeline (ADR 0032, ADR
// 0033, ADR 0034): the core finds the page, the write tool plans the
// section with the marking of the run, the policy of the routine judges
// it with its limits per run and per day, and the plan is committed with
// the proof of the policy or queued for the operator. ChurchTools is the
// double, which keeps the pages of one category as state, so that several
// runs follow each other as on a real instance.

// Two answers the contracts allow but no real part gives: a plan of the
// write guard without its text, and a search of the page that fails with
// an error the client does not describe. Off unless a test turns them on.
// Besides, a step a test runs right after the search has found its page.
const gaps = vi.hoisted(() => ({
  dropText: false,
  pageThrows: false,
  afterSearch: undefined as (() => void) | undefined,
  plans: 0,
}));
vi.mock('../write/guard.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../write/guard.js')>();
  return {
    ...original,
    createWriteGuard: (
      options: Parameters<typeof original.createWriteGuard>[0],
    ) => {
      const guard = original.createWriteGuard(options);
      return Object.freeze({
        ...guard,
        plan: async (...args: Parameters<typeof guard.plan>) => {
          gaps.plans += 1;
          const result = await guard.plan(...args);
          return gaps.dropText
            ? { outcome: result.outcome, target: result.target }
            : result;
        },
      });
    },
  };
});
vi.mock('./run-write.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./run-write.js')>();
  return {
    ...original,
    resolveRunPage: async (
      ...args: Parameters<typeof original.resolveRunPage>
    ) => {
      if (gaps.pageThrows) throw new TypeError('not described');
      const found = await original.resolveRunPage(...args);
      gaps.afterSearch?.();
      return found;
    },
  };
});

const loaded = loadConfig({
  environment: {
    ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
    ECCLIUM_CHURCHTOOLS_TOKEN: makeCanary('token').value,
  },
  transport: 'stdio',
});
if (!loaded.ok) throw new Error('the configuration of the test is invalid');
const token = loaded.config.churchtoolsToken;

const now = Date.UTC(2026, 10, 10, 6, 0, 0);
const day = '2026-11-10' as IsoDate;
const clock = Object.freeze({ now: Object.freeze(() => now) });
const json = {
  headers: {
    'content-type': 'application/json',
    date: new Date(now).toUTCString(),
  },
};

const markerKey = new KeyMaterial('0123456789abcdef'.repeat(4));
const routine = 'dienstplan-report';
const toolName = 'ct_test_run_append';
const guid = '00000000-0000-4000-8000-000000000001';
const otherGuid = '00000000-0000-4000-8000-000000000002';
const runId = '00000000-0000-4000-8000-0000000000a1';
const section = '## Woche 46\n\nAlles besetzt.';
const target = { kind: 'wiki_page', key: `12/${guid}` };

const provider: ProviderInfo = Object.freeze({
  vendor: 'example-vendor',
  model: 'example-model',
  hostingCountry: 'CH',
  endpointHost: 'models.example.org',
});

const runner = {
  tenantId: 'default',
  actor: { kind: 'runner', id: `runner:${routine}` },
} as unknown as TenantAssignment;
const operator = {
  tenantId: 'default',
  actor: { kind: 'user', id: 'stdio:local-stdio' },
} as unknown as TenantAssignment;
// What the stores of the test are keyed by.
const ctxOf = {
  tenantId: 'default',
  instance: doubleOrigin,
  actor: { kind: 'runner', id: `runner:${routine}` },
} as unknown as TenantContext;

const description = {
  purpose: 'Serves a test.',
  useWhen: 'A test needs it.',
  avoidWhen: 'Anything else.',
  limits: 'None.',
};

const appendMeta: WriteToolMeta = Object.freeze({
  capability: 'write',
  domain: 'wiki',
  requiredRights: [{ module: 'churchwiki', right: 'edit category' }],
  tier: 'free',
  sensitivity: 'personal',
  unattended: 'policy',
  routineStable: true,
  reversible: 'snapshot',
  replayGuard: 'marker',
});

/** The input the pipeline builds for the write tool of a run. */
interface RunToolInput {
  readonly categoryId: number;
  readonly guid: string;
  readonly section: string;
  readonly baseVersion: number;
}

// Adds the section, as the tool of the core does.
const appendSectionOf = (
  input: RunToolInput,
  write: WritePort,
): Promise<PlanOutcome> =>
  write.plan({
    kind: 'wikiSectionAppend',
    categoryId: input.categoryId,
    guid: input.guid,
    section: input.section,
    baseVersion: input.baseVersion,
  });

// A write tool with the input the pipeline builds for a run, which by
// default adds the section.
const appendTool = (
  name: `ct_${string}`,
  meta: Partial<WriteToolMeta> = {},
  run: (
    input: RunToolInput,
    write: WritePort,
  ) => Promise<unknown> = appendSectionOf,
): ToolDefinition =>
  defineWriteTool({
    name,
    meta: { ...appendMeta, ...meta } as WriteToolMeta,
    description,
    input: z.strictObject({
      categoryId: refersTo(z.number().int().positive(), 'wiki_category'),
      guid: refersTo(z.string().regex(wikiPageGuidPattern), 'wiki_page'),
      section: classify(z.string().max(70_000), 'untrusted'),
      baseVersion: classify(z.number().int().min(0), 'none'),
    }),
    execute: ({ input, write }) => run(input, write) as Promise<PlanOutcome>,
  });

// What the read tool of the test gives as its free text, which a test
// changes.
const defaultReadText = 'Fragen an info@example.org oder +41 00 000 12 34.';
const readText = { value: defaultReadText };

// A read tool of a routine whose free text holds a contact value: in the
// level standard it stays in the data of the run (ADR 0030).
const readTool = defineTool({
  name: 'ct_test_run_read',
  meta: {
    capability: 'read',
    domain: 'wiki',
    requiredRights: [{ module: 'churchwiki', right: 'view' }],
    tier: 'free',
    sensitivity: 'none',
    unattended: 'policy',
    routineStable: true,
  },
  description,
  input: z.strictObject({}),
  output: z.object({ text: classify(z.string().max(10_000), 'untrusted') }),
  execute: () => Promise.resolve({ text: readText.value }),
});

// The tools of the core: those of the example, among them a write tool
// that is not stable for routines, and those of this test.
const corePlugin: Plugin = {
  name: examplePlugin.name,
  version: examplePlugin.version,
  register(host: PluginHost): undefined {
    examplePlugin.register(host);
    host.addTool(appendTool(toolName));
    host.addTool(appendTool('ct_test_run_never', { unattended: 'never' }));
    // Replaces the whole page instead of adding a section.
    host.addTool(
      appendTool('ct_test_run_update', {}, (input, write) =>
        write.plan({
          kind: 'wikiPageUpdate',
          categoryId: input.categoryId,
          guid: input.guid,
          text: input.section,
          baseVersion: input.baseVersion,
        }),
      ),
    );
    // Plans, but returns a copy of the outcome of its plan.
    host.addTool(
      appendTool('ct_test_run_copy', {}, async (input, write) => ({
        ...(await appendSectionOf(input, write)),
      })),
    );
    // Returns an outcome without planning.
    host.addTool(
      appendTool('ct_test_run_unplanned', {}, () =>
        Promise.resolve({ kind: 'skipped', reason: 'unchanged' }),
      ),
    );
    host.addTool(readTool);
    return undefined;
  },
};

// A write tool of a plugin that declares everything a run needs.
const otherPlugin: Plugin = {
  name: 'test-plugin',
  version: '1.0.0',
  register(host: PluginHost): undefined {
    host.addTool(appendTool('ct_test_plugin_append'));
    return undefined;
  },
};

// The entry of the routine in the unattended part, with what a test
// changes.
const policyOf = (
  extra: Record<string, unknown> = {},
  others: readonly Record<string, unknown>[] = [],
): Policy => {
  const checked = checkPolicy({
    schema: 'policy.v1',
    interactive: { inquiriesTo: 'Sekretariat' },
    unattended: [
      {
        routine,
        credential: 'berichte',
        target: { kind: 'wiki_category', id: 12, name: 'Berichte' },
        tools: [toolName],
        maxPerRun: 2,
        maxPerDay: 10,
        ...extra,
      },
      ...others,
    ],
  });
  if (!checked.ok) throw new Error(checked.code);
  return checked.policy;
};

// The line of the marking of a section of the run of a period, as the
// write guard writes it on the day of the test.
const runMarking = (written: string, period: string): string => {
  const origin = { kind: 'routine', routine, run: period } as const;
  const code = checkCodeOf(
    markerKey,
    'default',
    origin,
    canonicalOfWritten(written),
  );
  return markingLineOf({ date: day, origin, code }, 'Sekretariat');
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
  categoryName: string;
  readonly pages: Map<string, FakePage>;
  /** The status of a read of a page instead of the page. */
  pageStatus?: number;
  /**
   * What a write of a page does: store the text, fail with 500 and store
   * nothing, or store a text of someone else.
   */
  patch?: 'write' | 'fail' | 'other';
  /** Runs at each read of the categories, which the policy reads. */
  onCategories?: () => void;
  /** Runs at each read of the list of pages of a category. */
  onList?: () => void;
  /** Runs at each read of a page by its GUID, with its number. */
  onPageRead?: (count: number) => void;
}

const pagePath = /^\/api\/wiki\/categories\/(\d+)\/pages\/([0-9a-f-]{36})$/;

const bodyText = (body: unknown): string =>
  typeof body === 'string'
    ? body
    : Buffer.from(body as Uint8Array).toString('utf8');

// Answers every read and write of the wiki from the state, for as many
// calls as a test makes.
const serve = (double: MockedHttpTransport, fake: FakeChurchTools): void => {
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
    .reply(() => {
      fake.onCategories?.();
      return {
        statusCode: 200,
        data: JSON.stringify({ data: [{ id: 12, name: fake.categoryName }] }),
        responseOptions: json,
      };
    })
    .persist();
  double
    .intercept({
      path: (path: string) => path.split('?')[0] === '/api/wiki/pages',
      method: 'GET',
    })
    .reply((opts) => {
      fake.onList?.();
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
  let pageReads = 0;
  double
    .intercept({ path: (path: string) => pagePath.test(path), method: 'GET' })
    .reply((opts) => {
      pageReads += 1;
      fake.onPageRead?.(pageReads);
      const found = pageOf(opts.path);
      if (fake.pageStatus !== undefined || found === undefined) {
        return {
          statusCode: fake.pageStatus ?? 404,
          data: '{}',
          responseOptions: json,
        };
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
    .intercept({
      path: (path: string) => pagePath.test(path),
      method: 'PATCH',
    })
    .reply((opts) => {
      const found = pageOf(opts.path);
      if (found === undefined) {
        return { statusCode: 404, data: '{}', responseOptions: json };
      }
      if (fake.patch === 'fail') {
        return { statusCode: 500, data: '{}', responseOptions: json };
      }
      const sent = (JSON.parse(bodyText(opts.body)) as { text: string }).text;
      found.text =
        fake.patch === 'other' ? `${sent}\n\nZugleich geändert.` : sent;
      found.version += 1;
      return { statusCode: 200, data: '{}', responseOptions: json };
    })
    .persist();
};

let dir: string;
const open: { close(): Promise<void> }[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ecclium-pipeline-run-write-'));
  gaps.dropText = false;
  gaps.pageThrows = false;
  gaps.afterSearch = undefined;
  gaps.plans = 0;
  readText.value = defaultReadText;
});

afterEach(async () => {
  rmSync(dir, { recursive: true, force: true });
  await Promise.all(open.splice(0).map((item) => item.close()));
});

const setup = (
  options: {
    readonly policy?: Policy;
    /** False for a server that keeps no queue of approvals. */
    readonly queue?: false;
    readonly snapshots?: WriteSnapshots;
    /** The halt of writes of the process. */
    readonly writeHalt?: WriteHalt;
  } = {},
) => {
  const double = createChurchToolsDouble({ token });
  open.push(double);
  const fake: FakeChurchTools = {
    rights: { churchwiki: { 'edit category': [12] } },
    categoryName: 'Berichte',
    pages: new Map([
      [
        guid,
        {
          categoryId: 12,
          title: 'Dienstplan',
          version: 3,
          text: '# Dienstplan',
        },
      ],
    ]),
  };
  serve(double, fake);
  const catalog = createToolCatalog({
    core: corePlugin,
    plugins: [otherPlugin],
    readOnly: false,
    toolsets: new Set(['wiki'] as const),
  });
  const auditLines: string[] = [];
  const logLines: string[] = [];
  const file = { ok: true, ready: true };
  const audit = createAuditSink({
    writer: { write: () => true },
    file: {
      write: (line: string) => {
        auditLines.push(line);
        return file.ok;
      },
      ready: () => file.ready,
      anchor: () => undefined,
    },
    clock,
    isKnownTool: catalog.has,
  });
  const quotaMemory = new Map<string, number>();
  const quota = createMemoryQuotaStore(quotaMemory);
  const keeper = createQueueKeeper({
    keys: createFileKeyProvider({ dayKeys: createMemoryDayKeys() }),
    store: createMemoryApprovalQueue(),
    clock,
  });
  const policy = options.policy ?? policyOf();
  const pipeline = createToolPipeline({
    policy,
    markerKey,
    catalog,
    audit,
    quota,
    transport: double.transport,
    origin: doubleOrigin,
    // The clock stands still, so the bucket never refills.
    requestsPerMinute: 6000,
    clock,
    logging: {
      writer: Object.freeze({
        write: (line: string) => {
          logLines.push(line);
          return true;
        },
      }),
      minLevel: 'debug',
    },
    killSwitchDir: dir,
    plans: createMemoryPlanStore(clock),
    nonces: createMemoryNonceStore(clock),
    ...(options.queue === false ? {} : { queue: keeper }),
    ...(options.writeHalt === undefined
      ? {}
      : { writeHalt: options.writeHalt }),
    ...(options.snapshots === undefined
      ? {}
      : { snapshots: options.snapshots }),
  });
  const events = () =>
    auditLines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const logs = () =>
    logLines.map((line) => (JSON.parse(line) as { event: string }).event);
  const patches = () =>
    double.calls().filter((call) => call.method === 'PATCH').length;
  // The writes of the tool to the category today, counted for the runner.
  const dayCount = () =>
    quota.read(ctxOf, `write:${toolName}:wiki_category:12` as never, day);
  const text = (id = guid) => fake.pages.get(id)?.text ?? '';
  return {
    double,
    fake,
    pipeline,
    policy,
    keeper,
    file,
    events,
    logs,
    patches,
    dayCount,
    text,
  };
};

const writeRequest = (
  extra: Partial<RunWriteRequest> = {},
): RunWriteRequest => ({
  assignment: runner,
  features: [],
  signal: new AbortController().signal,
  run: { runId, routineId: routine, provider },
  readOnly: false,
  tool: toolName,
  period: '2026-W46',
  section,
  page: { categoryId: 12, guid },
  data: [],
  accountTools: [toolName],
  runWrites: createRunWrites(),
  ...extra,
});

const readRequest = (): RunCallRequest => ({
  assignment: runner,
  redaction: 'standard',
  features: [],
  signal: new AbortController().signal,
  run: { runId, routineId: routine, provider },
  maxEntries: 10,
});

const operatorRequest = (): ToolRequest => ({
  assignment: operator,
  mode: 'operator',
  redaction: 'standard',
  readOnly: false,
  features: [],
  signal: new AbortController().signal,
});

const verified = (version: number, at = target) => ({
  ok: true,
  state: 'verified',
  target: at,
  version,
});

const refused = (code: string, transient = false) => ({
  ok: false,
  code,
  sent: false,
  transient,
});

// The lines of the marking of the routine on a page, by period.
const periodsOn = (text: string): readonly string[] =>
  findMarkings(text).flatMap(({ marking }) =>
    marking.origin.kind === 'routine' && marking.origin.routine === routine
      ? [marking.origin.run]
      : [],
  );

describe('a write of a run', () => {
  it('adds the section with the marking of the run and commits it with the proof of the policy', async () => {
    const { pipeline, policy, events, patches, dayCount, text } = setup();
    const outcome = await pipeline.writeForRun(writeRequest());
    expect(outcome).toEqual(verified(4));
    expect(patches()).toBe(1);
    const written = text();
    expect(written.startsWith('# Dienstplan\n')).toBe(true);
    expect(written).toContain(section);
    expect(written.split('\n').at(-1)).toBe(
      runMarking(`${section}\n`, '2026-W46'),
    );
    expect(written).toMatch(
      /Automatisch erstellt am 10\.11\.2026 durch Ecclium, Routine dienstplan-report, Lauf 2026-W46, Prüfcode k1:[A-Z2-7]{13}\. Rückfragen an Sekretariat\.$/u,
    );
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({
      type: 'tool_call',
      mode: 'unattended',
      actor: { kind: 'runner', id: `runner:${routine}` },
      tool: toolName,
      outcome: 'ok',
      writeState: 'verified',
      confirmation: 'policy',
      runId,
      routineId: routine,
      policyHash: policyHashOf(policy),
      provider,
      objectRefs: ['wiki_category:12', `wiki_page:${guid}`],
    });
    expect(events()[0]).not.toHaveProperty('rightsDriftAccepted');
    expect(events()[0]).not.toHaveProperty('errorCode');
    expect(await dayCount()).toBe(1);
  });

  it('skips the same section of the period, replaces its own section in place, and adds the one of the next period', async () => {
    const { pipeline, fake, events, patches, dayCount, text } = setup();
    expect(await pipeline.writeForRun(writeRequest())).toEqual(verified(4));

    // A second run of the period with the same section adds nothing.
    expect(await pipeline.writeForRun(writeRequest())).toEqual({
      ok: true,
      state: 'skipped',
      target,
    });
    expect(patches()).toBe(1);
    expect(events()[1]).toMatchObject({
      outcome: 'ok',
      writeState: 'skipped',
      runId,
      routineId: routine,
    });

    // A person adds text below; a run of the period with another section
    // replaces its own section and leaves the rest as it is.
    const page = fake.pages.get(guid);
    if (page === undefined) throw new Error('no page');
    page.text = `${page.text}\n\nNachtrag von Hand.`;
    page.version += 1;
    const changed = '## Woche 46\n\nSigrist fehlt am Sonntag.';
    expect(
      await pipeline.writeForRun(writeRequest({ section: changed })),
    ).toEqual(verified(6));
    const replaced = text();
    expect(replaced.startsWith('# Dienstplan\n\n## Woche 46')).toBe(true);
    expect(replaced.endsWith('\n\nNachtrag von Hand.')).toBe(true);
    expect(replaced).toContain('Sigrist fehlt am Sonntag.');
    expect(replaced).not.toContain('Alles besetzt.');
    expect(periodsOn(replaced)).toEqual(['2026-W46']);
    expect(replaced).toContain(runMarking(`${changed}\n`, '2026-W46'));
    expect(replaced).not.toContain(runMarking(`${section}\n`, '2026-W46'));

    // The next period adds a section of its own.
    const next = '## Woche 47\n\nAlles besetzt.';
    expect(
      await pipeline.writeForRun(
        writeRequest({ period: '2026-W47', section: next }),
      ),
    ).toEqual(verified(7));
    const appended = text();
    expect(periodsOn(appended)).toEqual(['2026-W46', '2026-W47']);
    expect(appended.startsWith(replaced)).toBe(true);
    expect(appended.split('\n').at(-1)).toBe(
      runMarking(`${next}\n`, '2026-W47'),
    );
    expect(patches()).toBe(3);
    // A skipped write takes no place of the day.
    expect(await dayCount()).toBe(3);
  });

  it('queues a section a person changed, and an approval adds the new one beside it and counts against the day', async () => {
    const { pipeline, fake, keeper, events, logs, patches, dayCount, text } =
      setup({ policy: policyOf({ maxPerRun: 1, maxPerDay: 2 }) });
    expect(await pipeline.writeForRun(writeRequest())).toEqual(verified(4));
    const page = fake.pages.get(guid);
    if (page === undefined) throw new Error('no page');
    page.text = page.text.replace('Alles besetzt.', 'Alles besetzt, von Hand.');
    page.version += 1;
    const before = page.text;

    const outcome = await pipeline.writeForRun(writeRequest());
    const queueId = events()[1]?.['eventId'];
    expect(outcome).toEqual({ ok: true, state: 'queued', target, queueId });
    expect(events()[1]).toMatchObject({
      outcome: 'ok',
      writeState: 'queued',
      runId,
      routineId: routine,
    });
    expect(logs()).toEqual(
      expect.arrayContaining(['marking_changed', 'write_queued']),
    );
    expect(patches()).toBe(1);
    expect(text()).toBe(before);
    expect(await keeper.load(ctxOf, queueId as string)).toMatchObject({
      kind: 'found',
      day,
      content: {
        tool: toolName,
        origin: 'core',
        actor: { kind: 'runner', id: `runner:${routine}` },
        reason: 'marker_changed',
        target,
        run: { routine, period: '2026-W46', contacts: [] },
      },
    });
    expect(await dayCount()).toBe(1);

    const approved = await pipeline.approve({ queueId }, operatorRequest());
    expect(approved).toMatchObject({ kind: 'approved', target, version: 6 });
    expect(patches()).toBe(2);
    const after = text();
    // The changed section stays; the new one stands beside it.
    expect(after.startsWith(before)).toBe(true);
    expect(periodsOn(after)).toEqual(['2026-W46', '2026-W46']);
    expect(after.split('\n').at(-1)).toBe(
      runMarking(`${section}\n`, '2026-W46'),
    );
    expect(events()[2]).toMatchObject({
      type: 'approval',
      queueId,
      decision: 'approved',
      outcome: 'ok',
      writeState: 'verified',
      confirmation: 'operator',
    });
    // The approval took the second place of the day of the routine.
    expect(await dayCount()).toBe(2);
    const next = await pipeline.writeForRun(
      writeRequest({
        period: '2026-W47',
        section: '## Woche 47\n\nAlles besetzt.',
      }),
    );
    expect(next).toMatchObject({ ok: true, state: 'queued' });
    expect(
      await keeper.load(ctxOf, events()[3]?.['eventId'] as string),
    ).toMatchObject({ content: { reason: 'limit_reached' } });
    expect(patches()).toBe(2);
  });
});

describe('the page of a write of a run', () => {
  it('finds a page by its title in the category, in the normal form NFC', async () => {
    const { pipeline, fake, patches } = setup();
    expect(
      await pipeline.writeForRun(
        writeRequest({ page: { categoryId: 12, title: 'Dienstplan' } }),
      ),
    ).toEqual(verified(4));
    const page = fake.pages.get(guid);
    if (page === undefined) throw new Error('no page');
    page.title = 'Übersicht';
    expect(
      await pipeline.writeForRun(
        writeRequest({
          period: '2026-W47',
          page: { categoryId: 12, title: 'Übersicht' },
        }),
      ),
    ).toEqual(verified(5));
    expect(patches()).toBe(2);
  });

  it('ends for good without a page of that title, and never creates one', async () => {
    const { double, pipeline, events, logs } = setup();
    const outcome = await pipeline.writeForRun(
      writeRequest({ page: { categoryId: 12, title: 'Wochenbericht' } }),
    );
    expect(outcome).toEqual({ ...refused('not_found'), page: 'missing' });
    assertOnlyReads(double);
    expect(logs()).toContain('run_page_missing');
    expect(events()[0]).toMatchObject({
      tool: toolName,
      errorCode: 'not_found',
      runId,
    });
  });

  it('ends for good when the GUID names no page of the category', async () => {
    const { double, pipeline } = setup();
    const outcome = await pipeline.writeForRun(
      writeRequest({ page: { categoryId: 12, guid: otherGuid } }),
    );
    expect(outcome).toEqual({ ...refused('not_found'), page: 'missing' });
    assertOnlyReads(double);
  });

  it('ends for good when two pages of the category have the title', async () => {
    const { double, fake, pipeline, logs } = setup();
    fake.pages.set(otherGuid, {
      categoryId: 12,
      title: 'Dienstplan',
      version: 1,
      text: '# Dienstplan',
    });
    const outcome = await pipeline.writeForRun(
      writeRequest({ page: { categoryId: 12, title: 'Dienstplan' } }),
    );
    expect(outcome).toEqual({ ...refused('conflict'), page: 'ambiguous' });
    assertOnlyReads(double);
    expect(logs()).toContain('run_page_ambiguous');
  });
});

describe('the signal of a write of a run', () => {
  // The paths of the requests the double saw, without their query.
  const pathsOf = (double: MockedHttpTransport): readonly string[] =>
    double
      .calls()
      .map((call) => `${call.method} ${call.path.split('?')[0] ?? ''}`);

  it('ends the search of a page by its title, unsent and for a later try', async () => {
    const { double, fake, pipeline, events, text } = setup();
    const controller = new AbortController();
    // The stop arrives while the core reads the list of the category.
    fake.onList = () => {
      controller.abort();
    };
    const outcome = await pipeline.writeForRun(
      writeRequest({
        signal: controller.signal,
        page: { categoryId: 12, title: 'Dienstplan' },
      }),
    );
    expect(outcome).toEqual(refused('network', true));
    // Nothing of the write began: no rights, no read of the page.
    expect(pathsOf(double)).toEqual(['GET /api/wiki/pages']);
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({
      tool: toolName,
      errorCode: 'network',
      runId,
    });
    expect(text()).toBe('# Dienstplan');
  });

  it('begins no write when the stop comes right after the search', async () => {
    const { double, pipeline } = setup();
    const controller = new AbortController();
    // Every request of the search has its answer; the stop comes before
    // the core plans.
    gaps.afterSearch = () => {
      controller.abort();
    };
    expect(
      await pipeline.writeForRun(
        writeRequest({
          signal: controller.signal,
          page: { categoryId: 12, title: 'Dienstplan' },
        }),
      ),
    ).toEqual(refused('network', true));
    expect(pathsOf(double)).toEqual(['GET /api/wiki/pages']);
    // The write guard never plans, so no step of the write runs.
    expect(gaps.plans).toBe(0);
  });

  it('ends the read of a page by its GUID before the write the same way', async () => {
    const { double, fake, pipeline } = setup();
    const controller = new AbortController();
    fake.onPageRead = (count) => {
      if (count === 1) controller.abort();
    };
    expect(
      await pipeline.writeForRun(writeRequest({ signal: controller.signal })),
    ).toEqual(refused('network', true));
    expect(pathsOf(double)).toEqual([
      `GET /api/wiki/categories/12/pages/${guid}`,
    ]);
  });

  it('writes to its end once the page is found, whatever the signal', async () => {
    const { fake, pipeline, events, patches, text } = setup();
    const controller = new AbortController();
    // The stop arrives at the plan, when the policy reads the name of the
    // category, after the search.
    fake.onCategories = () => {
      controller.abort();
    };
    expect(
      await pipeline.writeForRun(
        writeRequest({
          signal: controller.signal,
          page: { categoryId: 12, title: 'Dienstplan' },
        }),
      ),
    ).toEqual(verified(4));
    expect(controller.signal.aborted).toBe(true);
    expect(patches()).toBe(1);
    expect(periodsOn(text())).toEqual(['2026-W46']);
    expect(events()[0]).toMatchObject({
      outcome: 'ok',
      writeState: 'verified',
    });
  });

  it('sends at most the requests a stopping container waits for once the page is found', async () => {
    // A whole category: its list, then the rights and the page for the
    // plan, the page, the update and the read after it for the commit,
    // and the name of the category at the plan and at the commit.
    const inCategory = setup();
    expect(
      await inCategory.pipeline.writeForRun(
        writeRequest({ page: { categoryId: 12, title: 'Dienstplan' } }),
      ),
    ).toEqual(verified(4));
    const [search, ...category] = pathsOf(inCategory.double);
    expect(search).toBe('GET /api/wiki/pages');
    expect(category).toHaveLength(7);
    expect(
      category.filter((path) => path === 'GET /api/wiki/categories'),
    ).toHaveLength(2);
    // A page by its GUID: its read, then the same without the names.
    const onPage = setup({
      policy: policyOf({
        target: { kind: 'wiki_page', categoryId: 12, guid, name: 'Dienstplan' },
      }),
    });
    expect(await onPage.pipeline.writeForRun(writeRequest())).toEqual(
      verified(4),
    );
    const [read, ...page] = pathsOf(onPage.double);
    expect(read).toBe(`GET /api/wiki/categories/12/pages/${guid}`);
    expect(page).toHaveLength(5);
    expect(Math.max(category.length, page.length)).toBe(maxRunWriteRequests);
  });
});

describe('what stops a write of a run', () => {
  it('stops at the kill switch of its routine, for good, and writes again without it', async () => {
    const { double, pipeline, events, patches } = setup();
    const file = join(dir, `writes-off-routine-${routine}`);
    writeFileSync(file, '');
    expect(await pipeline.writeForRun(writeRequest())).toEqual(
      refused('policy_denied'),
    );
    assertOnlyReads(double);
    expect(events()[0]).toMatchObject({
      outcome: 'denied',
      errorCode: 'policy_denied',
      writeState: 'denied',
      runId,
    });
    rmSync(file);
    expect(await pipeline.writeForRun(writeRequest())).toEqual(verified(4));
    expect(patches()).toBe(1);
  });

  it('does not stop at the kill switch of another routine', async () => {
    const { pipeline } = setup();
    writeFileSync(join(dir, 'writes-off-routine-wochen-report'), '');
    expect(await pipeline.writeForRun(writeRequest())).toEqual(verified(4));
  });

  it('queues a write to a target whose name is not the one of the policy', async () => {
    const { pipeline, fake, keeper, events, logs, patches } = setup();
    fake.categoryName = 'Umbenannt';
    const outcome = await pipeline.writeForRun(writeRequest());
    expect(outcome).toMatchObject({ ok: true, state: 'queued', target });
    expect(
      await keeper.load(ctxOf, events()[0]?.['eventId'] as string),
    ).toMatchObject({ content: { reason: 'name_changed' } });
    expect(logs()).toContain('policy_name_changed');
    expect(patches()).toBe(0);
  });

  it('may try again later when the audit file cannot take the line', async () => {
    const { double, pipeline, file } = setup();
    file.ready = false;
    expect(await pipeline.writeForRun(writeRequest())).toEqual(
      refused('policy_denied', true),
    );
    expect(double.calls()).toHaveLength(0);
  });

  it('may try again after a restart when the writes of the process are halted', async () => {
    // A line of the audit was lost in an earlier run of the process; after
    // a restart the halt is gone (ADR 0029, ADR 0034).
    const writeHalt = createWriteHalt();
    haltWrites(writeHalt);
    const { double, pipeline } = setup({ writeHalt });
    expect(await pipeline.writeForRun(writeRequest())).toEqual(
      refused('policy_denied', true),
    );
    assertOnlyReads(double);
  });
});

describe('rights of the account of a run', () => {
  const wide = { churchwiki: { 'edit category': [12, 13] } };

  it('queues a write when the account may edit a category outside the entries of its account', async () => {
    const { pipeline, fake, keeper, events, logs, patches } = setup();
    fake.rights = wide;
    const outcome = await pipeline.writeForRun(writeRequest());
    expect(outcome).toMatchObject({ ok: true, state: 'queued', target });
    expect(
      await keeper.load(ctxOf, events()[0]?.['eventId'] as string),
    ).toMatchObject({ content: { reason: 'rights_drift' } });
    expect(logs()).toContain('run_rights_drift');
    expect(events()[0]).not.toHaveProperty('rightsDriftAccepted');
    expect(patches()).toBe(0);
  });

  it('queues a write when the account has a right no tool of its routines needs', async () => {
    const { pipeline, fake, patches } = setup();
    fake.rights = { churchwiki: { 'edit category': [12], view: true } };
    expect(await pipeline.writeForRun(writeRequest())).toMatchObject({
      ok: true,
      state: 'queued',
    });
    // The read tool of its routines needs the right: no drift.
    expect(
      await pipeline.writeForRun(
        writeRequest({ accountTools: [toolName, 'ct_test_run_read'] }),
      ),
    ).toEqual(verified(4));
    expect(patches()).toBe(1);
  });

  const accepted = () =>
    setup({
      policy: policyOf({
        acceptRightsDrift: { from: '2026-11-01', until: '2026-11-20' },
      }),
    });

  it('writes under the exception of the policy for today', async () => {
    const { pipeline, fake, events, logs } = accepted();
    fake.rights = wide;
    expect(await pipeline.writeForRun(writeRequest())).toEqual(verified(4));
    expect(events()[0]).toMatchObject({
      outcome: 'ok',
      writeState: 'verified',
      confirmation: 'policy',
      runId,
    });
    expect(logs()).toContain('run_rights_drift_accepted');
    // Without rights beyond the needs, the exception leaves no note.
    fake.rights = { churchwiki: { 'edit category': [12] } };
    expect(
      await pipeline.writeForRun(writeRequest({ period: '2026-W47' })),
    ).toEqual(verified(5));
    expect(events()[1]).not.toHaveProperty('rightsDriftAccepted');
  });

  // The note reaches the line in the audit file, not only the log.
  it('notes the exception in the audit line of the write', async () => {
    const { pipeline, fake, events } = accepted();
    fake.rights = wide;
    expect(await pipeline.writeForRun(writeRequest())).toEqual(verified(4));
    expect(events()[0]).toMatchObject({
      writeState: 'verified',
      rightsDriftAccepted: true,
    });
  });

  it('queues a write when the exception is over or has not begun', async () => {
    for (const span of [
      { from: '2026-10-01', until: '2026-10-20' },
      { from: '2026-11-11', until: '2026-11-20' },
    ]) {
      const { pipeline, fake, keeper, events, patches } = setup({
        policy: policyOf({ acceptRightsDrift: span }),
      });
      fake.rights = wide;
      expect(await pipeline.writeForRun(writeRequest())).toMatchObject({
        ok: true,
        state: 'queued',
      });
      expect(
        await keeper.load(ctxOf, events()[0]?.['eventId'] as string),
      ).toMatchObject({ content: { reason: 'rights_drift' } });
      expect(events()[0]).not.toHaveProperty('rightsDriftAccepted');
      expect(patches()).toBe(0);
    }
  });
});

describe('the limits of a routine', () => {
  it('queues a second write of the same run beyond its limit per run', async () => {
    const { pipeline, fake, keeper, events, patches, dayCount } = setup({
      policy: policyOf({ maxPerRun: 1 }),
    });
    fake.pages.set(otherGuid, {
      categoryId: 12,
      title: 'Wochenplan',
      version: 1,
      text: '# Wochenplan',
    });
    const runWrites = createRunWrites();
    expect(await pipeline.writeForRun(writeRequest({ runWrites }))).toEqual(
      verified(4),
    );
    const second = await pipeline.writeForRun(
      writeRequest({ runWrites, page: { categoryId: 12, guid: otherGuid } }),
    );
    expect(second).toMatchObject({
      ok: true,
      state: 'queued',
      target: { kind: 'wiki_page', key: `12/${otherGuid}` },
    });
    expect(
      await keeper.load(ctxOf, events()[1]?.['eventId'] as string),
    ).toMatchObject({ content: { reason: 'limit_reached' } });
    expect(patches()).toBe(1);
    // A write beyond the limit of its run costs no place of the day.
    expect(await dayCount()).toBe(1);
    // Another run has a counter of its own.
    expect(
      await pipeline.writeForRun(
        writeRequest({ page: { categoryId: 12, guid: otherGuid } }),
      ),
    ).toEqual(verified(2, { kind: 'wiki_page', key: `12/${otherGuid}` }));
  });

  it('queues the write of a later run beyond the limit of the day', async () => {
    const { pipeline, keeper, events, patches } = setup({
      policy: policyOf({ maxPerRun: 1, maxPerDay: 1 }),
    });
    expect(await pipeline.writeForRun(writeRequest())).toEqual(verified(4));
    const later = await pipeline.writeForRun(
      writeRequest({
        period: '2026-W47',
        section: '## Woche 47\n\nAlles besetzt.',
      }),
    );
    expect(later).toMatchObject({ ok: true, state: 'queued', target });
    expect(
      await keeper.load(ctxOf, events()[1]?.['eventId'] as string),
    ).toMatchObject({ content: { reason: 'limit_reached' } });
    expect(patches()).toBe(1);
  });
});

describe('contact values in the section of a run', () => {
  it('lets through those of the data the run read, and refuses any other', async () => {
    const { pipeline, events, patches } = setup();
    const read = await pipeline.callForRun(
      'ct_test_run_read',
      {},
      readRequest(),
    );
    if (!read.ok) throw new Error(`the read failed: ${read.code}`);
    const known =
      '## Kontakt\n\nFragen an info@example.org oder +41 00 000 12 34.';
    expect(
      await pipeline.writeForRun(
        writeRequest({ section: known, data: [read.data] }),
      ),
    ).toEqual(verified(4));
    expect(events()[1]).toMatchObject({ writeState: 'verified' });

    for (const unknown of [
      '## Kontakt\n\nFragen an andere@example.org.',
      '## Kontakt\n\nFragen an +41 00 000 56 78.',
    ]) {
      const outcome = await pipeline.writeForRun(
        writeRequest({
          period: '2026-W47',
          section: unknown,
          data: [read.data],
        }),
      );
      expect(outcome).toEqual(refused('validation'));
      expect(events().at(-1)).toMatchObject({
        outcome: 'denied',
        writeState: 'denied',
        errorCode: 'validation',
        contentViolations: ['contact'],
      });
    }
    // The same values without the data that hold them are refused too.
    expect(
      await pipeline.writeForRun(
        writeRequest({ period: '2026-W47', section: known }),
      ),
    ).toEqual(refused('validation'));
    expect(patches()).toBe(1);
  });
});

describe('a write of a run that the composition root built wrong', () => {
  it('ends as internal and reads and writes nothing', async () => {
    const { double, pipeline } = setup();
    const internal = refused('internal');
    for (const wrong of [
      // Data without the mark of a redacted result.
      writeRequest({ data: [{ text: 'Fragen an info@example.org' }] }),
      // A tool of the account the catalog does not know.
      writeRequest({ accountTools: [toolName, 'ct_test_unknown'] }),
      // Periods the line of the marking cannot name.
      writeRequest({ period: 'W 46' }),
      writeRequest({ period: '' }),
      writeRequest({ period: '-2026' }),
      writeRequest({ period: 'x'.repeat(33) }),
      writeRequest({ period: 46 as unknown as string }),
      // A routine without the form of the policy.
      writeRequest({ run: { runId, routineId: 'Dienstplan' } }),
      // A section that is no text.
      writeRequest({ section: undefined as unknown as string }),
      // Page, data and tools of the wrong form.
      writeRequest({ page: null as unknown as RunWriteRequest['page'] }),
      writeRequest({ data: 'x' as unknown as unknown[] }),
      writeRequest({ accountTools: 'x' as unknown as string[] }),
    ]) {
      await expect(pipeline.writeForRun(wrong)).resolves.toEqual(internal);
    }
    await expect(
      pipeline.writeForRun(null as unknown as RunWriteRequest),
    ).resolves.toEqual(internal);
    assertOnlyReads(double);
    expect(double.calls()).toHaveLength(0);
  });

  // A counter the core did not make ends the write as internal before
  // anything is read, so that no write of a run goes on without its limit
  // per run.
  it('ends a counter of the writes that the core did not make as internal', async () => {
    const { pipeline } = setup();
    await expect(
      pipeline.writeForRun(
        writeRequest({
          runWrites: { __ecclium: 'RunWrites' } as unknown as RunWrites,
        }),
      ),
    ).resolves.toEqual(refused('internal'));
  });
  // The same for each other form, so that a fix that misses one shows.
  const forms: readonly (readonly [string, () => unknown])[] = [
    ['a copy', (): unknown => Object.freeze({ ...createRunWrites() })],
    ['a proxy', (): unknown => new Proxy(createRunWrites(), {})],
    ['none', (): unknown => undefined],
  ];
  it.each(forms)(
    'ends %s of the counter of the writes as internal',
    async (_name, make) => {
      const { pipeline } = setup();
      await expect(
        pipeline.writeForRun(writeRequest({ runWrites: make() as RunWrites })),
      ).resolves.toEqual(refused('internal'));
    },
  );

  it('writes nothing with a counter of the writes that the core did not make', async () => {
    const { double, pipeline, dayCount } = setup();
    const real = createRunWrites();
    for (const lookalike of [
      { __ecclium: 'RunWrites' },
      Object.freeze({ ...real }),
      new Proxy(real, {}),
      undefined,
    ]) {
      const outcome = await pipeline.writeForRun(
        writeRequest({ runWrites: lookalike as unknown as RunWrites }),
      );
      expect(outcome).not.toMatchObject({ state: 'verified' });
    }
    assertOnlyReads(double);
    expect(await dayCount()).toBe(0);
  });

  it('writes nothing for a configuration that only reads, or that does not say', async () => {
    const { double, pipeline, events } = setup();
    const withoutReadOnly = writeRequest();
    Reflect.deleteProperty(withoutReadOnly, 'readOnly');
    for (const wrong of [
      writeRequest({ readOnly: true }),
      withoutReadOnly,
      writeRequest({ readOnly: 'false' as unknown as boolean }),
    ]) {
      await expect(pipeline.writeForRun(wrong)).resolves.toEqual(
        refused('policy_denied'),
      );
    }
    assertOnlyReads(double);
    expect(events().map((line) => line['outcome'])).toEqual([
      'denied',
      'denied',
      'denied',
    ]);
  });
});

describe('which tools write for a run', () => {
  it('never writes through a call in the mode unattended, which reaches no entry of a routine', async () => {
    const { double, pipeline, logs, dayCount } = setup();
    const outcome = await pipeline.call(
      toolName,
      { categoryId: 12, guid, section, baseVersion: 3 },
      {
        assignment: runner,
        mode: 'unattended',
        redaction: 'standard',
        readOnly: false,
        features: [],
        signal: new AbortController().signal,
      },
    );
    expect(outcome).toEqual({
      ok: false,
      error: {
        code: 'policy_denied',
        message: policySentences.notInteractive,
      },
    });
    expect(logs()).toContain('policy_not_interactive');
    assertOnlyReads(double);
    expect(await dayCount()).toBe(0);
  });

  it('refuses a tool that may never run unattended, one not stable for routines, one of a plugin and a read tool', async () => {
    const { double, pipeline, events } = setup();
    for (const tool of [
      'ct_test_run_never',
      'ct_example_note_write',
      'ct_test_plugin_append',
      'ct_test_run_read',
    ]) {
      await expect(
        pipeline.writeForRun(writeRequest({ tool })),
      ).resolves.toEqual(refused('policy_denied'));
    }
    await expect(
      pipeline.writeForRun(writeRequest({ tool: 'ct_test_missing' })),
    ).resolves.toEqual(refused('not_found'));
    expect(double.calls()).toHaveLength(0);
    expect(events().map((line) => line['outcome'])).toEqual([
      'denied',
      'denied',
      'denied',
      'denied',
      'error',
    ]);
  });
});

describe('how a write of a run ends', () => {
  it('keeps a snapshot before the write and gives the ID to take it back', async () => {
    const saved: unknown[] = [];
    const { pipeline, events } = setup({
      snapshots: {
        save: (_ctx, snapshot) => {
          saved.push(snapshot.eventId);
          return Promise.resolve();
        },
        load: () => Promise.resolve({ kind: 'missing' }),
      },
    });
    const outcome = await pipeline.writeForRun(writeRequest());
    const eventId = events()[0]?.['eventId'];
    expect(outcome).toEqual({ ...verified(4), undoId: eventId });
    expect(saved).toEqual([eventId]);
  });

  it('may try again after a write whose outcome is not known, which a later run then writes', async () => {
    const { pipeline, fake, events, patches, text } = setup();
    fake.patch = 'fail';
    expect(await pipeline.writeForRun(writeRequest())).toEqual({
      ok: false,
      code: 'upstream',
      sent: true,
      transient: true,
    });
    expect(events()[0]).toMatchObject({
      outcome: 'error',
      errorCode: 'upstream',
      writeState: 'failed',
      confirmation: 'policy',
      runId,
    });
    expect(text()).toBe('# Dienstplan');
    delete fake.patch;
    expect(await pipeline.writeForRun(writeRequest())).toEqual(verified(4));
    expect(patches()).toBe(2);
  });

  it('may try again after a write that someone changed at the same time, which the marking keeps from adding twice', async () => {
    const { pipeline, fake, events, patches } = setup();
    fake.patch = 'other';
    expect(await pipeline.writeForRun(writeRequest())).toEqual({
      ok: false,
      code: 'conflict',
      sent: true,
      transient: true,
    });
    expect(events()[0]).toMatchObject({
      outcome: 'error',
      errorCode: 'conflict',
      writeState: 'conflict',
    });
    // The section landed: the next try finds it and adds nothing.
    delete fake.patch;
    expect(await pipeline.writeForRun(writeRequest())).toMatchObject({
      ok: true,
      state: 'skipped',
    });
    expect(patches()).toBe(1);
  });

  it('ends with the code of a read of the page that ChurchTools refused', async () => {
    const { double, pipeline, fake } = setup();
    fake.pageStatus = 403;
    expect(await pipeline.writeForRun(writeRequest())).toEqual(
      refused('permission'),
    );
    assertOnlyReads(double);
  });

  it('cannot queue a write on a server without a queue, and writes nothing', async () => {
    const { double, pipeline, fake, events } = setup({ queue: false });
    fake.categoryName = 'Umbenannt';
    expect(await pipeline.writeForRun(writeRequest())).toEqual(
      refused('confirmation_required'),
    );
    expect(events()[0]).toMatchObject({
      outcome: 'denied',
      writeState: 'denied',
      errorCode: 'confirmation_required',
    });
    assertOnlyReads(double);
  });

  it('stops when the kill switch of the routine is set between the plan and the commit', async () => {
    const { double, pipeline, fake, dayCount } = setup();
    fake.onCategories = () => {
      writeFileSync(join(dir, `writes-off-routine-${routine}`), '');
    };
    expect(await pipeline.writeForRun(writeRequest())).toEqual(
      refused('policy_denied'),
    );
    assertOnlyReads(double);
    expect(await dayCount()).toBe(0);
  });

  it('refuses a section after a block the page leaves open, which would swallow its line of the marking', async () => {
    const { pipeline, fake, events, patches } = setup();
    const page = fake.pages.get(guid);
    if (page === undefined) throw new Error('no page');
    page.text = '# Dienstplan\n\n```\nnoch offen';
    expect(await pipeline.writeForRun(writeRequest())).toEqual(
      refused('validation'),
    );
    expect(events()[0]).not.toHaveProperty('contentViolations');
    expect(patches()).toBe(0);
  });
});

describe('a write tool that does not do what a run expects', () => {
  it('ends as internal when the tool returns anything but the outcome of its plan', async () => {
    const { pipeline, logs, patches } = setup();
    for (const tool of ['ct_test_run_copy', 'ct_test_run_unplanned']) {
      await expect(
        pipeline.writeForRun(writeRequest({ tool })),
      ).resolves.toEqual(refused('internal'));
    }
    expect(
      logs().filter((event) => event === 'tool_output_invalid'),
    ).toHaveLength(2);
    expect(patches()).toBe(0);
  });

  it('refuses a plan of a run that changes the whole page', async () => {
    const { pipeline, logs, patches } = setup();
    expect(
      await pipeline.writeForRun(writeRequest({ tool: 'ct_test_run_update' })),
    ).toEqual(refused('policy_denied'));
    expect(logs()).toContain('write_refused');
    expect(patches()).toBe(0);
  });
});

describe('answers no real part gives', () => {
  it('ends as internal when the write guard gives a plan without its text', async () => {
    const { pipeline, patches } = setup();
    gaps.dropText = true;
    expect(await pipeline.writeForRun(writeRequest())).toEqual(
      refused('internal'),
    );
    expect(patches()).toBe(0);
  });

  it('ends as internal when the search of the page fails with an error the client does not describe', async () => {
    const { double, pipeline } = setup();
    gaps.pageThrows = true;
    expect(await pipeline.writeForRun(writeRequest())).toEqual(
      refused('internal'),
    );
    expect(double.calls()).toHaveLength(0);
  });
});

describe('contact values of the data in a write of a run that waits in the queue', () => {
  const wide = { churchwiki: { 'edit category': [12, 13] } };

  it('keeps an address whose written form escapes a sign, so that an approval writes it', async () => {
    readText.value = 'Fragen an anna_muster@example.org oder im Sekretariat.';
    const { pipeline, fake, keeper, events, patches, text } = setup();
    const read = await pipeline.callForRun(
      'ct_test_run_read',
      {},
      readRequest(),
    );
    if (!read.ok) throw new Error(`the read failed: ${read.code}`);
    // Rights beyond the needs of the account send the write to the queue.
    fake.rights = wide;
    const outcome = await pipeline.writeForRun(
      writeRequest({
        section: '## Kontakt\n\nFragen an anna_muster@example.org.',
        data: [read.data],
      }),
    );
    const queueId = events()[1]?.['eventId'];
    expect(outcome).toEqual({ ok: true, state: 'queued', target, queueId });
    expect(await keeper.load(ctxOf, queueId as string)).toMatchObject({
      kind: 'found',
      content: {
        reason: 'rights_drift',
        run: { contacts: ['anna_muster@example.org'] },
      },
    });
    expect(patches()).toBe(0);

    const approved = await pipeline.approve({ queueId }, operatorRequest());
    expect(approved).toMatchObject({ kind: 'approved', target, version: 4 });
    expect(patches()).toBe(1);
    expect(text()).toContain('anna\\_muster@example.org');
  });

  it('keeps an address the template sets in bold, so that an approval writes it', async () => {
    readText.value = 'Fragen an anna_muster@example.org oder im Sekretariat.';
    const { pipeline, fake, keeper, events, patches, text } = setup();
    const read = await pipeline.callForRun(
      'ct_test_run_read',
      {},
      readRequest(),
    );
    if (!read.ok) throw new Error(`the read failed: ${read.code}`);
    fake.rights = wide;
    const outcome = await pipeline.writeForRun(
      writeRequest({
        section: '## Kontakt\n\nFragen an **anna_muster@example.org**.',
        data: [read.data],
      }),
    );
    const queueId = events()[1]?.['eventId'];
    expect(outcome).toEqual({ ok: true, state: 'queued', target, queueId });
    expect(await keeper.load(ctxOf, queueId as string)).toMatchObject({
      content: { run: { contacts: ['anna_muster@example.org'] } },
    });
    expect(
      await pipeline.approve({ queueId }, operatorRequest()),
    ).toMatchObject({ kind: 'approved', target, version: 4 });
    expect(patches()).toBe(1);
    expect(text()).toContain('**anna\\_muster@example.org**');
  });

  it('keeps at most 100 of them in the entry, so that an approval refuses a section with more', async () => {
    const addresses = Array.from(
      { length: 101 },
      (_, index) => `person${String(index).padStart(3, '0')}@example.org`,
    );
    readText.value = `Liste: ${addresses.join(' ')} und andere.`;
    const { pipeline, fake, keeper, events, patches } = setup();
    const read = await pipeline.callForRun(
      'ct_test_run_read',
      {},
      readRequest(),
    );
    if (!read.ok) throw new Error(`the read failed: ${read.code}`);
    fake.rights = wide;
    const outcome = await pipeline.writeForRun(
      writeRequest({
        section: `## Kontakt\n\n${addresses.join(', ')}.`,
        data: [read.data],
      }),
    );
    const queueId = events()[1]?.['eventId'];
    expect(outcome).toEqual({ ok: true, state: 'queued', target, queueId });
    const loaded = await keeper.load(ctxOf, queueId as string);
    expect(loaded.kind === 'found' && loaded.content.run?.contacts).toEqual(
      addresses.slice(0, 100),
    );

    expect(
      await pipeline.approve({ queueId }, operatorRequest()),
    ).toMatchObject({ kind: 'failed', reason: 'content', used: false });
    expect(patches()).toBe(0);
  });

  it('never trusts a web address from the data that reads like an e-mail address, and writes nothing', async () => {
    const phishing = 'https://phish.example/@login/a.bc';
    readText.value = `Anmeldung unter ${phishing} bitte.`;
    const { double, pipeline, events, patches } = setup();
    const read = await pipeline.callForRun(
      'ct_test_run_read',
      {},
      readRequest(),
    );
    if (!read.ok) throw new Error(`the read failed: ${read.code}`);
    const outcome = await pipeline.writeForRun(
      writeRequest({
        section: `## Anmeldung\n\nUnter ${phishing} anmelden.`,
        data: [read.data],
      }),
    );
    expect(outcome).toEqual(refused('validation'));
    expect(events()[1]).toMatchObject({
      outcome: 'denied',
      writeState: 'denied',
      errorCode: 'validation',
    });
    expect(events()[1]?.['contentViolations']).toEqual(
      expect.arrayContaining([expect.any(String)]),
    );
    assertOnlyReads(double);
    expect(patches()).toBe(0);
  });
});

describe('the own section of a run right after a paragraph of a person', () => {
  it('is replaced with an empty line after the paragraph, and found as its own again', async () => {
    const { pipeline, fake, logs, patches, text } = setup();
    const first = '## W46\n\nAlles besetzt.';
    expect(
      await pipeline.writeForRun(writeRequest({ section: first })),
    ).toEqual(verified(4));
    // A person writes a paragraph right before the heading of the section,
    // without an empty line; the heading still ends the paragraph.
    const page = fake.pages.get(guid);
    if (page === undefined) throw new Error('no page');
    page.text = page.text.replace('\n\n## W46', '\n\nNotiz von Hand.\n## W46');
    page.version += 1;
    expect(
      await pipeline.writeForRun(writeRequest({ section: first })),
    ).toMatchObject({ ok: true, state: 'skipped' });

    // The new section begins with a paragraph, which would run on from the
    // paragraph of the person without the empty line.
    const second =
      'Sigrist fehlt am Sonntag.\n\n## W46\n\nSonst alles besetzt.';
    expect(
      await pipeline.writeForRun(writeRequest({ section: second })),
    ).toEqual(verified(6));
    expect(text()).toBe(
      `# Dienstplan\n\nNotiz von Hand.\n\n${second}\n\n${runMarking(`${second}\n`, '2026-W46')}`,
    );
    expect(periodsOn(text())).toEqual(['2026-W46']);

    // A third run of the period with the same section finds it as its own.
    expect(
      await pipeline.writeForRun(writeRequest({ section: second })),
    ).toEqual({ ok: true, state: 'skipped', target });
    expect(logs()).not.toContain('marking_changed');
    expect(patches()).toBe(2);
  });
});

// A free text of the data comes in the envelope of foreign data,
// `<<data-…>>…<</data-…>>`. An address at the very start or end of such a
// text counts as a contact value of the data all the same, read apart
// from the marks of the envelope (run/content.ts, `collect`).
describe('a contact value at the edge of a free text of the data', () => {
  it.each([
    ['at the end', 'Fragen an anna_muster@example.org.'],
    ['at the start', 'anna_muster@example.org nimmt Fragen entgegen.'],
  ])('counts %s of the text', async (_where, given) => {
    readText.value = given;
    const { pipeline } = setup();
    const read = await pipeline.callForRun(
      'ct_test_run_read',
      {},
      readRequest(),
    );
    if (!read.ok) throw new Error(`the read failed: ${read.code}`);
    expect(
      await pipeline.writeForRun(
        writeRequest({
          section: '## Kontakt\n\nFragen an anna_muster@example.org.',
          data: [read.data],
        }),
      ),
    ).toEqual(verified(4));
  });
});

describe('the reason a write of a run waits for', () => {
  const wide = { churchwiki: { 'edit category': [12, 13] } };

  it('is rights beyond the needs of the account, also when the limit of the day is reached', async () => {
    const { pipeline, fake, keeper, events, logs } = setup({
      policy: policyOf({ maxPerRun: 1, maxPerDay: 1 }),
    });
    expect(await pipeline.writeForRun(writeRequest())).toEqual(verified(4));
    fake.rights = wide;
    const outcome = await pipeline.writeForRun(
      writeRequest({
        period: '2026-W47',
        section: '## Woche 47\n\nAlles besetzt.',
      }),
    );
    expect(outcome).toMatchObject({ ok: true, state: 'queued' });
    expect(logs()).toEqual(
      expect.arrayContaining(['policy_limit_reached', 'run_rights_drift']),
    );
    expect(
      await keeper.load(ctxOf, events()[1]?.['eventId'] as string),
    ).toMatchObject({ content: { reason: 'rights_drift' } });
  });

  it('is rights beyond the needs of the account, also when the name of the target changed', async () => {
    const { pipeline, fake, keeper, events, logs } = setup();
    fake.rights = wide;
    fake.categoryName = 'Umbenannt';
    expect(await pipeline.writeForRun(writeRequest())).toMatchObject({
      ok: true,
      state: 'queued',
    });
    expect(logs()).toEqual(
      expect.arrayContaining(['policy_name_changed', 'run_rights_drift']),
    );
    expect(
      await keeper.load(ctxOf, events()[0]?.['eventId'] as string),
    ).toMatchObject({ content: { reason: 'rights_drift' } });
  });
});
