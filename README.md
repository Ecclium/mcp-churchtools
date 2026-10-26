<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/logo/ecclium-logo-negativ.svg">
  <img src="brand/logo/ecclium-logo.svg" alt="Ecclium" width="240">
</picture>

# Ecclium MCP für ChurchTools

**In Entwicklung.** Es gibt noch keine veröffentlichte Version. Aus dem Quellcode lässt sich ein erster Server bauen, der einen KI-Assistenten über stdio anbindet und das Tool `ct_whoami` anbietet, auf ausdrücklichen Wunsch auch Tools, die Personen, Gruppen und das Wiki lesen. Wie, steht in [docs/betrieb/stdio.md](docs/betrieb/stdio.md), wie Sie das Dienstkonto in ChurchTools einrichten, in [docs/betrieb/dienstkonto.md](docs/betrieb/dienstkonto.md). Welche Variablen es gibt, steht in [docs/configuration.md](docs/configuration.md), welche Tools mit welchen Feldern, in [docs/tools.md](docs/tools.md), welche Prompts, in [docs/prompts.md](docs/prompts.md). Was fertig ist und was als Nächstes kommt, steht in [docs/STATUS.md](docs/STATUS.md).

Ecclium verbindet KI-Assistenten mit der Gemeindesoftware ChurchTools. Der Assistent kann Daten lesen und, wo die Gemeinde es erlaubt, auch schreiben. Wiederkehrende Aufgaben wie der wöchentliche Dienstplan-Bericht laufen nach Zeitplan. Jede Änderung wird vorher gezeigt, gekennzeichnet und protokolliert und lässt sich zurücknehmen. Der Quellcode von Ecclium ist öffentlich, Ecclium lässt sich selbst betreiben und legt besonderen Wert auf Daten- und Informationssicherheit.

Ecclium ist ein unabhängiges Projekt und steht in keiner Verbindung zum Hersteller von ChurchTools.

## Stand

Das Projekt steht am Anfang. Den aktuellen Stand, die offenen Punkte und den nächsten Schritt finden Sie in [docs/STATUS.md](docs/STATUS.md), die Architekturentscheide in [docs/adr/](docs/adr/README.md).

## Sicherheit

Melden Sie Sicherheitslücken bitte nicht in einem öffentlichen Issue, sondern vertraulich, wie in [SECURITY.md](SECURITY.md) beschrieben.

## Mitwirken

Wie ein Beitrag aussieht, den das Projekt übernehmen kann, steht in [CONTRIBUTING.md](CONTRIBUTING.md). Jeder Commit in einem Pull Request trägt ein Sign-off nach dem Developer Certificate of Origin, und Beiträge gehen unter der Apache License 2.0 ein.

## Lizenz

Der Quellcode steht unter der [Elastic License 2.0](LICENSE), die Hinweise dazu stehen in [NOTICE](NOTICE). Sie ist keine Open-Source-Lizenz. Eine Gemeinde darf Ecclium kostenlos für sich selbst betreiben, ändern und weitergeben. Die Lizenz erlaubt nicht, Ecclium Dritten als gehosteten oder verwalteten Dienst anzubieten, der ihnen einen wesentlichen Teil der Funktionen zugänglich macht, etwa als Dienstleister für eine oder mehrere andere Gemeinden. Dafür braucht es eine Erlaubnis des Lizenzgebers im Sinn der Elastic License 2.0. Was vor dem Wechsel zur Elastic License 2.0 hier veröffentlicht war, steht weiter unter der [Apache License 2.0](LICENSES/Apache-2.0.txt). Massgebend ist allein der englische Text in [LICENSE](LICENSE), diese Zusammenfassung ist nicht verbindlich. Was einmal im freien Kern war, bleibt im freien Kern, siehe [PROMISE.md](PROMISE.md).

Name und Logo von Ecclium sind nicht Teil der Lizenz des Quellcodes. Ihr Gebrauch wird in [TRADEMARKS.md](TRADEMARKS.md) geregelt, diese Datei folgt.
