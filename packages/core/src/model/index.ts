/**
 * The way to a language model inside core (ADR 0033): the guard before
 * every adapter, the reading of the answers of a vendor and the rule of
 * the country of hosting and the basis of a transfer.
 *
 * @packageDocumentation
 */
export {
  type ModelAnswerReason,
  modelAnswerLimits,
  type ModelAnswerResult,
  parseModelJson,
  readModelAnswer,
} from './answer.js';
export {
  checkTransferBasis,
  isSwissOrEeaCountry,
  swissAndEeaCountries,
  type TransferBasis,
  transferBases,
  type TransferBasisProblem,
} from './countries.js';
export {
  type GuardedModel,
  type GuardedModelRequest,
  type GuardedPromptPart,
  guardModelProvider,
  type ModelGuardOptions,
} from './guard.js';
