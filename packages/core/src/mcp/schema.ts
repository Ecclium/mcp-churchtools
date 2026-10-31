/**
 * The JSON schema the mount advertises for the output of a tool in the
 * list of tools (ADR 0024). The mount derives it once at the start and
 * freezes it. The input schema it advertises comes from the catalog: the
 * registry derives it when the tool is added, so an input schema that
 * cannot be advertised stops the start before the mount exists.
 *
 * The output schema comes from the shape the registry kept, not from the
 * schema of the tool. Masks, the note on removed characters and the data
 * envelope change strings after `validateOutput`, so every string is
 * advertised without length, pattern, format or enum, and the marker that
 * replaces an address or an amount is a string, also where the value was a
 * number. Objects stay closed, arrays have no bounds, and a tuple is
 * bounded by its length.
 *
 * @packageDocumentation
 */
import {
  markerClasses,
  type ObjectJsonSchema,
  type OutputShape,
  type ShapeNode,
} from '../registry/index.js';

type JsonObject = Readonly<Record<string, unknown>>;

// The value of `type`: one type alone, or a list, with null added when the
// value may be null.
const typeOf = (types: readonly string[], nullable: boolean): unknown => {
  const all = nullable && !types.includes('null') ? [...types, 'null'] : types;
  return all.length === 1 ? all[0] : Object.freeze([...all]);
};

// The types a leaf can have in a result. A marker takes the place of an
// address or an amount, also of a number, so these leaves are strings as
// well (ADR 0069).
const leafTypes = (node: ShapeNode & { kind: 'leaf' }): readonly string[] =>
  node.dataClass !== undefined &&
  markerClasses.includes(node.dataClass) &&
  !node.types.includes('string')
    ? ['string', ...node.types]
    : node.types;

// The schema of one node of the kept shape. A value in an array is never
// missing: the copy of the pipeline puts undefined in its place, which JSON
// writes as null.
const outputNode = (node: ShapeNode, inArray: boolean): JsonObject => {
  const nullable = node.nullable || (inArray && node.optional);
  switch (node.kind) {
    case 'leaf':
      return Object.freeze({
        __proto__: null,
        type: typeOf(leafTypes(node), nullable),
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
