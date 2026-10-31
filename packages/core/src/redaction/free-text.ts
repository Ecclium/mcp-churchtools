/**
 * The check of free text in the level `strict` (ADR 0026, ADR 0069). A text
 * of the class `untrusted`, such as a page of the wiki or a note, has no
 * fields that say what it holds, so this check looks for what has the form
 * of an e-mail address, a phone number, an IBAN or a Swiss AHV number and
 * puts a visible marker in its place. It finds no names and no address of
 * a house: personal data in free text are only caught by their form.
 *
 * An IBAN counts only with a valid check sum and an AHV number only with a
 * valid check digit, so that not every run of digits goes. A phone number
 * starts with `+`, `(` or `0` and is never a date, as in the mask of the
 * escape hatch.
 *
 * Like the other masks it reads the text after NFKC and without hidden
 * characters, character by character, without a regular expression over
 * values of the tenant.
 *
 * @packageDocumentation
 */
import { dateAt, phoneEndAt } from './message.js';
import { removeHiddenCharacters } from './unicode.js';

/** What takes the place of each kind of find, in English like every text for the model. */
export const freeTextMarkers = Object.freeze({
  email: '[email masked]',
  phone: '[phone masked]',
  iban: '[IBAN masked]',
  ahv: '[AHV number masked]',
} as const);

/** The fewest characters of an IBAN, letters and digits counted. */
export const minIbanLength = 15;

/** The most characters of an IBAN, letters and digits counted. */
export const maxIbanLength = 34;

const isDigit = (code: number): boolean => code >= 0x30 && code <= 0x39;

const isUpper = (code: number): boolean => code >= 0x41 && code <= 0x5a;

const isLower = (code: number): boolean => code >= 0x61 && code <= 0x7a;

const isLetter = (code: number): boolean => isUpper(code) || isLower(code);

const isAlnum = (code: number): boolean => isDigit(code) || isLetter(code);

const isSpace = (code: number): boolean =>
  code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;

const allDigits = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    if (!isDigit(text.charCodeAt(index))) return false;
  }
  return true;
};

// Characters that enclose an address in a sentence, as in the mask of
// messages.
const openers = '(<["\'';
const closers = ')>]"\'.,;:!?';

// An address: at least one character before the last @, and after it a
// dot with a last part of at least two characters that does not start
// with a digit, so that «Treffpunkt@19.30» stays. The last @, so that a
// handle such as @max@example.org counts as well. The domain may be in
// any script: strict hides more than the mask of standard reads.
const isAddress = (text: string): boolean => {
  const at = text.lastIndexOf('@');
  if (at < 1) return false;
  const domain = text.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  if (dot < 1) return false;
  const last = domain.slice(dot + 1);
  return last.length >= 2 && !isDigit(last.charCodeAt(0));
};

// A word with an address becomes the marker, without what encloses it.
const maskAddressWord = (word: string): string => {
  let start = 0;
  let end = word.length;
  while (start < end && openers.includes(word.charAt(start))) start += 1;
  while (end > start && closers.includes(word.charAt(end - 1))) end -= 1;
  const core = word.slice(start, end);
  return isAddress(core)
    ? word.slice(0, start) + freeTextMarkers.email + word.slice(end)
    : word;
};

const maskAddresses = (text: string): string => {
  let masked = '';
  let index = 0;
  while (index < text.length) {
    if (isSpace(text.charCodeAt(index))) {
      masked += text.charAt(index);
      index += 1;
      continue;
    }
    let end = index;
    while (end < text.length && !isSpace(text.charCodeAt(end))) end += 1;
    const word = text.slice(index, end);
    masked += word.includes('@') ? maskAddressWord(word) : word;
    index = end;
  }
  return masked;
};

// The value of a letter or digit in the check sum of an IBAN: a digit is
// itself, a letter 10 for A up to 35 for Z, in either case.
const ibanValue = (code: number): number =>
  isDigit(code)
    ? code - 0x30
    : (isUpper(code) ? code - 0x41 : code - 0x61) + 10;

/**
 * Whether letters and digits pass the check of ISO 7064 that an IBAN
 * carries: the first four moved to the end, every letter as two digits,
 * the whole number leaves 1 when divided by 97.
 *
 * @param chars - The letters and digits of the IBAN, without spaces.
 * @returns Whether the check sum fits.
 * @example
 * ```ts
 * ibanCheckSumFits(candidate); // true for an IBAN without a typo
 * ```
 */
export function ibanCheckSumFits(chars: string): boolean {
  let rest = 0;
  for (let step = 0; step < chars.length; step += 1) {
    const value = ibanValue(chars.charCodeAt((step + 4) % chars.length));
    rest = (rest * (value > 9 ? 100 : 10) + value) % 97;
  }
  return rest === 1;
}

// The end of an IBAN that starts at the index, or -1. It reads two
// letters, two digits and then letters and digits, either in one run, as
// an IBAN is stored, or in groups of four with one space between them and
// a last group of one to four, as it is printed. From the longest printed
// form down to the shortest, the first that has a valid check sum counts,
// so that a word of four characters after the IBAN is no part of it.
const ibanEndAt = (text: string, start: number): number => {
  if (
    !isLetter(text.charCodeAt(start)) ||
    !isLetter(text.charCodeAt(start + 1)) ||
    !isDigit(text.charCodeAt(start + 2)) ||
    !isDigit(text.charCodeAt(start + 3))
  ) {
    return -1;
  }
  let end = start + 4;
  if (isAlnum(text.charCodeAt(end))) {
    while (isAlnum(text.charCodeAt(end))) end += 1;
    const chars = text.slice(start, end);
    return chars.length >= minIbanLength &&
      chars.length <= maxIbanLength &&
      ibanCheckSumFits(chars)
      ? end
      : -1;
  }
  // The printed form: the ends of the groups and the letters and digits
  // up to each.
  const ends: { readonly end: number; readonly chars: string }[] = [];
  let chars = text.slice(start, end);
  while (text.charCodeAt(end) === 0x20 && chars.length < maxIbanLength) {
    let groupEnd = end + 1;
    while (groupEnd - end - 1 < 5 && isAlnum(text.charCodeAt(groupEnd))) {
      groupEnd += 1;
    }
    const size = groupEnd - end - 1;
    if (size < 1 || size > 4) break;
    chars += text.slice(end + 1, groupEnd);
    end = groupEnd;
    ends.push({ end, chars });
    if (size < 4) break;
  }
  for (let index = ends.length - 1; index >= 0; index -= 1) {
    const candidate = ends[index] as (typeof ends)[number];
    if (
      candidate.chars.length >= minIbanLength &&
      candidate.chars.length <= maxIbanLength &&
      ibanCheckSumFits(candidate.chars)
    ) {
      return candidate.end;
    }
  }
  return -1;
};

/**
 * Whether thirteen digits pass the check digit of EAN-13 that an AHV
 * number carries: the first twelve weighted 1 and 3 in turn, and the last
 * digit brings their sum to a multiple of ten.
 *
 * @param digits - Exactly thirteen digits.
 * @returns Whether the check digit fits.
 * @example
 * ```ts
 * ahvCheckDigitFits(candidate); // true for an AHV number without a typo
 * ```
 */
export function ahvCheckDigitFits(digits: string): boolean {
  if (digits.length !== 13 || !allDigits(digits)) return false;
  let sum = 0;
  for (let index = 0; index < 12; index += 1) {
    sum += (digits.charCodeAt(index) - 0x30) * (index % 2 === 0 ? 1 : 3);
  }
  return (10 - (sum % 10)) % 10 === digits.charCodeAt(12) - 0x30;
}

// The lengths of the groups of a printed AHV number: 756.1234.5678.97.
const ahvGroups: readonly number[] = Object.freeze([3, 4, 4, 2]);

// The end of an AHV number that starts at the index, or -1: 756 and ten
// more digits, in one run or in the groups 3, 4, 4 and 2 with the same dot,
// space or hyphen between them, with a valid check digit and no digit right
// after it.
const ahvEndAt = (text: string, start: number): number => {
  if (text.slice(start, start + 3) !== '756') return -1;
  let digits: string;
  let end: number;
  const separator = text.charCodeAt(start + 3);
  if (separator === 0x2e || separator === 0x20 || separator === 0x2d) {
    digits = '';
    end = start;
    for (const [index, size] of ahvGroups.entries()) {
      if (index > 0) {
        if (text.charCodeAt(end) !== separator) return -1;
        end += 1;
      }
      const group = text.slice(end, end + size);
      if (group.length !== size || !allDigits(group)) return -1;
      digits += group;
      end += size;
    }
  } else {
    end = start + 13;
    digits = text.slice(start, end);
  }
  if (isDigit(text.charCodeAt(end))) return -1;
  return ahvCheckDigitFits(digits) ? end : -1;
};

// The most separators between two digits of a phone number in free text:
// three, so that a number written as 044 / 123 45 67 or 079 - 123 45 67
// counts as one.
const freeTextSeparatorRun = 3;

const isDateMark = (code: number): boolean =>
  code === 0x2e ||
  code === 0x2d ||
  code === 0x2f ||
  code === 0x2010 ||
  code === 0x2013;

// Whether a run that starts with 0 is a date, a range of days or a time
// rather than a phone number: groups of one or two digits and at most one
// group of four, the year, with at least one dot, hyphen or slash between
// them, as in 01.-03.10.2026, 05.03. 19.30 or 09.30-10.30. A phone number
// has a group of three or more digits, or is written with spaces only.
const isDateOrTime = (run: string): boolean => {
  let group = 0;
  let years = 0;
  let marked = false;
  for (let index = 0; index <= run.length; index += 1) {
    const code = index < run.length ? run.charCodeAt(index) : 0x20;
    if (isDigit(code)) {
      group += 1;
      continue;
    }
    if (group === 4) years += 1;
    else if (group > 2) return false;
    group = 0;
    if (isDateMark(code)) marked = true;
  }
  return marked && years <= 1;
};

// IBAN, AHV numbers and phone numbers in a text whose addresses are
// already masked. An IBAN starts where no letter or digit stands before
// it, a number where no digit does. A date is copied as it is, so that
// 01.10.2026 never reads as a phone number, as in the mask of the escape
// hatch, also in brackets, and a range of days or a time that starts with
// 0 stays as well.
const maskNumbers = (text: string): string => {
  let masked = '';
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    const before = index === 0 ? 0x20 : text.charCodeAt(index - 1);
    if (isLetter(code) && !isAlnum(before)) {
      const end = ibanEndAt(text, index);
      if (end !== -1) {
        masked += freeTextMarkers.iban;
        index = end;
        continue;
      }
    }
    const runStart = !isDigit(before);
    if (runStart && isDigit(code)) {
      const end = ahvEndAt(text, index);
      if (end !== -1) {
        masked += freeTextMarkers.ahv;
        index = end;
        continue;
      }
      const date = dateAt(text, index);
      if (date !== undefined) {
        masked += text.slice(index, date.end);
        index = date.end;
        continue;
      }
    }
    // A bracket opens a number such as (000) 000 12 34, not a date or an
    // AHV number in brackets, which the next sign starts.
    const bracketed =
      code === 0x28 &&
      (dateAt(text, index + 1) !== undefined ||
        ahvEndAt(text, index + 1) !== -1);
    if (
      runStart &&
      !bracketed &&
      (code === 0x2b || code === 0x28 || code === 0x30)
    ) {
      const end = phoneEndAt(text, index, freeTextSeparatorRun);
      if (
        end !== -1 &&
        !(code === 0x30 && isDateOrTime(text.slice(index, end)))
      ) {
        masked += freeTextMarkers.phone;
        index = end;
        continue;
      }
    }
    masked += text.charAt(index);
    index += 1;
  }
  return masked;
};

/**
 * Checks a free text of the level `strict` and puts a marker in place of
 * every e-mail address, IBAN, AHV number and phone number it finds (ADR
 * 0069). It looks at the text after NFKC and without hidden characters, so
 * that digits and signs of full width or an invisible character inside a
 * number do not slip past. A text it finds nothing in comes back as it
 * was; one it finds something in comes back normalised, with the markers.
 *
 * @param text - A text of the class `untrusted`, already cleaned of hidden
 *   characters.
 * @returns The text, with {@link freeTextMarkers} where it found something.
 * @example
 * ```ts
 * maskFreeText('Kontakt: max.mustermann@example.org, 000 000 12 34');
 * // 'Kontakt: [email masked], [phone masked]'
 * ```
 */
export function maskFreeText(text: string): string {
  const value = removeHiddenCharacters(text.normalize('NFKC')).text;
  const masked = maskNumbers(maskAddresses(value));
  return masked === value ? text : masked;
}
