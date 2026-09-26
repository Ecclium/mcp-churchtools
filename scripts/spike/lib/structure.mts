/**
 * Turns a response into a description of its structure, without values.
 *
 * Texts become «leer» or «nicht leer», numbers only a type, and counts one
 * of a few classes. A key appears under its name only if the policy allows
 * it, by default only if the specification of the instance declares it.
 * Every other key becomes `<key#n>`, numbered within its object, because
 * keys can carry data too, such as a group ID or a name.
 *
 * @packageDocumentation
 */
import type { Guard, Json } from './guard.mts';
import type { Schemas } from './spec.mts';

/** Classes for counts, so that exact numbers do not reach the output. */
export const countClasses = [
  '0',
  '1',
  '2–9',
  '10–99',
  '100–999',
  'ab 1000',
] as const;

/**
 * Puts a count into its class.
 *
 * @param count - A count, such as the number of entries in a list.
 * @returns The class of the count.
 */
export function countClass(count: number): (typeof countClasses)[number] {
  if (count <= 0) return '0';
  if (count === 1) return '1';
  if (count < 10) return '2–9';
  if (count < 100) return '10–99';
  if (count < 1000) return '100–999';
  return 'ab 1000';
}

/**
 * Which keys may appear under their own name.
 *
 * - `specification`: keys the specification declares at this position.
 * - `lowercaseWords`: keys made of lower-case words, such as module and
 *   right names in the permissions, which the specification does not list.
 */
export type KeyPolicy = 'specification' | 'lowercaseWords';

/** Settings for {@link describe}. */
export interface DescribeOptions {
  /** Receives every word the description uses. */
  readonly guard: Guard;
  /** Schemas of the instance, if a specification is at hand. */
  readonly schemas: Schemas | undefined;
  /** Which keys may appear under their own name. */
  readonly keys: KeyPolicy;
  /** Whether true and false are shown, as for rights of the service account. */
  readonly booleanValues?: boolean;
}

/** Words that every description may contain. */
export const structureWords = [
  ...countClasses,
  'typ',
  'null',
  'Wahrheitswert',
  'wert',
  'wahr',
  'falsch',
  'Zahl',
  'Text',
  'inhalt',
  'leer',
  'nicht leer',
  'Liste',
  'anzahl',
  'formen',
  'weitereFormen',
  'Objekt',
  'felder',
  'weitereFelder',
  'zu tief',
] as const;

const maxDepth = 10;
const maxFields = 50;
const maxSampled = 50;
const maxShapes = 3;
const identifierKey = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const lowercaseWordsKey = /^[a-z]+(?: [a-z]+)*$/;

/**
 * Describes the structure of a value.
 *
 * @param value - Parsed JSON from a response.
 * @param schema - Schema the specification declares for this value, if any.
 * @param options - Guard, schemas and key policy.
 * @returns A description that contains no value from the response.
 * @example
 * ```ts
 * describe({ firstName: 'Max' }, personSchema, { guard, schemas, keys: 'specification' });
 * // { typ: 'Objekt', felder: { firstName: { typ: 'Text', inhalt: 'nicht leer' } } }
 * ```
 */
export function describe(
  value: unknown,
  schema: unknown,
  options: DescribeOptions,
): Json {
  options.guard.allowFixed(...structureWords);
  return describeAt(value, schema, options, 0);
}

function describeAt(
  value: unknown,
  schema: unknown,
  options: DescribeOptions,
  depth: number,
): Json {
  if (depth > maxDepth) {
    return { typ: 'zu tief' };
  }
  if (value === null || value === undefined) {
    return { typ: 'null' };
  }
  if (typeof value === 'boolean') {
    return options.booleanValues === true
      ? { typ: 'Wahrheitswert', wert: value ? 'wahr' : 'falsch' }
      : { typ: 'Wahrheitswert' };
  }
  if (typeof value === 'number') {
    return { typ: 'Zahl' };
  }
  if (typeof value === 'string') {
    return { typ: 'Text', inhalt: value === '' ? 'leer' : 'nicht leer' };
  }
  if (Array.isArray(value)) {
    return describeList(value, schema, options, depth);
  }
  if (typeof value === 'object') {
    return describeObject(
      value as Record<string, unknown>,
      schema,
      options,
      depth,
    );
  }
  return { typ: 'null' };
}

function describeList(
  list: readonly unknown[],
  schema: unknown,
  options: DescribeOptions,
  depth: number,
): Json {
  const itemSchema = options.schemas?.items(schema);
  const shapes = new Map<string, Json>();
  for (const item of list.slice(0, maxSampled)) {
    const shape = describeAt(item, itemSchema, options, depth + 1);
    shapes.set(JSON.stringify(shape), shape);
  }
  const distinct = [...shapes.values()];
  const result: Record<string, Json> = {
    typ: 'Liste',
    anzahl: countClass(list.length),
    formen: distinct.slice(0, maxShapes),
  };
  if (distinct.length > maxShapes) {
    result['weitereFormen'] = countClass(distinct.length - maxShapes);
  }
  return result;
}

function describeObject(
  object: Record<string, unknown>,
  schema: unknown,
  options: DescribeOptions,
  depth: number,
): Json {
  const declared =
    options.schemas?.properties(schema) ?? new Map<string, unknown>();
  const valueSchema = options.schemas?.additionalProperties(schema);
  const fields: Record<string, Json> = {};
  let unnamed = 0;
  const entries = Object.entries(object);
  for (const [key, item] of entries.slice(0, maxFields)) {
    const named =
      options.keys === 'specification'
        ? declared.has(key) && identifierKey.test(key)
        : key.length <= 64 && lowercaseWordsKey.test(key);
    let label: string;
    if (named) {
      label = key;
      options.guard.allowChecked(key);
    } else {
      unnamed += 1;
      label = `<key#${String(unnamed)}>`;
      options.guard.allowFixed(label);
    }
    const childSchema = named ? declared.get(key) : valueSchema;
    fields[label] = describeAt(item, childSchema, options, depth + 1);
  }
  const result: Record<string, Json> = { typ: 'Objekt', felder: fields };
  if (entries.length > maxFields) {
    result['weitereFelder'] = countClass(entries.length - maxFields);
  }
  return result;
}
