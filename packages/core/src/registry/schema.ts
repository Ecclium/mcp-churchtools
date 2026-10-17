/**
 * Checks the schemas of a tool and keeps the data classes of its output
 * (ADR 0024). The pipeline drops every field the output schema does not
 * declare, so an open form would defeat that. The classes are read once,
 * when the tool is added, so a later change to the registry of zod changes
 * no tool.
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

/** A field of the output and what it holds, as the registry kept it. */
export type ShapeNode =
  | {
      readonly kind: 'object';
      readonly fields: Readonly<Record<string, ShapeNode>>;
    }
  | { readonly kind: 'array'; readonly element: ShapeNode }
  | { readonly kind: 'tuple'; readonly items: readonly ShapeNode[] }
  | { readonly kind: 'leaf'; readonly dataClass: DataClass | undefined };

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

const unsafeNames: readonly string[] = [
  '__proto__',
  'constructor',
  'prototype',
];

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

/** The walk over one output schema, with its counters. */
class OutputWalk {
  nodes = 0;
  unclassified = 0;
  personal = false;

  // Returns undefined for any form the registry does not accept.
  visit(schema: unknown, depth: number): ShapeNode | undefined {
    this.nodes += 1;
    if (this.nodes > maxSchemaNodes) return undefined;
    let internals = internalsOf(schema);
    while (internals !== undefined && wrapperTypes.includes(internals.type)) {
      if (hasCustomCheck(internals.def)) return undefined;
      internals = internalsOf(internals.def.innerType);
      this.nodes += 1;
    }
    if (internals === undefined || hasCustomCheck(internals.def)) {
      return undefined;
    }
    if (leafTypes.includes(internals.type)) return this.leaf(schema);
    if (internals.type === 'union') return this.union(schema, internals);
    if (depth >= maxSchemaDepth) return undefined;
    switch (internals.type) {
      case 'object':
        return this.object(internals, depth);
      case 'array':
        return this.array(internals, depth);
      case 'tuple':
        return this.tuple(internals, depth);
      default:
        return undefined;
    }
  }

  private leaf(schema: unknown): ShapeNode | undefined {
    let dataClass: DataClass | undefined;
    try {
      dataClass = dataClassOf(schema as z.core.$ZodType);
    } catch {
      return undefined;
    }
    this.count(dataClass);
    return freezeNode({ kind: 'leaf', dataClass });
  }

  // A union of leaves only, such as a string or null. All classified options
  // must agree, so no option lowers the class of the field.
  private union(schema: unknown, internals: Internals): ShapeNode | undefined {
    const options = internals.def.options;
    if (!Array.isArray(options) || options.length === 0) return undefined;
    let dataClass: DataClass | undefined;
    try {
      dataClass = dataClassOf(schema as z.core.$ZodType);
      for (const option of options as unknown[]) {
        this.nodes += 1;
        let optionInternals = internalsOf(option);
        while (
          optionInternals !== undefined &&
          wrapperTypes.includes(optionInternals.type) &&
          !hasCustomCheck(optionInternals.def)
        ) {
          optionInternals = internalsOf(optionInternals.def.innerType);
        }
        if (
          optionInternals === undefined ||
          !leafTypes.includes(optionInternals.type) ||
          hasCustomCheck(optionInternals.def)
        ) {
          return undefined;
        }
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
    this.count(dataClass);
    return freezeNode({ kind: 'leaf', dataClass });
  }

  private object(internals: Internals, depth: number): ShapeNode | undefined {
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
    return freezeNode({ kind: 'object', fields: Object.freeze(fields) });
  }

  private array(internals: Internals, depth: number): ShapeNode | undefined {
    const bound = arrayBound(internals.def);
    if (bound === undefined || bound > maxArrayLength) return undefined;
    const element = this.visit(internals.def.element, depth + 1);
    return element === undefined
      ? undefined
      : freezeNode({ kind: 'array', element });
  }

  private tuple(internals: Internals, depth: number): ShapeNode | undefined {
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
    return freezeNode({ kind: 'tuple', items: Object.freeze(nodes) });
  }

  private count(dataClass: DataClass | undefined): void {
    if (dataClass === undefined) this.unclassified += 1;
    else if (personalClasses.includes(dataClass)) this.personal = true;
  }
}

/**
 * Checks the output schema of a tool and keeps what each field holds.
 *
 * Accepted are closed objects (strip or strict), arrays with a maximum of
 * at most {@link maxArrayLength}, tuples without rest, unions of leaves, the
 * wrappers `optional`, `nullable`, `default` and `readonly`, and the leaves
 * string, number, boolean, literal, enum, template literal and null.
 * Refused are loose objects and catch-alls, `any`, `unknown`, records,
 * custom checks such as `refine`, transforms and pipes, `lazy`, bigint,
 * dates and every other form, and schemas of another major version of zod.
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
