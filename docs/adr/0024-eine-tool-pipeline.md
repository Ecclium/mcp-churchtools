# ADR 0024: Eine Tool-Pipeline, Redaction und Audit ab Phase 1

- Status: Vorgeschlagen
- Datum: 29.09.2026
- Fällt vor: Phase 1

## Kontext

Die Tools von Ecclium lesen Daten aus ChurchTools, darunter Personendaten, die auf die Religionszugehörigkeit schliessen lassen. Zwischen dem Aufruf eines Tools und der Antwort an das Modell stehen mehrere Schutzmassnahmen: die Sperre für Schreib-Tools im Modus nur lesen, die Prüfung der Eingaben, das Verwerfen nicht deklarierter Felder, die Maskierung von Personendaten, die Kennzeichnung fremder Texte und das Protokoll. Jede davon wirkt nur, wenn wirklich jeder Aufruf sie in der richtigen Reihenfolge durchläuft. Tools kommen aus dem Kern, aus einem kostenpflichtigen Zusatzmodul und von Dritten.

Festzulegen ist, wie Tools beim MCP-SDK registriert werden, wer die Antwort ausliefert, wer den ChurchTools-Client benutzen darf und ab wann Maskierung und Protokoll gelten.

## Optionen

1. **Jedes Tool registriert sich selbst beim SDK** und ruft die Schutzmassnahmen als Hilfsfunktionen auf: flexibel, aber jede Stufe kann fehlen, und das fällt nur im Review auf.
2. **Eine Kette von Stufen, in die Erweiterungen eigene Stufen einfügen:** erweiterbar, aber Reihenfolge und Vollständigkeit hängen von jeder Erweiterung ab.
3. **Genau eine Pipeline mit festen Stufen im Kern** und genau eine Stelle, die beim SDK registriert.

## Entscheid

Gewählt ist die dritte Option.

- Jeder Aufruf durchläuft dieselben Stufen in fester Reihenfolge: `gate` (nur lesen, Toolsets, Lizenz, Regel für unbeaufsichtigte Läufe), `validateInput`, `execute`, `validateOutput` (nicht deklarierte Felder werden verworfen), `redact` (jede Maskierung sichtbar markiert), `markUntrusted` (Datenumschlag für fremden Text, Säuberung von Unicode), `serialize` (die einzige Stufe, die MCP-Typen kennt) und `audit` in einem `finally`, also auch im Fehlerfall. Erweiterungen fügen keine Stufe ein und entfernen keine.
- Ein Tool liefert nur Daten. Die Antwort liefert es nie selbst aus, deshalb kann es die Maskierung nicht umgehen.
- **Eine Stelle für das SDK:** Tools, Prompts und Ressourcen registriert nur `packages/core/src/mcp/mount.ts`. Dieser Ordner ist der einzige im Kern, der das MCP-SDK importiert, und dort liegt auch `serialize`. Der Kern gibt den Mount nur über den Unterpfad `./mcp` seines Pakets heraus, nicht über seinen Einstiegspunkt. Importieren darf ihn nur der Server.
- **Der rohe ChurchTools-Client** liegt in `packages/core/src/churchtools/`. Ihn importieren nur die Kernmodule, die `tests/architecture/boundaries.json` einzeln nennt. Der Einstiegspunkt des Kerns gibt ihn nicht weiter. Tools erreichen ChurchTools nur über die Pipeline.
- **Ab Phase 1** gelten ein Minimum der Maskierung (E-Mail-Adressen, Telefonnummern, Geburtsdaten) und das Audit als JSON Lines, im Betrieb über stdio nach stderr (ADR 0018). Voreingestellt sind nur lesen und die mittlere Stufe der Maskierung. Die vollständige Maskierung folgt in Phase 4.

## Konsequenzen

- Ein Tool zu schreiben wird einfacher, weil es nur Daten liefert. Was eine Stufe über ein Tool wissen muss, steht in seinen Metadaten, und die Registry lehnt ein Tool mit unvollständigen Metadaten ab.
- Erweiterungen ändern das Verhalten nur über die Schnittstellen des Kerns, nie über zusätzliche Stufen.
- Durchgesetzt wird die Grenze durch die Regeln `raw-client-only-in-core` und `mcp-mount-only-in-server` von dependency-cruiser, durch die ESLint-Sperre `[arch:mcp-sdk]` für Importe des SDK in jeder Form und durch einen Test der Exportfläche: Er folgt jedem Export des Einstiegspunkts von `core` mit dem TypeScript-Checker bis zu seiner Deklaration und lehnt alles ab, was aus dem rohen Client, aus dem Mount oder aus dem SDK stammt.
- Die Regel, dass nur `mount.ts` die Registrierfunktionen des SDK aufruft, entsteht in Phase 1 mit dem Einbau des SDK.
- Restrisiken: dependency-cruiser prüft den Zugriff auf den rohen Client über direkte Importe. Ein erlaubtes Modul könnte den Client als Wert an andere weiterreichen, und ein Modul, das ihn in eine eigene Konstante legt und diese exportiert, erkennt auch der Test der Exportfläche nicht. Die Liste der erlaubten Module bleibt deshalb kurz, und jeder neue Eintrag wird im Review begründet.

## Umsetzung

- Orte: `rawClient`, `rawClientImporters`, `mcpMount`, `mcpMountImporters` und `mcpSdk` in `tests/architecture/boundaries.json`, mit leeren Modulen in `packages/core/src/churchtools/` und `packages/core/src/mcp/mount.ts`. Der Unterpfad `./mcp` steht in `packages/core/package.json`.
- dependency-cruiser: `tests/architecture/dependency-rules.mts`, geprüft mit `pnpm check:arch`.
- ESLint: `tests/architecture/lint-rules.mts`.
- Tests: `tests/architecture/dependency-rules.test.mts`, `tests/architecture/export-surface.test.mts` und `tests/architecture/lint-rules.test.mts`.
- Pipeline, Registry, Maskierung und Audit folgen in Phase 1.
