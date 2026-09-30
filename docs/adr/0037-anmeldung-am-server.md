# ADR 0037: Anmeldung am Server: im freien Kern statische Bearer-Tokens und OAuth-Modus gegen einen Anmeldedienst des Betreibers, Komfort im Pro-Modul, Client-Test in Phase 7

- Status: Vorgeschlagen
- Datum: 25.09.2026
- Fällt vor: Phase 1

## Kontext

Über HTTP ist Ecclium ein Dienst im Netz. Wer ihn benutzen darf, entscheidet die Anmeldung eines Clients am Server. Sie ist getrennt vom Zugang des Servers zu ChurchTools (ADR 0023): Sie bestimmt, wer den Server benutzen darf, nicht mit welchen Rechten der Server ChurchTools liest.

Die MCP-Spezifikation 2026-07-28 regelt die Anmeldung auf der Seite «Authorization» und ihren Unterseiten:

- Anmeldung ist in MCP optional. Wer sie über HTTP anbietet, soll der Spezifikation folgen. Im Betrieb über stdio soll ein Server ihr nicht folgen und seine Zugangsdaten aus der Umgebung nehmen (Abschnitt «Protocol Requirements»).
- Ein geschützter Server ist ein Resource Server nach OAuth 2.1, einem Entwurf der IETF, und muss Metadaten nach RFC 9728 (OAuth 2.0 Protected Resource Metadata) anbieten. Ungültige oder abgelaufene Tokens erhalten 401. Den Weg zu den Metadaten zeigt der Server in der Kopfzeile `WWW-Authenticate` oder unter einer festen Adresse (Abschnitte «Roles», «Overview» und «Token Handling»; Unterseite «Authorization Server Discovery», Abschnitt «Protected Resource Metadata Discovery Requirements»).
- Clients müssen Resource Indicators nach RFC 8707 senden, und der Server muss prüfen, dass ein Token für ihn ausgestellt ist (Abschnitte «Resource Parameter Implementation» und «Token Handling»).
- Fehlt einem Token ein Scope, soll der Server mit 403 und `insufficient_scope` antworten (Abschnitt «Scope Challenge Handling»).
- Clients und Anmeldedienste sollen Client ID Metadata Documents unterstützen. Dynamic Client Registration ist veraltet und bleibt nur für Anmeldedienste, die diese Dokumente nicht kennen. Ein Client soll zuerst Angaben benutzen, mit denen er vorab registriert ist, dann Client ID Metadata Documents und erst danach Dynamic Client Registration (Abschnitt «Overview»; Unterseite «Client Registration»).

Stand der Clients laut der Dokumentation ihrer Anbieter, abgerufen am 30.09.2026:

- Claude Desktop bindet lokale MCP-Server über stdio ein (Claude Docs, «Build a desktop extension with MCPB», Einleitung).
- Claude Code verbindet sich über HTTP und kann eigene Kopfzeilen senden, also auch ein statisches Bearer-Token (Claude Code Docs, «Connect Claude Code to tools via MCP», Abschnitt «Option 1: Add a remote HTTP server»).
- Konnektoren (Connectors) von claude.ai:
  - Sie verbinden sich aus der Infrastruktur des Anbieters, auch wenn sie in Claude Desktop oder in den Mobile-Apps benutzt werden. Der Server muss deshalb aus dem Internet erreichbar sein. Einen Tunnel für Server in einem privaten Netz gibt es nur als Vorschau für Organisationen mit dem Enterprise-Plan, auf Anfrage (Claude Help Center, «Get started with custom connectors using remote MCP», Stand 11.08.2026, Abschnitt «Network requirements»; Claude Docs, «MCP tunnels», Hinweis zur Vorschau).
  - Sie melden sich über OAuth an oder gar nicht. Statische Kopfzeilen gibt es nur als Beta für einen begrenzten Kreis von Organisationen. Als OAuth-Client registrieren sie sich über Client ID Metadata Documents oder Dynamic Client Registration, sie nehmen aber auch eine vorab registrierte OAuth-Anwendung an (Claude Docs, «Authentication for connectors», Abschnitt «Supported authentication types»; «Add a connector that isn't in the directory», Abschnitte «Authenticate with request headers» und «Choose authentication settings»).
  - Konnektoren, die im Web oder in Claude Desktop eingerichtet sind, stehen auch in den Mobile-Apps zur Verfügung (Claude Help Center, «Use connectors to extend Claude's capabilities», Stand 20.08.2026, Abschnitt «Use connected services»).
- ChatGPT bindet eigene MCP-Server über den Developer Mode im Web ein, mit OAuth oder ohne Anmeldung. Eigene API-Schlüssel oder statische Kopfzeilen sendet es nicht. Für OAuth nimmt es hinterlegte Zugangsdaten eines Clients, sonst Client ID Metadata Documents oder Dynamic Client Registration. Für Server in einem privaten Netz bietet der Anbieter einen Tunnel an (OpenAI Developers, «ChatGPT Developer mode», Abschnitt «How to use»; «Authentication» in der Dokumentation zu Plugins, Abschnitt «Custom auth with OAuth 2.1»; «Secure MCP Tunnel», Abschnitte «Use Secure MCP Tunnel when» und «Connect from ChatGPT»).

Festzulegen ist, wie sich Clients im freien Kern anmelden und was davon ins kostenpflichtige Zusatzmodul gehört.

## Optionen

1. **Nur statische Bearer-Tokens:** einfach und ohne fremden Dienst, aber claude.ai und ChatGPT können sie nicht oder nur eingeschränkt senden. Wer diese Clients nutzen will, müsste auf einen Betrieb ohne Anmeldung ausweichen.
2. **Ein eigener Anmeldedienst im freien Kern:** alle Clients abgedeckt, aber ein eigener Autorisierungsserver ist viel sicherheitskritischer Code, den eine Person pflegen müsste.
3. **Statische Bearer-Tokens und ein OAuth-Modus, der Tokens eines Anmeldediensts des Betreibers prüft,** den Komfort rund um die Anmeldung im Zusatzmodul.

## Entscheid

Gewählt ist die dritte Option.

- **Kein Betrieb über HTTP ohne Anmeldung,** auch nicht als Schalter.
- **Statische Bearer-Tokens:** 256 Bit aus einem sicheren Zufallsgenerator, mit einem festen Präfix und einer Prüfsumme, damit Scanner für Geheimnisse sie ohne Zusammenhang erkennen. Gespeichert wird nur ihr SHA-256-Hash. Scopes `read` und `write`, ein Ablauf ist möglich. Verglichen wird in konstanter Zeit. Ohne gültiges Token antwortet der Server mit 401 und `WWW-Authenticate`, bei fehlendem Scope mit 403 und `insufficient_scope`.
- **OAuth-Modus:** Der Server ist ein Resource Server nach OAuth 2.1. Er veröffentlicht seine Metadaten nach RFC 9728 unter `/.well-known/oauth-protected-resource`, und seine Antwort 401 verweist darauf. Er prüft JWT-Zugriffstokens eines Anmeldediensts, den der Betreiber frei wählt: Signatur über die Schlüssel aus `jwks_uri`, Aussteller (`iss`), Audience (`aud`) gleich der Adresse dieses Servers, Ablauf und Scopes. Einen eigenen Anmeldedienst bringt der freie Kern nicht mit.
- **Anforderungen an den Anmeldedienst:** Er stellt JWT-Zugriffstokens mit der Adresse des Servers als Audience aus (RFC 8707) und veröffentlicht seine Metadaten samt `jwks_uri`. Clients lässt er auf einem von zwei Wegen zu: als vorab registrierte Anwendung mit fester Redirect-URI, die die Dokumentation von Ecclium für claude.ai und ChatGPT als Standard empfiehlt, oder über Client ID Metadata Documents mit einer Positivliste der zugelassenen Adressen. Dynamic Client Registration ist nur erlaubt, wenn beides nicht geht, und nie offen: Der Endpunkt verlangt ein Token, das der Betreiber ausgibt (Initial Access Token nach RFC 7591). Die Dokumentation nennt mindestens einen selbst hostbaren Anmeldedienst, mit dem der Client-Test in Phase 7 bestanden wurde.
- **Mandant und Scopes:** Der Mandant stammt nur aus der geprüften Anmeldung, nie aus Parametern oder Kopfzeilen (ADR 0003). Scopes eines Anmeldediensts werden auf `read` und `write` abgebildet, wie bei statischen Tokens.
- **Betrieb über stdio:** keine Anmeldung. Der Client ist ein lokaler Prozess, die Identität kommt aus der Konfiguration.
- **Anmeldung als Schnittstelle ab Phase 1:** Genau eine Stelle macht aus einer geprüften Anmeldung eine Identität aus Quelle (`stdio`, `bearer` oder `oauth`), Subjekt und Scopes. Aus dieser Identität leitet der `TenantResolver` Mandant und Akteur ab (ADR 0003). Pipeline, Audit, Pseudonyme und Cache wissen nicht, wie sich jemand angemeldet hat. Der Code für HTTP und OAuth entsteht in Phase 7.
- **Zusatzmodul:** ein mitgelieferter, vorkonfigurierter Anmeldedienst, ein bewährtes Produkt oder eine Bibliothek und kein Eigenbau, dazu die Anmeldung mit dem ChurchTools-Konto, die Zuordnung von Personen und Rollen.

## Konsequenzen

- Claude Desktop und Claude Code lassen sich ohne weiteren Dienst anbinden. Für claude.ai und ChatGPT braucht der Betreiber einen Anmeldedienst und einen Server, der aus dem Internet erreichbar ist oder über den Tunnel eines Anbieters angebunden wird. Die Sicherheit bleibt im freien Kern, das Zusatzmodul bringt den Komfort.
- Issuer und `jwks_uri` des Anmeldediensts kommen auf die Positivliste für ausgehende Verbindungen (ADR 0009). Der Reverse-Proxy gibt `/.well-known/oauth-protected-resource` frei.
- Restrisiken: Ein statisches Token gehört zu einem Client, nicht zu einer Person. Wer es liest, benutzt den Server bis zu seinem Ablauf oder bis der Betreiber es entfernt.
- Der Client-Test in Phase 7 prüft den Entscheid: Claude Desktop über stdio, Claude Code mit statischem Bearer-Token, claude.ai im Web und in der Mobile-App und ChatGPT im Developer Mode, beide über OAuth, je mit einer vorab registrierten Anwendung und mit Client ID Metadata Documents. Er hält pro Client auch fest, welchen Weg der Bestätigung von Schreibvorgängen der Client nimmt und ob sich eine Bestätigung dort dauerhaft auf «immer erlauben» stellen lässt. Legt ein Client die Bedingungen anders aus als erwartet, löst ein neues ADR dieses ab.
- Offen: Präfix, Prüfsumme und Format der statischen Tokens werden mit dem Code in Phase 7 festgelegt, zusammen mit einer eigenen Regel in `.gitleaks.toml` und demselben Muster für die Push Protection von GitHub.

## Umsetzung

- `.gitleaks.toml` erkennt Bearer-Tokens in einer Kopfzeile schon heute (Regel `http-bearer-token`) und beschreibt, wo die eigene Regel für die statischen Tokens hinkommt.
- Die Schnittstelle der Anmeldung folgt in Phase 1, HTTP und OAuth folgen in Phase 7.
