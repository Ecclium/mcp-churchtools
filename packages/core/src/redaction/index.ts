/**
 * Redaction of results and error messages (ADR 0024): masks for contact
 * data and dates of birth, the cleaning of hidden characters and the data
 * envelope for free text. Only the pipeline uses it; the entry point of
 * core does not export it.
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
export {
  maskBirthdate,
  maskedValue,
  maskEmail,
  maskPhone,
  minPhoneDigits,
  visiblePhoneDigits,
} from './mask.js';
export { maskErrorDescription, maskMessage } from './message.js';
export {
  cleanText,
  type CleanedText,
  hiddenCharactersNote,
  removeHiddenCharacters,
} from './unicode.js';
