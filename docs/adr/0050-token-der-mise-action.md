# ADR 0050: Token des Jobs bei der Action, die mise installiert

- Status: Vorgeschlagen
- Datum: 08.10.2026
- Fällt vor: Phase 0

## Kontext

ADR 0021 (Supply-Chain-Baseline) ist seit dem 02.10.2026 angenommen. In seinen Konsequenzen steht: «Die Action, die mise installiert, legt das Token des Jobs als `MISE_GITHUB_TOKEN` für alle folgenden Schritte des Jobs in die Umgebung. Deshalb erhält kein Job, der mise benutzt, mehr als Leserechte.»

Das galt für `jdx/mise-action` bis Version 5.1.0. Seit Version 5.1.1 vom 04.10.2026 behält die Action das Token in der Grundeinstellung für sich. Es steht nur in ihrem eigenen Prozess und in den Prozessen von mise, die sie startet. Folgende Schritte erhalten es nur noch über die neue Eingabe `persist_github_token`. Sie nimmt `true` oder `false`, und jeden anderen Wert gibt die Action wörtlich als Token an die folgenden Schritte weiter. Alles andere an der Action ist gegenüber Version 5.1.0 gleich, auch der Cache, die Prüfung von mise und die Übernahme von Umgebung und Pfaden aus den Dateien von mise. Geprüft am Quelltext von Version 5.1.1, dem Commit `2d8d4cafcbd33be2ea37d2b6f5ad595363d1f1ca`.

Ein angenommener Entscheid ändert sich nur durch ein neues ADR, das ihn ablöst (ADR 0001).

## Optionen

1. **Bei Version 5.1.0 bleiben:** ADR 0021 bleibt richtig, aber das Token erreicht weiter jeden folgenden Schritt, auch Tests und Skripte aus einem Pull Request.
2. **Version 5.1.1 mit `persist_github_token: true`:** dasselbe Verhalten wie bisher, ohne Gewinn.
3. **Version 5.1.1 in der Grundeinstellung, durch einen Test gesichert:** Das Token bleibt in der Action und in mise, die Jobs mit mise lesen weiter nur.

## Entscheid

Gewählt ist die dritte Option. Dieses ADR löst ADR 0021 ab. Der Entscheid von ADR 0021 gilt unverändert weiter, nur die Konsequenz zum Token der Action, die mise installiert, wird ersetzt durch:

- Die Action, die mise installiert, behält das Token des Jobs für sich. Keine Workflow-Datei setzt für diese Action `persist_github_token` oder `github_token`, und keine setzt `MISE_GITHUB_TOKEN`.
- Das Token steht weiter in den Prozessen von mise, die die Action startet. Deshalb erhält ein Job, der mise benutzt, weiter nur Leserechte (`contents: read`) und keine Secrets.
- Was ADR 0021 sonst über diese Action sagt, gilt weiter: Sie erklärt jede Konfigurationsdatei von mise im Arbeitsverzeichnis für vertrauenswürdig und übernimmt in ihrer Grundeinstellung Umgebungsvariablen und Pfade aus diesen Dateien für alle folgenden Schritte.

## Konsequenzen

- Wer den ganzen Entscheid zur Lieferkette lesen will, liest ADR 0021 und dieses ADR zusammen. ADR 0021 trägt den Status «Abgelöst durch ADR 0050», sein Text bleibt unverändert.
- Tests und Skripte in den Schritten nach mise erhalten das Token nicht mehr von der Action.
- Eine Datei von mise mit einem Eintrag unter `[env]`, der `MISE_GITHUB_TOKEN` ausliest, könnte das Token über die Übernahme der Umgebung wieder an die folgenden Schritte geben. Solche Dateien gehören deshalb zur Durchsicht eines Pull Requests. Eine Prüfung im Repository gibt es dafür nicht.
- Eine spätere Version der Action kann ihr Verhalten wieder ändern. Der Test prüft nur die Eingaben und die Rechte in den Workflows, nicht das Verhalten der Action selbst. Weil keine Aktualisierung einer Action automatisch übernommen wird (ADR 0021), sieht eine Person vor jeder Übernahme nach, ob sich am Umgang mit dem Token etwas ändert.

## Umsetzung

- Gepinnt ist `jdx/mise-action` 5.1.1 in allen Schritten, die mise installieren.
- `tests/toolchain.test.mts` weist `persist_github_token`, `github_token` und `MISE_GITHUB_TOKEN` zurück und verlangt für jeden Job mit mise genau `contents: read` und keine Secrets. Ein weiterer Test wendet acht verbotene Änderungen auf `ci.yml` an und verlangt, dass jede gemeldet wird.
