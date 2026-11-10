import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type EccliumError,
  isEccliumError,
  type IsoDate,
  type Mode,
  type PlannedWrite,
  type TenantContext,
  type WikiPage,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  createMemoryQuotaStore,
  createTestClock,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { KeyMaterial } from '../keys/index.js';
import { checkPolicy } from '../policy/check.js';
import {
  createWriteGuard,
  type PlanRequest,
  replaceSection,
  type RunPlanRequest,
  type WriteClient,
  writeSentences,
} from './guard.js';
import { contentHashOf } from './plan-hash.js';
import { issueProof } from './proof.js';
import { createRunWrites } from './run-writes.js';
import { sealPlan } from './sealed-plan.js';

// The write guard for a write of a run of a routine (ADR 0032), where the
// pipeline cannot lead: a plan of a run offered to the commit of a tool,
// and a commit of a run for a plan, a mode, a tenant or an actor it does
// not fit. The pipeline tests the way of a run as a whole
// (pipeline-run-write.test.ts).

const now = Date.UTC(2026, 10, 10, 6, 0, 0);
const day = '2026-11-10' as IsoDate;
const guid = '00000000-0000-4000-8000-000000000001';
const routine = 'dienstplan-report';
const tool = 'ct_test_run_append';
const markerKey = new KeyMaterial('0123456789abcdef'.repeat(4));

const checked = checkPolicy({
  schema: 'policy.v1',
  interactive: { inquiriesTo: 'Sekretariat' },
  unattended: [
    {
      routine,
      credential: 'berichte',
      target: { kind: 'wiki_category', id: 12, name: 'Berichte' },
      tools: [tool],
      maxPerRun: 2,
      maxPerDay: 10,
    },
  ],
});
if (!checked.ok) throw new Error(checked.code);
const policy = checked.policy;

let dir: string;
let page: WikiPage;
let sent: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ecclium-guard-run-'));
  page = {
    guid,
    title: 'Dienstplan',
    isMarkdown: true,
    version: 3,
    text: '# Dienstplan',
  };
  sent = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const unused = (): Promise<never> =>
  Promise.reject(new Error('not used by a run'));

// One category with one page, in memory.
const client: WriteClient = {
  permissions: () =>
    Promise.resolve({
      kind: 'known',
      granted: { churchwiki: { 'edit category': [12] } },
    }),
  whoami: unused,
  writes: {
    wikiPageState: () => Promise.resolve({ page, serverTime: now }),
    wikiCategoryName: () => Promise.resolve('Berichte'),
    updateWikiPage: (_ctx, _category, _guid, text) => {
      sent.push(text);
      page = { ...page, text, version: page.version + 1 };
      return Promise.resolve();
    },
    wikiCategoryState: unused,
    createWikiPage: unused,
    appointmentState: unused,
    calendarDayState: unused,
    createAppointment: unused,
    updateAppointment: unused,
    deleteAppointment: unused,
    bookingState: unused,
    resourceDayState: unused,
    createBooking: unused,
    deleteBooking: unused,
    calendarFacts: unused,
    resourceName: unused,
  },
};

const contextOf = (
  change: Partial<{ tenantId: string; id: string; mode: Mode }> = {},
): TenantContext => {
  const log = (): undefined => undefined;
  return {
    tenantId: change.tenantId ?? 'demo-tenant',
    actor: { kind: 'runner', id: change.id ?? `runner:${routine}` },
    readOnly: false,
    mode: change.mode ?? 'unattended',
    log: { debug: log, info: log, warn: log, error: log },
  } as unknown as TenantContext;
};

const guardOf = () =>
  createWriteGuard({
    client,
    clock: createTestClock(now),
    killSwitchDir: dir,
    policy,
    quota: createMemoryQuotaStore(),
    markerKey,
  });

const runOf = (): RunPlanRequest => ({
  routine,
  period: '2026-W46',
  contacts: new Set(),
  needs: {
    rights: [{ module: 'churchwiki', right: 'edit category' }],
    editCategories: new Set([12]),
  },
  runWrites: createRunWrites(),
});

const requestOf = (change: Partial<PlanRequest> = {}): PlanRequest => ({
  ctx: contextOf(),
  tool,
  origin: 'core',
  meta: { sensitivity: 'personal', unattended: 'policy' },
  run: runOf(),
  ...change,
});

const append = {
  kind: 'wikiSectionAppend',
  categoryId: 12,
  guid,
  section: '## Woche 46\n\nAlles besetzt.',
  baseVersion: 3,
};

const planned = async (
  guard: ReturnType<typeof guardOf>,
  request: PlanRequest = requestOf(),
): Promise<PlannedWrite> => {
  const { outcome, queue } = await guard.plan(request, append);
  if (outcome.kind !== 'planned' || queue !== undefined) {
    throw new Error('expected a plan to commit');
  }
  return outcome.plan;
};

const refusalOf = async (promise: Promise<unknown>): Promise<EccliumError> => {
  try {
    await promise;
  } catch (error) {
    if (isEccliumError(error)) return error;
  }
  throw new Error('expected a refusal');
};

const target = { kind: 'wiki_page', key: `12/${guid}` };

describe('a plan of a run in the write guard', () => {
  it('commits on the way of a run with the proof of the policy', async () => {
    const guard = guardOf();
    const plan = await planned(guard);
    const result = await guard.commitForRun(
      contextOf(),
      plan,
      createRunWrites(),
      '00000000-0000-4000-8000-0000000000e1',
    );
    expect(result).toMatchObject({
      ok: true,
      state: 'verified',
      path: 'policy',
      target,
      version: 4,
    });
    expect(sent).toHaveLength(1);
  });

  it('never commits on the way of a tool, whatever proof comes with it', async () => {
    const guard = guardOf();
    const plan = await planned(guard);
    for (const path of ['policy', 'elicitation'] as const) {
      const result = await guard.commit(
        contextOf(),
        plan,
        issueProof(plan, path, now),
      );
      expect(result).toMatchObject({
        ok: false,
        state: 'denied',
        sent: false,
        target,
        error: { code: 'internal', message: writeSentences.notConfirmed },
      });
    }
    expect(sent).toHaveLength(0);
  });

  it('commits on the way of a run only a plan of a run, in the mode of a run, for its tenant and actor', async () => {
    const guard = guardOf();
    const plan = await planned(guard);
    // A plan of the same section without a run, as a tool plans it in a
    // conversation.
    const plain = await planned(guard, {
      ctx: contextOf({ mode: 'interactive' }),
      tool,
      origin: 'core',
      meta: { sensitivity: 'personal', unattended: 'policy' },
    });
    const wrong = [
      { ctx: contextOf(), value: plain },
      { ctx: contextOf(), value: { ...(plan as object) } },
      { ctx: contextOf(), value: undefined },
      { ctx: contextOf({ mode: 'interactive' }), value: plan },
      { ctx: contextOf({ tenantId: 'other-tenant' }), value: plan },
      { ctx: contextOf({ id: 'runner:wochen-report' }), value: plan },
    ];
    for (const { ctx, value } of wrong) {
      const result = await guard.commitForRun(ctx, value, createRunWrites());
      expect(result).toEqual({
        ok: false,
        state: 'denied',
        sent: false,
        error: expect.objectContaining({
          code: 'internal',
          message: writeSentences.notConfirmed,
        }) as unknown,
      });
    }
    expect(sent).toHaveLength(0);
  });

  it('issues no proof of the policy for a plan of a run that may never run unattended', async () => {
    const guard = guardOf();
    const ctx = contextOf();
    const plan = sealPlan({
      tenantId: ctx.tenantId,
      actor: ctx.actor,
      tool,
      origin: 'core',
      intent: append as never,
      toolMeta: { sensitivity: 'personal', unattended: 'never' },
      contentHash: contentHashOf(['x']),
      sealedAt: now,
      day,
      snapshots: false,
      run: { routine, period: '2026-W46', contacts: [] },
    });
    const result = await guard.commitForRun(ctx, plan, createRunWrites());
    expect(result).toMatchObject({
      ok: false,
      state: 'denied',
      sent: false,
      target,
      error: { code: 'policy_denied', message: writeSentences.notForRun },
    });
    expect(sent).toHaveLength(0);
  });

  it('plans for a run only a section of the wiki with a tool of the core that may run unattended, in the mode of a run', async () => {
    const guard = guardOf();
    const update = {
      kind: 'wikiPageUpdate',
      categoryId: 12,
      guid,
      text: '# Neu\n',
      baseVersion: 3,
    };
    const cases: readonly (readonly [PlanRequest, unknown])[] = [
      [requestOf(), update],
      [requestOf({ ctx: contextOf({ mode: 'interactive' }) }), append],
      [requestOf({ origin: 'plugin' }), append],
      [
        requestOf({ meta: { sensitivity: 'personal', unattended: 'never' } }),
        append,
      ],
    ];
    for (const [request, intent] of cases) {
      const error = await refusalOf(guard.plan(request, intent));
      expect({ code: error.code, message: error.message }).toEqual({
        code: 'policy_denied',
        message: writeSentences.notForRun,
      });
    }
    expect(sent).toHaveLength(0);
  });
});

// The text of a page whose own section of a run is replaced (ADR 0032):
// the old section may have begun with a heading right after a paragraph,
// and a new one that begins with a paragraph would run on from it.
describe('the text of a page whose own section is replaced', () => {
  it('sets an empty line between a paragraph before the section and the new section', () => {
    // Lines: 0 heading, 1 empty, 2 paragraph, 3 heading of the section,
    // 4 its text, 5 empty, 6 its line of the marking, 7 empty, 8 rest.
    const page = '# Plan\n\nNotiz\n## W46\nalt\n\nMarke\n\nRest';
    expect(replaceSection(page, { start: 3, end: 6 }, 'neu\n\nMarke 2')).toBe(
      '# Plan\n\nNotiz\n\nneu\n\nMarke 2\n\nRest',
    );
  });

  it('adds no line after an empty one, nor at the start of the page', () => {
    expect(
      replaceSection('# Plan\n\n## W46\nalt', { start: 2, end: 3 }, 'neu'),
    ).toBe('# Plan\n\nneu');
    // A line of spaces counts as empty.
    expect(
      replaceSection('# Plan\n  \n## W46\nalt', { start: 2, end: 3 }, 'neu'),
    ).toBe('# Plan\n  \nneu');
    expect(
      replaceSection('## W46\nalt\n\nRest', { start: 0, end: 1 }, 'neu\n'),
    ).toBe('neu\n\nRest');
  });
});
