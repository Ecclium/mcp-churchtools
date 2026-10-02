# ADR 0012: GitHub als Code-Verwaltung, kein selbst betriebener Git-Dienst

- Status: Vorgeschlagen
- Datum: 02.10.2026
- Fällt vor: Phase 0

## Kontext

Ecclium braucht einen Ort für Code, Issues, Pull Requests, CI und die vertrauliche Meldung von Sicherheitslücken. Das Repository ist ab dem ersten Commit öffentlich (ADR 0014), und Ecclium hat eine Person als Maintainer. Der Ort muss Beitragende erreichen, die Regeln für `main` technisch durchsetzen und die Prüfungen der Lieferkette tragen (ADR 0021), ohne dass jemand dafür einen eigenen Dienst betreiben und absichern muss.

Daten von Gemeinden liegen dort nie. Das Repository enthält Code, Dokumentation und erfundene Testdaten.

## Optionen

1. **Selbst betriebener Git-Dienst:** volle Kontrolle über Daten und Einstellungen. Betrieb, Aktualisierungen, Sicherungen und Absicherung lägen bei einer Person, und wer den Dienst übernimmt, erreicht jede Installation. Beitragende bräuchten dort ein eigenes Konto.
2. **Ein anderer gehosteter Dienst:** kein eigener Betrieb. Die Werkbank müsste neu aufgebaut werden, denn CodeQL im Default Setup, OpenSSF Scorecard und die Renovate-App sind heute auf GitHub eingerichtet.
3. **GitHub:** Code, Issues, Pull Requests, CI, Rulesets und die Funktionen für Sicherheit aus einer Hand, ohne eigenen Betrieb. Dafür hängt Ecclium an Verfügbarkeit, Bedingungen und Plan eines Anbieters.

## Entscheid

Gewählt ist die dritte Option. Code, Issues, Pull Requests und CI von Ecclium liegen auf GitHub, in der Organisation `ecclium`. Es gibt keinen selbst betriebenen Git-Dienst und keinen Spiegel, der Beiträge annimmt.

GitHub trägt:

- **Beiträge:** Pull Requests, Issue-Formulare ohne leere Issues, CODEOWNERS mit dem Team der Maintainer.
- **Schutz von `main`:** ein Ruleset ohne Ausnahmen. Änderungen nur über Pull Requests mit grünen Pflichtprüfungen aus GitHub Actions, kein Force-Push, lineare Geschichte, nur Squash (ADR 0014).
- **CI:** GitHub Actions. Erlaubt sind nur Actions aus der Positivliste der Organisation, jede auf eine vollständige SHA gepinnt (ADR 0021).
- **Sicherheit:** Private Vulnerability Reporting als Meldeweg (`SECURITY.md`), Secret Scanning mit Push Protection, CodeQL im Default Setup, Warnungen von Dependabot ohne eigene Pull Requests, die Renovate-App nur für dieses Repository.

Container-Images unter `ghcr.io/ecclium/` (ADR 0004) und der Release-Pfad (ADR 0040) bauen auf GitHub auf. Ihre Einzelheiten entscheiden diese ADRs.

## Konsequenzen

- Ecclium hängt an Verfügbarkeit, Bedingungen und Plan von GitHub. Fällt GitHub aus, ruhen Pull Requests, CI und Meldungen. Code, Geschichte, ADRs und Dokumentation liegen in jedem Klon vollständig vor. Ein Umzug bliebe möglich, Issues, Einstellungen und Workflows müssten aber neu aufgebaut werden.
- Viele Schutzmassnahmen sind Einstellungen auf GitHub, keine Dateien im Repository. Das Repository kann sie nicht belegen. Sie gelten als belegt, sobald der Maintainer sie mit Datum in `docs/STATUS.md` bestätigt hat, und das Threat Model führt sie mit dem Stand «Einstellung».
- Die Konten der Maintainer auf GitHub sind schützenswert (Threat Model W8 und L15). Wer eines übernimmt, kann das Ruleset ändern und mergen.
- Beitragende brauchen ein Konto bei GitHub. Für das Sign-off genügt die noreply-Adresse von GitHub (ADR 0002).
- Issues und Pull Requests sind öffentlich. Daten von Gemeinden gehören auch dort nie hinein. Die Issue-Formulare weisen darauf hin, und Sicherheitslücken gehen über den vertraulichen Meldeweg.

## Umsetzung

- Beiträge: `.github/CODEOWNERS`, `.github/ISSUE_TEMPLATE/`, `.github/pull_request_template.md`.
- CI: `.github/workflows/`, Aktualisierungen: `.github/renovate.json5` (ADR 0021).
- Meldeweg für Sicherheitslücken: `SECURITY.md`.
- Ruleset, Positivliste der Actions und die Einstellungen für Sicherheit: in den Einstellungen von Repository und Organisation. Als belegt gilt jede, sobald der Maintainer sie mit Datum in `docs/STATUS.md` bestätigt hat.
