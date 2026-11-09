/**
 * The date and time an instant shows on a clock of a time zone (ADR 0034).
 *
 * Where it stands in a run: when the core reckons the triggers of a
 * schedule and the period of a trigger. It only reads what `Intl` says a
 * clock in the zone shows; when a time is skipped or repeated at a change
 * of summer time is left to croner.
 *
 * @packageDocumentation
 */

/** The date and time a clock of a zone shows, to the minute. */
export interface WallTime {
  readonly year: number;
  /** 1 to 12. */
  readonly month: number;
  /** 1 to 31. */
  readonly day: number;
  /** 0 to 23. */
  readonly hour: number;
  readonly minute: number;
}

/**
 * The same date and time as milliseconds, read as if the zone were UTC,
 * so that two times on the clock compare and step like instants.
 *
 * @param wall - A date and time on the clock.
 * @returns Milliseconds since the Unix epoch, as if in UTC.
 * @example
 * ```ts
 * naiveOf({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 });
 * // Date.UTC(2026, 2, 29, 2, 30)
 * ```
 */
export function naiveOf(wall: WallTime): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
}

/**
 * Builds a reader of the clock of a zone. The formatter is built once per
 * reader, never kept at the level of the module.
 *
 * @param timeZone - A zone `Intl` knows, checked by the caller.
 * @returns A function from milliseconds since the Unix epoch to the date
 *   and time the clock of the zone shows, frozen.
 * @example
 * ```ts
 * const wallOf = createWallClock('Europe/Zurich');
 * wallOf(Date.UTC(2026, 10, 9, 5)); // 09.11.2026, 06:00
 * ```
 */
export function createWallClock(timeZone: string): (ms: number) => WallTime {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  });
  return (ms: number): WallTime => {
    let year = Number.NaN;
    let month = Number.NaN;
    let day = Number.NaN;
    let hour = Number.NaN;
    let minute = Number.NaN;
    for (const { type, value } of format.formatToParts(ms)) {
      switch (type) {
        case 'year':
          year = Number(value);
          break;
        case 'month':
          month = Number(value);
          break;
        case 'day':
          day = Number(value);
          break;
        case 'hour':
          hour = Number(value);
          break;
        case 'minute':
          minute = Number(value);
          break;
        default:
        // The signs between the numbers.
      }
    }
    return Object.freeze({ year, month, day, hour, minute });
  };
}
