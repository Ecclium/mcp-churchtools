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
 * The page is read once into its blocks of the top level, as a reader sees
 * them (`canonicalPartsOf`). A line of the marking is a paragraph of the
 * top level on one line, so a line inside a comment, a block of code, a
 * quote or a list is none. A section ends before its line and starts at a
 * block after the line of the marking before it, or at the start of the
 * page. The line does not say where, so the core tries the starts from
 * the nearest block back, at most {@link maxSectionStarts}, and the first
 * whose canonical form gives the code counts. A code has 64 bits, so
 * trying a few hundred starts leaves a chance of one in about 2^56 that a
 * section someone else wrote passes.
 *
 * Whatever the core cannot judge counts as changed, never as absent, so
 * that a write goes to the operator rather than twice: a page with HTML
 * that could hide a section, more lines of the marking a write asks about
 * than {@link maxJudgedMarkings}, and a page the lexer cannot read.
 *
 * @packageDocumentation
 */
import {
  type Block,
  type CanonicalPart,
  canonicalFormOf,
  canonicalPartsOf,
} from '../content/index.js';
import type { KeyMaterial } from '../keys/index.js';
import { checkCodeOf, sameCheckCode } from './code.js';
import { type Marking, readMarkingLine } from './line.js';

/** The most starts of a section the core tries for one line. */
export const maxSectionStarts = 256;

/** The most lines of the marking that match a write the core judges on one page. */
export const maxJudgedMarkings = 16;

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
  /**
   * Such a marking, but its code fits no start, or the core cannot judge
   * the page: a person changed it, or may have.
   */
  | { readonly kind: 'changed' };

/** A block of the page with the number of its first line. */
interface PagePart extends CanonicalPart {
  readonly first: number;
}

/** A line of the marking with the place of its block among the parts. */
interface PlacedMarking extends FoundMarking {
  readonly index: number;
}

const partsOf = (text: string): readonly PagePart[] | undefined => {
  const parts = canonicalPartsOf(text);
  if (parts === undefined) return undefined;
  let first = 0;
  return parts.map((part) => {
    const placed = { ...part, first };
    first += part.breaks;
    return placed;
  });
};

const markingsOf = (parts: readonly PagePart[]): readonly PlacedMarking[] =>
  parts.flatMap((part, index) => {
    const marking =
      part.type === 'paragraph' && part.line !== undefined
        ? readMarkingLine(part.line)
        : undefined;
    return marking === undefined
      ? []
      : [Object.freeze({ marking, line: part.first, index })];
  });

// The lines of a page the lexer cannot read that read as a marking, only
// to tell whether one matches.
const linesOf = (text: string): readonly Marking[] =>
  text.split('\n').flatMap((line) => {
    const marking = readMarkingLine(line);
    return marking === undefined ? [] : [marking];
  });

/**
 * Finds the lines of the marking on a page, in the order of the page. A
 * line counts only as a paragraph of the top level on one line.
 *
 * @param text - The text of the page.
 * @returns The lines, frozen; none for a page the lexer cannot read.
 * @example
 * ```ts
 * findMarkings(page.text).map(({ marking }) => marking.code);
 * ```
 */
export function findMarkings(text: string): readonly FoundMarking[] {
  const parts = partsOf(text);
  return Object.freeze(
    parts === undefined
      ? []
      : markingsOf(parts).map(({ marking, line }) =>
          Object.freeze({ marking, line }),
        ),
  );
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
  const changed: SectionJudgement = Object.freeze({ kind: 'changed' });
  const parts = partsOf(options.text);
  if (parts === undefined) {
    return linesOf(options.text).some(options.matches)
      ? changed
      : Object.freeze({ kind: 'none' });
  }
  // HTML other than a closed comment could hide a section from readers,
  // so that only a look-alike stays visible (T10).
  const hidden = parts.some((part) => part.hides);
  let judged = 0;
  let found = false;
  // The earliest start: after the line of the marking before, or the
  // start of the page.
  let earliest = 0;
  for (const { marking, line, index } of markingsOf(parts)) {
    if (options.matches(marking)) {
      if (hidden || judged === maxJudgedMarkings) return changed;
      judged += 1;
      found = true;
      const start = ownStart(options, parts.slice(earliest, index), marking);
      if (start !== undefined) {
        return Object.freeze({ kind: 'own', start, end: line });
      }
    }
    earliest = index + 1;
  }
  return found ? changed : Object.freeze({ kind: 'none' });
}

// The first line of the section before a line of the marking whose code
// fits, trying the blocks before it from the nearest one back. A block
// without a canonical form ends the search: every start further back
// holds it.
const ownStart = (
  options: { readonly key: KeyMaterial; readonly tenantId: string },
  before: readonly PagePart[],
  marking: Marking,
): number | undefined => {
  const blocks: Block[] = [];
  for (const part of [...before].reverse()) {
    if (part.type === 'space') continue;
    if (part.node === undefined || blocks.length === maxSectionStarts) {
      return undefined;
    }
    blocks.unshift(part.node);
    const canonical = canonicalFormOf(blocks);
    if (
      sameCheckCode(
        checkCodeOf(options.key, options.tenantId, marking.origin, canonical),
        marking.code,
      )
    ) {
      return part.first;
    }
  }
  return undefined;
};

/** A line of the marking a write asks about, with where its section may begin. */
export interface MarkingAskedFor extends FoundMarking {
  /**
   * The first line its section may begin at: after the line of the
   * marking before it, or the start of the page.
   */
  readonly earliest: number;
}

/**
 * What a page holds of the lines of the marking a write asks about, for an
 * adoption (ADR 0032): none of them can say whether their code fits, that
 * is {@link judgeSections}.
 */
export type MarkingsAskedFor =
  /** The lexer cannot read the page. */
  | { readonly kind: 'unreadable' }
  | {
      readonly kind: 'read';
      /** Whether the page holds HTML that could hide a section (T10). */
      readonly hides: boolean;
      /** The lines, in the order of the page. */
      readonly lines: readonly MarkingAskedFor[];
    };

/**
 * Finds the lines of the marking a write asks about on a page, each with
 * the first line its section may begin at, as {@link judgeSections} reads
 * the page.
 *
 * @param options - What to find.
 * @param options.text - The text of the page.
 * @param options.matches - Which markings the write asks about.
 * @returns The lines, frozen, or that the page cannot be read.
 * @example
 * ```ts
 * markingsAskedFor({ text, matches: (m) => m.origin.kind === 'routine' });
 * ```
 */
export function markingsAskedFor(options: {
  readonly text: string;
  readonly matches: (marking: Marking) => boolean;
}): MarkingsAskedFor {
  const parts = partsOf(options.text);
  if (parts === undefined) return Object.freeze({ kind: 'unreadable' });
  const lines: MarkingAskedFor[] = [];
  let earliest = 0;
  for (const { marking, line } of markingsOf(parts)) {
    if (options.matches(marking)) {
      lines.push(Object.freeze({ marking, line, earliest }));
    }
    earliest = line + 1;
  }
  return Object.freeze({
    kind: 'read',
    hides: parts.some((part) => part.hides),
    lines: Object.freeze(lines),
  });
}

/**
 * Gives the canonical form of the section of a page between two lines, as
 * {@link judgeSections} takes the code over it, for an adoption
 * (ADR 0032).
 *
 * @param text - The text of the page.
 * @param start - The first line of the section, where a block begins.
 * @param end - The line of its marking, a paragraph of the top level.
 * @returns The canonical form, or undefined when the page cannot be read,
 *   no block begins at `start`, no line of the marking stands at `end`, no
 *   block lies between, or a block between has no canonical form.
 * @example
 * ```ts
 * canonicalSectionOf('# Plan\n\n## W46\nText\n\nAutomatisch …', 2, 5);
 * ```
 */
export function canonicalSectionOf(
  text: string,
  start: number,
  end: number,
): string | undefined {
  const parts = partsOf(text);
  if (parts === undefined) return undefined;
  const marking = markingsOf(parts).find(({ line }) => line === end);
  if (
    marking === undefined ||
    !parts.some((part) => part.first === start && part.type !== 'space')
  ) {
    return undefined;
  }
  const blocks: Block[] = [];
  for (const part of parts.slice(0, marking.index)) {
    if (part.first < start || part.type === 'space') continue;
    if (part.node === undefined) return undefined;
    blocks.push(part.node);
  }
  return blocks.length === 0 ? undefined : canonicalFormOf(blocks);
}
