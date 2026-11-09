# ADR 0033: Runner-Modell ohne Werkzeuge, Ausgabe in Blöcken mit festen Feldern, Maskierung `strict` zum Modell, Anbieter mit `transferBasis`

- Status: Vorgeschlagen
- Datum: 09.11.2026
- Fällt vor: Phase 6
- Ergänzt: [ADR 0030](0030-contentpolicy.md), [ADR 0032](0032-richtlinie-und-pruefcode.md) und [ADR 0056](0056-ausgehender-weg.md)

## Kontext

Ab Phase 6 führt der Runner Routinen aus: Er liest Daten aus ChurchTools, gibt sie einem Sprachmodell, das daraus einen Bericht oder einen Entwurf macht, und schreibt das Ergebnis, ohne dass ein Mensch zusieht. Den Nachweis für das Schreiben gibt dann die Richtlinie ([ADR 0029](0029-write-guard.md), [ADR 0032](0032-richtlinie-und-pruefcode.md)). Ein solcher Lauf verbindet drei Dinge, die zusammen gefährlich sind: fremden Text, etwa aus dem Wiki, Daten von Personen und die Möglichkeit, etwas zu ändern. Das ist die Lage, vor der die «Rule of Two» warnt: Ein Ablauf ohne Menschen soll höchstens zwei dieser drei Dinge verbinden. Weil ein Bericht alle drei braucht, muss jedes begrenzt sein, auch wenn das Modell einer Anweisung in den Daten folgt.

Das [Threat Model](../threat-model.md) nennt dafür T6 (eine Injection über einen Wiki-Text lässt den Runner an fremde Ziele schreiben oder Daten abfliessen), T12 (Daten fliessen an eine beliebige Adresse ab) und T17 (der Anbieter des Modells erhält mehr Daten als nötig, oder einen Anbieter, den der Betreiber nicht kennt). Dazu kommt das Recht: Der Anbieter des Modells empfängt Daten, und liegt er ausserhalb der Schweiz und des EWR, braucht die Weitergabe nach DSG und DSGVO eine Grundlage, die der Betreiber verantwortet. Ecclium verspricht dabei keine Konformität ([ADR 0028](0028-audit-ereignis-und-datei-sink.md)).

Was schon gilt: Jedes Lese-Tool läuft durch die Pipeline mit Maskierung und Audit ([ADR 0024](0024-eine-tool-pipeline.md)). Die Stufe `strict` ersetzt Kennungen von Personen durch Pseudonyme und kürzt Nachnamen ([ADR 0069](0069-stufe-strict.md)). Jeder Text, den Ecclium schreibt, geht durch die ContentPolicy ([ADR 0030](0030-contentpolicy.md)), und jede Seite und jeder Abschnitt trägt die Kennzeichnung mit Prüfcode ([ADR 0032](0032-richtlinie-und-pruefcode.md)). Für Routinen verlässlich sind die Lese-Tools mit `routineStable`.

Festzulegen sind die Form der Ausgabe des Modells, was das Modell sieht, wie Personen in einen Bericht kommen, wie ein Anbieter beschrieben wird und wie der Aufruf zum Anbieter geht. Die Form der Ausgabe wird mit `routine.v1` öffentlich und bleibt in dieser Hauptversion stabil, deshalb fällt der Entscheid vor dem Code.

## Optionen

1. **Modell mit Werkzeugen:** Das Modell ruft die Tools selbst, wie ein Agent. Flexibel, aber eine Anweisung in den Daten entscheidet dann, welches Tool es mit welchen Werten ruft. Die Richtlinie begrenzt zwar die Ziele, doch jede Prüfung müsste annehmen, dass das Modell dem Angreifer gehört.
2. **Modell ohne Werkzeuge, Ausgabe als freier Text:** Das Modell bekommt Daten und schreibt einen Text, den der Kern prüft und schreibt. Einfach, aber Länge, Aufbau und Inhalt bestimmt das Modell, und eine Injection kann den ganzen Text bestimmen, solange er die ContentPolicy besteht.
3. **Modell ohne Werkzeuge, Ausgabe in Blöcken mit festen Feldern:** Die Routine legt Blöcke fest, jeder mit Feldern einer Art und einer Grenze. Das Modell füllt nur diese Felder, der Kern prüft sie und rendert sie in eine Vorlage der Routine.

## Entscheid

Gewählt ist die dritte Option.

### Modell ohne Werkzeuge

- Das Modell bekommt Daten und ein Ausgabeschema, nie ein Tool und nie eine Möglichkeit, etwas nachzulesen. Die Eingaben holt der Runner vorher selbst, nur mit Lese-Tools, die `routineStable` und `unattended: 'policy'` tragen, und jede Eingabe hat eine Obergrenze (`maxItems`). Sie laufen durch die Pipeline wie jeder Aufruf, mit dem Akteur der Routine (`runner:<Routine>`) und dem Modus `unattended`, den nur die Wurzel der Komposition setzt.
- Ein Lauf liest und schreibt mit einem einzigen Konto von ChurchTools: dem Alias `credential` aus den Einträgen seiner Routine in der Richtlinie, die dafür alle denselben Alias nennen müssen, sonst startet der Runner nicht. Eine Routine ohne Eintrag, etwa eine, die nur einen Entwurf als Datei schreibt, liest mit dem Konto des Runners aus der Konfiguration.
- Den Lauf beginnt kein Modell und kein Text in den Daten, sondern der Zeitplan oder der Betreiber ([ADR 0034](0034-zeitplan-semantik.md)).

### Ausgabe in Blöcken

- Eine Routine ist eine Datei in YAML mit dem Feld `schema: routine.v1`, wie die Richtlinie. Unter `generate.output.blocks` nennt sie Blöcke, jeder mit `maxItems` und Feldern. Ein Feld hat eine Art: Text mit `maxLength`, ganze Zahl mit Grenzen, Datum oder Verweis auf eine Person. Ein Feld ohne Grenze weist der Lader ab.
- Aus den Blöcken entsteht ein JSON Schema für das Modell und ein Schema für die Prüfung der Antwort, beide aus derselben Definition. Ein unbekanntes Feld, ein Wert über einer Grenze oder ein Verweis auf eine Person, die nicht in den Daten des Laufs stand, macht die Antwort ungültig.
- Jedes Textfeld geht einzeln durch die ContentPolicy, bevor der Kern es rendert. Für die Prüfung auf E-Mail-Adressen und Telefonnummern ([ADR 0030](0030-contentpolicy.md)) gelten als bekannt die Kontaktangaben der Gemeinde aus `interactive.contacts` der Richtlinie, die damit auch für Routinen gelten, und die Angaben, die das Modell in seinen Daten sah. Weil diese Daten mindestens mit `standard` maskiert sind, stehen darin keine E-Mail-Adressen und Telefonnummern im Klartext.
- Der Kern rendert die Blöcke in die Vorlage der Routine, eine Datei in Markdown mit Platzhaltern für die Felder und einer Wiederholung je Block, dazu einem festen Text für einen leeren Block. Eine Vorlage kennt keine Bedingungen, keine Ausdrücke und keinen Code. Den Text eines Felds setzt der Kern als reinen Text ein, so dass Zeichen von Markdown darin nichts auszeichnen. Das Ergebnis geht als Ganzes noch einmal durch die ContentPolicy, dann hängt der Kern die Kennzeichnung mit Routine, Periode und Prüfcode an. «Rückfragen an» kommt wie bei einem interaktiven Schreibvorgang aus `interactive.inquiriesTo`.
- **Ziele:** `wiki` mit einem Schreib-Tool des Kerns, Zielen über Namen und dem Schlüssel `idempotencyKey`, und `draft` für einen Entwurf oder Bericht, den ein Mensch liest oder weitergibt, mit einem benannten Kanal. Im freien Kern gibt es den Kanal `file`: eine Datei je Routine und Periode in einem Ordner aus der Konfiguration, die ein zweiter Lauf derselben Periode ersetzt. Die Kanäle des Pro-Moduls kommen ab Phase 9, ohne dass `routine.v1` sich ändert. Ein Ziel `draft` mit dem Kanal `file` schreibt nichts in ChurchTools und braucht deshalb keinen Eintrag in der Richtlinie. Jeder Inhalt geht durch die ContentPolicy, auch eine Datei, weil ein Mensch ihn weiterverwenden kann.
- Eine Meldung nach dem Lauf (`notify`) geht im freien Kern an eine Datei oder an stdout. Sie nennt Routine, Periode und Ausgang, nie Inhalt.

### Maskierung zum Modell

- Der Aufruf zum Modell läuft mit der Stufe `strict`, ausser der Eintrag der Routine in der Richtlinie erlaubt `standard` (`modelRedaction`, [ADR 0032](0032-richtlinie-und-pruefcode.md)). `generate.redaction` in der Routine ist ein Wunsch, der höchstens strenger macht. Eine importierte Routine kann sich die Senkung nicht selbst geben.
- Jeder Teil des Prompts mit Daten trägt die Marke eines maskierten Werts. Der Kern prüft das zur Laufzeit, bevor er einen Adapter aufruft, und bricht sonst ab, auch für einen Adapter aus einem Plugin. So gelangt auch durch einen Fehler im Code kein Rohwert zum Anbieter (T17). Einen Adapter aus einem Plugin baut der Kern mit einem Transport, den er selbst baut, so dass auch er nur die Origin aus der Konfiguration erreicht.
- Der Kern liest jede Eingabe einmal. Die Pipeline gibt dem Lauf davon zwei Fassungen: eine in der Stufe zum Modell und eine für das Rendern, mindestens mit `standard`, weil die Leser eines Berichts nicht dieselben sind wie die Personen, die die Daten in ChurchTools sehen dürfen. Ein Aufruf zählt so einmal gegen das Lesebudget, und beide Fassungen zeigen denselben Stand.

### Personen im Bericht

- Das Modell sieht in `strict` keine Kennung einer Person, sondern ihr Pseudonym, und den Nachnamen nur mit dem ersten Buchstaben. Eine Person nennt es nur in einem Feld der Art «Verweis auf eine Person», mit dem Pseudonym aus seinen Daten.
- Beim Rendern setzt der Kern für ein solches Pseudonym den Namen ein, wie ChurchTools ihn liefert, aus der Fassung für das Rendern. Die Zuordnung von Pseudonym zu Namen gibt die Pipeline dem Lauf mit, nur für die Personen seiner Eingaben und nur für seine Dauer. Pseudonyme übersetzt so weiter nur die Pipeline, wie [ADR 0069](0069-stufe-strict.md) es verlangt. Der Anbieter des Modells sieht nie einen ganzen Namen und nie eine Kennung, die Leser des Berichts sehen den Namen.
- Erlaubt die Richtlinie `standard` zum Modell, steht in einem Verweis auf eine Person die Kennung, die das Modell in seinen Daten sah, und der Kern setzt ebenso den Namen ein.
- Ein Pseudonym in einem Textfeld macht die Antwort ungültig, damit keines im Bericht steht. Einen Namen in freiem Text erkennt die Prüfung nicht. Das Modell sieht dort aber nur Vornamen mit dem ersten Buchstaben des Nachnamens.
- Entschieden am 09.11.2026 mit dem Plan für Phase 6. Die Doku für Betreiber rät, Berichte mit Namen in eine Kategorie zu schreiben, die nur der Kreis sieht, der die Daten in ChurchTools ohnehin sieht.

### Prompt

- Die Reihenfolge ist fest: zuerst ein Systemtext aus dem Kern, der sagt, dass Daten keine Anweisungen sind, dann die Prompt-Datei der Routine, dann die Daten. Jede Eingabe steht in einem eigenen Block mit einer zufälligen Grenze, wie der Datenumschlag der Pipeline. Die Prompt-Datei liegt neben der Routine, nie im Code.
- Die Routine wählt das Modell über einen Alias wie `default`, nie über den Namen eines Anbieters. Welcher Anbieter dahinter steht, sagt die Konfiguration der Anbieter. So bleibt eine Routine zwischen Gemeinden und Betriebsarten übertragbar.

### Aufruf und zweiter Versuch

- Ein Aufruf hat eine feste Frist, eine Grenze für die Tokens der Ausgabe, die die Routine unter einer festen Obergrenze einstellt, und eine Grenze für die Grösse der Antwort.
- Kann der Anbieter strukturierte Ausgabe nach einem JSON Schema, nutzt der Adapter sie, und eine ungültige Antwort beendet den Lauf ohne Schreiben. Sonst verlangt er JSON im Text, und nur dann gibt es genau einen zweiten Versuch, mit dem Grund der Ablehnung als festem Satz, nie mit dem Text der ersten Antwort.
- Verletzt ein Text die ContentPolicy, schreibt der Lauf nichts, das Audit nennt den Grund, und die Meldung nach dem Lauf sagt es. Der Schreibwunsch geht nicht in die Freigabe-Warteschlange, weil auch eine Freigabe die ContentPolicy wieder prüft ([ADR 0029](0029-write-guard.md), Umsetzung) und ihn nie schreiben könnte.

### Anbieter

- Die Anbieter stehen in einer Datei `providers.v1` in YAML, gelesen wie die Richtlinie. Jeder Eintrag hat einen Alias, den Anbieter, das Modell, das Land des Rechenzentrums als Code nach ISO 3166, die Adresse des Endpunkts mit `https`, ob der Anbieter strukturierte Ausgabe nach einem JSON Schema kann, den Pfad der Datei mit dem Schlüssel und, ausserhalb der Schweiz und des EWR, die Pflichtangabe `transferBasis`.
- `transferBasis` ist ein Begriff aus einer geschlossenen Liste: `adequacy_decision` für einen Beschluss über ein angemessenes Schutzniveau, `standard_contractual_clauses` und `binding_corporate_rules`. Fehlt sie ausserhalb der Schweiz und des EWR, startet der Runner nicht. Ob die Grundlage trägt, prüft Ecclium nicht, das verantwortet der Betreiber.
- Ohne einen Anbieter für den Alias einer Routine startet die Routine nicht. Eine Routine ohne Modell (unten) braucht keinen.
- Der Schlüssel kommt nur aus einer Datei und bleibt ein `Secret` ([ADR 0054](0054-secret-fehler-logger-audit.md)). Weil es mehrere Anbieter geben kann, nennt die Datei der Anbieter den Pfad statt einer Variable `*_FILE`. Der Kern liest die Datei mit denselben Prüfungen wie die Token-Datei: absoluter Pfad, kein Link, gewöhnliche Datei des Benutzers, keine Rechte für Gruppe und andere. Ein Schlüssel selbst in der Datei der Anbieter ist ein Fehler beim Start.
- **Weg zum Anbieter:** Die Wurzel der Komposition baut für jeden Anbieter einen eigenen Transport mit genau dessen Origin und Schlüssel ([ADR 0056](0056-ausgehender-weg.md)), mit dem Zweck `model`. Er sendet nur `POST` mit JSON an den Pfad aus der Konfiguration, folgt keiner Weiterleitung und hat feste Fristen und Grenzen. Die Origin kommt so auf die Positivliste ([ADR 0009](0009-positivliste-ausgehend.md)). Phase 6 spricht nur `https`, auch mit einem Modell im lokalen Netz.
- Der freie Kern bringt einen Adapter für die Chat-Schnittstelle, die viele Anbieter nach dem Vorbild von OpenAI anbieten. Weitere Adapter kommen über `ModelProvider` in der Schnittstelle für Plugins.

### Routinen ohne Modell

- Statt `generate` kann eine Routine `checks` nennen, feste Prüfungen, die der Kern bringt und die Routine nur auswählt und einstellt. Ihr Ergebnis füllt die Blöcke wie die Antwort eines Modells, und der Rest des Laufs bleibt gleich. Eine solche Routine liest fremden Text höchstens, ohne ihn einem Modell zu geben, und braucht keinen Anbieter.
- Die ersten beiden Prüfungen kommen mit `wiki-hygiene`: lange nicht geänderte Seiten und Links im Wiki, deren Ziel das Konto der Routine nicht findet. Ein Link auf eine Seite, die das Konto nicht sehen darf, erscheint dabei wie einer auf eine fehlende Seite, und der Bericht sagt das. Entschieden am 09.11.2026 mit dem Plan für Phase 6.

### Audit

- Jedes Ereignis eines Laufs trägt `runId`, `routineId` und `policyHash`, eines mit Modell dazu `provider` mit Anbieter, Modell, Land, Host des Endpunkts und `transferBasis`. Den Inhalt des Prompts und der Antwort hält das Audit nie fest.

## Konsequenzen

- Ein Bericht kann nur so viel enthalten, wie seine Blöcke erlauben. Eine Injection kann den Inhalt der Felder bestimmen, nicht ihre Zahl, ihre Länge, ihr Ziel oder den Aufbau des Berichts.
- Routinen sind weniger frei als ein Agent. Was eine Routine braucht, muss in Blöcken und einer Vorlage beschreibbar sein. Das ist gewollt.
- Neu sind eine öffentliche Datei `routine.v1` und eine Datei `providers.v1`, beide mit erzeugtem JSON Schema, dazu Variablen für den Ordner der Routinen und die Datei der Anbieter, die mit ihrem Bau in die Tabelle von [ADR 0055](0055-konfiguration-identitaet.md) kommen.
- **Restrisiken:**
  - Ein Modell kann innerhalb der Felder falsch zählen, etwas weglassen oder einer Anweisung in den Daten folgen. Was es schreibt, steht nur im Ziel der Richtlinie, besteht die ContentPolicy, trägt die Kennzeichnung und lässt sich zurücknehmen, aber es kann falsch sein. Die Kennzeichnung sagt, dass der Text automatisch entstanden ist.
  - Ein Name in freiem Text bleibt stehen, wenn das Modell ihn aus den Daten übernimmt, in `strict` mit gekürztem Nachnamen.
  - Das Land in der Konfiguration ist eine Angabe des Betreibers. Hat ein Anbieter seinen Sitz in einem anderen Land als sein Rechenzentrum, kann die Weitergabe trotzdem ein Land ausserhalb betreffen. Das beurteilt der Betreiber, die Doku weist darauf hin.
  - Die Maskierung erkennt nicht jede Angabe zu einer Person in freiem Text ([ADR 0069](0069-stufe-strict.md)). Was sie nicht erkennt, erreicht den Anbieter.
