/**
 * The times of appointments and bookings as a person reads them before a
 * write (ADR 0029, ADR 0072).
 *
 * Where it stands in the way of a write: planning an appointment or a
 * booking makes the text of its confirmation, and the person who confirms
 * has to see the hour that will be written. ChurchTools takes and gives
 * times in UTC; the text names the zone it shows them in, UTC until the
 * operator names another, so that no one reads 09:00 UTC as 09:00 local
 * time without noticing.
 *
 * @packageDocumentation
 */

/** The zone of a text when the operator names none. */
export const defaultTimeZone = 'UTC';

const weekdays: readonly string[] = Object.freeze([
  'Sonntag',
  'Montag',
  'Dienstag',
  'Mittwoch',
  'Donnerstag',
  'Freitag',
  'Samstag',
]);

/** A time as the clock of a zone shows it. */
interface LocalTime {
  readonly day: string;
  readonly weekday: string;
  readonly clock: string;
}

const two = (value: number): string => String(value).padStart(2, '0');

// The parts of a time in a zone, by the numbers Intl gives, so that the
// text has one form whatever the locale data of the runtime hold.
const localTimeOf = (time: number, zone: string): LocalTime => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(new Date(time));
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((entry) => entry.type === type)?.value);
  const year = part('year');
  const month = part('month');
  const day = part('day');
  // The weekday of the local day, counted in UTC, where it is the same;
  // getUTCDay gives 0 to 6, an index the list always has.
  const weekday = String(
    weekdays[new Date(Date.UTC(year, month - 1, day)).getUTCDay()],
  );
  return {
    day: `${two(day)}.${two(month)}.${String(year)}`,
    weekday,
    clock: `${two(part('hour'))}:${two(part('minute'))}`,
  };
};

/**
 * One time in German, in a zone: the day with its weekday, the clock and
 * the name of the zone.
 *
 * @param date - A time in UTC.
 * @param zone - An IANA name the operator chose, or undefined for UTC.
 * @returns The time as text.
 * @example
 * ```ts
 * timeTextOf('2026-11-08T09:00:00Z', undefined); // 'Sonntag, 08.11.2026, 09:00 (UTC)'
 * ```
 */
export function timeTextOf(date: string, zone: string | undefined): string {
  const shown = zone ?? defaultTimeZone;
  const time = localTimeOf(Date.parse(date), shown);
  return `${time.weekday}, ${time.day}, ${time.clock} (${shown})`;
}

/**
 * The span of an appointment or a booking in German, in a zone: the day
 * with its weekday and the clock of the start, the clock of the end on the
 * same day or the whole end on another, and the name of the zone.
 *
 * @param startDate - The start, a time in UTC.
 * @param endDate - The end, a time in UTC.
 * @param zone - An IANA name the operator chose, or undefined for UTC.
 * @returns The span as text.
 * @example
 * ```ts
 * spanTextOf('2026-11-08T09:00:00Z', '2026-11-08T10:00:00Z', undefined);
 * // 'Sonntag, 08.11.2026, 09:00 bis 10:00 (UTC)'
 * ```
 */
export function spanTextOf(
  startDate: string,
  endDate: string,
  zone: string | undefined,
): string {
  const shown = zone ?? defaultTimeZone;
  const start = localTimeOf(Date.parse(startDate), shown);
  const end = localTimeOf(Date.parse(endDate), shown);
  const until =
    start.day === end.day
      ? end.clock
      : `${end.weekday}, ${end.day}, ${end.clock}`;
  return `${start.weekday}, ${start.day}, ${start.clock} bis ${until} (${shown})`;
}

/**
 * Whether a time falls on midnight in a zone. ChurchTools stores an
 * appointment whose start and end both fall on midnight in the zone of the
 * installation as one of whole days, so the write guard refuses such times
 * in the zone the operator names; the minutes are the whole check, since
 * every time it writes is on the full minute.
 *
 * @param date - A time in UTC.
 * @param zone - An IANA name the operator chose.
 * @returns Whether the clock of the zone shows 00:00.
 * @example
 * ```ts
 * isMidnightIn('2026-11-07T23:00:00Z', 'Europe/Zurich'); // true
 * isMidnightIn('2026-11-08T00:00:00Z', 'Europe/Zurich'); // false
 * ```
 */
export function isMidnightIn(date: string, zone: string): boolean {
  return localTimeOf(Date.parse(date), zone).clock === '00:00';
}
