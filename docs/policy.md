# Richtlinie

<!-- Erzeugt aus dem Schema im Kern. Ändern Sie den Code und rufen Sie pnpm docs:generate auf, nicht diese Datei. -->

Die Richtlinie legt fest, auf welche Ziele Schreibvorgänge von Ecclium gehen dürfen, wie oft je Tag, und wie viel ein Akteur je Tag lesen darf ([ADR 0032](adr/0032-richtlinie-und-pruefcode.md)). Eine Bestätigung allein genügt nicht: Ohne Grenze dürfte ein gestohlenes Token, ein kompromittierter Client oder ein Tool, das im Client auf «immer erlauben» steht, alles, was das Dienstkonto in ChurchTools darf.

Stand: Der Server liest die Richtlinie beim Start und nimmt das Lesebudget aus ihr. Ziele, Namen und Obergrenzen der Schreibvorgänge wendet der Write-Guard an, beim Planen und noch einmal unmittelbar vor dem Senden. Die Kontaktangaben nimmt die ContentPolicy, wenn sie einen Text prüft. Wo diese Seite sagt, ein Wunsch gehe an den Betreiber, legt der Server ihn in die Freigabe-Warteschlange, wo ihn der Betreiber mit `ecclium queue` sieht, freigibt oder abweist. Eine Freigabe mit `ecclium queue approve` ersetzt, wofür die Richtlinie den Wunsch zum Betreiber schickte, einen fehlenden Eintrag, einen anderen Namen oder die erreichte Obergrenze, und der Schreibvorgang zählt trotzdem gegen die Obergrenze seines Eintrags. Ergibt erst die Prüfung unmittelbar vor dem Senden, dass ein schon bestätigter Wunsch an den Betreiber ginge, schreibt der Server nicht und lehnt mit `policy_denied` ab. Den unbeaufsichtigten Teil benutzt erst der Runner einer späteren Version, bis dahin schreibt Ecclium nur in einer Unterhaltung.

## Datei

- `ECCLIUM_POLICY_FILE` nennt den absoluten Pfad der Datei ([Konfiguration](configuration.md)). Die Datei ist kein Geheimnis und darf lesbar sein. Sie muss dem Benutzer gehören, unter dem Ecclium läuft, und Gruppe und andere Benutzer dürfen sie nicht ändern, etwa mit den Rechten 644. Ecclium folgt keinem Link.
- Das Format ist YAML 1.2 oder JSON in UTF-8 ohne BOM, höchstens 262'144 Bytes. Kommentare mit `#` sind erlaubt. Anker und Verweise, Tags, Direktiven wie `%YAML`, ein zweites Dokument, doppelte Schlüssel und Schlüssel, die kein Text sind, nimmt Ecclium nicht an.
- Ecclium liest die Datei beim Start, auch wenn der Server nur liest, weil das Lesebudget daraus kommt. Eine Änderung wirkt nach einem Neustart. `ecclium config check` prüft die Datei vorher und zeigt den Hash, die Zahl der Einträge und das Lesebudget.
- Ist etwas falsch, startet Ecclium nicht und endet mit dem Code 78. Die Meldung nennt den Pfad des Felds, etwa `interactive.targets[2].maxPerDay`, oder die Zeile, nie einen Wert.
- Sind `LOG_TOKENS` oder `LOG_STREAM` gesetzt, liest Ecclium die Datei nicht und startet nicht, weil die Bibliothek für YAML sie sonst nach stdout schriebe.
- Editoren prüfen und vervollständigen die Datei mit dem Schema [`schemas/policy.v1.json`](../schemas/policy.v1.json).

## Ohne Datei

Ohne `ECCLIUM_POLICY_FILE` gilt die Voreinstellung: keine Einträge und ein Lesebudget von 200 Aufrufen je Akteur und UTC-Tag. Bestätigte Schreibvorgänge dürfen dann auf jedes Ziel, das das Dienstkonto schreiben darf, ausser bei Gruppen und Diensten: Ohne Eintrag gehen sie wie jede Operation der schreibenden Escape Hatch an den Betreiber zur Freigabe. Das hält die Einrichtung einfach. Empfohlen sind Einträge für die Ziele, auf die Ecclium schreiben soll, und Schreibrechte des Dienstkontos nur für diese Ziele.

## Beispiel

Die Kennungen und Namen sind Platzhalter.

```yaml
# Richtlinie der Gemeinde, geprüft beim Start von Ecclium.
schema: policy.v1
interactive:
  readBudgetPerDay: 200
  targets:
    - target: { kind: wiki_category, id: 12, name: Berichte }
      tools: [ct_wiki_page_create, ct_wiki_page_append_section]
      maxPerDay: 10
    - target:
        kind: wiki_page
        categoryId: 12
        guid: 00000000-0000-4000-8000-000000000001
        name: Dienstplan-Auswertung
      tools: [ct_wiki_page_update]
      maxPerDay: 4
    - target:
        kind: service
        event: { id: 5, name: Gottesdienst }
        service: { id: 7, name: Technik }
      tools: [ct_services_request]
      maxPerDay: 5
  contacts:
    - sekretariat@example.org
    - +41 00 000 12 34
unattended:
  - routine: dienstplan-report
    credential: bericht
    modelRedaction: strict
    target:
      kind: wiki_page
      categoryId: 12
      guid: 00000000-0000-4000-8000-000000000001
      name: Dienstplan-Auswertung
    tools: [ct_wiki_page_append_section]
    maxPerRun: 2
    maxPerDay: 4
```

## Felder

| Feld | Form | Pflicht | Bedeutung |
| --- | --- | --- | --- |
| `schema` | `policy.v1` | ja | Format der Datei, immer `policy.v1`. Ohne diese Angabe oder mit einer anderen startet Ecclium nicht. |
| `interactive` | Objekt | nein | Der Teil für Schreibvorgänge, die eine Person über ihren KI-Assistenten bestätigt, und das Lesebudget. |
| `interactive.readBudgetPerDay` | ganze Zahl von 0 bis 1'000 | nein | Wie oft ein Akteur je UTC-Tag Tools mit besonders schützenswerten Daten und Tools, die Namen anderer Personen nennen, zusammen aufrufen darf. Ohne Angabe 200, 0 sperrt diese Tools für alle. |
| `interactive.targets` | Liste mit höchstens 200 Einträgen | nein | Die Ziele, auf die bestätigte Schreibvorgänge gehen dürfen. Ohne Eintrag ist erlaubt, was das Dienstkonto darf, ausser bei Gruppen und Diensten. Mit einem Eintrag ist die Liste abschliessend. |
| `interactive.targets[].target` | Ziel | ja | Das Ziel, siehe «Ziele». |
| `interactive.targets[].tools` | Liste mit 1 bis 20 Einträgen | ja | Die Schreib-Tools, die auf das Ziel schreiben dürfen, mit ihrem Namen wie `ct_wiki_page_create`. |
| `interactive.targets[].maxPerDay` | ganze Zahl von 1 bis 1'000 | ja | Wie oft je Prinzipal und UTC-Tag jedes dieser Tools auf das Ziel schreiben darf. |
| `interactive.contacts` | Liste mit höchstens 100 Einträgen | nein | Die Kontaktangaben der Gemeinde, die ein Text stehen haben darf, den Ecclium schreibt: E-Mail-Adressen, Telefonnummern, IBAN und AHV-Nummern, je ein Wert. Jede andere solche Angabe lehnt die ContentPolicy ab. Ohne Eintrag steht keine. Eine E-Mail-Adresse gilt ohne Gross und Klein, eine Nummer nur mit ihren Ziffern, Buchstaben und einem führenden `+`, so dass `000 000 12 34` und `000-000-12-34` gleich sind, `+41 00 000 12 34` aber nicht. Einen Wert nur aus Ziffern setzen Sie in Anführungszeichen, sonst liest YAML ihn als Zahl. |
| `interactive.inquiriesTo` | Text von 1 bis 200 Zeichen ohne Steuerzeichen | nein | Wen man bei Fragen erreicht, etwa `Sekretariat, sekretariat@example.org`. Der Text steht am Ende der Zeile, mit der jede Seite und jeder Abschnitt endet, die Ecclium im Wiki hinzufügt: «Automatisch erstellt am 05.11.2026 durch Ecclium, interaktiv, Prüfcode k1:ABCDEFGHIJKLM. Rückfragen an Sekretariat, sekretariat@example.org.». Er ist Klartext in einer Zeile ohne Steuerzeichen, Links und Adressen von Websites, ohne `<` vor einem Buchstaben, `/`, `!` oder `?`, ohne Zeichenreferenzen wie `&amp;` und ohne die Zeichen `[`, `]`, `` ` `` und `\`, und eine E-Mail-Adresse oder Telefonnummer darin muss auch unter `interactive.contacts` stehen. Ohne ihn legt Ecclium keine Seite an und hängt keinen Abschnitt an. Nennen Sie eine Stelle statt einer Person, wenn Sie keinen Namen im Wiki wollen. |
| `unattended` | Liste mit höchstens 200 Einträgen | nein | Der Teil für Routinen, die ohne Person laufen. Ecclium prüft ihn beim Start, benutzt wird er erst mit dem Runner einer späteren Version. |
| `unattended[].routine` | Text nach festem Muster, höchstens 63 Zeichen | ja | Kennung der Routine, etwa `dienstplan-report`. |
| `unattended[].credential` | Text nach festem Muster, höchstens 63 Zeichen | ja | Name der Zugangsdaten, mit denen der Runner für diese Routine schreibt, damit er das engste passende Dienstkonto nimmt. |
| `unattended[].modelRedaction` | `strict` oder `standard` | nein | Stufe der Maskierung für den Aufruf des Sprachmodells der Routine: `strict`, die Voreinstellung, oder `standard`. Für dieselbe Routine überall gleich. |
| `unattended[].target` | Ziel | ja | Das Ziel, siehe «Ziele». Gruppen und Dienste gibt es hier nicht. |
| `unattended[].tools` | Liste mit 1 bis 20 Einträgen | ja | Die Schreib-Tools, mit denen die Routine auf das Ziel schreiben darf. |
| `unattended[].maxPerRun` | ganze Zahl von 1 bis 100 | ja | Wie oft jedes dieser Tools je Lauf auf das Ziel schreiben darf, höchstens so oft wie je Tag. |
| `unattended[].maxPerDay` | ganze Zahl von 1 bis 1'000 | ja | Wie oft jedes dieser Tools je UTC-Tag auf das Ziel schreiben darf. Läufe von Hand zählen mit. |

Jeder Teil hat höchstens 200 Einträge, jeder Eintrag 1 bis 20 Tools.

## Ziele

Ein Ziel ist immer eine Kennung mit dem Namen, den Sie erwarten, nie der ganze Mandant.

| Art | Was | Teil | Was ein Eintrag erlaubt |
| --- | --- | --- | --- |
| `wiki_category` | Kategorie des Wikis | beide | Neue Seiten in der Kategorie und Änderungen an jeder ihrer Seiten. |
| `wiki_page` | Seite des Wikis | beide | Nur diese Seite. Ein Eintrag für die Seite geht dem ihrer Kategorie vor. |
| `calendar` | Kalender | beide | Neue Termine im Kalender und Änderungen an seinen Terminen. |
| `resource` | Ressource | beide | Buchungen der Ressource. |
| `group` | Gruppe | nur `interactive` | Mitglieder der Gruppe hinzufügen oder entfernen. |
| `service` | Dienst eines Events | nur `interactive` | Anfragen für diesen Dienst in diesem Event. |

| Feld des Ziels | Form | Bedeutung |
| --- | --- | --- |
| `kind` | eine Art aus der Tabelle oben | Art des Ziels, siehe die Tabelle. |
| `id` | ganze Zahl von 1 bis 2'147'483'647 | Kennung des Ziels in ChurchTools. |
| `name` | Text von 1 bis 255 Zeichen ohne Steuerzeichen | Der Name, den Sie erwarten: Titel der Seite oder Name des Ziels in ChurchTools. |
| `categoryId` | ganze Zahl von 1 bis 2'147'483'647 | Kennung der Kategorie, in der die Seite liegt. |
| `guid` | Text nach festem Muster, höchstens 36 Zeichen | GUID der Seite, wie `ct_wiki_pages_list` sie zeigt. |
| `event` | Objekt | Das Event, zu dem der Dienst gehört. |
| `event.id` | ganze Zahl von 1 bis 2'147'483'647 | Kennung des Events. |
| `event.name` | Text von 1 bis 255 Zeichen ohne Steuerzeichen | Der Name des Events, den Sie erwarten. |
| `service` | Objekt | Der Dienst im Event. |
| `service.id` | ganze Zahl von 1 bis 2'147'483'647 | Kennung des Dienstes. |
| `service.name` | Text von 1 bis 255 Zeichen ohne Steuerzeichen | Der Name des Dienstes, den Sie erwarten. |

## Regeln

- **Name:** Ecclium vergleicht den erwarteten Namen in der Normalform NFC genau mit dem Namen in ChurchTools. Weicht er ab, weil jemand das Ziel umbenannt oder eine Kennung neu vergeben hat, schreibt Ecclium nicht auf dieses Ziel, und der Wunsch geht an den Betreiber. Das Lesen trifft das nicht.
- **Abschliessend:** Hat `interactive.targets` einen Eintrag, darf ein bestätigter Schreibvorgang nur noch auf die genannten Ziele mit den genannten Tools. Jeder andere Wunsch und jeder über `maxPerDay` geht an den Betreiber, statt abgelehnt zu werden, damit die Person handlungsfähig bleibt.
- **Gruppen und Dienste:** Mitgliedschaften in Gruppen und Anfragen für Dienste betreffen Personen. Ohne Eintrag gehen sie an den Betreiber, und Routinen schreiben sie nie. Operationen der schreibenden Escape Hatch gehen immer an den Betreiber, weil die Richtlinie für sie keine Art von Ziel kennt.
- **Zähler:** Die Zähler je Tag liegen im Zustandsordner, überstehen einen Neustart und gelten für alle Prozesse mit demselben Ordner. Beim Planen liest Ecclium den Zähler, und steht er schon bei `maxPerDay`, geht der Wunsch an den Betreiber, damit niemand einen Vorgang bestätigt, der nicht mehr geht. Gezählt wird beim Festschreiben unmittelbar vor dem Senden. Ein gezählter Vorgang, der danach scheitert, bleibt gezählt, ein abgelehnter Name zählt nicht. Ohne Zustandsordner lässt sich nicht zählen, dann geht jeder Wunsch auf ein Ziel mit Eintrag an den Betreiber.
- **Widersprüche:** Dasselbe Ziel mit zwei Namen, dasselbe Tool zweimal für ein Ziel im selben Teil, `maxPerRun` über `maxPerDay` oder zwei Stufen von `modelRedaction` für eine Routine verhindern den Start.

## Vorschlag aus dem Audit

`ecclium policy init --interactive` schlägt den interaktiven Teil aus den Audit-Dateien im Zustandsordner vor. Der Befehl ändert keine Datei.

- **Ziele:** je Kategorie des Wikis, die das Audit in einer Zeile eines Schreib-Tools im interaktiven Modus nennt, ein Eintrag mit den Tools, die das Audit dort zeigt, auch bei abgelehnten Versuchen, denn gerade ein Ziel ohne Eintrag soll der Vorschlag zeigen. Ein Schreibvorgang auf eine Seite, den der Write-Guard geplant hat, nennt ihre Kategorie. Ein Eintrag, den das Audit nur aus abgelehnten oder übersprungenen Versuchen kennt, trägt darüber einen Kommentar: Entscheiden Sie, ob Ecclium dort schreiben soll.
- **Grenze:** `maxPerDay` ist das Doppelte des höchsten Tageswerts eines Tools, mindestens 5 und höchstens 1'000. Abgelehnte und übersprungene Aufrufe zählen nicht, jeder andere schon, auch ein gescheiterter. `readBudgetPerDay` übernimmt der Vorschlag aus der Richtlinie, die gilt.
- **Namen:** Der Befehl fragt ChurchTools mit `ct_wiki_categories_list` über dieselbe Pipeline wie der Server. Dafür muss das Toolset `wiki` eingeschaltet sein. Seine Aufrufe laufen im Modus `operator`, stehen in einer eigenen Audit-Datei und verbrauchen kein Lesebudget. Nennt das Audit keine Kategorie, fragt er ChurchTools nicht.
- **Ausgabe:** YAML auf stdout. Ein Name steht in doppelten Anführungszeichen, jedes Zeichen ausser ASCII, Umlauten und «» ‹› als Escape von YAML, damit das Terminal nichts verändert und der Lader den Namen genau zurückliest. Eine Kategorie, die ChurchTools dem Konto nicht nennt, deren Name die Richtlinie nicht annimmt oder deren Name verändert ankam, weil Ecclium unsichtbare Zeichen entfernt oder in der Stufe `strict` einen Teil maskiert hat, steht nur als Kommentar. Fällt so jede Kategorie heraus, steht statt einer leeren Liste ein Platzhalter darin, und Ecclium nimmt die Datei erst an, wenn Sie die Ziele von Hand eintragen, denn eine leere Liste erlaubte jeden bestätigten Schreibvorgang. Die Ziele stehen vor dem Lesebudget, damit eine abgeschnittene Ausgabe keine Datei ergibt, die Ecclium annimmt.
- **Prüfen:** Leiten Sie die Ausgabe in eine Datei um, etwa mit `ecclium policy init --interactive > richtlinie.yaml`, prüfen Sie jeden Eintrag und setzen Sie die Datei dann mit `ECCLIUM_POLICY_FILE` ein.
- **Exit-Codes:** 0, wenn der Vorschlag geschrieben ist, 64 ohne `--interactive`, 66 ohne Ordner `audit`, 69, wenn ChurchTools keine Namen gibt, 74, wenn Dateien nicht ganz lesbar waren oder der Vorschlag stdout nicht ganz erreichte, und 78 für eine ungültige Konfiguration, einen fehlenden Zustandsordner oder ein ausgeschaltetes Toolset `wiki`.

## Hash

Ecclium bildet den SHA-256 über die geprüfte Richtlinie in einer festen Form: Voreinstellungen eingesetzt, Namen in NFC, GUIDs in Kleinbuchstaben und die Schlüssel sortiert. Kommentare und die Schreibweise eines Werts ändern ihn nicht, die Reihenfolge der Einträge schon. Ohne Datei gilt der Hash der Voreinstellung. `ecclium config check` zeigt ihn, und die Zeile jedes Aufrufs eines schreibenden Tools im Audit nennt ihn als `policyHash`, auch die eines abgelehnten. So lässt sich später sagen, unter welcher Richtlinie ein Schreibvorgang lief.
