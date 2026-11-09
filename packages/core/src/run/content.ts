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

// Adds the keys of the contact values in every text of a value of JSON.
const collect = (value: unknown, keys: Set<string>): void => {
  if (typeof value === 'string') {
    const normal = normalizeContent(value);
    if (!normal.ok) return;
    for (const find of findPersonalData(normal.text)) {
      keys.add(contactKey(normal.text, find));
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
