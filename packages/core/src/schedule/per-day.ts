/**
 * How often a schedule fires on one UTC day at most (ADR 0032, ADR 0034).
 *
 * Where it stands: when `ecclium policy init --routine` proposes the entry
 * of a routine, never in a run. The limit `maxPerDay` of an entry counts
 * per UTC day in the store of quotas (ADR 0063), so the proposal needs the
 * most triggers that one UTC day can hold, not one day on the clock of the
 * zone. The two differ: on the day summer time starts in Europe/Zurich,
 * the schedule `30 * * * *` fires 25 times between two midnights of UTC,
 * because the time the change skips runs at the end of its gap.
 *
 * Why a year and a week of whole days: the count starts at midnight UTC
 * of the day of the first trigger after a time, so that this day counts
 * whole, and a schedule for 29 February is counted on that day. A day of
 * the month and a month come again within a year, a change of summer time
 * set to the last Sunday of a month within 371 days. A coincidence of both
 * in a later year, such as a change on 29 March, the count does not see;
 * then one write more than the limit goes to the queue. It reads every
 * trigger through the module of the triggers, which keeps the one rule
 * for the changes of summer time; an hourly schedule takes about two
 * seconds.
 *
 * @packageDocumentation
 */
import { readTriggers, triggerTimeRange } from './triggers.js';

/** The whole UTC days counted from the day of the first trigger on. */
export const triggersPerDaySpanDays = 373;

const dayMs = 86_400_000;

/**
 * The most triggers of a schedule on one UTC day, over
 * {@link triggersPerDaySpanDays} whole UTC days from the day of the first
 * trigger after a time.
 *
 * @param schedule - A schedule that passes the check of its form.
 * @param timeZone - `UTC` or a name of the time zone database, as
 *   `ECCLIUM_TIME_ZONE` takes it.
 * @param from - Milliseconds since the Unix epoch, from 2000 to 2099.
 * @returns The count, from 1 for a schedule that fires before 2100, else
 *   0.
 * @throws {TypeError} When the schedule does not pass the check, the zone
 *   is none the configuration takes or the time is outside those years.
 * @example
 * ```ts
 * mostTriggersPerUtcDay('0 6 * * MON', 'Europe/Zurich', Date.now()); // 1
 * ```
 */
export function mostTriggersPerUtcDay(
  schedule: string,
  timeZone: string,
  from: number,
): number {
  const triggers = readTriggers(schedule, timeZone);
  const first = triggers.next(from);
  // The module of the triggers takes no time from 2100 on.
  if (first >= triggerTimeRange.to) return 0;
  // From midnight UTC of the day of the first trigger, so that the day
  // counts whole; a time before 2000 the module of the triggers refuses.
  const start = Math.floor(first / dayMs) * dayMs;
  let at = triggers.next(Math.max(start - 1, triggerTimeRange.from));
  const end = Math.min(
    start + triggersPerDaySpanDays * dayMs,
    triggerTimeRange.to,
  );
  let day = Math.floor(at / dayMs);
  let count = 0;
  let most = 0;
  // The triggers come in their order, so one count per day suffices.
  while (at < end) {
    const today = Math.floor(at / dayMs);
    if (today === day) {
      count += 1;
    } else {
      day = today;
      count = 1;
    }
    most = Math.max(most, count);
    at = triggers.next(at);
  }
  return most;
}
