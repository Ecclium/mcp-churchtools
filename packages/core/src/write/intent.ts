/**
 * Reads an intent as a tool handed it to `plan` (ADR 0029).
 *
 * Where it stands in the way of a write: this is the first step of
 * planning. A tool of a plugin is compiled apart from the core, so its
 * intent is any value until checked here: it may be a proxy, carry
 * getters, have fields the kind does not know, or change after the check.
 * The core therefore copies the own data properties of a plain object
 * once, checks each against the fields of its kind and goes on with the
 * frozen copy only. Everything after this step, from the rules of the
 * intent to the hash of the plan, reads the copy.
 *
 * The checks here are about form, not content: the client checks titles
 * and texts as ChurchTools takes them, and the content policy what a text
 * may say.
 *
 * @packageDocumentation
 */
import { isProxy } from 'node:util/types';

import {
  isWikiPageGuid,
  type WriteIntent,
  type WriteIntentKind,
  writeIntentKinds,
} from '@ecclium/mcp-churchtools-plugin-api';

/**
 * The longest text of a field of an intent in UTF-16 code units. It only
 * bounds what a plan can hold; the client checks the length in bytes that
 * ChurchTools takes, at most 64 KiB of UTF-8 for the text of a page.
 */
export const maxIntentTextLength = 65_536;

// The most values of the path of an operation, and their longest text.
const maxPathValues = 20;
const maxPathValueLength = 1_024;

/** What a field of an intent holds. */
type FieldKind =
  | 'id'
  | 'version'
  | 'guid'
  | 'text'
  | 'optionalText'
  | 'operationId'
  | 'optionalPath';

// The fields of each kind, in the order the copy keeps them.
const fieldsOf: Readonly<
  Record<WriteIntentKind, Readonly<Record<string, FieldKind>>>
> = Object.freeze({
  wikiPageCreate: { categoryId: 'id', title: 'text', text: 'text' },
  wikiPageUpdate: {
    categoryId: 'id',
    guid: 'guid',
    text: 'text',
    baseVersion: 'version',
  },
  wikiSectionAppend: {
    categoryId: 'id',
    guid: 'guid',
    section: 'text',
    baseVersion: 'version',
  },
  appointmentCreate: {
    calendarId: 'id',
    title: 'text',
    startDate: 'text',
    endDate: 'text',
    description: 'optionalText',
  },
  appointmentUpdate: {
    calendarId: 'id',
    appointmentId: 'id',
    baseVersion: 'version',
    title: 'text',
    startDate: 'text',
    endDate: 'text',
    description: 'optionalText',
  },
  bookingCreate: {
    resourceId: 'id',
    title: 'text',
    startDate: 'text',
    endDate: 'text',
    description: 'optionalText',
  },
  groupMemberAdd: { groupId: 'id', personId: 'id' },
  groupMemberRemove: { groupId: 'id', personId: 'id' },
  serviceRequest: { eventId: 'id', serviceId: 'id', personId: 'id' },
  apiOperation: {
    operationId: 'operationId',
    path: 'optionalPath',
    body: 'optionalText',
  },
});

const operationIdPattern = /^[A-Za-z0-9_-]{1,200}$/;
const pathNamePattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

// A plain object whose own properties can be read without running its
// code: made by a literal, JSON or Object.create(null), not an array, not
// an instance of a class. isProxy runs no trap, also not for a revoked
// proxy, so it comes first; for any other object getPrototypeOf runs no
// code either.
const isPlainObject = (value: unknown): value is object => {
  if (typeof value !== 'object' || value === null || isProxy(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

// The own data properties of an object, or undefined when one is an
// accessor or a symbol: such an object cannot be read without its code.
const ownData = (value: object): Map<string, unknown> | undefined => {
  if (Object.getOwnPropertySymbols(value).length > 0) return undefined;
  const copy = new Map<string, unknown>();
  for (const key of Object.getOwnPropertyNames(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (property === undefined || !Object.hasOwn(property, 'value')) {
      return undefined;
    }
    copy.set(key, property.value);
  }
  return copy;
};

const isText = (value: unknown, max: number): value is string =>
  typeof value === 'string' &&
  value.length <= max &&
  // A lone surrogate would turn into U+FFFD in UTF-8, so two different
  // texts could hash the same.
  value.isWellFormed();

const isWhole = (value: unknown, min: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min;

// The values of the path of an operation, copied, or undefined.
const readPath = (
  value: unknown,
): Readonly<Record<string, number | string>> | undefined => {
  if (!isPlainObject(value)) return undefined;
  const fields = ownData(value);
  if (fields === undefined || fields.size > maxPathValues) return undefined;
  const copy: Record<string, number | string> = {};
  for (const [name, entry] of fields) {
    if (!pathNamePattern.test(name)) return undefined;
    if (!isWhole(entry, 0) && !isText(entry, maxPathValueLength)) {
      return undefined;
    }
    copy[name] = entry;
  }
  return Object.freeze(copy);
};

// One field, checked and copied, or undefined when it does not fit. A
// missing optional field is the value `absent`.
const absent = Symbol('absent');
const readField = (kind: FieldKind, value: unknown): unknown => {
  switch (kind) {
    case 'id':
      return isWhole(value, 1) ? value : undefined;
    case 'version':
      return isWhole(value, 0) ? value : undefined;
    case 'guid':
      return isWikiPageGuid(value) ? value : undefined;
    case 'text':
      return isText(value, maxIntentTextLength) ? value : undefined;
    case 'optionalText':
      if (value === undefined) return absent;
      return isText(value, maxIntentTextLength) ? value : undefined;
    case 'operationId':
      return typeof value === 'string' && operationIdPattern.test(value)
        ? value
        : undefined;
    case 'optionalPath':
      return value === undefined ? absent : readPath(value);
  }
};

/**
 * Checks an intent and copies it. A value that is no plain object, a
 * proxy, one with an accessor or a symbol, an unknown kind, a missing or
 * unknown field and a field of the wrong form all give `undefined`. An
 * optional field that is `undefined` counts as missing.
 *
 * @param value - The intent as a tool handed it over.
 * @returns A frozen copy with the fields of its kind in a fixed order, or
 *   undefined.
 * @example
 * ```ts
 * readIntent({ kind: 'wikiPageCreate', categoryId: 12, title: 'Plan', text: '# Plan' });
 * // { kind: 'wikiPageCreate', categoryId: 12, title: 'Plan', text: '# Plan' }
 * readIntent({ kind: 'wikiPageDelete', guid: 'x' }); // undefined
 * ```
 */
export function readIntent(value: unknown): WriteIntent | undefined {
  if (!isPlainObject(value)) return undefined;
  const fields = ownData(value);
  if (fields === undefined) return undefined;
  const kind = fields.get('kind');
  if (!writeIntentKinds.includes(kind as WriteIntentKind)) return undefined;
  const expected = fieldsOf[kind as WriteIntentKind];
  for (const name of fields.keys()) {
    if (name !== 'kind' && !Object.hasOwn(expected, name)) return undefined;
  }
  const copy: Record<string, unknown> = { kind };
  for (const [name, fieldKind] of Object.entries(expected)) {
    const read = readField(fieldKind, fields.get(name));
    if (read === undefined) return undefined;
    if (read !== absent) copy[name] = read;
  }
  return Object.freeze(copy) as unknown as WriteIntent;
}
