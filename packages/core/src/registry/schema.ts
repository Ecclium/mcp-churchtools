/**
 * Checks the schemas of a tool and keeps what each field of its output
 * holds: its data class, the types of JSON of a leaf and whether a value may
 * be missing or null (ADR 0024). The pipeline drops every field the output
 * schema does not declare, so an open form would defeat that. The classes
 * are read once, when the tool is added, so a later change to the registry
 * of zod changes no tool. The mount derives the schema it advertises from
 * the kept shape, not from the schema of the tool.
 *
 * The input schema the mount advertises is derived here, once, when the
 * tool is added, so an input schema that cannot be advertised stops the
 * start in the registry, before any server is built. It is converted from
 * the zod schema of the tool and then rebuilt from a list of allowed
 * keywords. Descriptions and every other annotation from the registry of
 * zod stay behind: no check of the registry reads them, and the model
 * reads the list of tools in every session.
 *
 * The check reads internals of zod 4 (`_zod.def`), which zod marks as
 * internal. It is tested with the version core pins.
 *
 * @packageDocumentation
 */
import {
  type DataClass,
  dataClassOf,
  type Sensitivity,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

/** The deepest nesting of objects, arrays and tuples in an output schema. */
export const maxSchemaDepth = 16;

/** The most schemas the registry visits in one output schema. */
export const maxSchemaNodes = 2000;

/** The largest maximum an array of an output schema may declare. */
export const maxArrayLength = 10_000;

/** A type of JSON that a leaf of the output can have. */
export type LeafType = 'string' | 'number' | 'boolean' | 'null';

/** Whether a value may be missing or null, as its wrappers say. */
export interface ShapePresence {
  /**
   * Whether the value may be missing: the outermost of the wrappers
   * `optional` and `default` decides, as in zod, because `default` fills a
   * missing value and `optional` lets one through.
   */
  readonly optional: boolean;
  /** Whether a wrapper `nullable` lets the value be null. */
  readonly nullable: boolean;
}

/**
 * A field of the output and what it holds, as the registry kept it. A leaf
 * lists the types of JSON its value can have; it may also be null through
 * `nullable`.
 */
export type ShapeNode =
  | (ShapePresence & {
      readonly kind: 'object';
      readonly fields: Readonly<Record<string, ShapeNode>>;
    })
  | (ShapePresence & { readonly kind: 'array'; readonly element: ShapeNode })
  | (ShapePresence & {
      readonly kind: 'tuple';
      readonly items: readonly ShapeNode[];
    })
  | (ShapePresence & {
      readonly kind: 'leaf';
      readonly dataClass: DataClass | undefined;
      readonly types: readonly LeafType[];
    });

/** What the registry keeps of an output schema. */
export interface OutputShape {
  /** The shape of the result, an object. */
  readonly root: ShapeNode & { readonly kind: 'object' };
  /** Leaves without a data class. The registry refuses a tool with one. */
  readonly unclassified: number;
  /** The lowest sensitivity the classes of the output allow. */
  readonly minimumSensitivity: Sensitivity;
  /**
   * Whether a leaf holds the ID or a name of a person, the classes
   * `personId`, `name.first` and `name.last`. The registry derives from it
   * which tools it treats like special ones (ADR 0064).
   */
  readonly namesPersons: boolean;
}

/**
 * Classes whose values the pipeline replaces with a marker as a whole:
 * the street, postcode and coordinates of an address and an amount of
 * money (ADR 0026, ADR 0069). Their leaves must be strings or numbers, so
 * that the marker, a string, takes the place of a value of a known type
 * and the mount can advertise both.
 */
export const markerClasses: readonly DataClass[] = Object.freeze([
  'address',
  'amount',
]);

// Classes that make a tool hold personal data.
const personalClasses: readonly DataClass[] = [
  'personId',
  'name.first',
  'name.last',
  'email',
  'phone',
  'birthdate',
  'address',
];

// Classes that name a person: a tool that passes one on names persons.
const personNameClasses: readonly DataClass[] = [
  'personId',
  'name.first',
  'name.last',
];

// Leaves that JSON carries as they are. A bigint makes JSON.stringify
// throw and a date becomes a string, so neither is a leaf of an output.
const leafTypes: readonly string[] = [
  'string',
  'number',
  'boolean',
  'literal',
  'enum',
  'template_literal',
  'null',
];

// Wrappers that keep the shape of what they wrap. catch, prefault and
// nonoptional are left out: catch swallows a wrong value, and the others
// are not needed for an output.
const wrapperTypes: readonly string[] = [
  'optional',
  'nullable',
  'default',
  'readonly',
];

// Classes whose leaves the pipeline masks or wraps in the data envelope.
// Their leaves must be strings, so that a mask or an envelope never changes
// the type of a value (ADR 0024).
const textClasses: readonly DataClass[] = [
  'email',
  'phone',
  'birthdate',
  'untrusted',
];

const unsafeNames: readonly string[] = [
  '__proto__',
  'constructor',
  'prototype',
];

const isTextClass = (dataClass: DataClass | undefined): boolean =>
  dataClass !== undefined && textClasses.includes(dataClass);

const isMarkerClass = (dataClass: DataClass | undefined): boolean =>
  dataClass !== undefined && markerClasses.includes(dataClass);

/** The type and the definition of a schema of zod 4. */
export interface Internals {
  readonly type: string;
  readonly def: Readonly<Record<string, unknown>>;
}

/**
 * An own data property of a value, never inherited and never through a
 * getter.
 *
 * @param value - Any value.
 * @param key - The name of the property.
 * @returns Its value, or `undefined`.
 */
export const own = (value: unknown, key: string): unknown => {
  if (typeof value !== 'object' || value === null) return undefined;
  const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && 'value' in descriptor
    ? descriptor.value
    : undefined;
};

/**
 * The definition of a schema of zod 4, or `undefined` for anything else,
 * such as a schema of zod 3, which another copy of the registry would hold.
 *
 * @param schema - Any value.
 * @returns Type and definition of the schema.
 */
export const internalsOf = (schema: unknown): Internals | undefined => {
  const zod = own(schema, '_zod');
  if (own(own(zod, 'version'), 'major') !== 4) return undefined;
  const def = own(zod, 'def');
  const type = own(def, 'type');
  if (typeof type !== 'string') return undefined;
  return { type, def: def as Readonly<Record<string, unknown>> };
};

// A check written by the author, such as refine, runs code on every value
// and is no form the registry can read.
const hasCustomCheck = (def: Readonly<Record<string, unknown>>): boolean => {
  const checks = def.checks;
  if (checks === undefined) return false;
  if (!Array.isArray(checks)) return true;
  return checks.some(
    (check: unknown) =>
      own(own(own(check, '_zod'), 'def'), 'check') === 'custom',
  );
};

const arrayBound = (
  def: Readonly<Record<string, unknown>>,
): number | undefined => {
  if (!Array.isArray(def.checks)) return undefined;
  let bound: number | undefined;
  for (const check of def.checks as unknown[]) {
    const checkDef = own(own(check, '_zod'), 'def');
    const kind = own(checkDef, 'check');
    const limit =
      kind === 'max_length'
        ? own(checkDef, 'maximum')
        : kind === 'length_equals'
          ? own(checkDef, 'length')
          : undefined;
    if (typeof limit === 'number' && (bound === undefined || limit < bound)) {
      bound = limit;
    }
  }
  return bound;
};

const isFieldName = (name: string): boolean => {
  if (name.length < 1 || name.length > 100 || unsafeNames.includes(name)) {
    return false;
  }
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
};

const isClosedObject = (internals: Internals): boolean => {
  const catchall = internals.def.catchall;
  return catchall === undefined || internalsOf(catchall)?.type === 'never';
};

const freezeNode = (node: ShapeNode): ShapeNode =>
  Object.freeze({ __proto__: null, ...node });

// The order of the types of a leaf, so that equal leaves are kept alike.
const typeOrder: readonly LeafType[] = ['string', 'number', 'boolean', 'null'];

// The type of JSON of a value of a literal or an enum. JSON.stringify throws
// on a bigint and turns undefined and numbers that are not finite into
// other values, so these have none.
const jsonTypeOf = (value: unknown): LeafType | undefined => {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
      return Number.isFinite(value) ? 'number' : undefined;
    case 'boolean':
      return 'boolean';
    default:
      return undefined;
  }
};

// The types of JSON of a leaf, or undefined when one of its values has none.
const typesOf = (internals: Internals): readonly LeafType[] | undefined => {
  let values: readonly unknown[];
  switch (internals.type) {
    case 'string':
    case 'template_literal':
      return ['string'];
    case 'number':
      return ['number'];
    case 'boolean':
      return ['boolean'];
    case 'null':
      return ['null'];
    case 'literal': {
      const { values: literals } = internals.def;
      values = Array.isArray(literals) ? (literals as unknown[]) : [];
      break;
    }
    default: {
      // The last leaf type, enum.
      const { entries } = internals.def;
      values =
        typeof entries === 'object' && entries !== null
          ? Object.values(entries)
          : [];
    }
  }
  const types = new Set<LeafType>();
  for (const value of values) {
    const type = jsonTypeOf(value);
    if (type === undefined) return undefined;
    types.add(type);
  }
  return types.size === 0
    ? undefined
    : typeOrder.filter((type) => types.has(type));
};

/** A schema without its accepted wrappers. */
interface Unwrapped {
  readonly internals: Internals;
  /** How many wrappers it had. */
  readonly wrappers: number;
  /** What the outermost `optional` or `default` says, if there is one. */
  readonly optional: boolean | undefined;
  /** Whether a wrapper `nullable` lets the value be null. */
  readonly nullable: boolean;
}

// Takes off the accepted wrappers, outermost first, and notes whether they
// let a value be missing or null. Returns undefined for a wrapper or a
// schema with a custom check and for anything that is no schema of zod 4.
const unwrap = (schema: unknown): Unwrapped | undefined => {
  let internals = internalsOf(schema);
  let wrappers = 0;
  let optional: boolean | undefined;
  let nullable = false;
  while (internals !== undefined && wrapperTypes.includes(internals.type)) {
    if (hasCustomCheck(internals.def)) return undefined;
    if (internals.type === 'nullable') nullable = true;
    else if (internals.type === 'optional') optional ??= true;
    else if (internals.type === 'default') optional ??= false;
    internals = internalsOf(internals.def.innerType);
    wrappers += 1;
  }
  if (internals === undefined || hasCustomCheck(internals.def)) {
    return undefined;
  }
  return { internals, wrappers, optional, nullable };
};

/** The walk over one output schema, with its counters. */
class OutputWalk {
  nodes = 0;
  unclassified = 0;
  personal = false;
  namesPersons = false;

  // Returns undefined for any form the registry does not accept.
  visit(schema: unknown, depth: number): ShapeNode | undefined {
    this.nodes += 1;
    if (this.nodes > maxSchemaNodes) return undefined;
    const unwrapped = unwrap(schema);
    if (unwrapped === undefined) return undefined;
    this.nodes += unwrapped.wrappers;
    const { internals } = unwrapped;
    const presence: ShapePresence = {
      optional: unwrapped.optional ?? false,
      nullable: unwrapped.nullable,
    };
    if (leafTypes.includes(internals.type)) {
      return this.leaf(schema, internals, presence);
    }
    if (internals.type === 'union') {
      return this.union(schema, internals, unwrapped);
    }
    if (depth >= maxSchemaDepth) return undefined;
    switch (internals.type) {
      case 'object':
        return this.object(internals, depth, presence);
      case 'array':
        return this.array(internals, depth, presence);
      case 'tuple':
        return this.tuple(internals, depth, presence);
      default:
        return undefined;
    }
  }

  private leaf(
    schema: unknown,
    internals: Internals,
    presence: ShapePresence,
  ): ShapeNode | undefined {
    const types = typesOf(internals);
    if (types === undefined) return undefined;
    let dataClass: DataClass | undefined;
    try {
      dataClass = dataClassOf(schema as z.core.$ZodType);
    } catch {
      return undefined;
    }
    if (isTextClass(dataClass) && internals.type !== 'string') {
      return undefined;
    }
    if (
      isMarkerClass(dataClass) &&
      internals.type !== 'string' &&
      internals.type !== 'number'
    ) {
      return undefined;
    }
    this.count(dataClass);
    return freezeNode({
      kind: 'leaf',
      dataClass,
      types: Object.freeze(types),
      ...presence,
    });
  }

  // A union of leaves only, such as a string or null. All classified options
  // must agree, so no option lowers the class of the field. A class the
  // pipeline masks or wraps allows only strings and null as options, one
  // it replaces with a marker also numbers. As in zod, the union may be
  // missing when one of its options may, unless a wrapper around the union
  // decides.
  private union(
    schema: unknown,
    internals: Internals,
    outer: Unwrapped,
  ): ShapeNode | undefined {
    const options = internals.def.options;
    if (!Array.isArray(options) || options.length === 0) return undefined;
    let dataClass: DataClass | undefined;
    let onlyText = true;
    let onlyTextOrNumber = true;
    let optional = false;
    let nullable = outer.nullable;
    const types = new Set<LeafType>();
    try {
      dataClass = dataClassOf(schema as z.core.$ZodType);
      for (const option of options as unknown[]) {
        this.nodes += 1;
        const unwrapped = unwrap(option);
        if (
          unwrapped === undefined ||
          !leafTypes.includes(unwrapped.internals.type)
        ) {
          return undefined;
        }
        const optionTypes = typesOf(unwrapped.internals);
        if (optionTypes === undefined) return undefined;
        for (const type of optionTypes) types.add(type);
        const optionType = unwrapped.internals.type;
        if (optionType !== 'string' && optionType !== 'null') {
          onlyText = false;
        }
        if (
          optionType !== 'string' &&
          optionType !== 'number' &&
          optionType !== 'null'
        ) {
          onlyTextOrNumber = false;
        }
        optional ||= unwrapped.optional === true;
        nullable ||= unwrapped.nullable;
        const optionClass = dataClassOf(option as z.core.$ZodType);
        if (optionClass === undefined) continue;
        if (dataClass !== undefined && dataClass !== optionClass) {
          return undefined;
        }
        dataClass = optionClass;
      }
    } catch {
      return undefined;
    }
    if (this.nodes > maxSchemaNodes) return undefined;
    if (isTextClass(dataClass) && !onlyText) return undefined;
    if (isMarkerClass(dataClass) && !onlyTextOrNumber) return undefined;
    this.count(dataClass);
    return freezeNode({
      kind: 'leaf',
      dataClass,
      types: Object.freeze(typeOrder.filter((type) => types.has(type))),
      optional: outer.optional ?? optional,
      nullable,
    });
  }

  private object(
    internals: Internals,
    depth: number,
    presence: ShapePresence,
  ): ShapeNode | undefined {
    if (!isClosedObject(internals)) return undefined;
    const shape = internals.def.shape;
    if (typeof shape !== 'object' || shape === null) return undefined;
    const fields = Object.create(null) as Record<string, ShapeNode>;
    for (const name of Object.keys(shape)) {
      if (!isFieldName(name)) return undefined;
      const node = this.visit(own(shape, name), depth + 1);
      if (node === undefined) return undefined;
      fields[name] = node;
    }
    return freezeNode({
      kind: 'object',
      fields: Object.freeze(fields),
      ...presence,
    });
  }

  private array(
    internals: Internals,
    depth: number,
    presence: ShapePresence,
  ): ShapeNode | undefined {
    const bound = arrayBound(internals.def);
    if (bound === undefined || bound > maxArrayLength) return undefined;
    const element = this.visit(internals.def.element, depth + 1);
    return element === undefined
      ? undefined
      : freezeNode({ kind: 'array', element, ...presence });
  }

  private tuple(
    internals: Internals,
    depth: number,
    presence: ShapePresence,
  ): ShapeNode | undefined {
    const { items, rest } = internals.def;
    if (!Array.isArray(items) || (rest !== undefined && rest !== null)) {
      return undefined;
    }
    const nodes: ShapeNode[] = [];
    for (const item of items as unknown[]) {
      const node = this.visit(item, depth + 1);
      if (node === undefined) return undefined;
      nodes.push(node);
    }
    return freezeNode({
      kind: 'tuple',
      items: Object.freeze(nodes),
      ...presence,
    });
  }

  private count(dataClass: DataClass | undefined): void {
    if (dataClass === undefined) {
      this.unclassified += 1;
      return;
    }
    if (personalClasses.includes(dataClass)) this.personal = true;
    if (personNameClasses.includes(dataClass)) this.namesPersons = true;
  }
}

/**
 * Checks the output schema of a tool and keeps what each field holds: its
 * data class, the types of JSON of a leaf and whether a value may be
 * missing or null. The mount derives the schema it advertises from these.
 *
 * Accepted are closed objects (strip or strict), arrays with a maximum of
 * at most {@link maxArrayLength}, tuples without rest, unions of leaves, the
 * wrappers `optional`, `nullable`, `default` and `readonly`, and the leaves
 * string, number, boolean, literal, enum, template literal and null.
 * The classes `email`, `phone`, `birthdate` and `untrusted` fit only a
 * string, or a union of strings and null, because the pipeline masks or
 * wraps their values as text. The classes `address` and `amount` fit a
 * string or a number, or a union of them and null, because the pipeline
 * replaces their values with a marker.
 * Refused are loose objects and catch-alls, `any`, `unknown`, records,
 * custom checks such as `refine`, transforms and pipes, `lazy`, bigint,
 * dates and every other form, literals and enums with a value JSON does not
 * carry as it is (bigint, undefined, a number that is not finite), and
 * schemas of another major version of zod.
 *
 * @param schema - The output schema as the plugin hands it over.
 * @returns The kept shape, frozen, or `undefined` when the registry does not
 *   accept the schema.
 * @example
 * ```ts
 * checkOutputSchema(z.object({ id: classify(z.number(), 'personId') }));
 * // { root: …, unclassified: 0, minimumSensitivity: 'personal',
 * //   namesPersons: true }
 * ```
 */
export function checkOutputSchema(schema: unknown): OutputShape | undefined {
  const internals = internalsOf(schema);
  if (internals?.type !== 'object') return undefined;
  const walk = new OutputWalk();
  const root = walk.visit(schema, 0);
  if (root?.kind !== 'object') return undefined;
  return Object.freeze({
    __proto__: null,
    root,
    unclassified: walk.unclassified,
    minimumSensitivity: walk.personal ? 'personal' : 'none',
    namesPersons: walk.namesPersons,
  });
}

/** A JSON Schema of an object as the mount advertises it, frozen. */
export interface ObjectJsonSchema {
  /** An object, as MCP requires for input and structured output. */
  readonly type: 'object';
  /** The other keywords. */
  readonly [keyword: string]: unknown;
}

type JsonObject = Readonly<Record<string, unknown>>;

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
 * Checks the input schema of a tool and derives the JSON Schema the mount
 * advertises for it. The schema must be a closed object of zod 4. Its
 * fields may use any form that JSON Schema can hold, because the input
 * goes to the tool, not to the model. The converter of the zod that core
 * pins turns the schema into JSON Schema for its input, and the result is
 * rebuilt from the keywords of structure and validation only, so no
 * description and no other entry of the registry of zod reaches the list
 * of tools. The pipeline still validates every input with the schema of
 * the tool.
 *
 * @param schema - The input schema as the plugin hands it over.
 * @returns The schema the mount advertises, frozen, without prototypes and
 *   without `$schema`, or `undefined` when the registry does not accept the
 *   input schema: when it is no closed object of zod 4, when zod cannot
 *   convert it, when the result holds a reference, a keyword with a value
 *   of the wrong form or more than {@link maxSchemaNodes} schemas, or when
 *   its root is no object.
 * @example
 * ```ts
 * checkInputSchema(z.object({ query: z.string().max(100) }));
 * // { type: 'object', properties: { query: { type: 'string',
 * //   maxLength: 100 } }, required: ['query'] }
 * checkInputSchema(z.looseObject({})); // undefined
 * ```
 */
export function checkInputSchema(
  schema: unknown,
): ObjectJsonSchema | undefined {
  const internals = internalsOf(schema);
  if (internals?.type !== 'object' || !isClosedObject(internals)) {
    return undefined;
  }
  // The converter of the zod core pins, not ~standard.jsonSchema of the
  // schema. Both read the same accessors of the zod the plugin built its
  // schema with, ~standard among them, but there the function that getter
  // returns would make the whole result. Here the walk is code core pins
  // and tests, and the rebuild below decides what is kept (ADR 0024).
  let converted: unknown;
  try {
    converted = z.toJSONSchema(schema as z.ZodType, {
      target: 'draft-2020-12',
      io: 'input',
      unrepresentable: 'throw',
    });
  } catch {
    return undefined;
  }
  const rebuilt = new InputRebuild().schema(converted);
  return isObject(rebuilt) && rebuilt.type === 'object'
    ? (rebuilt as ObjectJsonSchema)
    : undefined;
}
