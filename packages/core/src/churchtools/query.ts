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
  if (
    !Array.isArray(ids) ||
    ids.length < 1 ||
    ids.length > maxIds ||
    !ids.every(isPositiveInteger)
  ) {
    throw new TypeError('A list of IDs needs 1 to 100 positive whole numbers.');
  }
  for (const id of ids) params.append(name, String(id));
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
