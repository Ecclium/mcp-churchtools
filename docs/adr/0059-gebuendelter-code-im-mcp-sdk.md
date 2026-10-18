# ADR 0059: Gebündelter Code des MCP-SDK in `core` und `server`

- Status: Vorgeschlagen
- Datum: 18.10.2026
- Fällt vor: Phase 1

## Kontext

Der Mount in `core` und der Server über stdio in `server` brauchen das Serverpaket des MCP-SDK. ADR 0053 lässt es dort nur zu, wenn sein gebündelter Code keine bekannte Schwachstelle hat oder ein eigenes ADR zeigt, warum der verwundbare Code dort nicht erreichbar ist (ADR 0053, «Gebündelter Code»). Dieses ADR ist dieser Nachweis, für eine einzige Version.

- **Version:** `@modelcontextprotocol/server` 2.3.1 ist am 18.10.2026 die neueste Version, laut dem Tag `latest` in der Registry von npm. Es bündelt `fast-uri` 3.1.0 (ADR 0053, Umsetzung). Laut OSV, abgerufen am 18.10.2026, gelten dafür dieselben neun Schwachstellen wie in ADR 0053, acht «hoch» und eine «mittel», behoben in den Versionen 3.1.1 bis 3.1.8. Sie betreffen das Zerlegen, Auflösen und Normalisieren von URIs. Eine Version des SDK, die eine behobene Version bündelt, gibt es nicht. Das Kernpaket `@modelcontextprotocol/core` 2.3.1 bündelt keinen Code (`packages/testkit/src/mcp-spike/bundled-code.test.ts`).
- **Gefahr:** Schaden kann eine dieser Schwachstellen nur anrichten, wenn `fast-uri` einen Wert verarbeitet, den ein Angreifer bestimmt. Für den Server ist das vor allem ein Wert, den ein MCP-Client sendet.

Geprüft am 18.10.2026 an den Dateien unter `dist/` des installierten Pakets. Die Namen der Dateien tragen einen Hash des Builds und gelten nur für diese Version:

1. **Laden:** Der Haupteinstieg und der Einstieg für stdio laden `./_shims`: `index.mjs:3` und das von ihm geladene `mcp-DIH4cS6P.mjs:2` für den Validator, `stdio.mjs:3` für `process`. Unter Node.js ist das `shimsNode.mjs`, das den Validator auf Basis von Ajv als `DefaultJsonSchemaValidator` herausgibt (`shimsNode.mjs:1-4`). Damit wertet jeder Prozess, der das SDK lädt, den Code von Ajv und `fast-uri` aus (`ajvProvider-CEoC__sr.mjs:7383`, `:3508`, `:3445`). Beim Laden gibt es noch keinen Wert eines Clients.
2. **Aufrufer von `fast-uri`:** Nur Ajv ruft `fast-uri` auf, über die Option `uriResolver` einer Engine, die das gebündelte `fast-uri` voreinstellt (`ajvProvider-CEoC__sr.mjs:3560`). Ajv löst damit `$id` und `$ref` auf, wenn es ein Schema aufnimmt oder übersetzt (`:2014-2019`, `:2627-2629`, `:2663-2666`). Eine neue Engine nimmt im Konstruktor ihre eigenen Metaschemas auf (`:3590-3622`).
3. **Engine:** `AjvJsonSchemaValidator` legt im Konstruktor keine Engine an (`ajvProvider-CEoC__sr.mjs:7455-7458`). Das geschieht erst beim ersten Aufruf von `getValidator` über `ajv` oder `_engineFor` (`:7460-7462`, `:7469-7475`), der das Schema dann übersetzt (`:7476-7478`).
4. **Aufrufer von `getValidator`:** Im Code, den Node.js lädt, gibt es genau zwei. Die zweite Umsetzung des Validators, `cfWorkerProvider-p3WaZPqB.mjs:962`, lädt nur `./validators/cf-worker` oder `./_shims` unter den Bedingungen `workerd` und `browser`.
   - `fromJsonSchema` übersetzt ein JSON-Schema schon beim Verpacken (`src-Cqbh3MYc.mjs:7684-7685`). Der Export im Einstieg nimmt ohne zweites Argument einen eigenen Validator auf Modulebene, `new DefaultJsonSchemaValidator()`, nie den einer Instanz (`index.mjs:1783-1786`).
   - `_sendElicitationLeg` prüft den angenommenen Inhalt einer Rückfrage mit dem Validator der Instanz (`mcp-DIH4cS6P.mjs:1507-1509`, `:1527-1528`). Den setzt der Konstruktor von `Server` aus der Option `jsonSchemaValidator`, fehlt sie, als `new DefaultJsonSchemaValidator()` (`:1044`), und `McpServer` reicht seine Optionen an `Server` weiter (`:1693`). Die Option beschreiben `createMcpHandler-D4NN8WsG.d.mts:2846` und `types-DUs7mGBv.d.mts:1088-1097`.
   - Den Inhalt prüfen lässt nur `elicitInput` (`mcp-DIH4cS6P.mjs:1487-1497`), auch über `ctx.mcpReq.elicitInput` (`:1100`). Der Shim für ältere Clients ruft `_sendElicitationLeg` mit `validateAcceptedContent: false` auf und fragt den Validator nie (`:1027`). `elicitInput` ist veraltet (`createMcpHandler-D4NN8WsG.d.mts:3164`) und wirft bei einer Anfrage der Ära 2026 (`mcp-DIH4cS6P.mjs:1488`). In der Ära 2025 verlangt es für ein Formular die Capability `elicitation.form` (`:1493-1494`) und fragt den Validator nur bei `accept` mit Inhalt (`:1527`). Dann übersetzt eine Engine das `requestedSchema` des Servers und prüft den Inhalt des Clients.
5. **Eigene Benutzung:** Wer `./validators/ajv` oder `./_shims` importiert, erhält Ajv selbst (`validators/ajv.mjs:1-3`, `shimsNode.mjs:4`).

Schluss: Ein Wert eines Clients erreicht `fast-uri` in 2.3.1 nur, wenn Code `fromJsonSchema` oder `elicitInput` aufruft oder Ajv aus `./validators/ajv` oder `./_shims` selbst benutzt. Ohne diese Wege entsteht im Prozess keine Engine von Ajv, und keine Funktion von `fast-uri` läuft.

## Optionen

1. **Warten,** bis eine Version des SDK `fast-uri` ab 3.1.8 bündelt. Wann das kommt, ist nicht bekannt. Bis dahin gibt es weder den Mount noch den Server über stdio.
2. **Den gebündelten Code ersetzen.** Ein Override in pnpm erreicht ihn nicht, weil er nicht im Lockfile steht (ADR 0053). Ein Patch an den Dateien des SDK änderte fremden Code, den kein Herkunftsnachweis mehr deckt, und wäre bei jeder neuen Version neu zu bauen.
3. **Die Wege sperren,** auf denen ein Wert eines Clients `fast-uri` erreicht, mit Wachen im Code und in den Prüfungen, nur für die geprüfte Version.

## Entscheid

Gewählt ist die dritte Option. Das Serverpaket des MCP-SDK darf in `core` und `server` stehen, solange es genau die Version ist, die der Abschnitt «Umsetzung» als geprüft nennt. Vier Wachen halten die Wege aus dem Kontext geschlossen:

1. **Werfender Validator:** Jede Instanz, die der Mount baut, erhält über die Option `jsonSchemaValidator` einen Validator, dessen `getValidator` immer wirft. Er deckt nur den Validator der Instanz, also `elicitInput`. Der Konstruktor legt dann auch keinen Validator auf Basis von Ajv an (`mcp-DIH4cS6P.mjs:1044`). Ruft doch Code `elicitInput` auf, endet die Rückfrage mit dem JSON-RPC-Fehler -32603, bevor Ajv etwas übersetzt (`:1530-1532`).
2. **Regel `[arch:mcp-json-schema]`:** ESLint verbietet im Code der Pakete die Namen `fromJsonSchema`, `elicitInput`, `DefaultJsonSchemaValidator` und `AjvJsonSchemaValidator` und jeden Import aus `@modelcontextprotocol/server/validators/*` und `@modelcontextprotocol/server/_shims`. Tests (`*.test.ts`) sind ausgenommen, damit ein Test Ergebnisse mit Ajv gegen das gemeldete Schema prüfen und `elicitInput` für eine Gegenprobe aufrufen kann. Nur diese Regel hält `fromJsonSchema` auf, denn es fragt den Validator der Instanz nie.
3. **Test der Erreichbarkeit:** Ein Test führt Mount und SDK über einen ganzen Rundlauf beider Ären, mit `tools/list` und feindlichen Eingaben an `tools/call`. Er zählt jeden Aufruf von `fast-uri` an dem Objekt, das Ajv als `uriResolver` voreinstellt (`ajvProvider-CEoC__sr.mjs:3560`), und erwartet 0.
4. **Pin-Test:** Der Test des gebündelten Codes liest die geprüfte Version aus diesem ADR und verlangt, dass jedes Paket mit dem SDK genau sie pinnt. Eine neue Version des SDK lässt ihn scheitern.

Jede neue Version des SDK braucht eine neue Prüfung: den gebündelten Code nach ADR 0053 und die Wege aus dem Kontext dieses ADR, mit neuen Fundstellen. Erst dann führt eine Person die geprüfte Version hier nach, oder ein neues ADR löst dieses ab.

## Konsequenzen

- Der verwundbare Code bleibt im Prozess. Er wird mit dem SDK geladen und nur nicht aufgerufen. Eine Schwachstelle, die schon beim Laden wirkte, deckten die Wachen nicht. Die bekannten betreffen alle das Verarbeiten einer URI.
- Die Regel erkennt Namen im Code, nicht was zur Laufzeit geschieht. Einen Namen, der aus einer Variable oder durch Verketten entsteht, sieht sie nicht, das prüft das Review, wie bei `[arch:mcp-register]`. Eigener Code der Pakete und die Plugin-Schnittstelle dürfen die vier Namen nicht für sich verwenden.
- Im Betrieb prüft niemand ein Ergebnis mit Ajv gegen das gemeldete JSON-Schema der Ausgabe. Ob ein Ergebnis dazu passt, prüft ein Test mit Ajv aus `./validators/ajv`. Die Regel erlaubt diesen Import nur in Tests.
- Eine Rückfrage über `elicitInput` ist ausgeschlossen. Angenommenen Inhalt einer Rückfrage prüft eigener Code ohne Ajv aus dem SDK, wie ADR 0053 es für beide Ären verlangt. Braucht eine spätere Phase eine Prüfung gegen ein JSON-Schema, kommt sie ohne den gebündelten Code oder mit einem neuen ADR.
- Der Betrieb über HTTP in Phase 7 baut seine Instanzen mit derselben Fabrik und erhält dieselben Wachen.
- Der Pin-Test liest die Version aus dem Satz «Geprüft ist `@modelcontextprotocol/server` …» im Abschnitt «Umsetzung». Wer den Satz umformuliert, passt den Test an.
- Bündelt eine spätere Version `fast-uri` ab 3.1.8 und hat ihr gebündelter Code keine bekannte Schwachstelle, braucht es dieses ADR für sie nicht mehr. Die Wachen dürfen bleiben.

## Umsetzung

- Geprüft ist `@modelcontextprotocol/server` 2.3.1, am 18.10.2026, an den Dateien des installierten Pakets. Die Fundstellen im Kontext gelten nur für diese Version.
- Stand 18.10.2026 ist keine der vier Wachen gebaut. Sie kommen mit dem Mount:
  - der werfende Validator im Mount in `packages/core/src/mcp/`;
  - die Regel `[arch:mcp-json-schema]` in `tests/architecture/lint-rules.mts`;
  - der Test der Erreichbarkeit mit dem Mount, der Verweis auf ihn folgt hier;
  - der Pin-Test in `packages/testkit/src/mcp-spike/bundled-code.test.ts`, mit der Abhängigkeit in `core` und `server`.
