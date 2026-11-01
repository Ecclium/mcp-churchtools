/**
 * Reads the time of ChurchTools from the `date` header of an answer. Before
 * it writes, the core compares that time with its own clock and does not
 * write when the two differ by more than five minutes, because daily keys,
 * counters and the marker depend on the date (ADR 0029). The client only
 * reads the header; the comparison belongs to the write guard.
 *
 * @packageDocumentation
 */

/**
 * Gives the time a `date` header names, in milliseconds since the Unix
 * epoch, or null. Only the one form RFC 9110 asks a server to send counts,
 * such as `Sun, 01 Nov 2026 20:00:00 GMT`: the value must be exactly what
 * `toUTCString` writes for that time, so a wrong day of the week, a day
 * that does not exist, another zone or any of the older forms gives null.
 * The transport passes on a header of at most 256 characters of printable
 * ASCII (ADR 0056), so the parse costs nothing.
 *
 * @param value - The header as ChurchTools sent it, or undefined.
 * @returns The time, or null when the header is missing or has another form.
 * @example
 * ```ts
 * serverTimeOf('Sun, 01 Nov 2026 20:00:00 GMT'); // 1793563200000
 * serverTimeOf('Sunday, 01-Nov-26 20:00:00 GMT'); // null
 * ```
 */
export function serverTimeOf(value: string | undefined): number | null {
  if (value === undefined) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toUTCString() === value ? time : null;
}
