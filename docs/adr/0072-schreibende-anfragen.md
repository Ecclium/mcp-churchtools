# ADR 0072: Schreibende Anfragen an ChurchTools

- Status: Vorgeschlagen
- Datum: 01.11.2026
- Fällt vor: Phase 5
- Ergänzt: [ADR 0056](0056-ausgehender-weg.md) und [ADR 0057](0057-lesender-churchtools-client.md)

## Kontext

Mit Phase 5 schreibt Ecclium in ChurchTools: Seiten im Wiki, Termine und Buchungen ([ADR 0071](0071-grenze-zwischen-kern-und-pro.md)). Schreiben darf nur der Kern, nach Plan, Bestätigung und mit einem Nachweis ([ADR 0029](0029-write-guard.md)). Der ausgehende Weg aus ADR 0056 kennt aber nur GET, und der Client aus ADR 0057 nur lesende Operationen. Festzulegen ist, wie Transport und Client schreiben, ohne eine Prüfung des Lesens zu lockern, und was der Write-Guard von ihnen bekommt: die Schreibvorgänge selbst und das Lesen unmittelbar davor und danach.

Folgende Entscheide, Bedrohungen und Befunde geben den Rahmen vor:

- **ADR 0029:** Der Write-Guard liest unmittelbar vor dem Schreiben, vergleicht Version und die Uhr mit dem `Date`-Header und liest danach, ob die neue Version genau auf die alte folgt. `DELETE` braucht der ausgehende Weg nur, um einen Termin oder eine Buchung zurückzunehmen, die Ecclium angelegt hat.
- **Nicht-Ziele:** Ecclium löscht in Version 1 keine Personen, Gruppen und Seiten des Wikis und schreibt kein HTML ins Wiki.
- **Threat Model:** T4 (ein Login-Token fliesst ab), T9 (das Fenster zwischen Lesen und Schreiben), T12 (Daten fliessen an eine beliebige Adresse ab).
- **Befunde** in [`docs/research/churchtools-api.md`](../research/churchtools-api.md):
  - F12: Mit einem Login-Token braucht eine schreibende Anfrage kein CSRF-Token und kein Cookie. `POST` antwortete mit 201, `PATCH` mit 200, `DELETE` mit 204.
  - F16: `POST /api/wiki/categories/{id}/pages` mit `isMarkdown` auf wahr legt eine Markdown-Seite an, ohne das Feld eine Seite ohne Markdown. Die Antwort 201 trägt die Seite unter `data`, mit `guid` und `version`.
  - F10 und F11: Die Version einer Seite steigt mit jeder Änderung des Texts, ein `PATCH` ohne Änderung lässt sie stehen. Eine Bedingung gegen Überschreiben nimmt die API nicht an.
  - F8 und «Titel einer Seite»: Ein zweites `POST` mit dem Titel einer Seite derselben Kategorie ergibt 400. Den Titel ändert ein `PATCH` nicht.
  - F22: Jede geprüfte Antwort trug einen `Date`-Header, auch die auf schreibende Anfragen.
  - F41 bis F48: Bei Terminen und Buchungen ersetzt `PUT` den ganzen Eintrag, `version` beginnt bei 0 und steigt mit jedem `PUT`, ein gelöschter Termin liest mit 404, eine gelöschte Buchung mit 500. Eine neue Buchungsanfrage und ihre erste Änderung schicken den Verwaltern der Ressource eine Mail (F48).
- **OpenAPI-Dokument an ChurchTools 3.138:** Beim Anlegen einer Seite kürzt ChurchTools den Titel um Leerraum an beiden Enden und schreibt eine Ellipse «…» als drei Punkte. Beim Ändern löscht ein Text, der nach dem Kürzen leer ist, den Inhalt der Seite. Für beide Operationen nennt es das Recht, die Kategorie zu bearbeiten.
- **undici 8.12.2**, geprüft am 01.11.2026 im Quelltext: Schliesst sich eine Verbindung, während eine Anfrage auf ihre Antwort wartet, meldet der Pool diese Anfrage als Fehler. Erneut sendet er nur Anfragen, die er noch nicht geschrieben hat. Als wiederholbar gelten nur `GET`, `HEAD` und `QUERY`, und eine Anfrage, die nicht wiederholbar ist, wartet, bis auf ihrer Verbindung nichts anderes läuft. Schliesst sich die Verbindung vor den Kopfzeilen der Antwort, meldet der Transport die Kategorie `connect`, ob die Anfrage den Server erreicht hat oder nicht.

## Optionen

1. **Ein zweiter Transport für Schreibvorgänge:** klar getrennt, aber ein zweiter Pool und eine zweite Positivliste je Origin, und Lesen und Schreiben zählten nicht unter derselben Drosselung.
2. **Eine allgemeine Methode `request(method, …)` im Transport:** wenig Code, aber jeder Aufrufer wählt die Methode selbst, und Regeln je Methode stehen nur als Bedingungen in einem Pfad.
3. **Benannte Methoden je Verb über einen gemeinsamen inneren Weg:** `get`, `post`, `put`, `patch` und `delete` laufen durch dieselben Prüfungen, und jede Methode trägt ihre eigenen Regeln.

## Entscheid

Gewählt ist die dritte Option.

### Transport (ergänzt ADR 0056)

- **Fünf Methoden, ein Weg:** Der Transport ist ein eingefrorenes Objekt aus `get`, `post`, `put`, `patch`, `delete`, `close` und `destroy`. Alle fünf Methoden gehen durch dieselbe innere Funktion, mit denselben Prüfungen von Ziel, Grenze und Signal, denselben Kopfzeilen, Fristen, Grenzen der Antwort, der Warteschlange vor dem Pool und denselben Kategorien der Fehler wie GET. Für GET ändert sich nichts.
- **Körper:** `post`, `put` und `patch` verlangen einen Körper, `get` und `delete` nehmen keinen. Der Körper ist ein echtes `Uint8Array` mit JSON in UTF-8, von 1 Byte bis 1 MiB (`maxRequestBytes`). Einen grösseren weist der Transport ab, bevor er etwas kopiert. Sonst kopiert er ihn beim Aufruf und zählt die Länge der Kopie, so dass eine spätere Änderung durch den Aufrufer nichts anderes sendet, und setzt dazu genau eine weitere Kopfzeile, `content-type: application/json`. Ein Körper, der das Token enthält, so wie es ist oder so, wie ein String in JSON es schreibt, wird abgewiesen, wie ein Token im Ziel. 1 MiB fasst einen Text von 64 KiB auch dann, wenn JSON jedes Zeichen sechsfach schreibt, und begrenzt doch, was ein Aufruf senden kann.
- **Keine Query beim Schreiben:** Eine schreibende Anfrage trägt ihre Werte im Körper. Ein Ziel mit Query weist der Transport bei `post`, `put`, `patch` und `delete` ab, die Prüfung nennt dafür den Code `target_write_query`. So gerät kein Wert eines Schreibvorgangs in das Zugriffsprotokoll eines Servers oder Proxys.
- **Ziele je Methode:** Jede schreibende Methode erreicht nur die Pfade der Vorhaben des Kerns. `POST` nur `/api/wiki/categories/{id}/pages`, `/api/calendars/{id}/appointments` und `/api/bookings`, `PATCH` nur `/api/wiki/categories/{id}/pages/{guid}`, `PUT` und `DELETE` nur `/api/calendars/{id}/appointments/{id}` und `/api/bookings/{id}`. Eine Kennung ist eine ganze Zahl ab 1 in Dezimalziffern ohne führende Null, eine GUID hat die Form aus ADR 0057. Jedes andere Ziel weist der Transport ab, die Prüfung nennt dafür den Code `target_write_path`. Selbst ein Fehler im Client kann so weder eine Person noch eine Gruppe ändern noch eine Seite des Wikis löschen. Welchen Termin und welche Buchung Ecclium zurücknimmt, entscheidet der Write-Guard, hier zählt nur die Form. Ein neues Vorhaben, auch eines des Pro-Moduls, braucht eine neue Form mit dem ADR, das es trägt.
- **Keine Wiederholung:** Der Transport wiederholt keine Anfrage, bei keiner Methode. Die Optionen des Pools setzen `pipelining: 1` ausdrücklich: Eine Verbindung trägt immer nur eine Anfrage, und eine Verbindung, die sich schliesst, beendet die Anfrage, die sie trägt, mit einem Fehler, statt sie neu zu senden.
- **Ausgang nach einem Fehler:** Jede abgewiesene Prüfung endet mit der Kategorie `refused`, gleich welchen Code die Prüfung nennt. Nur `refused` belegt, dass nichts gesendet wurde. Nach jeder anderen Kategorie, auch nach `connect`, kann ChurchTools geschrieben haben. Der Write-Guard liest deshalb nach jedem solchen Fehler neu, bevor er entscheidet (ADR 0029). Der Transport ändert seine Kategorien dafür nicht, weil er nicht erkennt, ob eine Anfrage schon geschrieben war.
- **Protokoll:** `http_response` und `http_<kategorie>` tragen das Feld `method` mit einem der fünf Werte `GET`, `POST`, `PUT`, `PATCH` und `DELETE`. Der Logger nimmt nur diese fünf an, genau so geschrieben (ergänzt [ADR 0054](0054-secret-fehler-logger-audit.md)).

### Client (ergänzt ADR 0057)

- **Eine Stelle:** Die schreibenden Operationen gehören zum selben Client, nutzen denselben Weg und dieselbe Drosselung wie das Lesen und prüfen zuerst denselben Mandanten. Sie liegen gebündelt unter `client.writes`, damit eine Regel genau eine Stelle für den Write-Guard freigeben kann. Den Zugriff zum Lesen für die Tools baut die Pipeline aus dem Client ohne `writes`, so dass das Lesen eines Tools sie schon im Typ nicht erreicht.
- **Seite anlegen:** `createWikiPage` sendet `POST /api/wiki/categories/{id}/pages` mit genau `title`, `text` und `isMarkdown: true`. Erwartet wird 201. Aus der Antwort liest der Client nur `guid`, `title`, `version` und `isMarkdown` und gibt sie zurück. Weichen Titel oder Format vom Gesendeten ab, etwa weil ChurchTools eine Ellipse umschreibt, gibt er sie trotzdem zurück, statt mit einem Fehler zu enden, weil die Seite dann schon besteht. Der Write-Guard urteilt darüber. Fehlt eine GUID in der bekannten Form, endet der Aufruf mit `upstream`.
- **Seite ändern:** `updateWikiPage` sendet `PATCH /api/wiki/categories/{id}/pages/{guid}` mit genau `text`, nie `title` und nie `isMarkdown`. Erwartet wird 200. Den Körper der Antwort liest der Client nicht, weil keine Probe seine Form zeigt. Ob die Änderung angekommen ist, zeigt das Lesen danach.
- **Lesen für den Plan:** `wikiPageState` liest eine Seite wie `wikiPage` und gibt dazu die Zeit von ChurchTools aus dem `Date`-Header zurück, in Millisekunden. Gezählt wird nur die eine Form, die RFC 9110 vom Server verlangt, etwa `Sun, 01 Nov 2026 20:00:00 GMT`: Der Wert muss genau das sein, was `toUTCString` für diese Zeit schreibt. Jede andere Form und ein fehlender Header ergeben `null`, und dann schreibt der Write-Guard nicht. Mehr braucht der Plan nicht: `wikiPage` liefert Version und Text, `wikiPages` die Titel einer Kategorie.
- **Kein Löschen:** Der Client löscht keine Seite des Wikis und hat dafür keine Operation.
- **Eingaben:** Vor dem Mandanten und der Drosselung prüft der Client die Kategorie (ganze Zahl ab 1), die GUID (die Form aus ADR 0057), den Titel (1 bis 255 Zeichen, gezählt in UTF-16-Einheiten wie beim Lesen, ohne Steuerzeichen aus C0, C1 und DEL, ohne Leerraum am Anfang oder Ende, den ChurchTools entfernt, ohne einzelne Surrogate) und den Text (1 Byte bis 64 KiB in UTF-8, mehr als Leerraum, weil ein Text, der nach dem Kürzen leer ist, die Seite leert, ohne U+0000, ohne einzelne Surrogate). Sonst endet der Aufruf mit `validation` und einem festen Satz, ohne Anfrage. Die eigentliche Grenze für den Inhalt bleibt die ContentPolicy.
- **Status:** 401 ergibt `auth`, 403 `permission`, 404 `not_found` (Seite oder Kategorie fehlt), 429 `rate_limited` mit der Wartezeit aus `Retry-After`. Ein 400 beim Anlegen ergibt `conflict` mit dem Satz, dass in der Kategorie womöglich schon eine Seite mit diesem Titel steht (F12, «Titel einer Seite»). Ein 400 beim Ändern ergibt `internal` wie beim Lesen, weil der Client jede Eingabe vorher prüft. Jeder andere Status, auch ein anderer Status des Erfolgs, ergibt `upstream`. Den Körper einer Antwort mit einem anderen Status als dem des Erfolgs liest der Client nie.
- **Termine und Buchungen:** Was der Client dafür sendet, legt die Umsetzung dieses ADR mit den Tools für Termine und Buchungen fest, auf Grundlage von F41 bis F48. `put` und `delete` des Transports stehen dafür bereit.

### Vertragsabgleich und Probelauf

- `contract.json` beschreibt den Körper jedes Schreibvorgangs als geschlossenes Objekt, so wie der Client ihn sendet, und nennt den Status des Erfolgs. `scripts/contract/check.mts` vergleicht jedes gesendete Feld mit dem `requestBody` des Dokuments, nennt ein Feld, das das Dokument nicht oder mit einer anderen Typklasse deklariert, und eines, das es verlangt und der Client nicht sendet (`Pflicht nicht gesendet`). Die Antwort liest es für den Status, den der Eintrag nennt.
- `assertOnlyReads` in testkit zählt jede Anfrage ausser GET als Fehler. Ein Test eines Probelaufs zeigt damit, dass nichts geschrieben wurde.

## Konsequenzen

- Jede schreibende Anfrage geht durch die Prüfungen des Lesens und weitere eigene. Jede schreibende Methode erreicht nur die Pfade der Vorhaben des Kerns, `DELETE` nur Termine und Buchungen, und ein Wert eines Schreibvorgangs nie eine Query.
- Das Log zeigt die Methode jeder Anfrage. Wer prüfen will, ob Ecclium geschrieben hat, findet jede schreibende Anfrage, auch eine gescheiterte. Ein Beweis ist das Log nicht: Ein Tool schreibt über denselben Logger und könnte eine Zeile `http_response` hinzufügen, wenn auch keine entfernen. Was Ecclium geschrieben hat, hält die Audit-Datei fest ([ADR 0029](0029-write-guard.md)).
- Ein Schreibvorgang verbraucht einen Platz der Drosselung wie ein Lesen. Mit dem Lesen davor und danach kostet ein Schreibvorgang drei.
- **Restrisiken:**
  - **Ausgang unbekannt:** ChurchTools kennt keinen Schlüssel, der eine Wiederholung erkennt. Endet eine schreibende Anfrage mit einem Fehler nach dem Senden, zeigt nur das Lesen danach, ob sie gewirkt hat. Bei einer neuen Seite ohne bekannte GUID hilft nur ihr Titel oder die Kennzeichnung ([ADR 0032](0032-richtlinie-und-pruefcode.md)).
  - **Ruhende Verbindung:** Schliesst ChurchTools eine ruhende Verbindung genau dann, wenn eine schreibende Anfrage auf ihr beginnt, scheitert sie, auch wenn sie nicht angekommen ist. Das Lesen danach zeigt das, und die Person kann den Vorgang erneut anstossen.
  - **Token im Körper:** Die Prüfung findet das Token so, wie es ist, und so, wie JSON es schreibt. Gegen Code, der es absichtlich anders kodiert, schützt sie nicht.
  - **Status und Form beim Ändern:** Der Client liest die Antwort auf `PATCH` nicht. Ändert ChurchTools sie, fällt das nicht auf. Das Lesen danach prüft die Wirkung.

## Umsetzung

- **Transport:** `packages/core/src/http/transport.ts` mit der inneren Funktion `send`, den fünf Methoden, der Grenze `maxRequestBytes`, der Prüfung und Kopie des Körpers und `pipelining: 1` in den Optionen des Pools. `target.ts` mit `checkWriteTarget`, den Formen je Methode und den Codes `target_write_query` und `target_write_path`. Das Testdouble in `compose-mock.ts` zeichnet den Körper jedes Aufrufs als Text auf. `packages/core/src/http/*.test.ts` decken den Ordner weiter zu 100 Prozent ab. `tests/http-transport-tls.test.mts` zeigt am Server im Speicher, dass ein `POST`, nach dem der Server die Verbindung schliesst, genau einmal ankommt und mit `connect` endet.
- **Logger:** das Feld `method` in `packages/core/src/logger/fields.ts` (`httpMethods`, `isHttpMethod`), `logger.ts` und `catalog.ts`, `docs/log-events.md` neu erzeugt.
- **Client:** `packages/core/src/churchtools/wiki-writes.ts` mit `createWikiPage`, `updateWikiPage` und `wikiPageState`, `request.ts` mit `fetchRead` und `sendWrite`, `answer.ts` mit `statusFailure` und dem Status 201, `server-date.ts`, die Schemas `wikiPageCreatedSchema`, `wikiPageCreateBodySchema` und `wikiPageUpdateBodySchema` in `schemas.ts`. `client.ts` hängt die Schreibvorgänge unter `writes` an, `pipeline/read-api.ts` nimmt den Client ohne sie. Neue Ereignisse: `churchtools_wiki_page_create_status`, `…_create_refused`, `…_create_missing`, `churchtools_wiki_page_update_status`, `…_update_missing` und `churchtools_wiki_write_input_refused`. Die Tests stehen in `client-wiki-writes.test.ts`, `server-date.test.ts` und `answer.test.ts`.
- **Vertragsabgleich:** `contract.ts` und `contract.json` mit `wikiPageCreate` und `wikiPageUpdate`, `scripts/contract/check.mts` mit dem Vergleich der Körper, `scripts/spike/lib/spec.mts` mit `requestSchema`, die README des Skripts und Fälle in `tests/scripts/contract-check.test.mts`. Lauf am 01.11.2026 gegen das Dokument der Testinstanz an ChurchTools 3.138: Beide Operationen sind dokumentiert. Jedes Feld beider Körper ist mit derselben Typklasse deklariert, `title` verlangt das Dokument, und der Client sendet es. Ein Feld, das das Dokument verlangt und der Client nicht sendet, gibt es nicht. Die Antwort 201 deklariert `guid`, `title`, `isMarkdown` und `version` als Pflicht. Neue Abweichungen gibt es keine.
- **Rechte:** Die Zuordnung von Operationen zu Rechten nennt für beide Schreibvorgänge `churchwiki: edit category`, belegt mit dem Befund «Rechte zum Schreiben im Wiki» in `docs/research/churchtools-api.md` und für das Anlegen auch mit dem OpenAPI-Dokument ([ADR 0066](0066-doku-index.md), Umsetzung).
- **Probelauf:** `assertOnlyReads` in `packages/testkit/src/http-double/`.
- **Offen:** Die Regel, die `writes` nur dem Write-Guard freigibt, kommt mit dem Write-Guard im Kern. Die Operationen für Termine und Buchungen kommen mit ihren Tools, die Aufrufe von `delete` mit der Rücknahme.
