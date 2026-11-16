# ADR 0074: Statische Bearer-Tokens und Prüfung im OAuth-Modus: Format, Ablauf, Rotation, Widerruf, Subjekt im Audit und Prüfliste für JWT, ergänzt ADR 0037

- Status: Vorgeschlagen
- Datum: 16.11.2026
- Fällt vor: Phase 7

## Kontext

[ADR 0037](0037-anmeldung-am-server.md) legt fest, wie sich Clients über HTTP am Server anmelden: mit statischen Bearer-Tokens oder im OAuth-Modus mit JWT-Zugriffstokens eines Anmeldediensts, den der Betreiber stellt. Es lässt offen, wie die Tokens aussehen, wo der Server sie hält und wie Ablauf und Rotation gehen, und nennt die Prüfung im OAuth-Modus nur in groben Zügen. Am 10.10.2026 ist entschieden: Ein statisches Token läuft in der Voreinstellung nach 180 Tagen ab, und eine Rotation überlappt sieben Tage, umgesetzt mit einem ADR, das ADR 0037 ergänzt, vor dem Code für HTTP (`docs/STATUS.md`, Grundsatzentscheid 12; Threat Model T3).

Weitere Bedingungen:

- **Prinzipal:** Über HTTP ist der Prinzipal das Subjekt des Tokens. Es wird `actor.id` im Audit und bestimmt die Pseudonyme der Stufe `strict` ([ADR 0026](0026-klassifizierte-ausgabeschemas.md), [ADR 0069](0069-stufe-strict.md)). Ein Anmeldedienst kann als Subjekt eine E-Mail-Adresse setzen. Das Schema des Audits nimmt als Kennung eines Akteurs nur `^[a-z][a-z0-9_-]{0,31}(?::[a-z0-9_-]{1,64})?$` an (`schemas/audit-event.v1.json`). Über stdio ist das Subjekt eine neutrale Bezeichnung nach `^[a-z][a-z0-9-]{0,31}$` ([ADR 0055](0055-konfiguration-identitaet.md)).
- **Speicher:** `/config` ist im Container nur lesbar ([ADR 0036](0036-runner-container-vertrag.md)). Der `QuotaStore` löscht gewöhnliche Zähler am nächsten Tag und hält nur die Zähler der Freigaben 15 und die der Läufe 32 Tage ([ADR 0063](0063-quotastore-als-datei.md), [ADR 0029](0029-write-guard.md), [ADR 0034](0034-zeitplan-semantik.md)).
- **Ein Weg nach draussen:** Verbindungen öffnet nur der Ort `egress` ([ADR 0056](0056-ausgehender-weg.md)). Metadaten und Schlüssel eines Anmeldediensts kommen deshalb über den `HttpTransport`, mit Issuer und `jwks_uri` auf der Positivliste ([ADR 0009](0009-positivliste-ausgehend.md)).
- **jose** 6.2.17 vom 09.11.2026 steht unter MIT, ohne Abhängigkeiten und mit Herkunftsnachweis (Registry von npm, geprüft am 16.11.2026). Seine Funktion für entfernte Schlüssel holt sie selbst mit `fetch`, eine lokale Menge von Schlüsseln nimmt sie aus dem Speicher.
- Ein Fehlversuch soll im Audit stehen, ohne dass das Audit Inhalte oder Zugangsdaten trägt ([ADR 0028](0028-audit-ereignis-und-datei-sink.md)).

## Optionen

1. **Subjekt so, wie der Anmeldedienst es setzt, nur in neutraler Form:** Ein Subjekt, das nicht passt, weist der Server ab. Die Person hinter einem Eintrag im Audit findet der Betreiber direkt in seinem Anmeldedienst. Dienste, die eine E-Mail-Adresse als Subjekt setzen, muss der Betreiber umstellen.
2. **Subjekt nur als Hash mit einem Schlüssel des Servers:** Jeder Anmeldedienst geht, aber die Zuordnung zu einer Person braucht einen eigenen Befehl, und es gibt ein Geheimnis mehr, das gesichert werden muss.

Für den Tag der letzten Verwendung: in der Datei der Tokens unter `/config`, die im Container nur lesbar ist, oder im Zustandsordner.

## Entscheid

Gewählt ist die erste Option, dazu gilt:

- **Format:** `ecclium_mcp_`, dann 43 Zeichen Base62 aus 32 Bytes eines sicheren Zufallsgenerators (256 Bit), dann 6 Zeichen Base62 mit der Prüfsumme CRC32 über die 43 Zeichen. Der Server prüft Präfix, Länge und Prüfsumme, bevor er nachschlägt. Eine Regel in `.gitleaks.toml` erkennt das Muster, mit einem Beispiel, das sie findet, und einem, das sie nicht findet. Dasselbe Muster wird für die Push Protection von GitHub angemeldet, sobald das Paket öffentlich ist.
- **Datei der Tokens:** `ECCLIUM_HTTP_TOKENS_FILE` nennt eine YAML-Datei unter `/config`, nur lesbar für den Server. Je Eintrag: Name, SHA-256 des ganzen Tokens, Scopes (`read` oder `read` und `write`), `createdAt` und `expiresAt` als Tag. Das Token selbst steht nirgends, es erscheint nur einmal in der Ausgabe von `ecclium token create`. Der Server liest die Datei neu, wenn sie sich ändert, ohne Neustart. Er vergleicht den Hash in konstanter Zeit.
- **Name eines Tokens:** neutral nach `^[a-z][a-z0-9-]{0,31}$`, etwa `claude-code-buero`. Die Doku rät von Namen von Personen ab.
- **Befehle:** `ecclium token create <Name>` mit den Scopes und einer Dauer von höchstens 365 Tagen, voreingestellt 180. `ecclium token rotate <Name>` erzeugt ein neues Token und setzt den Ablauf des alten auf höchstens sieben Tage; in dieser Zeit stehen zwei Einträge mit demselben Namen in der Datei. `ecclium token revoke <Name>` entfernt alle Einträge des Namens, der Server weist sie ab der nächsten Anfrage ab. `ecclium token list` zeigt Name, Scopes, Tage und letzte Verwendung, nie einen Hash. Die Befehle laufen dort, wo `config/` schreibbar ist, im Bundle im Container `cli`.
- **Letzte Verwendung:** Der Tag der letzten Anmeldung je Name liegt im Zustandsordner, als eigene Art im `QuotaStore`, ein Tag je Name und Mandant, höchstens einmal am Tag geschrieben. Er bleibt so lange, wie der Name in der Datei steht, und höchstens 365 Tage. Das ist eine neue Art von Zähler im bestehenden Port, kein neuer Port und keine neue Ausnahme der Persistenz: nur Tage, keine Inhalte. `ecclium doctor` warnt 30 Tage vor dem Ablauf eines Tokens und nennt Tokens, die seit 90 Tagen nicht benutzt wurden.
- **Scopes:** `read` erlaubt jedes Lese-Tool, das der Server anbietet. Ein Tool mit `capability: write` braucht `write`. Ohne `write` zeigt `tools/list` keine Schreib-Tools, und ein Aufruf eines solchen endet mit 403, `insufficient_scope` und `scope="write"` in `WWW-Authenticate` ([ADR 0037](0037-anmeldung-am-server.md)). Mit `ECCLIUM_READ_ONLY=true` gibt es keine Schreib-Tools, gleich welche Scopes ein Token trägt.
- **Akteur im Audit:** Ein Bearer-Token ergibt den Akteur `bearer:<Name>`, ein JWT den Akteur `oauth:<Subjekt>`, beide mit der Art `user`. So ergeben ein Token und ein Subjekt mit gleichem Text nie denselben Akteur. Ein Subjekt muss `^[a-z0-9_-]{1,64}$` erfüllen, etwa eine UUID in Kleinbuchstaben oder eine Zahl. Ein Subjekt mit `@`, Punkt, Leerzeichen oder Grossbuchstaben weist der Server mit 401 ab und schreibt eine Logzeile ohne den Wert. Die Doku sagt, wie gängige Anmeldedienste ein solches Subjekt setzen. Pseudonyme folgen dem Akteur wie bisher.
- **Fehlversuche im Audit:** Jede abgewiesene Anmeldung schreibt eine Zeile vom neuen Typ `auth` mit `outcome: denied` und einem Grund aus einer festen Liste (fehlt, Form, Prüfsumme, unbekannt, abgelaufen, widerrufen, Signatur, Aussteller, Audience, Zeit, Algorithmus, Subjekt, Scope). Ist der Name eines Tokens bekannt, nennt sie den Akteur `bearer:<Name>`, sonst `unauthenticated`. Sie nennt nie eine IP-Adresse, nie ein Token oder einen Teil davon und nie einen Wert aus einem JWT. Die Adresse kennen nur die Zähler des Rate-Limits im Arbeitsspeicher und das Log des Reverse-Proxys ([ADR 0073](0073-betrieb-ueber-http.md)). Nach dem Rate-Limit schreibt der Server keine weitere Zeile, er zählt nur in den Metriken. Der Typ `auth` erweitert die Liste der Typen im Ereignis v1.
- **Beide Wege zugleich:** Ein Server kann statische Tokens und den OAuth-Modus zugleich annehmen, etwa Claude Code mit Token und claude.ai mit OAuth. Das Präfix entscheidet, welcher Weg prüft.
- **Prüfliste im OAuth-Modus**, jeder Punkt mit einem Negativtest:
  - Die Algorithmen stehen in der Konfiguration, voreingestellt `ES256` und `EdDSA`, auf Wunsch `RS256`. `alg` im Kopf des Tokens wählt nie den Algorithmus, `none` wird immer abgewiesen.
  - Erwartet wird `typ: at+jwt` (RFC 9068). Setzt der Anmeldedienst es nicht, muss der Betreiber das ausdrücklich erlauben.
  - `aud` enthält genau die kanonische Adresse des Servers, ohne Toleranz für einen Pfad. `iss` gleicht dem konfigurierten Aussteller Byte für Byte.
  - `exp` und `nbf` werden geprüft, mit höchstens 60 Sekunden Abweichung der Uhren.
  - Beim Start liest der Server die Metadaten des Anmeldediensts und daraus `jwks_uri` und pinnt sie. Die Schlüssel hält er höchstens eine Stunde und holt sie bei einer unbekannten `kid` höchstens alle fünf Minuten neu, damit niemand ihn zu Abrufen zwingen kann. Gelingt der erste Abruf nicht, endet der Start mit 69.
  - Scopes des Anmeldediensts bildet die Konfiguration auf `read` und `write` ab. Ein Token ohne bekannten Scope hat keinen.
- **jose:** Laufzeitabhängigkeit im Kern, exakt gepinnt, nur zur Prüfung mit einer lokalen Menge von Schlüsseln. Metadaten und Schlüssel holt der `HttpTransport` mit dem Zweck `oauth`. Die Funktion von jose für entfernte Schlüssel benutzt Ecclium nie, weil sie am einzigen Weg nach draussen vorbeiginge.
- **Metadaten nach RFC 9728:** unter `/.well-known/oauth-protected-resource` mit der kanonischen Adresse, dem Aussteller und den Scopes. Eine Antwort 401 im OAuth-Modus nennt sie in `WWW-Authenticate` mit `resource_metadata`.
- **Kein Weiterreichen:** Kein Token eines Clients geht je an ChurchTools ([ADR 0023](0023-kein-token-passthrough.md)).

## Konsequenzen

- Ein Token in einem öffentlichen Repository erkennen Scanner ohne Zusammenhang am Präfix, nach der Anmeldung des Musters auch die Push Protection von GitHub.
- Ein Widerruf wirkt ab der nächsten Anfrage. Eine Rotation lässt dem Client sieben Tage für das neue Token.
- Ein Anmeldedienst, der eine E-Mail-Adresse als Subjekt setzt, funktioniert erst, wenn der Betreiber ihn umstellt. Dafür steht im Audit nie eine E-Mail-Adresse, und es braucht kein weiteres Geheimnis.
- Der Zustandsordner trägt neu den Tag der letzten Verwendung je Name eines Tokens. `docs/privacy.md` nennt das.
- Wer das Schema des Audits genau prüft, muss den Typ `auth` annehmen. Vor v0.1.0 gibt es noch keine Leser ausser Ecclium selbst.
- Restrisiken:
  - Ein statisches Token steht beim Client im Klartext, etwa in der Konfiguration von Claude Code. Wer es liest, benutzt den Server bis zum Ablauf oder Widerruf (T3).
  - Ein Name in der Form `max-mustermann` passt auf das Muster, wie beim Subjekt über stdio ([ADR 0055](0055-konfiguration-identitaet.md)).
  - Nach einem Widerruf eines Schlüssels beim Anmeldedienst nimmt der Server Tokens mit diesem Schlüssel noch bis zu einer Stunde an.
  - Ein Subjekt ist nur so neutral, wie der Anmeldedienst es vergibt; das Muster schliesst eine Kennung, die selbst einen Namen trägt, nicht aus.
