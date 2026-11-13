/**
 * The texts of `ecclium run-once` and of the runner (ADR 0033, ADR 0034),
 * for operators in German: why the runner or a routine does not start,
 * what became of each routine of a pass, and the providers of the models.
 * A text names the ID of a routine, a period and a code, which are
 * settings of the operator and fixed lists, never a path, a token or a
 * value of ChurchTools or of the model.
 *
 * @packageDocumentation
 */
import {
  dueLimits,
  type ProviderSettings,
} from '@ecclium/mcp-churchtools-core';
import type {
  PreviewReport,
  RoutineReport,
} from '@ecclium/mcp-churchtools-runner';
import type { RoutineLoadProblem } from '@ecclium/mcp-churchtools-workflows';

import type { RefusedRoutine, RunnerRoutineCode } from './start.js';

const quote = (text: string): string => `‹${text}›`;

// The tries of one trigger, the first run included (ADR 0034).
const maxTries = dueLimits.maxTries;

/** Why the runner does not start, for the problems besides the loader. */
export const runnerStartTexts = Object.freeze({
  credential_mixed: (routineId: string): string =>
    `Der Runner startet nicht: Die Einträge der Routine ${quote(routineId)} in der Richtlinie nennen zwei verschiedene Konten. Ein Lauf liest und schreibt mit genau einem Konto. Nennen Sie in allen Einträgen der Routine dasselbe ‹credential›.`,
  read_only_wiki: (routineId: string): string =>
    `Der Runner startet nicht: Die Routine ${quote(routineId)} schreibt ins Wiki, und ‹ECCLIUM_READ_ONLY› steht nicht auf ‹false›. Ein Lauf würde lesen und das Modell fragen und dann nichts schreiben. Setzen Sie ‹ECCLIUM_READ_ONLY=false›, wenn der Runner schreiben soll, oder nehmen Sie die Routine aus dem Ordner. Eine Vorschau mit ‹--preview› läuft auch so.`,
  routine_unknown:
    'Eine Routine mit dieser Kennung gibt es im Ordner aus ‹ECCLIUM_ROUTINES_DIR› nicht. Ecclium nennt die Kennung nicht noch einmal. Prüfen Sie die Schreibweise: Die Kennung ist der Name der Datei ohne ‹.yaml›.',
  routine_invalid:
    'Die Kennung ist keine Kennung einer Routine: Kleinbuchstaben, Ziffern und Bindestriche, höchstens 63 Zeichen, am Anfang ein Buchstabe oder eine Ziffer.',
});

/**
 * Why the routines cannot be loaded: the code of the loader, the routine,
 * the field and the line where there are any.
 *
 * @param problem - The first problem of the loader.
 * @returns One text.
 * @example
 * ```ts
 * routinesProblemText({ code: 'routine_yaml_syntax', routine: 'dienstplan-report', line: 4 });
 * ```
 */
export function routinesProblemText(problem: RoutineLoadProblem): string {
  const where = [
    problem.routine === undefined
      ? ''
      : ` in der Routine ${quote(problem.routine)}`,
    problem.field === undefined ? '' : `, Feld ${quote(problem.field)}`,
    problem.line === undefined ? '' : `, Zeile ${String(problem.line)}`,
  ].join('');
  return `Der Runner startet nicht: Die Routinen im Ordner aus ‹ECCLIUM_ROUTINES_DIR› lassen sich nicht laden, Code ${quote(problem.code)}${where}. Die Seite ‹docs/routines.md› der Dokumentation beschreibt das Format jeder Datei einer Routine.`;
}

// What to do for each code a single routine does not start with.
const refusedActions: Readonly<Record<RunnerRoutineCode, string>> =
  Object.freeze({
    run_tool_unknown:
      'Das Tool gibt es in Ecclium nicht. Prüfen Sie den Namen des Tools.',
    run_tool_unfit:
      'Eine Routine liest nur mit Lese-Tools, auf die sie sich verlassen kann und die ohne Menschen laufen dürfen. Wählen Sie ein solches Tool.',
    run_param_unknown:
      'Das Tool kennt diesen Parameter nicht. Prüfen Sie den Namen des Parameters.',
    run_param_days:
      'Ein relativer Tag reicht höchstens 366 Tage weit. Wählen Sie einen näheren Tag.',
    run_field_unknown:
      'Die Einträge der Quelle haben dieses Feld nicht. Prüfen Sie den Namen des Felds.',
    run_credential_mixed:
      'Die Einträge der Routine in der Richtlinie nennen zwei verschiedene Konten. Nennen Sie in allen dasselbe ‹credential›.',
    run_target_unlisted:
      'Für das Ziel im Wiki hat die Richtlinie keinen Eintrag mit dem Tool der Ausgabe. Prüfen Sie die Routine mit ‹--preview› und tragen Sie das Ziel dann in die Richtlinie ein.',
    run_model_unknown:
      'Die Datei der Anbieter aus ‹ECCLIUM_PROVIDERS_FILE› nennt keinen Anbieter mit diesem Alias. Tragen Sie ihn ein oder wählen Sie einen Alias, den es gibt.',
    runner_pseudonym_key_missing:
      'Die Routine gibt dem Modell Daten in der Stufe ‹strict›, die Kennungen von Personen durch Pseudonyme ersetzt, und ‹ECCLIUM_PSEUDONYM_KEY_FILE› ist nicht gesetzt. Legen Sie die Schlüsseldatei an und nennen Sie sie dort.',
    runner_drafts_dir_unset:
      'Die Routine schreibt einen Entwurf als Datei, und ‹ECCLIUM_DRAFTS_DIR› ist nicht gesetzt. Nennen Sie dort den Ordner der Entwürfe.',
    runner_stop_dir_missing:
      'Die Routine schreibt einen Entwurf, und den Ordner ‹stop› der Kill-Switches im Zustandsordner gibt es nicht oder Ecclium kann ihn nicht prüfen. Ein Kill-Switch, den Ecclium nicht sieht, hielte jeden Entwurf an. Legen Sie den Ordner ‹stop› im Zustandsordner an.',
    runner_inquiries_missing:
      'Die Routine schreibt einen Entwurf, und die Richtlinie nennt unter ‹interactive.inquiriesTo› niemanden für Rückfragen. Die Kennzeichnung am Ende des Entwurfs braucht diese Angabe. Tragen Sie sie in die Richtlinie ein.',
    runner_notify_file_unset:
      'Die Routine meldet ihre Läufe in eine Datei, und ‹ECCLIUM_NOTIFY_FILE› ist nicht gesetzt. Nennen Sie dort die Datei der Meldungen oder wählen Sie den Kanal ‹stdout›.',
  });

/**
 * Why one routine does not start, with its code and field.
 *
 * @param refused - The routine, its code and its field.
 * @returns One text.
 * @example
 * ```ts
 * refusedText({ routineId: 'dienstplan-report', code: 'run_tool_unknown', field: 'inputs[1].tool' });
 * ```
 */
export function refusedText(refused: RefusedRoutine): string {
  const field =
    refused.field === undefined ? '' : `, Feld ${quote(refused.field)}`;
  return `Die Routine ${quote(refused.routineId)} startet nicht, Code ${quote(refused.code)}${field}. ${refusedActions[refused.code]}`;
}

// How a run ended, in words.
const resultWords = Object.freeze({
  written: 'geschrieben',
  unchanged: 'unverändert, der Abschnitt steht schon so im Wiki',
  queued: 'in der Freigabe-Warteschlange, sie wartet auf Ihre Freigabe',
  drafted: 'Entwurf geschrieben',
  preview: 'Vorschau, nichts geschrieben',
  failed: 'gescheitert',
} as const);

/**
 * What became of a routine in a pass, or undefined for a routine that was
 * not due, which a pass every 15 minutes would else repeat for every
 * routine.
 *
 * @param report - What became of the routine.
 * @returns One text, or undefined.
 * @example
 * ```ts
 * routineReportText(report);
 * ```
 */
export function routineReportText(report: RoutineReport): string | undefined {
  const routine = `Routine ${quote(report.routineId)}`;
  const period =
    report.period === undefined ? '' : `, Periode ${quote(report.period)}`;
  switch (report.status) {
    case 'not_due':
    case 'stopped':
      return undefined;
    case 'busy':
      return `${routine}: Ein anderer Prozess führt sie gerade aus, dieser Aufruf hat sie übersprungen.`;
    case 'halted':
      return `${routine}${period}: nicht gestartet, weil der Prozess nach einer Zeile des Audits, die die Datei nicht erreichte, nichts mehr schreibt. Prüfen Sie die Audit-Datei; der nächste Aufruf versucht es wieder.`;
    case 'read_only':
      return `${routine}${period}: nicht gestartet, weil sie ins Wiki schreibt und ‹ECCLIUM_READ_ONLY› nicht auf ‹false› steht.`;
    case 'unavailable':
      return `${routine}${period}: nicht gestartet, weil das Gedächtnis der Läufe im Zustandsordner nicht antwortete. Ohne es weiss Ecclium nicht, ob die Auslösung schon lief. Der nächste Aufruf versucht es wieder.`;
    case 'lock_failed':
      return `${routine}: nicht gestartet, weil sich die Sperrdatei der Routine im Ordner ‹runner› des Zustandsordners nicht anlegen liess. Prüfen Sie, dass der Ordner Ihrem Benutzer gehört, kein Link ist und nur für Sie zugänglich ist.`;
    case 'not_opened':
      return `${routine}${period}: nicht gestartet, Code ${quote(report.code ?? 'internal')}. Das Konto oder das Modell der Routine lässt sich nicht verwenden. Prüfen Sie die Token-Datei des Kontos im Ordner aus ‹ECCLIUM_RUNNER_TOKENS_DIR›, die auch ‹ecclium config check --runner› prüft, und die Datei des Schlüssels des Modells.`;
    case 'internal':
      return `${routine}: mit einem internen Fehler abgebrochen. Einzelheiten zeigt Ecclium nicht.`;
    case 'ran': {
      const outcome = report.outcome;
      if (outcome === undefined) return undefined;
      const run =
        report.runId === undefined ? '' : `, Lauf ${quote(report.runId)}`;
      const code =
        outcome.code === undefined ? '' : `, Code ${quote(outcome.code)}`;
      const again =
        outcome.result === 'failed'
          ? outcome.final
            ? ' Diese Auslösung ist damit abgeschlossen; nach einer Korrektur starten Sie die Routine mit ‹ecclium run-once <Routine>›.'
            : (report.attempt ?? 0) >= maxTries
              ? ' Das war der dritte Versuch dieser Auslösung; die Routine wartet auf ihre nächste Auslösung, oder Sie starten sie mit ‹ecclium run-once <Routine>›.'
              : ' Ein späterer Aufruf versucht es noch einmal.'
          : '';
      const lost = [
        report.recorded === false
          ? ' Die Zeile des Audits zum Ende des Laufs erreichte die Audit-Datei nicht.'
          : '',
        report.closed === false
          ? ' Das Gedächtnis der Läufe hat das Ende der Auslösung nicht festgehalten.'
          : '',
        report.notified === false
          ? ' Die Meldung des Laufs liess sich nicht ganz senden.'
          : '',
      ].join('');
      return `${routine}${period}${run}: ${resultWords[outcome.result]}${code}.${again}${lost}`;
    }
  }
}

/**
 * What became of a preview, besides the section on stdout.
 *
 * @param report - What became of the preview.
 * @returns One text.
 * @example
 * ```ts
 * previewReportText(report);
 * ```
 */
export function previewReportText(report: PreviewReport): string {
  const routine = `Routine ${quote(report.routineId)}`;
  const period =
    report.period === undefined ? '' : `, Periode ${quote(report.period)}`;
  switch (report.status) {
    case 'not_opened':
      return `${routine}${period}: Vorschau nicht gestartet, Code ${quote(report.code ?? 'internal')}. Das Konto oder das Modell der Routine lässt sich nicht verwenden.`;
    case 'internal':
      return `${routine}: Vorschau mit einem internen Fehler abgebrochen. Einzelheiten zeigt Ecclium nicht.`;
    case 'ran': {
      const outcome = report.outcome;
      const lost =
        report.recorded === false
          ? ' Die Zeile des Audits erreichte die Audit-Datei nicht.'
          : '';
      if (outcome?.result === 'preview') {
        return `${routine}${period}: Vorschau auf stdout, ohne die Zeile der Kennzeichnung. Geschrieben ist nichts, gezählt ist kein Versuch, aber das Lesen und, wo die Routine eines hat, das Modell haben gekostet.${lost}`;
      }
      return `${routine}${period}: Vorschau gescheitert, Code ${quote(outcome?.code ?? 'internal')}. Geschrieben ist nichts.${lost}`;
    }
  }
}

/**
 * One line per provider a call uses, as the start of the runner names
 * them: vendor, model, country and the basis of a transfer outside
 * Switzerland and the EEA (ADR 0033).
 *
 * @param provider - The checked settings of a provider.
 * @returns One text.
 * @example
 * ```ts
 * providerText(provider);
 * ```
 */
export function providerText(provider: ProviderSettings): string {
  const { info } = provider;
  const basis =
    info.transferBasis === undefined
      ? 'Schweiz oder EWR, keine Grundlage nötig'
      : `Grundlage ${quote(info.transferBasis)}`;
  return `Modell für ${quote(provider.alias)}: Anbieter ${quote(info.vendor)}, Modell ${quote(info.model)}, Land ${quote(info.hostingCountry)}, ${basis}.`;
}

/**
 * Why the key file of a model cannot be used: the routines of the model
 * do not start in this call, the others run.
 *
 * @param alias - The alias of the provider.
 * @param code - The code of the key file, such as `token_file_mode`.
 * @returns One text.
 * @example
 * ```ts
 * modelKeyText('default', 'token_file_mode');
 * ```
 */
export function modelKeyText(alias: string, code: string): string {
  return `Das Modell ${quote(alias)} lässt sich nicht verwenden: Seine Datei des Schlüssels hat den Code ${quote(code)}. Die Routinen mit diesem Modell starten nicht, die übrigen laufen. Legen Sie die Datei so an, wie die Datei der Anbieter sie nennt, als Ihr Benutzer und mit den Rechten 600.`;
}

/**
 * The last line of a pass, with its counts.
 *
 * @param counts - What the pass counted.
 * @param counts.ran - The routines that ran.
 * @param counts.skipped - The routines skipped for another reason than
 *   not being due.
 * @param counts.refused - The routines that do not start.
 * @returns One text.
 * @example
 * ```ts
 * passSummaryText({ ran: 1, skipped: 0, refused: 0 });
 * // 'Durchgang beendet: 1 Lauf, 0 übersprungen, 0 Routinen starten nicht.'
 * ```
 */
export function passSummaryText(counts: {
  readonly ran: number;
  readonly skipped: number;
  readonly refused: number;
}): string {
  return `Durchgang beendet: ${String(counts.ran)} ${counts.ran === 1 ? 'Lauf' : 'Läufe'}, ${String(counts.skipped)} übersprungen, ${String(counts.refused)} ${counts.refused === 1 ? 'Routine startet' : 'Routinen starten'} nicht.`;
}

/**
 * Why the folder of the drafts cannot be used: the runner does not start.
 *
 * @param code - The code of the private folder, such as `unsafe`.
 * @returns One text.
 * @example
 * ```ts
 * draftsFolderText('unsafe');
 * ```
 */
export function draftsFolderText(code: string): string {
  return `Der Ordner aus ‹ECCLIUM_DRAFTS_DIR› lässt sich nicht als privater Ordner verwenden, Code ${quote(code)}, und der Runner startet nicht. Ein Entwurf enthält Namen von Personen; nur der Benutzer des Runners darf den Ordner lesen. Legen Sie ihn mit den Rechten 700 an, als der Benutzer, unter dem der Runner läuft.`;
}

/**
 * Why the folder of the metrics file cannot be used: the runner does not
 * start.
 *
 * @param code - The code of the private folder, such as `unsafe`.
 * @returns One text.
 * @example
 * ```ts
 * metricsFolderText('unsafe');
 * ```
 */
export function metricsFolderText(code: string): string {
  return `Der Ordner der Metrikdatei aus ‹ECCLIUM_RUNNER_METRICS_FILE› lässt sich nicht als privater Ordner verwenden, Code ${quote(code)}, und der Runner startet nicht. Wie jede Datei von Ecclium liegt die Metrikdatei in einem Ordner nur für den Benutzer des Runners. Legen Sie den Ordner mit den Rechten 700 an, als der Benutzer, unter dem der Runner läuft, oder lassen Sie ihn den Runner anlegen. Eine Überwachung liest die Datei als derselbe Benutzer.`;
}

/** The texts of the process of the runner and of its daemon. */
export const runnerProcessTexts = Object.freeze({
  signal:
    'Der Runner hält an: Lesen und Modell brechen ab, ein Schreibvorgang, der begonnen hat, endet noch, und keine weitere Routine beginnt. Ein zweites Signal beendet ihn sofort, ausser während eines Schreibvorgangs.',
  metrics_failed:
    'Die Metrikdatei aus ‹ECCLIUM_RUNNER_METRICS_FILE› liess sich nicht schreiben. Die Läufe selbst sind davon nicht betroffen. Prüfen Sie, dass ihr Ordner Ihrem Benutzer gehört, nur für Sie zugänglich ist und Platz hat.',
  no_routine:
    'Der Runner startet nicht: Keine Routine im Ordner aus ‹ECCLIUM_ROUTINES_DIR› startet. Die Zeilen darüber nennen den Grund für jede.',
  halted:
    'Der Runner endet mit 75: Eine Zeile des Audits erreichte die Audit-Datei nicht, und seither schreibt der Prozess nichts mehr. Ein Neustart hebt die Sperre. Prüfen Sie die Audit-Datei im Zustandsordner, etwa den freien Platz.',
});

/**
 * The first line of the daemon, after the routines that do not start.
 *
 * @param counts - What the start counted.
 * @param counts.routines - The routines that run.
 * @param counts.refused - The routines that do not start.
 * @returns One text.
 * @example
 * ```ts
 * daemonStartText({ routines: 2, refused: 0 });
 * ```
 */
export function daemonStartText(counts: {
  readonly routines: number;
  readonly refused: number;
}): string {
  return `Der Runner läuft mit ${String(counts.routines)} ${counts.routines === 1 ? 'Routine' : 'Routinen'}, ${String(counts.refused)} ${counts.refused === 1 ? 'startet' : 'starten'} nicht. Er sieht die Routinen zu ihrer Zeit an, spätestens alle 15 Minuten.`;
}
