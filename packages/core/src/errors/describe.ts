/**
 * Turns any thrown value into a stable code and one short line for the model
 * (ADR 0054).
 *
 * @packageDocumentation
 */
import { isProxy } from 'node:util/types';

import type { ErrorCode, RightRef } from '@ecclium/mcp-churchtools-plugin-api';

/** What the core reports about a failure. */
export interface ErrorDescription {
  /** The category of the failure. */
  readonly code: ErrorCode;
  /**
   * One line of printable ASCII with 1 to {@link maxMessageLength}
   * characters, not blank. It goes to the model only, never to log or audit.
   */
  readonly message: string;
  /**
   * Rights the account of the server lacks, for the code `permission` only:
   * 1 to {@link maxMissingRights} entries.
   */
  readonly missingRights?: readonly RightRef[];
}

/** The longest message of a tool that reaches the model. */
export const maxMessageLength = 500;

/** The most missing rights that reach the model. */
export const maxMissingRights = 32;

const maxRightLength = 100;

// The key every copy of plugin-api sets on an EccliumError. Symbol.for, so
// that an error from a plugin that brought its own copy is recognised too.
const errorBrand = Symbol.for('ecclium.mcp-churchtools.error.v1');

/**
 * One sentence per code, used when a message breaks the rules or the code is
 * `internal`. Frozen and without prototype, so a key such as `toString` finds
 * nothing.
 */
export const fixedSentences: Readonly<Record<ErrorCode, string>> =
  Object.freeze({
    __proto__: null,
    config:
      'The server is not configured correctly. Ask the operator to check its configuration.',
    auth: 'The server could not sign in to ChurchTools. Ask the operator to check its access.',
    permission:
      'The account of the server lacks a right for this. Ask the operator to grant it.',
    not_found:
      'The requested object does not exist or is not visible to the server.',
    validation:
      'The input is not valid. Check the arguments against the schema of the tool.',
    conflict:
      'The object was changed in the meantime. Read it again before you retry.',
    rate_limited:
      'ChurchTools limits the number of requests. Wait a moment, then try again.',
    upstream: 'ChurchTools answered with an error. Try again later.',
    network: 'ChurchTools could not be reached. Try again later.',
    policy_denied: 'A policy of the operator does not allow this action.',
    confirmation_required:
      'This action needs the confirmation of the user first.',
    license_required: 'This function needs a license that is not active.',
    internal:
      'An internal error occurred. The operator finds its code in the log.',
  });

const internalDescription: ErrorDescription = Object.freeze({
  code: 'internal',
  message: fixedSentences.internal,
});

// Membership through the table without prototype, so that neither an
// inherited key nor a patched Array.prototype.includes lets a code through.
const isErrorCode = (value: unknown): value is ErrorCode =>
  typeof value === 'string' && Object.hasOwn(fixedSentences, value);

// An object whose properties can be read without running code of the thrown
// value. isProxy runs no trap, also not for a revoked proxy or
// one from another realm.
const isPlainTarget = (value: unknown): value is object =>
  typeof value === 'object' && value !== null && !isProxy(value);

// An own data property, never inherited and never through a getter. Each
// field is read once into a local, so a value cannot change between the
// check and its use.
const ownData = (target: object, key: PropertyKey): unknown => {
  const property = Object.getOwnPropertyDescriptor(target, key);
  return property !== undefined && Object.hasOwn(property, 'value')
    ? property.value
    : undefined;
};

// Character by character instead of a regular expression: its legacy
// statics such as RegExp.$_ would keep the whole text. The length is checked
// first, so a huge string costs nothing. Printable ASCII keeps out line
// breaks, terminal escapes and invisible or bidi characters.
const isPrintableAscii = (
  value: unknown,
  maxLength: number,
): value is string => {
  if (typeof value !== 'string') return false;
  if (value.length < 1 || value.length > maxLength) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
};

const isMessage = (value: unknown): value is string =>
  isPrintableAscii(value, maxMessageLength) && value.trim() !== '';

// A module or right name: no space at either end. Right names of ChurchTools
// are not all lowercase words, so the rule cannot be narrower.
const isRightField = (value: unknown): value is string =>
  isPrintableAscii(value, maxRightLength) &&
  value.charCodeAt(0) !== 0x20 &&
  value.charCodeAt(value.length - 1) !== 0x20;

// A frozen copy, or undefined. The length is checked before any entry, the
// entries are read by index, so no iterator runs and no huge sparse array is
// walked. One bad entry drops the whole list rather than leave a misleading
// part of it.
const copyRights = (list: unknown): readonly RightRef[] | undefined => {
  if (!isPlainTarget(list) || !Array.isArray(list)) return undefined;
  const length = ownData(list, 'length');
  if (
    typeof length !== 'number' ||
    !Number.isInteger(length) ||
    length < 1 ||
    length > maxMissingRights
  ) {
    return undefined;
  }
  const copy: RightRef[] = [];
  for (let index = 0; index < length; index += 1) {
    const entry = ownData(list, String(index));
    if (!isPlainTarget(entry)) return undefined;
    const module = ownData(entry, 'module');
    const right = ownData(entry, 'right');
    if (!isRightField(module) || !isRightField(right)) return undefined;
    copy.push(Object.freeze({ module, right }));
  }
  return Object.freeze(copy);
};

// The brand as plugin-api sets it: an own data property with the value true
// that can be neither changed nor removed. It selects the value; every field
// is still checked, because any code in the process can forge it.
const hasBrand = (value: object): boolean => {
  const brand = Object.getOwnPropertyDescriptor(value, errorBrand);
  return (
    brand !== undefined &&
    Object.hasOwn(brand, 'value') &&
    brand.value === true &&
    brand.writable === false &&
    brand.configurable === false
  );
};

/**
 * Describes a thrown value by its code. An EccliumError, also one of another
 * copy of plugin-api, keeps its code, its message if the message is one line
 * of printable ASCII with 1 to 500 characters and, for `permission`, its
 * missing rights. Any other value, a proxy and the code `internal` give
 * `internal` or the code with a fixed sentence. The message, stack, cause or
 * name of a foreign error never leave.
 *
 * It reads only own data properties, each once, so no getter, proxy trap,
 * iterator or coercion of the thrown value runs. It never throws; only when
 * the stack is exhausted can a RangeError escape, and the caller's last
 * catch must then answer `internal` without calling anything.
 *
 * @param thrown - Any thrown value.
 * @returns A frozen description.
 * @example
 * ```ts
 * describeError(new Error('connect ECONNREFUSED'));
 * // { code: 'internal', message: fixedSentences.internal }
 * ```
 */
export function describeError(thrown: unknown): ErrorDescription {
  try {
    if (!isPlainTarget(thrown) || !hasBrand(thrown)) {
      return internalDescription;
    }
    const code = ownData(thrown, 'code');
    if (!isErrorCode(code) || code === 'internal') return internalDescription;
    const message = ownData(thrown, 'message');
    const text = isMessage(message) ? message : fixedSentences[code];
    const rights =
      code === 'permission'
        ? copyRights(ownData(thrown, 'missingRights'))
        : undefined;
    return Object.freeze(
      rights === undefined
        ? { code, message: text }
        : { code, message: text, missingRights: rights },
    );
  } catch {
    return internalDescription;
  }
}
