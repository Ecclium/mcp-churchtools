# ADR 0023: Kein Token-Passthrough, OAuth-Delegation für Pro und gehosteten Betrieb

- Status: Angenommen am 02.10.2026
- Datum: 30.09.2026
- Fällt vor: Phase 1

## Kontext

Ecclium wird von MCP-Clients aufgerufen und greift selbst auf ChurchTools zu. Es gibt also zwei Arten von Zugangsdaten: die eines Clients gegenüber Ecclium und die von Ecclium gegenüber ChurchTools. Naheliegend wäre, dass ein Client sein eigenes ChurchTools-Token mitschickt und der Server es weiterreicht. Dann hätte jede Anfrage genau die Rechte der Person, die fragt.

Die MCP-Spezifikation 2026-07-28 schliesst das aus. Auf der Seite «Authorization», Abschnitt «Token Handling», darf ein MCP-Server nur Tokens annehmen, die für ihn selbst ausgestellt sind: «MCP servers MUST NOT accept or transit any other tokens». Die Seite «Authorization Security Considerations», Abschnitt «Access Token Privilege Restriction», verlangt, dass ein Server für eine API dahinter ein eigenes Token benutzt und das Token des Clients nicht weiterreicht.

Zu ChurchTools, laut ChurchTools Academy und Änderungsprotokoll, abgerufen am 30.09.2026:

- Die REST-API nimmt ein Login-Token in der Kopfzeile `Authorization: Login <token>` an. Das Token authentifiziert den Benutzer, dem es gehört (Academy, Seite «API Authentifizierung», Abschnitt «Login-Token»). Eine Einschränkung auf weniger Rechte als die des Kontos beschreibt die Dokumentation nicht, ein eigenes Dienstkonto ebenso wenig.
- Seit Version 3.135.0 vom 03.08.2026 dürfen OAuth-Anwendungen mit ausdrücklicher Freigabe, Scope `api`, auf die REST-API zugreifen, nur im Rahmen der Rechte des angemeldeten Benutzers (Änderungsprotokoll «Web v3.135.0», Abschnitt «Verbesserungen»; Academy, Seite «Was ist OAuth? (SSO in Drittsysteme)», Abschnitt «Häufige Fragen (FAQ)»). Als OAuth-Anbieter dient ChurchTools schon seit Version 3.116.0 (Änderungsprotokoll «Web v3.116.0», Abschnitt «Verbesserungen»).
- Eine OAuth-Anwendung richtet jemand mit den nötigen Rechten in den Einstellungen der jeweiligen Instanz ein, mit der Redirect-URI des Clients (Academy, Seite «OAuth-Authentifizierung mit ChurchTools», Abschnitte «OAuth-Server vorbereiten» und «OAuth-Server fertigstellen»).
- Nicht dokumentiert sind die Pfade der Endpunkte, PKCE, Refresh-Tokens, Laufzeiten, das Format der Tokens und Metadaten unter `.well-known` (`docs/research/churchtools-api.md`, Frage F15).

Festzulegen ist, ob Ecclium Tokens von Clients an ChurchTools weiterreicht und wie Rechte pro Person entstehen.

## Optionen

1. **Token-Passthrough:** Der Client schickt ein ChurchTools-Token mit, der Server reicht es weiter. Rechte pro Person ohne eigene Verwaltung, aber die Spezifikation verbietet es. Ein Token mit allen Rechten eines Kontos läge in jedem Client, der Server könnte nicht prüfen, für wen es ausgestellt wurde, und Mandant und Protokoll hingen an einem fremden Token.
2. **Nur Dienstkonten:** Ecclium greift immer mit einem eigenen Konto zu. Einfach und passend für eine Gemeinde, aber alle, die einen Server benutzen, teilen dieselben Rechte.
3. **Dienstkonten im freien Kern, Rechte pro Person über OAuth-Delegation im Zusatzmodul und im gehosteten Betrieb,** nie Token-Passthrough.

## Entscheid

Gewählt ist die dritte Option.

- **Kein Token-Passthrough:** Ecclium nimmt kein ChurchTools-Token von einem Client an und reicht keines weiter. Die Anmeldung eines Clients am Server (ADR 0037) und der Zugang des Servers zu ChurchTools bleiben getrennt. Ein Token, mit dem sich ein Client anmeldet, wird nie zu einem Zugang zu ChurchTools.
- **Freier Kern:** Ecclium greift mit dem Login-Token eines eigenen Kontos zu, das nur Ecclium benutzt und nur die nötigen Rechte hat, hier Dienstkonto genannt. Server und Runner haben getrennte Dienstkonten. Das Konto des Servers hat nur Leserechte, solange der Server nur liest, und das ist voreingestellt (ADR 0024). Schaltet der Betreiber Schreib-Tools frei, bekommt es Schreibrechte nur für die Ziele dieser Tools. Das Konto des Runners hat nur die Rechte, die seine Routinen brauchen: Es liest nur deren Quellen und schreibt nur in deren Ziele. Tokens kommen aus Dateien. Nur im lokalen Betrieb über stdio ist eine Umgebungsvariable erlaubt, mit einer Warnung beim Start. Das Token steht nur in der Kopfzeile, nie in einer URL, und Ecclium fordert bei ChurchTools keine Sitzung an.
- **Rechte pro Person:** Im Zusatzmodul und im gehosteten Betrieb meldet sich eine Person über OAuth bei ChurchTools an und gibt den Zugriff auf die API frei. Das Token von ChurchTools gehört dann zu ihrer Identität am Server von Ecclium. Es bleibt beim Server und geht nie an den Client. Der Runner benutzt weiterhin ein Dienstkonto der Gemeinde.
- **Nicht geraten:** Was ChurchTools zu OAuth nicht dokumentiert, setzt Ecclium nicht voraus. Die offenen Einzelheiten werden geklärt, bevor der Code dafür entsteht.

## Konsequenzen

- In einer Installation des freien Kerns haben alle, die den Server benutzen, dieselben Rechte: die des Dienstkontos. Die Betreiber wählen sie entsprechend eng.
- Die Anmeldung über OAuth braucht in jeder Instanz eine OAuth-Anwendung, die jemand mit den nötigen Rechten dort einrichtet. Im gehosteten Betrieb gehört das zum Einrichten jeder Gemeinde.
- Restrisiken: Ein Login-Token wirkt ohne zweiten Faktor und trägt alle Rechte seines Kontos. Wer eine Token-Datei liest, handelt als dieses Konto, bis das Token in ChurchTools ungültig ist. Ob ein erneuertes Token das alte sofort ungültig macht, beschreibt die Dokumentation nicht. Eingrenzen lassen sich nur die Rechte des Kontos selbst.
- Offen: Pfade der Endpunkte, PKCE, Refresh-Tokens, Laufzeiten und Format der OAuth-Tokens von ChurchTools und ob Metadaten unter `.well-known` bereitstehen. Das wird bis Phase 7 oder bis zum Zusatzmodul geklärt, aus der Dokumentation oder mit einer Probe an einer Testinstanz.

## Umsetzung

- gitleaks erkennt Login-Tokens in einer Kopfzeile, in einer URL und in einer Zuweisung: Regeln `churchtools-login-token-header`, `churchtools-login-token-query` und `churchtools-token-assignment` in `.gitleaks.toml`.
- Der ChurchTools-Client, der Typ für Geheimnisse und das Lesen der Tokens aus Dateien folgen in Phase 1.
- Die Rechte eines Kontos kommen in ChurchTools auch aus seinem Personenstatus. Auf der Testinstanz aus ADR 0049 brachte jeder vorgegebene Status bis auf einen eigene Rechte mit, unter anderem auf Personendaten und Kalender. Ein Dienstkonto erhält deshalb einen eigenen Personenstatus ohne Berechtigungen und direkt nur die Rechte seiner Aufgabe. Erst so zeigte `GET /api/permissions/global` beim lesenden Konto des Spikes nur die vorgesehenen Rechte (`docs/research/churchtools-api.md`, F5). Die Anleitung für Betreiber nimmt das auf.
- Ein erneuertes Login-Token macht das alte ungültig, auf der Testinstanz etwa zehn Sekunden nach dem Erneuern geprüft (F23). Jede Anfrage mit einem gültigen Login-Token erhält dort Cookies (F3). Wie der Client damit umgeht, legt der Bau des Clients in Phase 1 fest.
