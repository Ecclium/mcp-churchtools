/**
 * The texts of `ecclium queue` (ADR 0029, ADR 0031), for operators in
 * German: what waits in the queue of approvals, why, what an approval or a
 * rejection did, and what to do, each ending with its exit code after
 * sysexits. No text repeats the ID it was given, a
 * value of the configuration or a path; the IDs of the list are the ones
 * Ecclium drew. The summary and the diff of an entry are text of
 * ChurchTools and of the model, shown only made safe for the terminal
 * (`output/terminal.ts`).
 *
 * @packageDocumentation
 */
import type { ApproveReason, QueueReason } from '@ecclium/mcp-churchtools-core';
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
  'id_invalid' | 'read_only' | 'state_dir_missing' | 'keys_dir_missing';

/** One ending per problem. */
export const queueProblems: Readonly<Record<QueueProblem, QueueEnding>> =
  Object.freeze({
    id_invalid: ending(
      'Die Kennung ist keine Kennung eines Eintrags der Freigabe-Warteschlange, Ecclium nennt sie nicht. Nehmen Sie die ‹queueId› aus dem Ergebnis des Schreib-Tools oder die Kennung aus ‹ecclium queue list›, eine UUID in Kleinbuchstaben.',
      exitCodes.usage,
    ),
    read_only: ending(
      'Eine Freigabe schreibt, und ‹ECCLIUM_READ_ONLY› steht nicht auf ‹false›. Setzen Sie ‹ECCLIUM_READ_ONLY=false› für den Aufruf, wenn Sie freigeben wollen.',
      exitCodes.noPermission,
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
    marker_changed:
      'Auf der Seite steht ein Abschnitt mit derselben Kennzeichnung, den jemand geändert hat. Ob es eine Wiederholung ist, entscheiden Sie.',
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
  'Was ein Eintrag schreiben würde, zeigt ‹ecclium queue show <Kennung>›. Freigeben lässt er sich mit ‹ecclium queue approve <Kennung>›, abweisen mit ‹ecclium queue reject <Kennung>›. Nach 14 Tagen verfällt jeder Eintrag.';

/** How an entry reads in a list whose decision was counted but not kept. */
export const usedWords =
  'schon entschieden, ohne Vermerk, lässt sich nicht mehr entscheiden';

/** The line before the diff of an entry. */
export const diffHeading =
  'Der Schreibvorgang würde so ändern, mit ‹-› für Zeilen davor und ‹+› für Zeilen danach, wie Ecclium das Ziel beim Einreihen las:';

/** The line after an entry that waits. */
export const showFooter =
  'Freigeben lässt sich der Eintrag mit ‹ecclium queue approve›, abweisen mit ‹ecclium queue reject›, jeweils mit seiner Kennung. Die Freigabe plant den Schreibvorgang auf dem Stand des Ziels von dann neu und schreibt sofort.';

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

/**
 * The ending of a call about an entry whose decision was counted but not
 * kept, as after a stop between the two (ADR 0029).
 *
 * @param shown - Whether the command only shows the entry.
 * @returns The ending: 0 for `show`, 65 for a decision.
 * @example
 * ```ts
 * usedEnding(false).code; // 65
 * ```
 */
export function usedEnding(shown: boolean): QueueEnding {
  // A command that stopped between the count and the record wrote no line
  // into the audit, so the audit may not tell the outcome.
  const counted =
    'Über diesen Eintrag hat Ecclium schon einen Entscheid gezählt, aber keinen Vermerk festgehalten, etwa weil ein Befehl dazwischen endete. Entscheiden lässt er sich nicht mehr. Hat der Befehl seine Zeile noch geschrieben, zeigt ‹ecclium audit show› den Ausgang.';
  return shown
    ? ending(
        `${counted} Sein Inhalt lässt sich nicht mehr zeigen und verfällt mit dem Eintrag nach 14 Tagen.`,
        exitCodes.ok,
      )
    : ending(
        `${counted} Dieser Befehl hat nichts geändert.`,
        exitCodes.dataError,
      );
}

/** The line before the diff of an approval that wrote. */
export const approvedDiffHeading =
  'Ecclium hat so geschrieben, mit ‹-› für Zeilen davor und ‹+› für Zeilen danach:';

/** The line before the diff of an approval that may not have written. */
export const wouldWriteHeading =
  'Die Freigabe sollte so schreiben, mit ‹-› für Zeilen davor und ‹+› für Zeilen danach:';

/**
 * The lines after an approval that wrote.
 *
 * @param version - The version of the target after the write.
 * @param undoId - The ID to take the write back with, if it kept one.
 * @returns The lines, for stdout.
 * @example
 * ```ts
 * approvedLines(4, '11111111-2222-4333-8444-555555555555');
 * ```
 */
export function approvedLines(version: number, undoId?: string): string[] {
  const lines = [
    `Der Eintrag ist freigegeben und sein Inhalt vernichtet. Das Ziel steht jetzt in Version ${String(version)}.`,
  ];
  lines.push(
    undoId === undefined
      ? 'Zurücknehmen lässt sich der Schreibvorgang nicht, weil ‹ECCLIUM_SNAPSHOTS› auf ‹off› steht.'
      : `Zurücknehmen lässt sich der Schreibvorgang mit ‹ecclium undo ${undoId}›.`,
  );
  return lines;
}

/**
 * The ending of an approval that may have written while its line did not
 * reach the audit file.
 */
export const approvedUnrecorded = ending(
  'Die Zeile dieser Freigabe kam nicht in die Audit-Datei, obwohl Ecclium über den Eintrag entschieden und womöglich geschrieben hat. Prüfen Sie die Audit-Datei mit ‹ecclium audit verify› und das Ziel in ChurchTools.',
  exitCodes.ioError,
);

// A store of quotas that did not answer in time may still count the
// decision, so neither waiting nor used up can be said.
const countUnknownText =
  'Der Zähler der Entscheide hat nicht rechtzeitig geantwortet, darum hat Ecclium nicht entschieden und nichts geschrieben. Ob der Zähler den Entscheid trotzdem noch gezählt hat, ist unbekannt: Ob sich der Eintrag noch entscheiden lässt, zeigt ‹ecclium queue list›. Prüfen Sie den Ordner ‹quota› im Zustandsordner.';

// What an approval that did not write says of its entry: it still waits,
// or its approval is used up.
const waits = ' Der Eintrag wartet weiter auf Ihre Freigabe.';
const usedUp =
  ' Die Freigabe ist verbraucht, und der Eintrag lässt sich nicht noch einmal freigeben. Lassen Sie den Schreibvorgang bei Bedarf neu planen.';

// The sentences of an approval by the reason the core names, before what
// it says of the entry, with the code they end with.
const approveReasons: Readonly<
  Record<ApproveReason, { readonly text: string; readonly code: ExitCode }>
> = Object.freeze({
  blocked: {
    text: 'Ecclium schreibt nichts mehr, bis es neu startet, weil ein Schreibvorgang nicht in die Audit-Datei kam. Prüfen Sie die Audit-Datei mit ‹ecclium audit verify›.',
    code: exitCodes.noPermission,
  },
  readOnly: {
    text: 'Eine Freigabe schreibt, und ‹ECCLIUM_READ_ONLY› steht nicht auf ‹false›.',
    code: exitCodes.noPermission,
  },
  switchedOff: {
    text: 'Das Schreiben ist für diesen Mandanten mit einem Kill-Switch im Zustandsordner ausgeschaltet, Ecclium hat nichts geschrieben.',
    code: exitCodes.noPermission,
  },
  switchUnknown: {
    text: 'Ecclium kann nicht prüfen, ob das Schreiben ausgeschaltet ist, und schreibt darum nicht. Prüfen Sie den Ordner ‹stop› im Zustandsordner.',
    code: exitCodes.noPermission,
  },
  notRun: {
    text: 'Diese Version von Ecclium führt diese Art Schreibvorgang nicht aus, Ecclium hat nichts geschrieben.',
    code: exitCodes.noPermission,
  },
  intent: {
    text: 'Der Eintrag beschreibt keinen Schreibvorgang, den Ecclium ausführen kann, Ecclium hat nichts geschrieben.',
    code: exitCodes.dataError,
  },
  blank: {
    text: 'Der Text des Eintrags besteht nur aus Leerzeichen, Ecclium hat nichts geschrieben.',
    code: exitCodes.dataError,
  },
  rightsUnknown: {
    text: 'Ecclium kann die Rechte des Dienstkontos nicht lesen und schreibt darum nicht. Prüfen Sie das Dienstkonto in ChurchTools.',
    code: exitCodes.noPermission,
  },
  missingRight: {
    text: 'Das Dienstkonto darf Seiten in dieser Kategorie des Wikis nicht ändern, Ecclium hat nichts geschrieben. Die nötigen Rechte nennt die Anleitung zum Dienstkonto.',
    code: exitCodes.noPermission,
  },
  notMarkdown: {
    text: 'Die Seite ist keine Markdown-Seite. Ecclium ändert nur Markdown-Seiten und hat nichts geschrieben.',
    code: exitCodes.noPermission,
  },
  changedBefore: {
    text: 'Das Ziel hat sich seit dem Einreihen geändert, darum hat Ecclium nichts geschrieben.',
    code: exitCodes.dataError,
  },
  changedSincePlan: {
    text: 'Das Ziel hat sich während der Freigabe geändert, darum hat Ecclium nichts geschrieben.',
    code: exitCodes.dataError,
  },
  changedSinceQueued: {
    text: 'Das Ziel hat sich seit dem Einreihen geändert, darum hat Ecclium nichts geschrieben und nicht entschieden. Freigeben lässt sich der Eintrag nicht mehr: Weisen Sie ihn mit ‹ecclium queue reject› ab und lassen Sie den Schreibvorgang neu planen.',
    code: exitCodes.dataError,
  },
  clock: {
    text: 'Die Uhr dieses Rechners weicht mehr als fünf Minuten von der Zeit von ChurchTools ab, darum schreibt Ecclium nicht. Stellen Sie die Uhr des Rechners.',
    code: exitCodes.noPermission,
  },
  notSent: {
    text: 'Der Schreibvorgang hat ChurchTools nicht erreicht, nichts hat sich geändert.',
    code: exitCodes.unavailable,
  },
  unknown: {
    text: 'Ob der Schreibvorgang ChurchTools erreicht hat, ist unbekannt. Prüfen Sie das Ziel in ChurchTools.',
    code: exitCodes.unavailable,
  },
  notAsPlanned: {
    text: 'Der Schreibvorgang hat ChurchTools erreicht, aber das Ziel liest sich danach nicht wie geplant. Prüfen Sie das Ziel in ChurchTools.',
    code: exitCodes.unavailable,
  },
  notConfirmed: {
    text: 'Die Freigabe ist mit einem internen Fehler abgebrochen, Ecclium hat nichts geschrieben. Einzelheiten zeigt Ecclium nicht.',
    code: exitCodes.internal,
  },
  noSnapshot: {
    text: 'Ecclium konnte den Stand vor dem Schreibvorgang nicht festhalten und hat darum nichts geschrieben. Prüfen Sie den Ordner ‹snapshots› im Zustandsordner und den Schlüsselordner.',
    code: exitCodes.ioError,
  },
  // The marking of a new page or a section (ADR 0032).
  noMarking: {
    text: 'Ecclium kann nicht kennzeichnen, was es dem Wiki hinzufügt, und hat nichts geschrieben. Setzen Sie ‹ECCLIUM_MARKER_KEY_FILE› und in der Richtlinie ‹interactive.inquiriesTo›.',
    code: exitCodes.invalidConfig,
  },
  noDay: {
    text: 'Die Uhr dieses Rechners nennt keinen Tag für die Kennzeichnung, darum schreibt Ecclium nicht. Stellen Sie die Uhr des Rechners.',
    code: exitCodes.noPermission,
  },
  tooLong: {
    text: 'Mit der Zeile der Kennzeichnung wäre der Text der Seite länger, als ChurchTools annimmt. Ecclium hat nichts geschrieben.',
    code: exitCodes.dataError,
  },
  pageOpen: {
    text: 'Die Seite endet in einem offenen Block, etwa einem Codeblock oder Kommentar, der den Abschnitt mit seiner Kennzeichnung aufnähme. Ecclium hat nichts geschrieben. Schliessen Sie den Block in ChurchTools.',
    code: exitCodes.dataError,
  },
  auditNotReady: {
    text: 'Die Audit-Datei kann die Zeile der Freigabe nicht aufnehmen, darum schreibt Ecclium nicht. Prüfen Sie die Audit-Datei mit ‹ecclium audit verify›.',
    code: exitCodes.ioError,
  },
  content: {
    text: 'Die ContentPolicy weist einen Text des Eintrags jetzt ab, etwa weil sich die Kontakte in der Richtlinie geändert haben. Ecclium hat nichts geschrieben.',
    code: exitCodes.dataError,
  },
  countUnknown: {
    text: countUnknownText,
    code: exitCodes.internal,
  },
});

// Codes with which ChurchTools answers and refuses a write.
const refusals: readonly ErrorCode[] = Object.freeze([
  'auth',
  'permission',
  'not_found',
  'conflict',
  'validation',
]);

// The sentences of an approval by the code of the error alone.
const approveCodeTexts = (
  code: ErrorCode,
): { readonly text: string; readonly code: ExitCode } => {
  switch (code) {
    case 'auth':
      return {
        text: 'ChurchTools hat das Token des Dienstkontos abgewiesen, Ecclium hat nichts geschrieben. Erneuern Sie das Token, wie es die Anleitung zum Dienstkonto beschreibt.',
        code: exitCodes.noPermission,
      };
    case 'permission':
      return approveReasons.missingRight;
    case 'not_found':
      return {
        text: 'Das Ziel gibt es in ChurchTools nicht mehr, oder das Dienstkonto sieht es nicht. Ecclium hat nichts geschrieben.',
        code: exitCodes.noInput,
      };
    case 'conflict':
      return approveReasons.changedSincePlan;
    case 'validation':
      return {
        text: 'ChurchTools hat den Text abgewiesen, Ecclium hat nichts geschrieben.',
        code: exitCodes.dataError,
      };
    case 'network':
    case 'upstream':
    case 'rate_limited':
      return {
        text: 'ChurchTools war nicht erreichbar oder hat nicht wie erwartet geantwortet, Ecclium hat nichts geschrieben.',
        code: exitCodes.unavailable,
      };
    case 'policy_denied':
      return {
        text: 'Ecclium hat die Freigabe abgewiesen und nichts geschrieben.',
        code: exitCodes.noPermission,
      };
    default:
      return approveReasons.notConfirmed;
  }
};

/**
 * The ending of an approval that was refused or failed: by the reason the
 * core names, otherwise by the stable code of the error and whether the
 * write may have reached ChurchTools, and then what that means for the
 * entry, which waits on unless the approval is used up.
 *
 * @param failure - Code, reason, whether the approval is used up and
 *   whether the write may have been sent.
 * @param failure.code - The stable code of the error, never its message.
 * @param failure.reason - The reason, where the core knows it.
 * @param failure.used - Whether the approval is used up.
 * @param failure.sent - Whether the write may have reached ChurchTools.
 * @returns The ending.
 * @example
 * ```ts
 * approveFailedEnding({ code: 'network', used: false, sent: false }).code; // 69
 * ```
 */
export function approveFailedEnding(failure: {
  readonly code: ErrorCode;
  readonly reason?: ApproveReason | undefined;
  readonly used: boolean;
  readonly sent: boolean;
}): QueueEnding {
  const { code, reason, used, sent } = failure;
  // A write ChurchTools answered and refused carries the sentence that it
  // did not reach the target, but its code says why.
  const found =
    reason !== undefined && !(reason === 'notSent' && refusals.includes(code))
      ? approveReasons[reason]
      : sent
        ? code === 'conflict'
          ? approveReasons.notAsPlanned
          : approveReasons.unknown
        : approveCodeTexts(code);
  // The sentence of a target that changed since the write was queued, and
  // that of a count that is unknown, say themselves what is left to do.
  const after =
    reason === 'changedSinceQueued' || reason === 'countUnknown'
      ? ''
      : used
        ? usedUp
        : waits;
  return ending(`${found.text}${after}`, found.code);
}

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
 * the error, the reason, and whether the decision was counted.
 *
 * @param failure - Code, reason and whether the decision was counted.
 * @param failure.code - The stable code of the error, never its message.
 * @param failure.reason - Why, where the core knows it.
 * @param failure.used - Whether the decision was counted but not kept.
 * @returns The ending.
 * @example
 * ```ts
 * failedEnding({ code: 'internal' }).code; // 70
 * ```
 */
export function failedEnding(failure: {
  readonly code: ErrorCode;
  readonly reason?: 'auditNotReady' | 'countUnknown' | undefined;
  readonly used?: true | undefined;
}): QueueEnding {
  if (failure.reason === 'countUnknown') {
    return ending(countUnknownText, exitCodes.internal);
  }
  // Counted but not kept: the entry can no longer be decided (ADR 0029).
  if (failure.used === true) {
    return ending(
      'Der Befehl ist mit einem internen Fehler abgebrochen, nachdem Ecclium den Entscheid gezählt hatte. Der Eintrag lässt sich darum nicht mehr entscheiden und verfällt nach 14 Tagen. Prüfen Sie den Ordner ‹queue› im Zustandsordner.',
      exitCodes.internal,
    );
  }
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
