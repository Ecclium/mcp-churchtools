/**
 * The content policy (ADR 0030): every text Ecclium writes to ChurchTools
 * goes through it, whether a person, a routine or the operator wrote it.
 *
 * Where it stands in the way of a write: while the write is planned, on
 * every text of the intent, before the core asks ChurchTools anything. A
 * text that passes comes back in the form the core writes; the plan is
 * sealed with that form, so the confirmation shows and the commit writes
 * exactly what was checked. A text that does not pass comes back with
 * every reason found, and nothing is written.
 *
 * The steps: the limit of 64 KiB and the normal form (normalize.ts), the
 * lexer of `marked` and the allowed part of Markdown (lexer.ts), the own
 * serializer (serialize.ts), which never writes raw text of a token, a
 * second reading of what it wrote, and the checks of what a reader sees
 * (scan.ts).
 *
 * @packageDocumentation
 */
import { readMarkdown } from './lexer.js';
import {
  hasTooManyDelimiters,
  maxContentBytes,
  normalizeContent,
} from './normalize.js';
import { checkReadableText, hasCharacterReference } from './scan.js';
import { serializeBlocks } from './serialize.js';
import type { Block, Inline } from './tree.js';
import { type ContentViolationKind, orderViolations } from './violations.js';

/** What the content policy needs besides the text. */
export interface ContentCheckOptions {
  /**
   * The keys of the contact values a text may hold, from the list of the
   * policy (`contactKeyOf`). Every other e-mail address, phone number,
   * IBAN and AHV number refuses the text.
   */
  readonly contacts: ReadonlySet<string>;
}

/** What a check gives: the text to write, or every reason to refuse it. */
export type ContentCheckResult =
  | { readonly ok: true; readonly text: string }
  | {
      readonly ok: false;
      readonly violations: readonly ContentViolationKind[];
    };

const refused = (
  kinds: Iterable<ContentViolationKind>,
): ContentCheckResult => ({ ok: false, violations: orderViolations(kinds) });

const plain = (nodes: readonly Inline[]): string =>
  nodes
    .map((node) => (node.kind === 'text' ? node.text : plain(node.children)))
    .join('');

// The plain text of each heading, paragraph and cell, as a reader sees it:
// bold and italic joined to their neighbours, line breaks as spaces.
const readableTexts = (blocks: readonly Block[]): string[] =>
  blocks.flatMap((block) => {
    switch (block.kind) {
      case 'heading':
      case 'paragraph':
        return [plain(block.children).replaceAll('\n', ' ')];
      case 'list':
        return block.items.flatMap(readableTexts);
      case 'table':
        return [...block.header, ...block.rows.flat()].map(plain);
    }
  });

const bytesOf = (text: string): number =>
  new TextEncoder().encode(text).byteLength;

/**
 * Checks a text in Markdown, such as the text of a page of the wiki or a
 * section to add, and gives the form to write.
 *
 * @param markdown - The text as the tool handed it over.
 * @param options - The contact values the policy lists.
 * @returns The text to write, or the reasons to refuse it, in the order of
 *   `contentViolationKinds`.
 * @example
 * ```ts
 * checkMarkdown('# Plan\n* Probe', { contacts: new Set() });
 * // { ok: true, text: '# Plan\n\n- Probe\n' }
 * checkMarkdown('Mehr: [hier](https://example.org)', { contacts: new Set() });
 * // { ok: false, violations: ['link'] }
 * ```
 */
export function checkMarkdown(
  markdown: string,
  options: ContentCheckOptions,
): ContentCheckResult {
  const normal = normalizeContent(markdown);
  if (!normal.ok) return refused([normal.violation]);
  if (hasTooManyDelimiters(normal.text)) return refused(['tooLong']);
  const read = readMarkdown(normal.text);
  if (!read.ok) return refused(read.violations);
  const text = serializeBlocks(read.blocks);
  // Escaping adds signs, so a text near the limit can pass it only before.
  if (bytesOf(text) > maxContentBytes) return refused(['tooLong']);
  // The written form is read once more. The lexer does not always read
  // emphasis the same way after a mark of punctuation, so a text whose
  // written form it reads differently is refused: what passes is always a
  // form that comes back unchanged.
  // Joining parts of bold or of text can bring two signs together that
  // NFKC composes, such as = and a long stroke: then the written text is
  // not its own normal form and would change on the next check.
  const again = readMarkdown(text);
  const stable = normalizeContent(text);
  if (
    !again.ok ||
    serializeBlocks(again.blocks) !== text ||
    !stable.ok ||
    stable.text !== text
  ) {
    return refused(['unparsable']);
  }
  // What a reader sees, in the text as it came and as it is written, so
  // that emphasis read one way or the other hides nothing.
  const found = [
    ...readableTexts(read.blocks),
    ...readableTexts(again.blocks),
  ].flatMap((value) => checkReadableText(value, options.contacts));
  return found.length > 0 ? refused(found) : { ok: true, text };
}

const isHtmlStart = (code: number): boolean =>
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x61 && code <= 0x7a) ||
  code === 0x2f ||
  code === 0x21 ||
  code === 0x3f;

// Whether a plain text holds what a browser could read as a tag: < before
// a letter, /, ! or ?.
const hasTag = (text: string): boolean => {
  let at = text.indexOf('<');
  while (at !== -1) {
    if (isHtmlStart(text.charCodeAt(at + 1))) return true;
    at = text.indexOf('<', at + 1);
  }
  return false;
};

// Signs that start a link, code or an escape in Markdown, and the
// separators of lines and paragraphs of Unicode. A title is written
// without escaping, so should anything ever show it as Markdown, none of
// them may be there.
const plainEnds = '[]`\\\n\u2028\u2029';

const hasMarkdownSign = (text: string): boolean => {
  for (const sign of text) if (plainEnds.includes(sign)) return true;
  return false;
};

/**
 * Checks a text without Markdown, such as the title of a page: the same
 * limit, normal form and checks of what a reader sees, one line, no `<`
 * before a letter, `/`, `!` or `?`, no character reference and none of
 * `[`, `]`, a backtick or a backslash. It is written as it is, without
 * escaping.
 *
 * @param text - The text as the tool handed it over.
 * @param options - The contact values the policy lists.
 * @returns The text in its normal form, or the reasons to refuse it.
 * @example
 * ```ts
 * checkPlainText('Ｐlan 2026', { contacts: new Set() }); // { ok: true, text: 'Plan 2026' }
 * checkPlainText('Plan\nB', { contacts: new Set() }); // { ok: false, violations: ['unsupported'] }
 * ```
 */
export function checkPlainText(
  text: string,
  options: ContentCheckOptions,
): ContentCheckResult {
  const normal = normalizeContent(text);
  if (!normal.ok) return refused([normal.violation]);
  const found: ContentViolationKind[] = [];
  if (hasTag(normal.text) || hasCharacterReference(normal.text)) {
    found.push('html');
  }
  if (hasMarkdownSign(normal.text)) found.push('unsupported');
  found.push(...checkReadableText(normal.text, options.contacts));
  return found.length > 0 ? refused(found) : { ok: true, text: normal.text };
}
