/**
 * Walks the input schema of a tool once, when the tool is added, and keeps
 * where its IDs stand and which kind of object each one names (ADR 0028).
 * The pipeline reads the IDs of a call from the input along what is kept
 * here, never from the code of the tool.
 *
 * Every leaf of an input carries a data class or a kind of object, as
 * every leaf of an output carries a class, so that no ID leaves the audit
 * through a class nobody set. Persons and groups are named by the classes
 * `personId` and `groupId`, the other kinds by `refersTo` of the plugin
 * API. A leaf that names a kind has no class or the class `none`.
 *
 * The walk reads internals of zod 4 (`_zod.def`), like the check of the
 * output schema.
 *
 * @packageDocumentation
 */
import { isProxy } from 'node:util/types';

import {
  type DataClass,
  dataClassOf,
  objectKindOf,
} from '@ecclium/mcp-churchtools-plugin-api';
import type { z } from 'zod';

import type { ObjectDomain } from '../audit/index.js';
import {
  type Internals,
  internalsOf,
  maxSchemaDepth,
  maxSchemaNodes,
  own,
} from './schema.js';

/**
 * Where the IDs of an input stand. Only parts that hold an ID are kept: a
 * leaf with its kind, and the objects, lists, records, tuples and choices
 * on the way to it.
 */
export type InputRefNode =
  | { readonly kind: 'leaf'; readonly domain: ObjectDomain }
  | {
      readonly kind: 'object';
      readonly fields: Readonly<Record<string, InputRefNode>>;
      /** The part every further key holds, from a catch-all. */
      readonly rest?: InputRefNode;
    }
  | { readonly kind: 'list'; readonly element: InputRefNode }
  | { readonly kind: 'record'; readonly value: InputRefNode }
  | {
      readonly kind: 'tuple';
      readonly items: readonly (InputRefNode | null)[];
      readonly rest?: InputRefNode;
    }
  | { readonly kind: 'choice'; readonly options: readonly InputRefNode[] };

/** What the walk keeps of an input schema. */
export interface InputShape {
  /** Where its IDs stand, or `undefined` when it has none. */
  readonly refs: InputRefNode | undefined;
  /**
   * Leaves without a data class and without a kind of object. The registry
   * refuses a tool with one.
   */
  readonly undeclared: number;
}

// Wrappers that keep the value of what they wrap.
const wrapperTypes: readonly string[] = [
  'optional',
  'nullable',
  'default',
  'prefault',
  'readonly',
  'catch',
  'nonoptional',
];

// Leaves that can carry a class or a kind.
const leafTypes: readonly string[] = [
  'string',
  'number',
  'bigint',
  'boolean',
  'date',
  'literal',
  'enum',
  'template_literal',
  'null',
];

// The kind of object the class of a leaf names.
const domainOfClass = (
  dataClass: DataClass | undefined,
): ObjectDomain | undefined => {
  if (dataClass === 'personId') return 'person';
  if (dataClass === 'groupId') return 'group';
  return undefined;
};

// Whether a schema carries the class of an ID or a kind of object. A
// class or kind it cannot read counts, so that the walk refuses it.
const namesObject = (schema: unknown): boolean => {
  try {
    const dataClass = dataClassOf(schema as z.core.$ZodType);
    return (
      domainOfClass(dataClass) !== undefined ||
      objectKindOf(schema as z.core.$ZodType) !== undefined
    );
  } catch {
    return true;
  }
};

const freeze = (node: InputRefNode): InputRefNode =>
  Object.freeze({ __proto__: null, ...node });

/** Stands for an input the walk cannot read or does not accept. */
class Refused extends Error {}

/** The walk over one input schema, with its counters. */
class InputWalk {
  nodes = 0;
  undeclared = 0;

  visit(
    schema: unknown,
    depth: number,
    inPipe: boolean,
  ): InputRefNode | undefined {
    this.nodes += 1;
    if (this.nodes > maxSchemaNodes || depth > maxSchemaDepth) {
      throw new Refused();
    }
    let internals = internalsOf(schema);
    let pipe = inPipe;
    // The class or kind of a leaf is read from the outermost schema that
    // dataClassOf can look through: past wrappers, but not past a pipe,
    // whose input side is a schema of its own.
    let outer = schema;
    while (internals !== undefined) {
      if (wrapperTypes.includes(internals.type)) {
        internals = internalsOf(internals.def.innerType);
      } else if (internals.type === 'pipe') {
        pipe = true;
        outer = internals.def.in;
        internals = internalsOf(outer);
      } else {
        break;
      }
      this.nodes += 1;
      if (this.nodes > maxSchemaNodes) throw new Refused();
    }
    if (internals === undefined) throw new Refused();
    const node = this.shape(outer, internals, depth, pipe);
    // A pipe turns the input into another value, so an ID found along its
    // input side could not be read from the parsed value.
    if (node !== undefined && pipe) throw new Refused();
    return node;
  }

  private shape(
    schema: unknown,
    internals: Internals,
    depth: number,
    pipe: boolean,
  ): InputRefNode | undefined {
    if (leafTypes.includes(internals.type)) {
      return this.leaf(schema, internals.type);
    }
    const { def } = internals;
    switch (internals.type) {
      case 'object':
        return this.object(def, depth, pipe);
      case 'array':
        return this.wrap(this.visit(def.element, depth + 1, pipe), 'list');
      case 'record':
        // The keys of a record are never read for IDs, so a key that names
        // a person, a group or another object would pass the audit and the
        // pseudonyms of strict unseen (ADR 0028, ADR 0069).
        if (namesObject(def.keyType)) throw new Refused();
        return this.wrap(this.visit(def.valueType, depth + 1, pipe), 'record');
      case 'tuple':
        return this.tuple(def, depth, pipe);
      case 'union':
        return this.choice(this.all(def.options, depth, pipe));
      case 'intersection':
        return this.choice([
          this.visit(def.left, depth + 1, pipe),
          this.visit(def.right, depth + 1, pipe),
        ]);
      case 'lazy':
        throw new Refused();
      default:
        // Any other form, such as any, unknown or a custom check, holds a
        // value no class or kind can describe.
        this.undeclared += 1;
        return undefined;
    }
  }

  private leaf(schema: unknown, type: string): InputRefNode | undefined {
    let dataClass: DataClass | undefined;
    let kind: ObjectDomain | undefined;
    try {
      dataClass = dataClassOf(schema as z.core.$ZodType);
      kind = objectKindOf(schema as z.core.$ZodType);
    } catch {
      throw new Refused();
    }
    if (dataClass === undefined && kind === undefined) {
      this.undeclared += 1;
      return undefined;
    }
    // An ID of a person or a group has its class, not a kind.
    if (kind !== undefined && dataClass !== undefined && dataClass !== 'none') {
      throw new Refused();
    }
    const domain = kind ?? domainOfClass(dataClass);
    if (domain === undefined) return undefined;
    // An ID is a whole number or text such as a GUID; a bigint or a date
    // would never have the form the audit takes. The ID of a person is a
    // number, because the level strict takes a pseudonym of a whole number
    // in its place (ADR 0069).
    if (type !== 'number' && type !== 'string') throw new Refused();
    if (domain === 'person' && type !== 'number') throw new Refused();
    return freeze({ kind: 'leaf', domain });
  }

  private object(
    def: Readonly<Record<string, unknown>>,
    depth: number,
    pipe: boolean,
  ): InputRefNode | undefined {
    const shape = def.shape;
    if (typeof shape !== 'object' || shape === null) throw new Refused();
    const fields = Object.create(null) as Record<string, InputRefNode>;
    let found = false;
    for (const name of Object.keys(shape)) {
      const node = this.visit(own(shape, name), depth + 1, pipe);
      if (node === undefined) continue;
      fields[name] = node;
      found = true;
    }
    const catchall = def.catchall;
    const rest =
      catchall === undefined || internalsOf(catchall)?.type === 'never'
        ? undefined
        : this.visit(catchall, depth + 1, pipe);
    if (!found && rest === undefined) return undefined;
    return freeze({
      kind: 'object',
      fields: Object.freeze(fields),
      ...(rest === undefined ? {} : { rest }),
    });
  }

  private tuple(
    def: Readonly<Record<string, unknown>>,
    depth: number,
    pipe: boolean,
  ): InputRefNode | undefined {
    const items = def.items;
    if (!Array.isArray(items)) throw new Refused();
    const nodes = (items as unknown[]).map(
      (item) => this.visit(item, depth + 1, pipe) ?? null,
    );
    const rest =
      def.rest === undefined || def.rest === null
        ? undefined
        : this.visit(def.rest, depth + 1, pipe);
    if (nodes.every((node) => node === null) && rest === undefined) {
      return undefined;
    }
    return freeze({
      kind: 'tuple',
      items: Object.freeze(nodes),
      ...(rest === undefined ? {} : { rest }),
    });
  }

  private all(
    options: unknown,
    depth: number,
    pipe: boolean,
  ): (InputRefNode | undefined)[] {
    if (!Array.isArray(options)) throw new Refused();
    return (options as unknown[]).map((option) =>
      this.visit(option, depth + 1, pipe),
    );
  }

  // A choice between forms keeps every form that holds an ID. Leaves among
  // them must name the same kind, so that no value is recorded as two
  // kinds of object.
  private choice(
    options: readonly (InputRefNode | undefined)[],
  ): InputRefNode | undefined {
    const kept = options.filter(
      (option): option is InputRefNode => option !== undefined,
    );
    const domains = new Set(
      kept.flatMap((option) => (option.kind === 'leaf' ? [option.domain] : [])),
    );
    if (domains.size > 1) throw new Refused();
    if (kept.length === 0) return undefined;
    if (kept.length === 1) return kept[0];
    return freeze({ kind: 'choice', options: Object.freeze(kept) });
  }

  private wrap(
    node: InputRefNode | undefined,
    kind: 'list' | 'record',
  ): InputRefNode | undefined {
    if (node === undefined) return undefined;
    return kind === 'list'
      ? freeze({ kind, element: node })
      : freeze({ kind, value: node });
  }
}

/**
 * Walks an input schema and keeps where its IDs stand.
 *
 * Read are objects with their catch-all, arrays, records (their values,
 * not their keys), tuples, unions, intersections, the wrappers and the
 * input side of a pipe. An ID inside a pipe is refused, since the parsed
 * value no longer holds it, and so is a lazy schema.
 *
 * @param schema - The input schema as the plugin hands it over, already
 *   checked as a closed object.
 * @returns The kept shape, or `undefined` when the walk refuses the
 *   schema: a lazy schema, an ID inside a pipe, a kind next to a class
 *   other than `none`, an ID that is no number or text, an ID of a
 *   person that is no number, leaves of a union that name different kinds,
 *   a key of a record that names an object, a class or kind the registry
 *   cannot read, or more than the bounds of
 *   nodes and depth of an output schema.
 * @throws {Error} Whatever else goes wrong while the schema is read, such
 *   as a getter of a definition that throws.
 * @example
 * ```ts
 * checkInputRefs(z.strictObject({
 *   personId: classify(z.number().int(), 'personId'),
 *   page: classify(z.number().int(), 'none'),
 * }));
 * // { refs: { kind: 'object', fields: { personId: { kind: 'leaf',
 * //   domain: 'person' } } }, undeclared: 0 }
 * ```
 */
export function checkInputRefs(schema: unknown): InputShape | undefined {
  const walk = new InputWalk();
  let refs: InputRefNode | undefined;
  try {
    refs = walk.visit(schema, 0, false);
  } catch (error) {
    if (error instanceof Refused) return undefined;
    throw error;
  }
  return Object.freeze({
    __proto__: null,
    refs,
    undeclared: walk.undeclared,
  });
}

/**
 * Whether the kept shape of an input holds an ID of a person anywhere,
 * which the level `strict` takes as a pseudonym (ADR 0069).
 *
 * @param node - Where the IDs of an input stand.
 * @returns Whether a leaf names a person.
 * @example
 * ```ts
 * holdsPersons(shape.refs); // true for an input with a personId
 * ```
 */
export function holdsPersons(node: InputRefNode): boolean {
  switch (node.kind) {
    case 'leaf':
      return node.domain === 'person';
    case 'object':
      return (
        Object.values(node.fields).some(holdsPersons) ||
        (node.rest !== undefined && holdsPersons(node.rest))
      );
    case 'list':
      return holdsPersons(node.element);
    case 'record':
      return holdsPersons(node.value);
    case 'tuple':
      return (
        node.items.some((item) => item !== null && holdsPersons(item)) ||
        (node.rest !== undefined && holdsPersons(node.rest))
      );
    case 'choice':
      return node.options.some(holdsPersons);
  }
}

// An object whose own properties can be read without running its code.
const isPlainTarget = (value: unknown): value is object =>
  typeof value === 'object' && value !== null && !isProxy(value);

// The own data properties of an object, by name, without a getter.
const ownEntries = (value: object): [string, unknown][] => {
  const entries: [string, unknown][] = [];
  for (const key of Object.keys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && 'value' in descriptor) {
      entries.push([key, descriptor.value]);
    }
  }
  return entries;
};

// The items of an array; the length is no enumerable key.
const items = (value: unknown): unknown[] =>
  isPlainTarget(value) && Array.isArray(value)
    ? ownEntries(value).map(([, item]) => item)
    : [];

/**
 * Hands every ID of a parsed input to `add`, along the kept shape. Only own
 * data properties of plain objects and arrays are read; a proxy, a getter
 * or a value of another form gives nothing.
 *
 * @param value - The input as the schema of the tool parsed it.
 * @param node - Where the IDs stand.
 * @param add - Takes the kind and the value of each ID, in order, but no
 *   missing or null one.
 * @example
 * ```ts
 * collectInputRefs({ calendarIds: [1, 2] }, shape.refs, refs.add);
 * ```
 */
export function collectInputRefs(
  value: unknown,
  node: InputRefNode,
  add: (domain: ObjectDomain, value: unknown) => void,
): void {
  switch (node.kind) {
    case 'leaf':
      // A missing or null ID asks for nothing.
      if (value !== null && value !== undefined) add(node.domain, value);
      return;
    case 'object': {
      if (!isPlainTarget(value) || Array.isArray(value)) return;
      for (const [key, field] of ownEntries(value)) {
        const fieldNode = Object.hasOwn(node.fields, key)
          ? node.fields[key]
          : node.rest;
        if (fieldNode !== undefined) collectInputRefs(field, fieldNode, add);
      }
      return;
    }
    case 'list':
      for (const item of items(value)) {
        collectInputRefs(item, node.element, add);
      }
      return;
    case 'record':
      if (!isPlainTarget(value) || Array.isArray(value)) return;
      for (const [, field] of ownEntries(value)) {
        collectInputRefs(field, node.value, add);
      }
      return;
    case 'tuple':
      items(value).forEach((item, index) => {
        const itemNode =
          index < node.items.length ? node.items[index] : node.rest;
        if (itemNode !== undefined && itemNode !== null) {
          collectInputRefs(item, itemNode, add);
        }
      });
      return;
    case 'choice':
      for (const option of node.options) collectInputRefs(value, option, add);
  }
}
