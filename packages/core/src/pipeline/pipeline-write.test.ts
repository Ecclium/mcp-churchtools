import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '@ecclium/mcp-churchtools-core';
import {
  classify,
  defineWriteTool,
  EccliumError,
  type NonceStore,
  type PlanStore,
  type Plugin,
  type PluginHost,
  type TenantAssignment,
  type ToolDefinition,
  type WritePort,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  assertOnlyReads,
  createChurchToolsDouble,
  createMemoryQuotaStore,
  doubleOrigin,
  examplePlugin,
  makeCanary,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createAuditSink } from '../audit/index.js';
import type { WriteConfirmation } from '../config/index.js';
import { contentSentences } from '../content/index.js';
import { checkPolicy, defaultPolicy } from '../policy/check.js';
import { policyHashOf } from '../policy/hash.js';
import type { Policy } from '../policy/schema.js';
import { createToolCatalog } from '../registry/index.js';
import {
  confirmationSentence,
  confirmationSentences,
} from '../write/confirm.js';
import { type WriteSnapshots, writeSentences } from '../write/guard.js';
import { createMemoryNonceStore } from '../write/nonce-store.js';
import { createMemoryPlanStore } from '../write/plan-store.js';
import { policySentences } from '../write/policy-gate.js';
import {
  createToolPipeline,
  type ToolOutcome,
  type ToolPipeline,
  type ToolRequest,
} from './pipeline.js';

// Two answers of the write guard that its contract allows but no real
// plan gives: a sealed plan without its text, and a refused commit that
// names no target. Off unless a test turns them on.
const gaps = vi.hoisted(() => ({
  dropText: false,
  commitWithoutTarget: false,
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
          const result = await guard.plan(...args);
          return gaps.dropText
            ? { outcome: result.outcome, target: result.target }
            : result;
        },
        commit: (...args: Parameters<typeof guard.commit>) =>
          gaps.commitWithoutTarget
            ? Promise.resolve({
                ok: false,
                state: 'denied',
                error: new EccliumError('internal'),
                sent: false,
              } as const)
            : guard.commit(...args),
      });
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

const now = Date.UTC(2026, 10, 2, 8, 0, 0);
const clock = Object.freeze({ now: Object.freeze(() => now) });
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
const note = { categoryId: 12, guid, baseVersion: 3, note: 'Hallo' };

const assignment = {
  tenantId: 'default',
  actor: { kind: 'user', id: 'stdio:local-stdio' },
} as unknown as TenantAssignment;

const request = (extra: Partial<ToolRequest> = {}): ToolRequest => ({
  assignment,
  mode: 'interactive',
  redaction: 'standard',
  readOnly: false,
  features: [],
  signal: new AbortController().signal,
  ...extra,
});

const pluginOf = (...tools: ToolDefinition[]): Plugin => ({
  name: 'test-plugin',
  version: '1.0.0',
  register(host: PluginHost): undefined {
    for (const tool of tools) host.addTool(tool);
    return undefined;
  },
});

// A write tool of the test that plans an update and returns what the
// given function makes of the port and its outcome.
const customTool = (
  name: `ct_${string}`,
  run: (write: WritePort) => Promise<unknown>,
): ToolDefinition =>
  defineWriteTool({
    name,
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
    execute: ({ write }) => run(write) as never,
  });

const update = {
  kind: 'wikiPageUpdate',
  categoryId: 12,
  guid,
  text: '# Neu\n',
  baseVersion: 3,
} as const;

let dir: string;
const open: { close(): Promise<void> }[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ecclium-pipeline-write-'));
  gaps.dropText = false;
  gaps.commitWithoutTarget = false;
});

// A write confirmed by the person: the first round asks a client that
// declared elicitation, the second brings a yes (ADR 0029). The first
// round leaves the audit line `planned`, the second the line of the write.
const confirmed = async (
  pipeline: ToolPipeline,
  name: string,
  input: unknown,
  change: Partial<ToolRequest> = {},
): Promise<ToolOutcome> => {
  const asked = await pipeline.call(
    name,
    input,
    request({ elicitation: true, ...change }),
  );
  if (asked.ok || asked.question === undefined) return asked;
  return pipeline.call(
    name,
    input,
    request({
      answer: {
        state: asked.question.state,
        action: 'accept',
        content: { bestaetigen: true },
      },
      ...change,
    }),
  );
};

afterEach(async () => {
  rmSync(dir, { recursive: true, force: true });
  await Promise.all(open.splice(0).map((item) => item.close()));
});

const setup = (
  options: {
    readonly tools?: readonly ToolDefinition[];
    readonly killSwitchDir?: string | null;
    readonly policy?: Policy;
    readonly snapshots?: WriteSnapshots;
    readonly nonces?: NonceStore;
    readonly plans?: PlanStore;
    readonly confirmation?: WriteConfirmation;
    /** False for a pipeline without the stores of questions. */
    readonly stores?: false;
  } = {},
) => {
  const double = createChurchToolsDouble({ token });
  open.push(double);
  const catalog = createToolCatalog({
    core: examplePlugin,
    plugins: [pluginOf(...(options.tools ?? []))],
    readOnly: false,
    toolsets: new Set(['wiki', 'persons'] as const),
  });
  const auditLines: string[] = [];
  const logLines: string[] = [];
  const file = { ok: true, ready: true, anchors: 0 };
  const audit = createAuditSink({
    writer: { write: () => true },
    file: {
      write: (line: string) => {
        auditLines.push(line);
        return file.ok;
      },
      ready: () => file.ready,
      anchor: () => {
        file.anchors += 1;
      },
    },
    clock,
    isKnownTool: catalog.has,
  });
  const pipeline = createToolPipeline({
    policy: options.policy ?? defaultPolicy,
    catalog,
    audit,
    quota: createMemoryQuotaStore(),
    transport: double.transport,
    origin: doubleOrigin,
    requestsPerMinute: 300,
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
    ...(options.killSwitchDir === null
      ? {}
      : { killSwitchDir: options.killSwitchDir ?? dir }),
    ...(options.snapshots === undefined
      ? {}
      : { snapshots: options.snapshots }),
    ...(options.stores === false
      ? {}
      : {
          plans: options.plans ?? createMemoryPlanStore(clock),
          nonces: options.nonces ?? createMemoryNonceStore(clock),
        }),
    ...(options.confirmation === undefined
      ? {}
      : { confirmation: options.confirmation }),
  });
  const events = () =>
    auditLines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const logs = () =>
    logLines.map((line) => (JSON.parse(line) as { event: string }).event);
  // The reads of a plan of the example: the rights, then the page.
  const planReads = (version = 3, text = '# Plan\n') => {
    double
      .intercept({ path: '/api/permissions/global', method: 'GET' })
      .reply(200, rights, json);
    double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(200, page(version, text), json);
  };
  return { double, pipeline, events, logs, file, planReads };
};

describe('a write tool in the pipeline', () => {
  it('plans, finds no way to confirm, and writes nothing: a dry run', async () => {
    const { double, pipeline, events, file, planReads } = setup();
    planReads();
    const outcome = await pipeline.call(
      'ct_example_note_write',
      note,
      request(),
    );
    expect(outcome).toEqual({
      ok: false,
      error: { code: 'confirmation_required', message: confirmationSentence },
    });
    assertOnlyReads(double);
    expect(events()[0]).toMatchObject({
      tool: 'ct_example_note_write',
      outcome: 'denied',
      errorCode: 'confirmation_required',
      writeState: 'denied',
      objectRefs: ['wiki_category:12', `wiki_page:${guid}`],
    });
    expect(events()[0]).not.toHaveProperty('confirmation');
    expect(file.anchors).toBe(0);
  });

  it('commits after a yes, reads the change back and gives the fixed result', async () => {
    const { double, pipeline, events, file, logs, planReads } = setup();
    planReads();
    double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(200, page(3, '# Plan\n'), json);
    double
      .intercept({ path: pagePath, method: 'PATCH' })
      .reply(200, '{}', json);
    double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(200, page(4, '# Plan\n\nHallo\n'), json);
    const outcome = await confirmed(pipeline, 'ct_example_note_write', note);
    expect(outcome.ok && outcome.data).toMatchObject({
      state: 'verified',
      target: { kind: 'wiki_page', key: `12/${guid}` },
      version: 4,
    });
    expect(events()[0]).toMatchObject({ outcome: 'ok', writeState: 'planned' });
    expect(events()[1]).toMatchObject({
      outcome: 'ok',
      confirmation: 'elicitation',
      writeState: 'verified',
      policyHash: policyHashOf(defaultPolicy),
      objectRefs: ['wiki_category:12', `wiki_page:${guid}`],
    });
    expect(file.anchors).toBe(1);
    expect(logs()).toContain('write_committed');
  });

  it('keeps a snapshot under the ID of the audit event and gives that ID to undo the write', async () => {
    const saved: { eventId: string; part: string }[] = [];
    const { double, pipeline, events, planReads } = setup({
      snapshots: {
        save: (_ctx, snapshot) => {
          saved.push({ eventId: snapshot.eventId, part: snapshot.part });
          return Promise.resolve();
        },
        load: () => Promise.resolve({ kind: 'missing' }),
      },
    });
    planReads();
    double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(200, page(3, '# Plan\n'), json);
    double
      .intercept({ path: pagePath, method: 'PATCH' })
      .reply(200, '{}', json);
    double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(200, page(4, '# Plan\n\nHallo\n'), json);
    const outcome = await confirmed(pipeline, 'ct_example_note_write', note);
    // The snapshot names the line of the round that wrote.
    const eventId = events()[1]?.['eventId'];
    expect(saved).toEqual([{ eventId, part: 'before' }]);
    expect(outcome.ok && outcome.data).toMatchObject({
      state: 'verified',
      version: 4,
      undoId: eventId,
    });
  });

  it('creates a page and names the new page in the audit', async () => {
    const tool = customTool('ct_test_create', (write) =>
      write.plan({
        kind: 'wikiPageCreate',
        categoryId: 12,
        title: 'Bericht',
        text: '# Bericht\n',
      }),
    );
    const { double, pipeline, events } = setup({ tools: [tool] });
    const created = '00000000-0000-4000-8000-0000000000cd';
    const list = JSON.stringify({
      data: [],
      meta: {
        count: 0,
        pagination: { total: 0, limit: 25, current: 1, lastPage: 1 },
      },
    });
    double
      .intercept({ path: '/api/permissions/global', method: 'GET' })
      .reply(200, rights, json);
    // The list of the category is read when planning and right before
    // the write.
    for (let read = 0; read < 2; read += 1) {
      double
        .intercept({
          path: (path: string) => path.split('?')[0] === '/api/wiki/pages',
          method: 'GET',
        })
        .reply(200, list, json);
    }
    double
      .intercept({ path: '/api/wiki/categories/12/pages', method: 'POST' })
      .reply(
        201,
        JSON.stringify({
          data: {
            guid: created,
            title: 'Bericht',
            version: 1,
            isMarkdown: true,
          },
        }),
        json,
      );
    double
      .intercept({
        path: `/api/wiki/categories/12/pages/${created}`,
        method: 'GET',
      })
      .reply(
        200,
        JSON.stringify({
          data: {
            title: 'Bericht',
            isMarkdown: true,
            version: 1,
            text: '# Bericht\n',
          },
        }),
        json,
      );
    const outcome = await confirmed(pipeline, 'ct_test_create', { text: 'x' });
    expect(outcome.ok && outcome.data).toMatchObject({
      state: 'verified',
      target: { kind: 'wiki_page', key: `12/${created}` },
      version: 1,
    });
    expect(events()[0]).toMatchObject({
      writeState: 'planned',
      objectRefs: ['wiki_category:12'],
    });
    expect(events()[1]).toMatchObject({
      writeState: 'verified',
      objectRefs: ['wiki_category:12', `wiki_page:${created}`],
    });
  });

  it('skips a write that changes nothing, without asking for a confirmation', async () => {
    const tool = customTool('ct_test_same', (write) =>
      write.plan({ ...update, text: '# Plan\n' }),
    );
    const { pipeline, events, planReads } = setup({ tools: [tool] });
    planReads();
    const outcome = await pipeline.call(
      'ct_test_same',
      { text: 'x' },
      request(),
    );
    expect(outcome.ok && outcome.data).toMatchObject({
      state: 'skipped',
      target: { kind: 'wiki_page', key: `12/${guid}` },
    });
    expect(events()[0]).toMatchObject({ outcome: 'ok', writeState: 'skipped' });
  });

  it('reports a conflict after a write, with its anchor', async () => {
    const { double, pipeline, events, file, planReads } = setup({
      snapshots: {
        save: () => Promise.resolve(),
        load: () => Promise.resolve({ kind: 'missing' }),
      },
    });
    planReads();
    double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(200, page(3, '# Plan\n'), json);
    double
      .intercept({ path: pagePath, method: 'PATCH' })
      .reply(200, '{}', json);
    double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(200, page(5, '# Anders\n'), json);
    const outcome = await confirmed(pipeline, 'ct_example_note_write', note);
    expect(!outcome.ok && outcome.error).toEqual({
      code: 'conflict',
      message: writeSentences.notAsPlanned,
    });
    expect(events()[1]).toMatchObject({
      outcome: 'error',
      errorCode: 'conflict',
      confirmation: 'elicitation',
      writeState: 'conflict',
      objectRefs: ['wiki_category:12', `wiki_page:${guid}`],
    });
    expect(file.anchors).toBe(1);
  });

  it('gives the result of a write whose line failed, and then writes no more', async () => {
    const { double, pipeline, file, logs, planReads } = setup();
    planReads();
    double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(200, page(3, '# Plan\n'), json);
    double
      .intercept({ path: pagePath, method: 'PATCH' })
      .reply(200, '{}', json);
    double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(200, page(4, '# Plan\n\nHallo\n'), json);
    // The line of the second round, which writes, fails.
    const asked = await pipeline.call(
      'ct_example_note_write',
      note,
      request({ elicitation: true }),
    );
    if (asked.ok || asked.question === undefined) {
      throw new Error('no question');
    }
    file.ok = false;
    const written = await pipeline.call(
      'ct_example_note_write',
      note,
      request({
        answer: {
          state: asked.question.state,
          action: 'accept',
          content: { bestaetigen: true },
        },
      }),
    );
    expect(written.ok).toBe(true);
    expect(logs()).toContain('write_audit_failed');
    file.ok = true;
    const next = await pipeline.call('ct_example_note_write', note, request());
    expect(!next.ok && next.error.message).toBe(writeSentences.blocked);
  });

  it('runs no write tool without an audit file that can take its line', async () => {
    const { double, pipeline, file } = setup();
    file.ready = false;
    const outcome = await pipeline.call(
      'ct_example_note_write',
      note,
      request(),
    );
    expect(!outcome.ok && outcome.error.code).toBe('policy_denied');
    expect(double.calls()).toEqual([]);
  });

  it('refuses every write without a folder of kill switches, and with a switch', async () => {
    const none = setup({ killSwitchDir: null });
    const first = await none.pipeline.call(
      'ct_example_note_write',
      note,
      request(),
    );
    expect(!first.ok && first.error.message).toBe(writeSentences.switchUnknown);
    expect(none.events()[0]).toMatchObject({
      outcome: 'denied',
      writeState: 'denied',
    });
    writeFileSync(join(dir, 'writes-off'), '');
    const off = setup();
    const second = await off.pipeline.call(
      'ct_example_note_write',
      note,
      request(),
    );
    expect(!second.ok && second.error.message).toBe(writeSentences.switchedOff);
  });

  it('refuses a write of the Pro module, whatever its tool declares', async () => {
    const { pipeline, events } = setup();
    const outcome = await pipeline.call(
      'ct_example_member_add',
      { groupId: 7, personId: 1 },
      request(),
    );
    expect(!outcome.ok && outcome.error).toEqual({
      code: 'policy_denied',
      message: writeSentences.notRun,
    });
    expect(events()[0]).toMatchObject({ writeState: 'denied' });
  });

  it('refuses a write outside the policy before it asks for a confirmation', async () => {
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
    const { double, pipeline, events, logs, planReads } = setup({
      policy: checked.policy,
    });
    planReads();
    const outcome = await pipeline.call(
      'ct_example_note_write',
      note,
      request({ elicitation: true }),
    );
    expect(!outcome.ok && outcome.error).toEqual({
      code: 'policy_denied',
      message: policySentences.outside,
    });
    expect(events()[0]).toMatchObject({
      outcome: 'denied',
      writeState: 'denied',
      policyHash: policyHashOf(checked.policy),
    });
    expect(logs()).toContain('policy_no_entry');
    expect(double.calls().filter(({ method }) => method !== 'GET')).toEqual([]);
  });

  it('ends a refused plan with its error, also when the tool catches it', async () => {
    const tool = customTool('ct_test_catches', async (write) => {
      try {
        return await write.plan({ ...update, baseVersion: 2 });
      } catch {
        return { kind: 'skipped', reason: 'unchanged' };
      }
    });
    const { pipeline, events, planReads } = setup({ tools: [tool] });
    planReads();
    const outcome = await pipeline.call(
      'ct_test_catches',
      { text: 'x' },
      request(),
    );
    expect(!outcome.ok && outcome.error).toEqual({
      code: 'conflict',
      message: writeSentences.changedBefore,
    });
    expect(events()[0]).toMatchObject({
      outcome: 'error',
      writeState: 'conflict',
    });
  });

  it('ends a text the content policy refuses as denied, with its reasons in the audit', async () => {
    for (const catches of [false, true]) {
      const plan = (write: WritePort) =>
        write.plan({
          kind: 'wikiPageCreate',
          categoryId: 12,
          title: 'Bericht',
          text: 'Mehr unter example.org',
        });
      const tool = customTool('ct_test_content', async (write) => {
        if (!catches) return plan(write);
        try {
          return await plan(write);
        } catch {
          return { kind: 'skipped', reason: 'unchanged' };
        }
      });
      const { pipeline, events, logs } = setup({ tools: [tool] });
      const outcome = await pipeline.call(
        'ct_test_content',
        { text: 'x' },
        request(),
      );
      expect(!outcome.ok && outcome.error).toEqual({
        code: 'validation',
        message: contentSentences.webAddress,
      });
      expect(events()[0]).toMatchObject({
        outcome: 'denied',
        errorCode: 'validation',
        writeState: 'denied',
        contentViolations: ['webAddress'],
      });
      expect(logs()).toContain('content_web_address');
    }
  });

  it('ends a plan refused as invalid as failed', async () => {
    const tool = customTool('ct_test_invalid', (write) =>
      write.plan({ kind: 'wikiPageDelete' } as never),
    );
    const { pipeline, events } = setup({ tools: [tool] });
    const outcome = await pipeline.call(
      'ct_test_invalid',
      { text: 'x' },
      request(),
    );
    expect(!outcome.ok && outcome.error.code).toBe('validation');
    expect(events()[0]).toMatchObject({
      outcome: 'error',
      writeState: 'failed',
    });
  });

  it('refuses a result that is not the outcome of the plan of the call', async () => {
    const forged = customTool('ct_test_forged', () =>
      Promise.resolve({ kind: 'skipped', reason: 'unchanged' }),
    );
    const other = customTool('ct_test_other', async (write) => {
      await write.plan(update);
      return { kind: 'skipped', reason: 'unchanged' };
    });
    const { pipeline, events, logs, planReads } = setup({
      tools: [forged, other],
    });
    const first = await pipeline.call(
      'ct_test_forged',
      { text: 'x' },
      request(),
    );
    expect(!first.ok && first.error.code).toBe('internal');
    planReads();
    const second = await pipeline.call(
      'ct_test_other',
      { text: 'x' },
      request(),
    );
    expect(!second.ok && second.error.code).toBe('internal');
    expect(logs()).toContain('tool_output_invalid');
    expect(events()[0]).toMatchObject({ writeState: 'failed' });
  });

  it('gives a tool one plan per call, and none after the call', async () => {
    let kept: WritePort | undefined;
    const tool = customTool('ct_test_twice', async (write) => {
      kept = write;
      const outcome = await write.plan(update);
      await expect(write.plan(update)).rejects.toThrow(EccliumError);
      return outcome;
    });
    const { pipeline, planReads } = setup({ tools: [tool] });
    planReads();
    const outcome = await pipeline.call(
      'ct_test_twice',
      { text: 'x' },
      request(),
    );
    expect(!outcome.ok && outcome.error.code).toBe('confirmation_required');
    await expect(kept?.plan(update)).rejects.toThrow(EccliumError);
  });

  it('passes on the error of a tool that fails before it plans', async () => {
    const tool = customTool('ct_test_throws', () =>
      Promise.reject(new EccliumError('upstream')),
    );
    const { pipeline, events } = setup({ tools: [tool] });
    const outcome = await pipeline.call(
      'ct_test_throws',
      { text: 'x' },
      request(),
    );
    expect(!outcome.ok && outcome.error.code).toBe('upstream');
    expect(events()[0]).toMatchObject({ writeState: 'failed' });
  });

  it('commits nothing once the client cancelled the second round', async () => {
    const controller = new AbortController();
    const memory = createMemoryNonceStore(clock);
    // The client cancels while the answer is checked.
    const nonces: NonceStore = Object.freeze({
      consume: (...args: Parameters<NonceStore['consume']>) => {
        controller.abort();
        return memory.consume(...args);
      },
    });
    const { double, pipeline, planReads } = setup({ nonces });
    planReads();
    const outcome = await confirmed(pipeline, 'ct_example_note_write', note, {
      signal: controller.signal,
    });
    expect(!outcome.ok && outcome.error.code).toBe('network');
    assertOnlyReads(double);
  });

  it('asks nothing once the client cancelled the first round', async () => {
    const controller = new AbortController();
    const tool = customTool('ct_test_cancels', async (write) => {
      const outcome = await write.plan(update);
      controller.abort();
      return outcome;
    });
    const { double, pipeline, planReads } = setup({ tools: [tool] });
    planReads();
    const outcome = await pipeline.call(
      'ct_test_cancels',
      { text: 'x' },
      request({ elicitation: true, signal: controller.signal }),
    );
    expect(!outcome.ok && outcome.error.code).toBe('network');
    assertOnlyReads(double);
  });
});

describe('a question before a write', () => {
  // The answer of a client to a question, with the content it sends.
  const answerOf = (
    state: unknown,
    action: 'accept' | 'decline' | 'cancel' = 'accept',
    content: unknown = { bestaetigen: true },
  ): Partial<ToolRequest> => ({
    answer: { state, action, ...(action === 'accept' ? { content } : {}) },
  });

  const ask = async (pipeline: ToolPipeline, input: unknown = note) => {
    const asked = await pipeline.call(
      'ct_example_note_write',
      input,
      request({ elicitation: true }),
    );
    if (asked.ok || asked.question === undefined) {
      throw new Error('no question');
    }
    return asked.question;
  };

  // The reads and the one write of a commit of the note.
  const commitReads = (double: ReturnType<typeof setup>['double']) => {
    double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(200, page(3, '# Plan\n'), json);
    double
      .intercept({ path: pagePath, method: 'PATCH' })
      .reply(200, '{}', json);
    double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(200, page(4, '# Plan\n\nHallo\n'), json);
  };

  it('asks a client that declared elicitation, with summary and diff, and writes nothing yet', async () => {
    const { double, pipeline, events, file, planReads } = setup();
    planReads();
    const question = await ask(pipeline);
    expect(question.message).toContain(
      'An die Seite «Dienstplan» in der Kategorie 12 einen Abschnitt mit 2 Zeilen anhängen.',
    );
    expect(question.message).toContain('+Hallo');
    expect(question.form.required).toEqual(['bestaetigen']);
    expect(question.state).toMatchObject({
      v: 1,
      tool: 'ct_example_note_write',
    });
    assertOnlyReads(double);
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({
      outcome: 'ok',
      writeState: 'planned',
      objectRefs: ['wiki_category:12', `wiki_page:${guid}`],
    });
    expect(events()[0]).not.toHaveProperty('errorCode');
    expect(events()[0]).not.toHaveProperty('confirmation');
    expect(file.anchors).toBe(0);
  });

  it.each([
    ['with the setting queue', { confirmation: 'queue' as const }],
    ['without the stores of questions', { stores: false as const }],
  ])('asks nothing %s, and writes nothing', async (_name, options) => {
    const { double, pipeline, events, planReads } = setup(options);
    planReads();
    const outcome = await pipeline.call(
      'ct_example_note_write',
      note,
      request({ elicitation: true }),
    );
    expect(outcome).toEqual({
      ok: false,
      error: { code: 'confirmation_required', message: confirmationSentence },
    });
    assertOnlyReads(double);
    expect(events()[0]).toMatchObject({ writeState: 'denied' });
  });

  it('asks nothing about a diff too long for a dialog', async () => {
    const long = Array.from(
      { length: 121 },
      (_, index) => `Zeile ${String(index)}`,
    )
      .join('\n')
      .concat('\n');
    const tool = customTool('ct_test_long', (write) =>
      write.plan({ ...update, text: long }),
    );
    const { double, pipeline, planReads } = setup({ tools: [tool] });
    planReads();
    const outcome = await pipeline.call(
      'ct_test_long',
      { text: 'x' },
      request({ elicitation: true }),
    );
    expect(!outcome.ok && outcome.error.code).toBe('confirmation_required');
    assertOnlyReads(double);
  });

  it.each([
    ['a decline', answerOf(undefined, 'decline')],
    ['a cancel', answerOf(undefined, 'cancel')],
    ['a no', answerOf(undefined, 'accept', { bestaetigen: false })],
  ])('writes nothing after %s, and refuses the call', async (_name, given) => {
    const { double, pipeline, events, file, planReads } = setup();
    planReads();
    const question = await ask(pipeline);
    const answer = { ...given.answer, state: question.state } as NonNullable<
      ToolRequest['answer']
    >;
    const outcome = await pipeline.call(
      'ct_example_note_write',
      note,
      request({ answer }),
    );
    expect(outcome).toEqual({
      ok: false,
      error: {
        code: 'confirmation_required',
        message: confirmationSentences.notConfirmed,
      },
    });
    assertOnlyReads(double);
    expect(events()[1]).toMatchObject({
      outcome: 'denied',
      errorCode: 'confirmation_required',
      writeState: 'denied',
      objectRefs: ['wiki_category:12', `wiki_page:${guid}`],
    });
    expect(file.anchors).toBe(0);
  });

  it('runs no tool in the second round', async () => {
    let runs = 0;
    const tool = customTool('ct_test_counts', (write) => {
      runs += 1;
      return write.plan(update);
    });
    const { double, pipeline, planReads } = setup({ tools: [tool] });
    planReads();
    const outcome = await confirmed(pipeline, 'ct_test_counts', { text: 'x' });
    // The commit reads the page right before writing and fails here
    // without a reply; what counts is that the tool ran once.
    expect(outcome.ok).toBe(false);
    expect(runs).toBe(1);
    expect(double.calls().filter(({ method }) => method !== 'GET')).toEqual([]);
  });

  it('refuses an answer for another input, and the right one still writes', async () => {
    const { double, pipeline, planReads } = setup();
    planReads();
    const question = await ask(pipeline);
    const other = await pipeline.call(
      'ct_example_note_write',
      { ...note, note: 'Anders' },
      request(answerOf(question.state)),
    );
    expect(other).toEqual({
      ok: false,
      error: {
        code: 'confirmation_required',
        message: confirmationSentences.notThisCall,
      },
    });
    commitReads(double);
    const right = await pipeline.call(
      'ct_example_note_write',
      note,
      request(answerOf(question.state)),
    );
    expect(right.ok && right.data).toMatchObject({
      state: 'verified',
    });
  });

  it('writes once for an answer that comes twice', async () => {
    const { double, pipeline, planReads } = setup();
    planReads();
    const question = await ask(pipeline);
    commitReads(double);
    const first = await pipeline.call(
      'ct_example_note_write',
      note,
      request(answerOf(question.state)),
    );
    expect(first.ok).toBe(true);
    const again = await pipeline.call(
      'ct_example_note_write',
      note,
      request(answerOf(question.state)),
    );
    expect(again).toEqual({
      ok: false,
      error: {
        code: 'confirmation_required',
        message: confirmationSentences.used,
      },
    });
    expect(
      double.calls().filter(({ method }) => method === 'PATCH'),
    ).toHaveLength(1);
  });

  it('finds no plan in a second instance with stores of its own', async () => {
    const first = setup();
    first.planReads();
    const question = await ask(first.pipeline);
    const second = setup();
    const outcome = await second.pipeline.call(
      'ct_example_note_write',
      note,
      request(answerOf(question.state)),
    );
    expect(outcome).toEqual({
      ok: false,
      error: {
        code: 'confirmation_required',
        message: confirmationSentences.gone,
      },
    });
    expect(second.double.calls()).toEqual([]);
  });

  it('refuses an answer to a tool that only reads, without running it', async () => {
    const { double, pipeline, events } = setup();
    const outcome = await pipeline.call(
      'ct_example_echo',
      { notes: ['a'] },
      request(answerOf({ v: 1 })),
    );
    expect(!outcome.ok && outcome.error.code).toBe('validation');
    expect(double.calls()).toEqual([]);
    expect(events()[0]).not.toHaveProperty('writeState');
  });

  it('refuses an answer in a pipeline without the stores of questions', async () => {
    const { double, pipeline } = setup({ stores: false });
    const outcome = await pipeline.call(
      'ct_example_note_write',
      note,
      request(answerOf({ v: 1 })),
    );
    expect(outcome).toEqual({
      ok: false,
      error: { code: 'confirmation_required', message: confirmationSentence },
    });
    expect(double.calls()).toEqual([]);
  });

  it('refuses a question while too many plans wait', async () => {
    const { double, pipeline, events, planReads } = setup({
      plans: createMemoryPlanStore(clock, 1),
    });
    planReads();
    await ask(pipeline);
    planReads();
    const outcome = await pipeline.call(
      'ct_example_note_write',
      { ...note, note: 'Noch einmal' },
      request({ elicitation: true }),
    );
    expect(outcome).toEqual({
      ok: false,
      error: {
        code: 'policy_denied',
        message: confirmationSentences.tooMany,
      },
    });
    expect(events()[1]).toMatchObject({
      outcome: 'denied',
      writeState: 'denied',
    });
    assertOnlyReads(double);
  });

  it('takes a sealed plan without its text as a fault of the core', async () => {
    gaps.dropText = true;
    const { double, pipeline, planReads } = setup();
    planReads();
    const outcome = await pipeline.call(
      'ct_example_note_write',
      note,
      request({ elicitation: true }),
    );
    expect(!outcome.ok && outcome.error.code).toBe('internal');
    assertOnlyReads(double);
  });

  it('names the target of the input when a refused commit names none', async () => {
    const { pipeline, events, planReads } = setup();
    planReads();
    const question = await ask(pipeline);
    gaps.commitWithoutTarget = true;
    const outcome = await pipeline.call(
      'ct_example_note_write',
      note,
      request(answerOf(question.state)),
    );
    expect(!outcome.ok && outcome.error.code).toBe('internal');
    expect(events()[1]).toMatchObject({
      writeState: 'denied',
      objectRefs: ['wiki_category:12', `wiki_page:${guid}`],
    });
  });
});
