# ADR 0023: Kein Token-Passthrough, OAuth-Delegation für Pro und gehosteten Betrieb

- Status: Vorgeschlagen
- Datum: 30.09.2026
- Fällt vor: Phase 1

## Kontext

Ecclium wird von MCP-Clients aufgerufen und greift selbst auf ChurchTools zu. Es gibt also zwei Arten von Zugangsdaten: die eines Clients gegenüber Ecclium und die von Ecclium gegenüber ChurchTools. Naheliegend wäre, dass ein Client sein eigenes ChurchTools-Token mitschickt und der Server es weiterreicht. Dann hätte jede Anfrage genau die Rechte der Person, die fragt.

Die MCP-Spezifikation 2026-07-28 schliesst das aus. Auf der Seite «Authorization», Abschnitt «Token Handling», darf ein MCP-Server nur Tokens annehmen, die für ihn selbst ausgestellt sind: «MCP servers MUST NOT accept or transit any other tokens». Die Seite «Authorization Security Considerations», Abschnitt «Access Token Privilege Restriction», verlangt, dass ein Server für eine API dahinter ein eigenes Token benutzt und das Token des Clients nicht weiterreicht.

Zu ChurchTools, laut ChurchTools Academy und Änderungsprotokoll, abgerufen am 30.09.2026:

- Die REST-API nimmt ein Login-Token im Header `Authorization: Login <token>` an. Das Token authentifiziert den Benutzer, dem es gehört (Seite «API Authentifizierung»). Eine Einschränkung auf weniger Rechte als die des Kontos ist nicht dokumentiert. Ein eigenes Dienstkonto kennt ChurchTools nicht. Für Anbindungen empfiehlt die Academy eine eigene Person mit genau den nötigen Rechten.
- Seit Version 3.135.0 vom 03.08.2026 dürfen OAuth-Anwendungen mit ausdrücklicher Freigabe, Scope `api`, auf die REST-API zugreifen, nur im Rahmen der Rechte des angemeldeten Benutzers. Als OAuth-Anbieter dient ChurchTools schon seit Version 3.116.0.
- Eine OAuth-Anwendung richtet jemand mit den nötigen Rechten in den Einstellungen der jeweiligen Instanz ein, mit der Redirect-URI des Clients (Seite «OAuth-Authentifizierung mit ChurchTools»).
- Nicht dokumentiert sind die Pfade der Endpunkte, PKCE, Refresh-Tokens, Laufzeiten und das Format der Tokens. Metadaten unter `.well-known` gibt es nicht (`docs/research/churchtools-api.md`, Frage F15).

Festzulegen ist, ob Ecclium Tokens von Clients an ChurchTools weiterreicht und wie Rechte pro Person entstehen.

## Optionen

1. **Token-Passthrough:** Der Client schickt ein ChurchTools-Token mit, der Server reicht es weiter. Rechte pro Person ohne eigene Verwaltung, aber die Spezifikation verbietet es. Ein Token mit allen Rechten eines Kontos läge in jedem Client, der Server könnte nicht prüfen, für wen es ausgestellt wurde, und Mandant und Protokoll hingen an einem fremden Token.
2. **Nur Dienstkonten:** Ecclium greift immer mit einem eigenen Konto zu. Einfach und passend für eine Gemeinde, aber alle, die einen Server benutzen, teilen dieselben Rechte.
3. **Dienstkonten im freien Kern, Rechte pro Person über OAuth-Delegation im Zusatzmodul und im gehosteten Betrieb,** nie Token-Passthrough.

## Entscheid

Gewählt ist die dritte Option.

- **Kein Token-Passthrough:** Ecclium nimmt kein ChurchTools-Token von einem Client an und reicht keines weiter. Die Anmeldung eines Clients am Server (ADR 0037) und der Zugang des Servers zu ChurchTools bleiben getrennt. Ein Token, mit dem sich ein Client anmeldet, wird nie zu einem Zugang zu ChurchTools.
- **Freier Kern:** Ecclium greift mit dem Login-Token eines eigenen Kontos zu, das nur Ecclium benutzt und nur die nötigen Rechte hat, hier Dienstkonto genannt. Der Server liest mit einem Konto, der Runner schreibt mit einem eigenen, enger berechtigten. Tokens kommen aus Dateien. Nur im lokalen Betrieb über stdio ist eine Umgebungsvariable erlaubt, mit einer Warnung beim Start. Das Token steht nur im Header, nie in einer URL, und Ecclium fordert keine Session an.
- **Rechte pro Person:** Im Zusatzmodul und im gehosteten Betrieb meldet sich eine Person über OAuth bei ChurchTools an und gibt den Zugriff auf die API frei. Das Token von ChurchTools gehört dann zu ihrer Identität am Server von Ecclium. Es bleibt beim Server und geht nie an den Client. Der Runner benutzt weiterhin ein Dienstkonto der Gemeinde.
- **Nicht geraten:** Was ChurchTools zu OAuth nicht dokumentiert, setzt Ecclium nicht voraus. Die offenen Einzelheiten werden geklärt, bevor der Code dafür entsteht.

## Konsequenzen

- In einer Installation des freien Kerns haben alle, die den Server benutzen, dieselben Rechte: die des Dienstkontos. Die Betreiber wählen sie entsprechend eng.
- Die Anmeldung über OAuth braucht in jeder Instanz eine OAuth-Anwendung, die jemand mit den nötigen Rechten dort einrichtet. Im gehosteten Betrieb gehört das zum Einrichten jeder Gemeinde.
- Restrisiken: Ein Login-Token wirkt ohne zweiten Faktor und trägt alle Rechte seines Kontos. Wer eine Token-Datei liest, handelt als dieses Konto, bis das Token in ChurchTools erneuert wird. Eingrenzen lassen sich nur die Rechte des Kontos selbst.
- Offen: Pfade der Endpunkte, PKCE, Refresh-Tokens, Laufzeiten und Format der OAuth-Tokens von ChurchTools. Sie werden bis Phase 7 oder bis zum Zusatzmodul geklärt, aus der Dokumentation oder mit einer Probe an einer Testinstanz.

## Umsetzung

- gitleaks erkennt Login-Tokens in einer Kopfzeile, in einer URL und in einer Zuweisung: Regeln `churchtools-login-token-header`, `churchtools-login-token-query` und `churchtools-token-assignment` in `.gitleaks.toml`.
- Der ChurchTools-Client, der Typ für Geheimnisse und das Lesen der Tokens aus Dateien folgen in Phase 1.
