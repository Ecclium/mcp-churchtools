/**
 * Probe 04: wiki pages, their versions and their format.
 *
 * Reads, all in the test category:
 * - `GET /api/wiki/categories/{id}/pages`,
 * - for up to three pages of that list:
 *   `GET /api/wiki/categories/{id}/pages/{identifier}`,
 *   `GET …/{identifier}/versions` and `GET …/versions/{version}` for the
 *   highest version in the list.
 * Writes: nothing.
 * Answers: the structure of a page and of its version history, whether the
 * fields `version` and `isMarkdown` exist, whether the version of a page
 * equals the highest version of its history, and how many pages are
 * written in Markdown. Page IDs taken from the list fill a path only if
 * they have the form of an ID.
 *
 * Usage: see README.md in this folder.
 *
 * @packageDocumentation
 */
import { readCategoryId } from './lib/env.mts';
import type { Json } from './lib/guard.mts';
import { pathFor, type ProbeResponse } from './lib/http.mts';
import { operations } from './lib/operations.mts';
import { main, type ProbeDefinition } from './lib/probe.mts';
import { describeResponse } from './lib/report.mts';
import {
  Schemas,
  findOperation,
  isObject,
  type JsonObject,
} from './lib/spec.mts';
import { countClass } from './lib/structure.mts';

const maxPages = 3;
const identifierPattern = /^[A-Za-z0-9_-][A-Za-z0-9._~-]{0,199}$/;

const words = [
  'probe',
  '04-wiki-read',
  'wikiCategoryPages',
  'wikiPage',
  'wikiPageVersions',
  'wikiPageVersion',
  'nicht dokumentiert',
  'nicht aufgerufen',
  'liste',
  'kennung',
  'identifier',
  'id',
  'keine',
  'seiten',
  'seite',
  'versionen',
  'neuesteVersion',
  'anzahlVersionen',
  'versionGleichNeuester',
  'isMarkdown',
  'ja',
  'nein',
  'unbekannt',
  'wahr',
  'falsch',
  'fehlt',
];

/**
 * Takes the ID of a page from an entry of the page list.
 *
 * @param entry - One entry of the list.
 * @returns The field that held the ID and the ID, if it has the form of one.
 * @example
 * ```ts
 * pageId({ identifier: 'a1b2' }); // ['identifier', 'a1b2']
 * ```
 */
export function pageId(
  entry: unknown,
): readonly ['identifier' | 'id', string] | undefined {
  if (!isObject(entry)) {
    return undefined;
  }
  for (const field of ['identifier', 'id'] as const) {
    const value = entry[field];
    const text =
      typeof value === 'number' && Number.isSafeInteger(value) && value > 0
        ? String(value)
        : value;
    if (typeof text === 'string' && identifierPattern.test(text)) {
      return [field, text];
    }
  }
  return undefined;
}

function dataOf(response: ProbeResponse): unknown {
  return isObject(response.body) ? response.body['data'] : undefined;
}

function versionsOf(response: ProbeResponse): number[] {
  const data = dataOf(response);
  if (!Array.isArray(data)) {
    return [];
  }
  return data
    .map((entry) => (isObject(entry) ? entry['version'] : undefined))
    .filter(
      (value): value is number =>
        typeof value === 'number' && Number.isSafeInteger(value) && value > 0,
    );
}

/** The probe, for tests and for {@link main}. */
export const probe: ProbeDefinition = {
  name: '04-wiki-read',
  state: 'read',
  async run({ client, guard, state, env }): Promise<Json> {
    guard.allowFixed(...words);
    if (state === undefined) {
      throw new Error('INTERN');
    }
    const category =
      readCategoryId(env, 'ECCLIUM_SPIKE_WIKI_CATEGORY_ID', true) ?? 0;
    const document = state.specification;
    const schemas = new Schemas(document);
    const find = (
      name:
        | 'wikiCategoryPages'
        | 'wikiPage'
        | 'wikiPageVersions'
        | 'wikiPageVersion',
    ): JsonObject | undefined =>
      findOperation(
        document,
        operations[name].method,
        operations[name].template,
      );
    const listOperation = find('wikiCategoryPages');
    const pageOperation = find('wikiPage');
    const versionsOperation = find('wikiPageVersions');
    const versionOperation = find('wikiPageVersion');
    const describeWith =
      (operation: JsonObject | undefined) => (response: ProbeResponse) =>
        describeResponse(response, { guard, schemas, operation });

    if (listOperation === undefined) {
      return { probe: '04-wiki-read', wikiCategoryPages: 'nicht dokumentiert' };
    }
    const list = await client.get({
      path: pathFor(operations.wikiCategoryPages.template, category),
    });
    const listed = dataOf(list);
    const ids = (Array.isArray(listed) ? listed : [])
      .map(pageId)
      .filter((id) => id !== undefined)
      .slice(0, maxPages);

    const pages: Json[] = [];
    for (const [, id] of ids) {
      if (pageOperation === undefined) {
        break;
      }
      const page = await client.get({
        path: pathFor(operations.wikiPage.template, category, id),
      });
      const pageData = dataOf(page);
      const markdown = isObject(pageData) ? pageData['isMarkdown'] : undefined;
      const pageVersion = isObject(pageData) ? pageData['version'] : undefined;
      const result: Record<string, Json> = {
        seite: describeWith(pageOperation)(page),
        isMarkdown:
          typeof markdown === 'boolean'
            ? markdown
              ? 'wahr'
              : 'falsch'
            : 'fehlt',
      };
      if (versionsOperation === undefined) {
        result['versionen'] = 'nicht dokumentiert';
      } else {
        const versions = await client.get({
          path: pathFor(operations.wikiPageVersions.template, category, id),
        });
        const numbers = versionsOf(versions);
        const newest = numbers.length === 0 ? undefined : Math.max(...numbers);
        result['versionen'] = describeWith(versionsOperation)(versions);
        result['anzahlVersionen'] = countClass(numbers.length);
        result['versionGleichNeuester'] =
          newest === undefined || typeof pageVersion !== 'number'
            ? 'unbekannt'
            : pageVersion === newest
              ? 'ja'
              : 'nein';
        result['neuesteVersion'] =
          newest === undefined || versionOperation === undefined
            ? 'nicht aufgerufen'
            : describeWith(versionOperation)(
                await client.get({
                  path: pathFor(
                    operations.wikiPageVersion.template,
                    category,
                    id,
                    newest,
                  ),
                }),
              );
      }
      pages.push(result);
    }

    return {
      probe: '04-wiki-read',
      liste: describeWith(listOperation)(list),
      kennung: ids[0]?.[0] ?? 'keine',
      seiten: pageOperation === undefined ? 'nicht dokumentiert' : pages,
    };
  },
};

if (import.meta.main) {
  process.exitCode = await main(probe, import.meta.url);
}
