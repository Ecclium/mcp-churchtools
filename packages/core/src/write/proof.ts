/**
 * The proof that a write may happen (ADR 0029).
 *
 * Where it stands in the way of a write: after a plan is sealed, the core
 * gets it confirmed, and only then issues a proof for exactly that plan.
 * Committing takes the plan and the proof and writes only when the proof
 * belongs to the plan, to its tenant and actor, came on a way the plan
 * allows and is at most 600 seconds old. A proof counts once: committing
 * uses it up, also when it then refuses.
 *
 * A proof comes from three sources only: a checked confirmation by the
 * client or by echo, the policy of an unattended run, and an approval of
 * the operator. Each source gets its own function with its way; until
 * they exist, only tests issue a proof, through a relative import. Like
 * the sealed plan, the proof is a class with private fields behind a key
 * that only this module holds, so that no tool and no plugin can make
 * one, and the package exports no way to make one for tests. Only the
 * place `writeGuard` imports this module. As with the sealed plan, this
 * protects against values, not against code in the same process that
 * loads this module by the URL of its file or changes built-in objects.
 *
 * @packageDocumentation
 */
import type {
  Actor,
  ConfirmationPath,
  PlannedWrite,
} from '@ecclium/mcp-churchtools-plugin-api';

import { confirmationPaths } from '../audit/schema.js';
import { planTtlMs } from './plan-store.js';
import { type PlanView, readPlan } from './sealed-plan.js';

/**
 * A proof as the commit takes it. The brand exists in the types only; the
 * commit checks at run time that this module issued it.
 */
export interface WriteProof {
  readonly __ecclium: 'WriteProof';
}

/** What a proof binds. */
export interface ProofView {
  /** The hash of the plan it confirms. */
  readonly planHash: string;
  /** The tenant of the plan. */
  readonly tenantId: string;
  /** The actor of the plan. */
  readonly actor: Actor;
  /** The way of the confirmation. */
  readonly path: ConfirmationPath;
  /** When it was issued, in milliseconds since the Unix epoch. */
  readonly issuedAt: number;
}

// The key of this module; no code outside it can get it.
const key: unique symbol = Symbol('ecclium.proof');

class Proof {
  readonly #proof: ProofView;
  #used = false;

  constructor(given: symbol, proof: ProofView) {
    if (given !== key) throw new TypeError('Only the core issues a proof.');
    this.#proof = proof;
    Object.freeze(this);
  }

  /**
   * Uses a proof of this module up and gives what it binds.
   *
   * @param given - The key of this module.
   * @param value - Any value.
   * @returns What the proof binds the first time, otherwise undefined.
   */
  static use(given: symbol, value: unknown): ProofView | undefined {
    if (given !== key || !Proof.is(value)) return undefined;
    if (value.#used) return undefined;
    value.#used = true;
    return value.#proof;
  }

  /**
   * Tells whether a value is a proof of this module, used or not.
   *
   * @param value - Any value.
   * @returns Whether it is one.
   */
  static is(value: unknown): value is Proof {
    // `#proof in` runs no code of the value; for a proxy it is false.
    return typeof value === 'object' && value !== null && #proof in value;
  }
}
Object.freeze(Proof.prototype);
Object.freeze(Proof);

// Whether a plan allows a way of confirmation. None for an intent the
// core does not run. Only the operator for one that always goes to the
// queue, such as an operation of the escape hatch. Otherwise the echo only
// where the plan was derived to allow it, the policy only for a write of
// the core that may run unattended, and the client and the operator for
// any plan that reaches them (ADR 0029, ADR 0071).
const allows = (plan: PlanView, path: ConfirmationPath): boolean => {
  const { rules } = plan;
  if (!rules.runs) return false;
  if (rules.alwaysQueue) return path === 'operator';
  switch (path) {
    case 'echo':
      return plan.echo;
    case 'policy':
      return rules.module === 'core' && rules.unattended === 'policy';
    case 'elicitation':
    case 'operator':
      return true;
  }
};

/**
 * Issues a proof for a sealed plan, on a way the plan allows.
 *
 * @param plan - The sealed plan, as a tool got it.
 * @param path - The way of the confirmation.
 * @param issuedAt - The time, in milliseconds since the Unix epoch.
 * @returns The proof, for this plan only.
 * @throws {TypeError} For a value that is no sealed plan, a way that is
 *   unknown or that the plan does not allow, and a time that is no number.
 * @example
 * ```ts
 * const proof = issueProof(plan, 'elicitation', clock.now());
 * ```
 */
export function issueProof(
  plan: PlannedWrite,
  path: ConfirmationPath,
  issuedAt: number,
): WriteProof {
  const view = readPlan(plan);
  if (view === undefined) throw new TypeError('No sealed plan.');
  if (!confirmationPaths.includes(path) || !allows(view, path)) {
    throw new TypeError('The plan does not allow this way of confirmation.');
  }
  if (!Number.isFinite(issuedAt)) throw new TypeError('No time.');
  const proof = new Proof(
    key,
    Object.freeze({
      planHash: view.planHash,
      tenantId: view.tenantId,
      actor: view.actor,
      path,
      issuedAt,
    }),
  );
  return proof as unknown as WriteProof;
}

/**
 * Uses a proof up for a plan: the first use gives its way when the proof
 * was issued for this plan, its tenant and its actor, the plan still
 * allows the way, and the proof is at most 600 seconds old, as long as a
 * confirmation lives. Every later use gives undefined, and so does a value
 * that is no proof. A proof that does not fit is used up all the same.
 *
 * @param value - Any value, such as the proof a commit got.
 * @param plan - The plan as the commit derived it again.
 * @param now - The time of the commit, in milliseconds since the Unix
 *   epoch.
 * @returns The way of the confirmation, or undefined.
 * @example
 * ```ts
 * const path = useProof(proof, plan, clock.now());
 * if (path === undefined) return refused('confirmation_required');
 * ```
 */
export function useProof(
  value: unknown,
  plan: PlanView,
  now: number,
): ConfirmationPath | undefined {
  const proof = Proof.use(key, value);
  if (proof === undefined) return undefined;
  const age = now - proof.issuedAt;
  const bound =
    proof.planHash === plan.planHash &&
    proof.tenantId === plan.tenantId &&
    proof.actor.kind === plan.actor.kind &&
    proof.actor.id === plan.actor.id &&
    // A clock that went back or failed gives no age, and nothing counts.
    Number.isFinite(age) &&
    age >= 0 &&
    age <= planTtlMs;
  return bound && allows(plan, proof.path) ? proof.path : undefined;
}

/**
 * Tells whether a value is a proof this module issued, without using it.
 *
 * @param value - Any value.
 * @returns Whether it is one.
 * @example
 * ```ts
 * isProof({ __ecclium: 'WriteProof' }); // false
 * ```
 */
export function isProof(value: unknown): boolean {
  return Proof.is(value);
}
