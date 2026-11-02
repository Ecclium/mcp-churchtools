/**
 * The checks of the content policy on what a reader sees of a text (ADR
 * 0030): web addresses, masks of the redaction and contact data.
 *
 * Where it stands in the way of a write: after the Markdown is read, on
 * the plain text of each heading, paragraph and cell, the way ChurchTools
 * shows it, with every bold and italic part joined to its neighbours and
 * line breaks as spaces. So a mark of emphasis in the middle of a web
 * address or of a phone number does not hide it.
 *
 * Like the checks of the redaction it reads character by character,
 * without a regular expression over the text.
 *
 * @packageDocumentation
 */
import {
  findPersonalData,
  freeTextMarkers,
  maskedValue,
  type PersonalDataFind,
  pseudonymTextLength,
} from '../redaction/index.js';
import type { ContentViolationKind } from './violations.js';

const isAsciiLetter = (code: number): boolean =>
  (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);

const isAsciiDigit = (code: number): boolean => code >= 0x30 && code <= 0x39;

// A sign of a word for the check of web addresses: an ASCII letter or
// digit, a hyphen, or a character beyond Latin-1 that is no sign of
// punctuation, space, symbol or emoji, so that a domain in another script
// counts as well. The ranges are a rough map, wide on purpose: a sign that
// counts too often only makes the check refuse more.
const isWordSign = (code: number): boolean => {
  if (isAsciiLetter(code) || isAsciiDigit(code) || code === 0x2d) return true;
  if (code < 0xc0 || code === 0xd7 || code === 0xf7) return false;
  if (code >= 0x2000 && code <= 0x2bff) return false;
  if (code >= 0x3000 && code <= 0x303f) return false;
  if (code >= 0xd800 && code <= 0xdfff) return false;
  return !(code >= 0xfe10 && code <= 0xffef);
};

/**
 * Whether a text holds something a renderer could show as a link: `://`
 * anywhere, `www.` at the start of a word, or a dot after a sign of a word
 * followed by at least two ASCII letters and the end of the word, as in
 * `gemeinde.ch` (ADR 0030, F20). Which library ChurchTools shows Markdown
 * with is not known, and some link a domain without a scheme, so this
 * refuses more than the usual ones would: `bericht.pdf` and `St.Gallen`
 * too, not `z.B.`, `d.h.` or `Mt.5`.
 *
 * @param text - The plain text a reader sees.
 * @returns Whether it holds such a sequence.
 * @example
 * ```ts
 * hasWebAddress('Mehr unter gemeinde.ch'); // true
 * hasWebAddress('z.B. am 01.11.2026'); // false
 * ```
 */
export function hasWebAddress(text: string): boolean {
  const lower = text.toLowerCase();
  if (lower.includes('://')) return true;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 0x2e) continue;
    if (
      index >= 3 &&
      lower.startsWith('www', index - 3) &&
      (index === 3 || !isWordSign(text.charCodeAt(index - 4)))
    ) {
      return true;
    }
    if (index === 0 || !isWordSign(text.charCodeAt(index - 1))) continue;
    let end = index + 1;
    while (end < text.length && isAsciiLetter(text.charCodeAt(end))) end += 1;
    if (
      end - index - 1 >= 2 &&
      (end === text.length || !isWordSign(text.charCodeAt(end)))
    ) {
      return true;
    }
  }
  return false;
}

const isBase32Lower = (code: number): boolean =>
  (code >= 0x61 && code <= 0x7a) || (code >= 0x32 && code <= 0x37);

// A pseudonym of the level strict: p1_ and 39 signs of Base32 (ADR 0069).
const hasPseudonym = (text: string): boolean => {
  let at = text.indexOf('p1_');
  while (at !== -1) {
    let end = at + 3;
    while (
      end < at + pseudonymTextLength &&
      isBase32Lower(text.charCodeAt(end))
    ) {
      end += 1;
    }
    if (end === at + pseudonymTextLength) return true;
    at = text.indexOf('p1_', at + 1);
  }
  return false;
};

const isPhoneSign = (code: number): boolean =>
  code === 0x20 ||
  code === 0x2d ||
  code === 0x2f ||
  code === 0x2e ||
  code === 0x28 ||
  code === 0x29;

// A masked phone number: a digit, at most three signs that separate the
// groups of a number, and then at least two asterisks, as in
// `+41 00 *** ** **` or `000 1** ** **`.
const hasMaskedPhone = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    if (!isAsciiDigit(text.charCodeAt(index))) continue;
    let end = index + 1;
    while (end - index - 1 < 3 && isPhoneSign(text.charCodeAt(end))) end += 1;
    if (text.startsWith('**', end)) return true;
  }
  return false;
};

/**
 * Whether a text holds something the redaction put in place of a value:
 * a marker such as `[masked]`, a masked e-mail address or phone number, a
 * pseudonym, or the boundary of a data envelope. A model that carries a
 * result back into the wiki would otherwise write the mask over the value
 * it stood for.
 *
 * @param text - The plain text a reader sees.
 * @returns Whether it holds such a mask.
 * @example
 * ```ts
 * hasMask('Kontakt: m***@example.org'); // true
 * ```
 */
export function hasMask(text: string): boolean {
  return (
    text.includes(maskedValue) ||
    Object.values(freeTextMarkers).some((marker) => text.includes(marker)) ||
    text.includes('***@') ||
    text.includes('<<data-') ||
    text.includes('<</data-') ||
    hasMaskedPhone(text) ||
    hasPseudonym(text)
  );
}

/**
 * The form in which a contact value is compared with the list of the
 * policy: an e-mail address in lower case, a number with its digits,
 * letters and a leading `+` only, letters in upper case. So `000 000 12 34`
 * and `000-000-12-34` are the same, `+41 00 000 12 34` is not.
 *
 * @param text - The text the value stands in.
 * @param find - Where the value stands and what it is.
 * @returns The key of the value.
 * @example
 * ```ts
 * contactKey('Tel. 000 000 12 34', { kind: 'phone', start: 5, end: 18 }); // '0000001234'
 * ```
 */
export function contactKey(text: string, find: PersonalDataFind): string {
  const value = text.slice(find.start, find.end);
  if (find.kind === 'email') return value.toLowerCase();
  let key = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      isAsciiDigit(code) ||
      isAsciiLetter(code) ||
      (code === 0x2b && key === '')
    ) {
      key += value.charAt(index).toUpperCase();
    }
  }
  return key;
}

/**
 * The key of a contact value as the operator lists it, or undefined when
 * the value is not exactly one e-mail address, phone number, IBAN or AHV
 * number in the normal form of the content policy.
 *
 * @param value - One entry of the list, already in its normal form.
 * @returns The key to compare with, or undefined.
 * @example
 * ```ts
 * contactKeyOf('info@example.org'); // 'info@example.org'
 * contactKeyOf('Pfarramt'); // undefined
 * ```
 */
export function contactKeyOf(value: string): string | undefined {
  const finds = findPersonalData(value);
  const [find] = finds;
  return finds.length === 1 &&
    find !== undefined &&
    find.start === 0 &&
    find.end === value.length
    ? contactKey(value, find)
    : undefined;
}

/**
 * Checks the plain text a reader sees of one heading, paragraph or cell.
 *
 * @param text - The plain text, line breaks as spaces.
 * @param contacts - The keys of the contact values the policy lists.
 * @returns The reasons it gives to refuse the text, maybe none.
 * @example
 * ```ts
 * checkReadableText('Mehr unter gemeinde.ch', new Set()); // ['webAddress']
 * ```
 */
export function checkReadableText(
  text: string,
  contacts: ReadonlySet<string>,
): readonly ContentViolationKind[] {
  const found: ContentViolationKind[] = [];
  const finds = findPersonalData(text);
  // The domain of an e-mail address is no web address of its own: the
  // address counts as contact data, so that one the policy lists can stand.
  let rest = '';
  let from = 0;
  for (const find of finds) {
    if (find.kind !== 'email') continue;
    rest += `${text.slice(from, find.start)} `;
    from = find.end;
  }
  if (hasWebAddress(rest + text.slice(from))) found.push('webAddress');
  if (hasMask(text)) found.push('masked');
  if (finds.some((find) => !contacts.has(contactKey(text, find)))) {
    found.push('contact');
  }
  return found;
}
