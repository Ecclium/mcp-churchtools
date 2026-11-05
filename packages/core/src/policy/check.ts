/**
 * The check of a policy and the policy with its defaults (ADR 0032).
 *
 * Where it stands: at the start, after the reader of YAML. It checks the
 * plain values against the schema of `policy.v1`, then refuses what the
 * schema cannot see: one target with two names, a tool named twice for
 * one target, a limit per run above the limit per day, and one routine
 * with two levels of redaction. A policy that contradicts itself would
 * leave it to chance which entry counts, so the server does not start
 * with one. What passes gets its defaults, names in the normal form NFC
 * and GUIDs in lower case, so that planning compares like with like.
 *
 * A problem is reported with its code and the path of the field, built
 * only from names of the schema and positions in lists, never with a
 * value of the file and never with the name of an unknown field, which
 * the operator wrote.
 *
 * @packageDocumentation
 */
import {
  checkPlainText,
  contactKeyOf,
  contactKeysOf,
  normalizeContent,
} from '../content/index.js';
import {
  type InteractiveEntry,
  type InteractiveTarget,
  type Policy,
  policyFileSchema,
  policyLimits,
  type UnattendedEntry,
  type UnattendedTarget,
} from './schema.js';

/** Why a value is no policy, frozen. */
export const policyCheckCodes = Object.freeze([
  'policy_version_unknown',
  'policy_invalid',
  'policy_contradiction',
] as const);

/** Why a value is no policy. */
export type PolicyCheckCode = (typeof policyCheckCodes)[number];

/** The checked policy, or why there is none. */
export type PolicyCheckResult =
  | { readonly ok: true; readonly policy: Policy }
  | {
      readonly ok: false;
      readonly code: PolicyCheckCode;
      /** The path of the field, such as `interactive.targets[2].maxPerDay`. */
      readonly field?: string;
    };

const refuse = (code: PolicyCheckCode, field?: string): PolicyCheckResult =>
  Object.freeze({
    __proto__: null,
    ok: false,
    code,
    ...(field === undefined ? {} : { field }),
  });

// A name of the schema: letters only. Anything else ends the path, so that
// no text of the file reaches a message.
const fieldName = /^[A-Za-z]{1,32}$/;

/**
 * Writes the path of an issue of zod as the message shows it. Only names
 * of letters and positions in lists count; the path ends before anything
 * else, which only a schema with names from the file could produce.
 *
 * @param path - The path of the issue.
 * @returns The path, such as `interactive.targets[2].maxPerDay`, or
 *   undefined for the whole file.
 * @example
 * ```ts
 * policyFieldOf(['unattended', 0, 'maxPerRun']); // 'unattended[0].maxPerRun'
 * ```
 */
export function policyFieldOf(
  path: readonly PropertyKey[],
): string | undefined {
  let field = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      field += `[${String(segment)}]`;
    } else if (typeof segment === 'string' && fieldName.test(segment)) {
      field += field === '' ? segment : `.${segment}`;
    } else {
      break;
    }
  }
  return field === '' ? undefined : field;
}

// An own data property of a plain object, never through a getter.
const ownData = (value: unknown, key: string): unknown => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const property = Object.getOwnPropertyDescriptor(value, key);
  return property !== undefined && Object.hasOwn(property, 'value')
    ? property.value
    : undefined;
};

const nfc = (text: string): string => text.normalize('NFC');

// The named things of a target, each with the key that identifies it and
// the field of its name: an event and its service are named apart. A page
// is named by its GUID alone, which names one page whatever category an
// entry gives it.
const namesOf = (
  target: InteractiveTarget,
): readonly (readonly [key: string, name: string, field: string])[] => {
  switch (target.kind) {
    case 'wiki_page':
      return [[`wiki_page:${target.guid.toLowerCase()}`, target.name, 'name']];
    case 'service':
      return [
        [`event:${String(target.event.id)}`, target.event.name, 'event.name'],
        [
          `service:${String(target.service.id)}`,
          target.service.name,
          'service.name',
        ],
      ];
    default:
      return [[`${target.kind}:${String(target.id)}`, target.name, 'name']];
  }
};

/**
 * The key of a target, as the counters of the policy and its matching
 * name it: the kind and its IDs, a GUID in lower case.
 *
 * @param target - A target of the policy.
 * @returns The key, such as `wiki_category:12` or `service:5/7`.
 * @example
 * ```ts
 * targetKeyOf({ kind: 'calendar', id: 3, name: 'Gottesdienste' }); // 'calendar:3'
 * ```
 */
export function targetKeyOf(target: InteractiveTarget): string {
  switch (target.kind) {
    case 'wiki_page':
      return `wiki_page:${String(target.categoryId)}/${target.guid.toLowerCase()}`;
    case 'service':
      return `service:${String(target.event.id)}/${String(target.service.id)}`;
    default:
      return `${target.kind}:${String(target.id)}`;
  }
}

// The target with its names in NFC and its GUID in lower case, frozen. The
// kind stays as it is.
const normalTarget = (
  target: InteractiveTarget,
): Readonly<InteractiveTarget> => {
  switch (target.kind) {
    case 'wiki_page':
      return Object.freeze({
        ...target,
        guid: target.guid.toLowerCase(),
        name: nfc(target.name),
      });
    case 'service':
      return Object.freeze({
        ...target,
        event: Object.freeze({ ...target.event, name: nfc(target.event.name) }),
        service: Object.freeze({
          ...target.service,
          name: nfc(target.service.name),
        }),
      });
    default:
      return Object.freeze({ ...target, name: nfc(target.name) });
  }
};

/** What the checks across entries hold while they walk the file. */
interface Seen {
  /** The name in NFC of each named thing. */
  readonly names: Map<string, string>;
  /** Each target with each tool, in its part. */
  readonly tools: Set<string>;
}

// Checks the names and tools of one entry against those seen before. The
// field of the first contradiction, or undefined.
const contradictionOf = (
  seen: Seen,
  scope: string,
  target: InteractiveTarget,
  tools: readonly string[],
  at: string,
): string | undefined => {
  for (const [key, name, field] of namesOf(target)) {
    const known = seen.names.get(key);
    if (known !== undefined && known !== nfc(name)) {
      return `${at}.target.${field}`;
    }
    seen.names.set(key, nfc(name));
  }
  const ownTools = new Set<string>();
  for (const [index, tool] of tools.entries()) {
    const key = `${scope}|${targetKeyOf(target)}|${tool}`;
    if (ownTools.has(tool) || seen.tools.has(key)) {
      return `${at}.tools[${String(index)}]`;
    }
    ownTools.add(tool);
    seen.tools.add(key);
  }
  return undefined;
};

/**
 * Checks plain values as a policy of version 1 and fills in its defaults:
 * the read budget of 200 and the level `strict` for the call of the model
 * of a routine.
 *
 * @param value - The plain values, as the reader of YAML returns them.
 * @returns The policy, deeply frozen, or the code of the first problem
 *   with the path of its field. It never throws.
 * @example
 * ```ts
 * checkPolicy({ schema: 'policy.v1' }); // { ok: true, policy: defaultPolicy }
 * checkPolicy({ schema: 'policy.v2' }); // { ok: false, code: 'policy_version_unknown', field: 'schema' }
 * ```
 */
export function checkPolicy(value: unknown): PolicyCheckResult {
  // Without its version, or with another, the rest of the file means
  // something else, so its fields are not checked against this schema.
  if (ownData(value, 'schema') !== 'policy.v1') {
    return refuse(
      'policy_version_unknown',
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? 'schema'
        : undefined,
    );
  }
  const parsed = policyFileSchema.safeParse(value);
  if (!parsed.success) {
    // A failed parse has at least one issue; the first one counts.
    const [field] = parsed.error.issues
      .slice(0, 1)
      .map((issue) => policyFieldOf(issue.path));
    return refuse('policy_invalid', field);
  }
  const file = parsed.data;

  const seen: Seen = { names: new Map(), tools: new Set() };
  const interactive: InteractiveEntry[] = [];
  for (const [index, entry] of (file.interactive?.targets ?? []).entries()) {
    const at = `interactive.targets[${String(index)}]`;
    const contradiction = contradictionOf(
      seen,
      'interactive',
      entry.target,
      entry.tools,
      at,
    );
    if (contradiction !== undefined) {
      return refuse('policy_contradiction', contradiction);
    }
    interactive.push(
      Object.freeze({
        target: normalTarget(entry.target),
        tools: Object.freeze([...entry.tools]),
        maxPerDay: entry.maxPerDay,
      }),
    );
  }

  // Every contact value is exactly one e-mail address, phone number, IBAN
  // or AHV number in the normal form of the content policy, each once by
  // the key it is compared by (ADR 0030).
  const contacts: string[] = [];
  const keys = new Set<string>();
  for (const [index, entry] of (file.interactive?.contacts ?? []).entries()) {
    const at = `interactive.contacts[${String(index)}]`;
    const normal = normalizeContent(entry);
    const key = normal.ok ? contactKeyOf(normal.text) : undefined;
    if (!normal.ok || key === undefined) return refuse('policy_invalid', at);
    if (keys.has(key)) return refuse('policy_contradiction', at);
    keys.add(key);
    contacts.push(normal.text);
  }

  // Whom to ask stands in the line of the marking of every page and
  // section Ecclium adds, so it passes the content policy as plain text,
  // and contact data in it only when the policy lists them (ADR 0032).
  let inquiriesTo: string | undefined;
  if (file.interactive?.inquiriesTo !== undefined) {
    const checked = checkPlainText(file.interactive.inquiriesTo, {
      contacts: contactKeysOf(contacts),
    });
    if (!checked.ok || checked.text.trim() === '') {
      return refuse('policy_invalid', 'interactive.inquiriesTo');
    }
    inquiriesTo = checked.text.trim();
  }

  const levels = new Map<string, string>();
  const unattended: UnattendedEntry[] = [];
  for (const [index, entry] of (file.unattended ?? []).entries()) {
    const at = `unattended[${String(index)}]`;
    const modelRedaction = entry.modelRedaction ?? 'strict';
    const level = levels.get(entry.routine);
    if (level !== undefined && level !== modelRedaction) {
      return refuse('policy_contradiction', `${at}.modelRedaction`);
    }
    levels.set(entry.routine, modelRedaction);
    if (entry.maxPerRun > entry.maxPerDay) {
      return refuse('policy_contradiction', `${at}.maxPerRun`);
    }
    const contradiction = contradictionOf(
      seen,
      `routine:${entry.routine}`,
      entry.target,
      entry.tools,
      at,
    );
    if (contradiction !== undefined) {
      return refuse('policy_contradiction', contradiction);
    }
    unattended.push(
      Object.freeze({
        routine: entry.routine,
        credential: entry.credential,
        modelRedaction,
        // The kind of the target stays one of the unattended part.
        target: normalTarget(entry.target) as Readonly<UnattendedTarget>,
        tools: Object.freeze([...entry.tools]),
        maxPerRun: entry.maxPerRun,
        maxPerDay: entry.maxPerDay,
      }),
    );
  }

  const policy: Policy = Object.freeze({
    schema: 'policy.v1',
    interactive: Object.freeze({
      readBudgetPerDay:
        file.interactive?.readBudgetPerDay ??
        policyLimits.defaultReadBudgetPerDay,
      targets: Object.freeze(interactive),
      ...(contacts.length > 0 ? { contacts: Object.freeze(contacts) } : {}),
      ...(inquiriesTo === undefined ? {} : { inquiriesTo }),
    }),
    unattended: Object.freeze(unattended),
  });
  return Object.freeze({ __proto__: null, ok: true, policy });
}

/**
 * The policy without a file: no entries, so the interactive part allows
 * what the account may except for groups and services, and the read
 * budget of 200. Deeply frozen.
 */
export const defaultPolicy: Policy = Object.freeze({
  schema: 'policy.v1',
  interactive: Object.freeze({
    readBudgetPerDay: policyLimits.defaultReadBudgetPerDay,
    targets: Object.freeze([]),
  }),
  unattended: Object.freeze([]),
});
