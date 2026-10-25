# ADR 0051: Zustand zwischen Anfragen

- Status: Angenommen am 16.10.2026
- Datum: 10.10.2026
- Fällt vor: Phase 1

## Kontext

Der Mandantenkontext entsteht für jede Anfrage neu und wird nie auf Modulebene oder über seine Anfrage hinaus gehalten (ADR 0003). ADR 0018 nannte den Server zustandslos: Er hält keinen Zustand zwischen Anfragen, für jede Anfrage entsteht eine Server-Instanz. ADR 0053 löst es ab, mit einer Instanz pro Verbindung im Betrieb über stdio. Die Typen verhindern aber nicht, dass ein Modul Daten einer Anfrage aufbewahrt und in einer späteren wieder benutzt. Solcher Zustand ist unsichtbar: Er kann Daten einer Gemeinde in die Antwort für eine andere tragen, er wächst ohne Grenze, und im Review fällt er nur auf, wenn jemand gezielt danach sucht.

Ganz ohne Zustand über eine Anfrage hinaus kommt der Kern trotzdem nicht aus:

- Der ausgehende Weg hält Verbindungen zur ChurchTools-Instanz offen, damit nicht jede Anfrage eine neue TLS-Verbindung aufbaut.
- Die eigene Drosselung zählt Anfragen über mehrere Aufrufe hinweg, damit Ecclium das Rate-Limit der Gemeinde nicht aufbraucht (Threat Model, T20).
- Spätere Phasen brauchen offene Pläne für Schreibvorgänge bis zu ihrer Bestätigung, verbrauchte Nonces gegen das Wiederholen einer Bestätigung und Kontingente pro Akteur wie das Lesebudget.
- Ein Cache ist der häufigste Fall. ADR 0003 legt seinen Schlüssel fest, aber nicht, wann es einen geben darf.

## Optionen

1. **Keine Regel, nur Review:** einfach, aber Zustand auf Modulebene ist eine Zeile Code und im Review leicht übersehen.
2. **Gar kein Zustand über eine Anfrage hinaus:** am sichersten, aber ohne Drosselung und ohne Bestätigung von Schreibvorgängen nicht umsetzbar.
3. **Zustand nur an benannten Stellen,** alles andere durch eine Architekturregel ausgeschlossen. Nachteil: Die Regel erkennt Muster im Code, nicht jeden Zustand (siehe Restrisiken).

## Entscheid

Gewählt ist die dritte Option.

- **Kein Zustand auf Modulebene:** Code der Pakete hält keinen veränderlichen Zustand auf Modulebene. Die ESLint-Regel `[arch:module-state]` meldet:
  - `let` und `var`, die zum Modul gehören, nicht zu einer Funktion oder einem Block;
  - jedes `new` beim Laden eines Moduls, auch in statischen Feldern und statischen Blöcken einer Klasse, damit kein Singleton Zustand hält. Ausgenommen sind `TextEncoder`, `TextDecoder` und die Formatierer von `Intl`, deren Objekte keinen veränderlichen Zustand haben;
  - statische Felder ohne `readonly`.

  Felder einer Instanz und Deklarationen nur für den Type-Checker sind erlaubt. Tests (`*.test.ts`) sind ausgenommen. Braucht ein Modul trotzdem Zustand auf Modulebene, steht es einzeln im Ort `moduleState` in `tests/architecture/boundaries.json`, mit eigenem ADR.

- **Zustand über eine Anfrage hinaus** entsteht als Instanz in der Composition Root und wird übergeben, nie importiert. Es gibt ihn nur an zwei Arten von Stellen:
  - **in einem benannten Port** für Pläne bis zur Bestätigung, für Nonces gegen Wiederholung und für Kontingente pro Akteur. Jeder Port kommt mit seinem eigenen ADR, wenn er gebaut wird, und bindet jeden Eintrag an Mandant und Akteur (ADR 0003). Ein weiterer Port braucht ebenfalls ein eigenes ADR.
  - **in einer benannten Ausnahme.** Es gibt zwei: den Pool der Verbindungen des ausgehenden Wegs und den Zähler der eigenen Drosselung. Beide enthalten keine Inhalte aus ChurchTools und keine Zugangsdaten. Sie gelten je ChurchTools-Instanz, also je Mandant: Ein Mandant verbraucht nie die Drosselung eines anderen und teilt keine Verbindung mit ihm. Ein Neustart des Prozesses setzt sie zurück, und zwei Prozesse teilen nichts.
- **Cache:** Ein Cache über Anfragen hinweg ist ein solcher Zustand und braucht ein eigenes ADR. Sein Schlüssel besteht aus Mandant, Akteur und Route (ADR 0003). In Phase 1 gibt es keinen Cache über Anfragen hinweg.
- **Server-Instanz:** Eine Instanz des MCP-Servers hält keine Daten einer Anfrage über diese hinaus. Der Mandantenkontext entsteht für jeden Aufruf eines Tools neu. «Zustandslos» im Sinn von ADR 0053 heisst damit: kein Zustand mit Daten einer Anfrage. Pool und Zähler der Drosselung tragen keine solchen Daten.

## Konsequenzen

- Was eine Anfrage überdauert, steht an einer Stelle, der Composition Root, und ist im Review leicht zu finden.
- ADR 0053 löst ADR 0018 ab und übernimmt diese Abgrenzung: Eine Instanz des MCP-Servers hält keine Daten einer Anfrage über diese hinaus.
- Eine Nachschlagetabelle als `Map` auf Modulebene und ein Objekt einer Klasse als Singleton sind nicht mehr erlaubt. Stattdessen dient ein eingefrorenes Objekt, eine Funktion, die die Tabelle erzeugt, oder eine Instanz aus der Composition Root.
- Nach einem Neustart beginnt die Drosselung bei null. Kurz danach kann Ecclium mehr Anfragen senden, als seine eigene Grenze in diesem Zeitraum erlaubt. Die Grenze von ChurchTools gilt unabhängig davon.
- Ohne Cache kostet jede Anfrage den Aufruf bei ChurchTools. Das ist gewollt, bis ein Cache mit eigenem ADR gezeigt hat, dass er keine Daten zwischen Mandanten oder Akteuren vermischt.
- Restrisiken: Die Regel liest Code, nicht das Verhalten zur Laufzeit. Sie erkennt nicht:
  - ein Objekt oder Array in einer Konstante oder einem statischen Feld mit `readonly`, das später verändert wird (`const seen = []`);
  - eine Closure, die Zustand einfängt, und eine Funktion, die beim Laden aufgerufen wird und ein Objekt mit Zustand liefert, etwa `Reflect.construct` oder `Map.groupBy`;
  - Zustand in Abhängigkeiten und auf globalen Objekten.

  Das fangen der Test mit zwei Mandanten (ADR 0003) und das Review.

## Umsetzung

- Die Regel `ecclium-arch/no-module-state` steht in `tests/architecture/module-state-rule.mts` und wird über `tests/architecture/lint-rules.mts` für den Code der Pakete eingebunden, in einem eigenen Block, weil sie keine der geteilten ESLint-Regeln ist. Der Ort `moduleState` in `tests/architecture/boundaries.json` ist leer und nimmt nur einzelne Dateien. `tests/architecture/lint-rules.test.mts` belegt jede Form, die die Regel meldet, mit einem Beispiel und prüft Beispiele, die erlaubt bleiben.
- Der Pool der Verbindungen ist der Agent von undici, den jeder Transport für seine eine Origin baut, mit dem Cache der TLS-Sitzungen seines Connectors (ADR 0056). Die Composition Root baut ihn, ein Neustart verwirft ihn. Der Zähler der Drosselung steht seit dem 17.10.2026 in `packages/core/src/throttle/`, je ChurchTools-Client gebaut (ADR 0057). Dass jede Instanz ihren eigenen Zähler hat, zeigt seit dem 19.10.2026 der Test mit zwei Mandanten in `packages/core/src/mcp/two-tenants.test.ts` (ADR 0003).
- Der Start über stdio hält seinen Zustand, etwa ein empfangenes Signal, nur in der Closure seiner Startfunktion in `packages/cli/src/stdio/serve.ts`, nicht auf Modulebene. Der Transport, den er baut, lebt so lange wie der Prozess.
- Seit dem 24.10.2026 gibt es den ersten Port, den `QuotaStore` für das Lesebudget, als Datei im Zustandsordner (ADR 0063). Der Store bindet jeden Zähler an Mandant und Akteur, ein Neustart behält die Zähler, und zwei Prozesse mit demselben Zustandsordner teilen sie. Die Composition Root baut ihn in `packages/cli/src/stdio/serve.ts` und übergibt ihn der Pipeline.
