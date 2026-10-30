/**
 * The docs index as the tools use it (ADR 0066): search and lookup over
 * the operations, the rights and the help pages, the lookups with the
 * rights an operation needs and the operations that need a right, as far
 * as the mapping by hand shows them with evidence, every result with the
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
  NotNeededRight,
  OperationFact,
  OperationRights,
  RightFact,
  RightNeed,
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

/** The file of the repository of Ecclium that holds the findings. */
export const findingsPath = 'docs/research/churchtools-api.md';

/**
 * Where a label of a right comes from that no help page names: the web
 * interface of ChurchTools as a finding of the project recorded it
 * (ADR 0066).
 */
export interface FindingAttribution {
  /** The source. */
  readonly source: 'finding';
  /** The number or title of the finding, such as `F36`. */
  readonly title: string;
  /** The file of the findings in the repository of Ecclium. */
  readonly path: typeof findingsPath;
  /** The version of ChurchTools the finding saw. */
  readonly churchToolsVersion: string;
}

/** The attribution of a result. */
export type Attribution =
  | AcademyAttribution
  | FindingAttribution
  | OpenApiAttribution
  | PermissionsAttribution;

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

/**
 * An operation that needs a right, with the pairing that says so: the
 * rights of which one suffices, what a read gives without them and the
 * evidence.
 */
export interface NeedingOperation {
  /** The `operationId`. */
  readonly operationId: string;
  /** The method of HTTP. */
  readonly method: OperationFact['method'];
  /** The path with its parameters. */
  readonly path: string;
  /** The pairing that names the right. */
  readonly need: RightNeed;
}

/** An operation a finding showed does not need a right. */
export interface NotNeedingOperation {
  /** The `operationId`. */
  readonly operationId: string;
  /** The method of HTTP. */
  readonly method: OperationFact['method'];
  /** The path with its parameters. */
  readonly path: string;
  /** The right and the evidence. */
  readonly notNeeded: NotNeededRight;
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
   * @returns Its facts and attribution and, where the mapping has it, the
   *   rights it needs, or undefined if there is no such operation.
   */
  getOperation(operationId: string):
    | {
        readonly fact: OperationFact;
        readonly attribution: OpenApiAttribution;
        readonly rights?: OperationRights;
      }
    | undefined;
  /**
   * Finds the operations whose path fits a path as a request or a message
   * writes it: with or without the base `/api`, with values such as
   * `/groups/12/members` or with placeholders of any name such as
   * `/groups/{id}/members`. A value fits a placeholder of the document, a
   * placeholder only a placeholder, and a fixed part only the same text.
   * Of all that fit, only those with the most fixed parts count, so that
   * `/groups/members` finds that operation and not `/groups/{groupId}`.
   *
   * @param method - The method of HTTP in small letters, such as `get`.
   * @param path - The path, starting with `/`, without query.
   * @returns The `operationId` of each operation that fits best, sorted;
   *   more than one only where the document has two such paths. Empty
   *   when none fits or the path is not one.
   */
  findOperationsByPath(method: string, path: string): readonly string[];
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
   * @returns Its facts, the pages that explain it, the attributions and
   *   the operations that need it or, by a finding, do not, each sorted by
   *   `operationId`, or undefined if there is none.
   */
  getRight(
    module: string,
    name: string,
  ):
    | {
        readonly fact: RightFact;
        readonly pages: readonly ExplainingPage[];
        readonly attributions: readonly Attribution[];
        readonly neededBy: readonly NeedingOperation[];
        readonly notNeededBy: readonly NotNeedingOperation[];
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
  const mapping = new Map(
    facts.operationRights.entries.map((entry) => [entry.operationId, entry]),
  );
  // Each right with the operations that name it, in the order of the
  // mapping, which is sorted by `operationId`.
  const neededBy = new Map<string, NeedingOperation[]>();
  const notNeededBy = new Map<string, NotNeedingOperation[]>();
  const add = <T>(lists: Map<string, T[]>, key: string, item: T) => {
    const list = lists.get(key) ?? [];
    list.push(Object.freeze(item));
    lists.set(key, list);
  };
  for (const entry of facts.operationRights.entries) {
    const operation = operations.get(entry.operationId);
    if (operation === undefined) {
      continue;
    }
    const { operationId, method, path } = operation;
    if ('needs' in entry) {
      for (const need of entry.needs) {
        for (const right of need.rights) {
          add(neededBy, rightKey(right.module, right.name), {
            operationId,
            method,
            path,
            need,
          });
        }
      }
    }
    if ('notNeeded' in entry) {
      for (const item of entry.notNeeded ?? []) {
        add(notNeededBy, rightKey(item.right.module, item.right.name), {
          operationId,
          method,
          path,
          notNeeded: item,
        });
      }
    }
  }

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
    const { label } = fact;
    if (label !== undefined && 'page' in label) {
      const labelPage = pages.get(label.page);
      if (labelPage !== undefined) {
        attributions.push(pageAttribution(labelPage));
      }
    } else if (label !== undefined) {
      // No help page names the right: the label is the wording of the web
      // interface as the finding recorded it, so it names that finding.
      attributions.push(
        Object.freeze({
          source: 'finding',
          title: label.finding,
          path: findingsPath,
          churchToolsVersion: label.version,
        }),
      );
    }
    return Object.freeze(attributions);
  };

  // The paths of the operations by method, cut into their parts once. A
  // part in braces is a placeholder of the document.
  const templates = new Map<
    string,
    { readonly operationId: string; readonly parts: readonly string[] }[]
  >();
  for (const fact of facts.operations.entries) {
    const list = templates.get(fact.method) ?? [];
    list.push({ operationId: fact.operationId, parts: fact.path.split('/') });
    templates.set(fact.method, list);
  }
  const isPlaceholder = (part: string) => /^\{[^{}/]+\}$/u.test(part);

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
      if (fact === undefined) {
        return undefined;
      }
      const rights = mapping.get(operationId);
      return Object.freeze({
        fact,
        attribution: operationAttribution(fact),
        ...(rights === undefined ? {} : { rights }),
      });
    },
    findOperationsByPath: (method: string, path: string) => {
      // The document writes its paths below the base /api of its servers.
      const below = /^\/api(?=\/|$)/u.test(path) ? path.slice(4) : path;
      const trimmed =
        below.length > 1 && below.endsWith('/') ? below.slice(0, -1) : below;
      if (!trimmed.startsWith('/') || /[?#\s]/u.test(trimmed)) {
        return Object.freeze([]);
      }
      const asked = trimmed.split('/');
      let best = -1;
      let found: string[] = [];
      for (const { operationId, parts } of templates.get(method) ?? []) {
        if (parts.length !== asked.length) continue;
        let fixed = 0;
        const fits = parts.every((part, at) => {
          const given = asked[at] ?? '';
          if (isPlaceholder(part)) {
            return (
              given !== '' && (isPlaceholder(given) || !given.includes('{'))
            );
          }
          if (part === given) {
            fixed += 1;
            return true;
          }
          return false;
        });
        if (!fits || fixed < best) continue;
        if (fixed > best) {
          best = fixed;
          found = [];
        }
        found.push(operationId);
      }
      return Object.freeze(found.sort());
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
      const key = rightKey(module, name);
      return Object.freeze({
        fact,
        pages: Object.freeze(explaining),
        attributions: rightAttributions(fact),
        neededBy: Object.freeze([...(neededBy.get(key) ?? [])]),
        notNeededBy: Object.freeze([...(notNeededBy.get(key) ?? [])]),
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
