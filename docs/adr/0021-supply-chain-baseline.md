# ADR 0021: Supply-Chain-Baseline

- Status: Vorgeschlagen
- Datum: 26.09.2026
- Fällt vor: Phase 0

## Kontext

Ecclium wird Daten von Gemeinden verarbeiten, die Rückschlüsse auf die Religionszugehörigkeit von Personen erlauben. Wer eine Abhängigkeit, ein Werkzeug oder den Weg der Veröffentlichung übernimmt, erreicht diese Daten über jede Installation.

Angriffe auf die Lieferkette nutzen Wege, die bei einem kleinen Projekt offen stehen: eine übernommene Version eines npm-Pakets, ein Install-Skript, das beim Installieren nach Zugangsdaten sucht, eine kompromittierte GitHub Action oder ein Token zum Veröffentlichen auf einem Entwicklungsrechner. Sich selbst verbreitende npm-Würmer haben genau diese Wege mehrfach genutzt. Übernommene Versionen werden oft innerhalb weniger Tage entdeckt und zurückgezogen.

Ecclium hat eine Person als Maintainer. Der Schutz muss deshalb technisch wirken, nicht durch Aufmerksamkeit.

## Optionen

1. **Standardwerte der Werkzeuge:** kein Aufwand. pnpm 11 wartet von sich aus einen Tag und verbietet Install-Skripte, prüft aber keine Lizenzen, und eine falsch geschriebene Einstellung fiele niemandem auf.
2. **Abhängigkeiten ins Repository kopieren:** volle Kontrolle, aber jede Aktualisierung ist Handarbeit, und der Umfang wächst schnell.
3. **Strenge Grundlinie im Repository, automatisch geprüft:** Schutzeinstellungen, Positivlisten und Prüfungen liegen im Repository und laufen lokal und in CI.

## Entscheid

Gewählt ist die dritte Option. Sie gilt ab dem ersten Commit.

**Installation.** pnpm installiert mit diesen Einstellungen in `pnpm-workspace.yaml`:

- Jede Version, auch eine transitive, muss seit mindestens drei Tagen veröffentlicht sein. Findet pnpm in einem Bereich keine Version, die alt genug ist, bricht die Installation ab, statt auf eine jüngere auszuweichen. Eine Version ohne Zeitangabe in der Registry gilt als zu jung.
- Eine Ausnahme vom Mindestalter gibt es nur für eine Sicherheitskorrektur, als genaue Version mit Datum und Begründung.
- Erscheint eine Version mit schwächerem Herkunftsnachweis als frühere Versionen desselben Pakets, bricht die Installation ab.
- Transitive Abhängigkeiten kommen nur aus der Registry, nicht aus Git-Repositories oder Tarball-Adressen.
- Abhängigkeiten führen keine Install-Skripte aus. Ein Paket mit einem Build-Schritt, der nicht ausdrücklich abgelehnt ist, lässt die Installation scheitern.
- Vor `pnpm run` prüft pnpm, dass `node_modules` zum Lockfile passt.

pnpm übergeht einen unbekannten Schlüssel nur mit einer Warnung. `scripts/check-pnpm-settings.mts` prüft deshalb die wirksamen Werte und jeden Schlüssel der Datei.

**Aktualisierungen.** Renovate wartet bei Laufzeitabhängigkeiten sieben Tage, bei Werkzeugen, Actions und Digests drei. Automatisch übernommen werden nur Patch- und Minor-Versionen von Entwicklungswerkzeugen, wenn alle Pflichtprüfungen grün sind. Nie automatisch übernommen werden Laufzeitabhängigkeiten, Actions, Werkzeuge aus mise, Basis-Images, Werkzeuge ohne Herkunftsnachweis, die Pflege der Lockdatei und Sicherheitsaktualisierungen.

Actions sind aus zwei Gründen ausgenommen. Das Alter einer Version liest Renovate bei Actions aus Git-Daten, die bestimmt, wer den Tag setzt, ausser die Version hat ein Release auf GitHub; die Wartezeit ist für Actions also nicht verlässlich. Und eine Action läuft in den Prüfungen ihrer eigenen Aktualisierung: Eine übernommene Version von `actions/checkout` oder der Action, die mise installiert, könnte dort jede Pflichtprüfung als bestanden melden.

Jede Action ist auf eine SHA gepinnt, mit der genauen Version im Kommentar. Bringt eine Aktualisierung eine neue SHA für dieselbe Version, wurde ein Tag verschoben. Das ist das typische Zeichen einer übernommenen Action. Für eine solche Aktualisierung öffnet Renovate erst nach einer Freigabe im Dependency Dashboard einen Pull Request.

Sicherheitsaktualisierungen umgehen die Wartezeit von Renovate. pnpm installiert sie trotzdem erst mit einer Ausnahme vom Mindestalter, und diese Ausnahme besteht die Prüfung erst, wenn eine Maintainerin oder ein Maintainer Datum und Begründung dazugeschrieben hat.

**Herkunftsnachweis.** Die Vertrauensrichtlinie von pnpm schützt nur Pakete, die einen Herkunftsnachweis (Provenance) veröffentlichen. Am 26.09.2026 fehlt er bei TypeScript, `@types/node`, ESLint, `@eslint/js` und Prettier. Für diese Pakete bleibt das Mindestalter die einzige automatische Sperre.

**Lizenzen.** Zur Laufzeit sind nur MIT, ISC, Apache-2.0, BSD-2-Clause, BSD-3-Clause, 0BSD und BlueOak-1.0.0 erlaubt. Werkzeuge der Entwicklung dürfen zusätzlich MPL-2.0, CC0-1.0, CC-BY-3.0 und CC-BY-4.0 nutzen, weil sie nie ausgeliefert werden. Eine unbekannte Lizenz ist ein Fehler. Jede neue Abhängigkeit wird im Commit begründet: Zweck, Lizenz, erwogene Alternativen.

**Werkzeuge ausserhalb von npm.** mise installiert sie im Locked-Modus. `mise.lock` hält für jedes Werkzeug und jede unterstützte Plattform Download-Adresse und Prüfsumme fest. Die Datei ist der Anker für die Integrität, weil mehrere dieser Projekte selbst keine Prüfsummen veröffentlichen.

**Geheimnisse und vertrauliche Daten.** gitleaks prüft vor jedem Commit die Änderungen und die Commit-Message mit den Regeln in `.gitleaks.toml` (ADR 0014). Ein Kommentar `gitleaks:allow` schaltet einen Fund nicht ab, und eine Datei `.gitleaksignore`, die gitleaks von sich aus liest, weisen Hooks und CI zurück. In CI prüft gitleaks für jeden Pull Request die Geschichte bis zum geprüften Commit, die Dateien, die Namen aller Dateien, den Titel und alle Commit-Messages, denn Titel und Messages werden Teil des Squash-Commits auf `main`.

**GitHub Actions.** Erlaubt sind nur Actions aus einer Positivliste der Organisation, jede auf eine vollständige SHA gepinnt. Die Actions, die nur im Job von OpenSSF Scorecard laufen, stehen dort mit genau einer SHA, die übrigen mit dem Namen ihres Repositorys. Workflows starten ohne Rechte (`permissions: {}`), und jeder Job erhält nur, was er braucht: Alle Jobs in den Workflows des Repositorys lesen nur, ausser dem Job von OpenSSF Scorecard, der seine Ergebnisse als Befunde hochlädt und für den Scorecard-Dienst signiert. CodeQL läuft im Default Setup in einem eigenen Job, den GitHub verwaltet. Dazu `persist-credentials: false`, kein `pull_request_target`, keine Secrets, Workflows aus Forks erst nach Freigabe und in Phase 0 kein Cache. Ein vergifteter Cache könnte ein Prüfwerkzeug ersetzen, und die Prüfsummen aus `mise.lock` werden beim Wiederherstellen aus dem Cache nicht erneut geprüft. actionlint, shellcheck und zizmor prüfen die Workflows selbst. zizmor prüft in CI zusätzlich online, ob jede gepinnte SHA zur Action und zur Version im Kommentar passt und ob eine Version bekannte Schwachstellen ab mittlerer Schwere hat.

**Pull Requests.** Jeder Pull Request durchläuft die Prüfungen in CI als Pflicht: Workflows, Geheimnisse, Build und Tests auf drei Versionen von Node.js (ADR 0019), neue Abhängigkeiten auf bekannte Schwachstellen, den Titel und das Sign-off jedes Commits (ADR 0002). Die Prüfung der Abhängigkeiten schlägt bei jeder bekannten Schwachstelle fehl, auch in Werkzeugen der Entwicklung, weil diese in CI und auf Entwicklungsrechnern laufen.

**Veröffentlichung.** Auf Entwicklungsrechnern liegt kein Token für npm. Entwickelt wird in einer isolierten Arbeitsumgebung ohne Rechte zum Veröffentlichen und Pushen. Veröffentlicht wird nur über den Release-Pfad, mit Trusted Publishing und einer Freigabe über einen Hardware-Schlüssel.

## Konsequenzen

- Neue Versionen kommen frühestens nach drei Tagen an, auch Fehlerkorrekturen. Für Sicherheitskorrekturen gibt es die enge Ausnahme.
- Wer ein Paket ohne Herkunftsnachweis übernimmt, wird nur durch das Mindestalter und die Durchsicht aufgehalten.
- gitleaks erhält laut seinem Projekt nur noch Sicherheitskorrekturen. Spätestens vor dem ersten Release wird es gegen seinen Nachfolger neu bewertet.
- Prüfungen, die in einem Pull Request laufen, schützen vor Versehen. Gegen einen böswilligen Fork schützen nur die Freigabe des Laufs und die Durchsicht. `CONTRIBUTING.md` nennt die Dateien, die vor einer Freigabe anzusehen sind.
- Die Action, die mise installiert, legt das Token des Jobs für alle folgenden Schritte in die Umgebung. Deshalb erhält kein Job, der mise benutzt, mehr als Leserechte. mise übernimmt ausserdem Umgebungsvariablen und Pfade aus seinen Konfigurationsdateien für alle folgenden Schritte; auch diese Dateien gehören zur Durchsicht eines Pull Requests aus einem Fork.
- Updates von Actions kosten Handarbeit, weil keines automatisch übernommen wird. Bei der geringen Zahl von Actions ist das der kleinere Preis.
- Die Action von OpenSSF Scorecard lädt ihr Container-Image über einen Tag. Die gepinnte SHA der Action legt den Inhalt dieses Images nicht fest.
- Actions, die mit genau einer SHA in der Positivliste stehen, brauchen bei jeder Aktualisierung zuerst einen neuen Eintrag in der Organisation. Bis dahin startet der Workflow nicht.
- Mit einer Person als Maintainer prüft niemand die Entscheide der Maintainer gegen. Die Regeln machen Abweichungen sichtbar, verhindern können sie sie nicht.
- Die Prüfungen kosten bei jeder Änderung Zeit. Das ist der Preis dafür, dass der Schutz nicht von Aufmerksamkeit abhängt.

## Umsetzung

- Installation: `pnpm-workspace.yaml`, geprüft durch `scripts/check-pnpm-settings.mts`.
- Lizenzen: `scripts/check-licenses.mts`.
- Werkzeuge: `mise.toml`, `mise.lock`, `mise.compat.toml`, `mise.compat.lock`, `mise.minimum.toml`, `mise.minimum.lock`.
- Geheimnisse: `.gitleaks.toml`, `lefthook.yml`.
- Alle Prüfungen zusammen: `pnpm check`, dazu `pnpm ci:local` für die Prüfungen aus CI, die ohne GitHub möglich sind.
- CI: `.github/workflows/ci.yml` mit den Jobs `workflow-lint`, `secret-scan`, `check`, `compat`, `minimum` und `deps-review`, `.github/workflows/pr-meta.yml` mit `pr-title` und `dco`, dazu `scripts/ci/`. Jeder dieser Jobs ist eine Pflichtprüfung für `main`.
- OpenSSF Scorecard: `.github/workflows/scorecard.yml`, keine Pflichtprüfung.
- Aktualisierungen: `.github/renovate.json5`.
- Ausnahmen vom Mindestalter: `scripts/check-pnpm-settings.mts` verlangt über jeder Ausnahme einen Kommentar mit Datum und Grund und gleicht die Liste mit den Ausnahmen ab, die pnpm tatsächlich anwendet.
- Positivliste der Actions, Pflicht zur vollständigen SHA und Freigabe von Workflows aus Forks: Einstellungen der Organisation auf GitHub.
- Sicherheitskonfiguration auf GitHub: Abhängigkeitsgraph (für `deps-review`), Dependabot-Warnungen (für die Sicherheitsaktualisierungen von Renovate, ohne eigene Pull Requests von Dependabot), CodeQL im Default Setup, Secret Scanning mit Push Protection und Private Vulnerability Reporting.
- Der Release-Pfad folgt in Phase 8.
