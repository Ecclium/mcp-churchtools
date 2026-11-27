# Betrieb über HTTP

**In Entwicklung.** Es gibt noch keine veröffentlichte Version. Diese Seite beschreibt, wie Sie Ecclium aus dem Quellcode als Server über HTTP starten und Claude Code mit einem Bearer-Token anbinden. Über HTTP läuft der Server als eigener, langlebiger Prozess, und Clients verbinden sich mit ihm über eine Adresse wie `http://127.0.0.1:8765/mcp`.

In dieser Version liest der Server über HTTP nur. Schreib-Tools bietet er nicht an, und mit `ECCLIUM_READ_ONLY=false` startet er nicht. Schreiben über HTTP kommt mit einer späteren Version, bis dahin schreibt Ecclium nur im Betrieb über stdio ([Betrieb über stdio](stdio.md)). Ein Image, eine Vorlage für Docker Compose und den Weg über einen Reverse-Proxy bringen spätere Schritte dieser Phase.

Ecclium ist ein unabhängiges Projekt und steht in keiner Verbindung zum Hersteller von ChurchTools.

Geprüft am 27.11.2026 unter macOS mit Claude Code 2.1.332 und einem Server auf `127.0.0.1` gegen eine Testinstanz mit synthetischen Daten: Claude Code verband sich mit dem Skript unter «Claude Code», rief `ct_whoami` und die Liste der Kategorien des Wikis auf, und das Audit nannte den Akteur des Tokens.

## Voraussetzungen

- Ein gebauter Checkout wie unter «Bauen» in [Betrieb über stdio](stdio.md), mit dem absoluten Pfad von Node.js aus `mise which node`.
- Ein eigenes Dienstkonto in ChurchTools mit einer Token-Datei, wie unter «Token-Datei» in [Betrieb über stdio](stdio.md) und in [Dienstkonto in ChurchTools](dienstkonto.md). Über HTTP nimmt Ecclium das Token nur aus einer Datei, nie aus der Umgebung.
- Ein Zustandsordner Ihres Benutzers mit den Rechten 700, der zwischen zwei Starts erhalten bleibt. Darin liegen die Audit-Datei, die Zähler des Lesebudgets und der Tag der letzten Verwendung jedes Bearer-Tokens.

Auf dieser Seite steht `ecclium` für `/pfad/zu/node /pfad/zum/checkout/packages/cli/dist/bin.js`.

## Bearer-Tokens

Jeder Client meldet sich mit einem eigenen Bearer-Token an. Ein Token hat die Form `ecclium_mcp_` mit 49 Zeichen dahinter, gilt standardmässig 180 Tage und hat den Scope `read`. In der Datei aus `ECCLIUM_HTTP_TOKENS_FILE` steht je Token nur sein Name, sein SHA-256, seine Scopes und seine Tage, nie das Token selbst ([ADR 0074](../adr/0074-bearer-tokens-und-oauth-pruefung.md)).

Ein neues Token geht allein auf stdout. Schreiben Sie es direkt in eine Datei, die nur Ihr Benutzer lesen kann, damit es weder im Terminal noch in der History der Shell steht:

```sh
export ECCLIUM_HTTP_TOKENS_FILE=/pfad/zur/http-tokens.yaml
(umask 077 && ecclium token create claude-code-buero > /pfad/zum/client-token)
```

Der Name ist neutral, nie der Name einer Person: Er steht im Audit als Akteur `bearer:claude-code-buero`. Die Klammern mit `umask 077` sorgen dafür, dass die Datei des Clients die Rechte 600 bekommt.

- `ecclium token list` zeigt Name, Scopes, die Tage jedes Tokens und mit `ECCLIUM_STATE_DIR` den Tag seiner letzten Verwendung, nie einen Hash.
- `ecclium token rotate <Name>` legt ein neues Token mit denselben Scopes an. Die bisherigen gelten noch höchstens sieben Tage, damit Sie den Client in Ruhe umstellen können.
- `ecclium token revoke <Name>` entfernt jedes Token dieses Namens. Der Server liest die Datei bei jeder Anfrage neu, ein Widerruf wirkt deshalb ab der nächsten Anfrage, ohne Neustart.

Ist die Datei im Betrieb ungültig oder nicht lesbar, etwa nach einer Änderung von Hand, endet jede Anmeldung mit 401, bis sie wieder gilt. So hebt eine beschädigte Datei nie einen Widerruf auf.

## Starten

```sh
export ECCLIUM_CHURCHTOOLS_URL=https://example.church.tools
export ECCLIUM_CHURCHTOOLS_TOKEN_FILE=/pfad/zur/token-datei
export ECCLIUM_STATE_DIR=/pfad/zum/zustandsordner
export ECCLIUM_HTTP_TOKENS_FILE=/pfad/zur/http-tokens.yaml
ecclium serve-http
```

Ohne weitere Angaben bindet der Server an `127.0.0.1` und den Port `8765` und nimmt in den Kopfzeilen `Host` und `Origin` nur die Namen von Loopback mit diesem Port an. Die übrigen Variablen, etwa `ECCLIUM_TOOLSETS` und `ECCLIUM_REDACTION`, gelten wie über stdio ([Konfiguration](../configuration.md)).

Bevor der Server einen Port belegt, prüft er die Konfiguration, die Datei der Tokens, die Audit-Datei und den Ordner der Zähler. Jede dieser Prüfungen beendet den Start mit 78 und einem Satz auf Deutsch, der sagt, was fehlt. Ebenso endet der Start mit 78, wenn der Port belegt ist oder das System die Adresse nicht zulässt. Mit `ECCLIUM_EGRESS_PROXY` prüft er zuerst einen Tunnel zu ChurchTools und endet mit 69, wenn der Proxy keinen gibt. Hält die Datei kein Token, das heute gilt, startet der Server trotzdem und sagt, dass jede Anmeldung mit 401 enden wird.

Läuft der Server, schreibt er auf stderr, unter welcher Adresse er Anfragen annimmt. Danach folgen nur noch Zeilen des Logs und die Kopie des Audits, je eine Zeile JSON.

### Andere Adresse und Hosts

- `ECCLIUM_HTTP_PORT` wählt einen anderen Port von 1 bis 65'535.
- `ECCLIUM_HTTP_ADDRESS` nimmt eine ausgeschriebene IP-Adresse, etwa `0.0.0.0` in einem Container. Ausserhalb von Loopback braucht sie `ECCLIUM_ALLOWED_HOSTS`, sonst bricht der Start ab: Eine fremde Webseite könnte den Server sonst über DNS-Rebinding ansprechen.
- `ECCLIUM_ALLOWED_HOSTS` nennt die Hosts, unter denen Clients den Server erreichen, etwa `mcp.example.org` oder `mcp.example.org:8443`. Ein Eintrag ohne Port erlaubt nur den Namen ohne Port. Gesetzt gelten nur diese Einträge, auch die Namen von Loopback nur, wenn die Liste sie nennt.

Der Server selbst spricht kein TLS. Wer ihn über das lokale Netz oder das Internet erreichbar macht, setzt einen Reverse-Proxy mit TLS davor; die Anleitung dazu folgt mit dem Bundle für das Self-Hosting.

### Beenden

SIGTERM oder Ctrl+C schliessen den Server: Er nimmt keine neue Verbindung mehr an, laufende Anfragen enden noch, höchstens zehn Sekunden lang, dann schliesst er die Audit-Datei mit dem Anker ihrer Kette. Der Befehl endet mit 143 nach SIGTERM und 130 nach SIGINT. Ein zweites Signal beendet ihn sofort. SIGHUP behandelt der Server nicht selbst, so dass ein Start mit `nohup` das Schliessen des Terminals übersteht.

## Claude Code

Claude Code liest den Kopf `Authorization` am besten aus einem kleinen Skript, damit das Token nicht im Klartext in der Konfiguration von Claude Code steht. Legen Sie das Skript mit den Rechten 700 an:

```sh
(umask 077 && cat > /pfad/zu/ecclium-header.sh <<'SKRIPT'
#!/bin/sh
printf '{"Authorization":"Bearer %s"}\n' "$(cat /pfad/zum/client-token)"
SKRIPT
)
chmod 700 /pfad/zu/ecclium-header.sh
```

Tragen Sie dann den Server für Ihren Benutzer ein:

```sh
claude mcp add-json --scope user ecclium-http '{"type":"http","url":"http://127.0.0.1:8765/mcp","headersHelper":"/pfad/zu/ecclium-header.sh"}'
```

Claude Code führt das Skript bei jeder Verbindung aus und setzt den Kopf, den es ausgibt. In der Konfiguration stehen nur die Adresse und der Pfad des Skripts. Mit `claude mcp add --header` stünde das Token dagegen im Klartext in der Datei von Claude Code.

## Grenzen dieser Version

- Nur lesend, siehe oben. Ein Token mit dem Scope `write` schaltet über HTTP nichts frei.
- Nur statische Bearer-Tokens. Den OAuth-Modus, mit dem sich claude.ai und ChatGPT anmelden, bringt ein späterer Schritt dieser Phase.
- Ein Mandant, `default`, wie über stdio.
- Fehlversuche stehen mit ihrem Grund im Log als `http_auth_refused`, noch nicht im Audit, und es gibt noch kein Rate-Limit je Adresse und Token. Beides kommt mit dem nächsten Schritt.
- Keine Endpunkte `/healthz`, `/readyz` und `/metrics`.

## Tag der letzten Verwendung

Nach jeder gelungenen Anmeldung hält der Server den UTC-Tag fest, an dem das Token benutzt wurde, im Ordner `quota` des Zustandsordners in der Datei `default.last-use.json`, ohne Uhrzeit und ohne Adresse. `ecclium token list` zeigt ihn, damit vergessene Tokens auffallen. Beim Start und an jedem neuen UTC-Tag entfernt der Server Tage, die mehr als 365 Tage zurückliegen, und die Datei, wenn kein Tag übrig bleibt. Ein Tag bleibt so höchstens ein Jahr, auch wenn das Token nie wieder benutzt wird ([Datenschutz](../privacy.md)).

## Audit

Jeder Aufruf eines Tools steht wie über stdio zuerst in der Audit-Datei unter `ECCLIUM_STATE_DIR/audit` und danach als Kopie auf stderr, mit dem Akteur `bearer:<Name>` des Tokens. Frist, Löschung, Kette und Anker gelten wie über stdio, ebenso `ecclium audit verify` und `ecclium audit show` (siehe «Audit-Datei» in [Betrieb über stdio](stdio.md)).
