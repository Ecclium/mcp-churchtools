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
 * sees each change and the page cannot fake that form. A combining mark at
 * the start of a line is shown the same way, since it would join the sign
 * of the diff before it, and so are the quotes of a title, since they
 * would close the quote it stands in. The title of a new page is written
 * in full, so the question shows it in full on a line of its own.
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

import {
  crLfMarker,
  diffLines,
  type LineDiff,
  noLineEndMarker,
  renderDiff,
} from '../diff/index.js';

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
  /**
   * The whole title of a new page, made visible: it is written as it is,
   * so the person sees all of it, not only the cut one of the summary.
   */
  readonly title?: string;
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
 * visibleText('a\u202eb\\c'); // 'a\\u{202e}b\\\\c'
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

// The quotes the fixed sentences put around a title, as code points.
const quotes: readonly number[] = Object.freeze([0xab, 0xbb, 0x2039, 0x203a]);

// A title as the text shows it: made visible, with its quotes as code points
// too, so that it cannot close the quote it stands in.
const titleText = (title: string): string => {
  let shown = '';
  for (const character of visibleText(title)) {
    const point = Number(character.codePointAt(0));
    shown += quotes.includes(point) ? `\\u{${point.toString(16)}}` : character;
  }
  return shown;
};

// A title as a summary names it: at most 80 code points of the original,
// then made visible, so that a cut never splits a visible form.
const titleOf = (title: string): string => {
  const points = Array.from(title);
  const cut =
    points.length > maxSummaryTitleLength
      ? `${points.slice(0, maxSummaryTitleLength - 1).join('')}…`
      : title;
  return titleText(cut);
};

// The combining marks, which join the character before them.
const combiningRanges: readonly (readonly [number, number])[] = Object.freeze([
  [0x0300, 0x036f],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x20d0, 0x20ff],
  [0xfe20, 0xfe2f],
]);

const isCombining = (point: number): boolean =>
  combiningRanges.some(([from, to]) => point >= from && point <= to);

// A line of the diff as the text shows it. The header of a hunk and the two
// marks of a line ending come from the core and stay as they are. Every
// other line is its sign and a line of the page, which is made visible, a
// combining mark at its start too, so that it cannot join the sign.
const shownLine = (line: string): string => {
  if (
    line.startsWith('@@ ') ||
    line === noLineEndMarker ||
    line === crLfMarker
  ) {
    return line;
  }
  const content = visibleText(line.slice(1));
  const first = Number(content.codePointAt(0));
  // Every combining mark lies in the basic plane, one code unit long.
  return isCombining(first)
    ? `${line.slice(0, 1)}\\u{${first.toString(16)}}${content.slice(1)}`
    : `${line.slice(0, 1)}${content}`;
};

// A text that ends with a line break, for the diff a person reads.
const lineEnded = (text: string): string =>
  text === '' || text.endsWith('\n') ? text : `${text}\n`;

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
  // ChurchTools stores a text without a line break at its end (F51), so
  // the last line of a page has none before a section is appended and has
  // one after. A person reads lines: with a line break added to both texts
  // the question shows only the new lines, not the last one as changed.
  const diff = diffLines(lineEnded(preview.before), lineEnded(preview.after));
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
  const shown = Object.freeze(renderDiff(diff).map(shownLine));
  // The whole title of a new page goes into the question, so it counts.
  const whole =
    preview.kind === 'wikiPageCreate' ? titleText(preview.title) : undefined;
  const characters = shown.reduce(
    (sum, line) => sum + line.length + 1,
    whole?.length ?? 0,
  );
  return Object.freeze({
    summary,
    ...(whole === undefined ? {} : { title: whole }),
    diff: shown,
    fits:
      added + removed <= confirmationLimits.changedLines &&
      characters <= confirmationLimits.characters,
  });
}

/**
 * What the write guard knows of a write of an appointment or a booking when
 * it seals its plan (ADR 0072). Names and texts come from ChurchTools or
 * the tool and are made visible.
 */
export interface DatedPreview {
  readonly kind: 'appointmentCreate' | 'appointmentUpdate' | 'bookingCreate';
  /** The calendar or the resource: its name as read, or its ID. */
  readonly place: { readonly id: number; readonly name?: string };
  /** The title: as read for a change, as planned for a new one. */
  readonly title: string;
  /** The span after the write, as {@link spanTextOf} gives it. */
  readonly span: string;
  /** The fields now as lines, empty for a new appointment or booking. */
  readonly before: string;
  /** The fields after the write as lines. */
  readonly after: string;
  /**
   * The German names of the fields a change changes; empty for a new
   * appointment or booking.
   */
  readonly changed: readonly string[];
  /**
   * Whether anyone, also not signed in, sees the appointment: a public
   * calendar and an appointment that is not internal.
   */
  readonly isPublic?: boolean;
  /** For a booking, how many other bookings the resource has at the time. */
  readonly overlapping?: number;
}

// The German list of a few names: «a», «a und b», «a, b und c».
const listOf = (names: readonly string[]): string =>
  names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} und ${String(names.at(-1))}`;

const placeOf = (
  kind: DatedPreview['kind'],
  place: DatedPreview['place'],
): string => {
  const where = kind === 'bookingCreate' ? 'der Ressource' : 'im Kalender';
  return place.name === undefined
    ? `${where} ${String(place.id)}`
    : `${where} «${titleOf(place.name)}»`;
};

/**
 * Makes the text of a confirmation of an appointment or a booking: a
 * summary in German with title, place and span, whether the calendar is
 * public, and for a booking request that ChurchTools mails its title and
 * description to the managers of the resource (F48), and the diff of the
 * fields as lines with every character visible.
 *
 * @param preview - What the write guard read and would write.
 * @returns The text, frozen.
 * @example
 * ```ts
 * const text = datedConfirmationTextOf({ kind: 'bookingCreate',
 *   place: { id: 13, name: 'Saal' }, title: 'Probe',
 *   span: 'Sonntag, 08.11.2026, 09:00 bis 10:00 (UTC)', before: '',
 *   after: 'Titel: Probe\n', changed: [], overlapping: 0 });
 * text.summary.startsWith('Eine Buchung der Ressource «Saal» anfragen'); // true
 * ```
 */
export function datedConfirmationTextOf(
  preview: DatedPreview,
): ConfirmationText {
  const diff = diffLines(preview.before, preview.after);
  const { added, removed } = countsOf(diff);
  const title = titleOf(preview.title);
  const place = placeOf(preview.kind, preview.place);
  const visible =
    preview.isPublic === true
      ? ' Der Kalender ist öffentlich: Den Termin sieht auch, wer nicht angemeldet ist.'
      : '';
  let summary: string;
  switch (preview.kind) {
    case 'appointmentCreate':
      summary = `Einen Termin «${title}» ${place} anlegen: ${preview.span}.${visible}`;
      break;
    case 'appointmentUpdate':
      summary = `Beim Termin «${title}» ${place} ${listOf(preview.changed)} ändern, danach ${preview.span}.${visible}`;
      break;
    case 'bookingCreate': {
      const others = preview.overlapping ?? 0;
      const busy =
        others === 0
          ? ''
          : others === 1
            ? ' Zur selben Zeit hat die Ressource eine weitere Buchung.'
            : ` Zur selben Zeit hat die Ressource ${String(others)} weitere Buchungen.`;
      summary = `Eine Buchung ${place} anfragen: «${title}», ${preview.span}. ChurchTools schickt Titel und Beschreibung per Mail an die Verwalter der Ressource.${busy}`;
      break;
    }
  }
  const shown = Object.freeze(renderDiff(diff).map(shownLine));
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
    ...(text.title === undefined
      ? []
      : [`Titel der neuen Seite: «${text.title}»`, '']),
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
