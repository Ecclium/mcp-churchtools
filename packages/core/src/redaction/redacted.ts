/**
 * The mark of a redacted result (ADR 0026). The pipeline puts it on the
 * result of a call after the stages redact and markUntrusted and the check
 * of its size, and the serialisation of the mount sends only a result that
 * carries it. So the types stop a result that went past the pipeline by
 * mistake, and the check at run time stops one that a cast made into a
 * redacted result, as code compiled on its own could.
 *
 * The mark is an own property under a symbol that this module does not
 * export, not enumerable, not writable and not configurable. JSON, the keys
 * of the object and a copy with the spread operator do not see it, and a
 * proxy never counts as marked, also not one around a marked result, whose
 * traps could change what it shows. Code that holds a marked result can
 * read the symbol from it, so the mark guards against a mistake and a cast,
 * not against code that takes a marked result apart: only the pipeline
 * makes one, and only the serialisation of the mount and the SDK see one.
 * A rule of dependency-cruiser lets only the pipeline, the serialisation
 * and the stand-in outcomes of testkit import this module.
 *
 * @packageDocumentation
 */

import { isProxy } from 'node:util/types';

declare const redactedType: unique symbol;

/** A result of a call that the pipeline redacted, as the mount sends it. */
export type Redacted = Readonly<Record<string, unknown>> & {
  readonly [redactedType]: true;
};

const mark: unique symbol = Symbol('redacted');

/**
 * Marks a result as redacted: a frozen copy of its top level, without a
 * prototype, with the mark. The values below the top level are shared,
 * not copied, so the result keeps its size and its frozen parts.
 *
 * @param data - The result after the stages redact and markUntrusted.
 * @returns The marked copy.
 * @example
 * ```ts
 * const data = sealRedacted(markUntrusted(redacted, root, boundary));
 * ```
 */
export function sealRedacted(
  data: Readonly<Record<string, unknown>>,
): Redacted {
  const copy = Object.create(null) as Record<string | symbol, unknown>;
  for (const [key, value] of Object.entries(data)) copy[key] = value;
  Object.defineProperty(copy, mark, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(copy) as Redacted;
}

/**
 * Whether a value carries the mark of a redacted result. It reads only the
 * own descriptor of the mark and calls no getter, and a proxy counts as
 * unmarked.
 *
 * @param value - Any value.
 * @returns Whether {@link sealRedacted} made it.
 * @example
 * ```ts
 * isRedacted(sealRedacted({ id: 1 })); // true
 * isRedacted({ id: 1 }); // false
 * ```
 */
export function isRedacted(value: unknown): value is Redacted {
  if (typeof value !== 'object' || value === null || isProxy(value)) {
    return false;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, mark);
  return (
    descriptor !== undefined &&
    Object.hasOwn(descriptor, 'value') &&
    descriptor.value === true &&
    descriptor.writable === false &&
    descriptor.configurable === false
  );
}
