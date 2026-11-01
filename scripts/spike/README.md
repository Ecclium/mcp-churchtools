# API-Spike: Proben

Diese Skripte prüfen, wie sich die REST-API von ChurchTools bei einer echten Instanz verhält: Anmeldung mit einem Token, Rechte, Paginierung, Fehler, Wiki, Personen, Gruppen und die globale Suche. Sie geben nur die Struktur der Antworten und feste Wörter aus, nicht deren Inhalt. Die Ergebnisse fliessen in `docs/research/churchtools-api.md` ein.

Der Spike hat fünf Teile. Die Proben `00` bis `04` lesen nur, mit einem lesenden Dienstkonto. Die Proben `05` bis `07` laufen mit einem eigenen Schreibkonto und nur auf der Testinstanz mit synthetischen Daten aus ADR 0049: `05` und `07` schreiben in einen Schreibbereich des Wikis, `06` liest dort. Vor jeder dieser Proben prüft der Wächter der Testumgebung, ob die Instanz die Testinstanz ist und das Konto das enge Schreibkonto (siehe «Der Wächter der Testumgebung»). Die Probe `08` liest Personen, Gruppen und die globale Suche, mit dem Dienstkonto des Servers und ebenfalls nur auf der Testinstanz. Personen und Gruppen sind Daten besonderer Kategorien. Vor `08` prüft deshalb ein eigener Wächter, ob die Instanz die Testinstanz ist und das Konto nur die erlaubten Leserechte hat (siehe «Der Wächter für Personendaten»). Die Probe `09` liest hinter demselben Wächter Kalender, Termine, Events, Dienste, Abläufe, Ressourcen, Buchungen und Lieder, dazu die Suche im Wiki und die globale Suche. Auch diese Antworten nennen Personen, etwa wer einen Dienst tut oder eine Buchung angelegt hat. Für `09` lässt der Wächter zusätzlich die Leserechte auf diese Bereiche zu (siehe «Was die Probe für die Bereiche tut»). Die Probe `10` prüft die Quellen des Index der Dokumentation: das OpenAPI-Dokument, die Rechtedefinitionen und die öffentlichen Hilfeseiten von ChurchTools, die Academy. Sie läuft mit dem Dienstkonto des Servers und liest keine Personendaten (siehe «Was die Probe für die Quellen der Doku tut»).

Die Proben verringern das Risiko, dass Daten Ihrer Gemeinde in eine Ausgabe geraten. Ausschliessen können sie es nicht. Lesen Sie deshalb jede Ausgabe durch, bevor Sie sie weitergeben (siehe «Durchsicht vor dem Weitergeben»).

## Was die Proben lesen

| Probe                      | Liest                                                                                                                                                                                                                                                                                                                | Beantwortet                                                                                                                                                                                                                                                                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `00-inventory.mts`         | `GET /system/runtime/swagger/openapi.json`, `GET /api/info`                                                                                                                                                                                                                                                          | Version von ChurchTools als Haupt- und Nebennummer. Für jede Operation der Proben, ob Ihre Instanz sie dokumentiert. Die übrigen Pfade nennt die Probe nicht, weil sie zeigen würden, welche Module aktiv sind. Von der Antwort auf `/api/info` zeigt sie nur Status und Version, weil diese Antwort Name und Einstellungen der Instanz enthält. |
| `01-auth.mts`              | `GET /api/whoami` sechsmal: mit dem Token, ohne Token und mit einem ungültigen Zufallswert, jeweils mit und ohne `only_allow_authenticated=true`                                                                                                                                                                     | Ob das Token angenommen wird, Struktur von `whoami`, Format einer 401-Antwort, was eine Anfrage ohne Anmeldung erhält und ob eine Antwort ein Cookie setzt.                                                                                                                                                                                      |
| `02-permissions.mts`       | `GET /api/permissions/global`                                                                                                                                                                                                                                                                                        | Struktur der Rechte des Dienstkontos und ihr Umfang, als Wahrheitswerte und Anzahlklassen.                                                                                                                                                                                                                                                       |
| `03-pagination-errors.mts` | `GET /api/wiki/pages` für die Testkategorie mit `limit` 1, 2, 100 und 1000, mit einer Seite hinter der letzten und mit ungültigen Werten für `page` und `limit`. `GET /api/wiki/categories/{id}/pages/{identifier}` mit einer zufälligen, unbekannten Kennung. Optional beide Seitenlisten der gesperrten Kategorie. | Wie die Paginierung arbeitet, Felder von `meta.pagination`, wirksame Obergrenze von `limit`, Format der Fehler 400, 404 und 403.                                                                                                                                                                                                                 |
| `04-wiki-read.mts`         | `GET /api/wiki/categories/{id}/pages` für die Testkategorie, dann für höchstens drei Seiten daraus die Seite, ihre Versionen und die neueste Version                                                                                                                                                                 | Struktur von Seite und Versionsliste, ob die Felder `version` und `isMarkdown` vorkommen, ob die Version einer Seite der neuesten Version ihrer Liste entspricht.                                                                                                                                                                                |

Die lesenden Proben schreiben in ChurchTools nichts. Lokal legt `00-inventory` die State-Datei an. Sie enthält die Version und das OpenAPI-Dokument Ihrer Instanz, damit die übrigen Proben ihre Operationen darin nachschlagen können. Die Operationen zum Anlegen, Ändern und Löschen von Wiki-Seiten schlägt `00-inventory` nur nach. Aufgerufen werden sie nur von `05` und `07`, hinter dem Wächter.

Ausser `/api/info`, `/api/whoami`, `/api/permissions/global` und dem OpenAPI-Dokument liest keine lesende Probe etwas ausserhalb der Testkategorie. Die einzige Ausnahme ist die gesperrte Kategorie, wenn Sie eine angeben: `03` fragt ihre Seitenlisten ab, um die Antwort 403 zu sehen. Wählen Sie dafür eine Kategorie ohne vertrauliche Seiten. Darf das Dienstkonto sie doch lesen, beschreibt die Ausgabe auch ihre Struktur. `08` liest ausserdem für seinen Wächter die Liste der Wiki-Kategorien und, hinter diesem Wächter, Personen, Gruppen, Mitgliederlisten und die globale Suche (siehe «Was die Probe für Personen und Gruppen tut»). `09` liest für seinen Wächter dieselben beiden Antworten und dahinter die Bereiche (siehe «Was die Probe für die Bereiche tut»).

Jede Probe sucht ihre Operationen vor dem ersten Aufruf im OpenAPI-Dokument Ihrer Instanz, über Methode und Pfad. Fehlt eine Operation dort, meldet eine lesende Probe «nicht dokumentiert» und ruft sie nicht auf. Eine Probe des Schreibkontos bricht dann ab. Der Wächter von `08` und `09` bricht ab, wenn die Instanz `GET /api/wiki/categories` oder `GET /api/permissions/global` nicht dokumentiert. Fehlt eine Operation für Personen, Gruppen oder die Suche, meldet `08` «nicht dokumentiert» und ruft sie nicht auf. Ebenso meldet `09` jede fehlende Operation der Bereiche.

## Was die Proben des Schreibkontos tun

| Probe                          | Liest und schreibt                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Beantwortet                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `05-wiki-write.mts`            | Legt im Schreibbereich mit `POST /api/wiki/categories/{id}/pages` vier Seiten mit einem synthetischen Text an: zwei in Markdown, eine ohne `isMarkdown`, eine für die Fälle. Ändert nur die vierte mit `PATCH …/pages/{guid}`: gleicher Text, neuer Text, kein Text, zwei Änderungen hintereinander, veraltete `version`, veraltetes `If-Match`, `If-Unmodified-Since` in der Vergangenheit, `title` im Body. Legt einmal den Titel der vierten Seite neu an. Liest jede Seite zurück.                                                                                                                                                                                                                                                                                                                         | Ob und wann eine neue Version entsteht, ob die API eine Versionsbedingung beachtet, ob ein Client mit Login-Token ohne Sitzung ein CSRF-Token braucht, welches Format eine neue Seite erhält, ob ein HTML-Kommentar den Weg über die API übersteht.                                                                                                                                                                                                                          |
| `06-wiki-editor-roundtrip.mts` | Liest die drei ersten Seiten des Laufs und ihre Versionen, nachdem Sie sie im Web-Editor ohne Änderung gespeichert haben, einmal oder zweimal. Nach zwei Speichern liest sie auch die Version davor. Schreibt nichts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Was der Web-Editor an einer Markdown-Seite ändert, nach Art und Zeile des synthetischen Texts, ob dabei eine Version entsteht und ob der HTML-Kommentar bleibt. `zweitesSpeichern` sagt, ob ein zweites Speichern den Text noch einmal ändert, und nennt dann die Änderungen gegenüber der Version davor. `standNach05` sagt, ob die Seite nach `05` noch dem synthetischen Text entsprach. Wenn nicht, enthält die Liste auch die Änderungen der API, die schon `05` nennt. |
| `11-calendar-write.mts`        | Legt im Kalender der Proben mit `POST /api/calendars/{id}/appointments` einen Termin ohne Event und ohne Serie an, an einem Tag in dreissig Tagen und nicht um Mitternacht. Ändert ihn mit `PUT …/appointments/{id}`: neuer Titel mit allen Feldern, derselbe Körper noch einmal, ohne die optionalen Felder, veraltete `version`, veraltetes `If-Match`, `If-Unmodified-Since` in der Vergangenheit. Löscht ihn mit `DELETE`. Prüft mit `POST /api/bookings/conflicts` vor und nach der ersten Buchung, legt mit `POST /api/bookings` eine Buchung als Anfrage (`statusId` 1) und eine als genehmigt (`statusId` 2) an, ändert die erste mit `PUT /api/bookings/{id}` (neue Zeit, derselbe Körper, ohne Beschreibung, `statusId` 2, veraltete `version`) und löscht beide. Liest nach jedem Schreiben zurück. | Was `PUT` mit Feldern tut, die es nicht bekommt, ob die API eine veraltete Version abweist, an welchem Feld sich eine Änderung zeigt, wer als Autor gilt, was `statusId` für ein Konto bedeutet, das nur Buchungsanfragen erstellen darf, was die Prüfung auf Konflikte liefert und ob ein gelöschtes Objekt fehlt.                                                                                                                                                          |
| `07-wiki-cleanup.mts`          | Löscht mit `DELETE …/pages/{guid}` die Seiten des Laufs: die aus der Schreib-State-Datei und die Seiten des Schreibbereichs, deren Titel Präfix und Kennung des Laufs trägt. Jede erst nach einem Lesen, das Schreibbereich, diesen Titel und das Recht zum Löschen zeigt.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Ob die dokumentierte Löschung wirkt und ob eine gelöschte Seite danach fehlt.                                                                                                                                                                                                                                                                                                                                                                                                |

Jede Seite, die `05` anlegt, hält die Probe sofort in einer eigenen Schreib-State-Datei fest, mit Modus 0600 und ausserhalb jedes Git-Arbeitsbaums. Bricht `05` mitten im Lauf ab, nennt die Datei trotzdem jede Seite, deren Anlegen die Instanz bestätigt hat. Ging eine Antwort verloren, findet `07` die Seite über den Titel mit der Kennung des Laufs. Nach einem Fehler, der auf eine schreibende Anfrage folgt, sendet `05` keine weitere.

`11` führt eine Schreib-State-Datei eigener Form: jeden Termin und jede Buchung, sobald die Instanz das Anlegen bestätigt, und jede bestätigte Löschung. Nach einem Fehler sendet `11` nur noch die Löschungen dessen, was der Lauf angelegt hat. Bleibt dabei etwas stehen, starten Sie `11` mit derselben Schreib-State-Datei noch einmal: Dann löscht die Probe nur, was der frühere Lauf übrig liess, auch Objekte, deren Antwort verloren ging, über den Titel mit der Kennung des Laufs.

Ausser der Liste der Kategorien, `/api/permissions/global` und dem OpenAPI-Dokument lesen die Proben des Schreibkontos nur im Schreibbereich, und geschrieben wird nur dort. `11` liest und schreibt dazu nur im Kalender und bei der Ressource der Proben und liest `/api/whoami`, die Listen der Kalender und Ressourcen und die Rechte noch einmal nach dem Lauf. Eine Löschung entfernt eine Seite mit allen Versionen und lässt sich nicht rückgängig machen.

## Was die Probe für Personen und Gruppen tut

| Probe                        | Liest                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Beantwortet                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `08-persons-groups-read.mts` | Für seinen Wächter: `GET /api/wiki/categories` und `GET /api/permissions/global`. Danach: `GET /api/whoami`; die Listen `GET /api/persons` und `GET /api/groups` ohne Filter, mit den festen Suchbegriffen, mit `ids[]` für die IDs aus der Umgebung und mit `limit` und `page`; die globale Suche `GET /api/search` mit den festen Suchbegriffen; die synthetische Person `p1` und ihre Gruppen, die beiden synthetischen Gruppen `g1` und `g2` und ihre Mitglieder, je über die ID aus der Umgebung; `p1` sowie `g1` mit seinen Mitgliedern ein zweites Mal über die GUID aus der eigenen Antwort; je eine unbekannte ID und GUID | Welche Operationen und Parameter Ihre Instanz dokumentiert, wie die Suche trifft, wie die Listen blättern und wo `limit` endet, wie Fehler aussehen, welches Recht jede Operation verlangt, wie Rechte und «alle» aussehen, welche Felder Personen und Gruppen haben, ob Gruppen und Mitgliederlisten Personendaten mitbringen und wie Personen und Gruppen angesprochen werden. |

`08` schreibt nichts. Es sendet nur `GET`, nur an Operationen, die Ihre Instanz dokumentiert, und Parameter nur, wenn die Operation sie deklariert. Einzeln ruft es nur die synthetische Person und die beiden synthetischen Gruppen ab, über die IDs aus `ECCLIUM_SPIKE_PERSON_ID`, `ECCLIUM_SPIKE_GROUP_ID` und `ECCLIUM_SPIKE_OTHER_GROUP_ID`, und `p1` und `g1` zusätzlich über die GUID, die ihre eigene Antwort trägt. Unter `kennungSynthetisch` steht für jeden Einzelabruf über eine ID «ja», «nein», «nicht vergleichbar» oder «nicht geprüft». Antwortet er mit 200 und zeigt ein anderes Objekt, steht dort «nein», trägt seine Antwort gar keinen Namen, «nicht vergleichbar». In beiden Fällen liest `08` zu diesem Objekt nichts weiter, und Sie halten an (Schritt 5 der Ausführung). Antwortet er nicht mit 200, steht dort «nicht geprüft». `08` ruft dann über die ID aus der Umgebung trotzdem die Gruppen der Person oder die Mitglieder der Gruppe ab, damit die Stufen zeigen, wie diese Operationen ohne das Recht antworten. Über die GUID ruft es nur nach «ja» ab. Die unbekannte ID ist eine feste Zahl, die keine Testinstanz erreicht, damit kein Abruf zufällig eine echte Person trifft. Die Suchbegriffe stehen fest in `lib/synthetic.mts` und erscheinen in der Ausgabe nur als `q1` bis `q8`: die Marke, klein geschrieben und ihr Anfang, Vor- und Nachname von `p1` in beiden Reihenfolgen, ein Teil der E-Mail-Adresse von `p1`, ein Teil aus der Mitte der Marke und als `q8` eine zufällige UUID. Die Grenze von `limit` sucht `08` auch bei einer leeren Liste, weil sie von der Prüfung der Parameter abhängt, nicht von den Daten. Die Mitgliederliste kennt einen Parameter für zusätzliche Felder einer Person. `08` sendet ihn nie.

## Was die Probe für die Bereiche tut

| Probe                 | Liest                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Beantwortet                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `09-domains-read.mts` | Für seinen Wächter: `GET /api/wiki/categories` und `GET /api/permissions/global`. Danach: `GET /api/calendars`; `GET /api/calendars/appointments` für `c1`; `t1` und `t2` einzeln über `GET /api/calendars/{calendarId}/appointments/{appointmentId}`; `GET /api/events`; `e1` über `GET /api/events/{eventId}`, seinen Ablauf und dessen Lieder; `GET /api/services`, `GET /api/servicegroups`, `GET /api/resourcetypes` und `GET /api/resources`; `GET /api/bookings` für `r1`; `GET /api/songs` für `sc1` und mit «Synthetisch» als `query`; `l1` und `l2` einzeln, je mit ihren Arrangements; die Suche im Wiki `GET /api/wiki/search` mit der Marke, einmal in der Kennkategorie und einmal ohne Kategorie; die globale Suche `GET /api/search` mit «Synthetisch», einmal je Typ, den Ihre Instanz für `domain_types[]` aufzählt; Events und Lieder mit `page` und `limit`; je eine unbekannte ID für Event, Lied und Termin | Welche Operationen und Parameter Ihre Instanz dokumentiert, wie die Antworten aufgebaut sind und wie ihre Datumsangaben aussehen, ob die synthetischen Objekte erscheinen und ob eine Antwort Personen nennt, wie Events und Lieder blättern und wo `limit` endet, wie eine unbekannte ID scheitert, ob ein verborgener Name in einer Einteilung der echte ist und, über die Stufen, welches Recht jede Operation verlangt. |

`09` schreibt nichts. Es sendet nur `GET`, nur an Operationen, die Ihre Instanz dokumentiert, und Parameter nur, wenn die Operation sie deklariert. Fehlt ein Parameter, ohne den ein Aufruf nichts aussagt, etwa `calendar_ids[]` für die Termine, `resource_ids[]` für die Buchungen oder `query` für eine Suche, steht dort «nicht deklariert», und `09` ruft die Operation nicht auf. Einzeln ruft es nur die synthetischen Objekte ab, über die IDs aus der Umgebung (siehe «Voraussetzungen»). Termine, Events und Buchungen fragt es für sechs Wochen ab dem Tag des Laufs ab, mit `from` und `to` als Datum in UTC. Keines der beiden Daten erscheint in der Ausgabe. Die Suche im Wiki sucht die Marke «Spikeprobe» einmal in der Kennkategorie und einmal ohne Kategorie. Weil der Wächter vorher geprüft hat, dass das Konto nur die Kennkategorie sieht, bleibt auch die zweite Suche dort. Die globale Suche und die Liste der Lieder suchen das Wort «Synthetisch». Andere Suchbegriffe sendet `09` nicht. Die unbekannte ID ist dieselbe feste Zahl wie in `08`. Das Blättern prüft `09` mit genau vier Aufrufen je Liste: `page=1&limit=1`, `page=2&limit=1`, `limit=100` und `limit=1000`, bei Events zusätzlich mit `from` und `to`, bei Liedern mit `sc1` in `song_category_ids[]`.

## Was die Probe für die Quellen der Doku tut

`10-docs-sources.mts` prüft, was der Index der Dokumentation aus seinen Quellen nehmen kann ([ADR 0027](../../docs/adr/0027-inhalte-des-doku-index.md)). Sie schreibt nichts.

- Das OpenAPI-Dokument liest sie aus der State-Datei von `00-inventory`, ohne Anfrage. Sie zählt die Operationen je Methode, die veralteten und die mit `operationId`, die `GET`-Operationen je Präfix und die Beschreibungen, die Rechte nennen. Von `info` zeigt sie die Schlüssel, ob die Lizenz CC BY 4.0 ist und ihr Link zu Creative Commons führt, ob Titel und Beschreibung einen Hinweis zum Urheberrecht, den Hersteller oder einen Ausschluss der Gewährleistung nennen und ob die Version des Dokuments die Ihrer Instanz ist. Hosts in `servers`, in Beispielen und in Beschreibungen erscheinen nur als Klasse: der Host Ihrer Instanz, ein anderer Host unter `church.tools`, eine Seite des Herstellers, ein Platzhalter oder ein anderer Host. Dazu kommt die Grösse jedes Teils des Dokuments.
- Die Namen der Präfixe zeigen, welche Module aktiv sind. Sie erscheinen nur, wenn das Konto genau eine Kategorie `testinstanz-kennung` sieht, sonst als `<prefix#1>` und so weiter. Dafür liest `10` `GET /api/wiki/categories`.
- `GET /api/permissions/definitions` ruft sie nur auf, wenn Ihre Instanz die Operation dokumentiert. Von der Antwort zeigt sie die Struktur wie die übrigen lesenden Proben, mit den Schlüsseln, die das Dokument deklariert, höchstens zehn je Objekt, ob die Module und die Rechte der Tools darin stehen, die Klasse der Zahl der Namen von Rechten und ob sie Werte der Instanz trägt: einen Text gleich dem Namen einer Kategorie des Wikis, die das Konto sieht, oder Listen von Objekten mit Kennung und Namen. Laut OpenAPI-Dokument verlangt die Operation `administer persons` in `churchcore`, ein Recht der Verwaltung von Personen, das das Dienstkonto des Servers nicht hat. Ohne dieses Recht antwortet die Instanz mit 403, und die Ausgabe zeigt nur diese Antwort.
- Die Academy unter `https://churchtools.academy` liest sie mit einem eigenen Client ohne Token. Zuerst liest sie `robots.txt` und fragt die Datei danach vor jeder Anfrage, mit Pfad und Query. Verbietet die Datei eine Anfrage, die die Probe braucht, verlangt sie eine Pause von mehr als 30 Sekunden oder kommt statt der Datei etwas anderes als Text, liest `10` dort nichts weiter. Scheitert eine Anfrage an die Academy, steht unter `academy` nur ihr fester Code, und die Teile zu Ihrer Instanz erscheinen trotzdem. Sonst liest sie `/de/help/` für die Sprachen aus `hreflang`, `/de/wp-json/`, die Kategorien und Wissensbasen der Hilfeseiten und jede deutsche Hilfeseite, je 50 auf einmal, und von jeder weiteren Sprache, höchstens drei, wie viele Hilfeseiten es gibt. Sie fragt nur feste Felder ab, nie die Autorinnen und Autoren einer Seite.
- Von den Hilfeseiten zeigt sie die Zahl je Abschnitt und je Wissensbasis mit dem Slug, die Grösse der Texte, den Monat der ältesten und der neuesten Änderung und die Seiten je Jahr. Als Klassen zeigt sie, wie viele Seiten Bilder, Videos, Tabellen und Code tragen und wie viele auf welche Klasse von Hosts verlinken oder sie im Text nennen. Kein Text, kein Link und kein Host einer Hilfeseite erscheint.

## Anfragen

- Nur an die Basis-URL, ausser `10` für die Academy (siehe unten). Die lesenden Proben senden nur `GET`. Pfade unter `/api/persons`, `/api/groups`, `/api/search`, `/api/events`, `/api/services`, `/api/bookings`, `/api/songs`, `/api/wiki/search` und `/api/calendars/appointments` und die Termine jedes Kalenders unter `/api/calendars/{calendarId}/appointments` lehnt der Client jeder Probe vor der Anfrage ab, auch in anderer Gross- und Kleinschreibung und mit doppelten Schrägstrichen. Einen Pfad, der nach dem Auflösen der URL noch `%` oder `;` enthält oder einen Abschnitt, der mit einem Punkt beginnt, lehnt er immer ab, weil ein Server ihn als anderen Pfad lesen könnte. `\` und Abschnitte aus Punkten löst schon die URL auf. Die Proben bauen solche Pfade nie. Nur `08` und `09` erreichen diese Pfade, mit einem Client, den erst ihr Wächter herausgibt.
- `05` und `07` senden ausserdem `POST`, `PATCH` und `DELETE`, nur an Seiten des Schreibbereichs, mit einem JSON-Body und ohne CSRF-Token oder Cookie. Eine Seite adressieren sie nur über ihre GUID. Eine schreibende Anfrage wird nie wiederholt: Nach einem Zeitlimit weiss niemand, ob die Instanz geschrieben hat. Vor jeder schreibenden Anfrage wartet `05` etwas mehr als eine Sekunde, weil die Instanz die Zeit der letzten Änderung nur in ganzen Sekunden nennt.
- Das Token steht nur im Header `Authorization: Login`, nie in einer URL. Die Proben fordern keine Sitzung an.
- Die Proben folgen keiner Weiterleitung, sie brechen mit `HTTP_REDIRECT` ab.
- Jede Anfrage hat ein Zeitlimit von 20 Sekunden und eine Grössengrenze von 5 MiB, für das OpenAPI-Dokument 64 MiB. ChurchTools 3.138 lieferte es im Oktober 2026 mit etwa 41 MB.
- Eine Kennung aus einer Antwort kommt nur in einen Pfad, wenn sie die Form einer Kennung hat: eine positive ganze Zahl, oder höchstens 200 Zeichen aus ASCII-Buchstaben, Ziffern und `-_.~`, ohne Punkt oder Tilde am Anfang.
- Der User-Agent ist `ecclium-spike`, damit die Anfragen in Zugriffsprotokollen erkennbar sind.
- `10` liest ausserdem die Academy unter `https://churchtools.academy`, mit einem eigenen Client: nur `GET` an feste Pfade mit den Parametern `per_page`, `page` und `_fields`, ohne Token, ohne Cookie und ohne Weiterleitung, mit denselben Grenzen für Zeit und Grösse wie bei Ihrer Instanz und mit mindestens drei Sekunden Pause zwischen zwei Abrufen. Ein `Crawl-delay` in `robots.txt` verlängert die Pause, verkürzt sie aber nie.

## Was die Ausgabe enthält

Jede Probe schreibt JSON auf stdout und kurze Hinweise auf stderr. Auf stderr stehen zuerst die Version von Node.js und die SHA-256-Werte aller Dateien `.mts` und `.md` dieses Ordners. Vergleichen Sie sie mit der Beschreibung des Pull Requests, aus dem der Commit stammt.

- Texte erscheinen nur als «leer» oder «nicht leer», Zahlen nur als Typ, Anzahlen nur als Klasse: 0, 1, 2–9, 10–99, 100–999, ab 1000.
- Genaue Zahlen gibt es nur in `03`, `08` und `09`, weil die Frage sie verlangt: in `03` die Anzahl der gelieferten Einträge und das Echo von `limit`, in `08` die gesendeten Werte von `limit`, ihr Echo und die Grenze von `limit`, in `09` die gesendeten Werte von `page` und `limit` und das Echo von `limit`. Die Anzahl der Einträge zeigen `08` und `09` nur als Klasse. Statuscodes geben alle Proben genau aus.
- Der einzige Wert aus der Instanz ist die Version von ChurchTools als Haupt- und Nebennummer, etwa `3.136`.
- Schlüssel erscheinen mit ihrem Namen, wenn das OpenAPI-Dokument Ihrer Instanz sie für diese Antwort deklariert. In `02` gilt stattdessen: Ein Schlüssel erscheint mit Namen, wenn er nur aus kleingeschriebenen Wörtern besteht. Dort werden Namen von Modulen und Rechten als Schlüssel erwartet, die das Dokument nicht einzeln aufzählt. Ein deklarierter Schlüssel erscheint nur mit Namen, wenn er die Form eines Bezeichners hat: höchstens 64 Zeichen aus ASCII-Buchstaben, Ziffern, `_` und `$`, ohne Ziffer am Anfang. Ein Schlüssel wie `@deprecated` erscheint deshalb immer ohne Namen. Alle anderen Schlüssel erscheinen als `<key#1>`, `<key#2>` und so weiter.
- In `08` erscheinen die synthetischen Personen nur als `p1` bis `p4`, die Gruppen als `g1` und `g2` und die Suchbegriffe als `q1` bis `q8`. Jeder Aufruf hat unter `ergebnisse` ein festes Wort: «verweigert», «erlaubt mit Einträgen», «erlaubt leer», «nicht gefunden», «Fehler», «nicht dokumentiert», «nicht aufgerufen», «unbekannte ID vorhanden» oder «nicht geprüft». Dazu stehen unter `sichtbar` für jedes synthetische Objekt «ja», «nein» oder «unbekannt», unter `andereEintraege` die Klasse der Einträge, die einen Namen tragen und weder synthetisch noch der Datensatz des Kontos sind, unter `nichtVergleichbar` die Klasse der Einträge ohne jeden Namen und unter `eigenerDatensatz`, ausser bei Gruppen, ob der Datensatz des Kontos selbst dabei war. «nein» unter `sichtbar` heisst, dass jeder Eintrag einen Namen trug und keiner das Objekt nannte. Antwortet ein Aufruf nicht mit 200, liest `08` keine Einträge, und dort steht überall «unbekannt». In den Mitgliedern einer Gruppe entscheidet die Person eines Eintrags, in den Gruppen einer Person die Gruppe, ob der Eintrag unter `andereEintraege` oder `nichtVergleichbar` zählt und ob er einen Namen trug. Ein leerer Name gilt als fehlend. Unter `strukturen` steht je Operation eine Antwort mit 200, die erste mit Einträgen oder sonst die erste, mit bis zu 200 Feldern je Objekt. Texte zeigen in `08` zusätzlich, ob sie ein Datum oder ein Datum mit Zeit sind, mit Trenner, Sekunden, Bruchteilen und Zone, nie den Text. Rechte erscheinen nur, wenn sie wirksam sind, mit Namen aus einer festen Liste. Eine Liste von Rechten erscheint als Anzahlklasse und als Klassen ihrer Elemente: positive Zahl, 0, negative Zahl, Zahl, die nicht ganz ist, Text, Objekt oder anderes. Unter `fehler` steht die erste Fehlerantwort je Operation und Status mit ihrer Struktur, auch aus den Listen. Von einer Fehlerantwort zeigt `08`, welche der bekannten Schlüssel `message`, `translatedMessage`, `messageKey`, `args` und `errors` sie trägt und ob sie einen gesendeten Text wiederholt, nie den Text. Den ungültigen Wert von `limit` mit der Marke sendet `08` mit der zufälligen UUID aus `q8` statt der Marke als Suchbegriff und sucht sein Echo nur in einer Fehlerantwort. Antwortet die Liste darauf mit 200, steht beim Echo «nicht geprüft».
- In `09` erscheinen die synthetischen Objekte nur als `c1`, `t1`, `t2`, `rt1`, `r1`, `sg1`, `s1`, `s2`, `e1`, `sc1`, `l1` und `l2` und die synthetische Person als `p1`. Unter `ergebnisse` steht für jeden Aufruf ein festes Wort wie in `08`, dazu «nicht deklariert». Unter `sichtbar` steht für jedes Objekt, das die Antwort einer Operation nennen kann, «ja», wenn irgendwo in der Antwort ein Objekt mit seiner ID als `id` steht, sonst «nein», und bei einer Antwort ohne 200 «unbekannt». IDs verschiedener Bereiche können gleich sein, und ein verschachteltes Objekt kann dieselbe Zahl als `id` tragen. Ein «ja» ist deshalb ein Hinweis, kein Beleg. Die globale Suche nennt ihre Treffer mit `domainIdentifier`, nicht mit `id`. Dort steht «ja», wenn ein Objekt der Antwort die ID als `domainIdentifier` trägt, und jeder Aufruf prüft nur die Objekte, deren Art zu seinem Typ passt, nach einem Teil des Werts: `song` die Lieder `l1` und `l2`, `appointment` die Termine `t1` und `t2`, `event` das Event `e1`, `calendar` den Kalender `c1`, `resource` die Ressource `r1`, `service` die Dienste `s1` und `s2` und, wenn der Wert auch `group` enthält, die Dienstgruppe `sg1`. So zählt ein Lied nicht als Event mit derselben ID. Für jeden anderen Typ steht unter `sichtbar` nichts. Unter `treffer` steht für jede Suche, auch die im Wiki, die Klasse der Treffer. Unter `vorkommen` steht für Termine, Events und Buchungen die Klasse, wie oft ein Objekt erscheint. So zeigt `t2`, ob die Liste die Serie in einzelne Termine auflöst. Unter `personP1` steht, ob die ID von `p1` als `id`, als `personId` oder als `domainIdentifier` eines Objekts vom Typ `person` vorkommt, unter `personen` die Klasse der Objekte vom Typ `person`. Unter `meta` steht je Liste, ob ihre erste Antwort mit 200 `meta.count`, `meta.all` und `meta.pagination` trägt, unter `listen` je Aufruf zum Blättern der Status, die Klasse der Einträge und das Echo von `limit`, unter `unbekannt` der Status, die Struktur und die Fehlerschlüssel der Antwort auf eine unbekannte ID. Antwortet eine unbekannte ID mit 200, liest `09` nichts davon. Die Typen der globalen Suche erscheinen als `d1`, `d2` und so weiter und unter `domaenentypen` mit dem Wert aus dem OpenAPI-Dokument Ihrer Instanz, wie ein Schlüssel, den das Dokument deklariert. Einen Wert, der nicht die Form eines Bezeichners hat, zeigt `09` als «anderer Wert» und sendet ihn nicht. Unter `verborgen` steht, was die Einteilungen von `e1` von einer Person zeigen, deren Namen ein Dienst verbirgt: «unbekannt» ohne Antwort 200, «keine» ohne eine Einteilung, deren Person einen leeren Vornamen trägt, sonst die Klasse solcher Einteilungen und für die erste unter `name` «echt», wenn ihr Nachname oder ein Wort ihres Titels ein Name einer synthetischen Person ist, «Platzhalter», wenn keines es ist, oder «nicht vergleichbar», und unter `kennung`, ob `personId` eine positive Zahl ist. Den Vergleich macht `09` im Speicher, der Name erscheint nie. Strukturen, Rechte und Fehler zeigt `09` wie `08`, Texte also mit den Merkmalen eines Datums.
- In `10` erscheinen genaue Zahlen für die Operationen und Schemas des OpenAPI-Dokuments und für die Kategorien und Hilfeseiten der Academy, weil die Frage sie verlangt. Beide sind öffentliche Dokumente. Nur auf der Testinstanz erscheinen ausserdem die Präfixe der Pfade. Auf jeder Instanz erscheinen die Namen der Erweiterungen an Operationen, die mit `x-` beginnen, die Version des Dokuments, wenn sie die Form einer Version hat, die Slugs der Abschnitte und Wissensbasen der Academy, höchstens 100 je Liste, die Codes ihrer Sprachen, die Monate und Jahre der Änderungen und Grössen in KiB oder MiB. Die Namen der Rechte der Tools und der Module stehen fest im Code.
- Kopfzeilen erscheinen mit Namen, wenn der Name auf einer festen Liste bekannter Kopfzeilen steht, etwa `content-type` oder `retry-after`, und mit der Klasse ihres Werts: Zahl, Datum oder Text. Alle anderen Kopfzeilen erscheinen nur als Anzahl.
- Cookies erscheinen nur als Anzahlklasse und mit den verschiedenen Formen ihrer Attribute, jede Form einmal und höchstens drei, nie mit Name oder Wert, weil ein Name den Namen der Instanz tragen kann. Gibt es mehr Formen, steht ihre Zahl als Klasse unter `weitereFormen`.
- Rechte in `02` und das Feld `isMarkdown` in `04` erscheinen als «wahr» oder «falsch».
- `05`, `06` und `07` geben Statuscodes, «ja» oder «nein», «wahr» oder «falsch», Anzahlklassen und die Art jeder Änderung mit der Zeilennummer im synthetischen Text aus, etwa `{ "zeile": 9, "art": "Listenzeichen" }`, höchstens dreissig und die Klasse der übrigen. Den Text selbst geben sie nie aus. Er steht in `lib/corpus.mts` und enthält nichts aus einer Instanz. Für die erste angelegte Seite und für jede abgelehnte schreibende Anfrage gibt `05` ausserdem die Struktur der Antwort aus, wie die lesenden Proben: mit den Schlüsseln, die das OpenAPI-Dokument deklariert. Was eine Probe nicht feststellen kann, etwa weil das Zurücklesen scheitert, steht als «unbekannt» oder «fehlt» in der Ausgabe.

## Der Wächter der Testumgebung

Jede Probe des Schreibkontos prüft vor ihrer ersten Anfrage, nur mit ihrer Umgebung:

- Der Schalter `ECCLIUM_SPIKE_ALLOW_WRITE` stimmt mit dem ersten Teil des Hosts überein, ohne Rücksicht auf Gross- und Kleinschreibung. Tippen Sie ihn von Hand ein, nie aus der Variablen der Adresse: Nur so hält ein vertippter Host den Lauf an.
- Die Basis-URL ist nicht der Platzhalter dieses README.
- Das Token kommt nur aus `ECCLIUM_SPIKE_WRITE_TOKEN_FILE`. Ist zugleich `ECCLIUM_SPIKE_TOKEN_FILE` gesetzt, bricht die Probe ab.
- `ECCLIUM_SPIKE_WRITE_CALENDAR_ID` und `ECCLIUM_SPIKE_WRITE_RESOURCE_ID` sind beide gesetzt oder beide nicht. `11` verlangt sie.

Danach liest sie und bricht ab, sobald etwas nicht stimmt:

- Genau eine sichtbare Kategorie heisst `testinstanz-kennung`, und das Konto darf sie weder bearbeiten noch löschen. Fehlt sie, gilt die Instanz als produktiv.
- Die Kategorie aus `ECCLIUM_SPIKE_WRITE_CATEGORY_ID` ist eine andere, sichtbar und bearbeitbar. Eine dritte Kategorie sieht das Konto nicht.
- Die globalen Rechte erlauben genau das: das Wiki sehen, Schreibbereich und Kennkategorie sehen, den Schreibbereich bearbeiten. Mit den beiden Variablen dazu genau: `churchcal: view category` und `edit category` für den Kalender, `churchresource: view resource` und `create bookings` für die Ressource, und `view` der beiden Module wahr oder falsch. Jedes andere Recht jedes Moduls steht auf «falsch» oder ist leer, auch `administer bookings`.
- Mit den beiden Variablen sieht das Konto genau diesen einen Kalender und genau diese eine Ressource, und die Ressource lässt sich ohne Termin buchen.
- Im Schreibbereich liegen nur die Seite «main» und die Seiten des laufenden Laufs. Vor `11` liegen im Kalender und bei der Ressource am Tag der Probe nur Termine und Buchungen des laufenden Laufs, bei Buchungen in jedem Status. Erst nach den übrigen Prüfungen bekommt `11` einen Client, der diese Termine und Buchungen liest, und nur sie.

Was der Wächter nicht prüfen kann, wertet er als Grund zum Abbruch: eine Operation, die die Instanz nicht dokumentiert, ein anderer Status, ein fehlendes Feld, ein Wert eines anderen Typs. Zuletzt fragt `05`, `07` oder `11` im Terminal nach, mit der Frage auf stderr. Nur die Antwort «ja» lässt die Probe schreiben. Ohne Terminal, etwa mit umgeleiteter Eingabe, bricht sie ab.

## Der Wächter für Personendaten

Vor seiner ersten Anfrage prüft `08`, nur mit seiner Umgebung:

- Die Basis-URL ist nicht der Platzhalter dieses README.
- Der Schalter `ECCLIUM_SPIKE_ALLOW_PERSONS` stimmt mit dem ersten Teil des Hosts überein, ohne Rücksicht auf Gross- und Kleinschreibung. Tippen Sie ihn von Hand ein.
- `ECCLIUM_SPIKE_PERSON_ID`, `ECCLIUM_SPIKE_GROUP_ID` und `ECCLIUM_SPIKE_OTHER_GROUP_ID` sind positive ganze Zahlen, und die beiden Gruppen sind verschieden.

Bis dahin hält `08` nur einen Client für die beiden Anfragen des Wächters, `GET /api/wiki/categories` und `GET /api/permissions/global`. Danach liest der Wächter und bricht ab, sobald etwas nicht stimmt. Beide Anfragen sendet er selbst, mit der Adresse und dem Token, für die er danach den Client herausgibt. So stammen die Antworten, die er prüft, von dieser Instanz und diesem Konto:

- Das Konto sieht genau eine Kategorie, `testinstanz-kennung`, und darf sie weder bearbeiten noch löschen. Stammdaten bearbeiten darf es nicht.
- Im Wiki darf das Konto genau das Wiki und die Kennkategorie sehen.
- In `churchdb` dürfen nur `view`, `view alldata`, `view persons from campus`, `security level person`, `view group`, `view groups of grouptype`, `security level group` und `view memberliste` gesetzt sein, in `churchgroup` nur `view`, `view group`, `view groups of grouptype` und `security level group`, jeweils mit beliebigem Wert, dazu die Leserechte der Bereiche unten. Jedes andere Recht jedes Moduls steht auf «falsch» oder ist leer.

Was der Wächter nicht prüfen kann, wertet er als Grund zum Abbruch: eine Operation, die die Instanz nicht dokumentiert, eine Antwort anderer Form, ein Recht, das er nicht kennt. Rechte, die das Konto über eine Gruppe erhält, sieht er nur, soweit `GET /api/permissions/global` sie nennt. Ob die Antwort das tut, ist offen (F31 in `docs/research/churchtools-api.md`). Deshalb gehört das Dienstkonto des Servers keiner Gruppe an (siehe «Voraussetzungen»). Erst wenn alles stimmt, gibt er den Client heraus, der Personen, Gruppen und die Suche erreicht. Eine Bestätigung im Terminal gibt es nicht, weil `08` nichts schreibt. Braucht eine Operation ein Leserecht, das nicht auf dieser Liste steht, bricht der Wächter ab, sobald Sie es vergeben. Die Liste wird dann mit einem eigenen Pull Request erweitert.

Für `08` und `09` prüft der Wächter die Leserechte mit einer längeren Liste, damit beide Proben mit demselben Satz von Rechten laufen, dem der Lese-Tools aus ADR 0064. Zusätzlich zur Liste oben dürfen in `churchservice` `view`, `view events`, `view servicegroup`, `view agenda` und `view songcategory` gesetzt sein, in `churchcal` `view` und `view category`, in `churchresource` `view` und `view resource`, jeweils mit beliebigem Wert. Die Leserechte für Personen und Gruppen von oben bleiben erlaubt, weil Events und Dienste Personen nennen. Jedes andere Recht jedes Moduls steht auch hier auf «falsch» oder ist leer, und im Wiki bleibt es bei genau den beiden Rechten. Vor seiner ersten Anfrage prüft `09` ausserdem, dass jede ID der synthetischen Objekte eine positive ganze Zahl ist und dass `t1` und `t2`, `s1` und `s2` sowie `l1` und `l2` verschiedene IDs haben.

## Sicherung vor jeder Ausgabe

Bevor eine Probe etwas ausgibt, prüft sie die ganze Ausgabe zweimal:

1. Jedes Wort muss bekannt sein: ein festes Wort der Proben, ein zugelassener Schlüssel oder die Version.
2. Kein zugelassener Schlüssel darf als ganzes Wort etwas enthalten, das aus der Instanz oder von Ihrem Rechner stammt: den Host und seine Teile, das Token, die Werte der Variablen, Ihren Benutzernamen und Ihr Home-Verzeichnis, die Werte aller Kopfzeilen und Cookies und jede Zeichenkette und Zahl aus den Antworten. Gross- und Kleinschreibung zählen nicht, die URL-kodierte Form wird mitgeprüft.

Eine Ausnahme gilt für Schlüssel, die das OpenAPI-Dokument Ihrer Instanz an ihrer Stelle deklariert: Ein Wert aus einer Antwort, der genau so lautet wie der ganze Schlüssel, sperrt ihn nicht, ohne Rücksicht auf Gross- und Kleinschreibung. Solch ein Schlüssel steht in der Ausgabe, weil das Dokument ihn nennt. ChurchTools schickt solche Werte selbst, etwa `{"@deprecated": {"identifier": "guid"}}` in jeder Wiki-Seite oder den Namen eines Modells wie `WikiPage` in einer Fehlerantwort. Ein Wert, der als ganzes Wort nur Teil eines Schlüssels ist, sperrt ihn weiter. Der Host und seine Teile, das Token, die Werte der Variablen, Ihr Benutzername, Ihr Home-Verzeichnis und die Werte der Kopfzeilen und Cookies sperren auch einen gleichlautenden Schlüssel. Die Namen der Rechte aus `02-permissions` prüft die Sicherung ohne diese Ausnahme. In `08` und `09` stammen die Namen der Rechte aus festen Listen im Code und gelten als feste Wörter: Werte aus Antworten über Personen und Gruppen wie «person» oder «group» würden sie sonst zurückhalten. Nennt das OpenAPI-Dokument Ihrer Instanz einen eigenen Namen als Schlüssel und kommt derselbe Name als Wert in einer Antwort vor, hält die Sicherung ihn nicht mehr zurück. Achten Sie bei der Durchsicht darauf.

Schlägt eine Prüfung an, gibt die Probe nur die Stellen der Treffer als JSON-Pointer aus und endet mit Code 3.

Vom Host stehen der ganze Name, der Port und jeder Teil auf der Sperrliste, auch in der Schreibweise mit Umlauten und bei einer IPv6-Adresse jede Gruppe. Ausgenommen sind nur bei Instanzen unter `church.tools` die Wörter «church» und «tools», die alle diese Instanzen teilen. Sonst würde schon ein Recht wie «admin church category» jede Ausgabe von `02-permissions` zurückhalten.

Die Werte des OpenAPI-Dokuments stehen nicht auf der Sperrliste. Das Dokument beschreibt die API, und die Ausgabe braucht seine Schlüssel. Enthält das Dokument Ihrer Instanz eigene Namen, etwa von Zusatzfeldern, können diese als Schlüssel erscheinen. Achten Sie bei der Durchsicht darauf.

Die Slugs der Academy in `10` stammen aus einer öffentlichen Quelle, die keine Antwort Ihrer Instanz erreicht. Werte aus den Antworten Ihrer Instanz halten sie deshalb nicht zurück, sonst hielte eine deutsche Bezeichnung eines Rechts wie «Kalender» den Abschnitt `kalender` zurück. Der Host und seine Teile, das Token, die Werte der Variablen, Ihr Benutzername, Ihr Home-Verzeichnis und die Werte der Kopfzeilen und Cookies halten sie weiter zurück. Die Werte der Academy selbst kommen nicht auf die Sperrliste.

## Voraussetzungen

- Node.js 24.21.0, wie in `.nvmrc`. Die Proben brauchen nur Node.js selbst, keine Pakete und kein `pnpm install`.
- Ein Dienstkonto in ChurchTools mit einem Login-Token. Es darf das Wiki sehen und die Testkategorie lesen, sonst nichts. Beim Recht «Einzelne Wiki-Kategorien sehen» wählen Sie nur die Testkategorie, nie «alle». In ChurchTools kann auch ein Personenstatus Rechte vergeben. Auf einer Testinstanz mit synthetischen Daten brachte jeder vorgegebene Status bis auf einen eigene Rechte mit, etwa auf Personendaten und Kalender. Geben Sie dem Dienstkonto deshalb einen eigenen Status ohne Berechtigungen, und nehmen Sie es in keine Gruppe auf. Ob es nur die beiden Rechte hat, zeigt `02-permissions` (Schritt 6), soweit `GET /api/permissions/global` alle Rechte nennt. Ob diese Antwort auch Rechte aus Gruppen enthält, ist ungeprüft.
- Eine Wiki-Kategorie nur für Tests, mit einigen Seiten aus erfundenem Inhalt, mindestens eine davon mit mehreren Versionen. `04` liest höchstens drei Seiten in der Reihenfolge der Liste. Auf der Testinstanz beobachtet: Eine Seite, die Sie in der Weboberfläche anlegen, hat schon zwei Versionen, die erste ohne Text. In jeder neuen Kategorie legt ChurchTools von selbst eine leere Seite «main» an, die Kategorie hat also eine Seite mehr, als Sie angelegt haben.
- Optional eine zweite Kategorie ohne vertrauliche Seiten, die das Dienstkonto nicht lesen darf.
- Ein privater Ordner ausserhalb jedes Git-Arbeitsbaums für Token, State-Datei und Ausgaben.

Für die Proben des Schreibkontos, nur auf der Testinstanz aus ADR 0049:

- Eine Kategorie `testinstanz-kennung`, die das Schreibkonto sieht, aber nicht bearbeiten darf. Ihr Name steht fest im Code des Wächters.
- Ein Schreibbereich: eine eigene Kategorie, die nur das Schreibkonto und Sie sehen. Ausser der Seite «main» liegt darin nichts.
- Ein Schreibkonto, getrennt vom lesenden Dienstkonto: eine synthetische Person mit einem eigenen Status ohne Berechtigungen, in keiner Gruppe, mit einem Passwort, damit Sie sein Login-Token holen können. Es erhält direkt nur diese Rechte: «Wiki sehen», «Einzelne Wiki-Kategorien sehen» für Schreibbereich und Kennkategorie, «Einzelne Wiki-Kategorien bearbeiten» nur für den Schreibbereich. Nirgends «alle».
- Eine eigene Token-Datei für das Schreibkonto im privaten Ordner.

Für die Probe für Personen und Gruppen, nur auf der Testinstanz aus ADR 0049:

- Das Dienstkonto des Servers, getrennt von den beiden anderen Konten: eine synthetische Person mit einem eigenen Status ohne Berechtigungen, in keiner Gruppe und in keinem Bereich der synthetischen Personen, mit einem Passwort, damit Sie sein Login-Token holen können. Es erhält direkt nur «Wiki sehen» und «Einzelne Wiki-Kategorien sehen» für die Kennkategorie. Die Leserechte für Personen und Gruppen vergeben Sie erst in den Stufen.
- Eine eigene Token-Datei für das Dienstkonto des Servers im privaten Ordner.
- Jede Person auf der Testinstanz trägt Platzhalter, auch Konten wie das des Administrators. Prüfen Sie das vor dem ersten Lauf. Echte Daten auf der Testinstanz sind ein Vorfall (ADR 0049). Geben Sie einer Person mit echten Daten zuerst Platzhalter.
- Ein Bereich nur für die synthetischen Personen und ein zweiter, ebenfalls synthetischer Bereich. Verwenden Sie in Namen von Bereichen, Status und Gruppentypen keine allgemeinen Wörter wie «view», «group» oder «person». Kommt ein solcher Name in einer Antwort vor, sperrt er jeden deklarierten Schlüssel, der ihn als ganzes Wort enthält, etwa nach einem Unterstrich, und die Probe endet mit Code 3. Die Namen der Rechte betrifft das in `08` nicht, sie sind feste Wörter.
- Vier synthetische Personen und zwei Gruppen, von Hand angelegt, genau mit diesen Namen und nur mit Platzhaltern:

  | In der Ausgabe | Vorname    | Nachname        | Bereich               | Gruppen      |
  | -------------- | ---------- | --------------- | --------------------- | ------------ |
  | `p1`           | Anna       | Spikeprobe      | synthetischer Bereich | `g1`, leitet |
  | `p2`           | Bruno      | Spikeprobenberg | synthetischer Bereich | `g1`         |
  | `p3`           | Spikeprobe | Carlsen         | synthetischer Bereich | `g2`         |
  | `p4`           | Dora       | Vorspikeprobe   | zweiter Bereich       | `g1`         |

  Die Gruppe `g1` heisst «Spikeprobe Nord» und gehört zu einem Gruppentyp A, die Gruppe `g2` heisst «Spikeprobe West» und gehört zu einem anderen Gruppentyp B. Beide haben die Sichtbarkeit «restricted», so heisst der Wert im Feld `settings.visibility` einer Gruppe. Diese Sichtbarkeit ist gewählt, damit die Stufen für Gruppen etwas messen. Mit «intern» lieferte `08` auf einer Testinstanz mit synthetischen Daten und ChurchTools 3.137 schon in `s0` beide Gruppen, ohne jedes Recht auf Gruppen oder Personen. Das Recht für `s6` schliesst Gruppen mit «hidden» schon nach seiner Bezeichnung in der Oberfläche aus: «Gruppen eines Gruppentyps sehen - ausser versteckte». Geprüft ist das nicht. `p4` liegt ausserhalb des Bereichs, den die Stufen öffnen, ist aber Mitglied von `g1`. So zeigen die Mitglieder von `g1`, ob die API ein Mitglied weglässt, das das Konto nicht sehen darf. `p1` erhält die E-Mail-Adresse `kontakt.qzvx@example.org`, eine erfundene Telefonnummer wie `+41 00 000 00 00`, ein erfundenes Geburtsdatum und eine erfundene Adresse, die anderen erhalten Adressen unter `example.org`. Keine der vier ist verborgen oder archiviert. Hat Ihre Instanz Standorte, erhalten alle vier denselben eigenen Standort. Notieren Sie die IDs von `p1`, `g1` und `g2` nur lokal, und die Einstellungen in Worten: Bereiche, Gruppentypen, Sichtbarkeit.

- Die Testinstanz öffnen in diesem Teil nur Sie, auch als Administrator, in einem privaten Fenster eines Browsers ohne Erweiterungen.

Für die Probe für die Bereiche, nur auf der Testinstanz aus ADR 0049, zusätzlich zu den Voraussetzungen der Probe für Personen und Gruppen:

- Dasselbe Dienstkonto des Servers und dieselben Personen und Gruppen. `09` braucht die IDs von `p1`, `g1` und `g2` wie `08`, sonst bricht sein Wächter ab.
- Die folgenden synthetischen Objekte, von Hand angelegt und nur mit Platzhaltern. Notieren Sie ihre IDs nur lokal:

  | In der Ausgabe | Variable                              | Objekt                                                                    |
  | -------------- | ------------------------------------- | ------------------------------------------------------------------------- |
  | `c1`           | `ECCLIUM_SPIKE_CALENDAR_ID`           | ein Kalender                                                              |
  | `t1`           | `ECCLIUM_SPIKE_APPOINTMENT_ID`        | ein einzelner Termin in `c1`                                              |
  | `t2`           | `ECCLIUM_SPIKE_SERIES_APPOINTMENT_ID` | ein wöchentlicher Serientermin in `c1`                                    |
  | `rt1`          | `ECCLIUM_SPIKE_RESOURCE_TYPE_ID`      | ein Ressourcentyp                                                         |
  | `r1`           | `ECCLIUM_SPIKE_RESOURCE_ID`           | eine Ressource                                                            |
  | `sg1`          | `ECCLIUM_SPIKE_SERVICE_GROUP_ID`      | eine Dienstgruppe                                                         |
  | `s1`           | `ECCLIUM_SPIKE_SERVICE_ID`            | ein Dienst                                                                |
  | `s2`           | `ECCLIUM_SPIKE_OTHER_SERVICE_ID`      | ein zweiter Dienst                                                        |
  | `e1`           | `ECCLIUM_SPIKE_EVENT_ID`              | ein Event, in dem `p1` den Dienst `s1` und `p2` den Dienst `s2` übernimmt |
  | `sc1`          | `ECCLIUM_SPIKE_SONG_CATEGORY_ID`      | eine Liedkategorie                                                        |
  | `l1`           | `ECCLIUM_SPIKE_SONG_ID`               | ein Lied mit einem Arrangement                                            |
  | `l2`           | `ECCLIUM_SPIKE_OTHER_SONG_ID`         | ein zweites Lied                                                          |

  Termine, das Event und Buchungen liest `09` nur in den sechs Wochen ab dem Tag des Laufs. Was ausserhalb liegt, fehlt in den Listen. Die Lieder liest `09` in der Liste aus `sc1` und mit dem Wort «Synthetisch», die Buchungen nur von `r1`. Verbirgt `s2` die Namen der Eingeteilten, zeigt `verborgen`, was davon bleibt. Tragen die Namen der Objekte das Wort «Synthetisch», zeigt die globale Suche, welche Typen sie findet. Hat `e1` einen Ablauf, zeigen `eventAgenda` und `eventAgendaSongs`, ob er `l1` oder `l2` nennt.

Die Proben prüfen Token-Datei und State-Datei vor dem Lesen: kein symbolischer Link, eine reguläre Datei, die Ihnen gehört, keine Rechte für andere, ausserhalb jedes Git-Arbeitsbaums. Die Token-Datei enthält genau eine Zeile aus druckbaren ASCII-Zeichen und ist höchstens 4 KiB gross. Die State-Datei legt `00-inventory` selbst an, mit Modus 0600. Sie darf vorher nicht existieren. Existiert sie schon, bricht `00-inventory` mit Code 2 ab, bevor es eine Anfrage sendet.

## Ausführung des lesenden Teils

Die Befehle sind für zsh und bash geschrieben. Ersetzen Sie die Werte in Grossbuchstaben und die Adresse der Instanz.

1. Legen Sie die Variablen für diese Sitzung fest. `SHA` ist der Commit aus dem Pull Request, dessen Skripte Sie geprüft haben. Ohne gesperrte Kategorie lassen Sie `GESPERRT` leer.

   ```bash
   D="$HOME/.config/ecclium-testinstanz"
   URL=https://example.church.tools
   KATEGORIE=KATEGORIE_ID
   GESPERRT=GESPERRTE_KATEGORIE_ID
   SHA=COMMIT_AUS_DEM_PULL_REQUEST
   ```

2. Legen Sie den privaten Ordner und eine leere Token-Datei an. `~/.config` muss dafür bestehen:

   ```bash
   mkdir -m 700 "$D" "$D/ausgabe"
   (umask 077 && touch "$D/token")
   ```

   Öffnen Sie `$D/token` in einem Editor und fügen Sie das Token als einzige Zeile ein. Geben Sie es nicht auf der Kommandozeile ein, sonst steht es in der History der Shell.

3. Holen Sie die Skripte des geprüften Commits aus dem Klon des Repositorys, nicht aus einem Arbeitsbaum mit lokalen Änderungen, und bestimmen Sie den Pfad zu Node.js:

   ```bash
   R="$D/lauf-$SHA"
   mkdir -m 700 "$R"
   git archive "$SHA" scripts/spike | tar -x -C "$R"
   NODE="$(mise which node)"
   "$NODE" --version
   ```

4. Führen Sie `00-inventory` aus. `env -i` startet die Probe ohne Ihre übrigen Umgebungsvariablen. Vergleichen Sie danach die SHA-256-Werte auf dem Bildschirm mit dem Pull Request.

   ```bash
   env -i ECCLIUM_SPIKE_BASE_URL="$URL" ECCLIUM_SPIKE_TOKEN_FILE="$D/token" ECCLIUM_SPIKE_STATE_FILE="$D/state.json" "$NODE" "$R/scripts/spike/00-inventory.mts" > "$D/ausgabe/00-inventory.json"
   echo "Code $?"
   ```

   Wollen Sie `00-inventory` wiederholen, löschen Sie zuerst die State-Datei. Oder geben Sie in `ECCLIUM_SPIKE_STATE_FILE` eine neue an und danach allen Proben dieselbe. Leiten Sie die Ausgabe einer Wiederholung in eine neue Datei um: Die Shell leert die Zieldatei von `>` schon vor dem Start der Probe. Bricht `00-inventory` dann ab, weil die State-Datei existiert, ist die frühere Ausgabe leer.

5. Führen Sie `01-auth` und `02-permissions` aus:

   ```bash
   for P in 01-auth 02-permissions; do
     env -i ECCLIUM_SPIKE_BASE_URL="$URL" ECCLIUM_SPIKE_TOKEN_FILE="$D/token" ECCLIUM_SPIKE_STATE_FILE="$D/state.json" ECCLIUM_SPIKE_WIKI_CATEGORY_ID="$KATEGORIE" ECCLIUM_SPIKE_FORBIDDEN_CATEGORY_ID="$GESPERRT" "$NODE" "$R/scripts/spike/$P.mts" > "$D/ausgabe/$P.json"
     echo "$P: Code $?"
   done
   ```

6. Halten Sie hier an und prüfen Sie `02-permissions.json`, bevor `03` und `04` die Testkategorie lesen. Erwartet sind Code 0, unter `antwort` der Status 200 und im Modul `churchwiki` genau zwei Rechte: `view` mit «wahr» und `view category` mit `anzahl` «1». Jedes andere Recht steht auf «falsch» oder ist eine Liste mit `anzahl` «0». Dieser Befehl gibt jedes Recht aus, das nicht auf «falsch» steht und keine leere Liste ist, also auch die beiden erwarteten:

   ```bash
   env -i "$NODE" -e '
   let out = {};
   try { out = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); } catch {}
   const daten = out.antwort?.status === 200 ? out.antwort.struktur?.felder?.data : undefined;
   if (daten?.typ !== "Objekt") { console.log("ABBRUCH: keine Antwort 200 mit Rechten"); process.exit(1); }
   if (daten.weitereFelder) console.log("weitere Module nicht gezeigt");
   for (const [modul, rechte] of Object.entries(daten.felder)) {
     if (rechte.typ !== "Objekt" || rechte.weitereFelder) console.log(`${modul}: nicht vollständig gezeigt`);
     for (const [recht, w] of Object.entries(rechte.felder ?? {}))
       if (w.wert !== "falsch" && w.anzahl !== "0") console.log(`${modul}: ${recht}: ${w.wert ?? w.anzahl ?? w.typ}`);
   }
   ' "$D/ausgabe/02-permissions.json"
   ```

   Erwartet sind genau diese zwei Zeilen:

   ```text
   churchwiki: view: wahr
   churchwiki: view category: 1
   ```

   Steht dort etwas anderes, machen Sie nicht weiter. Schränken Sie die Rechte des Dienstkontos ein, wie unter «Voraussetzungen» beschrieben, und wiederholen Sie nur `02-permissions`. Die State-Datei bleibt gültig. Welche Kategorie das Konto lesen darf, zeigt `02` nicht.

7. Führen Sie `03-pagination-errors` und `04-wiki-read` aus:

   ```bash
   for P in 03-pagination-errors 04-wiki-read; do
     env -i ECCLIUM_SPIKE_BASE_URL="$URL" ECCLIUM_SPIKE_TOKEN_FILE="$D/token" ECCLIUM_SPIKE_STATE_FILE="$D/state.json" ECCLIUM_SPIKE_WIKI_CATEGORY_ID="$KATEGORIE" ECCLIUM_SPIKE_FORBIDDEN_CATEGORY_ID="$GESPERRT" "$NODE" "$R/scripts/spike/$P.mts" > "$D/ausgabe/$P.json"
     echo "$P: Code $?"
   done
   ```

   In `03` nennt der Eintrag in `limitTest` mit `angefragt` 100 unter `eintraege`, wie viele Seiten das Konto lesen kann, solange es weniger als 100 sind: Ihre Seiten der Testkategorie und die Seite «main». Stimmt die Zahl nicht, prüfen Sie `KATEGORIE` und die Rechte des Kontos.

## Ausführung des schreibenden Teils

Erst nach dem lesenden Teil, nur auf der Testinstanz. Die Schritte setzen die Variablen `D`, `URL`, `SHA`, `R` und `NODE` aus den Schritten 1 bis 3 des lesenden Teils voraus.

1. Legen Sie die Variablen des Schreibkontos fest. `SCHREIBBEREICH` ist die ID des Schreibbereichs.

   ```bash
   SCHREIBBEREICH=SCHREIBBEREICH_ID
   KALENDER=KALENDER_ID
   RESSOURCE=RESSOURCEN_ID
   (umask 077 && touch "$D/token-schreiben")
   ```

   `KALENDER` und `RESSOURCE` sind die IDs des Kalenders und der Ressource der Proben. Legen Sie beide als Administrator mit synthetischen Namen an: den Kalender als Gemeindekalender, die Ressource in einem eigenen Ressourcentyp, ohne Pflicht zu einem Termin und ohne automatische Genehmigung, mit Ihrem Konto als Verwalter, damit Sie sehen, ob ChurchTools Mails an Verwalter schickt. Geben Sie dem Schreibkonto genau `Einzelnen Kalender sehen` und `In einzelnen Kalendern Termine erstellen, bearbeiten etc.` für diesen Kalender und `Ressource sehen` und `Eigene Buchungsanfragen erstellen` für diese Ressource.

   Fügen Sie das Login-Token des Schreibkontos in einem Editor als einzige Zeile in `$D/token-schreiben` ein.

2. Führen Sie `00-inventory` mit dem Token des Schreibkontos und einer neuen State-Datei aus, dann `02-permissions`. Beide haben keinen Wächter und senden das Token an `$URL`. Prüfen Sie deshalb vorher, dass `$URL` die Adresse der Testinstanz ist:

   ```bash
   env -i ECCLIUM_SPIKE_BASE_URL="$URL" ECCLIUM_SPIKE_TOKEN_FILE="$D/token-schreiben" ECCLIUM_SPIKE_STATE_FILE="$D/state-schreiben.json" "$NODE" "$R/scripts/spike/00-inventory.mts" > "$D/ausgabe/00-inventory-schreiben.json"
   echo "Code $?"
   env -i ECCLIUM_SPIKE_BASE_URL="$URL" ECCLIUM_SPIKE_TOKEN_FILE="$D/token-schreiben" ECCLIUM_SPIKE_STATE_FILE="$D/state-schreiben.json" "$NODE" "$R/scripts/spike/02-permissions.mts" > "$D/ausgabe/02-permissions-schreiben.json"
   echo "Code $?"
   ```

3. Halten Sie an und prüfen Sie die Rechte mit dem Befehl aus Schritt 6 des lesenden Teils, mit `02-permissions-schreiben.json` statt `02-permissions.json` am Ende. Erwartet sind genau diese drei Zeilen:

   ```text
   churchwiki: view: wahr
   churchwiki: view category: 2–9
   churchwiki: edit category: 1
   churchcal: view category: 1
   churchcal: edit category: 1
   churchresource: view resource: 1
   churchresource: create bookings: 1
   ```

   Ohne Kalender und Ressource fehlen die vier letzten Zeilen.

   Steht dort etwas anderes, schränken Sie die Rechte ein und wiederholen Sie nur `02-permissions`. Der Wächter prüft die Rechte vor dem Schreiben noch einmal, genauer: mit den IDs von Schreibbereich und Kennkategorie.

4. Führen Sie `05-wiki-write` aus. Ersetzen Sie `ERSTER_TEIL_DES_HOSTS` von Hand durch den Teil der Adresse vor dem ersten Punkt. Leiten Sie die Eingabe nicht um: Die Probe fragt im Terminal nach. Vergleichen Sie vor der Antwort die SHA-256-Werte auf dem Bildschirm mit dem Pull Request, dann tippen Sie «ja».

   ```bash
   env -i ECCLIUM_SPIKE_BASE_URL="$URL" ECCLIUM_SPIKE_ALLOW_WRITE=ERSTER_TEIL_DES_HOSTS ECCLIUM_SPIKE_WRITE_TOKEN_FILE="$D/token-schreiben" ECCLIUM_SPIKE_STATE_FILE="$D/state-schreiben.json" ECCLIUM_SPIKE_WRITE_CATEGORY_ID="$SCHREIBBEREICH" ECCLIUM_SPIKE_WRITE_STATE_FILE="$D/schreib-state.jsonl" "$NODE" "$R/scripts/spike/05-wiki-write.mts" > "$D/ausgabe/05-wiki-write.json"
   echo "Code $?"
   ```

   Sehen Sie die Ausgabe durch, bevor Sie weitermachen.

5. Öffnen Sie im Web-Editor nacheinander die drei Seiten, deren Titel auf `-1`, `-2` und `-3` enden, und speichern Sie jede ohne Änderung. Am besten als Schreibkonto: Speichern Sie als Administrator, steht Ihr Name in der Versionsgeschichte. Notieren Sie, ob der Editor das Speichern überhaupt anbot. Um zu prüfen, ob ein zweites Speichern den Text noch einmal ändert, laden Sie die Seite neu und speichern die beiden Markdown-Seiten (`-1` und `-2`) ein zweites Mal ohne Änderung.

6. Führen Sie `06-wiki-editor-roundtrip` aus und sehen Sie die Ausgabe durch:

   ```bash
   env -i ECCLIUM_SPIKE_BASE_URL="$URL" ECCLIUM_SPIKE_ALLOW_WRITE=ERSTER_TEIL_DES_HOSTS ECCLIUM_SPIKE_WRITE_TOKEN_FILE="$D/token-schreiben" ECCLIUM_SPIKE_STATE_FILE="$D/state-schreiben.json" ECCLIUM_SPIKE_WRITE_CATEGORY_ID="$SCHREIBBEREICH" ECCLIUM_SPIKE_WRITE_STATE_FILE="$D/schreib-state.jsonl" "$NODE" "$R/scripts/spike/06-wiki-editor-roundtrip.mts" > "$D/ausgabe/06-wiki-editor-roundtrip.json"
   echo "Code $?"
   ```

7. Prüfen Sie zwei Fragen von Hand, bevor die Seiten verschwinden. Notieren Sie nur «ja» oder «nein»:
   - Zeigt die Ansicht der Seite, deren Titel auf `-4` oder `-4-titel` endet, die nackte Adresse `https://example.org/` als Link? Diese Seite ist in Markdown und wurde nie im Web-Editor gespeichert, die Antwort hängt also nur von der Darstellung ab.
   - Erwähnen Sie als Administrator die synthetische Person des Schreibkontos in einer der Seiten. Erhält das Schreibkonto danach eine Benachrichtigung? Notieren Sie dazu, welche Benachrichtigungen das Schreibkonto eingeschaltet hat.

8. Legen Sie die durchgesehenen Ausgaben ab. Erst danach führen Sie `07-wiki-cleanup` aus und bestätigen mit «ja». Die Löschung lässt sich nicht rückgängig machen.

   ```bash
   env -i ECCLIUM_SPIKE_BASE_URL="$URL" ECCLIUM_SPIKE_ALLOW_WRITE=ERSTER_TEIL_DES_HOSTS ECCLIUM_SPIKE_WRITE_TOKEN_FILE="$D/token-schreiben" ECCLIUM_SPIKE_STATE_FILE="$D/state-schreiben.json" ECCLIUM_SPIKE_WRITE_CATEGORY_ID="$SCHREIBBEREICH" ECCLIUM_SPIKE_WRITE_STATE_FILE="$D/schreib-state.jsonl" "$NODE" "$R/scripts/spike/07-wiki-cleanup.mts" > "$D/ausgabe/07-wiki-cleanup.json"
   echo "Code $?"
   ```

9. Führen Sie `11-calendar-write` erst nach `07` aus, wenn im Schreibbereich wieder nur die Seite «main» liegt: Der Wächter prüft den Schreibbereich auch für diese Probe. Bestätigen Sie mit «ja». Die Probe löscht am Ende, was sie angelegt hat. Schauen Sie gleich danach im Postfach des Verwalters der Ressource nach, ob ChurchTools beim Anlegen, Ändern oder Löschen Mails geschickt hat, und notieren Sie nur, wozu.

   ```bash
   env -i ECCLIUM_SPIKE_BASE_URL="$URL" ECCLIUM_SPIKE_ALLOW_WRITE=ERSTER_TEIL_DES_HOSTS ECCLIUM_SPIKE_WRITE_TOKEN_FILE="$D/token-schreiben" ECCLIUM_SPIKE_STATE_FILE="$D/state-schreiben.json" ECCLIUM_SPIKE_WRITE_CATEGORY_ID="$SCHREIBBEREICH" ECCLIUM_SPIKE_WRITE_CALENDAR_ID="$KALENDER" ECCLIUM_SPIKE_WRITE_RESOURCE_ID="$RESSOURCE" ECCLIUM_SPIKE_WRITE_STATE_FILE="$D/kalender-state.jsonl" "$NODE" "$R/scripts/spike/11-calendar-write.mts" > "$D/ausgabe/11-calendar-write.json"
   echo "Code $?"
   ```

   Mit Kalender und Ressource im Konto brauchen auch `05` bis `07` die beiden Variablen `ECCLIUM_SPIKE_WRITE_CALENDAR_ID` und `ECCLIUM_SPIKE_WRITE_RESOURCE_ID`, sonst gilt das Konto als zu weit berechtigt.

Wiederholen: Endet `05` nach der Bestätigung mit einem anderen Code als 0, führen Sie zuerst `07` mit derselben Schreib-State-Datei aus. `07` findet auch Seiten dieses Laufs, deren Antwort verloren ging, über den Titel mit der Kennung des Laufs. Danach starten Sie `05` mit einem neuen Pfad in `ECCLIUM_SPIKE_WRITE_STATE_FILE`. Seiten mit dem Präfix `spike-schreibprobe` aus einem Lauf, dessen Schreib-State-Datei fehlt, entfernen Sie von Hand. Solange solche Seiten im Schreibbereich liegen, brechen `05`, `06` und `07` ab. Endet `11` mit einem anderen Code als 0 und nennt `aufraeumen` übrige Objekte, starten Sie `11` noch einmal mit derselben Schreib-State-Datei. Termine und Buchungen mit dem Präfix `spike-schreibprobe` aus einem Lauf, dessen Schreib-State-Datei fehlt, entfernen Sie von Hand.

Eine Probe bricht vor der ersten Anfrage ab, wenn `NODE_OPTIONS`, `NODE_DEBUG`, `NODE_PATH` oder `NODE_EXTRA_CA_CERTS` gesetzt ist oder `NODE_TLS_REJECT_UNAUTHORIZED=0` gilt. Diese Variablen könnten fremden Code laden oder ein fremdes Zertifikat gelten lassen, über das jemand das Token mitlesen könnte. Mit `env -i` sind sie nicht gesetzt.

## Ausführung der Probe für Personen und Gruppen

Nur auf der Testinstanz, nach den Voraussetzungen oben. Die Schritte setzen die Variablen `D`, `URL`, `SHA`, `R` und `NODE` aus den Schritten 1 bis 3 des lesenden Teils voraus. In jeder Stufe ändern Sie die Rechte des Dienstkontos des Servers in der Oberfläche und führen `08` aus. Halten Sie zu jedem Recht seine Bezeichnung in der Oberfläche fest und den Abschnitt der Oberfläche, unter dem es steht.

1. Legen Sie die Variablen fest und eine leere Token-Datei an:

   ```bash
   PERSON=ID_VON_P1
   GRUPPE=ID_VON_G1
   ANDERE_GRUPPE=ID_VON_G2
   (umask 077 && touch "$D/token-server")
   ```

   Fügen Sie das Login-Token des Dienstkontos des Servers in einem Editor als einzige Zeile in `$D/token-server` ein.

2. Führen Sie `00-inventory` mit diesem Token und einer neuen State-Datei aus, dann `02-permissions`. Beide haben keinen Wächter und senden das Token an `$URL`. Prüfen Sie deshalb vorher mit `echo "$URL"`, dass dies die Adresse der Testinstanz ist:

   ```bash
   env -i ECCLIUM_SPIKE_BASE_URL="$URL" ECCLIUM_SPIKE_TOKEN_FILE="$D/token-server" ECCLIUM_SPIKE_STATE_FILE="$D/state-server.json" "$NODE" "$R/scripts/spike/00-inventory.mts" > "$D/ausgabe/00-inventory-server.json"
   echo "Code $?"
   env -i ECCLIUM_SPIKE_BASE_URL="$URL" ECCLIUM_SPIKE_TOKEN_FILE="$D/token-server" ECCLIUM_SPIKE_STATE_FILE="$D/state-server.json" "$NODE" "$R/scripts/spike/02-permissions.mts" > "$D/ausgabe/02-permissions-server.json"
   echo "Code $?"
   ```

   Prüfen Sie die Rechte mit dem Befehl aus Schritt 6 des lesenden Teils, mit `02-permissions-server.json`. Erwartet sind genau die beiden Zeilen von dort. Steht dort etwas anderes, führen Sie `08` nicht aus. Schränken Sie die Rechte des Dienstkontos des Servers ein, wie unter «Voraussetzungen» beschrieben, und wiederholen Sie nur `02-permissions`. Die State-Datei bleibt gültig. In `00-inventory-server.json` steht jede Operation für Personen, Gruppen und Suche auf «dokumentiert» oder «nicht dokumentiert». Vergleichen Sie danach die SHA-256-Werte, die `00-inventory` auf dem Bildschirm ausgegeben hat, mit dem Pull Request. Sie umfassen alle Dateien des Ordners, auch `08` und seinen Wächter. Starten Sie `08` erst, wenn alle Werte übereinstimmen.

3. Führen Sie in jeder Stufe `08` aus. Setzen Sie `S` auf den Namen der Stufe und ersetzen Sie `ERSTER_TEIL_DES_HOSTS` von Hand durch den Teil der Adresse vor dem ersten Punkt. `08` fragt nicht nach und liest sofort. Die SHA-256-Werte haben Sie deshalb schon in Schritt 2 verglichen.

   ```bash
   S=s0
   env -i ECCLIUM_SPIKE_BASE_URL="$URL" ECCLIUM_SPIKE_ALLOW_PERSONS=ERSTER_TEIL_DES_HOSTS ECCLIUM_SPIKE_TOKEN_FILE="$D/token-server" ECCLIUM_SPIKE_STATE_FILE="$D/state-server.json" ECCLIUM_SPIKE_PERSON_ID="$PERSON" ECCLIUM_SPIKE_GROUP_ID="$GRUPPE" ECCLIUM_SPIKE_OTHER_GROUP_ID="$ANDERE_GRUPPE" "$NODE" "$R/scripts/spike/08-persons-groups-read.mts" > "$D/ausgabe/08-$S.json"
   echo "Code $?"
   ```

   Die Stufen bauen aufeinander auf:

   | Stufe         | Änderung der Rechte                                                                    | Was `08` zeigen soll                                                                                                                                                                                                                                                                  |
   | ------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `s0`          | nur das Wiki und die Kennkategorie                                                     | Wächter bestanden, unter `sichtbar` kein «ja», `andereEintraege` «0» oder «unbekannt», jede Liste und Suche «verweigert» oder «erlaubt leer» ausser `persons`: Die Liste ohne Filter enthält den Datensatz des Kontos (`eigenerDatensatz` «ja») und steht auf «erlaubt mit Einträgen» |
   | `s1`          | dazu `churchdb: view`                                                                  | ob das Recht auf das Modul allein etwas öffnet                                                                                                                                                                                                                                        |
   | `s2`          | dazu `view alldata`, nur für den synthetischen Bereich                                 | `p1` bis `p3` in Liste und Suche, `p4` nicht                                                                                                                                                                                                                                          |
   | `s3`          | dazu `security level person`, die niedrigste Stufe                                     | die Felder einer Person bei niedriger Stufe                                                                                                                                                                                                                                           |
   | `s4`          | `security level person` mit der höchsten Stufe statt der niedrigsten, nicht mit «alle» | Felder, die erst mit höheren Stufen erscheinen. Die Zeilen `recht:` bleiben wie in `s3`                                                                                                                                                                                               |
   | `s5`          | dazu `churchgroup: view`                                                               | ob das Recht auf das Modul der Gruppen allein etwas öffnet                                                                                                                                                                                                                            |
   | `s6`          | dazu `view groups of grouptype`, nur für Typ A                                         | `g1` sichtbar, `g2` weggelassen oder verweigert                                                                                                                                                                                                                                       |
   | `s7`          | dazu `security level group`, die niedrigste Stufe                                      | Mitglieder und Felder der Gruppe                                                                                                                                                                                                                                                      |
   | `s8`          | dazu `view memberliste`                                                                | ob die Mitgliederliste dieses Recht verlangt                                                                                                                                                                                                                                          |
   | `e1` bis `e4` | je ein Recht entzogen, sonst wie `s8`                                                  | Gegenproben, siehe unten                                                                                                                                                                                                                                                              |
   | `sa`          | `view groups of grouptype` von Typ A auf «alle», danach wieder zurück                  | `g2` sichtbar, die Klassen der Elemente dieses Rechts neben denen von `s6`                                                                                                                                                                                                            |

   Die Gegenproben `e1` bis `e4` legen Sie nach `s8` fest: je eine für jedes Recht, das zuerst ein Ergebnis für Listen, Suche oder die Sichtbarkeit von `p1` bis `p4` und `g1` geändert hat, höchstens vier. Für die übrigen Rechte bleibt der Befund «hinreichend» (Schritt 6). Ein Entzug kann für das Token verzögert wirken (Schritt 7). Speichern Sie deshalb nach dem Entzug eine andere Zuweisung des Kontos unverändert neu, etwa `view memberliste`. Werten Sie eine Gegenprobe nur, wenn im Vergleich aus Schritt 4 gegen `s8` die Zeilen `recht:` des entzogenen Rechts fehlen. Stehen sie noch da, speichern Sie die andere Zuweisung erneut unverändert und wiederholen Sie die Gegenprobe unter einem neuen Namen, etwa `e1b`. Auf einer Testinstanz mit synthetischen Daten und ChurchTools 3.137 wechselten in den Wiederholungen von `e1` die Zeile `recht:` und die gelesenen Daten stets gemeinsam. Neu gespeichert wurde dort über die API. Ob das Neuspeichern in der Oberfläche ebenso wirkt, ist ungeprüft. `sa` läuft zuletzt, damit ein Abbruch dort keine Gegenprobe kostet. Im Wiki vergeben Sie nie «alle». Sobald die Mitglieder von `g1` lesbar sind, zeigen sie, ob `p4` dort fehlt. Steht für `p4` «unbekannt», trug mindestens ein Mitglied keinen Namen.

   `view groups of grouptype` und `security level group` vergeben Sie unter `churchgroup`. Auf einer Testinstanz mit synthetischen Daten und ChurchTools 3.137 führten die Rechtedefinitionen (`GET /api/permissions/definitions`) beide nur dort, `view memberliste` nur unter `churchdb`. `GET /api/permissions/global` nannte jedes der beiden zusätzlich unter `churchdb`, sobald es unter `churchgroup` vergeben war. In der Gegenprobe ohne `view groups of grouptype` fehlten beide Zeilen dieses Rechts. Dass die Zeilen unter `churchdb` eine Spiegelung und kein eigenes Recht sind, ist ein Schluss daraus (F30 in `docs/research/churchtools-api.md`). Im Vergleich aus Schritt 4 erscheinen deshalb in `s6` und in `s7` je zwei neue Zeilen `recht:`, eine unter jedem Modul. In `sa` ändern sich beide Zeilen von `view groups of grouptype`, in einer Gegenprobe zu diesem Recht fehlen beide. Das ist erwartet und kein Grund zum Anhalten.

4. Vergleichen Sie zwei Stufen ohne Werte. Dieser Befehl gibt die wirksamen Rechte, das Ergebnis jedes Aufrufs, die Sichtbarkeit, die Klassen der übrigen Einträge und der Einträge ohne Namen, `kennungSynthetisch` und die Namen der Felder jeder Operation als Zeilen aus:

   ```bash
   zeilen() { env -i "$NODE" -e '
   let out = {};
   try { out = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); } catch {}
   if (out.waechter !== "bestanden") { console.log("ABBRUCH: Wächter nicht bestanden"); process.exit(1); }
   for (const [modul, rechte] of Object.entries(out.rechte ?? {}))
     for (const [recht, w] of Object.entries(rechte))
       console.log(`recht: ${modul}: ${recht}: ${w.wert ?? w.klasse ?? w.anzahl ?? w.typ}${w.elemente ? " " + JSON.stringify(w.elemente) : ""}`);
   for (const [ziel, e] of Object.entries(out.ergebnisse ?? {})) console.log(`ergebnis: ${ziel}: ${e}`);
   for (const [ziel, s] of Object.entries(out.sichtbar ?? {})) console.log(`sichtbar: ${ziel}: ${Object.entries(s).map(([k, v]) => k + "=" + v).join(" ")}`);
   for (const [ziel, a] of Object.entries(out.andereEintraege ?? {})) console.log(`andere: ${ziel}: ${a}`);
   for (const [ziel, a] of Object.entries(out.nichtVergleichbar ?? {})) console.log(`ohne Namen: ${ziel}: ${a}`);
   for (const [k, v] of Object.entries(out.kennungSynthetisch ?? {})) console.log(`kennung: ${k}: ${v}`);
   for (const [op, s] of Object.entries(out.strukturen ?? {})) {
     const daten = s?.struktur?.felder?.data;
     const felder = daten?.felder ?? daten?.formen?.[0]?.felder;
     if (felder) console.log(`felder: ${op}: ${Object.keys(felder).join(" ")}`);
   }
   ' "$1"; }
   diff <(zeilen "$D/ausgabe/08-s0.json") <(zeilen "$D/ausgabe/08-s1.json")
   ```

   `diff` zeigt das neue Recht mit seinem Modul, bei `view groups of grouptype` und `security level group` auch die Zeile unter `churchdb` (Schritt 3), und jedes Ergebnis, das sich geändert hat.

5. Halten Sie nach `s0`, nach `s1` und nach `s8` an und vergleichen Sie die Zeilen aus Schritt 4 mit der Spalte «Was `08` zeigen soll», bevor Sie weitermachen. Nach `s8` legen Sie die Gegenproben fest (Schritt 3). Halten Sie ausserdem sofort an, wenn:
   - `02-permissions-server.json` eine Zeile zeigt, die nicht erwartet ist;
   - ein Code nicht 0 ist oder der Wächter abbricht;
   - `kennungSynthetisch` «nein» zeigt. Prüfen Sie dann die ID;
   - `kennungSynthetisch` «nicht vergleichbar» zeigt oder `nichtVergleichbar` für ein Ziel eine Klasse über «0». Dann tragen die Antworten in dieser Stufe keine Namen. Sehen Sie unter `strukturen` nach, ob `firstName` und `lastName` fehlen oder leer sind;
   - in `s0` ein synthetisches Objekt sichtbar ist;
   - `andereEintraege` für ein Ziel, das mit `persons`, `search`, `groupMembers` oder `personGroups` beginnt, eine Klasse über «0» zeigt. Dann sieht das Konto Personen oder Mitgliedschaften ausserhalb der synthetischen Daten. «unbekannt» heisst, dass keine Einträge gelesen wurden, und ist kein Grund zum Anhalten.

   Nach einem solchen Halt setzen Sie die Rechte auf `s0` zurück und führen Schritt 7 aus, bevor Sie die Ursache suchen. Bis Schritt 7 zeigt, dass das Token nur noch die Rechte von `s0` sieht, kann es entzogene Rechte weiter nutzen, auch beim Lesen von Personen. Ausgenommen ist eine unerwartete Zeile von `02-permissions` vor dem ersten Lauf: Dafür gilt Schritt 2. Wollen Sie danach weitermachen, legen Sie die Token-Datei neu an wie in Schritt 1 und vergeben die Rechte bis zur Stufe, an der Sie angehalten haben.

6. Was als Beleg gilt: Ein Endpunkt verlangt ein Recht, wenn er in der Stufe davor verweigert ist oder kein synthetisches Objekt zeigt, wenn er mit dem Recht Einträge mit den erwarteten Objekten liefert, und wenn er in der Gegenprobe ohne das Recht, bei sonst gleichen Rechten, wieder wie vorher ist. Ohne Gegenprobe heisst der Befund «hinreichend», nicht «nötig».

7. Danach setzen Sie die Rechte des Dienstkontos des Servers auf die Stufe `s0` zurück: nur das Wiki und die Kennkategorie. Ein Entzug wirkt für ein bestehendes Token nicht immer sofort. Auf einer Testinstanz mit synthetischen Daten und ChurchTools 3.137 sah das Login-Token des Dienstkontos ein Recht, das über die API entzogen war, noch etwa zwanzig Minuten danach, in `GET /api/permissions/global` wie beim Lesen von Daten. Das spricht für einen Zwischenspeicher («Zwischenspeicher der Rechte» in `docs/research/churchtools-api.md`). Ob ein Entzug in der Oberfläche ebenso verzögert wirkt, ist ungeprüft. Prüfen Sie deshalb mit `echo "$URL"`, dass dies die Adresse der Testinstanz ist, und dann mit `02-permissions` und der alten Token-Datei, welche Rechte das Token noch sieht:

   ```bash
   env -i ECCLIUM_SPIKE_BASE_URL="$URL" ECCLIUM_SPIKE_TOKEN_FILE="$D/token-server" ECCLIUM_SPIKE_STATE_FILE="$D/state-server.json" "$NODE" "$R/scripts/spike/02-permissions.mts" > "$D/ausgabe/02-permissions-server-vor-erneuern-$S.json"
   echo "Code $?"
   ```

   Prüfen Sie die Ausgabe mit dem Befehl aus Schritt 6 des lesenden Teils, mit dieser Datei am Ende. Stehen dort mehr als die beiden Zeilen von `s0`, melden Sie sich einmal als Dienstkonto des Servers in der Weboberfläche an, ohne das Token zu erneuern, oder speichern Sie eine seiner Zuweisungen unverändert neu. Wiederholen Sie danach `02-permissions` unter einem neuen Dateinamen, etwa `02-permissions-server-vor-erneuern-$S-2.json`, damit die erste Ausgabe als Beleg bleibt. Auf einer Testinstanz mit synthetischen Daten und ChurchTools 3.137 sah das alte Token nach einer solchen Anmeldung nur noch die Rechte des Wikis, und in den Gegenproben zeigte es den Entzug, nachdem `view memberliste` über die API unverändert neu gespeichert war. Dass beides den Zwischenspeicher leert, ist ein Schluss daraus. Ob das Neuspeichern einer Zuweisung des Wikis genügt, ist ungeprüft. Stehen auch danach mehr als die beiden Zeilen, deaktivieren Sie das Dienstkonto. Erneuern Sie das Token erst, wenn genau die beiden Zeilen von `s0` stehen. Ob das Erneuern allein einen veralteten Stand leert, ist offen.

   Erneuern Sie dann das Login-Token des Dienstkontos und lassen Sie `$D/token-server` vorerst unverändert. Prüfen Sie mit `01-auth` und der alten Token-Datei, dass die Instanz das alte Token abweist:

   ```bash
   env -i ECCLIUM_SPIKE_BASE_URL="$URL" ECCLIUM_SPIKE_TOKEN_FILE="$D/token-server" ECCLIUM_SPIKE_STATE_FILE="$D/state-server.json" "$NODE" "$R/scripts/spike/01-auth.mts" > "$D/ausgabe/01-auth-server-nach-$S.json"
   echo "Code $?"
   ```

   Erwartet ist unter `anfragen.mitTokenNurAngemeldet` der Status 401, ebenso unter `anfragen.mitToken`. Ob ein Token gilt, entscheidet die Anfrage mit `only_allow_authenticated=true` (ADR 0025). Die 401 zählt, weil `02-permissions` mit derselben, seither unveränderten Token-Datei zuvor eine Antwort 200 erhielt. Ein ungültiges Token erhielte ebenfalls 401. Steht unter `anfragen.mitTokenNurAngemeldet` 200, gilt das alte Token noch. Deaktivieren Sie dann das Dienstkonto. Fügen Sie erst danach das neue Token als einzige Zeile in `$D/token-server` ein und bestätigen Sie mit `02-permissions`, dass nur die zwei Rechte von `s0` gelten:

   ```bash
   env -i ECCLIUM_SPIKE_BASE_URL="$URL" ECCLIUM_SPIKE_TOKEN_FILE="$D/token-server" ECCLIUM_SPIKE_STATE_FILE="$D/state-server.json" "$NODE" "$R/scripts/spike/02-permissions.mts" > "$D/ausgabe/02-permissions-server-nach-$S.json"
   echo "Code $?"
   ```

   Prüfen Sie die Ausgabe mit dem Befehl aus Schritt 6 des lesenden Teils. Erwartet sind genau die beiden Zeilen von `s0`. Löschen Sie danach `$D/token-server`. Das Dienstkonto des Servers bleibt bestehen.

## Ausführung der Probe für die Bereiche

Nur auf der Testinstanz, nach den Voraussetzungen oben. Die Schritte setzen die Variablen `D`, `URL`, `SHA`, `R` und `NODE` aus den Schritten 1 bis 3 des lesenden Teils und `PERSON`, `GRUPPE` und `ANDERE_GRUPPE` aus Schritt 1 der Probe für Personen und Gruppen voraus, ebenso die Token-Datei `$D/token-server` und die State-Datei aus Schritt 2 dort. Vergleichen Sie die SHA-256-Werte, die `00-inventory` ausgegeben hat, mit dem Pull Request, bevor Sie `09` starten. Sie umfassen auch `09`.

1. Legen Sie die IDs der synthetischen Objekte fest:

   ```bash
   KALENDER=ID_VON_C1
   TERMIN=ID_VON_T1
   SERIENTERMIN=ID_VON_T2
   RESSOURCENTYP=ID_VON_RT1
   RESSOURCE=ID_VON_R1
   DIENSTGRUPPE=ID_VON_SG1
   DIENST=ID_VON_S1
   ANDERER_DIENST=ID_VON_S2
   EVENT=ID_VON_E1
   LIEDKATEGORIE=ID_VON_SC1
   LIED=ID_VON_L1
   ANDERES_LIED=ID_VON_L2
   ```

2. Führen Sie in jeder Stufe `09` aus. Setzen Sie `S` auf den Namen der Stufe und ersetzen Sie `ERSTER_TEIL_DES_HOSTS` von Hand wie für `08`. `09` fragt nicht nach und liest sofort:

   ```bash
   S=s0
   env -i ECCLIUM_SPIKE_BASE_URL="$URL" ECCLIUM_SPIKE_ALLOW_PERSONS=ERSTER_TEIL_DES_HOSTS ECCLIUM_SPIKE_TOKEN_FILE="$D/token-server" ECCLIUM_SPIKE_STATE_FILE="$D/state-server.json" ECCLIUM_SPIKE_PERSON_ID="$PERSON" ECCLIUM_SPIKE_GROUP_ID="$GRUPPE" ECCLIUM_SPIKE_OTHER_GROUP_ID="$ANDERE_GRUPPE" ECCLIUM_SPIKE_CALENDAR_ID="$KALENDER" ECCLIUM_SPIKE_APPOINTMENT_ID="$TERMIN" ECCLIUM_SPIKE_SERIES_APPOINTMENT_ID="$SERIENTERMIN" ECCLIUM_SPIKE_RESOURCE_TYPE_ID="$RESSOURCENTYP" ECCLIUM_SPIKE_RESOURCE_ID="$RESSOURCE" ECCLIUM_SPIKE_SERVICE_GROUP_ID="$DIENSTGRUPPE" ECCLIUM_SPIKE_SERVICE_ID="$DIENST" ECCLIUM_SPIKE_OTHER_SERVICE_ID="$ANDERER_DIENST" ECCLIUM_SPIKE_EVENT_ID="$EVENT" ECCLIUM_SPIKE_SONG_CATEGORY_ID="$LIEDKATEGORIE" ECCLIUM_SPIKE_SONG_ID="$LIED" ECCLIUM_SPIKE_OTHER_SONG_ID="$ANDERES_LIED" "$NODE" "$R/scripts/spike/09-domains-read.mts" > "$D/ausgabe/09-$S.json"
   echo "Code $?"
   ```

   Jede Stufe vergibt ein Recht aus der Liste des Wächters mehr. Halten Sie die Stufen vor dem ersten Lauf fest, mit der Bezeichnung jedes Rechts in der Oberfläche und dem Abschnitt, unter dem es steht. Zwei Stufen vergleichen Sie mit `zeilen` aus Schritt 4 der Probe für Personen und Gruppen, etwa `diff <(zeilen "$D/ausgabe/09-s0.json") <(zeilen "$D/ausgabe/09-s1.json")`. Was als Beleg gilt, steht in Schritt 6 dort.

3. Halten Sie sofort an, wenn ein Code nicht 0 ist oder der Wächter abbricht. Nach einem Halt und nach der letzten Stufe setzen Sie die Rechte des Dienstkontos des Servers zurück, prüfen sie und erneuern sein Token, wie in Schritt 7 der Probe für Personen und Gruppen.

## Ausführung der Probe für die Quellen der Doku

Die Schritte setzen die Variablen `D`, `URL`, `SHA`, `R` und `NODE` aus den Schritten 1 bis 3 des lesenden Teils voraus und die Token-Datei des Dienstkontos des Servers `$D/token-server` (siehe «Ausführung der Probe für Personen und Gruppen»). Das Konto braucht dafür keine weiteren Rechte. Prüfen Sie vorher mit `02-permissions` wie in Schritt 6 des lesenden Teils, dass es nur das Wiki und die Kennkategorie sieht.

1. Legen Sie eine frische State-Datei an, damit das OpenAPI-Dokument zur Version Ihrer Instanz passt:

   ```bash
   env -i ECCLIUM_SPIKE_BASE_URL="$URL" ECCLIUM_SPIKE_TOKEN_FILE="$D/token-server" ECCLIUM_SPIKE_STATE_FILE="$D/state-quellen.json" "$NODE" "$R/scripts/spike/00-inventory.mts" > "$D/ausgabe/00-quellen.json"
   echo "Code $?"
   ```

2. Führen Sie `10` aus. Die Probe braucht Zugang zu Ihrer Instanz und zu `churchtools.academy`. Der Teil zur Academy dauert wegen der Pausen etwa anderthalb Minuten:

   ```bash
   env -i ECCLIUM_SPIKE_BASE_URL="$URL" ECCLIUM_SPIKE_TOKEN_FILE="$D/token-server" ECCLIUM_SPIKE_STATE_FILE="$D/state-quellen.json" "$NODE" "$R/scripts/spike/10-docs-sources.mts" > "$D/ausgabe/10-docs-sources.json"
   echo "Code $?"
   ```

   Unter `testinstanz` steht «ja», wenn das Konto die Kennkategorie genau einmal sieht. Nur dann nennt die Ausgabe die Präfixe der Pfade.

## Codes

| Code | Bedeutung                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Ausgabe geschrieben.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2    | Eine Variable oder Datei fehlt, eine Datei ist unsicher, die Umgebung ist unsicher, oder der Wächter hat abgebrochen. Der Hinweis auf stderr nennt den Grund. Eine lesende Probe hat in diesem Fall in der Regel keine Anfrage gesendet. Bei einer Probe des Schreibkontos können Lese-Anfragen des Wächters vorausgegangen sein, aber keine schreibende. Bei `08` und `09` können die beiden Lese-Anfragen ihres Wächters vorausgegangen sein, aber keine an Personen, Gruppen, die Suche oder die Bereiche. |
| 3    | Ausgabe zurückgehalten, siehe «Sicherung vor jeder Ausgabe».                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 4    | Netz oder Antwort: `NETZ_DNS`, `NETZ_VERBINDUNG`, `NETZ`, `TLS`, `TIMEOUT`, `HTTP_REDIRECT`, `ANTWORT_ZU_GROSS` oder `ANTWORT_UNGUELTIG`. Folgt der Fehler auf eine schreibende Anfrage, sagt der Hinweis das, siehe «Wiederholen».                                                                                                                                                                                                                                                                           |
| 70   | Unerwarteter Fehler in der Probe (`INTERN`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Fehler erscheinen nur als fester Code mit einem festen Hinweis, nie mit einer Meldung oder einem Stack, weil diese Daten aus einer Antwort enthalten könnten.

Die Umleitung `>` legt die Zieldatei an oder leert sie, bevor die Probe startet. Bei Code 2, 4 und 70 bleibt sie leer. Bei Code 3 enthält sie nur `zurueckgehalten` und die Liste `stellen`. Eine frühere Ausgabe unter demselben Namen ist danach überschrieben.

## Durchsicht vor dem Weitergeben

1. Öffnen Sie jede Datei in `$D/ausgabe` und lesen Sie sie ganz. Erwartet sind nur Wörter der Proben, Schlüssel der API, Klassen, Statuscodes, Zeilennummern des synthetischen Texts, die Werte von `limit` und die Version.
2. Suchen Sie nach allem, was Ihre Instanz, Ihre Gemeinde oder Personen erkennbar macht: Host, Namen, Gruppen, IDs.
3. Prüfen Sie die Ausgaben im Klon des Repositorys mit gitleaks und den Regeln des Projekts, und zusätzlich mit einem eigenen Mustersatz, falls Sie einen mit den Namen Ihrer Instanz und Gemeinde pflegen:

   ```bash
   mise exec -- gitleaks dir --redact --no-banner --config .gitleaks.toml "$D/ausgabe"
   ```

4. Für `08` und `09` müssen die folgenden Suchen ohne Treffer bleiben. Findet eine etwas, löschen Sie die Datei und geben Sie keine Ausgabe dieser Stufe weiter. Melden Sie den Fehler der Sicherung vertraulich, wie `SECURITY.md` beschreibt, ohne Werte. Die Ausgabe von `08` enthält den Schlüssel `kennungSynthetisch`, deshalb sucht nur die zweite Suche nach «synthetisch»:

   ```bash
   grep -i -l -E 'spikepro|ikeprob|qzvx' "$D"/ausgabe/08-*.json
   grep -i -l -E 'spikepro|ikeprob|qzvx|synthetisch' "$D"/ausgabe/09-*.json
   ```

   Die beiden folgenden Suchen finden Teile der Namen ohne die Marke, Adressen unter `example.org`, GUIDs und Daten. Ein Treffer kann auch ein Schlüssel sein, den das OpenAPI-Dokument Ihrer Instanz deklariert. Sehen Sie sich jeden Treffer an, bevor Sie die Datei weitergeben:

   ```bash
   grep -i -l -w -E 'anna|bruno|carlsen|dora' "$D"/ausgabe/0[89]-*.json
   grep -i -l -E 'example\.org|[0-9a-f]{8}-[0-9a-f]{4}-|[0-9]{4}-[0-9]{2}-[0-9]{2}' "$D"/ausgabe/0[89]-*.json
   ```

5. Geben Sie nur Dateien weiter, die diese Durchsicht bestanden haben.

## Aufräumen

1. Machen Sie das Token ungültig. Melden Sie sich als Dienstkonto an und erneuern Sie sein Login-Token, ohne das neue zu kopieren. Oder deaktivieren Sie das Dienstkonto.
2. Nach dem Erneuern prüfen Sie mit der alten Token-Datei, dass die Instanz das alte Token abweist:

   ```bash
   env -i ECCLIUM_SPIKE_BASE_URL="$URL" ECCLIUM_SPIKE_TOKEN_FILE="$D/token" ECCLIUM_SPIKE_STATE_FILE="$D/state.json" ECCLIUM_SPIKE_WIKI_CATEGORY_ID="$KATEGORIE" ECCLIUM_SPIKE_FORBIDDEN_CATEGORY_ID="$GESPERRT" "$NODE" "$R/scripts/spike/01-auth.mts" > "$D/ausgabe/01-auth-nach-erneuerung.json"
   echo "Code $?"
   ```

   Erwartet ist unter `anfragen.mitToken` der Status 401. Auf einer Testinstanz mit synthetischen Daten und ChurchTools 3.137 war das etwa zehn Sekunden nach dem Erneuern so. Steht dort 200, gilt das alte Token noch, deaktivieren Sie dann das Dienstkonto. Sehen Sie auch diese Ausgabe durch, bevor Sie sie weitergeben.

3. Löschen Sie danach die Token-Datei.
4. Nach dem schreibenden Teil erneuern Sie ebenso das Token des Schreibkontos und prüfen mit `01-auth`, dass die Instanz das alte abweist. `01-auth` liest das Token aus `ECCLIUM_SPIKE_TOKEN_FILE` und hat keinen Wächter. Prüfen Sie vorher, dass `$URL` die Adresse der Testinstanz ist:

   ```bash
   env -i ECCLIUM_SPIKE_BASE_URL="$URL" ECCLIUM_SPIKE_TOKEN_FILE="$D/token-schreiben" ECCLIUM_SPIKE_STATE_FILE="$D/state-schreiben.json" "$NODE" "$R/scripts/spike/01-auth.mts" > "$D/ausgabe/01-auth-schreibkonto-nach-erneuerung.json"
   echo "Code $?"
   ```

   Erwartet ist unter `anfragen.mitToken` der Status 401. Das Schreibkonto bleibt bestehen, löschen Sie nur die Token-Datei.

5. Löschen Sie den Ordner `$R`, die State-Dateien, die Schreib-State-Datei und die Ausgaben, sobald die Ergebnisse im Research-Dokument stehen. Die State-Datei enthält das vollständige OpenAPI-Dokument Ihrer Instanz. Die Schreib-State-Datei brauchen `06` und `07`. Löschen Sie sie erst, wenn `07` alle Seiten des Laufs entfernt hat.

## Tests

Die Tests in `tests/spike/` laufen mit `pnpm test`, ohne Netz, gegen eine synthetische Instanz, deren Antworten voller Kanarienwerte sind. Keiner dieser Werte darf in einer Ausgabe erscheinen. Woher die Testdaten stammen, steht in [`tests/fixtures/README.md`](../../tests/fixtures/README.md).
