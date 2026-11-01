import type {
  Clock,
  NonceStore,
  PlannedWrite,
  PlanStore,
  TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';
import { describe, expect, it } from 'vitest';

import {
  createTestClock,
  nonceStoreChecks,
  type OpenNonceStore,
  type OpenPlanStore,
  planStoreChecks,
  stubPlan,
  type WriteStoreCheck,
} from './index.js';

// The checks must pass for a store that keeps its promises and fail for
// one that breaks any of them, or they show nothing. The stores here are
// small on purpose; the stores of the core run the same checks in core.

interface Faults {
  /** Gives a plan back on every take, or calls every nonce fresh. */
  readonly repeats?: boolean;
  /** Looks only at the hash or the nonce, not at tenant and actor. */
  readonly ignoresTenant?: boolean;
  /** Looks only at tenant and actor, not at the hash or the nonce. */
  readonly ignoresValue?: boolean;
  /** Keeps every entry forever. */
  readonly neverExpires?: boolean;
  /** Keeps every entry for the longest time, whatever time it is given. */
  readonly ignoresTtl?: boolean;
  /** Forgets every entry at once. */
  readonly forgets?: boolean;
  /** Takes any time and any nonce. */
  readonly loose?: boolean;
  /** Takes any number of entries. */
  readonly unbounded?: boolean;
  /** Makes room by dropping the oldest entry when full. */
  readonly evicts?: boolean;
  /** Reads and changes an entry in two turns of the event loop. */
  readonly racy?: boolean;
}

// The longest times of ADR 0029.
const planTtl = 600_000;
const nonceTtl = 660_000;

const keyOf = (ctx: TenantContext, value: string, faults: Faults): string =>
  faults.ignoresTenant === true
    ? value
    : JSON.stringify([
        ctx.tenantId,
        ctx.actor.kind,
        ctx.actor.id,
        faults.ignoresValue === true ? '' : value,
      ]);

const checkTtl = (ttl: number, max: number, faults: Faults): void => {
  if (
    faults.loose !== true &&
    (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > max)
  ) {
    throw new TypeError('bad ttl');
  }
};

const untilOf = (now: number, ttl: number, max: number, faults: Faults) =>
  faults.neverExpires === true
    ? Infinity
    : now + (faults.ignoresTtl === true ? max : ttl);

// Whether a store over these entries has room for a new key, after it
// dropped the oldest entry if it makes room that way.
const room = <Value>(
  entries: Map<string, Value>,
  capacity: number,
  faults: Faults,
): boolean => {
  if (faults.unbounded === true || entries.size < capacity) return true;
  if (faults.evicts !== true) return false;
  const [oldest] = entries.keys();
  if (oldest !== undefined) entries.delete(oldest);
  return true;
};

const planStore = (
  clock: Clock,
  capacity: number,
  faults: Faults = {},
): PlanStore => {
  const plans = new Map<
    string,
    { readonly plan: PlannedWrite; readonly until: number }
  >();
  return {
    put: (ctx, hash, plan, ttl) =>
      Promise.resolve().then(() => {
        checkTtl(ttl, planTtl, faults);
        const now = clock.now();
        for (const [key, entry] of plans) {
          if (!(now < entry.until)) plans.delete(key);
        }
        const key = keyOf(ctx, hash, faults);
        if (!plans.has(key) && !room(plans, capacity, faults)) return 'full';
        if (faults.forgets !== true) {
          plans.set(key, { plan, until: untilOf(now, ttl, planTtl, faults) });
        }
        return 'stored' as const;
      }),
    take: async (ctx, hash) => {
      const key = keyOf(ctx, hash, faults);
      const entry = plans.get(key);
      // Another call runs here and sees the same entry.
      if (faults.racy === true) await Promise.resolve();
      if (faults.repeats !== true) plans.delete(key);
      return entry !== undefined && clock.now() < entry.until
        ? entry.plan
        : undefined;
    },
  };
};

const nonceStore = (
  clock: Clock,
  capacity: number,
  faults: Faults = {},
): NonceStore => {
  const used = new Map<string, number>();
  return {
    consume: async (ctx, nonce, ttl) => {
      checkTtl(ttl, nonceTtl, faults);
      if (faults.loose !== true && nonce === '') throw new TypeError('');
      const now = clock.now();
      const key = keyOf(ctx, nonce, faults);
      const until = used.get(key);
      // Another call runs here and sees the same entry.
      if (faults.racy === true) await Promise.resolve();
      if (faults.repeats !== true && until !== undefined && now < until) {
        return 'replayed';
      }
      if (!used.has(key) && !room(used, capacity, faults)) return 'replayed';
      if (faults.forgets !== true) {
        used.set(key, untilOf(now, ttl, nonceTtl, faults));
      }
      return 'fresh';
    },
  };
};

const fails = async <Open>(
  checks: readonly WriteStoreCheck<Open>[],
  open: Open,
): Promise<string[]> => {
  const failed: string[] = [];
  for (const { name, run } of checks) {
    await run(open).catch(() => {
      failed.push(name);
    });
  }
  return failed;
};

describe('the checks of a store of plans', () => {
  it.each(planStoreChecks)(
    '$name: passes for a sound store',
    async ({ run }) => {
      await run((clock, capacity) => planStore(clock, capacity));
    },
  );

  it.each<[string, Faults, string]>([
    ['gives a plan twice', { repeats: true }, 'gives a plan back once'],
    ['mixes tenants', { ignoresTenant: true }, 'keeps tenants and actors'],
    ['mixes hashes', { ignoresValue: true }, 'apart by their hash'],
    ['keeps plans forever', { neverExpires: true }, 'never after'],
    ['keeps plans longer than told', { ignoresTtl: true }, 'only for the time'],
    ['forgets plans at once', { forgets: true }, 'gives a plan back once'],
    ['takes any time', { loose: true }, 'refuses a time'],
    ['never fills up', { unbounded: true }, 'answers full'],
    ['drops the oldest plan when full', { evicts: true }, 'answers full'],
    ['lets two takes get the same plan', { racy: true }, 'only one of many'],
  ])('fail for a store that %s', async (_name, faults, expected) => {
    const open: OpenPlanStore = (clock, capacity) =>
      planStore(clock, capacity, faults);
    const failed = await fails(planStoreChecks, open);
    expect(failed.some((name) => name.includes(expected))).toBe(true);
  });

  it('are frozen', () => {
    expect(Object.isFrozen(planStoreChecks)).toBe(true);
    expect(planStoreChecks.every((entry) => Object.isFrozen(entry))).toBe(true);
  });
});

describe('the checks of a store of nonces', () => {
  it.each(nonceStoreChecks)(
    '$name: passes for a sound store',
    async ({ run }) => {
      await run((clock, capacity) => nonceStore(clock, capacity));
    },
  );

  it.each<[string, Faults, string]>([
    ['calls every nonce fresh', { repeats: true }, 'takes a nonce once'],
    ['mixes tenants', { ignoresTenant: true }, 'keeps tenants and actors'],
    ['mixes nonces', { ignoresValue: true }, 'takes a nonce once'],
    ['forgets nonces at once', { forgets: true }, 'whole time'],
    ['takes any nonce and time', { loose: true }, 'refuses an empty nonce'],
    ['never fills up', { unbounded: true }, 'used when full'],
    ['drops the oldest nonce when full', { evicts: true }, 'used when full'],
    ['lets two uses be fresh', { racy: true }, 'only one of many'],
  ])('fail for a store that %s', async (_name, faults, expected) => {
    const open: OpenNonceStore = (clock, capacity) =>
      nonceStore(clock, capacity, faults);
    const failed = await fails(nonceStoreChecks, open);
    expect(failed.some((name) => name.includes(expected))).toBe(true);
  });

  it('are frozen', () => {
    expect(Object.isFrozen(nonceStoreChecks)).toBe(true);
  });
});

describe('the clock for tests', () => {
  it('moves only when told, and only forward', () => {
    const clock = createTestClock(1_000);
    expect(clock.now()).toBe(1_000);
    clock.advance(500);
    expect(clock.now()).toBe(1_500);
    for (const ms of [-1, 0.5, Number.NaN]) {
      expect(() => {
        clock.advance(ms);
      }).toThrow(TypeError);
    }
    expect(clock.now()).toBe(1_500);
    expect(Object.isFrozen(clock)).toBe(true);
  });

  it('stands in for a plan with a frozen value', () => {
    expect(Object.isFrozen(stubPlan('a'))).toBe(true);
    expect(stubPlan('a')).not.toBe(stubPlan('a'));
  });
});
