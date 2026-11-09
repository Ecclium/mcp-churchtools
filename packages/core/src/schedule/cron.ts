/**
 * The reader of schedules (ADR 0034): the only module that loads croner.
 *
 * Where it stands in a run: when a routine is loaded, to see whether its
 * schedule ever fires, and before each run, when the core reckons which
 * trigger is due. It answers one question only: which instants a
 * schedule names before or after a time in a time zone. What counts as a
 * trigger at a change of summer time, which trigger is due and which
 * period it serves, the modules beside it decide.
 *
 * Why it is narrow: croner can also run jobs on timers, keep named jobs in
 * a list of its own, read six or seven fields and number the weekdays as
 * Quartz does. None of that has a place here. A schedule has exactly five
 * fields, the weekday 0 is Sunday, a value with a step such as `5/15` is
 * refused, and no job, callback or name is ever given, so croner starts no
 * timer and keeps no state. The check of the form never lets day of the
 * month and day of the week both be restricted, so the choice between
 * «and» and «or» that croner offers for the two does not matter and is
 * left alone.
 *
 * A rule of dependency-cruiser holds that no other module imports croner
 * (place `cronSchedule`).
 *
 * @packageDocumentation
 */
import { Cron } from 'croner';

import { isTimeZone } from '../config/variables.js';

/** The instants a schedule names, in milliseconds since the Unix epoch. */
export interface CronSchedule {
  /**
   * The first instant the schedule names strictly after a time.
   *
   * @param after - Milliseconds since the Unix epoch.
   * @returns The instant, or `undefined` when the schedule names none.
   */
  readonly next: (after: number) => number | undefined;
  /**
   * The last instant the schedule names strictly before a time.
   *
   * @param before - Milliseconds since the Unix epoch.
   * @returns The instant, or `undefined` when the schedule names none.
   */
  readonly previous: (before: number) => number | undefined;
}

/**
 * The instant croner named, for a schedule that names one wherever it is
 * asked: one that passed the check of its form, which refuses a schedule
 * that never fires, asked within the years in which a clock is right.
 *
 * @param instant - What {@link CronSchedule} returned.
 * @returns The instant.
 * @throws {RangeError} When croner named none.
 * @example
 * ```ts
 * found(createCron('0 6 * * MON', 'UTC').next(0)); // Date.UTC(1970, 0, 5, 6)
 * ```
 */
export function found(instant: number | undefined): number {
  if (instant === undefined) {
    throw new RangeError('The schedule names no such time.');
  }
  return instant;
}

/**
 * Reads a schedule of five fields in a time zone.
 *
 * croner places a time that a change to summer time skips and a time that
 * the change back repeats by its own rules, which differ between a
 * schedule with one minute and one hour and other schedules. The module
 * of the triggers evens that out (ADR 0034).
 *
 * @param schedule - Five fields, as the check of the form allows them.
 * @param timeZone - `UTC` or a name of the time zone database, as
 *   `ECCLIUM_TIME_ZONE` takes it.
 * @returns The schedule, frozen.
 * @throws {TypeError} When croner cannot read the schedule or the zone is
 *   none the configuration takes.
 * @example
 * ```ts
 * const cron = createCron('0 6 * * MON', 'Europe/Zurich');
 * cron.next(Date.UTC(2026, 10, 9, 5)); // Date.UTC(2026, 10, 16, 5)
 * ```
 */
export function createCron(schedule: string, timeZone: string): CronSchedule {
  // croner takes an offset, an abbreviation such as CET and a name in
  // small letters as a zone, and an unknown one only fails when it
  // reckons. The zone of a schedule is the one of the configuration.
  if (!isTimeZone(timeZone)) {
    throw new TypeError('The schedule or its time zone is invalid.');
  }
  let cron: Cron;
  try {
    cron = new Cron(schedule, {
      timezone: timeZone,
      mode: '5-part',
      alternativeWeekdays: false,
      sloppyRanges: false,
    });
  } catch {
    throw new TypeError('The schedule or its time zone is invalid.');
  }
  return Object.freeze({
    // croner drops the milliseconds of the time it starts from. A trigger
    // is a whole minute, so the first one after the second that remains
    // also comes after the time itself.
    next: (after: number) => cron.nextRun(new Date(after))?.getTime(),
    // croner looks strictly before the whole second it starts from. Up to
    // the next whole second, so that a trigger in the same second as the
    // time, but before it, still counts.
    previous: (before: number) =>
      cron
        .previousRuns(1, new Date(Math.ceil(before / 1000) * 1000))[0]
        ?.getTime(),
  });
}
