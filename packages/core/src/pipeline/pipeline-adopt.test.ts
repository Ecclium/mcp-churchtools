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
import { canonicalMarkdown, checkMarkdown } from '../content/index.js';
import { createFileKeyProvider } from '../keys/file-provider.js';
import { KeyMaterial } from '../keys/index.js';
import {
  checkCodeOf,
  markingLineOf,
  type MarkingOrigin,
} from '../marker/index.js';
import { defaultPolicy } from '../policy/check.js';
import { createToolCatalog } from '../registry/index.js';
import { createSnapshotKeeper } from '../snapshots/keeper.js';
import { appendSection, type WriteSnapshots } from '../write/guard.js';
import { contentHashOf } from '../write/plan-hash.js';
import {
  type AdoptCall,
  createToolPipeline,
  maxAdoptionWrites,
  type ToolRequest,
} from './pipeline.js';

// The entry adopt of the pipeline (ADR 0032): the section of a run whose
// key of the check codes was lost, proven by the snapshot of its write,
// shown, and signed anew for the operator through the write guard, with an
// audit line of the type adoption. ChurchTools is the double; the
// snapshots are sealed with day keys in memory. All data are made up.

const loaded = loadConfig({
  environment: {
    ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
    ECCLIUM_CHURCHTOOLS_TOKEN: makeCanary('token').value,
  },
  transport: 'stdio',
});
if (!loaded.ok) throw new Error('the configuration of the test is invalid');
const token = loaded.config.churchtoolsToken;

const now = Date.UTC(2026, 10, 12, 8, 0, 0);
const day = '2026-11-09' as IsoDate;
const clock = Object.freeze({ now: Object.freeze(() => now) });
const guid = '00000000-0000-4000-8000-0000000000ab';
const pagePath = `/api/wiki/categories/12/pages/${guid}`;
const written = '11111111-2222-4333-8444-555555555555';
const runId = '0b0e9a3c-3f7e-4c62-9a55-6a1f0d2c7e11';
const routine = 'dienstplan-report';
const period = '2026-W46';
const json = {
  headers: {
    'content-type': 'application/json',
    date: new Date(now).toUTCString(),
  },
};
const rights = JSON.stringify({
  data: { churchwiki: { 'edit category': [12] } },
});
const pageAnswer = (version: number, text: string, title = 'Dienstplan') =>
  JSON.stringify({
    data: {
      title,
      isMarkdown: true,
      version,
      text,
      wikiCategory: { id: 12 },
    },
  });

const lostKey = new KeyMaterial('0123456789abcdef'.repeat(4));
const key = new KeyMaterial('fedcba9876543210'.repeat(4));
const origin: MarkingOrigin = { kind: 'routine', routine, run: period };

// A name in the section that must never reach a log line or the audit.
const canary = makeCanary('name');

// A section as the run wrote it with the key that is lost now.
const sectionOf = (body: string, signWith = lostKey): string => {
  const checked = checkMarkdown(body, { contacts: new Set() });
  if (!checked.ok) throw new TypeError('The section does not pass.');
  const canonical = canonicalMarkdown(checked.text);
  if (canonical === undefined) throw new TypeError('No canonical form.');
  const code = checkCodeOf(signWith, 'default', origin, canonical);
  const line = markingLineOf({ date: day, origin, code }, 'Sekretariat');
  return `${checked.text}\n${line}`;
};

const head = '# Dienstplan\n\nWas die Routine findet.';
const report = sectionOf(`## Dienste KW 46\n\n- ${canary.value} fehlt\n`);
// The page as the run left it, at version 4.
const left = appendSection(head, report);

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

const call = (extra: Partial<AdoptCall> = {}): AdoptCall => ({
  run: { runId, routineId: routine },
  period,
  page: { categoryId: 12, guid, name: 'Dienstplan' },
  writeIds: [written],
  ...extra,
});

let dir: string;
const open: { close(): Promise<void> }[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ecclium-pipeline-adopt-'));
});

afterEach(async () => {
  rmSync(dir, { recursive: true, force: true });
  await Promise.all(open.splice(0).map((item) => item.close()));
});

const setup = (
  options: {
    readonly snapshots?: false | WriteSnapshots;
    readonly markerKey?: false;
  } = {},
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
    ...(options.markerKey === false ? {} : { markerKey: key }),
    ...(options.snapshots === false
      ? {}
      : { snapshots: options.snapshots ?? keeper }),
  });
  // The snapshot the write of the run kept: the page from version 3 to 4.
  const keep = (
    eventId = written,
    content: Partial<{ guid: string; categoryId: number }> = {},
  ) =>
    keeper.save(ctxOf, {
      eventId,
      part: 'before',
      day,
      content: {
        kind: 'wikiPageText',
        tool: 'ct_wiki_page_append_section',
        categoryId: content.categoryId ?? 12,
        guid: content.guid ?? guid,
        before: { version: 3, text: head },
        after: { version: 4, textHash: contentHashOf([left]) },
      },
    });
  // The reads of an adoption: the rights, then the page.
  const reads = (text = left, title = 'Dienstplan') => {
    double
      .intercept({ path: '/api/permissions/global', method: 'GET' })
      .reply(200, rights, json);
    double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(200, pageAnswer(4, text, title), json);
  };
  // The commit: the read right before, the write and the read after.
  const commits = (afterText: string, patch = 200) => {
    double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(200, pageAnswer(4, left), json);
    double
      .intercept({ path: pagePath, method: 'PATCH' })
      .reply(patch, '{}', json);
    double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(200, pageAnswer(patch === 200 ? 5 : 4, afterText), json);
  };
  const events = () =>
    auditLines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return {
    double,
    pipeline,
    keeper,
    keep,
    reads,
    commits,
    events,
    auditLines,
    logLines,
    file,
  };
};

// The text of the page with the new line of a preview.
const signedOf = (newLine: string): string =>
  [...left.split('\n').slice(0, -1), newLine].join('\n');

describe('the adoption of the pipeline (ADR 0032)', () => {
  it('shows a section its snapshot proves without writing, then signs it anew with the value it showed', async () => {
    const run = setup();
    await run.keep();
    run.reads();
    const preview = await run.pipeline.adopt(call(), request());
    expect(preview.kind).toBe('preview');
    if (preview.kind !== 'preview') throw new Error('no preview');
    expect(preview.shown.section).toContain('## Dienste KW 46');
    expect(preview.shown.check).toMatch(/^[0-9a-f]{16}$/);
    expect(preview.shown.oldLine).toBe(left.split('\n').at(-1));
    run.reads();
    run.commits(signedOf(preview.shown.newLine));
    const done = await run.pipeline.adopt(
      call({ confirm: preview.shown.check }),
      request(),
    );
    expect(done).toMatchObject({ kind: 'done', version: 5 });
    if (done.kind !== 'done') throw new Error('not done');
    const [shown, wrote] = run.events();
    expect(shown).toMatchObject({
      type: 'adoption',
      mode: 'operator',
      runId,
      routineId: routine,
      outcome: 'ok',
      writeState: 'planned',
      objectRefs: ['wiki_category:12', `wiki_page:${guid}`],
    });
    expect(shown).not.toHaveProperty('confirmation');
    expect(wrote).toMatchObject({
      type: 'adoption',
      outcome: 'ok',
      writeState: 'verified',
      confirmation: 'operator',
      eventId: done.undoId,
    });
    expect(wrote).not.toHaveProperty('tool');
    // The adoption kept the page it wrote over, so `ecclium undo` takes it
    // back.
    expect((await run.keeper.load(ctxOf, done.undoId as string)).kind).toBe(
      'found',
    );
    assertNoCanary(
      `${run.auditLines.join('\n')}\n${run.logLines.join('\n')}`,
      [canary],
      'log',
    );
    expect(
      run.logLines.filter((entry) => entry.includes('"adoption_call"')),
    ).toHaveLength(2);
  });

  it('writes nothing for a check value that does not fit the page now', async () => {
    const { pipeline, keep, reads, events } = setup();
    await keep();
    reads();
    expect(
      await pipeline.adopt(call({ confirm: '0123456789abcdef' }), request()),
    ).toMatchObject({ kind: 'mismatch' });
    expect(events()[0]).toMatchObject({
      outcome: 'denied',
      writeState: 'denied',
      errorCode: 'conflict',
    });
  });

  it('finds nothing to do for a code that fits, no line, a renamed page, two lines and a section it cannot sign', async () => {
    const cases: readonly {
      readonly text: string;
      readonly title?: string;
      readonly kind: string;
    }[] = [
      { text: appendSection(head, sectionOf('## KW 46\n', key)), kind: 'own' },
      { text: head, kind: 'none' },
      { text: left, title: 'Anders', kind: 'renamed' },
      { text: appendSection(left, report), kind: 'unclear' },
    ];
    for (const { text, title, kind } of cases) {
      const { pipeline, keep, reads, events } = setup();
      await keep();
      reads(text, title);
      expect(await pipeline.adopt(call(), request()), kind).toMatchObject({
        kind,
      });
      expect(events()[0], kind).toMatchObject(
        kind === 'own'
          ? { outcome: 'ok', writeState: 'skipped' }
          : {
              outcome: 'denied',
              errorCode: kind === 'none' ? 'not_found' : 'conflict',
            },
      );
    }
    // A section with a link a person put in, which the snapshot still
    // proves: it has no canonical form, so it is not signed.
    const linked = appendSection(
      head,
      `## KW 46\n\nMehr: [Plan](https://example.org/)\n\n${left.split('\n').at(-1) ?? ''}`,
    );
    const { pipeline, keeper, reads } = setup();
    await keeper.save(ctxOf, {
      eventId: written,
      part: 'before',
      day,
      content: {
        kind: 'wikiPageText',
        tool: 'ct_wiki_page_append_section',
        categoryId: 12,
        guid,
        before: { version: 3, text: head },
        after: { version: 4, textHash: contentHashOf([linked]) },
      },
    });
    reads(linked);
    expect(await pipeline.adopt(call(), request())).toMatchObject({
      kind: 'unsignable',
    });
  });

  it('counts only the snapshots of writes of the page it found, to tell none left from no proof', async () => {
    const otherPage = '11111111-2222-4333-8444-555555555556';
    const otherCategory = '11111111-2222-4333-8444-555555555557';
    const newPage = '11111111-2222-4333-8444-555555555558';
    const { pipeline, keeper, keep, reads } = setup();
    // A write of another page, one of another category, a new page, and
    // an ID without a snapshot.
    await keep(otherPage, { guid: '00000000-0000-4000-8000-0000000000ac' });
    await keep(otherCategory, { categoryId: 13 });
    await keeper.save(ctxOf, {
      eventId: newPage,
      part: 'before',
      day,
      content: {
        kind: 'wikiPageCreate',
        tool: 'ct_wiki_page_create',
        categoryId: 12,
        title: 'Dienstplan',
        textHash: contentHashOf([left]),
      },
    });
    await keeper.save(ctxOf, {
      eventId: newPage,
      part: 'after',
      day,
      content: { kind: 'wikiPageCreated', guid, version: 1 },
    });
    const writes = [otherPage, otherCategory, newPage, written];
    reads();
    expect(
      await pipeline.adopt(call({ writeIds: writes }), request()),
    ).toMatchObject({
      kind: 'unproven',
      snapshots: 0,
      range: left,
    });
    // The write of the page, whose snapshot does not fit a changed page.
    await keep();
    reads(left.replace('fehlt', 'gefunden'));
    expect(
      await pipeline.adopt(call({ writeIds: writes }), request()),
    ).toMatchObject({
      kind: 'unproven',
      snapshots: 1,
    });
  });

  it('signs nothing in another mode, for a call built wrong, without the audit file or snapshots, cancelled or without a tenant', async () => {
    const { pipeline, keep, events, file } = setup();
    await keep();
    expect(
      await pipeline.adopt(call(), request({ mode: 'interactive' })),
    ).toMatchObject({ kind: 'failed', code: 'policy_denied', sent: false });
    const wrong: readonly Partial<AdoptCall>[] = [
      { run: { runId: 'run-1', routineId: routine } },
      { run: { runId, routineId: 'Dienstplan Report' } },
      { period: 'W46' },
      { page: { categoryId: 0, guid, name: 'Dienstplan' } },
      { page: { categoryId: 1.5, guid, name: 'Dienstplan' } },
      { page: { categoryId: 12, guid: 'page-1', name: 'Dienstplan' } },
      { page: { categoryId: 12, guid: 12, name: 'Dienstplan' } },
      { page: { categoryId: 12, guid, name: ' ' } },
      { page: { categoryId: 12, guid, name: 7 } },
      { writeIds: 'all' as unknown as readonly unknown[] },
      { writeIds: ['NOT-AN-ID'] },
      {
        writeIds: Array.from({ length: maxAdoptionWrites + 1 }, () => written),
      },
      { confirm: 'ABCDEF0123456789' },
      { confirm: 42 },
    ];
    for (const extra of wrong) {
      expect(
        await pipeline.adopt(call(extra), request()),
        JSON.stringify(extra).slice(0, 80),
      ).toMatchObject({ kind: 'failed', code: 'validation' });
    }
    const aborted = new AbortController();
    aborted.abort();
    expect(
      await pipeline.adopt(call(), request({ signal: aborted.signal })),
    ).toMatchObject({ kind: 'failed', code: 'network' });
    expect(
      await pipeline.adopt(call(), request({ assignment: undefined })),
    ).toMatchObject({ kind: 'failed', code: 'auth' });
    file.ready = false;
    expect(await pipeline.adopt(call(), request())).toMatchObject({
      kind: 'failed',
      code: 'policy_denied',
      reason: 'auditNotReady',
    });
    // A run built wrong is named with the zero UUID, a valid one always.
    const lines = events();
    expect(lines[1]?.['runId']).toBe(auditPlaceholders.runId);
    expect(lines[1]).not.toHaveProperty('routineId');
    expect(lines[2]?.['runId']).toBe(auditPlaceholders.runId);
    expect(lines.at(-1)?.['runId']).toBe(runId);
    const off = setup({ snapshots: false });
    expect(await off.pipeline.adopt(call(), request())).toEqual({
      kind: 'off',
    });
  });

  it('names the reason of the write guard: a switch of the tenant but not of the routine, no key, a missing right, no Markdown', async () => {
    const routineOff = setup();
    await routineOff.keep();
    routineOff.reads();
    // Whoever stops a routine may still sign its section.
    writeFileSync(join(dir, `writes-off-routine-${routine}`), '');
    expect(await routineOff.pipeline.adopt(call(), request())).toMatchObject({
      kind: 'preview',
    });
    writeFileSync(join(dir, 'writes-off-default'), '');
    expect(await routineOff.pipeline.adopt(call(), request())).toMatchObject({
      kind: 'failed',
      code: 'policy_denied',
      reason: 'switchedOff',
      state: 'denied',
    });
    rmSync(join(dir, 'writes-off-default'));
    const noKey = setup({ markerKey: false });
    expect(await noKey.pipeline.adopt(call(), request())).toMatchObject({
      kind: 'failed',
      code: 'policy_denied',
      reason: 'noMarking',
    });
    const noRight = setup();
    noRight.double
      .intercept({ path: '/api/permissions/global', method: 'GET' })
      .reply(200, JSON.stringify({ data: { churchwiki: {} } }), json);
    expect(await noRight.pipeline.adopt(call(), request())).toMatchObject({
      kind: 'failed',
      code: 'permission',
      reason: 'missingRight',
    });
    const notMarkdown = setup();
    notMarkdown.double
      .intercept({ path: '/api/permissions/global', method: 'GET' })
      .reply(200, rights, json);
    notMarkdown.double.intercept({ path: pagePath, method: 'GET' }).reply(
      200,
      JSON.stringify({
        data: {
          title: 'Dienstplan',
          isMarkdown: false,
          version: 4,
          text: left,
          wikiCategory: { id: 12 },
        },
      }),
      json,
    );
    expect(await notMarkdown.pipeline.adopt(call(), request())).toMatchObject({
      kind: 'failed',
      code: 'policy_denied',
      reason: 'notMarkdown',
    });
  });

  it('stops every later write when the line of an adoption that wrote is not in the audit file', async () => {
    const { pipeline, keep, reads, commits, file } = setup();
    await keep();
    reads();
    const preview = await pipeline.adopt(call(), request());
    if (preview.kind !== 'preview') throw new Error('no preview');
    reads();
    commits(signedOf(preview.shown.newLine));
    file.ok = false;
    expect(
      await pipeline.adopt(call({ confirm: preview.shown.check }), request()),
    ).toMatchObject({ kind: 'done', unrecorded: true });
    file.ok = true;
    expect(await pipeline.adopt(call(), request())).toMatchObject({
      kind: 'failed',
      reason: 'blocked',
    });
    expect(file.anchors).toBe(1);
  });

  it('names a commit ChurchTools refused, a read that failed and a snapshot that does not open', async () => {
    const refused = setup();
    await refused.keep();
    refused.reads();
    const preview = await refused.pipeline.adopt(call(), request());
    if (preview.kind !== 'preview') throw new Error('no preview');
    refused.reads();
    refused.commits(left, 403);
    expect(
      await refused.pipeline.adopt(
        call({ confirm: preview.shown.check }),
        request(),
      ),
    ).toMatchObject({
      kind: 'failed',
      code: 'permission',
      reason: 'notSent',
      sent: false,
      shown: preview.shown,
    });
    // The page is gone when the commit reads it right before the write:
    // an error of ChurchTools, with no sentence of the write guard.
    const gone = setup();
    await gone.keep();
    gone.reads();
    const shownGone = await gone.pipeline.adopt(call(), request());
    if (shownGone.kind !== 'preview') throw new Error('no preview');
    gone.reads();
    gone.double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(404, '{}', json);
    const goneOutcome = await gone.pipeline.adopt(
      call({ confirm: shownGone.shown.check }),
      request(),
    );
    expect(goneOutcome).toMatchObject({ kind: 'failed', sent: false });
    expect(goneOutcome).not.toHaveProperty('reason');
    // ChurchTools fails on the read of the page.
    const failing = setup();
    failing.double
      .intercept({ path: '/api/permissions/global', method: 'GET' })
      .reply(200, rights, json);
    failing.double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(500, '{}', json);
    expect(await failing.pipeline.adopt(call(), request())).toMatchObject({
      kind: 'failed',
      code: 'upstream',
    });
    // A store whose record does not open.
    const broken = setup({
      snapshots: {
        save: () => Promise.resolve(),
        load: () => Promise.reject(new Error('damaged')),
      },
    });
    expect(await broken.pipeline.adopt(call(), request())).toMatchObject({
      kind: 'failed',
      code: 'internal',
    });
    // A call whose run throws when it is read.
    const hostile = {
      ...call(),
      get run(): AdoptCall['run'] {
        throw new Error('hostile');
      },
    };
    expect(await broken.pipeline.adopt(hostile, request())).toMatchObject({
      kind: 'failed',
      code: 'internal',
    });
  });
});
