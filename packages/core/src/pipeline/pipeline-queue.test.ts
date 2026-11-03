import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '@ecclium/mcp-churchtools-core';
import {
  type ApprovalQueue,
  classify,
  type Clock,
  defineWriteTool,
  type IsoDate,
  type Plugin,
  type PluginHost,
  type TenantAssignment,
  type TenantContext,
  type ToolDefinition,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  assertNoCanary,
  assertOnlyReads,
  createChurchToolsDouble,
  createMemoryApprovalQueue,
  createMemoryDayKeys,
  createMemoryQuotaStore,
  doubleOrigin,
  examplePlugin,
  makeCanary,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { auditPlaceholders, createAuditSink } from '../audit/index.js';
import type { WriteConfirmation } from '../config/index.js';
import { createFileKeyProvider } from '../keys/file-provider.js';
import { checkPolicy, defaultPolicy } from '../policy/check.js';
import type { Policy } from '../policy/schema.js';
import { createQueueKeeper, type QueueKeeper } from '../queue/index.js';
import { createToolCatalog } from '../registry/index.js';
import {
  confirmationSentence,
  confirmationSentences,
} from '../write/confirm.js';
import { createMemoryNonceStore } from '../write/nonce-store.js';
import { createMemoryPlanStore } from '../write/plan-store.js';
import { createToolPipeline, type ToolRequest } from './pipeline.js';

// The queue of approvals in the pipeline (ADR 0031): a write no person can
// confirm in the client, or that the policy sends there, waits as a sealed
// entry under the ID of the audit line of its call, and the operator
// rejects it through the entry reject. ChurchTools is the double; the
// entries are sealed with day keys in memory.

const loaded = loadConfig({
  environment: {
    ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
    ECCLIUM_CHURCHTOOLS_TOKEN: makeCanary('token').value,
  },
  transport: 'stdio',
});
if (!loaded.ok) throw new Error('the configuration of the test is invalid');
const token = loaded.config.churchtoolsToken;

const now = Date.UTC(2026, 10, 3, 8, 0, 0);
const day = '2026-11-03' as IsoDate;
const clockAt = (time: () => number): Clock =>
  Object.freeze({ now: Object.freeze(time) });
const clock = clockAt(() => now);
const guid = '00000000-0000-4000-8000-0000000000ab';
const pagePath = `/api/wiki/categories/12/pages/${guid}`;
const json = {
  headers: {
    'content-type': 'application/json',
    date: new Date(now).toUTCString(),
  },
};
const rights = JSON.stringify({
  data: { churchwiki: { 'edit category': [12] } },
});
const page = (version: number, text: string): string =>
  JSON.stringify({
    data: { title: 'Dienstplan', isMarkdown: true, version, text },
  });

// Text of the write that must never reach a log line or the audit.
const canary = makeCanary('name');
const note = { categoryId: 12, guid, baseVersion: 3, note: canary.value };

const assignment = {
  tenantId: 'default',
  actor: { kind: 'user', id: 'stdio:local-stdio' },
} as unknown as TenantAssignment;
const ctxOf = {
  tenantId: 'default',
  instance: doubleOrigin,
} as unknown as TenantContext;

const request = (extra: Partial<ToolRequest> = {}): ToolRequest => ({
  assignment,
  mode: 'interactive',
  redaction: 'standard',
  readOnly: false,
  features: [],
  signal: new AbortController().signal,
  ...extra,
});
const operator = (extra: Partial<ToolRequest> = {}): ToolRequest =>
  request({ mode: 'operator', ...extra });

const pluginOf = (...tools: ToolDefinition[]): Plugin => ({
  name: 'test-plugin',
  version: '1.0.0',
  register(host: PluginHost): undefined {
    for (const tool of tools) host.addTool(tool);
    return undefined;
  },
});

// A write tool of a plugin that replaces the text of the page with a text
// of 121 lines, too long for a question.
const longTool = defineWriteTool({
  name: 'ct_test_long',
  meta: {
    capability: 'write',
    domain: 'wiki',
    requiredRights: [],
    tier: 'free',
    sensitivity: 'personal',
    unattended: 'policy',
    routineStable: false,
    reversible: 'snapshot',
    replayGuard: 'baseVersion',
  },
  description: {
    purpose: 'Serves a test.',
    useWhen: 'A test needs it.',
    avoidWhen: 'Anything else.',
    limits: 'None.',
  },
  input: z.object({ text: classify(z.string().max(100), 'untrusted') }),
  execute: ({ write }) =>
    write.plan({
      kind: 'wikiPageUpdate',
      categoryId: 12,
      guid,
      text: Array.from({ length: 121 }, (_, index) => `Zeile ${String(index)}`)
        .join('\n')
        .concat('\n'),
      baseVersion: 3,
    }),
});

let dir: string;
const open: { close(): Promise<void> }[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ecclium-pipeline-queue-'));
});

afterEach(async () => {
  rmSync(dir, { recursive: true, force: true });
  await Promise.all(open.splice(0).map((item) => item.close()));
});

const setup = (
  options: {
    readonly queue?: false | QueueKeeper;
    readonly store?: ApprovalQueue;
    readonly confirmation?: WriteConfirmation;
    readonly policy?: Policy;
    readonly clock?: Clock;
  } = {},
) => {
  const double = createChurchToolsDouble({ token });
  open.push(double);
  const catalog = createToolCatalog({
    core: examplePlugin,
    plugins: [pluginOf(longTool)],
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
  const keys = createFileKeyProvider({ dayKeys: createMemoryDayKeys() });
  const store = options.store ?? createMemoryApprovalQueue();
  const keeper = createQueueKeeper({ keys, store, clock });
  const pipelineClock = options.clock ?? clock;
  const pipeline = createToolPipeline({
    policy: options.policy ?? defaultPolicy,
    catalog,
    audit,
    quota: createMemoryQuotaStore(),
    transport: double.transport,
    origin: doubleOrigin,
    requestsPerMinute: 300,
    clock: pipelineClock,
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
    ...(options.confirmation === undefined
      ? {}
      : { confirmation: options.confirmation }),
    ...(options.queue === false ? {} : { queue: options.queue ?? keeper }),
  });
  const events = () =>
    auditLines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const logs = () =>
    logLines.map((line) => (JSON.parse(line) as { event: string }).event);
  // The reads of a plan: the rights, then the page.
  const planReads = () => {
    double
      .intercept({ path: '/api/permissions/global', method: 'GET' })
      .reply(200, rights, json);
    double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(200, page(3, '# Plan\n'), json);
  };
  return {
    double,
    pipeline,
    keeper,
    keys,
    store,
    events,
    logs,
    file,
    planReads,
    auditLines,
    logLines,
  };
};

// Queues the note of the example and gives the ID of its entry.
const queueNote = async (
  setupped: ReturnType<typeof setup>,
  extra: Partial<ToolRequest> = {},
): Promise<string> => {
  setupped.planReads();
  const outcome = await setupped.pipeline.call(
    'ct_example_note_write',
    note,
    request(extra),
  );
  if (!outcome.ok) throw new Error(outcome.error.message);
  const data = outcome.data as unknown as { queueId: string };
  return data.queueId;
};

describe('a write that waits in the queue (ADR 0031)', () => {
  it('waits under the ID of its audit line, sealed, when the client cannot confirm it, and nothing is written', async () => {
    const setupped = setup();
    const { double, pipeline, keeper, store, events, logs, planReads } =
      setupped;
    planReads();
    const outcome = await pipeline.call(
      'ct_example_note_write',
      note,
      request(),
    );
    expect(outcome.ok).toBe(true);
    const data = outcome.ok
      ? (outcome.data as unknown as Record<string, unknown>)
      : {};
    const target = { kind: 'wiki_page', key: `12/${guid}` };
    expect(data).toEqual({
      state: 'queued',
      target,
      queueId: events()[0]?.['eventId'],
    });
    expect(events()[0]).toMatchObject({
      type: 'tool_call',
      tool: 'ct_example_note_write',
      outcome: 'ok',
      writeState: 'queued',
      objectRefs: ['wiki_category:12', `wiki_page:${guid}`],
    });
    expect(events()[0]).not.toHaveProperty('errorCode');
    expect(logs()).toContain('write_queued');
    assertOnlyReads(double);
    const loaded = await keeper.load(ctxOf, data['queueId'] as string);
    expect(loaded).toMatchObject({
      kind: 'found',
      day,
      content: {
        tool: 'ct_example_note_write',
        origin: 'core',
        actor: { kind: 'user', id: 'stdio:local-stdio' },
        // The section as written, with its line break (ADR 0030).
        intent: { kind: 'wikiSectionAppend', section: `${canary.value}\n` },
        target,
        reason: 'no_question',
        queuedAt: now,
      },
    });
    expect(loaded.kind === 'found' && loaded.content.summary).toContain(
      'Dienstplan',
    );
    const kept = await store.list(ctxOf);
    expect(kept[0]?.entry?.sealed).not.toContain(canary.value);
    assertNoCanary(
      [...setupped.auditLines, ...setupped.logLines].join('\n'),
      [canary],
      'audit and log',
    );
  });

  it('waits with the reason of the policy whatever the client can, and asks nothing', async () => {
    const checked = checkPolicy({
      schema: 'policy.v1',
      interactive: {
        targets: [
          {
            target: { kind: 'wiki_category', id: 13, name: 'Andere' },
            tools: ['ct_example_note_write'],
            maxPerDay: 1,
          },
        ],
      },
    });
    if (!checked.ok) throw new Error(checked.code);
    const setupped = setup({ policy: checked.policy });
    const id = await queueNote(setupped, { elicitation: true });
    expect(await setupped.keeper.load(ctxOf, id)).toMatchObject({
      kind: 'found',
      content: { reason: 'no_entry' },
    });
    expect(setupped.logs()).toEqual(
      expect.arrayContaining(['policy_no_entry', 'write_queued']),
    );
  });

  it('waits with the setting queue, also for a client that can be asked', async () => {
    const setupped = setup({ confirmation: 'queue' });
    const id = await queueNote(setupped, { elicitation: true });
    expect(await setupped.keeper.load(ctxOf, id)).toMatchObject({
      kind: 'found',
      content: { reason: 'setting' },
    });
  });

  it('waits with a diff too long for a question, whole', async () => {
    const setupped = setup();
    setupped.planReads();
    const outcome = await setupped.pipeline.call(
      'ct_test_long',
      { text: 'x' },
      request({ elicitation: true }),
    );
    if (!outcome.ok) throw new Error(outcome.error.message);
    const { queueId } = outcome.data as unknown as { queueId: string };
    const loaded = await setupped.keeper.load(ctxOf, queueId);
    expect(loaded).toMatchObject({
      kind: 'found',
      content: { reason: 'too_long', origin: 'plugin' },
    });
    expect(
      loaded.kind === 'found' &&
        loaded.content.diff.filter((line) => line.startsWith('+')).length,
    ).toBe(121);
  });

  it('writes nothing and queues nothing once 100 entries wait', async () => {
    const store = createMemoryApprovalQueue();
    for (let index = 0; index < 100; index += 1) {
      await store.put(ctxOf, {
        id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
        day,
        sealed: 'x',
      });
    }
    const { double, pipeline, events, logs, planReads } = setup({ store });
    planReads();
    const outcome = await pipeline.call(
      'ct_example_note_write',
      note,
      request(),
    );
    expect(!outcome.ok && outcome.error).toEqual({
      code: 'policy_denied',
      message: confirmationSentences.queueFull,
    });
    expect(events()[0]).toMatchObject({
      outcome: 'denied',
      writeState: 'denied',
      errorCode: 'policy_denied',
    });
    expect(logs()).toContain('write_queue_full');
    expect((await store.list(ctxOf)).length).toBe(100);
    assertOnlyReads(double);
  });

  it.each([
    [
      'cannot count the entries',
      (store: ApprovalQueue): ApprovalQueue => ({
        ...store,
        list: () => Promise.reject(new Error('disk')),
      }),
    ],
    [
      'cannot keep the entry',
      (store: ApprovalQueue): ApprovalQueue => ({
        ...store,
        put: () => Promise.reject(new Error('disk')),
      }),
    ],
  ])('writes nothing when the queue %s', async (_name, broken) => {
    const store = broken(createMemoryApprovalQueue());
    const { double, pipeline, events, logs, planReads } = setup({ store });
    planReads();
    const outcome = await pipeline.call(
      'ct_example_note_write',
      note,
      request(),
    );
    expect(!outcome.ok && outcome.error.code).toBe('internal');
    expect(events()[0]).toMatchObject({
      outcome: 'error',
      writeState: 'failed',
    });
    expect(logs()).toContain('write_queue_failed');
    assertOnlyReads(double);
  });

  it('writes nothing when the queue cannot tell its count', async () => {
    const queue: QueueKeeper = {
      ...setup().keeper,
      waiting: () => Promise.resolve(undefined),
    };
    const { pipeline, planReads } = setup({ queue });
    planReads();
    const outcome = await pipeline.call(
      'ct_example_note_write',
      note,
      request(),
    );
    expect(!outcome.ok && outcome.error.code).toBe('internal');
  });

  it('writes nothing without a day from the clock', async () => {
    const { pipeline, planReads, logs } = setup({
      clock: clockAt(() => Number.NaN),
    });
    planReads();
    const outcome = await pipeline.call(
      'ct_example_note_write',
      note,
      request(),
    );
    expect(!outcome.ok && outcome.error.code).toBe('internal');
    expect(logs()).toContain('write_queue_failed');
  });

  it('ends with the sentence of a missing confirmation without a queue', async () => {
    const { pipeline, planReads } = setup({ queue: false });
    planReads();
    const outcome = await pipeline.call(
      'ct_example_note_write',
      note,
      request(),
    );
    expect(!outcome.ok && outcome.error).toEqual({
      code: 'confirmation_required',
      message: confirmationSentence,
    });
  });
});

describe('a rejection of the operator (ADR 0031)', () => {
  it('keeps the decision, destroys the entry and writes one audit line of the type approval, without asking ChurchTools', async () => {
    const setupped = setup();
    const id = await queueNote(setupped);
    const calls = setupped.double.calls().length;
    const outcome = await setupped.pipeline.reject({ queueId: id }, operator());
    const target = { kind: 'wiki_page', key: `12/${guid}` };
    expect(outcome).toMatchObject({ kind: 'rejected', target });
    expect(outcome.kind === 'rejected' && outcome.summary).toContain(
      'Dienstplan',
    );
    expect(outcome).not.toHaveProperty('unrecorded');
    expect(await setupped.keeper.load(ctxOf, id)).toMatchObject({
      kind: 'decided',
      decision: {
        decision: 'rejected',
        decidedAt: new Date(now).toISOString(),
      },
    });
    expect((await setupped.store.get(ctxOf, id))?.entry).toBeUndefined();
    const line = setupped.events()[1];
    expect(line).toMatchObject({
      type: 'approval',
      queueId: id,
      decision: 'rejected',
      actor: { kind: 'user', id: 'stdio:local-stdio' },
      mode: 'operator',
      outcome: 'ok',
      objectRefs: ['wiki_category:12', `wiki_page:${guid}`],
    });
    expect(line).not.toHaveProperty('tool');
    expect(line).not.toHaveProperty('writeState');
    expect(setupped.logs()).toContain('queue_reject_call');
    expect(setupped.double.calls().length).toBe(calls);
    assertNoCanary(
      [...setupped.auditLines, ...setupped.logLines].join('\n'),
      [canary],
      'audit and log',
    );
  });

  it('says an entry is decided already when rejected twice', async () => {
    const setupped = setup();
    const id = await queueNote(setupped);
    await setupped.pipeline.reject({ queueId: id }, operator());
    expect(await setupped.pipeline.reject({ queueId: id }, operator())).toEqual(
      { kind: 'decided', decision: 'rejected' },
    );
    expect(setupped.events()[2]).toMatchObject({
      type: 'approval',
      queueId: id,
      outcome: 'error',
      errorCode: 'conflict',
    });
  });

  it('finds no entry under another ID, and none past its retention', async () => {
    const setupped = setup();
    const id = await queueNote(setupped);
    expect(
      await setupped.pipeline.reject(
        { queueId: '00000000-0000-4000-8000-0000000000ff' },
        operator(),
      ),
    ).toEqual({ kind: 'missing' });
    expect(setupped.events()[1]).toMatchObject({
      outcome: 'error',
      errorCode: 'not_found',
    });
    await setupped.keys.destroyBefore('queue', '2026-11-04' as IsoDate);
    expect(await setupped.pipeline.reject({ queueId: id }, operator())).toEqual(
      { kind: 'expired' },
    );
  });

  it('refuses an ID that is no UUID, and names none in the audit', async () => {
    const { pipeline, events } = setup();
    for (const queueId of ['../x', 42, undefined]) {
      expect(await pipeline.reject({ queueId }, operator())).toEqual({
        kind: 'failed',
        code: 'validation',
      });
    }
    expect(events()[0]).toMatchObject({
      type: 'approval',
      queueId: auditPlaceholders.queueId,
      decision: 'rejected',
      outcome: 'error',
      errorCode: 'validation',
    });
  });

  it.each([
    ['in another mode', request(), 'policy_denied'],
    ['cancelled before', operator({ signal: AbortSignal.abort() }), 'network'],
    ['without a tenant', operator({ assignment: undefined }), 'auth'],
  ])(
    'refuses a rejection %s and decides nothing',
    async (_name, given, code) => {
      const setupped = setup();
      const id = await queueNote(setupped);
      expect(await setupped.pipeline.reject({ queueId: id }, given)).toEqual({
        kind: 'failed',
        code,
      });
      expect(await setupped.keeper.load(ctxOf, id)).toMatchObject({
        kind: 'found',
      });
    },
  );

  it('decides nothing while the audit file cannot take the line', async () => {
    const setupped = setup();
    const id = await queueNote(setupped);
    setupped.file.ready = false;
    expect(await setupped.pipeline.reject({ queueId: id }, operator())).toEqual(
      { kind: 'failed', code: 'policy_denied', reason: 'auditNotReady' },
    );
    expect(await setupped.keeper.load(ctxOf, id)).toMatchObject({
      kind: 'found',
    });
  });

  it('says so when its line did not reach the audit file', async () => {
    const setupped = setup();
    const id = await queueNote(setupped);
    setupped.file.ok = false;
    expect(
      await setupped.pipeline.reject({ queueId: id }, operator()),
    ).toMatchObject({ kind: 'rejected', unrecorded: true });
  });

  it('finds nothing without a queue', async () => {
    const { pipeline, events } = setup({ queue: false });
    expect(
      await pipeline.reject(
        { queueId: '00000000-0000-4000-8000-0000000000ff' },
        operator(),
      ),
    ).toEqual({ kind: 'off' });
    expect(events()[0]).toMatchObject({
      outcome: 'denied',
      errorCode: 'policy_denied',
    });
  });

  it.each([
    [
      'an entry that does not open',
      (store: ApprovalQueue): ApprovalQueue => ({
        ...store,
        get: (ctx, id) =>
          Promise.resolve({ id, day, entry: { id, day, sealed: 'not.it' } }),
      }),
    ],
    [
      'a queue that cannot keep the decision',
      (store: ApprovalQueue): ApprovalQueue => ({
        ...store,
        decide: () => Promise.reject(new Error('disk')),
      }),
    ],
  ])('fails as internal with %s', async (_name, broken) => {
    const memory = createMemoryApprovalQueue();
    const setupped = setup({ store: memory });
    const id = await queueNote(setupped);
    const { pipeline, events } = setup({
      store: broken(memory),
      queue: createQueueKeeper({
        keys: setupped.keys,
        store: broken(memory),
        clock,
      }),
    });
    expect(await pipeline.reject({ queueId: id }, operator())).toEqual({
      kind: 'failed',
      code: 'internal',
    });
    expect(events()[0]).toMatchObject({
      type: 'approval',
      outcome: 'error',
      errorCode: 'internal',
    });
  });

  it('fails as internal without a time for the decision', async () => {
    const memory = createMemoryApprovalQueue();
    const setupped = setup({ store: memory });
    const id = await queueNote(setupped);
    let times = 0;
    // The clock fails only from the time of the decision on.
    const { pipeline } = setup({
      queue: setupped.keeper,
      clock: clockAt(() => {
        times += 1;
        return times > 1 ? Number.NaN : now;
      }),
    });
    expect(await pipeline.reject({ queueId: id }, operator())).toEqual({
      kind: 'failed',
      code: 'internal',
    });
    expect(await setupped.keeper.load(ctxOf, id)).toMatchObject({
      kind: 'found',
    });
  });

  it('fails as internal when the request cannot be read', async () => {
    const { pipeline, events } = setup();
    const broken = {
      ...operator(),
      get mode(): never {
        throw new Error('no mode');
      },
    } as unknown as ToolRequest;
    expect(
      await pipeline.reject(
        { queueId: '00000000-0000-4000-8000-0000000000ff' },
        broken,
      ),
    ).toEqual({ kind: 'failed', code: 'internal' });
    expect(events()[0]).toMatchObject({ type: 'approval', outcome: 'error' });
  });
});

describe('the queue as the operator reads it (ADR 0031)', () => {
  it('lists the entries of the tenant, waiting and decided, and writes no audit line', async () => {
    const setupped = setup();
    const first = await queueNote(setupped);
    const second = await queueNote(setupped);
    await setupped.pipeline.reject({ queueId: second }, operator());
    const lines = setupped.events().length;
    const listed = await setupped.pipeline.listQueue(operator());
    expect(listed.kind).toBe('listed');
    const entries = listed.kind === 'listed' ? listed.entries : [];
    expect(entries.map(({ id, state }) => ({ id, state }))).toEqual(
      expect.arrayContaining([
        { id: first, state: 'open' },
        { id: second, state: 'rejected' },
      ]),
    );
    expect(setupped.events()).toHaveLength(lines);
  });

  it('shows one entry, one that is decided, and none for another ID or past its retention', async () => {
    const setupped = setup();
    const id = await queueNote(setupped);
    expect(
      await setupped.pipeline.showQueue({ queueId: id }, operator()),
    ).toMatchObject({
      kind: 'found',
      day,
      content: { reason: 'no_question', tool: 'ct_example_note_write' },
    });
    expect(
      await setupped.pipeline.showQueue(
        { queueId: '00000000-0000-4000-8000-0000000000ff' },
        operator(),
      ),
    ).toEqual({ kind: 'missing' });
    await setupped.pipeline.reject({ queueId: id }, operator());
    expect(
      await setupped.pipeline.showQueue({ queueId: id }, operator()),
    ).toEqual({
      kind: 'decided',
      decision: 'rejected',
      decidedAt: new Date(now).toISOString(),
    });
    const later = await queueNote(setupped);
    await setupped.keys.destroyBefore('queue', '2026-11-04' as IsoDate);
    expect(
      await setupped.pipeline.showQueue({ queueId: later }, operator()),
    ).toEqual({ kind: 'expired' });
  });

  it.each([
    ['in another mode', request(), 'policy_denied'],
    ['cancelled before', operator({ signal: AbortSignal.abort() }), 'network'],
    ['without a tenant', operator({ assignment: undefined }), 'auth'],
  ])('refuses to list or show %s', async (_name, given, code) => {
    const setupped = setup();
    const id = await queueNote(setupped);
    expect(await setupped.pipeline.listQueue(given)).toEqual({
      kind: 'failed',
      code,
    });
    expect(await setupped.pipeline.showQueue({ queueId: id }, given)).toEqual({
      kind: 'failed',
      code,
    });
  });

  it('refuses to show an ID that is no UUID', async () => {
    const { pipeline } = setup();
    for (const queueId of ['../x', 42, undefined]) {
      expect(await pipeline.showQueue({ queueId }, operator())).toEqual({
        kind: 'failed',
        code: 'validation',
      });
    }
  });

  it('finds nothing without a queue', async () => {
    const { pipeline } = setup({ queue: false });
    expect(await pipeline.listQueue(operator())).toEqual({ kind: 'off' });
    expect(
      await pipeline.showQueue(
        { queueId: '00000000-0000-4000-8000-0000000000ff' },
        operator(),
      ),
    ).toEqual({ kind: 'off' });
  });

  it('fails as internal when the queue cannot be read', async () => {
    const broken: ApprovalQueue = {
      ...createMemoryApprovalQueue(),
      list: () => Promise.reject(new Error('disk')),
      get: () => Promise.reject(new Error('disk')),
    };
    const { pipeline } = setup({ store: broken });
    expect(await pipeline.listQueue(operator())).toEqual({
      kind: 'failed',
      code: 'internal',
    });
    expect(
      await pipeline.showQueue(
        { queueId: '00000000-0000-4000-8000-0000000000ff' },
        operator(),
      ),
    ).toEqual({ kind: 'failed', code: 'internal' });
  });
});
