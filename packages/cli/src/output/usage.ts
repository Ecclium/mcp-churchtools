/**
 * The fixed texts of the command line about its own use (ADR 0055). No
 * text repeats an argument: an option or a word on the command line can
 * hold a token.
 *
 * @packageDocumentation
 */

/** The short form of the call. */
export const usageLine = 'Aufruf: ecclium config check [--show-values]';

/** The help, for `--help` and `-h`. */
export const helpLines: readonly string[] = Object.freeze([
  usageLine,
  'Prüft die Konfiguration aus der Umgebung, ohne ChurchTools anzufragen.',
  '  --show-values  zeigt auch den Host und ein abweichendes Subjekt',
  '  -h, --help     zeigt diese Hilfe',
]);

/** What is wrong with a call. */
export type UsageProblem = 'command' | 'option' | 'repeated' | 'value';

/** One text per kind of wrong call: what, why and what to do. */
export const usageProblemTexts: Readonly<Record<UsageProblem, string>> =
  Object.freeze({
    command:
      'Der Befehl ist unvollständig oder unbekannt. Diese Version von Ecclium kennt nur ‹ecclium config check›. Prüfen Sie den Aufruf mit ‹ecclium --help›.',
    option:
      'Eine Option ist unbekannt. Ecclium nennt sie nicht, weil darin ein Token stehen könnte. Prüfen Sie den Aufruf mit ‹ecclium --help›.',
    repeated:
      'Eine Option steht mehr als einmal im Aufruf. Jede Option gilt nur einmal, damit kein Aufruf zweideutig ist. Nennen Sie jede Option höchstens einmal.',
    value:
      'Eine Option hat einen Wert erhalten. Die Optionen von ‹ecclium config check› nehmen keinen Wert an. Geben Sie die Option ohne Wert an.',
  });

/** The one text for an internal error. */
export const internalErrorText =
  'Die Prüfung ist mit einem internen Fehler abgebrochen. Einzelheiten zeigt Ecclium nicht, weil sie Werte der Konfiguration enthalten könnten. Versuchen Sie es erneut und melden Sie den Fehler, wenn er bleibt.';
