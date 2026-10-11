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
  /**
   * Whether a text that is not empty also shows the features of a date
   * or a date with time. Off by default, so the outputs of the probes
   * that do not ask for it stay the same.
   */
  readonly textFormats?: boolean;
  /**
   * How many fields of one object are described by name or position, by
   * default 50. The rest appear only as a count class.
   */
  readonly maxFields?: number;
}

/** Words the features of a text may contain. */
export const textFormatWords = [
  'format',
  'Datum',
  'Datum mit Zeit',
  'anderer Text',
  'trenner',
  'T',
  'Leerzeichen',
  'sekunden',
  'ja',
  'nein',
  'bruchteile',
  'keine',
  '1-3 Stellen',
  'mehr',
  'zone',
  'Z',
  'Versatz',
] as const;

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const dateTimePattern =
  /^\d{4}-\d{2}-\d{2}([T ])\d{2}:\d{2}(:\d{2})?(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Describes the features of a text that is not empty, never the text.
 *
 * Both patterns match the whole text. A date is `JJJJ-MM-TT`. A date with
 * time also tells the separator, whether there are seconds, how many
 * digits of a fraction, and whether a zone follows as `Z` or as an offset.
 * Every other text is «anderer Text».
 *
 * @param text - A text from a response.
 * @returns The features as fixed words.
 */
export function textFeatures(text: string): Readonly<Record<string, string>> {
  if (datePattern.test(text)) {
    return { format: 'Datum' };
  }
  const match = dateTimePattern.exec(text);
  if (match === null) {
    return { format: 'anderer Text' };
  }
  const [, separator, seconds, fraction, zone] = match;
  return {
    format: 'Datum mit Zeit',
    trenner: separator === 'T' ? 'T' : 'Leerzeichen',
    sekunden: seconds === undefined ? 'nein' : 'ja',
    bruchteile:
      fraction === undefined
        ? 'keine'
        : fraction.length <= 3
          ? '1-3 Stellen'
          : 'mehr',
    zone: zone === undefined ? 'keine' : zone === 'Z' ? 'Z' : 'Versatz',
  };
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
const defaultMaxFields = 50;
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
  if (options.textFormats === true) {
    options.guard.allowFixed(...textFormatWords);
  }
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
    if (value === '') {
      return { typ: 'Text', inhalt: 'leer' };
    }
    return options.textFormats === true
      ? { typ: 'Text', inhalt: 'nicht leer', ...textFeatures(value) }
      : { typ: 'Text', inhalt: 'nicht leer' };
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
  const maxFields = options.maxFields ?? defaultMaxFields;
  for (const [key, item] of entries.slice(0, maxFields)) {
    const named =
      options.keys === 'specification'
        ? declared.has(key) && identifierKey.test(key)
        : key.length <= 64 && lowercaseWordsKey.test(key);
    let label: string;
    if (named) {
      label = key;
      if (options.keys === 'specification') {
        options.guard.allowDeclared(key);
      } else {
        options.guard.allowChecked(key);
      }
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
