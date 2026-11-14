/**
 * The corpus of prompt injections and a model that obeys them, for the
 * tests that show the checks of a run without a model (ADR 0030, ADR
 * 0033).
 *
 * @packageDocumentation
 */
export {
  type InjectionCase,
  injectionCorpus,
  type InjectionExpectation,
  type InjectionKind,
  type InjectionObedience,
} from './corpus.js';
export {
  createObedientModel,
  heardCases,
  heardText,
  obeyedEntry,
  type ObedientModel,
  type ObedientModelOptions,
} from './obey.js';
