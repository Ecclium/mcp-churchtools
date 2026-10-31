/**
 * The IDs of objects in an audit line (ADR 0028). Each entry is
 * `<domain>:<ID>`, the ID as digits or as a GUID in lower case, never a
 * name. The pipeline derives them from the schemas of a tool and from the
 * checked request of the escape hatch, never from the code of a tool.
 *
 * @packageDocumentation
 */
import type { ObjectKind } from '@ecclium/mcp-churchtools-plugin-api';

import { auditLimits, objectDomains } from './schema.js';

/**
 * The kind of object an entry of `objectRefs` names: a person, a group or
 * one of the kinds of object of the plugin API.
 */
export type ObjectDomain = 'person' | 'group' | ObjectKind;

/** The IDs of one audit line and how many did not fit. */
export interface ObjectRefList {
  /** At most 100 entries, each once, in the order they were found. */
  readonly refs: readonly string[];
  /**
   * How many other entries were found beyond the first 100, at most as
   * many as the audit takes.
   */
  readonly omitted: number;
}

/** Gathers the IDs of one call, each once, in the order they come. */
export interface ObjectRefCollector {
  /**
   * Adds the ID of an object, if it has the form of one.
   *
   * @param domain - The kind of object.
   * @param value - The ID as a whole number or as text.
   * @returns Whether the value has the form of an ID, also when it was
   *   there already or beyond the first 100.
   */
  add(domain: ObjectDomain, value: unknown): boolean;
  /**
   * Returns what was gathered.
   *
   * @returns The first 100 entries and the count of the others.
   */
  list(): ObjectRefList;
}

// An ID as ChurchTools writes it: digits, or a GUID in any case. No other
// text becomes an entry, so the part after the colon never holds a name.
const digits = /^[0-9]{1,16}$/;
const guid =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

// The most entries a collector keeps track of, so that no list of values
// makes it grow without end. Far above what a result of 64 KiB can hold.
const maxTracked = 100_000;

/**
 * Makes the entry for the ID of an object.
 *
 * @param domain - The kind of object, one of the closed list.
 * @param value - The ID: a whole number from 0 up to the largest safe
 *   integer, or text of 1 to 16 digits or a GUID.
 * @returns The entry such as `person:12`, a GUID in lower case, or
 *   `undefined` when the domain or the value has another form.
 * @example
 * ```ts
 * objectRefOf('person', 12); // 'person:12'
 * objectRefOf('wiki_page', 'A1B2C3D4-0000-4000-8000-000000000001');
 * // 'wiki_page:a1b2c3d4-0000-4000-8000-000000000001'
 * objectRefOf('person', 'Max'); // undefined
 * ```
 */
export function objectRefOf(
  domain: ObjectDomain,
  value: unknown,
): string | undefined {
  if (!objectDomains.includes(domain)) return undefined;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0
      ? `${domain}:${String(value)}`
      : undefined;
  }
  // The length first, so that a long text never reaches a pattern.
  if (typeof value !== 'string' || value.length > 36) return undefined;
  if (digits.test(value)) return `${domain}:${value}`;
  if (guid.test(value)) return `${domain}:${value.toLowerCase()}`;
  return undefined;
}

/**
 * Makes the entry for an ID of an object as a person types it, such as
 * the value of `ecclium audit show --object`: a kind of the closed list,
 * a colon and the ID as digits or as a GUID in any case. Leading zeros of
 * digits go, as the audit writes a number without them.
 *
 * @param text - The text, such as `person:12`.
 * @returns The entry as the audit writes it, a GUID in lower case, or
 *   `undefined` for any other text.
 * @example
 * ```ts
 * objectRefFromText('group:7'); // 'group:7'
 * objectRefFromText('person:Max'); // undefined
 * ```
 */
export function objectRefFromText(text: string): string | undefined {
  // The length first: a kind has at most 13 characters and an ID 36.
  if (typeof text !== 'string' || text.length > 50) return undefined;
  const colon = text.indexOf(':');
  if (colon < 1) return undefined;
  const domain = text.slice(0, colon);
  // The audit writes a number without leading zeros, so 0042 is 42: a
  // search for 0042 must not miss the lines that name 42.
  const raw = text.slice(colon + 1);
  const id = digits.test(raw) ? raw.replace(/^0+(?=[0-9])/, '') : raw;
  return objectDomains.includes(domain)
    ? objectRefOf(domain as ObjectDomain, id)
    : undefined;
}

/**
 * Makes a collector for the IDs of one call. It keeps the first 100
 * distinct entries and counts the distinct ones after them, so that a line
 * shows when IDs are missing (ADR 0028).
 *
 * @returns The collector.
 * @example
 * ```ts
 * const refs = createObjectRefCollector();
 * refs.add('group', 7);
 * refs.add('person', 12);
 * refs.list(); // { refs: ['group:7', 'person:12'], omitted: 0 }
 * ```
 */
export function createObjectRefCollector(): ObjectRefCollector {
  const seen = new Set<string>();
  const refs: string[] = [];
  let omitted = 0;
  return Object.freeze({
    add(domain: ObjectDomain, value: unknown): boolean {
      const ref = objectRefOf(domain, value);
      if (ref === undefined) return false;
      if (seen.has(ref)) return true;
      if (seen.size < maxTracked) seen.add(ref);
      if (refs.length < auditLimits.objectRefs) refs.push(ref);
      else omitted += 1;
      return true;
    },
    list: (): ObjectRefList =>
      Object.freeze({
        refs: Object.freeze([...refs]),
        omitted: Math.min(omitted, auditLimits.objectRefsOmitted),
      }),
  });
}
