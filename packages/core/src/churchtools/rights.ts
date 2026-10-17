/**
 * Turns the answer of `GET /api/permissions/global` into the set rights
 * (ADR 0057). The names of modules and rights are checked on the parsed
 * value before any schema, because `z.record` drops a key `__proto__`
 * silently and a later check would never see it. Every deviation makes the
 * whole answer unknown, never a part of it.
 *
 * @packageDocumentation
 */
import type {
  GrantedRights,
  Permissions,
  RightValue,
} from '@ecclium/mcp-churchtools-plugin-api';

import { rightValueSchema } from './schemas.js';

/** The most modules of an answer. */
export const maxModules = 100;

/** The most rights of one module. */
export const maxRightsPerModule = 500;

const unsafeNames = Object.freeze(['__proto__', 'constructor', 'prototype']);

const unknown: Permissions = Object.freeze({
  __proto__: null,
  kind: 'unknown',
});

// Printable ASCII, 1 to 100 characters, no blank at either end, and none
// of the names that reach the prototype.
const isName = (name: string): boolean => {
  if (name.length < 1 || name.length > 100 || unsafeNames.includes(name)) {
    return false;
  }
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return name.trim() === name;
};

// A plain object as JSON.parse makes it, not an array and not null.
const isPlain = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

/**
 * Reads the set rights from `data` of the answer.
 *
 * @param data - `data` of the parsed answer, of any shape.
 * @returns The set rights, frozen and without prototypes, or `unknown`.
 * @example
 * ```ts
 * toPermissions({ churchwiki: { view: true, edit: false } });
 * // { kind: 'known', granted: { churchwiki: { view: true } } }
 * ```
 */
export function toPermissions(data: unknown): Permissions {
  if (!isPlain(data)) return unknown;
  const modules = Object.keys(data);
  if (modules.length > maxModules) return unknown;
  const granted = Object.create(null) as Record<
    string,
    Readonly<Record<string, RightValue>>
  >;
  for (const module of modules) {
    if (!isName(module)) return unknown;
    const rights = data[module];
    if (!isPlain(rights)) return unknown;
    const names = Object.keys(rights);
    if (names.length > maxRightsPerModule) return unknown;
    const set = Object.create(null) as Record<string, RightValue>;
    for (const name of names) {
      if (!isName(name)) return unknown;
      const parsed = rightValueSchema.safeParse(rights[name]);
      if (!parsed.success) return unknown;
      const value = parsed.data;
      if (value === true) set[name] = true;
      else if (Array.isArray(value) && value.length > 0) {
        set[name] = Object.freeze([...value]);
      }
    }
    if (Object.keys(set).length > 0) granted[module] = Object.freeze(set);
  }
  return Object.freeze({
    __proto__: null,
    kind: 'known',
    granted: Object.freeze<GrantedRights>(granted),
  });
}
