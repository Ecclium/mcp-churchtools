/**
 * Masks for e-mail addresses, phone numbers and dates of birth, the minimum
 * of redaction in phase 1 (ADR 0024). Each mask keeps a part the model can
 * work with and shows with asterisks that the rest is hidden. A value a
 * mask cannot read becomes {@link maskedValue} as a whole, so an unexpected
 * form never passes unmasked.
 *
 * Every mask removes hidden characters first and reads its input character
 * by character, without a regular expression: the values come from the
 * tenant, and the legacy statics of RegExp such as RegExp.$_ would keep
 * them.
 *
 * @packageDocumentation
 */
import { removeHiddenCharacters } from './unicode.js';

/** What a value becomes when its mask cannot read it. */
export const maskedValue = '[masked]';

/** The digits of a phone number that stay visible. */
export const visiblePhoneDigits = 4;

/** The fewest digits a value needs to be read as a phone number. */
export const minPhoneDigits = 7;

const maxDomainLength = 253;

const isDigit = (code: number): boolean => code >= 0x30 && code <= 0x39;

const isAsciiLetterOrDigit = (code: number): boolean =>
  isDigit(code) ||
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x61 && code <= 0x7a);

// Space, hyphen, slash, dot and brackets, as phone numbers are written.
const isPhoneSeparator = (code: number): boolean =>
  code === 0x20 ||
  code === 0x2d ||
  code === 0x2f ||
  code === 0x2e ||
  code === 0x28 ||
  code === 0x29;

const prepare = (text: string): string =>
  removeHiddenCharacters(text).text.trim();

// A domain in ASCII with at least one dot, labels of letters, digits and
// hyphens, none empty and none starting or ending with a hyphen. A domain in
// another script is not read and masks the whole address.
const isDomain = (domain: string): boolean => {
  if (domain.length < 3 || domain.length > maxDomainLength) return false;
  let labelStart = 0;
  let dots = 0;
  for (let index = 0; index <= domain.length; index += 1) {
    const code = index < domain.length ? domain.charCodeAt(index) : 0x2e;
    if (code === 0x2e) {
      if (index === labelStart) return false;
      if (domain.charCodeAt(labelStart) === 0x2d) return false;
      if (domain.charCodeAt(index - 1) === 0x2d) return false;
      labelStart = index + 1;
      if (index < domain.length) dots += 1;
      continue;
    }
    if (code !== 0x2d && !isAsciiLetterOrDigit(code)) return false;
  }
  return dots > 0;
};

const allDigits = (text: string, from: number, to: number): boolean => {
  for (let index = from; index < to; index += 1) {
    if (!isDigit(text.charCodeAt(index))) return false;
  }
  return true;
};

/**
 * Masks an e-mail address: the first character of the local part, three
 * asterisks, `@` and the domain. A first character other than an ASCII
 * letter or digit becomes an asterisk as well.
 *
 * @param text - The address as ChurchTools gives it.
 * @returns The masked address, or {@link maskedValue} for a value without
 *   exactly one `@`, without a local part or without a domain in ASCII with
 *   a dot.
 * @example
 * ```ts
 * maskEmail('max.mustermann@example.org'); // 'm***@example.org'
 * maskEmail('kein Eintrag'); // '[masked]'
 * ```
 */
export function maskEmail(text: string): string {
  const value = prepare(text);
  const at = value.indexOf('@');
  if (at < 1 || at !== value.lastIndexOf('@')) return maskedValue;
  const domain = value.slice(at + 1);
  if (!isDomain(domain)) return maskedValue;
  const first = isAsciiLetterOrDigit(value.charCodeAt(0))
    ? value.charAt(0)
    : '*';
  return `${first}***@${domain}`;
}

/**
 * Masks a phone number: the first {@link visiblePhoneDigits} digits stay,
 * with a `+` in front if there is one, every further digit becomes `*`, and
 * spaces, hyphens, slashes, dots and brackets stay where they are.
 *
 * @param text - The number as ChurchTools gives it.
 * @returns The masked number, or {@link maskedValue} for a value with any
 *   other character, a `+` that does not lead, or fewer than
 *   {@link minPhoneDigits} digits.
 * @example
 * ```ts
 * maskPhone('+41 00 123 45 67'); // '+41 00 *** ** **'
 * maskPhone('000 123 45 67'); // '000 1** ** **'
 * ```
 */
export function maskPhone(text: string): string {
  const value = prepare(text);
  let masked = '';
  let digits = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (isDigit(code)) {
      digits += 1;
      masked += digits <= visiblePhoneDigits ? value.charAt(index) : '*';
    } else if (isPhoneSeparator(code) || (code === 0x2b && index === 0)) {
      masked += value.charAt(index);
    } else {
      return maskedValue;
    }
  }
  return digits >= minPhoneDigits ? masked : maskedValue;
}

/**
 * Masks a date of birth to its year. It reads `YYYY-MM-DD`, `DD.MM.YYYY`
 * and a year alone.
 *
 * @param text - The date as ChurchTools gives it.
 * @returns The year, or {@link maskedValue} for any other form.
 * @example
 * ```ts
 * maskBirthdate('1980-05-17'); // '1980'
 * maskBirthdate('17.05.1980'); // '1980'
 * ```
 */
export function maskBirthdate(text: string): string {
  const value = prepare(text);
  if (value.length === 4 && allDigits(value, 0, 4)) return value;
  if (value.length !== 10) return maskedValue;
  if (
    allDigits(value, 0, 4) &&
    value.charCodeAt(4) === 0x2d &&
    allDigits(value, 5, 7) &&
    value.charCodeAt(7) === 0x2d &&
    allDigits(value, 8, 10)
  ) {
    return value.slice(0, 4);
  }
  if (
    allDigits(value, 0, 2) &&
    value.charCodeAt(2) === 0x2e &&
    allDigits(value, 3, 5) &&
    value.charCodeAt(5) === 0x2e &&
    allDigits(value, 6, 10)
  ) {
    return value.slice(6);
  }
  return maskedValue;
}
