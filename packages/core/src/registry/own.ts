/**
 * Reads what a plugin hands over without running its code: only own data
 * properties, never a getter, and only plain objects (ADR 0024).
 *
 * @packageDocumentation
 */

/**
 * Whether a value is a plain object: made by a literal, `Object.create`
 * with `null`, or `Object.freeze` of one, not an array, a function or an
 * instance of a class.
 *
 * @param value - Any value.
 * @returns `true` for a plain object.
 * @example
 * ```ts
 * isPlainObject({ a: 1 }); // true
 * isPlainObject([1]); // false
 * ```
 */
export function isPlainObject(value: unknown): value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

/**
 * Reads the own data properties of a plain object, when its keys are
 * exactly among the allowed ones and every required key is there.
 *
 * @param value - A plain object, or anything else.
 * @param allowed - The keys the object may have.
 * @param required - The keys it must have.
 * @returns The values by key in an object without prototype, or `undefined`
 *   when the value is no plain object, has another key, a symbol key, an
 *   accessor or lacks a required key.
 * @example
 * ```ts
 * readFields({ a: 1 }, ['a', 'b'], ['a']); // { a: 1 }
 * readFields({ c: 1 }, ['a'], []); // undefined
 * ```
 */
export function readFields(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
  if (!isPlainObject(value)) return undefined;
  const fields = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) return undefined;
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) return undefined;
    fields[key] = descriptor.value;
  }
  for (const key of required) {
    if (!(key in fields)) return undefined;
  }
  return fields;
}
