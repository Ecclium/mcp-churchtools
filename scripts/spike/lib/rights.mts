/**
 * Describes the effective rights of the account, without any value.
 *
 * A right is effective if its value is neither `false` nor an empty list.
 * Its name appears only if a fixed table in this file holds it: the read
 * rights the guard for personal data allows and the two rights on the
 * wiki. These are words of the product, so they pass as fixed words and
 * no value from an answer can withhold them. The guard has already
 * refused every other right; one that turns up anyway ends the probe.
 *
 * A list appears as a count class and as classes of its entries, never
 * with an entry: a positive whole number, zero, a negative number, a
 * number that is not whole, a text, an object, or anything else. So two
 * runs show how a value such as «alle» differs from a list of IDs without
 * showing either.
 *
 * @packageDocumentation
 */
import { SpikeError } from './errors.mts';
import type { Guard, Json } from './guard.mts';
import { personReadRights } from './persons-gate.mts';
import { isObject, type JsonObject } from './spec.mts';
import { countClass, countClasses } from './structure.mts';

/** The rights whose names may appear, by module. */
export const describedRights: Readonly<Record<string, readonly string[]>> = {
  churchdb: personReadRights.churchdb,
  churchgroup: personReadRights.churchgroup,
  churchwiki: ['view', 'view category'],
};

/** The classes of the entries of a list of rights. */
export const entryClasses = [
  'Zahl positiv',
  'Zahl 0',
  'Zahl negativ',
  'Zahl nicht ganz',
  'Text',
  'Objekt',
  'anderes',
] as const;

/** Words a description of rights may contain. */
export const rightsWords = [
  ...countClasses,
  ...entryClasses,
  'typ',
  'Wahrheitswert',
  'wert',
  'wahr',
  'Liste',
  'anzahl',
  'elemente',
  'Zahl',
  'klasse',
  'positiv',
  '0',
  'negativ',
  'nicht ganz',
  'Text',
  'inhalt',
  'leer',
  'nicht leer',
  'Objekt',
  'felder',
  'null',
] as const;

function entryClass(value: unknown): (typeof entryClasses)[number] {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) return 'Zahl nicht ganz';
    if (value > 0) return 'Zahl positiv';
    if (value === 0) return 'Zahl 0';
    return 'Zahl negativ';
  }
  if (typeof value === 'string') return 'Text';
  if (isObject(value)) return 'Objekt';
  return 'anderes';
}

function describeValue(value: unknown): Json {
  if (value === true) {
    return { typ: 'Wahrheitswert', wert: 'wahr' };
  }
  if (Array.isArray(value)) {
    const counts = new Map<string, number>();
    for (const entry of value as readonly unknown[]) {
      const kind = entryClass(entry);
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    return {
      typ: 'Liste',
      anzahl: countClass(value.length),
      elemente: Object.fromEntries(
        entryClasses
          .filter((kind) => counts.has(kind))
          .map((kind) => [kind, countClass(counts.get(kind) ?? 0)]),
      ),
    };
  }
  if (typeof value === 'number') {
    const kind = entryClass(value);
    return {
      typ: 'Zahl',
      klasse:
        kind === 'Zahl positiv'
          ? 'positiv'
          : kind === 'Zahl 0'
            ? '0'
            : kind === 'Zahl negativ'
              ? 'negativ'
              : 'nicht ganz',
    };
  }
  if (typeof value === 'string') {
    return { typ: 'Text', inhalt: value === '' ? 'leer' : 'nicht leer' };
  }
  if (isObject(value)) {
    return { typ: 'Objekt', felder: countClass(Object.keys(value).length) };
  }
  return { typ: 'null' };
}

/**
 * Describes the effective rights, by module and name.
 *
 * @param data - `data` of `GET /api/permissions/global`, as the guard checked it.
 * @param guard - The guard of the run.
 * @returns For each module with an effective right, each such right and the class of its value.
 * @throws {SpikeError} If an effective right is not in {@link describedRights}.
 */
export function describeEffectiveRights(data: JsonObject, guard: Guard): Json {
  guard.allowFixed(...rightsWords);
  const result: Record<string, Json> = {};
  for (const [module, rights] of Object.entries(data)) {
    if (!isObject(rights)) {
      throw new SpikeError('INTERN');
    }
    const known = describedRights[module] ?? [];
    const effective: Record<string, Json> = {};
    for (const [name, value] of Object.entries(rights)) {
      if (value === false || (Array.isArray(value) && value.length === 0)) {
        continue;
      }
      if (!known.includes(name)) {
        throw new SpikeError('INTERN');
      }
      guard.allowFixed(name);
      effective[name] = describeValue(value);
    }
    if (Object.keys(effective).length > 0) {
      guard.allowFixed(module);
      result[module] = effective;
    }
  }
  return result;
}
