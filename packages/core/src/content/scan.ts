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

const isHexDigit = (code: number): boolean =>
  isAsciiDigit(code) ||
  (code >= 0x41 && code <= 0x46) ||
  (code >= 0x61 && code <= 0x66);

/**
 * Whether a raw text holds a character reference such as `&amp;` or
 * `&#60;`. The lexer decodes the numeric ones in its text and keeps the
 * named ones, both for HTML, so a text with either does not say what a
 * reader sees. HTML is not written, so a reference counts as HTML. The raw
 * text is only read for this, never written.
 *
 * @param raw - A raw text of Markdown or a text without Markdown.
 * @returns Whether it holds a named, decimal or hexadecimal reference.
 * @example
 * ```ts
 * hasCharacterReference('Q&A'); // false
 * hasCharacterReference('a &amp; b'); // true
 * ```
 */
export const hasCharacterReference = (raw: string): boolean => {
  let at = raw.indexOf('&');
  while (at !== -1) {
    let end = at + 1;
    if (raw.charCodeAt(end) === 0x23) {
      end += 1;
      const hex = raw.charCodeAt(end) === 0x78 || raw.charCodeAt(end) === 0x58;
      if (hex) end += 1;
      const digitsStart = end;
      while (
        end < raw.length &&
        (hex
          ? isHexDigit(raw.charCodeAt(end))
          : isAsciiDigit(raw.charCodeAt(end)))
      ) {
        end += 1;
      }
      if (end > digitsStart && raw.charCodeAt(end) === 0x3b) return true;
    } else if (isAsciiLetter(raw.charCodeAt(end))) {
      while (
        end < raw.length &&
        (isAsciiLetter(raw.charCodeAt(end)) ||
          isAsciiDigit(raw.charCodeAt(end)))
      ) {
        end += 1;
      }
      if (raw.charCodeAt(end) === 0x3b) return true;
    }
    at = raw.indexOf('&', at + 1);
  }
  return false;
};

// ASCII signs that end the name of a host: spaces and punctuation, but no
// hyphen. Every other sign may stand in one, also a symbol such as + or $
// and every sign beyond ASCII: linkify-it, which many renderers use, takes
// them into the name of a host. Wide on purpose: a sign that counts too
// often only makes the check refuse more.
const hostEnds = ' \t\n!"#%&\'()*,./:;<>?@[\\]_{}';

// Past the end of a text the code is NaN, which is no sign of a host.
const isHostSign = (code: number): boolean =>
  code >= 0x80
    ? code !== 0x85 && code !== 0x1680 && code !== 0x2028 && code !== 0x2029
    : code >= 0 && !hostEnds.includes(String.fromCharCode(code));

// Whether a word of lower-case ASCII stands at the index, in either case.
// Character by character: the lower case of some letters, such as the
// dotted capital I, is longer than the letter, so a lowered copy of the
// text would move every index after it.
const isWordAt = (text: string, index: number, word: string): boolean => {
  if (index < 0) return false;
  for (let offset = 0; offset < word.length; offset += 1) {
    const code = text.charCodeAt(index + offset);
    const lower = code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
    if (lower !== word.charCodeAt(offset)) return false;
  }
  return true;
};

// Whether the last part of a host name starts at the index: two or more
// ASCII letters that no digit or hyphen follows, so that bericht.pdf-Datei
// and x.de1 stay; xn-- of a part in another script, as in .xn--p1ai; or
// two or more signs beyond ASCII, as in .рф.
const isTopLevelAt = (text: string, start: number): boolean => {
  if (isWordAt(text, start, 'xn--')) return true;
  let end = start;
  while (isAsciiLetter(text.charCodeAt(end))) end += 1;
  if (end - start >= 2) {
    const after = text.charCodeAt(end);
    return !isAsciiDigit(after) && after !== 0x2d;
  }
  if (end > start) return false;
  while (text.charCodeAt(end) >= 0x80 && isHostSign(text.charCodeAt(end))) {
    end += 1;
  }
  return end - start >= 2;
};

// Whether an @ at the index stands between a name and a host with a dot
// and a sign of a host after it, as in a@a.a or even Treffpunkt@19.30,
// which linkify-it links as an e-mail address although the check of
// contact data does not count it as one.
const isMailAt = (text: string, at: number): boolean => {
  if (at === 0 || !isHostSign(text.charCodeAt(at - 1))) return false;
  for (let index = at + 1; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x2e) {
      if (isHostSign(text.charCodeAt(index + 1))) return true;
    } else if (!isHostSign(code)) {
      return false;
    }
  }
  return false;
};

/**
 * Whether a text holds something a renderer could show as a link: `//`
 * before a sign of a host name, also after a scheme, `mailto:` and
 * `xmpp:`, `www.` at the start of a word, a dot after a sign of a host
 * name followed by the last part of one, as in `gemeinde.example`, or an
 * @ before a host with a dot (ADR 0030, F20). Which library ChurchTools
 * shows Markdown with is not known, and some link a domain without a
 * scheme, so this refuses more than the usual ones would: `bericht.pdf`
 * and `St.Gallen` too, not `z.B.`, `d.h.` or `Mt.5`.
 *
 * @param text - The plain text a reader sees.
 * @returns Whether it holds such a sequence.
 * @example
 * ```ts
 * hasWebAddress('Mehr unter gemeinde.example'); // true
 * hasWebAddress('z.B. am 01.11.2026'); // false
 * ```
 */
export function hasWebAddress(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (
      code === 0x2f &&
      text.charCodeAt(index + 1) === 0x2f &&
      isHostSign(text.charCodeAt(index + 2))
    ) {
      return true;
    }
    if (
      code === 0x3a &&
      (isWordAt(text, index - 6, 'mailto') || isWordAt(text, index - 4, 'xmpp'))
    ) {
      return true;
    }
    if (code === 0x40 && isMailAt(text, index)) return true;
    if (code !== 0x2e) continue;
    if (
      isWordAt(text, index - 3, 'www') &&
      (index === 3 || !isHostSign(text.charCodeAt(index - 4)))
    ) {
      return true;
    }
    if (index > 0 && isHostSign(text.charCodeAt(index - 1))) {
      if (isTopLevelAt(text, index + 1)) return true;
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

// The text as the checks read it: without the selectors of variants,
// which the normal form keeps for emoji but which can stand unseen between
// two digits, and with blank signs that are no spaces to Unicode as
// spaces, so that a number or an address they split is found.
const readableView = (text: string): string => {
  let view = '';
  for (const sign of text) {
    const code = sign.charCodeAt(0);
    if (code >= 0xfe00 && code <= 0xfe0f) continue;
    view +=
      code === 0x2800 || code === 0x2028 || code === 0x2029 || code === 0x1680
        ? ' '
        : sign;
  }
  return view;
};

/**
 * The keys of the contact values of a list, such as the checked policy
 * holds them. A value that is not exactly one contact value has no key and
 * is left out; the check of the policy refuses such a value before.
 *
 * @param values - The values in the normal form of the content policy.
 * @returns The keys to compare with.
 * @example
 * ```ts
 * contactKeysOf(['Info@example.org']); // Set { 'info@example.org' }
 * ```
 */
export function contactKeysOf(values: readonly string[]): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const value of values) {
    const key = contactKeyOf(value);
    if (key !== undefined) keys.add(key);
  }
  return keys;
}

/**
 * Checks the plain text a reader sees of one heading, paragraph or cell.
 *
 * @param value - The plain text, line breaks as spaces.
 * @param contacts - The keys of the contact values the policy lists.
 * @returns The reasons it gives to refuse the text, maybe none.
 * @example
 * ```ts
 * checkReadableText('Mehr unter gemeinde.example', new Set()); // ['webAddress']
 * ```
 */
export function checkReadableText(
  value: string,
  contacts: ReadonlySet<string>,
): readonly ContentViolationKind[] {
  const text = readableView(value);
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
