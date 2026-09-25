# ADR 0001: ADRs als Entscheidformat

- Status: Vorgeschlagen
- Datum: 25.09.2026
- Fällt vor: Phase 0

## Kontext

Ecclium wird öffentlich und in Schüben entwickelt. Zwischen zwei Arbeitsphasen können Wochen liegen. Wer den Code liest, dazu beiträgt oder Ecclium betreibt, muss nachvollziehen können, warum etwas so gebaut ist, gerade bei Entscheiden zu Sicherheit und Datenschutz. Begründungen, die nur in Commit-Messages, Issues oder im Gedächtnis stehen, gehen verloren oder sind schwer zu finden.

## Optionen

1. **Begründungen nur in Commit-Messages und Pull Requests:** kein Zusatzaufwand, aber verstreut und nach einem Squash-Merge schwer auffindbar.
2. **Ein Wiki oder eine andere Plattform ausserhalb des Repositorys:** nicht mit dem Code versioniert, nicht im Pull Request prüfbar, eine zweite Stelle für Beitragende.
3. **Architecture Decision Records (ADR) im Repository:** ein kurzes Dokument pro Entscheid, mit dem Code versioniert und im Pull Request prüfbar.

## Entscheid

Entscheide mit Tragweite für Architektur, Sicherheit, Datenschutz, Lizenz oder Betrieb stehen als ADR in `docs/adr/`.

- **Datei:** `NNNN-titel.md`, mit vierstelliger, fortlaufender Nummer und einem kurzen Titel in Kleinbuchstaben mit Bindestrichen, Umlaute als ae, oe, ue. Die Vorlage ist `0000-template.md`.
- **Aufbau:** Status, Datum und die Phase, vor der entschieden sein muss. Danach Kontext, Optionen, Entscheid, Konsequenzen und, sobald es etwas umzusetzen gibt, Umsetzung.
- **Status eines ADR:** Entwurf (begonnen, noch nicht zur Bestätigung bereit), Vorgeschlagen, Angenommen, Abgelöst durch ADR NNNN (ein neues ADR ersetzt den Entscheid), Verworfen.
- **Status im Index:** Der Index in `docs/adr/README.md` kennt zusätzlich «Geplant» für noch nicht geschriebene ADRs und «Betrieblich, nicht öffentlich» für Entscheide, die nur den gehosteten Betrieb betreffen und nicht in diesem Repository liegen. Ihre Nummern stehen im Index, damit die Zählung keine Lücken hat.
- **Änderungen:** Ein angenommener Entscheid ändert sich nur durch ein neues ADR, das ihn ablöst. Im abgelösten ADR ändert sich dann nur der Status zu «Abgelöst durch ADR NNNN». Sonst darf nur der Abschnitt «Umsetzung» nachgeführt werden.
- **Sprache:** Deutsch, nach Kapitel 9 der Markenrichtlinie in `brand/README.md`.
- **Quellen:** ohne Host zitiert, mit Titel, Version und Abschnitt, bei der ChurchTools-API mit Version und `operationId`.
- **Verweise:** Code, Kommentare, Architekturregeln und Prüfungen nennen das ADR, das ihre Begründung trägt, mit seiner Nummer, etwa «ADR 0002».

## Konsequenzen

- Jeder grössere Entscheid braucht ein kurzes Dokument, bevor die betroffene Arbeit beginnt. Das kostet Zeit und verhindert, dass Begründungen verloren gehen.
- Ein ADR enthält alles, was zum Verständnis des Entscheids nötig ist. Es setzt kein Wissen voraus, das nicht im Repository steht.
- Weil Regeln und Prüfungen auf ihr ADR verweisen, lässt sich zu jeder Regel die Begründung finden und bei einer Änderung prüfen, welche Regeln betroffen sind.

## Umsetzung

- Vorlage: `docs/adr/0000-template.md`.
- Index mit allen Nummern, Titeln, Status und Phasen: `docs/adr/README.md`.
