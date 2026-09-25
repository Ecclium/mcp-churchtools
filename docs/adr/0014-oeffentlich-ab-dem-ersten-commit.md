# ADR 0014: Öffentliche Versionsgeschichte ab dem ersten Commit

- Status: Angenommen
- Datum: 25.09.2026
- Fällt vor: Phase 0, vor dem ersten Commit

## Kontext

Ein Repository kann privat beginnen und später öffentlich werden, mit oder ohne seine bisherige Geschichte. Wer privat beginnt, schiebt die Prüfung auf vertrauliche Daten auf und muss später wählen: die Geschichte umschreiben oder einen neuen Anfang ohne Geschichte veröffentlichen. Beides kostet Nachvollziehbarkeit. Umgeschriebene Geschichte bricht Verweise, ein neuer Anfang verbirgt, wie Code und Entscheide entstanden sind.

Ecclium arbeitet mit Daten von Gemeinden. Ein einziger Commit mit einem echten Hostnamen, einem Token oder Personendaten bliebe in einem öffentlichen Repository auffindbar, auch nach einer Korrektur, weil Klone, Forks und Archive die alte Fassung behalten.

## Optionen

1. **Privater Vorlauf, später öffentlich mit der ganzen Geschichte:** Versehen aus der privaten Zeit werden mit veröffentlicht.
2. **Privater Vorlauf, später öffentlich ohne Geschichte:** Die Herkunft von Code und Entscheiden geht verloren.
3. **Öffentlich ab dem ersten Commit:** Die Prüfung gilt von Anfang an, und nichts muss später umgeschrieben werden.

## Entscheid

Dieses Repository ist ab dem ersten Commit öffentlich. Es gibt keinen privaten Vorlauf und kein späteres Umschalten.

Die Geschichte auf `main` wird nicht umgeschrieben. Einzige Ausnahme: Personendaten, die entfernt werden müssen. Auch dann geschieht es nur nach einem Entscheid, der offen festgehalten wird.

## Konsequenzen

- Die Prüfung auf vertrauliche Daten gilt ab dem ersten Commit. Wo er eingerichtet ist, prüft ein Git-Hook Commits und Commit-Messages mit gitleaks. Er ist eine erste Sicherung. Commits, die ohne den Hook entstehen, etwa Beiträge von aussen oder die Squash-Commits auf `main`, prüft ein Scan in CI, sobald er besteht. Die Regeln in `.gitleaks.toml` sind generisch, echte Daten werden durch Platzhalter ersetzt.
- Suchmuster für einen bestimmten Tenant oder eine bestimmte Person liegen nie im Repository, weil ein Suchmuster verrät, wonach es sucht. Solche Prüfungen führen die Maintainer ausserhalb des Repositorys aus.
- Ein Fund in der Geschichte ist ein Blocker und wird als Vorfall behandelt. Zuerst wird ein betroffenes Geheimnis widerrufen. Dann wird über das weitere Vorgehen entschieden und dieses offen festgehalten. Umgeschrieben wird die Geschichte nur bei Personendaten und nie still. Auch dann bleibt die alte Fassung in Klonen, Forks und Archiven erhalten.
- Vor jedem Release läuft eine eigene Prüfung über Repository, Geschichte, npm-Paket und Container-Image.
- `main` ist geschützt: Änderungen nur über Pull Requests, kein Force-Push, lineare Geschichte.

## Umsetzung

- Regeln für gitleaks: `.gitleaks.toml`. Git-Hooks vor dem Commit und für die Commit-Message: `lefthook.yml`.
- Schutz von `main`: ein Ruleset in den Einstellungen des Repositorys auf GitHub. Es verlangt Pull Requests, verbietet Force-Push und erlaubt nur eine lineare Geschichte mit Squash-Merges.
