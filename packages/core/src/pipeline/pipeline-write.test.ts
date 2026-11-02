import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '@ecclium/mcp-churchtools-core';
import {
  classify,
  defineWriteTool,
  EccliumError,
  type PlannedWrite,
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
import { createToolCatalog } from '../registry/index.js';
import { confirmationSentence } from '../write/confirm.js';
import { writeSentences } from '../write/guard.js';
import { issueProof } from '../write/proof.js';
import { createToolPipeline, type ToolRequest } from './pipeline.js';

// The step of the confirmation gives no proof until the ways of
// confirmation exist (ADR 0029). These tests replace it, call by call, to
// reach the commit with a proof they issue; without a replacement the real
// step runs.
const confirming = vi.hoisted(() => ({
  issue: undefined as ((plan: PlannedWrite) => unknown) | undefined,
}));
vi.mock('../write/confirm.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../write/confirm.js')>();
  return {
    ...original,
    confirmWrite: (ctx: never, plan: PlannedWrite) =>
      confirming.issue === undefined
        ? original.confirmWrite(ctx, plan)
        : Promise.resolve({ kind: 'proof', proof: confirming.issue(plan) }),
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
  confirming.issue = undefined;
});

afterEach(async () => {
  rmSync(dir, { recursive: true, force: true });
  await Promise.all(open.splice(0).map((item) => item.close()));
});

const setup = (
  options: {
    readonly tools?: readonly ToolDefinition[];
    readonly killSwitchDir?: string | null;
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

  it('commits with a proof, reads the change back and gives the fixed result', async () => {
    const { double, pipeline, events, file, logs, planReads } = setup();
    confirming.issue = (plan) => issueProof(plan, 'elicitation', now);
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
    const outcome = await pipeline.call(
      'ct_example_note_write',
      note,
      request(),
    );
    expect(outcome.ok && outcome.data).toMatchObject({
      state: 'verified',
      target: { kind: 'wiki_page', key: `12/${guid}` },
      version: 4,
    });
    expect(events()[0]).toMatchObject({
      outcome: 'ok',
      confirmation: 'elicitation',
      writeState: 'verified',
    });
    expect(file.anchors).toBe(1);
    expect(logs()).toContain('write_committed');
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
    confirming.issue = (plan) => issueProof(plan, 'elicitation', now);
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
    const outcome = await pipeline.call(
      'ct_test_create',
      { text: 'x' },
      request(),
    );
    expect(outcome.ok && outcome.data).toMatchObject({
      state: 'verified',
      target: { kind: 'wiki_page', key: `12/${created}` },
      version: 1,
    });
    expect(events()[0]).toMatchObject({
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
    const { double, pipeline, events, file, planReads } = setup();
    confirming.issue = (plan) => issueProof(plan, 'echo', now);
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
    const outcome = await pipeline.call(
      'ct_example_note_write',
      note,
      request(),
    );
    expect(!outcome.ok && outcome.error).toEqual({
      code: 'conflict',
      message: writeSentences.notAsPlanned,
    });
    expect(events()[0]).toMatchObject({
      outcome: 'error',
      errorCode: 'conflict',
      confirmation: 'echo',
      writeState: 'conflict',
    });
    expect(file.anchors).toBe(1);
  });

  it('gives the result of a write whose line failed, and then writes no more', async () => {
    const { double, pipeline, file, logs, planReads } = setup();
    confirming.issue = (plan) => issueProof(plan, 'elicitation', now);
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
    file.ok = false;
    const written = await pipeline.call(
      'ct_example_note_write',
      note,
      request(),
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

  it('commits nothing once the client cancelled the call', async () => {
    const { double, pipeline, planReads } = setup();
    const controller = new AbortController();
    confirming.issue = (plan) => {
      controller.abort();
      return issueProof(plan, 'elicitation', now);
    };
    planReads();
    const outcome = await pipeline.call(
      'ct_example_note_write',
      note,
      request({ signal: controller.signal }),
    );
    expect(!outcome.ok && outcome.error.code).toBe('network');
    assertOnlyReads(double);
  });
});
