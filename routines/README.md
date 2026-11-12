# Mitgelieferte Routinen

Dieser Ordner enthält die Routinen, die Ecclium mitbringt, mit ihren Prompts unter `prompts/` und ihren Vorlagen unter `templates/`. Jede Routine ist eine Vorlage für Ihre Gemeinde: Kopieren Sie den Inhalt dieses Ordners oder einzelne Routinen mit Prompt und Vorlage in den Ordner aus `ECCLIUM_ROUTINES_DIR` und passen Sie an, was unten steht. Der Lader liest nur Routinen, die direkt im Ordner aus `ECCLIUM_ROUTINES_DIR` liegen, nicht in einem Ordner darunter. Wie eine Routine aufgebaut ist und was jedes Feld bedeutet, steht unter [Routinen](../docs/routines.md), wie der Runner sie ausführt, unter [Runner](../docs/betrieb/runner.md).

Ordner und Dateien müssen dem Benutzer gehören, unter dem Ecclium läuft, und dürfen für Gruppe und andere nicht beschreibbar sein, etwa mit den Rechten 755 und 644. Ein Checkout gibt Dateien oft andere Rechte, prüfen Sie sie nach dem Kopieren.

Probieren Sie eine Routine zuerst mit `ecclium run-once <Routine> --preview` aus. Die Vorschau zeigt den Abschnitt, ohne zu schreiben, auch bevor die Richtlinie einen Eintrag für die Routine hat. Eine Routine mit Modell fragt dafür schon das Modell und braucht wie jeder Lauf die Schlüsseldatei der Pseudonyme ([Runner](../docs/betrieb/runner.md)).

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

Die Routine schreibt jeden Montag um 06:00 einen Entwurf für den Gemeindebrief mit den Terminen von der nächsten bis zur fünften Woche, als Datei: je Termin Datum, Uhrzeit, Titel und ein kurzer Satz, dazu Hinweise für die Redaktion. Sie verschickt nichts und ändert nichts in ChurchTools. Ein zweiter Lauf in derselben Woche ersetzt die Datei dieser Woche.

Was Sie anpassen:

- **Kalender:** `calendarIds` nennt als Beispiel den Kalender mit der Kennung 1. Tragen Sie die Kennungen Ihrer öffentlichen Kalender ein, 1 bis 10, jede einmal, etwa `calendarIds: [3, 7]`. Die Kennungen nennt `ct_calendars_list` für die Kalender, die das Konto des Servers sieht. Nennen Sie nur Kalender, deren Termine in den Gemeindebrief gehören: Der Anbieter des Modells sieht Titel, Untertitel und Orte, wie sie in ChurchTools stehen, und die Stufe `strict` erkennt Namen in diesen Texten nur an ihrer Form.
- **Zeitraum:** `from` und `to` zählen Tage ab der geplanten Auslösung, `+7d` bis `+35d` sind 29 Tage. Mehr als 31 Tage, beide Enden mitgezählt, nimmt das Tool nicht an, und der Lauf endet dann mit `validation`.
- **Zeit:** `schedule` gilt in der Zeitzone aus `ECCLIUM_TIME_ZONE`. Die Zeiten in den Daten stehen in UTC, der Prompt bittet das Modell, Datum und Uhrzeit in mitteleuropäischer Zeit zu nennen. Liegt Ihre Gemeinde in einer anderen Zone, passen Sie diesen Satz im Prompt an.
- **Modell:** `generate.model` nennt den Alias `default` aus der Datei der Anbieter ([Anbieter](../docs/providers.md)).
- **Ablage:** Der Entwurf liegt als `termin-vorschau-<Woche>.md` im Ordner aus `ECCLIUM_DRAFTS_DIR`. Am Ende steht die Kennzeichnung mit dem, was unter `interactive.inquiriesTo` in der Richtlinie steht: wen Leserinnen und Leser fragen können. Beides braucht der Runner für einen Entwurf ([Runner](../docs/betrieb/runner.md), «Entwürfe»). Einen Eintrag im Teil `unattended` der Richtlinie braucht die Routine nicht, weil sie nichts in ChurchTools schreibt.
- **Form:** Der Entwurf ist Markdown. Ein Zeichen aus Daten oder Modell, das sonst als Auszeichnung wirkte, etwa ein Stern, steht mit einem Backslash davor. Ein Programm, das Markdown darstellt, zeigt den Text ohne ihn.

Ohne Eintrag in der Richtlinie liest die Routine mit dem eigenen Konto des Runners, `ct_token_runner`. Es braucht dafür genau «Einzelnen Kalender sehen» (`churchcal: view category`) für die Kalender aus `calendarIds`, nicht das Recht des Moduls `churchcal: view` ([Dienstkonto](../docs/betrieb/dienstkonto.md#rechte)). Nennt der Eintrag von `dienstplan-report` den Alias `runner`, liest der Bericht mit demselben Konto. Das Konto braucht dann die Rechte beider Routinen, und das Recht auf die Kalender gilt für den Bericht nicht als zu weit.

Fehlt dem Konto das Recht auf den einzigen Kalender aus `calendarIds`, weist ChurchTools die Termine ab, und der Lauf endet mit `permission`, ohne Entwurf. Ob ChurchTools eine Liste mehrerer Kalender ebenso abweist, wenn das Recht nur für einen davon fehlt, oder diesen Kalender still weglässt, ist nicht geprüft. Prüfen Sie deshalb nach jeder Änderung an `calendarIds` oder an den Rechten mit `ecclium run-once termin-vorschau --preview`, dass jeder Kalender mit seinen Terminen erscheint.

Grenzen: Ein Lauf liest höchstens 50 Termine, in zwei Aufrufen zu 25, jedes Datum einer Serie als eigenen Termin. Haben die Kalender in diesen Wochen mehr, sagt das Tool es, und der Prompt bittet das Modell, es unter den Hinweisen zu nennen. Nennen Sie dann weniger Kalender oder kürzen Sie den Zeitraum. Die Aufrufe zählen nicht gegen das Lesebudget, weil das Tool keine Person in einem eigenen Feld nennt.
