/**
 * The port for quotas (ADR 0063): counters that outlive a request, such as
 * the daily read budget of the tools with sensitivity special. The free
 * core keeps them in a file; a plugin may bring another store, which must
 * pass the same checks as the store of the core.
 *
 * @packageDocumentation
 */
import type { TenantContext } from './context.js';

/**
 * What a counter counts. Today there is one: the calls of tools with
 * sensitivity special, which share one budget per actor and day.
 */
export type QuotaKey = 'special_reads';

/** Every {@link QuotaKey}, frozen, for checks at run time. */
export const quotaKeys: readonly QuotaKey[] = Object.freeze(['special_reads']);

/**
 * A day in UTC as `YYYY-MM-DD`, such as `2026-10-24`. The brand keeps a
 * string that was not checked from passing as a day by accident.
 */
export type IsoDate = string & { readonly __ecclium: 'IsoDate' };

// Anchored, without flags, so no lastIndex is shared between callers.
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Tells whether a value is a day of the calendar as `YYYY-MM-DD`, from
 * 1970 to 9999. A store checks every day itself before it builds a name
 * of a file or a key from it.
 *
 * @param value - Any value.
 * @returns Whether it is such a day.
 * @example
 * ```ts
 * isIsoDate('2026-10-24'); // true
 * isIsoDate('2026-02-30'); // false
 * ```
 */
export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== 'string' || !isoDatePattern.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1970) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * Counters only, never content (ADR 0051, ADR 0063). Each counter belongs
 * to the tenant and the actor of the context, a key and a day; a store
 * takes them from the context and from nothing a tool hands over. A
 * counter survives a restart and is shared by every process that uses the
 * same store.
 */
export interface QuotaStore {
  /**
   * Adds one to a counter.
   *
   * @param ctx - The context of the call, for tenant and actor.
   * @param key - What is counted.
   * @param day - The day in UTC.
   * @returns The counter after this call, 1 or more.
   */
  increment(ctx: TenantContext, key: QuotaKey, day: IsoDate): Promise<number>;
  /**
   * Reads a counter without changing it.
   *
   * @param ctx - The context of the call, for tenant and actor.
   * @param key - What is counted.
   * @param day - The day in UTC.
   * @returns The counter, 0 when nothing was counted.
   */
  read(ctx: TenantContext, key: QuotaKey, day: IsoDate): Promise<number>;
}
