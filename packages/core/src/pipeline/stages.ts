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

import { type ObjectDomain, objectRefOf } from '../audit/index.js';
import {
  cleanText,
  isStrictLevel,
  maskBirthdate,
  maskedValue,
  maskEmail,
  maskFreeText,
  maskLastName,
  maskPhone,
  wrapInEnvelope,
} from '../redaction/index.js';
import {
  type InputRefNode,
  markerClasses,
  type ShapeNode,
} from '../registry/index.js';

/** The deepest nesting of the input of a tool. */
export const maxInputDepth = 16;

/** The most values in the input of a tool, containers included. */
export const maxInputElements = 1000;

/** The most UTF-8 bytes of a result of a tool as the client receives it. */
export const maxResultBytes = 64 * 1024;

/**
 * The part of {@link maxResultBytes} kept for what the mount puts around
 * the data: the envelope of the JSON-RPC message, the type of the text
 * block and `_meta` (ADR 0024).
 */
export const resultReserveBytes = 1024;

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

/** What {@link revealInput} gives: the input with IDs, or a refusal. */
export type RevealedInput =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false };

// A copy of plain JSON, with objects of the prototype of Object as zod
// takes them. Object.fromEntries defines each key as an own property, also
// one named __proto__, so no key changes the prototype of a copy.
const copyJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return (value as unknown[]).map(copyJson);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, copyJson(item)]),
  );
};

const isRecordValue = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// An object or a list of the copy, whose items are read by key or index.
type Holder = Record<string | number, unknown>;

/** One walk of {@link revealInput}. */
interface RevealWalk {
  readonly reveal: (pseudonym: unknown) => number | undefined;
  // The places already turned into an ID, so that a choice whose options
  // both name the place does not read the ID as a raw one.
  readonly done: Map<object, Set<string | number>>;
  ok: boolean;
}

// Turns the pseudonym at one place into its ID. A missing value asks for
// nothing; anything else that is no pseudonym of the call ends the walk.
const revealAt = (
  holder: Holder,
  key: string | number,
  walk: RevealWalk,
): void => {
  const done = walk.done.get(holder) ?? new Set<string | number>();
  if (done.has(key)) return;
  const value = holder[key];
  if (value === null || value === undefined) return;
  const id = walk.reveal(value);
  if (id === undefined) {
    walk.ok = false;
    return;
  }
  Object.defineProperty(holder, key, {
    value: id,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  done.add(key);
  walk.done.set(holder, done);
};

// Walks the copy along the places of IDs the registry kept, as the audit
// reads them, and turns each pseudonym at a place of a person into its ID.
const revealWalk = (
  holder: Holder,
  key: string | number,
  node: InputRefNode,
  walk: RevealWalk,
): void => {
  const value = holder[key];
  switch (node.kind) {
    case 'leaf':
      if (node.domain === 'person') revealAt(holder, key, walk);
      return;
    case 'object':
      if (!isRecordValue(value)) return;
      for (const field of Object.keys(value)) {
        const fieldNode = Object.hasOwn(node.fields, field)
          ? node.fields[field]
          : node.rest;
        if (fieldNode !== undefined) revealWalk(value, field, fieldNode, walk);
      }
      return;
    case 'record':
      if (!isRecordValue(value)) return;
      for (const field of Object.keys(value)) {
        revealWalk(value, field, node.value, walk);
      }
      return;
    case 'list':
      if (!Array.isArray(value)) return;
      for (let index = 0; index < value.length; index += 1) {
        revealWalk(value as unknown as Holder, index, node.element, walk);
      }
      return;
    case 'tuple':
      if (!Array.isArray(value)) return;
      for (let index = 0; index < value.length; index += 1) {
        const itemNode =
          index < node.items.length ? node.items[index] : node.rest;
        if (itemNode !== undefined && itemNode !== null) {
          revealWalk(value as unknown as Holder, index, itemNode, walk);
        }
      }
      return;
    case 'choice':
      // Every option counts: a raw ID at a place where one option expects
      // a person ends the call, even if another option would take a
      // number there.
      for (const option of node.options) revealWalk(holder, key, option, walk);
  }
};

/**
 * Turns every pseudonym in the input of a call in the level `strict` into
 * the ID of the person, before the schema of the tool checks the input
 * (ADR 0069). It finds the places along the IDs the registry kept for the
 * audit, in objects, lists, records, tuples and choices, and works on a
 * copy of plain objects. At a place of a person, only a pseudonym of the
 * call or a missing value passes; a raw number, a changed pseudonym or one
 * of another principal ends the walk, so the tool only ever sees IDs and a
 * raw ID never reaches it.
 *
 * @param input - The input as the client sent it, which passed
 *   {@link fitsInput}.
 * @param node - Where the IDs of the input stand.
 * @param reveal - Gives the ID of a pseudonym of the call, or undefined.
 * @returns The copy with IDs, or a refusal.
 * @example
 * ```ts
 * revealInput({ personId: 'p1_…' }, entry.inputRefs, pseudonyms.reveal);
 * // { ok: true, value: { personId: 12 } }
 * ```
 */
export function revealInput(
  input: unknown,
  node: InputRefNode,
  reveal: (pseudonym: unknown) => number | undefined,
): RevealedInput {
  const holder: Record<string, unknown> = { input: copyJson(input) };
  const walk: RevealWalk = { reveal, done: new Map(), ok: true };
  revealWalk(holder, 'input', node, walk);
  return walk.ok ? { ok: true, value: holder.input } : { ok: false };
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

/**
 * Hands the ID of every person and group a checked result names to `add`,
 * along the shape the registry kept: the leaves of the classes `personId`
 * and `groupId` (ADR 0028). It reads the result before `redact`, so that
 * the audit records the IDs, whatever a level of redaction shows.
 *
 * @param value - A value that passed the output schema.
 * @param node - The kept shape of that value.
 * @param add - Takes the kind and the value of each ID, in order.
 * @example
 * ```ts
 * collectOutputRefs({ id: 12 }, shape.root, refs.add); // adds person 12
 * ```
 */
export function collectOutputRefs(
  value: unknown,
  node: ShapeNode,
  add: (domain: ObjectDomain, value: unknown) => void,
): void {
  if (value === null || value === undefined) return;
  switch (node.kind) {
    case 'leaf':
      if (node.dataClass === 'personId') add('person', value);
      else if (node.dataClass === 'groupId') add('group', value);
      return;
    case 'array':
      for (const item of value as readonly unknown[]) {
        collectOutputRefs(item, node.element, add);
      }
      return;
    case 'tuple':
      node.items.forEach((item, index) => {
        collectOutputRefs((value as readonly unknown[])[index], item, add);
      });
      return;
    case 'object':
      for (const [key, field] of Object.entries(
        value as Readonly<Record<string, unknown>>,
      )) {
        const fieldNode = node.fields[key];
        if (fieldNode !== undefined) collectOutputRefs(field, fieldNode, add);
      }
  }
}

/**
 * Tells whether every ID of a person or a group that a checked result
 * names has the form the audit takes, so that no ID leaves without its
 * line naming it (ADR 0028).
 *
 * @param value - A value that passed the output schema.
 * @param node - The kept shape of that value.
 * @returns Whether every such ID fits.
 * @example
 * ```ts
 * outputIdsFit({ id: 12 }, shape.root); // true
 * outputIdsFit({ id: 'Max' }, shape.root); // false
 * ```
 */
export function outputIdsFit(value: unknown, node: ShapeNode): boolean {
  let fits = true;
  collectOutputRefs(value, node, (domain, id) => {
    if (objectRefOf(domain, id) === undefined) fits = false;
  });
  return fits;
}

// The free text of the level strict: cleaned with its note first, then
// checked, so that the check reads what the envelope will hold.
const checkFreeText = (text: string): string => maskFreeText(cleanText(text));

// The mask of a class at a level, if the class has one there. The registry
// lets these classes only on strings, so a mask never changes the type of
// a value.
const maskOf = (
  dataClass: DataClass | undefined,
  level: RedactionLevel,
): ((text: string) => string) | undefined => {
  if (level === 'off') return undefined;
  switch (dataClass) {
    case 'email':
      return maskEmail;
    case 'phone':
      return maskPhone;
    case 'birthdate':
      return maskBirthdate;
    case 'name.last':
      return isStrictLevel(level) ? maskLastName : undefined;
    case 'untrusted':
      return isStrictLevel(level) ? checkFreeText : undefined;
    default:
      return undefined;
  }
};

/**
 * The stage `redact`. It masks e-mail addresses, phone numbers and dates of
 * birth by their data class and replaces addresses and amounts with
 * {@link maskedValue}, unless the level is `off`; any other level masks, so
 * a level the core does not know yet fails closed. In `strict` it also
 * shortens last names to their first letter and checks every free text for
 * e-mail addresses, phone numbers, IBAN and AHV numbers (ADR 0069). Every
 * other string loses its hidden characters, with a note at its end when
 * some were removed, at every level, because hidden characters carry
 * instructions, not personal data. A leaf without a class cannot reach
 * this stage since the registry refuses it (ADR 0026); it would stay
 * unmasked here.
 *
 * In `strict` every ID of a person becomes the pseudonym `hide` gives for
 * it. The audit has read the IDs before, so it records the IDs, not the
 * pseudonyms (ADR 0028, ADR 0069).
 *
 * @param value - The checked result.
 * @param root - The kept shape of the result.
 * @param level - The level of redaction of the call.
 * @param hide - Gives the pseudonym of an ID, needed in `strict` for a
 *   result with an ID of a person.
 * @returns The result, copied and frozen.
 * @throws {TypeError} In `strict`, for an ID of a person without `hide`
 *   or one that is no number; and whatever `hide` throws, such as for a
 *   number that is no ID.
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
  hide?: (id: number) => string,
): unknown {
  const pseudonyms = isStrictLevel(level);
  return mapLeaves(value, root, (leaf, dataClass) => {
    // The ID of a person, in place of which strict gives its pseudonym. A
    // missing ID stays missing; the registry lets the class only on
    // numbers, so anything else is a fault and ends the call (ADR 0069).
    if (
      pseudonyms &&
      dataClass === 'personId' &&
      leaf !== null &&
      leaf !== undefined
    ) {
      if (typeof leaf !== 'number' || hide === undefined) {
        throw new TypeError('An ID of a person has no pseudonym.');
      }
      return hide(leaf);
    }
    // Street, postcode, coordinates and amounts go as a whole, numbers as
    // well as text; the registry lets these classes only on both (ADR
    // 0026, ADR 0069). A missing value stays missing.
    if (
      level !== 'off' &&
      dataClass !== undefined &&
      markerClasses.includes(dataClass) &&
      (typeof leaf === 'string' || typeof leaf === 'number')
    ) {
      return maskedValue;
    }
    if (typeof leaf !== 'string') return leaf;
    const mask = maskOf(dataClass, level);
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
 * The size of a result as the client receives it, in UTF-8 bytes (ADR
 * 0024). The mount sends the data twice: once as their JSON, and once as
 * text that holds this JSON, which the message escapes a second time. Both
 * copies count as they are sent, so a quote of the data costs six bytes, a
 * line break five and a plain letter two. {@link resultReserveBytes} stands
 * for the rest of the message, so the pipeline needs no type of MCP. The
 * count holds only while the mount writes the text exactly as
 * `JSON.stringify` writes the data, without indentation.
 *
 * @param value - The result, after `markUntrusted`.
 * @returns The number of bytes, the reserve included.
 * @example
 * ```ts
 * resultBytes({ name: 'Ä' }); // 13 + 19 + 1024 = 1056
 * ```
 */
export function resultBytes(value: unknown): number {
  const json = JSON.stringify(value);
  return (
    encoder.encode(json).byteLength +
    encoder.encode(JSON.stringify(json)).byteLength +
    resultReserveBytes
  );
}
