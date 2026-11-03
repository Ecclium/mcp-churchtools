/**
 * The line diff of two texts (ADR 0031), as data: hunks with three lines
 * of context, each line tagged as context, removed or added. Where it
 * stands in the way of a write: `ecclium undo` shows the operator what
 * taking a write back changes, the text of the page now against the text
 * before the write, and confirmations and approvals will show such a diff
 * too. `applyDiff` rebuilds the new text from the old one and the diff,
 * `renderDiff` turns a diff into lines to read.
 *
 * The search is Myers' algorithm over the lines (`myers.ts`), each
 * distinct line numbered once, so that the search compares integers. Two
 * bounds keep its cost small whatever the texts are, and past either one
 * the diff shows the whole old text as removed and the whole new text as
 * added, with `replaced` set:
 *
 * - **Edits:** at most 2'000 removed and added lines together in a
 *   shortest script ({@link maxDiffEdits}). A diff with more is no help to
 *   a reader, and the time of the search grows with the edits. When the
 *   lengths of the texts alone differ by more, the search does not start.
 * - **Lines:** at most 10'000 lines of either text between the lines both
 *   share at their start and at their end ({@link maxDiffLines}). The time
 *   of the search grows with these lines times the edits: from either end
 *   at most 2'001 diagonals, each walked at most once over the lines, and
 *   the halves of the splits together as much again, so about 4 times
 *   10'000 times 2'000, 80 million comparisons of integers at the very
 *   worst. A text of 64 KiB, the most a page of the wiki holds (ADR 0072),
 *   can have 65'536 lines, more than six times as many. A change in a long
 *   page leaves few lines between the common start and end, so the bound
 *   hardly ever applies to one.
 *
 * Measured on a laptop in November 2026, pairs of texts built to keep the
 * search busy, with lines that repeat with and without shifts or at
 * random, took at most about 30 milliseconds each, also with the bound on
 * the lines lifted to 65'536; the bound keeps the worst case of the
 * arithmetic well under a second as well. Splitting, numbering and the
 * hunks are linear in the length of the texts. The search itself keeps
 * two arrays of 2'003 numbers, besides the lines and their numbers.
 *
 * @packageDocumentation
 */
import { splitLines } from './lines.js';
import { editScript, type EditStep } from './myers.js';

/** How many lines of context a hunk shows before and after a change. */
export const diffContextLines = 3;

/**
 * The most removed and added lines together that a diff shows line by
 * line. An even number, as the search goes half of it from either end.
 */
export const maxDiffEdits = 2_000;

/**
 * The most lines of either text, between the lines both share at their
 * start and at their end, that a diff compares line by line.
 */
export const maxDiffLines = 10_000;

/** What a line of a hunk is: in both texts, only in the old, only in the new. */
export type DiffLineKind = 'context' | 'removed' | 'added';

/** A line of a hunk. */
export interface DiffLine {
  /** Whether the line stays, goes or comes. */
  readonly kind: DiffLineKind;
  /** The line with its own line ending: `\n`, `\r\n` or none. */
  readonly text: string;
}

/**
 * A run of changes with up to three lines of context on either side. Two
 * changes with six lines or fewer between them are in one hunk.
 */
export interface DiffHunk {
  /**
   * The number of the first line of the hunk in the old text, from 1; for
   * a hunk without old lines, the number its first line would have.
   */
  readonly oldStart: number;
  /** How many lines of the old text the hunk holds: context and removed. */
  readonly oldCount: number;
  /** The number of the first line of the hunk in the new text, the same way. */
  readonly newStart: number;
  /** How many lines of the new text the hunk holds: context and added. */
  readonly newCount: number;
  /** The lines in order, removed lines before the added lines of a change. */
  readonly lines: readonly DiffLine[];
}

/** The line diff of two texts. */
export interface LineDiff {
  /** The hunks in order; none when the texts are equal. */
  readonly hunks: readonly DiffHunk[];
  /**
   * Whether a bound made the diff show the whole old text as removed and
   * the whole new text as added, in one hunk without context.
   */
  readonly replaced: boolean;
}

// A hunk as it grows.
interface Draft {
  readonly oldStart: number;
  readonly newStart: number;
  readonly lines: DiffLine[];
  oldCount: number;
  newCount: number;
}

const draftAt = (oldStart: number, newStart: number): Draft => ({
  oldStart,
  newStart,
  lines: [],
  oldCount: 0,
  newCount: 0,
});

const append = (
  draft: Draft,
  kind: DiffLineKind,
  texts: readonly string[],
): void => {
  for (const text of texts) draft.lines.push(Object.freeze({ kind, text }));
  if (kind !== 'added') draft.oldCount += texts.length;
  if (kind !== 'removed') draft.newCount += texts.length;
};

const close = (draft: Draft): DiffHunk =>
  Object.freeze({
    oldStart: draft.oldStart,
    oldCount: draft.oldCount,
    newStart: draft.newStart,
    newCount: draft.newCount,
    lines: Object.freeze(draft.lines),
  });

// One number per distinct line, the same in both texts.
const numbered = (
  lines: readonly string[],
  numbers: Map<string, number>,
): Int32Array => {
  const result = new Int32Array(lines.length);
  for (const [index, line] of lines.entries()) {
    let number = numbers.get(line);
    if (number === undefined) {
      number = numbers.size;
      numbers.set(line, number);
    }
    result[index] = number;
  }
  return result;
};

// The hunks of a script. Lines that stay are taken from the old text; they
// are the same in the new.
const hunksOf = (
  script: readonly EditStep[],
  before: readonly string[],
  after: readonly string[],
): readonly DiffHunk[] => {
  const hunks: DiffHunk[] = [];
  let open: Draft | undefined;
  let oldAt = 0;
  let newAt = 0;
  for (const { equal, removed, added } of script) {
    const changes = removed + added > 0;
    if (open !== undefined) {
      // Lines between two changes join them into one hunk when the context
      // of both would meet; otherwise the hunk ends with its context.
      if (changes && equal <= 2 * diffContextLines) {
        append(open, 'context', before.slice(oldAt, oldAt + equal));
      } else {
        const tail = Math.min(equal, diffContextLines);
        append(open, 'context', before.slice(oldAt, oldAt + tail));
        hunks.push(close(open));
        open = undefined;
      }
    }
    oldAt += equal;
    newAt += equal;
    if (changes) {
      if (open === undefined) {
        const lead = Math.min(equal, diffContextLines);
        open = draftAt(oldAt - lead + 1, newAt - lead + 1);
        append(open, 'context', before.slice(oldAt - lead, oldAt));
      }
      append(open, 'removed', before.slice(oldAt, oldAt + removed));
      append(open, 'added', after.slice(newAt, newAt + added));
      oldAt += removed;
      newAt += added;
    }
  }
  if (open !== undefined) hunks.push(close(open));
  return Object.freeze(hunks);
};

/**
 * Computes the line diff of two texts. Equal texts give a diff without
 * hunks. Past a bound, see {@link maxDiffEdits} and {@link maxDiffLines},
 * the diff shows the whole old text as removed and the whole new text as
 * added, and says so in `replaced`.
 *
 * @param oldText - The text before, for `ecclium undo` the text of the page
 *   now.
 * @param newText - The text after, for `ecclium undo` the text before the
 *   write.
 * @returns The diff, frozen with its hunks and lines.
 * @example
 * ```ts
 * const diff = diffLines('a\nb\nc\n', 'a\nB\nc\n');
 * // diff.hunks[0]: oldStart 1, oldCount 3, newStart 1, newCount 3, lines
 * // ' a', '-b', '+B', ' c'
 * ```
 */
export function diffLines(oldText: string, newText: string): LineDiff {
  const before = splitLines(oldText);
  const after = splitLines(newText);
  const numbers = new Map<string, number>();
  const script = editScript(
    numbered(before, numbers),
    numbered(after, numbers),
    { depth: maxDiffEdits / 2, lines: maxDiffLines },
  );
  if (script === undefined) {
    const whole = draftAt(1, 1);
    append(whole, 'removed', before);
    append(whole, 'added', after);
    return Object.freeze({
      hunks: Object.freeze([close(whole)]),
      replaced: true,
    });
  }
  return Object.freeze({
    hunks: hunksOf(script, before, after),
    replaced: false,
  });
}
