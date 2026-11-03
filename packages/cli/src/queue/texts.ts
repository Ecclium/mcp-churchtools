/**
 * The texts of `ecclium queue` (ADR 0031), for operators in German: what
 * waits in the queue of approvals, why, and what to do, each ending with
 * its exit code after sysexits. No text repeats the ID it was given, a
 * value of the configuration or a path; the IDs of the list are the ones
 * Ecclium drew. The summary and the diff of an entry are text of
 * ChurchTools and of the model, shown only made safe for the terminal
 * (`output/terminal.ts`).
 *
 * @packageDocumentation
 */
import type { QueueReason } from '@ecclium/mcp-churchtools-core';
import type {
  ErrorCode,
  QueueDecisionKind,
} from '@ecclium/mcp-churchtools-plugin-api';

import { type ExitCode, exitCodes } from '../exit-codes.js';

/** A text and the exit code it ends the command with. */
export interface QueueEnding {
  readonly text: string;
  readonly code: ExitCode;
}

const ending = (text: string, code: ExitCode): QueueEnding =>
  Object.freeze({ text, code });

/** The problems that end `ecclium queue` before it reads the queue. */
export type QueueProblem =
  'id_invalid' | 'state_dir_missing' | 'keys_dir_missing';

/** One ending per problem. */
export const queueProblems: Readonly<Record<QueueProblem, QueueEnding>> =
  Object.freeze({
    id_invalid: ending(
      'Die Kennung ist keine Kennung eines Eintrags der Freigabe-Warteschlange, Ecclium nennt sie nicht. Nehmen Sie die ‹queueId› aus dem Ergebnis des Schreib-Tools oder die Kennung aus ‹ecclium queue list›, eine UUID in Kleinbuchstaben.',
      exitCodes.usage,
    ),
    state_dir_missing: ending(
      'Ohne ‹ECCLIUM_STATE_DIR› gibt es keine Freigabe-Warteschlange und keine Audit-Datei. Setzen Sie denselben Zustandsordner wie in der Konfiguration des KI-Assistenten.',
      exitCodes.invalidConfig,
    ),
    keys_dir_missing: ending(
      'Ohne ‹ECCLIUM_KEYS_DIR› lassen sich die Einträge der Freigabe-Warteschlange nicht öffnen. Setzen Sie denselben Schlüsselordner wie in der Konfiguration des KI-Assistenten.',
      exitCodes.invalidConfig,
    ),
  });

/** Why a write waits, in one sentence for the operator. */
export const reasonTexts: Readonly<Record<QueueReason, string>> = Object.freeze(
  {
    queue_only: 'Diese Art Schreibvorgang braucht immer Ihre Freigabe.',
    no_entry:
      'Die Richtlinie hat für dieses Tool und dieses Ziel keinen Eintrag.',
    name_changed:
      'Das Ziel in ChurchTools trägt nicht den Namen, den die Richtlinie erwartet.',
    limit_reached:
      'Die Obergrenze des Tages für dieses Tool und dieses Ziel war erreicht.',
    count_unavailable: 'Ecclium konnte den Zähler des Tages nicht lesen.',
    setting:
      '‹ECCLIUM_WRITE_CONFIRMATION› steht auf ‹queue›, jeder Schreibvorgang wartet auf Ihre Freigabe.',
    no_question:
      'Der Client kann nicht nachfragen, und das Echo bestätigt diesen Schreibvorgang nicht.',
    too_long: 'Der Unterschied ist für eine Rückfrage im Client zu lang.',
  },
);

/** How a decision reads in a list. */
export const decisionWords: Readonly<Record<QueueDecisionKind, string>> =
  Object.freeze({ approved: 'freigegeben', rejected: 'abgewiesen' });

/** The heading of the list. */
export const listHeading = 'Freigabe-Warteschlange, Zeiten in UTC';

/** The line of a list without entries. */
export const listEmpty = 'Es wartet kein Eintrag auf Ihre Freigabe.';

/** The line after a list with entries that wait. */
export const listFooter =
  'Was ein Eintrag schreiben würde, zeigt ‹ecclium queue show <Kennung>›, abweisen lässt er sich mit ‹ecclium queue reject <Kennung>›. Freigeben lässt sich ein Eintrag in dieser Version noch nicht. Nach 14 Tagen verfällt jeder Eintrag.';

/** The line before the diff of an entry. */
export const diffHeading =
  'Der Schreibvorgang würde so ändern, mit ‹-› für Zeilen davor und ‹+› für Zeilen danach, wie Ecclium das Ziel beim Einreihen las:';

/** The line after an entry that waits. */
export const showFooter =
  'Abweisen lässt sich der Eintrag mit ‹ecclium queue reject› und seiner Kennung. Freigeben lässt er sich in dieser Version noch nicht.';

/** The line when a text did not reach stdout whole. */
export const outputCutText =
  'Die Ausgabe liess sich nicht ganz auf stdout schreiben. Leiten Sie sie in eine Datei um, wenn Sie alles sehen wollen.';

/** The ending of a rejection that kept its decision. */
export const rejectedEnding = ending(
  'Der Eintrag ist abgewiesen und sein Inhalt vernichtet. Ecclium hat nichts in ChurchTools geschrieben.',
  exitCodes.ok,
);

/**
 * The ending of a rejection whose line did not reach the audit file: the
 * entry is gone, but the audit does not show the decision.
 */
export const rejectedUnrecorded = ending(
  'Der Eintrag ist abgewiesen und sein Inhalt vernichtet, aber die Zeile kam nicht in die Audit-Datei. Prüfen Sie die Audit-Datei mit ‹ecclium audit verify›.',
  exitCodes.ioError,
);

/** The endings of a call that found no entry. */
export const queueMissing = Object.freeze({
  missing: ending(
    'Unter dieser Kennung findet Ecclium keinen Eintrag: Er liegt mehr als 14 Tage zurück, die Kennung gehört zu keinem Eintrag dieses Mandanten, oder ‹ECCLIUM_STATE_DIR› ist ein anderer Ordner als beim Server. Prüfen Sie die Kennung mit ‹ecclium queue list›.',
    exitCodes.noInput,
  ),
  expired: ending(
    'Der Eintrag ist verfallen: Er liegt mehr als 14 Tage zurück, oder sein Tagesschlüssel fehlt, weil ‹ECCLIUM_KEYS_DIR› ein anderer Ordner als beim Server ist. Lassen Sie den Schreibvorgang bei Bedarf neu planen.',
    exitCodes.noInput,
  ),
  off: ending(
    'Dieser Server hält keine Freigabe-Warteschlange, weil ‹ECCLIUM_STATE_DIR› oder ‹ECCLIUM_KEYS_DIR› fehlt.',
    exitCodes.noInput,
  ),
});

/**
 * The ending of a call about an entry that was decided already.
 *
 * @param decision - What was decided.
 * @param decidedAt - When, in ISO 8601 in UTC.
 * @param shown - Whether the command only shows the entry.
 * @returns The ending: 0 for `show`, 65 for a second decision.
 * @example
 * ```ts
 * decidedEnding('rejected', '2026-11-03T18:00:00.000Z', false).code; // 65
 * ```
 */
export function decidedEnding(
  decision: QueueDecisionKind,
  decidedAt: string | undefined,
  shown: boolean,
): QueueEnding {
  const when = decidedAt === undefined ? '' : ` am ${timeOf(decidedAt)} UTC`;
  return shown
    ? ending(
        `Über diesen Eintrag ist schon entschieden: ${decisionWords[decision]}${when}. Sein Inhalt ist vernichtet.`,
        exitCodes.ok,
      )
    : ending(
        `Über diesen Eintrag ist schon entschieden: ${decisionWords[decision]}${when}. Ecclium hat nichts geändert.`,
        exitCodes.dataError,
      );
}

/**
 * The ending of a call that was refused or failed, by the stable code of
 * the error and, for the audit file, the reason.
 *
 * @param failure - Code and reason.
 * @param failure.code - The stable code of the error, never its message.
 * @param failure.reason - Why, where the core knows it.
 * @returns The ending.
 * @example
 * ```ts
 * failedEnding({ code: 'internal' }).code; // 70
 * ```
 */
export function failedEnding(failure: {
  readonly code: ErrorCode;
  readonly reason?: 'auditNotReady' | undefined;
}): QueueEnding {
  if (failure.reason === 'auditNotReady') {
    return ending(
      'Die Audit-Datei kann die Zeile des Entscheids nicht aufnehmen, darum entscheidet Ecclium nicht. Prüfen Sie die Audit-Datei mit ‹ecclium audit verify›.',
      exitCodes.ioError,
    );
  }
  switch (failure.code) {
    case 'validation':
      return queueProblems.id_invalid;
    case 'policy_denied':
    case 'auth':
      return ending(
        'Ecclium hat den Aufruf abgewiesen und nichts geändert.',
        exitCodes.noPermission,
      );
    default:
      return ending(
        'Der Befehl ist mit einem internen Fehler abgebrochen, Ecclium hat nichts geändert. Einzelheiten zeigt Ecclium nicht. Melden Sie den Fehler, wenn er bleibt.',
        exitCodes.internal,
      );
  }
}

/**
 * A time of the audit as the operator reads it: day, month, year and the
 * time of the day.
 *
 * @param iso - A time in ISO 8601 in UTC, such as `2026-11-03T18:00:00.000Z`.
 * @returns The time, such as `03.11.2026 18:00:00`.
 * @example
 * ```ts
 * timeOf('2026-11-03T18:00:00.000Z'); // '03.11.2026 18:00:00'
 * ```
 */
export function timeOf(iso: string): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)} ${iso.slice(11, 19)}`;
}
