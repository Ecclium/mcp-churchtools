# ADR 0024: Eine Tool-Pipeline, Redaction und Audit ab Phase 1

- Status: Angenommen am 02.10.2026
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
- Durchgesetzt wird die Grenze durch die Regeln `raw-client-only-in-core` und `mcp-mount-only-in-server` von dependency-cruiser und durch die ESLint-Sperre `[arch:mcp-sdk]`. Sie erfasst statische Importe und Wiederexporte, Importe nur für Typen, `import()` und `typeof import()`. Das Laden an den Importen vorbei, über `node:module`, `require` oder `process.getBuiltinModule`, verbietet ESLint im Code der Pakete ganz (ADR 0018). Dazu kommt ein Test der Exportfläche: Er folgt jedem Export jedes Einstiegspunkts mit dem TypeScript-Checker bis zu seiner Deklaration und lehnt alles ab, was aus dem rohen Client, aus dem Mount oder aus dem SDK stammt. Ausgenommen ist nur der Unterpfad `./mcp` selbst.
- Die Regel, dass nur `mount.ts` die Registrierfunktionen des SDK aufruft, entsteht in Phase 1 mit dem Einbau des SDK.
- Die Listen der Ausnahmen bleiben eng: Unter den Importeuren des rohen Clients steht jedes Modul einzeln, nie ein Ordner oder der Einstiegspunkt des Kerns, und der Mount hat keinen Importeur im eigenen Paket. Das prüft das Laden von `boundaries.json`.
- Restrisiken: dependency-cruiser prüft den Zugriff auf den rohen Client über direkte Importe. Ein erlaubtes Modul könnte den Client als Wert an andere weiterreichen, und ein Modul, das ihn in eine eigene Konstante legt und diese exportiert, erkennt auch der Test der Exportfläche nicht. Die Liste der erlaubten Module bleibt deshalb kurz, und jeder neue Eintrag wird im Review begründet.

## Umsetzung

- Orte: `rawClient`, `rawClientImporters`, `mcpMount`, `mcpMountImporters` und `mcpSdk` in `tests/architecture/boundaries.json`, mit leeren Modulen in `packages/core/src/churchtools/` und `packages/core/src/mcp/mount.ts`. Der Unterpfad `./mcp` steht in `packages/core/package.json`.
- dependency-cruiser: `tests/architecture/dependency-rules.mts`, geprüft mit `pnpm check:arch`.
- ESLint: `tests/architecture/lint-rules.mts`.
- Tests: `tests/architecture/dependency-rules.test.mts`, `tests/architecture/export-surface.test.mts` und `tests/architecture/lint-rules.test.mts`.
- Registrierung beim SDK: der Ort `mcpRegistration` mit `packages/core/src/mcp/mount.ts` und, im Paket für Tests, dem Server des Spikes zu Elicitation `packages/testkit/src/mcp-spike/server.ts` (ADR 0053), dazu die ESLint-Sperre `[arch:mcp-register]`. Sie meldet jeden Zugriff auf `registerTool`, `registerPrompt`, `registerResource`, `setRequestHandler`, `setNotificationHandler`, `fallbackRequestHandler`, `fallbackNotificationHandler`, `removeRequestHandler`, `removeNotificationHandler`, `registerCapabilities` und `readCallback`, auch mit einer Zeichenkette oder einem Template-Literal als Schlüssel und beim Zerlegen eines Objekts, damit auch eine weitergereichte Methode auffällt. Einen Schlüssel aus einer Variablen oder einer Verkettung erkennt sie nicht. Weil sie die Methoden an ihrem Namen erkennt, nicht an ihrem Typ, benutzt die Plugin-Schnittstelle diese Namen nicht für eigene Methoden. Am 11.10.2026 ist die Liste gegen Version 2.3.1 des SDK geprüft und um die letzten vier Namen ergänzt (ADR 0053). Die Objekte, die `registerTool`, `registerPrompt` und `registerResource` zurückgeben, können einen Handler ebenfalls austauschen oder abschalten: mit `update({ callback })`, `remove()`, `disable()` und `enabled` und über ihre Felder `handler` und `executor`, die das SDK bei jeder Anfrage liest. Diese Namen sind für die Sperre zu allgemein. Der Mount behält diese Objekte deshalb für sich, und das prüft das Review. Ausser im Mount darf ein Eintrag nur im Paket für Tests stehen, als einzelne Datei. Die Regel aus den Konsequenzen besteht damit schon vor dem Einbau des SDK.
- Der Vertrag der Tools steht seit dem 13.10.2026 in `plugin-api`, in `packages/plugin-api/src/tool.ts`, `read-api.ts` und `plugin.ts`:
  - Ein Tool hat einen Namen, der mit `ct_` beginnt, bei Tools eines Bereichs nach dem Schema `ct_<bereich>_<aktion>`. Dazu kommen Metadaten, eine Beschreibung in Pflichtabschnitten, je ein Schema von zod für Ein- und Ausgabe und `execute({ ctx, input, read })`, das nur Daten liefert.
  - `defineTool()` leitet die Typen von `execute` nur aus den beiden Schemas ab. `execute` kann so weder mehr Eingabe erwarten, als das Schema der Eingabe liefert, noch weniger zurückgeben, als das Schema der Ausgabe verlangt. Es gibt zurück, was die Pipeline mit dem Schema der Ausgabe prüft, also den Wert vor einer Umwandlung. Beide Schemas beschreiben Objekte, wie es MCP für die Eingabe und ein strukturiertes Ergebnis verlangt.
  - Die Typen verbieten schon, was die Registry zur Laufzeit ablehnen wird: ein Tool mit der Sensibilität `special`, das unbeaufsichtigt laufen dürfte, ein Schreib-Tool ohne Schutz gegen Wiederholung oder ohne Angabe, ob es sich zurücknehmen lässt, und ein Schutz gegen Wiederholung an einem lesenden Tool.
  - Freitext erkennt die Pipeline an der Datenklasse `untrusted` des Felds im Register von zod (ADR 0022), nicht an einer eigenen Angabe in den Metadaten des Tools.
  - Die `ReadApi` beginnt mit `whoami` und `permissions` und wächst mit den Tools. Bis zur Version 1.0 der Plugin-Schnittstelle darf sich ihre Form ändern.
  - Ein Plugin meldet seine Tools synchron über `PluginHost.addTool` an. `register` gibt `undefined` zurück, eine asynchrone Funktion passt deshalb nicht. Keine Methode der Schnittstelle trägt den Namen einer Registrierfunktion des SDK.
  - Das Audit-Ereignis `AuditEventV1` und die Fehlercodes stehen ebenfalls in `plugin-api`, in `audit.ts` und `errors.ts`.
- Pipeline, Registry, Maskierung, die Stufe des Audits und der Widerruf der `ReadApi` nach dem Aufruf folgen in Phase 1 im Kern.
