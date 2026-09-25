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
- Pull Requests werden per Squash gemergt. Der Titel des Pull Requests wird zum Titel des Commits auf `main` und folgt deshalb ebenfalls Conventional Commits. Die Nachrichten der zusammengefassten Commits samt Sign-off stehen darunter.
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

Ein Git-Hook aus der Einrichtung unten prüft jeden Commit und jede Commit-Message mit gitleaks. Er sucht nach Zugangsdaten, Hosts unter `church.tools`, internen Hostnamen, IPv4- und IPv6-Adressen, E-Mail-Adressen, Telefonnummern aus der Schweiz, Liechtenstein, Deutschland und Österreich, AHV-Nummern, IBAN und Home-Pfaden. Dazu kommen Dateien, die nie ins Repository gehören, etwa `.env`, Schlüssel oder Datenexporte. Welche Platzhalter die Prüfung durchlässt, steht am Anfang von `.gitleaks.toml`. Namen, IDs und ChurchTools-Instanzen auf einer eigenen Domain erkennt der Hook nicht, und ein Kommentar `gitleaks:allow` schaltet einen Fund nicht ab. Er fängt Versehen ab, Ihre eigene Durchsicht ersetzt er nicht.

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

2. Richten Sie die Git-Hooks ein:

   ```sh
   mise exec -- lefthook install
   ```

3. Prüfen Sie, ob der Hook läuft: Beim nächsten Commit erscheint die Ausgabe von lefthook mit dem Schritt `secrets`, und gitleaks meldet «no leaks found». Fehlt die Ausgabe, ist der Hook nicht aktiv. Meldet der Schritt «command not found», fehlt mise im Pfad.

Weitere Prüfungen für Formatierung, Typen und Tests kommen dazu, sobald es Code gibt.
