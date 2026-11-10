/**
 * The content policy for what a run of a routine writes (ADR 0030, ADR
 * 0033): each text the model filled, the section the core rendered from
 * them, and which contact values such a text may hold.
 *
 * Where it stands in a run: after the answer of the model passed its
 * schema and every person in it was found in the data of the run. Each
 * text field goes through the policy of a title, one line of plain text,
 * then the core puts it into the template as plain text, and the whole
 * section goes through the policy of the text of a page. The write guard
 * checks the section once more when it plans the write.
 *
 * These are thin wrappers, so that the content policy itself stays out of
 * the entry point of core and only the checks a run needs leave it.
 *
 * @packageDocumentation
 */
import {
  checkMarkdown,
  checkPlainText,
  contactKey,
  type ContentCheckResult,
  contactKeysOf,
  normalizeContent,
} from '../content/index.js';
import type { Policy } from '../policy/schema.js';
import { findPersonalData } from '../redaction/index.js';

/**
 * Checks one text field of the answer of a model: one line of plain text,
 * as a title of a page, without a link, a web address, a mask, a
 * pseudonym, HTML or contact values beyond those given.
 *
 * @param text - The text the model wrote.
 * @param contacts - The keys of the contact values it may hold.
 * @returns The text in its normal form, or every reason to refuse it.
 * @example
 * ```ts
 * checkRunText('Sigrist fehlt', new Set()); // { ok: true, text: 'Sigrist fehlt' }
 * ```
 */
export function checkRunText(
  text: string,
  contacts: ReadonlySet<string>,
): ContentCheckResult {
  return checkPlainText(text, { contacts });
}

/**
 * Checks a section the core rendered from a template and the fields of an
 * answer, as the text of a page, and gives the form to write.
 *
 * @param markdown - The rendered section.
 * @param contacts - The keys of the contact values it may hold.
 * @returns The section to write, or every reason to refuse it.
 * @example
 * ```ts
 * checkRunSection('## Woche\n\n- Sigrist fehlt\n', new Set());
 * ```
 */
export function checkRunSection(
  markdown: string,
  contacts: ReadonlySet<string>,
): ContentCheckResult {
  return checkMarkdown(markdown, { contacts });
}

// Every sign of ASCII that CommonMark lets a backslash escape.
const escapable = /[!-/:-@[-`{-~]/gu;

/**
 * Writes a text as plain text into Markdown: a backslash before every sign
 * of punctuation of ASCII, so that nothing in it marks up, starts a list,
 * a heading or a quote, or ends a cell, wherever the template puts it.
 *
 * @param text - A text that passed {@link checkRunText}, or a value the
 *   core wrote itself, such as a date or a number.
 * @returns The text, escaped.
 * @example
 * ```ts
 * escapeRunText('# 1. *Probe*'); // '\\# 1\\. \\*Probe\\*'
 * ```
 */
export function escapeRunText(text: string): string {
  return text.replaceAll(escapable, (sign) => `\\${sign}`);
}

// The marks of the envelope around a text of foreign data, such as
// `<<data-a1b2c3d4e5f6a7b8>>` and `<</data-a1b2c3d4e5f6a7b8>>`.
const envelope = /<<\/?data-[0-9A-Za-z]{1,64}>>/gu;

// Adds the keys of the contact values in every text of a value of JSON.
const collect = (value: unknown, keys: Set<string>): void => {
  if (typeof value === 'string') {
    // The marks of the envelope of foreign data around a text of the data
    // as spaces, so that an address at its start or end reads alone.
    const normal = normalizeContent(value.replaceAll(envelope, ' '));
    if (!normal.ok) return;
    for (const find of findPersonalData(normal.text)) {
      const key = contactKey(normal.text, find);
      // The masking reads any word with an @ and a later dot as an e-mail
      // address, a web address with an @ in its path included. Data that
      // others can edit must never make such a value trusted, so a key
      // with a sign of a web address never counts (ADR 0030).
      if (/[/:?#\\]/u.test(key)) continue;
      keys.add(key);
    }
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const item of Object.values(value)) collect(item, keys);
};

/**
 * The contact values a text of a run may hold (ADR 0030): those of the
 * church in the policy, and those the model saw in its data. A field that
 * holds an e-mail address or a phone number is masked in every level, free
 * text only in `strict`. In `standard`, which only the policy allows, a
 * contact value in free text, such as a number in the text of a page,
 * stays in the data and so counts as known: a report may repeat a value
 * of its data, never one from elsewhere.
 *
 * @param policy - The checked policy.
 * @param data - The data the model got, each the result of a read.
 * @returns The keys to compare with.
 * @example
 * ```ts
 * runContactKeys(policy, [result]); // Set { 'info@example.org' }
 * ```
 */
export function runContactKeys(
  policy: Policy,
  data: readonly unknown[],
): ReadonlySet<string> {
  const keys = new Set(contactKeysOf(policy.interactive.contacts ?? []));
  for (const value of data) collect(value, keys);
  return keys;
}

/**
 * The keys of the contact values that a section in its written form holds,
 * as a reader sees them: the written form escapes signs such as `_` with a
 * backslash and may set an address in emphasis, which a key of the data
 * does not have (ADR 0030).
 *
 * @param markdown - The section as the content policy wrote it.
 * @returns The keys.
 * @example
 * ```ts
 * contactKeysInSection('Fragen an anna\\_muster@example.org'); // Set { 'anna_muster@example.org' }
 * ```
 */
export function contactKeysInSection(markdown: string): ReadonlySet<string> {
  // Without its escapes, and with the signs of emphasis as spaces, so that
  // `**anna@example.org**` reads as the address a reader sees.
  return contactKeysIn([
    markdown.replaceAll(escaped, '$1').replaceAll(emphasis, ' '),
  ]);
}

// The signs of emphasis and strikethrough the content policy writes.
const emphasis = /[*~]/gu;

// A sign of ASCII that CommonMark lets a backslash escape, with its
// backslash.
const escaped = /\\([!-/:-@[-`{-~])/gu;

/**
 * The keys of the contact values that the texts of some values of JSON
 * hold, without those of the policy: what a section of a run took from
 * its data, for the entry of the queue (ADR 0030).
 *
 * @param data - Values of JSON, such as the text of a section.
 * @returns The keys.
 * @example
 * ```ts
 * contactKeysIn(['Fragen an info@example.org']); // Set { 'info@example.org' }
 * ```
 */
export function contactKeysIn(data: readonly unknown[]): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const value of data) collect(value, keys);
  return keys;
}
