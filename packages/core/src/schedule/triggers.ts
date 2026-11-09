/**
 * The triggers of a schedule (ADR 0034): when a routine is planned to run,
 * by one rule for every schedule, also at a change of summer time.
 *
 * Where it stands in a run: before the start, when the core tells whether
 * a routine is due and when the daemon should look again. The trigger,
 * not the time the run starts, then gives the period of the run and the
 * days that relative inputs count from.
 *
 * Why it does more than ask croner: ADR 0034 sets one rule for the
 * changes of summer time. A time the change to summer time skips runs at
 * the first time after it that exists, a time the change back repeats
 * runs once, the first time. croner keeps that rule for a schedule with
 * one minute and one hour. For a schedule with a list, a range or a step
 * in the hour it does what cron does: it skips a time in the gap and runs
 * a repeated time twice, which would mean two runs and two calls of a
 * model for one time on the clock. And where a gap crosses midnight, as
 * in America/Nuuk, croner skips even a fixed time. The core evens this
 * out. croner names the times of the schedule. For each trigger the core
 * asks croner when the same date and time on the clock would run as a
 * fixed time, which croner places at its first occurrence; a trigger that
 * comes later than that is a repeat and is dropped. A time of the
 * schedule that croner skipped becomes a trigger at the end of its gap,
 * the first minute at which the clock of the zone shows a later time, as
 * `Intl` reads it; if a regular trigger falls on the same instant, they
 * are one.
 *
 * @packageDocumentation
 */
import { createCron, found } from './cron.js';
import { checkSchedule } from './form.js';
import { createWallClock, naiveOf, type WallTime } from './wall.js';

/** The triggers of one schedule in one zone. */
export interface ScheduleTriggers {
  /**
   * The last trigger at or before a time.
   *
   * @param now - Milliseconds since the Unix epoch, from 2000 to 2099.
   * @returns The trigger.
   * @throws {TypeError} When the time is not within those years.
   */
  readonly last: (now: number) => number;
  /**
   * The first trigger strictly after a time.
   *
   * @param after - Milliseconds since the Unix epoch, from 2000 to 2099.
   * @returns The trigger.
   * @throws {TypeError} When the time is not within those years.
   */
  readonly next: (after: number) => number;
}

/**
 * The years in which the core takes a time to reckon triggers from. A
 * clock outside them is wrong, and croner searches the calendar for a
 * long time before it gives up on a time far away.
 */
export const triggerTimeRange = Object.freeze({
  from: Date.UTC(2000, 0, 1),
  to: Date.UTC(2100, 0, 1),
});

// Far enough before a date on the clock to lie before both instants that
// show its times in any zone, and far enough after the same date a year
// earlier.
const twoDaysMs = 2 * 86_400_000;

const minuteMs = 60_000;

const checkTime = (time: number): number => {
  if (
    !Number.isSafeInteger(time) ||
    time < triggerTimeRange.from ||
    time >= triggerTimeRange.to
  ) {
    throw new TypeError('The time is outside the years the core takes.');
  }
  return time;
};

/**
 * Reads the triggers of a schedule in a zone.
 *
 * @param schedule - A schedule that passes {@link checkSchedule}.
 * @param timeZone - `UTC` or a name of the time zone database, as
 *   `ECCLIUM_TIME_ZONE` takes it.
 * @returns The triggers, frozen.
 * @throws {TypeError} When the schedule does not pass the check or the
 *   zone is none the configuration takes.
 * @example
 * ```ts
 * const triggers = readTriggers('0 6 * * MON', 'Europe/Zurich');
 * triggers.last(Date.UTC(2026, 10, 11)); // Date.UTC(2026, 10, 9, 5)
 * ```
 */
export function readTriggers(
  schedule: string,
  timeZone: string,
): ScheduleTriggers {
  if (!checkSchedule(schedule).ok) {
    throw new TypeError('The schedule is not allowed.');
  }
  const cron = createCron(schedule, timeZone);
  // The schedule on a clock read as UTC: every date and time it names,
  // whether the zone has it or not.
  const onClock = createCron(schedule, 'UTC');
  const wallOf = createWallClock(timeZone);

  // When croner runs a date and time the clock shows as a fixed time: at
  // its first occurrence.
  const firstOf = (wall: WallTime): number =>
    found(
      createCron(
        `${String(wall.minute)} ${String(wall.hour)} ${String(wall.day)} ${String(wall.month)} *`,
        timeZone,
      ).next(naiveOf(wall) - twoDaysMs),
    );

  // A trigger at a time the clock showed before, after the change back.
  const isRepeat = (trigger: number): boolean =>
    firstOf(wallOf(trigger)) < trigger;

  // Whether the clock shows a later time than one of the schedule at the
  // start of a minute.
  const isPast = (minute: number, time: number): boolean =>
    naiveOf(wallOf(minute * minuteMs)) > time;

  // A time of the schedule that croner skipped between two of its
  // instants, as the trigger at the end of its gap: the first time the
  // schedule names on the clock after `from`, if the clock passes it
  // before `to` without a trigger of croner. The end of the gap is the
  // first minute at which the clock shows a later time, found by halving
  // the minutes between the two, so that it holds also for a gap across
  // midnight or a day a zone skipped whole, where croner places no fixed
  // time. If the minute before shows the time itself, the clock had it
  // after all, as the second pass of a time the change back repeats, and
  // it is no trigger.
  const skipped = (from: number, to: number): number | undefined => {
    const time = found(onClock.next(naiveOf(wallOf(from))));
    let before = Math.floor(from / minuteMs);
    let after = Math.floor(to / minuteMs);
    if (!isPast(after, time)) return undefined;
    while (after - before > 1) {
      const middle = Math.floor((before + after) / 2);
      if (isPast(middle, time)) after = middle;
      else before = middle;
    }
    return naiveOf(wallOf(before * minuteMs)) === time
      ? undefined
      : after * minuteMs;
  };

  const last = (now: number): number => {
    const regular = found(cron.previous(checkTime(now) + 1));
    let kept = regular;
    while (isRepeat(kept)) kept = found(cron.previous(kept));
    return Math.max(kept, skipped(regular, now) ?? kept);
  };

  const next = (after: number): number => {
    const regular = found(cron.next(checkTime(after)));
    let kept = regular;
    while (isRepeat(kept)) kept = found(cron.next(kept));
    return skipped(after, regular) ?? kept;
  };

  return Object.freeze({ last, next });
}
