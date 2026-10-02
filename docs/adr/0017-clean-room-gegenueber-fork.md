# ADR 0017: Clean Room gegenüber dem eigenen Fork eines Referenzprojekts

- Status: Vorgeschlagen
- Datum: 02.10.2026
- Fällt vor: Phase 0

## Kontext

Es gibt andere quelloffene MCP-Server für ChurchTools unter der MIT-Lizenz. Ecclium nutzt sie als Ideengeber, nicht als Quelle für Code: Fremder Quelltext kommt nicht in den Kern (ADR 0002, `CONTRIBUTING.md`). Der Maintainer von Ecclium betreibt ausserdem einen Fork eines dieser Projekte. Damit liegen fremder Quelltext, Zugangsdaten und Erfahrungen aus dessen Betrieb nahe an der Arbeit am Kern.

Fremder Code im Kern brächte Pflichten aus seiner Lizenz und machte die Herkunft des Codes unklar, gerade weil ein kostenpflichtiges Zusatzmodul auf dem Kern aufbaut (ADR 0015). Zugangsdaten aus dem Betrieb des Forks könnten in Tests, Proben oder Protokolle geraten.

## Optionen

1. **Nur die allgemeine Regel gegen fremden Quelltext:** keine zusätzlichen Vorgaben. Wer am Fork und am Kern im selben Umfeld arbeitet, übernimmt Code oder Zugangsdaten aber leicht aus Versehen.
2. **Clean Room:** Fork und Kern bleiben getrennt, in der Arbeit wie bei Konten und Zugangsdaten. Aus dem Betrieb des Forks fliessen nur Beobachtungen an der API ein, gekennzeichnet.

## Entscheid

Gewählt ist die zweite Option.

- **Getrennte Arbeit:** Am Fork und am Kern wird nie in derselben Arbeitsumgebung gearbeitet. In der Arbeitsumgebung des Kerns liegen weder Quelltext noch Zugangsdaten des Forks.
- **Kein Quelltext:** Aus dem Fork und aus den Referenzprojekten wird kein Quelltext übernommen, auch keine einzelnen Funktionen, Tests oder Konfigurationen. Ideen, der Zuschnitt von Tools und Namensschemata dürfen einfliessen. Ausnahmen gibt es nur nach dem Verfahren aus ADR 0002.
- **Getrennte Konten:** Ecclium benutzt kein Konto, kein Dienstkonto und kein Token, das der Fork benutzt, weder für die Proben des API-Spikes noch für Server, Runner oder CI.
- **Beobachtungen an der API:** Was beim Betrieb des Forks über das Verhalten der ChurchTools-API bekannt wird, darf einfliessen, als Beschreibung der API mit dem Vermerk «Beobachtung an der API im eigenen Betrieb, kein fremder Quelltext». Wie jede Aussage zur API gilt eine solche Beobachtung erst als belegt, wenn eine Probe sie an einer Instanz bestätigt hat (`docs/research/churchtools-api.md`). Daten, Protokolle und Konfiguration aus dem Betrieb des Forks kommen nie ins Repository.

## Konsequenzen

- Die Trennung ist eine Regel für die Arbeit, das Repository kann sie nicht belegen. Die Prüfungen auf vertrauliche Daten (ADR 0014) finden Zugangsdaten und Hosts, aber keinen kopierten Code. Dagegen helfen nur die Durchsicht und die Checkliste im Pull Request.
- Ecclium entsteht langsamer, als wenn es Code übernehmen dürfte. Dafür ist die Herkunft jeder Zeile im Kern klar, auch für das Zusatzmodul, das auf ihm aufbaut.
- Dass der Maintainer einen Fork betreibt, steht offen in diesem ADR, damit die Trennung nachvollziehbar ist.

## Umsetzung

- Regel für Beitragende: Abschnitt «Fremder Quelltext und Clean Room» in `CONTRIBUTING.md` und die Checkliste in `.github/pull_request_template.md`.
- Getrennte Konten für den API-Spike: Grundsatzentscheid 2 in `docs/STATUS.md`.
