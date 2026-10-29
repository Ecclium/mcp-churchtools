/**
 * Takes the facts about the operations from the OpenAPI document of an
 * instance, in the format `ecclium.docs.operations.v1` of the docs index
 * (ADR 0066): per operation its ID, method, path, tags, texts, whether it
 * is deprecated, its parameters, the body of its request and its answers,
 * with schemas cut to {@link factDepth} steps.
 *
 * Never taken: `servers`, `example`, `examples`, `default`,
 * `externalDocs`, `security` and any extension `x-…`, because they carry
 * hosts and values (D6). Operations with `x-internal` stay out, since
 * they are not meant for clients. The fields of every object stand in the
 * order of the format, since the check of the docs index compares the
 * canonical form byte by byte.
 *
 * A form the format cannot hold ends the refresh with the place, never
 * with a value, so that nothing from the document reaches the output.
 *
 * @packageDocumentation
 */
import { SpikeError } from '../../spike/lib/errors.mts';
import {
  isObject,
  type JsonObject,
  type OpenApiDocument,
} from '../../spike/lib/spec.mts';
import { cleanBlock, cleanLine } from './text.mts';

/**
 * How many steps deep the schemas reach, decided on 29.10.2026: the least
 * depth at which a list still names the fields of its entries (answer,
 * `data`, entry, field). The format allows four (ADR 0066).
 */
export const factDepth = 3;

/** The methods an operation of the document may have, in sorted order. */
const methods = [
  'delete',
  'get',
  'head',
  'options',
  'patch',
  'post',
  'put',
  'trace',
] as const;

const shapeTypes: ReadonlySet<string> = new Set([
  'array',
  'boolean',
  'integer',
  'null',
  'number',
  'object',
  'string',
]);

const parameterLocations: ReadonlySet<string> = new Set([
  'cookie',
  'header',
  'path',
  'query',
]);

/** A schema of the format, written with its fields in their order. */
export type ShapeFact = Readonly<Record<string, unknown>>;

/** One operation of the format, written with its fields in their order. */
export type OperationFactEntry = Readonly<Record<string, unknown>>;

function fail(where: string): never {
  throw new SpikeError('ANTWORT_UNGUELTIG', 'quelleUngueltig', where);
}

// Code units, not the locale: the order must not change with the
// language of the machine that writes it.
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// JSON with sorted keys, to tell whether two schemas have the same form.
function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort(compare)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const componentName = /^[A-Za-z0-9_.-]{1,200}$/;

/** What the cutting of schemas needs from the whole document. */
interface Context {
  /** The name under `components.schemas` for each form, the first sorted. */
  readonly names: ReadonlyMap<string, string>;
  /** The schemas under `components.schemas`, for a `$ref`. */
  readonly schemas: JsonObject;
}

function contextOf(document: OpenApiDocument): Context {
  const components = isObject(document['components'])
    ? document['components']
    : {};
  const schemas = isObject(components['schemas']) ? components['schemas'] : {};
  const names = new Map<string, string>();
  for (const name of Object.keys(schemas).sort(compare)) {
    const form = stableJson(schemas[name]);
    if (componentName.test(name) && !names.has(form)) {
      names.set(form, name);
    }
  }
  return { names, schemas };
}

// A text the format keeps as it is, or nothing: a value of `enum`, a
// format or a name of a component must not change while it is cleaned.
function unchanged(text: string, max: number): boolean {
  return text.length <= max && cleanLine(text, 'en') === text;
}

/**
 * Cuts a schema of the document to the format: kinds, format, values,
 * the name of an equal schema under `components`, the description, and
 * the inner schemas while `depth` stays below {@link factDepth}. At the
 * limit only the schema itself stands, with its name if it has one.
 *
 * @param schema - A schema of the document.
 * @param depth - How many steps it lies below the schema of a parameter or body.
 * @param where - Its place, for an error.
 * @param context - The components of the document.
 * @returns The schema in the format.
 * @throws {SpikeError} If the schema has a form the format cannot hold.
 */
function shapeOf(
  schema: unknown,
  depth: number,
  where: string,
  context: Context,
): ShapeFact {
  if (!isObject(schema)) {
    return fail(where);
  }
  let target = schema;
  // Only a schema with inner schemas gets a name: a plain string that
  // happens to equal a schema under `components` says nothing by its name.
  let ref = hasInnerSchemas(schema)
    ? context.names.get(stableJson(schema))
    : undefined;
  const pointer = schema['$ref'];
  if (typeof pointer === 'string') {
    const name = /^#\/components\/schemas\/([A-Za-z0-9_.-]{1,200})$/.exec(
      pointer,
    )?.[1];
    const resolved = name === undefined ? undefined : context.schemas[name];
    if (name === undefined || !isObject(resolved)) {
      return fail(where);
    }
    ref = name;
    target = resolved;
  }
  const out: Record<string, unknown> = {};

  const types = target['type'];
  if (types !== undefined) {
    const list = Array.isArray(types) ? (types as unknown[]) : [types];
    if (
      list.length === 0 ||
      !list.every((type) => typeof type === 'string' && shapeTypes.has(type))
    ) {
      return fail(`${where}.type`);
    }
    out['type'] = [...new Set(list as string[])].sort(compare);
  }
  const format = target['format'];
  if (typeof format === 'string' && unchanged(format, 64)) {
    out['format'] = format;
  }
  const values = valuesOf(target);
  if (values !== undefined) {
    out['enum'] = values;
  }
  if (ref !== undefined) {
    out['ref'] = ref;
  }
  // Next to a `$ref`, OpenAPI 3.1 lets a schema say what the referenced
  // one means in its place. That description is the more specific one.
  const description =
    typeof schema['description'] === 'string'
      ? schema['description']
      : target['description'];
  if (typeof description === 'string') {
    const text = cleanBlock(description, 'en');
    if (text !== undefined) {
      if (text.length > 10_000) {
        return fail(`${where}.description`);
      }
      out['description'] = text;
    }
  }
  const inner = depth < factDepth;
  if (inner && target['items'] !== undefined) {
    out['items'] = shapeOf(
      target['items'],
      depth + 1,
      `${where}.items`,
      context,
    );
  }
  const properties = target['properties'];
  if (inner && isObject(properties)) {
    const names = Object.keys(properties).sort(compare);
    if (names.length > 500) {
      return fail(`${where}.properties`);
    }
    const required = new Set(
      Array.isArray(target['required'])
        ? (target['required'] as unknown[])
        : [],
    );
    out['properties'] = names.map((name, index) => {
      if (!unchanged(name, 200)) {
        return fail(`${where}.properties[${String(index)}].name`);
      }
      return {
        name,
        required: required.has(name),
        schema: shapeOf(
          properties[name],
          depth + 1,
          `${where}.properties[${String(index)}].schema`,
          context,
        ),
      };
    });
  }
  const additional = target['additionalProperties'];
  if (typeof additional === 'boolean') {
    out['additionalProperties'] = additional;
  } else if (inner && isObject(additional)) {
    out['additionalProperties'] = shapeOf(
      additional,
      depth + 1,
      `${where}.additionalProperties`,
      context,
    );
  }
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const members = target[key];
    if (!inner || !Array.isArray(members) || members.length === 0) {
      continue;
    }
    if (members.length > 50) {
      return fail(`${where}.${key}`);
    }
    const shapes = (members as unknown[]).map((member, index) =>
      shapeOf(member, depth + 1, `${where}.${key}[${String(index)}]`, context),
    );
    // A member that keeps nothing in the format, such as one of only
    // `required` or `not`, would read as «any value». In `allOf` it adds
    // nothing then and leaves. In `anyOf` and `oneOf` it would turn a
    // condition into a false statement, so the whole list leaves.
    const kept = shapes.filter((shape) => Object.keys(shape).length > 0);
    if (key === 'allOf' ? kept.length > 0 : kept.length === shapes.length) {
      out[key] = kept;
    }
  }
  return out;
}

function hasInnerSchemas(schema: JsonObject): boolean {
  return ['items', 'properties', 'anyOf', 'oneOf', 'allOf'].some(
    (key) => schema[key] !== undefined,
  );
}

// The allowed values, from `enum` or `const`. Values the format cannot
// hold faithfully, such as a number with a fraction or a text that the
// cleaning would change, drop the whole list: a list with values missing
// would say something false.
function valuesOf(schema: JsonObject): unknown[] | undefined {
  const raw = Array.isArray(schema['enum'])
    ? (schema['enum'] as unknown[])
    : Object.hasOwn(schema, 'const')
      ? [schema['const']]
      : undefined;
  if (raw === undefined || raw.length === 0 || raw.length > 100) {
    return undefined;
  }
  const fits = raw.every(
    (value) =>
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isSafeInteger(value)) ||
      (typeof value === 'string' && value !== '' && unchanged(value, 200)),
  );
  return fits ? raw : undefined;
}

function resolve(
  value: unknown,
  document: OpenApiDocument,
  kind: 'parameters' | 'requestBodies' | 'responses',
  where: string,
): JsonObject {
  if (!isObject(value)) {
    return fail(where);
  }
  const pointer = value['$ref'];
  if (typeof pointer !== 'string') {
    return value;
  }
  const name = new RegExp(
    `^#/components/${kind}/([A-Za-z0-9_.-]{1,200})$`,
  ).exec(pointer)?.[1];
  const components = isObject(document['components'])
    ? document['components']
    : {};
  const table = isObject(components[kind]) ? components[kind] : {};
  const resolved = name === undefined ? undefined : table[name];
  return isObject(resolved) ? resolved : fail(where);
}

function textField(
  value: unknown,
  max: number,
  where: string,
): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const text = cleanBlock(value, 'en');
  if (text !== undefined && text.length > max) {
    return fail(where);
  }
  return text;
}

function contentOf(
  value: unknown,
  where: string,
  context: Context,
): Record<string, unknown>[] {
  if (value === undefined) {
    return [];
  }
  if (!isObject(value)) {
    return fail(where);
  }
  const types = Object.keys(value).sort(compare);
  if (types.length > 10) {
    return fail(where);
  }
  return types.map((mediaType, index) => {
    const at = `${where}[${String(index)}]`;
    if (
      mediaType.length > 100 ||
      !/^(?:\*\/\*|[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+*-]+)$/i.test(mediaType)
    ) {
      return fail(`${at}.mediaType`);
    }
    const body = value[mediaType];
    const entry: Record<string, unknown> = { mediaType };
    if (isObject(body) && body['schema'] !== undefined) {
      entry['schema'] = shapeOf(body['schema'], 0, `${at}.schema`, context);
    }
    return entry;
  });
}

/**
 * Takes the facts about every operation of the document, except those
 * with `x-internal`, sorted by their ID.
 *
 * @param document - The OpenAPI document from the state of 00-inventory.
 * @returns The entries of `operations.json`, each with its fields in the
 *   order of the format.
 * @throws {SpikeError} With the place, if the document has a form the
 *   format cannot hold, such as an unknown kind of a schema, an ID used
 *   twice or a text over its limit.
 */
export function operationFacts(
  document: OpenApiDocument,
): OperationFactEntry[] {
  const context = contextOf(document);
  const paths = isObject(document['paths']) ? document['paths'] : {};
  const entries: {
    id: string;
    order: number;
    where: string;
    entry: OperationFactEntry;
  }[] = [];
  let index = 0;
  for (const path of Object.keys(paths).sort(compare)) {
    const item = paths[path];
    if (!isObject(item)) {
      continue;
    }
    for (const method of methods) {
      const operation = item[method];
      if (!isObject(operation)) {
        continue;
      }
      const where = `operations[${String(index)}]`;
      index += 1;
      if (operation['x-internal'] === true) {
        continue;
      }
      entries.push({
        ...operationOf(document, path, method, item, operation, where, context),
        order: index,
        where,
      });
    }
  }
  // Sorted by ID, two operations with the same ID stand side by side.
  // The place names the later one in the order of the document, as every
  // other place does.
  entries.sort((a, b) => compare(a.id, b.id) || a.order - b.order);
  entries.forEach((entry, position) => {
    if (position > 0 && entries[position - 1]?.id === entry.id) {
      fail(`${entry.where}.operationId`);
    }
  });
  return entries.map(({ entry }) => entry);
}

function operationOf(
  document: OpenApiDocument,
  path: string,
  method: (typeof methods)[number],
  item: JsonObject,
  operation: JsonObject,
  where: string,
  context: Context,
): { id: string; entry: OperationFactEntry } {
  const id = operation['operationId'];
  if (typeof id !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(id)) {
    return fail(`${where}.operationId`);
  }
  if (!/^\/[\x21-\x7e]{0,299}$/.test(path)) {
    return fail(`${where}.path`);
  }
  const tags = Array.isArray(operation['tags'])
    ? (operation['tags'] as unknown[])
    : [];
  const cleanTags = [
    ...new Set(
      tags
        .map((tag) =>
          typeof tag === 'string' ? cleanLine(tag, 'en') : undefined,
        )
        .filter((tag): tag is string => tag !== undefined),
    ),
  ].sort(compare);
  if (cleanTags.length > 20 || cleanTags.some((tag) => tag.length > 100)) {
    return fail(`${where}.tags`);
  }
  const entry: Record<string, unknown> = {
    operationId: id,
    method,
    path,
    tags: cleanTags,
  };
  const summary =
    typeof operation['summary'] === 'string'
      ? cleanLine(operation['summary'], 'en')
      : undefined;
  if (summary !== undefined) {
    if (summary.length > 1000) {
      return fail(`${where}.summary`);
    }
    entry['summary'] = summary;
  }
  const description = textField(
    operation['description'],
    20_000,
    `${where}.description`,
  );
  if (description !== undefined) {
    entry['description'] = description;
  }
  entry['deprecated'] = operation['deprecated'] === true;
  entry['parameters'] = parametersOf(document, item, operation, where, context);
  if (operation['requestBody'] !== undefined) {
    const body = resolve(
      operation['requestBody'],
      document,
      'requestBodies',
      `${where}.requestBody`,
    );
    const request: Record<string, unknown> = {
      required: body['required'] === true,
    };
    const text = textField(
      body['description'],
      4000,
      `${where}.requestBody.description`,
    );
    if (text !== undefined) {
      request['description'] = text;
    }
    request['content'] = contentOf(
      body['content'],
      `${where}.requestBody.content`,
      context,
    );
    entry['requestBody'] = request;
  }
  entry['responses'] = responsesOf(document, operation, where, context);
  return { id, entry };
}

// The parameters of the path, replaced by those of the operation with the
// same place and name, sorted by place and name.
function parametersOf(
  document: OpenApiDocument,
  item: JsonObject,
  operation: JsonObject,
  where: string,
  context: Context,
): Record<string, unknown>[] {
  const byKey = new Map<string, JsonObject>();
  const lists = [item['parameters'], operation['parameters']];
  lists.forEach((list, which) => {
    if (list === undefined) {
      return;
    }
    if (!Array.isArray(list)) {
      fail(`${where}.parameters`);
    }
    (list as unknown[]).forEach((raw, position) => {
      const at = `${where}.parameters[${String(which)}.${String(position)}]`;
      const parameter = resolve(raw, document, 'parameters', at);
      const name = parameter['name'];
      const place = parameter['in'];
      if (typeof name !== 'string' || !unchanged(name, 200) || name === '') {
        fail(`${at}.name`);
      }
      if (typeof place !== 'string' || !parameterLocations.has(place)) {
        fail(`${at}.in`);
      }
      byKey.set(`${place}\u0000${name}`, parameter);
    });
  });
  const keys = [...byKey.keys()].sort(compare);
  if (keys.length > 100) {
    return fail(`${where}.parameters`);
  }
  return keys.map((key, position) => {
    const parameter = byKey.get(key) ?? {};
    const at = `${where}.parameters[${String(position)}]`;
    const out: Record<string, unknown> = {
      name: parameter['name'],
      in: parameter['in'],
      required: parameter['required'] === true,
    };
    const text = textField(parameter['description'], 4000, `${at}.description`);
    if (text !== undefined) {
      out['description'] = text;
    }
    if (parameter['schema'] !== undefined) {
      out['schema'] = shapeOf(parameter['schema'], 0, `${at}.schema`, context);
    }
    return out;
  });
}

function responsesOf(
  document: OpenApiDocument,
  operation: JsonObject,
  where: string,
  context: Context,
): Record<string, unknown>[] {
  const responses = operation['responses'];
  if (responses === undefined) {
    return [];
  }
  if (!isObject(responses)) {
    return fail(`${where}.responses`);
  }
  const statuses = Object.keys(responses).sort(compare);
  if (statuses.length > 50) {
    return fail(`${where}.responses`);
  }
  return statuses.map((status, position) => {
    const at = `${where}.responses[${String(position)}]`;
    if (!/^(?:[1-5](?:\d\d|XX)|default)$/.test(status)) {
      return fail(`${at}.status`);
    }
    const response = resolve(responses[status], document, 'responses', at);
    const out: Record<string, unknown> = { status };
    const text = textField(response['description'], 4000, `${at}.description`);
    if (text !== undefined) {
      out['description'] = text;
    }
    out['content'] = contentOf(response['content'], `${at}.content`, context);
    return out;
  });
}
