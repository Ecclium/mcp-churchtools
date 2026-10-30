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

import { maskBirthdate, maskEmail, maskPhone } from './mask.js';
import { dateAt, maskAddresses, phoneEndAt } from './message.js';
import { removeHiddenCharacters } from './unicode.js';

/**
 * The most bytes an answer may cost in a result, counted as the pipeline
 * counts it: once as a text in the JSON of the result and once in the text
 * of that JSON (ADR 0024). With the reserve of the pipeline, the envelope
 * and the other fields of the result, it stays below 64 KiB.
 */
export const maxForeignJsonCost = 61_440;

/** The kinds of mask a field name can ask for. */
export type FieldMask = 'email' | 'phone' | 'birthdate';

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

const birthdateNames: readonly string[] = Object.freeze([
  'birthday',
  'birthdate',
  'dateofbirth',
  'geburtsdatum',
  'geburtstag',
]);

/**
 * The mask a field name asks for: e-mail for a name that ends in `mail`
 * or `mails`, phone for one that holds `phone`, `telefon` or `handy` or
 * ends in `mobile`, `mobil` or `fax`, and the date of birth for
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
 * ```
 */
export function fieldMask(name: string): FieldMask | undefined {
  const plain = plainName(name);
  if (plain.endsWith('mail') || plain.endsWith('mails')) return 'email';
  if (
    plain.includes('phone') ||
    plain.includes('telefon') ||
    plain.includes('handy') ||
    plain.endsWith('mobile') ||
    plain.endsWith('mobil') ||
    plain.endsWith('fax')
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
  if (mask === 'email') return maskEmail(text);
  if (mask === 'phone') return maskPhone(text);
  return maskBirthdate(text);
};

// Whether two keys of an object were the same after the mask, set by the
// walk of one answer.
interface Walk {
  collided: boolean;
}

// A masked copy of a value of the parsed answer. A text under a field that
// asks for a mask gets that mask, also inside a list; every other text and
// every key gets the mask by form.
const masked = (
  value: unknown,
  mask: FieldMask | undefined,
  walk: Walk,
): unknown => {
  if (typeof value === 'string') {
    return mask === undefined
      ? maskForeignText(value)
      : maskByField(mask, value);
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => masked(item, mask, walk));
  }
  if (typeof value !== 'object' || value === null) return value;
  const copy = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value)) {
    const name = maskForeignText(key);
    if (Object.hasOwn(copy, name)) walk.collided = true;
    Object.defineProperty(copy, name, {
      value: masked(item, fieldMask(key), walk),
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
  const walk: Walk = { collided: false };
  const value = level === 'off' ? root : masked(root, undefined, walk);
  if (walk.collided) return Object.freeze({ ok: false, reason: 'collision' });
  const text = JSON.stringify(value);
  if (foreignJsonCost(text) > maxForeignJsonCost) {
    return Object.freeze({ ok: false, reason: 'too_large' });
  }
  return Object.freeze({ ok: true, text });
}
