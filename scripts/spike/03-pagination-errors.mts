/**
 * Probe 03: pagination, the limit of `limit`, and the format of errors.
 *
 * Reads, all in the test category:
 * - `GET /api/wiki/pages` with `wiki_category_ids[]` set to the test
 *   category, `page=1` and `limit` 1, 2, 100 and 1000,
 * - the same with a page behind the last one,
 * - the same with invalid values for `page` and `limit`,
 * - `GET /api/wiki/categories/{id}/pages/{identifier}` with a random,
 *   unknown identifier,
 * - if a second, forbidden category is given: the page list of it.
 * Writes: nothing.
 * Answers: how pagination works and which fields `meta.pagination` has,
 * the largest effective `limit` (echo or error), and the format of 400,
 * 404 and 403 responses. Exact numbers appear only where the question
 * needs them: the number of entries returned and the echo of `limit`.
 *
 * Usage: see README.md in this folder.
 *
 * @packageDocumentation
 */
import { randomUUID } from 'node:crypto';

import { readCategoryId } from './lib/env.mts';
import type { Guard, Json } from './lib/guard.mts';
import { pathFor, type Client, type ProbeResponse } from './lib/http.mts';
import { operations } from './lib/operations.mts';
import { main, type ProbeDefinition } from './lib/probe.mts';
import { describeResponse } from './lib/report.mts';
import {
  Schemas,
  findOperation,
  isObject,
  type JsonObject,
} from './lib/spec.mts';

const limits = [1, 2, 100, 1000] as const;
const invalidValues = [
  ['page', '0'],
  ['page', '-1'],
  ['page', 'x'],
  ['limit', '0'],
  ['limit', '-1'],
  ['limit', 'x'],
] as const;

const words = [
  'probe',
  '03-pagination-errors',
  'wikiPages',
  'wikiPage',
  'wikiCategoryPages',
  'nicht dokumentiert',
  'nicht geprüft',
  'parameterDokumentiert',
  'page',
  'limit',
  'wiki_category_ids[]',
  'ja',
  'nein',
  'limitTest',
  'angefragt',
  'eintraege',
  'limitEcho',
  'keine Liste',
  'kein Echo',
  'antwort',
  'hinterLetzterSeite',
  'ungueltigeWerte',
  'parameter',
  'wert',
  'unbekannteSeite',
  'gesperrteKategorie',
  'liste',
  'seitenliste',
  ...limits,
  ...invalidValues.flat(),
];

function entries(body: unknown): number | undefined {
  const data = isObject(body) ? body['data'] : undefined;
  return Array.isArray(data) ? data.length : undefined;
}

function pagination(body: unknown): JsonObject | undefined {
  const meta = isObject(body) ? body['meta'] : undefined;
  const value = isObject(meta) ? meta['pagination'] : undefined;
  return isObject(value) ? value : undefined;
}

// Exact numbers are allowed here on purpose: the question is how many
// entries come back and what the instance reports as its limit.
function exact(guard: Guard, value: number | undefined, missing: string): Json {
  if (value === undefined) {
    return missing;
  }
  guard.allowFixed(value);
  return value;
}

async function listPages(
  client: Client,
  category: number,
  page: string,
  limit: string,
): Promise<ProbeResponse> {
  return client.get({
    path: operations.wikiPages.template,
    query: [
      ['wiki_category_ids[]', String(category)],
      ['page', page],
      ['limit', limit],
    ],
  });
}

/** The probe, for tests and for {@link main}. */
export const probe: ProbeDefinition = {
  name: '03-pagination-errors',
  state: 'read',
  async run({ client, guard, state, env }): Promise<Json> {
    guard.allowFixed(...words);
    if (state === undefined) {
      throw new Error('INTERN');
    }
    const category =
      readCategoryId(env, 'ECCLIUM_SPIKE_WIKI_CATEGORY_ID', true) ?? 0;
    const forbidden = readCategoryId(
      env,
      'ECCLIUM_SPIKE_FORBIDDEN_CATEGORY_ID',
      false,
    );
    const document = state.specification;
    const schemas = new Schemas(document);
    const find = (
      name: 'wikiPages' | 'wikiPage' | 'wikiCategoryPages',
    ): JsonObject | undefined =>
      findOperation(
        document,
        operations[name].method,
        operations[name].template,
      );
    const list = find('wikiPages');
    const page = find('wikiPage');
    const categoryPages = find('wikiCategoryPages');
    const describeWith =
      (operation: JsonObject | undefined) => (response: ProbeResponse) =>
        describeResponse(response, { guard, schemas, operation });

    const output: Record<string, Json> = { probe: '03-pagination-errors' };
    if (list === undefined) {
      output['wikiPages'] = 'nicht dokumentiert';
    } else {
      const declared = schemas.queryParameters(list);
      output['parameterDokumentiert'] = Object.fromEntries(
        ['page', 'limit', 'wiki_category_ids[]'].map((name) => [
          name,
          declared.has(name) ? 'ja' : 'nein',
        ]),
      );
      const limitTest: Json[] = [];
      let lastPage: number | undefined;
      for (const limit of limits) {
        const response = await listPages(client, category, '1', String(limit));
        const echo = pagination(response.body)?.['limit'];
        const last = pagination(response.body)?.['lastPage'];
        if (
          limit === 1 &&
          typeof last === 'number' &&
          Number.isSafeInteger(last)
        ) {
          lastPage = last;
        }
        limitTest.push({
          angefragt: limit,
          eintraege: exact(guard, entries(response.body), 'keine Liste'),
          limitEcho: exact(
            guard,
            typeof echo === 'number' ? echo : undefined,
            'kein Echo',
          ),
          antwort: describeWith(list)(response),
        });
      }
      output['limitTest'] = limitTest;
      const behind = await listPages(
        client,
        category,
        String((lastPage ?? 999) + 1),
        '1',
      );
      output['hinterLetzterSeite'] = {
        eintraege: exact(guard, entries(behind.body), 'keine Liste'),
        antwort: describeWith(list)(behind),
      };
      const invalid: Json[] = [];
      for (const [name, value] of invalidValues) {
        const response = await listPages(
          client,
          category,
          name === 'page' ? value : '1',
          name === 'limit' ? value : '1',
        );
        invalid.push({
          parameter: name,
          wert: value,
          antwort: describeWith(list)(response),
        });
      }
      output['ungueltigeWerte'] = invalid;
    }

    if (page === undefined) {
      output['wikiPage'] = 'nicht dokumentiert';
    } else {
      const unknown = await client.get({
        path: pathFor(operations.wikiPage.template, category, randomUUID()),
      });
      output['unbekannteSeite'] = describeWith(page)(unknown);
    }

    if (forbidden === undefined) {
      output['gesperrteKategorie'] = 'nicht geprüft';
    } else {
      const forbiddenList =
        list === undefined
          ? undefined
          : await listPages(client, forbidden, '1', '1');
      const forbiddenPages =
        categoryPages === undefined
          ? undefined
          : await client.get({
              path: pathFor(operations.wikiCategoryPages.template, forbidden),
            });
      output['gesperrteKategorie'] = {
        liste:
          forbiddenList === undefined
            ? 'nicht dokumentiert'
            : describeWith(list)(forbiddenList),
        seitenliste:
          forbiddenPages === undefined
            ? 'nicht dokumentiert'
            : describeWith(categoryPages)(forbiddenPages),
      };
    }
    return output;
  },
};

if (import.meta.main) {
  process.exitCode = await main(probe, import.meta.url);
}
