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
import { maskEmail, maskPhone, minPhoneDigits } from './mask.js';
import { removeHiddenCharacters } from './unicode.js';

const isDigit = (code: number): boolean => code >= 0x30 && code <= 0x39;

const isSpace = (code: number): boolean =>
  code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;

// Separators between the digits of a phone number in running text, as in
// +41 0 (00) 123-45/67.
const isNumberSeparator = (code: number): boolean =>
  code === 0x20 ||
  code === 0x2d ||
  code === 0x2f ||
  code === 0x2e ||
  code === 0x28 ||
  code === 0x29;

// The most separators in a row between two digits of a phone number, as
// the space and bracket in 41 (0).
const maxSeparatorRun = 2;

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

/**
 * Masks every token with `@` in a text as an e-mail address, without what
 * encloses it, such as brackets or a full stop after it.
 *
 * @param text - A text, normalised and without hidden characters.
 * @returns The text with each address masked.
 */
export const maskAddresses = (text: string): string => {
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

// How many digits follow from the index, counted up to one more than the
// most a part of a date has, so that a longer run shows.
const digitRun = (text: string, from: number, most: number): number => {
  let count = 0;
  while (count <= most && isDigit(text.charCodeAt(from + count))) count += 1;
  return count;
};

const isDateSeparator = (code: number): boolean =>
  code === 0x2e || code === 0x2f || code === 0x2d;

/**
 * A date that starts at the index: a year of four digits, then month and
 * day of one or two digits, or day and month, then the year, with the same
 * dot, slash or hyphen between the parts.
 *
 * @param text - A text.
 * @param index - Where the date would start.
 * @returns The end of the date and its year, or `undefined`.
 */
export const dateAt = (
  text: string,
  index: number,
): { readonly end: number; readonly year: string } | undefined => {
  const first = digitRun(text, index, 4);
  const separator = text.charCodeAt(index + first);
  if (!isDateSeparator(separator)) return undefined;
  const middleStart = index + first + 1;
  const middle = digitRun(text, middleStart, 2);
  if (middle < 1 || middle > 2) return undefined;
  if (text.charCodeAt(middleStart + middle) !== separator) return undefined;
  const lastStart = middleStart + middle + 1;
  if (first === 4) {
    const last = digitRun(text, lastStart, 2);
    if (last < 1 || last > 2) return undefined;
    return { end: lastStart + last, year: text.slice(index, index + 4) };
  }
  if (first > 2 || digitRun(text, lastStart, 4) !== 4) return undefined;
  return { end: lastStart + 4, year: text.slice(lastStart, lastStart + 4) };
};

/**
 * The end of a phone number that starts at the index: an optional `+` or
 * `(`, then digits with at most two separators between two of them.
 *
 * @param text - A text.
 * @param index - Where the number would start.
 * @returns The index after its last digit, or -1 when the run has fewer
 *   digits than a phone number.
 */
export const phoneEndAt = (text: string, index: number): number => {
  let position = text.charCodeAt(index) === 0x2b ? index + 1 : index;
  let digits = 0;
  let lastDigitEnd = -1;
  while (position < text.length) {
    if (isDigit(text.charCodeAt(position))) {
      digits += 1;
      position += 1;
      lastDigitEnd = position;
      continue;
    }
    // Separators count only after a digit, or as the bracket that opens
    // the number.
    if (lastDigitEnd !== position && text.charCodeAt(position) !== 0x28) {
      break;
    }
    let gap = position;
    while (
      gap - position < maxSeparatorRun &&
      isNumberSeparator(text.charCodeAt(gap))
    ) {
      gap += 1;
    }
    if (gap === position || !isDigit(text.charCodeAt(gap))) break;
    position = gap;
  }
  return digits >= minPhoneDigits ? lastDigitEnd : -1;
};

const maskNumbers = (text: string): string => {
  let masked = '';
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    const startsRun =
      (isDigit(code) || code === 0x2b || code === 0x28) &&
      (index === 0 || !isDigit(text.charCodeAt(index - 1)));
    const date = startsRun && isDigit(code) ? dateAt(text, index) : undefined;
    if (date !== undefined) {
      masked += date.year;
      index = date.end;
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
 * hyphens, slashes, dots or brackets between them as a phone number, and a
 * date such as `1980-05-17`, `17.05.1980` or `5/3/1980` to its year. The text is first normalised
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
