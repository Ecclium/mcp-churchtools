import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EccliumError,
  isEccliumError,
  type Mode,
  type Permissions,
  type PlannedWrite,
  type QuotaStore,
  type TenantContext,
  type WikiPage,
  writeQuotaKey,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  createMemoryQuotaStore,
  createTestClock,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { contentSentences } from '../content/index.js';
import { HttpTransportError } from '../http/index.js';
import { checkPolicy, defaultPolicy } from '../policy/check.js';
import type { Policy } from '../policy/schema.js';
import { isoDateOf } from '../quota/budget.js';
import {
  appendSection,
  createWriteGuard,
  type PlanRequest,
  type PlanResult,
  type WriteClient,
  type WriteSnapshots,
  writeSentences,
} from './guard.js';
import { ContentRefusal } from './content-gate.js';
import { policySentences } from './policy-gate.js';
import { issueProof } from './proof.js';
import { readPlan } from './sealed-plan.js';
import type { SnapshotToSeal } from '../snapshots/seal.js';
import { contentHashOf } from './plan-hash.js';

const guid = '00000000-0000-4000-8000-0000000000AB';
const now = Date.UTC(2026, 11, 1, 8, 0, 0);

interface Logged {
  readonly level: string;
  readonly event: string;
  readonly code?: unknown;
}

const contextOf = (
  logged: Logged[],
  change: Partial<{
    tenantId: string;
    readOnly: boolean;
    id: string;
    mode: Mode;
  }> = {},
): TenantContext => {
  const log =
    (level: string) => (event: string, fields?: { code?: unknown }) => {
      logged.push({
        level,
        event,
        ...(fields?.code === undefined ? {} : { code: fields.code }),
      });
    };
  return {
    tenantId: change.tenantId ?? 'demo-tenant',
    actor: { kind: 'service', id: change.id ?? 'stdio:local-stdio' },
    readOnly: change.readOnly ?? false,
    mode: change.mode ?? 'interactive',
    log: {
      debug: log('debug'),
      info: log('info'),
      warn: log('warn'),
      error: log('error'),
    },
  } as unknown as TenantContext;
};

/** A ChurchTools of one category with one page, in memory. */
interface Fake {
  page: WikiPage;
  permissions: Permissions;
  time: number | null;
  readonly sent: string[];
  // What the next write does instead of writing.
  updateFails?: Error;
  updateWrites?: boolean;
  createFails?: Error;
  created?: {
    guid: string;
    title: string;
    version: number;
    isMarkdown: boolean;
  };
  createdText?: string;
  readFails?: Error;
  readFailsAfterWrite?: Error;
  onRead?: () => void;
  /** The name of the category, for the policy; undefined when unknown. */
  categoryName?: string;
  /** What the read of the name of the category fails with instead. */
  categoryNameFails?: Error;
}

const fakeOf = (): Fake => ({
  page: {
    guid,
    title: 'Dienstplan',
    isMarkdown: true,
    version: 3,
    text: '# Plan\n',
  },
  permissions: {
    kind: 'known',
    granted: { churchwiki: { 'edit category': [12] } },
  },
  time: now,
  sent: [],
});

const clientOf = (fake: Fake): WriteClient => ({
  permissions: () => Promise.resolve(fake.permissions),
  writes: {
    wikiCategoryState: () => Promise.resolve({ serverTime: fake.time }),
    wikiCategoryName: () =>
      fake.categoryNameFails === undefined
        ? Promise.resolve(fake.categoryName)
        : Promise.reject(fake.categoryNameFails),
    wikiPageState: (_ctx, _category, target) => {
      fake.onRead?.();
      if (fake.readFails !== undefined) return Promise.reject(fake.readFails);
      if (fake.readFailsAfterWrite !== undefined && fake.sent.length > 0) {
        return Promise.reject(fake.readFailsAfterWrite);
      }
      if (target !== fake.page.guid && fake.created !== undefined) {
        return Promise.resolve({
          page: {
            guid: target,
            title: fake.created.title,
            isMarkdown: true,
            version: 1,
            text: fake.createdText ?? '',
          },
          serverTime: fake.time,
        });
      }
      return Promise.resolve({ page: fake.page, serverTime: fake.time });
    },
    updateWikiPage: (_ctx, _category, _guid, text) => {
      fake.sent.push(text);
      if (fake.updateWrites !== false) {
        fake.page = { ...fake.page, text, version: fake.page.version + 1 };
      }
      return fake.updateFails === undefined
        ? Promise.resolve()
        : Promise.reject(fake.updateFails);
    },
    createWikiPage: (_ctx, _category, title, text) => {
      fake.sent.push(text);
      if (fake.createFails !== undefined)
        return Promise.reject(fake.createFails);
      fake.createdText ??= text;
      fake.created ??= {
        guid: '00000000-0000-4000-8000-0000000000CD',
        title,
        version: 1,
        isMarkdown: true,
      };
      return Promise.resolve(fake.created);
    },
  },
});

const meta = { sensitivity: 'personal', unattended: 'policy' } as const;
const update = {
  kind: 'wikiPageUpdate',
  categoryId: 12,
  guid,
  text: '# Neu\n',
  baseVersion: 3,
};
const append = {
  kind: 'wikiSectionAppend',
  categoryId: 12,
  guid,
  section: '## Nachtrag',
  baseVersion: 3,
};
const create = {
  kind: 'wikiPageCreate',
  categoryId: 12,
  title: 'Bericht',
  text: '# Bericht\n',
};

let dir: string;
let logged: Logged[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ecclium-guard-'));
  logged = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const setup = (
  fake = fakeOf(),
  killSwitchDir: string | null = dir,
  limits: {
    policy?: Policy;
    quota?: QuotaStore | null;
    snapshots?: WriteSnapshots;
  } = {},
) => {
  const clock = createTestClock(now);
  const quota =
    limits.quota === null
      ? undefined
      : (limits.quota ?? createMemoryQuotaStore());
  const guard = createWriteGuard({
    client: clientOf(fake),
    clock,
    killSwitchDir: killSwitchDir ?? undefined,
    policy: limits.policy ?? defaultPolicy,
    quota,
    snapshots: limits.snapshots,
  });
  const ctx = contextOf(logged);
  const request: PlanRequest = {
    ctx,
    tool: 'ct_example_note_write',
    origin: 'core',
    meta,
  };
  return { fake, clock, guard, ctx, request, quota };
};

const refusalOf = async (promise: Promise<unknown>): Promise<EccliumError> => {
  try {
    await promise;
  } catch (error) {
    if (isEccliumError(error)) return error;
  }
  throw new Error('expected a refusal');
};

const planOf = ({ outcome }: PlanResult): PlannedWrite => {
  if (outcome.kind !== 'planned') throw new Error('expected a plan');
  return outcome.plan;
};

describe('appending a section', () => {
  it.each([
    ['# Plan\n', '## Nachtrag', '# Plan\n\n## Nachtrag\n'],
    ['# Plan  \n\n', '## Nachtrag \n', '# Plan\n\n## Nachtrag\n'],
    ['', '## Nachtrag', '## Nachtrag\n'],
    ['   ', '## Nachtrag', '## Nachtrag\n'],
  ])('joins %j and %j', (text, section, expected) => {
    expect(appendSection(text, section)).toBe(expected);
  });
});

describe('planning', () => {
  it('seals a change of a page on the version the tool read', async () => {
    const { guard, request } = setup();
    const view = readPlan(planOf(await guard.plan(request, update)));
    expect(view).toMatchObject({
      tool: 'ct_example_note_write',
      baseVersion: 3,
      rules: { target: { kind: 'wiki_page', key: `12/${guid.toLowerCase()}` } },
    });
  });

  it('seals a new page and a section, which reads the page for its text', async () => {
    const { guard, request } = setup();
    expect((await guard.plan(request, create)).outcome.kind).toBe('planned');
    expect((await guard.plan(request, append)).outcome.kind).toBe('planned');
  });

  it('skips a change that leaves the page as it is', async () => {
    const { guard, request } = setup();
    expect(await guard.plan(request, { ...update, text: '# Plan\n' })).toEqual({
      outcome: { kind: 'skipped', reason: 'unchanged' },
      target: { kind: 'wiki_page', key: `12/${guid.toLowerCase()}` },
    });
  });

  it.each([
    ['the server only reads', { readOnly: true }, writeSentences.readOnly],
  ])('refuses when %s', async (_name, change, sentence) => {
    const { guard } = setup();
    const ctx = contextOf(logged, change);
    const error = await refusalOf(
      guard.plan({ ctx, tool: 'ct_x', origin: 'core', meta }, update),
    );
    expect([error.code, error.message]).toEqual(['policy_denied', sentence]);
  });

  it('refuses while a kill switch is there, and without a folder to look in', async () => {
    writeFileSync(join(dir, 'writes-off-demo-tenant'), '');
    const { guard, request } = setup();
    expect((await refusalOf(guard.plan(request, update))).message).toBe(
      writeSentences.switchedOff,
    );
    const none = setup(fakeOf(), null);
    expect(
      (await refusalOf(none.guard.plan(none.request, update))).message,
    ).toBe(writeSentences.switchUnknown);
    expect(
      logged.filter((line) => line.event === 'write_refused'),
    ).toHaveLength(2);
  });

  it('refuses every plan after a block, until the process ends', async () => {
    const { guard, request } = setup();
    guard.block();
    expect((await refusalOf(guard.plan(request, update))).message).toBe(
      writeSentences.blocked,
    );
  });

  it.each([
    [
      'an intent that does not fit',
      { ...update, baseVersion: -1 },
      'validation',
      writeSentences.intent,
    ],
    [
      'a write of the Pro module',
      { kind: 'groupMemberAdd', groupId: 7, personId: 1 },
      'policy_denied',
      writeSentences.notRun,
    ],
    [
      'an appointment',
      {
        kind: 'appointmentCreate',
        calendarId: 4,
        title: 'P',
        startDate: 'a',
        endDate: 'b',
      },
      'policy_denied',
      writeSentences.notRun,
    ],
    [
      'a new page of spaces',
      { ...create, text: '  \n' },
      'validation',
      writeSentences.blank,
    ],
    [
      'a text of spaces',
      { ...update, text: ' ' },
      'validation',
      writeSentences.blank,
    ],
    [
      'a section of spaces',
      { ...append, section: '\n' },
      'validation',
      writeSentences.blank,
    ],
    [
      'a page of another version',
      { ...update, baseVersion: 2 },
      'conflict',
      writeSentences.changedBefore,
    ],
  ])('refuses %s', async (_name, intent, code, sentence) => {
    const { guard, request } = setup();
    const error = await refusalOf(guard.plan(request, intent));
    expect([error.code, error.message]).toEqual([code, sentence]);
  });

  it('refuses a page that is no Markdown page', async () => {
    const fake = fakeOf();
    fake.page = { ...fake.page, isMarkdown: false };
    const { guard, request } = setup(fake);
    expect((await refusalOf(guard.plan(request, update))).message).toBe(
      writeSentences.notMarkdown,
    );
  });

  it('names the missing right, and takes the right for all categories', async () => {
    const fake = fakeOf();
    fake.permissions = {
      kind: 'known',
      granted: { churchwiki: { 'edit category': [13] } },
    };
    const { guard, request } = setup(fake);
    const error = await refusalOf(guard.plan(request, update));
    expect([error.code, error.missingRights]).toEqual([
      'permission',
      [{ module: 'churchwiki', right: 'edit category' }],
    ]);
    fake.permissions = { kind: 'known', granted: {} };
    expect((await refusalOf(guard.plan(request, update))).code).toBe(
      'permission',
    );
    fake.permissions = {
      kind: 'known',
      granted: { churchwiki: { 'edit category': true } },
    };
    expect((await guard.plan(request, update)).outcome.kind).toBe('planned');
  });

  it('turns any other error of a read into internal', async () => {
    const { request } = setup();
    const failing = createWriteGuard({
      client: {
        ...clientOf(fakeOf()),
        permissions: () => Promise.reject(new Error('socket')),
      },
      clock: createTestClock(now),
      killSwitchDir: dir,
      policy: defaultPolicy,
      quota: undefined,
    });
    expect((await refusalOf(failing.plan(request, update))).code).toBe(
      'internal',
    );
  });

  it('does not write when it cannot read the rights', async () => {
    const fake = fakeOf();
    fake.permissions = { kind: 'unknown' };
    const { guard, request } = setup(fake);
    expect((await refusalOf(guard.plan(request, update))).message).toBe(
      writeSentences.rightsUnknown,
    );
  });

  it('never writes while it plans', async () => {
    const { fake, guard, request } = setup();
    await guard.plan(request, update);
    await guard.plan(request, create);
    await guard.plan(request, append);
    expect(fake.sent).toEqual([]);
  });
});

describe('the content policy in planning', () => {
  it('refuses a text before any read and names every reason', async () => {
    const parts = setup();
    let reads = 0;
    const counting = {
      ...parts.fake,
    };
    const guard = createWriteGuard({
      client: {
        ...clientOf(counting),
        permissions: () => {
          reads += 1;
          return Promise.resolve(counting.permissions);
        },
      },
      clock: parts.clock,
      killSwitchDir: dir,
      policy: defaultPolicy,
      quota: parts.quota,
    });
    const refused = await guard
      .plan(parts.request, {
        ...create,
        title: 'Bericht [Klick](javascript:x)',
        text: 'Mehr unter example.org ![x](https://example.org/p.png)',
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(refused).toBeInstanceOf(ContentRefusal);
    const refusal = refused as ContentRefusal;
    expect(refusal.violations).toEqual(['image', 'unsupported']);
    expect(refusal.error.code).toBe('validation');
    expect(refusal.error.message).toBe(
      `${contentSentences.image} ${contentSentences.unsupported}`,
    );
    expect(reads).toBe(0);
    expect(logged.map((line) => line.event)).toEqual([
      'content_image',
      'content_unsupported',
    ]);
  });

  it('seals and writes the texts in their written form', async () => {
    const parts = setup();
    const plan = planOf(
      await parts.guard.plan(parts.request, {
        ...append,
        section: '## Nachtrag\n\n* Probe',
      }),
    );
    const proof = issueProof(plan, 'elicitation', now);
    expect((await parts.guard.commit(parts.ctx, plan, proof)).ok).toBe(true);
    expect(parts.fake.sent).toEqual(['# Plan\n\n## Nachtrag\n\n- Probe\n']);
  });

  it('lets the contact values of the policy stand', async () => {
    const policy = checkPolicy({
      schema: 'policy.v1',
      interactive: { contacts: ['sekretariat@example.org'] },
    });
    if (!policy.ok) throw new Error(policy.code);
    const parts = setup(fakeOf(), dir, { policy: policy.policy });
    const section = 'Fragen an sekretariat@example.org';
    expect(
      (await parts.guard.plan(parts.request, { ...append, section })).outcome
        .kind,
    ).toBe('planned');
    const other = setup();
    await expect(
      other.guard.plan(other.request, { ...append, section }),
    ).rejects.toBeInstanceOf(ContentRefusal);
  });
});

describe('committing', () => {
  const planned = async (intent: unknown, fake = fakeOf()) => {
    const parts = setup(fake);
    const plan = planOf(await parts.guard.plan(parts.request, intent));
    const proof = issueProof(plan, 'elicitation', now);
    return { ...parts, plan, proof };
  };

  it('changes a page and reads the change back', async () => {
    const { fake, guard, ctx, plan, proof } = await planned(update);
    expect(await guard.commit(ctx, plan, proof)).toEqual({
      ok: true,
      state: 'verified',
      path: 'elicitation',
      target: { kind: 'wiki_page', key: `12/${guid.toLowerCase()}` },
      version: 4,
    });
    expect(fake.sent).toEqual(['# Neu\n']);
    expect(logged.map((line) => line.event)).toContain('write_committed');
  });

  it('appends a section to the text the page has', async () => {
    const { fake, guard, ctx, plan, proof } = await planned(append);
    expect((await guard.commit(ctx, plan, proof)).ok).toBe(true);
    expect(fake.sent).toEqual(['# Plan\n\n## Nachtrag\n']);
  });

  it('creates a page and names it as the target', async () => {
    const { guard, ctx, plan, proof } = await planned(create);
    expect(await guard.commit(ctx, plan, proof)).toMatchObject({
      ok: true,
      target: {
        kind: 'wiki_page',
        key: '12/00000000-0000-4000-8000-0000000000cd',
      },
      version: 1,
    });
  });

  it('commits nothing without a proof, and uses a proof only once', async () => {
    const { fake, guard, ctx, plan, proof } = await planned(update);
    const without = await guard.commit(ctx, plan, undefined);
    expect(without).toMatchObject({ ok: false, state: 'denied', sent: false });
    expect(!without.ok && without.error.code).toBe('confirmation_required');
    // Refused for the clock after the proof was used.
    fake.time = null;
    const late = await guard.commit(ctx, plan, proof);
    expect(!late.ok && late.error.message).toBe(writeSentences.clock);
    fake.time = now;
    const twice = await guard.commit(ctx, plan, proof);
    expect(!twice.ok && twice.error.code).toBe('confirmation_required');
    expect(fake.sent).toEqual([]);
  });

  it('ends a repeated commit after a write in a conflict, without writing again', async () => {
    const { fake, guard, ctx, plan, proof } = await planned(update);
    expect((await guard.commit(ctx, plan, proof)).ok).toBe(true);
    const again = await guard.commit(
      ctx,
      plan,
      issueProof(plan, 'elicitation', now),
    );
    expect(!again.ok && again.error.message).toBe(
      writeSentences.changedSincePlan,
    );
    expect(fake.sent).toHaveLength(1);
  });

  it('commits no value that is no plan and no plan of another tenant or actor', async () => {
    const { guard, plan, proof } = await planned(update);
    for (const ctx of [
      contextOf(logged, { tenantId: 'other-tenant' }),
      contextOf(logged, { id: 'stdio:other' }),
    ]) {
      const result = await guard.commit(ctx, plan, proof);
      expect(!result.ok && result.error.code).toBe('internal');
    }
    const lookalike = await guard.commit(contextOf(logged), {}, proof);
    expect(!lookalike.ok && lookalike.state).toBe('denied');
  });

  it('commits nothing once a kill switch is there or writing is blocked', async () => {
    const first = await planned(update);
    writeFileSync(join(dir, 'writes-off'), '');
    const off = await first.guard.commit(first.ctx, first.plan, first.proof);
    expect(!off.ok && off.error.message).toBe(writeSentences.switchedOff);
    rmSync(join(dir, 'writes-off'));
    first.guard.block();
    const blocked = await first.guard.commit(
      first.ctx,
      first.plan,
      first.proof,
    );
    expect(!blocked.ok && blocked.error.message).toBe(writeSentences.blocked);
    expect(first.fake.sent).toEqual([]);
  });

  it('writes nothing when the page changed after the plan, and uses the proof up', async () => {
    const { fake, guard, ctx, plan, proof } = await planned(update);
    fake.page = { ...fake.page, version: 4 };
    const result = await guard.commit(ctx, plan, proof);
    expect(result).toMatchObject({ ok: false, state: 'denied', sent: false });
    expect(!result.ok && result.error.message).toBe(
      writeSentences.changedSincePlan,
    );
    fake.page = { ...fake.page, version: 3 };
    const again = await guard.commit(ctx, plan, proof);
    expect(!again.ok && again.error.code).toBe('confirmation_required');
    expect(fake.sent).toEqual([]);
  });

  it('writes nothing when the text of the page changed under the same version', async () => {
    const { fake, guard, ctx, plan, proof } = await planned(append);
    fake.page = { ...fake.page, text: '# Anders\n' };
    const result = await guard.commit(ctx, plan, proof);
    expect(!result.ok && result.error.message).toBe(
      writeSentences.changedSincePlan,
    );
    expect(logged.map((line) => line.event)).toContain('write_conflict');
    expect(fake.sent).toEqual([]);
  });

  it('passes on a failed read right before the write', async () => {
    const { fake, guard, ctx, plan, proof } = await planned(update);
    fake.readFails = new EccliumError('upstream');
    const result = await guard.commit(ctx, plan, proof);
    expect(!result.ok && [result.state, result.error.code]).toEqual([
      'denied',
      'upstream',
    ]);
    fake.readFails = new Error('not a core error');
    const other = await guard.commit(
      ctx,
      plan,
      issueProof(plan, 'elicitation', now),
    );
    expect(!other.ok && other.error.code).toBe('internal');
  });

  it.each([
    ['five minutes and a second off', now + 301_000],
    ['without a time of ChurchTools', null],
  ])('writes nothing with a clock %s', async (_name, time) => {
    const { fake, guard, ctx, plan, proof } = await planned(update);
    fake.time = time;
    const result = await guard.commit(ctx, plan, proof);
    expect(!result.ok && result.error.message).toBe(writeSentences.clock);
    expect(fake.sent).toEqual([]);
  });

  it('knows that nothing left when the transport refused the target', async () => {
    const { fake, guard, ctx, plan, proof } = await planned(update);
    fake.updateFails = new HttpTransportError('refused');
    fake.updateWrites = false;
    expect(await guard.commit(ctx, plan, proof)).toMatchObject({
      ok: false,
      state: 'failed',
      sent: false,
      error: { message: writeSentences.notSent },
    });
  });

  it('reads after a failure and finds the change written', async () => {
    const { fake, guard, ctx, plan, proof } = await planned(update);
    fake.updateFails = new HttpTransportError('timeout');
    expect((await guard.commit(ctx, plan, proof)).ok).toBe(true);
  });

  it('reads after a lost answer, finds nothing yet and leaves the outcome open', async () => {
    const { fake, guard, ctx, plan, proof } = await planned(update);
    fake.updateFails = new HttpTransportError('interrupted');
    fake.updateWrites = false;
    expect(await guard.commit(ctx, plan, proof)).toMatchObject({
      state: 'failed',
      sent: true,
      error: { code: 'network', message: writeSentences.unknown },
    });
  });

  it('knows that nothing changed when ChurchTools refused the write', async () => {
    const { fake, guard, ctx, plan, proof } = await planned(update);
    fake.updateFails = new EccliumError('permission');
    fake.updateWrites = false;
    expect(await guard.commit(ctx, plan, proof)).toMatchObject({
      state: 'failed',
      sent: false,
      error: { code: 'permission', message: writeSentences.notSent },
    });
  });

  it('writes nothing when writing was switched off during the read before', async () => {
    const { fake, guard, ctx, plan, proof } = await planned(update);
    fake.onRead = () => {
      writeFileSync(join(dir, 'writes-off'), '');
    };
    const result = await guard.commit(ctx, plan, proof);
    expect(!result.ok && result.error.message).toBe(writeSentences.switchedOff);
    expect(fake.sent).toEqual([]);
  });

  it('leaves the outcome unknown when the read after a failure fails too', async () => {
    const { fake, guard, ctx, plan, proof } = await planned(update);
    fake.updateFails = new HttpTransportError('timeout');
    fake.updateWrites = false;
    // The read right before the write succeeds; the read after fails.
    fake.readFailsAfterWrite = new EccliumError('network');
    const result = await guard.commit(ctx, plan, proof);
    expect(result).toMatchObject({ state: 'failed', sent: true });
    expect(!result.ok && result.error.message).toBe(writeSentences.unknown);
    expect(logged.map((line) => line.event)).toContain('write_outcome_unknown');
  });

  it('leaves the outcome unknown when only the read after the write fails', async () => {
    const { fake, guard, ctx, plan, proof } = await planned(update);
    fake.readFailsAfterWrite = new EccliumError('upstream');
    const result = await guard.commit(ctx, plan, proof);
    expect(result).toMatchObject({ state: 'failed', sent: true });
    expect(!result.ok && [result.error.code, result.error.message]).toEqual([
      'upstream',
      writeSentences.unknown,
    ]);
  });

  it('reports a conflict when the page does not read back as planned', async () => {
    const { fake, guard, ctx, plan, proof } = await planned(update);
    fake.updateWrites = false;
    expect(await guard.commit(ctx, plan, proof)).toMatchObject({
      state: 'conflict',
      sent: true,
      error: { code: 'conflict', message: writeSentences.notAsPlanned },
    });
  });

  it.each([
    [
      'refused by the transport',
      new HttpTransportError('refused'),
      false,
      writeSentences.notSent,
    ],
    [
      'refused by ChurchTools',
      new EccliumError('conflict', 'A page with this title may exist.'),
      false,
      'A page with this title may exist.',
    ],
    [
      'lost on the way',
      new HttpTransportError('timeout'),
      true,
      writeSentences.unknown,
    ],
    ['broken in another way', new Error('x'), true, writeSentences.unknown],
  ])('reports a new page %s', async (_name, failure, sent, sentence) => {
    const fake = fakeOf();
    const { guard, ctx, plan, proof } = await planned(create, fake);
    fake.createFails = failure;
    const result = await guard.commit(ctx, plan, proof);
    expect(result).toMatchObject({ ok: false, state: 'failed', sent });
    expect(!result.ok && result.error.message).toBe(sentence);
  });

  it('reports a conflict for a new page that came back otherwise', async () => {
    for (const created of [
      {
        guid: '00000000-0000-4000-8000-0000000000CD',
        title: 'Anders',
        version: 1,
        isMarkdown: true,
      },
      {
        guid: '00000000-0000-4000-8000-0000000000CD',
        title: 'Bericht',
        version: 2,
        isMarkdown: true,
      },
      {
        guid: '00000000-0000-4000-8000-0000000000CD',
        title: 'Bericht',
        version: 1,
        isMarkdown: false,
      },
    ]) {
      const fake = fakeOf();
      fake.created = created;
      const { guard, ctx, plan, proof } = await planned(create, fake);
      expect(await guard.commit(ctx, plan, proof)).toMatchObject({
        state: 'conflict',
        sent: true,
      });
    }
    const fake = fakeOf();
    fake.createdText = '# Anders\n';
    const other = await planned(create, fake);
    expect(
      await other.guard.commit(other.ctx, other.plan, other.proof),
    ).toMatchObject({
      state: 'conflict',
    });
  });

  it('leaves the outcome of a new page unknown when it cannot read it back', async () => {
    const fake = fakeOf();
    const { guard, ctx, plan, proof } = await planned(create, fake);
    fake.readFailsAfterWrite = new EccliumError('network');
    expect(await guard.commit(ctx, plan, proof)).toMatchObject({
      state: 'failed',
      sent: true,
    });
  });

  it('is frozen', () => {
    expect(Object.isFrozen(setup().guard)).toBe(true);
    expect(Object.isFrozen(writeSentences)).toBe(true);
  });
});

describe('the policy (ADR 0032)', () => {
  const tool = 'ct_example_note_write';
  const policyOf = (target: unknown): Policy => {
    const result = checkPolicy({
      schema: 'policy.v1',
      interactive: { targets: [{ target, tools: [tool], maxPerDay: 1 }] },
    });
    if (!result.ok) throw new Error(result.code);
    return result.policy;
  };
  const categoryPolicy = policyOf({
    kind: 'wiki_category',
    id: 12,
    name: 'Berichte',
  });
  const pagePolicy = policyOf({
    kind: 'wiki_page',
    categoryId: 12,
    guid: guid.toLowerCase(),
    name: 'Dienstplan',
  });
  const pageKey = writeQuotaKey(tool, `wiki_page:12/${guid.toLowerCase()}`);
  const today = () => {
    const day = isoDateOf(now);
    if (day === undefined) throw new Error('expected a day');
    return day;
  };

  it('plans a new page only in a category with the name it expects', async () => {
    const fake = fakeOf();
    fake.categoryName = 'Berichte';
    const { guard, request } = setup(fake, dir, { policy: categoryPolicy });
    expect((await guard.plan(request, create)).outcome.kind).toBe('planned');
    fake.categoryName = 'Protokolle';
    expect(await refusalOf(guard.plan(request, create))).toMatchObject({
      code: 'policy_denied',
      message: policySentences.nameChanged,
    });
    expect(logged.map(({ event }) => event)).toEqual(['policy_name_changed']);
  });

  it('refuses a plan outside the policy before it seals anything', async () => {
    const { guard, request } = setup(fakeOf(), dir, {
      policy: policyOf({ kind: 'wiki_category', id: 13, name: 'Andere' }),
    });
    expect(await refusalOf(guard.plan(request, update))).toMatchObject({
      code: 'policy_denied',
      message: policySentences.outside,
    });
  });

  it('counts a write when it commits, not when it plans', async () => {
    const { fake, guard, ctx, request, quota } = setup(fakeOf(), dir, {
      policy: pagePolicy,
    });
    const plan = planOf(await guard.plan(request, update));
    expect(await quota?.read(ctx, pageKey, today())).toBe(0);
    const proof = issueProof(plan, 'elicitation', now);
    expect((await guard.commit(ctx, plan, proof)).ok).toBe(true);
    expect(await quota?.read(ctx, pageKey, today())).toBe(1);
    expect(fake.sent).toEqual(['# Neu\n']);
  });

  it('writes nothing once the limit is reached after the plan, and uses the proof up', async () => {
    const { fake, guard, ctx, request, quota } = setup(fakeOf(), dir, {
      policy: pagePolicy,
    });
    const plan = planOf(await guard.plan(request, update));
    // Another write of the same tool took the place of the day meanwhile.
    await quota?.increment(ctx, pageKey, today());
    const proof = issueProof(plan, 'elicitation', now);
    const result = await guard.commit(ctx, plan, proof);
    expect(result).toMatchObject({
      ok: false,
      state: 'denied',
      sent: false,
      path: 'elicitation',
    });
    expect(!result.ok && result.error.message).toBe(
      policySentences.limitReached,
    );
    const again = await guard.commit(ctx, plan, proof);
    expect(!again.ok && again.error.code).toBe('confirmation_required');
    expect(fake.sent).toEqual([]);
  });

  it('writes nothing when the page was renamed after the plan, without counting it', async () => {
    const { fake, guard, ctx, request, quota } = setup(fakeOf(), dir, {
      policy: pagePolicy,
    });
    const plan = planOf(await guard.plan(request, update));
    fake.page = { ...fake.page, title: 'Alter Plan' };
    const proof = issueProof(plan, 'elicitation', now);
    const result = await guard.commit(ctx, plan, proof);
    expect(!result.ok && result.error.message).toBe(
      policySentences.nameChanged,
    );
    expect(await quota?.read(ctx, pageKey, today())).toBe(0);
    expect(fake.sent).toEqual([]);
  });

  it('ends a commit whose read of a name fails as failed, not as refused', async () => {
    const fake = fakeOf();
    fake.categoryName = 'Berichte';
    const { guard, ctx, request } = setup(fake, dir, {
      policy: categoryPolicy,
    });
    const plan = planOf(await guard.plan(request, create));
    fake.categoryNameFails = new EccliumError('network');
    const result = await guard.commit(
      ctx,
      plan,
      issueProof(plan, 'elicitation', now),
    );
    expect(result).toMatchObject({ ok: false, state: 'failed', sent: false });
    expect(!result.ok && result.error.code).toBe('network');
    expect(fake.sent).toEqual([]);
  });

  it('looks at the switches again after the count, and keeps the count', async () => {
    const store = createMemoryQuotaStore();
    // The switch goes off while the write takes its place in the counter.
    const quota: QuotaStore = {
      read: (ctx, key, day) => store.read(ctx, key, day),
      increment: (ctx, key, day) => {
        writeFileSync(join(dir, 'writes-off'), '');
        return store.increment(ctx, key, day);
      },
    };
    const { fake, guard, ctx, request } = setup(fakeOf(), dir, {
      policy: pagePolicy,
      quota,
    });
    const plan = planOf(await guard.plan(request, update));
    const result = await guard.commit(
      ctx,
      plan,
      issueProof(plan, 'elicitation', now),
    );
    expect(!result.ok && result.error.message).toBe(writeSentences.switchedOff);
    expect(await store.read(ctx, pageKey, today())).toBe(1);
    expect(fake.sent).toEqual([]);
  });

  it('cannot count a limited write without a store of quotas', async () => {
    const { guard, request } = setup(fakeOf(), dir, {
      policy: pagePolicy,
      quota: null,
    });
    expect(await refusalOf(guard.plan(request, update))).toMatchObject({
      code: 'policy_denied',
      message: policySentences.countUnavailable,
    });
  });
});

describe('the snapshot of a write (ADR 0031)', () => {
  const eventId = '11111111-2222-4333-8444-555555555555';
  const day = '2026-12-01';

  // Records every part it is asked to keep, and fails the parts named.
  const recording = (fails: readonly ('before' | 'after')[] = []) => {
    const saved: SnapshotToSeal[] = [];
    const snapshots: WriteSnapshots = {
      save: (_ctx, snapshot) => {
        saved.push(snapshot);
        return fails.includes(snapshot.part)
          ? Promise.reject(new Error('no room'))
          : Promise.resolve();
      },
    };
    return { saved, snapshots };
  };

  const commitWith = async (
    intent: unknown,
    snapshots: WriteSnapshots | undefined,
    event: string | undefined = eventId,
  ) => {
    const { guard, ctx, request, fake } = setup(fakeOf(), dir, { snapshots });
    const plan = planOf(await guard.plan(request, intent));
    const committed = await guard.commit(
      ctx,
      plan,
      issueProof(plan, 'elicitation', now),
      event,
    );
    return { committed, fake, plan };
  };

  it('keeps the text before a change, with its version and the hash of the new text, before the send', async () => {
    const { saved, snapshots } = recording();
    const { committed, fake } = await commitWith(update, snapshots);
    expect(committed).toMatchObject({ ok: true, undoId: eventId });
    expect(saved).toEqual([
      {
        eventId,
        part: 'before',
        day,
        content: {
          kind: 'wikiPageText',
          tool: 'ct_example_note_write',
          categoryId: 12,
          guid,
          before: { version: 3, text: '# Plan\n' },
          after: { version: 4, textHash: contentHashOf(['# Neu\n']) },
        },
      },
    ]);
    expect(fake.sent).toEqual(['# Neu\n']);
  });

  it('keeps a new page before the send and its GUID after the read back', async () => {
    const { saved, snapshots } = recording();
    const { committed } = await commitWith(create, snapshots);
    expect(committed).toMatchObject({ ok: true, undoId: eventId });
    expect(saved).toEqual([
      {
        eventId,
        part: 'before',
        day,
        content: {
          kind: 'wikiPageCreate',
          tool: 'ct_example_note_write',
          categoryId: 12,
          title: 'Bericht',
          textHash: contentHashOf(['# Bericht\n']),
        },
      },
      {
        eventId,
        part: 'after',
        day,
        content: {
          kind: 'wikiPageCreated',
          guid: '00000000-0000-4000-8000-0000000000CD',
          version: 1,
        },
      },
    ]);
  });

  it('sends nothing when the state before cannot be kept', async () => {
    const { snapshots } = recording(['before']);
    const { committed, fake } = await commitWith(append, snapshots);
    expect(committed).toMatchObject({
      ok: false,
      state: 'failed',
      sent: false,
      error: { code: 'internal', message: writeSentences.noSnapshot },
    });
    expect(fake.sent).toEqual([]);
    expect(logged).toContainEqual({
      level: 'warn',
      event: 'snapshot_failed',
      code: 'internal',
    });
  });

  it('sends nothing without the ID of the event or without a day', async () => {
    const { saved, snapshots } = recording();
    const first = setup(fakeOf(), dir, { snapshots });
    const plan = planOf(await first.guard.plan(first.request, update));
    const withoutEvent = await first.guard.commit(
      first.ctx,
      plan,
      issueProof(plan, 'elicitation', now),
    );
    expect(withoutEvent).toMatchObject({
      ok: false,
      state: 'failed',
      sent: false,
    });
    expect(first.fake.sent).toEqual([]);
    expect(saved).toEqual([]);
    // A time past the year 9999, which ChurchTools would share, has no day.
    const future = Date.UTC(10_000, 0, 1);
    const fake = { ...fakeOf(), time: future };
    const late = setup(fake, dir, { snapshots });
    late.clock.advance(future - now);
    const later = planOf(await late.guard.plan(late.request, update));
    const withoutDay = await late.guard.commit(
      late.ctx,
      later,
      issueProof(later, 'elicitation', future),
      eventId,
    );
    expect(withoutDay).toMatchObject({
      ok: false,
      state: 'failed',
      sent: false,
    });
    expect(fake.sent).toEqual([]);
  });

  // A page that ChurchTools created but that does not read back as planned
  // exists all the same, so `ecclium undo` must be able to find it.
  it.each([
    [
      'answers with another version',
      (fake: Fake) => {
        fake.created = {
          guid: '00000000-0000-4000-8000-0000000000CD',
          title: 'Bericht',
          version: 2,
          isMarkdown: true,
        };
      },
      'conflict',
      2,
    ],
    [
      'cannot be read back',
      (fake: Fake) => {
        fake.readFailsAfterWrite = new EccliumError('network');
      },
      'failed',
      1,
    ],
    [
      'reads back with another text',
      (fake: Fake) => {
        fake.createdText = '# Anders\n';
      },
      'conflict',
      1,
    ],
  ] as const)(
    'keeps the GUID of a new page that %s',
    async (_, change, state, version) => {
      const { saved, snapshots } = recording();
      const fake = fakeOf();
      change(fake);
      const { guard, ctx, request } = setup(fake, dir, { snapshots });
      const plan = planOf(await guard.plan(request, create));
      const committed = await guard.commit(
        ctx,
        plan,
        issueProof(plan, 'elicitation', now),
        eventId,
      );
      expect(committed).toMatchObject({ ok: false, state, sent: true });
      expect(saved.map((part) => part.part)).toEqual(['before', 'after']);
      expect(saved[1]?.content).toEqual({
        kind: 'wikiPageCreated',
        guid: '00000000-0000-4000-8000-0000000000CD',
        version,
      });
    },
  );

  it('keeps a new page written when its GUID cannot be kept, and says so', async () => {
    const { snapshots } = recording(['after']);
    const { committed } = await commitWith(create, snapshots);
    expect(committed).toMatchObject({ ok: true, undoId: eventId });
    expect(logged).toContainEqual({
      level: 'warn',
      event: 'snapshot_incomplete',
      code: 'internal',
    });
  });

  it('seals every plan as not reversible without snapshots and gives no ID to undo', async () => {
    const { committed, plan } = await commitWith(update, undefined);
    expect(readPlan(plan)?.rules.reversible).toBe('no');
    expect(readPlan(plan)?.echo).toBe(false);
    expect(committed.ok && 'undoId' in committed).toBe(false);
    const { snapshots } = recording();
    const { plan: kept } = await commitWith(update, snapshots);
    expect(readPlan(kept)?.rules.reversible).toBe('snapshot');
    expect(readPlan(kept)?.echo).toBe(true);
  });
});
