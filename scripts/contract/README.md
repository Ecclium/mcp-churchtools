# Vertragsabgleich des ChurchTools-Clients

Das Skript `check.mts` vergleicht, was der ChurchTools-Client von Ecclium liest, mit dem OpenAPI-Dokument Ihrer Instanz (ADR 0057). Es sendet nichts an ChurchTools. Es liest nur zwei Dateien:

- `packages/core/src/churchtools/contract.json`: die Schemas des Clients als JSON Schema. Ein Test hält die Datei fest und wird rot, sobald sich ein Schema ändert.
- die State-Datei der Probe `00-inventory` aus `scripts/spike/`. Sie enthält das OpenAPI-Dokument Ihrer Instanz. Wie Sie sie anlegen, steht in `scripts/spike/README.md`.

## Was es ausgibt

Für jede Operation des Clients in `contract.json`, ob Ihre Instanz sie dokumentiert und als veraltet markiert, und ob sie die Parameter der Query deklariert, die der Client sendet. Für jedes Feld, das der Client liest, in jeder Tiefe, ob das Dokument es deklariert, mit seiner Typklasse, ob es Pflicht ist und ob es `null` sein darf. Ein Feld nennt das Skript mit seinem Pfad in der Antwort, etwa `data[].appointment.base.title`, wobei `[]` für die Einträge einer Liste steht und `{}` für die Werte einer Map, etwa der Tage eines Termins. Das Dokument liest es dabei samt Verweisen und den Teilen von `allOf`, `oneOf` und `anyOf`. Für die Rechte, ob das Dokument ihre Werte als Map beschreibt. Zwei Einträge des Vertrags können dieselbe Operation lesen, etwa ein Event und seine Einteilungen. Das Skript vergleicht dann beide mit derselben Antwort.

Am Ende steht unter `abweichungen`, wo das Dokument von dem abweicht, was der Client erwartet: eine Operation, die es nicht dokumentiert oder als veraltet markiert, ein Parameter, den es nicht deklariert, ein Feld, das es nicht deklariert, mit einer anderen Typklasse beschreibt, nicht als Pflicht nennt, obwohl der Client es verlangt, oder `null` erlaubt, wo der Client es nicht annimmt. Unter einem Feld, das das Dokument nicht deklariert, nennt es nichts mehr. Eine Abweichung heisst nicht, dass der Client scheitert: Das OpenAPI-Dokument ist nicht immer genau, und was ChurchTools tatsächlich antwortet, zeigt erst ein Lauf der Tools.

Ausgegeben werden nur feste Wörter, die Namen des Clients, Wahrheitswerte und die Version von ChurchTools als Haupt- und Nebennummer. Dafür sorgt dieselbe Sicherung wie bei den Proben. Stünde an einer Stelle womöglich etwas aus Ihrer Instanz, hält das Skript die ganze Ausgabe zurück.

## Aufruf

Das Skript läuft nicht in CI. Sie starten es lokal, mit denselben Variablen wie die Proben:

```bash
ECCLIUM_SPIKE_BASE_URL=https://example.church.tools ECCLIUM_SPIKE_STATE_FILE=/pfad/zur/state-datei node scripts/contract/check.mts
```

Die State-Datei muss ausserhalb jedes Git-Arbeitsbaums liegen und darf nur von Ihrem Benutzer lesbar sein. Lesen Sie die Ausgabe durch, bevor Sie sie weitergeben.
