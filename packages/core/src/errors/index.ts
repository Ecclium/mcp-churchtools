/**
 * Errors of the core: every thrown value becomes a stable code with one short
 * line for the model. Log and audit take only the code (ADR 0054).
 *
 * @packageDocumentation
 */
export {
  describeError,
  type ErrorDescription,
  fixedSentences,
  maxMessageLength,
  maxMissingRights,
} from './describe.js';
