# Konfiguration

<!-- Erzeugt mit `pnpm docs:generate` aus der Tabelle der Variablen. Nicht von Hand ändern. -->

Diese Seite entsteht mit `pnpm docs:generate` aus der Tabelle der Variablen im Kern ([ADR 0055](adr/0055-konfiguration-identitaet.md)). Ein Test vergleicht sie mit dem Code. Ändern Sie sie deshalb nicht von Hand.

Ecclium liest seine Konfiguration aus Variablen der Umgebung. Jede trägt das Präfix `ECCLIUM_`. Eine unbekannte oder falsch geschriebene Variable mit diesem Präfix bricht den Start ab. `ecclium config check` zeigt jede Einstellung mit ihrer Herkunft und prüft die Konfiguration, ohne ChurchTools anzufragen.

Die Spalte «Server nur über stdio» sagt, ob der Server die Variable nur im Betrieb über stdio nimmt und nicht über HTTP. Die Spalte «Runner» sagt, ob der Runner der Routinen sie nimmt. Er hat ein eigenes Konto und liest nie mit dem Token des Servers.

| Variable | Werte | Voreinstellung | Geheimnis | Server nur über stdio | Runner |
| --- | --- | --- | --- | --- | --- |
| `ECCLIUM_CHURCHTOOLS_URL` | Adresse mit `https` | keine | nein | nein | ja |
| `ECCLIUM_CHURCHTOOLS_TOKEN_FILE` | absoluter Pfad | keine | nein | nein | nein |
| `ECCLIUM_CHURCHTOOLS_TOKEN` | Login-Token | keine | ja | ja | nein |
| `ECCLIUM_CHURCHTOOLS_REQUESTS_PER_MINUTE` | ganze Zahl von 1 bis 500 | `300` | nein | nein | ja |
| `ECCLIUM_READ_ONLY` | `true`, `false` | `true` | nein | nein | ja |
| `ECCLIUM_REDACTION` | `standard`, `off`, `strict` | `standard` | nein | nein | ja |
| `ECCLIUM_PSEUDONYM_KEY_FILE` | absoluter Pfad | keine | nein | nein | ja |
| `ECCLIUM_PSEUDONYM_KEY_PREVIOUS_FILE` | absoluter Pfad | keine | nein | nein | ja |
| `ECCLIUM_TOOLSETS` | Liste aus `persons`, `events`, `calendars`, `wiki`, `songs`, `docs`, `api`, mit Komma getrennt, oder `all` für alle ausser `api`, oder `all,api` | leer | nein | nein | ja |
| `ECCLIUM_STATE_DIR` | absoluter Pfad | keine | nein | ja | ja |
| `ECCLIUM_KEYS_DIR` | absoluter Pfad | keine | nein | ja | ja |
| `ECCLIUM_SNAPSHOTS` | `on`, `off` | `on` | nein | nein | ja |
| `ECCLIUM_WRITE_CONFIRMATION` | `echo-allowed`, `elicitation-or-queue`, `queue` | `echo-allowed` | nein | nein | ja |
| `ECCLIUM_TIME_ZONE` | `UTC` oder Name einer Zeitzone wie `Europe/Zurich` | keine | nein | nein | ja |
| `ECCLIUM_AUDIT_RETENTION_MONTHS` | ganze Zahl von 1 bis 120 | `12` | nein | ja | ja |
| `ECCLIUM_POLICY_FILE` | absoluter Pfad | keine | nein | nein | ja |
| `ECCLIUM_MARKER_KEY_FILE` | absoluter Pfad | keine | nein | nein | ja |
| `ECCLIUM_ROUTINES_DIR` | absoluter Pfad | keine | nein | nein | ja |
| `ECCLIUM_PROVIDERS_FILE` | absoluter Pfad | keine | nein | nein | ja |
| `ECCLIUM_RUNNER_TOKENS_DIR` | absoluter Pfad | keine | nein | nein | ja |
| `ECCLIUM_DRAFTS_DIR` | absoluter Pfad | keine | nein | nein | ja |
| `ECCLIUM_NOTIFY_FILE` | absoluter Pfad | keine | nein | nein | ja |
| `ECCLIUM_STDIO_SUBJECT` | Bezeichnung mit höchstens 32 Zeichen | `local-stdio` | nein | ja | nein |
| `ECCLIUM_LOG_LEVEL` | `debug`, `info`, `warn`, `error` | `info` | nein | nein | ja |

## `ECCLIUM_CHURCHTOOLS_URL`

Adresse der ChurchTools-Instanz, nur mit `https`, ohne Pfad und in Kleinbuchstaben, etwa `https://example.church.tools`. Eine IP-Adresse oder `localhost` nimmt Ecclium nicht an. Der Server verbindet sich nur mit genau dieser Adresse. Pflicht.

## `ECCLIUM_CHURCHTOOLS_TOKEN_FILE`

Absoluter Pfad einer Datei mit dem Login-Token des Dienstkontos. Die Datei muss dem Benutzer gehören, unter dem Ecclium läuft, und für die Gruppe und andere Benutzer keine Rechte haben, etwa mit den Rechten 600. Pflicht, ausser im Betrieb über stdio mit `ECCLIUM_CHURCHTOOLS_TOKEN`. Für den Runner nicht erlaubt: Er liest nie mit dem Token des Servers, sondern mit seinem eigenen Konto aus `ECCLIUM_RUNNER_TOKENS_DIR`.

## `ECCLIUM_CHURCHTOOLS_TOKEN`

Das Login-Token selbst statt einer Datei, nur im Betrieb über stdio und mit einer Warnung beim Start. Sicherer ist die Token-Datei. Beides zugleich bricht den Start ab.

## `ECCLIUM_CHURCHTOOLS_REQUESTS_PER_MINUTE`

Legt fest, wie viele Anfragen der Server im Mittel höchstens pro Minute an ChurchTools sendet. Die Drosselung zählt je ChurchTools-Instanz und Prozess selbst. Ist ihr Kontingent erschöpft, endet ein Aufruf sofort mit `rate_limited`.

## `ECCLIUM_READ_ONLY`

Legt fest, ob der Server nur liest. Mit `true` registriert er keine Schreib-Tools. Mit `false` und dem Toolset `wiki` bietet er die Schreib-Tools des Wikis an, `ct_wiki_page_create`, `ct_wiki_page_update` und `ct_wiki_page_append_section`, mit dem Toolset `calendars` die für Termine und Buchungen, `ct_appointments_create`, `ct_appointments_update` und `ct_bookings_create`. Alle schreiben erst nach einer Bestätigung. Mit `false` warnt jeder Start, dass Ecclium schreiben darf, und der Start verlangt über stdio `ECCLIUM_STATE_DIR` mit dem Unterordner `stop` und `ECCLIUM_KEYS_DIR`, mit dem Toolset `wiki` dazu `ECCLIUM_MARKER_KEY_FILE` und `interactive.inquiriesTo` in der Richtlinie.

## `ECCLIUM_REDACTION`

Stufe der Maskierung. `standard` maskiert E-Mail-Adressen, Telefonnummern und Geburtsdaten und ersetzt Strasse, Postleitzahl und Koordinaten einer Adresse und Beträge durch eine Marke. `off` schaltet die Masken ab, nur im Betrieb über stdio und mit einer Warnung beim Start. `strict` kürzt zusätzlich Nachnamen auf den ersten Buchstaben, ersetzt die Kennungen von Personen durch Pseudonyme und prüft Freitext auf E-Mail-Adressen, Telefonnummern, IBAN und AHV-Nummern. Es braucht `ECCLIUM_PSEUDONYM_KEY_FILE` und geht nicht zusammen mit dem Toolset `api`.

## `ECCLIUM_PSEUDONYM_KEY_FILE`

Absoluter Pfad einer Datei mit dem Schlüssel für die Pseudonyme der Maskierung `strict`: genau 64 Zeichen aus `0` bis `9` und `a` bis `f`, höchstens mit einem Zeilenumbruch am Ende, so wie `openssl rand -hex 32` ihn schreibt. Die Datei muss dem Benutzer gehören, unter dem Ecclium läuft, und für die Gruppe und andere Benutzer keine Rechte haben, etwa mit den Rechten 600. Wer den Schlüssel hat, kann jedes Pseudonym in die Kennung einer Person zurückübersetzen. Sichern Sie ihn trotzdem, damit Pseudonyme nach einer Wiederherstellung gleich bleiben. Mit `strict` ist die Variable nötig, ohne `strict` bewirkt der Schlüssel in dieser Version nichts.

## `ECCLIUM_PSEUDONYM_KEY_PREVIOUS_FILE`

Nur während eines Wechsels des Schlüssels für Pseudonyme: absoluter Pfad einer Datei mit dem bisherigen Schlüssel, in derselben Form und mit denselben Rechten wie `ECCLIUM_PSEUDONYM_KEY_FILE`, die dann den neuen enthält. Ecclium übersetzt so auch Pseudonyme aus dem bisherigen Schlüssel zurück, neue entstehen nur mit dem neuen. Jeder Start warnt, solange die Variable gesetzt ist. Entfernen Sie sie, sobald der UTC-Tag nach dem Wechsel vorbei ist. Ohne `ECCLIUM_PSEUDONYM_KEY_FILE` oder mit demselben Schlüssel bricht der Start ab.

## `ECCLIUM_TOOLSETS`

Legt fest, welche Bereiche von Tools der Server anbietet: eine mit Komma getrennte Liste aus `persons` (Personen und Gruppen), `events` (Events und Dienste), `calendars` (Kalender, Termine, Ressourcen und Buchungen), `wiki`, `songs`, `docs` (der Index der Dokumentation von ChurchTools) und `api` (der lesende Zugriff auf jede Operation der API, die Ecclium freigibt), ohne Leerzeichen, oder `all` für alle ausser `api`, oder `all,api` für alle. Leer oder nicht gesetzt bietet der Server nur `ct_whoami` an. `persons`, `events` und `api` verlangen im Betrieb über stdio `ECCLIUM_STATE_DIR` für die Audit-Datei. Die Variable ersetzt `ECCLIUM_SEARCH_TOOLS`: Statt `ECCLIUM_SEARCH_TOOLS=true` gilt `ECCLIUM_TOOLSETS=persons`.

## `ECCLIUM_STATE_DIR`

Absoluter Pfad eines Ordners für den Zustand des Servers: für die Audit-Datei im Unterordner `audit`, die Zähler im Unterordner `quota` und, wenn Ecclium schreibt, die Snapshots im Unterordner `snapshots` und die Freigabe-Warteschlange im Unterordner `queue`. Den Ordner selbst legt Ecclium nicht an, diese Unterordner darin schon. Im Unterordner `stop` liegen die Kill-Switches: Eine Datei `writes-off` darin hält jedes Schreiben ohne Neustart an. Diesen Unterordner legt Ecclium nicht an, und ohne ihn startet ein Server mit `ECCLIUM_READ_ONLY=false` nicht. Pflicht mit `ECCLIUM_READ_ONLY=false`, für den Runner immer. Der Ordner muss dem Benutzer gehören, unter dem Ecclium läuft, und für die Gruppe und andere Benutzer keine Rechte haben, etwa mit den Rechten 700. Beim Server nur im Betrieb über stdio, dazu für den Runner.

## `ECCLIUM_KEYS_DIR`

Absoluter Pfad eines eigenen Ordners für die Tagesschlüssel, mit denen Ecclium die Snapshots von Schreibvorgängen und die Einträge der Freigabe-Warteschlange verschlüsselt, in den Unterordnern `snapshot` und `queue`. Den Ordner selbst legt Ecclium nicht an, beim Start aber den Unterordner `snapshot`, den Unterordner `queue` mit dem ersten Eintrag. Der Ordner muss dem Benutzer gehören, unter dem Ecclium läuft, und für die Gruppe und andere Benutzer keine Rechte haben, etwa mit den Rechten 700. Er darf nicht der Ordner aus `ECCLIUM_STATE_DIR` sein, nicht darin liegen und ihn nicht enthalten und gehört in keine Sicherung. Beim Start und beim Wechsel des UTC-Tages vernichtet Ecclium die Tagesschlüssel der Snapshots, die älter sind als 30 Tage, und die der Freigabe-Warteschlange, die älter sind als 14 Tage: Ein Snapshot bleibt an seinem Tag und an den 30 Tagen danach lesbar, ein Eintrag der Warteschlange an seinem Tag und an den 14 Tagen danach, danach in keiner Kopie mehr. Pflicht mit `ECCLIUM_READ_ONLY=false`. Beim Server nur im Betrieb über stdio, dazu für den Runner.

## `ECCLIUM_SNAPSHOTS`

Legt fest, ob Ecclium vor jedem Schreibvorgang den bisherigen Stand als Snapshot festhält, mit dem sich der Schreibvorgang zurücknehmen lässt. Ein Snapshot liegt verschlüsselt im Unterordner `snapshots` des Ordners aus `ECCLIUM_STATE_DIR`, den der Start eines Servers anlegt, der schreibt, und sein Schlüssel ist mit einem Tagesschlüssel aus `ECCLIUM_KEYS_DIR` verschlüsselt. Die Frist ist fest 30 Tage: Ein Snapshot bleibt an seinem Tag und an den 30 Tagen danach lesbar, danach löscht Ecclium beim Start oder beim Wechsel des UTC-Tages den Snapshot und vernichtet seinen Tagesschlüssel, solange `ECCLIUM_STATE_DIR` und `ECCLIUM_KEYS_DIR` gesetzt sind, auch wenn es nur liest oder die Snapshots ausgeschaltet sind. Snapshots entstehen mit den Schreib-Tools, in dieser Version mit denen des Wikis und denen für Termine und Buchungen. Mit `off` hält Ecclium keinen Snapshot fest, kein Schreibvorgang lässt sich zurücknehmen, und jeder Start mit `ECCLIUM_READ_ONLY=false` warnt.

## `ECCLIUM_WRITE_CONFIRMATION`

Legt fest, wie Ecclium einen Schreibvorgang bestätigen lässt, bevor es schreibt. Mit `echo-allowed`, der Voreinstellung über stdio, stellt Ecclium eine Rückfrage im Client, wenn der Client sie kann, sonst gilt die Bestätigung mit `ct_write_confirm`, wenn sich der Schreibvorgang zurücknehmen lässt und niemanden ausserhalb des Clients benachrichtigt, sonst kommt er in die Freigabe-Warteschlange. Mit `elicitation-or-queue`, der Voreinstellung über HTTP, gilt nie die Bestätigung mit `ct_write_confirm`, nur die Rückfrage oder die Freigabe-Warteschlange. Mit `queue` wartet jeder Schreibvorgang auf die Freigabe des Betreibers. Steht die Variable über HTTP auf `echo-allowed`, warnt jeder Start. Ein Eintrag der Freigabe-Warteschlange liegt verschlüsselt im Unterordner `queue` des Ordners aus `ECCLIUM_STATE_DIR`, `ecclium queue list` zeigt, was wartet, `ecclium queue approve` gibt einen Eintrag frei und schreibt ihn sofort, und `ecclium queue reject` weist ihn ab. Das Ändern eines Termins mit `ct_appointments_update` und eine Buchungsanfrage mit `ct_bookings_create` bestätigt `ct_write_confirm` nie, weil ChurchTools dabei Personen ausserhalb des Clients benachrichtigen kann.

## `ECCLIUM_TIME_ZONE`

Die Zeitzone, in der die Rückfrage vor einem Schreibvorgang, `ecclium queue show` und `ecclium undo` Beginn und Ende von Terminen und Buchungen zeigen, mit dem Namen der Zone, etwa `Europe/Zurich`. Erlaubt ist `UTC` oder der Name einer Zeitzone aus Gebiet und Ort, keine Angabe wie `+01:00` und keine Abkürzung wie `CET`. Ohne die Variable zeigen die Texte die Zeiten in UTC. Die Tools nehmen Zeiten immer in UTC, auch mit der Variable. Mit ihr lehnt Ecclium einen Termin und eine Buchung ab, deren Beginn und Ende beide auf Mitternacht dieser Zone fallen, weil ChurchTools sie womöglich als ganztägig speichert, was keine Probe geprüft hat. Tragen Sie deshalb die Zeitzone der ChurchTools-Installation ein. Der Runner rechnet in dieser Zone die Zeitpläne der Routinen und ihre Perioden und startet ohne die Variable nicht, damit Texte und Zeitpläne dieselbe Zone zeigen.

## `ECCLIUM_AUDIT_RETENTION_MONTHS`

Wie viele Monate die Audit-Dateien bleiben, von 1 bis 120. Danach löscht Ecclium sie beim Start oder beim Wechsel des UTC-Tages, nur im Ordner `audit` und nur Dateien mit dem Namen einer Audit-Datei. Eine Datei bleibt mindestens bis zum Ende des Tages, der so viele Kalendermonate nach ihrem Tag liegt. Unter zwölf Monaten warnt jeder Start, weil das Protokoll dann kürzer bleibt als ein Jahr. Ohne `ECCLIUM_STATE_DIR` gibt es keine Audit-Datei, und die Variable bewirkt nichts. Kopien, etwa in Backups, löscht Ecclium nicht. Beim Server nur im Betrieb über stdio, dazu für den Runner.

## `ECCLIUM_POLICY_FILE`

Absoluter Pfad der Datei mit der Richtlinie im Format `policy.v1`, in YAML oder JSON. Sie legt fest, auf welche Ziele bestätigte Schreibvorgänge gehen dürfen, wie oft je Tag, und wie hoch das Lesebudget ist (`docs/policy.md`). Die Datei muss dem Benutzer gehören, unter dem Ecclium läuft, und Gruppe und andere Benutzer dürfen sie nicht ändern, etwa mit den Rechten 644 oder 600. Ecclium liest sie beim Start, eine Änderung wirkt nach einem Neustart. Ohne die Variable gilt die Voreinstellung: Erlaubt ist, was das Dienstkonto darf, ausser bei Gruppen und Diensten, und das Lesebudget ist 200 Aufrufe je Akteur und UTC-Tag. Der Runner startet ohne die Variable nicht. Ist `LOG_TOKENS` oder `LOG_STREAM` gesetzt, bricht der Start ab, weil die Bibliothek für YAML die Datei sonst nach stdout schriebe.

## `ECCLIUM_MARKER_KEY_FILE`

Absoluter Pfad einer Datei mit dem Schlüssel für den Prüfcode der Kennzeichnung: genau 64 Zeichen aus `0` bis `9` und `a` bis `f`, höchstens mit einem Zeilenumbruch am Ende, so wie `openssl rand -hex 32` ihn schreibt. Die Datei muss dem Benutzer gehören, unter dem Ecclium läuft, und für die Gruppe und andere Benutzer keine Rechte haben, etwa mit den Rechten 600. Jede Seite und jeder Abschnitt, die Ecclium im Wiki hinzufügt, endet mit einer Zeile mit einem Prüfcode aus diesem Schlüssel, an dem Ecclium seine eigenen Abschnitte wiedererkennt. Wer den Schlüssel hat, kann Abschnitte als eigene von Ecclium ausgeben. Sichern Sie die Datei: Ein neuer Schlüssel macht jeden bisherigen Prüfcode ungültig. Es muss ein anderer Schlüssel sein als der für die Pseudonyme. Mit `ECCLIUM_READ_ONLY=false` und dem Toolset `wiki` ist die Variable Pflicht, ebenso `interactive.inquiriesTo` in der Richtlinie.

## `ECCLIUM_ROUTINES_DIR`

Absoluter Pfad des Ordners mit den Routinen im Format `routine.v1`, je eine Datei `<Kennung>.yaml`, mit ihren Prompts und Vorlagen im Ordner selbst oder in einem Ordner darunter (`docs/routines.md`). Ordner und Dateien müssen dem Benutzer gehören, unter dem Ecclium läuft, und Gruppe und andere Benutzer dürfen sie nicht ändern, etwa mit den Rechten 755 für Ordner und 644 für Dateien. Nur der Runner liest die Routinen und startet ohne die Variable nicht, der Server prüft beim Start nur die Form des Pfads. Ist `LOG_TOKENS` oder `LOG_STREAM` gesetzt, bricht der Start ab, weil die Bibliothek für YAML die Routinen sonst nach stdout schriebe.

## `ECCLIUM_PROVIDERS_FILE`

Absoluter Pfad der Datei mit den Anbietern von Sprachmodellen im Format `providers.v1` (`docs/providers.md`): je Alias Anbieter, Modell, Land des Rechenzentrums, Endpunkt mit `https`, ob der Anbieter strukturierte Ausgabe kann, der Pfad der Datei mit dem Schlüssel und ausserhalb der Schweiz und des EWR die Grundlage der Übermittlung. Der Start liest und prüft die Datei wie die Richtlinie, die Dateien der Schlüssel liest erst der Runner. Ein Anbieter ausserhalb ohne Grundlage und ein Schlüssel in der Datei selbst verhindern den Start. Ist `LOG_TOKENS` oder `LOG_STREAM` gesetzt, bricht der Start ab, weil die Bibliothek für YAML die Datei sonst nach stdout schriebe. Nicht gesetzt: kein Modell, Routinen mit Modell starten nicht.

## `ECCLIUM_RUNNER_TOKENS_DIR`

Absoluter Pfad des Ordners mit den Token-Dateien der Konten des Runners: `ct_token_runner` für das eigene Konto des Runners, mit dem eine Routine ohne Eintrag in der Richtlinie liest, und je Alias der Richtlinie eine Datei `ct_token_<Alias>`, etwa `ct_token_bericht` für den Alias `bericht` (`docs/policy.md`). Jede Datei hält das Login-Token eines eigenen Dienstkontos mit nur den Rechten seiner Routinen und muss dem Benutzer gehören, unter dem Ecclium läuft, ohne Rechte für Gruppe und andere, etwa mit den Rechten 600. Der Ordner muss ebenfalls diesem Benutzer gehören, darf kein Link sein und nicht im Ordner aus `ECCLIUM_STATE_DIR` liegen, und weder die Gruppe noch andere dürfen darin schreiben, etwa mit den Rechten 700 oder 755. Jeder Start prüft den Ordner, und der Runner prüft vor dem ersten Lauf seine eigene Datei und die Datei jedes Alias der Richtlinie und startet ohne den Ordner nicht. Ein Lauf liest die Datei seines Kontos neu, ein neues Token wirkt ohne Neustart. Auch `ecclium queue approve` schreibt einen Eintrag aus einem Lauf mit diesem Konto. Der Runner liest nie mit dem Token aus `ECCLIUM_CHURCHTOOLS_TOKEN_FILE`.

## `ECCLIUM_DRAFTS_DIR`

Absoluter Pfad des Ordners, in den der Runner die Entwürfe der Routinen mit dem Ziel `draft` und dem Kanal `file` schreibt, je Routine und Periode eine Datei `<Routine>-<Periode>.md` (`docs/routines.md`). Ein zweiter Lauf derselben Periode ersetzt die Datei in einem Schritt. Fehlt der Ordner, legt der Runner ihn mit den Rechten 700 an, nicht aber einen Ordner darüber, und jede Datei darin mit den Rechten 600. Ein bestehender Ordner muss dem Benutzer gehören, unter dem Ecclium läuft, und für die Gruppe und andere Benutzer keine Rechte haben. Nur der Runner schreibt hinein. Beim Start prüft Ecclium die Form des Pfads und dass er weder der Zustandsordner ist noch ihn enthält und nicht im Ordner der Schlüssel, im Ordner der Token-Dateien oder in einem der Ordner `audit`, `quota`, `snapshots`, `queue`, `runner` oder `stop` des Zustandsordners liegt, weil ein Entwurf oder eine Meldung dort eine Datei von Ecclium verdürbe. Die Entwürfe enthalten Personendaten. Wie lange sie bleiben, ist Ihre Sache als Betreiber: Ecclium löscht sie nicht. Nicht gesetzt: Eine Routine mit dem Ziel `draft` und dem Kanal `file` startet nicht.

## `ECCLIUM_NOTIFY_FILE`

Absoluter Pfad der Datei, an die der Runner nach jedem Lauf einer Routine, deren `notify` den Kanal `file` nennt, eine Zeile in JSON anhängt: Zeit, Routine, Periode, Lauf, Ausgang und Code, nie Inhalt. Fehlt die Datei, legt der Runner sie mit den Rechten 600 an. Eine bestehende Datei muss dem Benutzer gehören, unter dem Ecclium läuft, darf für die Gruppe und andere Benutzer keine Rechte haben und kein Link sein. Nur der Runner schreibt hinein. Beim Start prüft Ecclium die Form des Pfads und dass er nicht im Ordner der Schlüssel, im Ordner der Token-Dateien oder in einem der Ordner `audit`, `quota`, `snapshots`, `queue`, `runner` oder `stop` des Zustandsordners liegt, weil ein Entwurf oder eine Meldung dort eine Datei von Ecclium verdürbe. Die Datei wächst mit jedem Lauf. Wie bei einem Log ist das Rotieren Ihre Sache als Betreiber, etwa mit logrotate. Nicht gesetzt: Eine Routine, deren `notify` den Kanal `file` nennt, startet nicht.

## `ECCLIUM_STDIO_SUBJECT`

Das Subjekt, also eine neutrale Bezeichnung dessen, der den Server über stdio nutzt. Erlaubt sind Kleinbuchstaben, Ziffern und Bindestriche, am Anfang ein Buchstabe. Die Bezeichnung erscheint im Audit als Akteur und darf deshalb kein Personenname sein.

## `ECCLIUM_LOG_LEVEL`

Legt fest, ab welcher Stufe der Server Zeilen des Logs auf stderr schreibt.

## Noch nicht unterstützt

Diese Namen gehören zu späteren Versionen. Ist einer gesetzt, bricht der Start mit einem Hinweis ab, statt die Variable still zu übergehen.

- `ECCLIUM_EGRESS`
- `ECCLIUM_EGRESS_ALLOW_LAN`
- `ECCLIUM_ALLOWED_HOSTS`
- `ECCLIUM_EGRESS_PROXY`: Einen Proxy für ausgehende Verbindungen gibt es erst in einer späteren Version.

## Nicht mehr gültig

Diese Namen gibt es nicht mehr. Ist einer gesetzt, bricht der Start mit einem Hinweis auf die Variable ab, die ihn ersetzt.

- `ECCLIUM_SEARCH_TOOLS`: Statt `ECCLIUM_SEARCH_TOOLS=true` gilt `ECCLIUM_TOOLSETS=persons`.
