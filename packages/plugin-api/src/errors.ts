/**
 * Stable codes for every error the core reports, and the error a tool or
 * plugin throws to report one (ADR 0054).
 *
 * @packageDocumentation
 */

import type { RightRef } from './tool.js';

/**
 * The category of an error. The core translates every failure into one of
 * these, so the model, the audit and an operator see the same small set,
 * never a message of ChurchTools. A tool error reaches the model as a result
 * with a code and a short message in English.
 *
 * The codes are a contract: renaming or removing one breaks plugins and
 * every reader of the audit.
 */
export type ErrorCode =
  | 'config'
  | 'auth'
  | 'permission'
  | 'not_found'
  | 'validation'
  | 'conflict'
  | 'rate_limited'
  | 'upstream'
  | 'network'
  | 'policy_denied'
  | 'confirmation_required'
  | 'license_required'
  | 'internal';

/** Every {@link ErrorCode}, frozen, for checks at run time. */
export const errorCodes: readonly ErrorCode[] = Object.freeze([
  'config',
  'auth',
  'permission',
  'not_found',
  'validation',
  'conflict',
  'rate_limited',
  'upstream',
  'network',
  'policy_denied',
  'confirmation_required',
  'license_required',
  'internal',
]);

// Brand of an EccliumError. Symbol.for, so that every copy of this package
// sets and reads the same key: the core recognises an error from a plugin
// that brought its own copy, where instanceof would fail. The brand selects
// an error, it does not prove where it came from; the core checks every
// field again (ADR 0054).
const errorBrand = Symbol.for('ecclium.mcp-churchtools.error.v1');

const maxMissingRights = 32;
const maxRightLength = 100;

const isErrorCode = (value: unknown): value is ErrorCode =>
  (errorCodes as readonly unknown[]).includes(value);

// A module or right name: printable ASCII, 1 to 100 characters, no space at
// either end. Right names of ChurchTools are not all lowercase words.
const isRightField = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  if (value.length < 1 || value.length > maxRightLength) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return (
    value.charCodeAt(0) !== 0x20 && value.charCodeAt(value.length - 1) !== 0x20
  );
};

// An own data property, never inherited and never through a getter.
const ownData = (target: object, key: PropertyKey): unknown => {
  const property = Object.getOwnPropertyDescriptor(target, key);
  return property !== undefined && 'value' in property
    ? property.value
    : undefined;
};

// A frozen copy of the missing rights, or undefined. Reads the length before
// any entry, entries by index and only their own data properties, so that no
// getter, iterator or huge sparse array of the caller runs or is walked. One
// bad entry drops the whole list rather than leave a misleading part of it.
const copyRights = (options: unknown): readonly RightRef[] | undefined => {
  try {
    if (typeof options !== 'object' || options === null) return undefined;
    const list = ownData(options, 'missingRights');
    if (!Array.isArray(list)) return undefined;
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
      if (typeof entry !== 'object' || entry === null) return undefined;
      const module = ownData(entry, 'module');
      const right = ownData(entry, 'right');
      if (!isRightField(module) || !isRightField(right)) return undefined;
      copy.push(Object.freeze({ module, right }));
    }
    return Object.freeze(copy);
  } catch {
    return undefined;
  }
};

const locked = (value: unknown, enumerable: boolean): PropertyDescriptor => ({
  value,
  enumerable,
  writable: false,
  configurable: false,
});

/** Options of an {@link EccliumError}. There is no cause: a cause carries foreign text. */
export interface EccliumErrorOptions {
  /** Rights the account of the server lacks, kept for the code `permission` only. */
  readonly missingRights?: readonly RightRef[];
}

/**
 * The error a tool or plugin throws to report one of the stable codes. The
 * core turns it into a result for the model with the code and the message,
 * and writes only the code to log and audit. Any other thrown value becomes
 * `internal` with a fixed sentence.
 *
 * Code, message and the brand are own properties that cannot be changed,
 * and so are the missing rights, which only an error with the code
 * `permission` and a valid list has. An unknown code becomes `internal` with
 * an empty message. There is never a cause. A subclass may set its own
 * `name`, but a field named `code` or `message` makes its constructor throw.
 * Rights a subclass adds itself are not locked; the core checks them like
 * every other field. Recognise the error with {@link isEccliumError}, never with
 * `instanceof`, which fails when a plugin brings its own copy of this
 * package.
 *
 * @example
 * ```ts
 * throw new EccliumError('not_found', 'No group has this ID. Search for the group by name first.');
 * ```
 */
export class EccliumError extends Error {
  /** The category of the error. */
  declare readonly code: ErrorCode;
  /** Rights the account of the server lacks, for the code `permission` only. */
  declare readonly missingRights?: readonly RightRef[];

  /**
   * Creates the error. It never throws, also not for callers without types.
   *
   * @param code - The category.
   * @param message - One line in English for the model that says what it can
   *   do next. The core replaces a message that breaks its rules with a fixed
   *   sentence for the code.
   * @param options - The missing rights, for the code `permission`.
   */
  constructor(
    code: ErrorCode,
    message?: string,
    options?: EccliumErrorOptions,
  ) {
    // Error gets neither the message nor the options, so it sets no cause.
    super();
    const known = isErrorCode(code);
    const rights =
      known && code === 'permission' ? copyRights(options) : undefined;
    Object.defineProperty(this, 'name', {
      value: 'EccliumError',
      enumerable: false,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(
      this,
      'message',
      locked(known && typeof message === 'string' ? message : '', false),
    );
    Object.defineProperty(
      this,
      'code',
      locked(known ? code : 'internal', true),
    );
    if (rights !== undefined) {
      Object.defineProperty(this, 'missingRights', locked(rights, true));
    }
    Object.defineProperty(this, errorBrand, locked(true, false));
  }
}

/**
 * Tells whether a value is an {@link EccliumError}, also one made by another
 * copy of this package. It checks the brand, a known code and a message, all
 * as own properties that a getter cannot fake, and never throws. The traps of
 * a proxy do run; the core decides with its own checks, which refuse proxies
 * first.
 *
 * @param value - Any thrown value.
 * @returns Whether the value carries the brand of an EccliumError.
 * @example
 * ```ts
 * if (isEccliumError(thrown)) report(thrown.code);
 * ```
 */
export function isEccliumError(value: unknown): value is EccliumError {
  try {
    if (typeof value !== 'object' || value === null) return false;
    const brand = Object.getOwnPropertyDescriptor(value, errorBrand);
    if (
      brand === undefined ||
      !('value' in brand) ||
      brand.value !== true ||
      brand.writable !== false ||
      brand.configurable !== false
    ) {
      return false;
    }
    return (
      isErrorCode(ownData(value, 'code')) &&
      typeof ownData(value, 'message') === 'string'
    );
  } catch {
    return false;
  }
}
