/**
 * The docs index as the tools use it (ADR 0066): search and lookup over
 * the operations, the rights and the help pages, every result with the
 * attribution ADR 0027 asks for. Source, title or `operationId`, link or
 * path and the day the source was fetched; for the OpenAPI document also
 * its versions, its licence and that Ecclium prepared it.
 *
 * {@link openDocsIndex} builds the lookups once from a checked file. The
 * composition root calls it once per process and hands the result to the
 * tools. The data never change and are the same for every tenant, so
 * they are no state between requests in the sense of ADR 0051.
 *
 * @packageDocumentation
 */
import { type DocsIndexSearch, parseDocsIndex, rightKey } from './artifact.js';
import type {
  AcademyPage,
  Facts,
  OperationFact,
  RightFact,
  Sources,
} from './facts.js';
import { academyOrigin } from './hosts.js';
import { prepareSearch, type SearchHit } from './search/query.js';

/** Where an instance serves its OpenAPI document (ADR 0027). */
export const openApiDocumentPath = '/system/runtime/swagger/openapi.json';

/** The operation the facts about the rights come from (ADR 0027). */
export const permissionsPath = '/api/permissions/global';

/** Where a fact from the OpenAPI document comes from. */
export interface OpenApiAttribution {
  /** The source. */
  readonly source: 'openapi';
  /** The `operationId`. */
  readonly title: string;
  /** The path of the document on the own instance. */
  readonly path: typeof openApiDocumentPath;
  /** The day it was fetched, `JJJJ-MM-TT`. */
  readonly retrieved: string;
  /** The version the document names. */
  readonly documentVersion: string;
  /** The version of ChurchTools it was fetched from. */
  readonly churchToolsVersion: string;
  /** The licence of the document. */
  readonly license: 'CC BY 4.0';
  /** Ecclium prepared the facts from the document. */
  readonly adapted: true;
}

/** Where module, name and kind of a right come from. */
export interface PermissionsAttribution {
  /** The source. */
  readonly source: 'permissions';
  /** Module and name, such as `churchwiki: view`. */
  readonly title: string;
  /** The path of the operation on the own instance. */
  readonly path: typeof permissionsPath;
  /** The day it was fetched. */
  readonly retrieved: string;
  /** The version of ChurchTools it was fetched from. */
  readonly churchToolsVersion: string;
}

/** Where a text of the Academy comes from. */
export interface AcademyAttribution {
  /** The source. */
  readonly source: 'academy';
  /** The title of the page. */
  readonly title: string;
  /** The link to the page. */
  readonly link: string;
  /** The day it was fetched. */
  readonly retrieved: string;
}

/** The attribution of a result. */
export type Attribution =
  AcademyAttribution | OpenApiAttribution | PermissionsAttribution;

/** An operation the search found. */
export interface OperationHit {
  /** The `operationId`. */
  readonly operationId: string;
  /** The method of HTTP. */
  readonly method: OperationFact['method'];
  /** The path with its parameters. */
  readonly path: string;
  /** The summary, foreign text. */
  readonly summary?: string;
  /** Whether the document marks it as deprecated. */
  readonly deprecated: boolean;
  /** Where it comes from. */
  readonly attribution: OpenApiAttribution;
}

/** A right the search found. */
export interface RightHit {
  /** The module. */
  readonly module: string;
  /** The name. */
  readonly name: string;
  /** The kind of its value. */
  readonly kind: RightFact['kind'];
  /** The label, foreign text from a help page. */
  readonly label?: string;
  /** Where name and label come from, the label with its page. */
  readonly attributions: readonly Attribution[];
}

/** A help page the search found. */
export interface AcademyHit {
  /** The path on the Academy. */
  readonly path: string;
  /** The title. */
  readonly title: string;
  /** The slug of its section. */
  readonly section: string;
  /** Where it comes from, with the link. */
  readonly attribution: AcademyAttribution;
}

/** A page that explains a right. */
export interface ExplainingPage {
  /** The path on the Academy. */
  readonly path: string;
  /** Where it comes from: title, link and the day it was fetched. */
  readonly attribution: AcademyAttribution;
}

/** The docs index, frozen. */
export interface DocsIndex {
  /** When and from what the facts came. */
  readonly sources: Sources;
  /**
   * Searches the operations.
   *
   * @param query - The words to look for.
   * @param limit - The most hits, from 1 to 100.
   * @returns The hits, best first.
   * @throws {RangeError} If the limit is out of range.
   */
  searchOperations(query: string, limit: number): readonly OperationHit[];
  /**
   * Looks up an operation.
   *
   * @param operationId - Its ID.
   * @returns Its facts and attribution, or undefined if there is none.
   */
  getOperation(
    operationId: string,
  ):
    | { readonly fact: OperationFact; readonly attribution: OpenApiAttribution }
    | undefined;
  /**
   * Searches the rights.
   *
   * @param query - The words to look for.
   * @param limit - The most hits, from 1 to 100.
   * @returns The hits, best first.
   * @throws {RangeError} If the limit is out of range.
   */
  searchRights(query: string, limit: number): readonly RightHit[];
  /**
   * Looks up a right.
   *
   * @param module - Its module.
   * @param name - Its name.
   * @returns Its facts, the pages that explain it and the attributions,
   *   or undefined if there is none.
   */
  getRight(
    module: string,
    name: string,
  ):
    | {
        readonly fact: RightFact;
        readonly pages: readonly ExplainingPage[];
        readonly attributions: readonly Attribution[];
      }
    | undefined;
  /**
   * Searches the help pages.
   *
   * @param query - The words to look for.
   * @param limit - The most hits, from 1 to 100.
   * @returns The hits, best first.
   * @throws {RangeError} If the limit is out of range.
   */
  searchAcademy(query: string, limit: number): readonly AcademyHit[];
  /**
   * Looks up a help page.
   *
   * @param path - Its path on the Academy.
   * @returns Its facts and attribution, or undefined if there is none.
   */
  getAcademyPage(
    path: string,
  ):
    | { readonly fact: AcademyPage; readonly attribution: AcademyAttribution }
    | undefined;
}

/**
 * Opens a built docs index: checks it with {@link parseDocsIndex} and
 * prepares the searches and lookups.
 *
 * @param text - The text of the built file.
 * @returns The index, frozen.
 * @throws {DocsIndexError} If the file breaks a rule.
 * @example
 * ```ts
 * const index = openDocsIndex(text);
 * index.searchRights('Gruppenmitglieder sehen', 5);
 * ```
 */
export function openDocsIndex(text: string): DocsIndex {
  const { facts, search } = parseDocsIndex(text);
  return createDocsIndex(facts, search);
}

function createDocsIndex(facts: Facts, search: DocsIndexSearch): DocsIndex {
  // The facts reach the tools as they are, so nothing may change them.
  deepFreeze(facts);
  const { sources } = facts;
  const searchers = {
    operations: prepareSearch(search.operations),
    rights: prepareSearch(search.rights),
    academy: prepareSearch(search.academy),
  };
  const operations = new Map(
    facts.operations.entries.map((fact) => [fact.operationId, fact]),
  );
  const rights = new Map(
    facts.rights.entries.map((fact) => [
      rightKey(fact.module, fact.name),
      fact,
    ]),
  );
  const pages = new Map(facts.academy.entries.map((page) => [page.path, page]));

  const day = (time: string | undefined) => (time ?? '').slice(0, 10);

  const operationAttribution = (fact: OperationFact): OpenApiAttribution =>
    Object.freeze({
      source: 'openapi',
      title: fact.operationId,
      path: openApiDocumentPath,
      retrieved: day(sources.openapi?.retrievedAt),
      documentVersion: sources.openapi?.documentVersion ?? '',
      churchToolsVersion: sources.openapi?.churchToolsVersion ?? '',
      license: 'CC BY 4.0',
      adapted: true,
    });

  const pageAttribution = (page: AcademyPage): AcademyAttribution =>
    Object.freeze({
      source: 'academy',
      title: page.title,
      link: `${academyOrigin}${page.path}`,
      retrieved: day(sources.academy?.retrievedAt),
    });

  const rightAttributions = (fact: RightFact): readonly Attribution[] => {
    const attributions: Attribution[] = [
      Object.freeze({
        source: 'permissions',
        title: `${fact.module}: ${fact.name}`,
        path: permissionsPath,
        retrieved: day(sources.permissions?.retrievedAt),
        churchToolsVersion: sources.permissions?.churchToolsVersion ?? '',
      }),
    ];
    const labelPage =
      fact.label === undefined || !('page' in fact.label)
        ? undefined
        : pages.get(fact.label.page);
    if (labelPage !== undefined) {
      attributions.push(pageAttribution(labelPage));
    }
    return Object.freeze(attributions);
  };

  const pick = <T>(
    hits: readonly SearchHit[],
    entries: readonly T[],
  ): readonly T[] =>
    hits.flatMap(({ index }) => {
      const entry = entries[index];
      return entry === undefined ? [] : [entry];
    });

  return Object.freeze({
    sources,
    searchOperations: (query: string, limit: number) =>
      Object.freeze(
        pick(
          searchers.operations.search(query, limit),
          facts.operations.entries,
        ).map((fact) =>
          Object.freeze({
            operationId: fact.operationId,
            method: fact.method,
            path: fact.path,
            ...(fact.summary === undefined ? {} : { summary: fact.summary }),
            deprecated: fact.deprecated,
            attribution: operationAttribution(fact),
          }),
        ),
      ),
    getOperation: (operationId: string) => {
      const fact = operations.get(operationId);
      return fact === undefined
        ? undefined
        : Object.freeze({ fact, attribution: operationAttribution(fact) });
    },
    searchRights: (query: string, limit: number) =>
      Object.freeze(
        pick(searchers.rights.search(query, limit), facts.rights.entries).map(
          (fact) =>
            Object.freeze({
              module: fact.module,
              name: fact.name,
              kind: fact.kind,
              ...(fact.label === undefined ? {} : { label: fact.label.text }),
              attributions: rightAttributions(fact),
            }),
        ),
      ),
    getRight: (module: string, name: string) => {
      const fact = rights.get(rightKey(module, name));
      if (fact === undefined) {
        return undefined;
      }
      const explaining = fact.pages.flatMap((path) => {
        const page = pages.get(path);
        return page === undefined
          ? []
          : [Object.freeze({ path, attribution: pageAttribution(page) })];
      });
      return Object.freeze({
        fact,
        pages: Object.freeze(explaining),
        attributions: rightAttributions(fact),
      });
    },
    searchAcademy: (query: string, limit: number) =>
      Object.freeze(
        pick(searchers.academy.search(query, limit), facts.academy.entries).map(
          (page) =>
            Object.freeze({
              path: page.path,
              title: page.title,
              section: page.section,
              attribution: pageAttribution(page),
            }),
        ),
      ),
    getAcademyPage: (path: string) => {
      const page = pages.get(path);
      return page === undefined
        ? undefined
        : Object.freeze({ fact: page, attribution: pageAttribution(page) });
    },
  });
}

function deepFreeze(value: unknown): void {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
  }
}
