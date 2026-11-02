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
 * The key of a counter of the policy (ADR 0032): how often one tool wrote
 * to one target of the policy, as `write:<tool>:<kind>:<ID>`, such as
 * `write:ct_wiki_page_create:wiki_category:12`. Only
 * {@link writeQuotaKey} makes one; the brand keeps any other string from
 * passing as one by accident.
 */
export type WriteQuotaKey = string & { readonly __ecclium: 'WriteQuotaKey' };

/**
 * What a counter counts: the calls of the tools in the read budget, which
 * share one budget per actor and day, or the writes of one tool to one
 * target of the policy.
 */
export type QuotaKey = 'special_reads' | WriteQuotaKey;

/** The keys with a fixed name, frozen. */
export const quotaKeys: readonly QuotaKey[] = Object.freeze(['special_reads']);

// A tool, a kind of target of the policy and its ID: a whole number, and
// for a page the category and the GUID in lower case, for a service the
// event and the service. Anchored, without flags, so no lastIndex is shared.
const writeQuotaKeyPattern =
  /^write:ct_[a-z0-9_]{1,60}:(?:(?:wiki_category|calendar|resource|group):[1-9]\d{0,9}|wiki_page:[1-9]\d{0,9}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|service:[1-9]\d{0,9}\/[1-9]\d{0,9})$/;

/** The longest key of a counter of the policy. */
export const maxWriteQuotaKeyLength = 128;

/**
 * Tells whether a value is the key of a counter: `special_reads` or a key
 * of a counter of the policy. A store checks every key itself before it
 * counts under it.
 *
 * @param value - Any value.
 * @returns Whether it is such a key.
 * @example
 * ```ts
 * isQuotaKey('special_reads'); // true
 * isQuotaKey('write:ct_wiki_page_create:wiki_category:12'); // true
 * isQuotaKey('write:../x'); // false
 * ```
 */
export function isQuotaKey(value: unknown): value is QuotaKey {
  return (
    typeof value === 'string' &&
    ((quotaKeys as readonly string[]).includes(value) ||
      (value.length <= maxWriteQuotaKeyLength &&
        writeQuotaKeyPattern.test(value)))
  );
}

/**
 * Builds the key of a counter of the policy from a tool and the key of a
 * target, such as `wiki_category:12`, `wiki_page:12/<GUID>` or
 * `service:5/7`.
 *
 * @param tool - The name of the tool.
 * @param target - The key of the target, with a GUID in lower case.
 * @returns The key.
 * @throws {TypeError} When the result is no key of a counter.
 * @example
 * ```ts
 * writeQuotaKey('ct_wiki_page_create', 'wiki_category:12');
 * // 'write:ct_wiki_page_create:wiki_category:12'
 * ```
 */
export function writeQuotaKey(tool: string, target: string): WriteQuotaKey {
  const key = `write:${tool}:${target}`;
  if (!isQuotaKey(key)) {
    throw new TypeError('The key of the counter is invalid.');
  }
  return key as WriteQuotaKey;
}

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
