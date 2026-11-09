/**
 * The content policy (ADR 0030): the checks every text passes before
 * Ecclium writes it to ChurchTools, and the form it is written in. The
 * write guard applies it while a write is planned. The entry point of
 * core does not export it.
 *
 * @packageDocumentation
 */
export {
  canonicalFormOf,
  canonicalMarkdown,
  canonicalOfWritten,
  type CanonicalPart,
  canonicalPartsOf,
} from './canonical.js';
export {
  checkMarkdown,
  checkPlainLines,
  checkPlainText,
  type ContentCheckOptions,
  type ContentCheckResult,
} from './check.js';
export {
  maxContentBytes,
  maxDelimiterSigns,
  normalizeContent,
  type NormalizedContent,
} from './normalize.js';
export { contactKey, contactKeyOf, contactKeysOf } from './scan.js';
export { serializeBlocks } from './serialize.js';
export type { Block, Inline } from './tree.js';
export {
  contentSentences,
  contentViolationKinds,
  type ContentViolationKind,
  orderViolations,
} from './violations.js';
