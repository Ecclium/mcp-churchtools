/**
 * The confirmation of a write (ADR 0029): the step between planning and
 * committing where a person says yes.
 *
 * Where it stands in the way of a write: the pipeline calls it with every
 * sealed plan. It gives back a proof for exactly that plan, or says that a
 * confirmation is still needed. The ways a person confirms, a question to
 * the client, the echo and the queue of the operator, come with their own
 * decisions; until then no plan is confirmed, and every real call of a
 * write tool ends with `confirmation_required`. Tests of the pipeline
 * replace this module to reach the commit with a proof they issue.
 *
 * @packageDocumentation
 */
import type {
  PlannedWrite,
  TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';

import type { WriteProof } from './proof.js';

/** The sentence of a write that needs a confirmation this server cannot ask for. */
export const confirmationSentence =
  'The write needs a confirmation, which this server cannot ask for yet, so nothing was written.';

/** What the confirmation of a plan gives back. */
export type Confirmation =
  | { readonly kind: 'required' }
  | { readonly kind: 'proof'; readonly proof: WriteProof };

const required: Confirmation = Object.freeze({ kind: 'required' });

/**
 * Gets a sealed plan confirmed.
 *
 * @param ctx - The context of the call.
 * @param plan - The sealed plan.
 * @returns The proof for the plan, or that a confirmation is needed.
 * @example
 * ```ts
 * const confirmation = await confirmWrite(ctx, plan); // { kind: 'required' }
 * ```
 */
export function confirmWrite(
  // The ways of confirmation read both; until they exist, none does.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- see above
  ctx: TenantContext,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- see above
  plan: PlannedWrite,
): Promise<Confirmation> {
  return Promise.resolve(required);
}
