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
import { addRunWrite, createRunWrites, runWriteCount } from './run-writes.js';

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

// A write of a run of a routine (ADR 0032): the entries of its routine in
// the unattended part decide, with the counter of the writes of the run
// besides the counter of the day.
describe('the policy in the write guard for a run of a routine', () => {
  const append = 'ct_wiki_page_append_section';
  const berichte = { kind: 'wiki_category', id: 12, name: 'Berichte' };
  const routines = (() => {
    const result = checkPolicy({
      schema: 'policy.v1',
      interactive: {
        targets: [{ target: berichte, tools: [append], maxPerDay: 10 }],
      },
      unattended: [
        {
          routine: 'dienstplan-report',
          credential: 'bericht',
          target: berichte,
          tools: [append],
          maxPerRun: 2,
          maxPerDay: 3,
        },
        {
          routine: 'wiki-hygiene',
          credential: 'bericht',
          target: berichte,
          tools: [append],
          maxPerRun: 1,
          maxPerDay: 3,
        },
      ],
    });
    if (!result.ok) throw new Error(result.code);
    return result.policy;
  })();
  const counter = writeQuotaKey(append, 'wiki_category:12');
  const rules = rulesOf('wiki_category', '12');

  const runSetup = (
    options: {
      mode?: Mode;
      categoryName?: () => Promise<string | undefined>;
      quota?: QuotaStore;
    } = {},
  ) => {
    const watching = watched();
    const quota = options.quota ?? watching.quota;
    const base = setup({
      policy: routines,
      quota,
      ...(options.categoryName === undefined
        ? {}
        : { categoryName: options.categoryName }),
    });
    const events: string[] = [];
    const ctx = contextOf(events, options.mode ?? 'unattended');
    const day = isoDateOf(now);
    if (day === undefined) throw new Error('expected a day');
    const dayCount = () => quota.read(ctx, counter, day);
    return { ...base, ctx, events, dayCount, increments: watching.increments };
  };

  it('reads the counter of the run when planning and adds to it when committing', async () => {
    const { gate, ctx, events, dayCount, names } = runSetup();
    const run = { routine: 'dienstplan-report', runWrites: createRunWrites() };
    expect(
      await gate.check(ctx, append, rules, {}, 'plan', run),
    ).toBeUndefined();
    expect(runWriteCount(run.runWrites, counter)).toBe(0);
    expect(await dayCount()).toBe(0);
    await gate.check(ctx, append, rules, {}, 'commit', run);
    expect(runWriteCount(run.runWrites, counter)).toBe(1);
    expect(await dayCount()).toBe(1);
    await gate.check(ctx, append, rules, {}, 'commit', run);
    expect(runWriteCount(run.runWrites, counter)).toBe(2);
    expect(await dayCount()).toBe(2);
    expect(names).toEqual([12, 12, 12]);
    expect(events).toEqual([]);
  });

  it('stops at the limit of the run, and a write beyond it costs no place of the day', async () => {
    const { gate, ctx, events, dayCount, increments } = runSetup();
    const run = { routine: 'dienstplan-report', runWrites: createRunWrites() };
    await gate.check(ctx, append, rules, {}, 'commit', run);
    await gate.check(ctx, append, rules, {}, 'commit', run);
    expect(await gate.check(ctx, append, rules, {}, 'plan', run)).toBe(
      'limit_reached',
    );
    const error = await refusalOf(
      gate.check(ctx, append, rules, {}, 'commit', run),
    );
    expect(error).toMatchObject({
      code: 'policy_denied',
      message: policySentences.limitReached,
    });
    // The refused commit took its place in the run, not in the day.
    expect(runWriteCount(run.runWrites, counter)).toBe(3);
    expect(await dayCount()).toBe(2);
    expect(increments()).toBe(2);
    expect(events).toEqual([
      'warn:policy_limit_reached',
      'warn:policy_limit_reached',
    ]);
  });

  it('starts each run at 0 and holds the limit of the day across runs', async () => {
    const { gate, ctx, dayCount } = runSetup();
    const first = {
      routine: 'dienstplan-report',
      runWrites: createRunWrites(),
    };
    await gate.check(ctx, append, rules, {}, 'commit', first);
    await gate.check(ctx, append, rules, {}, 'commit', first);
    const second = {
      routine: 'dienstplan-report',
      runWrites: createRunWrites(),
    };
    expect(
      await gate.check(ctx, append, rules, {}, 'plan', second),
    ).toBeUndefined();
    await gate.check(ctx, append, rules, {}, 'commit', second);
    expect(await dayCount()).toBe(3);
    // The run is under its limit, the day is at its own.
    expect(await gate.check(ctx, append, rules, {}, 'plan', second)).toBe(
      'limit_reached',
    );
    const error = await refusalOf(
      gate.check(ctx, append, rules, {}, 'commit', second),
    );
    expect(error.message).toBe(policySentences.limitReached);
    expect(runWriteCount(second.runWrites, counter)).toBe(2);
    expect(await dayCount()).toBe(4);
  });

  it('takes the limit per run of the entry of its own routine', async () => {
    const { gate, ctx } = runSetup();
    const run = { routine: 'wiki-hygiene', runWrites: createRunWrites() };
    await gate.check(ctx, append, rules, {}, 'commit', run);
    expect(await gate.check(ctx, append, rules, {}, 'plan', run)).toBe(
      'limit_reached',
    );
  });

  it('sends a write of a routine without entries to the queue, also where the interactive part has one', async () => {
    const { gate, ctx, events, increments } = runSetup();
    const run = { routine: 'kalender-report', runWrites: createRunWrites() };
    expect(await gate.check(ctx, append, rules, {}, 'plan', run)).toBe(
      'no_entry',
    );
    const error = await refusalOf(
      gate.check(ctx, append, rules, {}, 'commit', run),
    );
    expect(error.message).toBe(policySentences.outside);
    expect(runWriteCount(run.runWrites, counter)).toBe(0);
    expect(increments()).toBe(0);
    expect(events).toEqual(['warn:policy_no_entry', 'warn:policy_no_entry']);
  });

  it('cannot count a run without its counter, so it queues a plan and refuses a commit', async () => {
    const { gate, ctx, events, increments } = runSetup();
    const run = { routine: 'dienstplan-report' };
    expect(await gate.check(ctx, append, rules, {}, 'plan', run)).toBe(
      'count_unavailable',
    );
    const error = await refusalOf(
      gate.check(ctx, append, rules, {}, 'commit', run),
    );
    expect(error.message).toBe(policySentences.countUnavailable);
    expect(increments()).toBe(0);
    expect(events).toEqual([
      'warn:policy_count_unavailable',
      'warn:policy_count_unavailable',
    ]);
  });

  it('counts a write to a renamed target neither in the run nor in the day', async () => {
    const { gate, ctx, increments } = runSetup({
      categoryName: () => Promise.resolve('Archiv'),
    });
    const run = { routine: 'dienstplan-report', runWrites: createRunWrites() };
    const error = await refusalOf(
      gate.check(ctx, append, rules, {}, 'commit', run),
    );
    expect(error.message).toBe(policySentences.nameChanged);
    expect(runWriteCount(run.runWrites, counter)).toBe(0);
    expect(increments()).toBe(0);
  });

  it('refuses a write in the mode unattended without its run', async () => {
    const { gate, ctx, events } = runSetup();
    const error = await refusalOf(gate.check(ctx, append, rules, {}, 'plan'));
    expect(error.message).toBe(policySentences.notInteractive);
    expect(events).toEqual(['warn:policy_not_interactive']);
  });

  it('approves a write a run queued against the entries of its routine, counting only the day', async () => {
    const { gate, ctx, events, dayCount, names } = runSetup({
      mode: 'operator',
      categoryName: () => Promise.resolve('Archiv'),
    });
    const runWrites = createRunWrites();
    // At the limit of the run and with another name: the approval of the
    // operator stands in for both.
    addRunWrite(runWrites, counter);
    addRunWrite(runWrites, counter);
    expect(
      await gate.check(ctx, append, rules, {}, 'approve', {
        routine: 'dienstplan-report',
        runWrites,
      }),
    ).toBeUndefined();
    expect(
      await gate.check(ctx, append, rules, {}, 'approve', {
        routine: 'dienstplan-report',
      }),
    ).toBeUndefined();
    expect(await dayCount()).toBe(2);
    expect(runWriteCount(runWrites, counter)).toBe(2);
    expect(names).toEqual([]);
    expect(events).toEqual([]);
  });

  it('approves a write of a routine without entries without counting, and any other against the interactive part', async () => {
    const { gate, ctx, dayCount, increments } = runSetup({ mode: 'operator' });
    expect(
      await gate.check(ctx, append, rules, {}, 'approve', {
        routine: 'kalender-report',
      }),
    ).toBeUndefined();
    expect(increments()).toBe(0);
    // Without a run the wish is judged in the interactive mode, whose entry
    // counts the same counter of the day.
    expect(await gate.check(ctx, append, rules, {}, 'approve')).toBeUndefined();
    expect(await dayCount()).toBe(1);
    expect(
      await gate.check(
        ctx,
        append,
        rulesOf('wiki_category', '13'),
        {},
        'approve',
      ),
    ).toBeUndefined();
    expect(increments()).toBe(1);
  });

  it('approves a write of a run whose count fails, and says so', async () => {
    const { gate, ctx, events } = runSetup({
      mode: 'operator',
      quota: {
        read: () => Promise.reject(new Error('disk')),
        increment: () => Promise.reject(new Error('disk')),
      },
    });
    expect(
      await gate.check(ctx, append, rules, {}, 'approve', {
        routine: 'dienstplan-report',
      }),
    ).toBeUndefined();
    expect(events).toEqual(['warn:policy_count_unavailable']);
  });
});

describe('the sentences of the policy', () => {
  it('name no entry and no name the policy expects', () => {
    for (const sentence of Object.values(policySentences)) {
      expect(sentence).not.toMatch(/Berichte|Dienstplan|Gottesdienste/);
    }
  });
});
