# Vertragsabgleich des ChurchTools-Clients

Das Skript `check.mts` vergleicht, was der ChurchTools-Client von Ecclium liest und schreibt, mit dem OpenAPI-Dokument Ihrer Instanz (ADR 0057, ADR 0072), und ebenso den Katalog des lesenden Zugriffs auf die API (ADR 0067). Es sendet nichts an ChurchTools. Gegen Ihre Instanz liest es nur drei Dateien, in CI statt der State-Datei den Auszug in diesem Ordner (siehe «In CI»):

- `packages/core/src/churchtools/contract.json`: die Schemas des Clients als JSON Schema. Ein Test hält die Datei fest und wird rot, sobald sich ein Schema ändert.
- `packages/core/src/churchtools/catalog/generated.ts`: den erzeugten Teil des Katalogs, je Operation mit `GET` Pfad und Parameter, wie `pnpm docs:refresh` ihn schreibt.
- die State-Datei der Probe `00-inventory` aus `scripts/spike/`. Sie enthält das OpenAPI-Dokument Ihrer Instanz. Wie Sie sie anlegen, steht in `scripts/spike/README.md`.

## Was es ausgibt

Für jede Operation des Clients in `contract.json`, ob Ihre Instanz sie dokumentiert und als veraltet markiert, und ob sie die Parameter der Query deklariert, die der Client sendet. Für jedes Feld, das der Client liest, in jeder Tiefe, ob das Dokument es deklariert, mit seiner Typklasse, ob es Pflicht ist und ob es `null` sein darf. Ein Feld nennt das Skript mit seinem Pfad in der Antwort, etwa `data[].appointment.base.title`, wobei `[]` für die Einträge einer Liste steht und `{}` für die Werte einer Map, etwa der Tage eines Termins. Das Dokument liest es dabei samt Verweisen und den Teilen von `allOf`, `oneOf` und `anyOf`: Ein Feld gilt als deklariert, wenn ein Teil es deklariert. Typklasse und `null` kommen aus jedem Teil, der es deklariert, und Pflicht ist es, wenn das Schema selbst oder ein Teil von `allOf` es verlangt, oder jede Form von `oneOf` oder `anyOf` ausser einer, die nur `null` erlaubt. Für die Rechte, ob das Dokument ihre Werte als Map beschreibt. Zwei Einträge des Vertrags können dieselbe Operation lesen, etwa ein Event und seine Einteilungen. Das Skript vergleicht dann beide mit derselben Antwort.

Für eine Operation, die schreibt, vergleicht es unter `koerper` jedes Feld, das der Client sendet, mit dem Körper der Anfrage, den das Dokument deklariert (`requestBody`): ob es das Feld deklariert, mit welcher Typklasse, ob es Pflicht ist und ob es `null` sein darf. Die Antwort liest es für den Status, den `contract.json` nennt, beim Anlegen einer Seite also 201. Eine Antwort, die der Client nicht liest, etwa die auf das Ändern einer Seite, vergleicht es nicht. Ein Löschen (`DELETE`) hat keinen Körper und endet mit 204. Dafür vergleicht es nur, ob das Dokument die Operation kennt und als veraltet markiert.

Am Ende steht unter `abweichungen`, wo das Dokument von dem abweicht, was der Client erwartet: eine Operation, die es nicht dokumentiert oder als veraltet markiert, ein Parameter, den es nicht deklariert, ein Feld, das es nicht deklariert, mit einer anderen Typklasse beschreibt, nicht als Pflicht nennt, obwohl der Client es verlangt, oder `null` erlaubt, wo der Client es nicht annimmt. Beim Körper einer Anfrage nennt es ein Feld, das der Client sendet und das Dokument nicht deklariert oder mit einer anderen Typklasse beschreibt, und ein Feld, das das Dokument verlangt und der Client nicht sendet (`Pflicht nicht gesendet`), jeweils mit `koerper.` vor dem Namen. Unter einem Feld, das das Dokument nicht deklariert, nennt es nichts mehr. Eine Abweichung heisst nicht, dass der Client scheitert: Das OpenAPI-Dokument ist nicht immer genau, und was ChurchTools tatsächlich antwortet, zeigt erst ein Lauf der Tools.

Unter `katalog` steht, was das Dokument Ihrer Instanz für die Escape Hatch ergäbe, verglichen mit dem Katalog des Kerns, mit `abgleich: moeglich`. Das Skript baut dafür aus dem Dokument mit denselben Regeln wie `pnpm docs:refresh` den Katalog und nennt unter `abweichungen` jede Operation, die neu im Dokument ist, die es nicht mehr nennt, die einen anderen Pfad hat, nun oder nicht mehr veraltet ist oder anders antwortet, und jeden Parameter, der dazukommt, fehlt oder sich in Ort, Pflicht, Art, als Liste oder in seinen Werten ändert. `operationen`, `imDokument` und `gleich` zählen die Operationen des Katalogs, die des Dokuments und die ohne Abweichung. Eine Operation, die neu im Dokument ist, hat keine Einstufung von Hand: Ecclium liest sie nicht, bis `pnpm docs:refresh` sie aufnimmt und eine Person sie einstuft. Den Namen einer neuen Operation oder eines neuen Parameters gibt nur das Dokument Ihrer Instanz. Das Skript nennt ihn nur in der Form, die die Fakten für solche Namen zulassen, sonst steht dort `unlesbar`, und es behandelt ihn wie jeden Wert der Instanz: Enthält er etwa einen Teil des Hosts, hält es die ganze Ausgabe zurück. Hat das Dokument eine Form, aus der auch der Refresh keine Fakten machen kann, steht unter `katalog` nur `abgleich: nicht moeglich`, und der Abgleich des Clients läuft trotzdem.

Ist `contract.json` beschädigt oder das Dokument so verschachtelt, dass der Abgleich mehr als eine feste Zahl von Schritten bräuchte, bricht das Skript mit einem festen Hinweis ab, statt eine halbe Antwort zu geben.

Ausgegeben werden nur feste Wörter, die Namen des Clients und des Katalogs, die geprüften Namen neuer Operationen und Parameter, Wahrheitswerte, Zahlen der Operationen und die Version von ChurchTools als Haupt- und Nebennummer. Dafür sorgt dieselbe Sicherung wie bei den Proben. Stünde an einer Stelle womöglich etwas aus Ihrer Instanz, hält das Skript die ganze Ausgabe zurück.

## In CI

`pnpm check:contract` führt `node scripts/contract/check.mts --auszug` aus, als Schritt von `pnpm check` und damit in CI (ADR 0076). Statt der State-Datei liest das Skript dann `openapi-extract.json` in diesem Ordner, einen Auszug des OpenAPI-Dokuments nur mit den Operationen des Clients, mit allen Feldern der Schemas, die sie erreichen, aber nur mit den Schlüsseln, die der Abgleich liest, und vergleicht die Abweichungen mit `accepted-deviations.json`: je bekannter Abweichung Operation, Feld, Art und ein Grund mit Beleg. Den Teil `katalog` lässt es weg, weil ein Test den Katalog schon in CI gegen `operations.json` hält. Ausgegeben werden nur Zahlen und die Abweichungen, die nicht zur Liste passen. Codes: 0, wenn die Abweichungen genau die Liste sind, 1 bei einer neuen und bei einer, die nicht mehr auftritt, 2 bei einer beschädigten oder fehlenden Datei, 3, wenn die Sicherung der Ausgabe etwas zurückhält.

Ändern Sie den Client so, dass er vom Dokument abweicht, wird CI rot. Belegen Sie die Abweichung, etwa mit einem Lauf der Tools gegen die Testinstanz, und tragen Sie sie mit ihrem Grund in die Liste ein, oder passen Sie den Client an. Fällt eine bekannte Abweichung weg, entfernen Sie ihren Eintrag. Braucht der Client eine neue Operation oder liest er die Antwort eines anderen Status, schreiben Sie zuerst den Auszug neu, nach einem frischen Lauf von `00-inventory`, statt eine Abweichung einzutragen:

```bash
ECCLIUM_SPIKE_BASE_URL=https://example.church.tools ECCLIUM_SPIKE_STATE_FILE=/pfad/zur/state-datei pnpm docs:refresh --nur-vertrag
```

Der Auszug nennt das Dokument, aus dem er stammt. Er kann neuer sein als die Fakten des Doku-Index; `pnpm docs:refresh --nur-openapi` schreibt beide aus demselben Dokument. Vor dem Schreiben prüft der Refresh, dass der Abgleich über den Auszug genau dasselbe ergibt wie über das ganze Dokument, sonst schreibt er nichts. Eine Änderung am API von ChurchTools findet nur der Lauf gegen Ihre Instanz unten; machen Sie ihn vor jeder Erneuerung des Auszugs.

## Aufruf gegen Ihre Instanz

Sie starten das Skript lokal, mit denselben Variablen wie die Proben:

```bash
ECCLIUM_SPIKE_BASE_URL=https://example.church.tools ECCLIUM_SPIKE_STATE_FILE=/pfad/zur/state-datei node scripts/contract/check.mts
```

Die State-Datei muss ausserhalb jedes Git-Arbeitsbaums liegen und darf nur von Ihrem Benutzer lesbar sein. Lesen Sie die Ausgabe durch, bevor Sie sie weitergeben.
