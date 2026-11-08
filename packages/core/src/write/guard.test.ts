import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EccliumError,
  isEccliumError,
  type IsoDate,
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
  type TestClock,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { canonicalOfWritten, contentSentences } from '../content/index.js';
import { HttpTransportError } from '../http/index.js';
import { KeyMaterial } from '../keys/index.js';
import { checkCodeOf, markingLineOf } from '../marker/index.js';
import { checkPolicy, defaultPolicy } from '../policy/check.js';
import type { Policy } from '../policy/schema.js';
import { isoDateOf } from '../quota/budget.js';
import {
  appendSection,
  type ApprovedEntry,
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
import type { SnapshotToUndo } from './undo.js';

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
    text: '# Plan',
  },
  permissions: {
    kind: 'known',
    granted: { churchwiki: { 'edit category': [12] } },
  },
  time: now,
  sent: [],
});

const unused = (): Promise<never> =>
  Promise.reject(new Error('not used by the wiki'));
const calendarUnused = {
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
};

// ChurchTools removes white space at both ends of a text before it stores
// it, as `trim` of PHP does (F51); the double does the same, written apart
// from the core, so that a text the core sends in another form comes back
// changed.
const asStored = (text: string): string =>
  text.replace(/^[ \t\n\r\v]+/u, '').replace(/[ \t\n\r\v]+$/u, '');

const clientOf = (fake: Fake): WriteClient => ({
  permissions: () => Promise.resolve(fake.permissions),
  writes: {
    wikiCategoryState: () => {
      fake.onRead?.();
      return Promise.resolve({ serverTime: fake.time });
    },
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
        fake.page = {
          ...fake.page,
          text: asStored(text),
          version: fake.page.version + 1,
        };
      }
      return fake.updateFails === undefined
        ? Promise.resolve()
        : Promise.reject(fake.updateFails);
    },
    createWikiPage: (_ctx, _category, title, text) => {
      fake.sent.push(text);
      if (fake.createFails !== undefined)
        return Promise.reject(fake.createFails);
      fake.createdText ??= asStored(text);
      fake.created ??= {
        guid: '00000000-0000-4000-8000-0000000000CD',
        title,
        version: 1,
        isMarkdown: true,
      };
      return Promise.resolve(fake.created);
    },
    // The writes of appointments and bookings have tests of their own in
    // guard-calendar.test.ts; a test of the wiki never reaches them.
    ...calendarUnused,
  },
  whoami: () => Promise.reject(new Error('not used by the wiki')),
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

// The key of the check codes and whom to ask, which every write that adds
// a page or a section needs (ADR 0032). Tests of the marking itself leave
// them out on purpose.
const markerKey = new KeyMaterial('0123456789abcdef'.repeat(4));
const inquiriesTo = 'Sekretariat';
const withInquiries = (policy: Policy): Policy =>
  policy.interactive.inquiriesTo === undefined
    ? Object.freeze({
        ...policy,
        interactive: Object.freeze({ ...policy.interactive, inquiriesTo }),
      })
    : policy;

// A text as the guard adds it: the written text and its line of the
// marking, an interactive one of the day of the plan in the tenant of the
// context.
const day = isoDateOf(now) as IsoDate;
const marked = (written: string, tenantId = 'demo-tenant'): string => {
  const origin = { kind: 'interactive', day } as const;
  const code = checkCodeOf(
    markerKey,
    tenantId,
    origin,
    canonicalOfWritten(written),
  );
  return `${written}\n${markingLineOf({ date: day, origin, code }, inquiriesTo)}`;
};

const setup = (
  fake = fakeOf(),
  killSwitchDir: string | null = dir,
  limits: {
    policy?: Policy;
    quota?: QuotaStore | null;
    snapshots?: WriteSnapshots;
    /** Without the key and whom to ask, for the tests of the marking. */
    unmarked?: 'key' | 'inquiries';
    clock?: TestClock;
  } = {},
) => {
  const clock = limits.clock ?? createTestClock(now);
  const quota =
    limits.quota === null
      ? undefined
      : (limits.quota ?? createMemoryQuotaStore());
  const policy = limits.policy ?? defaultPolicy;
  const guard = createWriteGuard({
    client: clientOf(fake),
    clock,
    killSwitchDir: killSwitchDir ?? undefined,
    policy: limits.unmarked === 'inquiries' ? policy : withInquiries(policy),
    quota,
    snapshots: limits.snapshots,
    ...(limits.unmarked === 'key' ? {} : { markerKey }),
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
    ['# Plan\n', '## Nachtrag', '# Plan\n\n## Nachtrag'],
    ['# Plan  \n\n', '## Nachtrag \n', '# Plan\n\n## Nachtrag'],
    ['', '## Nachtrag', '## Nachtrag'],
    ['   ', '## Nachtrag', '## Nachtrag'],
    // Only what ChurchTools removes goes, at both ends (F51).
    ['\n\t# Plan', '\r\n## Nachtrag\v', '# Plan\n\n## Nachtrag'],
    [
      '# Plan\u00a0',
      '## Nachtrag\u00a0\n',
      '# Plan\u00a0\n\n## Nachtrag\u00a0',
    ],
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

  // A plugin declares rights, a target and a guard against replay in its
  // meta; even if such fields reached the guard, the rules come from the
  // intent (ADR 0029).
  it('derives target, rights and replay guard from the intent, whatever a meta claims', async () => {
    const { guard, request } = setup();
    const plain = readPlan(planOf(await guard.plan(request, update)));
    const claimed = readPlan(
      planOf(
        await guard.plan(
          {
            ...request,
            origin: 'plugin',
            meta: {
              ...meta,
              requiredRights: [{ module: 'churchcal', right: 'view' }],
              replayGuard: 'nonce',
              target: { kind: 'calendar', key: '3' },
            } as typeof meta,
          },
          update,
        ),
      ),
    );
    if (plain === undefined || claimed === undefined) {
      throw new Error('expected two sealed plans');
    }
    expect(claimed.rules).toEqual(plain.rules);
    expect(claimed.rules).toMatchObject({
      target: { kind: 'wiki_page', key: `12/${guid.toLowerCase()}` },
      requiredRights: [{ module: 'churchwiki', right: 'edit category' }],
      replayGuard: 'baseVersion',
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

  // Every kind of intent the plugin interface knows, those of the Pro
  // module and one that fits none: with ECCLIUM_READ_ONLY=true the guard
  // refuses each before it reads anything, whoever plans it (ADR 0029).
  const everyIntent = [
    ['a new page', create],
    ['a change of a page', update],
    ['a section', append],
    [
      'a new appointment',
      {
        kind: 'appointmentCreate',
        calendarId: 3,
        title: 'Probe',
        startDate: '2026-12-02T09:00:00Z',
        endDate: '2026-12-02T10:00:00Z',
      },
    ],
    [
      'a change of an appointment',
      {
        kind: 'appointmentUpdate',
        calendarId: 3,
        appointmentId: 41,
        baseVersion: 0,
        title: 'Probe',
        startDate: '2026-12-02T09:00:00Z',
        endDate: '2026-12-02T10:00:00Z',
      },
    ],
    [
      'a booking',
      {
        kind: 'bookingCreate',
        resourceId: 6,
        title: 'Probe',
        startDate: '2026-12-02T09:00:00Z',
        endDate: '2026-12-02T10:00:00Z',
      },
    ],
    [
      'a new member of a group',
      { kind: 'groupMemberAdd', groupId: 7, personId: 1 },
    ],
    [
      'a member leaving a group',
      { kind: 'groupMemberRemove', groupId: 7, personId: 1 },
    ],
    [
      'a service request',
      { kind: 'serviceRequest', eventId: 9, serviceId: 3, personId: 1 },
    ],
    ['an operation by its ID', { kind: 'apiOperation', operationId: 'x' }],
    ['an intent that fits none', { kind: 'pageDelete', guid }],
  ] as const;

  it.each(
    everyIntent.flatMap(([name, intent]) =>
      (['core', 'plugin'] as const).map(
        (origin) => [name, origin, intent] as const,
      ),
    ),
  )(
    'refuses %s from %s when the server only reads, before any read',
    async (_name, origin, intent) => {
      const fake = fakeOf();
      let reads = 0;
      fake.onRead = () => {
        reads += 1;
      };
      const { guard } = setup(fake);
      const ctx = contextOf(logged, { readOnly: true });
      const error = await refusalOf(
        guard.plan({ ctx, tool: 'ct_x', origin, meta }, intent),
      );
      expect([error.code, error.message]).toEqual([
        'policy_denied',
        writeSentences.readOnly,
      ]);
      expect([reads, fake.sent]).toEqual([0, []]);
    },
  );

  it.each(everyIntent)(
    'counter-check: %s is not refused as read-only on a server that writes',
    async (_name, intent) => {
      const { guard, request } = setup();
      const outcome = await guard.plan(request, intent).then(
        () => 'planned',
        (error: unknown) =>
          isEccliumError(error) ? error.message : 'other error',
      );
      expect(outcome).not.toBe(writeSentences.readOnly);
    },
  );

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
      'a service request',
      { kind: 'serviceRequest', eventId: 9, serviceId: 3, personId: 1 },
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
      'a title with a space at its end',
      { ...create, title: 'Plan ' },
      'validation',
      writeSentences.title,
    ],
    [
      'a title that NFKC makes longer than 255 characters',
      { ...create, title: `${'T'.repeat(254)}${String.fromCodePoint(0x2026)}` },
      'validation',
      writeSentences.title,
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
    expect(parts.fake.sent).toEqual([
      `# Plan\n\n${marked('## Nachtrag\n\n- Probe\n')}`,
    ]);
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

  it('sends every text in the form ChurchTools stores, so that the read back finds it (F51)', async () => {
    // The double removes white space at both ends, as ChurchTools does: a
    // text sent with a line break at its end would come back without it
    // and end in conflict.
    for (const intent of [create, append, { ...update, text: '\n# Neu\n\n' }]) {
      const { fake, guard, ctx, plan, proof } = await planned(intent);
      expect(await guard.commit(ctx, plan, proof)).toMatchObject({
        ok: true,
        state: 'verified',
      });
      expect(fake.sent).toHaveLength(1);
      expect(fake.sent.map(asStored)).toEqual(fake.sent);
    }
  });

  it('changes a page and reads the change back', async () => {
    const { fake, guard, ctx, plan, proof } = await planned(update);
    expect(await guard.commit(ctx, plan, proof)).toEqual({
      ok: true,
      state: 'verified',
      path: 'elicitation',
      target: { kind: 'wiki_page', key: `12/${guid.toLowerCase()}` },
      version: 4,
    });
    expect(fake.sent).toEqual(['# Neu']);
    expect(logged.map((line) => line.event)).toContain('write_committed');
  });

  it('appends a section to the text the page has', async () => {
    const { fake, guard, ctx, plan, proof } = await planned(append);
    expect((await guard.commit(ctx, plan, proof)).ok).toBe(true);
    expect(fake.sent).toEqual([`# Plan\n\n${marked('## Nachtrag\n')}`]);
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

  // What code outside the core could build in place of the proof it got:
  // none is taken, none uses the proof up, and the real one still writes
  // (ADR 0029).
  it('commits nothing with a proof built outside the core, and the real proof still writes', async () => {
    const { fake, guard, ctx, plan, proof } = await planned(update);
    const forged: unknown[] = [
      {},
      { __ecclium: 'WriteProof' },
      Object.create(proof) as object,
      new Proxy(proof, {}),
      { ...(proof as object) },
      JSON.parse(JSON.stringify(proof)) as unknown,
    ];
    for (const value of forged) {
      const result = await guard.commit(ctx, plan, value);
      expect(result).toMatchObject({ ok: false, state: 'denied', sent: false });
      expect(!result.ok && result.error.code).toBe('confirmation_required');
    }
    expect(fake.sent).toEqual([]);
    expect((await guard.commit(ctx, plan, proof)).ok).toBe(true);
    expect(fake.sent).toHaveLength(1);
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
    fake.page = { ...fake.page, text: '# Anders' };
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
    fake.createdText = '# Anders';
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

  it('plans a new page in a category with another name for the queue, with the reason', async () => {
    const fake = fakeOf();
    fake.categoryName = 'Berichte';
    const { guard, request } = setup(fake, dir, { policy: categoryPolicy });
    const fits = await guard.plan(request, create);
    expect(fits.outcome.kind).toBe('planned');
    expect(fits.queue).toBeUndefined();
    fake.categoryName = 'Protokolle';
    const renamed = await guard.plan(request, create);
    expect(renamed.outcome.kind).toBe('planned');
    expect(renamed.queue).toBe('name_changed');
    expect(logged.map(({ event }) => event)).toEqual(['policy_name_changed']);
  });

  it('seals a plan outside the policy for the queue, with the reason, and a skipped one stays skipped', async () => {
    const { fake, guard, request } = setup(fakeOf(), dir, {
      policy: policyOf({ kind: 'wiki_category', id: 13, name: 'Andere' }),
    });
    const planned = await guard.plan(request, update);
    expect(planned.outcome.kind).toBe('planned');
    expect(planned.queue).toBe('no_entry');
    expect(planned.text?.summary).toContain('ändern');
    fake.page = { ...fake.page, text: '# Neu' };
    const skipped = await guard.plan(request, update);
    expect(skipped.outcome).toEqual({ kind: 'skipped', reason: 'unchanged' });
    expect(skipped.queue).toBeUndefined();
    expect(fake.sent).toEqual([]);
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
    expect(fake.sent).toEqual(['# Neu']);
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

  it('cannot count a limited write without a store of quotas, so it plans it for the queue', async () => {
    const { guard, request } = setup(fakeOf(), dir, {
      policy: pagePolicy,
      quota: null,
    });
    const planned = await guard.plan(request, update);
    expect(planned.outcome.kind).toBe('planned');
    expect(planned.queue).toBe('count_unavailable');
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
      load: () => Promise.resolve({ kind: 'missing' }),
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
          before: { version: 3, text: '# Plan' },
          after: { version: 4, textHash: contentHashOf(['# Neu']) },
        },
      },
    ]);
    expect(fake.sent).toEqual(['# Neu']);
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
          textHash: contentHashOf([marked('# Bericht\n')]),
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
        fake.createdText = '# Anders';
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

describe('the undo of a write (ADR 0031)', () => {
  const undoId = '22222222-3333-4444-8555-666666666666';
  // Records every part the undo keeps of the state it writes over.
  const recording = () => {
    const saved: SnapshotToSeal[] = [];
    const snapshots: WriteSnapshots = {
      save: (_ctx, snapshot) => {
        saved.push(snapshot);
        return Promise.resolve();
      },
      load: () => Promise.resolve({ kind: 'missing' }),
    };
    return { saved, snapshots };
  };
  const day = '2026-11-30' as IsoDate;
  // The write took the page from version 2 to the text it has now, 3.
  const changed: SnapshotToUndo = {
    before: {
      kind: 'wikiPageText',
      tool: 'ct_example_note_write',
      categoryId: 12,
      guid,
      before: { version: 2, text: '# Alt' },
      after: { version: 3, textHash: contentHashOf(['# Plan']) },
    },
    day,
  };
  const created: SnapshotToUndo = {
    before: {
      kind: 'wikiPageCreate',
      tool: 'ct_example_note_write',
      categoryId: 12,
      title: 'Dienstplan',
      textHash: contentHashOf(['# Plan']),
    },
    after: { kind: 'wikiPageCreated', guid, version: 3 },
    day,
  };

  const undoWith = (
    snapshot: SnapshotToUndo,
    options: {
      fake?: Fake;
      overwrite?: boolean;
      killSwitchDir?: string | null;
      policy?: Policy;
      readOnly?: boolean;
      future?: boolean;
    } = {},
  ) => {
    const fake = options.fake ?? fakeOf();
    const { saved, snapshots } = recording();
    const switches =
      options.killSwitchDir === undefined ? dir : options.killSwitchDir;
    const { guard, clock } = setup(fake, switches, {
      snapshots,
      ...(options.policy === undefined ? {} : { policy: options.policy }),
    });
    // A time past the year 9999, which has no day.
    if (options.future === true) clock.advance(Date.UTC(10_000, 0, 1) - now);
    const ctx = contextOf(logged, {
      mode: 'operator',
      readOnly: options.readOnly ?? false,
    });
    return {
      fake,
      saved,
      result: guard.undo({
        ctx,
        eventId: undoId,
        snapshot,
        overwrite: options.overwrite ?? false,
      }),
    };
  };

  it('writes the text from before back, with a snapshot of its own', async () => {
    const { fake, saved, result } = undoWith(changed);
    const ended = await result;
    expect(ended).toMatchObject({
      kind: 'committed',
      result: { ok: true, path: 'operator', version: 4, undoId },
      change: { from: '# Plan', to: '# Alt' },
    });
    expect(fake.sent).toEqual(['# Alt']);
    // The undo can be taken back from the state it wrote over.
    expect(saved).toEqual([
      {
        eventId: undoId,
        part: 'before',
        day: isoDateOf(now),
        content: {
          kind: 'wikiPageText',
          tool: 'ct_example_note_write',
          categoryId: 12,
          guid,
          before: { version: 3, text: '# Plan' },
          after: { version: 4, textHash: contentHashOf(['# Alt']) },
        },
      },
    ]);
  });

  it('writes nothing over a page someone changed since, unless asked to', async () => {
    const fake = fakeOf();
    fake.page = { ...fake.page, version: 5, text: '# Von Hand' };
    const first = undoWith(changed, { fake });
    expect(await first.result).toMatchObject({
      kind: 'changed',
      target: { kind: 'wiki_page', key: `12/${guid.toLowerCase()}` },
      change: { from: '# Von Hand', to: '# Alt' },
    });
    expect(fake.sent).toEqual([]);
    const second = undoWith(changed, { fake, overwrite: true });
    expect(await second.result).toMatchObject({
      kind: 'committed',
      result: { ok: true, version: 6 },
    });
    expect(fake.sent).toEqual(['# Alt']);
  });

  it('does nothing when the page holds the text from before already', async () => {
    const fake = fakeOf();
    fake.page = { ...fake.page, version: 4, text: '# Alt' };
    const { result } = undoWith(changed, { fake });
    expect(await result).toMatchObject({ kind: 'unchanged' });
    expect(fake.sent).toEqual([]);
  });

  // An undo writes back what the page held, also a line of the marking a
  // change dropped since; that is no line a tool brings (ADR 0032).
  it('takes back a change that dropped a line of the marking', async () => {
    const old = `# Alt\n\n${marked('## Nachtrag\n')}`;
    const { fake, result } = undoWith({
      ...changed,
      before: { ...changed.before, before: { version: 2, text: old } },
    } as SnapshotToUndo);
    expect(await result).toMatchObject({
      kind: 'committed',
      result: { ok: true },
    });
    expect(fake.sent).toEqual([old]);
  });

  it('withdraws a new page with the fixed sentence and keeps the page', async () => {
    const { fake, result } = undoWith(created);
    const ended = await result;
    expect(ended).toMatchObject({ kind: 'committed', result: { ok: true } });
    expect(fake.sent).toEqual([
      'Diese Seite hat Ecclium am 30.11.2026 angelegt und am 01.12.2026 zurückgenommen.',
    ]);
    // A second undo finds the sentence and writes nothing.
    const again = undoWith(created, { fake });
    expect(await again.result).toMatchObject({ kind: 'unchanged' });
  });

  it('names only the category of a new page whose GUID was never kept', async () => {
    const { before } = created;
    const { result } = undoWith({ before, day });
    expect(await result).toEqual({
      kind: 'incomplete',
      target: { kind: 'wiki_category', key: '12' },
    });
  });

  it('is not held back by the policy, which judges the writes of the model', async () => {
    const outside = checkPolicy({
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
    if (!outside.ok) throw new Error(outside.code);
    const { fake, result } = undoWith(changed, { policy: outside.policy });
    expect(await result).toMatchObject({
      kind: 'committed',
      result: { ok: true },
    });
    expect(fake.sent).toEqual(['# Alt']);
  });

  it.each([
    [
      'while the server only reads',
      { readOnly: true },
      writeSentences.readOnly,
    ],
    [
      'without the folder of the kill switches',
      { killSwitchDir: null },
      writeSentences.switchUnknown,
    ],
  ] as const)('is refused %s', async (_, options, message) => {
    const { fake, result } = undoWith(changed, options);
    expect(await result).toMatchObject({
      kind: 'refused',
      error: { code: 'policy_denied', message },
    });
    expect(fake.sent).toEqual([]);
  });

  it('is refused without the right, on a page of another kind, and when the read fails', async () => {
    const lacking = fakeOf();
    lacking.permissions = { kind: 'known', granted: {} };
    expect(await undoWith(changed, { fake: lacking }).result).toMatchObject({
      kind: 'refused',
      error: { code: 'permission' },
    });
    const html = fakeOf();
    html.page = { ...html.page, isMarkdown: false };
    expect(await undoWith(changed, { fake: html }).result).toMatchObject({
      kind: 'refused',
      error: { message: writeSentences.notMarkdown },
    });
    const failing = fakeOf();
    failing.readFails = new EccliumError('network');
    expect(await undoWith(changed, { fake: failing }).result).toMatchObject({
      kind: 'refused',
      error: { code: 'network' },
    });
  });

  it('is refused when the clock gives no day', async () => {
    const { result } = undoWith(changed, { future: true });
    expect(await result).toMatchObject({
      kind: 'refused',
      error: { code: 'policy_denied', message: writeSentences.clock },
    });
  });

  it('is refused by the clock right before the send', async () => {
    const late = fakeOf();
    late.time = now + 10 * 60_000;
    const { fake, result } = undoWith(changed, { fake: late });
    expect(await result).toMatchObject({
      kind: 'committed',
      result: {
        ok: false,
        state: 'denied',
        error: { message: writeSentences.clock },
      },
    });
    expect(fake.sent).toEqual([]);
  });
});

describe('an approval of the operator (ADR 0029)', () => {
  const approvalId = '33333333-4444-4555-8666-777777777777';
  const tool = 'ct_example_note_write';
  const pageKey = writeQuotaKey(tool, `wiki_page:12/${guid.toLowerCase()}`);
  const today = (): IsoDate => {
    const day = isoDateOf(now);
    if (day === undefined) throw new Error('expected a day');
    return day;
  };
  const policyOf = (target: unknown, name = 'Dienstplan'): Policy => {
    const result = checkPolicy({
      schema: 'policy.v1',
      interactive: {
        targets: [
          {
            target: { ...(target as object), name },
            tools: [tool],
            maxPerDay: 1,
          },
        ],
      },
    });
    if (!result.ok) throw new Error(result.code);
    return result.policy;
  };
  const pagePolicy = policyOf({
    kind: 'wiki_page',
    categoryId: 12,
    guid: guid.toLowerCase(),
  });

  // The entry of the queue as the pipeline makes it from a sealed plan:
  // what the plan was sealed with, and its hash.
  const entryOf = async (
    intent: unknown,
    options: { fake?: Fake; policy?: Policy } = {},
  ): Promise<ApprovedEntry> => {
    const { guard, request } = setup(options.fake ?? fakeOf(), dir, {
      ...(options.policy === undefined ? {} : { policy: options.policy }),
    });
    const view = readPlan(planOf(await guard.plan(request, intent)));
    if (view === undefined) throw new Error('expected a plan');
    return {
      plannedOn: view.day ?? day,
      tool: view.tool,
      origin: view.origin,
      toolMeta: {
        sensitivity: view.rules.sensitivity,
        unattended: view.rules.unattended,
        reversible: view.rules.reversible,
      },
      intent: view.intent,
      planHash: view.planHash,
    };
  };

  const approveWith = (
    entry: ApprovedEntry,
    options: {
      fake?: Fake;
      killSwitchDir?: string | null;
      policy?: Policy;
      quota?: QuotaStore | null;
      readOnly?: boolean;
      decide?: () => Promise<boolean>;
    } = {},
  ) => {
    const fake = options.fake ?? fakeOf();
    const saved: SnapshotToSeal[] = [];
    const snapshots: WriteSnapshots = {
      save: (_ctx, snapshot) => {
        saved.push(snapshot);
        return Promise.resolve();
      },
      load: () => Promise.resolve({ kind: 'missing' }),
    };
    const switches =
      options.killSwitchDir === undefined ? dir : options.killSwitchDir;
    const { guard, quota } = setup(fake, switches, {
      snapshots,
      ...(options.policy === undefined ? {} : { policy: options.policy }),
      ...(options.quota === undefined ? {} : { quota: options.quota }),
    });
    const decisions: number[] = [];
    // The command of the operator, for the actor who asked for the write.
    const ctx = contextOf(logged, {
      mode: 'operator',
      readOnly: options.readOnly ?? false,
    });
    return {
      fake,
      saved,
      quota,
      decisions,
      ctx,
      result: guard.approve({
        ctx,
        eventId: approvalId,
        entry,
        decide:
          options.decide ??
          (() => {
            // What was sent when the decision was asked for.
            decisions.push(fake.sent.length);
            return Promise.resolve(true);
          }),
      }),
    };
  };

  it('writes the entry from the state now, with a proof of the operator and a snapshot of its own', async () => {
    const entry = await entryOf(update);
    const { fake, saved, decisions, result } = approveWith(entry);
    expect(await result).toEqual({
      kind: 'committed',
      target: { kind: 'wiki_page', key: `12/${guid.toLowerCase()}` },
      result: {
        ok: true,
        state: 'verified',
        path: 'operator',
        target: { kind: 'wiki_page', key: `12/${guid.toLowerCase()}` },
        version: 4,
        undoId: approvalId,
      },
      change: { from: '# Plan', to: '# Neu' },
    });
    // Decided once, before anything was sent.
    expect(decisions).toEqual([0]);
    expect(fake.sent).toEqual(['# Neu']);
    expect(saved).toMatchObject([{ eventId: approvalId, part: 'before' }]);
  });

  it('appends to the text the page has now and creates a new page', async () => {
    const appended = approveWith(await entryOf(append));
    expect(await appended.result).toMatchObject({
      kind: 'committed',
      result: { ok: true },
      change: { from: '# Plan', to: `# Plan\n\n${marked('## Nachtrag\n')}` },
    });
    const created = approveWith(await entryOf(create));
    expect(await created.result).toMatchObject({
      kind: 'committed',
      target: { kind: 'wiki_category', key: '12' },
      result: { ok: true, target: { kind: 'wiki_page' }, version: 1 },
      change: { from: '', to: marked('# Bericht\n') },
    });
    expect(created.fake.sent).toEqual([marked('# Bericht\n')]);
  });

  // The line names the day the write was planned, not the day of the
  // approval, so that the plan of now has the hash of the entry (ADR 0032).
  it('writes the line with the day the write was planned, and nothing for another day', async () => {
    const entry = await entryOf(create);
    expect(entry.plannedOn).toBe(day);
    const approved = approveWith(entry);
    await approved.result;
    expect(approved.fake.sent).toEqual([marked('# Bericht\n')]);
    const later = approveWith({
      ...entry,
      plannedOn: '2026-12-04' as IsoDate,
    });
    expect(await later.result).toMatchObject({
      kind: 'refused',
      error: { code: 'conflict', message: writeSentences.changedSinceQueued },
    });
    expect(later.fake.sent).toEqual([]);
  });

  it('writes and decides nothing when the page changed since the write was queued', async () => {
    const entry = await entryOf(append);
    const later = fakeOf();
    later.page = { ...later.page, version: 4, text: '# Plan, von Hand' };
    const moved = approveWith(entry, { fake: later });
    expect(await moved.result).toEqual({
      kind: 'refused',
      error: expect.objectContaining({
        code: 'conflict',
        message: writeSentences.changedSinceQueued,
      }) as unknown,
    });
    expect(moved.decisions).toEqual([]);
    expect(moved.fake.sent).toEqual([]);
  });

  it('writes and decides nothing for a plan of another hash', async () => {
    const entry = await entryOf(append);
    // The same version with another text, as no ChurchTools should hold.
    const other = fakeOf();
    other.page = { ...other.page, text: '# Anders' };
    const changed = approveWith(entry, { fake: other });
    expect(await changed.result).toMatchObject({
      kind: 'refused',
      error: { code: 'conflict', message: writeSentences.changedSinceQueued },
    });
    expect(changed.decisions).toEqual([]);
    expect(logged.map(({ event }) => event)).toContain('write_conflict');
    // And an entry that names another hash than its plan has.
    const forged = approveWith({ ...entry, planHash: 'f'.repeat(64) });
    expect(await forged.result).toMatchObject({
      kind: 'refused',
      error: { code: 'conflict' },
    });
    expect(forged.fake.sent).toEqual([]);
  });

  it('writes nothing when the decision is not kept or fails', async () => {
    const entry = await entryOf(update);
    const refused = approveWith(entry, {
      decide: () => Promise.resolve(false),
    });
    expect(await refused.result).toEqual({
      kind: 'undecided',
      target: { kind: 'wiki_page', key: `12/${guid.toLowerCase()}` },
    });
    expect(refused.fake.sent).toEqual([]);
    const failing = approveWith(entry, {
      decide: () => Promise.reject(new Error('the store failed')),
    });
    expect(await failing.result).toMatchObject({ kind: 'undecided' });
    expect(failing.fake.sent).toEqual([]);
  });

  it('commits on the way of every write: a change after the decision ends without a write', async () => {
    const entry = await entryOf(update);
    const fake = fakeOf();
    let reads = 0;
    fake.onRead = () => {
      reads += 1;
      // Someone saves the page between the decision and the send.
      if (reads === 2) fake.page = { ...fake.page, version: 4 };
    };
    const { decisions, result } = approveWith(entry, { fake });
    expect(await result).toMatchObject({
      kind: 'committed',
      result: {
        ok: false,
        error: { code: 'conflict', message: writeSentences.changedSincePlan },
      },
    });
    expect(decisions).toEqual([0]);
    expect(fake.sent).toEqual([]);
  });

  it.each([
    [
      'while the server only reads',
      { readOnly: true },
      writeSentences.readOnly,
    ],
    [
      'without the folder of the kill switches',
      { killSwitchDir: null },
      writeSentences.switchUnknown,
    ],
  ] as const)(
    'is refused %s, before any decision',
    async (_, options, message) => {
      const entry = await entryOf(update);
      const { fake, decisions, result } = approveWith(entry, options);
      expect(await result).toMatchObject({
        kind: 'refused',
        error: { code: 'policy_denied', message },
      });
      expect(decisions).toEqual([]);
      expect(fake.sent).toEqual([]);
    },
  );

  it('is refused for an intent that is none, or one this version does not run', async () => {
    const entry = await entryOf(update);
    const broken = approveWith({
      ...entry,
      intent: { kind: 'wikiPageUpdate' },
    });
    expect(await broken.result).toMatchObject({
      kind: 'refused',
      error: { code: 'validation', message: writeSentences.intent },
    });
    const later = approveWith({
      ...entry,
      intent: { kind: 'serviceRequest', eventId: 9, serviceId: 3, personId: 1 },
    });
    expect(await later.result).toMatchObject({
      kind: 'refused',
      error: { code: 'policy_denied', message: writeSentences.notRun },
    });
    expect([...broken.decisions, ...later.decisions]).toEqual([]);
  });

  it('is refused without the right, for a page of another kind, when the read fails and by the clock', async () => {
    const entry = await entryOf(update);
    const lacking = fakeOf();
    lacking.permissions = { kind: 'known', granted: {} };
    const html = fakeOf();
    html.page = { ...html.page, isMarkdown: false };
    const failing = fakeOf();
    failing.readFails = new EccliumError('network');
    const late = fakeOf();
    late.time = now + 10 * 60_000;
    const ends = await Promise.all(
      [lacking, html, failing, late].map(
        (fake) => approveWith(entry, { fake }).result,
      ),
    );
    expect(ends).toMatchObject([
      { kind: 'refused', error: { code: 'permission' } },
      { kind: 'refused', error: { message: writeSentences.notMarkdown } },
      { kind: 'refused', error: { code: 'network' } },
      { kind: 'refused', error: { message: writeSentences.clock } },
    ]);
    for (const fake of [lacking, html, failing, late]) {
      expect(fake.sent).toEqual([]);
    }
  });

  it('checks the texts against the content policy again', async () => {
    const entry = await entryOf(create);
    const { decisions, result } = approveWith({
      ...entry,
      intent: {
        ...create,
        text: 'Mehr unter ![x](https://example.org/p.png)',
      },
    });
    expect(await result).toMatchObject({
      kind: 'refused',
      error: { code: 'validation' },
      contentViolations: ['image'],
    });
    expect(decisions).toEqual([]);
  });

  it('stands in for an entry the policy lacks', async () => {
    const outside = policyOf({ kind: 'wiki_category', id: 13 }, 'Andere');
    const entry = await entryOf(update, { policy: outside });
    const { fake, result } = approveWith(entry, { policy: outside });
    expect(await result).toMatchObject({
      kind: 'committed',
      result: { ok: true },
    });
    expect(fake.sent).toEqual(['# Neu']);
  });

  it('writes past the limit of the day and counts the write all the same', async () => {
    const store = createMemoryQuotaStore();
    const wish = contextOf([]);
    // The place of the day was taken before the write was queued.
    await store.increment(wish, pageKey, today());
    const entry = await entryOf(update, { policy: pagePolicy });
    const { fake, result } = approveWith(entry, {
      policy: pagePolicy,
      quota: store,
    });
    expect(await result).toMatchObject({
      kind: 'committed',
      result: { ok: true },
    });
    expect(fake.sent).toEqual(['# Neu']);
    // Counted for the actor who asked for the write.
    expect(await store.read(wish, pageKey, today())).toBe(2);
  });

  it('stands in for a name that changed, and counts the write', async () => {
    const renamed = policyOf(
      { kind: 'wiki_page', categoryId: 12, guid: guid.toLowerCase() },
      'Alter Plan',
    );
    const store = createMemoryQuotaStore();
    const entry = await entryOf(update, { policy: renamed });
    const { fake, result } = approveWith(entry, {
      policy: renamed,
      quota: store,
    });
    expect(await result).toMatchObject({
      kind: 'committed',
      result: { ok: true },
    });
    expect(fake.sent).toEqual(['# Neu']);
    expect(await store.read(contextOf([]), pageKey, today())).toBe(1);
  });

  it('writes when the write cannot be counted, and says so', async () => {
    const entry = await entryOf(update);
    const { fake, result } = approveWith(entry, {
      policy: pagePolicy,
      quota: null,
    });
    expect(await result).toMatchObject({
      kind: 'committed',
      result: { ok: true },
    });
    expect(fake.sent).toEqual(['# Neu']);
    expect(logged.map(({ event }) => event)).toContain(
      'policy_count_unavailable',
    );
  });
});

// The marking of what the guard adds to the wiki (ADR 0032).
describe('the marking', () => {
  const plannedWith = async (
    intent: unknown,
    fake = fakeOf(),
    limits: Parameters<typeof setup>[2] = {},
  ) => {
    const parts = setup(fake, dir, limits);
    return { ...parts, result: await parts.guard.plan(parts.request, intent) };
  };

  it('ends a new page and a section with the line of the marking', async () => {
    for (const [intent, sent] of [
      [create, marked('# Bericht\n')],
      [append, `# Plan\n\n${marked('## Nachtrag\n')}`],
    ] as const) {
      const { guard, ctx, result, fake } = await plannedWith(intent);
      const plan = planOf(result);
      expect(readPlan(plan)?.day).toBe(day);
      expect(result.text?.diff.join('\n')).toContain('Prüfcode k1:');
      const proof = issueProof(plan, 'elicitation', now);
      expect((await guard.commit(ctx, plan, proof)).ok).toBe(true);
      expect(fake.sent).toEqual([sent]);
    }
    expect(marked('# Bericht\n')).toMatch(
      /^# Bericht\n\nAutomatisch erstellt am 01\.12\.2026 durch Ecclium, interaktiv, Prüfcode k1:[A-Z2-7]{13}\. Rückfragen an Sekretariat\.$/u,
    );
  });

  it('gives a change of a page no line, also without the key', async () => {
    const { guard, ctx, result, fake } = await plannedWith(update, fakeOf(), {
      unmarked: 'key',
    });
    const plan = planOf(result);
    await guard.commit(ctx, plan, issueProof(plan, 'elicitation', now));
    expect(fake.sent).toEqual(['# Neu']);
  });

  it.each([
    ['without the key', 'key'],
    ['without whom to ask', 'inquiries'],
  ] as const)(
    'adds no page and no section %s, before any read',
    async (_name, unmarked) => {
      for (const intent of [create, append]) {
        const fake = fakeOf();
        fake.onRead = () => {
          throw new Error('read');
        };
        const parts = setup(fake, dir, { unmarked });
        const refusal = await refusalOf(
          parts.guard.plan(parts.request, intent),
        );
        expect(refusal.code).toBe('policy_denied');
        expect(refusal.message).toBe(writeSentences.noMarking);
      }
    },
  );

  it('writes nothing when the clock gives no day', async () => {
    const parts = setup(fakeOf(), dir, {
      clock: { now: () => Number.NaN, advance: () => undefined },
    });
    const refusal = await refusalOf(parts.guard.plan(parts.request, create));
    expect(refusal.code).toBe('policy_denied');
    expect(refusal.message).toBe(writeSentences.noDay);
  });

  it('refuses a text that the line makes longer than ChurchTools takes, before it is confirmed', async () => {
    const long = { ...create, text: `${'a'.repeat(65_500)}\n` };
    const created = await refusalOf(setup().guard.plan(setup().request, long));
    expect(created).toMatchObject({
      code: 'validation',
      message: writeSentences.tooLong,
    });
    const full = fakeOf();
    full.page = { ...full.page, text: `${'a'.repeat(65_500)}\n` };
    const parts = setup(full);
    expect(
      await refusalOf(parts.guard.plan(parts.request, append)),
    ).toMatchObject({ code: 'validation', message: writeSentences.tooLong });
  });

  it('adds a section that stands on the page as its own of the day no second time', async () => {
    const fake = fakeOf();
    fake.page = { ...fake.page, text: `# Plan\n\n${marked('## Nachtrag\n')}` };
    const { result } = await plannedWith(append, fake);
    expect(result.outcome).toEqual({
      kind: 'skipped',
      reason: 'already_written',
    });
    expect(logged.map(({ event }) => event)).toContain('marking_repeated');
  });

  it('sends a section whose marking a person changed to the queue', async () => {
    const fake = fakeOf();
    fake.page = {
      ...fake.page,
      text: `# Plan\n\n${marked('## Nachtrag\n').replace('Nachtrag', 'Nachtrag von Hand')}`,
    };
    const { result } = await plannedWith(append, fake);
    expect(result.outcome.kind).toBe('planned');
    expect(result.queue).toBe('marker_changed');
    expect(logged.map(({ event }) => event)).toContain('marking_changed');
  });

  it('adds a section beside one of another day, another tenant or a routine', async () => {
    const own = marked('## Nachtrag\n');
    const line =
      own.split('\n').find((entry) => entry.startsWith('Automatisch')) ?? '';
    const code = /k1:[A-Z2-7]{13}/u.exec(line)?.[0] ?? '';
    for (const text of [
      `# Plan\n\n${own.replace('01.12.2026', '30.11.2026')}`,
      `# Plan\n\n${marked('## Nachtrag\n', 'other-tenant')}`,
      `# Plan\n\n## Nachtrag\n\nAutomatisch erstellt am 01.12.2026 durch Ecclium, Routine dienstplan-report, Lauf 2026-W49, Prüfcode ${code}. Rückfragen an Sekretariat.\n`,
    ]) {
      const fake = fakeOf();
      fake.page = { ...fake.page, text };
      const { result } = await plannedWith(append, fake);
      expect(result.outcome.kind, text).toBe('planned');
      expect(result.queue, text).toBeUndefined();
    }
  });

  it('adds no section to a page that ends in an open block of code or comment', async () => {
    for (const text of ['# Plan\n\n```\nalt\n', '# Plan\n\n<!--\nalt\n']) {
      const fake = fakeOf();
      fake.page = { ...fake.page, text };
      const parts = setup(fake);
      expect(
        await refusalOf(parts.guard.plan(parts.request, append)),
        text,
      ).toMatchObject({ code: 'validation', message: writeSentences.pageOpen });
    }
  });

  it('skips a repeat also on a page too full for a second one', async () => {
    const fake = fakeOf();
    fake.page = {
      ...fake.page,
      text: `${'a'.repeat(65_400)}\n\n${marked('## Nachtrag\n')}`,
    };
    const { result } = await plannedWith(append, fake);
    expect(result.outcome).toEqual({
      kind: 'skipped',
      reason: 'already_written',
    });
  });

  it('checks the marking before the rights', async () => {
    const fake = fakeOf();
    fake.permissions = { kind: 'unknown' };
    const parts = setup(fake, dir, { unmarked: 'key' });
    expect(
      await refusalOf(parts.guard.plan(parts.request, create)),
    ).toMatchObject({ message: writeSentences.noMarking });
  });

  it('keeps the reason of the policy for a changed section', async () => {
    const fake = fakeOf();
    fake.page = {
      ...fake.page,
      text: `# Plan\n\n${marked('## Nachtrag\n').replace('Nachtrag', 'Nachtrag von Hand')}`,
    };
    const policy = checkPolicy({
      schema: 'policy.v1',
      interactive: {
        targets: [
          {
            target: { kind: 'wiki_category', id: 13, name: 'Andere' },
            tools: ['ct_example_note_write'],
            maxPerDay: 4,
          },
        ],
      },
    });
    if (!policy.ok) throw new Error(policy.code);
    const { result } = await plannedWith(append, fake, {
      policy: policy.policy,
    });
    expect(result.queue).toBe('no_entry');
    expect(logged.map(({ event }) => event)).toContain('marking_changed');
  });

  // The day is that of the plan, so that the commit after midnight and an
  // approval days later write what was confirmed.
  it('keeps the day of the plan through a commit after midnight', async () => {
    const late = Date.UTC(2026, 10, 30, 23, 59, 58);
    const clock = createTestClock(late);
    const fake = fakeOf();
    fake.time = late;
    const parts = setup(fake, dir, { clock });
    const plan = planOf(await parts.guard.plan(parts.request, create));
    clock.advance(4_000);
    expect(isoDateOf(clock.now())).toBe('2026-12-01');
    const proof = issueProof(plan, 'elicitation', clock.now());
    expect((await parts.guard.commit(parts.ctx, plan, proof)).ok).toBe(true);
    expect(fake.sent[0]).toContain('Automatisch erstellt am 30.11.2026');
  });
});

// A line of the marking comes from the core alone (ADR 0032).
describe('a line of the marking in a text of a tool', () => {
  const own = marked('## Nachtrag\n');
  const line =
    own.split('\n').find((entry) => entry.startsWith('Automatisch')) ?? '';

  it('refuses a new page or a section that brings one, also in a list or a heading, before any read', async () => {
    for (const text of [
      `Text.\n\n${line}`,
      `- ${line}`,
      `## ${line}`,
      line.replace('interaktiv', 'Routine dienstplan-report, Lauf 2026-W49'),
    ]) {
      for (const intent of [
        { ...create, text },
        { ...append, section: text },
      ]) {
        const fake = fakeOf();
        fake.onRead = () => {
          throw new Error('read');
        };
        const parts = setup(fake);
        const refused = await parts.guard.plan(parts.request, intent).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(refused, text).toBeInstanceOf(ContentRefusal);
        expect((refused as ContentRefusal).violations).toEqual(['marking']);
      }
    }
    expect(logged.map(({ event }) => event)).toContain('content_marking');
  });

  it('refuses one written another way, also as the title of a new page', async () => {
    for (const intent of [
      { ...create, text: line.replace('durch Ecclium', 'durch  Ecclium') },
      { ...append, section: line.replace('Ecclium', '**Ecclium**') },
      { ...create, title: line.slice(0, 150) },
    ]) {
      const parts = setup();
      const refused = await parts.guard.plan(parts.request, intent).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect((refused as ContentRefusal).violations).toEqual(['marking']);
    }
    const fake = fakeOf();
    fake.page = { ...fake.page, text: `# Plan\n\n${own}` };
    const parts = setup(fake);
    const refused = await parts.guard
      .plan(parts.request, {
        ...update,
        text: `# Plan\n\n${own}\n${line.replace('durch Ecclium', 'durch  Ecclium')}\n`,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect((refused as ContentRefusal).violations).toEqual(['marking']);
  });

  it('lets a change keep or drop the lines the page has, but add or change none', async () => {
    const page = `# Plan\n\n${own}`;
    const planWith = async (text: string) => {
      const fake = fakeOf();
      fake.page = { ...fake.page, text: page };
      const parts = setup(fake);
      return parts.guard.plan(parts.request, { ...update, text });
    };
    for (const text of [
      '# Plan\n\nOhne den Abschnitt.\n',
      `# Plan, neu\n\n${own}`,
    ]) {
      expect((await planWith(text)).outcome.kind, text).toBe('planned');
    }
    const other = marked('## Anderes\n');
    for (const text of [
      `${page}\n${other}`,
      `${page}\n${own}`,
      page.replace(/k1:[A-Z2-7]{13}/u, 'k1:ABCDEFGHIJKLM'),
      page.replace('01.12.2026', '02.12.2026'),
    ]) {
      const refused = await planWith(text).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refused, text).toBeInstanceOf(ContentRefusal);
      expect((refused as ContentRefusal).violations).toEqual(['marking']);
    }
  });
});
