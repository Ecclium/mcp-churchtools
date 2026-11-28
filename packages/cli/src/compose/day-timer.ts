/**
 * When a long run looks at the day again: the start over stdio and the
 * server over HTTP start the audit file of a new UTC day and delete what
 * is past its retention through a timer that comes at least every hour
 * (ADR 0028, ADR 0031, ADR 0074).
 *
 * @packageDocumentation
 */

const dayMs = 86_400_000;
const hourMs = 3_600_000;

/**
 * Milliseconds from a time to the next look of the timer of a long run at
 * the day: one second after the next UTC midnight, but at most an hour.
 * A timer of Node.js does not count the time a computer sleeps, so after
 * a sleep the next look comes within the hour, not a day late.
 *
 * @param now - Milliseconds since the Unix epoch, from the clock.
 * @returns The delay, or an hour when the time is no finite number.
 * @example
 * ```ts
 * setTimeout(look, untilNextDay(clock.now())).unref();
 * ```
 */
export const untilNextDay = (now: number): number =>
  Number.isFinite(now)
    ? Math.min(dayMs - (((now % dayMs) + dayMs) % dayMs) + 1000, hourMs)
    : hourMs;
