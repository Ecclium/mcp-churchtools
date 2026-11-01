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
  /** Keeps every entry forever. */
  readonly neverExpires?: boolean;
  /** Forgets every entry at once. */
  readonly forgets?: boolean;
  /** Takes any time and any nonce. */
  readonly loose?: boolean;
}

const keyOf = (ctx: TenantContext, value: string, faults: Faults): string =>
  faults.ignoresTenant === true
    ? value
    : JSON.stringify([ctx.tenantId, ctx.actor.kind, ctx.actor.id, value]);

const checkTtl = (ttl: number, faults: Faults): void => {
  if (faults.loose !== true && (!Number.isSafeInteger(ttl) || ttl < 1)) {
    throw new TypeError('bad ttl');
  }
};

const planStore = (clock: Clock, faults: Faults = {}): PlanStore => {
  const plans = new Map<
    string,
    { readonly plan: PlannedWrite; readonly until: number }
  >();
  return {
    put: (ctx, hash, plan, ttl) =>
      Promise.resolve().then(() => {
        checkTtl(ttl, faults);
        if (faults.forgets !== true) {
          plans.set(keyOf(ctx, hash, faults), {
            plan,
            until: faults.neverExpires === true ? Infinity : clock.now() + ttl,
          });
        }
        return 'stored' as const;
      }),
    take: (ctx, hash) =>
      Promise.resolve().then(() => {
        const key = keyOf(ctx, hash, faults);
        const entry = plans.get(key);
        if (faults.repeats !== true) plans.delete(key);
        return entry !== undefined && clock.now() < entry.until
          ? entry.plan
          : undefined;
      }),
  };
};

const nonceStore = (clock: Clock, faults: Faults = {}): NonceStore => {
  const used = new Map<string, number>();
  return {
    consume: (ctx, nonce, ttl) =>
      Promise.resolve().then(() => {
        checkTtl(ttl, faults);
        if (faults.loose !== true && nonce === '') throw new TypeError('');
        const key = keyOf(ctx, nonce, faults);
        const until = used.get(key);
        if (faults.repeats !== true && until !== undefined) {
          if (clock.now() < until) return 'replayed' as const;
        }
        if (faults.forgets !== true) {
          used.set(
            key,
            faults.neverExpires === true ? Infinity : clock.now() + ttl,
          );
        }
        return 'fresh' as const;
      }),
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
      await run((clock) => planStore(clock));
    },
  );

  it.each<[string, Faults, string]>([
    ['gives a plan twice', { repeats: true }, 'gives a plan back once'],
    ['mixes tenants', { ignoresTenant: true }, 'keeps tenants and actors'],
    ['keeps plans forever', { neverExpires: true }, 'never after'],
    ['forgets plans at once', { forgets: true }, 'gives a plan back once'],
    ['takes any time', { loose: true }, 'refuses a time'],
  ])('fail for a store that %s', async (_name, faults, expected) => {
    const open: OpenPlanStore = (clock) => planStore(clock, faults);
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
      await run((clock) => nonceStore(clock));
    },
  );

  it.each<[string, Faults, string]>([
    ['calls every nonce fresh', { repeats: true }, 'takes a nonce once'],
    ['mixes tenants', { ignoresTenant: true }, 'keeps tenants and actors'],
    ['forgets nonces at once', { forgets: true }, 'whole time'],
    ['takes any nonce and time', { loose: true }, 'refuses an empty nonce'],
  ])('fail for a store that %s', async (_name, faults, expected) => {
    const open: OpenNonceStore = (clock) => nonceStore(clock, faults);
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
