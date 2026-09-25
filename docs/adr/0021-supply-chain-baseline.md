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

**Aktualisierungen.** Renovate wartet bei Laufzeitabhängigkeiten sieben Tage, bei Werkzeugen, Actions und Digests drei. Automatisch übernommen werden nur Patch- und Minor-Versionen von Entwicklungswerkzeugen und Digests reiner Prüf-Actions. Nie automatisch übernommen werden Laufzeitabhängigkeiten, Actions mit Schreib- oder `id-token`-Rechten, Basis-Images und Werkzeuge ohne Herkunftsnachweis.

**Herkunftsnachweis.** Die Vertrauensrichtlinie von pnpm schützt nur Pakete, die einen Herkunftsnachweis (Provenance) veröffentlichen. Am 26.09.2026 fehlt er bei TypeScript, `@types/node`, ESLint, `@eslint/js` und Prettier. Für diese Pakete bleibt das Mindestalter die einzige automatische Sperre.

**Lizenzen.** Zur Laufzeit sind nur MIT, ISC, Apache-2.0, BSD-2-Clause, BSD-3-Clause, 0BSD und BlueOak-1.0.0 erlaubt. Werkzeuge der Entwicklung dürfen zusätzlich MPL-2.0, CC0-1.0, CC-BY-3.0 und CC-BY-4.0 nutzen, weil sie nie ausgeliefert werden. Eine unbekannte Lizenz ist ein Fehler. Jede neue Abhängigkeit wird im Commit begründet: Zweck, Lizenz, erwogene Alternativen.

**Werkzeuge ausserhalb von npm.** mise installiert sie im Locked-Modus. `mise.lock` hält für jedes Werkzeug und jede unterstützte Plattform Download-Adresse und Prüfsumme fest. Die Datei ist der Anker für die Integrität, weil mehrere dieser Projekte selbst keine Prüfsummen veröffentlichen.

**Geheimnisse und vertrauliche Daten.** gitleaks prüft vor jedem Commit die Änderungen und die Commit-Message mit den Regeln in `.gitleaks.toml` (ADR 0014). Ein Kommentar `gitleaks:allow` schaltet einen Fund nicht ab. In CI läuft dieselbe Prüfung über jeden Pull Request.

**GitHub Actions.** Erlaubt sind nur Actions aus einer Positivliste der Organisation, jede auf eine vollständige SHA gepinnt. Workflows starten ohne Rechte (`permissions: {}`), und jeder Job erhält nur, was er braucht. Dazu `persist-credentials: false`, kein `pull_request_target`, Workflows aus Forks erst nach Freigabe und in Phase 0 kein Cache.

**Veröffentlichung.** Auf Entwicklungsrechnern liegt kein Token für npm. Entwickelt wird in einer isolierten Arbeitsumgebung ohne Rechte zum Veröffentlichen und Pushen. Veröffentlicht wird nur über den Release-Pfad, mit Trusted Publishing und einer Freigabe über einen Hardware-Schlüssel.

## Konsequenzen

- Neue Versionen kommen frühestens nach drei Tagen an, auch Fehlerkorrekturen. Für Sicherheitskorrekturen gibt es die enge Ausnahme.
- Wer ein Paket ohne Herkunftsnachweis übernimmt, wird nur durch das Mindestalter und die Durchsicht aufgehalten.
- gitleaks erhält laut seinem Projekt nur noch Sicherheitskorrekturen. Spätestens vor dem ersten Release wird es gegen seinen Nachfolger neu bewertet.
- Prüfungen, die in einem Pull Request laufen, schützen vor Versehen. Gegen einen böswilligen Fork schützen nur die Freigabe des Laufs und die Durchsicht.
- Mit einer Person als Maintainer prüft niemand die Entscheide der Maintainer gegen. Die Regeln machen Abweichungen sichtbar, verhindern können sie sie nicht.
- Die Prüfungen kosten bei jeder Änderung Zeit. Das ist der Preis dafür, dass der Schutz nicht von Aufmerksamkeit abhängt.

## Umsetzung

- Installation: `pnpm-workspace.yaml`, geprüft durch `scripts/check-pnpm-settings.mts`.
- Lizenzen: `scripts/check-licenses.mts`.
- Werkzeuge: `mise.toml`, `mise.lock`, `mise.compat.toml`, `mise.compat.lock`.
- Geheimnisse: `.gitleaks.toml`, `lefthook.yml`.
- Alle Prüfungen zusammen: `pnpm check`.
- Renovate, die Workflows in CI mit ihren Rechten und die Positivliste der Actions folgen mit der Werkbank in Phase 0, der Release-Pfad in Phase 8.
