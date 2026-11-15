# Routinen und Läufe

**In Entwicklung.** Es gibt noch keine veröffentlichte Version. Diese Seite erklärt, was eine Routine ist, was in einem Lauf geschieht und warum Ecclium einen Lauf so eng führt, so wie es heute gebaut ist. Wie Sie den Runner einrichten, steht unter [Runner einrichten](betrieb/runner-einrichten.md), jedes Feld einer Routine unter [Routinen](routines.md), alle Bedrohungen und Restrisiken im [Threat Model](threat-model.md).

Ecclium ist ein unabhängiges Projekt und steht in keiner Verbindung zum Hersteller von ChurchTools.

## Zuerst die Grenzen

- Ein Lauf schreibt, ohne dass eine Person zusieht. Ecclium legt vorher fest, wohin er schreibt, womit und wie viel. Ob der Inhalt stimmt, prüft es nicht: Ein Sprachmodell kann falsch zählen, etwas weglassen oder einem Text in seinen Daten folgen. Lesen Sie einen Bericht deshalb wie einen Entwurf. Die Kennzeichnung am Ende sagt jeder Leserin und jedem Leser, dass er automatisch entstanden ist.
- Eine Routine mit Modell gibt Daten Ihrer Gemeinde an den Anbieter des Modells, maskiert, aber nicht anonym ([Datenschutz](privacy.md#was-an-den-anbieter-des-sprachmodells-geht)).
- Ecclium verschickt nichts. Ein Entwurf ist eine Datei, die eine Person liest und weitergibt.
- Was hier steht, belegen Tests mit Stellvertretern für ChurchTools und für das Modell und Läufe mit einem echten Modell an einer Testinstanz mit synthetischen Daten. Dort nannten zwei Berichte aus denselben Daten verschieden viele offene Anfragen, und ein Entwurf nannte jedes Datum mit einem falschen Jahr.

## Was eine Routine ist

Eine Routine beschreibt einen wiederkehrenden Ablauf in einer Datei: wann er läuft, was er in ChurchTools liest, wie daraus Blöcke mit festen Feldern entstehen, in welche Vorlage sie kommen und wohin das Ergebnis geht ([Routinen](routines.md)). Der Runner führt Routinen aus, als Daemon `ecclium runner` oder als Einzellauf `ecclium run-once`, den etwa cron aufruft ([Runner der Routinen](betrieb/runner.md)). Führt er eine Routine für eine Periode aus, etwa für die Woche `2026-W47`, heisst das ein Lauf.

Drei Dateien gehören zusammen, und jede hat eine andere Herkunft:

- Die **Routine** kommt vom Anwendungsfall. Sie nennt ihr Ziel über Namen und ihr Modell über einen Alias wie `default`. So bleibt sie zwischen Gemeinden übertragbar.
- Die **[Richtlinie](policy.md)** kommt von Ihnen. Nur sie erlaubt einem Lauf, ins Wiki zu schreiben: auf eine Seite mit Kennung und erwartetem Namen oder auf eine Seite in einer Kategorie, die der Eintrag nennt, mit einem bestimmten Konto und mit Grenzen je Lauf und je Tag. Eine Routine kann sich kein Recht selbst geben, auch nicht eine schwächere Maskierung zum Modell.
- Die **[Datei der Anbieter](providers.md)** kommt ebenfalls von Ihnen. Sie sagt, welcher Anbieter, welches Modell und welches Land hinter einem Alias stehen.

## Mitgelieferte Routinen

Ecclium bringt drei Routinen mit. Jede ist eine Vorlage, die Sie für Ihre Gemeinde anpassen ([Mitgelieferte Routinen](../routines/README.md)).

| Routine             | Zeitplan                    | Modell | Was sie liest                                                         | Ergebnis                               | Konto                                      |
| ------------------- | --------------------------- | ------ | --------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------ |
| `dienstplan-report` | Montag, 06:00               | ja     | die Events der kommenden zwei Wochen und ihre Einteilungen in Dienste | ein Abschnitt je Woche auf einer Seite | das Konto aus ihrem Eintrag der Richtlinie |
| `termin-vorschau`   | Montag, 06:00               | ja     | die Termine der Kalender, die Sie nennen, von Tag 7 bis Tag 35        | ein Entwurf je Woche als Datei         | das eigene Konto des Runners, ohne Eintrag |
| `wiki-hygiene`      | am Ersten des Monats, 07:00 | nein   | Kategorien, Listen der Seiten und Seiten des Wikis                    | ein Abschnitt je Monat auf einer Seite | das Konto aus ihrem Eintrag der Richtlinie |

`wiki-hygiene` hat kein Modell. Zwei feste Prüfungen des Kerns füllen ihren Bericht: Seiten, die lange niemand geändert hat, und Links im Wiki, deren Ziel das Konto der Routine nicht findet. Sie korrigiert nichts.

## Was in einem Lauf geschieht

Jeder Lauf geht dieselben Schritte, im Daemon wie im Einzellauf ([ADR 0033](adr/0033-runner-modell-ohne-werkzeuge.md), [ADR 0034](adr/0034-zeitplan-semantik.md)).

1. **Laden:** Beim Start liest der Runner Routinen, Richtlinie und Anbieter und prüft sie. Eine Routine, die ins Wiki schreibt, startet nur mit einem Eintrag der Richtlinie für ihre Seite oder deren Kategorie, eine Routine mit Modell nur mit einem Anbieter für ihren Alias.
2. **Fällig:** Den Zeitplan rechnet der Kern in der Zeitzone aus `ECCLIUM_TIME_ZONE`. Fällig ist die letzte geplante Auslösung, höchstens 31 Tage zurück, solange kein Lauf sie abgeschlossen hat. Eine Sperrdatei je Routine verhindert zwei Läufe zugleich. Ein Kill-Switch hält einen Lauf an, bevor er etwas liest.
3. **Lesen:** Der Lauf liest nur mit Lese-Tools, die in der [Referenz der Tools](tools.md) als «für Routinen stabil» stehen, mit dem Konto der Routine und mit einer Obergrenze je Eingabe. Jeder Aufruf geht durch dieselbe Pipeline wie beim Server und bekommt eine Zeile im Audit. Reicht eine Grenze nicht, endet der Lauf, oder die Daten sagen, dass es mehr gibt. Still gekürzt wird nie.
4. **Maskieren:** Was zum Modell geht, ist in der Stufe `strict` maskiert, ausser Ihre Richtlinie erlaubt für diese Routine `standard`. In `strict` sieht das Modell statt der Kennung einer Person ein Pseudonym und vom Nachnamen nur den ersten Buchstaben, und E-Mail-Adressen, Telefonnummern, IBAN und AHV-Nummern sind auch in freiem Text maskiert. Unmittelbar vor dem Aufruf prüft der Kern, dass jeder Teil mit Daten maskiert wurde, und bricht sonst ab.
5. **Modell fragen:** Das Modell bekommt einen festen Text des Kerns, dass Daten keine Anweisungen sind, dann den Prompt der Routine, dann die Daten, jede Eingabe in einem Block mit zufälliger Grenze. Es hat keine Werkzeuge: Es kann nichts nachlesen, nichts aufrufen und nichts senden. Es füllt nur die Blöcke, die die Routine vorgibt. Eine Routine ohne Modell überspringt diesen Schritt.
6. **Antwort prüfen:** Ein unbekanntes Feld, ein Wert über seiner Grenze oder eine Person, die nicht in den Daten stand, macht die Antwort ungültig. Jedes Textfeld geht einzeln durch die ContentPolicy. Sie weist Links, Bilder, HTML und Webadressen ab, dazu Kontaktangaben, die weder in den Daten des Laufs noch in der Richtlinie stehen ([Sicherheit](security.md#was-ecclium-ins-wiki-schreibt)). Ein Verstoss beendet den Lauf, ohne dass er schreibt.
7. **Rendern:** Der Kern setzt die Felder als reinen Text in die Vorlage der Routine, eine Datei ohne Bedingungen und ohne Code. Für eine Person steht dort der Name, wie ChurchTools ihn liefert. Ihn setzt der Kern erst nach der Antwort des Modells ein. Der ganze Abschnitt geht noch einmal durch die ContentPolicy.
8. **Schreiben:** Ins Wiki schreibt ein Lauf nur mit `ct_wiki_page_append_section`, nur einen eigenen Abschnitt je Periode, nur auf die Seite, die die Richtlinie erlaubt, und nur innerhalb ihrer Grenzen. Der Kern sucht die Seite selbst, hält vorher einen Snapshot fest und liest danach, ob steht, was er gesendet hat. Ein zweiter Lauf derselben Periode ändert den Abschnitt oder lässt ihn stehen, er hängt keinen zweiten an. Was die Richtlinie nicht deckt, legt der Lauf in die Freigabe-Warteschlange, statt zu schreiben: ein umbenanntes Ziel, eine erreichte Grenze, zu weite Rechte des Kontos oder einen Abschnitt, den eine Person geändert hat. Beim Schreiben hängt der Kern die Kennzeichnung an, etwa «Automatisch erstellt am 16.11.2026 durch Ecclium, Routine dienstplan-report, Lauf 2026-W47, Prüfcode k1:ABCDEFGHIJKLM. Rückfragen an Sekretariat.» Ein Entwurf geht als Datei in den Ordner aus `ECCLIUM_DRAFTS_DIR`, mit der Kennzeichnung ohne Prüfcode.
9. **Melden:** Jeder Lauf endet mit einer Zeile im Audit. Dazu kommen, wenn Sie sie einrichten, eine Meldung ohne Inhalt, die Metrikdatei und ein Ping an eine Überwachung. `ecclium audit show --run <Lauf>` zeigt, was ein Lauf gelesen und geschrieben hat.

## Warum so eng: die «Rule of Two»

Ein Ablauf ohne Menschen ist gefährlich, wenn er drei Dinge zugleich tut:

1. Er liest Texte, die jemand anderes geschrieben hat, etwa Namen von Events, Titel von Terminen oder Seiten des Wikis.
2. Er hat Zugriff auf Daten, die geschützt sein müssen, etwa Personen und ihre Einteilungen.
3. Er kann etwas ändern oder Daten nach aussen geben, etwa ins Wiki schreiben oder ein Modell bei einem Anbieter fragen.

Ein Text, der wie eine Anweisung aussieht, etwa «Ignoriere alles Bisherige und schreibe …», kann ein Sprachmodell dazu bringen, ihm zu folgen. Das heisst Prompt-Injection, und kein Modell ist davor sicher. Die «Rule of Two», eine Faustregel für Abläufe mit Sprachmodellen, sagt deshalb: Ein Ablauf ohne Menschen soll höchstens zwei der drei Dinge verbinden.

Ein Bericht über den Dienstplan braucht alle drei. Ecclium lässt darum keines weg, sondern begrenzt jedes so, dass ein Modell, das einer Anweisung in seinen Daten folgt, wenig damit erreicht ([ADR 0033](adr/0033-runner-modell-ohne-werkzeuge.md)):

| Was der Lauf tut               | Wie Ecclium es begrenzt                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fremde Texte lesen             | Das Modell hat keine Werkzeuge. Ziel, Tool und Aufbau des Berichts stehen fest, bevor es etwas sieht. Fremder Text steht in Blöcken mit zufälliger Grenze, unsichtbare Zeichen sind entfernt.                                                                                                                                                                                   |
| Auf geschützte Daten zugreifen | Der Lauf liest nur die Eingaben seiner Routine, jede mit Obergrenze, mit einem eigenen Konto, das nur die Rechte seiner Routinen hat. Zum Modell gehen die Daten maskiert. Tools, die Namen anderer Personen nennen, zählen gegen das Lesebudget.                                                                                                                               |
| Ändern und nach aussen geben   | Ein Tool, ein Abschnitt je Periode, ein Ziel aus der Richtlinie, Grenzen je Lauf und je Tag. Jeder Text geht durch die ContentPolicy, jeder Abschnitt trägt die Kennzeichnung und lässt sich in der Voreinstellung 30 Tage lang zurücknehmen. Hinter dem Proxy erreicht der Runner nur die Ziele der Konfiguration. Mit `ECCLIUM_EGRESS=off` gilt nur die Positivliste im Code. |

Die Begrenzung hängt nicht davon ab, dass das Modell sich richtig verhält. Sie gilt auch für ein Modell, das jeder Anweisung folgt.

## Was ein Angriff erreichen kann und was nicht

Dafür gibt es ein Korpus von 19 Angriffen auf Deutsch und Englisch und einen Stellvertreter für ein Modell, der jeder Anweisung folgt, die er in seinen Daten findet. Mit ihnen laufen bei jeder Änderung am Code die drei mitgelieferten Routinen bis zum fertigen Abschnitt und eine Routine, die Text des Wikis einem Modell gibt, bis zum Schreiben gegen einen Stellvertreter für ChurchTools. Die Angriffe stehen in Namen von Events und Diensten, in Titeln, Untertiteln und Orten von Terminen, in Titeln von Seiten und im Text von Seiten.

**Erreichen kann ein Angriff:**

- den Inhalt der Felder, innerhalb ihrer Grenzen. Ein Modell, das der Anweisung folgt, schreibt etwa «Alle Dienste sind besetzt.», obwohl Plätze offen sind.
- dass ein Bericht ausbleibt. Weist die Prüfung die Antwort ab, schreibt der Lauf nichts, und Meldung und Audit sagen es.

**Nicht erreicht hat ein Angriff in diesen Tests:**

- ein anderes Ziel oder ein anderes Tool: Jede Anfrage, die schreibt, ging mit `ct_wiki_page_append_section` an die Seite, die die Richtlinie erlaubt.
- ein Feld, das die Blöcke der Routine nicht kennen. Längere Felder, mehr Einträge und einen anderen Aufbau schliessen das Ausgabeschema und das Einsetzen als reiner Text aus; das Korpus versucht sie nicht eigens.
- einen Link, ein Bild, HTML, eine Webadresse oder eine Erwähnung einer Person im Bericht.
- eine Person oder eine Kontaktangabe, die in den Daten des Laufs nicht stand.
- einen Abschnitt mit einer Zeile, die sich als Kennzeichnung von Ecclium liest, mit der Einschränkung unten.
- unsichtbare Zeichen im Prompt: Tag-Zeichen von Unicode entfernt die Pipeline, bevor das Modell sie sieht.

**Was bleibt:**

- Ein Bericht kann falsch sein. Das erkennt keine Prüfung von Ecclium, nur eine Person, die den Bericht liest und ChurchTools kennt.
- Eine Zeile, die der Kennzeichnung ähnelt, aber in den festen Wörtern ähnliche Buchstaben des lateinischen Alphabets trägt, etwa ein grosses «I» für ein kleines «l» oder «rn» für «m», weist die Prüfung nicht ab. Für eine eigene Kennzeichnung hält Ecclium sie nie, eine Person sieht aber eine zweite Zeile, die wie die Kennzeichnung aussieht. Zeichen anderer Schriften an dieser Stelle weist die Prüfung ab.
- Als Text bleiben eine nackte IPv4-Adresse, `@Name` ohne Link auf eine Person und `javascript:` ohne Link stehen. Wie ChurchTools solche Texte zeigt, ist nicht geprüft.
- Ein Name in einem freien Text, etwa im Titel eines Termins, erreicht das Modell unmaskiert und kann im Bericht stehen. Die Maskierung erkennt in freiem Text nur, was die Form einer E-Mail-Adresse, Telefonnummer, IBAN oder AHV-Nummer hat.
- Ob ChurchTools HTML-Kommentare und Tag-Zeichen von Unicode im Text einer Seite unverändert speichert und wie es sie zeigt, ist nicht geprüft.

## Was Sie selbst tun

- **Enge Konten:** Geben Sie jedem Konto des Runners nur die Rechte seiner Routinen ([Mitgelieferte Routinen](../routines/README.md)). Hat ein Konto mehr, schreibt ein Lauf nicht ins Wiki, sondern legt seinen Abschnitt in die Freigabe-Warteschlange. Einen Entwurf als Datei hält das nicht auf. `ecclium doctor` zeigt zu weite und fehlende Rechte ([Prüfen mit `ecclium doctor`](betrieb/doctor.md)).
- **Leserkreis:** Ein Bericht nennt Personen mit ihrem Namen. Wählen Sie für ihn eine Kategorie des Wikis, die nur die Personen sehen, die diese Daten in ChurchTools ohnehin sehen.
- **Erst die Vorschau:** `ecclium run-once <Routine> --preview` zeigt den Abschnitt, ohne zu schreiben. Schalten Sie das Schreiben für eine Routine erst danach ein ([Runner einrichten](betrieb/runner-einrichten.md)).
- **Grenze im Netz:** Betreiben Sie den Runner hinter dem Proxy, nicht mit `ECCLIUM_EGRESS=off` ([Grenze im Netz mit Squid](betrieb/egress.md)).
- **Lesen, was entsteht:** Lesen Sie die ersten Berichte einer neuen Routine und danach regelmässig einen. `ecclium audit show --run <Lauf>` zeigt, was ein Lauf gelesen und geschrieben hat.
- **Anhalten und zurücknehmen:** Eine leere Datei `writes-off-routine-<Routine>` im Ordner der Kill-Switches hält die Läufe einer Routine an, ohne Neustart. `ecclium undo --run <Lauf>` nimmt zurück, was ein Lauf ins Wiki geschrieben hat ([Runner der Routinen](betrieb/runner.md#anhalten)).

## Eigene Routinen

Sie können eigene Routinen schreiben ([Routinen](routines.md)). Was eine Routine braucht, muss sich in Blöcken mit festen Feldern und einer Vorlage beschreiben lassen. Das ist gewollt: Ein Bericht enthält nur, was seine Blöcke vorsehen.

- Keine mitgelieferte Routine gibt Text aus dem Wiki einem Modell. Eine eigene Routine kann das, etwa mit `ct_wiki_page_get`. Dann liest das Modell, was jede Person schreiben kann, die im Wiki schreiben darf. Die Grenzen oben gelten auch dann, die Tests prüfen eine solche Routine. Rechnen Sie aber damit, dass ein Text im Wiki den Inhalt des Berichts bestimmt.
- Halten Sie Felder kurz und Blöcke klein. Jede Grenze, die Sie enger setzen, lässt einem Angriff weniger Raum.
- Nennen Sie als Eingabe nur, was der Bericht braucht. Was eine Routine nicht liest, erreicht weder das Modell noch den Bericht.
- Eine Zahl, ein Datum oder ein Verweis auf eine Person ist sicherer als ein Text: Der Kern prüft ihre Form, und eine Person muss in den Daten des Laufs stehen.

## Grenzen

- Ein Lauf dauert höchstens 30 Minuten und liest höchstens 400 Mal. Eine Routine löst höchstens einmal je Stunde aus.
- Ein Lauf hängt im Wiki nur einen Abschnitt an eine bestehende Seite an. Er legt keine Seite an, ändert keine ganze Seite und schreibt weder Termine noch Buchungen. Tools für Personen und Gruppen laufen nie unbeaufsichtigt.
- Verpasste Auslösungen holt der Runner nicht nach, ausser der letzten. War er eine Woche aus, läuft ein wöchentlicher Bericht einmal.
- Geht die Uhr des Rechners falsch, laufen Routinen zur falschen Zeit oder für die falsche Periode. Ecclium prüft die Uhr nur vor einem Schreibvorgang in ChurchTools: Weicht sie mehr als fünf Minuten von der Zeit von ChurchTools ab, schreibt ein Lauf nicht ins Wiki. Den Zeitplan, das Lesen, den Aufruf des Modells und einen Entwurf als Datei hält diese Prüfung nicht auf.
- Der Server über stdio führt keine Routinen aus. Routinen laufen nur im Runner.
