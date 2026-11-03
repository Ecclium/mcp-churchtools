/**
 * The confirmation of a write (ADR 0029): the step between planning and
 * committing where a person says yes.
 *
 * Where it stands in the way of a write: the pipeline gets a sealed plan
 * and its text from the write guard and asks here which way confirms it.
 * The ways come in the order of ADR 0029:
 *
 * 1. **A question to the client** (elicitation), when the client declared
 *    it in form mode and the diff fits into a dialog. The plan waits in the
 *    `PlanStore`, the client gets the question, and the second round of the
 *    call brings the answer. Only a yes issues a proof, for exactly that
 *    plan.
 * 2. **The echo**, where the setting and the plan allow it: a write of a
 *    tool of the core that can be taken back and is not special.
 * 3. **The queue of the operator** for every other plan, and for every plan
 *    with the setting `queue`.
 *
 * A decline, a cancel, an answer that does not fit and a question nobody
 * answers write nothing and queue nothing. For the echo, the result of the
 * write tool carries a token and the summary, and `ct_write_confirm`
 * brings both back: the core checks the token, uses up its nonce, takes
 * the plan and issues a proof of the echo only when the summary is the one
 * it made and the plan still allows the echo. The queue comes with its own
 * change; until then a plan that needs it ends with `confirmation_required`.
 *
 * Every refusal here carries a fixed sentence and the code
 * `confirmation_required` or `policy_denied`, which the audit counts as
 * refused, never as an error.
 *
 * @packageDocumentation
 */
import {
  type Clock,
  EccliumError,
  type NonceStore,
  type PlannedWrite,
  type PlanStore,
  type TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';

import type { WriteConfirmation } from '../config/index.js';
import type { RandomBytes } from '../redaction/envelope.js';
import {
  type ConfirmationForm,
  type ConfirmationText,
  confirmationForm,
  confirmationMessage,
  isConfirmed,
} from './confirmation-text.js';
import { echoTokenTtlMs, mintEchoToken, readEchoToken } from './echo-token.js';
import { nonceTtlMs } from './nonce-store.js';
import { planTtlMs } from './plan-store.js';
import { issueProof, type WriteProof } from './proof.js';
import {
  argumentsDigestOf,
  type ConfirmationState,
  confirmationStateVersion,
  principalDigestOf,
  readConfirmationState,
} from './request-state.js';
import { readPlan } from './sealed-plan.js';

/** The sentence of a write that needs a way of confirmation that is not built yet. */
export const confirmationSentence =
  'The write needs a confirmation, which this server cannot ask for yet, so nothing was written.';

/**
 * The sentence of a write that waits for the person to answer the question
 * in the client. The model reads it only from a mount that cannot ask.
 */
export const questionSentence =
  'The write waits for the person to confirm it in the client, so nothing was written yet.';

/**
 * The sentences the model reads when a question does not end in a write.
 * Each says to plan again where that is the way on.
 */
export const confirmationSentences = Object.freeze({
  notConfirmed: 'The person did not confirm the write, so nothing was written.',
  notThisCall:
    'The answer does not belong to this call, so nothing was written. Plan the write again.',
  used: 'This confirmation was used already, so nothing was written. Plan the write again.',
  gone: 'The plan of this write is no longer kept, so nothing was written. Plan the write again.',
  tooMany:
    'Too many writes wait for a confirmation on this server. Answer them or wait ten minutes.',
  echoToken:
    'The token is not valid or has expired, so nothing was written. Plan the write again.',
  echoSummary:
    'The summary does not match the planned write, so nothing was written. Plan the write again and send its summary exactly as the write tool returns it.',
  echoRefused:
    'This write cannot be confirmed with ct_write_confirm, so nothing was written. It needs a question to the person in the client or the approval of the operator.',
} as const);

/** The way a plan gets confirmed (ADR 0029). */
export type ConfirmationWay = 'question' | 'echo' | 'queue';

/** What decides the way of a plan besides the plan itself. */
export interface WayFacts {
  /** The setting of the server, `ECCLIUM_WRITE_CONFIRMATION`. */
  readonly setting: WriteConfirmation;
  /** Whether the client declared elicitation in form mode. */
  readonly elicitation: boolean;
  /** Whether the diff of the plan fits into a question. */
  readonly fits: boolean;
}

/**
 * Picks the way that confirms a plan, in the order of ADR 0029: a question
 * when the client can, else the echo where the setting and the plan allow
 * it, else the queue. A diff too long for a dialog goes to the queue and
 * not to the echo, because the echo shows the person only the summary. A
 * plan that only the operator may confirm, and every plan with the setting
 * `queue`, goes to the queue.
 *
 * @param facts - Setting, capability of the client and fit of the diff.
 * @param plan - The sealed plan.
 * @returns The way.
 * @throws {TypeError} For a value that is no sealed plan.
 * @example
 * ```ts
 * confirmationWayOf({ setting: 'echo-allowed', elicitation: true,
 *   fits: true }, plan); // 'question'
 * ```
 */
export function confirmationWayOf(
  facts: WayFacts,
  plan: PlannedWrite,
): ConfirmationWay {
  const view = readPlan(plan);
  if (view === undefined) throw new TypeError('No sealed plan.');
  if (facts.setting === 'queue' || view.rules.alwaysQueue) return 'queue';
  // A diff too long for a dialog goes to the queue on every way: the echo
  // hands the diff to the model, and the result of a call is bounded too.
  if (!facts.fits) return 'queue';
  if (facts.elicitation) return 'question';
  return facts.setting === 'echo-allowed' && view.echo ? 'echo' : 'queue';
}

/** A question to the client, as the mount turns it into `input_required`. */
export interface ConfirmationQuestion {
  /** The message, in German, with summary and diff. */
  readonly message: string;
  /** The form with its one field. */
  readonly form: ConfirmationForm;
  /** What the mount signs as the `requestState`. */
  readonly state: ConfirmationState;
}

/**
 * The answer of the client in the second round of a call, as the mount
 * read it: the state it verified, the action and, for an accept, the
 * content. `missing` stands for an answer the client did not send.
 */
export interface ConfirmationAnswer {
  /** The `requestState` as the codec of the mount returned it. */
  readonly state: unknown;
  /** What the person chose. */
  readonly action: 'accept' | 'decline' | 'cancel' | 'missing';
  /** The content of an accept, as the client sent it. */
  readonly content?: unknown;
}

/** How asking ended. */
export type AskResult =
  | { readonly kind: 'question'; readonly question: ConfirmationQuestion }
  | { readonly kind: 'refused'; readonly error: EccliumError };

/** How a token of the echo was made. */
export type EchoResult =
  | { readonly kind: 'token'; readonly token: string }
  | { readonly kind: 'refused'; readonly error: EccliumError };

/** How an answer ended. */
export type AnswerResult =
  | {
      readonly kind: 'confirmed';
      /** The plan the answer confirmed, as the first round kept it. */
      readonly plan: PlannedWrite;
      /** The proof for exactly that plan. */
      readonly proof: WriteProof;
    }
  | { readonly kind: 'refused'; readonly error: EccliumError };

/** The questions of one pipeline. */
export interface Confirmations {
  /**
   * Keeps a plan for its question and makes the question.
   *
   * @param ctx - The context of the call that planned.
   * @param plan - The sealed plan.
   * @param input - The input of the call, as its schema parsed it.
   * @param text - The text of the confirmation of the plan.
   * @returns The question, or why there is none.
   */
  ask(
    ctx: TenantContext,
    plan: PlannedWrite,
    input: unknown,
    text: ConfirmationText,
  ): Promise<AskResult>;
  /**
   * Takes the answer of the second round: checks that it belongs to this
   * call, uses up its nonce, takes the plan from the store and issues a
   * proof only for a yes.
   *
   * @param ctx - The context of the second round.
   * @param tool - The name of the tool called.
   * @param input - The input of the call, as its schema parsed it.
   * @param answer - The answer as the mount read it.
   * @returns The plan with its proof, or why there is none.
   */
  answer(
    ctx: TenantContext,
    tool: string,
    input: unknown,
    answer: ConfirmationAnswer,
  ): Promise<AnswerResult>;
  /**
   * Keeps a plan for its confirmation by echo and makes its token.
   *
   * @param ctx - The context of the call that planned.
   * @param plan - The sealed plan, one that allows the echo.
   * @param text - The text of the confirmation of the plan.
   * @returns The token, or why there is none.
   */
  echo(
    ctx: TenantContext,
    plan: PlannedWrite,
    text: ConfirmationText,
  ): Promise<EchoResult>;
  /**
   * Takes a token and a summary that `ct_write_confirm` brought back:
   * checks the token and its time, uses up its nonce, takes the plan and
   * issues a proof of the echo only for the summary the core made and a
   * plan that still allows the echo.
   *
   * @param ctx - The context of the call of `ct_write_confirm`.
   * @param token - The token as the call sent it.
   * @param summary - The summary as the call sent it.
   * @returns The plan with its proof, or why there is none.
   */
  confirmEcho(
    ctx: TenantContext,
    token: unknown,
    summary: unknown,
  ): Promise<AnswerResult>;
}

/** What the questions of a pipeline are built from. */
export interface ConfirmationsOptions {
  /** The store of plans, in memory over stdio (ADR 0029). */
  readonly plans: PlanStore;
  /** The store of used nonces, in memory over stdio (ADR 0029). */
  readonly nonces: NonceStore;
  /** The clock of the process. */
  readonly clock: Clock;
  /** The source of random bytes for the nonces. */
  readonly random: RandomBytes;
}

const refused = (
  code: 'confirmation_required' | 'policy_denied',
  sentence: string,
): { readonly kind: 'refused'; readonly error: EccliumError } =>
  Object.freeze({ kind: 'refused', error: new EccliumError(code, sentence) });

const notThisCall = refused(
  'confirmation_required',
  confirmationSentences.notThisCall,
);

// A summary as the model may send it back: with the markers of the data
// envelope around it, as the result carried it, or without them.
const unwrapped = (summary: string): string => {
  const open = summary.indexOf('>>');
  if (!summary.startsWith('<<data-') || open < 0) return summary;
  const close = `<</${summary.slice(2, open)}>>`;
  return summary.endsWith(close) && summary.length >= open + 2 + close.length
    ? summary.slice(open + 2, summary.length - close.length)
    : summary;
};

const hexOf = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/**
 * Makes the questions of one pipeline over its stores. They keep no state
 * of their own beyond a random key for the hashes of their states: the
 * plans wait in the `PlanStore` and the used nonces sit in the
 * `NonceStore`, both bound to tenant and actor.
 *
 * @param options - Stores, clock and source of random bytes.
 * @returns The questions, frozen.
 * @example
 * ```ts
 * const confirmations = createConfirmations({ plans, nonces, clock,
 *   random: randomBytes });
 * const asked = await confirmations.ask(ctx, plan, input, text);
 * ```
 */
export function createConfirmations(
  options: ConfirmationsOptions,
): Confirmations {
  const { plans, nonces, clock, random } = options;
  // The key of the hashes in the states of this pipeline: random, never
  // stored and never sent, so that the client cannot test guesses.
  const key = random(32);
  // The key of the tokens of the echo, apart from the one of the hashes.
  const tokenKey = random(32);
  const summaryDigest = (summary: string): string =>
    argumentsDigestOf(key, { echoSummary: summary });

  const ask = async (
    ctx: TenantContext,
    plan: PlannedWrite,
    input: unknown,
    text: ConfirmationText,
  ): Promise<AskResult> => {
    const view = readPlan(plan);
    if (view === undefined) throw new TypeError('No sealed plan.');
    const nonce = hexOf(random(16));
    // The plan lives as long as the requestState that names it.
    const kept = await plans.put(ctx, view.planHash, plan, planTtlMs);
    if (kept === 'full') {
      ctx.log.warn('write_plans_full', { code: 'policy_denied' });
      return refused('policy_denied', confirmationSentences.tooMany);
    }
    const state: ConfirmationState = Object.freeze({
      v: confirmationStateVersion,
      tool: view.tool,
      planHash: view.planHash,
      nonce,
      principal: principalDigestOf(key, ctx.tenantId, ctx.actor),
      arguments: argumentsDigestOf(key, input),
    });
    return Object.freeze({
      kind: 'question',
      question: Object.freeze({
        message: confirmationMessage(text),
        form: confirmationForm(),
        state,
      }),
    });
  };

  // A store that rejects counts as one that says no: a nonce as used, a
  // plan as gone.
  const consumed = async (
    ctx: TenantContext,
    nonce: string,
  ): Promise<boolean> => {
    try {
      return (await nonces.consume(ctx, nonce, nonceTtlMs)) === 'fresh';
    } catch {
      return false;
    }
  };
  const taken = async (
    ctx: TenantContext,
    planHash: string,
  ): Promise<PlannedWrite | undefined> => {
    try {
      return await plans.take(ctx, planHash);
    } catch {
      return undefined;
    }
  };

  const answer = async (
    ctx: TenantContext,
    tool: string,
    input: unknown,
    given: ConfirmationAnswer,
  ): Promise<AnswerResult> => {
    const state = readConfirmationState(given.state);
    if (
      state === undefined ||
      state.tool !== tool ||
      state.principal !== principalDigestOf(key, ctx.tenantId, ctx.actor) ||
      state.arguments !== argumentsDigestOf(key, input)
    ) {
      ctx.log.warn('write_answer_refused', { code: 'confirmation_required' });
      return notThisCall;
    }
    // The nonce first, so that a second answer with the same state never
    // reaches the plan; the plan next, also for a no, so that no answer
    // after it finds the plan again.
    if (!(await consumed(ctx, state.nonce))) {
      ctx.log.warn('write_answer_replayed', { code: 'confirmation_required' });
      return refused('confirmation_required', confirmationSentences.used);
    }
    // A store that gives another value than the plan asked about, as a
    // replaced store could, gives none; the hash binds tool and input as
    // well (ADR 0029).
    const plan = await taken(ctx, state.planHash);
    if (plan === undefined || readPlan(plan)?.planHash !== state.planHash) {
      ctx.log.warn('write_plan_gone', { code: 'confirmation_required' });
      return refused('confirmation_required', confirmationSentences.gone);
    }
    if (given.action !== 'accept' || !isConfirmed(given.content)) {
      ctx.log.info('write_not_confirmed', { code: 'confirmation_required' });
      return refused(
        'confirmation_required',
        confirmationSentences.notConfirmed,
      );
    }
    try {
      const proof = issueProof(plan, 'elicitation', clock.now());
      return Object.freeze({ kind: 'confirmed', plan, proof });
    } catch {
      // A plan that only the operator may confirm is never asked about;
      // should one get here, a yes of the client confirms nothing.
      return refused(
        'confirmation_required',
        confirmationSentences.notConfirmed,
      );
    }
  };

  const echo = async (
    ctx: TenantContext,
    plan: PlannedWrite,
    text: ConfirmationText,
  ): Promise<EchoResult> => {
    const view = readPlan(plan);
    if (view === undefined) throw new TypeError('No sealed plan.');
    const nonce = hexOf(random(16));
    const kept = await plans.put(ctx, view.planHash, plan, planTtlMs);
    if (kept === 'full') {
      ctx.log.warn('write_plans_full', { code: 'policy_denied' });
      return refused('policy_denied', confirmationSentences.tooMany);
    }
    const token = mintEchoToken(tokenKey, {
      v: 1,
      planHash: view.planHash,
      nonce,
      principal: principalDigestOf(key, ctx.tenantId, ctx.actor),
      summary: summaryDigest(text.summary),
      issuedAt: clock.now(),
    });
    return Object.freeze({ kind: 'token', token });
  };

  const confirmEcho = async (
    ctx: TenantContext,
    token: unknown,
    summary: unknown,
  ): Promise<AnswerResult> => {
    const claims = readEchoToken(tokenKey, token);
    const age =
      claims === undefined ? Number.NaN : clock.now() - claims.issuedAt;
    // A clock that went back or failed gives no age, and no token counts.
    if (
      claims === undefined ||
      !(age >= 0 && age < echoTokenTtlMs) ||
      claims.principal !== principalDigestOf(key, ctx.tenantId, ctx.actor)
    ) {
      ctx.log.warn('write_echo_refused', { code: 'confirmation_required' });
      return refused('confirmation_required', confirmationSentences.echoToken);
    }
    // The nonce first, so that a token counts once, also when its summary
    // was wrong; the plan next, so that no later token finds it.
    if (!(await consumed(ctx, claims.nonce))) {
      ctx.log.warn('write_answer_replayed', { code: 'confirmation_required' });
      return refused('confirmation_required', confirmationSentences.used);
    }
    const plan = await taken(ctx, claims.planHash);
    const view = readPlan(plan);
    if (plan === undefined || view?.planHash !== claims.planHash) {
      ctx.log.warn('write_plan_gone', { code: 'confirmation_required' });
      return refused('confirmation_required', confirmationSentences.gone);
    }
    if (
      typeof summary !== 'string' ||
      summaryDigest(unwrapped(summary)) !== claims.summary
    ) {
      ctx.log.warn('write_echo_refused', { code: 'confirmation_required' });
      return refused(
        'confirmation_required',
        confirmationSentences.echoSummary,
      );
    }
    // The plan decides again whether the echo may confirm it: a tool of the
    // core, a write that can be taken back, nothing special (ADR 0029).
    if (!view.echo) {
      ctx.log.warn('write_echo_refused', { code: 'confirmation_required' });
      return refused(
        'confirmation_required',
        confirmationSentences.echoRefused,
      );
    }
    const proof = issueProof(plan, 'echo', clock.now());
    return Object.freeze({ kind: 'confirmed', plan, proof });
  };

  return Object.freeze({ ask, answer, echo, confirmEcho });
}
