/**
 * The port for quotas (ADR 0063): counters that outlive a request, such as
 * the daily read budget of the tools with sensitivity special, the writes
 * of the policy and the decisions about entries of the queue of approvals.
 * The free core keeps them in a file; a plugin may bring another store,
 * which must pass the same checks as the store of the core.
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
 * The key of the counter of a decision about an entry of the queue of
 * approvals (ADR 0029): `approval:` and a SHA-256 in lowercase hex, which
 * the core makes from the ID of the entry and the hash of its plan. An
 * approval and a rejection count under the same key, and only the call
 * that counts 1 decides, so that no entry is decided twice, also after a
 * restart and with a queue of a plugin that offers an entry again. Only
 * {@link approvalQuotaKey} makes one.
 */
export type ApprovalQuotaKey = string & {
  readonly __ecclium: 'ApprovalQuotaKey';
};

/**
 * The key of a counter of the memory of runs (ADR 0034): for one trigger
 * of a routine, whether a run closed it (`done`), how many runs tried it
 * (`tries`), and whether a run began in a window of 15 minutes since the
 * trigger (`try:<window>`), as `run:<routine>:<trigger>:<counter>` with
 * the trigger in UTC to the minute, such as
 * `run:dienstplan-report:20261109T0500:done`. Only {@link runQuotaKey}
 * makes one.
 */
export type RunQuotaKey = string & { readonly __ecclium: 'RunQuotaKey' };

/**
 * What a counter counts: the calls of the tools in the read budget, which
 * share one budget per actor and day, the writes of one tool to one
 * target of the policy, the decisions about one entry of the queue, or
 * the runs of one trigger of a routine.
 */
export type QuotaKey =
  'special_reads' | WriteQuotaKey | ApprovalQuotaKey | RunQuotaKey;

/** The keys with a fixed name, frozen. */
export const quotaKeys: readonly QuotaKey[] = Object.freeze(['special_reads']);

// A tool, a kind of target of the policy and its ID: a whole number, and
// for a page the category and the GUID in lower case, for a service the
// event and the service. Anchored, without flags, so no lastIndex is shared.
const writeQuotaKeyPattern =
  /^write:ct_[a-z0-9_]{1,60}:(?:(?:wiki_category|calendar|resource|group):[1-9]\d{0,9}|wiki_page:[1-9]\d{0,9}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|service:[1-9]\d{0,9}\/[1-9]\d{0,9})$/;

/** The longest key of a counter of the policy. */
export const maxWriteQuotaKeyLength = 128;

// The hash of the entry and its plan, in lowercase hex. Anchored, without
// flags.
const approvalQuotaKeyPattern = /^approval:[0-9a-f]{64}$/;

/**
 * How many days after its own day a store keeps the counter of a decision
 * at least: the 14 days an entry of the queue waits and one more, so that
 * a decision is never forgotten while its entry can still be approved.
 * Other counters may go once their day is over.
 */
export const approvalCountDays = 15;

/**
 * Tells whether a value is the key of the counter of a decision about an
 * entry of the queue. A store counts under such a key for the tenant
 * alone and keeps it {@link approvalCountDays} days.
 *
 * @param value - Any value.
 * @returns Whether it is such a key.
 * @example
 * ```ts
 * isApprovalQuotaKey(`approval:${'a'.repeat(64)}`); // true
 * isApprovalQuotaKey('special_reads'); // false
 * ```
 */
export function isApprovalQuotaKey(value: unknown): value is ApprovalQuotaKey {
  return typeof value === 'string' && approvalQuotaKeyPattern.test(value);
}

/**
 * Builds the key of the counter of a decision from the hash the core made
 * of the ID of the entry and the hash of its plan.
 *
 * @param hash - SHA-256 in lowercase hex.
 * @returns The key.
 * @throws {TypeError} When the hash has another form.
 * @example
 * ```ts
 * approvalQuotaKey('a'.repeat(64)); // 'approval:aaaa…'
 * ```
 */
export function approvalQuotaKey(hash: string): ApprovalQuotaKey {
  const key = `approval:${hash}`;
  if (!isApprovalQuotaKey(key)) {
    throw new TypeError('The key of the counter is invalid.');
  }
  return key;
}

// The ID of a routine, its trigger in UTC to the minute and the counter,
// the window a number from 0 without a leading zero. Anchored, without
// flags.
const runQuotaKeyPattern =
  /^run:[a-z0-9][a-z0-9-]{0,62}:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2}):(?:done|tries|try:(0|[1-9]\d{0,3}))$/;

/**
 * How many days after the day of its trigger a store keeps a counter of
 * the memory of runs at least: the 31 days in which a trigger can still
 * be due and one more. Other counters may go once their day is over.
 */
export const runCountDays = 32;

/**
 * How many windows of 15 minutes the counters of a trigger may name: as
 * many as fit into {@link runCountDays}.
 */
export const runWindowCount: number = runCountDays * 96;

// The parts of a key of the memory of runs, or undefined: the UTC day of
// its trigger and the window, if it names one.
const runKeyParts = (
  value: unknown,
): { readonly day: string; readonly window?: number } | undefined => {
  if (typeof value !== 'string') return undefined;
  const match = runQuotaKeyPattern.exec(value);
  if (match === null) return undefined;
  const [, year, month, day, hour, minute, window] = match;
  const day10 = `${String(year)}-${String(month)}-${String(day)}`;
  if (!isIsoDate(day10) || Number(hour) > 23 || Number(minute) > 59) {
    return undefined;
  }
  if (window === undefined) return { day: day10 };
  const index = Number(window);
  return index < runWindowCount ? { day: day10, window: index } : undefined;
};

// The last trigger a key can name: 31.12.9999, 23:59 UTC.
const lastRunTrigger = Date.UTC(9999, 11, 31, 23, 59);

/**
 * Tells whether a value is the key of a counter of the memory of runs. A
 * store counts under such a key for the tenant alone, under the UTC day
 * of its trigger only, and keeps it {@link runCountDays} days.
 *
 * @param value - Any value.
 * @returns Whether it is such a key.
 * @example
 * ```ts
 * isRunQuotaKey('run:dienstplan-report:20261109T0500:done'); // true
 * isRunQuotaKey('run:dienstplan-report:20261109T2460:done'); // false
 * ```
 */
export function isRunQuotaKey(value: unknown): value is RunQuotaKey {
  return runKeyParts(value) !== undefined;
}

/**
 * The UTC day of the trigger of a key of the memory of runs, the only day
 * a store counts it under.
 *
 * @param key - A key of the memory of runs.
 * @returns The day.
 * @throws {TypeError} When the key is no such key.
 * @example
 * ```ts
 * runQuotaDayOf(runQuotaKey('dienstplan-report', Date.UTC(2026, 10, 9, 5), 'done'));
 * // '2026-11-09'
 * ```
 */
export function runQuotaDayOf(key: RunQuotaKey): IsoDate {
  const parts = runKeyParts(key);
  if (parts === undefined) {
    throw new TypeError('The key of the counter is invalid.');
  }
  return parts.day as IsoDate;
}

/**
 * Builds the key of a counter of the memory of runs.
 *
 * @param routine - The ID of the routine.
 * @param trigger - The trigger, a whole minute in milliseconds since the
 *   Unix epoch, from 1970 to 9999.
 * @param counter - `done`, `tries`, or the number of the window of 15
 *   minutes since the trigger, from 0 below {@link runWindowCount}.
 * @returns The key.
 * @throws {TypeError} When the result is no such key.
 * @example
 * ```ts
 * runQuotaKey('dienstplan-report', Date.UTC(2026, 10, 9, 5), 'done');
 * // 'run:dienstplan-report:20261109T0500:done'
 * runQuotaKey('dienstplan-report', Date.UTC(2026, 10, 9, 5), 2);
 * // 'run:dienstplan-report:20261109T0500:try:2'
 * ```
 */
export function runQuotaKey(
  routine: string,
  trigger: number,
  counter: 'done' | 'tries' | number,
): RunQuotaKey {
  if (
    typeof routine !== 'string' ||
    !Number.isSafeInteger(trigger) ||
    trigger < 0 ||
    // The last minute of the year 9999, so that the date has four digits
    // and a far time throws no RangeError when it is written.
    trigger > lastRunTrigger ||
    trigger % 60_000 !== 0 ||
    (typeof counter === 'number' && !Number.isSafeInteger(counter))
  ) {
    throw new TypeError('The key of the counter is invalid.');
  }
  // Without the seconds, the colons and the dashes: 2026-11-09T05:00 is
  // 20261109T0500.
  const stamp = new Date(trigger)
    .toISOString()
    .slice(0, 16)
    .replaceAll('-', '')
    .replaceAll(':', '');
  const key = `run:${routine}:${stamp}:${
    typeof counter === 'number' ? `try:${String(counter)}` : counter
  }`;
  if (!isRunQuotaKey(key)) {
    throw new TypeError('The key of the counter is invalid.');
  }
  return key;
}

/**
 * Tells whether a value is the key of a counter: `special_reads`, a key of
 * a counter of the policy, a key of the counter of a decision or a key of
 * the memory of runs. A store checks every key itself before it counts
 * under it.
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
        writeQuotaKeyPattern.test(value)) ||
      isApprovalQuotaKey(value) ||
      isRunQuotaKey(value))
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
 * takes them from the context and from nothing a tool hands over. The
 * counter of a decision about an entry of the queue belongs to the tenant
 * alone, whoever counts it, so that a second identity cannot decide again
 * about the same entry, and it stays at least {@link approvalCountDays}
 * days after its day (ADR 0029). A counter survives a restart and is
 * shared by every process that uses the same store.
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
