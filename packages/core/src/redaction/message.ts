/**
 * Masks contact data in the message of a failed call (ADR 0024, ADR 0054).
 * The message of an EccliumError reaches the model, and a tool could put an
 * address or a number from ChurchTools into it. Unlike a field of a result,
 * a message has no data class, so a scanner looks for what has the form of
 * an e-mail address, a phone number or a date.
 *
 * @packageDocumentation
 */
import type { RedactionLevel } from '@ecclium/mcp-churchtools-plugin-api';

import {
  type ErrorDescription,
  fixedSentences,
  maxMessageLength,
} from '../errors/index.js';
import { maskBirthdate, maskEmail, maskPhone, minPhoneDigits } from './mask.js';
import { removeHiddenCharacters } from './unicode.js';

const isDigit = (code: number): boolean => code >= 0x30 && code <= 0x39;

const isSpace = (code: number): boolean =>
  code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;

// Separators between the digits of a phone number in running text. Brackets
// are left out: in a sentence they belong to the text more often than to a
// number.
const isNumberSeparator = (code: number): boolean =>
  code === 0x20 || code === 0x2d || code === 0x2f || code === 0x2e;

// Characters that enclose an address in a sentence, such as <, ( or a
// full stop after it.
const openers = '(<["\'';
const closers = ')>]"\'.,;:!?';

// A token with @ becomes a masked address, without what encloses it.
const maskAddressToken = (token: string): string => {
  let start = 0;
  let end = token.length;
  while (start < end && openers.includes(token.charAt(start))) start += 1;
  while (end > start && closers.includes(token.charAt(end - 1))) end -= 1;
  return (
    token.slice(0, start) +
    maskEmail(token.slice(start, end)) +
    token.slice(end)
  );
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
    const token = text.slice(index, end);
    masked += token.includes('@') ? maskAddressToken(token) : token;
    index = end;
  }
  return masked;
};

const digitsAt = (text: string, from: number, count: number): boolean => {
  for (let index = from; index < from + count; index += 1) {
    if (!isDigit(text.charCodeAt(index))) return false;
  }
  return true;
};

// Whether a date YYYY-MM-DD or DD.MM.YYYY starts at the index, not followed
// by another digit.
const isDateAt = (text: string, index: number): boolean => {
  if (index + 10 > text.length || isDigit(text.charCodeAt(index + 10))) {
    return false;
  }
  const iso =
    digitsAt(text, index, 4) &&
    text.charCodeAt(index + 4) === 0x2d &&
    digitsAt(text, index + 5, 2) &&
    text.charCodeAt(index + 7) === 0x2d &&
    digitsAt(text, index + 8, 2);
  const dotted =
    digitsAt(text, index, 2) &&
    text.charCodeAt(index + 2) === 0x2e &&
    digitsAt(text, index + 3, 2) &&
    text.charCodeAt(index + 5) === 0x2e &&
    digitsAt(text, index + 6, 4);
  return iso || dotted;
};

// The end of a phone number that starts at the index: an optional +, then
// digits with at most one separator between two of them. Returns the index
// after its last digit, or -1 when the run has fewer digits than a phone
// number.
const phoneEndAt = (text: string, index: number): number => {
  let position = text.charCodeAt(index) === 0x2b ? index + 1 : index;
  let digits = 0;
  let lastDigitEnd = -1;
  while (position < text.length) {
    const code = text.charCodeAt(position);
    if (isDigit(code)) {
      digits += 1;
      position += 1;
      lastDigitEnd = position;
    } else if (
      lastDigitEnd === position &&
      isNumberSeparator(code) &&
      isDigit(text.charCodeAt(position + 1))
    ) {
      position += 1;
    } else {
      break;
    }
  }
  return digits >= minPhoneDigits ? lastDigitEnd : -1;
};

const maskNumbers = (text: string): string => {
  let masked = '';
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    const startsRun =
      (isDigit(code) || code === 0x2b) &&
      (index === 0 || !isDigit(text.charCodeAt(index - 1)));
    if (startsRun && isDateAt(text, index)) {
      masked += maskBirthdate(text.slice(index, index + 10));
      index += 10;
      continue;
    }
    const end = startsRun ? phoneEndAt(text, index) : -1;
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
 * Masks what has the form of contact data in a message: a token with `@`
 * as an e-mail address, a run of at least seven digits with `+`, spaces,
 * hyphens, slashes or dots between them as a phone number, and the dates
 * `YYYY-MM-DD` and `DD.MM.YYYY` to their year. The text is first normalised
 * with NFKC and cleaned of hidden characters, so full-width forms do not
 * slip past. It reads the text character by character, without a regular
 * expression.
 *
 * @param text - A message.
 * @returns The message with the masks applied.
 * @example
 * ```ts
 * maskMessage('No access for max.mustermann@example.org.');
 * // 'No access for m***@example.org.'
 * ```
 */
export function maskMessage(text: string): string {
  const value = removeHiddenCharacters(text.normalize('NFKC')).text;
  return maskNumbers(maskAddresses(value));
}

/**
 * Masks the message of a description of an error, unless the level is
 * `off`. A message that grows beyond the longest length a message may have
 * gives way to the fixed sentence of its code. Code and missing rights stay,
 * because they are names of the core and of ChurchTools, not data.
 *
 * @param description - What `describeError` returned.
 * @param level - The level of redaction of the call. Any level but `off`
 *   masks, so a level the core does not know yet fails closed.
 * @returns The description, frozen.
 * @example
 * ```ts
 * maskErrorDescription(describeError(error), 'standard');
 * ```
 */
export function maskErrorDescription(
  description: ErrorDescription,
  level: RedactionLevel,
): ErrorDescription {
  if (level === 'off') return description;
  const masked = maskMessage(description.message);
  if (masked === description.message) return description;
  const message =
    masked.length <= maxMessageLength
      ? masked
      : fixedSentences[description.code];
  return Object.freeze({ ...description, message });
}
