import {
  type EccliumError,
  isEccliumError,
  type Mode,
  type QuotaStore,
  type TenantContext,
  writeQuotaKey,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  createMemoryQuotaStore,
  createTestClock,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkPolicy, defaultPolicy } from '../policy/check.js';
import type { Policy } from '../policy/schema.js';
import { isoDateOf, quotaTimeoutMs } from '../quota/budget.js';
import { createPolicyGate, policySentences } from './policy-gate.js';
import type { IntentRules, TargetKind } from './rules.js';

const guid = '0000000a-0000-4000-8000-000000000001';
const now = Date.UTC(2026, 11, 1, 8, 0, 0);

const contextOf = (events: string[], mode: Mode = 'interactive') =>
  ({
    tenantId: 'demo-tenant',
    actor: { kind: 'service', id: 'stdio:local-stdio' },
    readOnly: false,
    mode,
    log: {
      debug: (event: string) => events.push(`debug:${event}`),
      info: (event: string) => events.push(`info:${event}`),
      warn: (event: string) => events.push(`warn:${event}`),
      error: (event: string) => events.push(`error:${event}`),
    },
  }) as unknown as TenantContext;

const rulesOf = (
  kind: TargetKind,
  key: string,
  alwaysQueue = false,
): IntentRules =>
  ({
    target: { kind, key },
    requiredRights: [],
    sensitivity: 'personal',
    unattended: 'policy',
    reversible: 'yes',
    replayGuard: 'version',
    module: 'core',
    alwaysQueue,
    runs: true,
  }) as unknown as IntentRules;

const policyOf = (targets: readonly unknown[]): Policy => {
  const result = checkPolicy({ schema: 'policy.v1', interactive: { targets } });
  if (!result.ok) throw new Error(result.code);
  return result.policy;
};

const create = 'ct_wiki_page_create';
const update = 'ct_wiki_page_update';
const limited = policyOf([
  {
    target: { kind: 'wiki_category', id: 12, name: 'Berichte' },
    tools: [create],
    maxPerDay: 2,
  },
  {
    target: {
      kind: 'wiki_page',
      categoryId: 12,
      guid,
      name: 'Dienstplan',
    },
    tools: [update],
    maxPerDay: 1,
  },
  {
    target: { kind: 'calendar', id: 3, name: 'Gottesdienste' },
    tools: ['ct_appointments_create'],
    maxPerDay: 1,
  },
]);

const setup = (
  options: {
    policy?: Policy;
    quota?: QuotaStore | null;
    categoryName?: () => Promise<string | undefined>;
    calendarName?: () => Promise<string | undefined>;
    time?: number;
  } = {},
) => {
  const events: string[] = [];
  const names: number[] = [];
  const quota =
    options.quota === null
      ? undefined
      : (options.quota ?? createMemoryQuotaStore());
  const gate = createPolicyGate({
    policy: options.policy ?? limited,
    quota,
    clock: createTestClock(options.time ?? now),
    categoryName: (_ctx, categoryId) => {
      names.push(categoryId);
      return (options.categoryName ?? (() => Promise.resolve('Berichte')))();
    },
    calendarName: (_ctx, calendarId) => {
      names.push(calendarId);
      return (
        options.calendarName ?? (() => Promise.resolve('Gottesdienste'))
      )();
    },
    resourceName: () => Promise.resolve('Saal'),
  });
  const ctx = contextOf(events);
  return { gate, ctx, events, names, quota };
};

const refusalOf = async (promise: Promise<unknown>): Promise<EccliumError> => {
  try {
    await promise;
  } catch (error) {
    if (isEccliumError(error)) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

const counterOf = (quota: QuotaStore | undefined, ctx: TenantContext) => {
  const day = isoDateOf(now);
  if (day === undefined) throw new Error('expected a day');
  return quota?.read(ctx, writeQuotaKey(create, 'wiki_category:12'), day);
};

// A store in memory that tells how often a count was raised.
const watched = () => {
  const store = createMemoryQuotaStore();
  let raised = 0;
  const quota: QuotaStore = {
    read: (ctx, key, day) => store.read(ctx, key, day),
    increment: (ctx, key, day) => {
      raised += 1;
      return store.increment(ctx, key, day);
    },
  };
  return { quota, increments: () => raised };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('the policy in the write guard', () => {
  it('lets every write of the wiki through under the default policy, without counting', async () => {
    const { quota, increments } = watched();
    const { gate, ctx, events } = setup({ policy: defaultPolicy, quota });
    await gate.check(ctx, create, rulesOf('wiki_category', '12'), {}, 'commit');
    expect(increments()).toBe(0);
    expect(events).toEqual([]);
  });

  it('refuses every write outside the interactive mode', async () => {
    const { gate } = setup({ policy: defaultPolicy });
    const events: string[] = [];
    const error = await refusalOf(
      gate.check(
        contextOf(events, 'unattended'),
        create,
        rulesOf('wiki_category', '12'),
        {},
        'plan',
      ),
    );
    expect(error).toMatchObject({
      code: 'policy_denied',
      message: policySentences.notInteractive,
    });
    expect(events).toEqual(['warn:policy_not_interactive']);
  });

  it.each([
    ['a group', rulesOf('group', '9'), defaultPolicy, 'policy_queue_only'],
    [
      'an operation that always waits for approval',
      rulesOf('wiki_category', '12', true),
      defaultPolicy,
      'policy_queue_only',
    ],
    [
      'a target without an entry',
      rulesOf('wiki_category', '13'),
      limited,
      'policy_no_entry',
    ],
  ])(
    'sends %s to the queue when planning, and refuses it with the sentence for writes outside the policy when committing',
    async (_name, rules, policy, event) => {
      const { gate, ctx, events } = setup({ policy });
      expect(await gate.check(ctx, create, rules, {}, 'plan')).toBe(
        event.slice('policy_'.length),
      );
      const error = await refusalOf(
        gate.check(ctx, create, rules, {}, 'commit'),
      );
      expect(error).toMatchObject({
        code: 'policy_denied',
        message: policySentences.outside,
      });
      expect(events).toEqual([`warn:${event}`, `warn:${event}`]);
    },
  );

  it('reads the counter when planning and raises it when committing', async () => {
    const { gate, ctx, quota, names } = setup();
    const rules = rulesOf('wiki_category', '12');
    expect(await gate.check(ctx, create, rules, {}, 'plan')).toBeUndefined();
    expect(await counterOf(quota, ctx)).toBe(0);
    await gate.check(ctx, create, rules, {}, 'commit');
    await gate.check(ctx, create, rules, {}, 'commit');
    expect(await counterOf(quota, ctx)).toBe(2);
    expect(names).toEqual([12, 12, 12]);
  });

  it('sends a plan to the queue and refuses a commit once the limit of the day is reached', async () => {
    const { gate, ctx, quota, events } = setup();
    const rules = rulesOf('wiki_category', '12');
    await gate.check(ctx, create, rules, {}, 'commit');
    await gate.check(ctx, create, rules, {}, 'commit');
    expect(await gate.check(ctx, create, rules, {}, 'plan')).toBe(
      'limit_reached',
    );
    const error = await refusalOf(gate.check(ctx, create, rules, {}, 'commit'));
    expect(error).toMatchObject({
      code: 'policy_denied',
      message: policySentences.limitReached,
    });
    // A refused commit has taken its place all the same.
    expect(await counterOf(quota, ctx)).toBe(3);
    expect(events).toEqual([
      'warn:policy_limit_reached',
      'warn:policy_limit_reached',
    ]);
  });

  it.each([
    ['another name', 'Protokolle'],
    ['no name', undefined],
  ])('refuses a category with %s, without counting', async (_name, name) => {
    const { quota, increments } = watched();
    const { gate, ctx, events } = setup({
      quota,
      categoryName: () => Promise.resolve(name),
    });
    const error = await refusalOf(
      gate.check(ctx, create, rulesOf('wiki_category', '12'), {}, 'commit'),
    );
    expect(error.message).toBe(policySentences.nameChanged);
    expect(increments()).toBe(0);
    expect(events).toEqual(['warn:policy_name_changed']);
  });

  it('takes the name of a page from the facts of the write', async () => {
    const { gate, ctx, names } = setup();
    const rules = rulesOf('wiki_page', `12/${guid}`);
    expect(
      await gate.check(ctx, update, rules, { pageTitle: 'Dienstplan' }, 'plan'),
    ).toBeUndefined();
    expect(
      await gate.check(ctx, update, rules, { pageTitle: 'Alter Plan' }, 'plan'),
    ).toBe('name_changed');
    expect(await gate.check(ctx, update, rules, {}, 'plan')).toBe(
      'name_changed',
    );
    // The entry of the page replaces the one of its category.
    expect(names).toEqual([]);
  });

  // The name of a calendar comes from the client; a group has none yet,
  // since its writes come with the Pro module.
  it('reads the name of a calendar, and knows none of a group yet', async () => {
    const same = setup();
    expect(
      await same.gate.check(
        same.ctx,
        'ct_appointments_create',
        rulesOf('calendar', '3'),
        {},
        'plan',
      ),
    ).toBeUndefined();
    expect(same.names).toEqual([3]);
    const renamed = setup({
      calendarName: () => Promise.resolve('Andacht'),
    });
    expect(
      await renamed.gate.check(
        renamed.ctx,
        'ct_appointments_create',
        rulesOf('calendar', '3'),
        {},
        'plan',
      ),
    ).toBe('name_changed');
    const group = setup({
      policy: policyOf([
        {
          target: { kind: 'group', id: 7, name: 'Chor' },
          tools: ['ct_groups_add_member'],
          maxPerDay: 1,
        },
      ]),
    });
    expect(
      await group.gate.check(
        group.ctx,
        'ct_groups_add_member',
        rulesOf('group', '7'),
        {},
        'plan',
      ),
    ).toBe('name_changed');
  });

  it('passes on an error of the read of a name', async () => {
    const { gate, ctx, events } = setup({
      categoryName: () => Promise.reject(new Error('socket')),
    });
    await expect(
      gate.check(ctx, create, rulesOf('wiki_category', '12'), {}, 'plan'),
    ).rejects.toThrow('socket');
    expect(events).toEqual([]);
  });

  const failing = (
    read: QuotaStore['read'],
    increment: QuotaStore['increment'] = read,
  ): QuotaStore => ({ read, increment });

  it.each([
    ['no store', null, undefined],
    [
      'a store that fails',
      failing(() => Promise.reject(new Error('disk'))),
      undefined,
    ],
    [
      'a store that throws at once',
      failing(() => {
        throw new Error('disk');
      }),
      undefined,
    ],
    [
      'a store without a number',
      failing(() => Promise.resolve('7' as unknown as number)),
      undefined,
    ],
    ['a clock without a day', undefined, Number.NaN],
  ])(
    'cannot count with %s, so it queues a plan and refuses a commit',
    async (_name, quota, time) => {
      const { gate, ctx, events } = setup({
        ...(quota === undefined ? {} : { quota }),
        ...(time === undefined ? {} : { time }),
      });
      const rules = rulesOf('wiki_category', '12');
      expect(await gate.check(ctx, create, rules, {}, 'plan')).toBe(
        'count_unavailable',
      );
      const error = await refusalOf(
        gate.check(ctx, create, rules, {}, 'commit'),
      );
      expect(error).toMatchObject({
        code: 'policy_denied',
        message: policySentences.countUnavailable,
      });
      expect(events).toEqual([
        'warn:policy_count_unavailable',
        'warn:policy_count_unavailable',
      ]);
    },
  );

  it('does not wait longer than the time of a quota for its count', async () => {
    vi.useFakeTimers();
    const never = failing(() => new Promise<number>(() => undefined));
    const { gate, ctx } = setup({ quota: never });
    const checking = refusalOf(
      gate.check(ctx, create, rulesOf('wiki_category', '12'), {}, 'commit'),
    );
    await vi.advanceTimersByTimeAsync(quotaTimeoutMs);
    expect((await checking).message).toBe(policySentences.countUnavailable);
  });
});

describe('the sentences of the policy', () => {
  it('name no entry and no name the policy expects', () => {
    for (const sentence of Object.values(policySentences)) {
      expect(sentence).not.toMatch(/Berichte|Dienstplan|Gottesdienste/);
    }
  });
});
