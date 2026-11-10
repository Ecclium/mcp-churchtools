/**
 * The texts of `ecclium undo` (ADR 0031), for operators in German: what
 * happened, why, and what to do, each with its exit code after sysexits.
 * No text repeats the ID it was given, a value of the configuration or a
 * path; the text of a page, an appointment or a booking appears only in
 * the diff, made safe for the terminal (`output/terminal.ts`). The texts
 * after a snapshot was found name what the undo takes back: a page, the
 * change of an appointment, a new appointment or a new booking.
 *
 * @packageDocumentation
 */
import type { UndoReason, UndoSubject } from '@ecclium/mcp-churchtools-core';
import type { ErrorCode } from '@ecclium/mcp-churchtools-plugin-api';

import { type ExitCode, exitCodes } from '../exit-codes.js';

/** A text and the exit code it ends the command with. */
export interface UndoEnding {
  readonly text: string;
  readonly code: ExitCode;
}

const ending = (text: string, code: ExitCode): UndoEnding =>
  Object.freeze({ text, code });

/** The problems that end `ecclium undo` before it asks ChurchTools. */
export type UndoProblem =
  'id_invalid' | 'read_only' | 'state_dir_missing' | 'snapshots_off';

const snapshotsOff = ending(
  'Dieser Server hält mit ‹ECCLIUM_SNAPSHOTS=off› keine Snapshots fest, und eine Rücknahme braucht selbst einen, damit sie sich zurücknehmen lässt. Setzen Sie ‹ECCLIUM_SNAPSHOTS› auf ‹on›.',
  exitCodes.noInput,
);

/** One ending per problem. */
export const undoProblems: Readonly<Record<UndoProblem, UndoEnding>> =
  Object.freeze({
    id_invalid: ending(
      'Die Kennung ist keine Kennung eines Schreibvorgangs, Ecclium nennt sie nicht. Nehmen Sie die ‹undoId› aus dem Ergebnis des Schreib-Tools oder die ‹eventId› seiner Zeile im Audit, eine UUID in Kleinbuchstaben.',
      exitCodes.usage,
    ),
    read_only: ending(
      'Eine Rücknahme schreibt, und ‹ECCLIUM_READ_ONLY› steht nicht auf ‹false›. Setzen Sie ‹ECCLIUM_READ_ONLY=false› für den Aufruf, wenn Sie zurücknehmen wollen.',
      exitCodes.noPermission,
    ),
    state_dir_missing: ending(
      'Ohne ‹ECCLIUM_STATE_DIR› gibt es keine Snapshots und keine Audit-Datei. Setzen Sie denselben Zustandsordner wie in der Konfiguration des KI-Assistenten.',
      exitCodes.invalidConfig,
    ),
    snapshots_off: snapshotsOff,
  });

/** The endings of an undo that found no write to take back. */
export const undoMissing = Object.freeze({
  missing: ending(
    'Unter dieser Kennung findet Ecclium keinen Snapshot: Der Schreibvorgang hat keinen festgehalten, er liegt mehr als 30 Tage zurück, die Kennung gehört zu keinem Schreibvorgang dieses Mandanten, oder ‹ECCLIUM_STATE_DIR› ist ein anderer Ordner als beim Server. Prüfen Sie die Kennung und den Zustandsordner.',
    exitCodes.noInput,
  ),
  expired: ending(
    'Der Snapshot dieses Schreibvorgangs lässt sich nicht öffnen, weil sein Tagesschlüssel fehlt: Nach 30 Tagen ist er vernichtet, oder ‹ECCLIUM_KEYS_DIR› ist ein anderer Ordner als beim Server. Prüfen Sie den Schlüsselordner, sonst lässt sich der Schreibvorgang nur noch von Hand zurücknehmen.',
    exitCodes.noInput,
  ),
  off: snapshotsOff,
});

/** How the texts name what an undo takes back. */
interface Naming {
  /** In the nominative, such as «der Termin». */
  readonly nominative: string;
  /** In the accusative, such as «den Termin». */
  readonly accusative: string;
  /** The pronoun in the accusative, such as «ihn». */
  readonly pronoun: string;
}

const page: Naming = {
  nominative: 'die Seite',
  accusative: 'die Seite',
  pronoun: 'sie',
};
const appointment: Naming = {
  nominative: 'der Termin',
  accusative: 'den Termin',
  pronoun: 'ihn',
};
const booking: Naming = {
  nominative: 'die Buchungsanfrage',
  accusative: 'die Buchungsanfrage',
  pronoun: 'sie',
};

const namings: Readonly<Record<UndoSubject, Naming>> = Object.freeze({
  page,
  appointment,
  newAppointment: appointment,
  newBooking: booking,
});

// A word at the start of a sentence.
const capital = (text: string): string =>
  `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

// Whether the undo of a subject deletes what a write created; a delete is
// never written over a change and cannot be taken back (ADR 0031).
const deletes = (subject: UndoSubject): boolean =>
  subject === 'newAppointment' || subject === 'newBooking';

const unchangedTexts: Readonly<Record<UndoSubject, string>> = Object.freeze({
  page: 'Die Seite steht schon so, wie die Rücknahme sie schreiben würde. Ecclium hat nichts geschrieben.',
  appointment:
    'Der Termin steht schon so, wie die Rücknahme ihn schreiben würde. Ecclium hat nichts geschrieben.',
  newAppointment:
    'Den Termin, den Ecclium angelegt hat, gibt es nicht mehr. Ecclium hat nichts geschrieben.',
  newBooking:
    'Die Buchungsanfrage, die Ecclium gestellt hat, gibt es nicht mehr. Ecclium hat nichts geschrieben.',
});

/**
 * The ending when the target holds what the undo would write already, or
 * a new appointment or booking is gone already.
 *
 * @param subject - What the undo takes back.
 * @returns The ending, with 0.
 * @example
 * ```ts
 * undoUnchangedOf('newBooking').code; // 0
 * ```
 */
export function undoUnchangedOf(subject: UndoSubject): UndoEnding {
  return ending(unchangedTexts[subject], exitCodes.ok);
}

const changedTexts: Readonly<Record<UndoSubject, string>> = Object.freeze({
  page: 'Jemand hat die Seite seit dem Schreibvorgang geändert, darum hat Ecclium nichts geschrieben. Oben steht, was die Rücknahme ändern würde. Mit ‹--overwrite› schreibt Ecclium trotzdem, und auch diese Rücknahme lässt sich dann zurücknehmen.',
  appointment:
    'Jemand hat den Termin seit dem Schreibvorgang geändert, darum hat Ecclium nichts geschrieben. Oben steht, was die Rücknahme ändern würde. Mit ‹--overwrite› schreibt Ecclium trotzdem, und auch diese Rücknahme lässt sich dann zurücknehmen.',
  newAppointment:
    'Jemand hat den Termin seit dem Anlegen geändert, darum löscht Ecclium ihn nicht, auch nicht mit ‹--overwrite›. Oben steht, wie er jetzt ist. Löschen Sie ihn bei Bedarf in ChurchTools.',
  newBooking:
    'Jemand hat die Buchungsanfrage seit dem Anlegen geändert oder genehmigt, darum löscht Ecclium sie nicht, auch nicht mit ‹--overwrite›. Oben steht, wie sie jetzt ist. Löschen Sie sie bei Bedarf in ChurchTools.',
});

/**
 * The ending when someone changed the target since the write.
 *
 * @param subject - What the undo takes back.
 * @returns The ending, with 65.
 * @example
 * ```ts
 * undoChangedOf('page').code; // 65
 * ```
 */
export function undoChangedOf(subject: UndoSubject): UndoEnding {
  return ending(changedTexts[subject], exitCodes.dataError);
}

/**
 * The line before the diff of what the undo would write but did not.
 *
 * @param subject - What the undo takes back.
 * @returns The line.
 * @example
 * ```ts
 * wouldChangeLineOf('newAppointment');
 * // 'Die Rücknahme würde den Termin löschen, mit ‹-› für seine Zeilen jetzt:'
 * ```
 */
export function wouldChangeLineOf(subject: UndoSubject): string {
  switch (subject) {
    case 'page':
      return 'Die Rücknahme würde die Seite so ändern, mit ‹-› für Zeilen der Seite jetzt und ‹+› für Zeilen danach:';
    case 'appointment':
      return 'Die Rücknahme würde den Termin so ändern, mit ‹-› für Zeilen des Termins jetzt und ‹+› für Zeilen danach:';
    case 'newAppointment':
      return 'Die Rücknahme würde den Termin löschen, mit ‹-› für seine Zeilen jetzt:';
    case 'newBooking':
      return 'Die Rücknahme würde die Buchungsanfrage löschen, mit ‹-› für ihre Zeilen jetzt:';
  }
}

/**
 * The line before the diff of what the undo wrote.
 *
 * @param subject - What the undo takes back.
 * @returns The line.
 * @example
 * ```ts
 * changedLineOf('page');
 * // 'Die Rücknahme hat die Seite so geändert, mit ‹-› für Zeilen davor und ‹+› für Zeilen danach:'
 * ```
 */
export function changedLineOf(subject: UndoSubject): string {
  switch (subject) {
    case 'page':
      return 'Die Rücknahme hat die Seite so geändert, mit ‹-› für Zeilen davor und ‹+› für Zeilen danach:';
    case 'appointment':
      return 'Die Rücknahme hat den Termin so geändert, mit ‹-› für Zeilen davor und ‹+› für Zeilen danach:';
    case 'newAppointment':
      return 'Die Rücknahme hat den Termin gelöscht, mit ‹-› für seine Zeilen davor:';
    case 'newBooking':
      return 'Die Rücknahme hat die Buchungsanfrage gelöscht, mit ‹-› für ihre Zeilen davor:';
  }
}

/** The line when the diff or a text did not reach stdout whole. */
export const outputCutText =
  'Die Ausgabe liess sich nicht ganz auf stdout schreiben. Leiten Sie sie in eine Datei um, wenn Sie den Unterschied sehen wollen.';

/**
 * The lines after an undo that wrote a page or an appointment back.
 *
 * @param subject - What the undo took back.
 * @param version - The version of the target after the undo.
 * @param undoId - The ID to take the undo back with, if it kept one.
 * @returns The lines, for stdout.
 * @example
 * ```ts
 * doneLines('page', 5, '11111111-2222-4333-8444-555555555555');
 * ```
 */
export function doneLines(
  subject: UndoSubject,
  version: number,
  undoId?: string,
): string[] {
  const lines = [
    `Der Schreibvorgang ist zurückgenommen, ${namings[subject].nominative} steht jetzt in Version ${String(version)}.`,
  ];
  if (undoId !== undefined) {
    lines.push(
      `Auch diese Rücknahme lässt sich zurücknehmen, mit ‹ecclium undo ${undoId}›.`,
    );
  }
  return lines;
}

/**
 * The lines after an undo that deleted a new appointment or booking.
 *
 * @param subject - What the undo took back.
 * @returns The lines, for stdout.
 * @example
 * ```ts
 * deletedLines('newBooking')[0];
 * // 'Der Schreibvorgang ist zurückgenommen, die Buchungsanfrage ist gelöscht.'
 * ```
 */
export function deletedLines(subject: UndoSubject): string[] {
  return [
    `Der Schreibvorgang ist zurückgenommen, ${namings[subject].nominative} ist gelöscht.`,
    'Ein Löschen lässt sich nicht zurücknehmen: Legen Sie den Eintrag bei Bedarf in ChurchTools neu an.',
  ];
}

/**
 * The ending for a new page, appointment or booking whose ID Ecclium
 * could not keep.
 *
 * @param subject - What the write was to create.
 * @param placeId - The category of the wiki, the calendar or the resource.
 * @returns The ending.
 * @example
 * ```ts
 * incompleteEnding('page', 12).code; // 66
 * ```
 */
export function incompleteEnding(
  subject: UndoSubject,
  placeId: number,
): UndoEnding {
  const place = String(placeId);
  switch (subject) {
    case 'page':
      return ending(
        `Der Schreibvorgang sollte eine Seite anlegen, aber ihre Kennung hat Ecclium nicht festgehalten: Entweder kam die Seite nie an, oder Ecclium konnte die Kennung danach nicht mehr sichern. Prüfen Sie die Kategorie ${place} des Wikis von Hand.`,
        exitCodes.noInput,
      );
    case 'newBooking':
      return ending(
        `Der Schreibvorgang sollte eine Buchung anfragen, aber ihre Kennung hat Ecclium nicht festgehalten: Entweder kam die Anfrage nie an, oder Ecclium konnte die Kennung danach nicht mehr sichern. Prüfen Sie die Buchungen der Ressource ${place} von Hand.`,
        exitCodes.noInput,
      );
    default:
      return ending(
        `Der Schreibvorgang sollte einen Termin anlegen, aber seine Kennung hat Ecclium nicht festgehalten: Entweder kam der Termin nie an, oder Ecclium konnte die Kennung danach nicht mehr sichern. Prüfen Sie den Kalender ${place} von Hand.`,
        exitCodes.noInput,
      );
  }
}

const internal = ending(
  'Die Rücknahme ist mit einem internen Fehler abgebrochen, Ecclium hat nichts geschrieben. Einzelheiten zeigt Ecclium nicht. Melden Sie den Fehler, wenn er bleibt.',
  exitCodes.internal,
);

/** The endings that name what the undo takes back. */
interface SubjectEndings {
  readonly changedMeanwhile: UndoEnding;
  readonly missingRight: UndoEnding;
  readonly outcomeUnknown: UndoEnding;
  readonly notAsPlanned: UndoEnding;
  readonly notFound: UndoEnding;
  readonly refused: UndoEnding;
}

const missingRights: Readonly<Record<UndoSubject, string>> = Object.freeze({
  page: 'Das Dienstkonto darf Seiten in dieser Kategorie des Wikis nicht ändern, Ecclium hat nichts geschrieben. Die nötigen Rechte nennt die Anleitung zum Dienstkonto.',
  appointment:
    'Das Dienstkonto darf Termine in diesem Kalender nicht ändern, Ecclium hat nichts geschrieben. Die nötigen Rechte nennt die Anleitung zum Dienstkonto.',
  newAppointment:
    'Das Dienstkonto darf Termine in diesem Kalender nicht ändern oder löschen, Ecclium hat nichts geschrieben. Die nötigen Rechte nennt die Anleitung zum Dienstkonto.',
  newBooking:
    'Das Dienstkonto darf für diese Ressource keine Buchungen anfragen oder löschen, Ecclium hat nichts geschrieben. Die nötigen Rechte nennt die Anleitung zum Dienstkonto.',
});

const refusedTexts: Readonly<Record<UndoSubject, string>> = Object.freeze({
  page: 'ChurchTools hat den Text der Rücknahme abgewiesen, Ecclium hat nichts geschrieben. Prüfen Sie die Seite in ChurchTools und nehmen Sie den Schreibvorgang bei Bedarf von Hand zurück.',
  appointment:
    'ChurchTools hat die Felder der Rücknahme abgewiesen, Ecclium hat nichts geschrieben. Prüfen Sie den Termin in ChurchTools und nehmen Sie den Schreibvorgang bei Bedarf von Hand zurück.',
  newAppointment:
    'ChurchTools hat das Löschen abgewiesen, Ecclium hat nichts geschrieben. Prüfen Sie den Termin in ChurchTools und löschen Sie ihn bei Bedarf von Hand.',
  newBooking:
    'ChurchTools hat das Löschen abgewiesen, Ecclium hat nichts geschrieben. Prüfen Sie die Buchungsanfrage in ChurchTools und löschen Sie sie bei Bedarf von Hand.',
});

// The endings that name the subject, built once per subject.
const endingsOf = (subject: UndoSubject): SubjectEndings => {
  const { nominative, accusative, pronoun } = namings[subject];
  return Object.freeze({
    changedMeanwhile: ending(
      `${capital(nominative)} hat sich während der Rücknahme geändert, darum hat Ecclium nichts geschrieben. Rufen Sie den Befehl erneut auf, er zeigt dann den neuen Stand.`,
      exitCodes.dataError,
    ),
    missingRight: ending(missingRights[subject], exitCodes.noPermission),
    outcomeUnknown: ending(
      `Ob die Rücknahme ChurchTools erreicht hat, ist unbekannt. Prüfen Sie ${accusative} in ChurchTools, bevor Sie es erneut versuchen.`,
      exitCodes.unavailable,
    ),
    notAsPlanned: ending(
      deletes(subject)
        ? `Die Rücknahme hat ChurchTools erreicht, aber ${nominative} ist danach noch da. Prüfen Sie ${pronoun} in ChurchTools.`
        : `Die Rücknahme hat ChurchTools erreicht, aber ${nominative} liest sich danach nicht wie geplant. Prüfen Sie ${accusative} in ChurchTools.`,
      exitCodes.unavailable,
    ),
    notFound: ending(
      `${capital(accusative)} gibt es in ChurchTools nicht mehr, oder das Dienstkonto sieht ${pronoun} nicht. Ecclium hat nichts geschrieben.`,
      exitCodes.noInput,
    ),
    refused: ending(refusedTexts[subject], exitCodes.dataError),
  });
};

// Codes with which ChurchTools answers and refuses a write.
const refusals: readonly ErrorCode[] = Object.freeze([
  'auth',
  'permission',
  'not_found',
  'conflict',
  'validation',
]);

// One ending per reason the core names, for what the undo takes back.
const reasonsOf = (
  endings: SubjectEndings,
): Readonly<Record<UndoReason, UndoEnding>> =>
  Object.freeze({
    blocked: ending(
      'Ecclium schreibt nichts mehr, bis es neu startet, weil ein Schreibvorgang nicht in die Audit-Datei kam. Prüfen Sie die Audit-Datei mit ‹ecclium audit verify›.',
      exitCodes.noPermission,
    ),
    readOnly: undoProblems.read_only,
    switchedOff: ending(
      'Das Schreiben ist für diesen Mandanten mit einem Kill-Switch im Zustandsordner ausgeschaltet, Ecclium hat nichts geschrieben. Schalten Sie es wieder ein, wenn Sie zurücknehmen wollen.',
      exitCodes.noPermission,
    ),
    switchUnknown: ending(
      'Ecclium kann nicht prüfen, ob das Schreiben ausgeschaltet ist, und schreibt darum nicht. Prüfen Sie den Ordner ‹stop› im Zustandsordner.',
      exitCodes.noPermission,
    ),
    // Every snapshot of this version can be taken back; the sentence of a
    // kind of write the core does not run only completes the table.
    notRun: ending(
      'Diesen Schreibvorgang nimmt diese Version von Ecclium nicht zurück, Ecclium hat nichts geschrieben. Nehmen Sie ihn bei Bedarf in ChurchTools von Hand zurück.',
      exitCodes.noPermission,
    ),
    // An undo is no write of a run; the reason only completes the table.
    notForRun: ending(
      'Ein Lauf einer Routine schreibt nur einen Abschnitt einer Seite des Wikis, Ecclium hat nichts geschrieben.',
      exitCodes.noPermission,
    ),
    intent: internal,
    blank: ending(
      'Vor dem Schreibvorgang war die Seite leer, und eine leere Seite schreibt Ecclium nicht. Leeren Sie die Seite bei Bedarf von Hand.',
      exitCodes.dataError,
    ),
    // An undo writes back the text of a page and never a title; the reason
    // only completes the table.
    title: ending(
      'Der Titel passt nicht zu einer Seite des Wikis, Ecclium hat nichts geschrieben.',
      exitCodes.dataError,
    ),
    rightsUnknown: ending(
      'Ecclium kann die Rechte des Dienstkontos nicht lesen und schreibt darum nicht. Prüfen Sie das Dienstkonto in ChurchTools.',
      exitCodes.noPermission,
    ),
    missingRight: endings.missingRight,
    notMarkdown: ending(
      'Die Seite ist keine Markdown-Seite mehr. Ecclium ändert nur Markdown-Seiten und hat nichts geschrieben.',
      exitCodes.noPermission,
    ),
    changedBefore: endings.changedMeanwhile,
    changedSincePlan: endings.changedMeanwhile,
    clock: ending(
      'Die Uhr dieses Rechners weicht mehr als fünf Minuten von der Zeit von ChurchTools ab, darum schreibt Ecclium nicht. Stellen Sie die Uhr des Rechners.',
      exitCodes.noPermission,
    ),
    notSent: ending(
      'Die Rücknahme hat ChurchTools nicht erreicht, nichts hat sich geändert. Prüfen Sie die Verbindung und rufen Sie den Befehl erneut auf.',
      exitCodes.unavailable,
    ),
    unknown: endings.outcomeUnknown,
    notAsPlanned: endings.notAsPlanned,
    notConfirmed: internal,
    // Only an approval meets this sentence; an undo plans on what it reads.
    changedSinceQueued: endings.changedMeanwhile,
    noSnapshot: ending(
      'Ecclium konnte den Stand vor der Rücknahme nicht festhalten und hat darum nichts geschrieben. Prüfen Sie den Ordner ‹snapshots› im Zustandsordner und den Schlüsselordner.',
      exitCodes.ioError,
    ),
    // A taking back changes the text of a page and adds nothing, so these
    // endings of a write that adds a page or a section do not come here;
    // the table names every sentence of the write guard all the same.
    noMarking: ending(
      'Ecclium kann nicht kennzeichnen, was es dem Wiki hinzufügt, und hat nichts geschrieben. Setzen Sie ‹ECCLIUM_MARKER_KEY_FILE› und in der Richtlinie ‹interactive.inquiriesTo›.',
      exitCodes.invalidConfig,
    ),
    noDay: ending(
      'Die Uhr dieses Rechners nennt keinen Tag für die Kennzeichnung, darum schreibt Ecclium nicht. Stellen Sie die Uhr des Rechners.',
      exitCodes.noPermission,
    ),
    tooLong: ending(
      'Der Text der Seite wäre länger, als ChurchTools annimmt. Ecclium hat nichts geschrieben.',
      exitCodes.dataError,
    ),
    pageOpen: ending(
      'Die Seite endet in einem offenen Block, der einen Abschnitt aufnähme. Ecclium hat nichts geschrieben.',
      exitCodes.dataError,
    ),
    auditNotReady: ending(
      'Die Audit-Datei kann die Zeile der Rücknahme nicht aufnehmen, darum schreibt Ecclium nicht. Prüfen Sie die Audit-Datei mit ‹ecclium audit verify›.',
      exitCodes.ioError,
    ),
    calendarRight: ending(
      'Das Dienstkonto darf Termine in diesem Kalender nicht ändern, Ecclium hat nichts geschrieben.',
      exitCodes.noPermission,
    ),
    resourceRight: ending(
      'Das Dienstkonto darf für diese Ressource keine Buchungen anfragen, Ecclium hat nichts geschrieben.',
      exitCodes.noPermission,
    ),
    datedFields: ending(
      'Titel, Beschreibung oder Zeiten passen nicht zu einem Termin oder einer Buchung, Ecclium hat nichts geschrieben.',
      exitCodes.dataError,
    ),
    datedSpan: ending(
      'Der Termin oder die Buchung dauert länger, als Ecclium schreibt. Ecclium hat nichts geschrieben.',
      exitCodes.dataError,
    ),
    appointmentChanged: endings.changedMeanwhile,
    appointmentParts: ending(
      'Der Termin hat Teile, die Ecclium weder ändert noch löscht, etwa eine Serie, eine Adresse oder ein verknüpftes Event. Ecclium hat nichts geschrieben. Nehmen Sie den Schreibvorgang bei Bedarf in ChurchTools zurück.',
      exitCodes.noPermission,
    ),
    wholeDays: ending(
      'Der Termin dauert ganze Tage, und solche schreibt Ecclium nicht. Ecclium hat nichts geschrieben.',
      exitCodes.noPermission,
    ),
    notOwnTime: ending(
      'Die Rücknahme würde einen Termin verschieben, den das Dienstkonto nicht angelegt hat, und das tut Ecclium nicht. Ecclium hat nichts geschrieben. Stellen Sie den Termin bei Bedarf in ChurchTools zurück.',
      exitCodes.noPermission,
    ),
    // An undo reads no list of days to rule out a repeat; the reason only
    // completes the table.
    dayListFull: ending(
      'Der Kalender oder die Ressource hat an diesen Tagen zu viele Einträge, als dass Ecclium einen gleichen ausschliessen könnte. Ecclium hat nichts geschrieben.',
      exitCodes.noPermission,
    ),
    bookingGone: ending(
      'Die Buchungsanfrage lässt sich nicht lesen, und die Liste ihrer Tage nennt sie nicht mehr: Jemand hat sie gelöscht oder auf eine andere Ressource verschoben. Ecclium hat nichts geschrieben. Prüfen Sie die Buchungsanfrage in ChurchTools.',
      exitCodes.noInput,
    ),
  });

/** The endings of one subject. */
interface Table {
  readonly endings: SubjectEndings;
  readonly reasons: Readonly<Record<UndoReason, UndoEnding>>;
}

const tableOf = (subject: UndoSubject): Table => {
  const endings = endingsOf(subject);
  return Object.freeze({ endings, reasons: reasonsOf(endings) });
};

// The endings of each subject, built once.
const tables: Readonly<Record<UndoSubject, Table>> = Object.freeze({
  page: tableOf('page'),
  appointment: tableOf('appointment'),
  newAppointment: tableOf('newAppointment'),
  newBooking: tableOf('newBooking'),
});

/**
 * The ending of an undo that was refused or failed: by the reason the core
 * names, otherwise by the stable code of the error and whether the undo
 * may have reached ChurchTools.
 *
 * @param failure - Code, reason, whether it may have been sent and what
 *   the undo takes back.
 * @param failure.code - The stable code of the error, never its message.
 * @param failure.reason - The reason, where the core knows it.
 * @param failure.sent - Whether the undo may have reached ChurchTools.
 * @param failure.subject - What the undo takes back, once its snapshot
 *   was found; the texts name a page without it, which the endings before
 *   a snapshot never do.
 * @returns The ending.
 * @example
 * ```ts
 * failedEnding({ code: 'network', sent: false }).code; // 69
 * ```
 */
export function failedEnding(failure: {
  readonly code: ErrorCode;
  readonly reason?: UndoReason | undefined;
  readonly sent: boolean;
  readonly subject?: UndoSubject | undefined;
}): UndoEnding {
  const { code, reason, sent } = failure;
  const { endings, reasons } = tables[failure.subject ?? 'page'];
  // A write ChurchTools answered and refused carries the sentence that it
  // did not reach the target, but its code says why: a right, a target
  // that is gone, a change in between.
  if (
    reason !== undefined &&
    !(reason === 'notSent' && refusals.includes(code))
  ) {
    return reasons[reason];
  }
  if (sent) {
    return code === 'conflict' ? endings.notAsPlanned : endings.outcomeUnknown;
  }
  switch (code) {
    case 'auth':
      return ending(
        'ChurchTools hat das Token des Dienstkontos abgewiesen, Ecclium hat nichts geschrieben. Erneuern Sie das Token, wie es die Anleitung zum Dienstkonto beschreibt.',
        exitCodes.noPermission,
      );
    case 'permission':
      return endings.missingRight;
    case 'not_found':
      return endings.notFound;
    case 'conflict':
      return endings.changedMeanwhile;
    case 'validation':
      return endings.refused;
    case 'network':
    case 'upstream':
    case 'rate_limited':
      return ending(
        'ChurchTools war nicht erreichbar oder hat nicht wie erwartet geantwortet, Ecclium hat nichts geschrieben. Versuchen Sie es später erneut.',
        exitCodes.unavailable,
      );
    case 'policy_denied':
      return ending(
        'Ecclium hat die Rücknahme abgewiesen und nichts geschrieben.',
        exitCodes.noPermission,
      );
    default:
      return internal;
  }
}

/**
 * The ending of an undo that may have written while its line did not reach
 * the audit file: the target changed, but the audit does not show it.
 *
 * @param subject - What the undo takes back.
 * @returns The ending, with 74.
 * @example
 * ```ts
 * undoUnrecordedOf('page').code; // 74
 * ```
 */
export function undoUnrecordedOf(subject: UndoSubject): UndoEnding {
  const { accusative } = namings[subject];
  return ending(
    `Die Zeile dieser Rücknahme kam nicht in die Audit-Datei, obwohl Ecclium ${accusative} womöglich ${deletes(subject) ? 'gelöscht' : 'geändert'} hat. Prüfen Sie die Audit-Datei mit ‹ecclium audit verify› und ${accusative} in ChurchTools.`,
    exitCodes.ioError,
  );
}
