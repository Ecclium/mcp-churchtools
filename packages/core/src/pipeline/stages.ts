/**
 * The stages of the pipeline that work on values only, without the client
 * or the context (ADR 0024).
 *
 * @packageDocumentation
 */
import type {
  DataClass,
  RedactionLevel,
} from '@ecclium/mcp-churchtools-plugin-api';

import {
  cleanText,
  maskBirthdate,
  maskEmail,
  maskPhone,
  wrapInEnvelope,
} from '../redaction/index.js';
import type { ShapeNode } from '../registry/index.js';

/** The deepest nesting of the input of a tool. */
export const maxInputDepth = 16;

/** The most values in the input of a tool, containers included. */
export const maxInputElements = 1000;

/** The most UTF-8 bytes of a result of a tool. */
export const maxResultBytes = 64 * 1024;

const encoder = new TextEncoder();

/**
 * Whether the input of a call is plain JSON within the limits: objects
 * without prototype or with the one of `Object`, arrays, strings, finite
 * numbers, booleans and null, at most {@link maxInputDepth} levels and
 * {@link maxInputElements} values. The check runs before zod, so a huge or
 * deep input costs no parse.
 *
 * @param input - The input as the client sent it.
 * @returns Whether it fits.
 * @example
 * ```ts
 * fitsInput({ query: 'Person A' }); // true
 * fitsInput({ when: new Date() }); // false
 * ```
 */
export function fitsInput(input: unknown): boolean {
  let count = 0;
  const stack: { readonly value: unknown; readonly depth: number }[] = [
    { value: input, depth: 1 },
  ];
  while (stack.length > 0) {
    const { value, depth } = stack.pop() as (typeof stack)[number];
    count += 1;
    if (count > maxInputElements) return false;
    if (value === null || typeof value === 'string') continue;
    if (typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return false;
      continue;
    }
    if (typeof value !== 'object' || depth > maxInputDepth) return false;
    const children: unknown[] = [];
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Reflect.getOwnPropertyDescriptor(value, index);
        if (descriptor === undefined || !('value' in descriptor)) return false;
        children.push(descriptor.value);
      }
    } else {
      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype !== null && prototype !== Object.prototype) return false;
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') return false;
        const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !('value' in descriptor)) return false;
        children.push(descriptor.value);
      }
    }
    for (const child of children)
      stack.push({ value: child, depth: depth + 1 });
  }
  return true;
}

/** What a stage does with one leaf of the result. */
export type LeafStep = (
  value: unknown,
  dataClass: DataClass | undefined,
) => unknown;

/**
 * Copies a checked result along the shape the registry kept and applies a
 * step to every leaf. Objects come out without prototype and frozen, a
 * field the shape does not know is dropped.
 *
 * @param value - A value that passed the output schema.
 * @param node - The kept shape of that value.
 * @param step - What happens to each leaf.
 * @returns The frozen copy.
 * @example
 * ```ts
 * mapLeaves({ id: 1 }, shape.root, (leaf) => leaf); // { id: 1 }, frozen
 * ```
 */
export function mapLeaves(
  value: unknown,
  node: ShapeNode,
  step: LeafStep,
): unknown {
  if (value === null || value === undefined) {
    return node.kind === 'leaf' ? step(value, node.dataClass) : value;
  }
  switch (node.kind) {
    case 'leaf':
      return step(value, node.dataClass);
    case 'array':
      return Object.freeze(
        (value as readonly unknown[]).map((item) =>
          mapLeaves(item, node.element, step),
        ),
      );
    case 'tuple':
      return Object.freeze(
        node.items.map((item, index) =>
          mapLeaves((value as readonly unknown[])[index], item, step),
        ),
      );
    case 'object': {
      const copy = Object.create(null) as Record<string, unknown>;
      for (const [key, field] of Object.entries(
        value as Readonly<Record<string, unknown>>,
      )) {
        const fieldNode = node.fields[key];
        if (fieldNode !== undefined) {
          copy[key] = mapLeaves(field, fieldNode, step);
        }
      }
      return Object.freeze(copy);
    }
  }
}

// The mask of a class, if the class has one. The registry lets these
// classes only on strings, so a mask never changes the type of a value.
const maskOf = (
  dataClass: DataClass | undefined,
): ((text: string) => string) | undefined => {
  switch (dataClass) {
    case 'email':
      return maskEmail;
    case 'phone':
      return maskPhone;
    case 'birthdate':
      return maskBirthdate;
    default:
      return undefined;
  }
};

/**
 * The stage `redact`. It masks e-mail addresses, phone numbers and dates of
 * birth by their data class, unless the level is `off`; any other level
 * masks, so a level the core does not know yet fails closed. Every other
 * string loses its hidden characters, with a note at its end when some were
 * removed, at every level, because hidden characters carry instructions,
 * not personal data. A leaf without a class stays unmasked in phase 1.
 *
 * @param value - The checked result.
 * @param root - The kept shape of the result.
 * @param level - The level of redaction of the call.
 * @returns The result, copied and frozen.
 * @example
 * ```ts
 * redact({ email: 'max.mustermann@example.org' }, shape.root, 'standard');
 * // { email: 'm***@example.org' }
 * ```
 */
export function redact(
  value: unknown,
  root: ShapeNode,
  level: RedactionLevel,
): unknown {
  return mapLeaves(value, root, (leaf, dataClass) => {
    if (typeof leaf !== 'string') return leaf;
    const mask = level === 'off' ? undefined : maskOf(dataClass);
    return mask === undefined ? cleanText(leaf) : mask(leaf);
  });
}

/**
 * The stage `markUntrusted`. It puts every string of the class `untrusted`
 * into the data envelope with the boundary of the call. It runs after
 * `redact`, so the text it wraps is cleaned, and a note on removed
 * characters stands inside the envelope.
 *
 * @param value - The redacted result.
 * @param root - The kept shape of the result.
 * @param boundary - The boundary of the call, which the result does not
 *   hold.
 * @returns The result, copied and frozen.
 * @example
 * ```ts
 * markUntrusted({ note: 'Text' }, shape.root, 'a1b2c3d4e5f6a7b8');
 * // { note: '<<data-a1b2c3d4e5f6a7b8>>Text<</data-a1b2c3d4e5f6a7b8>>' }
 * ```
 */
export function markUntrusted(
  value: unknown,
  root: ShapeNode,
  boundary: string,
): unknown {
  return mapLeaves(value, root, (leaf, dataClass) =>
    dataClass === 'untrusted' && typeof leaf === 'string'
      ? wrapInEnvelope(leaf, boundary)
      : leaf,
  );
}

/**
 * The size of a result as the client receives it, in UTF-8 bytes of its
 * JSON.
 *
 * @param value - The result.
 * @returns The number of bytes.
 * @example
 * ```ts
 * resultBytes({ name: 'Ä' }); // 13
 * ```
 */
export function resultBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}
