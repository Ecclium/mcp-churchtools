/**
 * The first step of the content policy (ADR 0030): a hard limit on the
 * length of a text and its normal form.
 *
 * Where it stands in the way of a write: before anything reads the text
 * as Markdown. Lexers of Markdown have had input that made them run for a
 * very long time; a worker with a time limit is not possible under the
 * permission model of Node.js, so the limit on the length is what keeps
 * such input small enough not to matter. It applies to every text,
 * whether a person, a routine or the operator wrote it.
 *
 * The normal form is NFKC without the characters a reader cannot see, as
 * in the checks of the redaction (ADR 0069): letters of full width, other
 * look-alikes and hidden characters cannot carry a web address or a phone
 * number past the checks. The core writes this form, not the original, so
 * that ChurchTools holds exactly the text that was checked. NFKC changes
 * some signs a person may have chosen: an ellipsis becomes three dots, a
 * raised two a plain 2, a protected space an ordinary one.
 *
 * @packageDocumentation
 */
import { removeHiddenCharacters } from '../redaction/index.js';

/**
 * The most bytes of UTF-8 in one field, before and after the normal form:
 * 64 KiB, the most ChurchTools takes for the text of a page of the wiki.
 */
export const maxContentBytes = 65_536;

/**
 * The most asterisks and underscores in one text of Markdown, escaped or
 * not. The lexer of `marked` 18.1.2 looks for the end of each unmatched
 * mark of emphasis through the rest of the text, so its time grows with
 * the square of their number: 2000 took about a quarter of a second on a
 * laptop in November 2026, 20'000 in a text below 64 KiB over 20 seconds.
 * A wiki page needs far fewer, and the limit stays when a later version
 * of the library fixes this, in case it comes back.
 */
export const maxEmphasisSigns = 2000;

/**
 * Whether a text holds more asterisks and underscores than
 * {@link maxEmphasisSigns}.
 *
 * @param text - The text in its normal form.
 * @returns Whether the lexer should not read it.
 * @example
 * ```ts
 * hasTooManyEmphasisSigns('**fett**'); // false
 * ```
 */
export function hasTooManyEmphasisSigns(text: string): boolean {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x2a || code === 0x5f) count += 1;
  }
  return count > maxEmphasisSigns;
}

/** What {@link normalizeContent} gives: the text in its normal form, or why not. */
export type NormalizedContent =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly violation: 'tooLong' | 'unparsable' };

const bytesOf = (text: string): number =>
  new TextEncoder().encode(text).byteLength;

/**
 * Checks the length of a text and brings it into its normal form: NFKC,
 * without hidden characters, with `\n` at the end of every line.
 *
 * The length is checked before NFKC, so that no long text reaches the
 * normalisation, and after it, because NFKC can make a text longer. A text
 * with a lone surrogate cannot be read: it would turn into another
 * character on the way to ChurchTools.
 *
 * @param text - The text as the tool handed it over.
 * @returns The text in its normal form, or `tooLong` or `unparsable`.
 * @example
 * ```ts
 * normalizeContent('Ｗｏｃｈｅ\r\n'); // { ok: true, text: 'Woche\n' }
 * ```
 */
export function normalizeContent(text: string): NormalizedContent {
  if (!text.isWellFormed()) return { ok: false, violation: 'unparsable' };
  if (bytesOf(text) > maxContentBytes) {
    return { ok: false, violation: 'tooLong' };
  }
  const value = removeHiddenCharacters(text.normalize('NFKC')).text.replaceAll(
    '\r\n',
    '\n',
  );
  if (bytesOf(value) > maxContentBytes) {
    return { ok: false, violation: 'tooLong' };
  }
  return { ok: true, text: value };
}
