/**
 * The fixed texts of the command line about its own use (ADR 0055). No
 * text repeats an argument: an option or a word on the command line can
 * hold a token.
 *
 * @packageDocumentation
 */

/** The short form of the call. */
export const usageLine =
  'Aufruf: ecclium stdio | ecclium config check [Optionen] | ecclium audit verify [Optionen] | ecclium audit show [Optionen] | ecclium policy init --interactive | ecclium policy init --routine <Routine> --credential <Alias> | ecclium init egress | ecclium doctor [--show-values] | ecclium undo <Kennung> [--overwrite] [--runner] | ecclium undo --run <Lauf> [--overwrite] | ecclium marker adopt --run <Lauf> [--confirm <Prüfwert>] | ecclium queue list [--runner] | ecclium queue show <Kennung> [--runner] | ecclium queue approve <Kennung> [--runner] | ecclium queue reject <Kennung> [--runner] | ecclium run-once --due | ecclium run-once <Routine> [--preview] | ecclium runner';

/** The help, for `--help` and `-h`. */
export const helpLines: readonly string[] = Object.freeze([
  usageLine,
  '  stdio                 startet den Server für einen KI-Assistenten über stdio',
  '  config check          prüft die Konfiguration aus der Umgebung, ohne ChurchTools anzufragen',
  '    --show-values       zeigt bei der Prüfung auch den Host, ein abweichendes Subjekt, den Zustands- und den Schlüsselordner',
  '    --runner            prüft die Konfiguration des Runners und seine Routinen, ohne ChurchTools und die Modelle anzufragen',
  '  audit verify          prüft die Audit-Dateien gegen ihre Ketten, braucht nur ‹ECCLIUM_STATE_DIR›',
  '    --log <Datei>       prüft auch gegen die Anker aus diesem Log, ‹-› liest stdin, mehrmals möglich',
  '  audit show            zählt die Aufrufe in den Audit-Dateien je Tag und Tool',
  '    --object <Kennung>  zeigt stattdessen die Aufrufe, die eine Kennung wie ‹person:42› nennen',
  '    --run <Lauf>        zeigt stattdessen einen Lauf einer Routine: Ausgang, Lesungen und Schreibvorgänge',
  '    --since <Tag>       ab diesem Tag in UTC, in der Form JJJJ-MM-TT',
  '    --until <Tag>       bis und mit diesem Tag in UTC',
  '  policy init           schlägt einen Teil der Richtlinie als YAML auf stdout vor und fragt ChurchTools nach den Namen',
  '    --interactive       den interaktiven Teil aus den Audit-Dateien',
  '    --routine <Routine> den Eintrag einer Routine für ihre Seite im Wiki, zum Einfügen unter ‹unattended›',
  '    --credential <Alias> mit ‹--routine›: das Konto, das später schreibt und jetzt die Namen liest, mit der Konfiguration des Runners',
  '  init egress           schreibt die Liste der Ziele für die Vorlage für Squid auf stdout, aus der Konfiguration des Runners',
  '  doctor                prüft den Runner: den Weg nach aussen über den Proxy, die Anbieter, die Richtlinie, die Routinen und die Rechte seiner Konten',
  '    --show-values       nennt bei ‹doctor› auch Name und Port jedes Ziels und den Host jedes Anbieters',
  '  undo <Kennung>        nimmt einen Schreibvorgang aus seinem Snapshot zurück, die Kennung steht im Audit',
  '    --overwrite         schreibt auch, wenn jemand die Seite seither geändert hat',
  '    --runner            nimmt den Schreibvorgang eines Laufs zurück, mit der Konfiguration des Runners',
  '  undo --run <Lauf>     nimmt jeden Schreibvorgang eines Laufs zurück, auch aus Freigaben, den neuesten zuerst, mit der Konfiguration des Runners',
  '  marker adopt --run <Lauf> zeigt den Abschnitt der Periode eines Laufs, den ein Snapshot belegt, zum neuen Signieren nach einem verlorenen Schlüssel, mit der Konfiguration des Runners',
  '    --confirm <Prüfwert> signiert ihn mit dem Prüfwert der Vorschau neu, wenn die Seite noch so steht',
  '  queue list            zeigt, was in der Freigabe-Warteschlange auf Ihre Freigabe wartet',
  '  queue show <Kennung>  zeigt den ganzen Unterschied eines Eintrags',
  '  queue approve <Kennung> gibt einen Eintrag frei und schreibt ihn sofort, auf dem Stand des Ziels von jetzt',
  '  queue reject <Kennung> weist einen Eintrag ab und vernichtet seinen Inhalt',
  '    --runner            mit ‹queue›: die Warteschlange des Runners, mit seiner Konfiguration; ‹approve› dann nur für einen Eintrag aus einem Lauf',
  '  run-once --due        führt jede Routine aus, die fällig ist, eine nach der anderen, und endet dann',
  '  run-once <Routine>    führt eine Routine von Hand aus, mit der Periode ihrer letzten Auslösung',
  '    --preview           zeigt den Abschnitt nur auf stdout und schreibt nichts, auch ohne Eintrag in der Richtlinie',
  '  runner                führt als Daemon jede Routine zu ihrer Zeit aus, bis ein Signal ihn anhält',
  '  -h, --help            zeigt diese Hilfe',
]);

/** What is wrong with a call. */
export type UsageProblem = 'command' | 'option' | 'repeated' | 'value';

/** One text per kind of wrong call: what, why and what to do. */
export const usageProblemTexts: Readonly<Record<UsageProblem, string>> =
  Object.freeze({
    command:
      'Der Befehl ist unvollständig oder unbekannt. Diese Version von Ecclium kennt nur ‹ecclium stdio›, ‹ecclium config check›, ‹ecclium audit verify›, ‹ecclium audit show›, ‹ecclium policy init›, ‹ecclium init egress›, ‹ecclium doctor›, ‹ecclium undo›, ‹ecclium marker adopt› mit ‹--run›, ‹ecclium queue›, ‹ecclium run-once›, diesen mit ‹--due› oder einer Routine, und ‹ecclium runner›. Prüfen Sie den Aufruf mit ‹ecclium --help›.',
    option:
      'Eine Option ist unbekannt oder gehört zu einem anderen Befehl. Ecclium nennt sie nicht, weil darin ein Token stehen könnte. Prüfen Sie den Aufruf mit ‹ecclium --help›.',
    repeated:
      'Eine Option steht mehr als einmal im Aufruf. Ausser ‹--log› gilt jede Option nur einmal, damit kein Aufruf zweideutig ist. Nennen Sie jede andere Option höchstens einmal.',
    value:
      'Eine Option hat einen Wert, den sie nicht annimmt, oder ihr fehlt einer. ‹--show-values›, ‹--runner›, ‹--interactive›, ‹--overwrite›, ‹--due›, ‹--preview› und ‹--help› nehmen keinen Wert an, ‹--log›, ‹--object›, ‹--run›, ‹--since›, ‹--until›, ‹--routine›, ‹--credential› und ‹--confirm› brauchen einen. Prüfen Sie den Aufruf mit ‹ecclium --help›.',
  });

/** The one text for an internal error. */
export const internalErrorText =
  'Der Befehl ist mit einem internen Fehler abgebrochen. Einzelheiten zeigt Ecclium nicht, weil sie Werte der Konfiguration enthalten könnten. Versuchen Sie es erneut und melden Sie den Fehler, wenn er bleibt.';
