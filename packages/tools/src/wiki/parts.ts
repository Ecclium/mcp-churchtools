/**
 * Cuts the text of a wiki page into parts that each fit into one result.
 * A result is never shortened (ADR 0024), so a long text comes in parts
 * the model asks for one by one.
 *
 * @packageDocumentation
 */

/**
 * The most bytes of one part, counted as UTF-8 of the text the way JSON
 * writes it inside a string. The pipeline measures a result as JSON and
 * once more as the text of that JSON, together at most 64 KiB; a part of
 * this size passes even when every character is a quote, whose length
 * doubles with each writing.
 */
export const maxPartBytes = 16_000;

// The bytes of one code point as JSON.stringify writes it in a string:
// the short escapes take two, other control characters and a lone
// surrogate six, every other code point its length in UTF-8.
const jsonBytes = (point: string): number => {
  const code = point.codePointAt(0) ?? 0;
  if (point === '"' || point === '\\') return 2;
  if (code < 0x20) {
    return code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
      ? 2
      : 6;
  }
  if (code >= 0xd800 && code <= 0xdfff) return 6;
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code < 0x10000) return 3;
  return 4;
};

const jsonSize = (text: string): number => {
  let bytes = 0;
  for (const point of text) bytes += jsonBytes(point);
  return bytes;
};

/**
 * Cuts a text into parts of at most `limit` bytes as JSON writes them. A
 * part ends after the last line break that fits; a line longer than a
 * part is cut between two code points, never between a carriage return
 * and its line feed. The same text always gives the
 * same parts, and the parts joined give the text.
 *
 * @param text - The text, Markdown or HTML.
 * @param limit - The most bytes of a part, a whole number from 6, the
 *   most one code point takes.
 * @returns At least one part; an empty text is one empty part.
 * @throws {RangeError} When the limit is smaller, so that no code point
 *   could ever fit.
 * @example
 * ```ts
 * splitIntoParts('ab\ncd\n', 6); // ['ab\n', 'cd\n']
 * ```
 */
export function splitIntoParts(
  text: string,
  limit = maxPartBytes,
): readonly string[] {
  if (!Number.isSafeInteger(limit) || limit < 6) {
    throw new RangeError('A part needs room for at least 6 bytes.');
  }
  const parts: string[] = [];
  let start = 0;
  let bytes = 0;
  // The index just after the last line break of the current part, or -1.
  let lastBreak = -1;
  let index = 0;
  for (const point of text) {
    const cost = jsonBytes(point);
    while (bytes + cost > limit) {
      let cut = lastBreak > start ? lastBreak : index;
      // A carriage return and the line feed after it stay together.
      if (
        cut === index &&
        point === '\n' &&
        cut - 1 > start &&
        text.charCodeAt(cut - 1) === 0x0d
      ) {
        cut -= 1;
      }
      parts.push(text.slice(start, cut));
      // What follows the cut has no line break, so it carries none over.
      bytes = jsonSize(text.slice(cut, index));
      start = cut;
      lastBreak = -1;
    }
    bytes += cost;
    index += point.length;
    if (point === '\n') lastBreak = index;
  }
  parts.push(text.slice(start));
  return Object.freeze(parts);
}
