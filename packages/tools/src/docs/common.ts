/**
 * What the six docs tools share: the limits of a search, the schemas of
 * the sources every result names (ADR 0027) and of the evidence of the
 * mapping of operations to rights, and the copies from the index into
 * them (ADR 0066).
 *
 * The docs tools read only the index of the ChurchTools documentation
 * that comes with Ecclium, never ChurchTools itself. Names of operations
 * and rights, methods, paths and links carry the data class `none`;
 * every text from the OpenAPI document, the Academy or the web interface
 * of ChurchTools carries `untrusted` and stands in the data envelope
 * (ADR 0026). The texts the project writes itself, such as the reason of
 * an open mapping, carry `none`.
 *
 * @packageDocumentation
 */
import {
  type DocsIndex,
  findingsPath,
  type NeedEvidence,
  type OperationFact,
  openApiDocumentPath,
  permissionsPath,
  type PlainEvidence,
  type RightRef,
  type Sources,
} from '@ecclium/mcp-churchtools-docs-index';
import { classify } from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

/** The most hits of a search. */
export const maxDocsHits = 25;

/** The hits of a search when the call names no limit. */
export const defaultDocsHits = 10;

/** The most characters of the words of a search. */
export const maxDocsQueryLength = 200;

// The words of a search: not blank and without control characters, so
// that nothing but words reaches the search.
const query = classify(
  z
    .string()
    .min(1)
    .max(maxDocsQueryLength)
    .regex(/\S/u)
    .regex(/^\P{Cc}*$/u),
  'none',
);

/**
 * The input of a search: the words and how many hits at most. Strict, so
 * that an argument the model made up ends as a validation error.
 */
export const searchInput = z.strictObject({
  query,
  limit: classify(z.number().int().min(1).max(maxDocsHits), 'none').optional(),
});

/** The checked input of a search. */
export type SearchInput = z.output<typeof searchInput>;

/**
 * Runs a search with one hit more than asked for, so that the result can
 * say whether more matched without a second search.
 *
 * @param search - The search of the index, bound to one source.
 * @param input - The checked input.
 * @returns The hits to give and whether more matched.
 * @example
 * ```ts
 * searchWithMore((q, n) => docs.searchRights(q, n), { query: 'Wiki' });
 * ```
 */
export function searchWithMore<T>(
  search: (query: string, limit: number) => readonly T[],
  input: SearchInput,
): { readonly hits: readonly T[]; readonly more: boolean } {
  const limit = input.limit ?? defaultDocsHits;
  const hits = search(input.query.trim(), limit + 1);
  return { hits: hits.slice(0, limit), more: hits.length > limit };
}

/**
 * The path of an operation as a request writes it. The OpenAPI document
 * names its paths below the base `/api` of its `servers`, which the facts
 * leave out (ADR 0066).
 *
 * @param path - The path from the facts, such as `/groups/{groupId}`.
 * @returns The path below the host, such as `/api/groups/{groupId}`.
 * @example
 * ```ts
 * apiPath('/groups/{groupId}/members'); // '/api/groups/{groupId}/members'
 * ```
 */
export const apiPath = (path: string): string => `/api${path}`;

/**
 * The methods of HTTP of the facts, as a request writes them: every one
 * the facts allow, so that no operation of a later refresh breaks a
 * result. A test holds the list equal to the methods of the facts.
 */
export const httpMethods = Object.freeze([
  'DELETE',
  'GET',
  'HEAD',
  'OPTIONS',
  'PATCH',
  'POST',
  'PUT',
  'TRACE',
] as const);

/**
 * A method of the facts as a request writes it.
 *
 * @param method - The method in small letters, as the facts hold it.
 * @returns The method in capitals.
 * @example
 * ```ts
 * httpMethod('get'); // 'GET'
 * ```
 */
export const httpMethod = (
  method: OperationFact['method'],
): (typeof httpMethods)[number] =>
  method.toUpperCase() as (typeof httpMethods)[number];

// The forms the facts allow, checked again here, so that nothing else
// passes outside the data envelope even if a layer before let it through.
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const version = z.string().regex(/^\d{1,4}\.\d{1,4}(?:\.\d{1,4})?$/);
const name = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/);

/** An `operationId` as the facts allow it, outside the data envelope. */
export const operationIdOutput = classify(
  z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/),
  'none',
);

/** A method of HTTP, outside the data envelope. */
export const methodOutput = classify(z.enum(httpMethods), 'none');

/**
 * A path of the API with `/api`, outside the data envelope. The facts
 * allow any printable character without spaces; here only the characters
 * of a path and the braces of a placeholder pass, no quotes, angle
 * brackets or backticks, so that no free text reaches the model outside
 * the envelope. A path with another character ends the call with an
 * error rather than pass.
 */
export const pathOutput = classify(
  z.string().regex(/^\/api\/[A-Za-z0-9\-._~{}/:@!$&()*+,;=%]{0,299}$/),
  'none',
);

/** A path on the Academy, outside the data envelope. */
export const academyPathOutput = classify(
  z
    .string()
    .max(300)
    .regex(/^\/de\/(?:[a-z0-9%_-]+\/)*[a-z0-9%_-]+\/?$/),
  'none',
);

/** A link to a page of the Academy, outside the data envelope. */
export const academyLinkOutput = classify(
  z
    .string()
    .max(330)
    .regex(
      /^https:\/\/churchtools\.academy\/de\/(?:[a-z0-9%_-]+\/)*[a-z0-9%_-]+\/?$/,
    ),
  'none',
);

/** The module of a right, outside the data envelope. */
export const moduleOutput = classify(name(32), 'none');

/** The name of a right, outside the data envelope. */
export const rightNameOutput = classify(name(64), 'none');

/** A right without its label. */
export const rightRefOutput = z.object({
  module: moduleOutput,
  name: rightNameOutput,
});

/** The fixed name of the OpenAPI document in a result. */
export const openApiName = 'OpenAPI document of ChurchTools';

/** The fixed name of the rights of an instance in a result. */
export const permissionsName = 'Rights of a ChurchTools instance';

/** The fixed name of the Academy in a result. */
export const academyName = 'ChurchTools Academy';

/** The terms of the texts of the Academy, as NOTICE gives them. */
export const academyTerms =
  '© ChurchTools, all rights reserved. Ecclium reproduces the texts with the permission of the publisher, with attribution and link.';

/** What the result of a finding names as its place. */
export const findingPlace = `${findingsPath} in the repository of Ecclium`;

/** Where a label from a finding comes from. */
export const interfacePlace = `the web interface of ChurchTools, as ${findingPlace} records it`;

/** Where the evidence from the OpenAPI document stands. */
export const openApiPlace =
  'the summary or description of this operation in the OpenAPI document';

/**
 * Where the facts from the OpenAPI document come from (ADR 0027): the
 * path of the document on the own instance, both versions, the day it was
 * fetched, its licence and that Ecclium prepared the facts from it.
 */
export const openApiSourceOutput = z.object({
  name: classify(z.literal(openApiName), 'none'),
  path: classify(z.literal(openApiDocumentPath), 'none'),
  documentVersion: classify(
    z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/),
    'none',
  ).nullable(),
  churchToolsVersion: classify(version, 'none').nullable(),
  retrieved: classify(day, 'none').nullable(),
  license: classify(z.literal('CC BY 4.0'), 'none'),
  adapted: classify(z.literal(true), 'none'),
});

/** Where module, name and kind of the rights come from. */
export const permissionsSourceOutput = z.object({
  name: classify(z.literal(permissionsName), 'none'),
  path: classify(z.literal(permissionsPath), 'none'),
  churchToolsVersion: classify(version, 'none').nullable(),
  retrieved: classify(day, 'none').nullable(),
});

/** Where the texts of the Academy come from and on which terms. */
export const academySourceOutput = z.object({
  name: classify(z.literal(academyName), 'none'),
  retrieved: classify(day, 'none').nullable(),
  terms: classify(z.literal(academyTerms), 'none'),
});

const dayOf = (time: string | undefined): string | null =>
  time === undefined ? null : time.slice(0, 10);

/**
 * The source block of a result from the OpenAPI document.
 *
 * @param sources - The sources of the index.
 * @returns The block; a part the index does not know is null.
 * @example
 * ```ts
 * openApiSource(docs.sources).license; // 'CC BY 4.0'
 * ```
 */
export function openApiSource(
  sources: Sources,
): z.input<typeof openApiSourceOutput> {
  const { openapi } = sources;
  return {
    name: openApiName,
    path: openApiDocumentPath,
    documentVersion: openapi?.documentVersion ?? null,
    churchToolsVersion: openapi?.churchToolsVersion ?? null,
    retrieved: dayOf(openapi?.retrievedAt),
    license: 'CC BY 4.0',
    adapted: true,
  };
}

/**
 * The source block of a result about rights.
 *
 * @param sources - The sources of the index.
 * @returns The block; a part the index does not know is null.
 * @example
 * ```ts
 * permissionsSource(docs.sources).path; // '/api/permissions/global'
 * ```
 */
export function permissionsSource(
  sources: Sources,
): z.input<typeof permissionsSourceOutput> {
  const { permissions } = sources;
  return {
    name: permissionsName,
    path: permissionsPath,
    churchToolsVersion: permissions?.churchToolsVersion ?? null,
    retrieved: dayOf(permissions?.retrievedAt),
  };
}

/**
 * The source block of a result with texts of the Academy.
 *
 * @param sources - The sources of the index.
 * @returns The block, with the day the pages were fetched or null.
 * @example
 * ```ts
 * academySource(docs.sources).name; // 'ChurchTools Academy'
 * ```
 */
export function academySource(
  sources: Sources,
): z.input<typeof academySourceOutput> {
  return {
    name: academyName,
    retrieved: dayOf(sources.academy?.retrievedAt),
    terms: academyTerms,
  };
}

/** What a read gives without the rights of a pairing, as a finding saw it. */
export const withoutThemOutput = classify(
  z.enum(['refused with 403', 'entries left out', 'fields left out']),
  'none',
).nullable();

const withoutThemTexts = Object.freeze({
  refused: 'refused with 403',
  omitted: 'entries left out',
  fields: 'fields left out',
} as const);

/**
 * What a read gives without the rights of a pairing, in words.
 *
 * @param without - The value of the mapping, if a finding saw it.
 * @returns The words, or null.
 * @example
 * ```ts
 * withoutThem('omitted'); // 'entries left out'
 * ```
 */
export const withoutThem = (
  without: keyof typeof withoutThemTexts | undefined,
): z.input<typeof withoutThemOutput> =>
  without === undefined ? null : withoutThemTexts[without];

/**
 * One piece of evidence of the mapping: a finding of the project with its
 * number or title and the version of ChurchTools it ran on, the
 * description of the operation in the OpenAPI document, or a help page of
 * the Academy with title and link. One object for every kind, because the
 * registry takes no union of objects in an output.
 */
export const evidenceOutput = z.object({
  kind: classify(z.enum(['finding', 'openapi', 'academy']), 'none'),
  // The number, such as F29, or the title of a further finding, which the
  // project writes itself without brackets (ADR 0066).
  finding: classify(z.string().max(120), 'none').nullable(),
  churchToolsVersion: classify(version, 'none').nullable(),
  shows: classify(z.enum(['necessary', 'sufficient']), 'none').nullable(),
  where: classify(z.enum([findingPlace, openApiPlace]), 'none').nullable(),
  title: classify(z.string().max(300), 'untrusted').nullable(),
  link: academyLinkOutput.nullable(),
});

/** The most pieces of evidence of one pairing, as the facts allow. */
export const maxEvidence = 10;

/**
 * Copies one piece of evidence into the form of a result. A help page
 * gets its title and link from the index.
 *
 * @param evidence - The evidence from the mapping.
 * @param docs - The index, for the help pages.
 * @returns The evidence as a result gives it.
 * @example
 * ```ts
 * evidenceOf({ kind: 'openapi' }, docs).where; // the place in the document
 * ```
 */
export function evidenceOf(
  evidence: NeedEvidence | PlainEvidence,
  docs: DocsIndex,
): z.input<typeof evidenceOutput> {
  const empty = {
    finding: null,
    churchToolsVersion: null,
    shows: null,
    where: null,
    title: null,
    link: null,
  };
  if (evidence.kind === 'openapi') {
    return { ...empty, kind: 'openapi', where: openApiPlace };
  }
  if (evidence.kind === 'academy') {
    const page = docs.getAcademyPage(evidence.page);
    return {
      ...empty,
      kind: 'academy',
      title: page?.attribution.title ?? null,
      link: page?.attribution.link ?? null,
    };
  }
  return {
    ...empty,
    kind: 'finding',
    finding: evidence.id,
    churchToolsVersion: evidence.version,
    shows: 'shows' in evidence ? evidence.shows : null,
    where: findingPlace,
  };
}

/**
 * Where the label of a right comes from: a help page with title and link,
 * or a finding of the project that recorded the web interface of
 * ChurchTools, with its number and version (ADR 0066).
 */
export const labelSourceOutput = z.object({
  kind: classify(z.enum(['academy', 'finding']), 'none'),
  title: classify(z.string().max(300), 'untrusted').nullable(),
  link: academyLinkOutput.nullable(),
  finding: classify(z.string().max(120), 'none').nullable(),
  churchToolsVersion: classify(version, 'none').nullable(),
  where: classify(z.literal(interfacePlace), 'none').nullable(),
});

/** A right with its label, as the rights of an operation name it. */
export const labelledRightOutput = z.object({
  module: moduleOutput,
  name: rightNameOutput,
  label: classify(z.string().max(200), 'untrusted').nullable(),
});

/**
 * The label of a right and where it comes from.
 *
 * @param right - The right.
 * @param docs - The index.
 * @returns The label and its source, both null when the right has none.
 * @example
 * ```ts
 * labelOf({ module: 'churchwiki', name: 'view' }, docs).label;
 * ```
 */
export function labelOf(
  right: RightRef,
  docs: DocsIndex,
): {
  readonly label: string | null;
  readonly labelSource: z.input<typeof labelSourceOutput> | null;
} {
  const found = docs.getRight(right.module, right.name);
  const label = found?.fact.label;
  if (found === undefined || label === undefined) {
    return { label: null, labelSource: null };
  }
  if ('page' in label) {
    const page = docs.getAcademyPage(label.page);
    return {
      label: label.text,
      labelSource: {
        kind: 'academy',
        title: page?.attribution.title ?? null,
        link: page?.attribution.link ?? null,
        finding: null,
        churchToolsVersion: null,
        where: null,
      },
    };
  }
  return {
    label: label.text,
    labelSource: {
      kind: 'finding',
      title: null,
      link: null,
      finding: label.finding,
      churchToolsVersion: label.version,
      where: interfacePlace,
    },
  };
}
