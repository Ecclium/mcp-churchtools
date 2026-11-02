/**
 * The reasons why the content policy refuses a text (ADR 0030), and the
 * fixed sentence the model reads for each.
 *
 * Where it stands in the way of a write: the content policy checks every
 * text of a write while the write is planned, before the core asks
 * ChurchTools anything. A refused text ends the plan with these sentences.
 * They never quote the text: the audit and the log record only the names
 * of the reasons, and the model already knows what it wrote.
 *
 * @packageDocumentation
 */

/**
 * Every reason the content policy knows, in a fixed order. The names stand
 * in the log and, from the write guard on, in the audit.
 */
export const contentViolationKinds = Object.freeze([
  'tooLong',
  'unparsable',
  'html',
  'image',
  'link',
  'mention',
  'reference',
  'webAddress',
  'contact',
  'masked',
  'unsupported',
  'tooDeep',
] as const);

/** One reason why the content policy refuses a text. */
export type ContentViolationKind = (typeof contentViolationKinds)[number];

/**
 * The sentence for each reason, in English like every text for the model.
 * Each says what the server does not write and what to do instead.
 */
export const contentSentences: Readonly<Record<ContentViolationKind, string>> =
  Object.freeze({
    tooLong:
      'The text is longer than 64 KiB, or holds more than 2000 of the signs *, _, ~ and ! together, the most this server writes in one field.',
    unparsable:
      'The server cannot read the text as Markdown. Write it more simply.',
    html: 'The text holds HTML, which this server does not write. Use Markdown only.',
    image: 'The text holds an image, which this server does not write.',
    link: 'The text holds a link, which this server does not write. Name the page or the site without a link.',
    mention:
      'The text mentions a person with a link, which this server does not write. Write the name as plain text.',
    reference:
      'The text holds a reference or a footnote in Markdown, which this server does not write.',
    webAddress:
      'The text holds something a reader could take for a web address, which ChurchTools may show as a link. Leave it out, or put a space after the dot.',
    contact:
      'The text holds an e-mail address, a phone number, an IBAN or an AHV number that the policy of the server does not list. Leave it out, or ask the operator to list it.',
    masked:
      'The text holds a value the server masked, such as [masked], a masked e-mail address or phone number, a pseudonym or the boundary of a data envelope. The server would write the mask instead of the value. Leave it out.',
    unsupported:
      'The text uses Markdown this server does not write. Use headings, paragraphs, lists, tables, bold and italic only.',
    tooDeep:
      'The text nests lists, bold or italic more deeply than this server writes. Use at most five levels of lists.',
  });

/**
 * Sorts reasons into the fixed order and drops repeats, so that a log, an
 * audit line and a test see the same list for the same text.
 *
 * @param kinds - Reasons in any order, maybe repeated.
 * @returns The reasons in the order of {@link contentViolationKinds}, each once.
 * @example
 * ```ts
 * orderViolations(['link', 'html', 'link']); // ['html', 'link']
 * ```
 */
export function orderViolations(
  kinds: Iterable<ContentViolationKind>,
): readonly ContentViolationKind[] {
  const seen = new Set(kinds);
  return Object.freeze(contentViolationKinds.filter((kind) => seen.has(kind)));
}
