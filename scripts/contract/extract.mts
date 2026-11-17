/**
 * The extract of the OpenAPI document of ChurchTools that the contract
 * check reads in CI (ADR 0076, which supplements ADR 0027).
 *
 * The document as a whole never enters the repository, and the facts of
 * the docs index cut every schema after three steps, too short for the
 * fields the client reads. The extract holds only what the contract check
 * reads, for only the operations of the client in `contract.json`: per
 * operation its method, path, whether it is deprecated, its parameters by
 * name, place and whether they are required, the schema of the body of a
 * write and the schema of the answer of the status the contract names;
 * and the named schemas these reach, in full depth, each with only the
 * keys the check reads. No text, example, default, extension, server or
 * tag of the document stays in it. Its own form, without `openapi` and
 * `paths`, keeps it apart from a raw source, which the checks of the tree
 * refuse.
 *
 * `pnpm docs:refresh` writes it from the state file of `00-inventory`;
 * `scripts/contract/check.mts --auszug` reads it in CI.
 *
 * @packageDocumentation
 */
import { SpikeError } from '../spike/lib/errors.mts';
import {
  basePath,
  findOperation,
  isObject,
  type JsonObject,
  type Method,
  normalizeTemplate,
  type OpenApiDocument,
  Schemas,
} from '../spike/lib/spec.mts';

/** The format of the extract. */
export const extractFormat = 'ecclium.contract.extract.v1';

/** The largest extract the refresh writes and the check reads. */
export const maxExtractBytes = 2_000_000;

/** The file of the extract, next to the check. */
export const defaultExtractFile = new URL(
  './openapi-extract.json',
  import.meta.url,
);

/** Where the document of the extract came from, as in `SOURCES.json`. */
export interface ExtractSource {
  readonly retrievedAt: string;
  readonly sha256: string;
  readonly documentVersion: string;
  readonly churchToolsVersion: string;
}

/** A parameter of an operation, without its texts and its schema. */
export interface ExtractParameter {
  readonly name: string;
  readonly in: string;
  readonly required: boolean;
}

/** An operation of the client, as the document describes it. */
export interface ExtractOperation {
  readonly method: Method;
  /** The path as the document gives it, with the prefix of its server. */
  readonly path: string;
  readonly deprecated: boolean;
  readonly parameters: readonly ExtractParameter[];
  /** Only writes: the schema of the body of the request. */
  readonly request?: unknown;
  /** The schema of the answer of each status the contract names. */
  readonly responses: Readonly<Record<string, unknown>>;
}

/** The whole extract. */
export interface Extract {
  readonly format: typeof extractFormat;
  readonly notice: string;
  readonly source: ExtractSource;
  readonly operations: readonly ExtractOperation[];
  readonly schemas: Readonly<Record<string, unknown>>;
}

/** What the extract takes of an operation of the contract. */
export interface ExtractNeed {
  readonly method: Method;
  readonly path: string;
  readonly status: number;
  /** Whether the client sends a body. */
  readonly request: boolean;
}

// The keys of a schema the contract check reads; every other key of the
// document stays out, texts, examples and extensions included.
const schemaKeys = [
  '$ref',
  'type',
  'nullable',
  'required',
  'properties',
  'items',
  'additionalProperties',
  'allOf',
  'oneOf',
  'anyOf',
] as const;
const combiners = ['allOf', 'oneOf', 'anyOf'] as const;
const refPrefix = '#/components/schemas/';
const methods: readonly Method[] = ['get', 'post', 'put', 'patch', 'delete'];

// A name of a schema in a reference: letters, digits, `_`, `.` and `-`,
// so that no escape of a JSON pointer, percent sign or slash makes the
// reference in the extract read another name than in the document.
const schemaNameForm = /^[A-Za-z0-9_.-]{1,200}$/;
const isSchemaName = (name: string): boolean => schemaNameForm.test(name);

// The values of `type` and of the place of a parameter that the extract
// takes, so that no other text of the document stands in them.
const jsonTypes: ReadonlySet<string> = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'array',
  'object',
  'null',
]);
const isTypeValue = (value: unknown): boolean =>
  (isText(value) && jsonTypes.has(value)) ||
  (Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => isText(item) && jsonTypes.has(item)));
const parameterPlaces: ReadonlySet<string> = new Set([
  'query',
  'path',
  'header',
  'cookie',
]);

/** The deepest schema the extract copies and reads. */
export const maxSchemaDepth = 64;

const isText = (value: unknown): value is string => typeof value === 'string';

const sourceForm = (where: string): never => {
  throw new SpikeError('ANTWORT_UNGUELTIG', 'quelleUngueltig', where);
};

/** What copying the schemas of an operation needs and collects. */
interface Cleaning {
  /** The names of the named schemas the copies refer to. */
  readonly refs: Set<string>;
  /** Each named schema of the document by its form as JSON. */
  readonly names: ReadonlyMap<string, string>;
}

// JSON of a value with its keys sorted, so that two equal schemas give the
// same text, whatever the order of their keys.
const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    isObject(inner)
      ? Object.fromEntries(
          Object.keys(inner)
            .sort()
            .map((key) => [key, inner[key]]),
        )
      : inner,
  );

/**
 * Copies a schema of the document with only the keys the check reads and
 * notes each named schema it refers to.
 *
 * @param node - A schema of the document.
 * @param where - The place, for an error.
 * @param context - Collects the names of the schemas it refers to, and
 *   knows the named schemas of the document by their form.
 * @param self - The name of the schema it copies, if it is a named one, so
 *   that its root does not turn into a reference to itself.
 * @param depth - How deep the schema lies, against {@link maxSchemaDepth}.
 * @returns The copy, its properties sorted by name.
 * @throws {SpikeError} For a form the extract cannot hold, such as a
 *   reference outside the named schemas.
 */
function cleanSchema(
  node: unknown,
  where: string,
  context: Cleaning,
  self?: string,
  depth = 0,
): unknown {
  if (!isObject(node) || depth > maxSchemaDepth) return sourceForm(where);
  // The document of an instance writes every schema out in place. One
  // equal to a named schema becomes a reference to it, as the facts of
  // the docs index name it, so that the extract holds each only once.
  const named = context.names.get(stableJson(node));
  if (named !== undefined && named !== self) {
    context.refs.add(named);
    return { $ref: `${refPrefix}${named}` };
  }
  const copy: Record<string, unknown> = {};
  for (const key of schemaKeys) {
    const value = node[key];
    if (value === undefined) continue;
    switch (key) {
      case '$ref': {
        if (!isText(value) || !value.startsWith(refPrefix)) {
          return sourceForm(`${where}.$ref`);
        }
        const name = value.slice(refPrefix.length);
        if (!isSchemaName(name)) return sourceForm(`${where}.$ref`);
        context.refs.add(name);
        copy[key] = value;
        break;
      }
      case 'type':
        if (!isTypeValue(value)) return sourceForm(`${where}.type`);
        copy[key] = Array.isArray(value) ? value.map(String) : value;
        break;
      case 'nullable':
        if (typeof value !== 'boolean') return sourceForm(`${where}.nullable`);
        copy[key] = value;
        break;
      case 'required':
        if (!Array.isArray(value) || !value.every(isText)) {
          return sourceForm(`${where}.required`);
        }
        copy[key] = [...value];
        break;
      case 'properties': {
        if (!isObject(value)) return sourceForm(`${where}.properties`);
        copy[key] = Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((name) => [
              name,
              cleanSchema(
                value[name],
                `${where}.properties`,
                context,
                undefined,
                depth + 1,
              ),
            ]),
        );
        break;
      }
      case 'items':
        copy[key] = Array.isArray(value)
          ? value.map((item) =>
              cleanSchema(
                item,
                `${where}.items`,
                context,
                undefined,
                depth + 1,
              ),
            )
          : cleanSchema(value, `${where}.items`, context, undefined, depth + 1);
        break;
      case 'additionalProperties':
        copy[key] =
          typeof value === 'boolean'
            ? value
            : cleanSchema(
                value,
                `${where}.additionalProperties`,
                context,
                undefined,
                depth + 1,
              );
        break;
      default:
        if (!Array.isArray(value)) return sourceForm(`${where}.${key}`);
        copy[key] = value.map((part) =>
          cleanSchema(part, `${where}.${key}`, context, undefined, depth + 1),
        );
    }
  }
  return copy;
}

// The path of an operation as the document gives it, with the prefix of
// its server, so that the check finds it as in the document itself.
const documentPath = (
  document: OpenApiDocument,
  method: Method,
  template: string,
): string | undefined => {
  const wanted = normalizeTemplate(template);
  const prefix = basePath(document);
  for (const [path, item] of Object.entries(document.paths)) {
    if (
      normalizeTemplate(`${prefix}${path}`) === wanted &&
      isObject(item) &&
      isObject(item[method])
    ) {
      return `${prefix}${path}`;
    }
  }
  return undefined;
};

// The parameters of an operation and of its path, one per name and place,
// the one of the operation first, as OpenAPI defines it.
const parametersOf = (
  schemas: Schemas,
  item: JsonObject,
  operation: JsonObject,
  where: string,
): ExtractParameter[] => {
  const found = new Map<string, ExtractParameter>();
  for (const source of [item['parameters'], operation['parameters']]) {
    if (source === undefined) continue;
    if (!Array.isArray(source)) return sourceForm(`${where}.parameters`);
    for (const raw of source) {
      const parameter = schemas.resolve(raw);
      const name = parameter?.['name'];
      const place = parameter?.['in'];
      if (!isText(name) || !isText(place) || !parameterPlaces.has(place)) {
        return sourceForm(`${where}.parameters`);
      }
      found.set(`${place} ${name}`, {
        name,
        in: place,
        required: parameter?.['required'] === true,
      });
    }
  }
  return [...found.values()].sort((left, right) =>
    left.in === right.in
      ? compareText(left.name, right.name)
      : compareText(left.in, right.in),
  );
};

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * Makes the extract from the document of the instance: the operations of
 * the contract that the document documents, and the named schemas they
 * reach, in full depth.
 *
 * @param document - The OpenAPI document from the state file.
 * @param needs - The operations of the contract, two of them possibly on
 *   the same operation of the document.
 * @param source - Where the document came from.
 * @param notice - The notice of the extract.
 * @returns The extract, in canonical order.
 * @throws {SpikeError} For a form of the document the extract cannot hold.
 */
export function buildExtract(
  document: OpenApiDocument,
  needs: readonly ExtractNeed[],
  source: ExtractSource,
  notice: string,
): Extract {
  const schemas = new Schemas(document);
  const components = isObject(document['components'])
    ? document['components']
    : {};
  const named = isObject(components['schemas']) ? components['schemas'] : {};
  // Each named schema by its form, the first name in order for a form
  // that two share.
  const names = new Map<string, string>();
  for (const name of Object.keys(named).sort(compareText)) {
    const form = stableJson(named[name]);
    if (isSchemaName(name) && !names.has(form)) names.set(form, name);
  }
  const context: Cleaning = { refs: new Set<string>(), names };
  const byKey = new Map<
    string,
    {
      method: Method;
      path: string;
      deprecated: boolean;
      parameters: ExtractParameter[];
      request?: unknown;
      responses: Record<string, unknown>;
    }
  >();
  for (const need of needs) {
    const path = documentPath(document, need.method, need.path);
    const operation = findOperation(document, need.method, need.path);
    if (path === undefined || operation === undefined) continue;
    const key = `${path} ${need.method}`;
    const where = `operations.${need.method} ${need.path}`;
    let entry = byKey.get(key);
    if (entry === undefined) {
      const item = document.paths[path.slice(basePath(document).length)];
      if (!isObject(item)) return sourceForm(where);
      entry = {
        method: need.method,
        path,
        deprecated: operation['deprecated'] === true,
        parameters: parametersOf(schemas, item, operation, where),
        responses: {},
      };
      byKey.set(key, entry);
    }
    if (need.request && entry.request === undefined) {
      const body = schemas.requestSchema(operation);
      if (body !== undefined) {
        entry.request = cleanSchema(body, `${where}.request`, context);
      }
    }
    const answer = schemas.responseSchema(operation, need.status);
    if (answer !== undefined) {
      entry.responses[String(need.status)] = cleanSchema(
        answer,
        `${where}.responses`,
        context,
      );
    }
  }

  // The named schemas the operations reach, and those these reach.
  const reached = new Map<string, unknown>();
  const pending = [...context.refs];
  while (pending.length > 0) {
    const name = pending.pop() ?? '';
    if (reached.has(name)) continue;
    if (!Object.hasOwn(named, name)) {
      return sourceForm('schemas');
    }
    const found: Cleaning = { refs: new Set<string>(), names };
    reached.set(name, cleanSchema(named[name], 'schemas', found, name));
    pending.push(...found.refs);
  }

  return {
    format: extractFormat,
    notice,
    source: {
      retrievedAt: source.retrievedAt,
      sha256: source.sha256,
      documentVersion: source.documentVersion,
      churchToolsVersion: source.churchToolsVersion,
    },
    operations: [...byKey.values()]
      .sort((left, right) =>
        left.path === right.path
          ? methods.indexOf(left.method) - methods.indexOf(right.method)
          : compareText(left.path, right.path),
      )
      .map((entry) => ({
        method: entry.method,
        path: entry.path,
        deprecated: entry.deprecated,
        parameters: entry.parameters,
        ...(entry.request === undefined ? {} : { request: entry.request }),
        responses: Object.fromEntries(
          Object.keys(entry.responses)
            .sort()
            .map((status) => [status, entry.responses[status]]),
        ),
      })),
    schemas: Object.fromEntries(
      [...reached.keys()]
        .sort(compareText)
        .map((name) => [name, reached.get(name)]),
    ),
  };
}

/**
 * The text of the extract: JSON with two spaces of indentation and a line
 * break at the end, in the order {@link buildExtract} gives.
 *
 * @param extract - The extract.
 * @returns Its text.
 */
export function extractText(extract: Extract): string {
  return `${JSON.stringify(extract, null, 2)}\n`;
}

/**
 * The document the contract check reads, made from the extract: the
 * operations under their paths and the named schemas under `components`,
 * without a server, since the paths already hold its prefix.
 *
 * @param extract - The extract.
 * @returns An OpenAPI document in memory.
 */
export function documentOf(extract: Extract): OpenApiDocument {
  const json = (schema: unknown) => ({
    content: { 'application/json': { schema } },
  });
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of extract.operations) {
    const item = paths[operation.path] ?? {};
    paths[operation.path] = item;
    item[operation.method] = {
      deprecated: operation.deprecated,
      parameters: operation.parameters.map((parameter) => ({ ...parameter })),
      ...(operation.request === undefined
        ? {}
        : { requestBody: json(operation.request) }),
      responses: Object.fromEntries(
        Object.entries(operation.responses).map(([status, schema]) => [
          status,
          json(schema),
        ]),
      ),
    };
  }
  return {
    openapi: '3.0.3',
    paths,
    components: { schemas: { ...extract.schemas } },
  };
}

const broken = (where: string): never => {
  throw new SpikeError('DATEI', 'auszugUngueltig', where);
};

// A schema of the extract: only the keys of the check, each in its form,
// and references only to schemas the extract holds.
function checkSchema(
  node: unknown,
  where: string,
  names: ReadonlySet<string>,
  depth = 0,
): void {
  if (!isObject(node) || depth > maxSchemaDepth) return broken(where);
  for (const key of Object.keys(node)) {
    if (!(schemaKeys as readonly string[]).includes(key)) broken(where);
  }
  const ref = node['$ref'];
  if (
    ref !== undefined &&
    !(
      isText(ref) &&
      ref.startsWith(refPrefix) &&
      names.has(ref.slice(refPrefix.length))
    )
  ) {
    broken(`${where}.$ref`);
  }
  const type = node['type'];
  if (type !== undefined && !isTypeValue(type)) broken(`${where}.type`);
  const nullable = node['nullable'];
  if (nullable !== undefined && typeof nullable !== 'boolean') {
    broken(`${where}.nullable`);
  }
  const required = node['required'];
  if (
    required !== undefined &&
    !(Array.isArray(required) && required.every(isText))
  ) {
    broken(`${where}.required`);
  }
  const properties = node['properties'];
  if (properties !== undefined) {
    if (!isObject(properties)) broken(`${where}.properties`);
    else {
      for (const value of Object.values(properties)) {
        checkSchema(value, `${where}.properties`, names, depth + 1);
      }
    }
  }
  const items = node['items'];
  if (items !== undefined) {
    for (const item of Array.isArray(items) ? items : [items]) {
      checkSchema(item, `${where}.items`, names, depth + 1);
    }
  }
  const more = node['additionalProperties'];
  if (more !== undefined && typeof more !== 'boolean') {
    checkSchema(more, `${where}.additionalProperties`, names, depth + 1);
  }
  for (const key of combiners) {
    const parts = node[key];
    if (parts === undefined) continue;
    if (!Array.isArray(parts)) broken(`${where}.${key}`);
    else {
      for (const part of parts) {
        checkSchema(part, `${where}.${key}`, names, depth + 1);
      }
    }
  }
}

const sha256Form = /^[0-9a-f]{64}$/;
const timeForm = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const versionForm = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;
// The version of ChurchTools as major and minor number, as the probes keep it.
const churchToolsVersionForm = /^\d+\.\d+$/;

/**
 * Reads the text of the extract and checks its form: the format, a
 * notice, the source, and operations and schemas with only the keys the
 * check reads.
 *
 * @param text - The text of `openapi-extract.json`.
 * @returns The extract.
 * @throws {SpikeError} `DATEI` with the place of the first fault.
 */
export function readExtract(text: string): Extract {
  if (Buffer.byteLength(text, 'utf8') > maxExtractBytes) broken('groesse');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return broken('json');
  }
  if (!isObject(value)) return broken('json');
  const keys = ['format', 'notice', 'source', 'operations', 'schemas'];
  if (Object.keys(value).join() !== keys.join()) broken('felder');
  if (value['format'] !== extractFormat) broken('format');
  if (!isText(value['notice']) || value['notice'] === '') broken('notice');
  const source = value['source'];
  if (
    !isObject(source) ||
    Object.keys(source).join() !==
      'retrievedAt,sha256,documentVersion,churchToolsVersion' ||
    !isText(source['retrievedAt']) ||
    !timeForm.test(source['retrievedAt']) ||
    !isText(source['sha256']) ||
    !sha256Form.test(source['sha256']) ||
    !isText(source['documentVersion']) ||
    !versionForm.test(source['documentVersion']) ||
    !isText(source['churchToolsVersion']) ||
    !churchToolsVersionForm.test(source['churchToolsVersion'])
  ) {
    broken('source');
  }
  const schemas = value['schemas'];
  if (!isObject(schemas)) return broken('schemas');
  const names = new Set(Object.keys(schemas));
  for (const [name, schema] of Object.entries(schemas)) {
    if (!isSchemaName(name)) broken('schemas');
    checkSchema(schema, 'schemas', names);
  }
  const operations = value['operations'];
  if (!Array.isArray(operations)) return broken('operations');
  for (const [index, operation] of operations.entries()) {
    const where = `operations[${String(index)}]`;
    if (
      !isObject(operation) ||
      !methods.includes(operation['method'] as Method) ||
      !isText(operation['path']) ||
      !operation['path'].startsWith('/') ||
      typeof operation['deprecated'] !== 'boolean' ||
      !Array.isArray(operation['parameters']) ||
      !isObject(operation['responses'])
    ) {
      broken(where);
      continue;
    }
    for (const key of Object.keys(operation)) {
      if (
        ![
          'method',
          'path',
          'deprecated',
          'parameters',
          'request',
          'responses',
        ].includes(key)
      ) {
        broken(where);
      }
    }
    for (const parameter of operation['parameters'] as unknown[]) {
      if (
        !isObject(parameter) ||
        Object.keys(parameter).join() !== 'name,in,required' ||
        !isText(parameter['name']) ||
        !isText(parameter['in']) ||
        !parameterPlaces.has(parameter['in']) ||
        typeof parameter['required'] !== 'boolean'
      ) {
        broken(`${where}.parameters`);
      }
    }
    if (operation['request'] !== undefined) {
      checkSchema(operation['request'], `${where}.request`, names);
    }
    for (const [status, schema] of Object.entries(operation['responses'])) {
      if (!/^[1-5]\d\d$/.test(status)) broken(`${where}.responses`);
      checkSchema(schema, `${where}.responses`, names);
    }
  }
  return value as unknown as Extract;
}
