# Anbieter von Sprachmodellen

<!-- Erzeugt aus dem Schema im Kern. Ändern Sie den Code und rufen Sie pnpm docs:generate auf, nicht diese Datei. -->

Eine Routine mit einem Erzeugungsschritt braucht ein Sprachmodell. Sie nennt es nur über einen Alias wie `default`, nie über einen Anbieter. Welcher Anbieter, welches Modell und welches Land dahinter stehen, sagt die Datei der Anbieter, damit Sie nie raten müssen, wohin Daten der Gemeinde gehen ([ADR 0033](adr/0033-runner-modell-ohne-werkzeuge.md)). Das Modell bekommt Daten und ein Ausgabeschema, nie ein Werkzeug.

Stand: Der Start liest und prüft die Datei, `ecclium config check` zeigt die Anbieter. Benutzt wird sie erst vom Runner einer späteren Version.

## Datei

- `ECCLIUM_PROVIDERS_FILE` nennt den absoluten Pfad der Datei ([Konfiguration](configuration.md)). Die Datei ist kein Geheimnis und darf lesbar sein. Sie muss dem Benutzer gehören, unter dem Ecclium läuft, und Gruppe und andere Benutzer dürfen sie nicht ändern, etwa mit den Rechten 644. Ecclium folgt keinem Link.
- Das Format ist YAML 1.2 oder JSON in UTF-8 ohne BOM, höchstens 65'536 Bytes, mit höchstens 10 Anbietern. Anker und Verweise, Tags, Direktiven, ein zweites Dokument und doppelte Schlüssel nimmt Ecclium nicht an.
- Ist etwas falsch, startet Ecclium nicht und endet mit dem Code 78. Die Meldung nennt den Pfad des Felds, etwa `providers[1].transferBasis`, oder die Zeile, nie einen Wert.
- Ein Feld, das wie ein Schlüssel heisst, etwa `apiKey`, `token` oder `secret`, verhindert den Start mit einer eigenen Meldung: Der Schlüssel gehört in seine eigene Datei.
- Sind `LOG_TOKENS` oder `LOG_STREAM` gesetzt, liest Ecclium die Datei nicht und startet nicht, weil die Bibliothek für YAML sie sonst nach stdout schriebe.
- `ecclium config check` zeigt je Alias Anbieter, Modell, Land und Grundlage, mit `--show-values` auch den Host des Endpunkts, nie den Pfad eines Schlüssels.
- Editoren prüfen und vervollständigen die Datei mit dem Schema [`schemas/providers.v1.json`](../schemas/providers.v1.json).

## Beispiel

Anbieter, Modelle, Adressen und Pfade sind Platzhalter.

```yaml
# Anbieter von Sprachmodellen, geprüft beim Start von Ecclium.
schema: providers.v1
providers:
  - alias: default
    vendor: example
    model: example-maker/example-model-1
    hostingCountry: CH
    endpoint: https://model.example.org/v1/chat/completions
    structuredOutput: true
    apiKeyFile: /run/secrets/model_api_key
  - alias: extern
    vendor: example
    model: example-model-2
    hostingCountry: US
    endpoint: https://model.example.com/v1/chat/completions
    structuredOutput: false
    apiKeyFile: /run/secrets/model_api_key_extern
    transferBasis: standard_contractual_clauses
```

## Felder

| Feld | Form | Pflicht | Bedeutung |
| --- | --- | --- | --- |
| `schema` | `providers.v1` | ja | Format der Datei, immer `providers.v1`. Ohne diese Angabe oder mit einer anderen startet Ecclium nicht. |
| `providers` | Liste mit 1 bis 10 Einträgen | ja | Die Anbieter, je einer für jeden Alias. |
| `providers[].alias` | Text nach festem Muster, höchstens 63 Zeichen | ja | Der Name, mit dem eine Routine das Modell in `generate.model` wählt, etwa `default`. Kleinbuchstaben, Ziffern und Bindestriche wie die Kennung einer Routine. Jeder Alias nur einmal. |
| `providers[].vendor` | Text nach festem Muster, höchstens 32 Zeichen | ja | Der Anbieter in Kleinbuchstaben, Ziffern und Bindestrichen, etwa `example`. Er steht in jedem Ereignis eines Laufs im Audit. |
| `providers[].model` | Text nach festem Muster, höchstens 64 Zeichen | ja | Das Modell, wie der Anbieter es nennt, mit Buchstaben, Ziffern, `.`, `_`, `:` und `-` und höchstens einem `/` zwischen Hersteller und Modell, etwa `example-maker/example-model-1`. Ecclium schickt es dem Anbieter im Feld `model`. |
| `providers[].hostingCountry` | Text nach festem Muster, höchstens 2 Zeichen | ja | Das Land des Rechenzentrums als Code nach ISO 3166-1 aus zwei Grossbuchstaben, etwa `CH` oder `DE`. Es entscheidet, ob es eine Grundlage der Übermittlung braucht, siehe unten. |
| `providers[].endpoint` | Text nach festem Muster, höchstens 600 Zeichen | ja | Die Adresse der Chat-Schnittstelle mit `https` und Pfad, etwa `https://model.example.org/v1/chat/completions`, in ihrer eindeutigen Form: Host in Kleinbuchstaben, keine IP-Adresse und kein `localhost`, kein Standardport, keine Query, kein Fragment und keine Zeichen mit `%`. Ecclium sendet nur an genau diese Adresse. |
| `providers[].structuredOutput` | `true` oder `false` | ja | Ob der Anbieter die Antwort nach einem JSON Schema strukturiert (`response_format` vom Typ `json_schema`). Mit `false` bittet Ecclium im Text um JSON und versucht es nach einer ungültigen Antwort genau einmal mehr. |
| `providers[].apiKeyFile` | Text von 1 bis 4'096 Zeichen | ja | Absoluter Pfad der Datei mit dem Schlüssel. Ecclium prüft sie wie die Token-Datei von ChurchTools: kein Link, eine gewöhnliche Datei Ihres Benutzers, keine Rechte für Gruppe und andere, etwa mit den Rechten 600, nur sichtbare ASCII-Zeichen. Der Schlüssel selbst steht nie in dieser Datei. |
| `providers[].transferBasis` | `adequacy_decision` oder `standard_contractual_clauses` oder `binding_corporate_rules` | nein | Die Grundlage der Übermittlung, Pflicht ausserhalb der Schweiz und des EWR und dort verboten, siehe unten. |

## Land und Grundlage der Übermittlung

In der Schweiz und im EWR braucht ein Anbieter keine Grundlage, und `transferBasis` darf nicht stehen, damit Land und Grundlage nie Verschiedenes sagen. Als Schweiz und EWR gelten genau diese 31 Codes: `AT`, `BE`, `BG`, `CH`, `CY`, `CZ`, `DE`, `DK`, `EE`, `ES`, `FI`, `FR`, `GR`, `HR`, `HU`, `IE`, `IS`, `IT`, `LI`, `LT`, `LU`, `LV`, `MT`, `NL`, `NO`, `PL`, `PT`, `RO`, `SE`, `SI`, `SK`. Jeder andere Code gilt als ausserhalb, auch `EU` und ein Gebiet mit eigenem Code wie die Färöer (`FO`).

Ausserhalb verlangt Ecclium eine dieser Grundlagen, sonst startet es nicht:

| Grundlage | Bedeutung |
| --- | --- |
| `adequacy_decision` | Ein Beschluss, dass das Land ein angemessenes Schutzniveau hat, nach DSG durch den Bundesrat, nach DSGVO durch die Europäische Kommission. |
| `standard_contractual_clauses` | Standardvertragsklauseln, die Sie mit dem Anbieter vereinbart haben. |
| `binding_corporate_rules` | Verbindliche Unternehmensregeln des Anbieters, die eine Behörde genehmigt hat. |

Ob die Grundlage trägt, prüft Ecclium nicht, das verantworten Sie. Massgebend ist das Land, in dem die Daten verarbeitet werden. Hat ein Anbieter seinen Sitz in einem anderen Land als sein Rechenzentrum, kann die Weitergabe trotzdem ein Land ausserhalb betreffen, das beurteilen Sie. Diese Seite ist keine Rechtsberatung.

## Weg zum Anbieter

- Für jeden Anbieter baut Ecclium einen eigenen ausgehenden Weg mit genau der Adresse aus `endpoint`. Er sendet nur `POST` mit JSON an diesen Pfad, mit dem Schlüssel im Header `Authorization` nach dem Schema `Bearer`, und folgt keiner Weiterleitung.
- Ein Aufruf endet nach höchstens fünf Minuten, weil ein Modell ohne Streaming erst antwortet, wenn es fertig ist. Eine Anfrage hat höchstens 2 MiB, eine Antwort höchstens 1 MiB.
- Ecclium spricht nur `https`, auch mit einem Modell im eigenen Netz.
- Die Daten einer Routine sind maskiert, bevor ein Anbieter sie sieht, voreingestellt in der Stufe `strict`. Ohne die Marke der Maskierung bricht der Aufruf ab, bevor der Anbieter etwas bekommt, auch bei einem Anbieter aus einem Plugin.

## Chat-Schnittstelle

Ecclium bringt einen Adapter für die Chat-Schnittstelle, die viele Anbieter nach dem Vorbild von OpenAI anbieten. Er sendet `model`, eine Nachricht der Rolle `system` und eine der Rolle `user` und `max_tokens`.

- Mit `structuredOutput: true` sendet er das Ausgabeschema als `response_format` vom Typ `json_schema`. Passt die Antwort nicht dazu, endet der Aufruf ohne zweiten Versuch.
- Mit `structuredOutput: false` bittet er im Systemtext um genau ein JSON-Objekt nach dem Schema. Ist die Antwort kein JSON, passt nicht zum Schema oder ist abgeschnitten, versucht er es genau einmal mehr, mit einem festen Satz zum Grund und nie mit dem Text der ersten Antwort.
- Eine Weigerung des Modells oder ein anderer Grund, warum es aufhörte, beendet den Aufruf. Kein Text des Anbieters erscheint in einer Meldung oder im Log.
- Ob ein Anbieter `json_schema` und `max_tokens` so annimmt, zeigt erst ein Lauf mit ihm. Lehnt er die Anfrage mit 400, 404 oder 422 ab, meldet Ecclium einen Fehler der Konfiguration.
