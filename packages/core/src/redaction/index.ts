/**
 * Redaction of results and error messages (ADR 0024): masks for contact
 * data and dates of birth, the cleaning of hidden characters, the data
 * envelope for free text, the mask of an answer of the escape hatch
 * (ADR 0067) and the check of free text in the level strict (ADR 0069).
 * The pipeline uses it; the registry and the mount read only which levels
 * use pseudonyms and their form, from `pseudonym-form.ts`. The entry point
 * of core does not export it.
 *
 * @packageDocumentation
 */
export {
  boundaryBytes,
  chooseBoundary,
  drawBoundary,
  maxBoundaryDraws,
  type RandomBytes,
  wrapInEnvelope,
} from './envelope.js';
export { freeTextMarkers, maskFreeText } from './free-text.js';
export {
  type FieldMask,
  fieldMask,
  foreignJsonCost,
  type ForeignJsonText,
  maskForeignText,
  maxForeignJsonCost,
  renderForeignJson,
} from './foreign-json.js';
export {
  maskBirthdate,
  maskedValue,
  maskEmail,
  maskLastName,
  maskPhone,
  minPhoneDigits,
  visiblePhoneDigits,
} from './mask.js';
export { maskErrorDescription, maskMessage } from './message.js';
export {
  isStrictLevel,
  pseudonymPattern,
  pseudonymTextLength,
} from './pseudonym-form.js';
export {
  cleanText,
  type CleanedText,
  hiddenCharactersNote,
  removeHiddenCharacters,
} from './unicode.js';
