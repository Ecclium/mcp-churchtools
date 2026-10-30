/**
 * The part of the course of the smoke test with the six docs tools.
 *
 * The docs tools read only the docs index that comes with the built server,
 * never ChurchTools (ADR 0066). The smoke test therefore calls them in
 * every run, also without its switch, and so checks the index of the
 * installation as well. Each search and each read takes fixed values that
 * the facts of every build hold: a search of operations and the members of
 * a group by method and path, as the acceptance test asks, a search of
 * rights and `churchdb: view alldata`, a search of the Academy and the
 * first page it found. The checks look at the form of each result, the
 * names of its sources and the data envelope around every text, not at
 * the wording of the docs, which a later refresh may change.
 *
 * The values of the docs are public and never reach the result, which
 * holds only fixed words, so they go onto no list of the guard.
 *
 * @packageDocumentation
 */
import { countClass } from '../spike/lib/structure.mts';
import { envelope, isRecord, sameKeys, type Steps } from './answers.mts';

/** The six docs tools, in the order the server lists them. */
export const docsTools = [
  'ct_docs_get_operation',
  'ct_docs_get_right',
  'ct_docs_read_academy',
  'ct_docs_search_academy',
  'ct_docs_search_api',
  'ct_docs_search_rights',
] as const;

/** The words of the result of this part, for the allow list. */
export const docsWords = [...docsTools] as const;

/** The codes of the checks of this part that can fail. */
export const docsCodes = [
  'doku_operationen',
  'doku_operation',
  'doku_rechte',
  'doku_recht',
  'doku_academy',
  'doku_hilfeseite',
] as const;

// The fixed names of the sources a result of the docs tools names
// (ADR 0027).
const openApiName = 'OpenAPI document of ChurchTools';
const permissionsName = 'Rights of a ChurchTools instance';
const academyName = 'ChurchTools Academy';
const academyHost = 'https://churchtools.academy/de/';

// The most hits the course asks a search for.
const hitLimit = 5;

const enveloped = (value: unknown): boolean =>
  typeof value === 'string' && envelope.test(value);
const optionalEnveloped = (value: unknown): boolean =>
  value === null || enveloped(value);

// The OpenAPI document under CC BY 4.0, adapted for the facts (ADR 0027).
const openApiSourceFits = (source: unknown): boolean =>
  isRecord(source) &&
  source['name'] === openApiName &&
  source['license'] === 'CC BY 4.0' &&
  source['adapted'] === true;

const academySourceFits = (source: unknown): boolean =>
  isRecord(source) &&
  source['name'] === academyName &&
  typeof source['terms'] === 'string';

// A link to the Academy, the only host the facts may name besides the
// placeholder (ADR 0027).
const academyLinkFits = (value: unknown): boolean =>
  typeof value === 'string' && value.startsWith(academyHost);

// A list of hits of a search: one to the limit, each in its form.
const hitsFit = (
  hits: unknown,
  fits: (hit: Record<string, unknown>) => boolean,
): hits is readonly unknown[] =>
  Array.isArray(hits) &&
  hits.length >= 1 &&
  hits.length <= hitLimit &&
  hits.every((hit: unknown) => isRecord(hit) && fits(hit));

const count = (hits: unknown): string =>
  countClass(Array.isArray(hits) ? hits.length : 0);

/**
 * Calls the six docs tools, each once, and checks their results. None of
 * them may send a request to ChurchTools, which the count of requests of
 * the course shows.
 *
 * @param steps - Calls and records of the course.
 */
export async function runDocs(steps: Steps): Promise<void> {
  // ct_docs_search_api: operations with method, path and summary.
  const operations = (
    await steps.call(
      'ct_docs_search_api',
      { query: 'group members', limit: hitLimit },
      'ok',
    )
  )?.data;
  const operationsFit =
    operations !== undefined &&
    sameKeys(operations, ['hits', 'more', 'source']) &&
    hitsFit(
      operations['hits'],
      (hit) =>
        sameKeys(hit, [
          'deprecated',
          'method',
          'operationId',
          'path',
          'summary',
        ]) &&
        typeof hit['operationId'] === 'string' &&
        typeof hit['method'] === 'string' &&
        typeof hit['path'] === 'string' &&
        hit['path'].startsWith('/api/') &&
        typeof hit['deprecated'] === 'boolean' &&
        optionalEnveloped(hit['summary']),
    ) &&
    typeof operations['more'] === 'boolean' &&
    openApiSourceFits(operations['source']);
  if (!operationsFit) steps.fail('doku_operationen');
  steps.report({
    tool: 'ct_docs_search_api',
    ergebnis: operationsFit ? 'ok' : 'gescheitert',
    treffer: count(operations?.['hits']),
  });

  // ct_docs_get_operation by method and path as a request writes them:
  // the members of a group, whose rights the mapping holds with evidence
  // (F29), the definition as text in the envelope.
  const operation = (
    await steps.call(
      'ct_docs_get_operation',
      { method: 'GET', path: '/api/groups/12/members' },
      'ok',
    )
  )?.data;
  const rights = operation?.['rights'];
  const needs = isRecord(rights) ? rights['needs'] : undefined;
  const operationFits =
    operation !== undefined &&
    sameKeys(operation, [
      'definition',
      'deprecated',
      'method',
      'operationId',
      'part',
      'parts',
      'path',
      'rights',
      'source',
      'summary',
    ]) &&
    typeof operation['operationId'] === 'string' &&
    operation['method'] === 'GET' &&
    typeof operation['path'] === 'string' &&
    operation['path'].startsWith('/api/groups/') &&
    operation['path'].endsWith('/members') &&
    isRecord(rights) &&
    rights['status'] === 'needs' &&
    Array.isArray(needs) &&
    needs.length >= 1 &&
    enveloped(operation['definition']) &&
    optionalEnveloped(operation['summary']) &&
    operation['part'] === 1 &&
    typeof operation['parts'] === 'number' &&
    operation['parts'] >= 1 &&
    openApiSourceFits(operation['source']);
  if (!operationFits) steps.fail('doku_operation');
  steps.report({
    tool: 'ct_docs_get_operation',
    ergebnis: operationFits ? 'ok' : 'gescheitert',
  });

  // ct_docs_search_rights: module, name, kind and label of each right.
  const rightsFound = (
    await steps.call(
      'ct_docs_search_rights',
      { query: 'view alldata', limit: hitLimit },
      'ok',
    )
  )?.data;
  const permissionsSource = rightsFound?.['source'];
  const rightsFit =
    rightsFound !== undefined &&
    sameKeys(rightsFound, ['academy', 'hits', 'more', 'source']) &&
    hitsFit(
      rightsFound['hits'],
      (hit) =>
        sameKeys(hit, ['kind', 'label', 'labelSource', 'module', 'name']) &&
        typeof hit['module'] === 'string' &&
        typeof hit['name'] === 'string' &&
        optionalEnveloped(hit['label']),
    ) &&
    typeof rightsFound['more'] === 'boolean' &&
    isRecord(permissionsSource) &&
    permissionsSource['name'] === permissionsName &&
    academySourceFits(rightsFound['academy']);
  if (!rightsFit) steps.fail('doku_rechte');
  steps.report({
    tool: 'ct_docs_search_rights',
    ergebnis: rightsFit ? 'ok' : 'gescheitert',
    treffer: count(rightsFound?.['hits']),
  });

  // ct_docs_get_right: the right that reads persons of an area, with the
  // operations that need it and the help pages that explain it.
  const right = (
    await steps.call(
      'ct_docs_get_right',
      { module: 'churchdb', name: 'view alldata' },
      'ok',
    )
  )?.data;
  const neededBy = right?.['neededBy'];
  const pages = right?.['pages'];
  const rightSource = right?.['source'];
  const rightFits =
    right !== undefined &&
    sameKeys(right, [
      'academy',
      'kind',
      'label',
      'labelSource',
      'module',
      'moreNeededBy',
      'moreNotNeededBy',
      'name',
      'neededBy',
      'note',
      'notNeededBy',
      'pages',
      'source',
    ]) &&
    right['module'] === 'churchdb' &&
    right['name'] === 'view alldata' &&
    optionalEnveloped(right['label']) &&
    Array.isArray(neededBy) &&
    neededBy.length >= 1 &&
    Array.isArray(pages) &&
    pages.every(
      (page: unknown) =>
        isRecord(page) &&
        enveloped(page['title']) &&
        academyLinkFits(page['link']),
    ) &&
    isRecord(rightSource) &&
    rightSource['name'] === permissionsName &&
    academySourceFits(right['academy']);
  if (!rightFits) steps.fail('doku_recht');
  steps.report({
    tool: 'ct_docs_get_right',
    ergebnis: rightFits ? 'ok' : 'gescheitert',
  });

  // ct_docs_search_academy: title, path and link of each help page.
  const academy = (
    await steps.call(
      'ct_docs_search_academy',
      { query: 'Rechte', limit: hitLimit },
      'ok',
    )
  )?.data;
  const academyHits = academy?.['hits'];
  const academyFits =
    academy !== undefined &&
    sameKeys(academy, ['hits', 'more', 'source']) &&
    hitsFit(
      academyHits,
      (hit) =>
        sameKeys(hit, ['link', 'path', 'section', 'title']) &&
        enveloped(hit['title']) &&
        typeof hit['path'] === 'string' &&
        hit['path'].startsWith('/de/') &&
        academyLinkFits(hit['link']) &&
        typeof hit['section'] === 'string',
    ) &&
    typeof academy['more'] === 'boolean' &&
    academySourceFits(academy['source']);
  if (!academyFits) steps.fail('doku_academy');
  steps.report({
    tool: 'ct_docs_search_academy',
    ergebnis: academyFits ? 'ok' : 'gescheitert',
    treffer: count(academyHits),
  });

  // ct_docs_read_academy with the first page found: title and text in the
  // envelope, the link to the Academy. Without a hit the search failed
  // already, so this read is one without data, not a second failure.
  const first: unknown =
    academyFits && Array.isArray(academyHits) ? academyHits[0] : undefined;
  const path = isRecord(first) ? first['path'] : undefined;
  if (typeof path !== 'string') {
    steps.withoutData('ct_docs_read_academy');
    return;
  }
  const page = (await steps.call('ct_docs_read_academy', { path }, 'ok'))?.data;
  const pageFits =
    page !== undefined &&
    sameKeys(page, [
      'link',
      'modified',
      'part',
      'parts',
      'path',
      'section',
      'source',
      'text',
      'title',
    ]) &&
    page['path'] === path &&
    enveloped(page['title']) &&
    enveloped(page['text']) &&
    academyLinkFits(page['link']) &&
    page['part'] === 1 &&
    typeof page['parts'] === 'number' &&
    page['parts'] >= 1 &&
    academySourceFits(page['source']);
  if (!pageFits) steps.fail('doku_hilfeseite');
  steps.report({
    tool: 'ct_docs_read_academy',
    ergebnis: pageFits ? 'ok' : 'gescheitert',
  });
}
