/**
 * The facts of the docs index and their formats (ADR 0066): three files
 * under `data/` with facts from the OpenAPI document, the rights and the
 * help pages of the Academy, and `SOURCES.json` with when and from what
 * they came. `pnpm docs:refresh` writes them, never a person.
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

/** The names of the files under `data/`, by their role. */
export const factFiles = Object.freeze({
  sources: 'SOURCES.json',
  operations: 'operations.json',
  rights: 'rights.json',
  academy: 'academy.json',
} as const);

/** The name of one file under `data/`. */
export type FactFileName = (typeof factFiles)[keyof typeof factFiles];

/** The text of every file under `data/`, by its name. */
export type FactFileTexts = Readonly<Record<FactFileName, string>>;

/**
 * The largest size of each file in bytes (ADR 0066). The schemas of the
 * OpenAPI document are the largest part (D7), the help pages of the
 * Academy hold about 500 KiB of text (D11).
 */
export const factFileLimits: Readonly<Record<FactFileName, number>> =
  Object.freeze({
    'SOURCES.json': 200_000,
    'operations.json': 2_500_000,
    'rights.json': 200_000,
    'academy.json': 1_000_000,
  });

/** The formats the files carry in their field `format`. */
export const factFormats = Object.freeze({
  sources: 'ecclium.docs.sources.v1',
  operations: 'ecclium.docs.operations.v1',
  rights: 'ecclium.docs.rights.v1',
  academy: 'ecclium.docs.academy.v1',
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

/** A label of a right and the help page it comes from. */
export interface RightLabel {
  /** The label, foreign text from the Academy. */
  readonly text: string;
  /** The path of the help page that names it. */
  readonly page: string;
}

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
  /** The label from a help page. */
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
  | 'reference';

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
 * and keep every schema within {@link maxShapeDepth}. A file with entries
 * needs its source in `SOURCES.json` and the other way round, and every
 * page a right names must be a help page of `academy.json`.
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
  }
  if (
    sources !== undefined &&
    operations !== undefined &&
    rights !== undefined &&
    academy !== undefined
  ) {
    checkReferences({ sources, operations, rights, academy }, violations);
  }

  if (
    violations.length > 0 ||
    sources === undefined ||
    operations === undefined ||
    rights === undefined ||
    academy === undefined
  ) {
    throw new DocsFactsError(violations);
  }
  return { sources, operations, rights, academy };
}

// Every text is foreign and only ever shown, so no control character may
// come in, apart from line breaks and tabs in texts with several lines.
function withoutControls(text: string, lines: boolean): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const allowed = lines && (code === 0x09 || code === 0x0a);
    if ((code < 0x20 || (code >= 0x7f && code <= 0x9f)) && !allowed) {
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
// a module and of a right.
const asciiName = z
  .string()
  .max(100)
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
    description: text(4000).optional(),
    items: shapeSchema.optional(),
    properties: z.array(shapePropertySchema).max(200).optional(),
    additionalProperties: z.union([z.boolean(), shapeSchema]).optional(),
    anyOf: z.array(shapeSchema).min(1).max(20).optional(),
    oneOf: z.array(shapeSchema).min(1).max(20).optional(),
    allOf: z.array(shapeSchema).min(1).max(20).optional(),
  }),
);

const shapePropertySchema: z.ZodType<ShapeProperty> = z.lazy(() =>
  z.strictObject({
    name: line(200),
    required: z.boolean(),
    schema: shapeSchema,
  }),
);

const contentSchema = z.strictObject({
  mediaType: z
    .string()
    .max(100)
    .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+*-]+$/i),
  schema: shapeSchema.optional(),
});

const operationSchema = z.strictObject({
  operationId: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,199}$/),
  method: z.enum(operationMethods),
  path: z.string().regex(/^\/[\x21-\x7e]{0,499}$/),
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

const rightSchema = z.strictObject({
  module: asciiName,
  name: asciiName,
  kind: z.enum(rightKinds),
  label: z.strictObject({ text: line(200), page: academyPath }).optional(),
  pages: z.array(academyPath).max(20),
});

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
  return parsed.data;
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
  facts.rights.entries.forEach((right, index) => {
    const at = `entries[${String(index)}]`;
    if (right.label !== undefined && !pages.has(right.label.page)) {
      violations.push({
        file: 'rights.json',
        path: `${at}.label.page`,
        rule: 'reference',
      });
    }
    right.pages.forEach((page, position) => {
      if (!pages.has(page)) {
        violations.push({
          file: 'rights.json',
          path: `${at}.pages[${String(position)}]`,
          rule: 'reference',
        });
      }
    });
  });
}
