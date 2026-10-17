# Vertragsabgleich des ChurchTools-Clients

Das Skript `check.mts` vergleicht, was der ChurchTools-Client von Ecclium liest, mit dem OpenAPI-Dokument Ihrer Instanz (ADR 0057). Es sendet nichts an ChurchTools. Es liest nur zwei Dateien:

- `packages/core/src/churchtools/contract.json`: die Schemas des Clients als JSON Schema. Ein Test hält die Datei fest und wird rot, sobald sich ein Schema ändert.
- die State-Datei der Probe `00-inventory` aus `scripts/spike/`. Sie enthält das OpenAPI-Dokument Ihrer Instanz. Wie Sie sie anlegen, steht in `scripts/spike/README.md`.

## Was es ausgibt

Für jede Operation des Clients, ob Ihre Instanz sie dokumentiert und als veraltet markiert, und ob sie die Parameter der Query deklariert, die der Client sendet. Für jedes Feld, das der Client liest, ob das Dokument es deklariert, mit seiner Typklasse, ob es Pflicht ist und ob es `null` sein darf. Für die Rechte, ob das Dokument ihre Werte als Map beschreibt.

Ausgegeben werden nur feste Wörter, die Namen des Clients, Wahrheitswerte und die Version von ChurchTools als Haupt- und Nebennummer. Dafür sorgt dieselbe Sicherung wie bei den Proben. Stünde an einer Stelle womöglich etwas aus Ihrer Instanz, hält das Skript die ganze Ausgabe zurück.

## Aufruf

Das Skript läuft nicht in CI. Sie starten es lokal, mit denselben Variablen wie die Proben:

```bash
ECCLIUM_SPIKE_BASE_URL=https://example.church.tools ECCLIUM_SPIKE_STATE_FILE=/pfad/zur/state-datei node scripts/contract/check.mts
```

Die State-Datei muss ausserhalb jedes Git-Arbeitsbaums liegen und darf nur von Ihrem Benutzer lesbar sein. Lesen Sie die Ausgabe durch, bevor Sie sie weitergeben.
