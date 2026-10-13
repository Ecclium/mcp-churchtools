/**
 * A secret such as a login token, which prints as `[REDACTED]` wherever it
 * goes and is turned back into its value only on the outbound path
 * (ADR 0054).
 *
 * @packageDocumentation
 */

// Key of the static method that reads the value. A plain Symbol(), never
// Symbol.for, so that no other module can make the same key. The method is
// taken off the class right after the class is defined, so neither the class
// nor an instance, through its constructor, leads to it.
const reveal: unique symbol = Symbol('reveal');

// The key util.inspect looks for. Symbol.for gives the same symbol as
// util.inspect.custom without importing node:util.
const inspectCustom: unique symbol = Symbol.for('nodejs.util.inspect.custom');

const redacted = '[REDACTED]';
const maxLength = 4096;

// Checks character by character instead of with a regular expression: after
// a successful match, the legacy statics such as RegExp.$_ would hold the
// whole value for every module in the process.
const isVisibleAscii = (value: string): boolean => {
  if (value.length < 1 || value.length > maxLength) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
};

/**
 * A secret value, such as a login token for ChurchTools. Its value lives in
 * a private field: no property, no copy and no clone carries it, and every
 * way of printing it gives `[REDACTED]`. Only {@link revealSecret} reads it,
 * and only modules of the outbound path may import that function.
 *
 * A secret holds 1 to 4096 visible ASCII characters, without spaces or
 * control characters, so that it cannot inject a header line or change on
 * the way. A value that contains `REDACTED` is refused, because it is most
 * likely a printed secret read back as if it were one. The class cannot be
 * subclassed, and instance, prototype and class are frozen.
 *
 * @example
 * ```ts
 * const token = new Secret(valueFromTheTokenFile);
 * String(token); // '[REDACTED]'
 * ```
 */
export class Secret {
  readonly #value: string;

  /**
   * Wraps a value.
   *
   * @param value - 1 to 4096 visible ASCII characters.
   * @throws {TypeError} When the value is not a string or the class is
   *   subclassed.
   * @throws {RangeError} When the value is empty, too long, holds other
   *   characters or contains `REDACTED`. The message never shows the value.
   */
  constructor(value: string) {
    if (new.target !== Secret) {
      throw new TypeError('A secret cannot be subclassed.');
    }
    if (typeof value !== 'string') {
      throw new TypeError('A secret must be a string.');
    }
    if (!isVisibleAscii(value) || value.includes('REDACTED')) {
      throw new RangeError(
        'A secret must be 1 to 4096 visible ASCII characters and no placeholder.',
      );
    }
    this.#value = value;
    Object.freeze(this);
  }

  /**
   * Reads the value of a secret. Taken off the class below; use
   * {@link revealSecret}. An arrow function, so it needs no `this`.
   *
   * @param secret - The secret.
   * @returns Its value.
   * @throws {TypeError} When the argument is not a secret of this module.
   */
  static readonly [reveal] = (secret: unknown): string => {
    if (typeof secret !== 'object' || secret === null || !(#value in secret)) {
      throw new TypeError('Not a secret.');
    }
    return secret.#value;
  };

  /**
   * Gives the placeholder, never the value.
   *
   * @returns `[REDACTED]`.
   */
  toString(): string {
    return redacted;
  }

  /**
   * Gives the placeholder to JSON, never the value.
   *
   * @returns `[REDACTED]`.
   */
  toJSON(): string {
    return redacted;
  }

  /**
   * Gives the placeholder to util.inspect, never the value.
   *
   * @returns `[REDACTED]`.
   */
  [inspectCustom](): string {
    return redacted;
  }
}

const read = Secret[reveal];
Reflect.deleteProperty(Secret, reveal);
Object.freeze(Secret.prototype);
Object.freeze(Secret);

/**
 * Turns a secret back into its value, to build the header of a request.
 * Only modules of the outbound path, `packages/core/src/http/`, may use
 * this function. In the packages, the dependency-cruiser rule
 * `egress-internals` refuses any other importer; outside them, where the
 * rule does not look, a test refuses the name (ADR 0054). Both guard against
 * mistakes, not against code that sets out to read a secret.
 *
 * @param secret - The secret.
 * @returns Its value.
 * @throws {TypeError} When the argument is not a secret made by this module,
 *   such as a copy, a clone or a proxy.
 * @example
 * ```ts
 * headers.set('authorization', `Login ${revealSecret(token)}`);
 * ```
 */
export function revealSecret(secret: Secret): string {
  return read(secret);
}
