/**
 * The entry of the write guard for the pipeline (ADR 0029): planning and
 * committing, the step of the confirmation, and what the pipeline derives
 * from an intent for the result and the audit. The sealed plan and the
 * proof stay inside the write guard; the stores of plans and nonces reach
 * the composition root through the subpath `./composition`.
 *
 * @packageDocumentation
 */
export {
  type Confirmation,
  confirmationSentence,
  confirmWrite,
} from './confirm.js';
export { ContentRefusal } from './content-gate.js';
export {
  type CommitResult,
  createWriteGuard,
  type PlanRequest,
  type WriteClient,
  type WriteGuard,
  type WriteGuardOptions,
  writeSentences,
} from './guard.js';
export type { WriteTarget } from './rules.js';
