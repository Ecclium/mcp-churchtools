/**
 * Variants of canary values for the property tests of the redaction (ADR
 * 0070). A variant is the same value in compatibility forms that NFKC
 * folds back to it, with hidden characters that the redaction removes
 * before it reads a text, or in letters and digits of other scripts that
 * only look the same. NFKC folds none of the last kind, so the check of
 * free text does not recognise them (ADR 0069), while a field with a data
 * class is masked whatever its characters are.
 *
 * A test draws the choices as numbers, from fast-check for example, so
 * that this package needs no library for property tests and a failing case
 * shrinks towards the plain value, whose choices are all zero.
 *
 * @packageDocumentation
 */

const char = (codePoint: number): string => String.fromCodePoint(codePoint);

/**
 * Characters that the redaction removes from every text before it reads
 * it: characters of zero width, controls of the writing direction, the
 * soft hyphen, the grapheme joiner, a tag character and a variation
 * selector of the supplement, among others.
 */
export const hiddenCharacters: readonly string[] = Object.freeze(
  [
    0x200b, 0x200c, 0x200d, 0x2060, 0x2064, 0xfeff, 0x00ad, 0x034f, 0x061c,
    0x180e, 0x200e, 0x202e, 0x2066, 0x2069, 0xfff9, 0xe0041, 0xe007f, 0xe0100,
  ].map(char),
);

// Forms that NFKC folds to a digit: bold, superscript and circled.
const superscriptDigits = [
  0x2070, 0x00b9, 0x00b2, 0x00b3, 0x2074, 0x2075, 0x2076, 0x2077, 0x2078,
  0x2079,
];
const circledDigits = [
  0x24ea, 0x2460, 0x2461, 0x2462, 0x2463, 0x2464, 0x2465, 0x2466, 0x2467,
  0x2468,
];

// Small forms of signs that stand in addresses and numbers.
const smallForms: Readonly<Record<string, number>> = Object.freeze({
  '@': 0xfe6b,
  '+': 0xfe62,
  '-': 0xfe63,
  '.': 0xfe52,
  '(': 0xfe59,
  ')': 0xfe5a,
});

// Spaces that NFKC folds to the space.
const spaces = [0x00a0, 0x2002, 0x2003, 0x2009, 0x3000];

/**
 * The compatibility forms of one character that NFKC folds back to it,
 * for the printable characters of ASCII: the form of full width, for
 * letters and digits the bold mathematical form, for digits the
 * superscript and the circled form, for some signs the small form, and
 * for the space spaces of other widths.
 *
 * @param character - One character.
 * @returns Its forms, empty for a character outside printable ASCII.
 * @example
 * ```ts
 * compatibilityForms('@'); // ['＠', '﹫']
 * ```
 */
export function compatibilityForms(character: string): readonly string[] {
  const code = character.codePointAt(0);
  if (code === undefined || character.length !== 1) return [];
  if (code === 0x20) return spaces.map(char);
  if (code < 0x21 || code > 0x7e) return [];
  const forms = [char(code + 0xfee0)];
  if (code >= 0x30 && code <= 0x39) {
    const digit = code - 0x30;
    forms.push(
      char(0x1d7ce + digit),
      char(superscriptDigits[digit] as number),
      char(circledDigits[digit] as number),
    );
  } else if (code >= 0x41 && code <= 0x5a) {
    forms.push(char(0x1d400 + code - 0x41));
  } else if (code >= 0x61 && code <= 0x7a) {
    forms.push(char(0x1d41a + code - 0x61));
  }
  const small = smallForms[character];
  if (small !== undefined) forms.push(char(small));
  return forms;
}

// Letters of Cyrillic that look like Latin ones, and digits of two other
// scripts. NFKC changes none of them.
const cyrillic: Readonly<Record<string, number>> = Object.freeze({
  a: 0x0430,
  c: 0x0441,
  e: 0x0435,
  i: 0x0456,
  j: 0x0458,
  o: 0x043e,
  p: 0x0440,
  s: 0x0455,
  x: 0x0445,
  y: 0x0443,
  A: 0x0410,
  B: 0x0412,
  C: 0x0421,
  E: 0x0415,
  H: 0x041d,
  K: 0x041a,
  M: 0x041c,
  O: 0x041e,
  P: 0x0420,
  T: 0x0422,
  X: 0x0425,
});
const arabicIndicZero = 0x0660;
const devanagariZero = 0x0966;

/**
 * The characters of other scripts that look like one character but that
 * NFKC leaves as they are: Cyrillic letters for Latin ones and Arabic-Indic
 * and Devanagari digits for digits.
 *
 * @param character - One character.
 * @returns Its look-alikes, empty for one without any.
 * @example
 * ```ts
 * lookalikes('a'); // ['а'], the Cyrillic letter
 * ```
 */
export function lookalikes(character: string): readonly string[] {
  const code = character.codePointAt(0);
  if (code === undefined || character.length !== 1) return [];
  if (code >= 0x30 && code <= 0x39) {
    return [
      char(arabicIndicZero + code - 0x30),
      char(devanagariZero + code - 0x30),
    ];
  }
  const letter = cyrillic[character];
  return letter === undefined ? [] : [char(letter)];
}

/** The choice for one character of a value. */
export interface VariantChoice {
  /**
   * 0 keeps the character, any other number takes one of its forms,
   * counted round, and keeps it when it has none.
   */
  readonly form: number;
  /**
   * 0 inserts nothing, any other number puts one of
   * {@link hiddenCharacters}, counted round, before the character.
   */
  readonly hidden: number;
}

const pick = (list: readonly string[], choice: number): string | undefined =>
  list.length === 0 ? undefined : list[(choice - 1) % list.length];

/**
 * Builds a variant of a value that NFKC and the removal of
 * {@link hiddenCharacters} turn back into the value. Each character takes
 * the choice at its position, a character past the end of the choices
 * stays as it is.
 *
 * @param value - The value, in printable ASCII or not.
 * @param choices - One choice per character, from the start of the value.
 * @returns The variant.
 * @example
 * ```ts
 * variantOf('m@example.org', [{ form: 0, hidden: 0 }, { form: 1, hidden: 1 }]);
 * // 'm', U+200B, the '@' of full width, then 'example.org'
 * ```
 */
export function variantOf(
  value: string,
  choices: readonly VariantChoice[],
): string {
  let variant = '';
  let index = 0;
  for (const character of value) {
    const choice = choices[index] ?? { form: 0, hidden: 0 };
    index += 1;
    if (choice.hidden > 0) {
      variant += pick(hiddenCharacters, choice.hidden) ?? '';
    }
    variant +=
      choice.form > 0
        ? (pick(compatibilityForms(character), choice.form) ?? character)
        : character;
  }
  return variant;
}

/**
 * Builds a variant of a value from characters of other scripts that only
 * look the same (see {@link lookalikes}). NFKC does not fold them, so the
 * variant stays a different text.
 *
 * @param value - The value.
 * @param choices - One number per character: 0 keeps it, any other takes
 *   one of its look-alikes, counted round, and keeps it when it has none.
 * @returns The variant.
 * @example
 * ```ts
 * lookalikeOf('0791', [1, 0, 0, 2]); // '٠79१'
 * ```
 */
export function lookalikeOf(value: string, choices: readonly number[]): string {
  let variant = '';
  let index = 0;
  for (const character of value) {
    const choice = choices[index] ?? 0;
    index += 1;
    variant +=
      choice > 0
        ? (pick(lookalikes(character), choice) ?? character)
        : character;
  }
  return variant;
}

/**
 * A text as a search for canary values reads it: after NFKC, without
 * {@link hiddenCharacters} and in lower case. A core of a canary found in
 * this form went out in some variant.
 *
 * @param text - Any text, such as the JSON of a result.
 * @returns The text to search.
 * @example
 * ```ts
 * expect(searchable(output)).not.toContain(core.toLowerCase());
 * ```
 */
export function searchable(text: string): string {
  let folded = text.normalize('NFKC');
  for (const hidden of hiddenCharacters) {
    folded = folded.replaceAll(hidden, '');
  }
  return folded.toLowerCase();
}
