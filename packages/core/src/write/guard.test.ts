import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EccliumError,
  isEccliumError,
  type Permissions,
  type PlannedWrite,
  type TenantContext,
  type WikiPage,
} from '@ecclium/mcp-churchtools-plugin-api';
import { createTestClock } from '@ecclium/mcp-churchtools-testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HttpTransportError } from '../http/index.js';
import {
  appendSection,
  createWriteGuard,
  type PlanRequest,
  type PlanResult,
  type WriteClient,
  writeSentences,
} from './guard.js';
import { issueProof } from './proof.js';
import { readPlan } from './sealed-plan.js';

const guid = '00000000-0000-4000-8000-0000000000AB';
const now = Date.UTC(2026, 11, 1, 8, 0, 0);

interface Logged {
  readonly level: string;
  readonly event: string;
  readonly code?: unknown;
}

const contextOf = (
  logged: Logged[],
  change: Partial<{ tenantId: string; readOnly: boolean; id: string }> = {},
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
    wikiCategoryName: () => Promise.resolve(fake.categoryName),
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

const setup = (fake = fakeOf(), killSwitchDir: string | null = dir) => {
  const clock = createTestClock(now);
  const guard = createWriteGuard({
    client: clientOf(fake),
    clock,
    killSwitchDir: killSwitchDir ?? undefined,
  });
  const ctx = contextOf(logged);
  const request: PlanRequest = {
    ctx,
    tool: 'ct_example_note_write',
    origin: 'core',
    meta,
  };
  return { fake, clock, guard, ctx, request };
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
