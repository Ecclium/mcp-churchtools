# Mitgelieferte Routinen

Dieser Ordner enthält die Routinen, die Ecclium mitbringt, mit ihren Prompts unter `prompts/` und ihren Vorlagen unter `templates/`. Jede Routine ist eine Vorlage für Ihre Gemeinde: Kopieren Sie den Inhalt dieses Ordners oder einzelne Routinen mit Prompt und Vorlage in den Ordner aus `ECCLIUM_ROUTINES_DIR` und passen Sie an, was unten steht. Der Lader liest nur Routinen, die direkt im Ordner aus `ECCLIUM_ROUTINES_DIR` liegen, nicht in einem Ordner darunter. Wie eine Routine aufgebaut ist und was jedes Feld bedeutet, steht unter [Routinen](../docs/routines.md), wie der Runner sie ausführt, unter [Runner](../docs/betrieb/runner.md).

Ordner und Dateien müssen dem Benutzer gehören, unter dem Ecclium läuft, und dürfen für Gruppe und andere nicht beschreibbar sein, etwa mit den Rechten 755 und 644. Ein Checkout gibt Dateien oft andere Rechte, prüfen Sie sie nach dem Kopieren.

Probieren Sie eine Routine zuerst mit `ecclium run-once <Routine> --preview` aus. Die Vorschau zeigt den Abschnitt, ohne zu schreiben, auch bevor die Richtlinie einen Eintrag für die Routine hat. Eine Routine mit Modell fragt dafür schon das Modell und braucht in der Stufe `strict` wie jeder ihrer Läufe die Schlüsseldatei der Pseudonyme ([Runner](../docs/betrieb/runner.md)). `wiki-hygiene` hat kein Modell und braucht weder die Datei der Anbieter noch diesen Schlüssel.

## dienstplan-report

Die Routine schreibt jeden Montag um 06:00 einen Bericht über die Dienste der kommenden zwei Wochen, als eigenen Abschnitt je Woche auf einer Seite des Wikis: welche Plätze unbesetzt sind, welche Anfragen noch auf eine Zusage warten, wer mehrfach eingeteilt ist und kurze Hinweise. Ein zweiter Lauf in derselben Woche ändert den Abschnitt dieser Woche, er hängt keinen zweiten an.

Was Sie anpassen:

- **Seite:** `output.scope` nennt die Kategorie «Berichte» und die Seite «Dienstplan-Auswertung». Legen Sie Kategorie und Seite in ChurchTools an oder nennen Sie eine bestehende Seite. Ecclium legt keine Seite an.
- **Wer den Bericht liest:** Der Bericht nennt Personen mit ihrem Namen, wie ChurchTools ihn liefert. Wählen Sie eine Kategorie, die nur das Team der Dienstplanung sieht. Der Anbieter des Modells sieht statt der Kennung einer Person ein Pseudonym und von ihrem Namen nur den Vornamen und den ersten Buchstaben des Nachnamens (Stufe `strict`). Den vollen Namen setzt der Kern erst beim Schreiben ein.
- **Zeit:** `schedule` gilt in der Zeitzone aus `ECCLIUM_TIME_ZONE`. Die Zeiten in den Daten stehen in UTC, der Prompt bittet das Modell, jedes Datum in mitteleuropäischer Zeit zu nennen. Liegt Ihre Gemeinde in einer anderen Zone, passen Sie diesen Satz im Prompt an.
- **Modell:** `generate.model` nennt den Alias `default` aus der Datei der Anbieter ([Anbieter](../docs/providers.md)).
- **Richtlinie:** Die Seite braucht einen Eintrag im Teil `unattended` der Richtlinie, sonst startet die Routine nicht. `ecclium policy init --routine dienstplan-report --credential <Alias>` schlägt ihn vor ([Richtlinie](../docs/policy.md)). Ohne `interactive.inquiriesTo` in der Richtlinie hängt ein Lauf keinen Abschnitt an.

Das Konto der Routine braucht genau diese Rechte ([Dienstkonto](../docs/betrieb/dienstkonto.md#rechte)):

- «Events von einzelnen Kalendern sehen» (`churchservice: view events`) für die Kalender, deren Events in den Bericht gehören;
- «Dienste einzelner Dienstkategorien sehen» (`churchservice: view servicegroup`) für die Dienstgruppen, deren Einteilungen in den Bericht gehören;
- «"Wiki" sehen» (`churchwiki: view`) sowie `churchwiki: view category` und `churchwiki: edit category` nur für die Kategorie des Berichts.

Ein Recht, das keine Routine dieses Kontos braucht, etwa das Recht des Moduls `churchservice: view` oder das Bearbeiten einer weiteren Kategorie, gilt als zu weit: Der Lauf legt seinen Abschnitt dann in die Freigabe-Warteschlange, statt ihn zu schreiben. Ohne das Recht auf eine Dienstgruppe zeigt ChurchTools ein Event ohne die Einteilungen dieser Gruppe, ohne Fehler. Steht bei einem Event gar keine Einteilung, bittet der Prompt das Modell, das unter den Hinweisen zu nennen. Fehlen nur die Plätze einer von mehreren Gruppen, sieht der Bericht das nicht.

Grenzen: Ein Lauf liest höchstens 40 Events und 200 Plätze. Gibt es mehr Events oder schneidet die Grenze die Plätze des letzten Events, sagen die Daten das mit `more`, und der Prompt bittet das Modell, es unter den Hinweisen zu nennen. Sind die 200 Plätze gelesen, bevor jedes Event seine Einteilungen hat, endet der Lauf mit `run_items_exhausted`, statt Events wegzulassen. Jeder Aufruf für die Einteilungen eines Events zählt gegen das Lesebudget je Akteur und UTC-Tag aus `interactive.readBudgetPerDay` der Richtlinie, voreingestellt 200 Aufrufe ([Richtlinie](../docs/policy.md)). Jede Routine ist ein eigener Akteur ([Ereignisse des Audits](../docs/audit-events.md)). Ein Aufruf liest 25 Plätze eines Events, bei 40 Events sind es also mindestens 40 Aufrufe.

## termin-vorschau

Die Routine schreibt jeden Montag um 06:00 einen Entwurf für den Gemeindebrief mit den Terminen von einer bis fünf Wochen nach dem Lauf, als Datei: je Termin Datum, Uhrzeit, Titel und ein kurzer Satz, dazu Hinweise für die Redaktion. Sie verschickt nichts und ändert nichts in ChurchTools. Ein zweiter Lauf in derselben Woche ersetzt die Datei dieser Woche.

Was Sie anpassen:

- **Kalender:** `calendarIds` nennt als Beispiel den Kalender mit der Kennung 1. Tragen Sie die Kennungen Ihrer öffentlichen Kalender ein, 1 bis 10, jede einmal, etwa `calendarIds: [3, 7]`. Die Kennungen nennt `ct_calendars_list` für die Kalender, die das Konto des Servers sieht. Das Konto des Runners braucht das Recht auf jeden davon (siehe unten). Nennen Sie nur Kalender, deren Termine in den Gemeindebrief gehören: Der Anbieter des Modells sieht Titel, Untertitel und Orte mit den Namen darin. Die Stufe `strict` erkennt in diesen Texten keine Namen, sie maskiert nur, was die Form einer E-Mail-Adresse, einer Telefonnummer, einer IBAN oder einer AHV-Nummer hat.
- **Zeitraum:** `from` und `to` zählen Tage ab der geplanten Auslösung, `+7d` bis `+35d` sind 29 Tage. Mehr als 31 Tage, beide Enden mitgezählt, nimmt das Tool nicht an, und der Lauf endet dann mit `validation`.
- **Zeit:** `schedule` gilt in der Zeitzone aus `ECCLIUM_TIME_ZONE`. Die Zeiten in den Daten stehen in UTC, der Prompt bittet das Modell, Datum und Uhrzeit in mitteleuropäischer Zeit zu nennen. Liegt Ihre Gemeinde in einer anderen Zone, passen Sie diesen Satz im Prompt an.
- **Modell:** `generate.model` nennt den Alias `default` aus der Datei der Anbieter ([Anbieter](../docs/providers.md)).
- **Ablage:** Der Entwurf liegt als `termin-vorschau-<Woche>.md` im Ordner aus `ECCLIUM_DRAFTS_DIR`. Am Ende steht die Kennzeichnung mit dem, was unter `interactive.inquiriesTo` in der Richtlinie steht: wen Leserinnen und Leser fragen können. Beides braucht der Runner für einen Entwurf ([Runner](../docs/betrieb/runner.md), «Entwürfe»). Einen Eintrag im Teil `unattended` der Richtlinie braucht die Routine nicht, weil sie nichts in ChurchTools schreibt.
- **Form:** Der Entwurf ist Markdown. Ein Zeichen aus Daten oder Modell, das sonst als Auszeichnung wirkte, etwa ein Stern, steht mit einem Backslash davor. Ein Programm, das Markdown darstellt, zeigt den Text ohne ihn.

Ohne Eintrag in der Richtlinie liest die Routine mit dem eigenen Konto des Runners, `ct_token_runner`. Es braucht dafür genau «Einzelnen Kalender sehen» (`churchcal: view category`) für die Kalender aus `calendarIds`, nicht das Recht des Moduls `churchcal: view` ([Dienstkonto](../docs/betrieb/dienstkonto.md#rechte)). Nennt der Eintrag von `dienstplan-report` den Alias `runner`, liest der Bericht mit demselben Konto. Das Konto braucht dann die Rechte beider Routinen, und das Recht auf die Kalender gilt für den Bericht nicht als zu weit, solange `termin-vorschau` startet. Startet sie nicht, etwa weil `ECCLIUM_DRAFTS_DIR` fehlt, gilt dieses Recht als zu weit, und der Bericht geht in die Freigabe-Warteschlange, statt geschrieben zu werden.

Fehlt dem Konto das Recht auf einen der Kalender aus `calendarIds`, weist ChurchTools die ganze Liste ab, nicht nur diesen Kalender, und der Lauf endet mit `permission`, ohne Entwurf. Das zeigte ein Blick von Hand an einer Testinstanz mit einem Konto, dem das Recht auf einen von zwei Kalendern fehlte. Prüfen Sie nach jeder Änderung an `calendarIds` oder an den Rechten mit `ecclium run-once termin-vorschau --preview`, dass der Entwurf entsteht.

Grenzen: Ein Lauf liest höchstens 50 Termine, in zwei Aufrufen zu 25, jedes Datum einer Serie als eigenen Termin. Haben die Kalender in diesen Wochen mehr, sagt das Tool es, und der Prompt bittet das Modell, es unter den Hinweisen zu nennen. Nennen Sie dann weniger Kalender oder kürzen Sie den Zeitraum. Die Aufrufe zählen nicht gegen das Lesebudget, weil das Tool keine Person in einem eigenen Feld nennt.

## wiki-hygiene

Die Routine schreibt am Ersten jedes Monats um 07:00 einen Bericht über die Pflege des Wikis, als eigenen Abschnitt je Monat auf einer Seite des Wikis: welche Seiten seit einem Jahr niemand geändert hat und welche Links auf Seiten des Wikis ihr Ziel nicht finden. Sie hat kein Modell. Zwei feste Prüfungen des Kerns, `stalePages` und `brokenLinks`, lesen das Wiki und füllen den Bericht ([Routinen](../docs/routines.md), «Prüfungen des Kerns»). Sie korrigiert nichts. Ein zweiter Lauf im selben Monat ändert den Abschnitt dieses Monats, er hängt keinen zweiten an.

Was die Prüfungen lesen und melden:

- **Welche Seiten:** jede Seite jeder Kategorie, die das Konto der Routine sieht, auch die des Berichts. Welche Kategorien das sind, bestimmen die Rechte des Kontos, nicht die Routine.
- **Lange nicht geändert:** Seiten, deren letzte Änderung länger als `olderThanDays` Tage vor der geplanten Auslösung liegt, so dass ein späterer Versuch dieselben Seiten nennt, die ältesten zuerst, mit dem Tag der Änderung in der Zeitzone aus `ECCLIUM_TIME_ZONE`. Fehlt einer Seite in der Liste von ChurchTools das Datum, endet der Lauf mit `run_page_date_missing`, statt zu melden, keine Seite sei alt.
- **Links ohne Ziel:** Links auf die eigene Instanz in der Form, die die Adresszeile von ChurchTools zeigt: `/wiki/<Kennung der Kategorie>/<Titel>`, `/wiki/<Kennung der Kategorie>/<GUID>`, `/wiki/<Kennung der Kategorie>/main` oder `/wiki/<Kennung der Kategorie>` für die Hauptseite, mit Schema und Host aus `ECCLIUM_CHURCHTOOLS_URL`, auch in anderer Gross- und Kleinschreibung oder ohne Schema, oder als Pfad allein, jeweils nur am Anfang einer Adresse. Ein Satzzeichen am Ende, etwa ein Punkt nach einer Adresse im Fliesstext, stört nicht. ChurchTools findet eine Seite dort über ihren Titel oder ihre GUID ohne Rücksicht auf Gross- und Kleinschreibung, die Prüfung ebenso. Ein Link auf eine Seite, die das Konto nicht sehen darf, erscheint wie ein Link auf eine fehlende Seite, ein Link in eine Kategorie, die es nicht sieht, mit der Kennung der Kategorie. Den Anker oder die Query eines Links prüft sie nicht, nur die Seite. Links auf andere Hosts, mit einem anderen Schema oder Port, auf Dateien und die alte Form mit `?q=churchwiki` prüft sie nicht. Der Bericht nennt das Ziel als Text «Kategorie › Titel», nie als Adresse.
- **Titel im Bericht:** Jeder Titel und jeder Name einer Kategorie geht für sich durch die ContentPolicy, und noch einmal jeder Wert, wie er im Bericht steht, und jeder Eintrag in seiner Zeile der Vorlage. Was sie abweist, etwa einen Titel mit einer E-Mail-Adresse, ersetzt der Text «(Titel nicht darstellbar)», eine GUID, deren Teile wie eine Telefonnummer aussehen, der Text «(Seite über ihre GUID verlinkt)». So lässt ein einzelner Titel nicht jeden Lauf scheitern.

Was Sie anpassen:

- **Seite:** `output.scope` nennt die Kategorie «Berichte» und die Seite «Wiki-Pflege». Legen Sie Kategorie und Seite in ChurchTools an oder nennen Sie eine bestehende Seite. Ecclium legt keine Seite an.
- **Wer den Bericht liest:** Der Bericht nennt Titel von Seiten, auch aus Kategorien, die nicht jeder sieht. Wählen Sie eine Kategorie, die nur die Personen sehen, die das Wiki pflegen.
- **Alter:** `olderThanDays` in `stalePages`, von 30 bis 3'650 Tagen. Ändern Sie dann auch die Überschrift und den Satz für eine leere Liste in der Vorlage.
- **Länge:** `maxItems` je Prüfung, 1 bis 100, und je Liste höchstens etwa 24 KB Text. Hat eine Prüfung mehr Treffer, nennt der Bericht die ersten in fester Reihenfolge: lange nicht geänderte Seiten die ältesten zuerst, Links nach Kategorie und Titel der Seite, dann nach dem Ziel. Die Vorlage sagt die Grenze, ändern Sie sie dort mit.
- **Zeit:** `schedule` gilt in der Zeitzone aus `ECCLIUM_TIME_ZONE`.
- **Richtlinie:** Die Seite braucht einen Eintrag im Teil `unattended` der Richtlinie, sonst startet die Routine nicht. `ecclium policy init --routine wiki-hygiene --credential <Alias>` schlägt ihn vor ([Richtlinie](../docs/policy.md)). Ohne `interactive.inquiriesTo` in der Richtlinie hängt ein Lauf keinen Abschnitt an.

Das Konto der Routine braucht genau diese Rechte ([Dienstkonto](../docs/betrieb/dienstkonto.md#rechte)):

- «"Wiki" sehen» (`churchwiki: view`);
- `churchwiki: view category` für jede Kategorie, die der Bericht prüfen soll, und für die Kategorie des Berichts;
- `churchwiki: edit category` nur für die Kategorie des Berichts.

Die Prüfungen lesen in der Stufe `standard`, weil sie ihre Daten keinem Modell geben und die Tools des Wikis keine Person in einem eigenen Feld nennen. In der Stufe `strict` hielte die Maskierung Teile einer GUID in einem Link für eine Telefonnummer. In den Bericht kommen nur Titel und Namen von Kategorien, jeder durch die ContentPolicy.

Grenzen: Ein Lauf liest höchstens 400 Mal: die Kategorien zu 25, je Kategorie die Liste ihrer Seiten zu 25, und für `brokenLinks` jede Seite, eine lange Seite in mehreren Teilen. Das reicht für etwa 350 Seiten. Braucht ein Lauf mehr, endet er mit `run_calls_exhausted`, statt Seiten wegzulassen. Geben Sie dem Konto dann weniger Kategorien oder nehmen Sie `brokenLinks` aus der Routine. Die Aufrufe zählen nicht gegen das Lesebudget.

## Ein Konto für alle drei Routinen

Nennen die Einträge von `dienstplan-report` und `wiki-hygiene` dasselbe Konto, etwa `runner`, das auch `termin-vorschau` ohne Eintrag nutzt, braucht dieses Konto die Rechte aller drei Routinen zusammen, und keines gilt als zu weit, solange alle drei starten. Eine Routine, die nicht startet, zählt nicht: Fehlt etwa die Datei der Anbieter, starten `dienstplan-report` und `termin-vorschau` nicht, ihre Rechte auf Events, Dienste und Kalender gelten als zu weit, und `wiki-hygiene` legt ihren Bericht in die Freigabe-Warteschlange. Für eine Übergangszeit lässt `acceptRightsDrift` im Eintrag von `wiki-hygiene` sie trotzdem schreiben, höchstens 30 Tage und mit einem Vermerk im Audit ([Richtlinie](../docs/policy.md)). Ein eigenes Konto je Routine vermeidet das.
