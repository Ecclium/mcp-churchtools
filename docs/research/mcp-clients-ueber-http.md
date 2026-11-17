# MCP-Clients über HTTP: Befunde

Stand: 16.11.2026, mit `@modelcontextprotocol/server` 2.3.1; die Prüfungen des SDK am 17.11.2026 mit 2.4.0 nachgeprüft

Dieses Dokument hält fest, was MCP-Clients über HTTP senden und wie das MCP-SDK darauf antwortet, und worauf sich jede Aussage stützt. Der Entscheid, der darauf aufbaut, steht in [ADR 0073](../adr/0073-betrieb-ueber-http.md), dort unter «Ältere Clients» und «Grenzen der Anfrage». Der erste Teil beschreibt, was das SDK prüft. Der zweite hält fest, was die Clients an einer Attrappe gesendet haben. Der Test mit den Clients in Phase 7 ergänzt dieses Dokument.

## Methode

- Gelesen ist der Code im Paket `@modelcontextprotocol/server` 2.3.1 unter `dist/`. Die Namen der Dateien tragen einen Hash des Builds und gelten nur für diese Version.
- Am 17.11.2026 kam das SDK auf 2.4.0. Die Funktionen `classifyRequestBody` und `validateStandardRequestHeaders` stehen dort in `dist/src-DdvbAHrR.mjs`, und ihre Quellen in den Source Maps gleichen denen von 2.3.1. Die Tests der Probe laufen mit 2.4.0 unverändert grün, auch jede Zeile der Tabelle unten. Die Läufe mit den Clients unter «Ergebnisse» liefen mit 2.3.1 und sind nicht wiederholt.
- Beobachtet ist mit der Probe `scripts/spike/14-protocol-version.mts` ([README der Proben](../../scripts/spike/README.md), «Was die Probe der Protokollversion tut»). Sie ist eine Attrappe eines MCP-Servers ohne ChurchTools, ohne Daten und mit einem leeren Tool. Ein eigener Teil hält jede Anfrage fest und reicht sie danach an `createMcpHandler` des SDK, im JSON-Modus und mit `legacy: 'stateless'`, wie Ecclium es über HTTP nutzen wird. Festgehalten werden nur feste Wörter und Werte in fester Form, nie Adressen, der Host, Pfade, weitere Kopfzeilen oder Inhalte.
- Eine Antwort, die das SDK als Strom mit genau einer Nachricht schickt, gibt die Attrappe als JSON an den Client weiter und hält fest, dass es ein Strom war (siehe «Ergebnisse», claude.ai).
- Das Urteil des SDK ist also beobachtet, mit Version 2.3.1 und ohne den Adapter für Hono, den Ecclium dazu nimmt. Den Beleg von Ende zu Ende bringt der Test mit den Clients gegen den Server von Ecclium.
- Bei einer Kopfzeile, die eine andere unterstützte Version nennt als der Körper, fragt die Probe das SDK in ihrer Voreinstellung ein zweites Mal mit der Version des Körpers in der Kopfzeile. Das ist die vorbereitete Ersatzregel aus ADR 0073. Festgehalten werden beide Antworten.

## Was das SDK prüft

Ob eine Anfrage zur Ära 2025 oder zur Ära 2026-07-28 gehört, entscheidet das SDK nach dem Körper: Trägt `params._meta` den Schlüssel `io.modelcontextprotocol/protocolVersion`, gehört sie zur Ära 2026, sonst zur Ära 2025. Die Kopfzeile `MCP-Protocol-Version` ändert die Ära nie, das SDK vergleicht sie nur (`dist/src-Cqbh3MYc.mjs`, Funktionen `classifyRequestBody` und `validateStandardRequestHeaders` mit dem Kommentar davor). Laut diesem Kommentar verlangt die Spezifikation auf jeder Anfrage der Ära 2026 die Kopfzeilen `MCP-Protocol-Version` und `Mcp-Method`, und `Mcp-Name` für die Methoden, deren Name oder Adresse sie wiederholt, etwa `tools/call`. Bevor ein Handler läuft, weist das SDK diese Fälle mit dem HTTP-Status 400 ab:

| Fall                                                                   | Fehler | Deckt die Ersatzregel ihn?  |
| ---------------------------------------------------------------------- | ------ | --------------------------- |
| Kopfzeile nennt eine andere Version als der Umschlag im Körper         | -32020 | ja, ausser bei `initialize` |
| `initialize` mit einer Kopfzeile der Ära 2026                          | -32020 | nein                        |
| Kopfzeile der Ära 2026, aber kein Umschlag im Körper                   | -32602 | nein                        |
| Umschlag der Ära 2026 ohne `MCP-Protocol-Version`                      | -32020 | nein                        |
| Umschlag der Ära 2026 ohne `Mcp-Method` oder mit einer anderen Methode | -32020 | nein                        |
| `tools/call` der Ära 2026 ohne `Mcp-Name` oder mit einem anderen Namen | -32020 | nein                        |

`Mcp-Name` darf den Namen auch in Base64 tragen, in der Form `=?base64?…?=`; eine ungültige Kodierung weist das SDK ebenfalls ab. Trägt der Körper das Feld nicht als Text, verlangt es `Mcp-Name` nicht. Bei einer Anfrage der Ära 2025 prüft das SDK nur `MCP-Protocol-Version`: Eine Version der Ära 2025, die es nicht kennt, etwa 2025-01-01, weist es mit 400 und -32000 ab, eine Version ab 2026-07-28 ohne Umschlag mit -32602 (dritte Zeile). Die Tests der Probe (`tests/spike/protocol-version.test.mts`) belegen jede Zeile der Tabelle mit dem SDK im Prozess, `initialize` mit und ohne Umschlag.

Für den Ort `ingress` von Ecclium folgt daraus: Das SDK liest den Körper mit einem `TextDecoder`, der ein Byte Order Mark am Anfang entfernt. Prüft `ingress` die Methode selbst, etwa um `subscriptions/listen` abzuweisen, oder gleicht es die Kopfzeile an, muss es den Körper genauso lesen oder dem SDK den gelesenen Körper übergeben (`parsedBody`). Sonst sieht es eine andere Nachricht als das SDK, und eine Anfrage mit Byte Order Mark ginge an seiner Prüfung vorbei. Die Attrappe liest den Körper deshalb wie das SDK, mit einem Test.

## Ergebnisse

| Datum      | Client                                         | Version | Weg                                                                      | Ära  | Kopfzeilen und Körper                                                                                                                                                                                                                                  | Urteil des SDK                                     |
| ---------- | ---------------------------------------------- | ------- | ------------------------------------------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| 16.11.2026 | `claude-code`                                  | 2.1.319 | HTTP auf Loopback, ohne Anmeldung                                        | 2026 | `server/discover`, `tools/list`, `tools/call`; `MCP-Protocol-Version` 2026-07-28 wie im Umschlag, `Mcp-Method` und `Mcp-Name` gleich, kein `Origin`, `Accept` mit JSON und SSE                                                                         | alle angenommen                                    |
| 16.11.2026 | `claude-code`                                  | 2.1.319 | HTTP auf Loopback, ohne Anmeldung, mit `MCP_PROTOCOL_NEGOTIATION=legacy` | 2025 | `initialize` mit 2025-11-25 ohne Kopfzeile, danach jede Anfrage mit `MCP-Protocol-Version` 2025-11-25; ein `GET` für einen Strom                                                                                                                       | alle angenommen, das `GET` mit 405                 |
| 16.11.2026 | `openai-mcp`, ChatGPT im Developer Mode im Web | 1.0.0   | über einen Tunnel mit `https`, ohne Anmeldung                            | 2026 | zuerst ein `POST` ohne Körper und die Suche nach OAuth unter `/.well-known/…`, zweimal; dann `server/discover`, `tools/list` und `tools/call` mit `MCP-Protocol-Version` 2026-07-28 wie im Umschlag, `Mcp-Method` und `Mcp-Name` gleich, kein `Origin` | das leere `POST` mit 415, alles Weitere angenommen |
| 16.11.2026 | `Anthropic`, claude.ai im Web                  | 1.0.0   | über einen Tunnel mit `https`, «No sign in»                              | 2025 | nur `initialize`, mit Kopfzeile und Körper 2025-11-25, kein `Origin`, in zwei Läufen achtmal; danach keine weitere Anfrage                                                                                                                             | `initialize` angenommen                            |

- Claude Code beginnt in der Ära 2026 mit `server/discover` und sendet kein `initialize`. Mit `MCP_PROTOCOL_NEGOTIATION=legacy` beginnt es mit `initialize` und fragt nicht nach `server/discover`.
- In der Ära 2025 öffnet Claude Code nach `notifications/initialized` mit `GET` einen Strom. Ohne Sitzung antwortet das SDK mit 405, und Claude Code arbeitet ohne Strom weiter.
- Den Namen meldet Claude Code in beiden Ären als `claude-code` mit seiner Version, in der Ära 2026 im Umschlag unter `io.modelcontextprotocol/clientInfo`.
- ChatGPT prüft vor der Verbindung, ob der Server eine Anmeldung verlangt: ein `POST` ohne Körper und ohne JSON in `Accept`, das das SDK mit 415 abweist, und Anfragen nach `oauth-protected-resource`, `oauth-authorization-server` und `openid-configuration`, je mit und ohne den Pfad des Servers. Auf 404 verbindet es sich ohne Anmeldung, in der Ära 2026 und mit allen Kopfzeilen, die das SDK verlangt. Bei `tools/call` hielt die Attrappe den Namen des Clients als «anderer Wert» fest; ob er dort eine andere Form hatte oder an der Sperrliste der Anfrage hängen blieb, zeigt die Ausgabe nicht.
- claude.ai sucht mit «No sign in» nicht nach OAuth. Es spricht die Ära 2025 und sendet die Kopfzeile schon mit `initialize`, passend zum Körper. Im ersten Lauf kam die Antwort nicht an: Den Weg der Ära 2025 beantwortet das SDK auch im JSON-Modus als Strom von Server-Sent Events, der sich nach der einen Nachricht schliesst, und der verwendete Tunnel leitet solche Ströme nicht weiter. Seit die Attrappe einen solchen Strom als JSON weitergibt, kommt die Antwort an. claude.ai sendet danach trotzdem nichts mehr, weder `notifications/initialized` noch `tools/list`, und meldet, der Server sei nicht erreichbar. Dasselbe Muster beschreiben offene Fehlerberichte bei Anthropic seit dem 03.11.2026 für das Web und die Android-App, mit demselben Namen des Clients und derselben Version, ohne Antwort von Anthropic und ohne bekannten Umweg (Repository `anthropics/claude-ai-mcp`, Issues 1214 und 1241). Die Mobile-App und den Connector in Claude Code liess der Fehler nicht prüfen.
- Kein Client sendete `Origin`, `Authorization` oder `Mcp-Session-Id`.

Offen bleibt, was claude.ai nach `initialize` sendet, also auch, ob es bei späteren Anfragen eine Kopfzeile sendet, die nicht zum Körper passt. Ein öffentlicher Fehlerbericht vom 10.09.2026 nennt Claude Desktop und Claude Code, die über Connectors von claude.ai die Kopfzeile 2025-11-25 mit 2026-07-28 im Körper senden (Repository `anthropics/claude-code`, Issue 93290, am 15.11.2026 ohne Fix geschlossen). Das wäre der erste Fall der Tabelle. Der Test mit den Clients in Phase 7 prüft claude.ai deshalb noch einmal.

## Folgen für Ecclium

- **Ältere Clients:** claude.ai spricht über HTTP die Ära 2025. Ecclium muss sie bedienen, wie ADR 0073 es vorsieht.
- **Kopfzeile und Körper:** Bisher hat kein Client eine Kopfzeile gesendet, die nicht zum Körper passt. Die vorbereitete Ersatzregel bleibt vorbereitet.
- **Antworten als JSON:** Der Weg der Ära 2025 antwortet als Strom. Ein Proxy oder Tunnel, der keine Ströme weiterleitet, hält die Antwort an claude.ai zurück. Der Ort `ingress` muss eine solche Antwort mit genau einer Nachricht als JSON weitergeben, wie die Attrappe es tut, oder der Reverse-Proxy muss Ströme durchlassen.
- **Origin:** Kein Client sendete `Origin`. Die Prüfung aus ADR 0073 weist keinen von ihnen ab.

## Quellen

- Das Paket `@modelcontextprotocol/server` 2.3.1, `dist/src-Cqbh3MYc.mjs` und `dist/createMcpHandler-D4NN8WsG.d.mts`, gelesen am 16.11.2026.
- Claude Code, Issue 93290: https://github.com/anthropics/claude-code/issues/93290, abgerufen am 16.11.2026.
- Läufe der Probe `14-protocol-version` mit Claude Code 2.1.319 auf Loopback und mit ChatGPT und claude.ai über einen Tunnel, am 16.11.2026.
- Fehlerberichte zu Connectors von claude.ai: https://github.com/anthropics/claude-ai-mcp/issues/1214 und https://github.com/anthropics/claude-ai-mcp/issues/1241, abgerufen am 16.11.2026.
