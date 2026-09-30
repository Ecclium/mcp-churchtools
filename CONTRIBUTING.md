# Mitwirken

Danke, dass Sie zu Ecclium beitragen möchten. Diese Seite beschreibt, wie ein Beitrag aussieht, den das Projekt übernehmen kann.

Ecclium steht am Anfang. Den aktuellen Stand finden Sie in [docs/STATUS.md](docs/STATUS.md). Bevor Sie eine grössere Änderung beginnen, eröffnen Sie bitte ein Issue, damit der Zuschnitt vorher geklärt ist. Sicherheitslücken melden Sie nicht in einem Issue, sondern wie in [SECURITY.md](SECURITY.md) beschrieben.

## Developer Certificate of Origin

Ecclium verlangt kein Contributor License Agreement (CLA), mit dem Sie dem Projekt weitergehende Rechte einräumen. Stattdessen bestätigen Sie mit jedem Commit das Developer Certificate of Origin 1.1 (DCO) der Linux Foundation: Sie dürfen den Beitrag unter der Lizenz des Projekts einreichen. Verbindlich ist der englische Wortlaut:

```text
Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

Sinngemäss auf Deutsch, ohne rechtliche Verbindlichkeit: Mit Ihrem Beitrag bestätigen Sie,

- (a) dass Sie ihn ganz oder teilweise selbst erstellt haben und ihn unter der Open-Source-Lizenz einreichen dürfen, die in der Datei genannt ist, oder
- (b) dass er auf früherer Arbeit beruht, die nach Ihrem besten Wissen unter einer passenden Open-Source-Lizenz steht, und dass Sie nach dieser Lizenz berechtigt sind, diese Arbeit mit Änderungen, die ganz oder teilweise von Ihnen stammen, unter derselben Open-Source-Lizenz einzureichen (es sei denn, Sie dürfen sie unter einer anderen Lizenz einreichen), wie in der Datei angegeben, oder
- (c) dass Sie ihn unverändert und direkt von einer Person erhalten haben, die (a), (b) oder (c) bestätigt hat,
- (d) und dass Sie verstehen und damit einverstanden sind: Projekt und Beitrag sind öffentlich, und ein Nachweis des Beitrags samt den Personendaten, die Sie mitschicken, auch Ihrem Sign-off, wird dauerhaft aufbewahrt und darf im Einklang mit dem Projekt oder den beteiligten Open-Source-Lizenzen weitergegeben werden.

Das Sign-off ist eine Zeile am Ende der Commit-Message. Git setzt sie mit `git commit -s`:

```text
Signed-off-by: Max Mustermann <max.mustermann@example.org>
```

Name und E-Mail-Adresse im Sign-off müssen zum Autor oder zur Autorin des Commits passen. Ein Pseudonym ist in Ordnung, wenn es dauerhaft zu Ihnen gehört, etwa Ihr GitHub-Konto mit der dazugehörigen noreply-Adresse. Anonyme Beiträge nimmt das Projekt nicht an. Die Adresse im Sign-off wird öffentlich. Wenn Sie Ihre private Adresse nicht zeigen möchten, verwenden Sie die noreply-Adresse von GitHub.

## Commits und Pull Requests

- Commit-Messages auf Englisch nach Conventional Commits 1.0.0, etwa `fix: reject tokens without prefix` oder `docs(adr): record the node line`.
- Kleine Commits, die je eine Sache ändern.
- Pull Requests werden per Squash gemergt. Der Titel des Pull Requests wird zum Titel des Commits auf `main` und folgt deshalb ebenfalls Conventional Commits, mit einem der Typen `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style` oder `test`. Die Nachrichten der zusammengefassten Commits samt Sign-off stehen darunter.
- Jeder Commit trägt das Sign-off seiner Autorin oder seines Autors. Der Git-Hook aus der Einrichtung weist einen Commit ohne Sign-off ab, in CI prüft der Job `dco` jeden Commit des Pull Requests. Ausgenommen ist nur ein Merge-Commit mit genau zwei Eltern, der nichts ausser dem Zusammenführen enthält, wie ihn «Update branch» auf GitHub erzeugt. Während eines Merges prüft der Hook das Sign-off nicht, das übernimmt der Job `dco`. Ein fehlendes Sign-off setzen Sie nachträglich mit `git rebase --signoff origin/main`, in einem Fork mit dem Remote des Projekts, etwa `upstream/main`, und übertragen den Branch danach mit `git push --force-with-lease`.
- Jede neue Abhängigkeit wird im Commit begründet: Zweck, Lizenz, erwogene Alternativen. Eine kleine Zahl von Abhängigkeiten ist ein Qualitätsmerkmal.

## Sprache

- Code, Bezeichner, Kommentare, Commit-Messages, Issues und Pull Requests auf Englisch.
- Texte für Menschen, also README, Dokumentation und Meldungen der Kommandozeile, auf Deutsch zuerst, nach Kapitel 9 der [Markenrichtlinie](brand/README.md): Anrede «Sie», Schweizer Schreibweise mit `ss`, Anführungszeichen «so», keine Geviertstriche, keine Ausrufezeichen.
- Kommentare erklären das Warum. Wo ein Architekturentscheid die Begründung trägt, nennen sie seine Nummer, etwa «ADR 0002». Die Entscheide stehen in [docs/adr/](docs/adr/README.md).

## Keine echten Daten

Dieses Repository ist öffentlich, und jeder Commit bleibt sichtbar. Deshalb gehören in Code, Tests, Beispiele, Protokollauszüge, Screenshots, Commit-Messages, Issues und Pull Requests:

- keine echten Hostnamen, Tenant-Namen, Subdomains, IP-Adressen, lokalen Pfade oder Benutzernamen,
- keine Namen, E-Mail-Adressen, Telefonnummern, Gruppen- oder Personen-IDs aus einer echten ChurchTools-Instanz,
- keine Tokens oder andere Zugangsdaten.

Verwenden Sie Platzhalter: `https://example.church.tools`, `demo-tenant`, `person-id-1`, `max.mustermann@example.org`, `10.0.0.0/8`. Testdaten sind vollständig erfunden.

Zitieren Sie Quellen ohne Host: mit Titel, Version und Abschnitt, bei der ChurchTools-API mit Version und `operationId`.

Ein Git-Hook aus der Einrichtung unten prüft jeden Commit und jede Commit-Message mit gitleaks. Er sucht nach Zugangsdaten, Hosts unter `church.tools`, internen Hostnamen, IPv4- und IPv6-Adressen, E-Mail-Adressen, Telefonnummern aus der Schweiz, Liechtenstein, Deutschland und Österreich, AHV-Nummern, IBAN und Home-Pfaden. Dazu kommen Dateien, die nie ins Repository gehören, etwa `.env`, Schlüssel oder Datenexporte. Welche Platzhalter die Prüfung durchlässt, steht am Anfang von `.gitleaks.toml`. Er prüft auch die Namen der Dateien. Namen, IDs und ChurchTools-Instanzen auf einer eigenen Domain erkennt er nicht. Ein Kommentar `gitleaks:allow` schaltet einen Fund nicht ab, und eine Datei `.gitleaksignore` weisen Hook und CI zurück. Er fängt Versehen ab, Ihre eigene Durchsicht ersetzt er nicht.

## Fremder Quelltext und Clean Room

Fremder Quelltext wird nicht in den Kern kopiert, auch nicht unter einer freien Lizenz. Ist eine Ausnahme nötig, wird sie vorher entschieden, im Code markiert und in `NOTICE` mit Quelle und Lizenz vermerkt ([ADR 0002](docs/adr/0002-apache-2-0-und-dco.md)).

Das gilt besonders für andere quelloffene MCP-Server für ChurchTools. Ecclium übernimmt aus ihnen keinen Quelltext, auch keine einzelnen Funktionen oder Tests, auch nicht unter einer freien Lizenz wie MIT. Ideen, der Zuschnitt von Tools und Namensschemata dürfen einfliessen, Code nicht. So bleibt die Herkunft jeder Zeile im Kern klar. Ecclium ist ein unabhängiges Projekt und steht in keiner Verbindung zum Hersteller von ChurchTools.

Beobachtungen an der ChurchTools-API selbst sind willkommen. Beschreiben Sie dann das Verhalten der API, nicht fremden Code.

## Zusage für den freien Kern

Was einmal im freien Kern war, bleibt dort. Die Zusage und was sie absichert, stehen in [PROMISE.md](PROMISE.md).

## Einrichtung

Node.js und alle Werkzeuge sind in `mise.toml` gepinnt, ihre Prüfsummen stehen in `mise.lock`. Sie brauchen dafür nur mise, den Versionsmanager, über den das Projekt alle Werkzeuge bezieht.

1. Installieren Sie die Werkzeuge im Locked-Modus. mise verlangt dann für jedes Werkzeug einen Eintrag mit Download-Adresse für Ihre Plattform in `mise.lock` und prüft beim Herunterladen die Prüfsumme, die dort steht:

   ```sh
   MISE_LOCKED=1 mise install
   ```

   `mise.lock` enthält Einträge für Linux auf x64 und macOS auf arm64. Auf anderen Plattformen bricht die Installation im Locked-Modus ab. Eröffnen Sie dann bitte ein Issue, damit die Plattform geprüft in `mise.lock` aufgenommen wird.

2. Installieren Sie die Abhängigkeiten mit dem gepinnten pnpm:

   ```sh
   mise exec -- pnpm install
   ```

   pnpm installiert nur Versionen, die seit mindestens drei Tagen veröffentlicht sind, und führt keine Install-Skripte aus. Die übrigen Schutzeinstellungen stehen mit Begründung in `pnpm-workspace.yaml`.

3. Richten Sie die Git-Hooks ein:

   ```sh
   mise exec -- lefthook install
   ```

4. Prüfen Sie, ob die Hooks laufen: Beim nächsten Commit erscheint die Ausgabe von lefthook mit den Schritten `secrets`, `file-names`, `ignore-file` und `format`, danach für die Commit-Message `secrets` und `sign-off`, und gitleaks meldet «no leaks found». Fehlt die Ausgabe, sind die Hooks nicht aktiv. Meldet ein Schritt «command not found», fehlt mise im Pfad.

## Prüfungen

Vor einem Pull Request muss dieser Befehl ohne Fehler durchlaufen:

```sh
mise exec -- pnpm check
```

Er prüft nacheinander Formatierung, Typen, Lint und die Architekturregeln, danach drei Dinge, die über den Code hinausgehen: die Lizenzen aller Abhängigkeiten, die Schutzeinstellungen von pnpm und die relativen Links in der Dokumentation. Zuletzt laufen die Tests. Die einzelnen Schritte gibt es auch als eigene Befehle, etwa `pnpm lint`, `pnpm check:arch`, `pnpm test` oder `pnpm check:licenses`. `pnpm format` behebt die Formatierung.

Dabei gilt:

- Jede exportierte Funktion und jeder exportierte Typ braucht einen Dokumentationskommentar (JSDoc) mit Zweck, Parametern, Ergebnis und Fehlerfällen. Exportierte Funktionen und Klassen der Pakete brauchen zusätzlich ein Beispiel. ESLint prüft das.
- Im Code der Pakete ist `console` verboten. Im Betrieb über stdio gehört stdout dem MCP-Protokoll: Auf stdout und stderr schreiben nur die Orte, die `tests/architecture/boundaries.json` nennt, also der Logger und die Meldungen der Kommandozeile (ADR 0018). Das MCP-SDK importieren nur der Mount in `packages/core/src/mcp/` und der Server (ADR 0024).
- Welches Paket welches importieren darf, steht ebenfalls in `tests/architecture/boundaries.json` (ADR 0022). `pnpm check:arch` prüft jeden Import mit dependency-cruiser, ESLint prüft Ausgaben, das Laden von Modulen und das SDK. Zu jeder Regel gibt es unter `tests/architecture/` einen Test mit einem Beispiel, das sie verletzt.
- Abhängigkeiten werden auf eine genaue Version gepinnt, nicht auf einen Bereich. Zur Laufzeit sind nur freizügige Lizenzen erlaubt, für Werkzeuge der Entwicklung einige mehr. Die Listen stehen in `scripts/check-licenses.mts`.
- Eine Ausnahme vom Mindestalter von drei Tagen gibt es nur für Sicherheitskorrekturen, als genaue Version in `pnpm-workspace.yaml` mit einem Kommentar direkt darüber, der mit dem Datum beginnt und den Grund nennt. `pnpm check` weist eine Ausnahme ohne diese Angaben ab.

### In CI

Für jeden Pull Request laufen die folgenden Prüfungen. Jede ist Pflicht für den Merge nach `main`:

| Prüfung         | Was sie prüft                                                                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflow-lint` | Die Workflows mit actionlint und shellcheck, dazu zizmor ab mittlerer Schwere. In CI prüft zizmor auch, ob jede gepinnte SHA zur Action und zur Version im Kommentar passt. |
| `secret-scan`   | Die Geschichte bis zum geprüften Commit, die Dateien, alle Dateinamen und die Nachrichten aller Commits bis dorthin mit gitleaks.                                           |
| `check`         | Build und `pnpm check` mit der Version von Node.js für die Entwicklung.                                                                                                     |
| `compat`        | Dasselbe mit der nächsten Linie von Node.js.                                                                                                                                |
| `minimum`       | Dasselbe mit der ältesten unterstützten Version von Node.js.                                                                                                                |
| `deps-review`   | Neue oder geänderte Abhängigkeiten auf bekannte Schwachstellen.                                                                                                             |
| `pr-title`      | Den Titel nach Conventional Commits und mit gitleaks.                                                                                                                       |
| `dco`           | Das Sign-off jedes Commits und die Commit-Messages mit gitleaks.                                                                                                            |

`secret-scan`, `pr-title` und `dco` scheitern ausserdem, solange irgendwo eine Datei `.gitleaksignore` liegt, weil gitleaks sie von sich aus liest und eine Zeile darin jeden Fund abschaltet.

Nach dem Merge laufen die Jobs aus `ci.yml` ausser `deps-review` noch einmal auf `main`. `secret-scan` prüft dann auch die Nachricht des Squash-Commits, die sich im Dialog des Merge ändern lässt. Ein Fund dort steht schon auf `main` und wird nach ADR 0014 als Vorfall behandelt.

Dieser Befehl führt lokal aus: die Prüfung der Workflows, zizmor dabei ohne Netz, den Scan der Geschichte, der Dateinamen und der Commit-Messages mit gitleaks sowie Build und `pnpm check` auf allen drei Versionen von Node.js. Den Scan der Dateien, die Prüfung der Abhängigkeiten, Titel und Sign-off prüft nur CI.

```sh
mise exec -- pnpm ci:local
```

Er braucht die Versionen von Node.js für `compat` und `minimum`. Installieren Sie sie einmal mit `MISE_ENV=compat MISE_LOCKED=1 mise install` und `MISE_ENV=minimum MISE_LOCKED=1 mise install`.

## Für Maintainer: Pull Requests aus Forks

Workflows aus einem Fork laufen erst, wenn eine Maintainerin oder ein Maintainer sie mit «Approve and run» freigibt. Die Prüfungen laufen dann mit dem Code aus dem Pull Request: Wer ein Prüfskript, einen Workflow oder eine Konfiguration ändert, kann damit die eigene Prüfung grün machen. Die Prüfungen schützen vor Versehen, gegen Absicht schützen nur die Freigabe und die Durchsicht ([ADR 0021](docs/adr/0021-supply-chain-baseline.md)).

Sehen Sie sich vor der Freigabe diese Teile des Diffs an. Jede Änderung dort verlangt, dass Sie sie verstanden haben, bevor der Lauf startet:

- `.github/**`. Eine neue Workflow-Datei ist ein Stoppsignal.
- `scripts/**`, besonders `scripts/ci/**`.
- `.gitleaks.toml` und `lefthook.yml`.
- `.gitleaksignore` an jedem Ort, auch wenn die Prüfungen sie abweisen.
- Alles, was mise liest: `mise*.toml`, `mise*.lock`, `.mise*.toml`, `mise/`, `.mise/`, `.config/` und `.tool-versions`. mise übernimmt aus diesen Dateien auch Umgebungsvariablen und Pfade für alle folgenden Schritte eines Jobs.
- `package.json` samt `scripts`, `packages/*/package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.npmrc` und `.pnpmfile.*`. pnpm lädt keine Datei `.pnpmfile.*`, solange `pnpm-workspace.yaml` `ignorePnpmfile: true` enthält. Entfernt ein Pull Request diese Einstellung, führt pnpm eine solche Datei bei jedem Befehl aus, auch bei der Installation in CI und wenn Install-Skripte gesperrt sind.
- Einstellungen für Editoren in `.vscode/`.
- Konfigurationen der Prüfungen: `eslint.config.mjs`, `.dependency-cruiser.mjs`, `vitest.config.mts`, `tsconfig*.json`, `.prettierrc.json` und `.prettierignore`, dazu jede Konfiguration von ESLint oder Prettier in einem Unterordner.
- Tests der Regeln und Prüfungen: `tests/architecture/**`, `tests/hooks/**`, `tests/scripts/**`, `tests/support/**`, `tests/workflows/**` und `tests/toolchain.test.mts`. Jede Testdatei, auch unter `packages/`, läuft in CI mit allem, was sie importiert, und kann die Prüfungen verfälschen.

Dieselbe Durchsicht gilt, bevor Sie den Branch eines Pull Requests lokal auschecken. Hooks, Skripte, Prettier aus `node_modules`, eine Datei `.pnpmfile.*`, wenn der Branch `ignorePnpmfile` entfernt, und die Konfiguration von mise laufen dann auf Ihrem Rechner, sobald Sie Git, mise oder pnpm aufrufen. `pnpm run` installiert vorher, wenn `node_modules` nicht zum Lockfile passt.
