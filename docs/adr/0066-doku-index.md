# ADR 0066: Doku-Index: Fakten, Bau und Suche, Toolset `docs`

- Status: Vorgeschlagen
- Datum: 29.10.2026
- Fällt vor: Phase 3

## Kontext

[ADR 0027](0027-inhalte-des-doku-index.md) legt fest, was in den Index der Dokumentation kommt: Fakten aus dem OpenAPI-Dokument, Fakten zu den Rechten und der aufbereitete Text frei zugänglicher Hilfeseiten der Academy, nie eine Rohquelle. Offen ist, in welcher Form diese Inhalte im Repository liegen, wie daraus der Index entsteht, wie der Server darin sucht und welche Prüfungen verhindern, dass etwas hineinkommt, das nicht hineingehört. Die Befunde in [`churchtools-docs.md`](../research/churchtools-docs.md) zeigen, womit zu rechnen ist:

- Jede der 851 Operationen an ChurchTools 3.138 trägt eine eigene `operationId`. 5 tragen die Erweiterung `x-internal`, 12 sind veraltet (D3).
- Ohne Leerzeichen ist das Dokument 11,7 MiB gross, die Schemas allein 4,7 MiB (D7). Der Text der Hilfeseiten aus ADR 0027 liegt bei rund 500 KiB (D11). Der Index soll im Paket unter 5 MB bleiben.
- Das Dokument nennt als Version 0.1.0, die Instanz meldet 3.138 (D2).
- Beispiele und Vorgaben im Dokument nennen Hosts, einer davon unter `church.tools`, Beschreibungen nennen andere Hosts (D6). Hilfeseiten verlinken auf Instanzen unter `church.tools` und nennen solche Hosts auch im Text (D14).
- Die Rechtedefinitionen verlangen `administer persons` und enthalten Werte der Instanz, das Dienstkonto bekam 403 (D8). `GET /api/permissions/global` nennt dagegen jedes Recht mit Modul, Namen und Art des Werts, auch ein Recht ohne Wert (F30 in [`churchtools-api.md`](../research/churchtools-api.md)), aber ohne Bezeichnung. Am 29.10.2026 hat der Maintainer entschieden, dass das Dienstkonto kein weiteres Recht bekommt (ADR 0027, Umsetzung).
- Gebaut wird das Repository mit `tsc -b`. Tests laufen immer aus dem Quelltext, nie gegen einen früheren Bau ([ADR 0022](0022-paketzuschnitt.md)). Skripte unter `scripts/` nutzen nur, was Node.js mitbringt ([ADR 0020](0020-werkzeugkette.md)).
- Für die Suche war MiniSearch 7.2.0 vorgesehen: MIT, ohne Abhängigkeiten und alt genug. Keine seiner Versionen trägt aber einen Herkunftsnachweis oder stammt von einem vertrauenswürdigen Herausgeber (Registry von npm, abgefragt am 29.10.2026), und `lockfile-provenance` würde sie zurückweisen ([ADR 0050](0050-token-der-mise-action.md), Entscheid aus ADR 0021).
- Code der Pakete hält keinen Zustand auf Modulebene, und Zustand zwischen Anfragen gibt es nur in benannten Ports und zwei benannten Ausnahmen ([ADR 0051](0051-zustand-zwischen-anfragen.md)).

## Optionen

Suche:

1. **MiniSearch:** bewährt, mit Suche nach dem Anfang eines Worts und mit Unschärfe. Eine Abhängigkeit zur Laufzeit im Produktpaket ohne Herkunftsnachweis, und die Form der Serialisierung gehört der Bibliothek.
2. **Eigene kleine Suche:** einige hundert Zeilen mit Tests, ohne Abhängigkeit, Serialisierung und Reproduzierbarkeit ganz in eigener Hand. Weniger Funktionen, und ihre Fehler sind die eigenen.

Index:

1. **Im Repository:** Jede Änderung der Fakten zieht eine grosse erzeugte Datei mit, die keine Durchsicht ernsthaft liest.
2. **Beim Start aus den Fakten:** nichts Erzeugtes, aber jeder Start baut neu, und die Grenze für das Paket misst nicht, was ausgeliefert wird.
3. **Beim Bau aus den Fakten:** Der Bau erzeugt eine Datei, die nicht im Repository liegt und reproduzierbar sein muss.

## Entscheid

Gewählt sind die eigene Suche, entschieden vom Maintainer am 29.10.2026, und der Bau des Index beim Bau des Repositorys.

- **Fakten:** Drei Dateien unter `packages/docs-index/data/`, `operations.json`, `rights.json` und `academy.json`, dazu `SOURCES.json`. Sie entstehen mit `pnpm docs:refresh` aus den Quellen, nie von Hand. Jede Datei hat einen Kopf mit ihrem Format (`ecclium.docs.operations.v1` und so weiter), ihrer Quelle und einem Hinweis auf deren Bedingungen nach ADR 0027, dann die Einträge, sortiert nach ihrem Schlüssel. Sie liegen in kanonischer Form: JSON mit zwei Leerzeichen Einzug, die Felder in der Reihenfolge des Formats, ein Zeilenende am Schluss. Prettier fasst sie nicht an. Ein unbekanntes Feld ist ein Fehler.
  - **Operation**, Schlüssel `operationId`: Methode, Pfad, Tags, Kurzbeschreibung, Beschreibung, ob sie veraltet ist, Parameter mit Name, Ort, Pflicht, Schema und Beschreibung, Anfrage und Antworten mit Medientyp und Schema. Ein Schema reicht höchstens vier Schritte tief. Ein Schritt geht über `properties`, `items`, `additionalProperties`, `anyOf`, `oneOf` oder `allOf`, tiefer steht nur der Name des Schemas. Nie `servers`, `example`, `examples` oder `default`, weil sie Hosts und Werte tragen (D6). Operationen mit `x-internal` kommen nicht hinein: Sie sind nicht für Clients gedacht, und der generische Lesezugriff erreicht sie nicht. Veraltete kommen hinein, mit Vermerk. Alle übrigen kommen hinein, auch solche, die der generische Lesezugriff ausschliesst: Nachschlagen liest nichts aus ChurchTools.
  - **Recht**, Schlüssel Modul und Name: die Art des Werts, `boolean` oder `list`, aus `GET /api/permissions/global`, dazu wahlweise eine Bezeichnung mit dem Pfad der Hilfeseite, aus der sie stammt, und die Pfade der Hilfeseiten, die das Recht erklären. Nie ein Wert einer Instanz.
  - **Hilfeseite**, Schlüssel ihr Pfad auf der Academy (`/de/…`): Titel, Abschnitt, Wissensbasis, Tag der letzten Änderung und Text. Der Text ist einfaches Markdown mit Überschriften, Absätzen, Listen, Tabellen und Code, ohne HTML und ohne Bilder. Ein Link zeigt nur auf einen Pfad der Academy.
  - **`SOURCES.json`** nennt je Quelle die Abrufzeit in UTC und den SHA-256 der Rohquelle, beim OpenAPI-Dokument die Version des Dokuments und die der Instanz (D2), bei den Rechten die Version der Instanz und bei der Academy jede Seite mit Pfad und eigenem SHA-256. Einen Host nennt sie nicht. Eine Datei mit Einträgen braucht ihre Quelle, eine Quelle ihre Datei, und jeder Pfad der Academy in `rights.json` steht in `academy.json`.
- **Bau:** `pnpm build` ruft nach `tsc -b` den Einstieg `packages/docs-index/dist/build/main.js` auf. Er liest die Fakten, prüft sie und schreibt eine einzige Datei `packages/docs-index/dist/docs-index.json` mit Quellen, Fakten und je einem Suchindex für Operationen, Rechte und Hilfeseiten. Ihr Inhalt ist sortiert und enthält keinen Zeitstempel und keine Zahl mit Nachkommastellen, damit Zeitzone, Sprache und Reihenfolge der Eingabe ihn nicht ändern. Sie liegt nicht im Repository. Der Einstieg liegt im Paket und nicht unter `scripts/`, weil Skripte keine Pakete laden, und er schreibt nichts nach stdout.
- **Reproduzierbar:** `pnpm ci:check` baut nach `pnpm build` mit `scripts/ci/check-docs-index-build.mts` ein zweites Mal, in einem eigenen Prozess mit anderer Zeitzone und Sprache, und verlangt denselben SHA-256.
- **Grenzen, in Bytes:** die gebaute Datei höchstens 5'000'000, `operations.json` 2'500'000, `academy.json` 1'000'000, `rights.json` und `SOURCES.json` je 200'000. Darüber bricht der Bau ab. Reicht das nicht, ist der erste Hebel die Tiefe der Schemas, erst danach eine Grenze.
- **Suche:** Je Quelle ein invertierter Index über Felder mit Gewicht: bei Operationen `operationId`, Pfad, Tags, Kurzbeschreibung und, schwächer, Beschreibung, bei Rechten Modul, Name und Bezeichnung, bei Hilfeseiten Titel, Abschnitt und Text. Ein Wort entsteht nach NFKC in Kleinbuchstaben, ohne diakritische Zeichen, also «ä» wie «a», und mit «ss» für «ß». Wörter trennt alles, was weder Buchstabe noch Ziffer ist, und ein Grossbuchstabe nach einem Kleinbuchstaben, damit `getGroupsGroupIdMembers` zu «groups» und «members» führt. Wörter unter zwei Zeichen und eine kurze Liste von Füllwörtern zählen nicht. Bewertet wird nach BM25. Ein Suchwort trifft ein Wort des Index ganz, als dessen Anfang, ab vier Zeichen als dessen Teil, etwa «mitglieder» in «gruppenmitglieder», und ab fünf Zeichen mit einem Tippfehler, je mit kleinerem Gewicht. Bei gleicher Bewertung entscheidet der Schlüssel. Der Index speichert nur ganze Zahlen, die Mittelwerte für BM25 rechnet das Laden.
- **Laden:** `readDocsIndex()` liest die gebaute Datei, prüft sie mit zod und gibt ein eingefrorenes Objekt. Die Wurzel der Komposition ruft es einmal je Prozess auf und gibt das Ergebnis den Tools. Diese Daten sind unveränderlich, gleich für jeden Mandanten und ohne Bezug zu einer Anfrage. Sie sind deshalb kein Zustand zwischen Anfragen nach ADR 0051, so wenig wie der Code selbst. Auf Modulebene liegt nichts.
- **Ergebnis:** Jeder Treffer und jeder Abruf nennt die Quelle, den Titel oder die `operationId`, den Link oder Pfad und das Abrufdatum (ADR 0027). Beim OpenAPI-Dokument ist das der Pfad `/system/runtime/swagger/openapi.json` auf der eigenen Instanz, mit beiden Versionen, CC BY 4.0 und dem Hinweis, dass Ecclium das Dokument aufbereitet hat, bei der Academy der Link auf ihren Host. `docs-index` gibt nur Daten. Die Tools geben Namen von Operationen und Rechten mit der Datenklasse `none` aus und Texte mit `untrusted` im Datenumschlag (ADR 0024, ADR 0027).
- **Prüfungen,** alle in `pnpm check`, je mit Gegenprobe, über die echten Dateien und über synthetische Fakten aus `testkit`:
  - Format: Form, Reihenfolge, kanonische Schreibweise und die Bezüge zwischen den Dateien.
  - Grösse: jede Datei unter ihrer Grenze, ebenso ein Bau im Speicher, damit kein Test vom Bau abhängt.
  - Reproduzierbar: dieselben Fakten in anderer Reihenfolge ergeben dieselben Bytes.
  - Hosts: In Fakten, Index und `SOURCES.json` stehen als Host nur der Platzhalter `example.church.tools` und `churchtools.academy`, wie ADR 0027 es verlangt. Die Prüfung findet URLs mit Schema, Ziele mit `//`, E-Mail-Adressen, jeden Namen unter `church.tools`, Namen mit `www.` und Namen mit den Endungen `academy`, `at`, `ch`, `church`, `com`, `de`, `eu`, `io`, `li`, `net`, `org` und `tools`. E-Mail-Adressen sind nur mit dem Platzhalter `example.org` erlaubt. Jede Endung prüft sie nicht, weil sonst Pfade von Feldern wie `group.name` als Host gälten.
  - Rohquellen: kein OpenAPI-Dokument im ganzen Baum, keine HTML-Seite ausserhalb von `brand/`, das Markenpaket mit seinen Vorlagen in HTML, und kein HTML-Tag in einem Text der Fakten oder der gebauten Datei.
  - Namensnennung: jede Hilfeseite mit Titel und Pfad, jeder Treffer und jeder Abruf mit den Angaben oben.
  - Eine Meldung nennt Datei, Eintrag und Feld, nie den Wert, damit ein Fund nicht im öffentlichen Log von CI steht.
- **Orte:** `docsFacts` ist der Ordner der Fakten. `docsFiles` sind die einzigen Module in `docs-index`, die `node:fs` laden: das Laden der gebauten Datei und das Lesen und Schreiben beim Bau. Eine Regel von dependency-cruiser hält das (ADR 0022).
- **Toolset `docs`:** Die Doku-Tools bilden das Toolset `docs`. Es gehört zu `all`, voreingestellt ist es nicht. Damit gilt der Satz aus [ADR 0062](0062-toolsets.md) «`docs` und `api` gehören zu keinem Toolset, bis ein ADR sie zuordnet, und der Server bietet ihre Tools bis dahin nicht an» für `docs` nicht mehr. Für `api` gilt er weiter, bis das ADR zum generischen Lesezugriff entscheidet. Eingebaut wird `docs` mit den Doku-Tools.

## Konsequenzen

- Keine neue Abhängigkeit zur Laufzeit. Die Suche ist eigener Code mit eigenen Tests. Sie kennt keine Stammformen und keine Synonyme: «mitglied» findet «Gruppenmitglieder» über den Wortteil, «Teilnehmer» findet es nicht.
- Der Index liegt im gebauten Paket, nicht im Repository. Wer den Quellcode ohne Bau startet, hat keinen Index. Sobald das Produktpaket gebündelt wird, braucht der Bau einen Schritt, der die Datei mitnimmt (ADR 0022).
- Die Prüfung der Hosts ist eine Heuristik. Ein Name mit einer Endung ausserhalb der Liste, ohne Schema und ohne `www.`, etwa unter `.app`, fällt ihr nicht auf. Hosts unter `church.tools`, die auf eine Gemeinde zeigen können, findet sie immer, und gitleaks prüft sie zusätzlich ([ADR 0014](0014-oeffentlich-ab-dem-ersten-commit.md)).
- Die Prüfung auf Rohquellen erkennt ein OpenAPI-Dokument und eine HTML-Seite an ihrer Form. Ein umgeschriebenes Dokument sieht sie nicht, dagegen hilft nur die Durchsicht jeder Änderung an `data/`. Das gepackte Produktpaket prüft erst der Release, wenn es gebündelt wird.
- Ohne die Rechtedefinitionen tragen die Fakten zu den Rechten keine Bezeichnung aus ChurchTools selbst. Wo keine Hilfeseite ein Recht benennt, bleibt nur sein Name.
- Das Format ist v1. Solange dieses ADR vorgeschlagen ist, darf es sich mit den echten Daten noch ändern.
