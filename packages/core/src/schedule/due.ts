/**
 * When a routine is due (ADR 0034): the one function that the daemon and
 * `ecclium run-once --due` both call, so that a routine runs the same way
 * whether something outside calls a single run every few minutes or the
 * daemon waits for the time itself.
 *
 * Where it stands in a run: first, before the routine is read further. It
 * reckons the last trigger up to now from the schedule, the zone of the
 * configuration and the clock of the core, and asks the memory of runs in
 * the store of quotas whether that trigger is closed and how often runs
 * tried it. A run then begins with {@link startAttempt}, and one that ends
 * for good, with or without a write, closes its trigger with
 * {@link closeTrigger}. A run that failed for a passing reason, such as a
 * model or ChurchTools out of reach, closes nothing and is tried again:
 * at most three tries per trigger, each one more than 15 minutes after
 * the one before, so that a single run called every minute tries no more
 * often than the daemon.
 *
 * Why the memory has windows: a counter holds no time. Each try also
 * counts in its window of 15 minutes since the trigger, and a new try
 * waits as long as one began in the current or in the window before. The
 * next try may so begin more than 15 and at most 30 minutes after the one
 * before, depending on where in its window that one began.
 *
 * Why no run without the store: without its memory the runner would not
 * know whether a trigger ran already or a limit of the policy is reached.
 * A store that fails or does not answer within 5 seconds ends the check
 * as unavailable, and no run begins.
 *
 * @packageDocumentation
 */
import {
  type Clock,
  type QuotaStore,
  runQuotaDayOf,
  runQuotaKey,
  type RunQuotaKey,
  type TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';

import { quotaTimeoutMs } from '../quota/budget.js';
import { type Period, periodOf } from './period.js';
import { readTriggers } from './triggers.js';

/** The limits of the schedule of a routine, frozen. */
export const dueLimits = Object.freeze({
  /** How many days back a trigger can still be due. */
  dueDays: 31,
  /** How many tries one trigger has at most, the first run included. */
  maxTries: 3,
  /** The least time between two tries, and the length of a window. */
  retryMs: 15 * 60_000,
});

const dayMs = 86_400_000;

/** What the check of a routine needs. */
export interface DueOptions {
  /** The schedule of the routine, which passed `checkSchedule`. */
  readonly schedule: string;
  /** The zone of the configuration, `ECCLIUM_TIME_ZONE`. */
  readonly timeZone: string;
  /** The ID of the routine. */
  readonly routineId: string;
  /** The clock of the core. */
  readonly clock: Clock;
  /** The store of quotas, which holds the memory of runs. */
  readonly store: QuotaStore;
  /** The context of the run, for the tenant. */
  readonly ctx: TenantContext;
}

/** A trigger and its periods. */
export interface Trigger {
  /** When the schedule fired, in milliseconds since the Unix epoch. */
  readonly at: number;
  /** Week, day and month of the trigger on the clock of the zone. */
  readonly period: Period;
}

/**
 * The answer of {@link checkDue}. `next` is the time from which it is
 * worth asking again: the next trigger, or the time of the next try if
 * that comes first.
 */
export type DueCheck =
  | {
      /** The routine is due: a run may begin for this trigger. */
      readonly status: 'due';
      readonly trigger: Trigger;
      readonly next: number;
    }
  | {
      /**
       * Not due: the trigger is closed, its tries are used up, or a try
       * began in the current window of 15 minutes since the trigger or in
       * the one before.
       */
      readonly status: 'closed' | 'exhausted' | 'waiting';
      readonly trigger: Trigger;
      readonly next: number;
    }
  | {
      /** No trigger within the last 31 days. */
      readonly status: 'none';
      readonly next: number;
    }
  | {
      /** The store failed or did not answer: no run begins. */
      readonly status: 'unavailable';
      readonly next: number;
    };

/** The answer of {@link startAttempt}. */
export type AttemptStart =
  | {
      readonly ok: true;
      /** Which try this is, from 1 to 3. */
      readonly attempt: number;
    }
  | {
      readonly ok: false;
      /**
       * `waiting` when a try began in the same window or one next to it,
       * `exhausted` when three began, `expired` when the trigger lies more
       * than 31 days back by now, `unavailable` when the store failed.
       */
      readonly reason: 'waiting' | 'exhausted' | 'expired' | 'unavailable';
    };

const unavailable = (): Error => new Error('The store of quotas failed.');

// One call of the store, with the deadline of the store (ADR 0063), and a
// value it must give: a whole number from 0 for a read, from 1 for a count.
const ask = (work: () => Promise<number>, least: number): Promise<number> =>
  new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(unavailable());
    }, quotaTimeoutMs);
    Promise.resolve()
      .then(work)
      .then(
        (value) => {
          clearTimeout(timer);
          if (Number.isSafeInteger(value) && value >= least) resolve(value);
          else reject(unavailable());
        },
        () => {
          clearTimeout(timer);
          reject(unavailable());
        },
      );
  });

const read = (options: DueOptions, key: RunQuotaKey): Promise<number> =>
  ask(() => options.store.read(options.ctx, key, runQuotaDayOf(key)), 0);

const count = (options: DueOptions, key: RunQuotaKey): Promise<number> =>
  ask(() => options.store.increment(options.ctx, key, runQuotaDayOf(key)), 1);

// The window of 15 minutes since the trigger that a time falls in.
const windowOf = (trigger: number, now: number): number =>
  Math.floor((now - trigger) / dueLimits.retryMs);

/**
 * The last trigger of a schedule up to now, however long ago, for a run of
 * a routine by hand, which serves the period of that trigger.
 *
 * @param options - Schedule, zone and clock.
 * @returns The trigger and its periods, frozen.
 * @throws {TypeError} When the schedule or the zone does not pass their
 *   checks or the clock gives no time from 2000 to 2099.
 * @example
 * ```ts
 * lastTrigger({ schedule: '0 6 * * MON', timeZone: 'Europe/Zurich', clock });
 * // { at: Date.UTC(2026, 10, 9, 5), period: { isoWeek: '2026-W46', … } }
 * ```
 */
export function lastTrigger(
  options: Pick<DueOptions, 'schedule' | 'timeZone' | 'clock'>,
): Trigger {
  const at = readTriggers(options.schedule, options.timeZone).last(
    options.clock.now(),
  );
  return Object.freeze({ at, period: periodOf(at, options.timeZone) });
}

/**
 * Tells whether a routine is due, for the daemon and a single run alike.
 *
 * @param options - Schedule, zone, routine, clock, store and context.
 * @returns The answer, frozen. It never rejects for a failing store; that
 *   is `unavailable`.
 * @throws {TypeError} When the schedule, the zone or the ID of the routine
 *   does not pass their checks or the clock gives no time from 2000 to
 *   2099.
 * @example
 * ```ts
 * const check = await checkDue({ schedule: '0 6 * * MON',
 *   timeZone: 'Europe/Zurich', routineId: 'dienstplan-report', clock,
 *   store, ctx });
 * if (check.status === 'due') await startAttempt({ ...options,
 *   trigger: check.trigger });
 * ```
 */
export async function checkDue(options: DueOptions): Promise<DueCheck> {
  const triggers = readTriggers(options.schedule, options.timeZone);
  const now = options.clock.now();
  const at = triggers.last(now);
  const nextTrigger = triggers.next(now);
  // Checked before the store is asked, so that a wrong ID throws.
  const done = runQuotaKey(options.routineId, at, 'done');
  if (now - at > dueLimits.dueDays * dayMs) {
    return Object.freeze({ status: 'none', next: nextTrigger });
  }
  const trigger = Object.freeze({
    at,
    period: periodOf(at, options.timeZone),
  });
  const answer = (
    status: 'due' | 'closed' | 'exhausted' | 'waiting',
    next = nextTrigger,
  ): DueCheck => Object.freeze({ status, trigger, next });
  try {
    if ((await read(options, done)) > 0) return answer('closed');
    const tries = await read(
      options,
      runQuotaKey(options.routineId, at, 'tries'),
    );
    if (tries >= dueLimits.maxTries) return answer('exhausted');
    // Read also before the first try: a start that counted its window but
    // not its try, because the store failed in between, holds the window.
    const current = windowOf(at, now);
    const window = async (index: number): Promise<number> =>
      index < 0 ? 0 : read(options, runQuotaKey(options.routineId, at, index));
    // The latest window a try began in, of the current one and the one
    // before. The next try may begin two windows after it.
    const latest =
      (await window(current)) > 0
        ? current
        : (await window(current - 1)) > 0
          ? current - 1
          : undefined;
    if (latest === undefined) return answer('due');
    return answer(
      'waiting',
      Math.min(nextTrigger, at + (latest + 2) * dueLimits.retryMs),
    );
  } catch {
    return Object.freeze({
      status: 'unavailable',
      next: Math.min(nextTrigger, now + dueLimits.retryMs),
    });
  }
}

/**
 * Begins a try of a trigger that {@link checkDue} found due: counts the
 * try in its window and among the tries of the trigger. It counts first
 * and refuses after, so that of two processes that start at the same time
 * at most one begins, also across the edge of two windows, and no fourth
 * try begins. The lock of a routine, which comes with the runner, keeps
 * two processes apart before they get here.
 *
 * @param options - The options of the check, with the trigger it found.
 * @returns Which try this is, or why none begins.
 * @throws {TypeError} When the ID of the routine or the trigger does not
 *   fit, or the trigger lies in the future.
 * @example
 * ```ts
 * const start = await startAttempt({ ...options, trigger: check.trigger });
 * if (start.ok) await run(start.attempt);
 * ```
 */
export async function startAttempt(
  options: DueOptions & { readonly trigger: Trigger },
): Promise<AttemptStart> {
  const at = options.trigger.at;
  const now = options.clock.now();
  if (!Number.isSafeInteger(now) || now < at) {
    throw new TypeError('The trigger is not one that can be due.');
  }
  // A trigger that left the 31 days since the check found it due.
  if (now - at > dueLimits.dueDays * dayMs) {
    return Object.freeze({ ok: false, reason: 'expired' });
  }
  const current = windowOf(at, now);
  const keyOf = (index: number): RunQuotaKey =>
    runQuotaKey(options.routineId, at, index);
  const tries = runQuotaKey(options.routineId, at, 'tries');
  const waiting = Object.freeze({ ok: false, reason: 'waiting' } as const);
  try {
    if ((await count(options, keyOf(current))) > 1) return waiting;
    // A try in the window before, or one that a second process began in
    // the next window while this one crossed the edge between the two:
    // each of two such starts sees the other and none begins, so that no
    // two tries begin less than 15 minutes apart. The window after the
    // last one a trigger can be due in still has a key.
    for (const index of [current - 1, current + 1]) {
      if (index >= 0 && (await read(options, keyOf(index))) > 0) {
        return waiting;
      }
    }
    const attempt = await count(options, tries);
    if (attempt > dueLimits.maxTries) {
      return Object.freeze({ ok: false, reason: 'exhausted' });
    }
    return Object.freeze({ ok: true, attempt });
  } catch {
    return Object.freeze({ ok: false, reason: 'unavailable' });
  }
}

/**
 * Closes a trigger, after a run that wrote, found nothing to change, put
 * its write into the queue of approvals, or ended for a reason a new try
 * would not change, such as a kill switch, a refusal of the policy, an
 * answer of the model that stayed invalid or a breach of the content
 * policy. A closed trigger is no longer due.
 *
 * @param options - The options of the check, with the trigger.
 * @returns Whether the store counted it.
 * @throws {TypeError} When the ID of the routine or the trigger does not
 *   fit.
 * @example
 * ```ts
 * await closeTrigger({ ...options, trigger: check.trigger });
 * ```
 */
export async function closeTrigger(
  options: DueOptions & { readonly trigger: Trigger },
): Promise<boolean> {
  const done = runQuotaKey(options.routineId, options.trigger.at, 'done');
  try {
    await count(options, done);
    return true;
  } catch {
    return false;
  }
}
