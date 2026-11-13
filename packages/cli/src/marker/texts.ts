/**
 * The texts of `ecclium marker adopt` (ADR 0032), for operators in German:
 * what happened, why, and what to do, each with its exit code after
 * sysexits. No text repeats an argument as it was given; the IDs of a run,
 * an adoption and an entry of the queue appear only as the audit names
 * them, and the text of the page only in the preview, made safe for the
 * terminal (`output/terminal.ts`).
 *
 * @packageDocumentation
 */
import type { AdoptOutcome, UndoReason } from '@ecclium/mcp-churchtools-core';
import type { ErrorCode } from '@ecclium/mcp-churchtools-plugin-api';

import type { RunPipelineCode } from '../compose/run-pipeline.js';
import { type ExitCode, exitCodes } from '../exit-codes.js';
import { runAccountCauses } from '../queue/texts.js';

/** A text and the exit code it ends the command with. */
export interface AdoptEnding {
  readonly text: string;
  readonly code: ExitCode;
}

const ending = (text: string, code: ExitCode): AdoptEnding =>
  Object.freeze({ text, code });

/** The problems that end `ecclium marker adopt` before it asks ChurchTools. */
export type AdoptProblem =
  | 'run_invalid'
  | 'confirm_invalid'
  | 'read_only'
  | 'state_dir_missing'
  | 'snapshots_off'
  | 'marker_key_missing'
  | 'run_unknown'
  | 'run_without_period'
  | 'audit_incomplete'
  | 'page_unknown'
  | 'routine_busy'
  | 'routine_lock_failed';

const snapshotsOff = ending(
  'Dieser Server hält mit ‹ECCLIUM_SNAPSHOTS=off› keine Snapshots fest. Ohne sie belegt nichts, wo ein Abschnitt beginnt, und eine Übernahme liesse sich nicht zurücknehmen. Setzen Sie ‹ECCLIUM_SNAPSHOTS› auf ‹on›.',
  exitCodes.noInput,
);

/** One ending per problem. */
export const adoptProblems: Readonly<Record<AdoptProblem, AdoptEnding>> =
  Object.freeze({
    run_invalid: ending(
      'Die Kennung des Laufs ist keine UUID, Ecclium nennt sie nicht. Nehmen Sie die Kennung ‹run› aus der Meldung des Laufs oder die ‹runId› seiner Zeilen im Audit.',
      exitCodes.usage,
    ),
    confirm_invalid: ending(
      'Der Prüfwert hat nicht die Form, die die Vorschau zeigt, 16 Zeichen aus 0 bis 9 und a bis f. Ecclium nennt ihn nicht. Rufen Sie den Befehl ohne ‹--confirm› auf und nehmen Sie den Prüfwert aus seiner Ausgabe.',
      exitCodes.usage,
    ),
    read_only: ending(
      'Eine Übernahme schreibt, und ‹ECCLIUM_READ_ONLY› steht nicht auf ‹false›. Setzen Sie ‹ECCLIUM_READ_ONLY=false› für den Aufruf, wenn Sie übernehmen wollen.',
      exitCodes.noPermission,
    ),
    state_dir_missing: ending(
      'Ohne ‹ECCLIUM_STATE_DIR› gibt es keine Snapshots und keine Audit-Datei. Setzen Sie denselben Zustandsordner wie beim Runner.',
      exitCodes.invalidConfig,
    ),
    snapshots_off: snapshotsOff,
    marker_key_missing: ending(
      'Ohne ‹ECCLIUM_MARKER_KEY_FILE› hat Ecclium keinen Schlüssel für den Prüfcode und kann nichts neu signieren. Setzen Sie die Variable auf die Schlüsseldatei, mit der der Runner von jetzt an schreibt.',
      exitCodes.invalidConfig,
    ),
    run_unknown: ending(
      'Keine Zeile in den Audit-Dateien der letzten 45 Tage nennt diesen Lauf. Für einen älteren Lauf belegt kein Snapshot mehr seinen Abschnitt, weil die Snapshots nach 30 Tagen vernichtet sind. Prüfen Sie die Kennung mit ‹ecclium audit show --run› und ob ‹ECCLIUM_STATE_DIR› derselbe Ordner ist wie beim Runner.',
      exitCodes.noInput,
    ),
    run_without_period: ending(
      'Der Lauf hat keine Zeile, die sein Ende mit seiner Periode festhält, etwa weil sein Prozess abbrach. Ohne Periode weiss Ecclium nicht, welcher Abschnitt gemeint ist. Nehmen Sie einen Lauf derselben Routine und Periode, der zu Ende lief, etwa den, der seinen Abschnitt in die Freigabe-Warteschlange stellte.',
      exitCodes.noInput,
    ),
    audit_incomplete: ending(
      'Ecclium konnte nicht jede Audit-Datei der letzten 45 Tage ganz lesen, eine Zeile darin passt nicht zum Format der Ereignisse, oder der Ordner ‹audit› änderte sich beim Lesen. Ein Schreibvorgang der Routine könnte darin stehen, und Ecclium signiert dann nichts. Prüfen Sie die Dateien mit ‹ecclium audit verify› und versuchen Sie es erneut.',
      exitCodes.ioError,
    ),
    page_unknown: ending(
      'Die Richtlinie nennt für die Routine dieses Laufs nicht genau eine Seite im Wiki. Eine Übernahme braucht einen Eintrag unter ‹unattended› mit dem Ziel ‹wiki_page›, wie ihn ‹ecclium policy init --routine› vorschlägt; ein Eintrag nur für eine Kategorie nennt die Seite nicht. Ergänzen Sie den Eintrag und versuchen Sie es erneut.',
      exitCodes.noInput,
    ),
    routine_busy: ending(
      'Ein Lauf dieser Routine hält gerade ihre Sperrdatei. Ecclium signiert nichts, solange er schreiben könnte. Versuchen Sie es nach seinem Ende erneut; eine Sperrdatei eines beendeten Laufs gilt spätestens 35 Minuten nach seinem Beginn als verlassen.',
      exitCodes.tempFail,
    ),
    routine_lock_failed: ending(
      'Die Sperrdatei der Routine liess sich nicht anlegen, weil der Ordner ‹runner› im Zustandsordner sich nicht nutzen lässt. Ecclium signiert nichts, ohne einen Lauf derselben Routine auszuschliessen. Der Ordner muss Ihrem Benutzer gehören und darf der Gruppe und anderen keine Rechte geben, üblich sind die Rechte 700.',
      exitCodes.invalidConfig,
    ),
  });

/**
 * The ending when the account of the routine has no token Ecclium accepts.
 *
 * @param code - Why the pipeline of the routine was not built.
 * @returns The ending, with 78.
 * @example
 * ```ts
 * adoptAccountEnding('token_file_missing').code; // 78
 * ```
 */
export const adoptAccountEnding = (code: RunPipelineCode): AdoptEnding =>
  ending(
    `Eine Übernahme schreibt mit dem Konto, das die Richtlinie für die Routine nennt, wie ihre Läufe. ${runAccountCauses[code]} Mit dem Token des Servers signiert Ecclium nichts. ${
      code === 'run_credential_missing' || code === 'run_credential_mixed'
        ? 'Nennen Sie für die Routine in der Richtlinie genau ein Konto.'
        : 'Richten Sie den Ordner aus ‹ECCLIUM_RUNNER_TOKENS_DIR› und die Token-Datei ‹ct_token_<Alias>› so ein, wie der Runner sie braucht.'
    }`,
    exitCodes.invalidConfig,
  );

const queueWay =
  'Der Weg bleibt die Freigabe-Warteschlange: ‹ecclium queue approve› hängt den Abschnitt des wartenden Laufs neu an, ‹ecclium queue reject› verwirft ihn.';

/** The endings of an adoption that signs nothing, by what it found. */
export const adoptEndings = Object.freeze({
  own: ending(
    'Der Abschnitt dieser Periode trägt schon einen Prüfcode, der mit dem Schlüssel von heute passt. Es gibt nichts zu übernehmen.',
    exitCodes.ok,
  ),
  none: ending(
    'Auf der Seite steht keine Zeile der Kennzeichnung dieser Routine und Periode. Ecclium signiert nichts. Prüfen Sie, ob der Lauf auf diese Seite schrieb und ob jemand die Zeile entfernte.',
    exitCodes.noInput,
  ),
  renamed: ending(
    'Die Seite heisst in ChurchTools nicht mehr so, wie der Eintrag der Routine in der Richtlinie es erwartet. Unter derselben Kennung könnte eine andere Seite stehen, darum signiert Ecclium nichts. Prüfen Sie die Seite und den Eintrag.',
    exitCodes.dataError,
  ),
  several: ending(
    `Auf der Seite stehen mehrere Zeilen der Kennzeichnung dieser Routine und Periode, und keine passt zum Schlüssel von heute. Ecclium weiss nicht, welcher Abschnitt der eigene ist, und signiert nichts. ${queueWay}`,
    exitCodes.dataError,
  ),
  hidden: ending(
    `Die Seite enthält HTML, das einen Abschnitt verbergen kann. Ecclium signiert auf einer solchen Seite nichts, damit niemand einen versteckten Abschnitt unterschieben kann. ${queueWay}`,
    exitCodes.dataError,
  ),
  unreadable: ending(
    `Ecclium kann den Text der Seite nicht in Abschnitte zerlegen, etwa weil er zu lang ist oder Zeichen enthält, die es nicht liest. Ecclium signiert nichts. ${queueWay}`,
    exitCodes.dataError,
  ),
  noSnapshot: ending(
    `Kein Schreibvorgang der Routine auf dieser Seite hat noch einen Snapshot, etwa weil er mehr als 30 Tage zurückliegt. Ohne ihn belegt nichts, wo der Abschnitt beginnt, und Ecclium signiert nichts. Oben steht der Bereich von der Zeile der Kennzeichnung davor bis zur Zeile dieser Periode. ${queueWay}`,
    exitCodes.noInput,
  ),
  unproven: ending(
    `Kein Snapshot belegt den Abschnitt: Jemand hat ihn oder den Text darüber seit dem Schreibvorgang geändert, die Seite im Web-Editor gespeichert, oder ein späterer Lauf der Periode hat ihn ersetzt. Ecclium signiert nichts. Oben steht der Bereich von der Zeile der Kennzeichnung davor bis zur Zeile dieser Periode. ${queueWay}`,
    exitCodes.dataError,
  ),
  unsignable: ending(
    `Ein Snapshot belegt den Abschnitt, aber Ecclium kann ihn nicht neu signieren: Die Zeile weicht vom festen Wortlaut ab, oder der Abschnitt enthält etwas, das Ecclium nicht schreibt, etwa einen Link. Oben steht der Bereich. ${queueWay}`,
    exitCodes.dataError,
  ),
  mismatch: ending(
    'Der Prüfwert passt nicht zur Seite von jetzt: Sie hat sich seit der Vorschau geändert, oder der Wert stammt aus einer anderen Vorschau. Ecclium hat nichts geschrieben. Rufen Sie den Befehl ohne ‹--confirm› auf und prüfen Sie die neue Vorschau.',
    exitCodes.dataError,
  ),
  off: snapshotsOff,
  unrecorded: ending(
    'Die Zeile dieser Übernahme kam nicht in die Audit-Datei, obwohl Ecclium die Seite womöglich geändert hat. Prüfen Sie die Audit-Datei mit ‹ecclium audit verify› und die Seite in ChurchTools.',
    exitCodes.ioError,
  ),
});

const internal = ending(
  'Die Übernahme ist mit einem internen Fehler abgebrochen, Ecclium hat nichts geschrieben. Einzelheiten zeigt Ecclium nicht. Melden Sie den Fehler, wenn er bleibt.',
  exitCodes.internal,
);
const notSent = ending(
  'Die Übernahme hat ChurchTools nicht erreicht, nichts hat sich geändert. Prüfen Sie die Verbindung und rufen Sie den Befehl erneut auf.',
  exitCodes.unavailable,
);
const changedMeanwhile = ending(
  'Die Seite hat sich während der Übernahme geändert, darum hat Ecclium nichts geschrieben. Rufen Sie den Befehl ohne ‹--confirm› erneut auf, er zeigt dann den neuen Stand.',
  exitCodes.dataError,
);
const switched = ending(
  'Das Schreiben ist im Ordner der Kill-Switches ausgeschaltet, für alle Mandanten oder für diesen. Ecclium hat nichts geschrieben. Der Kill-Switch der Routine hält eine Übernahme nicht an, diese beiden schon.',
  exitCodes.noPermission,
);

// The reasons a write guard names for an adoption, each with its ending.
const reasons: Partial<Readonly<Record<UndoReason, AdoptEnding>>> =
  Object.freeze({
    blocked: ending(
      'Ein früherer Schreibvorgang dieses Prozesses kam nicht in die Audit-Datei, darum schreibt Ecclium nicht mehr. Ecclium hat nichts geschrieben.',
      exitCodes.noPermission,
    ),
    readOnly: adoptProblems.read_only,
    switchedOff: switched,
    switchUnknown: ending(
      'Ecclium kann nicht prüfen, ob das Schreiben ausgeschaltet ist, und schreibt darum nicht. Prüfen Sie den Ordner der Kill-Switches, ‹stop› im Zustandsordner oder den Ordner aus ‹ECCLIUM_KILL_SWITCH_DIR›.',
      exitCodes.noPermission,
    ),
    rightsUnknown: ending(
      'Ecclium kann die Rechte des Kontos der Routine nicht lesen und schreibt darum nicht. Prüfen Sie das Konto in ChurchTools.',
      exitCodes.noPermission,
    ),
    missingRight: ending(
      'Dem Konto der Routine fehlt das Recht, Seiten dieser Kategorie zu ändern. Ecclium hat nichts geschrieben. Geben Sie dem Konto das Recht, das seine Läufe brauchen.',
      exitCodes.noPermission,
    ),
    notMarkdown: ending(
      'Die Seite ist keine Markdown-Seite, und Ecclium ändert nur solche. Ecclium hat nichts geschrieben.',
      exitCodes.noPermission,
    ),
    changedBefore: changedMeanwhile,
    changedSincePlan: changedMeanwhile,
    clock: ending(
      'Die Uhr dieses Rechners weicht um mehr als fünf Minuten von der Zeit von ChurchTools ab, darum schreibt Ecclium nicht. Stellen Sie die Uhr richtig.',
      exitCodes.noPermission,
    ),
    notSent,
    unknown: ending(
      'Ob die Übernahme ChurchTools erreicht hat, ist unbekannt. Prüfen Sie die Seite in ChurchTools und rufen Sie den Befehl ohne ‹--confirm› erneut auf: Steht der neue Prüfcode schon, gibt es nichts mehr zu tun.',
      exitCodes.unavailable,
    ),
    notAsPlanned: ending(
      'Die Übernahme hat ChurchTools erreicht, aber die Seite liest sich danach nicht wie geplant. Prüfen Sie die Seite in ChurchTools.',
      exitCodes.dataError,
    ),
    noSnapshot: ending(
      'Ecclium konnte den Stand vor der Übernahme nicht festhalten und hat darum nichts geschrieben. Prüfen Sie den Ordner ‹snapshots› im Zustandsordner und den Schlüsselordner.',
      exitCodes.ioError,
    ),
    noMarking: adoptProblems.marker_key_missing,
    auditNotReady: ending(
      'Die Audit-Datei kann die Zeile der Übernahme nicht aufnehmen, darum schreibt Ecclium nicht. Prüfen Sie die Audit-Datei mit ‹ecclium audit verify›.',
      exitCodes.ioError,
    ),
  });

// Codes with which ChurchTools answered and refused: the write did not
// reach the page, and the code says why.
const refusals: readonly ErrorCode[] = Object.freeze([
  'auth',
  'permission',
  'not_found',
  'conflict',
  'validation',
]);

/**
 * The ending of an adoption that was refused or failed.
 *
 * @param failure - The code, the reason of the write guard if any, and
 *   whether it may have reached ChurchTools.
 * @param failure.code - The code of the error.
 * @param failure.reason - The fixed sentence of the write guard, by name.
 * @param failure.sent - Whether the adoption may have reached ChurchTools.
 * @returns The ending.
 * @example
 * ```ts
 * adoptFailedEnding({ code: 'policy_denied', reason: 'switchedOff', sent: false }).code; // 77
 * ```
 */
export function adoptFailedEnding(failure: {
  readonly code: ErrorCode;
  readonly reason?: UndoReason | undefined;
  readonly sent: boolean;
}): AdoptEnding {
  const { code, reason, sent } = failure;
  const named = reason === undefined ? undefined : reasons[reason];
  if (
    named !== undefined &&
    !(reason === 'notSent' && refusals.includes(code))
  ) {
    return named;
  }
  if (sent) {
    return code === 'conflict'
      ? (reasons.notAsPlanned as AdoptEnding)
      : (reasons.unknown as AdoptEnding);
  }
  switch (code) {
    case 'auth':
      return ending(
        'ChurchTools hat das Token des Kontos der Routine abgewiesen, Ecclium hat nichts geschrieben. Erneuern Sie das Token, wie es die Anleitung zum Dienstkonto beschreibt.',
        exitCodes.noPermission,
      );
    case 'permission':
      return reasons.missingRight as AdoptEnding;
    case 'not_found':
      return ending(
        'Die Seite gibt es in ChurchTools nicht mehr, oder das Konto der Routine sieht sie nicht. Ecclium hat nichts geschrieben.',
        exitCodes.noInput,
      );
    case 'conflict':
      return changedMeanwhile;
    case 'validation':
      return ending(
        'ChurchTools hat den Text der Übernahme abgewiesen, Ecclium hat nichts geschrieben. Prüfen Sie die Seite in ChurchTools.',
        exitCodes.dataError,
      );
    case 'network':
    case 'upstream':
    case 'rate_limited':
      return ending(
        'ChurchTools war nicht erreichbar oder hat nicht wie erwartet geantwortet, Ecclium hat nichts geschrieben. Versuchen Sie es später erneut.',
        exitCodes.unavailable,
      );
    case 'policy_denied':
      return ending(
        'Ecclium hat die Übernahme abgewiesen und nichts geschrieben.',
        exitCodes.noPermission,
      );
    default:
      return internal;
  }
}

/** The shown parts of an adoption: section, lines and check value. */
export type AdoptionShown = Extract<AdoptOutcome, { kind: 'preview' }>['shown'];

/**
 * The lines after an adoption that wrote: the new version, how to take it
 * back, what still waits from the period, and how the next run replaces
 * the section.
 *
 * @param done - Version, ID of the adoption, routine and waiting entries.
 * @param done.version - The version of the page after the adoption.
 * @param done.undoId - The ID to take it back with, if a snapshot was kept.
 * @param done.routineId - The ID of the routine.
 * @param done.undecided - The entries of the period with no decision.
 * @returns The lines, for stdout.
 * @example
 * ```ts
 * adoptDoneLines({ version: 5, undoId, routineId: 'dienstplan-report', undecided: [] });
 * ```
 */
export function adoptDoneLines(done: {
  readonly version: number;
  readonly undoId: string | undefined;
  readonly routineId: string;
  readonly undecided: readonly string[];
}): readonly string[] {
  return Object.freeze([
    `Übernommen: Die Zeile der Kennzeichnung trägt jetzt den Prüfcode mit dem Schlüssel von heute, die Seite steht in Version ${String(done.version)}.`,
    ...(done.undoId === undefined
      ? []
      : [
          `Zurücknehmen lässt sich die Übernahme mit ‹ecclium undo ${done.undoId}›.`,
        ]),
    ...done.undecided.map(
      (queueId) =>
        `Ein Lauf dieser Periode hat den Eintrag ‹${queueId}› in die Freigabe-Warteschlange gestellt, und das Audit hält keinen Entscheid fest. Weisen Sie ihn mit ‹ecclium queue reject ${queueId}› ab: Eine Freigabe hängte den Abschnitt ein zweites Mal an.`,
    ),
    `Der nächste Lauf dieser Periode ersetzt den Abschnitt jetzt wie jeden eigenen, von Hand mit ‹ecclium run-once ${done.routineId}›, solange die Periode läuft.`,
  ]);
}
