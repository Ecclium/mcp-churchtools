/**
 * The store of plans of the free core (ADR 0029): sealed plans in memory,
 * between planning and committing.
 *
 * Where it stands in the way of a write: a tool plans, the core seals the
 * plan and, for a confirmation that takes a second round, keeps it here
 * until the answer comes back. Then the core takes it out, once, and
 * commits it. A plan carries the content it would write, so it never goes
 * to a file (ADR 0051): a restart loses every open plan, and nothing is
 * written without one. Each plan is bound to the tenant and the actor of
 * the call that planned it and lives as long as the requestState of the
 * confirmation.
 *
 * Only the composition root may build it, through the subpath
 * `./composition` of core, and hand it to the pipeline; it does so once
 * the confirmation needs a second round. The store keeps no state at
 * module level. A plugin may bring another store that passes the same
 * checks of testkit.
 *
 * @packageDocumentation
 */
import type {
  Clock,
  PlannedWrite,
  PlanStore,
  TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';

/**
 * How long a plan can be taken: 600 seconds, as long as the requestState
 * of a confirmation (ADR 0029).
 */
export const planTtlMs = 600_000;

/**
 * How many open plans one process keeps at most. A plan beyond that is
 * refused until older ones expire, so that no client fills the memory of
 * the server with plans it never confirms.
 */
export const maxOpenPlans = 100;

// A plan hash of the core: SHA-256 in lowercase hex.
const planHashPattern = /^[0-9a-f]{64}$/;

const checkHash = (planHash: string): void => {
  if (typeof planHash !== 'string' || !planHashPattern.test(planHash)) {
    throw new TypeError('A plan hash is 64 lowercase hex digits.');
  }
};

/** One plan with the time until which it can be taken. */
interface Kept {
  readonly plan: PlannedWrite;
  readonly until: number;
}

/**
 * Makes the store of plans in memory.
 *
 * @param clock - The clock that decides when a plan expires.
 * @param capacity - How many open plans it keeps at most; {@link maxOpenPlans}
 *   unless a test sets fewer.
 * @returns The store, frozen.
 * @throws {TypeError} When the capacity is no whole number from 1.
 * @example
 * ```ts
 * const plans = createMemoryPlanStore(systemClock);
 * await plans.put(ctx, planHash, plan, planTtlMs); // 'stored'
 * await plans.take(ctx, planHash); // the plan, once
 * ```
 */
export function createMemoryPlanStore(
  clock: Clock,
  capacity: number = maxOpenPlans,
): PlanStore {
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new TypeError('The capacity is a whole number from 1.');
  }
  const kept = new Map<string, Kept>();

  // Tenant, kind and ID of the actor and the hash, as one key that no
  // value of one part can shift into another.
  const keyOf = (ctx: TenantContext, planHash: string): string =>
    JSON.stringify([ctx.tenantId, ctx.actor.kind, ctx.actor.id, planHash]);

  // A clock that throws or gives no finite number lets no plan out.
  const now = (): number => {
    const value = clock.now();
    if (!Number.isFinite(value)) throw new TypeError('The clock failed.');
    return value;
  };

  const sweep = (at: number): void => {
    for (const [key, entry] of kept) {
      if (!(at < entry.until)) kept.delete(key);
    }
  };

  return Object.freeze({
    // Each method runs whole in one turn of the event loop, so two calls
    // at the same time never see a half change.
    put: (
      ctx: TenantContext,
      planHash: string,
      plan: PlannedWrite,
      ttlMs: number,
    ): Promise<'stored' | 'full'> =>
      Promise.resolve().then(() => {
        checkHash(planHash);
        if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > planTtlMs) {
          throw new TypeError('A plan lives from 1 ms up to its whole time.');
        }
        const at = now();
        sweep(at);
        const key = keyOf(ctx, planHash);
        // The same hash for the same tenant and actor is the same plan,
        // so it takes the place of the one before and counts once.
        if (!kept.has(key) && kept.size >= capacity) return 'full';
        kept.set(key, { plan, until: at + ttlMs });
        return 'stored';
      }),
    take: (
      ctx: TenantContext,
      planHash: string,
    ): Promise<PlannedWrite | undefined> =>
      Promise.resolve().then(() => {
        checkHash(planHash);
        const key = keyOf(ctx, planHash);
        const entry = kept.get(key);
        // Taken once, also when it expired.
        kept.delete(key);
        return entry !== undefined && now() < entry.until
          ? entry.plan
          : undefined;
      }),
  });
}
