/**
 * The sealed plan (ADR 0029): what a write will do, fixed when it is
 * planned and bound to tenant, actor and tool.
 *
 * Where it stands in the way of a write: planning ends by sealing a plan
 * here, and everything after works on it. The tool gets it back as an
 * opaque value and returns it; a confirmation, the queue and the commit
 * all name its hash. The commit derives the plan again from the state of
 * the target and writes only when the two hashes are equal.
 *
 * Why a class with a private field: a plugin is compiled apart from the
 * core, so a type alone proves nothing at run time. A private field
 * cannot be read, set or faked from outside the class, and `#plan in
 * value` tells a plan of this module from anything that only looks like
 * one, a proxy included. The constructor and the reader take a key that
 * only this module holds, and class and prototype are frozen, so that a
 * tool that reaches the class through `plan.constructor` can neither make
 * a plan nor read one. Only the place `writeGuard` imports this module.
 *
 * This protects against values a tool hands back, not against code that
 * runs in the same process: a plugin that loads this module by the URL of
 * its file, or changes built-in objects, gets past it. Against that only
 * the choice of plugins the operator admits helps.
 *
 * @packageDocumentation
 */
import type {
  Actor,
  IsoDate,
  PlannedWrite,
  Reversible,
  Sensitivity,
  UnattendedRule,
  WriteIntent,
} from '@ecclium/mcp-churchtools-plugin-api';

import { readIntent } from './intent.js';
import { planHashOf } from './plan-hash.js';
import {
  echoAllowed,
  type IntentRules,
  rulesOf,
  type ToolOrigin,
  withToolMeta,
} from './rules.js';

/** What a plan is sealed from. */
export interface PlanInput {
  /** The tenant of the call that planned. */
  readonly tenantId: string;
  /** The actor of the call that planned. */
  readonly actor: Actor;
  /** The name of the tool that planned. */
  readonly tool: string;
  /** Who brings the tool, as the catalog records it. */
  readonly origin: ToolOrigin;
  /** The intent; sealing checks and copies it again. */
  readonly intent: WriteIntent;
  /**
   * Sensitivity and the rule for running unattended of the tool, which
   * can only make the rules of the intent stricter.
   */
  readonly toolMeta: {
    readonly sensitivity: Sensitivity;
    readonly unattended: UnattendedRule;
    readonly reversible?: Reversible;
  };
  /** The hash of the new content. */
  readonly contentHash: string;
  /** When the plan was sealed, in milliseconds since the Unix epoch. */
  readonly sealedAt: number;
  /**
   * For a new page or a section, the UTC day its line of the marking names
   * (ADR 0032): the day it was first planned, kept through the commit and
   * an approval from the queue, so that every plan of it has the same text.
   */
  readonly day?: IsoDate;
  /**
   * Whether the core keeps snapshots of writes (ADR 0031). Without them no
   * write can be taken back, so the plan is sealed as not reversible and
   * the echo allows none.
   */
  readonly snapshots: boolean;
  /**
   * For a write of a run of a routine, the run it comes from (ADR 0032):
   * routine and period name its line of the marking, and the contact
   * values its text may hold besides those of the policy. Only such a plan
   * may get the proof of the policy.
   */
  readonly run?: PlanRun;
}

/** The run a plan of a write of a routine comes from. */
export interface PlanRun {
  /** The ID of the routine. */
  readonly routine: string;
  /** The period of the run, such as `2026-W46`. */
  readonly period: string;
  /**
   * The keys of the contact values from the data of the run that the text
   * holds, so that an approval checks the text as the run did (ADR 0030).
   */
  readonly contacts: readonly string[];
}

/** A sealed plan as the place `writeGuard` reads it. */
export interface PlanView {
  /** The tenant of the call that planned. */
  readonly tenantId: string;
  /** The actor of the call that planned, a frozen copy. */
  readonly actor: Actor;
  /** The name of the tool that planned. */
  readonly tool: string;
  /** Who brings the tool. */
  readonly origin: ToolOrigin;
  /** The checked, frozen copy of the intent. */
  readonly intent: WriteIntent;
  /** The rules of the intent with the metadata of the tool applied. */
  readonly rules: IntentRules;
  /** The version the write is based on, from the intent, or null. */
  readonly baseVersion: number | null;
  /** The hash of the new content. */
  readonly contentHash: string;
  /** When the plan was sealed. */
  readonly sealedAt: number;
  /** The UTC day of the marking, for a new page or a section. */
  readonly day?: IsoDate;
  /** For a write of a run of a routine, the run, frozen. */
  readonly run?: PlanRun;
  /** The hash of the plan, computed when it was sealed. */
  readonly planHash: string;
  /** Whether the plan may be confirmed by echo, derived, never given. */
  readonly echo: boolean;
}

// The key of this module. Only code that holds it can make or read a plan,
// and no code outside this module can get it.
const key: unique symbol = Symbol('ecclium.sealed-plan');

class SealedPlan {
  readonly #plan: PlanView;

  constructor(given: symbol, plan: PlanView) {
    if (given !== key) throw new TypeError('Only the core seals a plan.');
    this.#plan = plan;
    Object.freeze(this);
  }

  /**
   * Reads a plan of this module.
   *
   * @param given - The key of this module.
   * @param value - Any value.
   * @returns The fields of the plan, or undefined for anything else.
   */
  static read(given: symbol, value: unknown): PlanView | undefined {
    if (given !== key) return undefined;
    // `#plan in` runs no code of the value; for a proxy it is false.
    return typeof value === 'object' && value !== null && #plan in value
      ? value.#plan
      : undefined;
  }
}
Object.freeze(SealedPlan.prototype);
Object.freeze(SealedPlan);

/**
 * Seals a plan. The intent is checked and copied again, and its rules,
 * its base version, the hash of the plan and whether the echo is allowed
 * are derived here, never taken from the caller. An intent that this
 * version of the core does not run is not sealed.
 *
 * @param input - Tenant, actor, tool, origin, intent, metadata of the
 *   tool, hash of the content and the time.
 * @returns The plan as the opaque value a tool gets.
 * @throws {TypeError} For an intent that does not fit its kind or that
 *   the core does not run, and when the hash cannot be computed.
 * @example
 * ```ts
 * const plan = sealPlan({ tenantId, actor, tool, origin: 'core', intent,
 *   toolMeta: { sensitivity: 'personal', unattended: 'policy' },
 *   contentHash, sealedAt: clock.now(), snapshots: true });
 * readPlan(plan)?.planHash; // 64 hex digits
 * ```
 */
export function sealPlan(input: PlanInput): PlannedWrite {
  const intent = readIntent(input.intent);
  if (intent === undefined) throw new TypeError('The intent does not fit.');
  const metaRules = withToolMeta(rulesOf(intent), input.toolMeta);
  // Undone from a snapshot only while there are snapshots (ADR 0031).
  const rules =
    metaRules.reversible === 'snapshot' && !input.snapshots
      ? Object.freeze({ ...metaRules, reversible: 'no' as const })
      : metaRules;
  if (!rules.runs) throw new TypeError('The core does not run this intent.');
  const baseVersion = 'baseVersion' in intent ? intent.baseVersion : null;
  const actor = Object.freeze({
    kind: input.actor.kind,
    id: input.actor.id,
  });
  const planHash = planHashOf({
    tenantId: input.tenantId,
    actorKind: actor.kind,
    actorId: actor.id,
    tool: input.tool,
    intentKind: intent.kind,
    targetKind: rules.target.kind,
    targetKey: rules.target.key,
    baseVersion,
    contentHash: input.contentHash,
  });
  const view: PlanView = Object.freeze({
    tenantId: input.tenantId,
    actor,
    tool: input.tool,
    origin: input.origin,
    intent,
    rules,
    baseVersion,
    contentHash: input.contentHash,
    sealedAt: input.sealedAt,
    ...(input.day === undefined ? {} : { day: input.day }),
    ...(input.run === undefined
      ? {}
      : {
          run: Object.freeze({
            routine: input.run.routine,
            period: input.run.period,
            contacts: Object.freeze([...input.run.contacts]),
          }),
        }),
    planHash,
    echo: echoAllowed(rules, input.origin),
  });
  return new SealedPlan(key, view) as unknown as PlannedWrite;
}

/**
 * Reads a plan this module sealed. Anything else, a copy, a lookalike or
 * a proxy of a plan included, gives undefined.
 *
 * @param value - Any value, such as what a tool returned.
 * @returns The fields of the plan, frozen, or undefined.
 * @example
 * ```ts
 * const view = readPlan(outcome.plan);
 * if (view === undefined) throw new EccliumError('internal');
 * ```
 */
export function readPlan(value: unknown): PlanView | undefined {
  return SealedPlan.read(key, value);
}

/**
 * Tells whether a value is a plan this module sealed.
 *
 * @param value - Any value.
 * @returns Whether it is one.
 * @example
 * ```ts
 * isSealedPlan({ __ecclium: 'PlannedWrite' }); // false
 * ```
 */
export function isSealedPlan(value: unknown): boolean {
  return readPlan(value) !== undefined;
}
