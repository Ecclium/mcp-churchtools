/**
 * The facts of the docs index and their formats (ADR 0066): three files
 * under `data/` with facts from the OpenAPI document, the rights and the
 * help pages of the Academy, `SOURCES.json` with when and from what they
 * came, and `operation-rights.json` with the rights each operation needs,
 * mapped by hand in the project with evidence for every pairing.
 * `pnpm docs:refresh` writes them, never a person.
 *
 * Every file must be in canonical form, so that the same facts always
 * give the same bytes and a review sees only real changes. A finding
 * names the file, the entry and the field, never the value: the facts
 * come from the network, and a value in a finding would reach the public
 * log of CI (ADR 0027, ADR 0066).
 *
 * @packageDocumentation
 */
import { z } from 'zod';

import { findHostsIn, walkStrings } from './hosts.js';
import { hasHtmlTag } from './raw-sources.js';

/** The names of the files under `data/`, by their role. */
export const factFiles = Object.freeze({
  sources: 'SOURCES.json',
  operations: 'operations.json',
  rights: 'rights.json',
  academy: 'academy.json',
  operationRights: 'operation-rights.json',
} as const);

/** The name of one file under `data/`. */
export type FactFileName = (typeof factFiles)[keyof typeof factFiles];

/** The text of every file under `data/`, by its name. */
export type FactFileTexts = Readonly<Record<FactFileName, string>>;

/**
 * The largest size of each file in bytes (ADR 0066). The schemas of the
 * OpenAPI document are the largest part (D7), the help pages of the
 * Academy hold about 500 KiB of text (D11). The canonical form indents
 * every level, so `operations.json` with schemas three steps deep takes
 * about 7.4 MB in the repository and half of that compact in the built
 * file, whose own limit is what the package carries.
 */
export const factFileLimits: Readonly<Record<FactFileName, number>> =
  Object.freeze({
    'SOURCES.json': 200_000,
    'operations.json': 10_000_000,
    'rights.json': 200_000,
    'academy.json': 1_000_000,
    'operation-rights.json': 200_000,
  });

/** The formats the files carry in their field `format`. */
export const factFormats = Object.freeze({
  sources: 'ecclium.docs.sources.v1',
  operations: 'ecclium.docs.operations.v1',
  rights: 'ecclium.docs.rights.v1',
  academy: 'ecclium.docs.academy.v1',
  operationRights: 'ecclium.docs.operation-rights.v1',
} as const);

/**
 * How deep a schema of an operation may reach. A step goes through
 * `properties`, `items`, `additionalProperties`, `anyOf`, `oneOf` or
 * `allOf`; below that only the name of the schema stands (ADR 0066).
 */
export const maxShapeDepth = 4;

/** The kinds of value a schema of the OpenAPI document names. */
export const shapeTypes = Object.freeze([
  'array',
  'boolean',
  'integer',
  'null',
  'number',
  'object',
  'string',
] as const);

/** The methods of HTTP an operation may have. */
export const operationMethods = Object.freeze([
  'delete',
  'get',
  'head',
  'options',
  'patch',
  'post',
  'put',
  'trace',
] as const);

/** Where a parameter of an operation goes. */
export const parameterLocations = Object.freeze([
  'cookie',
  'header',
  'path',
  'query',
] as const);

/** The kinds of value of a right in `GET /api/permissions/global` (F30). */
export const rightKinds = Object.freeze(['boolean', 'list'] as const);

/** A schema of the OpenAPI document, cut to {@link maxShapeDepth}. */
export interface Shape {
  /** The kinds of value, sorted. */
  readonly type?: readonly (typeof shapeTypes)[number][];
  /** The format of a string or number, such as `date-time`. */
  readonly format?: string;
  /** The allowed values. */
  readonly enum?: readonly (string | number | boolean | null)[];
  /** The name of the schema under `components.schemas`. */
  readonly ref?: string;
  /** The description of the schema, foreign text from the document. */
  readonly description?: string;
  /** The schema of the elements of an array. */
  readonly items?: Shape;
  /** The properties of an object, sorted by name. */
  readonly properties?: readonly ShapeProperty[];
  /** Whether an object takes other properties, or their schema. */
  readonly additionalProperties?: boolean | Shape;
  /** Schemas of which at least one applies. */
  readonly anyOf?: readonly Shape[];
  /** Schemas of which exactly one applies. */
  readonly oneOf?: readonly Shape[];
  /** Schemas that all apply. */
  readonly allOf?: readonly Shape[];
}

/** A property of an object in a {@link Shape}. */
export interface ShapeProperty {
  /** The name of the property. */
  readonly name: string;
  /** Whether the object must have it. */
  readonly required: boolean;
  /** Its schema. */
  readonly schema: Shape;
}

/** A parameter of an operation. */
export interface OperationParameter {
  /** The name of the parameter. */
  readonly name: string;
  /** Where it goes. */
  readonly in: (typeof parameterLocations)[number];
  /** Whether the operation needs it. */
  readonly required: boolean;
  /** Its description, foreign text from the document. */
  readonly description?: string;
  /** Its schema. */
  readonly schema?: Shape;
}

/** A body of a request or an answer in one media type. */
export interface OperationContent {
  /** The media type, such as `application/json`. */
  readonly mediaType: string;
  /** The schema of the body. */
  readonly schema?: Shape;
}

/** The body of the request of an operation. */
export interface OperationRequestBody {
  /** Whether the operation needs a body. */
  readonly required: boolean;
  /** Its description, foreign text from the document. */
  readonly description?: string;
  /** The body in each media type, sorted by media type. */
  readonly content: readonly OperationContent[];
}

/** An answer of an operation. */
export interface OperationResponse {
  /** The status, such as `200`, `4XX` or `default`. */
  readonly status: string;
  /** Its description, foreign text from the document. */
  readonly description?: string;
  /** The body in each media type, sorted by media type. */
  readonly content: readonly OperationContent[];
}

/** The facts about one operation of the OpenAPI document. */
export interface OperationFact {
  /** The ID of the operation, its key. */
  readonly operationId: string;
  /** The method of HTTP. */
  readonly method: (typeof operationMethods)[number];
  /** The path with its parameters, such as `/api/groups/{id}`. */
  readonly path: string;
  /** The tags of the operation, sorted. */
  readonly tags: readonly string[];
  /** The summary, foreign text from the document. */
  readonly summary?: string;
  /** The description, foreign text from the document. */
  readonly description?: string;
  /** Whether the document marks it as deprecated. */
  readonly deprecated: boolean;
  /** The parameters, sorted by place and name. */
  readonly parameters: readonly OperationParameter[];
  /** The body of the request. */
  readonly requestBody?: OperationRequestBody;
  /** The answers, sorted by status. */
  readonly responses: readonly OperationResponse[];
}

/**
 * A label of a right from a help page, which names it right before the
 * name of the right in parentheses, such as «Dinge sehen (view things)».
 */
export interface AcademyRightLabel {
  /** The label, foreign text from the Academy. */
  readonly text: string;
  /** The path of the help page that names it. */
  readonly page: string;
}

/**
 * A label of a right as the web interface of ChurchTools shows it, where
 * no help page names it, taken from a finding of the project that
 * recorded it (ADR 0066).
 */
export interface FindingRightLabel {
  /** The label, foreign text from ChurchTools. */
  readonly text: string;
  /** The finding in `docs/research/churchtools-api.md`, such as `F36`. */
  readonly finding: string;
  /** The version of ChurchTools the finding saw. */
  readonly version: string;
}

/** A label of a right and where it comes from. */
export type RightLabel = AcademyRightLabel | FindingRightLabel;

/**
 * The facts about one right. Module, name and kind come from
 * `GET /api/permissions/global`, the label and the explaining pages from
 * the help pages of the Academy, each with its own page (ADR 0027,
 * Umsetzung).
 */
export interface RightFact {
  /** The module, such as `churchwiki`. */
  readonly module: string;
  /** The name of the right, such as `view category`. */
  readonly name: string;
  /** Whether its value is true or false or a list of IDs. */
  readonly kind: (typeof rightKinds)[number];
  /** The label from a help page or, failing that, from a finding. */
  readonly label?: RightLabel;
  /** The paths of the help pages that explain it, sorted. */
  readonly pages: readonly string[];
}

/** The facts about one help page of the Academy. */
export interface AcademyPage {
  /** The path on the Academy, its key, such as `/de/help/wiki/`. */
  readonly path: string;
  /** The title of the page. */
  readonly title: string;
  /** The slug of its section. */
  readonly section: string;
  /** The slug of its knowledge base. */
  readonly knowledgeBase: string;
  /** The day of its last change, `JJJJ-MM-TT`. */
  readonly modified: string;
  /** The prepared text in simple Markdown, foreign text from the Academy. */
  readonly text: string;
}

/** A right, by its module and its name. */
export interface RightRef {
  /** The module, such as `churchwiki`. */
  readonly module: string;
  /** The name of the right. */
  readonly name: string;
}

/**
 * What a read gives without a right, as a finding saw it: an answer 403,
 * an answer without the entries the right opens, or entries without the
 * fields it opens.
 */
export const withoutRight = Object.freeze([
  'fields',
  'omitted',
  'refused',
] as const);

/**
 * What a probe showed about a right: `necessary` when the effect was
 * missing without it, after a counter-check took it away or for an object
 * the right with values does not name, `sufficient` when the effect showed
 * with it and the probe never saw it without.
 */
export const findingShows = Object.freeze(['necessary', 'sufficient'] as const);

/**
 * A finding of the project in `docs/research/churchtools-api.md`, by its
 * number such as `F29` or the title of a further finding, with the version
 * of ChurchTools its probe ran on.
 */
export interface FindingEvidence {
  /** The kind of evidence. */
  readonly kind: 'finding';
  /** The number or title of the finding. */
  readonly id: string;
  /** The version of ChurchTools. */
  readonly version: string;
}

/** A finding that shows a right a read needs. */
export interface NeedFindingEvidence extends FindingEvidence {
  /** What the probe showed. */
  readonly shows: (typeof findingShows)[number];
}

/** The summary or description of the operation in the OpenAPI document. */
export interface OpenApiEvidence {
  /** The kind of evidence. */
  readonly kind: 'openapi';
}

/**
 * A help page that names the right for what the operation does. It
 * describes the web interface, not the API, so it only stands next to a
 * finding or the document (ADR 0066).
 */
export interface AcademyEvidence {
  /** The kind of evidence. */
  readonly kind: 'academy';
  /** The path of the page. */
  readonly page: string;
}

/** Evidence that an operation needs a right. */
export type NeedEvidence =
  NeedFindingEvidence | OpenApiEvidence | AcademyEvidence;

/** Evidence that an operation needs no right. */
export type PlainEvidence = FindingEvidence | OpenApiEvidence;

/**
 * A right an operation needs: one of `rights` opens it, as far as the
 * evidence shows. It never claims that no other right or condition counts.
 */
export interface RightNeed {
  /** The rights of which one suffices, sorted by module and name. */
  readonly rights: readonly RightRef[];
  /** What the read gives without them, only where a finding saw it. */
  readonly without?: (typeof withoutRight)[number];
  /** The evidence, sorted by kind and then number, title or page. */
  readonly evidence: readonly NeedEvidence[];
}

/**
 * A right a finding showed the operation does not need. Only a probe can
 * show that: a description that names a right says nothing about it.
 */
export interface NotNeededRight {
  /** The right. */
  readonly right: RightRef;
  /** The findings, sorted. */
  readonly evidence: readonly FindingEvidence[];
}

/** An operation and the rights it needs, by evidence. */
export interface OperationNeeds {
  /** The ID of the operation, its key. */
  readonly operationId: string;
  /** What it needs, sorted by the first of the rights. */
  readonly needs: readonly RightNeed[];
  /** Rights a finding showed it does not need, sorted. */
  readonly notNeeded?: readonly NotNeededRight[];
}

/** An operation that needs no right, by evidence. */
export interface OperationWithoutRights {
  /** The ID of the operation, its key. */
  readonly operationId: string;
  /**
   * The evidence that it needs none, at least one finding: only a probe
   * shows that a read works without any right.
   */
  readonly none: readonly PlainEvidence[];
}

/** An operation without a mapping, and why, in German. */
export interface OperationUnmapped {
  /** The ID of the operation, its key. */
  readonly operationId: string;
  /** Why no mapping stands. */
  readonly open: string;
  /** Rights a finding showed it does not need, sorted. */
  readonly notNeeded?: readonly NotNeededRight[];
}

/** One entry of `operation-rights.json`. */
export type OperationRights =
  OperationNeeds | OperationWithoutRights | OperationUnmapped;

/** A file of facts: its format, the notice of its source and its entries. */
export interface FactFile<F extends string, E> {
  /** The format, such as `ecclium.docs.operations.v1`. */
  readonly format: F;
  /** The source and its terms, as ADR 0027 asks. */
  readonly notice: string;
  /** The entries, sorted by their key. */
  readonly entries: readonly E[];
}

/** Where the facts of the OpenAPI document came from. */
export interface OpenApiSource {
  /** When it was fetched, in UTC, `JJJJ-MM-TTThh:mm:ssZ`. */
  readonly retrievedAt: string;
  /** The SHA-256 of the document as fetched, in hex. */
  readonly sha256: string;
  /** The version the document names in `info.version` (D2). */
  readonly documentVersion: string;
  /** The version of ChurchTools the instance reported. */
  readonly churchToolsVersion: string;
}

/** Where the facts about the rights came from. */
export interface PermissionsSource {
  /** When the rights were fetched, in UTC. */
  readonly retrievedAt: string;
  /** The SHA-256 of the answer as fetched, in hex. */
  readonly sha256: string;
  /** The version of ChurchTools the instance reported. */
  readonly churchToolsVersion: string;
}

/** A help page as fetched. */
export interface AcademySourcePage {
  /** Its path on the Academy. */
  readonly path: string;
  /** The SHA-256 of the page as fetched, in hex. */
  readonly sha256: string;
}

/** Where the help pages came from. */
export interface AcademySource {
  /** When the pages were fetched, in UTC. */
  readonly retrievedAt: string;
  /** Every page, sorted by path. */
  readonly pages: readonly AcademySourcePage[];
}

/** `SOURCES.json`: one entry for each source that has facts. */
export interface Sources {
  /** The format. */
  readonly format: typeof factFormats.sources;
  /** The OpenAPI document. */
  readonly openapi?: OpenApiSource;
  /** `GET /api/permissions/global`. */
  readonly permissions?: PermissionsSource;
  /** The help pages of the Academy. */
  readonly academy?: AcademySource;
}

/** Every file under `data/`, checked. */
export interface Facts {
  /** `SOURCES.json`. */
  readonly sources: Sources;
  /** `operations.json`. */
  readonly operations: FactFile<typeof factFormats.operations, OperationFact>;
  /** `rights.json`. */
  readonly rights: FactFile<typeof factFormats.rights, RightFact>;
  /** `academy.json`. */
  readonly academy: FactFile<typeof factFormats.academy, AcademyPage>;
  /** `operation-rights.json`. */
  readonly operationRights: FactFile<
    typeof factFormats.operationRights,
    OperationRights
  >;
}

/** The rules a finding can break. */
export type FactRule =
  | 'size'
  | 'json'
  | 'format'
  | 'canonical'
  | 'order'
  | 'depth'
  | 'source'
  | 'reference'
  | 'host'
  | 'html'
  | 'link'
  | 'evidence'
  | 'conflict';

/** One finding: where it is and which rule it breaks, never the value. */
export interface FactViolation {
  /** The file. */
  readonly file: FactFileName;
  /** The field, such as `entries[3].description`, or `` for the file. */
  readonly path: string;
  /** The rule. */
  readonly rule: FactRule;
}

/**
 * The facts under `data/` break at least one rule. The message and the
 * findings name files, fields and rules, never a value.
 *
 * @example
 * ```ts
 * try {
 *   parseFactFiles(texts);
 * } catch (error) {
 *   if (error instanceof DocsFactsError) report(error.violations);
 * }
 * ```
 */
export class DocsFactsError extends Error {
  /** Every finding, in the order they were found. */
  readonly violations: readonly FactViolation[];

  /**
   * Creates the error from its findings.
   *
   * @param violations - The findings, at least one.
   */
  constructor(violations: readonly FactViolation[]) {
    super(
      [
        `The facts of the docs index break ${String(violations.length)} rule(s):`,
        ...violations.map(describeViolation),
      ].join('\n'),
    );
    this.name = 'DocsFactsError';
    this.violations = Object.freeze([...violations]);
  }
}

/**
 * Describes a finding in one line: file, field and rule.
 *
 * @param violation - The finding.
 * @returns The line, without any value from the file.
 * @example
 * ```ts
 * describeViolation({ file: 'rights.json', path: 'entries[0].kind', rule: 'format' });
 * // 'rights.json entries[0].kind: format'
 * ```
 */
export function describeViolation(violation: FactViolation): string {
  const where =
    violation.path === ''
      ? violation.file
      : `${violation.file} ${violation.path}`;
  return `${where}: ${violation.rule}`;
}

/**
 * The canonical form of a file of facts: JSON with two spaces of indent,
 * the fields in the order of the format and a line break at the end.
 *
 * @param value - The checked content of a file.
 * @returns The text the file must have.
 * @example
 * ```ts
 * canonicalJson({ format: 'ecclium.docs.sources.v1' });
 * // '{\n  "format": "ecclium.docs.sources.v1"\n}\n'
 * ```
 */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Checks every file under `data/` and returns the facts. Each file must
 * stay under its limit, parse as JSON, match its format, stand in
 * canonical form, keep its entries and lists sorted without duplicates
 * and keep every schema within {@link maxShapeDepth}. No string may name
 * a host other than the two of ADR 0027 or hold markup of HTML, and a
 * link in the text of a help page leads only to another help page. A
 * file with entries needs its source in `SOURCES.json` and the other way
 * round, and every page a right names must be a help page of
 * `academy.json` that names the right. Every pairing of an operation and
 * a right must name what exists and carry evidence that names the right.
 *
 * @param texts - The text of each file.
 * @returns The checked facts.
 * @throws {DocsFactsError} If any file breaks a rule.
 * @example
 * ```ts
 * const facts = parseFactFiles(texts);
 * facts.operations.entries.length;
 * ```
 */
export function parseFactFiles(texts: FactFileTexts): Facts {
  const violations: FactViolation[] = [];
  const sources = parseFile(texts, 'SOURCES.json', sourcesSchema, violations);
  const operations = parseFile(
    texts,
    'operations.json',
    operationsFileSchema,
    violations,
  );
  const rights = parseFile(texts, 'rights.json', rightsFileSchema, violations);
  const academy = parseFile(
    texts,
    'academy.json',
    academyFileSchema,
    violations,
  );
  const operationRights = parseFile(
    texts,
    'operation-rights.json',
    operationRightsFileSchema,
    violations,
  );

  if (sources !== undefined) {
    checkSourcePages(sources, violations);
  }
  if (operations !== undefined) {
    checkOperations(operations.entries, violations);
  }
  if (rights !== undefined) {
    checkRights(rights.entries, violations);
  }
  if (academy !== undefined) {
    checkSorted(
      academy.entries.map((page) => page.path),
      'academy.json',
      'entries',
      violations,
    );
    checkAcademyLinks(academy.entries, violations);
  }
  if (operationRights !== undefined) {
    checkOperationRightsOrder(operationRights.entries, violations);
  }
  if (
    sources !== undefined &&
    operations !== undefined &&
    rights !== undefined &&
    academy !== undefined &&
    operationRights !== undefined
  ) {
    const facts = { sources, operations, rights, academy, operationRights };
    checkReferences(facts, violations);
    checkOperationRights(facts, violations);
  }

  if (
    violations.length > 0 ||
    sources === undefined ||
    operations === undefined ||
    rights === undefined ||
    academy === undefined ||
    operationRights === undefined
  ) {
    throw new DocsFactsError(violations);
  }
  return { sources, operations, rights, academy, operationRights };
}

// Control characters and characters a reader never sees: format
// characters such as a soft hyphen, a zero-width space, a change of
// direction or a TAG character, characters for private use, lone
// surrogates and every character Unicode lets a renderer ignore, such as
// the variation selectors, which can carry hidden text, and the fillers
// of Hangul. Inside a name they would hide a host from the check, and in
// a text an instruction from the review of a change. Line breaks and tabs
// stay in texts with several lines.
const hiddenCharacter =
  /^[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Default_Ignorable_Code_Point}]$/u;

function withoutControls(text: string, lines: boolean): boolean {
  for (const char of text) {
    if (lines && (char === '\t' || char === '\n')) {
      continue;
    }
    if (hiddenCharacter.test(char)) {
      return false;
    }
  }
  return true;
}

const line = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((text) => withoutControls(text, false));

const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => withoutControls(value, true));

// Printable ASCII without a space at either end, as F30 saw every name of
// a module and of a right. The tools give names out as names, not as
// foreign text, so their length stays short (ADR 0066).
const asciiName = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/);

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

const isRealDay = (value: string): boolean => {
  const day = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return (
    !Number.isNaN(day.getTime()) &&
    day.toISOString().slice(0, 10) === value.slice(0, 10)
  );
};

const utcTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\dZ$/)
  .refine(isRealDay);

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isRealDay);

const churchToolsVersion = z.string().regex(/^\d{1,4}\.\d{1,4}(?:\.\d{1,4})?$/);

// A path on the Academy, never a host: only the German pages, in the form
// WordPress gives their links, with percent-encoding for other letters.
const academyPath = z
  .string()
  .max(300)
  .regex(/^\/de\/(?:[a-z0-9%_-]+\/)*[a-z0-9%_-]+\/?$/);

const slug = z
  .string()
  .max(200)
  .regex(/^[a-z0-9%][a-z0-9%_-]*$/);

// The bounds of a schema leave room above the largest the OpenAPI document
// of ChurchTools 3.138 holds: an object with 319 properties, an `anyOf`
// with 38 members and a description of 4'349 characters (ADR 0066).
const shapeSchema: z.ZodType<Shape> = z.lazy(() =>
  z.strictObject({
    type: z.array(z.enum(shapeTypes)).min(1).max(shapeTypes.length).optional(),
    format: line(64).optional(),
    enum: z
      .array(z.union([line(200), z.int(), z.boolean(), z.null()]))
      .min(1)
      .max(100)
      .optional(),
    ref: line(200).optional(),
    description: text(10_000).optional(),
    items: shapeSchema.optional(),
    properties: z.array(shapePropertySchema).max(500).optional(),
    additionalProperties: z.union([z.boolean(), shapeSchema]).optional(),
    anyOf: z.array(shapeSchema).min(1).max(50).optional(),
    oneOf: z.array(shapeSchema).min(1).max(50).optional(),
    allOf: z.array(shapeSchema).min(1).max(50).optional(),
  }),
);

const shapePropertySchema: z.ZodType<ShapeProperty> = z.lazy(() =>
  z.strictObject({
    name: line(200),
    required: z.boolean(),
    schema: shapeSchema,
  }),
);

// `*/*` stands for any media type, as some answers of the document say.
const contentSchema = z.strictObject({
  mediaType: z
    .string()
    .max(100)
    .regex(/^(?:\*\/\*|[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+*-]+)$/i),
  schema: shapeSchema.optional(),
});

const operationIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/);

const operationSchema = z.strictObject({
  operationId: operationIdSchema,
  method: z.enum(operationMethods),
  path: z.string().regex(/^\/[\x21-\x7e]{0,299}$/),
  tags: z.array(line(100)).max(20),
  summary: line(1000).optional(),
  description: text(20_000).optional(),
  deprecated: z.boolean(),
  parameters: z
    .array(
      z.strictObject({
        name: line(200),
        in: z.enum(parameterLocations),
        required: z.boolean(),
        description: text(4000).optional(),
        schema: shapeSchema.optional(),
      }),
    )
    .max(100),
  requestBody: z
    .strictObject({
      required: z.boolean(),
      description: text(4000).optional(),
      content: z.array(contentSchema).max(10),
    })
    .optional(),
  responses: z
    .array(
      z.strictObject({
        status: z.string().regex(/^(?:[1-5](?:\d\d|XX)|default)$/),
        description: text(4000).optional(),
        content: z.array(contentSchema).max(10),
      }),
    )
    .max(50),
});

// A finding by its number, such as `F29`, or by the title of a further
// finding, such as «Kategorie ohne Leserecht». The test of the repository
// looks it up in `docs/research/churchtools-api.md`.
const findingId = z.union([
  z.string().regex(/^F[1-9]\d{0,2}$/),
  line(120).refine((title) => !/^f\d/i.test(title)),
]);

const rightSchema = z.strictObject({
  module: asciiName(32),
  name: asciiName(64),
  kind: z.enum(rightKinds),
  label: z
    .union([
      z.strictObject({ text: line(200), page: academyPath }),
      z.strictObject({
        text: line(200),
        finding: findingId,
        version: churchToolsVersion,
      }),
    ])
    .optional(),
  pages: z.array(academyPath).max(20),
});

const rightRefSchema = z.strictObject({
  module: asciiName(32),
  name: asciiName(64),
});

const openApiEvidenceSchema = z.strictObject({ kind: z.literal('openapi') });

const findingEvidenceSchema = z.strictObject({
  kind: z.literal('finding'),
  id: findingId,
  version: churchToolsVersion,
});

const plainEvidenceSchema = z.union([
  findingEvidenceSchema,
  openApiEvidenceSchema,
]);

const needEvidenceSchema = z.union([
  z.strictObject({
    kind: z.literal('finding'),
    id: findingId,
    version: churchToolsVersion,
    shows: z.enum(findingShows),
  }),
  openApiEvidenceSchema,
  z.strictObject({ kind: z.literal('academy'), page: academyPath }),
]);

const notNeededSchema = z.strictObject({
  right: rightRefSchema,
  evidence: z.array(findingEvidenceSchema).min(1).max(10),
});

const operationRightsSchema = z.union([
  z.strictObject({
    operationId: operationIdSchema,
    needs: z
      .array(
        z.strictObject({
          rights: z.array(rightRefSchema).min(1).max(10),
          without: z.enum(withoutRight).optional(),
          evidence: z.array(needEvidenceSchema).min(1).max(10),
        }),
      )
      .min(1)
      .max(20),
    notNeeded: z.array(notNeededSchema).min(1).max(20).optional(),
  }),
  z.strictObject({
    operationId: operationIdSchema,
    none: z.array(plainEvidenceSchema).min(1).max(10),
  }),
  z.strictObject({
    operationId: operationIdSchema,
    open: line(500),
    notNeeded: z.array(notNeededSchema).min(1).max(20).optional(),
  }),
]);

const academyPageSchema = z.strictObject({
  path: academyPath,
  title: line(300),
  section: slug,
  knowledgeBase: slug,
  modified: day,
  text: text(200_000),
});

const fileSchema = <F extends string, E extends z.ZodType>(
  format: F,
  entry: E,
) =>
  z.strictObject({
    format: z.literal(format),
    notice: text(2000),
    entries: z.array(entry).max(5000),
  });

const operationsFileSchema = fileSchema(
  factFormats.operations,
  operationSchema,
);
const rightsFileSchema = fileSchema(factFormats.rights, rightSchema);
const academyFileSchema = fileSchema(factFormats.academy, academyPageSchema);
const operationRightsFileSchema = fileSchema(
  factFormats.operationRights,
  operationRightsSchema,
);

const sourcesSchema = z.strictObject({
  format: z.literal(factFormats.sources),
  openapi: z
    .strictObject({
      retrievedAt: utcTime,
      sha256,
      documentVersion: z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/),
      churchToolsVersion,
    })
    .optional(),
  permissions: z
    .strictObject({
      retrievedAt: utcTime,
      sha256,
      churchToolsVersion,
    })
    .optional(),
  academy: z
    .strictObject({
      retrievedAt: utcTime,
      pages: z
        .array(z.strictObject({ path: academyPath, sha256 }))
        .min(1)
        .max(5000),
    })
    .optional(),
});

function parseFile<T>(
  texts: FactFileTexts,
  file: FactFileName,
  schema: z.ZodType<T>,
  violations: FactViolation[],
): T | undefined {
  const raw = texts[file];
  if (Buffer.byteLength(raw, 'utf8') > factFileLimits[file]) {
    violations.push({ file, path: '', rule: 'size' });
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    violations.push({ file, path: '', rule: 'json' });
    return undefined;
  }
  // zod and the checks below walk the value recursively, so a value nested
  // deeper than any valid file is refused before they run.
  if (jsonDepth(json) > maxJsonDepth) {
    violations.push({ file, path: '', rule: 'depth' });
    return undefined;
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    // zod runs every check of a field, so one field can fail twice, for
    // example a day in another form fails the pattern and the calendar.
    const paths = new Set(
      parsed.error.issues.map(({ path }) => issuePath(path)),
    );
    for (const path of paths) {
      violations.push({ file, path, rule: 'format' });
    }
    return undefined;
  }
  if (canonicalJson(parsed.data) !== raw) {
    violations.push({ file, path: '', rule: 'canonical' });
  }
  for (const { path } of findHostsIn(parsed.data)) {
    violations.push({ file, path, rule: 'host' });
  }
  walkStrings(parsed.data, (path, text) => {
    if (hasHtmlTag(text)) {
      violations.push({ file, path, rule: 'html' });
    }
    // No image stays in any text (ADR 0027).
    if (text.includes('![')) {
      violations.push({ file, path, rule: 'link' });
    }
  });
  return parsed.data;
}

// A link in the text of a help page leads only to another help page, as a
// path (ADR 0027). Link texts may span lines. A definition of a link for
// later reference and an autolink in angle brackets hide the target from
// this check, so neither may stand. Bounded, so linear in time.
// The target runs to the next closing parenthesis or space; no bound, so
// that a long target cannot slip past. Each match consumes its target, so
// the pattern stays linear.
const markdownLink = /\]\(([^)\s]*)/g;
const linkDefinition = /^[ ]{0,3}\[[^\]\n]*\]:/m;
const autolink = /<[a-z][a-z0-9+.-]{1,30}:/i;
const academyLinkTarget =
  /^\/de\/(?:[a-z0-9%_-]+\/)*(?:[a-z0-9%_-]+\/?)?(?:#[a-z0-9_-]{1,100})?$/;

function checkAcademyLinks(
  pages: readonly AcademyPage[],
  violations: FactViolation[],
): void {
  pages.forEach((page, index) => {
    if (linkDefinition.test(page.text) || autolink.test(page.text)) {
      violations.push({
        file: 'academy.json',
        path: `entries[${String(index)}].text`,
        rule: 'link',
      });
      return;
    }
    for (const match of page.text.matchAll(markdownLink)) {
      if (!academyLinkTarget.test(match[1] ?? '')) {
        violations.push({
          file: 'academy.json',
          path: `entries[${String(index)}].text`,
          rule: 'link',
        });
        return;
      }
    }
  });
}

// The path of an issue holds only names of the format and indices: an
// unknown key is reported at its parent, so no key from the file shows.
function issuePath(path: readonly PropertyKey[]): string {
  let result = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      result += `[${String(segment)}]`;
    } else if (typeof segment === 'string') {
      result += result === '' ? segment : `.${segment}`;
    }
  }
  return result;
}

// Code units, not the locale: the order must not change with the
// language of the machine that checks it.
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function checkSorted(
  keys: readonly string[],
  file: FactFileName,
  path: string,
  violations: FactViolation[],
): void {
  for (let index = 1; index < keys.length; index += 1) {
    if (compare(keys[index - 1] ?? '', keys[index] ?? '') >= 0) {
      violations.push({
        file,
        path: `${path}[${String(index)}]`,
        rule: 'order',
      });
      return;
    }
  }
}

function checkSourcePages(sources: Sources, violations: FactViolation[]) {
  if (sources.academy !== undefined) {
    checkSorted(
      sources.academy.pages.map((page) => page.path),
      'SOURCES.json',
      'academy.pages',
      violations,
    );
  }
}

function checkOperations(
  operations: readonly OperationFact[],
  violations: FactViolation[],
): void {
  const file = 'operations.json';
  checkSorted(
    operations.map((operation) => operation.operationId),
    file,
    'entries',
    violations,
  );
  operations.forEach((operation, index) => {
    const at = `entries[${String(index)}]`;
    checkSorted(operation.tags, file, `${at}.tags`, violations);
    checkSorted(
      operation.parameters.map(
        (parameter) => `${parameter.in}\u0000${parameter.name}`,
      ),
      file,
      `${at}.parameters`,
      violations,
    );
    operation.parameters.forEach((parameter, position) => {
      if (parameter.schema !== undefined) {
        checkShape(
          parameter.schema,
          `${at}.parameters[${String(position)}].schema`,
          violations,
        );
      }
    });
    if (operation.requestBody !== undefined) {
      checkContent(
        operation.requestBody.content,
        `${at}.requestBody.content`,
        violations,
      );
    }
    checkSorted(
      operation.responses.map((response) => response.status),
      file,
      `${at}.responses`,
      violations,
    );
    operation.responses.forEach((response, position) => {
      checkContent(
        response.content,
        `${at}.responses[${String(position)}].content`,
        violations,
      );
    });
  });
}

function checkContent(
  content: readonly OperationContent[],
  path: string,
  violations: FactViolation[],
): void {
  checkSorted(
    content.map((body) => body.mediaType),
    'operations.json',
    path,
    violations,
  );
  content.forEach((body, index) => {
    if (body.schema !== undefined) {
      checkShape(body.schema, `${path}[${String(index)}].schema`, violations);
    }
  });
}

function checkShape(
  shape: Shape,
  path: string,
  violations: FactViolation[],
): void {
  if (shapeDepth(shape) > maxShapeDepth) {
    violations.push({ file: 'operations.json', path, rule: 'depth' });
    return;
  }
  walkShape(shape, path, (inner, at) => {
    if (inner.type !== undefined) {
      checkSorted(inner.type, 'operations.json', `${at}.type`, violations);
    }
    if (inner.properties !== undefined) {
      checkSorted(
        inner.properties.map((property) => property.name),
        'operations.json',
        `${at}.properties`,
        violations,
      );
    }
  });
}

/**
 * How deep a file of facts may nest: enough for a schema of
 * {@link maxShapeDepth} steps inside an answer of an operation, and far
 * from what overflows the stack of a recursive walk.
 */
export const maxJsonDepth = 40;

/**
 * How deep a parsed JSON value nests, counted without recursion, so that
 * any value can be measured. It stops counting above `limit`.
 *
 * @param value - A parsed JSON value.
 * @param limit - The depth from which the exact number does not matter.
 * @returns The depth, 0 for a value that is no object or array, or
 *   `limit + 1` for anything deeper than `limit`.
 * @example
 * ```ts
 * jsonDepth({ a: [1] }); // 2
 * ```
 */
export function jsonDepth(value: unknown, limit = maxJsonDepth): number {
  let deepest = 0;
  const stack: [unknown, number][] = [[value, 0]];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const [item, depth] = next;
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const level = depth + 1;
    if (level > limit) {
      return limit + 1;
    }
    deepest = Math.max(deepest, level);
    for (const inner of Object.values(item)) {
      stack.push([inner, level]);
    }
  }
  return deepest;
}

/**
 * How many steps a schema reaches below itself, see {@link maxShapeDepth}.
 *
 * @param shape - The schema.
 * @returns 0 for a schema without inner schemas.
 * @example
 * ```ts
 * shapeDepth({ type: ['array'], items: { type: ['string'] } }); // 1
 * ```
 */
export function shapeDepth(shape: Shape): number {
  let deepest = 0;
  for (const inner of innerShapes(shape)) {
    deepest = Math.max(deepest, 1 + shapeDepth(inner.shape));
  }
  return deepest;
}

function innerShapes(
  shape: Shape,
): readonly { readonly shape: Shape; readonly at: string }[] {
  const inner: { shape: Shape; at: string }[] = [];
  if (shape.items !== undefined) {
    inner.push({ shape: shape.items, at: 'items' });
  }
  if (typeof shape.additionalProperties === 'object') {
    inner.push({
      shape: shape.additionalProperties,
      at: 'additionalProperties',
    });
  }
  shape.properties?.forEach((property, index) => {
    inner.push({
      shape: property.schema,
      at: `properties[${String(index)}].schema`,
    });
  });
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    shape[key]?.forEach((member, index) => {
      inner.push({ shape: member, at: `${key}[${String(index)}]` });
    });
  }
  return inner;
}

function walkShape(
  shape: Shape,
  path: string,
  visit: (shape: Shape, path: string) => void,
): void {
  visit(shape, path);
  for (const inner of innerShapes(shape)) {
    walkShape(inner.shape, `${path}.${inner.at}`, visit);
  }
}

function checkRights(
  rights: readonly RightFact[],
  violations: FactViolation[],
): void {
  checkSorted(
    rights.map((right) => `${right.module}\u0000${right.name}`),
    'rights.json',
    'entries',
    violations,
  );
  rights.forEach((right, index) => {
    checkSorted(
      right.pages,
      'rights.json',
      `entries[${String(index)}].pages`,
      violations,
    );
  });
}

function checkReferences(facts: Facts, violations: FactViolation[]): void {
  const pairs = [
    ['openapi', 'operations.json', facts.operations.entries.length],
    ['permissions', 'rights.json', facts.rights.entries.length],
    ['academy', 'academy.json', facts.academy.entries.length],
  ] as const;
  for (const [source, file, count] of pairs) {
    if ((facts.sources[source] !== undefined) !== count > 0) {
      violations.push({ file: 'SOURCES.json', path: source, rule: 'source' });
      violations.push({ file, path: 'entries', rule: 'source' });
    }
  }

  const pages = new Set(facts.academy.entries.map((page) => page.path));
  const fetched = facts.sources.academy?.pages.map((page) => page.path) ?? [];
  if (
    fetched.length !== pages.size ||
    fetched.some((path) => !pages.has(path))
  ) {
    violations.push({
      file: 'SOURCES.json',
      path: 'academy.pages',
      rule: 'reference',
    });
  }
  const texts = new Map(
    facts.academy.entries.map((page) => [page.path, page.text]),
  );
  facts.rights.entries.forEach((right, index) => {
    const at = `entries[${String(index)}]`;
    const { label } = right;
    if (
      label !== undefined &&
      (hasLinkMark(label.text) ||
        ('finding' in label && hasLinkMark(label.finding)))
    ) {
      violations.push({
        file: 'rights.json',
        path: `${at}.label`,
        rule: 'link',
      });
    }
    // A label from a help page stands right before the name in
    // parentheses, as the pages of the rights management write it, so
    // that no label is made up or taken from the wrong right. A label
    // from a finding is checked by the test of the repository, which can
    // read the findings.
    if (label !== undefined && 'page' in label) {
      const text = texts.get(label.page);
      if (text === undefined) {
        violations.push({
          file: 'rights.json',
          path: `${at}.label.page`,
          rule: 'reference',
        });
      } else if (!text.includes(`${label.text} (${right.name})`)) {
        violations.push({
          file: 'rights.json',
          path: `${at}.label`,
          rule: 'evidence',
        });
      }
    }
    right.pages.forEach((page, position) => {
      const text = texts.get(page);
      const path = `${at}.pages[${String(position)}]`;
      if (text === undefined) {
        violations.push({ file: 'rights.json', path, rule: 'reference' });
      } else if (
        !text.includes(`(${right.name})`) &&
        (label === undefined || !text.includes(label.text))
      ) {
        violations.push({ file: 'rights.json', path, rule: 'evidence' });
      }
    });
  });
}

// The keys the entries of `operation-rights.json` sort by. Code units,
// like every order of the facts.
function evidenceKey(evidence: NeedEvidence | PlainEvidence): string {
  switch (evidence.kind) {
    case 'finding':
      return `finding\u0000${evidence.id}`;
    case 'academy':
      return `academy\u0000${evidence.page}`;
    case 'openapi':
      return 'openapi';
  }
}

function refKey(right: RightRef): string {
  return `${right.module}\u0000${right.name}`;
}

function checkOperationRightsOrder(
  entries: readonly OperationRights[],
  violations: FactViolation[],
): void {
  const file = 'operation-rights.json';
  checkSorted(
    entries.map((entry) => entry.operationId),
    file,
    'entries',
    violations,
  );
  entries.forEach((entry, index) => {
    const at = `entries[${String(index)}]`;
    if ('needs' in entry) {
      checkSorted(
        entry.needs.map((need) =>
          need.rights[0] === undefined ? '' : refKey(need.rights[0]),
        ),
        file,
        `${at}.needs`,
        violations,
      );
      entry.needs.forEach((need, position) => {
        const needAt = `${at}.needs[${String(position)}]`;
        checkSorted(
          need.rights.map(refKey),
          file,
          `${needAt}.rights`,
          violations,
        );
        checkSorted(
          need.evidence.map(evidenceKey),
          file,
          `${needAt}.evidence`,
          violations,
        );
      });
    }
    if ('none' in entry) {
      checkSorted(entry.none.map(evidenceKey), file, `${at}.none`, violations);
    }
    if ('notNeeded' in entry && entry.notNeeded !== undefined) {
      checkSorted(
        entry.notNeeded.map((item) => refKey(item.right)),
        file,
        `${at}.notNeeded`,
        violations,
      );
      entry.notNeeded.forEach((item, position) => {
        checkSorted(
          item.evidence.map(evidenceKey),
          file,
          `${at}.notNeeded[${String(position)}].evidence`,
          violations,
        );
      });
    }
  });
}

// Words of a text as a plain list, so that «view-category» and «view
// category» name the same right and «views» does not name «view».
function plainWords(value: string): string {
  return ` ${value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
}

/**
 * Whether a text names a right by its name as whole words, case and
 * punctuation aside, as the OpenAPI document writes rights in changing
 * forms (D5).
 *
 * @param value - The text, such as the description of an operation.
 * @param name - The name of the right.
 * @returns Whether the text names it.
 * @example
 * ```ts
 * namesRight('Requires view-category permission.', 'view category'); // true
 * ```
 */
export function namesRight(value: string, name: string): boolean {
  return plainWords(value).includes(plainWords(name));
}

/**
 * Whether a text names a right so that it can only mean this one: by its
 * name and, where the same name stands in more than one module, such as
 * `view` or `view category`, also by its module.
 *
 * @param value - The text, such as the description of an operation.
 * @param right - The right.
 * @param rights - Every right of the facts, to know which names repeat.
 * @returns Whether the text names it.
 * @example
 * ```ts
 * documentNamesRight('Requires view in churchdb.', { module: 'churchdb', name: 'view' }, rights); // true
 * ```
 */
export function documentNamesRight(
  value: string,
  right: RightRef,
  rights: readonly RightRef[],
): boolean {
  const modules = rights.filter(({ name }) => name === right.name).length;
  return (
    namesRight(value, right.name) &&
    (modules <= 1 || namesRight(value, right.module))
  );
}

// Texts the project writes by hand or takes from a finding stand without
// any link: a bracket could start a Markdown link, whose target the check
// of the hosts does not see if it has no host, such as `javascript:`.
function hasLinkMark(value: string): boolean {
  return value.includes('[') || value.includes(']');
}

// Every pairing names an operation, rights and pages that exist, and its
// evidence carries it: the document names one of its rights, with its
// module where the name repeats, or a help page names it, a help page
// never stands alone, because it describes the web interface and not the
// API, and what a read gives without the right only a probe can show, as
// that a read needs no right (ADR 0066). No right stands twice in an
// entry, so that no operation both needs a right and does not need it,
// and no text the project writes holds a mark of a link.
function checkOperationRights(facts: Facts, violations: FactViolation[]): void {
  const file = 'operation-rights.json';
  const operations = new Map(
    facts.operations.entries.map((operation) => [
      operation.operationId,
      operation,
    ]),
  );
  const rights = new Set(facts.rights.entries.map(refKey));
  const texts = new Map(
    facts.academy.entries.map((page) => [page.path, page.text]),
  );
  const push = (path: string, rule: FactRule) => {
    violations.push({ file, path, rule });
  };

  facts.operationRights.entries.forEach((entry, index) => {
    const at = `entries[${String(index)}]`;
    const operation = operations.get(entry.operationId);
    if (operation === undefined) {
      push(`${at}.operationId`, 'reference');
    }
    const described = `${operation?.summary ?? ''} ${operation?.description ?? ''}`;
    const seen = new Set<string>();
    const checkRight = (right: RightRef, path: string) => {
      if (!rights.has(refKey(right))) {
        push(path, 'reference');
      }
      if (seen.has(refKey(right))) {
        push(path, 'conflict');
      }
      seen.add(refKey(right));
    };
    const checkTitles = (
      evidence: readonly (NeedEvidence | PlainEvidence)[],
      path: string,
    ) => {
      evidence.forEach((item, position) => {
        if (item.kind === 'finding' && hasLinkMark(item.id)) {
          push(`${path}[${String(position)}].id`, 'link');
        }
      });
    };

    if ('needs' in entry) {
      entry.needs.forEach((need, position) => {
        const needAt = `${at}.needs[${String(position)}]`;
        need.rights.forEach((right, place) => {
          checkRight(right, `${needAt}.rights[${String(place)}]`);
        });
        const findings = need.evidence.some((item) => item.kind === 'finding');
        if (
          !need.evidence.some(
            (item) => item.kind === 'finding' || item.kind === 'openapi',
          ) ||
          (need.without !== undefined && !findings)
        ) {
          push(`${needAt}.evidence`, 'evidence');
        }
        need.evidence.forEach((item, place) => {
          const itemAt = `${needAt}.evidence[${String(place)}]`;
          if (item.kind === 'openapi') {
            if (
              !need.rights.some((right) =>
                documentNamesRight(described, right, facts.rights.entries),
              )
            ) {
              push(itemAt, 'evidence');
            }
          } else if (item.kind === 'academy') {
            const text = texts.get(item.page);
            if (text === undefined) {
              push(`${itemAt}.page`, 'reference');
            } else if (
              !need.rights.some((right) => text.includes(`(${right.name})`))
            ) {
              push(itemAt, 'evidence');
            }
          }
        });
        checkTitles(need.evidence, `${needAt}.evidence`);
      });
    }
    if ('none' in entry) {
      if (!entry.none.some((item) => item.kind === 'finding')) {
        push(`${at}.none`, 'evidence');
      }
      checkTitles(entry.none, `${at}.none`);
    }
    if ('open' in entry && hasLinkMark(entry.open)) {
      push(`${at}.open`, 'link');
    }
    if ('notNeeded' in entry && entry.notNeeded !== undefined) {
      entry.notNeeded.forEach((item, position) => {
        const itemAt = `${at}.notNeeded[${String(position)}]`;
        checkRight(item.right, `${itemAt}.right`);
        checkTitles(item.evidence, `${itemAt}.evidence`);
      });
    }
  });
}
