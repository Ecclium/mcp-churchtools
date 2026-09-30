# ADR 0037: Anmeldung am Server: im freien Kern statische Bearer-Tokens und OAuth-Modus gegen einen Anmeldedienst des Betreibers, Komfort im Pro-Modul, Client-Test in Phase 7

- Status: Vorgeschlagen
- Datum: 25.09.2026
- Fällt vor: Phase 1

## Kontext

Über HTTP ist Ecclium ein Dienst im Netz. Wer ihn benutzen darf, entscheidet die Anmeldung eines Clients am Server. Sie ist getrennt vom Zugang des Servers zu ChurchTools (ADR 0023): Sie bestimmt, wer den Server benutzen darf, nicht mit welchen Rechten der Server ChurchTools liest.

Die MCP-Spezifikation 2026-07-28 regelt die Anmeldung auf der Seite «Authorization» und ihren Unterseiten:

- Anmeldung ist in MCP optional. Wer sie über HTTP anbietet, soll der Spezifikation folgen. Im Betrieb über stdio soll ein Server ihr nicht folgen und seine Zugangsdaten aus der Umgebung nehmen (Abschnitt «Protocol Requirements»).
- Ein geschützter Server ist ein Resource Server nach OAuth 2.1 und muss Metadaten nach RFC 9728 (OAuth 2.0 Protected Resource Metadata) anbieten. Ungültige oder abgelaufene Tokens erhalten 401. Den Weg zu den Metadaten zeigt der Server in der Kopfzeile `WWW-Authenticate` oder unter einer festen Adresse (Unterseite «Authorization Server Discovery»).
- Clients müssen Resource Indicators nach RFC 8707 senden, und der Server muss prüfen, dass ein Token für ihn ausgestellt ist (Abschnitte «Resource Parameter Implementation» und «Token Handling»).
- Fehlt einem Token ein Scope, soll der Server mit 403 und `insufficient_scope` antworten (Abschnitt «Scope Challenge Handling»).
- Clients und Anmeldedienste sollen Client ID Metadata Documents unterstützen. Dynamic Client Registration ist veraltet und bleibt nur für Anmeldedienste, die diese Dokumente nicht kennen.

Stand der Clients laut der Dokumentation ihrer Anbieter, abgerufen am 30.09.2026:

- Claude Desktop bindet lokale MCP-Server über stdio ein.
- Claude Code verbindet sich über HTTP und kann eigene Kopfzeilen senden, also auch ein statisches Bearer-Token.
- Connectoren von claude.ai verbinden sich aus der Infrastruktur des Anbieters, auch wenn sie in Claude Desktop oder in den Mobile-Apps benutzt werden. Der Server muss deshalb aus dem Internet erreichbar sein. Sie melden sich über OAuth an oder gar nicht. Statische Kopfzeilen gibt es nur als Beta für einen begrenzten Kreis von Organisationen. Connectoren, die im Web oder in Claude Desktop eingerichtet sind, stehen auch in den Mobile-Apps zur Verfügung.
- ChatGPT bindet eigene MCP-Server über den Developer Mode im Web ein, mit OAuth oder ohne Anmeldung. Eigene API-Schlüssel oder statische Kopfzeilen sendet es nicht.

Festzulegen ist, wie sich Clients im freien Kern anmelden und was davon ins kostenpflichtige Zusatzmodul gehört.

## Optionen

1. **Nur statische Bearer-Tokens:** einfach und ohne fremden Dienst, aber claude.ai und ChatGPT können sie nicht oder nur eingeschränkt senden. Wer diese Clients nutzen will, müsste auf einen Betrieb ohne Anmeldung ausweichen.
2. **Ein eigener Anmeldedienst im freien Kern:** alle Clients abgedeckt, aber ein eigener Autorisierungsserver ist viel sicherheitskritischer Code, den eine Person pflegen müsste.
3. **Statische Bearer-Tokens und ein OAuth-Modus, der Tokens eines Anmeldediensts des Betreibers prüft,** den Komfort rund um die Anmeldung im Zusatzmodul.

## Entscheid

Gewählt ist die dritte Option.

- **Kein Betrieb über HTTP ohne Anmeldung,** auch nicht als Schalter.
- **Statische Bearer-Tokens:** 256 Bit aus einem sicheren Zufallsgenerator, mit einem festen Präfix und einer Prüfsumme, damit Scanner für Geheimnisse sie ohne Zusammenhang erkennen. Gespeichert wird nur ihr SHA-256-Hash. Scopes `read` und `write`, ein Ablauf ist möglich. Verglichen wird in konstanter Zeit. Ohne gültiges Token antwortet der Server mit 401 und `WWW-Authenticate`, bei fehlendem Scope mit 403 und `insufficient_scope`.
- **OAuth-Modus:** Der Server ist ein Resource Server nach RFC 9728. Er veröffentlicht seine Metadaten unter `/.well-known/oauth-protected-resource`, und seine Antwort 401 verweist darauf. Er prüft JWT-Zugriffstokens eines Anmeldediensts, den der Betreiber frei wählt: Signatur über die Schlüssel aus `jwks_uri`, Aussteller (`iss`), Audience (`aud`) gleich der Adresse dieses Servers, Ablauf und Scopes. Einen eigenen Anmeldedienst bringt der freie Kern nicht mit.
- **Anforderungen an den Anmeldedienst:** Er stellt JWT-Zugriffstokens mit der Adresse des Servers als Audience aus (RFC 8707) und veröffentlicht seine Metadaten samt `jwks_uri`. Für claude.ai und ChatGPT unterstützt er Client ID Metadata Documents, ersatzweise Dynamic Client Registration, weil sich diese Clients darüber registrieren. Die Dokumentation nennt mindestens einen selbst hostbaren Anmeldedienst, mit dem der Client-Test in Phase 7 bestanden wurde.
- **Mandant und Scopes:** Der Mandant stammt nur aus der geprüften Anmeldung, nie aus Parametern oder Kopfzeilen (ADR 0003). Scopes eines Anmeldediensts werden auf `read` und `write` abgebildet, wie bei statischen Tokens.
- **Betrieb über stdio:** keine Anmeldung. Der Client ist ein lokaler Prozess, die Identität kommt aus der Konfiguration.
- **Anmeldung als Schnittstelle ab Phase 1:** Genau eine Stelle macht aus einer geprüften Anmeldung eine Identität aus Quelle (`stdio`, `bearer` oder `oauth`), Subjekt und Scopes. Pipeline, Audit, Pseudonyme und Cache wissen nicht, wie sich jemand angemeldet hat. Der Code für HTTP und OAuth entsteht in Phase 7.
- **Zusatzmodul:** ein mitgelieferter, vorkonfigurierter Anmeldedienst, ein bewährtes Produkt oder eine Bibliothek und kein Eigenbau, dazu die Anmeldung mit dem ChurchTools-Konto, die Zuordnung von Personen und Rollen.

## Konsequenzen

- Claude Desktop und Claude Code lassen sich ohne weiteren Dienst anbinden. Für claude.ai und ChatGPT braucht der Betreiber einen Anmeldedienst und einen Server, der aus dem Internet erreichbar ist. Die Sicherheit bleibt im freien Kern, das Zusatzmodul bringt den Komfort.
- Issuer und `jwks_uri` des Anmeldediensts kommen auf die Positivliste für ausgehende Verbindungen (ADR 0009). Der Reverse-Proxy gibt `/.well-known/oauth-protected-resource` frei.
- Ein statisches Token gehört zu einem Client, nicht zu einer Person. Es gilt bis zu seinem Ablauf oder bis der Betreiber es entfernt.
- Der Client-Test in Phase 7 prüft den Entscheid: Claude Desktop über stdio, Claude Code mit statischem Bearer-Token, claude.ai im Web und in der Mobile-App und ChatGPT im Developer Mode, beide über OAuth. Er hält pro Client auch fest, welchen Weg der Bestätigung von Schreibvorgängen der Client nimmt und ob sich eine Bestätigung dort dauerhaft auf «immer erlauben» stellen lässt. Legt ein Client die Bedingungen anders aus als erwartet, wird dieses ADR nachgeführt.
- Offen: Präfix, Prüfsumme und Format der statischen Tokens werden mit dem Code in Phase 7 festgelegt, zusammen mit einer eigenen Regel in `.gitleaks.toml` und demselben Muster für die Push Protection von GitHub.

## Umsetzung

- `.gitleaks.toml` erkennt Bearer-Tokens in einer Kopfzeile schon heute (Regel `http-bearer-token`) und beschreibt, wo die eigene Regel für die statischen Tokens hinkommt.
- Die Schnittstelle der Anmeldung folgt in Phase 1, HTTP und OAuth folgen in Phase 7.
