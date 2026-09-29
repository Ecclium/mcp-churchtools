# ADR 0018: MCP-Protokoll 2026-07-28 und SDK v2, zustandsloser Server

- Status: Vorgeschlagen
- Datum: 29.09.2026
- Fällt vor: Phase 1

## Kontext

Ecclium ist ein MCP-Server. Festzulegen ist, welche Version des Model Context Protocol er spricht, mit welcher Bibliothek, ob er zwischen zwei Anfragen Zustand hält und wem im Betrieb über stdio die Standardausgabe gehört.

Die MCP-Spezifikation in der Version 2026-07-28 kennt keinen Aufruf `initialize` und keine Kopfzeile `Mcp-Session-Id` mehr. Ein Server kann jede Anfrage für sich beantworten. Rückfragen an die Nutzerin oder den Nutzer laufen über Multi Round-Trip Requests (`input_required`), Sampling gilt als veraltet. Für den Betrieb über stdio verlangt die Spezifikation, dass der Server auf stdout nur MCP-Nachrichten schreibt (Abschnitt «Transports»). Jede andere Ausgabe dort bricht die Verbindung.

Zur Bibliothek, laut den Metadaten der Pakete in der npm-Registry, abgerufen am 29.09.2026:

- Das TypeScript-SDK erscheint in Version 2 als eigene Pakete, unter anderem `@modelcontextprotocol/server` und der Adapter `@modelcontextprotocol/hono` für HTTP. Die Beschreibung des Serverpakets nennt Version 2 die stabile Linie, die die Spezifikation 2026-07-28 umsetzt und das bisherige Paket `@modelcontextprotocol/sdk` ablöst. Dieses erhält weiterhin Releases.
- `@modelcontextprotocol/server` 2.0.0 erschien am 27.07.2026, 2.1.0 am 23.09.2026 und 2.2.0 am 28.09.2026. Jede Version hängt von einem Kernpaket `@modelcontextprotocol/core` in genau derselben Version ab.
- Der Adapter 2.0.0 verlangt `@modelcontextprotocol/server` ab 2.0.0, der Adapter 2.0.1 ab 2.1.0. Server und Adapter erschienen zusammen.
- Alle Versionen tragen einen Herkunftsnachweis und stehen unter MIT.

## Optionen

1. **SDK Version 1 mit der Protokollversion 2025-11-25:** verbreitet und erprobt, aber mit Sitzungen, und der Wechsel auf die aktuelle Protokollversion stünde später ohnehin an.
2. **Eigene Umsetzung des Protokolls:** volle Kontrolle, aber viel Code für ein fremdes Protokoll, das sich weiterentwickelt, und eigene Fehler genau dort, wo Prüfungen von Grösse, Host und Origin stattfinden.
3. **SDK Version 2 mit der Protokollversion 2026-07-28, ohne Zustand im Server.**

## Entscheid

Gewählt ist die dritte Option.

- Ecclium spricht MCP in der Version 2026-07-28 über `@modelcontextprotocol/server`, im Betrieb über HTTP zusammen mit `@modelcontextprotocol/hono`.
- Der Server hält keinen Zustand zwischen Anfragen. Für jede Anfrage entsteht eine Server-Instanz, Antworten gehen im JSON-Modus ohne SSE. Clients mit der Protokollversion 2025-11-25 werden ebenfalls ohne Sitzung bedient. Rückfragen laufen über Multi Round-Trip Requests, Sampling wird nicht benutzt. Alles Zeitgesteuerte läuft im Runner als eigener Prozess.
- **Versionen:** Server- und Adapterpaket werden nur gemeinsam aktualisiert. Die Version des Adapters bestimmt die Mindestversion des Servers, und das Serverpaket bringt sein Kernpaket in genau passender Version mit. Welches Paar gepinnt wird, entscheidet sich beim Einbau in Phase 1: das jüngste, das das Mindestalter für neue Versionen erfüllt (ADR 0021). Ein Pin, der schon jetzt gesetzt würde, wäre bis dahin veraltet.
- **stdout im Betrieb über stdio** gehört dem Protokoll, und nur der stdio-Transport des SDK schreibt dorthin. Die Orte im Code stehen in `tests/architecture/boundaries.json`:
  - Der Betrieb über stdio beginnt in `packages/server/src/stdio/` und in der Kommandozeile in `packages/cli/src/stdio/`. Nichts, was von dort aus erreichbar ist, darf auf stdout schreiben.
  - Auf stdout schreiben nur die Meldungen der Kommandozeile für Betreiber in `packages/cli/src/output/`.
  - Auf stderr schreiben nur der Logger in `packages/core/src/logger/` und dieselben Meldungen der Kommandozeile.
  - `console` benutzt der Code der Pakete nirgends. `process` wird nur über einzelne Eigenschaften wie `process.env` benutzt, nicht als Wert weitergegeben.
- Das Audit schreibt im Betrieb über stdio über den Logger nach stderr. Im Betrieb über HTTP und im Runner gibt die Kommandozeile als Composition Root dem Audit einen Ausgabestrom mit. Kein Modul im Kern schreibt selbst nach stdout.

## Konsequenzen

- Ecclium hängt an einem jungen SDK. Version 2 ist seit Ende Juli stabil, und Server wie Adapter erscheinen in kurzen Abständen neu. Weil beide nur gemeinsam aktualisiert werden, passt ein Update nie nur zur Hälfte.
- Was über eine Anfrage hinaus gelten muss, etwa eine offene Bestätigung, liegt nicht im Server, sondern im Kern mit eigener Frist und eigenem Schutz.
- Die Regel für stdout ist doppelt abgesichert. dependency-cruiser verbietet, dass vom Start des Betriebs über stdio ein Modul erreichbar ist, das auf stdout schreiben darf (`no-stdout-in-stdio-paths`). ESLint verbietet im Code der Pakete jede andere Ausgabe über `console`, `process.stdout`, `process.stderr`, die Dateideskriptoren 1 und 2 und `node:tty`.
- Restrisiken: Die Regeln sehen Code, nicht das Verhalten zur Laufzeit. Schreiben über einen berechneten Dateideskriptor, über einen Strom, den ein anderes Modul übergibt, oder im Code einer Abhängigkeit erkennen sie nicht. Ab Phase 1 prüft deshalb ein Test im Betrieb über stdio, dass auf stdout nur Protokollnachrichten erscheinen.
- Offen: Wie das SDK in Version 2 den Betrieb ohne Sitzung einstellt, belegen die Metadaten der Pakete nicht. Das wird zu Beginn von Phase 1 an den Typdefinitionen und der Dokumentation des SDK geprüft.

## Umsetzung

- Orte: `stdioEntries`, `stdout` und `stderr` in `tests/architecture/boundaries.json`, mit leeren Modulen an jedem Ort.
- dependency-cruiser: Regel `no-stdout-in-stdio-paths` in `tests/architecture/dependency-rules.mts`, geprüft mit `pnpm check:arch`.
- ESLint: `tests/architecture/lint-rules.mts`, geladen von `eslint.config.mjs`.
- Tests: `tests/architecture/dependency-rules.test.mts` und `tests/architecture/lint-rules.test.mts`, je Regel mit einem Beispiel, das sie verletzt.
- Das SDK selbst, die Server-Instanz pro Anfrage und der Test im Betrieb über stdio folgen in Phase 1.
