/**
 * Features of answers that the probe for persons reports without values.
 *
 * - Which of the error keys known from earlier runs an answer carries
 *   (docs/research/churchtools-api.md), and how many others, as a class.
 * - Whether an answer repeats a text the probe sent, and under which of the
 *   known error keys. The text itself never appears.
 * - What a hint `@deprecated` of an object replaces. Names appear only if
 *   the schema of the object declares both the old field and its
 *   replacement, so no value from the answer can reach the output.
 *
 * @packageDocumentation
 */
import type { Guard, Json } from './guard.mts';
import { isObject, type Schemas } from './spec.mts';
import { countClass, countClasses } from './structure.mts';

/** The error keys seen in earlier runs, by name. */
export const knownErrorKeys = [
  'message',
  'translatedMessage',
  'messageKey',
  'args',
  'errors',
] as const;

/** Words a description of these features may contain. */
export const flagWords = [
  ...knownErrorKeys,
  ...countClasses,
  'ja',
  'nein',
  'weitereSchluessel',
  'kein Objekt',
  'echo',
  'unter',
  'anderer Schlüssel',
  'veraltet',
  'vorhanden',
  'fehlt',
  'ersetzt',
  'ersatz',
  'anderer Wert',
  'andere',
] as const;

const identifierKey = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

const isKnownErrorKey = (key: string): boolean =>
  (knownErrorKeys as readonly string[]).includes(key);

/**
 * Tells which known error keys an answer carries.
 *
 * @param body - Parsed body of an answer.
 * @param guard - The guard of the run.
 * @returns «ja» or «nein» per known key and the class of the other keys, or «kein Objekt».
 */
export function describeErrorKeys(body: unknown, guard: Guard): Json {
  guard.allowFixed(...flagWords);
  if (!isObject(body)) {
    return 'kein Objekt';
  }
  const keys = Object.keys(body);
  return {
    ...Object.fromEntries(
      knownErrorKeys.map((key) => [key, keys.includes(key) ? 'ja' : 'nein']),
    ),
    weitereSchluessel: countClass(
      keys.filter((key) => !isKnownErrorKey(key)).length,
    ),
  };
}

/**
 * Tells whether an answer repeats a text the probe sent.
 *
 * Every text in the answer is searched, ignoring case. The place is named
 * by the top-level key under which the text was found, if that is a known
 * error key, and otherwise as «anderer Schlüssel».
 *
 * @param body - Parsed body of an answer.
 * @param text - The text the probe sent, such as a search term.
 * @param guard - The guard of the run.
 * @returns «ja» or «nein», and where it was found.
 */
export function describeEcho(body: unknown, text: string, guard: Guard): Json {
  guard.allowFixed(...flagWords);
  const needle = text.toLowerCase();
  const places = new Set<string>();
  const visit = (value: unknown, top: string | undefined): void => {
    if (typeof value === 'string') {
      if (needle !== '' && value.toLowerCase().includes(needle)) {
        places.add(
          top !== undefined && isKnownErrorKey(top) ? top : 'anderer Schlüssel',
        );
      }
    } else if (Array.isArray(value)) {
      for (const item of value as readonly unknown[]) {
        visit(item, top);
      }
    } else if (isObject(value)) {
      for (const [key, item] of Object.entries(value)) {
        visit(item, top ?? key);
      }
    }
  };
  visit(body, undefined);
  return { echo: places.size > 0 ? 'ja' : 'nein', unter: [...places].sort() };
}

/**
 * Describes the hint `@deprecated` of one object.
 *
 * ChurchTools writes it as an object from an old field to its replacement,
 * such as `{"identifier": "guid"}`. A pair appears by name only if the
 * schema of the object declares both fields and both have the form of an
 * identifier. Every other pair counts under «andere».
 *
 * @param object - One object of an answer.
 * @param schema - The schema the specification declares for it.
 * @param schemas - The schemas of the instance.
 * @param guard - The guard of the run.
 * @returns Whether the hint is there and what it replaces.
 */
export function describeDeprecation(
  object: unknown,
  schema: unknown,
  schemas: Schemas,
  guard: Guard,
): Json {
  guard.allowFixed(...flagWords);
  if (!isObject(object)) {
    return 'kein Objekt';
  }
  const hint = object['@deprecated'];
  if (hint === undefined) {
    return { veraltet: 'fehlt' };
  }
  if (!isObject(hint)) {
    return { veraltet: 'vorhanden', ersetzt: 'anderer Wert' };
  }
  const declared = schemas.properties(schema);
  const named = (key: string): boolean =>
    declared.has(key) && identifierKey.test(key);
  const pairs: Json[] = [];
  let others = 0;
  for (const [old, replacement] of Object.entries(hint)) {
    if (typeof replacement === 'string' && named(old) && named(replacement)) {
      guard.allowDeclared(old);
      guard.allowDeclared(replacement);
      pairs.push({ veraltet: old, ersatz: replacement });
    } else {
      others += 1;
    }
  }
  return { veraltet: 'vorhanden', ersetzt: pairs, andere: countClass(others) };
}
