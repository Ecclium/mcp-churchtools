# MCP-SDK und Elicitation: Befunde

Stand: 11.10.2026, Prüfung von `@modelcontextprotocol/server` 2.3.1

Dieses Dokument hält fest, was Ecclium über das MCP-SDK in Version 2 und über Rückfragen an Nutzerinnen und Nutzer (Elicitation) wissen muss, und worauf sich jede Aussage stützt. Der Entscheid, der darauf aufbaut, steht in [ADR 0053](../adr/0053-mcp-sdk-und-instanzmodell.md). Der erste Teil ist die Prüfung des SDK. Der zweite Teil, der Spike zu Elicitation mit echten Clients, folgt mit seinen Läufen.

## Methode

- Die Pakete kommen aus der npm-Registry. Ihre Prüfsummen sind gegen `dist.integrity` der Registry und gegen den Herkunftsnachweis verglichen.
- Gelesen sind die Typdefinitionen und der Code im Paket und der Quelltext des SDK, den das Paket in seinen Source Maps mitbringt, dazu Dokumentation und Tests im Repository des SDK beim Tag der geprüften Version.
- Aussagen zum Verhalten zur Laufzeit stammen aus dem Quelltext. Der Spike in `packages/testkit/src/mcp-spike/` prüft die wichtigsten davon in Tests ohne Netz.
- Fundstellen im Paket nennen die Datei unter `dist/`. Die Namen dieser Dateien tragen einen Hash des Builds und gelten nur für Version 2.3.1.

## Quellen

- npm-Registry, Metadaten und Herkunftsnachweise von `@modelcontextprotocol/server`, `@modelcontextprotocol/core`, `@modelcontextprotocol/client` und `zod`, abgerufen am 11.10.2026.
- Das Paket `@modelcontextprotocol/server` 2.3.1: `package.json`, `LICENSE`, `README.md` und `dist/`.
- Das Repository des TypeScript-SDK beim Tag v2.3.1, Commit `fcef852f6cdafea07f36cf6fae69b37c8adf85be`: `docs/serving/stdio.md`, `docs/serving/legacy-clients.md`, `docs/migration/support-2026-07-28.md`, `docs/testing.md`, `docs/servers/sampling.md` und `packages/server/test/server/serveStdio.test.ts`.
- Die MCP-Spezifikation 2026-07-28, Seiten `changelog`, `basic/index`, `basic/patterns/mrtr`, `basic/versioning`, `basic/transports/stdio`, `client/elicitation`, `client/sampling` und `deprecated`, dazu für ältere Clients `2025-11-25/client/elicitation`, abgerufen am 11.10.2026.
- Die Datenbank von OSV für bekannte Schwachstellen in npm-Paketen, abgerufen am 11.10.2026.

## Version und Herkunft

- **Version 2.3.1** ist am 11.10.2026 die neueste Version von `@modelcontextprotocol/server` und das einzige Dist-Tag (`latest`), erschienen am 05.10.2026 um 11:52 UTC. Sie erfüllt das Mindestalter von drei Tagen. Version 2.3.0 erschien am 02.10.2026.
- **Abhängigkeiten:** `@modelcontextprotocol/core` in genau 2.3.1, erschienen am 05.10.2026, und `zod` im Bereich `^4.2.0`. pnpm löst zod auf 4.6.5 vom 13.09.2026 auf. Keines der drei Pakete hat Peer-, optionale oder gebündelte Abhängigkeiten im Sinn von `bundleDependencies` und keines ein Install-Skript. Das Serverpaket verlangt Node.js ab Version 20.
- **Herkunft:** Alle drei Pakete sind mit einem Herkunftsnachweis nach SLSA v1 und über einen vertrauenswürdigen Herausgeber erschienen. Server und Kernpaket kommen aus dem Repository `modelcontextprotocol/typescript-sdk`, Workflow `.github/workflows/release.yml`, Commit `fcef852f`. Jede stabile Version des Servers von 2.0.0 bis 2.3.1 hat beide Nachweise, zod ab 4.4.0.
- **Prüfungen des Repositorys:** Mindestalter, Vertrauensrichtlinie von pnpm, transitive Abhängigkeiten nur aus der Registry, keine Install-Skripte und die Prüfung neuer Einträge im Lockfile auf Herkunft und Prüfsumme bestehen alle drei.
- **Lizenz:** Bis 2.2.0 stehen Server, Kernpaket und Client unter MIT, ab 2.3.0 unter Apache-2.0. `LICENSE` beginnt mit einer Erklärung zum laufenden Wechsel: Neue Beiträge stehen unter Apache-2.0, Dokumentation ausser der Spezifikation unter CC-BY-4.0, und Beiträge, deren Autorinnen und Autoren dem Wechsel noch nicht zugestimmt haben, bleiben unter MIT. Danach folgen der Text von Apache-2.0 und der von MIT. zod steht unter MIT.
- **Kein Client-Paket:** Das Serverpaket exportiert `InMemoryTransport` mit `createLinkedPair()`, und `serveStdio` nimmt einen eigenen Transport an. Tests können die Gegenseite also mit rohem JSON-RPC selbst spielen. `@modelcontextprotocol/client` 2.3.1 brächte `jose`, `cross-spawn`, `eventsource`, `pkce-challenge` und `eventsource-parser` mit. `eventsource` 3.0.7 und `pkce-challenge` 5.0.1 haben keinen vertrauenswürdigen Herausgeber, die Prüfung neuer Einträge im Lockfile würde sie melden.

## Gebündelter Code

Das Serverpaket bündelt Code anderer Pakete in seine eigenen Dateien. Das Werkzeug seines Builds markiert jeden solchen Abschnitt mit einem Kommentar `//#region` und dem Pfad, aus dem er stammt, etwa `node_modules/.pnpm/fast-uri@3.1.0/node_modules/fast-uri/…`. Dieselben Pfade stehen in den `sources` der Source Maps. Beide Quellen nennen dieselben acht Pakete:

| Paket                   | Version | Lizenz       | Fundstelle in `dist/`                                                                                |
| ----------------------- | ------- | ------------ | ---------------------------------------------------------------------------------------------------- |
| `ajv`                   | 8.18.0  | MIT          | `ajvProvider-CEoC__sr.mjs`, `ajvProvider-ZaoO9afR.cjs` und die Typen `ajvProvider-*.d.mts`, `.d.cts` |
| `ajv-formats`           | 3.0.1   | MIT          | wie `ajv`                                                                                            |
| `fast-deep-equal`       | 3.1.3   | MIT          | `ajvProvider-CEoC__sr.mjs`, `ajvProvider-ZaoO9afR.cjs`                                               |
| `fast-uri`              | 3.1.0   | BSD-3-Clause | `ajvProvider-CEoC__sr.mjs`, `ajvProvider-ZaoO9afR.cjs`                                               |
| `json-schema-traverse`  | 1.0.0   | MIT          | `ajvProvider-CEoC__sr.mjs`, `ajvProvider-ZaoO9afR.cjs`                                               |
| `content-type`          | 1.0.5   | MIT          | `src-Cqbh3MYc.mjs`, `src-BhnGYybN.cjs`                                                               |
| `@cfworker/json-schema` | 4.1.1   | MIT          | `cfWorkerProvider-p3WaZPqB.mjs`, `cfWorkerProvider-BwbPzsdI.cjs`                                     |
| `json-schema-typed`     | 8.0.2   | BSD-2-Clause | nur die Typen `types-DUs7mGBv.d.mts`, `types-DsbMXNFL.d.cts`                                         |

- **Was davon läuft:** Unter Node.js lädt das SDK über seinen Unterpfad `./_shims` die Gruppe um ajv als Prüfer für JSON-Schemas. `content-type` liegt im Hauptteil. `@cfworker/json-schema` lädt nur der Unterpfad `./validators/cf-worker` oder die Bedingung `workerd`. `json-schema-typed` steht nur in den Typen.
- **Woher die Lizenzen stammen:** aus den Metadaten der Registry für die jeweilige Version. Nur `content-type` behält im gebündelten Code seinen Hinweis auf Urheber und Lizenz. `LICENSE` des Pakets nennt keine Hinweise Dritter.
- **Kernpaket:** `@modelcontextprotocol/core` 2.3.1 bündelt keinen fremden Code. Seine Source Maps nennen nur eigene Quellen, und es importiert zur Laufzeit nur `zod/v4`.
- **Was die Werkzeuge sehen:** Gebündelter Code steht nicht im Lockfile. `pnpm licenses list`, `deps-review` und Renovate sehen ihn nicht, und ein Override in pnpm kann ihn nicht ersetzen.

### Bekannte Schwachstellen

Laut OSV, abgerufen am 11.10.2026, haben `ajv` 8.18.0, `ajv-formats` 3.0.1, `fast-deep-equal` 3.1.3, `json-schema-traverse` 1.0.0, `content-type` 1.0.5, `@cfworker/json-schema` 4.1.1 und `json-schema-typed` 8.0.2 keine bekannten Schwachstellen, ebenso `@modelcontextprotocol/server` 2.3.1, `@modelcontextprotocol/core` 2.3.1 und `zod` 4.6.5. Für `fast-uri` 3.1.0 sind es neun:

| Kennung             | CVE            | Schwere | Behoben in 3.x | Veröffentlicht | Inhalt                                                      |
| ------------------- | -------------- | ------- | -------------- | -------------- | ----------------------------------------------------------- |
| GHSA-q3j6-qgpj-74h6 | CVE-2026-6321  | hoch    | 3.1.1          | 08.05.2026     | Pfad mit kodierten Punkten verlässt den Pfad                |
| GHSA-v39h-62p7-jpjc | CVE-2026-6322  | hoch    | 3.1.2          | 08.05.2026     | verwechselter Host über kodierte Trennzeichen               |
| GHSA-4c8g-83qw-93j6 | CVE-2026-13676 | hoch    | 3.1.3          | 21.07.2026     | verwechselter Host bei gescheiterter Umwandlung von IDN     |
| GHSA-v2hh-gcrm-f6hx | CVE-2026-16221 | hoch    | 3.1.4          | 21.07.2026     | verwechselter Host über einen Backslash als Trennzeichen    |
| GHSA-7p8r-x3mc-p8w7 | CVE-2026-18446 | hoch    | 3.1.5          | 03.08.2026     | verwechselter Host über einen Backslash am Anfang           |
| GHSA-f65p-4m7j-42xc | CVE-2026-75975 | hoch    | 3.1.6          | 02.09.2026     | Anfrage an fremde Ziele über fehlerhaft normalisiertes IPv6 |
| GHSA-jqff-g426-hqxp | CVE-2026-76172 | hoch    | 3.1.6          | 02.09.2026     | verwechselter Host über ein kodiertes Schema                |
| GHSA-qw65-cvwx-89v3 | CVE-2026-84292 | hoch    | 3.1.7          | 28.09.2026     | eingeschleuste Authority über einen ungeprüften Port        |
| GHSA-hrr3-gc8f-f4qj | CVE-2026-86472 | mittel  | 3.1.8          | 29.09.2026     | uneinheitliche Gross- und Kleinschreibung des Hosts         |

ajv benutzt `fast-uri`, um `$id` und `$ref` aufzulösen, wenn es ein JSON-Schema übersetzt. Erreichbar ist es damit über die Schemas von Tools und Rückfragen, die der Server selbst festlegt. Ob ein Wert vom Client es erreicht, etwa über ein Format für URIs, ist nicht geprüft. Eine neuere Version des SDK, die eine behobene Version bündeln könnte, gibt es am 11.10.2026 nicht.

## Einstieg über stdio und Instanzen

- **`serveStdio`** aus `@modelcontextprotocol/server/stdio` ist der Einstieg über stdio (`dist/stdio.d.mts`). Es nimmt eine Funktion, die eine Instanz erzeugt, und Optionen: `legacy` (`'serve'` oder `'reject'`), `transport`, `onerror` und `maxSubscriptions`.
- **Zuordnung der Ära:** `serveStdio` ordnet die erste Nachricht einer Verbindung einmal zu. `initialize` ohne gültige Angabe der Version 2026 oder eine Nachricht ohne solche Angabe bedeutet die Ära 2025, eine Anfrage mit `io.modelcontextprotocol/protocolVersion` in `_meta` und einer unterstützten Version die Ära 2026. `server/discover` erzeugt eine Instanz zur Probe, ohne sie zu binden. Weicht der Client danach auf `initialize` aus, verwirft `serveStdio` sie und erzeugt eine neue (Quelltext `src/server/serveStdio.ts`, Kommentar am Anfang).
- **Eine Instanz pro Verbindung:** Die erste Nachricht bindet die Instanz an die Verbindung. Die Funktion, die sie erzeugt, läuft einmal pro Verbindung, bei einer Probe mit Rückfall zweimal, und soll laut SDK billig und ohne Nebenwirkung sein. Sie erhält `era` mit `'legacy'` oder `'modern'`.
- **Keine Instanz pro Anfrage über stdio:** `Server.connect` wirft bei einer verbundenen Instanz den Fehler `AlreadyConnected` mit dem Hinweis «Use a separate Server instance per connection» (Quelltext `src/server/server.ts`). Eine Instanz pro Anfrage gibt es nur über HTTP mit `createMcpHandler`, der seine Funktion «once per HTTP request» aufruft.
- **Ära 2026 nur über `serveStdio`:** Die Funktionen, die eine Instanz auf die Ära 2026 einstellen, sind nicht exportiert (`dist/index.d.mts`, Liste der Exporte). Ein von Hand verbundener `StdioServerTransport` spricht nur die Ära 2025 (`docs/migration/support-2026-07-28.md`).
- **Capabilities des Clients:** In der Ära 2026 trägt jede Anfrage sie in `_meta`, der Handler liest sie unter `ctx.mcpReq.envelope`. Der Typ dieses Felds ist im Paket als leeres Objekt deklariert, Lesen braucht eine Umwandlung des Typs. In der Ära 2025 kommen sie aus `initialize` und stehen über `getClientCapabilities()`, das als veraltet markiert ist. Über stdio in der Ära 2026 liefert diese Methode `undefined`.
- **Was eine Instanz hält:** die verhandelte Version, Capabilities, registrierte Tools, Prompts und Ressourcen, offene Anfragen in beide Richtungen und in der Ära 2025 die Capabilities und Angaben des Clients aus `initialize`.

## Ältere Clients

- **Voreinstellung:** `serveStdio` bedient Clients bis 2025-11-25 ohne weitere Einstellung (`legacy: 'serve'`). Mit `'reject'` antwortet es mit dem Fehler -32022 und nennt die unterstützten Versionen (`docs/serving/legacy-clients.md`).
- **Versionen:** Unterstützt sind in der Ära 2025 die Versionen 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05 und 2024-10-07, in der Ära 2026 nur 2026-07-28.
- **Laut Spezifikation** darf ein Server beide Ären bedienen. Ein älterer Client scheitert an einem Server, der nur die Ära 2026 spricht, weil er keinen Weg nach vorn kennt (`basic/versioning`, Abschnitt «Backward Compatibility with Initialization-Based Versions»).
- **Shim für `input_required`:** Gibt ein Handler in der Ära 2025 `input_required` zurück, schickt ein Shim des SDK für jede Rückfrage eine echte Anfrage `elicitation/create` an den Client und ruft den Handler mit den Antworten unter `inputResponses` erneut auf. Er ist voreingestellt, mit höchstens acht Runden und zehn Minuten pro Runde (`inputRequired` in den Optionen des Servers).
  - Hat der Client bei `initialize` keine Elicitation deklariert, ruft der Shim den Handler nicht erneut auf und liefert ein Ergebnis mit `isError`.
  - Angenommenen Inhalt prüft der Shim nicht gegen das Schema.
  - Ein Handler, der nach einer Ablehnung erneut fragt, fragt so lange, bis die Zahl der Runden erreicht ist.
- **Über HTTP** bedient `createMcpHandler` ältere Clients ohne Sitzung. Eine solche Instanz kennt die Capabilities des Clients nicht, und eine Rückfrage über Elicitation scheitert. Die Alternative ist `reject`.

## Rückfragen (`input_required`)

- **Spezifikation** (`basic/patterns/mrtr`): Ein Server antwortet auf `tools/call`, `prompts/get` oder `resources/read` mit `resultType: "input_required"`, mit Rückfragen unter `inputRequests` und einem undurchsichtigen `requestState`. Mindestens eines der beiden muss vorhanden sein. Der Client wiederholt die Anfrage mit einer neuen ID, mit den Antworten unter `inputResponses` und dem unveränderten `requestState`.
- **Anforderungen an den Server:** `requestState` ist vom Angreifer kontrolliert und muss geschützt werden, sobald er Logik beeinflusst, etwa mit HMAC (Anforderung 4). Er soll Prinzipal, eine kurze Frist und Methode mit einem Digest der Parameter enthalten. Der Server fragt nur nach Capabilities, die der Client deklariert hat (Anforderung 7), und verlässt sich nicht darauf, dass der Client antwortet oder wiederholt (Anforderung 8).
- **Antworten:** `accept`, `decline` und `cancel`, unverändert gegenüber 2025-11-25 (`client/elicitation`, Abschnitt «Response Actions»). Inhalt gibt es nur bei `accept` im Modus Formular. Ein leeres Objekt unter `elicitation` bedeutet Formular.
- **Im SDK:** Ein Tool gibt `CallToolResult` oder `InputRequiredResult` zurück. `inputRequired({ inputRequests, requestState })` und `inputRequired.elicit({ message, requestedSchema })` bauen die Antwort. Beim Wiedereinstieg stehen die Antworten unter `ctx.mcpReq.inputResponses` und der `requestState` über `ctx.mcpReq.requestState()`. `inputResponse()` liest eine Antwort als `accept`, `decline` oder `cancel` oder als `missing`, `acceptedContent()` den angenommenen Inhalt, mit einem Schema auch geprüft.
- **Prüfung der Capability in der Ära 2026:** Fehlt die nötige Capability in `_meta` der Anfrage, antwortet das SDK mit dem Fehler -32021, bevor etwas den Client erreicht.
- **Ein Tool ohne Eingabeschema** erhält seine Argumente nicht. Der Handler sieht nur den Kontext.

### `requestState` schützen

- **Codec des SDK:** `createRequestStateCodec({ key, ttlSeconds, bind })` signiert den `requestState` mit HMAC-SHA256. Der Schlüssel hat mindestens 32 Byte, die Frist ist in der Voreinstellung 600 Sekunden. Der Inhalt ist nicht verschlüsselt, der Client kann ihn lesen (`dist/index.d.mts`, `createRequestStateCodec`).
- **Prüfung:** `verify` des Codecs gehört in die Optionen des Servers unter `requestState.verify`. Das SDK ruft es bei `tools/call`, `prompts/get` und `resources/read` auf, sobald die Anfrage einen `requestState` trägt, vor dem Handler. Scheitert es, antwortet das SDK mit -32602 «Invalid or expired requestState» und `data.reason` gleich `invalid_request_state`. Den Grund (`malformed`, `mac`, `expired` oder `bind`) meldet es nur an `onerror` der Instanz, nicht an `onerror` von `serveStdio` (Quelltext `src/server/server.ts`).
- **Bindung:** `bind` erhält den Kontext der Anfrage, also Methode, ID, `_meta` und über HTTP die Anmeldung. Die Parameter der Anfrage sieht es nicht. Einen Digest der Parameter muss der Handler deshalb selbst in den Inhalt legen und beim Wiedereinstieg vergleichen.
- **Schlüssel:** Ein zufälliger Schlüssel pro Prozess genügt nur, wenn ein Prozess alle Runden bedient. Über stdio ist das der Fall.

## Sampling

- **Spezifikation:** Sampling ist seit 2026-07-28 veraltet, zusammen mit Roots und Logging (`changelog`, Abschnitt «Deprecated», SEP-2577). Entfernt wird es frühestens mit der ersten Revision ab dem 28.07.2027 (`deprecated`). Die Seite `client/sampling` sagt: «New implementations SHOULD NOT adopt it.»
- **SDK:** Die Typen für Sampling sind als veraltet markiert. `createMessage`, `requestSampling` und `elicitInput` werfen bei einer Anfrage der Ära 2026 (`docs/servers/sampling.md`).

## stdout, stderr und Konsole

- **stdout:** Nur `StdioServerTransport.send` schreibt dorthin (`dist/stdio.mjs`). Die Spezifikation verlangt, dass auf stdout nur gültige MCP-Nachrichten stehen (`basic/transports/stdio`).
- **stderr:** `console.warn` meldet sich bei einem ungültigen Namen eines Tools, bei zod älter als 4.2, bei einer ungültigen Kopfzeile `x-mcp-header` und bei `createMcpHandler` mit `responseMode: 'json'`. Letzteres betrifft den Betrieb über HTTP in Phase 7. Im JSON-Modus verwirft `createMcpHandler` Benachrichtigungen während eines Aufrufs.
- **ajv** schreibt über seinen Logger nur mit der Option `$comment: true` auf stdout. Das SDK setzt sie nicht.

## Kein Haken vor dem Handler

- Ein unbekanntes oder abgeschaltetes Tool endet als -32602, ein Fehler bei der Prüfung der Eingabe als Ergebnis mit `isError`, eine fehlerhafte Anfrage `tools/call` als -32602. Keines davon erreicht einen Handler von Ecclium oder `onerror` (Quelltext `src/server/mcp.ts`).
- Das Serverpaket hat keine Middleware. `fallbackRequestHandler` greift nur bei Methoden, für die kein Handler registriert ist.
- Denkbar, aber nicht geprüft, sind ein Transport, der die Nachrichten beobachtet, und ein Schema, das die Prüfung der Eingabe umhüllt.

## Namen der Registrierung

Methoden, über die Code Tools, Prompts, Ressourcen oder Handler beim SDK anmeldet oder ändert: `registerTool`, `registerPrompt`, `registerResource`, `setRequestHandler`, `setNotificationHandler`, `fallbackRequestHandler`, `fallbackNotificationHandler`, `removeRequestHandler`, `removeNotificationHandler`, `registerCapabilities` und an einem registrierten Tool `update`, `enable`, `disable` und `remove` (`dist/createMcpHandler-D4NN8WsG.d.mts`). Die Sperre `[arch:mcp-register]` kannte vor der Prüfung die ersten sieben.

## Offene Punkte

- Ob die Typdefinitionen des SDK ohne `skipLibCheck` und ohne die Typen des Browsers übersetzen, zeigt erst der Build mit dem Spike.
- Ob ein Wert vom Client den gebündelten Code von `fast-uri` erreicht.
- Wie sich Clients bei Rückfragen verhalten. Das klärt der Spike.
