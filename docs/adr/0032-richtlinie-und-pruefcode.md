# ADR 0032: Richtlinie mit Kennungen, portable Ziele der Routinen, interaktiver Teil und Lesebudget, Prüfcode in der Kennzeichnung, Zielarten für Gruppen und Dienste nur im interaktiven Teil

- Status: Vorgeschlagen
- Datum: 01.11.2026
- Fällt vor: Phase 5

## Kontext

Ein Schreibvorgang braucht eine Bestätigung ([ADR 0029](0029-write-guard.md)). Was eine Bestätigung durchläuft, dürfte ohne weitere Grenze alles, was das Dienstkonto in ChurchTools darf. Ein gestohlenes Token, ein kompromittierter Client oder ein Tool, das im Client auf «immer erlauben» steht, hätte damit die vollen Rechte des Kontos. Ein unbeaufsichtigter Lauf einer Routine ab Phase 6 hat niemanden, der bestätigt. Dazu kommen:

- **Lesebudget:** Tools mit `sensitivity: special` und Tools, die Namen anderer Personen nennen, teilen ein Budget von 200 Aufrufen je Akteur und UTC-Tag. Einstellbar soll es mit der Richtlinie werden ([ADR 0063](0063-quotastore-als-datei.md), [ADR 0064](0064-leserechte-und-felder-der-lese-tools.md)).
- **Gruppen und Dienste:** Die Vorhaben «Mitglied einer Gruppe hinzufügen oder entfernen» und «Dienstanfrage an eine Person» betreffen Personen und laufen nie unbeaufsichtigt ([ADR 0071](0071-grenze-zwischen-kern-und-pro.md)).
- **Kennzeichnung (T10):** Jede Seite und jeder Abschnitt, den Ecclium hinzufügt, trägt am Ende eine Zeile mit festem Wortlaut (`brand/README.md`, Kapitel 9). Sie ist zugleich das Zeichen, an dem Ecclium einen eigenen Abschnitt wiedererkennt, damit ein zweiter Lauf derselben Periode nichts verdoppelt. Ohne einen Prüfcode könnte jede Person mit Schreibrecht im Wiki einen Abschnitt mit dieser Zeile anlegen und so einen echten Bericht unterdrücken oder überschreiben lassen ([Threat Model](../threat-model.md), T10).
- **Web-Editor:** Er schrieb über die API angelegte Markdown-Seiten beim ersten Speichern neu, auch ohne Änderung: andere Zeichen vor Listenpunkten, zusätzliche Leerzeilen, neu ausgerichtete Tabellen, eine anders geschriebene Zeile mit zwei Leerzeichen am Ende und nackte URLs als Link. Gleich blieben Überschriften, Absatz, Fett, kursiv, Code und der HTML-Kommentar. Ob ein zweites Speichern den Text erneut ändert, ist nicht geprüft (F13 in [`docs/research/churchtools-api.md`](../research/churchtools-api.md)). Ein Prüfcode über den rohen Text gälte danach nicht mehr.
- **Format:** Die Datei pflegt der Betreiber von Hand und soll sie kommentieren können. `yaml` 2.9.1 ist am 01.11.2026 in der Registry von npm geprüft: Lizenz ISC, keine Abhängigkeiten, ohne Herkunftsnachweis, wie schon 2.8.0, 2.8.1 und 2.9.0, die neueste Version seit dem 11.09.2026. Eine neue Version ohne Herkunftsnachweis im Lockfile meldet der Job `lockfile-provenance` rot, und Renovate übernimmt sie nicht selbst.

## Optionen

Für das Format:

1. **YAML mit `yaml` 2.9.1:** lesbar, mit Kommentaren, für Routinen in Phase 6 ohnehin nötig, aber ohne Herkunftsnachweis.
2. **Nur JSON:** ohne Abhängigkeit, aber ohne Kommentare, für Betreiber ohne Entwicklerhintergrund schwer zu pflegen.
3. **Ein eigener Leser für eine Teilmenge von YAML:** ohne Abhängigkeit, aber die Grammatik von YAML ist gross, und ein eigener Leser wäre eine neue Quelle für Fehler an einer Stelle, die über Rechte entscheidet.

Für den Prüfcode:

1. **Über den rohen Text:** einfach, aber ungültig, sobald jemand die Seite im Web-Editor speichert, auch an einer ganz anderen Stelle.
2. **Über eine kanonische Form des Abschnitts,** die ausgleicht, was der Editor ändert, ohne den Inhalt zu übergehen.
3. **Ohne Prüfcode,** nur mit der Zeile: einfach zu fälschen (T10).

Für einen ungültigen Prüfcode: als Fälschung behandeln und melden, oder als Änderung eines Menschen.

## Entscheid

Gewählt sind YAML mit `yaml` 2.9.1, der Prüfcode über eine kanonische Form und ein ungültiger Code als Änderung eines Menschen.

### Datei und Format

- `ECCLIUM_POLICY_FILE` nennt die Datei der Richtlinie, Format `policy.v1` mit dem Feld `schema: policy.v1`. Gelesen wird YAML 1.2 mit `yaml` 2.9.1, JSON geht als Teil davon ebenso. Der Leser nimmt nur das Schema `core`, eindeutige Schlüssel, keine Anker und Aliase, keine eigenen Tags und keine Merge-Schlüssel und Dateien bis 256 KiB. Danach prüft zod strikt: Ein unbekanntes Feld, ein falscher Typ oder ein Widerspruch, etwa dasselbe Ziel mit zwei Namen, ist ein Fehler.
- Die Datei liest der Kern wie die Token-Datei, ohne einem Link zu folgen, nur als gewöhnliche Datei des Benutzers. Sie ist kein Geheimnis und darf lesbar sein, Gruppe und andere dürfen sie aber nicht schreiben, weil sie über die Ziele entscheidet. Ein Fehler bricht den Start mit 78 ab, und die Meldung nennt den Pfad des Felds in der Datei, nie einen Wert.
- **Ohne die Variable** läuft der Server wie mit einem leeren interaktiven Teil und dem Lesebudget 200. `ecclium doctor` meldet das als Befund, sobald es ihn gibt. Der Runner verlangt ab Phase 6 eine Datei.
- `schemas/policy.v1.json` entsteht aus dem Schema von zod wie das Schema des Audits, dazu eine erzeugte Seite `docs/policy.md` mit allen Feldern. CI prüft beides auf Abweichungen.
- **Hash:** SHA-256 über die kanonische Form der geprüften Richtlinie. Er steht in jedem Ereignis eines Schreibvorgangs und eines Laufs als `policyHash`.
- **Ausnahme für `yaml`:** genau gepinnt, jede neue Version sieht eine Person vor dem Merge an, und Renovate mergt sie nie selbst. Der Pull Request, der `yaml` hinzufügt, ist in `lockfile-provenance` rot, das keine Pflichtprüfung ist. Ein Wechsel auf eine andere Bibliothek braucht ein eigenes ADR. Andere Bibliotheken für YAML sind nicht auf ihren Herkunftsnachweis geprüft.

### Unbeaufsichtigter Teil

- Was nicht ausdrücklich erlaubt ist, ist verboten. Einen Modus «alles erlaubt» gibt es nicht.
- Ein Eintrag bindet eine Routine an Tools, eine Zielart, eine Kennung mit erwartetem Namen, Obergrenzen je Lauf und je Tag, bei denen auch Läufe von Hand mitzählen, und einen Alias für die Zugangsdaten, damit der Runner mit dem engsten passenden Dienstkonto schreibt.
- Geltungsbereiche sind immer konkret: eine Seite oder Kategorie des Wikis, ein Kalender, eine Ressource, nie der ganze Mandant. Für Ziele im Wiki gilt mindestens die Stufe `standard` der Maskierung. Der Modellaufruf einer Routine läuft mit `strict`, ausser der Eintrag erlaubt `standard`.
- Zielarten für Gruppen und Dienste weist der unbeaufsichtigte Teil ab, und der Runner startet dann nicht.
- Phase 5 prüft diesen Teil beim Laden, benutzt wird er ab Phase 6. Die Namen der Felder legt das Schema fest, das mit der Richtlinie gebaut wird.

### Interaktiver Teil

- Ein Eintrag nennt Tools, eine Zielart, eine Kennung mit erwartetem Namen und `maxPerDay`, eine Pflichtangabe von 1 bis 1000 Vorgängen je Prinzipal und UTC-Tag. Zielarten sind Kategorie und Seite des Wikis, Kalender, Ressource und nur hier Gruppe und Dienst. Ein Dienst ist ein Paar aus der Kennung des Events und der des Dienstes, beide mit erwartetem Namen.
- Die Zähler liegen im `QuotaStore` je Prinzipal und Tag unter einem Schlüssel aus Tool, Zielart und Kennung. Sie überstehen einen Neustart und gelten für alle Prozesse mit demselben Zustandsordner.
- Ein Wunsch ausserhalb aller Einträge oder über `maxPerDay` geht in die Freigabe-Warteschlange, nicht in die Ablehnung, damit die Person handlungsfähig bleibt.
- Ein leerer oder fehlender interaktiver Teil heisst: erlaubt ist, was das Dienstkonto darf. Ausgenommen sind Gruppenmitgliedschaften und Dienstanfragen, die ohne Eintrag in die Freigabe-Warteschlange gehen. Operationen nach `operationId` gehen immer in die Freigabe-Warteschlange, weil `policy.v1` für sie keine Zielart kennt.
- Grenzen je Token kommen mit dem Betrieb über HTTP in Phase 7.

### Lesebudget

- `readBudgetPerDay` im interaktiven Teil, voreingestellt 200, von 0 bis 1000. Es gilt wie bisher gemeinsam für alle Tools mit `sensitivity: special` und alle, die Namen anderer Personen nennen, je Akteur und UTC-Tag (ADR 0063). 0 sperrt diese Tools für alle. Die Obergrenze verhindert, dass ein Tippfehler das Budget aufhebt. Einen Wert über 200 meldet `ecclium doctor`.

### Kennung mit erwartetem Namen

- Jedes Ziel ist eine Kennung mit dem Namen, den der Betreiber erwartet. Routinen nennen ihre Ziele über Namen und bleiben so zwischen Gemeinden übertragbar, die Richtlinie bindet sie an Kennungen.
- Der Kern vergleicht den Namen nach der Normalform NFC genau. Weicht er ab, weil jemand das Ziel umbenannt oder eine Kennung neu vergeben hat, ist das Schreiben auf dieses Ziel gesperrt, und der Wunsch geht mit dem Grund in die Freigabe-Warteschlange. Das Lesen trifft das nicht.
- `ecclium policy init --interactive` schlägt Einträge aus den Zielen vor, die das Audit gesehen hat, auf stdout zur Prüfung durch den Betreiber. `ecclium policy init` für Routinen folgt in Phase 6.
- Ab Phase 6 sperren eine solche Abweichung und zu weite Rechte des Dienstkontos im unbeaufsichtigten Lauf das Schreiben, nicht den Lauf, mit einer befristeten Ausnahme `accept-rights-drift` und einem Vermerk im Audit.

### Prüfcode

- **Form:** `k1:` und 13 Zeichen Base32 nach RFC 4648, gross und ohne Auffüllung, aus den ersten 64 Bit eines HMAC-SHA256.
- **Schlüssel:** aus `ECCLIUM_MARKER_KEY_FILE`, 32 Bytes als 64 Zeichen Hex, gelesen wie der Schlüssel der Pseudonyme ([ADR 0069](0069-stufe-strict.md)). Er wird gesichert und nicht vernichtet wie die Tagesschlüssel. Ein neuer Schlüssel macht alte Codes ungültig, die Abschnitte gelten dann als Änderung eines Menschen.
- **Eingabe:** Mandant, die Kennung der Routine oder «interaktiv», die Periode des Laufs oder der Tag und der SHA-256 der kanonischen Form des Abschnitts ohne die Zeile der Kennzeichnung, in einer festen Kodierung mit Längen.
- **Kanonische Form:** Der Abschnitt wird mit dem Lexer der ContentPolicy gelesen und mit ihrem Serialisierer für die erlaubte Teilmenge von Markdown neu geschrieben (ADR 0030, geplant). So zählen Zeichen vor Listenpunkten, Leerzeilen, die Ausrichtung von Tabellen und die Schreibweise eines Zeilenumbruchs nicht mehr (F13). Text, Überschriften, Hervorhebung und der Aufbau von Listen und Tabellen zählen. Ein Element ausserhalb der Teilmenge, etwa ein Link, den eine Person einfügt oder den der Editor aus einer nackten URL macht, ändert die kanonische Form. Ecclium selbst schreibt weder nackte URLs noch Links nach aussen.
- **Gültiger Code:** Der Abschnitt gilt als eigener. Ein zweiter Lauf derselben Periode ändert ihn oder lässt ihn stehen und verdoppelt ihn nie.
- **Kein oder ungültiger Code:** Der Abschnitt gilt nicht als eigener. Ein ungültiger Code zählt als Änderung eines Menschen, nicht als Fälschung: Der Wunsch geht mit dem Unterschied in die Freigabe-Warteschlange, und Ecclium ersetzt einen solchen Abschnitt nie. Ein gefälschter Abschnitt ohne gültigen Code unterdrückt den echten nicht (T10).
- **Verlorener Schlüssel:** Die Abschnitte gelten als «Herkunft unbekannt», und die betroffene Periode geht in die Freigabe-Warteschlange. `ecclium marker adopt` signiert mit dem Runner in Phase 6 nach einer Sichtprüfung neu.
- Ob ein zweites Speichern den Text erneut ändert, prüfen Schreibproben an der Testinstanz ([ADR 0049](0049-testumgebung.md)). Die Tests der kanonischen Form nutzen die Änderungen, die die Probe `06-wiki-editor-roundtrip` gezeigt hat.

### Kennzeichnung

- Eine neue Seite und ein angehängter Abschnitt tragen die Zeile immer am Ende, mit dem festen Wortlaut aus `brand/README.md`. Bei einem interaktiven Schreibvorgang steht «interaktiv» an der Stelle von Routine und Lauf: «Automatisch erstellt am 01.11.2026 durch Ecclium, interaktiv, Prüfcode k1:ABCDEFGHIJKLM. Rückfragen an [Verantwortliche Person].» Das Datum ist der UTC-Tag des Schreibvorgangs, derselbe wie in der Eingabe des Prüfcodes.
- «Rückfragen an» kommt aus einer Einstellung des Betreibers und geht durch die ContentPolicy. Sie ist Pflicht für das Schreiben im Wiki. Ohne sie legt Ecclium keine Seite an und hängt keinen Abschnitt an.
- Eine Änderung an bestehendem Text, Termine und Buchungen bekommen keine Zeile im Text. Bei Seiten hält ChurchTools fest, wer zuletzt geändert hat, bei Terminen und Buchungen prüfen das die Schreibproben, und das Audit hält jeden Aufruf fest.
- Derselbe Inhalt in kanonischer Form am selben Tag auf derselben Seite, interaktiv angehängt, gilt als Wiederholung und endet in `skipped`.

## Konsequenzen

- Neue Variablen sind `ECCLIUM_POLICY_FILE` und `ECCLIUM_MARKER_KEY_FILE`, dazu die Einstellung für «Rückfragen an». Sie kommen mit ihrem Bau in die Tabelle von [ADR 0055](0055-konfiguration-identitaet.md).
- `yaml` kommt als Laufzeitabhängigkeit ohne Herkunftsnachweis ins Produkt, gebündelt, mit der Prüfung durch eine Person bei jeder neuen Version.
- Der Prüfcode hängt am Serialisierer der ContentPolicy. Ändert sich dieser so, dass die kanonische Form eines Abschnitts anders ausfällt, bekommt der Code ein neues Präfix wie `k2:`, und `k1:` bleibt mit der alten Form prüfbar.
- Ein leerer interaktiver Teil lässt bestätigte Schreibvorgänge im Rahmen aller Rechte des Dienstkontos zu, ausser für Gruppen und Dienste. Das hält die Einrichtung einfach. Die Doku für Betreiber rät zu Einträgen und zu Schreibrechten des Kontos nur für die Ziele.
- **Restrisiken:**
  - Ändert ein Mensch einen Abschnitt, auch nur ein Wort, gilt er danach nicht mehr als eigener, und jeder weitere Wunsch für ihn geht in die Freigabe-Warteschlange.
  - Ändert ein zweites Speichern im Web-Editor den Text auf eine Weise, die die kanonische Form nicht ausgleicht, gilt ein unveränderter Abschnitt als geändert. Das zeigen erst die Schreibproben.
  - Der Code hat 64 Bit. Ein Versuch, ihn ohne Schlüssel zu erraten, gelingt mit einer Wahrscheinlichkeit von eins zu 2^64.
  - Wer den Schlüssel des Prüfcodes kennt, kann Abschnitte als eigene ausgeben. Er gehört zu den Geheimnissen, die nur der Betreiber verwahrt.
