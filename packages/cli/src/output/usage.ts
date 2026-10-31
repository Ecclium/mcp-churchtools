/**
 * The fixed texts of the command line about its own use (ADR 0055). No
 * text repeats an argument: an option or a word on the command line can
 * hold a token.
 *
 * @packageDocumentation
 */

/** The short form of the call. */
export const usageLine =
  'Aufruf: ecclium stdio | ecclium config check [Optionen] | ecclium audit verify [Optionen] | ecclium audit show [Optionen]';

/** The help, for `--help` and `-h`. */
export const helpLines: readonly string[] = Object.freeze([
  usageLine,
  '  stdio                 startet den Server für einen KI-Assistenten über stdio',
  '  config check          prüft die Konfiguration aus der Umgebung, ohne ChurchTools anzufragen',
  '    --show-values       zeigt bei der Prüfung auch den Host, ein abweichendes Subjekt und den Zustandsordner',
  '  audit verify          prüft die Audit-Dateien gegen ihre Ketten, braucht nur ‹ECCLIUM_STATE_DIR›',
  '    --log <Datei>       prüft auch gegen die Anker aus diesem Log, ‹-› liest stdin, mehrmals möglich',
  '  audit show            zählt die Aufrufe in den Audit-Dateien je Tag und Tool',
  '    --object <Kennung>  zeigt stattdessen die Aufrufe, die eine Kennung wie ‹person:42› nennen',
  '    --since <Tag>       ab diesem Tag in UTC, in der Form JJJJ-MM-TT',
  '    --until <Tag>       bis und mit diesem Tag in UTC',
  '  -h, --help            zeigt diese Hilfe',
]);

/** What is wrong with a call. */
export type UsageProblem = 'command' | 'option' | 'repeated' | 'value';

/** One text per kind of wrong call: what, why and what to do. */
export const usageProblemTexts: Readonly<Record<UsageProblem, string>> =
  Object.freeze({
    command:
      'Der Befehl ist unvollständig oder unbekannt. Diese Version von Ecclium kennt nur ‹ecclium stdio›, ‹ecclium config check›, ‹ecclium audit verify› und ‹ecclium audit show›. Prüfen Sie den Aufruf mit ‹ecclium --help›.',
    option:
      'Eine Option ist unbekannt oder gehört zu einem anderen Befehl. Ecclium nennt sie nicht, weil darin ein Token stehen könnte. Prüfen Sie den Aufruf mit ‹ecclium --help›.',
    repeated:
      'Eine Option steht mehr als einmal im Aufruf. Ausser ‹--log› gilt jede Option nur einmal, damit kein Aufruf zweideutig ist. Nennen Sie jede andere Option höchstens einmal.',
    value:
      'Eine Option hat einen Wert, den sie nicht annimmt, oder ihr fehlt einer. ‹--show-values› und ‹--help› nehmen keinen Wert an, ‹--log›, ‹--object›, ‹--since› und ‹--until› brauchen einen. Prüfen Sie den Aufruf mit ‹ecclium --help›.',
  });

/** The one text for an internal error. */
export const internalErrorText =
  'Der Befehl ist mit einem internen Fehler abgebrochen. Einzelheiten zeigt Ecclium nicht, weil sie Werte der Konfiguration enthalten könnten. Versuchen Sie es erneut und melden Sie den Fehler, wenn er bleibt.';
