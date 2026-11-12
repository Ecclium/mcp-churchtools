/**
 * The rules of an adoption (ADR 0032): what `ecclium marker adopt` signs
 * anew on a page, proven by the snapshot of the write that left it there.
 *
 * Where it stands in the way of a write: once the key of the check codes
 * is lost or replaced, no section of a run fits its code any more, and the
 * next run of the same period queues its write as the change of a person.
 * The write guard asks this module which line of the marking the period
 * has on the page, whether a snapshot of a write of the routine proves
 * where its section begins, and what the line becomes with the code of the
 * key of today. The module reads and writes nothing itself.
 *
 * The proof: a run appends its section as `appendSection` builds it, the
 * text before in the form ChurchTools stores, an empty line and the
 * section with its line, or the section alone on an empty page. Its
 * snapshot keeps the text before and the hash of the text after. When the
 * page up to the line of the marking has that hash and begins with that
 * text, the section is exactly what the write appended, and no one changed
 * it since. The line in the hash names routine and period, so only a write
 * that appended this very line proves anything. A section a later run of
 * the period replaced, or a page saved in the web editor since, has no
 * proof: the start of a replaced section was known only to the old key.
 *
 * The new line is the line as it stands with only the code replaced: the
 * code of the key of today over the canonical form of the section. Day,
 * routine, period and whom to ask stay, and no code comes from an input.
 * Before anything is written, the page with the new line is judged as a
 * run judges it, and the section must count as Ecclium's own, from the
 * same first line to the same line of the marking.
 *
 * @packageDocumentation
 */
import { storedWikiText } from '../churchtools/wiki-writes.js';
import type { KeyMaterial } from '../keys/index.js';
import { checkCodeOf, judgeSections, type Marking } from '../marker/index.js';
import {
  canonicalSectionOf,
  type MarkingAskedFor,
  markingsAskedFor,
} from '../marker/sections.js';
import { contentHashOf } from './plan-hash.js';

/** What the snapshot of a write of the routine keeps of its page. */
export interface WrittenPage {
  /** The text of the page before the write. */
  readonly before: string;
  /** The hash of the text after the write, from `contentHashOf`. */
  readonly afterHash: string;
}

/** Why the core cannot tell which section to sign. */
export type AdoptionUnclear = 'several' | 'hidden' | 'unreadable';

/** What an adoption finds on a page for one routine and period. */
export type AdoptionPlan =
  /** A line of the period whose code fits already: nothing to do. */
  | { readonly kind: 'own' }
  /** No line of the marking of the period on the page. */
  | { readonly kind: 'none' }
  /**
   * More than one line of the period whose code fits no section, HTML
   * that could hide a section, or a page the lexer cannot read.
   */
  | { readonly kind: 'unclear'; readonly reason: AdoptionUnclear }
  /**
   * One line, but no snapshot proves its section. `range` holds the lines
   * from the line of the marking before, or the start of the page, to the
   * line itself, for the operator to look at.
   */
  | { readonly kind: 'unproven'; readonly range: string }
  /**
   * A snapshot proves the section, but the line is not in the fixed form,
   * the section has no canonical form, or the page with the new line would
   * not judge the section as Ecclium's own.
   */
  | { readonly kind: 'unsignable'; readonly range: string }
  /** The section, proven, and the page with its new line. */
  | {
      readonly kind: 'proven';
      /** Which of the pages given proved it, from 0. */
      readonly proof: number;
      /** The number of its first line, from 0. */
      readonly start: number;
      /** The number of its line of the marking. */
      readonly end: number;
      /** Its lines as they stand on the page. */
      readonly section: string;
      /** The line of the marking as it stands. */
      readonly oldLine: string;
      /** The same line with the new code. */
      readonly newLine: string;
      /** The text of the page with the new line. */
      readonly text: string;
    };

/** What {@link planAdoption} judges. */
export interface AdoptionOptions {
  /** The key of the check codes of today. */
  readonly key: KeyMaterial;
  /** The tenant of the page. */
  readonly tenantId: string;
  /** The text of the page as read now. */
  readonly text: string;
  /** The ID of the routine. */
  readonly routine: string;
  /** The period of the section, such as `2026-W46`. */
  readonly period: string;
  /**
   * What the snapshots of the writes of the routine on this page kept,
   * the newest first. The first that proves the section counts.
   */
  readonly written: readonly WrittenPage[];
}

// The line of the first section that the write of a page appended, when
// the page up to the line of its marking is the text the write left.
const startOf = (written: WrittenPage, prefix: string): number | undefined => {
  if (contentHashOf([prefix]) !== written.afterHash) return undefined;
  const head = storedWikiText(written.before);
  if (head === '') return 0;
  return prefix.startsWith(`${head}\n\n`)
    ? head.split('\n').length + 1
    : undefined;
};

// The line up to the code, as `markingLineOf` writes it for a run.
const fixedPartOf = (marking: Marking, routine: string, period: string) => {
  const { date } = marking;
  const day = `${date.slice(8, 10)}.${date.slice(5, 7)}.${date.slice(0, 4)}`;
  return `Automatisch erstellt am ${day} durch Ecclium, Routine ${routine}, Lauf ${period}, Prüfcode `;
};

/**
 * Judges a page for an adoption: the line of the marking of the period,
 * the proof of its section from a snapshot, and the page with the new
 * line.
 *
 * @param options - Key, tenant, page, routine, period and what the
 *   snapshots of the writes of the routine kept.
 * @returns What the adoption finds, frozen.
 * @example
 * ```ts
 * const plan = planAdoption({ key, tenantId, text: page.text, routine, period, written });
 * if (plan.kind === 'proven') plan.newLine;
 * ```
 */
export function planAdoption(options: AdoptionOptions): AdoptionPlan {
  const { key, tenantId, text, routine, period } = options;
  const matches = (marking: Marking): boolean =>
    marking.origin.kind === 'routine' &&
    marking.origin.routine === routine &&
    marking.origin.run === period;
  const judged = judgeSections({ key, tenantId, text, matches });
  if (judged.kind !== 'changed') return Object.freeze({ kind: judged.kind });
  const found = markingsAskedFor({ text, matches });
  const unclear = (reason: AdoptionUnclear): AdoptionPlan =>
    Object.freeze({ kind: 'unclear', reason });
  if (found.kind === 'unreadable') return unclear('unreadable');
  if (found.lines.length > 1) return unclear('several');
  if (found.hides) return unclear('hidden');
  // The page judged as changed holds a line of the period.
  const { marking, line: end, earliest } = found.lines[0] as MarkingAskedFor;
  const lines = text.split('\n');
  const range = lines.slice(earliest, end + 1).join('\n');
  const prefix = lines.slice(0, end + 1).join('\n');
  let proof = -1;
  let start: number | undefined;
  for (const [index, written] of options.written.entries()) {
    start = startOf(written, prefix);
    if (start !== undefined) {
      proof = index;
      break;
    }
  }
  if (start === undefined) return Object.freeze({ kind: 'unproven', range });
  const unsignable = Object.freeze({ kind: 'unsignable', range } as const);
  const oldLine = lines[end] as string;
  const fixed = fixedPartOf(marking, routine, period);
  const canonical = canonicalSectionOf(text, start, end);
  if (canonical === undefined || !oldLine.startsWith(fixed + marking.code)) {
    return unsignable;
  }
  const code = checkCodeOf(key, tenantId, marking.origin, canonical);
  const newLine = `${fixed}${code}${oldLine.slice(fixed.length + marking.code.length)}`;
  const next = [...lines.slice(0, end), newLine, ...lines.slice(end + 1)];
  const nextText = next.join('\n');
  // The page as every run judges it: the section must be Ecclium's own
  // again, exactly where the proof put it.
  const again = judgeSections({ key, tenantId, text: nextText, matches });
  if (again.kind !== 'own' || again.start !== start || again.end !== end) {
    return unsignable;
  }
  return Object.freeze({
    kind: 'proven',
    proof,
    start,
    end,
    section: lines.slice(start, end).join('\n'),
    oldLine,
    newLine,
    text: nextText,
  });
}
