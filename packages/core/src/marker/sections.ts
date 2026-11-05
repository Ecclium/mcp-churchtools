/**
 * Finds the sections of a page that Ecclium wrote (ADR 0032).
 *
 * Where it stands in the way of a write: before the core adds a section,
 * it looks on the page for one it wrote before with the same marking, so
 * that it never adds the same twice, and a run of a routine (from phase 6
 * on) finds its own section of the period to change it. A section counts
 * as Ecclium's own only when the check code of its line fits its content.
 * A code that does not fit means a person changed the section; it is never
 * taken for a forgery, and Ecclium never replaces such a section.
 *
 * A section ends with its line of the marking, a paragraph of its own. It
 * starts after a blank line, at the earliest after the line of the
 * marking before it or at the start of the page. The line does not say
 * where, so the core tries the starts from the nearest one back, at most
 * {@link maxSectionStarts}, and the first whose canonical form gives the
 * code counts. A code has 64 bits, so trying a few hundred starts leaves a
 * chance of one in about 2^56 that a section someone else wrote passes.
 *
 * @packageDocumentation
 */
import { canonicalMarkdown } from '../content/index.js';
import type { KeyMaterial } from '../keys/index.js';
import { checkCodeOf, sameCheckCode } from './code.js';
import { type Marking, readMarkingLine } from './line.js';

/** The most starts of a section the core tries for one line. */
export const maxSectionStarts = 256;

/** The most lines of the marking the core looks at on one page. */
export const maxMarkings = 256;

/** A line of the marking on a page. */
export interface FoundMarking {
  /** What the line says. */
  readonly marking: Marking;
  /** The number of the line in the page, from 0. */
  readonly line: number;
}

/** What a page holds for the markings a write asks about. */
export type SectionJudgement =
  /** No line of the page has such a marking. */
  | { readonly kind: 'none' }
  /**
   * A section with such a marking whose code fits: Ecclium's own. `start`
   * and `end` are the numbers of its first line and of its line of the
   * marking.
   */
  | { readonly kind: 'own'; readonly start: number; readonly end: number }
  /** Such a marking, but its code fits no start: a person changed it. */
  | { readonly kind: 'changed' };

const isBlank = (line: string): boolean => line.trim() === '';

/** The lines of a page and which of them are blank. */
interface Lines {
  readonly lines: readonly string[];
  readonly blank: readonly boolean[];
}

// The lines of a page, without a carriage return before a line break.
const linesOf = (text: string): Lines => {
  const lines = text
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  return { lines, blank: lines.map(isBlank) };
};

const markingsIn = ({ lines, blank }: Lines): FoundMarking[] => {
  const found: FoundMarking[] = [];
  for (const [index, line] of lines.entries()) {
    if (found.length === maxMarkings) break;
    // A paragraph of its own: a blank line or the edge of the page on
    // both sides.
    if (index > 0 && !blank[index - 1]) continue;
    if (blank[index + 1] === false) continue;
    const marking = readMarkingLine(line);
    if (marking !== undefined) {
      found.push(Object.freeze({ marking, line: index }));
    }
  }
  return found;
};

/**
 * Finds the lines of the marking on a page, in the order of the page, at
 * most {@link maxMarkings}. A line counts only as a paragraph of its own.
 *
 * @param text - The text of the page.
 * @returns The lines, frozen.
 * @example
 * ```ts
 * findMarkings(page.text).map(({ marking }) => marking.code);
 * ```
 */
export function findMarkings(text: string): readonly FoundMarking[] {
  return Object.freeze(markingsIn(linesOf(text)));
}

/**
 * Judges the sections of a page with a marking a write asks about: none,
 * Ecclium's own, or changed by a person. With more than one such line, an
 * own section wins over a changed one, and the first own one counts.
 *
 * @param options - What to judge.
 * @param options.key - The key of the check codes.
 * @param options.tenantId - The tenant of the page.
 * @param options.text - The text of the page.
 * @param options.matches - Which markings the write asks about, such as
 *   an interactive one of a day with a given code.
 * @returns The judgement, frozen.
 * @example
 * ```ts
 * judgeSections({ key, tenantId, text: page.text, matches: (m) => sameCheckCode(m.code, code) });
 * // { kind: 'none' }
 * ```
 */
export function judgeSections(options: {
  readonly key: KeyMaterial;
  readonly tenantId: string;
  readonly text: string;
  readonly matches: (marking: Marking) => boolean;
}): SectionJudgement {
  const page = linesOf(options.text);
  let changed = false;
  // The earliest start: after the line of the marking before, or the
  // start of the page.
  let earliest = 0;
  for (const { marking, line } of markingsIn(page)) {
    if (options.matches(marking)) {
      const start = ownStart(options, page, earliest, line, marking);
      if (start !== undefined) {
        return Object.freeze({ kind: 'own', start, end: line });
      }
      changed = true;
    }
    earliest = line + 1;
  }
  return Object.freeze(changed ? { kind: 'changed' } : { kind: 'none' });
}

// The first line of the section before a line of the marking whose code
// fits, trying the starts after a blank line from the nearest one back.
const ownStart = (
  options: { readonly key: KeyMaterial; readonly tenantId: string },
  { lines, blank }: Lines,
  earliest: number,
  end: number,
  marking: Marking,
): number | undefined => {
  let tried = 0;
  for (let start = end - 1; start >= earliest; start -= 1) {
    if (blank[start]) continue;
    if (start > earliest && !blank[start - 1]) continue;
    if (tried === maxSectionStarts) return undefined;
    tried += 1;
    const canonical = canonicalMarkdown(lines.slice(start, end).join('\n'));
    if (
      canonical !== undefined &&
      sameCheckCode(
        checkCodeOf(options.key, options.tenantId, marking.origin, canonical),
        marking.code,
      )
    ) {
      return start;
    }
  }
  return undefined;
};
