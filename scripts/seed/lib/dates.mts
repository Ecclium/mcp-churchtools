/**
 * The days of the synthetic data, counted from the day of the run.
 *
 * Appointments and events lie in the weeks after the run, so they fall into
 * the 31 days the read tools list, and the first Saturday fits the prompt
 * for a weekend rota. All times are UTC, like the days of the audit file.
 *
 * @packageDocumentation
 */

const dayMs = 24 * 60 * 60 * 1000;

/**
 * Finds the Saturday the data of a run hangs on: the first Saturday at
 * least two days after the day of the run, in UTC.
 *
 * @param now - The time of the run.
 * @returns Midnight UTC of that Saturday.
 * @example
 * ```ts
 * anchorSaturday(new Date('2026-10-27T20:00:00Z')); // 2026-10-31T00:00:00Z
 * ```
 */
export function anchorSaturday(now: Date): Date {
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const earliest = new Date(today + 2 * dayMs);
  const untilSaturday = (6 - earliest.getUTCDay() + 7) % 7;
  return new Date(earliest.getTime() + untilSaturday * dayMs);
}

/**
 * A point in time a number of days and hours after a day.
 *
 * @param day - Midnight UTC of a day.
 * @param days - Whole days after it.
 * @param hours - Hours after midnight, with fractions for minutes.
 * @returns The point in time.
 */
export function at(day: Date, days: number, hours = 0): Date {
  return new Date(day.getTime() + days * dayMs + hours * 60 * 60 * 1000);
}

/**
 * Writes a point in time as ChurchTools takes it: UTC without fractions.
 *
 * @param time - The point in time.
 * @returns Text such as `2026-10-31T18:00:00Z`.
 */
export function dateTime(time: Date): string {
  return `${time.toISOString().slice(0, 19)}Z`;
}

/**
 * Writes the day of a point in time, in UTC.
 *
 * @param time - The point in time.
 * @returns Text such as `2026-10-31`.
 */
export function dateOnly(time: Date): string {
  return time.toISOString().slice(0, 10);
}
