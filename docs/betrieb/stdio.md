# Betrieb über stdio

**In Entwicklung.** Es gibt noch keine veröffentlichte Version. Diese Seite beschreibt, wie Sie Ecclium aus dem Quellcode bauen und als lokalen Server über stdio in Claude Desktop oder Claude Code einbinden. Über stdio startet der Client den Server als eigenen Prozess auf Ihrem Rechner und spricht mit ihm über stdin und stdout.

In der Voreinstellung bietet der Server nur das Tool `ct_whoami` an. Es zeigt, mit welchem Konto Ecclium ChurchTools liest und welche Rechte ChurchTools diesem Konto gibt. Auf ausdrücklichen Wunsch kommen die Suchtools `ct_persons_search` und `ct_groups_search` dazu, siehe «Suchtools». Alle drei lesen nur und ändern in ChurchTools nichts.

Ecclium ist ein unabhängiges Projekt und steht in keiner Verbindung zum Hersteller von ChurchTools.

Geprüft am 19.10.2026 unter macOS 27.0 mit Claude Code 2.1.302 und Claude Desktop 2.31226.1: In beiden Clients erschien der Server mit genau `ct_whoami` und antwortete mit dem Konto und seinen Rechten. Mit einem Dienstkonto, das nur das Wiki sehen darf, ist das in Claude Code geprüft. Windows deckt diese Seite nicht ab: Dort kann Ecclium die Token-Datei nicht sicher lesen und lehnt sie ab ([ADR 0055](../adr/0055-konfiguration-identitaet.md)).

## Voraussetzungen

- macOS auf Apple Silicon (arm64) oder Linux auf x64, eine Shell wie zsh oder bash und Git. Für andere Plattformen siehe «Einrichtung» in [CONTRIBUTING.md](../../CONTRIBUTING.md).
- mise, der Versionsmanager, über den das Projekt Node.js und pnpm in festen Versionen bezieht. Wie Sie mise einrichten, steht in [CONTRIBUTING.md](../../CONTRIBUTING.md) unter «Einrichtung».
- Claude Desktop oder Claude Code.
- Ein eigenes Dienstkonto in ChurchTools mit einem Login-Token, nicht Ihr persönliches Konto. In ChurchTools kann auch ein Personenstatus Rechte vergeben, und Rechte aus Gruppen zeigt `ct_whoami` womöglich nicht. Geben Sie dem Dienstkonto deshalb einen eigenen Status ohne Berechtigungen, nehmen Sie es in keine Gruppe auf und vergeben Sie ihm direkt nur die Rechte, die seine Tools brauchen. `ct_whoami` verlangt kein Recht, die Rechte der Suchtools stehen unter «Suchtools».
- Eine sachliche Bezeichnung als Vor- und Nachname des Dienstkontos statt des Namens einer Person. Der KI-Assistent sieht beide unmaskiert.

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

Die Beispiele setzen nur die Adresse und die Token-Datei. Alle übrigen Einstellungen behalten ihre Voreinstellung: nur lesen, Maskierung `standard`, keine Suchtools, keine Audit-Datei, Stufe des Logs `info`. Alle Variablen stehen mit Erklärung in [.env.example](../../.env.example). Den Ordner für die Audit-Datei empfehlen wir zusätzlich, siehe «Audit-Datei».

## Claude Desktop

Claude Desktop liest seine Server aus der Datei `claude_desktop_config.json`, unter macOS im Ordner `~/Library/Application Support/Claude/`. Übernehmen Sie den Eintrag `ecclium` aus [beispiele/claude-desktop.json](beispiele/claude-desktop.json) unter `mcpServers`, neben allfällige andere Server, und ersetzen Sie die Platzhalter durch Ihre Adresse und Ihre absoluten Pfade. Ein Server mit freiem Netzzugriff gehört nicht in denselben Client, siehe «Grenzen». Beenden Sie danach Claude Desktop ganz und starten Sie es neu, damit es den Eintrag liest.

## Claude Code

In Claude Code tragen Sie den Server mit einem Befehl für Ihren Benutzer ein. Ersetzen Sie vorher die Platzhalter:

```sh
claude mcp add-json --scope user ecclium '{"type":"stdio","command":"/pfad/zu/node","args":["/pfad/zum/checkout/packages/cli/dist/bin.js","stdio"],"env":{"ECCLIUM_CHURCHTOOLS_URL":"https://example.church.tools","ECCLIUM_CHURCHTOOLS_TOKEN_FILE":"/pfad/zur/token-datei"}}'
```

Der Befehl übergibt den Eintrag als JSON in einfachen Anführungszeichen. Die kürzere Form `claude mcp add` mit `--env` nahm Claude Code 2.1.302 so nicht an: `--env` nahm dort alle folgenden Wörter bis `--`, auch den Namen des Servers. Mit `--scope user` gilt der Server in jedem Projekt Ihres Benutzers. Der Befehl steht danach in der History der Shell, er enthält aber nur den Pfad der Token-Datei, nicht das Token. Dieselben Angaben in der Form der Konfiguration von Claude Code stehen in [beispiele/claude-code.json](beispiele/claude-code.json). `claude mcp list` führt den Server danach auf, `claude mcp remove --scope user ecclium` trägt ihn wieder aus.

Im Checkout liegt absichtlich keine Datei `.mcp.json`. Claude Code böte den Server sonst jedem an, der Claude Code im Checkout startet, auch ohne Dienstkonto und Token-Datei.

## Was der KI-Assistent sieht

- Ohne Suchtools ein einziges Tool, `ct_whoami`, ohne Argumente und nur lesend. Seine Beschreibung ist englisch, wie alle Texte für das Modell. Was die Suchtools zeigen, steht unter «Suchtools».
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

Ecclium wartet nicht auf stderr. Liest der Client stderr nicht oder zu langsam, gehen Zeilen verloren, auch Zeilen des Audits. Ecclium zählt sie und nennt die Zahl beim Ende, doch auch diese letzte Zeile kann verloren gehen. Die Antworten auf stdout erreichen den Client trotzdem. Mit der Audit-Datei sind die Zeilen des Audits auf stderr nur Kopien. Jede Zeile geht zuerst in die Datei, und was sie dort nicht aufnimmt, zählt `audit_file_closed`.

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

Mit `ECCLIUM_STATE_DIR` schreibt Ecclium jede Zeile des Audits zuerst in eine eigene Datei und erst danach als Kopie nach stderr. Das Audit liegt dann bei Ihnen, gleich was der Client mit stderr macht. Ohne die Variable gibt es keine Audit-Datei, und das Audit geht nur nach stderr. Mit den Suchtools für Personen und Gruppen wird der Ordner nötig: Deren Ergebnis gibt Ecclium nur heraus, wenn seine Zeile ganz in der Audit-Datei steht.

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
- Dieselben Zeilen wie auf stderr: Zeit, Mandant, Subjekt, Modus, Tool, Ausgang, bei einem Fehler sein Code, die Dauer und die ID des Ereignisses. Keine Inhalte aus ChurchTools, keine IDs von Personen oder Gruppen und kein Token.
- Eine Zeile zählt nur, wenn sie mit einem Zeilenumbruch endet. Eine Zeile, die mit `~` endet, und ein letztes Stück ohne Zeilenumbruch sind Reste einer Zeile, die nicht ganz in die Datei kam. Überspringen Sie solche Zeilen wie Zeilen, die kein JSON sind.

Löscht jemand die Datei, während der Server läuft, legt Ecclium eine neue an, mit höchstens 64 Versuchen je Start. Danach laufen Tools mit Personendaten der besonderen Kategorie erst nach einem Neustart wieder. Lässt sich die Datei nicht beschreiben, etwa weil die Platte voll ist, geht die Zeile verloren, und der Server zählt sie. Das Ergebnis eines Tools mit Personendaten der besonderen Kategorie, etwa der Suchtools, hält er dann zurück.

Grenzen der Audit-Datei:

- Ecclium löscht die Dateien in dieser Version nicht, sie wachsen, eine je Start und Tag. Wie lange Sie sie aufbewahren, entscheiden Sie.
- Eine geschriebene Zeile übersteht einen Absturz des Servers oder des Clients, aber keinen Stromausfall und keinen Absturz des Betriebssystems.
- Die Datei schützt nicht gegen Ihren eigenen Benutzer: Wer unter ihm Programme ausführt, kann sie lesen, ändern oder löschen. Ecclium erkennt nur, dass sie gelöscht wurde.
- Unter Windows lassen sich Eigentümer und Rechte des Ordners nicht prüfen. Dort gibt es keine Audit-Datei, und ein gesetztes `ECCLIUM_STATE_DIR` bricht den Start ab.
- Ob das Datenschutzrecht Ihrer Gemeinde ein Protokoll der Lesezugriffe verlangt, etwa mindestens ein Jahr lang und getrennt vom System, ist nicht geklärt. Die Audit-Datei liegt auf demselben Rechner wie der Server und damit vermutlich nicht getrennt vom System. Ecclium verspricht keine Konformität mit einem Datenschutzrecht. Was Ecclium sonst ablegt, steht unter [Datenschutz](../privacy.md).
- Ob ChurchTools die Lesezugriffe über die API selbst je Konto protokolliert, ist nicht geprüft.

## Suchtools

`ct_persons_search` sucht Personen, `ct_groups_search` Gruppen nach ihrem Namen. Beide lesen nur und geben je Treffer nur die Kennung und den Namen weiter, höchstens 50 Treffer je Aufruf, ohne weitere Seiten. Gibt es mehr, sagt das Ergebnis es. Personen und Gruppen einer Gemeinde lassen auf die Religionszugehörigkeit schliessen. Deshalb bietet Ecclium die beiden Tools nur an, wenn Sie es ausdrücklich einstellen, und gibt ein Ergebnis nur heraus, wenn seine Zeile in der Audit-Datei steht ([ADR 0060](../adr/0060-leserechte-und-felder-der-suchtools.md)).

So schalten Sie sie ein: Setzen Sie im Abschnitt `env` des Eintrags `ecclium` neben der Adresse und der Token-Datei `ECCLIUM_SEARCH_TOOLS` auf `true` und `ECCLIUM_STATE_DIR` auf einen Ordner nach «Audit-Datei»:

```json
"ECCLIUM_SEARCH_TOOLS": "true",
"ECCLIUM_STATE_DIR": "/pfad/zum/zustandsordner"
```

Ohne den Ordner meldet `config check` ein Problem, und der Start bricht mit 78 ab. Unter Windows gibt es über stdio keine Audit-Datei und damit keine Suchtools. Bei jedem Start meldet Ecclium auf stderr, dass die Suchtools freigegeben sind.

Geben Sie dem Dienstkonto dafür direkt diese Rechte, neben den übrigen:

- «Personen eines Bereiches sehen» (`churchdb: view alldata`) nur für die Bereiche, in denen gesucht werden soll, «Alle» nur, wenn die ganze Instanz durchsuchbar sein soll.
- «Gruppen eines Gruppentyps sehen - ausser versteckte» (`churchgroup: view groups of grouptype`) nur für die Gruppentypen, in denen gesucht werden soll.

Geben Sie ihm keine Sicherheitsstufe, weder «Personendaten sehen - bis zum gewählten Sicherheitslevel» noch «Gruppeninfos sehen - bis zum gewählten Sicherheitslevel». Kennung und Name kommen ohne sie, und schon die niedrigste Stufe schickt E-Mail-Adresse, Telefon, Geburtstag, Postleitzahl und Ort jeder gefundenen Person an Ecclium. Ecclium gäbe sie nicht weiter, aber sie lägen im Arbeitsspeicher des Servers. Auch «"Personen" sehen», «"Gruppen" sehen» und «Mitgliederliste sehen» brauchen die Suchtools nicht. Hat das Konto mehr Rechte, weist Ecclium es nicht ab. Welche es hat, zeigt `ct_whoami`.

Was die Suchtools tun und was nicht:

- `ct_persons_search` sendet `GET /api/persons`, `ct_groups_search` `GET /api/groups`, je mit genau dem Suchbegriff, der ersten Seite und 51 Einträgen. Kommt ein 51. Eintrag, sagt das Ergebnis, dass es mehr Treffer gibt. Zahlen wie die Gesamtzahl der Treffer gibt Ecclium nicht weiter, weil offen ist, ob ChurchTools darin Einträge mitzählt, die das Konto nicht sehen darf.
- Ein Begriff trifft einen Namen ganz, am Anfang oder in der Mitte, auch kleingeschrieben, bei Personen auch Vor- und Nachname in dieser Reihenfolge, aber nicht in der umgekehrten und nie die E-Mail-Adresse. Er hat 1 bis 100 Zeichen ohne Leerzeichen am Rand und ohne Steuerzeichen. Eine Suche ohne Begriff, die alle Personen zeigte, lehnt Ecclium ab.
- Namen von Personen gibt diese Version unmaskiert und ohne Datenumschlag weiter, wie bei `ct_whoami`. Namen von Gruppen stehen im Datenumschlag, weil Personen der Gemeinde sie frei wählen.
- Ein leeres Ergebnis kann auch heissen, dass dem Konto das Recht fehlt: ChurchTools antwortet dann mit einer leeren Liste, nicht mit einem Fehler. Das Ergebnis sagt das und nennt das Recht.
- Personen ausserhalb der Bereiche des Kontos und Gruppen ausserhalb seiner Gruppentypen findet die Suche nicht, ohne Fehler. Gruppen mit der Sichtbarkeit «intern» findet sie dagegen auch ohne Recht auf Gruppen. Ob versteckte Gruppen ausgelassen werden, ist nicht geprüft.
- Passt der Name des Dienstkontos zum Begriff, kann sein eigener Datensatz unter den Treffern sein.
- Die Zeile des Audits nennt das Tool und den Ausgang, nie den Suchbegriff, einen Namen oder eine Kennung.

## Grenzen

- Nur `ct_whoami` und mit Freigabe die beiden Suchtools. Weitere Tools für Personen, Gruppen und das Wiki und Tools, die schreiben, kommen mit späteren Versionen.
- Der Start fragt ChurchTools nicht an. Ein ungültiges oder entzogenes Token zeigt sich erst beim ersten Aufruf von `ct_whoami`.
- `ct_whoami` verlangt kein Recht in ChurchTools. Geprüft ist das bisher nur mit einem Konto, das zwei Rechte im Wiki hatte, nicht mit einem Konto ganz ohne Rechte.
- Rechte, die das Konto über eine Gruppe erhält, können fehlen. Ein entzogenes Recht kann noch eine Weile erscheinen, auf einer Testinstanz mit ChurchTools 3.137 einmal mindestens etwa zwanzig Minuten lang (siehe [Befunde zur API von ChurchTools](../research/churchtools-api.md)).
- Ein Client, der stderr nicht liest, verliert Zeilen des Logs und, ohne Audit-Datei, des Audits, wie oben beschrieben.
- Der KI-Assistent kann, was er über Ecclium liest, über ein anderes Tool desselben Clients weitergeben, etwa nach einer Injection, auch über ein eingebautes Tool des Clients mit Netzzugriff. Betreiben Sie Ecclium nicht im selben Client wie Server mit freiem Netzzugriff, und prüfen Sie, welche eingebauten Tools mit Netzzugriff Ihr Client anbietet.
