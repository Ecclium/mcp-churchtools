/**
 * Data classes and kinds of objects of the fields of a schema, kept in the
 * global registry of zod.
 *
 * @packageDocumentation
 */

import { z } from 'zod';

/**
 * What a field of a schema holds, as far as redaction and the data envelope
 * care. Every leaf of an output schema carries one, and every leaf of an
 * input schema carries one or a kind of object ({@link refersTo}).
 *
 * - `none`: no personal data.
 * - `personId`: an ID of a person.
 * - `groupId`: an ID of a group. No level of redaction changes it, since it
 *   names no person; the audit records it (ADR 0028).
 * - `name.first`, `name.last`: first and last name.
 * - `email`, `phone`, `birthdate`, `address`: contact data and date of birth.
 * - `amount`: a sum of money.
 * - `untrusted`: free text from ChurchTools, which may contain instructions.
 *   The pipeline puts every field of this class into the data envelope, so
 *   free text is marked on the field it is in, not by a separate flag in the
 *   metadata of the tool.
 */
export type DataClass =
  | 'none'
  | 'personId'
  | 'groupId'
  | 'name.first'
  | 'name.last'
  | 'email'
  | 'phone'
  | 'birthdate'
  | 'address'
  | 'amount'
  | 'untrusted';

/**
 * The kind of object an ID in the input of a tool names, for the IDs the
 * audit records (ADR 0028). Persons and groups are not among them: their
 * IDs carry the data classes `personId` and `groupId`, which redaction
 * reads as well.
 */
export type ObjectKind =
  | 'event'
  | 'appointment'
  | 'calendar'
  | 'resource'
  | 'booking'
  | 'service'
  | 'song'
  | 'wiki_category'
  | 'wiki_page';

/** Every {@link ObjectKind}, frozen, for checks at run time. */
export const objectKinds: readonly ObjectKind[] = Object.freeze([
  'event',
  'appointment',
  'calendar',
  'resource',
  'booking',
  'service',
  'song',
  'wiki_category',
  'wiki_page',
]);

/** Every {@link DataClass}, frozen, for checks at run time. */
export const dataClasses: readonly DataClass[] = Object.freeze([
  'none',
  'personId',
  'groupId',
  'name.first',
  'name.last',
  'email',
  'phone',
  'birthdate',
  'address',
  'amount',
  'untrusted',
]);

// The class is stored under a symbol from the global symbol registry: every
// copy of this package computes the same key, and every copy of zod shares
// one global registry, so the core reads what a plugin wrote with its own
// copies (ADR 0022). A symbol, not a string: zod copies string keys of the
// registry into the JSON Schema it generates, which would send the class to
// the client in the schema of every tool.
const dataClassKey = Symbol.for('ecclium.mcp-churchtools.data-class.v1');
// The kind of object of an ID, kept the same way under a key of its own.
const objectKindKey = Symbol.for('ecclium.mcp-churchtools.object-kind.v1');

// Schema types that only wrap another one, which they name in innerType.
// dataClassOf looks through them to the classified leaf. A pipe is not among
// them: which of its two sides a class would describe is not clear.
const wrapperTypes: readonly string[] = Object.freeze([
  'optional',
  'nullable',
  'default',
  'prefault',
  'readonly',
  'catch',
  'nonoptional',
]);

// Schema types that hold one value and nothing open: only these carry a
// class. A container such as an object or an array would hide its fields
// behind one class, and an open shape such as any, a record or a custom
// check could hold content of any kind under a class that says it holds
// none.
const leafTypes: readonly string[] = Object.freeze([
  'string',
  'number',
  'bigint',
  'boolean',
  'date',
  'literal',
  'enum',
  'template_literal',
  'null',
]);

// Upper bound for the steps through wrappers and copies. zod builds no
// cycles, but a schema changed by hand could hold one, and the walk must
// end. Every check such as .max() adds a step, so the bound is far above
// what a real schema needs.
const maxSteps = 1000;

const unreadable =
  'The zod registry holds an entry the plugin API cannot read.';

const isDataClass = (value: unknown): value is DataClass =>
  (dataClasses as readonly unknown[]).includes(value);

const isObjectKind = (value: unknown): value is ObjectKind =>
  (objectKinds as readonly unknown[]).includes(value);

// The schema a wrapper wraps, or undefined for any other schema.
function innerOf(schema: z.core.$ZodType): z.core.$ZodType | undefined {
  const def = schema._zod.def as {
    readonly type: string;
    readonly innerType?: z.core.$ZodType;
  };
  return wrapperTypes.includes(def.type) ? def.innerType : undefined;
}

/** What is kept under one key of the registry: a class or a kind. */
interface Mark<T extends string> {
  readonly key: symbol;
  readonly known: (value: unknown) => value is T;
  readonly unknown: string;
  readonly name: string;
}

const classMark: Mark<DataClass> = {
  key: dataClassKey,
  known: isDataClass,
  unknown:
    'The zod registry holds a data class this version of the plugin API does not know.',
  name: 'data classes',
};

const kindMark: Mark<ObjectKind> = {
  key: objectKindKey,
  known: isObjectKind,
  unknown:
    'The zod registry holds a kind of object this version of the plugin API does not know.',
  name: 'kinds of object',
};

// The mark in the own entry of exactly this schema. zod's get() would merge
// in the entry of the schema it was copied from, but returns nothing for a
// copy when the merged entry has only symbol keys, so it would hide the mark
// of nearly every leaf. The own entry is read without its prototype and
// without running a getter, and whatever goes wrong while reading it ends in
// a fixed message, never in text from the entry.
function ownMark<T extends string>(
  schema: z.core.$ZodType,
  mark: Mark<T>,
): T | undefined {
  let value: unknown;
  try {
    const own: unknown = z.globalRegistry._map.get(schema);
    if (own === undefined) return undefined;
    const property = Object.getOwnPropertyDescriptor(own, mark.key);
    if (property === undefined) return undefined;
    if (!('value' in property)) throw new TypeError('no plain value');
    value = property.value;
  } catch {
    throw new TypeError(unreadable);
  }
  if (!mark.known(value)) throw new TypeError(mark.unknown);
  return value;
}

// The mark of a schema through its wrappers and the schemas it was copied
// from. All marks found on the way must agree.
function markOf<T extends string>(
  schema: z.core.$ZodType,
  mark: Mark<T>,
): T | undefined {
  let found: T | undefined;
  let steps = 0;
  for (
    let wrapper: z.core.$ZodType | undefined = schema;
    wrapper !== undefined;
    wrapper = innerOf(wrapper)
  ) {
    for (
      let current: z.core.$ZodType | undefined = wrapper;
      current !== undefined;
      current = current._zod.parent
    ) {
      steps += 1;
      if (steps > maxSteps) {
        throw new Error(
          'The chain of wrappers and copies is longer than 1000 steps, which suggests a loop.',
        );
      }
      const value = ownMark(current, mark);
      if (value === undefined) continue;
      if (found !== undefined && found !== value) {
        throw new Error(
          `The schema carries different ${mark.name}: ${found} and ${value}.`,
        );
      }
      found = value;
    }
  }
  return found;
}

// The leaf inside the wrappers of a schema, which must be one of the leaf
// types.
function leafOf(schema: z.core.$ZodType): void {
  let leaf: z.core.$ZodType = schema;
  for (let inner = innerOf(leaf); inner !== undefined; inner = innerOf(leaf)) {
    leaf = inner;
  }
  if (!leafTypes.includes(leaf._zod.def.type)) {
    throw new TypeError(
      'Only a leaf such as a string, a number or an enum carries a data class or a kind of object, not a container or an open shape.',
    );
  }
}

// Writes a mark into the own entry of a schema. Only the own entry: merging
// in what the schema inherits would freeze the metadata of its parent into
// it.
function addMark(schema: z.core.$ZodType, key: symbol, value: string): void {
  z.globalRegistry.add(schema, { ...ownEntryCopy(schema), [key]: value });
}

// A plain copy of the own entry of a schema, to write it back with the
// class. Spreading the entry would run its getters and the traps of a
// proxy, whose errors could carry any text; this copy takes only plain
// values and ends in a fixed message otherwise.
function ownEntryCopy(schema: z.core.$ZodType): Record<PropertyKey, unknown> {
  const copy: Record<PropertyKey, unknown> = {};
  try {
    const own: unknown = z.globalRegistry._map.get(schema);
    if (own === undefined) return copy;
    if (typeof own !== 'object' || own === null) throw new TypeError('');
    for (const key of Reflect.ownKeys(own)) {
      const property = Object.getOwnPropertyDescriptor(own, key);
      if (property === undefined || property.enumerable !== true) continue;
      if (!('value' in property)) throw new TypeError('');
      copy[key] = property.value;
    }
  } catch {
    throw new TypeError(unreadable);
  }
  return copy;
}

/**
 * Reads the data class of a schema.
 *
 * A copy made by a check such as `.max()` or by `.describe()` has the class
 * of the schema it was copied from. Wrappers such as `.optional()`,
 * `.nullable()` and `.default()` are looked through to the schema they wrap.
 * All classes found on the way must agree: a copy or a wrapper with another
 * class than its original is an error, so that no class can be lowered on
 * the way to the leaf.
 *
 * @param schema - A zod schema, usually a leaf of an output schema.
 * @returns The class, or `undefined` when neither the schema nor a schema it
 *   wraps or was copied from is classified.
 * @throws {TypeError} When the registry holds a value that is no known class,
 *   for example written by a newer version of this package, or an entry it
 *   cannot read.
 * @throws {Error} When two schemas on the way carry different classes, or
 *   when the way is longer than 1000 steps, which suggests a loop.
 * @example
 * ```ts
 * const email = classify(z.string(), 'email');
 * dataClassOf(email.optional()); // 'email'
 * ```
 */
export function dataClassOf(schema: z.core.$ZodType): DataClass | undefined {
  return markOf(schema, classMark);
}

/**
 * Classifies a schema in the global registry of zod and returns the same
 * schema.
 *
 * Only a leaf carries a class: a string, a number, a big integer, a
 * boolean, a date, a literal, an enum, a template literal or null, also
 * inside wrappers such as `.optional()`. Copies of the schema that zod links
 * to it, such as those made by `.max()`, `.refine()` or `.describe()`, have
 * the same class. A transform makes a new schema without it. Other metadata
 * of the schema stays as it is.
 *
 * @param schema - The schema to classify, usually a leaf of an output schema.
 * @param dataClass - What the field holds.
 * @returns The same schema, now classified.
 * @throws {TypeError} When `dataClass` is not a known class, such as from a
 *   plugin compiled against a newer version of this package, or when the
 *   schema is no leaf.
 * @throws {Error} When the schema already carries a different class: one
 *   schema cannot hold two kinds of data. Use two schemas instead. Also
 *   when it carries a kind of object and the class is not `none`: the ID
 *   of a person or a group has its class instead of a kind.
 * @example
 * ```ts
 * const person = z.object({
 *   id: classify(z.number().int(), 'personId'),
 *   email: classify(z.string().max(200), 'email'),
 * });
 * ```
 */
export function classify<T extends z.core.$ZodType>(
  schema: T,
  dataClass: DataClass,
): T {
  if (!isDataClass(dataClass)) {
    throw new TypeError('Unknown data class.');
  }
  // dataClassOf first: it refuses a class that differs from one already on
  // the way, and it stops at a chain that loops.
  const present = dataClassOf(schema);
  leafOf(schema);
  if (present !== undefined && present !== dataClass) {
    throw new Error(
      `The schema is already classified as ${present}, not ${dataClass}.`,
    );
  }
  if (dataClass !== 'none' && objectKindOf(schema) !== undefined) {
    throw new Error(
      `The schema names a kind of object, so its class can only be none, not ${dataClass}.`,
    );
  }
  addMark(schema, dataClassKey, dataClass);
  return schema;
}

/**
 * Reads the kind of object of a schema, as {@link dataClassOf} reads its
 * class: through copies and wrappers, and all kinds on the way must agree.
 *
 * @param schema - A zod schema, usually a leaf of an input schema.
 * @returns The kind, or `undefined` when neither the schema nor a schema it
 *   wraps or was copied from names one.
 * @throws {TypeError} When the registry holds a value that is no known
 *   kind, or an entry it cannot read.
 * @throws {Error} When two schemas on the way name different kinds, or
 *   when the way is longer than 1000 steps.
 * @example
 * ```ts
 * objectKindOf(refersTo(z.number().int(), 'event').optional()); // 'event'
 * ```
 */
export function objectKindOf(schema: z.core.$ZodType): ObjectKind | undefined {
  return markOf(schema, kindMark);
}

/**
 * Marks a leaf of an input schema as the ID of an object of a kind, so that
 * the audit records the value as the object the call asks for (ADR 0028).
 * The core reads the mark from the input schema, never from the code of
 * the tool, so a tool cannot leave an ID out of the audit. In an output
 * schema the mark counts for nothing: there only the IDs of persons and
 * groups are recorded, by their classes.
 *
 * Like {@link classify}, it marks only a leaf, also inside wrappers, and
 * copies made by checks keep the mark. A leaf with a kind needs no class
 * besides it; if it has one, the class is `none`.
 *
 * @param schema - The leaf that holds the ID, usually a whole number or a
 *   GUID.
 * @param kind - The kind of object the ID names.
 * @returns The same schema, now marked.
 * @throws {TypeError} When `kind` is no known kind, such as `person` or
 *   `group`, whose IDs carry the classes `personId` and `groupId` instead,
 *   or when the schema is no leaf.
 * @throws {Error} When the schema already names another kind, or carries a
 *   class other than `none`.
 * @example
 * ```ts
 * const input = z.strictObject({
 *   eventId: refersTo(z.number().int().positive(), 'event'),
 *   personId: classify(z.number().int().positive(), 'personId'),
 * });
 * ```
 */
export function refersTo<T extends z.core.$ZodType>(
  schema: T,
  kind: ObjectKind,
): T {
  if (!isObjectKind(kind)) {
    throw new TypeError(
      'Unknown kind of object. IDs of persons and groups carry the classes personId and groupId instead.',
    );
  }
  const present = objectKindOf(schema);
  leafOf(schema);
  if (present !== undefined && present !== kind) {
    throw new Error(`The schema already names ${present}, not ${kind}.`);
  }
  const dataClass = dataClassOf(schema);
  if (dataClass !== undefined && dataClass !== 'none') {
    throw new Error(
      `The schema is classified as ${dataClass}, so it cannot name a kind of object.`,
    );
  }
  addMark(schema, objectKindKey, kind);
  return schema;
}
