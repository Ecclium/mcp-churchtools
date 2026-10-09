/**
 * Reads back a wiki page of the write area, for the probes of the write
 * account.
 *
 * The probes compare what they read here with what they sent, and print
 * only the result of the comparison. Nothing read here reaches the output
 * as it is; every value is on the block list once the client has read it.
 *
 * @packageDocumentation
 */
import { pathFor, type Client, type ProbeResponse } from './http.mts';
import { operations } from './operations.mts';
import { isObject } from './spec.mts';

/** What a probe reads back of a page. */
export interface PageView {
  readonly status: number;
  readonly guid?: string;
  readonly identifier?: unknown;
  readonly title?: string;
  readonly version?: number;
  readonly text?: string | null;
  readonly isMarkdown?: boolean;
  readonly onStartpage?: boolean;
  readonly modifiedDate?: string;
  readonly versionCount?: number;
}

/**
 * Takes `data` from an answer of the instance.
 *
 * @param response - An answer.
 * @returns `data`, if the body is an object.
 */
export function dataOf(response: ProbeResponse): unknown {
  return isObject(response.body) ? response.body['data'] : undefined;
}

const isPositive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/**
 * Reads a page and the list of its versions.
 *
 * @param client - The client that reads.
 * @param category - ID of the write area.
 * @param guid - GUID of the page.
 * @returns What the page shows, or only the status if it cannot be read.
 * @example
 * ```ts
 * const view = await readPage(client, 7, guid);
 * view.version; // 1
 * ```
 */
export async function readPage(
  client: Client,
  category: number,
  guid: string,
): Promise<PageView> {
  const page = await client.get({
    path: pathFor(operations.wikiPage.template, category, guid),
  });
  const data = dataOf(page);
  if (page.status !== 200 || !isObject(data)) {
    return { status: page.status };
  }
  const versions = await client.get({
    path: pathFor(operations.wikiPageVersions.template, category, guid),
  });
  const list = dataOf(versions);
  const numbers = (Array.isArray(list) ? list : [])
    .map((entry) => (isObject(entry) ? entry['version'] : undefined))
    .filter(isPositive);
  const meta = data['meta'];
  const modified = isObject(meta) ? meta['modifiedDate'] : undefined;
  const text = data['text'];
  return {
    status: page.status,
    ...(typeof data['guid'] === 'string' ? { guid: data['guid'] } : {}),
    identifier: data['identifier'],
    ...(typeof data['title'] === 'string' ? { title: data['title'] } : {}),
    ...(isPositive(data['version']) ? { version: data['version'] } : {}),
    ...(typeof text === 'string' || text === null ? { text } : {}),
    ...(typeof data['isMarkdown'] === 'boolean'
      ? { isMarkdown: data['isMarkdown'] }
      : {}),
    ...(typeof data['onStartpage'] === 'boolean'
      ? { onStartpage: data['onStartpage'] }
      : {}),
    ...(typeof modified === 'string' ? { modifiedDate: modified } : {}),
    versionCount: numbers.length,
  };
}
