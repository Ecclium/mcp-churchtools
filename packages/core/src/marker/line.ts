/**
 * The line of the marking (ADR 0032), with the fixed wording of the brand:
 * «Automatisch erstellt am 05.11.2026 durch Ecclium, interaktiv, Prüfcode
 * k1:ABCDEFGHIJKLM. Rückfragen an Sekretariat.» A run of a routine names
 * the routine and the run instead of «interaktiv».
 *
 * Where it stands in the way of a write: the core ends every page and
 * section it adds to the wiki with this line, as a paragraph of its own,
 * and reads it back to find its own sections. Reading takes the fixed part
 * up to the check code exactly; what follows «Rückfragen an» is free,
 * because it is a setting of the operator and the web editor might turn an
 * address in it into a link. Spaces at the end of the line do not count.
 *
 * @packageDocumentation
 */
import { isIsoDate, type IsoDate } from '@ecclium/mcp-churchtools-plugin-api';

import { serializeBlocks } from '../content/index.js';
import type { MarkingOrigin } from './code.js';

/** What a line of the marking says. */
export interface Marking {
  /** The UTC day the line names; for an interactive write, its day. */
  readonly date: IsoDate;
  /** Where the marking comes from. */
  readonly origin: MarkingOrigin;
  /** The check code, with its prefix. */
  readonly code: string;
}

// The ID of a routine, as the policy names it.
const routinePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
// The period of a run, such as 2026-W40: letters, digits and hyphens.
const runPattern = /^[0-9A-Za-z][0-9A-Za-z-]{0,31}$/;
// The prefix and the signs of a check code of this version (code.ts).
const codePattern = /^k1:[A-Z2-7]{13}$/;

// The line up to the text of the operator. The alternation stands inside a
// group, so both anchors hold for the whole line.
const linePattern =
  /^Automatisch erstellt am (\d{2})\.(\d{2})\.(\d{4}) durch Ecclium, (?:interaktiv|Routine ([a-z0-9][a-z0-9-]{0,62}), Lauf ([0-9A-Za-z][0-9A-Za-z-]{0,31})), Prüfcode (k1:[A-Z2-7]{13})\. Rückfragen an \S/u;

// A sign that ends a sentence, after which the line needs no full stop.
const endsSentence = (text: string): boolean => /[.!?]$/u.test(text);

/**
 * Writes the line of a marking as Markdown: one paragraph on one line,
 * without a line break at the end. The text of the operator is escaped
 * like every text the content policy writes.
 *
 * @param marking - Day, origin and check code.
 * @param inquiriesTo - Whom to ask, as the policy names it.
 * @returns The line.
 * @throws {TypeError} For a day, routine, run or code of another form, an
 *   interactive origin of another day, and a text of the operator that is
 *   empty or holds a line break.
 * @example
 * ```ts
 * markingLineOf({ date, origin: { kind: 'interactive', day: date }, code }, 'Sekretariat');
 * // 'Automatisch erstellt am 05.11.2026 durch Ecclium, interaktiv, Prüfcode k1:…. Rückfragen an Sekretariat.'
 * ```
 */
export function markingLineOf(marking: Marking, inquiriesTo: string): string {
  const { date, origin, code } = marking;
  if (
    !isIsoDate(date) ||
    !codePattern.test(code) ||
    (origin.kind === 'interactive'
      ? origin.day !== date
      : !routinePattern.test(origin.routine) || !runPattern.test(origin.run))
  ) {
    throw new TypeError('A marking needs a day, an origin and a check code.');
  }
  const contact = inquiriesTo.trim();
  if (contact === '' || /[\n\r\u2028\u2029]/u.test(contact)) {
    throw new TypeError('Whom to ask is one line of text.');
  }
  const day = `${date.slice(8, 10)}.${date.slice(5, 7)}.${date.slice(0, 4)}`;
  const from =
    origin.kind === 'interactive'
      ? 'interaktiv'
      : `Routine ${origin.routine}, Lauf ${origin.run}`;
  const text = `Automatisch erstellt am ${day} durch Ecclium, ${from}, Prüfcode ${code}. Rückfragen an ${contact}${endsSentence(contact) ? '' : '.'}`;
  return serializeBlocks([
    { kind: 'paragraph', children: [{ kind: 'text', text }] },
  ]).trimEnd();
}

/**
 * Reads a line of a page as a line of the marking.
 *
 * @param line - One line of a page, without its line break.
 * @returns What the line says, or undefined when it is no such line.
 * @example
 * ```ts
 * readMarkingLine('Automatisch erstellt am 05.11.2026 durch Ecclium, interaktiv, Prüfcode k1:ABCDEFGHIJKLM. Rückfragen an Sekretariat.');
 * // { date: '2026-11-05', origin: { kind: 'interactive', day: '2026-11-05' }, code: 'k1:ABCDEFGHIJKLM' }
 * ```
 */
export function readMarkingLine(line: string): Marking | undefined {
  const match = linePattern.exec(line.trimEnd().normalize('NFC'));
  if (match === null) return undefined;
  // The pattern sets the groups of the day and the code on every match,
  // and those of routine and run together or not at all.
  const date = [match[3], match[2], match[1]].join('-');
  if (!isIsoDate(date)) return undefined;
  const [routine, run, code] = [match[4], String(match[5]), String(match[6])];
  const origin: MarkingOrigin =
    routine === undefined
      ? Object.freeze({ kind: 'interactive', day: date })
      : Object.freeze({ kind: 'routine', routine, run });
  return Object.freeze({ date, origin, code });
}
