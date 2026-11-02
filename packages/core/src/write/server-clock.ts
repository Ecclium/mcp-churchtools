/**
 * The check of the clock before a write (ADR 0029).
 *
 * Where it stands in the way of a write: the commit reads the target right
 * before it writes, and that answer carries the time of ChurchTools in its
 * `date` header. The core writes only when its own clock and that time
 * differ by five minutes at most. Daily keys, counters and the marking of
 * a page all hang on the date, and a wrong clock would put a write on the
 * wrong day. An answer without a time in the form of RFC 9110 stops the
 * write as well, because the core then cannot tell (F22).
 *
 * @packageDocumentation
 */

/** The largest difference between the two clocks: five minutes. */
export const maxClockSkewMs = 300_000;

/**
 * Tells whether the clock of the server fits the time of ChurchTools.
 *
 * @param local - The time of the server, in milliseconds since the Unix
 *   epoch.
 * @param server - The time of ChurchTools from the `date` header, or null
 *   when the answer had none in the expected form.
 * @returns Whether both are numbers and differ by five minutes at most.
 * @example
 * ```ts
 * serverTimeFits(clock.now(), state.serverTime); // false for null
 * ```
 */
export function serverTimeFits(local: number, server: number | null): boolean {
  return (
    server !== null &&
    Number.isFinite(local) &&
    Number.isFinite(server) &&
    Math.abs(local - server) <= maxClockSkewMs
  );
}
