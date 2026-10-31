/**
 * The part of the course of the smoke test with the two tools of the
 * escape hatch, the toolset `api` (ADR 0067).
 *
 * `ct_api_execute_read` passes on whole answers of ChurchTools, not fixed
 * fields. The smoke test calls it only with its own switch, which it takes
 * only together with the switch for the search tools, so only behind the
 * guard of the test instance (ADR 0049). The calls do not depend on the
 * data of the instance: the categories of the wiki, among which the guard
 * already found the identification category, and the rights of the
 * account. Three more calls must be refused before any request: the CSRF
 * token, which Ecclium never reads, an `operationId` that does not exist
 * and a value of the path that tries to leave its template. The count of
 * requests of the course and the audit file show that they sent nothing.
 *
 * Every value of an answer goes onto the block list of the guard, and the
 * names of the categories onto the texts no line of log or audit may hold.
 *
 * @packageDocumentation
 */
import { countClass } from '../spike/lib/structure.mts';
import {
  envelope,
  isRecord,
  sameKeys,
  type Steps,
  type ToolResult,
  unwrap,
} from './answers.mts';

/** The two tools of the escape hatch, in the order the server lists them. */
export const apiTools = [
  'ct_api_execute_read',
  'ct_api_search_actions',
] as const;

/**
 * The start of the warning the server writes to stderr at every start with
 * the toolset `api`, before its first line of JSON.
 */
export const apiWarning = 'Das Toolset ‹api› ist eingeschaltet.';

// The labels of the calls in the result, one per operation or refusal.
const labels = {
  categories: 'ct_api_execute_read get-wiki-categories',
  rights: 'ct_api_execute_read get-permissions-global',
  csrf: 'ct_api_execute_read get-csrftoken',
  unknown: 'ct_api_execute_read unbekannt',
  path: 'ct_api_execute_read pfad',
} as const;

/** The words of the result of this part, for the allow list. */
export const apiWords = [...apiTools, ...Object.values(labels)] as const;

/** The codes of the checks of this part that can fail. */
export const apiCodes = [
  'api_suche',
  'api_kategorien',
  'api_rechte',
  'api_ausgeschlossen',
  'api_unbekannt',
  'api_pfad',
  'api_warnung',
] as const;

const sensitivities: ReadonlySet<unknown> = new Set([
  'none',
  'personal',
  'special',
]);
const rightsStates: ReadonlySet<unknown> = new Set([
  'needs',
  'none',
  'open',
  'unmapped',
]);

// The most hits the course asks the search for.
const hitLimit = 5;

/** What one read of the escape hatch gave. */
interface Read {
  /** Whether the result has its form and the answer is JSON in the envelope. */
  readonly fits: boolean;
  /** The answer, parsed. */
  readonly root: unknown;
}

// A read as ct_api_execute_read gives it: the operation, the sensitivity
// of its answer and the answer as JSON text in the data envelope.
const readOf = (result: ToolResult | undefined, operationId: string): Read => {
  const data = result?.isError === false ? result.data : undefined;
  const text = unwrap(data?.['answer']);
  let root: unknown;
  try {
    root = text === undefined ? undefined : JSON.parse(text);
  } catch {
    root = undefined;
  }
  return {
    fits:
      data !== undefined &&
      sameKeys(data, ['answer', 'operationId', 'sensitivity']) &&
      data['operationId'] === operationId &&
      sensitivities.has(data['sensitivity']) &&
      isRecord(root),
    root,
  };
};

/**
 * Calls the two tools of the escape hatch and checks their results.
 *
 * @param steps - Calls and records of the course.
 * @returns How many requests the calls sent to ChurchTools.
 */
export async function runApi(steps: Steps): Promise<number> {
  let requests = 0;

  // ct_api_search_actions: only operations the core reads, with their
  // parameters, sensitivity and rights. It reads only the docs index.
  const found = (
    await steps.call(
      'ct_api_search_actions',
      { query: 'wiki categories', limit: hitLimit },
      'ok',
    )
  )?.data;
  const hits = found?.['hits'];
  const source = found?.['source'];
  const searchFits =
    found !== undefined &&
    sameKeys(found, ['hits', 'more', 'source']) &&
    Array.isArray(hits) &&
    hits.length >= 1 &&
    hits.length <= hitLimit &&
    hits.every(
      (hit: unknown) =>
        isRecord(hit) &&
        sameKeys(hit, [
          'operationId',
          'path',
          'pathParameters',
          'queryParameters',
          'rights',
          'sensitivity',
          'summary',
        ]) &&
        typeof hit['operationId'] === 'string' &&
        typeof hit['path'] === 'string' &&
        hit['path'].startsWith('/api/') &&
        Array.isArray(hit['pathParameters']) &&
        Array.isArray(hit['queryParameters']) &&
        sensitivities.has(hit['sensitivity']) &&
        isRecord(hit['rights']) &&
        rightsStates.has(hit['rights']['status']) &&
        (hit['summary'] === null ||
          (typeof hit['summary'] === 'string' &&
            envelope.test(hit['summary']))),
    ) &&
    typeof found['more'] === 'boolean' &&
    isRecord(source) &&
    source['license'] === 'CC BY 4.0';
  if (!searchFits) steps.fail('api_suche');
  steps.report({
    tool: 'ct_api_search_actions',
    ergebnis: searchFits ? 'ok' : 'gescheitert',
    treffer: countClass(Array.isArray(hits) ? hits.length : 0),
  });

  // The categories of the wiki: never empty, since the guard found the
  // identification category. One request.
  requests += 1;
  const categories = readOf(
    await steps.call(
      'ct_api_execute_read',
      { operationId: 'get-wiki-categories' },
      'ok',
    ),
    'get-wiki-categories',
  );
  steps.block(categories.root);
  const entries = isRecord(categories.root)
    ? categories.root['data']
    : undefined;
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (isRecord(entry)) steps.see(entry['name']);
    }
  }
  const categoriesFit =
    categories.fits && Array.isArray(entries) && entries.length >= 1;
  if (!categoriesFit) steps.fail('api_kategorien');
  steps.report({
    tool: labels.categories,
    ergebnis: categoriesFit ? 'ok' : 'gescheitert',
  });

  // The rights of the account, by module. One request.
  requests += 1;
  const rights = readOf(
    await steps.call(
      'ct_api_execute_read',
      { operationId: 'get-permissions-global' },
      'ok',
    ),
    'get-permissions-global',
  );
  steps.block(rights.root);
  const rightsFit =
    rights.fits && isRecord(rights.root) && isRecord(rights.root['data']);
  if (!rightsFit) steps.fail('api_rechte');
  steps.report({
    tool: labels.rights,
    ergebnis: rightsFit ? 'ok' : 'gescheitert',
  });

  // Three refusals before any request: an operation the core never reads,
  // one that does not exist and a value of the path outside its form.
  const refusals = [
    [
      labels.csrf,
      { operationId: 'get-csrftoken' },
      'policy_denied',
      'api_ausgeschlossen',
    ],
    [
      labels.unknown,
      { operationId: 'get-nothing-at-all' },
      'validation',
      'api_unbekannt',
    ],
    [
      labels.path,
      {
        operationId: 'get-wiki-categories-id-pages',
        path: { wikiCategoryId: '../1' },
      },
      'validation',
      'api_pfad',
    ],
  ] as const;
  for (const [label, args, expect, code] of refusals) {
    const refused =
      (await steps.call('ct_api_execute_read', args, expect))?.isError === true;
    if (!refused) steps.fail(code);
    steps.report({
      tool: label,
      ergebnis: refused ? 'abgewiesen' : 'nicht abgewiesen',
    });
  }
  return requests;
}
