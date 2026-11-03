import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '@ecclium/mcp-churchtools-core';
import type {
  IsoDate,
  TenantAssignment,
  TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  assertNoCanary,
  createChurchToolsDouble,
  createMemoryDayKeys,
  createMemoryQuotaStore,
  createMemorySnapshotStore,
  doubleOrigin,
  examplePlugin,
  makeCanary,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auditPlaceholders, createAuditSink } from '../audit/index.js';
import { createFileKeyProvider } from '../keys/file-provider.js';
import { defaultPolicy } from '../policy/check.js';
import { createToolCatalog } from '../registry/index.js';
import { createSnapshotKeeper } from '../snapshots/keeper.js';
import { contentHashOf } from '../write/plan-hash.js';
import type { WriteSnapshots } from '../write/guard.js';
import { createToolPipeline, type ToolRequest } from './pipeline.js';

// The entry undo of the pipeline (ADR 0031): a snapshot kept by a write,
// taken back for the operator through the write guard, with an audit
// line of the type undo. ChurchTools is the double; the snapshots are
// sealed with day keys in memory.

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
const clock = Object.freeze({ now: Object.freeze(() => now) });
const guid = '00000000-0000-4000-8000-0000000000ab';
const pagePath = `/api/wiki/categories/12/pages/${guid}`;
const written = '11111111-2222-4333-8444-555555555555';
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

// Texts of the page that must never reach a log line or the audit.
const canaries = [makeCanary('name'), makeCanary('email')] as const;
const before = `# Plan ${canaries[0].value}\n`;
const after = `# Neu ${canaries[1].value}\n`;

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
  mode: 'operator',
  redaction: 'standard',
  readOnly: false,
  features: [],
  signal: new AbortController().signal,
  ...extra,
});

let dir: string;
const open: { close(): Promise<void> }[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ecclium-pipeline-undo-'));
});

afterEach(async () => {
  rmSync(dir, { recursive: true, force: true });
  await Promise.all(open.splice(0).map((item) => item.close()));
});

const setup = (
  options: { readonly snapshots?: false | WriteSnapshots } = {},
) => {
  const double = createChurchToolsDouble({ token });
  open.push(double);
  const catalog = createToolCatalog({
    core: examplePlugin,
    plugins: [],
    readOnly: false,
    toolsets: new Set(['wiki'] as const),
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
  const keeper = createSnapshotKeeper({
    keys: createFileKeyProvider({ dayKeys: createMemoryDayKeys() }),
    store: createMemorySnapshotStore(),
  });
  const pipeline = createToolPipeline({
    policy: defaultPolicy,
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
    killSwitchDir: dir,
    ...(options.snapshots === false
      ? {}
      : { snapshots: options.snapshots ?? keeper }),
  });
  // The snapshot a write of the page from version 3 to 4 kept.
  const keep = () =>
    keeper.save(ctxOf, {
      eventId: written,
      part: 'before',
      day,
      content: {
        kind: 'wikiPageText',
        tool: 'ct_example_note_write',
        categoryId: 12,
        guid,
        before: { version: 3, text: before },
        after: { version: 4, textHash: contentHashOf([after]) },
      },
    });
  // The snapshot of a write that created the page, with or without its
  // GUID.
  const keepCreate = async (withGuid: boolean) => {
    await keeper.save(ctxOf, {
      eventId: written,
      part: 'before',
      day,
      content: {
        kind: 'wikiPageCreate',
        tool: 'ct_example_note_write',
        categoryId: 12,
        title: 'Dienstplan',
        textHash: contentHashOf([after]),
      },
    });
    if (withGuid) {
      await keeper.save(ctxOf, {
        eventId: written,
        part: 'after',
        day,
        content: { kind: 'wikiPageCreated', guid, version: 1 },
      });
    }
  };
  // The reads of an undo: the rights, then the page.
  const reads = (version = 4, text = after) => {
    double
      .intercept({ path: '/api/permissions/global', method: 'GET' })
      .reply(200, rights, json);
    double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(200, page(version, text), json);
  };
  const events = () =>
    auditLines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return {
    double,
    pipeline,
    keeper,
    keep,
    keepCreate,
    reads,
    events,
    auditLines,
    logLines,
    file,
  };
};

describe('the undo of the pipeline (ADR 0031)', () => {
  it('takes a write back for the operator, with an audit line of its own and no text in log or audit', async () => {
    const {
      double,
      pipeline,
      keeper,
      keep,
      reads,
      events,
      auditLines,
      logLines,
    } = setup();
    await keep();
    reads();
    // The commit reads again, writes, and reads after.
    double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(200, page(4, after), json);
    double
      .intercept({ path: pagePath, method: 'PATCH' })
      .reply(200, '{}', json);
    double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(200, page(5, before), json);
    const outcome = await pipeline.undo(
      { eventId: written, overwrite: false },
      request(),
    );
    expect(outcome).toMatchObject({ kind: 'done', version: 5 });
    if (outcome.kind !== 'done') throw new Error('not done');
    expect(outcome.undoId).toMatch(/^[0-9a-f-]{36}$/);
    expect(outcome.undoId).not.toBe(written);
    const [line] = events();
    expect(line).toMatchObject({
      type: 'undo',
      mode: 'operator',
      outcome: 'ok',
      undoes: written,
      confirmation: 'operator',
      writeState: 'verified',
      objectRefs: ['wiki_category:12', `wiki_page:${guid}`],
      eventId: outcome.undoId,
    });
    expect(line).not.toHaveProperty('tool');
    // The undo kept the state it wrote over, so it can be taken back too.
    expect((await keeper.load(ctxOf, outcome.undoId as string)).kind).toBe(
      'found',
    );
    for (const text of [auditLines.join('\n'), logLines.join('\n')]) {
      assertNoCanary(text, canaries, 'log');
    }
    expect(logLines.some((entry) => entry.includes('"undo_call"'))).toBe(true);
  });

  it('shows the change and writes nothing over a page changed since', async () => {
    const { pipeline, keep, reads, events } = setup();
    await keep();
    reads(5, '# Von Hand\n');
    const outcome = await pipeline.undo(
      { eventId: written, overwrite: false },
      request(),
    );
    expect(outcome.kind).toBe('changed');
    expect(events()).toMatchObject([
      {
        type: 'undo',
        outcome: 'error',
        writeState: 'conflict',
        errorCode: 'conflict',
        undoes: written,
      },
    ]);
  });

  it('says nothing is left to do when the page holds the text from before', async () => {
    const { pipeline, keep, reads, events } = setup();
    await keep();
    reads(5, before);
    expect(
      await pipeline.undo({ eventId: written, overwrite: false }, request()),
    ).toEqual({ kind: 'unchanged' });
    expect(events()).toMatchObject([
      { type: 'undo', outcome: 'ok', writeState: 'skipped' },
    ]);
  });

  it('finds no snapshot under an unknown ID, and none when the server keeps none', async () => {
    const kept = setup();
    expect(
      await kept.pipeline.undo(
        { eventId: written, overwrite: false },
        request(),
      ),
    ).toEqual({ kind: 'missing' });
    const off = setup({ snapshots: false });
    expect(
      await off.pipeline.undo(
        { eventId: written, overwrite: false },
        request(),
      ),
    ).toEqual({ kind: 'off' });
    expect(off.events()).toMatchObject([
      { type: 'undo', outcome: 'denied', writeState: 'denied' },
    ]);
  });

  it('takes nothing back in another mode than the operator, for an ID that is none, or without the audit file', async () => {
    const { pipeline, keep, events, file } = setup();
    await keep();
    expect(
      await pipeline.undo(
        { eventId: written, overwrite: false },
        request({ mode: 'interactive' }),
      ),
    ).toMatchObject({ kind: 'failed', code: 'policy_denied', sent: false });
    expect(
      await pipeline.undo(
        { eventId: 'NOT-AN-ID', overwrite: false },
        request(),
      ),
    ).toMatchObject({ kind: 'failed', code: 'validation' });
    file.ready = false;
    expect(
      await pipeline.undo({ eventId: written, overwrite: false }, request()),
    ).toMatchObject({
      kind: 'failed',
      code: 'policy_denied',
      reason: 'auditNotReady',
    });
    const lines = events();
    expect(lines.map((line) => line['undoes'])).toEqual([
      written,
      auditPlaceholders.eventId,
      written,
    ]);
  });

  it('names the reason of the write guard, such as a kill switch', async () => {
    const { pipeline, keep } = setup();
    await keep();
    writeFileSync(join(dir, 'writes-off'), '');
    expect(
      await pipeline.undo({ eventId: written, overwrite: false }, request()),
    ).toMatchObject({
      kind: 'failed',
      code: 'policy_denied',
      reason: 'switchedOff',
      state: 'denied',
    });
  });

  it('stops every later write when the line of an undo that wrote is not in the audit file', async () => {
    const { double, pipeline, keep, reads, file } = setup();
    await keep();
    reads();
    double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(200, page(4, after), json);
    double
      .intercept({ path: pagePath, method: 'PATCH' })
      .reply(200, '{}', json);
    double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(200, page(5, before), json);
    file.ok = false;
    // The undo wrote, but the audit does not show it, which it says.
    expect(
      await pipeline.undo({ eventId: written, overwrite: false }, request()),
    ).toMatchObject({ kind: 'done', unrecorded: true });
    file.ok = true;
    expect(
      await pipeline.undo({ eventId: written, overwrite: false }, request()),
    ).toMatchObject({ kind: 'failed', reason: 'blocked' });
    expect(file.anchors).toBe(1);
  });

  it('withdraws a new page, and names only its category without its GUID', async () => {
    const created = setup();
    await created.keepCreate(true);
    created.reads(1, after);
    created.double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(200, page(1, after), json);
    created.double
      .intercept({ path: pagePath, method: 'PATCH' })
      .reply(200, '{}', json);
    const note =
      'Diese Seite hat Ecclium am 03.11.2026 angelegt und am 03.11.2026 zurückgenommen.\n';
    created.double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(200, page(2, note), json);
    expect(
      await created.pipeline.undo(
        { eventId: written, overwrite: false },
        request(),
      ),
    ).toMatchObject({ kind: 'done', version: 2 });
    const incomplete = setup();
    await incomplete.keepCreate(false);
    expect(
      await incomplete.pipeline.undo(
        { eventId: written, overwrite: false },
        request(),
      ),
    ).toEqual({ kind: 'incomplete', categoryId: 12 });
    expect(incomplete.events()).toMatchObject([
      {
        type: 'undo',
        writeState: 'failed',
        errorCode: 'not_found',
        objectRefs: ['wiki_category:12'],
      },
    ]);
  });

  it('names the reason of a commit that the write guard refused, and none for an error of ChurchTools', async () => {
    const late = setup();
    await late.keep();
    late.reads();
    // ChurchTools answers with a time ten minutes off.
    late.double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(200, page(4, after), {
        headers: {
          'content-type': 'application/json',
          date: new Date(now + 600_000).toUTCString(),
        },
      });
    expect(
      await late.pipeline.undo(
        { eventId: written, overwrite: false },
        request(),
      ),
    ).toMatchObject({
      kind: 'failed',
      code: 'policy_denied',
      reason: 'clock',
      state: 'denied',
      sent: false,
    });
    const gone = setup();
    await gone.keep();
    gone.reads();
    gone.double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(404, '{}', json);
    const outcome = await gone.pipeline.undo(
      { eventId: written, overwrite: false },
      request(),
    );
    expect(outcome).toMatchObject({ kind: 'failed', sent: false });
    expect(outcome).not.toHaveProperty('reason');
  });

  it('takes nothing back for a request cancelled before, without a tenant, or with one that does not fit', async () => {
    const { pipeline, keep, events } = setup();
    await keep();
    const controller = new AbortController();
    controller.abort();
    expect(
      await pipeline.undo(
        { eventId: written, overwrite: false },
        request({ signal: controller.signal }),
      ),
    ).toMatchObject({ kind: 'failed', code: 'network' });
    expect(
      await pipeline.undo(
        { eventId: written, overwrite: false },
        request({ assignment: undefined }),
      ),
    ).toMatchObject({ kind: 'failed', code: 'auth' });
    expect(
      await pipeline.undo(
        { eventId: written, overwrite: false },
        request({
          assignment: {
            tenantId: 'Not A Tenant',
            actor: { kind: 'user', id: 'stdio:local-stdio' },
          } as unknown as TenantAssignment,
        }),
      ),
    ).toMatchObject({ kind: 'failed', code: 'internal' });
    expect(events()[1]).toMatchObject({
      tenantId: auditPlaceholders.tenantId,
      undoes: written,
    });
  });

  it('keeps the code of a write ChurchTools refused, and logs an undo whose snapshot does not open', async () => {
    const refused = setup();
    await refused.keep();
    refused.reads();
    refused.double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(200, page(4, after), json);
    refused.double
      .intercept({ path: pagePath, method: 'PATCH' })
      .reply(403, '{}', json);
    refused.double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(200, page(4, after), json);
    expect(
      await refused.pipeline.undo(
        { eventId: written, overwrite: false },
        request(),
      ),
    ).toMatchObject({
      kind: 'failed',
      code: 'permission',
      reason: 'notSent',
      sent: false,
    });
    // A store whose record does not open.
    const broken = setup({
      snapshots: {
        save: () => Promise.resolve(),
        load: () => Promise.reject(new Error('damaged')),
      },
    });
    expect(
      await broken.pipeline.undo(
        { eventId: written, overwrite: false },
        request(),
      ),
    ).toMatchObject({ kind: 'failed', code: 'internal' });
    expect(broken.logLines.some((entry) => entry.includes('"undo_call"'))).toBe(
      true,
    );
  });
});
