/**
 * The rules of taking back a write (ADR 0031): what `ecclium undo` writes
 * and whether the target is still as the write left it.
 *
 * Where it stands in the way of a write: right before its one send, a
 * write of the core kept a snapshot of what it changes (`guard.ts`).
 * `ecclium undo` loads that snapshot, and the write guard asks this module
 * which page to read, which text to write back, whether the page still
 * holds what the write left there, and whether nothing is left to do. The
 * module reads and writes nothing itself.
 *
 * There are these kinds of undo, and all are writes of the core that no
 * plugin can plan:
 *
 * - A page whose text a write changed or extended gets its text from
 *   before the write back, unchanged and without the content policy: it is
 *   the state before Ecclium wrote, not a text of the model, and a page
 *   that held a link before could otherwise never be taken back.
 * - A page a write created is never deleted. Its text becomes a fixed
 *   sentence that Ecclium created and took it back, and its title stays.
 *   That sentence does pass the content policy, as every text Ecclium
 *   writes of its own.
 * - An appointment whose fields a write changed gets its title,
 *   description, start and end from before back (`calendar-plan.ts`).
 * - An appointment or a booking a write created is deleted, but only while
 *   it is as the write left it, and never over a change (ADR 0031).
 *
 * Whether the target is still as the write left it is told by its version
 * and the hash of its text or fields, both kept in the snapshot. The write
 * guard writes over a page or an appointment that someone changed since
 * only when the operator asks for it.
 *
 * @packageDocumentation
 */
import type { IsoDate } from '@ecclium/mcp-churchtools-plugin-api';

import { checkMarkdown } from '../content/index.js';
import type {
  AppointmentFieldsSnapshot,
  PageCreatedSnapshot,
  SnapshotOutcome,
  SnapshotState,
  WikiSnapshotState,
} from '../snapshots/seal.js';
import { contentHashOf } from './plan-hash.js';
import type { WriteTarget } from './rules.js';

/** The snapshot of a write as the undo takes it, from the keeper. */
export interface SnapshotToUndo {
  /** The part before: what the write was to change. */
  readonly before: SnapshotState;
  /** The part after of a new object: its ID and version. */
  readonly after?: SnapshotOutcome;
  /** The UTC day of the part before, the day of the write. */
  readonly day: IsoDate;
}

/** The snapshot of a write of the wiki, which this module takes back. */
export interface WikiSnapshotToUndo {
  readonly before: WikiSnapshotState;
  /** The part after of a new page: its GUID and version. */
  readonly after?: PageCreatedSnapshot;
  readonly day: IsoDate;
}

/** The version and the hash of the fields a write left on its target. */
export interface LeftFields {
  readonly version: number;
  readonly fieldsHash: string;
}

/**
 * What taking back a write of an appointment or a booking means. None of
 * them goes through the content policy or the limits of a text of a tool:
 * what goes back is the state before Ecclium wrote.
 */
export type CalendarUndoTarget =
  /** A change of an appointment: its fields from before go back. */
  | {
      readonly kind: 'restore';
      /** The tool of the write, which the snapshot of the undo names. */
      readonly tool: string;
      readonly calendarId: number;
      readonly appointmentId: number;
      /** The fields and the version before the write. */
      readonly before: AppointmentFieldsSnapshot['before'];
      readonly left: LeftFields;
    }
  /** A new appointment, deleted only while it is as the write left it. */
  | {
      readonly kind: 'deleteAppointment';
      readonly tool: string;
      readonly calendarId: number;
      readonly appointmentId: number;
      readonly left: LeftFields;
    }
  /**
   * A new booking, likewise, and only with the status the write left. Its
   * time names the days whose list tells whether it is gone (F47).
   */
  | {
      readonly kind: 'deleteBooking';
      readonly tool: string;
      readonly resourceId: number;
      readonly bookingId: number;
      readonly left: LeftFields & { readonly statusId: number };
      readonly startDate: string;
      readonly endDate: string;
    };

/** What the snapshot of a write means for its undo. */
export type SnapshotUndo =
  | { readonly area: 'wiki'; readonly snapshot: WikiSnapshotToUndo }
  | { readonly area: 'calendar'; readonly target: CalendarUndoTarget }
  /**
   * A new appointment or booking whose ID was never kept: only its
   * calendar or resource is known, to look at by hand.
   */
  | { readonly area: 'incomplete'; readonly place: WriteTarget };

const placeOf = (kind: 'calendar' | 'resource', id: number): WriteTarget =>
  Object.freeze({ kind, key: String(id) });

/**
 * Tells what the snapshot of a write means for its undo: a write of the
 * wiki, one of an appointment or a booking, or a new one whose ID was
 * never kept.
 *
 * @param snapshot - The snapshot as the keeper found it.
 * @returns What to take back, frozen.
 * @example
 * ```ts
 * const found = undoOf(snapshot);
 * if (found.area === 'wiki') undoTargetOf(found.snapshot);
 * ```
 */
export function undoOf(snapshot: SnapshotToUndo): SnapshotUndo {
  const { before, after, day } = snapshot;
  switch (before.kind) {
    case 'wikiPageText':
    case 'wikiPageCreate':
      return Object.freeze({
        area: 'wiki',
        snapshot:
          after === undefined || after.kind !== 'wikiPageCreated'
            ? { before, day }
            : { before, after, day },
      });
    case 'appointmentFields':
      return Object.freeze({
        area: 'calendar',
        target: Object.freeze({
          kind: 'restore',
          tool: before.tool,
          calendarId: before.calendarId,
          appointmentId: before.appointmentId,
          before: before.before,
          left: before.after,
        }),
      });
    case 'appointmentCreate':
      return after?.kind === 'appointmentCreated'
        ? Object.freeze({
            area: 'calendar',
            target: Object.freeze({
              kind: 'deleteAppointment',
              tool: before.tool,
              calendarId: before.placeId,
              appointmentId: after.id,
              left: { version: after.version, fieldsHash: before.fieldsHash },
            }),
          })
        : Object.freeze({
            area: 'incomplete',
            place: placeOf('calendar', before.placeId),
          });
    case 'bookingCreate':
      return after?.kind === 'bookingCreated'
        ? Object.freeze({
            area: 'calendar',
            target: Object.freeze({
              kind: 'deleteBooking',
              tool: before.tool,
              resourceId: before.placeId,
              bookingId: after.id,
              left: {
                version: after.version,
                fieldsHash: before.fieldsHash,
                statusId: after.statusId,
              },
              startDate: before.startDate,
              endDate: before.endDate,
            }),
          })
        : Object.freeze({
            area: 'incomplete',
            place: placeOf('resource', before.placeId),
          });
  }
}

/**
 * What an undo takes back, for the texts of the command line: a page, the
 * change of an appointment, a new appointment or a new booking.
 */
export type UndoSubject =
  'page' | 'appointment' | 'newAppointment' | 'newBooking';

/**
 * Tells what the undo of a snapshot takes back.
 *
 * @param before - The part before of the snapshot.
 * @returns The subject of the undo.
 * @example
 * ```ts
 * undoSubjectOf(snapshot.before); // 'newBooking' for a booking request
 * ```
 */
export function undoSubjectOf(before: SnapshotState): UndoSubject {
  switch (before.kind) {
    case 'wikiPageText':
    case 'wikiPageCreate':
      return 'page';
    case 'appointmentFields':
      return 'appointment';
    case 'appointmentCreate':
      return 'newAppointment';
    case 'bookingCreate':
      return 'newBooking';
  }
}

/** What taking back one write means for its page. */
export interface UndoTarget {
  /** The category of the page. */
  readonly categoryId: number;
  /** The GUID of the page, as ChurchTools gave it. */
  readonly guid: string;
  /** The tool of the write, which the plan of the undo names. */
  readonly tool: string;
  /** The version and the hash of the text the write left on the page. */
  readonly left: { readonly version: number; readonly textHash: string };
  /**
   * The text to write back.
   *
   * @param today - The UTC day of the undo.
   * @returns The text in its written form.
   */
  readonly textOn: (today: IsoDate) => string;
  /**
   * Whether a text of the page is what the undo writes already, such as
   * after an earlier undo.
   *
   * @param text - The text of the page now.
   * @returns Whether nothing is left to do.
   */
  readonly done: (text: string) => boolean;
}

/**
 * What a snapshot allows: an undo, or, for a new page whose GUID was never
 * kept, only the category, so that the operator can look there by hand.
 */
export type UndoTargetResult =
  | { readonly ok: true; readonly target: UndoTarget }
  | { readonly ok: false; readonly categoryId: number };

// A UTC day as the German form of the fixed sentence writes it.
const germanDate = (day: IsoDate): string =>
  `${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(0, 4)}`;

/**
 * The fixed sentence a page that Ecclium created gets when the write is
 * taken back, in the form the content policy writes it. It names no
 * person and no tool, only the two days.
 *
 * @param created - The UTC day of the write that created the page.
 * @param today - The UTC day of the undo.
 * @returns The text of the page, in the form ChurchTools stores: without a
 *   line break at its end (F51).
 * @throws {TypeError} When the content policy would change or refuse the
 *   sentence, which no day can cause.
 * @example
 * ```ts
 * withdrawalNoteOf('2026-11-02', '2026-11-03');
 * // 'Diese Seite hat Ecclium am 02.11.2026 angelegt und am 03.11.2026 zurückgenommen.'
 * ```
 */
export function withdrawalNoteOf(created: IsoDate, today: IsoDate): string {
  const note = `Diese Seite hat Ecclium am ${germanDate(created)} angelegt und am ${germanDate(today)} zurückgenommen.`;
  // The sentence must come back from the content policy as it is, with
  // the one line break the policy ends every text with, so that a second
  // undo on any later day can tell it is there already.
  const checked = checkMarkdown(note, { contacts: new Set() });
  if (!checked.ok || checked.text !== `${note}\n`) {
    throw new TypeError('The fixed sentence does not pass the content policy.');
  }
  return note;
}

// Whether a text is the fixed sentence for a page created on a day, taken
// back on any day, as ChurchTools stores it.
const isWithdrawalNote = (text: string, created: IsoDate): boolean =>
  new RegExp(
    `^Diese Seite hat Ecclium am ${germanDate(created).replaceAll('.', '\\.')} angelegt und am \\d{2}\\.\\d{2}\\.\\d{4} zurückgenommen\\.$`,
    'u',
  ).test(text);

/**
 * Tells what taking back the write of a snapshot means for its page.
 *
 * @param snapshot - The parts of the snapshot and the day of the write.
 * @returns The target of the undo, or, for a new page without its GUID,
 *   the category to look at by hand.
 * @example
 * ```ts
 * const found = undoTargetOf({ before, after, day });
 * if (found.ok) found.target.textOn('2026-11-03');
 * ```
 */
export function undoTargetOf(snapshot: WikiSnapshotToUndo): UndoTargetResult {
  const { before, after, day } = snapshot;
  if (before.kind === 'wikiPageText') {
    const text = before.before.text;
    return Object.freeze({
      ok: true,
      target: Object.freeze({
        categoryId: before.categoryId,
        guid: before.guid,
        tool: before.tool,
        left: Object.freeze({ ...before.after }),
        textOn: () => text,
        done: (current: string) => current === text,
      }),
    });
  }
  if (after === undefined) {
    return Object.freeze({ ok: false, categoryId: before.categoryId });
  }
  return Object.freeze({
    ok: true,
    target: Object.freeze({
      categoryId: before.categoryId,
      guid: after.guid,
      tool: before.tool,
      // The text the write created, at the version ChurchTools gave it.
      left: Object.freeze({
        version: after.version,
        textHash: before.textHash,
      }),
      textOn: (today: IsoDate) => withdrawalNoteOf(day, today),
      done: (current: string) => isWithdrawalNote(current, day),
    }),
  });
}

/**
 * Tells whether a page still holds what the write left there: the same
 * version and the same text, by its hash.
 *
 * @param target - The target of the undo.
 * @param page - The page as read now.
 * @param page.version - Its version.
 * @param page.text - Its text.
 * @returns Whether no one changed the page since the write.
 * @example
 * ```ts
 * if (!isAsLeft(target, page) && !overwrite) return 'changed';
 * ```
 */
export function isAsLeft(
  target: UndoTarget,
  page: { readonly version: number; readonly text: string },
): boolean {
  return (
    page.version === target.left.version &&
    contentHashOf([page.text]) === target.left.textHash
  );
}
