/**
 * The content policy in the write guard (ADR 0030): every text of a write
 * is checked while the write is planned, and the plan is sealed with the
 * form the content policy gives.
 *
 * Where it stands in the way of a write: in planning, right after the
 * intent is read and its rules are known, before the rights and before
 * the core asks ChurchTools anything. A refused text so costs neither a
 * request nor a place of the day of the policy. The commit derives the
 * plan again from the sealed intent, whose texts are already in their
 * written form, so it writes and hashes exactly what was checked and
 * confirmed; the check needs no second run there.
 *
 * @packageDocumentation
 */
import {
  type ContentViolationKind,
  EccliumError,
  type TenantContext,
  type WriteIntent,
} from '@ecclium/mcp-churchtools-plugin-api';

import { maxMessageLength } from '../errors/index.js';
import { markingTextsOf } from '../marker/index.js';
import {
  checkMarkdown,
  checkPlainText,
  type ContentCheckResult,
  contentSentences,
  orderViolations,
} from '../content/index.js';

/** The writes of the wiki, the only ones this version runs. */
type WikiIntent = Extract<WriteIntent, { categoryId: number }>;

/**
 * A text refused by the content policy: the error the tool gets, and the
 * reasons for the audit. It never leaves the core; the pipeline passes on
 * only the error. It is an Error only so that it may be thrown, and its
 * message stays empty.
 *
 * @example
 * ```ts
 * const refusal = new ContentRefusal(['link']);
 * refusal.error.code; // 'validation'
 * refusal.violations; // ['link']
 * ```
 */
export class ContentRefusal extends Error {
  /** The error with the fixed sentences of the reasons. */
  readonly error: EccliumError;
  /** The reasons, in their fixed order. */
  readonly violations: readonly ContentViolationKind[];

  /**
   * Builds the refusal with the sentence of every reason.
   *
   * @param violations - The reasons the content policy gave.
   */
  constructor(violations: readonly ContentViolationKind[]) {
    super();
    this.name = 'ContentRefusal';
    this.violations = violations;
    // A message longer than the limit reaches the model only as a general
    // sentence, so the sentences go in their order as long as they fit:
    // the model fixes the first reasons and learns the rest on its next
    // try. The audit names all of them.
    let message = '';
    for (const kind of violations) {
      const next =
        message === ''
          ? contentSentences[kind]
          : `${message} ${contentSentences[kind]}`;
      if (next.length > maxMessageLength) break;
      message = next;
    }
    this.error = new EccliumError('validation', message);
    Object.freeze(this);
  }
}

// One log line per reason, written out so that the catalog of the log
// lines finds each one.
const eventOf = Object.freeze({
  tooLong: 'content_too_long',
  unparsable: 'content_unparsable',
  html: 'content_html',
  image: 'content_image',
  link: 'content_link',
  mention: 'content_mention',
  reference: 'content_reference',
  webAddress: 'content_web_address',
  contact: 'content_contact',
  masked: 'content_masked',
  unsupported: 'content_unsupported',
  tooDeep: 'content_too_deep',
  marking: 'content_marking',
} as const);

/**
 * Checks the texts of a write of the wiki and gives the intent with their
 * written form: the title of a new page as plain text, its text, the new
 * text of a page and a section to add as Markdown. The text of the page a
 * section is added to is not checked: it stays as it is.
 *
 * @param ctx - The context of the call, for the log.
 * @param intent - The checked copy of the intent.
 * @param contacts - The keys of the contact values of the policy.
 * @returns The intent with the texts in their written form, frozen.
 * @throws {ContentRefusal} With every reason of every text.
 * @example
 * ```ts
 * checkIntentContent(ctx, { kind: 'wikiSectionAppend', categoryId: 12, guid, section: '* Probe', baseVersion: 3 }, new Set());
 * // { ..., section: '- Probe\n' }
 * ```
 */
export function checkIntentContent(
  ctx: TenantContext,
  intent: WikiIntent,
  contacts: ReadonlySet<string>,
): WikiIntent {
  const options = { contacts };
  const results: ContentCheckResult[] = [];
  const text = (result: ContentCheckResult): string => {
    results.push(result);
    return result.ok ? result.text : '';
  };
  // What Ecclium adds as a whole gets its line of the marking from the
  // core alone, so a text that brings one is refused (ADR 0032). A change
  // of a page may keep the lines the page has, which the guard checks once
  // it has read the page.
  const added = (result: ContentCheckResult): string => {
    const written = text(result);
    if (markingTextsOf(written).length > 0) {
      results.push({ ok: false, violations: ['marking'] });
    }
    return written;
  };
  let checked: WikiIntent;
  switch (intent.kind) {
    case 'wikiPageCreate':
      checked = {
        ...intent,
        title: added(checkPlainText(intent.title, options)),
        text: added(checkMarkdown(intent.text, options)),
      };
      break;
    case 'wikiPageUpdate':
      checked = { ...intent, text: text(checkMarkdown(intent.text, options)) };
      break;
    case 'wikiSectionAppend':
      checked = {
        ...intent,
        section: added(checkMarkdown(intent.section, options)),
      };
      break;
  }
  const violations = orderViolations(
    results.flatMap((result) => (result.ok ? [] : result.violations)),
  );
  if (violations.length > 0) {
    for (const kind of violations) ctx.log.warn(eventOf[kind]);
    throw new ContentRefusal(violations);
  }
  return Object.freeze(checked);
}
