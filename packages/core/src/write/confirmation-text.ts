/**
 * The text of a confirmation (ADR 0029): what a person sees before a write,
 * made by the core from what the write guard read and the text it would
 * write, never by a tool.
 *
 * Where it stands in the way of a write: planning ends with a sealed plan
 * and this text. The pipeline asks the person with it through the client
 * (a question of elicitation); the echo and the queue of the operator show
 * the same summary and the same diff. Since no tool makes it, no tool can
 * hide what a write does.
 *
 * The text of a page comes from ChurchTools and may hold any character,
 * also one that turns the direction of the text, cannot be seen or could
 * control a terminal. Before it goes into the text, every such character
 * becomes a visible `\u{…}` and a backslash is doubled, so that the person
 * sees each change and the page cannot fake that form.
 *
 * A diff longer than a person can read in a dialog gets no question: the
 * plan goes to the queue of the operator, where it is shown whole (decided
 * on 03.11.2026, see `docs/STATUS.md`). The limits are
 * {@link confirmationLimits}.
 *
 * @packageDocumentation
 */
import type { WriteIntentKind } from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

import { diffLines, type LineDiff, renderDiff } from '../diff/index.js';

/**
 * The most a question shows: the changed lines of the diff, removed and
 * added together, and the characters of the diff as shown. A longer diff
 * goes to the queue instead.
 */
export const confirmationLimits = Object.freeze({
  changedLines: 120,
  characters: 12_000,
});

/** The most characters of a title in a summary, before it is cut. */
export const maxSummaryTitleLength = 80;

/** What the write guard knows of a write when it seals its plan. */
export interface ConfirmationPreview {
  /** The kind of the intent, one of the wiki in this version. */
  readonly kind: Extract<
    WriteIntentKind,
    'wikiPageCreate' | 'wikiPageUpdate' | 'wikiSectionAppend'
  >;
  /** The category of the page. */
  readonly categoryId: number;
  /** The title of the page: as read for a change, as planned for a new one. */
  readonly title: string;
  /** The text of the page now, empty for a new page. */
  readonly before: string;
  /** The text of the page after the write. */
  readonly after: string;
}

/** The text of a confirmation. */
export interface ConfirmationText {
  /** One sentence in German that says what the write does. */
  readonly summary: string;
  /** The diff as lines to read, every character visible. */
  readonly diff: readonly string[];
  /** Whether the diff is short enough for a question. */
  readonly fits: boolean;
}

// The code points a reader does not see as what they are: controls of C0
// but the tab, DEL and C1, controls of the writing direction, characters
// of zero width and other formats, separators of lines and paragraphs,
// fillers that look blank, variation selectors and the tag characters.
// Ranges by hand instead of a regular expression, because the text comes
// from the tenant and the legacy statics of RegExp would keep it.
const hiddenRanges: readonly (readonly [number, number])[] = Object.freeze([
  [0x00, 0x08],
  [0x0a, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x034f, 0x034f],
  [0x0600, 0x0605],
  [0x061c, 0x061c],
  [0x06dd, 0x06dd],
  [0x070f, 0x070f],
  [0x0890, 0x0891],
  [0x08e2, 0x08e2],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x205f, 0x206f],
  [0x3164, 0x3164],
  [0xd800, 0xdfff],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfffb],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff],
]);

const isHidden = (point: number): boolean =>
  hiddenRanges.some(([from, to]) => point >= from && point <= to);

/**
 * Makes foreign text visible: every character a reader would not see as
 * what it is becomes `\u{…}` with its code point in hex, a lone surrogate
 * included, and a backslash becomes two, so that the text cannot write
 * that form itself.
 *
 * @param text - Text from ChurchTools or from a tool.
 * @returns The text with every hidden character visible.
 * @example
 * ```ts
 * visibleText('a‮b\\c'); // 'a\\u{202e}b\\\\c'
 * ```
 */
export function visibleText(text: string): string {
  let shown = '';
  // for…of goes by code points and gives a lone surrogate on its own; each
  // character it gives has a code point at 0.
  for (const character of text) {
    const point = Number(character.codePointAt(0));
    if (character === '\\') shown += '\\\\';
    else if (isHidden(point)) shown += `\\u{${point.toString(16)}}`;
    else shown += character;
  }
  return shown;
}

// A title as a summary names it: at most 80 code points of the original,
// then made visible, so that a cut never splits a visible form.
const titleOf = (title: string): string => {
  const points = Array.from(title);
  const cut =
    points.length > maxSummaryTitleLength
      ? `${points.slice(0, maxSummaryTitleLength - 1).join('')}…`
      : title;
  return visibleText(cut);
};

const lines = (count: number): string =>
  count === 1 ? '1 Zeile' : `${String(count)} Zeilen`;

// How many lines a diff adds and removes.
const countsOf = (
  diff: LineDiff,
): { readonly added: number; readonly removed: number } => {
  let added = 0;
  let removed = 0;
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'added') added += 1;
      else if (line.kind === 'removed') removed += 1;
    }
  }
  return { added, removed };
};

/**
 * Makes the text of a confirmation: a summary in one German sentence, with
 * the title of the page made visible and cut at
 * {@link maxSummaryTitleLength} characters, the diff of the text as lines
 * with every character visible, and whether both fit into a question.
 *
 * @param preview - What the write guard read and would write.
 * @returns The text, frozen.
 * @example
 * ```ts
 * const text = confirmationTextOf({ kind: 'wikiSectionAppend',
 *   categoryId: 12, title: 'Plan', before: '# Plan\n',
 *   after: '# Plan\n\n## Nachtrag\n' });
 * text.summary;
 * // 'An die Seite «Plan» in der Kategorie 12 einen Abschnitt mit 2 Zeilen anhängen.'
 * ```
 */
export function confirmationTextOf(
  preview: ConfirmationPreview,
): ConfirmationText {
  const diff = diffLines(preview.before, preview.after);
  const { added, removed } = countsOf(diff);
  const title = titleOf(preview.title);
  const category = String(preview.categoryId);
  let summary: string;
  switch (preview.kind) {
    case 'wikiPageCreate':
      summary = `Neue Seite «${title}» in der Kategorie ${category} mit ${lines(added)} anlegen.`;
      break;
    case 'wikiPageUpdate':
      summary = `Die Seite «${title}» in der Kategorie ${category} ändern: ${lines(added)} neu, ${lines(removed)} weg.`;
      break;
    case 'wikiSectionAppend':
      summary = `An die Seite «${title}» in der Kategorie ${category} einen Abschnitt mit ${lines(added)} anhängen.`;
      break;
  }
  const shown = Object.freeze(renderDiff(diff).map(visibleText));
  const characters = shown.reduce((sum, line) => sum + line.length + 1, 0);
  return Object.freeze({
    summary,
    diff: shown,
    fits:
      added + removed <= confirmationLimits.changedLines &&
      characters <= confirmationLimits.characters,
  });
}

/** The name of the one field of the form of a question. */
export const confirmationField = 'bestaetigen';

/**
 * The question to the person, in German: what Ecclium would write, the
 * diff and how to confirm it.
 *
 * @param text - The text of the confirmation.
 * @returns The message of the question.
 * @example
 * ```ts
 * confirmationMessage(text).startsWith('Ecclium möchte'); // true
 * ```
 */
export function confirmationMessage(text: ConfirmationText): string {
  return [
    'Ecclium möchte in ChurchTools schreiben.',
    '',
    text.summary,
    '',
    ...text.diff,
    '',
    'Wählen Sie «Ja», damit Ecclium genau diese Änderung schreibt. Ohne Bestätigung schreibt Ecclium nichts.',
  ].join('\n');
}

/**
 * The form of a question as the client gets it: one field, yes or no. A
 * plain object type, so that it fits the form the SDK takes.
 */
export type ConfirmationForm = {
  type: 'object';
  properties: {
    [confirmationField]: {
      type: 'boolean';
      title: string;
      description: string;
    };
  };
  required: string[];
};

/**
 * The form of a question: one field «Schreiben bestätigen», yes or no, as
 * the spike of elicitation showed it to work in a client. Made anew for
 * every question, so that nothing can change a shared copy.
 *
 * @returns The form.
 * @example
 * ```ts
 * confirmationForm().required; // ['bestaetigen']
 * ```
 */
export function confirmationForm(): ConfirmationForm {
  return {
    type: 'object',
    properties: {
      [confirmationField]: {
        type: 'boolean',
        title: 'Schreiben bestätigen',
        description: 'Ja, wenn Ecclium diese Änderung schreiben soll.',
      },
    },
    required: [confirmationField],
  };
}

// The content of an accepted answer: exactly the one field, a boolean.
// The shim of the SDK does not check it against the form (ADR 0053).
const answerSchema = z.strictObject({ [confirmationField]: z.boolean() });

/**
 * Tells whether the content of an accepted answer confirms the write: the
 * one field and nothing else, set to yes. Anything else, no answers too,
 * confirms nothing.
 *
 * @param content - The content of an accepted answer, as the client sent it.
 * @returns Whether it confirms.
 * @example
 * ```ts
 * isConfirmed({ bestaetigen: true }); // true
 * isConfirmed({ bestaetigen: 'ja' }); // false
 * ```
 */
export function isConfirmed(content: unknown): boolean {
  const parsed = answerSchema.safeParse(content);
  return parsed.success && parsed.data[confirmationField];
}
