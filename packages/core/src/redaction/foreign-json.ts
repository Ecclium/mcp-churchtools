/**
 * Masks contact data in an answer of the escape hatch and writes it as
 * JSON text (ADR 0067). The answer has no classified schema, so the mask
 * goes by the name of a field and by the form of a text: a field whose
 * name says e-mail, phone or birthday gets the mask of its kind, and in
 * every other text and key whatever looks like an e-mail address or a
 * phone number is masked. A date of birth in running text looks like any
 * other date and stays: masking every date would leave appointments and
 * events with their year only.
 *
 * Like the other masks it reads every text character by character,
 * without a regular expression over values of the tenant.
 *
 * @packageDocumentation
 */
import type { RedactionLevel } from '@ecclium/mcp-churchtools-plugin-api';

import { maskBirthdate, maskedValue, maskEmail, maskPhone } from './mask.js';
import { dateAt, maskAddresses, phoneEndAt } from './message.js';
import { cleanText, removeHiddenCharacters } from './unicode.js';

/**
 * The most bytes an answer may cost in a result, counted as the pipeline
 * counts it: once as a text in the JSON of the result and once in the text
 * of that JSON (ADR 0024). With the reserve of the pipeline, the envelope
 * and the other fields of the result, it stays below 64 KiB.
 */
export const maxForeignJsonCost = 61_440;

/** The kinds of mask a field name can ask for. */
export type FieldMask = 'secret' | 'email' | 'phone' | 'birthdate';

/** What writing an answer gives. */
export type ForeignJsonText =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: 'too_large' | 'collision' };

const encoder = new TextEncoder();

const isDigit = (code: number): boolean => code >= 0x30 && code <= 0x39;

// The name of a field in lower case, of ASCII letters and digits only, so
// that phone_private, phonePrivate and PHONE-PRIVATE read the same.
const plainName = (name: string): string => {
  const lower = name.normalize('NFKC').toLowerCase();
  let plain = '';
  for (let index = 0; index < lower.length; index += 1) {
    const code = lower.charCodeAt(index);
    if (isDigit(code) || (code >= 0x61 && code <= 0x7a)) {
      plain += lower.charAt(index);
    }
  }
  return plain;
};

// Fields that carry a secret: the parts of the subscription link of a
// calendar, which the read tools never pass on (ADR 0064), and names that
// say token, password, secret or key.
const secretNames: readonly string[] = Object.freeze([
  'randomurl',
  'randomstring',
  'icalsourceurl',
]);
const secretParts: readonly string[] = Object.freeze([
  'token',
  'password',
  'passwort',
  'secret',
  'apikey',
]);

const birthdateNames: readonly string[] = Object.freeze([
  'birthday',
  'birthdate',
  'dateofbirth',
  'geburtsdatum',
  'geburtstag',
]);

/**
 * The mask a field name asks for: the whole value hidden for a secret,
 * that is `randomUrl`, `randomString`, `iCalSourceUrl` and every name that
 * holds `token`, `password`, `passwort`, `secret` or `apikey`; e-mail for
 * a name that ends in `mail`
 * or `mails`, phone for one that holds `phone`, `telefon` or `handy` or
 * ends in `mobile`, `mobiles`, `mobil`, `fax` or `faxes`, and the date of birth for
 * `birthday`, `birthdate`, `dateofbirth`, `geburtsdatum`, `geburtstag` and
 * names that end in `birthday` or `birthdate`. The name is read in lower
 * case with letters and digits only.
 *
 * @param name - The name of a field.
 * @returns The kind of mask, or `undefined`.
 * @example
 * ```ts
 * fieldMask('phonePrivate'); // 'phone'
 * fieldMask('birthName'); // undefined
 * fieldMask('randomUrl'); // 'secret'
 * ```
 */
export function fieldMask(name: string): FieldMask | undefined {
  const plain = plainName(name);
  if (
    secretNames.includes(plain) ||
    secretParts.some((part) => plain.includes(part))
  ) {
    return 'secret';
  }
  if (plain.endsWith('mail') || plain.endsWith('mails')) return 'email';
  if (
    plain.includes('phone') ||
    plain.includes('telefon') ||
    plain.includes('handy') ||
    plain.endsWith('mobile') ||
    plain.endsWith('mobiles') ||
    plain.endsWith('mobil') ||
    plain.endsWith('fax') ||
    plain.endsWith('faxes')
  ) {
    return 'phone';
  }
  if (
    birthdateNames.includes(plain) ||
    plain.endsWith('birthday') ||
    plain.endsWith('birthdate')
  ) {
    return 'birthdate';
  }
  return undefined;
}

// Phone numbers in running text, from a +, an opening bracket or a 0, and
// never inside a date: 01.10.2026 is a date, not a number of eight digits.
const maskPhones = (text: string): string => {
  let masked = '';
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    const startsRun =
      (isDigit(code) || code === 0x2b || code === 0x28) &&
      (index === 0 || !isDigit(text.charCodeAt(index - 1)));
    const date = startsRun && isDigit(code) ? dateAt(text, index) : undefined;
    if (date !== undefined) {
      masked += text.slice(index, date.end);
      index = date.end;
      continue;
    }
    const leads = code === 0x2b || code === 0x28 || code === 0x30;
    const end = startsRun && leads ? phoneEndAt(text, index) : -1;
    if (end !== -1) {
      masked += maskPhone(text.slice(index, end));
      index = end;
      continue;
    }
    masked += text.charAt(index);
    index += 1;
  }
  return masked;
};

/**
 * Masks what looks like contact data in any text of an answer: a token
 * with `@` as an e-mail address and a run of at least seven digits from a
 * `+`, an opening bracket or a `0` as a phone number, never a date. It
 * looks at the text after NFKC and without hidden characters, so that
 * full-width forms do not slip past. A text it finds nothing in comes back
 * as it was.
 *
 * @param text - Any text of an answer.
 * @returns The text, masked where it found something.
 * @example
 * ```ts
 * maskForeignText('Call 000 123 45 67 on 01.10.2026'); // 'Call 000 1** ** ** on 01.10.2026'
 * ```
 */
export function maskForeignText(text: string): string {
  const cleaned = removeHiddenCharacters(text.normalize('NFKC')).text;
  const masked = maskPhones(maskAddresses(cleaned));
  return masked === cleaned ? text : masked;
}

const maskByField = (mask: FieldMask, text: string): string => {
  if (text === '') return text;
  if (mask === 'secret') return maskedValue;
  if (mask === 'email') return maskEmail(text);
  if (mask === 'phone') return maskPhone(text);
  return maskBirthdate(text);
};

// One walk of an answer: whether it masks, by the level of redaction, and
// whether two keys of an object were the same after the mask.
interface Walk {
  readonly masking: boolean;
  collided: boolean;
}

// A masked copy of a value of the parsed answer. A field that asks for a
// mask passes it on to every text below it, in lists and in objects, where
// a key without a mask of its own keeps it; a number takes it only right
// under the field, so that an ID in an object below keeps its value. Every
// other text and every key gets the mask by form. Booleans and null carry
// nothing to hide and stay. Every text and key is then cleaned of hidden
// characters, with the note of the cleaning in that very text, also
// without masking: the stage redact of the pipeline cleans the whole JSON
// text again and would put its note after the closing brace, which leaves
// no valid JSON. Cleaned here, it finds nothing left (ADR 0024).
const masked = (
  value: unknown,
  mask: FieldMask | undefined,
  direct: boolean,
  walk: Walk,
): unknown => {
  if (typeof value === 'string') {
    if (!walk.masking) return cleanText(value);
    return cleanText(
      mask === undefined ? maskForeignText(value) : maskByField(mask, value),
    );
  }
  if (typeof value === 'number') {
    return walk.masking && mask !== undefined && direct
      ? maskByField(mask, String(value))
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => masked(item, mask, direct, walk));
  }
  if (typeof value !== 'object' || value === null) return value;
  const copy = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value)) {
    const name = cleanText(walk.masking ? maskForeignText(key) : key);
    if (Object.hasOwn(copy, name)) walk.collided = true;
    const own = fieldMask(key);
    Object.defineProperty(copy, name, {
      value: masked(item, own ?? mask, own !== undefined, walk),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy;
};

/**
 * What a text costs in a result as the pipeline counts it: its JSON in
 * the data, and the JSON of that in the text block.
 *
 * @param text - The JSON text of an answer.
 * @returns The bytes in UTF-8.
 * @example
 * ```ts
 * foreignJsonCost('a'); // 3 + 7 = 10
 * ```
 */
export function foreignJsonCost(text: string): number {
  const once = JSON.stringify(text);
  return (
    encoder.encode(once).byteLength +
    encoder.encode(JSON.stringify(once)).byteLength
  );
}

/**
 * Masks a parsed answer of the escape hatch and writes it as JSON text
 * without indentation. The level `off` masks nothing, every other level
 * masks, also one the core does not know yet. The answer is never cut.
 *
 * @param root - The parsed answer, as the client read it.
 * @param level - The level of redaction of the call.
 * @returns The text, or `too_large` when it costs more than
 *   {@link maxForeignJsonCost}, or `collision` when two keys of an object
 *   are the same after the mask.
 * @example
 * ```ts
 * renderForeignJson({ data: { email: 'max.mustermann@example.org' } }, 'standard');
 * // { ok: true, text: '{"data":{"email":"m***@example.org"}}' }
 * ```
 */
export function renderForeignJson(
  root: unknown,
  level: RedactionLevel,
): ForeignJsonText {
  const walk: Walk = { masking: level !== 'off', collided: false };
  const value = masked(root, undefined, false, walk);
  if (walk.collided) return Object.freeze({ ok: false, reason: 'collision' });
  const text = JSON.stringify(value);
  if (foreignJsonCost(text) > maxForeignJsonCost) {
    return Object.freeze({ ok: false, reason: 'too_large' });
  }
  return Object.freeze({ ok: true, text });
}
