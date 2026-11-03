/**
 * Makes text that the command line did not write itself safe for a
 * terminal, such as the lines of a page of the wiki that `ecclium undo`
 * shows in its diff (ADR 0031).
 *
 * A page can hold any character: an escape sequence that recolours or
 * moves the cursor, a control character, a mark that turns the direction
 * of text, a character that looks like another or one that is invisible.
 * The writers of the command line refuse such a line whole (`send.ts`), so
 * this module turns every character they would not let through into a
 * visible form of plain ASCII before the line goes out: `\u{1b}` for an
 * escape, `\\` for a backslash, so that the form cannot be faked by the
 * text itself. It cuts a long line into parts the writers take, each part
 * after the first starting with `\ ... `, which the text cannot fake.
 *
 * @packageDocumentation
 */
import { isShown } from '../send.js';
import { maxOutputLength } from './write.js';

// The mark at the start of a part that continues the line before it. It
// starts with a backslash, which no shown line of foreign text does: a
// backslash of the text itself is always doubled, and a caller that shows
// lines puts its own prefix first, such as that of a diff.
const continued = '\\ ... ';

// A character the writers let through stays; a backslash doubles; any
// other character, a pair of surrogates as one, becomes its code point.
const visible = (character: string): string => {
  if (character === '\\') return '\\\\';
  const code = character.charCodeAt(0);
  if (character.length === 1 && isShown(code)) return character;
  const point = character.codePointAt(0) ?? code;
  return `\\u{${point.toString(16)}}`;
};

/**
 * Turns one line of foreign text into lines a terminal shows as text: no
 * character that could control the terminal, each line no longer than the
 * writers take. A line break inside the text is shown as `\u{a}` as well,
 * so the caller splits the text into its lines first.
 *
 * @param prefix - A prefix the command line writes itself, such as `+ `,
 *   kept as it is.
 * @param text - The foreign text of one line.
 * @returns One or more lines, each with at least one character.
 * @example
 * ```ts
 * terminalLines('+ ', 'Rot: \u001b[31m'); // ['+ Rot: \\u{1b}[31m']
 * ```
 */
export function terminalLines(prefix: string, text: string): string[] {
  // Whole visible forms only, so that no part ends in half an escape.
  const parts = [prefix, ...Array.from(text, visible)];
  const lines: string[] = [];
  let line = '';
  for (const part of parts) {
    if (line.length + part.length > maxOutputLength) {
      lines.push(line);
      line = continued;
    }
    line += part;
  }
  lines.push(line === '' ? ' ' : line);
  return lines;
}
