/**
 * The period of a trigger (ADR 0034): the week, the day and the month it
 * falls in on the clock of the zone of the configuration.
 *
 * Where it stands in a run: once the core knows which trigger a run
 * serves. The period goes into the key of the run, the marking of what it
 * writes and the check code (ADR 0032). It comes from the planned trigger,
 * never from the time the run starts, so that a run that starts late
 * still serves the period of its trigger.
 *
 * @packageDocumentation
 */
import { isTimeZone } from '../config/variables.js';
import { createWallClock } from './wall.js';

/** The periods of one trigger, frozen. */
export interface Period {
  /** The week after ISO 8601, such as `2026-W46`. */
  readonly isoWeek: string;
  /** The day, such as `2026-11-09`. */
  readonly date: string;
  /** The month, such as `2026-11`. */
  readonly month: string;
}

const dayMs = 86_400_000;

const pad = (value: number, length: number): string =>
  String(value).padStart(length, '0');

/**
 * The periods of a trigger on the clock of a zone.
 *
 * The week counts from Monday, and week 1 is the one with the first
 * Thursday of its year, so the days around a new year may belong to the
 * week of the other year, such as 31.12.2026 to `2026-W53` and 01.01.2027
 * as well. This is plain arithmetic on the date of the clock, which needs
 * no zone any more.
 *
 * @param trigger - The trigger, in milliseconds since the Unix epoch.
 * @param timeZone - `UTC` or a name of the time zone database, as
 *   `ECCLIUM_TIME_ZONE` takes it.
 * @returns The periods, frozen.
 * @throws {TypeError} When the zone is none the configuration takes or
 *   the trigger is no time from the year 1970 to 9999.
 * @example
 * ```ts
 * periodOf(Date.UTC(2026, 10, 9, 5), 'Europe/Zurich');
 * // { isoWeek: '2026-W46', date: '2026-11-09', month: '2026-11' }
 * ```
 */
export function periodOf(trigger: number, timeZone: string): Period {
  if (!isTimeZone(timeZone)) throw new TypeError('The time zone is invalid.');
  if (
    !Number.isSafeInteger(trigger) ||
    trigger < 0 ||
    trigger >= Date.UTC(9999, 11, 31)
  ) {
    throw new TypeError('The trigger is no time.');
  }
  const { year, month, day } = createWallClock(timeZone)(trigger);
  const date = Date.UTC(year, month - 1, day);
  // Monday is 0. The Thursday of the same week decides its year.
  const weekday = (new Date(date).getUTCDay() + 6) % 7;
  const thursday = date + (3 - weekday) * dayMs;
  const weekYear = new Date(thursday).getUTCFullYear();
  const week =
    Math.floor((thursday - Date.UTC(weekYear, 0, 1)) / (7 * dayMs)) + 1;
  return Object.freeze({
    isoWeek: `${pad(weekYear, 4)}-W${pad(week, 2)}`,
    date: `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`,
    month: `${pad(year, 4)}-${pad(month, 2)}`,
  });
}
