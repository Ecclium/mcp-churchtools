/**
 * Checks the metadata of a tool at run time (ADR 0024). The types of the
 * plugin interface forbid the same combinations, but a plugin compiled
 * against another version, or written without TypeScript, passes them by.
 *
 * @packageDocumentation
 */
import type {
  ReplayGuard,
  Reversible,
  RightRef,
  Sensitivity,
  Tier,
  ToolDomain,
  ToolMeta,
  UnattendedRule,
} from '@ecclium/mcp-churchtools-plugin-api';

import { readFields } from './own.js';

/** Every {@link ToolDomain}, frozen. A test checks that none is missing. */
export const toolDomains = Object.freeze([
  'base',
  'persons',
  'groups',
  'events',
  'services',
  'calendars',
  'appointments',
  'resources',
  'bookings',
  'wiki',
  'songs',
  'docs',
  'api',
] as const satisfies readonly ToolDomain[]);

const sensitivities: readonly Sensitivity[] = ['none', 'personal', 'special'];
const unattendedRules: readonly UnattendedRule[] = ['never', 'policy'];
const reversibles: readonly Reversible[] = ['yes', 'no', 'snapshot'];
const replayGuards: readonly ReplayGuard[] = ['baseVersion', 'marker', 'nonce'];
const tiers: readonly Tier[] = ['free', 'pro'];

/** The most rights a tool may require, as many as an error may name. */
export const maxRequiredRights = 32;

const unsafeNames: readonly string[] = [
  '__proto__',
  'constructor',
  'prototype',
];

// Printable ASCII, 1 to 100 characters, no blank at either end: the form of
// the names in the answer of ChurchTools that the client accepts (ADR 0057).
const isRightName = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 100) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return value.trim() === value && !unsafeNames.includes(value);
};

const oneOf = <T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value);

const checkRights = (value: unknown): readonly RightRef[] | undefined => {
  if (!Array.isArray(value) || value.length > maxRequiredRights) {
    return undefined;
  }
  const rights: RightRef[] = [];
  const seen: string[] = [];
  // Read by index through descriptors, so a getter of the array runs no
  // code of the plugin.
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, index);
    if (descriptor === undefined || !('value' in descriptor)) return undefined;
    const fields = readFields(
      descriptor.value,
      ['module', 'right'],
      ['module', 'right'],
    );
    if (fields === undefined) return undefined;
    const { module, right } = fields;
    if (!isRightName(module) || !isRightName(right)) return undefined;
    const key = `${module}\n${right}`;
    if (seen.includes(key)) return undefined;
    seen.push(key);
    rights.push(Object.freeze({ __proto__: null, module, right }));
  }
  return Object.freeze(rights);
};

const commonKeys = [
  'capability',
  'domain',
  'requiredRights',
  'tier',
  'sensitivity',
  'unattended',
  'routineStable',
];

/**
 * Checks the metadata of a tool and copies them.
 *
 * It accepts only the combinations the types allow: a tool of the
 * sensitivity `special` never runs unattended, a write tool says whether it
 * can be undone and what keeps it from taking effect twice, and a reading
 * tool says neither.
 *
 * @param value - The metadata as the plugin hands them over.
 * @returns A frozen copy without prototypes, or `undefined` when the
 *   metadata are incomplete, hold another field or a contradiction.
 * @example
 * ```ts
 * checkMeta({ capability: 'read', domain: 'base', requiredRights: [],
 *   tier: 'free', sensitivity: 'personal', unattended: 'never',
 *   routineStable: false }); // a frozen copy
 * ```
 */
export function checkMeta(value: unknown): ToolMeta | undefined {
  const fields = readFields(
    value,
    [...commonKeys, 'reversible', 'replayGuard'],
    commonKeys,
  );
  if (fields === undefined) return undefined;
  const {
    capability,
    domain,
    requiredRights,
    tier,
    sensitivity,
    unattended,
    routineStable,
    reversible,
    replayGuard,
  } = fields;
  if (
    !oneOf(domain, toolDomains) ||
    !oneOf(tier, tiers) ||
    !oneOf(sensitivity, sensitivities) ||
    !oneOf(unattended, unattendedRules) ||
    typeof routineStable !== 'boolean'
  ) {
    return undefined;
  }
  // A tool on persons or memberships never runs without a person.
  if (sensitivity === 'special' && unattended !== 'never') return undefined;
  const rights = checkRights(requiredRights);
  if (rights === undefined) return undefined;
  const exposure =
    sensitivity === 'special'
      ? { sensitivity, unattended: 'never' as const }
      : { sensitivity, unattended };
  const common = { domain, requiredRights: rights, tier, routineStable };
  if (capability === 'read') {
    if ('reversible' in fields || 'replayGuard' in fields) return undefined;
    return Object.freeze({
      __proto__: null,
      ...common,
      ...exposure,
      capability,
    });
  }
  if (
    capability !== 'write' ||
    !oneOf(reversible, reversibles) ||
    !oneOf(replayGuard, replayGuards)
  ) {
    return undefined;
  }
  return Object.freeze({
    __proto__: null,
    ...common,
    ...exposure,
    capability,
    reversible,
    replayGuard,
  });
}
