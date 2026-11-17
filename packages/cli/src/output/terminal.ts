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
 * escape. A backslash of the text becomes `\\` wherever it could start a
 * form, so that the text cannot fake one; elsewhere, as in the `18\.11.`
 * that Markdown writes for a date at the start of a line, it stays as it
 * is. It cuts a long line into parts the writers take, each part after
 * the first starting with `\ ... `, which the text cannot fake.
 *
 * @packageDocumentation
 */
import { isShown } from '../send.js';
import { maxOutputLength } from './write.js';

// The mark at the start of a part that continues the line before it. It
// starts with a backslash and a space, which no shown line of foreign text
// does: a backslash of the text before a space is always doubled, and a
// caller that shows lines puts its own prefix first, such as that of a
// diff.
const continued = '\\ ... ';

// Whether a part starts what follows the backslash of a form: a second
// backslash, the `u` of `\u{…}` or the space of the mark of a
// continuation. A part shown as `\u{…}` starts with a backslash.
const startsForm = (part: string): boolean => {
  const first = part.charAt(0);
  return first === '\\' || first === 'u' || first === ' ';
};

// A character the writers let through stays; any other character, a pair
// of surrogates as one, becomes its code point.
const visible = (character: string): string => {
  const code = character.charCodeAt(0);
  if (character.length === 1 && isShown(code)) return character;
  const point = character.codePointAt(0) ?? code;
  return `\\u{${point.toString(16)}}`;
};

// The digits of a code point the core writes in `\u{…}`, at most six.
const isHexDigits = (text: string): boolean => {
  if (text.length < 1 || text.length > 6) return false;
  for (const digit of text) {
    if (!'0123456789abcdef'.includes(digit)) return false;
  }
  return true;
};

// Text the core made visible holds its forms whole: `\\` for a backslash
// and `\u{…}` for a code point (ADR 0029). Each form stays one part, so
// that a cut never splits it into what reads as another form, such as the
// second half of `\\` before `u{202e}`; any other character is shown as
// for foreign text.
const coreParts = (text: string): string[] => {
  const found: string[] = [];
  let index = 0;
  while (index < text.length) {
    if (text.startsWith('\\\\', index)) {
      found.push('\\\\');
      index += 2;
      continue;
    }
    if (text.startsWith('\\u{', index)) {
      // The closing brace within the seven characters after `\u{`, so
      // that a text of many `\u{` without one stays linear.
      const close = text.slice(index + 3, index + 10).indexOf('}');
      const digits = text.slice(index + 3, index + 3 + close);
      if (close !== -1 && isHexDigits(digits)) {
        found.push(`\\u{${digits}}`);
        index += 4 + close;
        continue;
      }
    }
    const character = String.fromCodePoint(text.codePointAt(index) ?? 0);
    found.push(visible(character));
    index += character.length;
  }
  return found;
};

// A backslash of the text stays single only before a part that starts no
// form: it doubles before a second backslash, before `u`, before a space,
// before a character shown as `\u{…}` and at the end of the text, so that
// `\\` always reads as one backslash and `\u{…}` and the mark always come
// from this module. The core doubled its backslashes already.
const parts = (text: string, shownByCore: boolean): string[] => {
  if (shownByCore) return coreParts(text);
  const shown = Array.from(text, visible);
  return shown.map((part, index) => {
    if (part !== '\\') return part;
    const next = shown[index + 1];
    return next === undefined || startsForm(next) ? '\\\\' : part;
  });
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
 * @param shownByCore - Whether the core already made the text visible, as
 *   for the summary and the diff of an entry of the queue: its backslashes
 *   are doubled already and stay as they are, and a cut keeps each of its
 *   forms whole.
 * @returns One or more lines, each with at least one character.
 * @example
 * ```ts
 * terminalLines('+ ', 'Rot: \u001b[31m'); // ['+ Rot: \\u{1b}[31m']
 * ```
 */
export function terminalLines(
  prefix: string,
  text: string,
  shownByCore = false,
): string[] {
  // Whole visible forms only, so that no part ends in half an escape.
  const lines: string[] = [];
  let line = '';
  for (const part of [prefix, ...parts(text, shownByCore)]) {
    if (line.length + part.length > maxOutputLength) {
      lines.push(line);
      line = continued;
    }
    line += part;
  }
  lines.push(line === '' ? ' ' : line);
  return lines;
}
