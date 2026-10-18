/**
 * The JSON schemas the mount advertises for a tool in the list of tools
 * (ADR 0024). The mount derives both once at the start and freezes them.
 *
 * The output schema comes from the shape the registry kept, not from the
 * schema of the tool. Masks, the note on removed characters and the data
 * envelope change strings after `validateOutput`, so every string is
 * advertised without length, pattern, format or enum. Objects stay closed,
 * arrays have no bounds, and a tuple is bounded by its length.
 *
 * The input schema is converted from the zod schema of the tool and then
 * rebuilt from a list of allowed keywords. Descriptions and every other
 * annotation from the registry of zod stay behind: no check of the
 * registry reads them, and the model reads the list of tools in every
 * session.
 *
 * @packageDocumentation
 */
import { z } from 'zod';

import {
  type CatalogEntry,
  type OutputShape,
  RegistryRefusal,
  type ShapeNode,
} from '../registry/index.js';
import { maxSchemaNodes } from '../registry/schema.js';

/** A JSON Schema of an object as the mount advertises it, frozen. */
export interface ObjectJsonSchema {
  /** An object, as MCP requires for input and structured output. */
  readonly type: 'object';
  /** The other keywords. */
  readonly [keyword: string]: unknown;
}

type JsonObject = Readonly<Record<string, unknown>>;

// The value of `type`: one type alone, or a list, with null added when the
// value may be null.
const typeOf = (types: readonly string[], nullable: boolean): unknown => {
  const all = nullable && !types.includes('null') ? [...types, 'null'] : types;
  return all.length === 1 ? all[0] : Object.freeze([...all]);
};

// The schema of one node of the kept shape. A value in an array is never
// missing: the copy of the pipeline puts undefined in its place, which JSON
// writes as null.
const outputNode = (node: ShapeNode, inArray: boolean): JsonObject => {
  const nullable = node.nullable || (inArray && node.optional);
  switch (node.kind) {
    case 'leaf':
      return Object.freeze({
        __proto__: null,
        type: typeOf(node.types, nullable),
      });
    case 'array':
      return Object.freeze({
        __proto__: null,
        type: typeOf(['array'], nullable),
        items: outputNode(node.element, true),
      });
    // The length bounds a tuple, not items: false. A client of the 2025
    // era may check the result with a draft-07 engine, the default of
    // version 1 of the TypeScript SDK, which does not know prefixItems
    // and reads items: false as "no item at all", so every tuple would
    // fail there (ADR 0053). The copy of the pipeline always writes every
    // item, so a correct result has exactly this length, and under
    // 2020-12 maxItems forbids an extra item as items: false did. Under
    // draft-07 only the length is checked, not the type of each item.
    case 'tuple':
      return Object.freeze({
        __proto__: null,
        type: typeOf(['array'], nullable),
        prefixItems: Object.freeze(
          node.items.map((item) => outputNode(item, true)),
        ),
        minItems: node.items.length,
        maxItems: node.items.length,
      });
    case 'object': {
      const properties = Object.create(null) as Record<string, JsonObject>;
      const required: string[] = [];
      for (const [name, field] of Object.entries(node.fields)) {
        properties[name] = outputNode(field, false);
        if (!field.optional) required.push(name);
      }
      return Object.freeze({
        __proto__: null,
        type: typeOf(['object'], nullable),
        properties: Object.freeze(properties),
        ...(required.length > 0 ? { required: Object.freeze(required) } : {}),
        additionalProperties: false,
      });
    }
  }
};

/**
 * Derives the output schema the mount advertises from the shape the
 * registry kept. Every leaf has only its types of JSON, so a masked value,
 * a note on removed characters or a data envelope still fits. A field that
 * may be missing is not required, and one that may be null allows null.
 * Every object is closed. An array has no bounds. A tuple lists its items
 * in `prefixItems` and has exactly their number as `minItems` and
 * `maxItems`, without `items: false`, which a draft-07 engine of an older
 * client reads as no item at all. An item that may be missing allows
 * null, because JSON writes a missing item as null.
 *
 * @param shape - The shape the registry kept for the output of a tool.
 * @returns The schema, frozen, without prototypes and without `$schema`,
 *   so it is JSON Schema 2020-12, the default of MCP.
 * @example
 * ```ts
 * deriveOutputSchema(entry.shape);
 * // { type: 'object', properties: { email: { type: 'string' } },
 * //   required: ['email'], additionalProperties: false }
 * ```
 */
export function deriveOutputSchema(shape: OutputShape): ObjectJsonSchema {
  return outputNode(shape.root, false) as ObjectJsonSchema;
}

// Keywords of JSON Schema 2020-12 that the input schema keeps, by what
// their value is: one schema, a map of schemas or a list of schemas. They
// and the plain values below are the keywords of the vocabularies
// applicator, validation and format that the converter of zod writes.
// Every other keyword is dropped: description, title, examples, default,
// deprecated and every key with x-, which are text of the plugin, and
// $schema, because JSON Schema 2020-12 is the default of MCP.
const schemaKeywords: readonly string[] = [
  'items',
  'additionalProperties',
  'not',
  'propertyNames',
];
const mapKeywords: readonly string[] = ['properties', 'patternProperties'];
const listKeywords: readonly string[] = [
  'prefixItems',
  'anyOf',
  'oneOf',
  'allOf',
];

// A reference needs the definition it points to, and without it any value
// would pass. zod writes one for a recursive schema and for one with an id
// in the registry of zod; such an input schema cannot be advertised.
const referenceKeywords: readonly string[] = [
  '$ref',
  '$dynamicRef',
  '$recursiveRef',
  '$defs',
  'definitions',
];

const isString = (value: unknown): boolean => typeof value === 'string';
const isStrings = (value: unknown): boolean =>
  Array.isArray(value) && value.every(isString);
const isNumber = (value: unknown): boolean =>
  typeof value === 'number' && Number.isFinite(value);

// Keywords with a plain value and the form that value must have, so that a
// value set through the registry of zod never makes a schema a client
// cannot read.
const valueKeywords: readonly (readonly [
  string,
  (value: unknown) => boolean,
])[] = [
  ['type', (value) => isString(value) || isStrings(value)],
  ['required', isStrings],
  ['enum', (value) => Array.isArray(value)],
  ['const', () => true],
  ['format', isString],
  ['pattern', isString],
  ['minLength', isNumber],
  ['maxLength', isNumber],
  ['minimum', isNumber],
  ['maximum', isNumber],
  ['exclusiveMinimum', isNumber],
  ['exclusiveMaximum', isNumber],
  ['multipleOf', isNumber],
  ['minItems', isNumber],
  ['maxItems', isNumber],
  ['minProperties', isNumber],
  ['maxProperties', isNumber],
  ['uniqueItems', (value) => typeof value === 'boolean'],
];

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// A frozen copy of a plain value of JSON, with objects without prototype.
const copyJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return Object.freeze(value.map(copyJson));
  if (!isObject(value)) return value;
  const copy = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value)) copy[key] = copyJson(entry);
  return Object.freeze(copy);
};

/** The rebuild of one converted input schema, with its counter. */
class InputRebuild {
  nodes = 0;

  // A schema from its allowed keywords, or undefined when the mount cannot
  // advertise it.
  schema(value: unknown): unknown {
    if (typeof value === 'boolean') return value;
    if (!isObject(value)) return undefined;
    this.nodes += 1;
    if (this.nodes > maxSchemaNodes) return undefined;
    const kept = Object.create(null) as Record<string, unknown>;
    for (const [keyword, entry] of Object.entries(value)) {
      if (referenceKeywords.includes(keyword)) return undefined;
      let copy: unknown;
      if (schemaKeywords.includes(keyword)) copy = this.schema(entry);
      else if (mapKeywords.includes(keyword)) copy = this.map(entry);
      else if (listKeywords.includes(keyword)) copy = this.list(entry);
      else {
        const fits = valueKeywords.find(([name]) => name === keyword)?.[1];
        if (fits === undefined) continue;
        copy = fits(entry) ? copyJson(entry) : undefined;
      }
      if (copy === undefined) return undefined;
      kept[keyword] = copy;
    }
    return Object.freeze(kept);
  }

  private map(value: unknown): unknown {
    if (!isObject(value)) return undefined;
    const kept = Object.create(null) as Record<string, unknown>;
    for (const [name, entry] of Object.entries(value)) {
      const schema = this.schema(entry);
      if (schema === undefined) return undefined;
      kept[name] = schema;
    }
    return Object.freeze(kept);
  }

  private list(value: unknown): unknown {
    if (!Array.isArray(value)) return undefined;
    const kept: unknown[] = [];
    for (const entry of value as unknown[]) {
      const schema = this.schema(entry);
      if (schema === undefined) return undefined;
      kept.push(schema);
    }
    return Object.freeze(kept);
  }
}

/**
 * Derives the input schema the mount advertises for a tool. The converter
 * of the zod that core pins turns the schema of the tool into JSON Schema
 * for its input, and the result is rebuilt from the keywords of structure
 * and validation only, so no description and no other entry of the
 * registry of zod reaches the list of tools. The pipeline still validates
 * every input with the schema of the tool.
 *
 * @param tool - Name, plugin and input schema of a tool in the catalog.
 * @returns The schema, frozen, without prototypes and without `$schema`.
 * @throws {RegistryRefusal} With the reason `tool_input` when zod cannot
 *   convert the schema, when the result holds a reference, a keyword with a
 *   value of the wrong form or more than 2000 schemas, or when its root is
 *   no object. The start then stops; the message is the fixed sentence of
 *   the reason, never the message of zod.
 * @example
 * ```ts
 * deriveInputSchema(entry);
 * // { type: 'object', properties: { query: { type: 'string',
 * //   maxLength: 100 } }, required: ['query'] }
 * ```
 */
export function deriveInputSchema(
  tool: Pick<CatalogEntry, 'name' | 'plugin' | 'input'>,
): ObjectJsonSchema {
  const refusal = (): RegistryRefusal =>
    new RegistryRefusal('tool_input', {
      plugin: tool.plugin,
      tool: tool.name,
    });
  // The converter of the zod core pins, not ~standard.jsonSchema of the
  // schema. Both read the same accessors of the zod the plugin built its
  // schema with, ~standard among them, but there the function that getter
  // returns would make the whole result. Here the walk is code core pins
  // and tests, and the rebuild below decides what is kept (ADR 0024).
  let converted: unknown;
  try {
    converted = z.toJSONSchema(tool.input, {
      target: 'draft-2020-12',
      io: 'input',
      unrepresentable: 'throw',
    });
  } catch {
    throw refusal();
  }
  const rebuilt = new InputRebuild().schema(converted);
  if (!isObject(rebuilt) || rebuilt.type !== 'object') throw refusal();
  return rebuilt as ObjectJsonSchema;
}
