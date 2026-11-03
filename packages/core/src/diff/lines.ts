/**
 * The lines of a text for the line diff (ADR 0031). Where it stands in the
 * way of a write: `ecclium undo` compares the text of a page now with the
 * text before the write, line by line, and must be able to rebuild the one
 * from the other exactly, so a line keeps its own line ending: `\n`,
 * `\r\n`, or none for a last line without a break. Joined, the lines give
 * the text back, sign for sign.
 *
 * Only `\n` ends a line. A lone `\r` stays inside its line, as in the text
 * of a page it is no line break of its own, and two lines that differ only
 * in their ending are two different lines.
 *
 * @packageDocumentation
 */

/**
 * Splits a text into its lines, each with its own line ending.
 *
 * @param text - The text.
 * @returns The lines, frozen: none for an empty text, and no empty line
 *   after a last line break.
 * @example
 * ```ts
 * splitLines('a\r\nb\n\nc');
 * // ['a\r\n', 'b\n', '\n', 'c']
 * ```
 */
export function splitLines(text: string): readonly string[] {
  const lines: string[] = [];
  let start = 0;
  for (
    let end = text.indexOf('\n');
    end !== -1;
    end = text.indexOf('\n', start)
  ) {
    lines.push(text.slice(start, end + 1));
    start = end + 1;
  }
  if (start < text.length) lines.push(text.slice(start));
  return Object.freeze(lines);
}
