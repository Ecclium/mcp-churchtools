/**
 * The days of the retention of the audit files (ADR 0028): which day a
 * name of an audit file holds, and until which day a file of a day stays.
 * Days are UTC days written as `YYYY-MM-DD`, which compare as text in the
 * order of time.
 *
 * @packageDocumentation
 */
import { isAuditFileName, toTimestamp } from '../logger/index.js';

const twoDigits = (value: number): string => String(value).padStart(2, '0');

// The last day of a month, with month 1 to 12.
const daysIn = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * The UTC day of a name of an audit file, or undefined for any other
 * name. Only a name of exactly the form the writer makes counts, with a
 * day and a time that exist, so that no other file in the folder `audit`
 * ever looks like an audit file.
 *
 * @param name - A name in the folder `audit`, without a path.
 * @returns The day, such as `2026-10-31`, or undefined.
 * @example
 * ```ts
 * dayOfAuditFile('audit-2026-10-31-055230-4242-1.jsonl'); // '2026-10-31'
 * dayOfAuditFile('audit-2026-02-30-055230-4242-1.jsonl'); // undefined
 * ```
 */
export function dayOfAuditFile(name: string): string | undefined {
  if (!isAuditFileName(name)) return undefined;
  // audit-YYYY-MM-DD-hhmmss-…, fixed by the pattern.
  const year = Number(name.slice(6, 10));
  const month = Number(name.slice(11, 13));
  const day = Number(name.slice(14, 16));
  const hour = Number(name.slice(17, 19));
  const minute = Number(name.slice(19, 21));
  const second = Number(name.slice(21, 23));
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysIn(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return undefined;
  }
  return name.slice(6, 16);
}

/**
 * The UTC day of a time in milliseconds, such as the last change of a
 * file, or undefined when the time is no valid one.
 *
 * @param milliseconds - Milliseconds since the Unix epoch.
 * @returns The day, or undefined.
 * @example
 * ```ts
 * dayOfTime(Date.UTC(2026, 9, 31, 23, 59)); // '2026-10-31'
 * ```
 */
export function dayOfTime(milliseconds: number): string | undefined {
  return toTimestamp(milliseconds)?.slice(0, 10);
}

/**
 * The last day a file of a day stays: the day that lies as many calendar
 * months later, or the last day of that month when it has no such day.
 * A file of 31.10.2026 stays with twelve months until the end of
 * 31.10.2027, one of 29.02.2028 until the end of 28.02.2029.
 *
 * @param day - A UTC day as `YYYY-MM-DD`.
 * @param months - The retention in whole months.
 * @returns The last day the file stays, as `YYYY-MM-DD`.
 * @example
 * ```ts
 * lastDayKept('2026-01-31', 1); // '2026-02-28'
 * ```
 */
export function lastDayKept(day: string, months: number): string {
  const total = Number(day.slice(5, 7)) - 1 + months;
  const year = Number(day.slice(0, 4)) + Math.floor(total / 12);
  // A day after the year 9999 has no form of four digits and would sort
  // before every other day, so the end of 9999 stands for it.
  if (year > 9999) return '9999-12-31';
  const month = (total % 12) + 1;
  const date = Math.min(Number(day.slice(8, 10)), daysIn(year, month));
  return `${String(year).padStart(4, '0')}-${twoDigits(month)}-${twoDigits(date)}`;
}

/**
 * Tells whether a file of a day is past its retention on another day,
 * that is, whether that day lies after the last day the file stays.
 *
 * @param day - The UTC day of the file.
 * @param months - The retention in whole months.
 * @param today - The current UTC day.
 * @returns Whether the file may go.
 * @example
 * ```ts
 * isPastRetention('2026-10-31', 12, '2027-10-31'); // false
 * isPastRetention('2026-10-31', 12, '2027-11-01'); // true
 * ```
 */
export function isPastRetention(
  day: string,
  months: number,
  today: string,
): boolean {
  return today > lastDayKept(day, months);
}
