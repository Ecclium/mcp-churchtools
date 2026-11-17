# ADR 0076: Vertragsabgleich in CI mit einem Auszug des OpenAPI-Dokuments, ergänzt ADR 0027 und ADR 0057

- Status: Angenommen am 17.11.2026
- Datum: 17.11.2026
- Fällt vor: Phase 7

## Kontext

`scripts/contract/check.mts` vergleicht seit dem 28.10.2026 jede Operation des ChurchTools-Clients aus `packages/core/src/churchtools/contract.json` mit dem OpenAPI-Dokument einer Instanz: ob sie dokumentiert und veraltet ist, die Parameter der Query, den Körper einer schreibenden Anfrage und jedes Feld, das der Client liest, in jeder Tiefe ([ADR 0057](0057-lesender-churchtools-client.md), [ADR 0072](0072-schreibende-anfragen.md)). Er lief nur lokal gegen die State-Datei von `00-inventory`, weil das Dokument als Ganzes nie ins Repository kommt ([ADR 0027](0027-inhalte-des-doku-index.md)). In CI lief er nie: Eine Änderung am Client, die vom dokumentierten API abweicht, fiel erst beim nächsten Lauf von Hand auf.

- **Die Fakten des Doku-Index reichen nicht.** `operations.json` kürzt jedes Schema nach drei Schritten, und ein benanntes Schema an dieser Grenze steht nur noch mit seinem Namen da. Von den 37 Operationen in `contract.json` liest der Client bei 22 tiefer, als die Fakten reichen, bei `appointments` und `eventAssignments` sechs Schritte. Auch die Körper der Anfragen zum Anlegen und Ändern eines Termins enden an Schemas ohne Felder. Gemessen am 17.11.2026.
- **Das Dokument einer Instanz** schreibt jedes Schema dort aus, wo es steht, ohne Verweise. Unter `components` stehen dieselben Schemas mit ihrem Namen. An ChurchTools 3.138 hat es 847 Operationen und 1'131 benannte Schemas.
- **Bekannte Abweichungen:** An 3.138 fand der Abgleich neun, alle belegt ([`docs/research/churchtools-api.md`](../research/churchtools-api.md), «Vertragsabgleich an 3.138»): sieben Felder, die das Dokument nicht als Pflicht nennt, und die Einträge einer Liste in `calculatedDates`.
- **Rohquellen:** Eine Datei mit den Schlüsseln `openapi` und `paths` weist die Prüfung gegen Rohquellen im Baum zurück ([ADR 0066](0066-doku-index.md)).

## Optionen

1. **Wie bisher nur lokal:** Kein fremdes Material mehr im Repository, aber CI sieht eine Abweichung des Clients nie.
2. **Gegen die Fakten des Index:** Keine neue Datei, scheitert aber an der Tiefe von drei Schritten.
3. **Ein bereinigtes OpenAPI-Dokument mit allen Operationen:** Prüft auch den Katalog der Escape Hatch, steht aber nahe am Dokument als Ganzen, das ADR 0027 ausschliesst, und ist für den Abgleich des Clients viel zu gross.
4. **Ein Auszug nur der Operationen des Clients,** in voller Tiefe und nur mit dem, was der Abgleich liest, in einem eigenen Format.

## Entscheid

Gewählt ist die vierte Option.

- **Datei:** `scripts/contract/openapi-extract.json` im Format `ecclium.contract.extract.v1`, ausserhalb jedes Pakets. Sie kommt nie in ein npm-Paket und nicht in den Doku-Index.
- **Inhalt:** je Operation aus `contract.json`, die das Dokument dokumentiert, Methode, Pfad, ob sie veraltet ist, die Parameter nur mit Name, Ort und Pflicht, bei einer schreibenden Anfrage das Schema des Körpers und das Schema der Antwort des Status, den der Vertrag nennt. Dazu die benannten Schemas, die diese erreichen, in voller Tiefe. Jedes Schema trägt nur die Schlüssel, die der Abgleich liest: `type`, `nullable`, `required`, `properties`, `items`, `additionalProperties`, `allOf`, `oneOf`, `anyOf` und Verweise. Ein Schema, das einem benannten gleicht, wird zum Verweis darauf, wie die Fakten des Index es nennen. Keine Texte, Beispiele, Vorgaben, Formate, Werte von Aufzählungen, Erweiterungen, Tags und kein `servers`.
- **Form:** eigene Schlüssel `format`, `notice`, `source`, `operations` und `schemas`, kein `openapi` und kein `paths`. Die Prüfung gegen Rohquellen bleibt, wie sie ist.
- **Lizenz:** Der Auszug ist bearbeitetes Material aus dem Dokument unter CC BY 4.0 und steht wie die Fakten unter CC BY 4.0, nicht unter der Elastic License 2.0. Er nennt das selbst in `notice`, und `NOTICE` nennt ihn. ADR 0027 bleibt: Das Dokument als Ganzes und jede andere Rohquelle kommen nie ins Repository.
- **Wer ihn schreibt:** `pnpm docs:refresh` mit den Fakten aus demselben Dokument, und `pnpm docs:refresh --nur-vertrag` allein aus der State-Datei von `00-inventory`, ohne Token und ohne Netz, ohne die Fakten anzufassen. `source` nennt das Dokument mit Zeit, SHA-256 und Versionen. Auszug und Fakten dürfen aus verschiedenen Dokumenten stammen, jeder nennt seine Quelle. Bevor etwas geschrieben wird, muss der Abgleich über den Auszug genau dasselbe ergeben wie über das ganze Dokument, und der Leser des Abgleichs muss den Text nehmen. Sonst schreibt der Refresh nichts.
- **Abgleich in CI:** `pnpm check:contract` führt `scripts/contract/check.mts --auszug` aus, als Schritt von `pnpm check` und damit von `pnpm ci:check` in den Jobs `check`, `compat` und `minimum`. Er vergleicht den Client mit dem Auszug und die Abweichungen mit `scripts/contract/accepted-deviations.json`: je Eintrag Operation, Feld, Art und ein Grund mit Beleg. Er endet mit 0, wenn die Abweichungen genau die Liste sind, mit 1 bei einer neuen und bei einer, die nicht mehr auftritt, mit 2 bei einer beschädigten Datei und mit 3, wenn die Sicherung der Ausgabe etwas zurückhält. Er gibt nur Zahlen und die abweichenden Einträge aus.
- **Teil `katalog`:** läuft in CI nicht über den Auszug. Der Katalog der Escape Hatch entsteht aus den Fakten, und ein Test hält ihn schon in CI gleich dem, was `pnpm docs:refresh` aus `operations.json` macht.
- **Lauf gegen eine Instanz:** bleibt wie bisher. Nur er findet eine Änderung am API von ChurchTools. Er gehört vor jede Erneuerung des Auszugs und zu jeder neuen Version von ChurchTools an der Testinstanz.

## Konsequenzen

- CI findet eine Änderung am Client, die vom dokumentierten API abweicht, im selben Pull Request. Eine Änderung an ChurchTools zeigt sich erst mit einem neuen Auszug, im Pull Request, der ihn bringt.
- Eine neue Operation des Clients braucht einen neuen Auszug. Ohne ihn meldet der Abgleich sie als nicht dokumentiert, und CI bleibt rot, bis jemand mit Zugang zu einer Instanz `pnpm docs:refresh --nur-vertrag` ausführt.
- Eine Abweichung kommt nur mit Grund und Beleg in die Liste. Fällt sie weg, wird CI rot, bis der Eintrag geht.
- Der Auszug ist an 3.138 rund 207 KiB gross, die Grenze liegt bei 2'000'000 Bytes.
- Restrisiken: Der Auszug zeigt das Dokument einer Instanz zu einem Zeitpunkt; eine andere Instanz oder Version kann abweichen. Was ChurchTools tatsächlich antwortet, zeigen weiter nur die Läufe der Tools gegen die Testinstanz.

## Umsetzung

- `scripts/contract/extract.mts` schreibt und liest den Auszug, `scripts/contract/check.mts` vergleicht in `compareContract` für beide Wege und mit `--auszug` für CI, `scripts/docs/refresh.mts` schreibt ihn mit `contractExtractText`.
- Tests: `tests/scripts/contract-extract.test.mts` und `tests/docs/refresh.test.mts`, jede Prüfung mit einer Gegenprobe.
- Der erste Auszug stammt vom 17.11.2026, von einer Testinstanz mit ChurchTools 3.138.
