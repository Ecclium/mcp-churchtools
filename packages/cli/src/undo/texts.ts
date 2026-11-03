/**
 * The texts of `ecclium undo` (ADR 0031), for operators in German: what
 * happened, why, and what to do, each with its exit code after sysexits.
 * No text repeats the ID it was given, a value of the configuration or a
 * path; the text of a page appears only in the diff, made safe for the
 * terminal (`output/terminal.ts`).
 *
 * @packageDocumentation
 */
import type { UndoReason } from '@ecclium/mcp-churchtools-core';
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
    'Unter dieser Kennung findet Ecclium keinen Snapshot: Der Schreibvorgang hat keinen festgehalten, er liegt mehr als 30 Tage zurück, oder die Kennung gehört zu keinem Schreibvorgang dieses Mandanten.',
    exitCodes.noInput,
  ),
  expired: ending(
    'Der Snapshot dieses Schreibvorgangs lässt sich nicht mehr öffnen, weil sein Tagesschlüssel nach 30 Tagen vernichtet ist. Zurücknehmen lässt er sich nur noch von Hand.',
    exitCodes.noInput,
  ),
  off: snapshotsOff,
});

/** The ending when the page holds what the undo would write already. */
export const undoUnchanged = ending(
  'Die Seite steht schon so, wie die Rücknahme sie schreiben würde. Ecclium hat nichts geschrieben.',
  exitCodes.ok,
);

/** The ending when someone changed the page since the write. */
export const undoChanged = ending(
  'Jemand hat die Seite seit dem Schreibvorgang geändert, darum hat Ecclium nichts geschrieben. Oben steht, was die Rücknahme ändern würde. Mit ‹--overwrite› schreibt Ecclium trotzdem, und auch diese Rücknahme lässt sich dann zurücknehmen.',
  exitCodes.dataError,
);

/** The line before the diff of a page that the undo did not write. */
export const wouldChangeLine =
  'Die Rücknahme würde die Seite so ändern, mit ‹-› für Zeilen der Seite jetzt und ‹+› für Zeilen danach:';

/** The line before the diff of a page that the undo wrote. */
export const changedLine =
  'Die Rücknahme hat die Seite so geändert, mit ‹-› für Zeilen davor und ‹+› für Zeilen danach:';

/** The line when the diff or a text did not reach stdout whole. */
export const outputCutText =
  'Die Ausgabe liess sich nicht ganz auf stdout schreiben. Leiten Sie sie in eine Datei um, wenn Sie den Unterschied sehen wollen.';

/**
 * The lines after an undo that wrote.
 *
 * @param version - The version of the page after the undo.
 * @param undoId - The ID to take the undo back with, if it kept one.
 * @returns The lines, for stdout.
 * @example
 * ```ts
 * doneLines(5, '11111111-2222-4333-8444-555555555555');
 * ```
 */
export function doneLines(version: number, undoId?: string): string[] {
  const lines = [
    `Der Schreibvorgang ist zurückgenommen, die Seite steht jetzt in Version ${String(version)}.`,
  ];
  if (undoId !== undefined) {
    lines.push(
      `Auch diese Rücknahme lässt sich zurücknehmen, mit ‹ecclium undo ${undoId}›.`,
    );
  }
  return lines;
}

/**
 * The ending for a new page whose GUID Ecclium could not keep.
 *
 * @param categoryId - The category of the wiki the page went to.
 * @returns The ending.
 * @example
 * ```ts
 * incompleteEnding(12).code; // 66
 * ```
 */
export function incompleteEnding(categoryId: number): UndoEnding {
  return ending(
    `Der Schreibvorgang hat eine Seite angelegt, deren Kennung Ecclium danach nicht mehr festhalten konnte. Prüfen Sie die Kategorie ${String(categoryId)} des Wikis von Hand.`,
    exitCodes.noInput,
  );
}

const internal = ending(
  'Die Rücknahme ist mit einem internen Fehler abgebrochen, Ecclium hat nichts geschrieben. Einzelheiten zeigt Ecclium nicht. Melden Sie den Fehler, wenn er bleibt.',
  exitCodes.internal,
);
const changedMeanwhile = ending(
  'Die Seite hat sich während der Rücknahme geändert, darum hat Ecclium nichts geschrieben. Rufen Sie den Befehl erneut auf, er zeigt dann den neuen Stand.',
  exitCodes.dataError,
);
const missingRight = ending(
  'Das Dienstkonto darf Seiten in dieser Kategorie des Wikis nicht ändern, Ecclium hat nichts geschrieben. Die nötigen Rechte nennt die Anleitung zum Dienstkonto.',
  exitCodes.noPermission,
);
const outcomeUnknown = ending(
  'Ob die Rücknahme ChurchTools erreicht hat, ist unbekannt. Prüfen Sie die Seite in ChurchTools, bevor Sie es erneut versuchen.',
  exitCodes.unavailable,
);
const notAsPlanned = ending(
  'Die Rücknahme hat ChurchTools erreicht, aber die Seite liest sich danach nicht wie geplant. Prüfen Sie die Seite in ChurchTools.',
  exitCodes.unavailable,
);

/** One ending per reason the core names. */
const reasons: Readonly<Record<UndoReason, UndoEnding>> = Object.freeze({
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
  notRun: internal,
  intent: internal,
  blank: ending(
    'Vor dem Schreibvorgang war die Seite leer, und eine leere Seite schreibt Ecclium nicht. Leeren Sie die Seite bei Bedarf von Hand.',
    exitCodes.dataError,
  ),
  rightsUnknown: ending(
    'Ecclium kann die Rechte des Dienstkontos nicht lesen und schreibt darum nicht. Prüfen Sie das Dienstkonto in ChurchTools.',
    exitCodes.noPermission,
  ),
  missingRight,
  notMarkdown: ending(
    'Die Seite ist keine Markdown-Seite mehr. Ecclium ändert nur Markdown-Seiten und hat nichts geschrieben.',
    exitCodes.noPermission,
  ),
  changedBefore: changedMeanwhile,
  changedSincePlan: changedMeanwhile,
  clock: ending(
    'Die Uhr dieses Rechners weicht mehr als fünf Minuten von der Zeit von ChurchTools ab, darum schreibt Ecclium nicht. Stellen Sie die Uhr des Rechners.',
    exitCodes.noPermission,
  ),
  notSent: ending(
    'Die Rücknahme hat ChurchTools nicht erreicht, nichts hat sich geändert. Prüfen Sie die Verbindung und rufen Sie den Befehl erneut auf.',
    exitCodes.unavailable,
  ),
  unknown: outcomeUnknown,
  notAsPlanned,
  notConfirmed: internal,
  noSnapshot: ending(
    'Ecclium konnte den Stand vor der Rücknahme nicht festhalten und hat darum nichts geschrieben. Prüfen Sie den Ordner ‹snapshots› im Zustandsordner und den Schlüsselordner.',
    exitCodes.ioError,
  ),
  auditNotReady: ending(
    'Die Audit-Datei kann die Zeile der Rücknahme nicht aufnehmen, darum schreibt Ecclium nicht. Prüfen Sie die Audit-Datei mit ‹ecclium audit verify›.',
    exitCodes.ioError,
  ),
});

/**
 * The ending of an undo that was refused or failed: by the reason the core
 * names, otherwise by the stable code of the error and whether the undo
 * may have reached ChurchTools.
 *
 * @param failure - Code, reason and whether it may have been sent.
 * @param failure.code - The stable code of the error, never its message.
 * @param failure.reason - The reason, where the core knows it.
 * @param failure.sent - Whether the undo may have reached ChurchTools.
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
}): UndoEnding {
  const { code, reason, sent } = failure;
  if (reason !== undefined) return reasons[reason];
  if (sent) return code === 'conflict' ? notAsPlanned : outcomeUnknown;
  switch (code) {
    case 'auth':
      return ending(
        'ChurchTools hat das Token des Dienstkontos abgewiesen, Ecclium hat nichts geschrieben. Prüfen Sie es mit ‹ecclium config check› und erneuern Sie es bei Bedarf.',
        exitCodes.noPermission,
      );
    case 'permission':
      return missingRight;
    case 'not_found':
      return ending(
        'Die Seite gibt es in ChurchTools nicht mehr, oder das Dienstkonto sieht sie nicht. Ecclium hat nichts geschrieben.',
        exitCodes.noInput,
      );
    case 'conflict':
      return changedMeanwhile;
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
