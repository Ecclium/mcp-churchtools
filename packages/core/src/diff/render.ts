/**
 * The line diff as plain lines to read (ADR 0031), in the form of a
 * unified diff: a header `@@ -a,b +c,d @@` per hunk, then each line with
 * a space, `-` or `+` before it and without its line ending. Where it
 * stands in the way of a write: `ecclium undo` prints these lines for the
 * operator after it wrote a text back, or instead of writing when the page
 * changed since, and confirmations and approvals will show them too.
 *
 * Two lines that differ only in their ending look the same once the
 * ending is off, so the renderer says what the ending was: after a line
 * without a line ending comes the line {@link noLineEndMarker}, as in a
 * unified diff, and after a line that ends with `\r\n` the line
 * {@link crLfMarker}. Both start with `\`, where every line of the text
 * starts with its prefix, so a page cannot fake them, and both are plain
 * ASCII.
 *
 * The lines are the text of the page as it is. The renderer does not make
 * them safe for a terminal; the command line replaces control characters,
 * escape sequences and invisible characters before it prints them.
 *
 * @packageDocumentation
 */
import type { DiffHunk, DiffLineKind, LineDiff } from './diff.js';

/** The line after a line without a line ending, as in a unified diff. */
export const noLineEndMarker = '\\ No newline at end of file';

/** The line after a line that ends with `\r\n` instead of `\n`. */
export const crLfMarker = '\\ Line ends with CR LF';

const prefixes: Readonly<Record<DiffLineKind, string>> = Object.freeze({
  context: ' ',
  removed: '-',
  added: '+',
});

// As in a unified diff, a side without lines names the line before the
// place of the hunk, 0 at the start of the text.
const range = (start: number, count: number): string =>
  `${String(count === 0 ? start - 1 : start)},${String(count)}`;

const header = (hunk: DiffHunk): string =>
  `@@ -${range(hunk.oldStart, hunk.oldCount)} +${range(hunk.newStart, hunk.newCount)} @@`;

/**
 * Turns a line diff into plain lines: per hunk its header, then its lines
 * with their prefix and without their line ending, each followed by
 * {@link noLineEndMarker} or {@link crLfMarker} where its ending calls for
 * one.
 *
 * @param diff - The diff, as `diffLines` gives it.
 * @returns The lines, frozen; none for a diff without hunks.
 * @example
 * ```ts
 * renderDiff(diffLines('a\nb', 'a\nc'));
 * // ['@@ -1,2 +1,2 @@', ' a', '-b', '\\ No newline at end of file',
 * //  '+c', '\\ No newline at end of file']
 * ```
 */
export function renderDiff(diff: LineDiff): readonly string[] {
  const rendered: string[] = [];
  for (const hunk of diff.hunks) {
    rendered.push(header(hunk));
    for (const { kind, text } of hunk.lines) {
      const prefix = prefixes[kind];
      if (text.endsWith('\r\n')) {
        rendered.push(prefix + text.slice(0, -2), crLfMarker);
      } else if (text.endsWith('\n')) {
        rendered.push(prefix + text.slice(0, -1));
      } else {
        rendered.push(prefix + text, noLineEndMarker);
      }
    }
  }
  return Object.freeze(rendered);
}
