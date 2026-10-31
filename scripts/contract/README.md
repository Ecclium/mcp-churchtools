# Vertragsabgleich des ChurchTools-Clients

Das Skript `check.mts` vergleicht, was der ChurchTools-Client von Ecclium liest, mit dem OpenAPI-Dokument Ihrer Instanz (ADR 0057), und ebenso den Katalog des lesenden Zugriffs auf die API (ADR 0067). Es sendet nichts an ChurchTools. Es liest nur drei Dateien:

- `packages/core/src/churchtools/contract.json`: die Schemas des Clients als JSON Schema. Ein Test hält die Datei fest und wird rot, sobald sich ein Schema ändert.
- `packages/core/src/churchtools/catalog/generated.ts`: den erzeugten Teil des Katalogs, je Operation mit `GET` Pfad und Parameter, wie `pnpm docs:refresh` ihn schreibt.
- die State-Datei der Probe `00-inventory` aus `scripts/spike/`. Sie enthält das OpenAPI-Dokument Ihrer Instanz. Wie Sie sie anlegen, steht in `scripts/spike/README.md`.

## Was es ausgibt

Für jede Operation des Clients in `contract.json`, ob Ihre Instanz sie dokumentiert und als veraltet markiert, und ob sie die Parameter der Query deklariert, die der Client sendet. Für jedes Feld, das der Client liest, in jeder Tiefe, ob das Dokument es deklariert, mit seiner Typklasse, ob es Pflicht ist und ob es `null` sein darf. Ein Feld nennt das Skript mit seinem Pfad in der Antwort, etwa `data[].appointment.base.title`, wobei `[]` für die Einträge einer Liste steht und `{}` für die Werte einer Map, etwa der Tage eines Termins. Das Dokument liest es dabei samt Verweisen und den Teilen von `allOf`, `oneOf` und `anyOf`: Ein Feld gilt als deklariert, wenn ein Teil es deklariert. Typklasse und `null` kommen aus jedem Teil, der es deklariert, und Pflicht ist es, wenn das Schema selbst oder ein Teil von `allOf` es verlangt, oder jede Form von `oneOf` oder `anyOf` ausser einer, die nur `null` erlaubt. Für die Rechte, ob das Dokument ihre Werte als Map beschreibt. Zwei Einträge des Vertrags können dieselbe Operation lesen, etwa ein Event und seine Einteilungen. Das Skript vergleicht dann beide mit derselben Antwort.

Am Ende steht unter `abweichungen`, wo das Dokument von dem abweicht, was der Client erwartet: eine Operation, die es nicht dokumentiert oder als veraltet markiert, ein Parameter, den es nicht deklariert, ein Feld, das es nicht deklariert, mit einer anderen Typklasse beschreibt, nicht als Pflicht nennt, obwohl der Client es verlangt, oder `null` erlaubt, wo der Client es nicht annimmt. Unter einem Feld, das das Dokument nicht deklariert, nennt es nichts mehr. Eine Abweichung heisst nicht, dass der Client scheitert: Das OpenAPI-Dokument ist nicht immer genau, und was ChurchTools tatsächlich antwortet, zeigt erst ein Lauf der Tools.

Unter `katalog` steht, was das Dokument Ihrer Instanz für die Escape Hatch ergäbe, verglichen mit dem Katalog des Kerns, mit `abgleich: moeglich`. Das Skript baut dafür aus dem Dokument mit denselben Regeln wie `pnpm docs:refresh` den Katalog und nennt unter `abweichungen` jede Operation, die neu im Dokument ist, die es nicht mehr nennt, die einen anderen Pfad hat, nun oder nicht mehr veraltet ist oder anders antwortet, und jeden Parameter, der dazukommt, fehlt oder sich in Ort, Pflicht, Art, als Liste oder in seinen Werten ändert. `operationen`, `imDokument` und `gleich` zählen die Operationen des Katalogs, die des Dokuments und die ohne Abweichung. Eine Operation, die neu im Dokument ist, hat keine Einstufung von Hand: Ecclium liest sie nicht, bis `pnpm docs:refresh` sie aufnimmt und eine Person sie einstuft. Den Namen einer neuen Operation oder eines neuen Parameters gibt nur das Dokument Ihrer Instanz. Das Skript nennt ihn nur in der Form, die die Fakten für solche Namen zulassen, sonst steht dort `unlesbar`, und es behandelt ihn wie jeden Wert der Instanz: Enthält er etwa einen Teil des Hosts, hält es die ganze Ausgabe zurück. Hat das Dokument eine Form, aus der auch der Refresh keine Fakten machen kann, steht unter `katalog` nur `abgleich: nicht moeglich`, und der Abgleich des Clients läuft trotzdem.

Ist `contract.json` beschädigt oder das Dokument so verschachtelt, dass der Abgleich mehr als eine feste Zahl von Schritten bräuchte, bricht das Skript mit einem festen Hinweis ab, statt eine halbe Antwort zu geben.

Ausgegeben werden nur feste Wörter, die Namen des Clients und des Katalogs, die geprüften Namen neuer Operationen und Parameter, Wahrheitswerte, Zahlen der Operationen und die Version von ChurchTools als Haupt- und Nebennummer. Dafür sorgt dieselbe Sicherung wie bei den Proben. Stünde an einer Stelle womöglich etwas aus Ihrer Instanz, hält das Skript die ganze Ausgabe zurück.

## Aufruf

Das Skript läuft nicht in CI. Sie starten es lokal, mit denselben Variablen wie die Proben:

```bash
ECCLIUM_SPIKE_BASE_URL=https://example.church.tools ECCLIUM_SPIKE_STATE_FILE=/pfad/zur/state-datei node scripts/contract/check.mts
```

Die State-Datei muss ausserhalb jedes Git-Arbeitsbaums liegen und darf nur von Ihrem Benutzer lesbar sein. Lesen Sie die Ausgabe durch, bevor Sie sie weitergeben.
