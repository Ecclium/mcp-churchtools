/**
 * The marking of what Ecclium adds to the wiki (ADR 0032): the check code,
 * the line with the fixed wording of the brand, and how the core finds its
 * own sections on a page. The entry point of core does not export it.
 *
 * @packageDocumentation
 */
export {
  base32,
  checkCodeOf,
  checkCodePrefix,
  checkCodeSigns,
  type MarkingOrigin,
  sameCheckCode,
} from './code.js';
export { type Marking, markingLineOf, readMarkingLine } from './line.js';
export {
  type FoundMarking,
  findMarkings,
  judgeSections,
  maxMarkings,
  maxSectionStarts,
  type SectionJudgement,
} from './sections.js';
