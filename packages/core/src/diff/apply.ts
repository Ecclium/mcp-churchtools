/**
 * Applies a line diff to the old text (ADR 0031). Where it stands in the
 * way of a write: a diff that `ecclium undo` or a confirmation shows must
 * lead from the text it was made from to exactly the other text, and this
 * function is how the tests and later callers check that. It refuses a
 * diff that does not fit the text instead of guessing, because a text
 * built from such a diff would be one nobody was shown.
 *
 * @packageDocumentation
 */
import type { LineDiff } from './diff.js';
import { splitLines } from './lines.js';

// The message names no line and no text, so that nothing of a page can
// reach a log through it.
const misfit = (): Error => new Error('The diff does not fit the text.');

/**
 * Builds the new text from the old text and their diff: the lines of the
 * old text outside the hunks stay, the hunks remove and add theirs.
 *
 * @param oldText - The text the diff was made from.
 * @param diff - The diff, as `diffLines` gives it.
 * @returns The new text, sign for sign.
 * @throws {Error} When the diff does not fit the text: a hunk starts before
 *   the end of the one before it or past the end of the text, a line of
 *   context or a removed line is not the line of the text at its place, or
 *   the starts and counts of a hunk do not match its lines.
 * @example
 * ```ts
 * const diff = diffLines('a\nb\n', 'a\nc\n');
 * applyDiff('a\nb\n', diff); // 'a\nc\n'
 * ```
 */
export function applyDiff(oldText: string, diff: LineDiff): string {
  const lines = splitLines(oldText);
  const result: string[] = [];
  let at = 0;
  for (const hunk of diff.hunks) {
    const start = hunk.oldStart - 1;
    if (
      !Number.isSafeInteger(start) ||
      start < at ||
      start > lines.length ||
      hunk.newStart - 1 !== result.length + start - at
    ) {
      throw misfit();
    }
    for (const line of lines.slice(at, start)) result.push(line);
    at = start;
    let oldCount = 0;
    let newCount = 0;
    for (const line of hunk.lines) {
      if (line.kind === 'added') {
        result.push(line.text);
        newCount += 1;
        continue;
      }
      if (lines[at] !== line.text) throw misfit();
      at += 1;
      oldCount += 1;
      if (line.kind === 'context') {
        result.push(line.text);
        newCount += 1;
      }
    }
    if (oldCount !== hunk.oldCount || newCount !== hunk.newCount) {
      throw misfit();
    }
  }
  for (const line of lines.slice(at)) result.push(line);
  return result.join('');
}
