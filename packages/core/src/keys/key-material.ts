/**
 * The secret behind the pseudonyms of the level `strict` (ADR 0069), which
 * prints as `[REDACTED]` wherever it goes and is turned back into its bytes
 * only by the modules of the keys. `Secret` holds the login token instead:
 * its value leaves only on the outbound path (ADR 0054), and a key must
 * never reach that path.
 *
 * @packageDocumentation
 */
import { timingSafeEqual } from 'node:crypto';

// Key of the static method that reads the bytes. A plain Symbol(), never
// Symbol.for, so that no other module can make the same key. The method is
// taken off the class right after the class is defined, so neither the
// class nor an instance, through its constructor, leads to it.
const reveal: unique symbol = Symbol('reveal');

// The key util.inspect looks for. Symbol.for gives the same symbol as
// util.inspect.custom without importing node:util.
const inspectCustom: unique symbol = Symbol.for('nodejs.util.inspect.custom');

const redacted = '[REDACTED]';

/** The bytes of the secret: 256 bits, as `openssl rand -hex 32` writes. */
export const keyMaterialLength = 32;

// One hex digit in lower case, or -1. Read sign by sign instead of with a
// regular expression, whose legacy statics such as RegExp.$_ would keep the
// whole key for every module in the process.
const hexValue = (code: number): number => {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  return -1;
};

const invalid = (): RangeError =>
  new RangeError(
    'A key is 64 hex digits in lower case, and not all of its bytes are the same.',
  );

/**
 * The secret for pseudonyms: 32 bytes in a private field. No property, no
 * copy and no clone of the holder carries them, and every way of printing
 * it gives `[REDACTED]`. Only {@link revealKeyMaterial} reads them, and only
 * the modules in `packages/core/src/keys/` may import that function. The
 * hex it is made from is a string, which JavaScript cannot erase; it stays
 * in memory until it is collected, as the token does (ADR 0069).
 *
 * It is made from 64 hex digits in lower case. A key whose bytes are all
 * the same, such as one written from `/dev/zero`, is refused, because no
 * random key looks like that. The class cannot be subclassed, and
 * instance, prototype and class are frozen.
 *
 * @example
 * ```ts
 * const key = new KeyMaterial(valueFromTheKeyFile);
 * String(key); // '[REDACTED]'
 * ```
 */
export class KeyMaterial {
  readonly #bytes: Uint8Array;

  /**
   * Reads a key from hex.
   *
   * @param hex - 64 hex digits in lower case.
   * @throws {TypeError} When the value is not a string or the class is
   *   subclassed.
   * @throws {RangeError} When the value has another length, another sign or
   *   only one byte value. The message never shows the value.
   */
  constructor(hex: string) {
    if (new.target !== KeyMaterial) {
      throw new TypeError('A key cannot be subclassed.');
    }
    if (typeof hex !== 'string') {
      throw new TypeError('A key must be a string of hex digits.');
    }
    if (hex.length !== 2 * keyMaterialLength) throw invalid();
    const bytes = new Uint8Array(keyMaterialLength);
    let same = true;
    for (let index = 0; index < keyMaterialLength; index += 1) {
      const high = hexValue(hex.charCodeAt(2 * index));
      const low = hexValue(hex.charCodeAt(2 * index + 1));
      if (high < 0 || low < 0) {
        bytes.fill(0);
        throw invalid();
      }
      bytes[index] = high * 16 + low;
      if (bytes[index] !== bytes[0]) same = false;
    }
    if (same) {
      bytes.fill(0);
      throw invalid();
    }
    this.#bytes = bytes;
    Object.freeze(this);
  }

  /**
   * Reads the bytes of a key. Taken off the class below; use
   * {@link revealKeyMaterial}. An arrow function, so it needs no `this`.
   *
   * @param key - The key.
   * @returns A copy of its bytes.
   * @throws {TypeError} When the argument is not a key of this module.
   */
  static readonly [reveal] = (key: unknown): Uint8Array => {
    if (typeof key !== 'object' || key === null || !(#bytes in key)) {
      throw new TypeError('Not a key.');
    }
    return Uint8Array.from(key.#bytes);
  };

  /**
   * Tells whether another key holds the same bytes, in constant time, so
   * that the configuration can refuse the same key in both files without
   * reading either.
   *
   * @param other - Another key.
   * @returns Whether both hold the same bytes.
   * @throws {TypeError} When the argument is not a key of this module.
   */
  sameAs(other: KeyMaterial): boolean {
    // Checked at run time as well: a caller outside TypeScript may pass
    // anything.
    const value: unknown = other;
    if (typeof value !== 'object' || value === null || !(#bytes in value)) {
      throw new TypeError('Not a key.');
    }
    return timingSafeEqual(this.#bytes, value.#bytes);
  }

  /**
   * Gives the placeholder, never the bytes.
   *
   * @returns `[REDACTED]`.
   */
  toString(): string {
    return redacted;
  }

  /**
   * Gives the placeholder to JSON, never the bytes.
   *
   * @returns `[REDACTED]`.
   */
  toJSON(): string {
    return redacted;
  }

  /**
   * Gives the placeholder to util.inspect, never the bytes.
   *
   * @returns `[REDACTED]`.
   */
  [inspectCustom](): string {
    return redacted;
  }
}

const read = KeyMaterial[reveal];
Reflect.deleteProperty(KeyMaterial, reveal);
Object.freeze(KeyMaterial.prototype);
Object.freeze(KeyMaterial);

/**
 * Turns a key back into its bytes, to derive the keys of a day. Only the
 * modules in `packages/core/src/keys/` may use this function. In the
 * packages, the dependency-cruiser rule `keys-internals` refuses any other
 * importer; outside them, where the rule does not look, a test refuses the
 * name (ADR 0069). Both guard against mistakes, not against code that sets
 * out to read a key.
 *
 * @param key - The key.
 * @returns A fresh copy of its 32 bytes, which the caller erases after use.
 * @throws {TypeError} When the argument is not a key made by this module,
 *   such as a copy, a clone or a proxy.
 * @example
 * ```ts
 * const secret = revealKeyMaterial(key);
 * try { derive(secret); } finally { secret.fill(0); }
 * ```
 */
export function revealKeyMaterial(key: KeyMaterial): Uint8Array {
  return read(key);
}
