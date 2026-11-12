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
