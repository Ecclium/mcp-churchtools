# ADR 0027: Inhalte des Doku-Index, OpenAPI unter CC BY 4.0 und frei zugängliche Hilfeseiten der Academy mit Namensnennung und Link

- Status: Angenommen am 28.10.2026
- Datum: 28.10.2026
- Fällt vor: Phase 3

## Kontext

Phase 3 bringt einen Index der Dokumentation von ChurchTools ins Paket `docs-index`. Der KI-Assistent soll darin nachschlagen können, statt zu raten: welche Operation die API für ein Vorhaben hat, welches Recht sie verlangt und wie ChurchTools eine Funktion erklärt. Der Index liegt im Paket und braucht im Betrieb kein Netz. Was ins Repository und ins Paket kommen darf, hängt von den Rechten an den Quellen ab. Bis zu diesem Entscheid lag keine Kopie der Dokumentation im Repository, und geplant war ein Index nur mit Fakten und Fundstellen.

Die Quellen, Stand 28.10.2026:

- **OpenAPI-Dokument:** Jede Instanz liefert ihre API als OpenAPI-Dokument unter `/system/runtime/swagger/openapi.json`. Es nennt in `info.license` die Lizenz CC BY 4.0 ([`docs/research/churchtools-api.md`](../research/churchtools-api.md), Quellen). An ChurchTools 3.138 ist es rund 41 MB gross. Es kann den Host der Instanz tragen, etwa in `servers`, und Beispiele mit Werten. Ob die Version, die das Dokument nennt, immer die Version der Instanz ist, ist nicht geprüft.
- **CC BY 4.0:** Wer das Material weitergibt, auch verändert, behält nach Abschnitt 3(a)(1) die mitgelieferten Angaben zum Urheber, den Hinweis zum Urheberrecht, die Hinweise auf die Lizenz und auf den Ausschluss der Gewährleistung und, soweit zumutbar, den Verweis auf das Material. Er sagt, ob er es verändert hat, behält Hinweise auf frühere Änderungen und verweist auf die Lizenz, mit ihrem Text oder einem Link darauf. Nach Abschnitt 3(a)(4) darf bearbeitetes Material unter einer eigenen Lizenz stehen, wenn diese die Empfänger nicht daran hindert, CC BY 4.0 einzuhalten. Abschnitt 2(a)(5)(B) verbietet zusätzliche oder abweichende Bedingungen und technische Massnahmen, die die Rechte der Empfänger aus der Lizenz einschränken. Abschnitt 2(a)(6) erlaubt nicht, eine Verbindung zum Lizenzgeber oder seine Unterstützung zu behaupten oder nahezulegen.
- **Rechte:** `GET /api/permissions/definitions` nennt die Rechte einer Instanz mit Modul, Schlüssel und Bezeichnung, bisher nur von Hand beobachtet (`docs/research/churchtools-api.md`, Rechte). Welches Recht eine Operation verlangt, zeigt `GET /api/permissions/global` nicht (F29). Ob das OpenAPI-Dokument es nennt, ist offen. Belegte Zuordnungen stehen in den Befunden der Proben, in [ADR 0060](0060-leserechte-und-felder-der-suchtools.md) und in [ADR 0064](0064-leserechte-und-felder-der-lese-tools.md).
- **Academy:** Die ChurchTools Academy ist die öffentliche Website des Herstellers mit Hilfeseiten, Änderungsprotokollen und Kursen, auf Deutsch und Englisch. Die Hilfeseiten sind ohne Anmeldung lesbar und nach Abschnitten geordnet, darunter die Module, die Rechteverwaltung und Seiten zur API. Kurse verlangen eine Anmeldung. Die Fusszeile lautet «© 2024 ChurchTools - Alle Rechte vorbehalten» (gesehen am 28.10.2026).
- **Erlaubnis:** In einem Gespräch am 07.10.2026 hat ChurchTools dem Maintainer mündlich erlaubt, die frei zugängliche Dokumentation der Academy mit Namensnennung und Link zu nutzen. Schriftlich liegt die Erlaubnis nicht vor. Für die Seiten zur Rechteverwaltung gilt sie, soweit sie frei zugänglich sind.

## Optionen

Inhalte:

1. **Nur Fakten, wie bisher geplant:** Namen von Operationen, Parameter, Bezeichnungen der Rechte, eigene Kurzbeschreibungen und Fundstellen. Kein fremder Text im Repository und kaum ein Risiko. Der KI-Assistent bekommt aber keine Erklärung aus der Academy, und jede eigene Kurzbeschreibung ist Text, den das Projekt schreiben und mit jeder Version von ChurchTools prüfen muss.
2. **Fakten, eigene Kurzfassung und kurze Auszüge der Hilfeseiten, mit Link:** wenig fremder Text, das Risiko einer nur mündlichen Erlaubnis bleibt klein. Für Einzelheiten bleibt dem KI-Assistenten nur der Link.
3. **Fakten aus dem OpenAPI-Dokument und den Rechtedefinitionen, dazu die Texte der frei zugänglichen Hilfeseiten zu den Bereichen von Ecclium, zur Rechteverwaltung und zur API, mit Namensnennung und Link:** nutzt die Erlaubnis für das, was die Tools brauchen. Fremder Text liegt im Repository und im Paket, gestützt auf eine mündliche Erlaubnis.
4. **Alle frei zugänglichen Hilfeseiten:** deckt auch Bereiche ab, für die Ecclium keine Tools hat, etwa die Website oder die Verwaltung. Mehr Text, mehr Grösse und mehr fremder Inhalt, ohne Nutzen für die Tools.

Host der Academy:

1. **Im Repository:** als Konstante im Code, in den Links der Ergebnisse, in `SOURCES.json` und in `NOTICE`. Der Link, den die Erlaubnis verlangt, ist vollständig.
2. **Nur Pfade, den Host setzt der Betreiber:** kein Host im Repository. Ohne Einstellung fehlt aber der Link, und jeder Betreiber müsste denselben Wert eintragen.

## Entscheid

Gewählt sind die dritte Option zu den Inhalten und die erste zum Host.

- **Was hineinkommt:**
  - aus dem OpenAPI-Dokument ausgewählte Felder je Operation, etwa `operationId`, Methode, Pfad, Kurzbeschreibung, Parameter, Schemas in begrenzter Tiefe und ob sie veraltet ist;
  - aus den Rechtedefinitionen je Recht Modul, Schlüssel, Bezeichnung und die Art seines Werts;
  - aus der Academy der aufbereitete Text der frei zugänglichen Hilfeseiten auf Deutsch zu den Bereichen, für die Ecclium Tools hat (Personen, Gruppen, Events und Dienste, Kalender und Ressourcen, Wiki, Songs), zur Rechteverwaltung und zur API, mit Titel, Pfad, Abschnitt und Datum der letzten Änderung. Aufbereitet heisst: Text mit Überschriften und Listen, ohne Bilder, Navigation und Skripte der Seite. Ein Link im Text bleibt nur als Pfad auf der Academy, ein Link auf einen anderen Host fällt weg, und sein Linktext bleibt. Ein Host einer Instanz im Text, etwa in einem Beispiel, wird durch den Platzhalter `example.church.tools` ersetzt.
- **Was nie hineinkommt:** Seiten hinter einer Anmeldung, Kurse, Online-Seminare, Bilder, Videos und andere Medien, Forum, Blog, Änderungsprotokolle, die übrigen Abschnitte der Hilfe und Seiten in anderen Sprachen. Aus dem OpenAPI-Dokument weder `servers` noch Beispiele, aus den Rechtedefinitionen keine Werte einer Instanz, etwa Namen von Kategorien, weil sie einen Host oder Daten einer Instanz tragen können.
- **Rohquellen und Fakten:** Eine Rohquelle ist, was abgerufen wird: eine Seite der Academy als HTML, das OpenAPI-Dokument als Ganzes, die Antwort der Rechtedefinitionen. Fakten sind die ausgewählten und aufbereiteten Felder daraus, jedes mit seiner Fundstelle. Rohquellen liegen nie im Repository und nie im Paket, nur Fakten.
- **Host:** Ausser dem Platzhalter `example.church.tools` darf in Fakten, Index, `SOURCES.json` und `NOTICE` nur der öffentliche Host der Academy stehen, `churchtools.academy`. Er steht im Code als Konstante und in den Links der Ergebnisse. Kein Host einer Instanz, auch nicht einer Demo-Instanz des Herstellers. Ein Test lässt in Fakten und Index nur diese beiden zu. Dieses ADR nennt den Host, abweichend von der Regel aus [ADR 0001](0001-adrs-als-entscheidformat.md), Quellen ohne Host zu nennen, damit eindeutig ist, welcher gemeint ist. Für das OpenAPI-Dokument nennt ein Ergebnis statt eines Links den Pfad auf der eigenen Instanz.
- **Namensnennung:** Jedes Ergebnis, das Fakten oder Text aus einer Quelle zeigt, nennt die Quelle, den Titel der Seite oder die `operationId`, den Link oder den Pfad und das Abrufdatum. Beim OpenAPI-Dokument nennt es dazu die Version, CC BY 4.0 und dass Ecclium das Dokument aufbereitet hat. `NOTICE` nennt beide Quellen: für das OpenAPI-Dokument die Angaben, die `info` mitliefert, etwa Urheber, Hinweis zum Urheberrecht und Ausschluss der Gewährleistung, dazu CC BY 4.0 und den Hinweis auf die Bearbeitung; für die Academy den Hersteller, den Vorbehalt aller Rechte, die Erlaubnis und den Link. Den Text von CC BY 4.0 legt das Projekt als Datei `LICENSES/CC-BY-4.0.txt` bei, wie den Text der Apache License 2.0, statt auf einen weiteren Host zu verlinken.
- **Lizenz der Daten:** Die Fakten aus dem OpenAPI-Dokument sind bearbeitetes Material und stehen weiter unter CC BY 4.0, nicht unter der Elastic License 2.0. Die Texte der Academy stehen unter keiner Lizenz des Projekts, alle Rechte liegen beim Hersteller, und Ecclium gibt sie mit dessen Erlaubnis wieder. Jede Datei mit Fakten nennt ihre Quelle und deren Bedingungen selbst, und `NOTICE` nennt diese Dateien als Ausnahme von der Elastic License 2.0, wie die Schriften in `brand/fonts/` ([ADR 0058](0058-elastic-license-2-0.md)). Das gilt auch für die Texte der Academy, die keine Lizenz haben: Ihre Datei nennt stattdessen den Vorbehalt und die Erlaubnis.
- **Keine Verbindung:** Die Erlaubnis betrifft nur die Nutzung der Texte. Sie ist keine Partnerschaft und keine Prüfung, Unterstützung oder Empfehlung von Ecclium durch den Hersteller, und kein Text des Projekts stellt sie so dar. Die Namensnennung nennt die Quelle, nicht mehr.
- **Widerruf:** Nimmt der Hersteller die Erlaubnis zurück oder ändern sich die Bedingungen der Academy, erscheint die nächste Version ohne die Texte der Academy. Der Index fällt für die Academy auf Titel, Abschnitt und Link zurück. Nennt eine spätere Version des OpenAPI-Dokuments eine andere Lizenz, braucht es für Fakten aus dieser Version einen neuen Entscheid.

## Konsequenzen

- Der KI-Assistent kann Funktionen und Rechte mit den Worten des Herstellers erklären und nennt dabei die Quelle. Das Projekt schreibt keine eigenen Kurzfassungen der Hilfeseiten.
- Die Texte der Academy und die Beschreibungen im OpenAPI-Dokument sind fremde Inhalte aus dem Netz und können Anweisungen enthalten. Der Index behandelt sie wie Freitext aus ChurchTools und gibt sie im Datenumschlag aus. Die Einzelheiten legt ADR 0066 fest.
- Die Dokumentation kann einer Instanz voraus oder hinterher sein. `SOURCES.json` hält für jede Quelle Abrufzeit und SHA-256 fest, beim OpenAPI-Dokument die Version, die das Dokument nennt, und die Version, die die Instanz meldet. Jedes Ergebnis nennt das Abrufdatum.
- Die Texte der Academy holt ein Skript, das lokal läuft und nicht in CI, mit Pausen zwischen den Abrufen und unter Beachtung von `robots.txt`.
- Wer Ecclium weitergibt, gibt die Fakten aus dem OpenAPI-Dokument unter CC BY 4.0 weiter. Ob Dritte auch die Texte der Academy weitergeben dürfen, ist offen (Restrisiken). Wenn, dann nur mit Namensnennung und Link, so wie Ecclium sie erhalten hat. Mehr Rechte, als es selbst hat, kann das Projekt nicht einräumen.
- Das Feld `license` der Pakete nennt weiter `Elastic-2.0`, und `NOTICE` nennt die Ausnahmen. Ob das Feld sie selbst ausdrücken muss, etwa als `Elastic-2.0 AND CC-BY-4.0`, klärt die juristische Prüfung vor dem ersten Release (ADR 0058).
- **Restrisiken:**
  - **Nur mündlich:** Die Erlaubnis für die Texte der Academy liegt nur mündlich vor. Was im öffentlichen Repository steht, bleibt in der Versionsgeschichte, auch nach einem Widerruf ([ADR 0014](0014-oeffentlich-ab-dem-ersten-commit.md)), und veröffentlichte Pakete lassen sich nur in engen Grenzen zurückziehen. Eine schriftliche Bestätigung vor dem ersten Release würde das Risiko verkleinern, sie ist aber keine Vorbedingung.
  - **Reichweite:** Ob die Erlaubnis auch Dritte deckt, die Ecclium oder einen Fork weitergeben, ist nicht geklärt. Eine schriftliche Bestätigung sollte das einschliessen.
  - **Vorbehalt:** Die Website behält alle Rechte vor. Die Erlaubnis ist eine Ausnahme davon, kein öffentlicher Text des Herstellers, und nur der Maintainer kann sie belegen.

## Umsetzung

- **Quelle der Rechte,** entschieden vom Maintainer am 29.10.2026: Der Index liest die Rechtedefinitionen nicht. `GET /api/permissions/definitions` verlangt laut OpenAPI-Dokument `administer persons` in `churchcore`, ein Recht der Verwaltung von Personen, und enthält Werte der Instanz. Das Dienstkonto des Servers bekam darauf 403 und bekommt dieses Recht nicht ([`churchtools-docs.md`](../research/churchtools-docs.md), D8). Anders als im Entscheid oben kommen Modul, Name und Art des Werts jedes Rechts deshalb aus `GET /api/permissions/global`, das das Dienstkonto schon liest und das jedes Recht auch ohne Wert nennt ([`churchtools-api.md`](../research/churchtools-api.md), F30). Bezeichnungen und Erklärungen kommen aus den frei zugänglichen Hilfeseiten der Rechteverwaltung, jede mit dem Pfad ihrer Seite als Fundstelle. Welche Operation welches Recht verlangt, ordnet das Projekt von Hand zu, mit Belegen. Das Format legt [ADR 0066](0066-doku-index.md) fest.
