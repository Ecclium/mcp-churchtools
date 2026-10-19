# Betrieb über stdio

**In Entwicklung.** Es gibt noch keine veröffentlichte Version. Diese Seite beschreibt, wie Sie Ecclium aus dem Quellcode bauen und als lokalen Server über stdio in Claude Desktop oder Claude Code einbinden. Über stdio startet der Client den Server als eigenen Prozess auf Ihrem Rechner und spricht mit ihm über stdin und stdout.

In dieser Version bietet der Server nur das Tool `ct_whoami` an. Es zeigt, mit welchem Konto Ecclium ChurchTools liest und welche Rechte ChurchTools diesem Konto gibt. Es liest nur und ändert in ChurchTools nichts.

Ecclium ist ein unabhängiges Projekt und steht in keiner Verbindung zum Hersteller von ChurchTools.

Geprüft am 19.10.2026 unter macOS 27.0 mit Claude Code 2.1.302 und Claude Desktop 2.31226.1: In beiden Clients erschien der Server mit genau `ct_whoami` und antwortete mit dem Konto und seinen Rechten. Mit einem Dienstkonto, das nur das Wiki sehen darf, ist das in Claude Code geprüft. Windows deckt diese Seite nicht ab: Dort kann Ecclium die Token-Datei nicht sicher lesen und lehnt sie ab ([ADR 0055](../adr/0055-konfiguration-identitaet.md)).

## Voraussetzungen

- macOS auf Apple Silicon (arm64) oder Linux auf x64, eine Shell wie zsh oder bash und Git. Für andere Plattformen siehe «Einrichtung» in [CONTRIBUTING.md](../../CONTRIBUTING.md).
- mise, der Versionsmanager, über den das Projekt Node.js und pnpm in festen Versionen bezieht. Wie Sie mise einrichten, steht in [CONTRIBUTING.md](../../CONTRIBUTING.md) unter «Einrichtung».
- Claude Desktop oder Claude Code.
- Ein eigenes Dienstkonto in ChurchTools mit einem Login-Token, nicht Ihr persönliches Konto. In ChurchTools kann auch ein Personenstatus Rechte vergeben, und Rechte aus Gruppen zeigt `ct_whoami` womöglich nicht. Geben Sie dem Dienstkonto deshalb einen eigenen Status ohne Berechtigungen, nehmen Sie es in keine Gruppe auf und vergeben Sie ihm direkt nur die Rechte, die seine Tools brauchen. `ct_whoami` verlangt kein Recht.
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

Die Beispiele setzen nur die Adresse und die Token-Datei. Alle übrigen Einstellungen behalten ihre Voreinstellung: nur lesen, Maskierung `standard`, keine Suchtools, Stufe des Logs `info`. Alle Variablen stehen mit Erklärung in [.env.example](../../.env.example).

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

- Ein einziges Tool, `ct_whoami`, ohne Argumente und nur lesend. Seine Beschreibung ist englisch, wie alle Texte für das Modell.
- Ein Aufruf sendet nacheinander zwei Anfragen an ChurchTools: `GET /api/whoami` für das Konto und `GET /api/permissions/global` für seine Rechte. Andere Adressen als die aus `ECCLIUM_CHURCHTOOLS_URL` fragt der Server nicht an.
- Das Ergebnis nennt die Personen-ID, Vor- und Nachname und die E-Mail-Adresse des Dienstkontos. Die E-Mail-Adresse ist maskiert: das erste Zeichen, drei Sterne und die Domain, etwa `m***@example.org`. Vor- und Nachname maskiert diese Version nicht. Darf das Dienstkonto keine Personen sehen, liefert ChurchTools seine E-Mail-Adresse nicht mit, und dort steht `null`.
- Dazu kommen die gesetzten Rechte je Modul, nach Namen sortiert. Rechte, die das Konto nicht hat, fehlen. Ein Recht mit einer Liste von IDs, etwa für einzelne Wiki-Kategorien, zeigt die 10 kleinsten IDs und ihre Gesamtzahl. Hat das Konto mehr als 150 gesetzte Rechte, gibt das Tool statt der Liste einen Fehler mit dem Rat, dem Dienstkonto nur die Rechte seiner Tools zu geben. Kennt Ecclium die Form der Antwort zu den Rechten nicht, stehen sie als unbekannt da.
- Lehnt ChurchTools das Token ab oder ist ChurchTools nicht erreichbar, erhält der KI-Assistent nur einen festen englischen Satz. Den Code, `auth` oder `network`, nennt die Zeile des Audits auf stderr. Keine Fehlermeldung nennt einen Wert aus der Konfiguration oder aus ChurchTools.

## Log und Audit auf stderr

stdout gehört dem Protokoll MCP. Alles andere schreibt Ecclium nach stderr, in dieser Reihenfolge:

1. Beim Start Hinweise als deutscher Text, je Hinweis eine Zeile, etwa die Warnung, wenn das Token in der Variable steht. Ist die Konfiguration ungültig, endet der Server nach den Hinweisen mit 78.
2. Danach schreibt Ecclium nur noch Zeilen in JSON, je Zeile ein Ereignis. Logzeilen tragen das Feld `event`, etwa `http_response` für jede Anfrage an ChurchTools, ab der Stufe aus `ECCLIUM_LOG_LEVEL`. Jeder Aufruf eines Tools ergibt eine Zeile des Audits mit `type` gleich `tool_call`, dem Mandanten `default`, dem Subjekt `stdio:local-stdio` aus `ECCLIUM_STDIO_SUBJECT`, dem Modus `interactive`, dem Namen des Tools, dem Ausgang und bei einem Fehler dessen Code. Die Logzeilen eines Aufrufs, darunter `tool_call`, tragen die `eventId` seiner Zeile im Audit, die Zeilen `http_response` tragen keine.
3. Beim Ende die Zeile `stdio_closed`, die im Feld `count` nennt, wie viele Zeilen verloren gingen. Kam vor dem Ende ein Signal, steht davor `process_sigterm` oder `process_sigint`. Kommt es erst danach, folgt seine Zeile. Diese Zeilen schreibt Ecclium bei jeder Stufe aus `ECCLIUM_LOG_LEVEL`.

Node.js selbst kann weitere Zeilen schreiben, etwa eine Warnung, wenn es die Datei aus `NODE_EXTRA_CA_CERTS` nicht laden kann. Überspringen Sie Zeilen, die kein JSON sind.

Weder das Token noch Namen, E-Mail-Adressen oder andere Werte aus den Antworten von ChurchTools stehen in diesen Zeilen. Tests mit erfundenen Werten prüfen das. Wohin die Zeilen gehen, bestimmt der Client. Ecclium schreibt keine eigene Datei.

Ecclium wartet nicht auf stderr. Liest der Client stderr nicht oder zu langsam, gehen Zeilen verloren, auch Zeilen des Audits. Ecclium zählt sie und nennt die Zahl beim Ende, doch auch diese letzte Zeile kann verloren gehen. Die Antworten auf stdout erreichen den Client trotzdem.

Der Server endet mit einem dieser Codes:

| Code | Bedeutung                                                                                                                         |
| ---- | --------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Die Verbindung hat geendet: Der Client hat stdin geschlossen, stdout ist abgebrochen, oder die ungelesene Eingabe lag über 1 MiB. |
| 64   | Nach `stdio` stand ein weiteres Argument.                                                                                         |
| 70   | Ein interner Fehler, gemeldet mit einer festen Meldung ohne Einzelheiten.                                                         |
| 78   | Die Konfiguration ist ungültig.                                                                                                   |
| 130  | Der Server hat sich nach dem Signal `SIGINT` beendet, das vor dem Ende der Verbindung kam.                                        |
| 143  | Der Server hat sich nach dem Signal `SIGTERM` beendet, das vor dem Ende der Verbindung kam.                                       |

Kommt das erste Signal erst nach dem Ende der Verbindung, steht es im Log, und der Code bleibt 0. Ein zweites Signal beendet den Server sofort, mit dem Code dieses zweiten Signals.

## Grenzen

- Nur `ct_whoami`. Tools für Personen, Gruppen und das Wiki und Tools, die schreiben, kommen mit späteren Versionen. `ECCLIUM_SEARCH_TOOLS=true` nimmt diese Version an, bietet aber noch keine Suchtools an. Der Start meldet das.
- Der Start fragt ChurchTools nicht an. Ein ungültiges oder entzogenes Token zeigt sich erst beim ersten Aufruf von `ct_whoami`.
- `ct_whoami` verlangt kein Recht in ChurchTools. Geprüft ist das bisher nur mit einem Konto, das zwei Rechte im Wiki hatte, nicht mit einem Konto ganz ohne Rechte.
- Rechte, die das Konto über eine Gruppe erhält, können fehlen. Ein entzogenes Recht kann noch eine Weile erscheinen, auf einer Testinstanz mit ChurchTools 3.137 einmal mindestens etwa zwanzig Minuten lang (siehe [Befunde zur API von ChurchTools](../research/churchtools-api.md)).
- Ein Client, der stderr nicht liest, verliert Zeilen des Logs und des Audits, wie oben beschrieben.
- Der KI-Assistent kann, was er über Ecclium liest, über ein anderes Tool desselben Clients weitergeben, etwa nach einer Injection, auch über ein eingebautes Tool des Clients mit Netzzugriff. Betreiben Sie Ecclium nicht im selben Client wie Server mit freiem Netzzugriff, und prüfen Sie, welche eingebauten Tools mit Netzzugriff Ihr Client anbietet.
