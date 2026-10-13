/**
 * Data classes of the fields of a schema, kept in the global registry of zod.
 *
 * @packageDocumentation
 */

import { z } from 'zod';

/**
 * What a field of a schema holds, as far as redaction and the data envelope
 * care. Every leaf of an output schema carries one.
 *
 * - `none`: no personal data.
 * - `personId`: an ID of a person.
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
  | 'name.first'
  | 'name.last'
  | 'email'
  | 'phone'
  | 'birthdate'
  | 'address'
  | 'amount'
  | 'untrusted';

/** Every {@link DataClass}, frozen, for checks at run time. */
export const dataClasses: readonly DataClass[] = Object.freeze([
  'none',
  'personId',
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

// The schema a wrapper wraps, or undefined for any other schema.
function innerOf(schema: z.core.$ZodType): z.core.$ZodType | undefined {
  const def = schema._zod.def as {
    readonly type: string;
    readonly innerType?: z.core.$ZodType;
  };
  return wrapperTypes.includes(def.type) ? def.innerType : undefined;
}

// The class in the own entry of exactly this schema. zod's get() would merge
// in the entry of the schema it was copied from, but returns nothing for a
// copy when the merged entry has only symbol keys, so it would hide the class
// of nearly every leaf. The own entry is read without its prototype and
// without running a getter, and whatever goes wrong while reading it ends in
// a fixed message, never in text from the entry.
function ownClass(schema: z.core.$ZodType): DataClass | undefined {
  let value: unknown;
  try {
    const own: unknown = z.globalRegistry._map.get(schema);
    if (own === undefined) return undefined;
    const property = Object.getOwnPropertyDescriptor(own, dataClassKey);
    if (property === undefined) return undefined;
    if (!('value' in property)) throw new TypeError('no plain value');
    value = property.value;
  } catch {
    throw new TypeError(unreadable);
  }
  if (!isDataClass(value)) {
    throw new TypeError(
      'The zod registry holds a data class this version of the plugin API does not know.',
    );
  }
  return value;
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
  let found: DataClass | undefined;
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
      const value = ownClass(current);
      if (value === undefined) continue;
      if (found !== undefined && found !== value) {
        throw new Error(
          `The schema carries different data classes: ${found} and ${value}.`,
        );
      }
      found = value;
    }
  }
  return found;
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
 *   schema cannot hold two kinds of data. Use two schemas instead.
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
  let leaf: z.core.$ZodType = schema;
  for (let inner = innerOf(leaf); inner !== undefined; inner = innerOf(leaf)) {
    leaf = inner;
  }
  if (!leafTypes.includes(leaf._zod.def.type)) {
    throw new TypeError(
      'Only a leaf such as a string, a number or an enum carries a data class, not a container or an open shape.',
    );
  }
  if (present !== undefined && present !== dataClass) {
    throw new Error(
      `The schema is already classified as ${present}, not ${dataClass}.`,
    );
  }
  // Only the own entry: merging in what the schema inherits would freeze the
  // metadata of its parent into it.
  z.globalRegistry.add(schema, {
    ...ownEntryCopy(schema),
    [dataClassKey]: dataClass,
  });
  return schema;
}
