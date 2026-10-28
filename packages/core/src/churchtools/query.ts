/**
 * Builds the query of a request to ChurchTools from checked values only
 * (ADR 0057). A value that does not fit throws before any request exists.
 *
 * @packageDocumentation
 */

/** The largest `limit` ChurchTools takes for a page. */
export const maxPageLimit = 100;

/** The most IDs one request lists. */
export const maxIds = 100;

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/**
 * Appends a page: `page` from 1 and `limit` from 1 to 100, always both.
 *
 * @param params - The query to append to.
 * @param page - The page, from 1.
 * @param limit - The entries per page, from 1 to 100.
 * @throws {TypeError} When a value is not a whole number in range.
 * @example
 * ```ts
 * appendPage(url.searchParams, 1, 50); // page=1&limit=50
 * ```
 */
export function appendPage(
  params: URLSearchParams,
  page: number,
  limit: number,
): void {
  if (
    !isPositiveInteger(page) ||
    !isPositiveInteger(limit) ||
    limit > maxPageLimit
  ) {
    throw new TypeError(
      'A page needs a whole page from 1 and a limit from 1 to 100.',
    );
  }
  params.append('page', String(page));
  params.append('limit', String(limit));
}

/**
 * Appends IDs one by one under a name such as `ids[]`, never as a list
 * with commas.
 *
 * @param params - The query to append to.
 * @param name - The name of the parameter.
 * @param ids - 1 to 100 positive whole numbers.
 * @throws {TypeError} When the list is empty, too long or holds another value.
 * @example
 * ```ts
 * appendIds(url.searchParams, 'ids[]', [1, 2]); // ids%5B%5D=1&ids%5B%5D=2
 * ```
 */
export function appendIds(
  params: URLSearchParams,
  name: string,
  ids: readonly number[],
): void {
  // Array.from reads every index, also the holes of a sparse array, which
  // every would skip and the loop would append as undefined.
  const given = Array.isArray(ids) ? Array.from(ids as unknown[]) : undefined;
  if (
    given === undefined ||
    given.length < 1 ||
    given.length > maxIds ||
    !given.every(isPositiveInteger)
  ) {
    throw new TypeError('A list of IDs needs 1 to 100 positive whole numbers.');
  }
  for (const id of given) params.append(name, String(id));
}

// A day of the calendar in the form ChurchTools takes for a span.
const dayPattern = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

/**
 * Appends a span of days as `from` and `to`, two days in the form
 * `JJJJ-MM-TT` that the caller checked as a span (ADR 0064).
 *
 * @param params - The query to append to.
 * @param from - The first day.
 * @param to - The last day, not before the first.
 * @throws {TypeError} When a day does not have the form or the last comes
 *   before the first.
 * @example
 * ```ts
 * appendSpan(url.searchParams, '2026-10-25', '2026-10-31'); // from=2026-10-25&to=2026-10-31
 * ```
 */
export function appendSpan(
  params: URLSearchParams,
  from: string,
  to: string,
): void {
  if (
    typeof from !== 'string' ||
    typeof to !== 'string' ||
    !dayPattern.test(from) ||
    !dayPattern.test(to) ||
    to < from
  ) {
    throw new TypeError('A span needs two days as JJJJ-MM-TT, in order.');
  }
  params.append('from', from);
  params.append('to', to);
}

/**
 * The day after a day of the calendar, across the end of a month and of a
 * year, in the form `JJJJ-MM-TT`.
 *
 * @param day - A day in the form `JJJJ-MM-TT` that exists.
 * @returns The next day.
 * @throws {TypeError} When the text is no day of the calendar.
 * @example
 * ```ts
 * dayAfter('2026-12-31'); // '2027-01-01'
 * ```
 */
export function dayAfter(day: string): string {
  const time =
    typeof day === 'string' && dayPattern.test(day)
      ? Date.parse(`${day}T00:00:00Z`)
      : Number.NaN;
  // Date.parse rolls an impossible day such as 2026-02-30 over, so the
  // day must come back unchanged before it counts.
  if (
    !Number.isFinite(time) ||
    new Date(time).toISOString().slice(0, 10) !== day
  ) {
    throw new TypeError('A day needs the form JJJJ-MM-TT and must exist.');
  }
  return new Date(time + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * Appends `limit` alone, from 1 to 100, for a list that takes no `page`.
 *
 * @param params - The query to append to.
 * @param limit - The entries, from 1 to 100.
 * @throws {TypeError} When the value is not a whole number in range.
 * @example
 * ```ts
 * appendLimit(url.searchParams, 51); // limit=51
 * ```
 */
export function appendLimit(params: URLSearchParams, limit: number): void {
  if (!isPositiveInteger(limit) || limit > maxPageLimit) {
    throw new TypeError('A limit needs a whole number from 1 to 100.');
  }
  params.append('limit', String(limit));
}

/**
 * Builds the URL of a path that the client filled with checked values and
 * makes sure that parsing kept exactly that path and added no query. A
 * value that slipped past its check, such as a dot segment or a question
 * mark, throws instead of reaching another path (ADR 0057).
 *
 * @param origin - The canonical origin of the client.
 * @param pathname - The path, starting with a slash.
 * @returns The URL, without a query.
 * @throws {TypeError} When the URL has another path or a query.
 * @example
 * ```ts
 * urlOfPath('https://example.church.tools', '/api/wiki/categories/4/pages');
 * ```
 */
export function urlOfPath(origin: string, pathname: string): URL {
  const url = new URL(pathname, origin);
  if (url.pathname !== pathname || url.search !== '' || url.hash !== '') {
    throw new TypeError('A path must stay exactly as it was built.');
  }
  return url;
}
