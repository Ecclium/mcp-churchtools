/**
 * The entry of the write guard for the pipeline (ADR 0029): planning,
 * committing and taking back (ADR 0031), the ways of the confirmation with
 * their text and the state of a question, the entry of the queue of
 * approvals made from a plan, and what the pipeline derives from an intent
 * for the result and the audit. The sealed plan and the
 * proof stay inside the write guard; the stores of plans and nonces reach
 * the composition root through the subpath `./composition`.
 *
 * @packageDocumentation
 */
export {
  type AnswerResult,
  type AskResult,
  type ConfirmationAnswer,
  type ConfirmationQuestion,
  type ConfirmationRoute,
  confirmationRouteOf,
  confirmationSentence,
  confirmationSentences,
  type Confirmations,
  type ConfirmationWay,
  confirmationWayOf,
  createConfirmations,
  questionSentence,
} from './confirm.js';
export {
  type ConfirmationForm,
  type ConfirmationText,
  confirmationField,
} from './confirmation-text.js';
export type { ConfirmationState } from './request-state.js';
export { ContentRefusal } from './content-gate.js';
export {
  type ApprovedEntry,
  type ApproveRequest,
  type ApproveResult,
  type CommitResult,
  createWriteGuard,
  type PlanQueueReason,
  type PlanRequest,
  type UndoChange,
  type UndoRequest,
  type UndoResult,
  type WriteClient,
  type WriteGuard,
  type WriteGuardOptions,
  type WriteSnapshots,
  writeSentences,
} from './guard.js';
export { approvalKeyOf } from './plan-hash.js';
export { queueEntryOf } from './queue-entry.js';
export { objectRefsOfTarget, type WriteTarget } from './rules.js';
