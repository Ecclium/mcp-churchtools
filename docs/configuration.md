# Konfiguration

<!-- Erzeugt mit `pnpm docs:generate` aus der Tabelle der Variablen. Nicht von Hand ändern. -->

Diese Seite entsteht mit `pnpm docs:generate` aus der Tabelle der Variablen im Kern ([ADR 0055](adr/0055-konfiguration-identitaet.md)). Ein Test vergleicht sie mit dem Code. Ändern Sie sie deshalb nicht von Hand.

Ecclium liest seine Konfiguration aus Variablen der Umgebung. Jede trägt das Präfix `ECCLIUM_`. Eine unbekannte oder falsch geschriebene Variable mit diesem Präfix bricht den Start ab. `ecclium config check` zeigt jede Einstellung mit ihrer Herkunft und prüft die Konfiguration, ohne ChurchTools anzufragen.

| Variable | Werte | Voreinstellung | Geheimnis | Nur über stdio |
| --- | --- | --- | --- | --- |
| `ECCLIUM_CHURCHTOOLS_URL` | Adresse mit `https` | keine | nein | nein |
| `ECCLIUM_CHURCHTOOLS_TOKEN_FILE` | absoluter Pfad | keine | nein | nein |
| `ECCLIUM_CHURCHTOOLS_TOKEN` | Login-Token | keine | ja | ja |
| `ECCLIUM_CHURCHTOOLS_REQUESTS_PER_MINUTE` | ganze Zahl von 1 bis 500 | `300` | nein | nein |
| `ECCLIUM_READ_ONLY` | `true`, `false` | `true` | nein | nein |
| `ECCLIUM_REDACTION` | `standard`, `off`, `strict` | `standard` | nein | nein |
| `ECCLIUM_TOOLSETS` | Liste aus `persons`, `events`, `calendars`, `wiki`, `songs`, `docs`, `api`, mit Komma getrennt, oder `all` für alle ausser `api`, oder `all,api` | leer | nein | nein |
| `ECCLIUM_STATE_DIR` | absoluter Pfad | keine | nein | ja |
| `ECCLIUM_STDIO_SUBJECT` | Bezeichnung mit höchstens 32 Zeichen | `local-stdio` | nein | ja |
| `ECCLIUM_LOG_LEVEL` | `debug`, `info`, `warn`, `error` | `info` | nein | nein |

## `ECCLIUM_CHURCHTOOLS_URL`

Adresse der ChurchTools-Instanz, nur mit `https`, ohne Pfad und in Kleinbuchstaben, etwa `https://example.church.tools`. Eine IP-Adresse oder `localhost` nimmt Ecclium nicht an. Der Server verbindet sich nur mit genau dieser Adresse. Pflicht.

## `ECCLIUM_CHURCHTOOLS_TOKEN_FILE`

Absoluter Pfad einer Datei mit dem Login-Token des Dienstkontos. Die Datei muss dem Benutzer gehören, unter dem Ecclium läuft, und für die Gruppe und andere Benutzer keine Rechte haben, etwa mit den Rechten 600. Pflicht, ausser im Betrieb über stdio mit `ECCLIUM_CHURCHTOOLS_TOKEN`.

## `ECCLIUM_CHURCHTOOLS_TOKEN`

Das Login-Token selbst statt einer Datei, nur im Betrieb über stdio und mit einer Warnung beim Start. Sicherer ist die Token-Datei. Beides zugleich bricht den Start ab.

## `ECCLIUM_CHURCHTOOLS_REQUESTS_PER_MINUTE`

Legt fest, wie viele Anfragen der Server im Mittel höchstens pro Minute an ChurchTools sendet. Die Drosselung zählt je ChurchTools-Instanz und Prozess selbst. Ist ihr Kontingent erschöpft, endet ein Aufruf sofort mit `rate_limited`.

## `ECCLIUM_READ_ONLY`

Legt fest, ob der Server nur liest. Mit `true` registriert er keine Schreib-Tools. In dieser Version gibt es noch keine Schreib-Tools.

## `ECCLIUM_REDACTION`

Stufe der Maskierung. `standard` maskiert E-Mail-Adressen, Telefonnummern und Geburtsdaten. `off` schaltet die Masken ab, nur im Betrieb über stdio und mit einer Warnung beim Start. `strict` bricht den Start ab, bis die vollständige Maskierung steht.

## `ECCLIUM_TOOLSETS`

Legt fest, welche Bereiche von Tools der Server anbietet: eine mit Komma getrennte Liste aus `persons` (Personen und Gruppen), `events` (Events und Dienste), `calendars` (Kalender, Termine, Ressourcen und Buchungen), `wiki`, `songs`, `docs` (der Index der Dokumentation von ChurchTools) und `api` (der lesende Zugriff auf jede Operation der API, die Ecclium freigibt), ohne Leerzeichen, oder `all` für alle ausser `api`, oder `all,api` für alle. Leer oder nicht gesetzt bietet der Server nur `ct_whoami` an. `persons`, `events` und `api` verlangen im Betrieb über stdio `ECCLIUM_STATE_DIR` für die Audit-Datei. Die Variable ersetzt `ECCLIUM_SEARCH_TOOLS`: Statt `ECCLIUM_SEARCH_TOOLS=true` gilt `ECCLIUM_TOOLSETS=persons`.

## `ECCLIUM_STATE_DIR`

Absoluter Pfad eines Ordners für den Zustand des Servers, heute für die Audit-Datei im Unterordner `audit`. Den Ordner selbst legt Ecclium nicht an, den Unterordner darin schon. Der Ordner muss dem Benutzer gehören, unter dem Ecclium läuft, und für die Gruppe und andere Benutzer keine Rechte haben, etwa mit den Rechten 700. Nur im Betrieb über stdio.

## `ECCLIUM_STDIO_SUBJECT`

Das Subjekt, also eine neutrale Bezeichnung dessen, der den Server über stdio nutzt. Erlaubt sind Kleinbuchstaben, Ziffern und Bindestriche, am Anfang ein Buchstabe. Die Bezeichnung erscheint im Audit als Akteur und darf deshalb kein Personenname sein.

## `ECCLIUM_LOG_LEVEL`

Legt fest, ab welcher Stufe der Server Zeilen des Logs auf stderr schreibt.

## Noch nicht unterstützt

Diese Namen gehören zu späteren Versionen. Ist einer gesetzt, bricht der Start mit einem Hinweis ab, statt die Variable still zu übergehen.

- `ECCLIUM_WRITE_CONFIRMATION`
- `ECCLIUM_EGRESS`
- `ECCLIUM_EGRESS_ALLOW_LAN`
- `ECCLIUM_ALLOWED_HOSTS`
- `ECCLIUM_EGRESS_PROXY`: Einen Proxy für ausgehende Verbindungen gibt es erst in einer späteren Version.

## Nicht mehr gültig

Diese Namen gibt es nicht mehr. Ist einer gesetzt, bricht der Start mit einem Hinweis auf die Variable ab, die ihn ersetzt.

- `ECCLIUM_SEARCH_TOOLS`: Statt `ECCLIUM_SEARCH_TOOLS=true` gilt `ECCLIUM_TOOLSETS=persons`.
