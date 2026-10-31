# Betrieb über stdio

**In Entwicklung.** Es gibt noch keine veröffentlichte Version. Diese Seite beschreibt, wie Sie Ecclium aus dem Quellcode bauen und als lokalen Server über stdio in Claude Desktop oder Claude Code einbinden. Über stdio startet der Client den Server als eigenen Prozess auf Ihrem Rechner und spricht mit ihm über stdin und stdout.

In der Voreinstellung bietet der Server nur das Tool `ct_whoami` an. Es zeigt, mit welchem Konto Ecclium ChurchTools liest und welche Rechte ChurchTools diesem Konto gibt. Auf ausdrücklichen Wunsch kommen mit dem Toolset `persons` die Tools für Personen und Gruppen dazu, siehe «Personen und Gruppen», mit dem Toolset `events` die Tools für Events, Abläufe und Dienste, siehe «Events und Dienste», mit dem Toolset `calendars` die Tools für Kalender, Termine, Ressourcen und Buchungen, siehe «Kalender und Ressourcen», mit dem Toolset `wiki` die Tools des Wikis und mit dem Toolset `songs` die Tools für Songs, siehe «Songs». Alle lesen nur und ändern in ChurchTools nichts.

Ecclium ist ein unabhängiges Projekt und steht in keiner Verbindung zum Hersteller von ChurchTools.

Geprüft am 19.10.2026 unter macOS 27.0 mit Claude Code 2.1.302 und Claude Desktop 2.31226.1: In beiden Clients erschien der Server mit genau `ct_whoami` und antwortete mit dem Konto und seinen Rechten. Am 23.10.2026 liefen auch die Suchtools in beiden Clients, mit Claude Code 2.1.308 und Claude Desktop 3.6556.2. Mit einem Dienstkonto, das nur das Wiki sehen darf, ist das in Claude Code geprüft. Windows deckt diese Seite nicht ab: Dort kann Ecclium die Token-Datei nicht sicher lesen und lehnt sie ab ([ADR 0055](../adr/0055-konfiguration-identitaet.md)).

## Voraussetzungen

- macOS auf Apple Silicon (arm64) oder Linux auf x64, eine Shell wie zsh oder bash und Git. Für andere Plattformen siehe «Einrichtung» in [CONTRIBUTING.md](../../CONTRIBUTING.md).
- mise, der Versionsmanager, über den das Projekt Node.js und pnpm in festen Versionen bezieht. Wie Sie mise einrichten, steht in [CONTRIBUTING.md](../../CONTRIBUTING.md) unter «Einrichtung».
- Claude Desktop oder Claude Code.
- Ein eigenes Dienstkonto in ChurchTools mit einem Login-Token, nicht Ihr persönliches Konto. Wie Sie es anlegen, welche Rechte es braucht und wie Sie sein Token holen und erneuern, steht unter [Dienstkonto in ChurchTools](dienstkonto.md).

## Bauen

Holen Sie den Quellcode mit Git als Klon des Repositorys `ecclium/mcp-churchtools` in einen Ordner Ihrer Wahl. Auf dieser Seite heisst er `/pfad/zum/checkout`. Führen Sie im Ordner des Checkouts aus:

```sh
MISE_LOCKED=1 mise install
mise exec -- pnpm install
mise exec -- pnpm build
mise which node
```

Der erste Befehl installiert Node.js und pnpm in den Versionen aus `mise.toml` und prüft dabei die Prüfsummen aus `mise.lock`. `pnpm build` übersetzt alle Pakete, der Einstieg des Servers liegt danach in `packages/cli/dist/bin.js`. `mise which node` gibt den absoluten Pfad von Node.js aus. Er ersetzt in den Beispielen `/pfad/zu/node`, denn Claude Desktop startet Server ohne den Suchpfad der Shell. Der Client startet den Server dann mit diesem Befehl:

```sh
/pfad/zu/node /pfad/zum/checkout/packages/cli/dist/bin.js stdio
```

Nach jeder Änderung am Checkout, etwa nach `git pull`, bauen Sie neu und starten den Client neu.

## Token-Datei

Ecclium liest das Login-Token des Dienstkontos aus einer Datei. Legen Sie die Datei leer und mit den Rechten 600 an, ausserhalb des Checkouts und in einem Ordner, den nur Ihr Benutzer lesen kann:

```sh
(umask 077 && touch /pfad/zur/token-datei)
```

Öffnen Sie die Datei in einem Editor und fügen Sie das Token als einzige Zeile ein. Geben Sie das Token nie auf der Kommandozeile ein, sonst steht es in der History der Shell.

Vor dem Lesen prüft Ecclium die Datei und bricht den Start ab, wenn eine dieser Bedingungen nicht erfüllt ist:

- Der Pfad ist absolut und ausgeschrieben, ohne `~` und ohne Variable.
- Die Datei ist eine gewöhnliche Datei und kein symbolischer Link.
- Sie gehört dem Benutzer, unter dem der Client läuft, und weder die Gruppe noch andere haben Rechte darauf.
- Sie enthält genau eine Zeile aus sichtbaren ASCII-Zeichen, höchstens 4 KiB und ohne BOM. Ein Zeilenumbruch am Ende ist erlaubt.

Den Ordnern über der Datei vertraut Ecclium, ohne sie zu prüfen. Wer in einen davon schreiben darf, kann die Datei ersetzen.

Die Beispiele nennen nur die Token-Datei. Das Token direkt in der Variable `ECCLIUM_CHURCHTOOLS_TOKEN` nimmt Ecclium nur über stdio an, mit einer Warnung bei jedem Start: Es steht dann im Klartext in der Konfiguration des Clients, und andere Programme Ihres Benutzers können es lesen, solange der Server läuft.

## Konfiguration prüfen

Prüfen Sie die Einstellungen, bevor Sie einen Client einrichten. Der Befehl ist derselbe, den der Client startet, mit `config check` statt `stdio`:

```sh
env -i ECCLIUM_CHURCHTOOLS_URL=https://example.church.tools ECCLIUM_CHURCHTOOLS_TOKEN_FILE=/pfad/zur/token-datei /pfad/zu/node /pfad/zum/checkout/packages/cli/dist/bin.js config check
```

Mit `env -i` sieht die Prüfung nur diese beiden Variablen und keine aus Ihrer Shell, etwa eine alte Variable mit dem Präfix `ECCLIUM_`. Die Prüfung liest die Token-Datei und prüft Eigentümer und Rechte, ChurchTools fragt sie nicht an. Sie zeigt jede Einstellung mit ihrer Herkunft, den Host der Adresse nur mit `--show-values` und das Token nie. Ist die Konfiguration gültig, endet sie mit 0, sonst mit 78 und einem Hinweis zu jedem Problem.

Ob ChurchTools das Token annimmt, zeigt erst ein Aufruf von `ct_whoami`, denn auch der Start fragt ChurchTools nicht an.

Die Beispiele setzen nur die Adresse und die Token-Datei. Alle übrigen Einstellungen behalten ihre Voreinstellung: nur lesen, Maskierung `standard`, kein Toolset und damit nur `ct_whoami`, keine Audit-Datei, Stufe des Logs `info`. Alle Variablen stehen mit Erklärung in [.env.example](../../.env.example) und in der Referenz [docs/configuration.md](../configuration.md), die Tools mit ihren Feldern in [docs/tools.md](../tools.md). Den Ordner für die Audit-Datei empfehlen wir zusätzlich, siehe «Audit-Datei».

## Claude Desktop

Claude Desktop liest seine Server aus der Datei `claude_desktop_config.json`, unter macOS im Ordner `~/Library/Application Support/Claude/`. Übernehmen Sie den Eintrag `ecclium` aus [beispiele/claude-desktop.json](beispiele/claude-desktop.json) unter `mcpServers`, neben allfällige andere Server, und ersetzen Sie die Platzhalter durch Ihre Adresse und Ihre absoluten Pfade. Ein Server mit freiem Netzzugriff gehört nicht in denselben Client, siehe «Grenzen». Beenden Sie Claude Desktop ganz, bevor Sie die Datei ändern: Läuft es noch, kann es sie mit seinem alten Stand überschreiben. Starten Sie es danach neu, damit es den Eintrag liest.

## Claude Code

In Claude Code tragen Sie den Server mit einem Befehl für Ihren Benutzer ein. Ersetzen Sie vorher die Platzhalter:

```sh
claude mcp add-json --scope user ecclium '{"type":"stdio","command":"/pfad/zu/node","args":["/pfad/zum/checkout/packages/cli/dist/bin.js","stdio"],"env":{"ECCLIUM_CHURCHTOOLS_URL":"https://example.church.tools","ECCLIUM_CHURCHTOOLS_TOKEN_FILE":"/pfad/zur/token-datei"}}'
```

Der Befehl übergibt den Eintrag als JSON in einfachen Anführungszeichen. Die kürzere Form `claude mcp add` mit `--env` nahm Claude Code 2.1.302 so nicht an: `--env` nahm dort alle folgenden Wörter bis `--`, auch den Namen des Servers. Mit `--scope user` gilt der Server in jedem Projekt Ihres Benutzers. Der Befehl steht danach in der History der Shell, er enthält aber nur den Pfad der Token-Datei, nicht das Token. Dieselben Angaben in der Form der Konfiguration von Claude Code stehen in [beispiele/claude-code.json](beispiele/claude-code.json). `claude mcp list` führt den Server danach auf, `claude mcp remove --scope user ecclium` trägt ihn wieder aus.

Im Checkout liegt absichtlich keine Datei `.mcp.json`. Claude Code böte den Server sonst jedem an, der Claude Code im Checkout startet, auch ohne Dienstkonto und Token-Datei.

## Was der KI-Assistent sieht

- Ohne Toolset ein einziges Tool, `ct_whoami`, ohne Argumente und nur lesend. Seine Beschreibung ist englisch, wie alle Texte für das Modell. Was die Tools für Personen und Gruppen zeigen, steht unter «Personen und Gruppen», was die des Wikis zeigen, unter «Wiki».
- Ein Aufruf sendet nacheinander zwei Anfragen an ChurchTools: `GET /api/whoami` für das Konto und `GET /api/permissions/global` für seine Rechte. Andere Adressen als die aus `ECCLIUM_CHURCHTOOLS_URL` fragt der Server nicht an.
- Das Ergebnis nennt die Personen-ID, Vor- und Nachname und die E-Mail-Adresse des Dienstkontos. Die E-Mail-Adresse ist maskiert: das erste Zeichen, drei Sterne und die Domain, etwa `m***@example.org`. Vor- und Nachname maskiert diese Version nicht. Darf das Dienstkonto keine Personen sehen, liefert ChurchTools seine E-Mail-Adresse nicht mit, und dort steht `null`.
- Dazu kommen die gesetzten Rechte je Modul, nach Namen sortiert. Rechte, die das Konto nicht hat, fehlen. Ein Recht mit einer Liste von IDs, etwa für einzelne Wiki-Kategorien, zeigt die 10 kleinsten IDs und ihre Gesamtzahl. Hat das Konto mehr als 150 gesetzte Rechte, gibt das Tool statt der Liste einen Fehler mit dem Rat, dem Dienstkonto nur die Rechte seiner Tools zu geben. Kennt Ecclium die Form der Antwort zu den Rechten nicht, stehen sie als unbekannt da.
- Lehnt ChurchTools das Token ab oder ist ChurchTools nicht erreichbar, erhält der KI-Assistent nur einen festen englischen Satz. Den Code, `auth` oder `network`, nennt die Zeile des Audits auf stderr. Keine Fehlermeldung nennt einen Wert aus der Konfiguration oder aus ChurchTools.

## Log und Audit auf stderr

stdout gehört dem Protokoll MCP. Alles andere schreibt Ecclium nach stderr, in dieser Reihenfolge:

1. Beim Start Hinweise als deutscher Text, je Hinweis eine Zeile, etwa die Warnung, wenn das Token in der Variable steht. Ist die Konfiguration ungültig oder lässt sich die Audit-Datei nicht öffnen, endet der Server nach den Hinweisen mit 78.
2. Danach schreibt Ecclium nur noch Zeilen in JSON, je Zeile ein Ereignis. Logzeilen tragen das Feld `event`, etwa `http_response` für jede Anfrage an ChurchTools, ab der Stufe aus `ECCLIUM_LOG_LEVEL`. Jeder Aufruf eines Tools ergibt eine Zeile des Audits mit `type` gleich `tool_call`, dem Mandanten `default`, dem Subjekt `stdio:local-stdio` aus `ECCLIUM_STDIO_SUBJECT`, dem Modus `interactive`, dem Namen des Tools, dem Ausgang und bei einem Fehler dessen Code. Die Logzeilen eines Aufrufs, darunter `tool_call`, tragen die `eventId` seiner Zeile im Audit, die Zeilen des Transports wie `http_response` tragen keine.
3. Beim Ende mit Audit-Datei die Zeile `audit_file_closed`, die im Feld `count` nennt, wie viele Zeilen des Audits nicht ganz in die Datei kamen, dann die Zeile `stdio_closed`, die im Feld `count` nennt, wie viele Zeilen auf stderr verloren gingen. Kam vor dem Ende ein Signal, steht davor `process_sigterm` oder `process_sigint`. Kommt es erst danach, folgt seine Zeile. Diese Zeilen schreibt Ecclium bei jeder Stufe aus `ECCLIUM_LOG_LEVEL`.

Node.js selbst kann weitere Zeilen schreiben, etwa eine Warnung, wenn es die Datei aus `NODE_EXTRA_CA_CERTS` nicht laden kann. Überspringen Sie Zeilen, die kein JSON sind.

Weder das Token noch Namen, E-Mail-Adressen oder andere Werte aus den Antworten von ChurchTools stehen in diesen Zeilen. Tests mit erfundenen Werten prüfen das. Wohin die Zeilen gehen, bestimmt der Client. Ohne `ECCLIUM_STATE_DIR` schreibt Ecclium keine eigene Datei, mit dem Ordner nur die Audit-Datei, siehe «Audit-Datei».

Ecclium wartet nicht auf stderr. Liest der Client stderr nicht oder zu langsam, gehen Zeilen verloren, auch Zeilen des Audits. Ecclium zählt sie und nennt die Zahl beim Ende, doch auch diese letzte Zeile kann verloren gehen. Die Antworten auf stdout erreichen den Client trotzdem. Mit der Audit-Datei sind die Zeilen des Audits auf stderr nur Kopien, ohne die Kennungen der Objekte. Jede Zeile geht zuerst in die Datei, und was sie dort nicht aufnimmt, zählt `audit_file_closed`.

Der Server endet mit einem dieser Codes:

| Code | Bedeutung                                                                                                                         |
| ---- | --------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Die Verbindung hat geendet: Der Client hat stdin geschlossen, stdout ist abgebrochen, oder die ungelesene Eingabe lag über 1 MiB. |
| 64   | Nach `stdio` stand ein weiteres Argument.                                                                                         |
| 70   | Ein interner Fehler, gemeldet mit einer festen Meldung ohne Einzelheiten.                                                         |
| 78   | Die Konfiguration ist ungültig, oder die Audit-Datei lässt sich nicht öffnen.                                                     |
| 130  | Der Server hat sich nach dem Signal `SIGINT` beendet, das vor dem Ende der Verbindung kam.                                        |
| 143  | Der Server hat sich nach dem Signal `SIGTERM` beendet, das vor dem Ende der Verbindung kam.                                       |

Kommt das erste Signal erst nach dem Ende der Verbindung, steht es im Log, und der Code bleibt 0. Ein zweites Signal beendet den Server sofort, mit dem Code dieses zweiten Signals.

## Audit-Datei

Mit `ECCLIUM_STATE_DIR` schreibt Ecclium jede Zeile des Audits zuerst in eine eigene Datei und erst danach als Kopie nach stderr. Das Audit liegt dann bei Ihnen, gleich was der Client mit stderr macht. Ohne die Variable gibt es keine Audit-Datei, und das Audit geht nur nach stderr. Mit den Toolsets `persons`, `events` und `api` wird der Ordner nötig: Das Ergebnis eines Tools, das Personen nennt oder ganze Antworten von ChurchTools weitergibt, gibt Ecclium nur heraus, wenn seine Zeile ganz in der Audit-Datei steht.

Legen Sie einen Ordner auf einer lokalen Platte an, als Ihr Benutzer und ausserhalb des Checkouts. Der Befehl legt jeden fehlenden Ordner auf dem Weg mit den Rechten 700 an:

```sh
(umask 077 && mkdir -p /pfad/zum/zustandsordner)
```

Nehmen Sie keinen Ordner auf einem Netzlaufwerk: Antwortet es nicht, hält es bei jedem Schreiben den ganzen Server an. Nehmen Sie auch keinen Ordner, den ein Dienst synchronisiert, unter macOS etwa iCloud Drive mit «Schreibtisch» und «Dokumente», denn er kopiert die Audit-Datei an andere Orte. Dasselbe gilt für Backups: Erfasst eines den Ordner, liegen Kopien der Datei dort.

Setzen Sie die Variable in der Konfiguration des Clients neben die Adresse und die Token-Datei, im Abschnitt `env` des Eintrags `ecclium`:

```json
"ECCLIUM_STATE_DIR": "/pfad/zum/zustandsordner"
```

`config check` prüft den Ordner, wenn Sie die Variable dort ebenfalls setzen, und legt nichts an. Der Start bricht mit 78 und einem Hinweis ab, wenn eine dieser Bedingungen nicht erfüllt ist:

- Der Pfad ist absolut und eindeutig geschrieben, ohne `/` am Ende, ohne `//`, `.` und `..`, mit höchstens 960 Zeichen und in UTF-8 höchstens 960 Bytes. Ein Umlaut zählt dabei doppelt.
- Der Ordner ist ein Ordner und kein symbolischer Link, gehört Ihrem Benutzer, und weder die Gruppe noch andere haben Rechte darauf. Dasselbe gilt für einen Ordner `audit` darin.
- Ecclium kann darin beim Start den Ordner `audit` mit den Rechten 700 anlegen, falls er fehlt, und eine neue Datei mit den Rechten 600 öffnen.

In der Datei steht:

- Je Start und UTC-Tag eine Datei `audit-JJJJ-MM-TT-hhmmss-<Prozess>-<Nummer>.jsonl` mit dem Datum und der Uhrzeit des Öffnens in UTC. Ecclium öffnet nie eine Datei, die schon da ist.
- Je Aufruf eine Zeile mit Zeit, Mandant, Subjekt, Modus, Tool, Ausgang, bei einem Fehler seinem Code, der Dauer, der ID des Ereignisses und den Kennungen der Objekte, nach denen der Aufruf fragt, und der Personen und Gruppen, die sein Ergebnis nennt, etwa `person:12`. Die Kopie auf stderr ist dieselbe Zeile ohne die Kennungen. Keine Inhalte aus ChurchTools, keine Namen und kein Token. Alle Felder stehen unter [Audit-Ereignisse](../audit-events.md), das JSON Schema einer Zeile in [`schemas/audit-event.v1.json`](../../schemas/audit-event.v1.json).
- Eine Zeile zählt nur, wenn sie mit einem Zeilenumbruch endet. Eine Zeile, die mit `~` endet, und ein letztes Stück ohne Zeilenumbruch sind Reste einer Zeile, die nicht ganz in die Datei kam. Überspringen Sie solche Zeilen wie Zeilen, die kein JSON sind.
- Jede ganze Zeile trägt am Ende `seq` und `prevHash`, eine Hash-Kette je Datei: `seq` zählt die ganzen Zeilen ab 1, `prevHash` ist der SHA-256 der vorigen ganzen Zeile, bei der ersten Zeile des Namens der Datei. Reste einer Zeile gehören nicht dazu. Die Kopie auf stderr hat beides nicht.

Beim Schliessen einer Datei, beim Wechsel des UTC-Tages und bevor Ecclium eine gelöschte Datei ersetzt, schreibt es den Anker der Kette als eigene Logzeile auf stderr: `audit_chain_anchor` mit dem Namen der Datei, ohne Pfad, der `seq` und dem Hash ihrer letzten ganzen Zeile. Eine Datei ohne Zeile hat keinen Anker. Sammeln Sie das Log, etwa weil Ihr Client stderr in eine Logdatei schreibt, haben Sie damit einen Anker ausserhalb der Datei: Wer die Datei ändert, muss dann auch jede Kopie des Logs ändern. Kette und Anker prüft `ecclium audit verify`, siehe «Audit prüfen und auswerten». Am Anker schreibt Ecclium die Datei auch mit `fsync` auf die Platte, nicht nach jeder Zeile, weil das unter macOS rund 3 ms je Zeile kostet.

Frist und Löschung: Die Dateien bleiben so viele Monate, wie `ECCLIUM_AUDIT_RETENTION_MONTHS` sagt, voreingestellt 12, einstellbar von 1 bis 120. Eine Datei bleibt mindestens bis zum Ende des Tages, der so viele Kalendermonate nach dem Tag in ihrem Namen liegt, und so lange nach ihrer letzten Änderung. Danach löscht Ecclium sie beim nächsten Start oder Wechsel des UTC-Tages. Ein laufender Server wechselt den Tag auch ohne Aufruf kurz nach Mitternacht in UTC, nach einem Ruhezustand des Rechners spätestens eine Stunde danach. Teilen sich mehrere Einträge oder Clients einen Zustandsordner, gilt für alle Dateien darin die kürzeste Frist, mit der einer von ihnen startet. Geht die Uhr des Rechners weit vor, löscht Ecclium auch Dateien, deren Frist nach der richtigen Zeit noch läuft. Unter zwölf Monaten warnt jeder Start, weil die Datenschutzverordnung der Schweiz ein Protokoll mindestens ein Jahr verlangt, wo sie eines verlangt. Ecclium löscht dabei nur im Ordner `audit`, nur gewöhnliche Dateien Ihres Benutzers mit dem Namen einer Audit-Datei, ohne Rechte für andere und ohne einem Link zu folgen, nie die Datei eines laufenden Tages. Die Logzeile `audit_files_deleted` nennt die Zahl gelöschter Dateien, `audit_files_not_deleted` die Zahl fälliger Dateien, die bleiben mussten, etwa weil eine davon anderen Rechte gibt. Eine Datei ohne Zeile entfernt der Server beim Ende selbst, eine leere Datei eines früheren Tages, etwa nach einem Absturz, die nächste Löschung, sobald ihre letzte Änderung eine Stunde zurückliegt.

Löscht jemand die Datei, während der Server läuft, legt Ecclium eine neue an, mit höchstens 64 Versuchen je Start. Danach laufen Tools mit Personendaten der besonderen Kategorie erst nach einem Neustart wieder. Lässt sich die Datei nicht beschreiben, etwa weil die Platte voll ist, geht die Zeile verloren, und der Server zählt sie. Das Ergebnis eines Tools mit Personendaten der besonderen Kategorie, etwa eines Tools für Personen und Gruppen, hält er dann zurück.

Grenzen der Audit-Datei:

- Kopien der Dateien, etwa in Backups, in synchronisierten Ordnern oder an einem getrennten Ort, löscht Ecclium nicht. Für sie gilt Ihre eigene Frist.
- Eine geschriebene Zeile übersteht einen Absturz des Servers oder des Clients. Einen Stromausfall oder einen Absturz des Betriebssystems übersteht sie erst nach dem nächsten Anker.
- Die Kette erkennt eine geänderte, fehlende oder vertauschte Zeile und eine umbenannte Datei. Wer die Datei ändern kann, kann aber auch die Kette neu berechnen, das zeigt erst ein Anker aus einer Kopie des Logs. Fälschungssicher ist das nicht.
- Die Datei schützt nicht gegen Ihren eigenen Benutzer: Wer unter ihm Programme ausführt, kann sie lesen, ändern oder löschen. Ecclium erkennt nur, dass sie gelöscht wurde.
- Unter Windows lassen sich Eigentümer und Rechte des Ordners nicht prüfen. Dort gibt es keine Audit-Datei, und ein gesetztes `ECCLIUM_STATE_DIR` bricht den Start ab.
- Welches Datenschutzrecht für Ihre Gemeinde gilt und was es für ein Protokoll verlangt, steht unter [Datenschutz, «Welches Recht gilt»](../privacy.md#welches-recht-gilt). Die Audit-Datei liegt auf demselben Rechner wie der Server und damit nicht getrennt vom System. Trifft Sie etwa die Pflicht zum Protokoll nach der Datenschutzverordnung der Schweiz, verlangt sie diese Trennung, und die Dateien kopieren Sie dann selbst an einen getrennten Ort. Ecclium verspricht keine Konformität mit einem Datenschutzrecht. Was Ecclium sonst ablegt, steht ebenfalls unter [Datenschutz](../privacy.md).
- Ob ChurchTools die Lesezugriffe über die API selbst je Konto protokolliert, ist nicht geprüft.

## Audit prüfen und auswerten

Zwei Befehle lesen die Audit-Dateien: `audit verify` prüft sie, `audit show` fasst sie zusammen. Beide brauchen nur `ECCLIUM_STATE_DIR` mit demselben Ordner wie in der Konfiguration des Clients, für `audit verify` auch eine abweichende Frist in `ECCLIUM_AUDIT_RETENTION_MONTHS`. Adresse und Token brauchen sie nicht, und die Token-Datei öffnen sie nie. Eine unbekannte Variable mit dem Präfix `ECCLIUM_` bricht sie ab wie den Start, die übrigen bekannten Variablen lesen sie nicht. Sie prüfen den Zustandsordner und den Ordner `audit` wie der Start, öffnen jede Datei, ohne einem Link zu folgen, und lesen nur: Sie legen nichts an, ändern nichts und löschen nichts. Ihre Ausgabe nennt keinen Pfad, nur die Namen der Dateien, und Kennungen nur, wenn Sie nach einer fragen.

### Kette und Anker prüfen

```sh
env -i ECCLIUM_STATE_DIR=/pfad/zum/zustandsordner /pfad/zu/node /pfad/zum/checkout/packages/cli/dist/bin.js audit verify --log /pfad/zum/log
```

`audit verify` prüft jede Datei im Ordner `audit` gegen ihre Kette und, mit `--log`, gegen die Anker in einem Log, das stderr des Servers enthält. `--log` darf mehrmals stehen, etwa für ein rotiertes Log, und `-` liest stdin, etwa `cat altes.log neues.log | … audit verify --log -`. Als Anker zählt eine Zeile mit `{"ts":"` und dem Ereignis `audit_chain_anchor`, auch wenn ein Client eine Zeit oder seinen Namen davorsetzt. Packt ein Client die Zeilen von stderr selbst in JSON, findet `audit verify` darin keinen Anker und sagt das am Ende.

Es meldet jeden Befund mit dem Namen der Datei und, wo es eine gibt, der Nummer der Zeile, nie mit ihrem Inhalt:

- eine geänderte, entfernte, eingefügte oder verschobene Zeile, an der Stelle, an der die Kette bricht,
- eine umbenannte oder vertauschte Datei an ihrer ersten Zeile,
- mit einem Anker auch eine geänderte letzte Zeile, eine gekürzte Datei und Zeilen nach dem Anker,
- eine Datei, die ein Anker nennt, die aber fehlt, solange ihre Frist nicht abgelaufen ist. Nach Ablauf der Frist zählt sie nur,
- zwei verschiedene Anker im Log für dieselbe Datei,
- einen Eintrag mit dem Namen einer Audit-Datei, der keine private Datei mit einem einzigen Link ist, etwa ein Link oder eine Datei mit Rechten für andere. Ihn liest `audit verify` nicht.

Eine Datei ohne Anker ist kein Befund: Ein Absturz, ein Client, der stderr verwirft, oder ein Log, das niemand aufbewahrt, hinterlassen keinen. Ohne `--log` prüft `audit verify` nur die Ketten, eine gekürzte Datei oder eine geänderte letzte Zeile zeigt erst ein Anker. Die Datei eines laufenden Servers prüft es so weit, wie sie geschrieben ist. Dateien aus einer Version von Ecclium vor der Kette zählt es als «ohne Kette» und wertet sie nicht als Fehler, eine Datei mit nur einem Teil ihrer Zeilen in einer Kette schon. Die Kette erkennt keine Änderung durch jemanden, der auch die Kette neu berechnet, das zeigt erst ein Anker aus einer Kopie des Logs, die er nicht ändern konnte.

| Code | Bedeutung                                                                                                         |
| ---- | ----------------------------------------------------------------------------------------------------------------- |
| 0    | Die Ketten sind ganz und passen zu den Ankern.                                                                    |
| 64   | Der Aufruf ist falsch.                                                                                            |
| 65   | Es gibt mindestens einen Befund.                                                                                  |
| 66   | Der Ordner `audit` fehlt, oder ein Log lässt sich nicht lesen.                                                    |
| 70   | Ein interner Fehler.                                                                                              |
| 74   | Eine Datei liess sich nicht ganz lesen, sonst gibt es keinen Befund.                                              |
| 78   | Die Konfiguration ist ungültig, etwa ohne `ECCLIUM_STATE_DIR` oder mit Rechten für andere auf dem Ordner `audit`. |

Bei einem Befund bewahren Sie die Dateien und das Log unverändert auf, vergleichen sie mit einer Kopie an einem getrennten Ort, falls Sie eine haben, und klären, wer Zugriff auf den Zustandsordner hatte.

### Aufrufe zählen und eine Kennung suchen

```sh
env -i ECCLIUM_STATE_DIR=/pfad/zum/zustandsordner /pfad/zu/node /pfad/zum/checkout/packages/cli/dist/bin.js audit show --since 2026-10-01 --until 2026-10-31
env -i ECCLIUM_STATE_DIR=/pfad/zum/zustandsordner /pfad/zu/node /pfad/zum/checkout/packages/cli/dist/bin.js audit show --object person:42
```

`audit show` zählt je UTC-Tag und Tool die Aufrufe, ausgeführt, mit Fehler und abgelehnt, und wie viele Ergebnisse Ecclium nach dem Lesen zurückhielt. Der Tag kommt aus der Zeit der Zeile. Ohne `--since` und `--until` zeigt es alle Tage in den Dateien, mit ihnen die Tage dazwischen, beide eingeschlossen, jeweils in der Form JJJJ-MM-TT in UTC.

Mit `--object` zeigt es stattdessen jeden Aufruf, der eine Kennung nennt, mit Zeit in UTC, Tool, Subjekt und Ausgang, etwa für die Auskunft an eine Person, wer ihre Daten über Ecclium gelesen hat. Die Kennung schreiben Sie wie im Audit, `person:42`, `group:7` oder `wiki_page:` mit einer GUID. Andere Kennungen nennt die Ausgabe nicht. Sie zeigt die ersten 1'000 Treffer und darunter die Zahl aller. Eine Zeile nennt höchstens 100 Kennungen, mehr kann bisher nur `ct_api_execute_read` finden. Dann zählt `audit show`, in wie vielen Zeilen die gesuchte unter den fehlenden sein kann. Ohne Treffer kann eine Person trotzdem über Ecclium gelesen worden sein, etwa vor dem ältesten Tag im Ordner, bei einem Start ohne Zustandsordner, in einer Zeile, die nicht in die Datei kam, oder in einer Liste der Escape Hatch, deren Anfrage keine Kennungen nennt.

Zeilen, die nicht zum Schema der Ereignisse passen, zählt `audit show` und lässt sie aus. Die Ketten prüft es nicht, das tut `audit verify`. Es endet mit 0, mit 74, wenn Dateien sich nicht lesen liessen, deren Aufrufe dann fehlen, und sonst mit denselben Codes wie `audit verify`. Die Läufe einer Routine zeigt es erst mit dem Runner.

Die Ausgabe mit `--object` ist eine Auskunft über eine Person. Geben Sie sie nur an Stellen weiter, die sie bekommen dürfen.

## Toolsets

Welche Tools der Server neben `ct_whoami` anbietet, legen Sie mit `ECCLIUM_TOOLSETS` fest: eine mit Komma getrennte Liste von Bereichen, ohne Leerzeichen ([ADR 0062](../adr/0062-toolsets.md)).

| Toolset     | Bereiche                                    | Tools in dieser Version                                                                                                                       |
| ----------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `persons`   | Personen und Gruppen                        | `ct_persons_search`, `ct_persons_get`, `ct_persons_get_groups`, `ct_groups_search`, `ct_groups_get`, `ct_groups_get_members`, `ct_search`     |
| `events`    | Events und Dienste                          | `ct_events_list`, `ct_events_get`, `ct_events_get_agenda`, `ct_services_list`, `ct_services_get_assignments`                                  |
| `calendars` | Kalender, Termine, Ressourcen und Buchungen | `ct_calendars_list`, `ct_appointments_list`, `ct_appointments_get`, `ct_resources_list`, `ct_bookings_list`                                   |
| `wiki`      | Wiki                                        | `ct_wiki_categories_list`, `ct_wiki_pages_list`, `ct_wiki_page_get`, `ct_wiki_search`                                                         |
| `songs`     | Songs                                       | `ct_songs_search`, `ct_songs_get`                                                                                                             |
| `docs`      | Dokumentation von ChurchTools               | `ct_docs_search_api`, `ct_docs_get_operation`, `ct_docs_search_rights`, `ct_docs_get_right`, `ct_docs_search_academy`, `ct_docs_read_academy` |
| `api`       | Lesender Zugriff auf die API                | `ct_api_search_actions`, `ct_api_execute_read`                                                                                                |

`all` schaltet alle ein ausser `api`, auch die Toolsets späterer Versionen. `api` nennen Sie ausdrücklich, allein, in einer Liste oder als `all,api` für alle ([ADR 0067](../adr/0067-generischer-lesezugriff.md)). Ist die Variable leer oder nicht gesetzt, bietet der Server nur `ct_whoami` an. Beim Start nennt Ecclium auf stderr die Toolsets, die eingeschaltet sind, und jedes, das in dieser Version noch keine Tools mitbringt. Ein unbekannter Name, ein doppelter oder `all` neben einem anderen Namen als `api` bricht den Start ab. Die frühere Variable `ECCLIUM_SEARCH_TOOLS` bricht den Start ebenfalls ab, mit dem Hinweis auf `ECCLIUM_TOOLSETS=persons`.

## Wiki

`ct_wiki_categories_list` nennt die Kategorien des Wikis, die das Dienstkonto sehen darf, `ct_wiki_pages_list` die Seiten einer Kategorie mit Titel und Version, aber ohne Text, beide 25 je Aufruf mit weiteren Seiten. `ct_wiki_page_get` liest eine Seite und gibt einen langen Text in Teilen von höchstens 16'000 Bytes, geschnitten an einem Zeilenumbruch, wo eine Zeile hineinpasst, sonst zwischen zwei Zeichen. Den Text maskiert Ecclium nicht, auch keine E-Mail-Adressen oder Telefonnummern darin ([ADR 0026](../adr/0026-klassifizierte-ausgabeschemas.md)). `ct_wiki_search` sucht Seiten nach einem Begriff, in allen Kategorien, die das Konto sehen darf, oder in einer, und gibt die ersten 20 Treffer in der Folge von ChurchTools mit GUID, Kategorie, Titel und einem Ausschnitt des Texts. Weitere Seiten gibt es nicht. Gibt es mehr Treffer, sagt das Ergebnis, Sie sollen genauer oder in einer Kategorie suchen. Nennt ChurchTools eine Seite in einer anderen Form als mit ihrer GUID, steht dort `null`. Namen, Titel, Ausschnitte und Text stehen im Datenumschlag, Personen aus den Metadaten der Antworten von ChurchTools gibt keines der vier Tools weiter. Sie brauchen keinen Zustandsordner. Schalten Sie sie mit `ECCLIUM_TOOLSETS=wiki` ein, die Rechte des Dienstkontos stehen unter [Dienstkonto](dienstkonto.md#rechte).

## Dokumentation

Die sechs Tools des Toolsets `docs` schlagen in der Dokumentation von ChurchTools nach, die mit Ecclium ausgeliefert wird: den Operationen der API aus dem OpenAPI-Dokument, den Rechten und den frei zugänglichen deutschen Hilfeseiten der ChurchTools Academy ([ADR 0027](../adr/0027-inhalte-des-doku-index.md), [ADR 0066](../adr/0066-doku-index.md)). Sie lesen nichts aus ChurchTools und von keiner anderen Adresse, brauchen kein Recht und keinen Zustandsordner und zählen nicht gegen das Lesebudget.

- `ct_docs_search_api` sucht Operationen über englische Wörter, `ct_docs_get_operation` liest eine Operation über ihre `operationId` oder über Methode und Pfad, etwa `GET /api/groups/12/members`, mit Parametern, Anfrage, Antworten und den Rechten, die sie verlangt. Die Rechte stehen nur, wo das Projekt sie mit einem Beleg zugeordnet hat: einem Befund mit der Version von ChurchTools, an der er gefunden wurde, der Beschreibung der Operation im OpenAPI-Dokument oder einer Hilfeseite neben einem der beiden.
- `ct_docs_search_rights` sucht Rechte über Modul, Namen oder deutsche Bezeichnung, `ct_docs_get_right` liest ein Recht mit Bezeichnung, erklärenden Hilfeseiten und den Operationen, die es verlangen.
- `ct_docs_search_academy` sucht Hilfeseiten, `ct_docs_read_academy` liest eine mit Titel und Link, eine lange in Teilen von höchstens 16'000 Bytes.

So schalten Sie sie ein: Setzen Sie `ECCLIUM_TOOLSETS` auf `docs`. Jedes Ergebnis nennt seine Quelle mit Abrufdatum, beim OpenAPI-Dokument mit Lizenz CC BY 4.0, bei der Academy mit Link. Texte aus der Dokumentation stehen im Datenumschlag, weil sie aus dem Netz kommen. Mit `docs` oder `api` liest der Start den Index einmal, das dauert etwa eine Sekunde und braucht einige Dutzend MiB Speicher. Ohne beide liest er ihn nicht. Fehlt der Index oder ist er beschädigt, bricht der Start mit einer Meldung und 70 ab. Installieren Sie Ecclium dann neu, im Quellcode mit `pnpm build`, oder nehmen Sie `docs` und `api` aus `ECCLIUM_TOOLSETS`.

## Lesender Zugriff auf die API

Für alles, was kein eigenes Tool hat, ruft `ct_api_execute_read` eine lesende Operation der API von ChurchTools auf, die Ecclium freigibt, und gibt die ganze Antwort weiter ([ADR 0067](../adr/0067-generischer-lesezugriff.md)). `ct_api_search_actions` sucht diese Operationen in der Dokumentation, die mit Ecclium ausgeliefert wird, und nennt je Operation Pfad, Parameter, Sensibilität und die Rechte, die das Projekt ihr mit Beleg zugeordnet hat. Die Suche fragt ChurchTools nicht.

- Freigegeben sind nur Operationen mit `GET`, jede von Hand eingestuft: die Bereiche, für die Ecclium Tools hat, und die Rechte, mit ihren Stammdaten wie Gruppentypen und Rollen. Nie erreichbar sind Operationen mit Tokens oder Geheimnissen, Dateien, Finanzen, Protokollen, Exporten und Einstellungen, ebenso Seelsorge und Gesundheit, Kommunikation zwischen Personen, übergreifende Stammdaten und die Liste der Geburtstage. Ecclium weist sie ab, bevor es ChurchTools fragt.
- Den Pfad baut Ecclium nur aus der Vorlage der Operation, mit geprüften Werten, und es sendet nur Parameter, die die Operation kennt. Eine Adresse, eine Kopfzeile oder ein anderer Host aus einer Eingabe gelangt nicht in die Anfrage.
- Die Antwort geht als JSON-Text im Datenumschlag hinaus. Ecclium verbirgt Felder mit einem Geheimnis, etwa den Abo-Link eines Kalenders, ganz und maskiert E-Mail-Adressen, Telefonnummern und Geburtsdaten. Adressen, Angaben zur Konfession, Notizen und alle anderen Felder gehen unmaskiert hinaus, soweit das Dienstkonto sie sehen darf. Die eigentliche Grenze sind die Rechte des Dienstkontos.
- Eine Antwort wird nie gekürzt. Passt sie nicht in ein Ergebnis, etwa 20 bis 30 KiB JSON, endet der Aufruf mit einem Hinweis, weniger Einträge mit `limit` oder einem Filter zu holen.
- Lehnt ChurchTools eine Operation ab, nennt der Fehler die Rechte, die das Projekt ihr zugeordnet hat. Hat sie keine Zuordnung, verweist er auf `ct_api_search_actions`.

So schalten Sie sie ein: Setzen Sie `ECCLIUM_TOOLSETS` auf `api` oder nehmen Sie `api` in die Liste auf, und setzen Sie `ECCLIUM_STATE_DIR` auf einen Ordner nach «Audit-Datei». `ct_api_execute_read` behandelt Ecclium wie die Tools für Personen: Sein Ergebnis geht nur mit seiner Zeile in der Audit-Datei hinaus, jeder Aufruf zählt gegen das Lesebudget, und es läuft nie unbeaufsichtigt. Ohne den Ordner meldet `config check` ein Problem, und der Start bricht mit 78 ab. Unter Windows gibt es über stdio kein Toolset `api`. Bei jedem Start meldet Ecclium auf stderr, dass `api` eingeschaltet ist und was unmaskiert bleibt. Wie `docs` liest der Start dafür den Index der Dokumentation und bricht ohne ihn mit 70 ab. Schalten Sie `api` nur für eine Instanz ein, deren Daten der KI-Assistent im Rahmen der Rechte des Dienstkontos sehen darf.

## Songs

`ct_songs_search` sucht Songs nach einem Begriff, 10 je Aufruf mit weiteren Seiten, je mit Kennung, Name, Kategorie, Autor, Copyright, CCLI-Nummer und den ersten 3 Arrangements mit Kennung, Name, Tonart und ob es das Standard-Arrangement ist, das Standard-Arrangement zuerst. `ct_songs_get` liest einen Song über seine Kennung mit bis zu 20 Arrangements. Hat ein Song mehr, sagt das Ergebnis es. Texte, Akkorde, Noten, Dateien und Links eines Songs gibt keines der beiden Tools weiter.

So schalten Sie sie ein: Setzen Sie `ECCLIUM_TOOLSETS` auf `songs`. Songs nennen keine Personen von ChurchTools. Die Tools brauchen keinen Zustandsordner und zählen nicht gegen das Lesebudget. Name, Kategorie, Autor, Copyright, CCLI-Nummer und die Angaben der Arrangements stehen im Datenumschlag. Die Rechte des Dienstkontos stehen unter [Dienstkonto](dienstkonto.md#rechte).

- Eine leere Suche kann auch heissen, dass dem Konto das Recht für eine Kategorie fehlt, das Ergebnis sagt das. Einen Song einer Kategorie ohne Recht lehnt ChurchTools ab, und das Ergebnis nennt das Recht.
- Ein Name, ein Autor, ein Copyright oder eine CCLI-Nummer über 255 Zeichen, eine Tonart über 32 Zeichen und mehr als 100 Arrangements eines Songs beenden den Aufruf mit einem Fehler.

## Events und Dienste

`ct_events_list` nennt die Events zwischen zwei Tagen, höchstens 31 Tage einschliesslich beider Enden, je mit Kennung, Name, Beginn, Ende, ob es abgesagt ist, und dem Kalender, 25 je Aufruf, das früheste zuerst. `ct_events_get` liest ein Event mit Notiz und Beschreibung, `ct_events_get_agenda` seinen Ablauf, 10 Punkte je Aufruf, je mit Position, Art, Titel, Beginn, Dauer in Sekunden, Notiz und Lied. `ct_services_list` nennt die Dienste mit ihrer Dienstgruppe und ob sie die Namen der Eingeteilten verbergen, 25 je Aufruf. `ct_services_get_assignments` nennt, wer in die Dienste eines Events eingeteilt ist, 25 je Aufruf, je mit Dienst, ob die Einteilung angenommen und zugesagt ist, und der Person mit Kennung und Namen.

So schalten Sie sie ein: Setzen Sie `ECCLIUM_TOOLSETS` auf `events` und `ECCLIUM_STATE_DIR` auf einen Ordner nach «Audit-Datei». Die Einteilungen nennen Personen. Deshalb gibt Ecclium ihr Ergebnis wie bei den Tools für Personen nur heraus, wenn seine Zeile in der Audit-Datei steht, und jeder Aufruf zählt gegen das Lesebudget, siehe «Personen und Gruppen». Ohne den Ordner meldet `config check` ein Problem, und der Start bricht mit 78 ab. Unter Windows gibt es über stdio kein Toolset `events`. Bei jedem Start meldet Ecclium auf stderr, dass das Toolset `events` eingeschaltet ist. Die Rechte des Dienstkontos stehen unter [Dienstkonto](dienstkonto.md#rechte).

- Beginn und Ende stehen in UTC, wie ChurchTools sie liefert, mit «T» und `Z`. Die Tage für `ct_events_list` geben Sie als `JJJJ-MM-TT` an.
- `ct_events_list` fragt ChurchTools nach höchstens 51 Events und gibt davon die 50 frühesten weiter, auf zwei Seiten. Gibt es mehr, sagt ein Hinweis, dass Sie weniger Tage wählen sollen. Für die Einteilungen fragt Ecclium ChurchTools nach dem Event und den Diensten, je Seite neu, und jede Seite zählt gegen das Lesebudget. Ob ChurchTools die Liste selbst kürzt, ist nicht geprüft.
- Einteilungen gibt nur `ct_services_get_assignments` weiter, `ct_events_get` nie. Bei einem Dienst, der die Namen verbirgt, bei einem Dienst, der in der Liste der Dienste fehlt, und wenn ChurchTools keine Kennung der Person ab 1 oder keinen Nachnamen liefert, steht statt der Person `null`, und das Ergebnis sagt das. Die anfragende Person einer Einteilung liest Ecclium nie.
- Wer für einen Punkt des Ablaufs verantwortlich ist und die Notizen der Dienstgruppen dazu liest Ecclium nicht.
- Namen von Events, Kalendern, Diensten, Dienstgruppen, Punkten und Liedern, Notizen und Beschreibungen stehen im Datenumschlag, Namen von Personen nicht, wie bei den Tools für Personen.
- Ein leeres Ergebnis kann auch heissen, dass dem Konto das Recht fehlt. Das Ergebnis sagt das und nennt das Recht. Eine verweigerte Anfrage nennt das Recht, eine unbekannte Kennung den Weg zur Kennung über `ct_events_list`. Ein Event ohne Ablauf meldet `ct_events_get_agenda` vermutlich wie eine unbekannte Kennung, geprüft ist das nicht.
- Eine Notiz eines Punkts über 1000 Zeichen, eine Notiz eines Events über 2000 und eine Beschreibung über 7000 Zeichen beenden den Aufruf mit einem Fehler. Volle Seiten mit sehr langen Namen ausserhalb von ASCII können ein Ergebnis über 64 KiB bringen, der Aufruf endet dann ebenfalls mit einem Fehler.

## Kalender und Ressourcen

`ct_calendars_list` nennt die Kalender, die das Dienstkonto sehen darf, je mit Kennung, Name und ob er öffentlich oder privat ist, 25 je Aufruf. `ct_appointments_list` nennt die Termine von bis zu 10 Kalendern zwischen zwei Tagen, höchstens 31 Tage einschliesslich beider Enden, je mit Kennung, Kalender, Titel, Untertitel, ob er ganze Tage dauert, dem Namen des Orts, Beginn und Ende, 25 je Aufruf, der früheste zuerst. Jeder Tag einer Serie ist ein eigener Eintrag mit der Kennung der Serie. `ct_appointments_get` liest einen Termin über die Kennungen seines Kalenders und von ihm selbst, mit Beschreibung, Link und seinen 25 frühesten Daten. `ct_resources_list` nennt die Ressourcen, etwa Räume, mit ihrem Typ, 25 je Aufruf, und `ct_bookings_list` die Buchungen von bis zu 10 Ressourcen zwischen zwei Tagen, je mit Kennung, Titel, Ressource, Stand, Termin, Beginn und Ende, 25 je Aufruf.

So schalten Sie sie ein: Setzen Sie `ECCLIUM_TOOLSETS` auf `calendars`. Keines der fünf Tools nennt Personen in einem eigenen Feld. Sie brauchen keinen Zustandsordner und zählen nicht gegen das Lesebudget. Die Rechte des Dienstkontos stehen unter [Dienstkonto](dienstkonto.md#rechte).

- Termine und Buchungen fragt ein Tool nur mit den Kennungen der Kalender oder Ressourcen ab. Sie kommen aus `ct_calendars_list` und `ct_resources_list`.
- Beginn und Ende stehen in UTC, wie ChurchTools sie liefert, mit «T» und `Z`. Einen Termin oder eine Buchung über ganze Tage geben die Listen mit Beginn und Ende als Tag allein weiter, `JJJJ-MM-TT`, wie ChurchTools ihn liefert. Die Daten eines einzelnen Termins tragen eine Uhrzeit. Die Tage für die Listen geben Sie als `JJJJ-MM-TT` an.
- ChurchTools nimmt für Termine und Buchungen keine Grenze an. Ecclium liest höchstens 1000 Einträge einer Antwort und gibt davon die 50 frühesten weiter, auf zwei Seiten. Gibt es mehr, sagt ein Hinweis, dass Sie weniger Tage oder weniger Kalender oder Ressourcen wählen sollen. Mehr als 1000 Einträge beenden den Aufruf mit einem Fehler, der um weniger Tage, Kalender oder Ressourcen bittet.
- Vom Ort eines Termins liest Ecclium nur den Namen, nie Strasse, Postleitzahl, Ort oder Koordinaten. Den Link eines Kalenders zum Abonnieren und die Person, die eine Buchung beantwortet hat, liest es nie.
- Den Stand einer Buchung gibt Ecclium als Zahl weiter, wie ChurchTools sie liefert. Was die Zahlen bedeuten, nennt es nicht.
- Titel, Untertitel, Namen, Orte, Beschreibungen und Links stehen im Datenumschlag.
- Eine leere Liste der Kalender oder Ressourcen kann auch heissen, dass dem Konto das Recht fehlt, das Ergebnis sagt das. Termine und Buchungen eines Kalenders oder einer Ressource ohne Recht lehnt ChurchTools ab, und das Ergebnis nennt das Recht. Ob ChurchTools aus einer Liste mit mehreren Kennungen die ohne Recht stillschweigend weglässt, ist nicht geprüft, das Ergebnis sagt das bei einer leeren Liste. Einen Termin eines Kalenders oder eine Buchung einer Ressource, nach dem nicht gefragt war, weist Ecclium mit einem Fehler ab.
- Eine Beschreibung über 7000 und ein Link über 1000 Zeichen beenden den Aufruf mit einem Fehler. Volle Seiten mit sehr langen Namen ausserhalb von ASCII können ein Ergebnis über 64 KiB bringen, der Aufruf endet dann ebenfalls mit einem Fehler.

## Personen und Gruppen

`ct_persons_search` sucht Personen, `ct_groups_search` Gruppen nach ihrem Namen. Beide lesen nur und geben je Treffer nur die Kennung und den Namen weiter, höchstens 50 Treffer je Aufruf, ohne weitere Seiten. Gibt es mehr, sagt das Ergebnis es. Über die Kennung lesen vier weitere Tools eine Person, die Gruppen einer Person, eine Gruppe und ihre Mitglieder, siehe «Lesen über die Kennung». Personen und Gruppen einer Gemeinde lassen auf die Religionszugehörigkeit schliessen. Deshalb bietet Ecclium die sechs Tools und die globale Suche `ct_search` nur mit dem Toolset `persons` an und gibt ein Ergebnis nur heraus, wenn seine Zeile in der Audit-Datei steht ([ADR 0060](../adr/0060-leserechte-und-felder-der-suchtools.md), [ADR 0064](../adr/0064-leserechte-und-felder-der-lese-tools.md)).

So schalten Sie sie ein: Setzen Sie im Abschnitt `env` des Eintrags `ecclium` neben der Adresse und der Token-Datei `ECCLIUM_TOOLSETS` auf `persons` und `ECCLIUM_STATE_DIR` auf einen Ordner nach «Audit-Datei»:

```json
"ECCLIUM_TOOLSETS": "persons",
"ECCLIUM_STATE_DIR": "/pfad/zum/zustandsordner"
```

Ohne den Ordner meldet `config check` ein Problem, und der Start bricht mit 78 ab. Unter Windows gibt es über stdio keine Audit-Datei und damit kein Toolset `persons`. Bei jedem Start meldet Ecclium auf stderr, dass das Toolset `persons` eingeschaltet ist.

Geben Sie dem Dienstkonto dafür die Rechte der Tools aus der Tabelle unter [Rechte](dienstkonto.md#rechte), nur für die Bereiche und Gruppentypen, die gelesen werden sollen, keine Sicherheitsstufe für Personen und für `ct_groups_get` die niedrigste Stufe für Gruppen. Hat das Konto mehr Rechte, weist Ecclium es nicht ab. Welche es hat, zeigt `ct_whoami`.

Was die Suchtools tun und was nicht:

- `ct_persons_search` sendet `GET /api/persons`, `ct_groups_search` `GET /api/groups`, je mit genau dem Suchbegriff, der ersten Seite und 51 Einträgen. Kommt ein 51. Eintrag, sagt das Ergebnis, dass es mehr Treffer gibt. Zahlen wie die Gesamtzahl der Treffer gibt Ecclium nicht weiter, weil offen ist, ob ChurchTools darin Einträge mitzählt, die das Konto nicht sehen darf.
- Ein Begriff trifft den Anfang oder einen Teil eines Namens, auch kleingeschrieben, bei Personen auch einen ganzen Vor- oder Nachnamen und Vor- und Nachname in dieser Reihenfolge, aber nicht in der umgekehrten und nie die E-Mail-Adresse. Ob ein ganzer Name einer Gruppe trifft, ist nicht geprüft. Er hat 1 bis 100 Zeichen ohne Leerzeichen am Rand und ohne Steuerzeichen. Eine Suche ohne Begriff, die alle Personen zeigte, lehnt Ecclium ab.
- Namen von Personen gibt diese Version unmaskiert und ohne Datenumschlag weiter, wie bei `ct_whoami`. Namen von Gruppen stehen im Datenumschlag, weil Personen der Gemeinde sie frei wählen.
- Ein leeres Ergebnis kann auch heissen, dass dem Konto das Recht fehlt: ChurchTools antwortet dann mit einer leeren Liste, nicht mit einem Fehler. Das Ergebnis sagt das und nennt das Recht.
- Personen ausserhalb der Bereiche des Kontos und Gruppen ausserhalb seiner Gruppentypen findet die Suche nicht, ohne Fehler. Gruppen mit der Sichtbarkeit «intern» findet sie dagegen auch ohne Recht auf Gruppen. Ob versteckte Gruppen ausgelassen werden, ist nicht geprüft.
- Passt der Name des Dienstkontos zum Begriff, kann sein eigener Datensatz unter den Treffern sein.
- Die Zeile des Audits nennt das Tool und den Ausgang, nie den Suchbegriff, einen Namen oder eine Kennung.
- `ct_search` ist die globale Suche von ChurchTools. Sie sucht je Aufruf eine Art, Personen, Gruppen, Songs oder Seiten des Wikis, und gibt höchstens 50 Treffer nur mit Kennung, bei Seiten mit GUID, und Titel weiter, Personen mit Kennung und Namen. Anders als `ct_persons_search` findet sie eine Person auch mit dem Nachnamen vor dem Vornamen. Weil sie Personen findet, behandelt Ecclium sie wie die übrigen sechs Tools: mit Audit-Datei und Lesebudget, auch wenn Sie Songs oder Seiten suchen. Mit dem Toolset `persons` findet sie deshalb auch Songs und Seiten des Wikis, die das Konto sehen darf, auch wenn die Toolsets `songs` und `wiki` aus sind.
- Die sieben Tools zusammen, jedes weitere Tool mit Personendaten der besonderen Kategorie und jedes Tool, das Namen anderer Personen nennt, etwa `ct_services_get_assignments`, haben ein gemeinsames Lesebudget von 200 Aufrufen je Subjekt und UTC-Tag. Danach antworten sie bis 00:00 UTC mit einer Ablehnung, und das Log nennt den Grund mit `read_budget_exhausted`. Die Zähler liegen im Ordner `quota` des Zustandsordners und überstehen einen Neustart ([ADR 0063](../adr/0063-quotastore-als-datei.md)). Was darin steht, sagt [Datenschutz](../privacy.md).

### Lesen über die Kennung

`ct_persons_get` liest eine Person über ihre Kennung und gibt Kennung, Vor- und Nachname weiter und ob sie archiviert ist. `ct_persons_get_groups` nennt höchstens 50 Gruppen einer Person, je mit Kennung und Name der Gruppe, der Kennung der Rolle und dem Stand der Mitgliedschaft, etwa `active`. `ct_groups_get` liest eine Gruppe mit Name, Treffzeit, Notiz, Höchstzahl der Mitglieder, Zielgruppe, Gründung und Ende. `ct_groups_get_members` nennt die Mitglieder einer Gruppe, 50 je Aufruf mit weiteren Seiten, je mit Kennung und Namen der Person, der Kennung der Rolle und dem Stand der Mitgliedschaft.

- Kontaktdaten, Geburtstag und Adresse gibt keines der vier Tools weiter.
- Namen von Gruppen, Treffzeit und Notiz stehen im Datenumschlag, Namen von Personen nicht, wie bei der Suche.
- Die Tools senden `GET /api/persons/{personId}`, `GET /api/persons/{personId}/groups` ohne Parameter, `GET /api/groups/{groupId}` und `GET /api/groups/{groupId}/members` mit `page` und 50 Einträgen, nie `personFields[]` oder `include`. Sie nehmen nur Kennungen als ganze Zahlen an, keine GUID.
- Die Gruppen einer Person zeigen, was ChurchTools ohne seine Schalter für vergangene, inaktive, angefragte und zu löschende Mitgliedschaften zeigt.
- Fehlt dem Dienstkonto die niedrigste Stufe von «Gruppeninfos sehen - bis zum gewählten Sicherheitslevel», gibt ChurchTools die Angaben einer Gruppe nicht mit. `ct_groups_get` gibt dann nur Kennung und Name weiter und nennt das Recht. Gründung und Ende nimmt Ecclium nur als Tag ohne Zeit an, weil keine Probe ihr Format gezeigt hat. Kommt eine andere Form, endet der Aufruf mit einem Fehler.
- Mitglieder ausserhalb der Bereiche des Kontos lässt ChurchTools ohne Eintrag weg. Weil die Seiten von ChurchTools sie womöglich mitzählen, kann eine spätere Seite leer sein, und das Ergebnis sagt das.
- Eine unbekannte Kennung ergibt einen Fehler mit dem Rat, die Kennung über die Suche zu finden, eine verweigerte Person oder Gruppe einen Fehler, der das Recht nennt. Leere Gruppen einer Person und eine leere erste Seite der Mitglieder nennen die Rechte, weil ChurchTools ohne sie leer antwortet, auch wenn ChurchTools weitere Seiten meldet.
- Jeder Aufruf und jede Seite der Mitglieder zählt gegen das Lesebudget.
- 50 Mitglieder oder Gruppen mit sehr langen Namen ausserhalb von ASCII, etwa 255 Zeichen mit Umlauten, können ein Ergebnis über 64 KiB bringen. Der Aufruf endet dann mit einem Fehler, wie bei der Suche.

## Prompts

Ein Prompt ist eine feste Vorlage für einen häufigen Ablauf. Sie wählen ihn in Ihrem KI-Assistenten aus, geben die Argumente ein, und sein Text erscheint im Gespräch als Ihre Nachricht. In Claude Code geben Sie ihn als Befehl ein, etwa `/mcp__ecclium__dienstplan_wochenende 2026-10-31`, wenn der Server in Ihrer Konfiguration `ecclium` heisst. Claude Code setzt in ein Argument nur das erste Wort ein, auch zwischen Anführungszeichen (geprüft mit Version 2.1.314). Am 31.10.2026 sah der KI-Assistent die ganze Eingabe trotzdem daneben und arbeitete mit ihr, ob das immer so ist, ist nicht geprüft. Für die Rechte-Diagnose geben Sie in Claude Code deshalb am besten ein Wort ohne Leerzeichen ein, etwa `/mcp__ecclium__rechte_diagnose ct_groups_get_members` oder die `operationId`. Andere Clients wie Claude Desktop bieten Prompts in ihrer Oberfläche an, wenn sie Prompts unterstützen.

| Prompt                  | Titel                                              | Argument                                                                                                                 | Angeboten mit                     |
| ----------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| `dienstplan_wochenende` | Dienstplan-Überblick für ein Wochenende            | `samstag`, ein Samstag als `JJJJ-MM-TT`                                                                                  | `events`, mit `ECCLIUM_STATE_DIR` |
| `wiki_seite_entwerfen`  | Wiki-Seite aus Stichworten                         | `stichworte`, ein Text von höchstens 2'000 Zeichen                                                                       | `wiki`                            |
| `rechte_diagnose`       | Rechte-Diagnose bei einem fehlgeschlagenen Zugriff | `zugriff`, ein Text von höchstens 2'000 Zeichen: das Tool, die `operationId` oder Methode und Pfad, gern mit der Meldung | `docs`                            |

Der Server bietet einen Prompt nur an, wenn er alle Tools anbietet, auf die sich der Prompt stützt. Ohne Toolsets gibt es also keine Prompts. Für einen Prompt liest der Server nichts aus ChurchTools: Er prüft die Argumente, setzt sie in den Text und schreibt eine Zeile ins Log, keine ins Audit. Erst die Tools, die der KI-Assistent danach aufruft, lesen. Der Entwurf einer Seite bleibt ein Entwurf, Ecclium legt die Seite nicht an. Die Rechte-Diagnose liest das Konto des Servers und schlägt in der Dokumentation nach, die mit Ecclium kommt. Ihr Text lässt nur Rechte vorschlagen, die die Dokumentation mit Beleg verlangt, und von einer Sicherheitsstufe für Personen abraten, wie die Anleitung zum [Dienstkonto](dienstkonto.md). Ob der KI-Assistent sich daran hält, entscheidet das Modell. Die Rechte vergeben Sie selbst in ChurchTools. Die Texte stehen ganz in [docs/prompts.md](../prompts.md).

## Smoke-Test

Mit `scripts/smoke.mts` prüfen Sie, ob der gebaute Server mit Ihrem Dienstkonto wie erwartet antwortet, ohne einen Client einzurichten. Der Smoke-Test startet den Server zweimal über stdio, einmal in der neueren und einmal in der älteren Fassung des Protokolls MCP. Er listet die Tools und die Prompts, ruft `ct_whoami` und die sechs Tools der Dokumentation auf und prüft die Antworten, die Zahl der Anfragen an ChurchTools, die Audit-Datei und das Ende des Servers. Er liest nur, schreibt nichts in ChurchTools und gibt nur die Form der Antworten aus, keine Namen, Kennungen, Adressen und nie das Token. Für den Server legt er einen eigenen Zustandsordner im temporären Ordner an und löscht ihn danach wieder.

```sh
env -i ECCLIUM_CHURCHTOOLS_URL=https://example.church.tools ECCLIUM_CHURCHTOOLS_TOKEN_FILE=/pfad/zur/token-datei /pfad/zu/node /pfad/zum/checkout/scripts/smoke.mts
```

Der Server bekommt nur die Adresse, die Token-Datei, den Zustandsordner, `ECCLIUM_READ_ONLY=true`, auch wenn Ihre Shell etwas anderes setzt, und `ECCLIUM_TOOLSETS=docs`, mit dem Schalter unten `ECCLIUM_TOOLSETS=persons,events,calendars,wiki,songs,docs` und mit dem zweiten Schalter dazu `api`. Das Token nimmt der Smoke-Test nur aus der Datei, unter einem absoluten Pfad. Variablen wie `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS` oder `NODE_USE_ENV_PROXY` weist er ab. Schreibt der Server nach seinen Startmeldungen Text auf stderr, der kein JSON ist, gilt das als Fehler, weil darin unbemerkt ein Name stehen könnte.

Die sechs Tools der Dokumentation ruft der Smoke-Test in jedem Lauf auf, auch ohne Schalter, weil sie nur im Index lesen, der mit Ecclium kommt, und ChurchTools nicht fragen. So prüft er auch auf einer Instanz Ihrer Gemeinde, ob der Index Ihrer Installation brauchbar ist. Er sucht Operationen mit «group members» und liest den Eintrag der Operation `GET /api/groups/12/members`, die die Mitglieder einer Gruppe liefert, sucht Rechte mit «view alldata» und liest `churchdb: view alldata`, sucht Hilfeseiten der Academy mit «Rechte» und liest die erste gefundene Seite. Er prüft die Form jedes Ergebnisses, die Quelle mit Lizenz oder Link und dass jeder Text im Datenumschlag steht, nicht den Wortlaut der Dokumentation. Fehlt der Index oder ist er beschädigt, startet der Server nicht, und der Lauf scheitert.

Die Tools für Personen und Gruppen, für Events und Dienste, für Kalender und Ressourcen, für Songs und die Suchen ruft der Smoke-Test nur auf einer Testinstanz mit synthetischen Daten auf, die eine Wiki-Kategorie `testinstanz-kennung` trägt, wie sie die Proben in `scripts/spike/` verlangen. Setzen Sie dafür `ECCLIUM_SMOKE_ALLOW_SEARCH` auf den ersten Teil des Hosts, von Hand getippt und nicht aus der Variablen der Adresse kopiert, und `ECCLIUM_SMOKE_QUERY` auf einen Suchbegriff. Der Smoke-Test liest dann mit dem Token zuerst die Wiki-Kategorien und die Version von ChurchTools. Sieht das Konto nicht genau eine solche Kategorie, die es weder bearbeiten noch löschen darf, bricht er ab, ohne den Server zu starten. Sonst sucht er Personen und Gruppen mit dem Begriff, Personen mit einem erfundenen Begriff ohne Treffer und mit einem Begriff nur aus Leerzeichen, den der Server abweisen muss, ohne ChurchTools zu fragen. Mit der ersten gefundenen Person ruft er danach `ct_persons_get` und `ct_persons_get_groups` auf, mit der ersten gefundenen Gruppe `ct_groups_get` und die erste Seite von `ct_groups_get_members`. Findet die Suche keine Person oder keine Gruppe, entfallen diese Aufrufe. Danach sucht er mit `ct_events_list` ein Event in bis zu drei Zeiträumen von 31 Tagen ab einer Woche vor dem Tag des Laufs, liest mit dem ersten gefundenen Event `ct_events_get`, `ct_events_get_agenda` und `ct_services_get_assignments` und ruft `ct_services_list` auf. Findet er kein Event, meldet er den Befund `kein_event_gefunden`, hat das Event keinen Ablauf, den Befund `kein_ablauf`. Zuletzt ruft er `ct_calendars_list` auf, sucht mit dem ersten Kalender in denselben Zeiträumen einen Termin mit `ct_appointments_list`, liest den ersten gefundenen mit `ct_appointments_get`, ruft `ct_resources_list` auf und sucht mit der ersten Ressource Buchungen mit `ct_bookings_list`. Fehlt ein Kalender, ein Termin, eine Ressource oder eine Buchung, meldet er den Befund `kein_kalender_gefunden`, `kein_termin_gefunden`, `keine_ressource_gefunden` oder `keine_buchung_gefunden`. Unter `ganztaegig` sagt er, ob ein Eintrag über ganze Tage mit Zeit oder als Tag allein kam. Danach sucht er Songs mit `ct_songs_search`, liest den ersten mit `ct_songs_get`, liest die Kategorien des Wikis mit `ct_wiki_categories_list` und die Seiten der ersten Kategorie mit `ct_wiki_pages_list`, sucht im Wiki mit `ct_wiki_search`, liest die erste Seite, deren Treffer GUID und Kategorie trägt, mit `ct_wiki_page_get`, ohne einen solchen Treffer die erste Seite der Liste, und ruft `ct_search` für jede der vier Arten auf. Unter `quelle` sagt er, ob die gelesene Seite aus der Suche oder aus der Liste kam. Die Songs sucht er mit `ECCLIUM_SMOKE_SONG_QUERY`, wenn Sie diese Variable setzen, sonst mit dem Begriff aus `ECCLIUM_SMOKE_QUERY`, ebenso `ct_search` für Songs. Fehlt ein Song, eine Kategorie, eine Seite in der Liste, ein Treffer im Wiki oder ein Treffer der globalen Suche, meldet er den Befund `kein_lied_gefunden`, `keine_kategorie_gefunden`, `keine_wikiseite_gefunden`, `keine_seite_gefunden` oder `globale_suche_ohne_treffer`, trägt ein Treffer im Wiki keine GUID, den Befund `seite_ohne_guid`. Unter `guid` sagt er, ob die Treffer der Seiten eine GUID trugen, und unter `artfremd`, ob eine Suche einen Treffer einer anderen Art als der gefragten bekam. Zuletzt prüft er, dass jedes Tool, das der Server anbietet, einen Aufruf bekam. Ein Tool, für dessen Aufruf ChurchTools nichts lieferte, etwa `ct_events_get` ohne Event, nennt er unter `ohneAufruf`. Was fehlte, sagt ein Befund oben oder, wenn schon der Aufruf davor scheiterte, ein Fehler. Ein solches Tool lässt den Lauf nicht scheitern: Dass jedes Tool mit Daten lief, zeigt erst ein leeres `ohneAufruf`. Bekam ein Tool aus einem anderen Grund keinen Aufruf, etwa weil der Server ein Tool anbietet, das der Smoke-Test nicht kennt, scheitert der Lauf mit `nicht_aufgerufen`. Gibt der Server die Liste der Tools oder der Prompts nur in Seiten heraus, gilt sie als abweichend. Ohne Schalter prüft er, dass der Server nur die Rechte-Diagnose anbietet. Mit Schalter ruft er alle drei Prompts mit erfundenen Werten ab, einem Samstag, Stichworten und einem fehlgeschlagenen Zugriff, prüft den Text und ob der Server einen Freitag als Samstag abweist, ohne Schalter nur die Rechte-Diagnose. In beiden Fällen muss der Server einen leeren Zugriff abweisen, und unter `prompts` steht, ob alles so war.

Die beiden Tools des lesenden Zugriffs auf die API ruft der Smoke-Test nur mit einem zweiten Schalter auf, `ECCLIUM_SMOKE_ALLOW_API`, wieder mit dem ersten Teil des Hosts von Hand getippt, und nur zusammen mit `ECCLIUM_SMOKE_ALLOW_SEARCH`, also nur hinter dem Wächter der Testinstanz. Ohne den ersten Schalter bricht er mit 78 ab. Er sucht mit `ct_api_search_actions` nach «wiki categories», liest mit `ct_api_execute_read` die Kategorien des Wikis und die Rechte des Kontos und prüft, dass jede Antwort als JSON im Datenumschlag steht. Danach muss der Server drei Aufrufe abweisen, ohne ChurchTools zu fragen: das CSRF-Token, das Ecclium nie liest, eine `operationId`, die es nicht gibt, und einen Wert des Pfads, der aus seiner Vorlage hinaus will. Unter `warnung` steht, ob der Server beim Start vor `api` gewarnt hat.

Die Ausgabe ist JSON. `ergebnis` sagt `bestanden` oder `gescheitert`, `fehler` nennt die gescheiterten Prüfungen und `befunde` Hinweise, die den Lauf nicht scheitern lassen, etwa `sicherheitsstufe`, wenn das Konto eine Sicherheitsstufe für Personen hat. Eine Stufe für Gruppen meldet er nicht, weil `ct_groups_get` die niedrigste braucht und die Rechte von ChurchTools die Stufen nur als Kennungen nennen. Der Smoke-Test endet mit einem dieser Codes:

| Code | Bedeutung                                                                                                                                                                                                                                                                           |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Alle Prüfungen sind bestanden.                                                                                                                                                                                                                                                      |
| 1    | Mindestens eine Prüfung ist gescheitert, siehe `fehler`.                                                                                                                                                                                                                            |
| 64   | Nach dem Befehl stand ein Argument.                                                                                                                                                                                                                                                 |
| 69   | Die Instanz war für das Lesen der Wiki-Kategorien nicht erreichbar, etwa wegen Netz, TLS, Zeitlimit, einer Weiterleitung oder einer zu grossen Antwort.                                                                                                                             |
| 70   | Ein interner Fehler, oder die Ausgabe ist zurückgehalten, weil sie womöglich Daten aus ChurchTools enthielte.                                                                                                                                                                       |
| 77   | Die Kennkategorie fehlt, ist doppelt, bearbeitbar oder löschbar, die Antwort zu den Wiki-Kategorien hat eine andere Form, oder einer der Schalter passt nicht zum Host.                                                                                                             |
| 78   | Eine Variable fehlt oder ist ungültig, der Schalter der Escape Hatch steht ohne den der Suchtools, die Token-Datei ist unsicher, ChurchTools weist das Token ab, der temporäre Ordner ist nicht beschreibbar, der Server ist nicht gebaut, oder der Smoke-Test läuft unter Windows. |

Unter Windows läuft der Smoke-Test nicht, weil es dort über stdio keine Audit-Datei gibt.

## Grenzen

- Nur `ct_whoami`, mit dem Toolset `persons` die sechs Tools für Personen und Gruppen und die globale Suche, mit `events` die fünf Tools für Events, Abläufe und Dienste, mit `calendars` die fünf Tools für Kalender, Termine, Ressourcen und Buchungen, mit `wiki` die vier Tools des Wikis, mit `songs` die zwei Tools für Songs, mit `docs` die sechs Tools der Dokumentation und mit `api` die zwei Tools des lesenden Zugriffs auf die API. Tools, die schreiben, kommen mit späteren Versionen.
- Drei Prompts, je mit dem Toolset ihrer Tools. Ein Prompt beschreibt nur Schritte, was der KI-Assistent daraus macht, entscheidet das Modell.
- Der Start fragt ChurchTools nicht an. Ein ungültiges oder entzogenes Token zeigt sich erst beim ersten Aufruf eines Tools.
- `ct_whoami` verlangt kein Recht in ChurchTools. Geprüft ist das bisher nur mit einem Konto, das zwei Rechte im Wiki hatte, nicht mit einem Konto ganz ohne Rechte.
- Rechte, die das Konto über eine Gruppe erhält, können fehlen. Ein entzogenes Recht kann noch eine Weile erscheinen, auf einer Testinstanz mit ChurchTools 3.137 einmal mindestens etwa zwanzig Minuten lang (siehe [Befunde zur API von ChurchTools](../research/churchtools-api.md)).
- Ein Client, der stderr nicht liest, verliert Zeilen des Logs und, ohne Audit-Datei, des Audits, wie oben beschrieben.
- Der KI-Assistent kann, was er über Ecclium liest, über ein anderes Tool desselben Clients weitergeben, etwa nach einer Injection, auch über ein eingebautes Tool des Clients mit Netzzugriff. Betreiben Sie Ecclium nicht im selben Client wie Server mit freiem Netzzugriff, und prüfen Sie, welche eingebauten Tools mit Netzzugriff Ihr Client anbietet.
