/**
 * The schema of the file of the policy, `policy.v1` (ADR 0032).
 *
 * Where it stands: at the start, after the reader of YAML. The schema
 * checks the plain values strictly: an unknown field, a wrong type or a
 * value out of its range fails the file, and the server does not start.
 * What passes is the policy that planning and committing a write consult
 * later, and its interactive part holds the daily read budget.
 *
 * The file has two parts. `interactive` limits what a person may write
 * through a client: targets as IDs with the name the operator expects,
 * the tools for each, and a limit per principal and UTC day. Without
 * entries the server writes what its account may, except for groups and
 * services. `unattended` binds a routine to its targets for the runner of
 * a later phase; the core checks it already, so that a file stays valid.
 * Groups and services of events are targets of the interactive part only.
 *
 * Only plain data and functions leave the core, never a zod schema, which
 * a caller could widen.
 *
 * @packageDocumentation
 */
import {
  maxWikiTitleLength,
  wikiPageGuidPattern,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

import { tenantIdPattern, toolNamePattern } from '../logger/index.js';

/** The limits of a policy, frozen. */
export const policyLimits = Object.freeze({
  /** The most entries of one part. */
  entries: 200,
  /** The most tools of one entry. */
  tools: 20,
  /** The highest read budget per actor and UTC day. */
  readBudgetPerDay: 1000,
  /** The read budget without a value in the file. */
  defaultReadBudgetPerDay: 200,
  /** The highest limit of writes per day of one entry. */
  maxPerDay: 1000,
  /** The highest limit of writes per run of one entry. */
  maxPerRun: 100,
  /** The highest ID of an object of ChurchTools. */
  id: 2_147_483_647,
  /** The longest name of a target. */
  name: maxWikiTitleLength,
} as const);

/** The levels of redaction a routine may ask for its call of the model. */
export const modelRedactionLevels = Object.freeze([
  'strict',
  'standard',
] as const);

/** The level of redaction of the call of the model of a routine. */
export type ModelRedaction = (typeof modelRedactionLevels)[number];

// A name as ChurchTools shows it: at least one character and no control
// character. The core compares it in the normal form NFC.
const namePattern = /^\P{Cc}+$/u;

const id = z.int().min(1).max(policyLimits.id);
const name = z.string().min(1).max(policyLimits.name).regex(namePattern);
const toolName = z.string().max(63).regex(toolNamePattern);
const slug = z.string().max(63).regex(tenantIdPattern);

const objectWithName = z.strictObject({ id, name });

const wikiCategoryTarget = z.strictObject({
  kind: z.literal('wiki_category'),
  id,
  name,
});
const wikiPageTarget = z.strictObject({
  kind: z.literal('wiki_page'),
  categoryId: id,
  guid: z.string().max(36).regex(wikiPageGuidPattern),
  name,
});
const calendarTarget = z.strictObject({
  kind: z.literal('calendar'),
  id,
  name,
});
const resourceTarget = z.strictObject({
  kind: z.literal('resource'),
  id,
  name,
});
const groupTarget = z.strictObject({ kind: z.literal('group'), id, name });
const serviceTarget = z.strictObject({
  kind: z.literal('service'),
  event: objectWithName,
  service: objectWithName,
});

// The targets of both parts, and those only the interactive part knows:
// writes to groups and services concern persons and never run unattended
// (ADR 0071).
const sharedTargets = [
  wikiCategoryTarget,
  wikiPageTarget,
  calendarTarget,
  resourceTarget,
] as const;
const interactiveTarget = z.discriminatedUnion('kind', [
  ...sharedTargets,
  groupTarget,
  serviceTarget,
]);
const unattendedTarget = z.discriminatedUnion('kind', [...sharedTargets]);

const tools = z.array(toolName).min(1).max(policyLimits.tools);
const maxPerDay = z.int().min(1).max(policyLimits.maxPerDay);

const interactiveEntry = z.strictObject({
  target: interactiveTarget,
  tools,
  maxPerDay,
});

const unattendedEntry = z.strictObject({
  routine: slug,
  credential: slug,
  modelRedaction: z.enum(modelRedactionLevels).optional(),
  target: unattendedTarget,
  tools,
  maxPerRun: z.int().min(1).max(policyLimits.maxPerRun),
  maxPerDay,
});

/**
 * The file of the policy as the operator writes it. Strict at every level;
 * the parts and the read budget may be left out.
 */
export const policyFileSchema = z.strictObject({
  schema: z.literal('policy.v1'),
  interactive: z
    .strictObject({
      readBudgetPerDay: z
        .int()
        .min(0)
        .max(policyLimits.readBudgetPerDay)
        .optional(),
      targets: z.array(interactiveEntry).max(policyLimits.entries).optional(),
    })
    .optional(),
  unattended: z.array(unattendedEntry).max(policyLimits.entries).optional(),
});

/** The file of the policy as the schema returns it. */
export type PolicyFile = z.output<typeof policyFileSchema>;

/** A target of the interactive part. */
export type InteractiveTarget = z.output<typeof interactiveTarget>;

/** A target of the unattended part. */
export type UnattendedTarget = z.output<typeof unattendedTarget>;

/** A kind of target of the policy. */
export type PolicyTargetKind = InteractiveTarget['kind'];

/** An entry of the interactive part. */
export interface InteractiveEntry {
  readonly target: Readonly<InteractiveTarget>;
  readonly tools: readonly string[];
  readonly maxPerDay: number;
}

/** An entry of the unattended part, with its level of redaction. */
export interface UnattendedEntry {
  readonly routine: string;
  readonly credential: string;
  readonly modelRedaction: ModelRedaction;
  readonly target: Readonly<UnattendedTarget>;
  readonly tools: readonly string[];
  readonly maxPerRun: number;
  readonly maxPerDay: number;
}

/**
 * A checked policy with every default in place, deeply frozen: what the
 * core reads after the start.
 */
export interface Policy {
  readonly schema: 'policy.v1';
  readonly interactive: {
    /** Calls per actor and UTC day of the tools in the read budget. */
    readonly readBudgetPerDay: number;
    /** Empty: what the account may, except for groups and services. */
    readonly targets: readonly InteractiveEntry[];
  };
  readonly unattended: readonly UnattendedEntry[];
}

/**
 * The JSON Schema of the file of the policy, made with `z.toJSONSchema`
 * from the schema of zod on each call. Editors can check a file and
 * complete it with it. It describes what the operator writes, so the parts
 * and the read budget are optional; the contradictions the core refuses
 * as well, such as one target with two names, it does not express.
 *
 * @returns The schema in JSON Schema 2020-12, a new object each time.
 * @example
 * ```ts
 * policyJsonSchema().type; // 'object'
 * ```
 */
export function policyJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(policyFileSchema, {
    target: 'draft-2020-12',
    io: 'input',
  });
}
