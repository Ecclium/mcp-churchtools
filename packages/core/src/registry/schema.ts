/**
 * Checks the schemas of a tool and keeps what each field of its output
 * holds: its data class, the types of JSON of a leaf and whether a value may
 * be missing or null (ADR 0024). The pipeline drops every field the output
 * schema does not declare, so an open form would defeat that. The classes
 * are read once, when the tool is added, so a later change to the registry
 * of zod changes no tool. The mount derives the schema it advertises from
 * the kept shape, not from the schema of the tool.
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
import type { z } from 'zod';

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
  /** Leaves without a data class. They stay unmasked in phase 1. */
  readonly unclassified: number;
  /** The lowest sensitivity the classes of the output allow. */
  readonly minimumSensitivity: Sensitivity;
}

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

interface Internals {
  readonly type: string;
  readonly def: Readonly<Record<string, unknown>>;
}

const own = (value: unknown, key: string): unknown => {
  if (typeof value !== 'object' || value === null) return undefined;
  const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && 'value' in descriptor
    ? descriptor.value
    : undefined;
};

// The definition of a schema of zod 4, or undefined for anything else,
// such as a schema of zod 3, which another copy of the registry would hold.
const internalsOf = (schema: unknown): Internals | undefined => {
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
  // pipeline masks or wraps allows only strings and null as options. As in
  // zod, the union may be missing when one of its options may, unless a
  // wrapper around the union decides.
  private union(
    schema: unknown,
    internals: Internals,
    outer: Unwrapped,
  ): ShapeNode | undefined {
    const options = internals.def.options;
    if (!Array.isArray(options) || options.length === 0) return undefined;
    let dataClass: DataClass | undefined;
    let onlyText = true;
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
    if (dataClass === undefined) this.unclassified += 1;
    else if (personalClasses.includes(dataClass)) this.personal = true;
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
 * wraps their values as text.
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
 * // { root: …, unclassified: 0, minimumSensitivity: 'personal' }
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
  });
}

/**
 * Checks the input schema of a tool: a closed object of zod 4. Its fields
 * may use any form, because the input goes to the tool, not to the model.
 *
 * @param schema - The input schema as the plugin hands it over.
 * @returns Whether the registry accepts it.
 * @example
 * ```ts
 * checkInputSchema(z.object({ query: z.string().max(100) })); // true
 * checkInputSchema(z.looseObject({})); // false
 * ```
 */
export function checkInputSchema(schema: unknown): boolean {
  const internals = internalsOf(schema);
  return internals?.type === 'object' && isClosedObject(internals);
}
