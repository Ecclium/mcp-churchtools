# Routinen

<!-- Erzeugt aus dem Schema im Paket der Workflows. Ändern Sie den Code und rufen Sie pnpm docs:generate auf, nicht diese Datei. -->

Eine Routine beschreibt einen wiederkehrenden Ablauf: wann er läuft, was er in ChurchTools liest, wie ein Sprachmodell oder eine feste Prüfung daraus Blöcke mit festen Feldern füllt, in welche Vorlage die Blöcke kommen und wohin das Ergebnis geht ([ADR 0033](adr/0033-runner-modell-ohne-werkzeuge.md)). Das Modell bekommt nur Daten und die Form der Antwort, nie ein Tool. Ziel und Aktion stehen fest, bevor es etwas sieht, und die Richtlinie entscheidet, ob ein Lauf dorthin schreiben darf ([Richtlinie](policy.md)).

Stand: Der Runner führt Routinen von Hand mit `ecclium run-once` aus und als Daemon mit `ecclium runner` zu ihrer Zeit ([Runner](betrieb/runner.md)). `ecclium policy init --routine` lädt die Routinen, um den Eintrag einer Routine in der Richtlinie vorzuschlagen ([Richtlinie](policy.md)). Der Server liest den Ordner der Routinen nicht.

## Ordner

- `ECCLIUM_ROUTINES_DIR` nennt den absoluten Pfad des Ordners ([Konfiguration](configuration.md)). Darin liegt je Routine eine Datei `<Kennung>.yaml`, höchstens 50. Eine Datei mit der Endung `.yml` oder ein Name, der keine Kennung ist, lässt den Lader abbrechen, damit keine Routine still fehlt. Andere Dateien, etwa ein README, übergeht er.
- Prompts und Vorlagen liegen im Ordner selbst oder in einem Ordner darunter, etwa `prompts/` und `templates/`. Die Routine nennt sie mit einem Pfad wie `prompts/dienstplan-report.md`, in Kleinbuchstaben, ohne `..` und ohne absoluten Pfad. So liest eine Routine keine Datei ausserhalb des Ordners.
- Ordner und Dateien müssen dem Benutzer gehören, unter dem Ecclium läuft, und Gruppe und andere Benutzer dürfen sie nicht ändern, etwa mit den Rechten 755 und 644. Ecclium folgt keinem Link.
- Eine Routine hat höchstens 65'536 Bytes, ein Prompt und eine Vorlage je höchstens 32'768 Bytes, alle in UTF-8 ohne BOM. Die Routine ist YAML 1.2 oder JSON mit denselben Regeln wie die Richtlinie: keine Anker und Verweise, keine Tags, keine Direktiven, kein zweites Dokument, keine doppelten Schlüssel.
- Über die Felder hinaus weist der Lader zurück: einen Prompt mit Steuerzeichen ausser Tabulator und Zeilenende, zwei Eingaben mit einem Namen, eine Prüfung oder einen Kanal der Meldung zweimal, ein `forEach` ohne Parameter `{ field }`, eine Zahl mit `min` über `max`, einen Schlüssel einer anderen Routine und einen Kanal, den Ecclium nicht kennt.
- Ist etwas falsch, hält der Lader beim ersten Problem an. Die Meldung nennt die Routine und den Pfad des Felds, etwa `inputs[1].forEach`, oder die Zeile, nie einen Wert.
- Editoren prüfen und vervollständigen eine Routine mit dem Schema [`schemas/routine.v1.json`](../schemas/routine.v1.json).
- Routinen, die Ecclium mitbringt, liegen mit ihren Prompts, Vorlagen und einer Anleitung zum Anpassen unter [`routines/`](../routines/README.md). Kopieren Sie sie mit Prompt und Vorlage in den Ordner aus `ECCLIUM_ROUTINES_DIR`.

## Beispiel

Gekürzt aus der mitgelieferten Routine `dienstplan-report` unter [`routines/`](../routines/README.md). Kategorie und Seite sind Platzhalter.

```yaml
# Wöchentlicher Bericht über die Dienste der kommenden zwei Wochen.
schema: routine.v1
id: dienstplan-report
schedule: '0 6 * * MON'
inputs:
  - name: termine
    tool: ct_events_list
    params: { from: '+0d', to: '+14d' }
    maxItems: 40
  - name: einteilungen
    tool: ct_services_get_assignments
    forEach: termine
    params:
      eventId: { field: id }
    maxItems: 200
generate:
  prompt: prompts/dienstplan-report.md
  model: default
  output:
    blocks:
      unbesetzt:
        maxItems: 30
        fields:
          datum: { type: date }
          dienst: { type: text, maxLength: 80 }
      mehrfach:
        maxItems: 30
        fields:
          person: { type: person }
          anzahl: { type: integer, min: 2, max: 50 }
template: templates/dienstplan-report.md
output:
  target: wiki
  tool: ct_wiki_page_append_section
  scope: { category: Berichte, page: Dienstplan-Auswertung }
  idempotencyKey: 'dienstplan-report:{isoWeek}'
notify:
  - channel: stdout
```

## Felder

| Feld | Form | Pflicht | Bedeutung |
| --- | --- | --- | --- |
| `schema` | `routine.v1` | ja | Format der Datei, immer `routine.v1`. Ohne diese Angabe oder mit einer anderen nimmt Ecclium die Routine nicht an. |
| `id` | Text nach festem Muster, höchstens 63 Zeichen | ja | Kennung der Routine, gleich dem Namen ihrer Datei ohne `.yaml`, etwa `dienstplan-report`. Unter dieser Kennung nennt die Richtlinie die Routine. |
| `schedule` | Text nach festem Muster, höchstens 100 Zeichen | ja | Zeitplan mit fünf Feldern, siehe «Zeitplan». Die Zeitzone kommt aus `ECCLIUM_TIME_ZONE`. |
| `inputs` | Liste mit 1 bis 10 Einträgen | nein | Was ein Lauf liest, bevor das Modell etwas sieht. Pflicht mit `generate`, mit `checks` nicht erlaubt, siehe «Eingaben». |
| `inputs[].name` | Text nach festem Muster, höchstens 32 Zeichen | ja | Name der Eingabe, unter dem das Modell ihre Daten sieht und eine spätere Eingabe sie mit `forEach` nennt. |
| `inputs[].tool` | Text nach festem Muster, höchstens 63 Zeichen | ja | Das Lese-Tool, etwa `ct_events_list`. Nur Lese-Tools, auf die sich Routinen verlassen können, siehe «Eingaben». |
| `inputs[].forEach` | Text nach festem Muster, höchstens 32 Zeichen | nein | Name einer früheren Eingabe: Das Tool läuft dann einmal je Eintrag dieser Eingabe. |
| `inputs[].params` | Zuordnung mit 0 bis 10 Einträgen | nein | Die Parameter des Tools mit ihrem Namen aus dem Tool, etwa `from`. |
| `inputs[].params.<Parameter>` | Text, ganze Zahl, Wahrheitswert oder Verweis auf ein Feld | nein | Ein Text, eine Zahl oder ein Wahrheitswert. Ein Text wie `+14d` oder `-30d` zählt Tage ab der geplanten Auslösung. Mit `forEach` setzt `{ field: id }` das Feld `id` des jeweiligen Eintrags ein. |
| `inputs[].params.<Parameter>.field` | Text nach festem Muster, höchstens 32 Zeichen | nein | Das Feld eines Eintrags der Eingabe aus `forEach`. |
| `inputs[].maxItems` | ganze Zahl von 1 bis 200 | ja | Wie viele Einträge die Eingabe höchstens liefert, über alle ihre Aufrufe zusammen. |
| `generate` | Objekt | nein | Der Schritt mit einem Sprachmodell. Eine Routine hat ihn oder `checks`, nicht beides. |
| `generate.prompt` | Text nach festem Muster, höchstens 130 Zeichen | ja | Pfad der Prompt-Datei in Markdown, im Ordner der Routinen oder einem Ordner darunter, etwa `prompts/dienstplan-report.md`. |
| `generate.model` | Text nach festem Muster, höchstens 63 Zeichen | ja | Das Modell als Name aus der Konfiguration der Anbieter, etwa `default`, nie der Name eines Anbieters. |
| `generate.redaction` | `strict` oder `standard` | nein | Wunsch für die Maskierung der Daten zum Modell, `strict` oder `standard`. Die Richtlinie entscheidet, und der Wunsch macht höchstens strenger. Voreingestellt ist `strict`. |
| `generate.maxOutputTokens` | ganze Zahl von 100 bis 8'000 | nein | Wie viele Tokens die Antwort des Modells höchstens hat, voreingestellt 2'000. |
| `generate.output` | Objekt | ja | Die Form der Antwort des Modells. |
| `generate.output.blocks` | Zuordnung mit 1 bis 10 Einträgen | ja | Die Blöcke der Antwort mit dem Namen, unter dem die Vorlage sie wiederholt. |
| `generate.output.blocks.<Block>` | Objekt | nein | Ein Block der Antwort. |
| `generate.output.blocks.<Block>.maxItems` | ganze Zahl von 1 bis 100 | ja | Wie viele Einträge der Block höchstens hat. |
| `generate.output.blocks.<Block>.fields` | Zuordnung mit 1 bis 8 Einträgen | ja | Die Felder jedes Eintrags mit dem Namen, unter dem die Vorlage sie zeigt. |
| `generate.output.blocks.<Block>.fields.<Feld>` | Objekt einer Art | nein | Ein Feld, siehe «Arten von Feldern». |
| `generate.output.blocks.<Block>.fields.<Feld>.type` | `text`, `integer`, `date` oder `person` | ja | Art des Felds. |
| `generate.output.blocks.<Block>.fields.<Feld>.maxLength` | ganze Zahl von 1 bis 1'000 | nein | Nur bei `text`: wie viele Zeichen der Text höchstens hat. |
| `generate.output.blocks.<Block>.fields.<Feld>.min` | ganze Zahl von -1'000'000'000 bis 1'000'000'000 | nein | Nur bei `integer`: die kleinste erlaubte Zahl. |
| `generate.output.blocks.<Block>.fields.<Feld>.max` | ganze Zahl von -1'000'000'000 bis 1'000'000'000 | nein | Nur bei `integer`: die grösste erlaubte Zahl. |
| `checks` | Liste mit 1 bis 2 Einträgen | nein | Feste Prüfungen des Kerns statt eines Modells, siehe «Prüfungen des Kerns». |
| `checks[].check` | `stalePages` oder `brokenLinks` | ja | Name der Prüfung. |
| `checks[].olderThanDays` | ganze Zahl von 30 bis 3'650 | nein | Nur bei `stalePages`: nach wie vielen Tagen ohne Änderung eine Seite zählt. |
| `checks[].maxItems` | ganze Zahl von 1 bis 100 | ja | Wie viele Einträge der Block der Prüfung höchstens hat. |
| `template` | Text nach festem Muster, höchstens 130 Zeichen | ja | Pfad der Vorlage in Markdown, im Ordner der Routinen oder einem Ordner darunter, siehe «Vorlage». |
| `output` | Objekt einer Art | ja | Wohin das Ergebnis eines Laufs geht, siehe «Ziele». |
| `output.target` | `wiki` oder `draft` | ja | Art des Ziels, siehe «Ziele». |
| `output.tool` | `ct_wiki_page_append_section` | nein | Nur bei `wiki`: das Schreib-Tool. Heute nur `ct_wiki_page_append_section`, das einen eigenen Abschnitt je Periode anhängt. |
| `output.scope` | Objekt | nein | Nur bei `wiki`: die Seite über ihre Namen. Die Richtlinie bindet sie an Kennungen. |
| `output.scope.category` | Text von 1 bis 255 Zeichen ohne Steuerzeichen | ja | Name der Kategorie des Wikis. |
| `output.scope.page` | Text von 1 bis 255 Zeichen ohne Steuerzeichen | ja | Titel der Seite. |
| `output.idempotencyKey` | Text nach festem Muster, höchstens 80 Zeichen | ja | Kennung der Routine, ein Doppelpunkt und genau einer der Platzhalter `{isoWeek}`, `{date}` oder `{month}`, etwa `dienstplan-report:{isoWeek}`. Er legt die Periode fest, siehe «Ziele». |
| `output.channel` | Text nach festem Muster, höchstens 63 Zeichen | nein | Nur bei `draft`: der Kanal. Im freien Kern `file`. |
| `notify` | Liste mit 1 bis 2 Einträgen | nein | Meldungen nach einem Lauf, ohne Inhalt. |
| `notify[].channel` | Text nach festem Muster, höchstens 63 Zeichen | ja | Der Kanal der Meldung. Im freien Kern `file` oder `stdout`. |

«Pflicht» heisst: in jeder Routine, die den Teil darüber hat. Ein Feld, das nur eine Art von Ziel oder Prüfung kennt, etwa `output.scope` für `wiki` oder `checks[].olderThanDays` für `stalePages`, steht mit «nein» und ist für diese Art Pflicht.

Namen von Eingaben, Blöcken und Feldern bestehen aus Kleinbuchstaben, Ziffern und `_` und beginnen mit einem Buchstaben. Der Name `period` gehört der Vorlage.

## Eingaben

- Eine Eingabe ruft ein Lese-Tool über dieselbe Pipeline wie der Server, mit Maskierung und Protokoll. Erlaubt sind nur Lese-Tools, auf die sich Routinen verlassen können und die unbeaufsichtigt laufen dürfen. Das prüft die Vorbereitung eines Laufs, bevor er etwas liest, ebenso die Parameter gegen das Tool, die Felder von `{ field }` und relative Tage bis 366 Tage.
- Mit `forEach` läuft das Tool einmal je Eintrag einer früheren Eingabe, die selbst kein `forEach` hat. Die Zahl der Aufrufe ist so höchstens `maxItems` der früheren Eingabe, dazu die Folgeseiten, bis `maxItems` erreicht ist. Tools, die Namen anderer Personen nennen, zählen gegen das Lesebudget ([Richtlinie](policy.md)): Im Beispiel liest ein Lauf mit 40 Terminen die Einteilungen mit mindestens 40 Aufrufen, einem je 25 Plätze eines Termins.
- Relative Tage wie `+0d` oder `+14d` zählen ab der geplanten Auslösung, nicht ab dem Beginn des Laufs. Ein verspäteter Lauf liest so denselben Zeitraum wie ein pünktlicher.

## Arten von Feldern

Jedes Feld ist begrenzt: Text mit `maxLength`, eine Zahl mit `min` und `max`, Datum und Verweis auf eine Person durch ihre feste Form. Einen Text ohne `maxLength` und eine Zahl ohne `min` oder `max` nimmt der Lader nicht an. Eine Antwort des Modells mit einem unbekannten Feld, einem Wert über einer Grenze oder einem Verweis auf eine Person, die nicht in den Daten stand, ist ungültig.

| Art | Grenze | Inhalt |
| --- | --- | --- |
| `text` | `maxLength` | Klartext. Der Kern setzt ihn als reinen Text ein, Zeichen von Markdown zeichnen darin nichts aus, und jedes Feld geht durch die ContentPolicy. |
| `integer` | `min` und `max` | Eine ganze Zahl in diesen Grenzen. |
| `date` | feste Form | Ein Datum wie `2026-11-09`. |
| `person` | feste Form | Verweis auf eine Person aus den Daten des Laufs. Das Modell sieht in `strict` ihr Pseudonym, in `standard` ihre Kennung, im Bericht steht ihr Name, wie ChurchTools ihn liefert. |

## Prüfungen des Kerns

Eine Routine mit `checks` hat kein Modell und keine Eingaben. Jede Prüfung füllt einen Block mit ihrem Namen und festen Feldern, den die Vorlage wie einen Block des Modells wiederholt. Die Prüfungen selbst kommen mit einer späteren Version.

| Prüfung | Was sie findet | Felder |
| --- | --- | --- |
| `stalePages` | Seiten des Wikis, die seit `olderThanDays` Tagen niemand geändert hat. | `page` (`text`), `category` (`text`), `changed` (`date`) |
| `brokenLinks` | Links im Wiki auf Seiten, die das Konto der Routine nicht findet. Ein Link auf eine Seite, die das Konto nicht sehen darf, erscheint wie einer auf eine fehlende Seite. | `page` (`text`), `link` (`text`) |

## Zeitplan

- Fünf Felder mit einem Leerzeichen dazwischen: Minute (0 bis 59), Stunde (0 bis 23), Tag des Monats (1 bis 31), Monat (1 bis 12 oder `JAN` bis `DEC`) und Wochentag (0 für Sonntag bis 6 oder `SUN` bis `SAT`). Kein Feld für Sekunden oder Jahre ([ADR 0034](adr/0034-zeitplan-semantik.md)).
- Ein Feld enthält `*`, einen Wert, einen Bereich wie `MON-FRI`, einen Schritt wie `*/2` oder `8-18/2` oder eine Liste davon mit Kommas. Einen Wert mit Schritt wie `5/15`, `L`, `W`, `#`, `?` und die 7 für Sonntag nimmt Ecclium nicht an, weil Nachbauten von cron sie verschieden lesen.
- Die Minute ist ein einzelner Wert wie `0` oder `30`, eine Routine löst also höchstens einmal je Stunde aus. Jede Auslösung kann ein Modell aufrufen und belegt Platz im Gedächtnis der Läufe.
- Tag des Monats und Wochentag dürfen nicht beide eingeschränkt sein: cron verbindet die beiden mit «oder», manche Nachbauten mit «und».
- Der Zeitplan muss an einem Tag auslösen, den es gibt. `0 6 31 2 *`, der 31. Februar, weist der Lader ab, `0 6 29 2 *` löst in jedem Schaltjahr aus.
- Der Zeitplan gilt in der Zeitzone aus `ECCLIUM_TIME_ZONE` ([Konfiguration](configuration.md)). Der Runner verlangt die Variable.
- Eine Zeit, die es beim Wechsel zur Sommerzeit nicht gibt, läuft zur ersten Zeit danach, die es gibt. Eine Zeit, die es beim Wechsel zur Winterzeit zweimal gibt, läuft einmal, beim ersten Mal. Wählen Sie trotzdem eine Zeit ausserhalb der Stunde von 02:00 bis 03:00, in der in Mitteleuropa die Sommerzeit wechselt.
- Fällig ist die letzte geplante Auslösung bis jetzt, höchstens 31 Tage zurück, solange kein Lauf sie abgeschlossen hat. Ältere verpasste Auslösungen holt der Runner nicht nach. Scheitert ein Lauf an einer vorübergehenden Störung, etwa weil das Modell oder ChurchTools nicht erreichbar ist, versucht der Runner dieselbe Auslösung höchstens dreimal, jeden Versuch mindestens 15 Minuten nach dem vorigen.

## Vorlage

Die Vorlage ist Markdown mit vier Marken und sonst nichts: keine Bedingungen, keine Ausdrücke, kein Code.

- `{{#block}}` und `{{/block}}` wiederholen die Zeilen dazwischen für jeden Eintrag des Blocks, `{{feld}}` darin steht für ein Feld des Eintrags.
- `{{^block}}` und `{{/block}}` zeigen die Zeilen dazwischen nur, wenn der Block leer ist.
- `{{period}}` steht für die Periode des Laufs, etwa `2026-W46`, überall.
- Eine Marke eines Blocks steht allein auf ihrer Zeile, die beim Rendern wegfällt. Blöcke stehen nicht ineinander. Jeder Block muss einmal wiederholt werden, damit nichts verloren geht, was der Lauf füllt. Jedes andere `{{` weist der Lader ab.
- Das Ergebnis geht als Ganzes noch einmal durch die ContentPolicy, dann hängt der Kern die Kennzeichnung mit Routine, Periode und Prüfcode an.

```markdown
### Dienstplan {{period}}

#### Unbesetzte Dienste
{{#unbesetzt}}
- {{datum}}: {{dienst}}
{{/unbesetzt}}
{{^unbesetzt}}
Alle Dienste sind besetzt.
{{/unbesetzt}}

#### Mehrfach eingeteilt
{{#mehrfach}}
- {{person}}: {{anzahl}} Einteilungen
{{/mehrfach}}
```

## Ziele

- `wiki` hängt mit `ct_wiki_page_append_section` einen eigenen Abschnitt je Periode an die Seite in `scope` an. Ein zweiter Lauf derselben Periode ändert diesen Abschnitt oder lässt ihn stehen, er verdoppelt ihn nie. Die Seite braucht einen Eintrag im Teil `unattended` der Richtlinie, sonst startet die Routine nicht. Ecclium sucht die Seite selbst, legt nie eine an und schreibt nicht, wenn es sie nicht gibt oder ihr Titel in der Kategorie zweimal vorkommt.
- Ein Lauf mit Ziel `wiki` liest und schreibt mit dem Konto, das die Einträge seiner Routine als `credential` nennen: mit dem Token aus der Datei `ct_token_<credential>` im Ordner aus `ECCLIUM_RUNNER_TOKENS_DIR` ([Konfiguration](configuration.md)), bei jedem Lauf neu gelesen. Ist `ECCLIUM_RUNNER_TOKENS_DIR` nicht gesetzt, fehlt die Datei oder weist Ecclium sie ab, läuft die Routine nicht, auch nicht mit dem Token des Servers.
- Eine leere Datei `writes-off-routine-<Kennung>` im Ordner `stop` des Zustandsordners hält das Schreiben der Läufe einer Routine und die Freigabe dessen, was sie in die Warteschlange legten, an, ohne Neustart. Was die Richtlinie nicht abdeckt, legt der Lauf in die Freigabe-Warteschlange ([Richtlinie](policy.md)).
- `draft` gibt einen Entwurf oder Bericht an einen Kanal. Der Kanal `file` schreibt eine Datei je Routine und Periode, die ein zweiter Lauf derselben Periode ersetzt, und schreibt nichts in ChurchTools.
- Die Periode kommt aus der geplanten Auslösung in der Zeitzone aus `ECCLIUM_TIME_ZONE`, nie aus der Zeit des Laufs: `{isoWeek}` wie `2026-W46`, `{date}` wie `2026-11-09`, `{month}` wie `2026-11`.
- Eine Meldung nach dem Lauf nennt Routine, Periode und Ausgang, nie Inhalt.
