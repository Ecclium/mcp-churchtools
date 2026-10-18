/**
 * Removes characters a reader cannot see from text of ChurchTools (ADR
 * 0024). Tag characters, controls of the writing direction and characters
 * of zero width can carry instructions to a model that a person reading the
 * same text never sees.
 *
 * @packageDocumentation
 */

/** What {@link removeHiddenCharacters} returns. */
export interface CleanedText {
  /** The text without hidden characters. */
  readonly text: string;
  /** How many characters were removed, counted in code points. */
  readonly removed: number;
}

// Character by character instead of a regular expression, because the text
// comes from the tenant and the legacy statics of RegExp such as RegExp.$_
// would keep it. Code points, not code units: the tag characters lie
// outside the basic plane.
const isHidden = (codePoint: number, next: number | undefined): boolean => {
  // A carriage return stays only as part of a line break CR LF, so that
  // text written on Windows gets no note for every line.
  if (codePoint === 0x0d) return next !== 0x0a;
  // Other controls of C0, DEL and C1. Line feed and tab stay.
  if (codePoint < 0x20) return codePoint !== 0x0a && codePoint !== 0x09;
  if (codePoint >= 0x7f && codePoint <= 0x9f) return true;
  // Controls of the writing direction.
  if (codePoint === 0x061c || codePoint === 0x200e || codePoint === 0x200f) {
    return true;
  }
  if (codePoint >= 0x202a && codePoint <= 0x202e) return true;
  if (codePoint >= 0x2066 && codePoint <= 0x2069) return true;
  // Characters of zero width, invisible operators and the byte order mark.
  if (codePoint >= 0x200b && codePoint <= 0x200d) return true;
  if (codePoint >= 0x2060 && codePoint <= 0x2064) return true;
  if (codePoint === 0xfeff) return true;
  // Other characters that show nothing: the soft hyphen, the grapheme
  // joiner, the Mongolian vowel separator, the Hangul fillers and the
  // interlinear annotation marks.
  if (
    codePoint === 0xad ||
    codePoint === 0x034f ||
    codePoint === 0x180e ||
    codePoint === 0x115f ||
    codePoint === 0x1160 ||
    codePoint === 0x3164 ||
    codePoint === 0xffa0
  ) {
    return true;
  }
  if (codePoint >= 0xfff9 && codePoint <= 0xfffb) return true;
  // The supplement of variation selectors serves no text in use and can
  // hide a whole message in one visible character. The variation
  // selectors U+FE00 to U+FE0F stay, because emoji and CJK script need
  // them.
  if (codePoint >= 0xe0100 && codePoint <= 0xe01ef) return true;
  // Tag characters.
  return codePoint >= 0xe0000 && codePoint <= 0xe007f;
};

/**
 * Removes tag characters (U+E0000 to U+E007F), controls of the writing
 * direction (U+061C, U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069),
 * characters of zero width (U+200B to U+200D, U+2060 to U+2064, U+FEFF),
 * other characters that show nothing (U+00AD, U+034F, U+180E, U+115F,
 * U+1160, U+3164, U+FFA0, U+FFF9 to U+FFFB), the supplement of variation
 * selectors (U+E0100 to U+E01EF) and controls other than line feed, tab and
 * the carriage return of a CR LF.
 * The text is not normalised otherwise, so names keep their spelling.
 *
 * @param text - Any text.
 * @returns The text without those characters and how many were removed.
 * @example
 * ```ts
 * const zeroWidthSpace = String.fromCodePoint(0x200b);
 * removeHiddenCharacters(`a${zeroWidthSpace}b`); // { text: 'ab', removed: 1 }
 * ```
 */
export function removeHiddenCharacters(text: string): CleanedText {
  let kept = '';
  let removed = 0;
  // The start of the run of kept code units that is not copied yet.
  let runStart = 0;
  let index = 0;
  while (index < text.length) {
    const codePoint = text.codePointAt(index) as number;
    const size = codePoint > 0xffff ? 2 : 1;
    if (isHidden(codePoint, text.codePointAt(index + size))) {
      kept += text.slice(runStart, index);
      runStart = index + size;
      removed += 1;
    }
    index += size;
  }
  if (removed === 0) return { text, removed };
  return { text: kept + text.slice(runStart), removed };
}

/**
 * The note at the end of a text from which hidden characters were removed,
 * so that the model knows the text was changed.
 *
 * @param removed - How many characters were removed, at least 1.
 * @returns The note, starting with a space.
 * @example
 * ```ts
 * hiddenCharactersNote(2); // ' [ecclium: 2 hidden characters removed]'
 * ```
 */
export function hiddenCharactersNote(removed: number): string {
  return ` [ecclium: ${String(removed)} hidden characters removed]`;
}

/**
 * Removes hidden characters and, if it removed any, ends the text with
 * {@link hiddenCharactersNote}. The note holds no hidden character, so
 * cleaning a cleaned text changes nothing.
 *
 * @param text - Any text.
 * @returns The cleaned text.
 * @example
 * ```ts
 * cleanText(`Hallo${String.fromCodePoint(0x202e)}welt`);
 * // 'Hallowelt [ecclium: 1 hidden characters removed]'
 * ```
 */
export function cleanText(text: string): string {
  const cleaned = removeHiddenCharacters(text);
  return cleaned.removed === 0
    ? cleaned.text
    : cleaned.text + hiddenCharactersNote(cleaned.removed);
}
