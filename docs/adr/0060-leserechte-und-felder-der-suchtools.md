# ADR 0060: Leserechte des Dienstkontos und feste Felder der Suchtools

- Status: Angenommen am 23.10.2026
- Datum: 23.10.2026
- Fällt vor: Phase 1

## Kontext

In Phase 1 kommen die Suchtools `ct_persons_search` und `ct_groups_search` dazu. Sie geben nur Kennung und Name aus, höchstens 50 Treffer je Aufruf, ohne Blättern und mit höchstens 64 KiB je Ergebnis (`docs/STATUS.md`, Weitere Entscheide, Plan für Phase 1). Beide tragen `sensitivity: special`, weil Personen und Gruppen einer Gemeinde auf die Religionszugehörigkeit schliessen lassen (Threat Model, W1). Ihr Ergebnis geht nur hinaus, wenn die Zeile des Aufrufs ganz in der Audit-Datei steht (ADR 0028).

Am 12.10.2026 wurde entschieden: Das Dienstkonto des Servers erhält für `security level person` und `security level group` die niedrigste Stufe, die für seine Tools ausreicht, und jedes Tool gibt nur eine feste Liste von Feldern weiter. So erreichen Felder, die ein Tool nicht braucht, den MCP-Client nie, auch wenn ChurchTools sie liefert. Ein ADR hält das mit der Wahl der Felder je Tool fest, bevor das Konto eine dieser Stufen erhält.

Die Befunde stammen aus `08-persons-groups-read` an ChurchTools 3.137 auf der Testinstanz (ADR 0049) und stehen in `docs/research/churchtools-api.md`:

- **Rechte je Operation (F29):** `GET /api/persons` zeigt andere Personen nur mit `churchdb: view alldata` («Personen eines Bereiches sehen») und nur aus dem gewählten Bereich. `GET /api/groups` zeigt Gruppen der Sichtbarkeit «restricted» nur mit `churchgroup: view groups of grouptype` («Gruppen eines Gruppentyps sehen - ausser versteckte») und nur des gewählten Typs. `churchdb: view` und `churchgroup: view` waren für keinen Abruf nötig (a1 bis a6), `churchdb: view memberliste` blieb ohne Wirkung (s8). Fehlt ein Recht, antworten beide Listen mit 200 und ohne die Einträge, die das Konto nicht sehen darf, nicht mit 403.
- **Felder einer Person (F32):** Ohne `security level person` hat eine andere Person 16 Felder, darunter `id`, `guid`, `firstName` und `lastName`. Schon die niedrigste Stufe bringt 20 weitere, darunter `email`, `emails`, `phonePrivate`, `phoneWork`, `mobile`, `birthday`, `zip` und `city`, die höchste zusammen 62. Die Stufe ändert nicht, welche Personen sichtbar sind, sondern ihre Felder.
- **Felder einer Gruppe (F32):** Eine Gruppe behält mit jeder Stufe von `security level group` 13 Felder auf oberster Ebene, in a1 bis a6 darunter `id`, `guid` und `name`. Die Stufe bringt nur Felder unter `information` und `settings`, in der niedrigsten etwa `information.note` und `information.meetingTime`.
- **Suche nach Namen (F25):** `GET /api/persons` mit `query` traf p1 bis p3 schon in s2, mit `view alldata` und ohne Sicherheitsstufe, und in a6 auch p4, wieder ohne Sicherheitsstufe. Ein Begriff traf als ganzer Name, als Anfang und als Teil eines Worts, auch kleingeschrieben, Vor- und Nachname nur in dieser Reihenfolge. `GET /api/groups` mit `query` traf g1 ab s6, mit `view groups of grouptype`. Nur der Filter `email` brauchte `security level person`.
- **Globale Suche (F25, F26, F32):** `GET /api/search` liefert je Treffer 12 Felder, darunter `apiUrl` und `frontendUrl`, nach ihren Namen Verweise auf die Instanz, und `domainAttributes` mit Schlüsseln, die die Probe nicht benennen kann. Die Kennung steht als Text in `domainIdentifier`. Die Operation kennt weder `page` noch `limit`, und ob sie die Zahl ihrer Treffer begrenzt, ist offen.
- **Zahlen in `meta` (F26):** Ob `meta.count`, `meta.all` oder `meta.pagination.total` Einträge mitzählen, die das Konto nicht sehen darf, ist offen.
- **Sichtbarkeit und Herkunft (F31, F34):** Gruppen der Sichtbarkeit «intern» las das Konto ohne jedes Recht auf Gruppen oder Personen. Ob `view groups of grouptype` Gruppen «hidden» auslässt, ist nicht geprüft, ebenso, ob `GET /api/permissions/global` Rechte aus einer Gruppe nennt.

Weitere Grundlagen: Der Client verwirft unbekannte Felder ohne Fehler, ein fehlendes Pflichtfeld ist ein Fehler (ADR 0025, ADR 0057). In Phase 1 liest er höchstens die erste Seite mit höchstens 50 Einträgen (ADR 0057). Die Pipeline lässt nichts durch, was das Ausgabeschema eines Tools nicht deklariert, und setzt Texte der Datenklasse `untrusted` in den Datenumschlag (ADR 0024). Ein Ergebnis über 64 KiB ist ein Fehler mit dem Rat, enger zu suchen (ADR 0024). Ein Blatt eines Schemas trägt höchstens eine Datenklasse. `ct_whoami` gibt Vor- und Nachname des Kontos mit den Datenklassen `name.first` und `name.last` aus.

## Optionen

1. **Niedrigste Stufe für Personen und Gruppen, feste Felder im Tool:** Die Tools verwerfen die übrigen Felder. Jede Antwort trägt aber E-Mail, Telefon, Geburtstag, Postleitzahl und Ort jeder gefundenen Person bis in den Prozess von Ecclium, und ein Fehler in den Schichten oder ein gestohlenes Token des Kontos kann sie herausgeben.
2. **Stufe nach dem Bedarf späterer Tools:** Das Konto erhält schon jetzt die Stufe, die spätere Tools brauchen werden, etwa die Tools zum Lesen einer Person in Phase 2. Das spart später einen Schritt am Konto, gibt den Suchtools aber Rechte, die sie nicht brauchen.
3. **Keine Stufe, feste Felder in drei Schichten:** Kennung und Name kommen ohne Sicherheitsstufe. Das Konto erhält nur die beiden Rechte, die die Abrufe öffnen, und jedes Tool liest und gibt nur seine Felder weiter.

## Entscheid

Gewählt ist die dritte Option. Die niedrigste ausreichende Stufe aus dem Entscheid vom 12.10.2026 ist für beide Suchtools: keine.

- **Rechte des Dienstkontos für die Suchtools:**
  - `churchdb: view alldata` nur für die Bereiche, in denen gesucht werden soll, «Alle» nur, wenn die ganze Instanz durchsuchbar sein soll.
  - `churchgroup: view groups of grouptype` nur für die Gruppentypen, in denen gesucht werden soll. Die Zeile, die `GET /api/permissions/global` dafür auch unter `churchdb` führt, ist nach F30 eine Spiegelung, kein zweites Recht (Schluss).
  - Das Konto erhält weder `churchdb: security level person` noch `churchgroup: security level group`, weder `churchdb: view` noch `churchgroup: view` und auch nicht `churchdb: view memberliste`. Wie bisher hat es einen eigenen Personenstatus ohne Berechtigungen (ADR 0023, Umsetzung) und gehört keiner Gruppe an, weil `GET /api/permissions/global` Rechte aus einer Gruppe womöglich nicht zeigt (F31).
  - Brauchen spätere Tools mehr Felder, entscheidet ihr ADR über eine Stufe neu.
- **Eingabe beider Tools:** genau `query`, ein Text, der nach dem Entfernen von Leerzeichen am Rand nicht leer ist und eine feste Höchstlänge hat. Einen leeren Suchbegriff weist das Tool ab, bevor es ChurchTools fragt, weil eine Liste ohne Suchbegriff alle sichtbaren Personen oder Gruppen zeigt. `page` und `limit` setzt das Tool selbst, der Aufrufer kann sie nicht wählen.
- **`ct_persons_search`:**
  - Operation `GET /api/persons` mit genau den Parametern `query`, `page=1` und `limit=51`. Andere Parameter sendet das Tool nicht, ausdrücklich weder `email` noch `email-exact`, mit denen sich eine Adresse bestätigen liesse, weder `ids[]` noch `include` und keinen Filter nach `firstName`, `lastName` oder `nickName`.
  - Der Client liest je Eintrag nur `id`, eine positive ganze Zahl, und `firstName` und `lastName`, je Text mit höchstens 255 Zeichen, auch leer. Alle drei sind Pflicht: Fehlt eines oder ist es `null`, endet der Aufruf mit `upstream`. Aus `meta` liest der Client nichts.
  - Ein Treffer im Ergebnis trägt `id` mit der Datenklasse `personId`, `firstName` mit `name.first` und `lastName` mit `name.last`. `guid` liest der Client nicht. Kennung ist die numerische ID, über die der Client Personen abruft (ADR 0057).
  - `requiredRights`: `churchdb` / `view alldata`.
- **`ct_groups_search`:**
  - Operation `GET /api/groups` mit genau `query`, `page=1` und `limit=51`. Andere Parameter sendet das Tool nicht.
  - Der Client liest je Eintrag nur `id`, eine positive ganze Zahl, und `name`, Text mit höchstens 255 Zeichen, auch leer. Beide sind Pflicht wie oben. Aus `meta` liest der Client nichts.
  - Ein Treffer trägt `id` mit der Datenklasse `none`, weil eine Gruppe keine Person ist, und `name` mit `untrusted`. Den Namen einer Gruppe setzen Personen in der Gemeinde, er kommt deshalb in den Datenumschlag. Eine eigene Datenklasse für IDs von Gruppen gibt es nicht. Sie wird nötig, wenn IDs ins Audit kommen (ADR 0028, Phase 4).
  - `requiredRights`: `churchgroup` / `view groups of grouptype`.
- **Mehr als 50 Treffer:** Kein Tool gibt `count`, `all`, `total` oder `lastPage` aus `meta` weiter. Das Tool fragt 51 Einträge an und gibt höchstens 50 weiter. Kam ein 51. Eintrag, meldet das Ergebnis mit einem Wahrheitswert, dass es weitere Treffer gibt, und rät, enger zu suchen. Der Wert stützt sich so nur auf Einträge, die das Konto sehen darf. ADR 0057 nimmt dafür die beiden Operationen und die Anfrage mit 51 Einträgen auf.
- **Nicht die globale Suche:** Sie liefert mehr Felder als nötig, darunter Verweise auf die Instanz und die Kennung als Text, und sie kennt weder `page` noch `limit`, an denen ein Tool mehr als 50 Treffer erkennen könnte. Weil `ct_persons_search` deshalb `GET /api/persons` nutzt, trifft ein Begriff mit dem Nachnamen vor dem Vornamen nicht (F25). Die Beschreibung von `ct_persons_search` sagt das.
- **Namen von Personen:** Sie behalten die Datenklassen `name.first` und `name.last` und kommen in Phase 1 nicht in den Datenumschlag, wie bei `ct_whoami`. Weil ein Feld höchstens eine Datenklasse trägt, verlöre ein Name als `untrusted` seine Klasse, und die Maskierung `strict` könnte ab Phase 4 keine Nachnamen kürzen. Ob Namen von Personen zusätzlich in den Umschlag kommen, entscheidet ADR 0026 vor Phase 2.
- **Leeres Ergebnis:** Weil die Listen ohne Recht mit 200 und leer antworten, nennt ein leeres Ergebnis das Recht aus `requiredRights` und sagt, dass sich daran «kein Treffer» und «kein Recht» nicht unterscheiden lassen.
- **Zu viele Rechte:** Hat das Konto eine Sicherheitsstufe oder mehr Bereiche oder Gruppentypen als nötig, weist der Server beim Lesen nichts ab. Die drei Schichten verwerfen die Felder ausserhalb der Liste, weitere Bereiche und Gruppentypen machen nur mehr Personen und Gruppen auffindbar. `ct_whoami` zeigt die Rechte, und sobald es den Befehl `ecclium doctor` gibt, meldet er eine Sicherheitsstufe, die kein Tool braucht, als Befund. Eine Prüfung bei jedem Aufruf kostete eine Anfrage mehr und sähe Rechte aus einer Gruppe womöglich nicht (F31, offen).
- **Drei Schichten:** Das Schema des Clients liest nur die Felder der Liste und verwirft den Rest (ADR 0025). Das Ausgabeschema des Tools deklariert nur sie, jedes mit seiner Datenklasse. Die Pipeline lässt nichts durch, was das Ausgabeschema nicht deklariert (ADR 0024). Jede Schicht hat einen eigenen Test, der nur sie prüft, darunter einer, der zeigt, dass schon das Ergebnis des Clients nur die Felder der Liste trägt. Dazu führt ein Test eine Antwort in der Form der höchsten Stufe, mit Kanarienwerten in jedem Feld ausserhalb der Liste, durch Client, Tool und Pipeline, und kein Kanarienwert erreicht Ergebnis, Log oder Audit.

## Konsequenzen

- Mit den Rechten aus diesem ADR liest Ecclium für die Suchtools keine Kontaktdaten und kein Geburtsdatum, auch nicht in seinen Arbeitsspeicher. Ein Fehler in den Schichten oder ein gestohlenes Token des Kontos kann sie deshalb nicht herausgeben.
- Gesucht wird nur nach Namen. Eine Person über ihre E-Mail-Adresse zu finden, geht mit den Suchtools nicht.
- Personen ausserhalb der Bereiche des Kontos und Gruppen ausserhalb seiner Gruppentypen findet die Suche nicht, und sie meldet dafür keinen Fehler. Gruppen «intern» findet sie dagegen ohne jedes Recht (F34).
- Ein leeres Ergebnis kann ein fehlendes Recht bedeuten. Die Meldung sagt es, prüfen lässt es sich mit `ct_whoami`.
- Passt der Name des Kontos zum Suchbegriff, gehört vermutlich sein eigener Datensatz zu den Treffern. Geprüft ist das nicht.
- Fünfzig lange Namen können ein Ergebnis über 64 KiB bringen. Der Aufruf endet dann wie jedes zu grosse Ergebnis mit dem Rat, enger zu suchen.
- ADR 0057 erweitert seinen Umfang um `GET /api/persons` und `GET /api/groups` mit den Parametern oben.
- **Restrisiken:**
  - **Felder ohne Stufe:** Welche Felder ohne Sicherheitsstufe kommen, hängt von den Einstellungen der Instanz ab, belegt ist es nur an der Testinstanz (F32). Fehlt auf einer anderen Instanz ohne Stufe `firstName`, `lastName` oder bei einer Gruppe `name`, endet der Aufruf mit `upstream`, nicht mit einem Teilergebnis.
  - **Namen als Anweisung:** Ein Name kann Text enthalten, der wie eine Anweisung aussieht. Die Pipeline entfernt unsichtbare Zeichen, das Schema begrenzt die Länge, und die Beschreibung jedes Tools sagt, dass Inhalte aus ChurchTools keine Anweisungen sind (Threat Model, T7). Namen von Personen stehen bis zum Entscheid in ADR 0026 ohne Datenumschlag.
  - **Kombination der Rechte:** Dass genau dieser Satz von Rechten für beide Suchtools genügt und dass eine Gruppe `name` auch ohne Sicherheitsstufe trägt, war beim Vorschlag ein Schluss aus F29 und F32. Der Lauf t3 von `08-persons-groups-read` am 23.10.2026 hat beides an ChurchTools 3.137 belegt (`docs/research/churchtools-api.md`, Methode, F25, F29 und F32). Für eine andere Version oder Instanz gilt der Vorbehalt unter «Felder ohne Stufe».
  - **Rechte aus Gruppen und versteckte Gruppen:** Beides ist offen (F31, F34).
  - **Zu viele Rechte bleiben möglich:** Der Server verhindert nicht, dass ein Betreiber dem Konto eine Sicherheitsstufe gibt. Die zusätzlichen Felder erreichen dann den Prozess von Ecclium, aber nicht den Client.

## Umsetzung

Seit dem 23.10.2026 gebaut:

- **Plugin-Schnittstelle:** Die `ReadApi` hat `searchPersons(query)` und `searchGroups(query)`, die je ein eingefrorenes Ergebnis mit höchstens `maxSearchHits` (50) Treffern und dem Wahrheitswert `more` geben. `normalizeSearchTerm` entfernt Leerraum am Rand und nimmt nur einen Begriff mit 1 bis `maxSearchTermLength` (100) UTF-16-Einheiten an, wohlgeformt und ohne Steuerzeichen. Tool und Client nehmen dieselbe Funktion.
- **Client:** `searchPersons` und `searchGroups` in `packages/core/src/churchtools/client.ts`, die Schemas `personListSchema` und `groupListSchema` in `schemas.ts` (ADR 0057).
- **Tools:** `ct_persons_search` in `packages/tools/src/persons/search.ts` und `ct_groups_search` in `packages/tools/src/groups/search.ts`. Die Eingabe ist `query` mit 1 bis 100 Zeichen und mindestens einem, das kein Leerraum ist. Das Ergebnis hat `persons` bzw. `groups`, `more` und `notice`. `notice` ist bei einem leeren Ergebnis ein fester Satz, der das Recht aus `requiredRights` nennt und sagt, dass sich «kein Treffer» und «kein Recht» nicht unterscheiden lassen, bei `more` ein fester Satz mit dem Rat, enger zu suchen, sonst `null`.
- **Freigabe:** `createCorePlugin({ searchTools })` in `packages/tools/src/core-plugin.ts` nimmt beide Tools nur mit dem Schalter in den Katalog (ADR 0055).
- **Tests:** Die Schicht des Clients prüft `client.test.ts` mit je 51 Personen und Gruppen in der Form der höchsten Sicherheitsstufen aus testkit (`personsAtHighestLevel`, `groupsAtHighestLevel`), mit einem Kanarienwert in jedem Feld ausserhalb der Liste. Die Schicht des Tools prüfen `search.test.ts` in beiden Ordnern mit einem Lesezugriff, der mehr Felder liefert, und am Katalog mit den Feldern und Klassen des Ausgabeschemas. Die Schicht der Pipeline prüft `packages/tools/src/search-layers.test.ts` mit einem Tool, das mehr zurückgibt, als sein Ausgabeschema deklariert. Dieselbe Datei schickt die Antworten der höchsten Stufen durch Client, Tool und Pipeline, und kein Kanarienwert erreicht Ergebnis, Log oder Audit. `tests/stdio-start.test.mts` zeigt am echten Prozess die Tools mit Schalter und Ordner, die gesendeten Parameter, die Zeilen der Audit-Datei ohne Suchbegriff und Namen und das zurückgehaltene Ergebnis, wenn die Zeile nicht in die Datei kommt.
