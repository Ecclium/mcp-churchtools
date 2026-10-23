# ADR 0060: Leserechte des Dienstkontos und feste Felder der Suchtools

- Status: Vorgeschlagen
- Datum: 23.10.2026
- Fällt vor: Phase 1

## Kontext

In Phase 1 kommen die Suchtools `ct_persons_search` und `ct_groups_search` dazu. Sie geben nur Kennung und Name aus, höchstens 50 Treffer je Aufruf, ohne Blättern und mit höchstens 64 KiB je Ergebnis (`docs/STATUS.md`, Weitere Entscheide, Plan für Phase 1). Beide tragen `sensitivity: special`, weil Personen und Gruppen einer Gemeinde auf die Religionszugehörigkeit schliessen lassen (Threat Model, W1). Ihr Ergebnis geht nur hinaus, wenn ihre Zeile ganz in der Audit-Datei steht (ADR 0028).

Am 12.10.2026 ist entschieden: Das Dienstkonto des Servers erhält für `security level person` und `security level group` die niedrigste Stufe, die für seine Tools ausreicht, und jedes Tool gibt nur eine feste Liste von Feldern weiter. So erreichen Felder, die ein Tool nicht braucht, den MCP-Client nie, auch wenn ChurchTools sie liefert. Ein ADR hält das mit der Wahl der Felder je Tool fest, bevor das Konto Rechte auf Personen und Gruppen erhält.

Die Befunde stammen aus `08-persons-groups-read` an ChurchTools 3.137 auf der Testinstanz (ADR 0049) und stehen in `docs/research/churchtools-api.md`:

- **Rechte je Operation (F29):** `GET /api/persons` zeigt andere Personen nur mit `churchdb: view alldata` («Personen eines Bereiches sehen») und nur aus dem gewählten Bereich. `GET /api/groups` zeigt Gruppen der Sichtbarkeit «restricted» nur mit `churchgroup: view groups of grouptype` («Gruppen eines Gruppentyps sehen - ausser versteckte») und nur des gewählten Typs. `churchdb: view` und `churchgroup: view` waren für keinen Abruf nötig (a1 bis a6), `churchdb: view memberliste` blieb ohne Wirkung (s8). Fehlt ein Recht, antworten beide Listen mit 200 und ohne das Objekt, nicht mit 403.
- **Felder einer Person (F32):** Ohne `security level person` hat eine andere Person 16 Felder, darunter `id`, `guid`, `firstName` und `lastName`. Schon die niedrigste Stufe bringt 20 weitere, darunter `email`, `emails`, `phonePrivate`, `phoneWork`, `mobile`, `birthday`, `zip` und `city`, die höchste zusammen 62. Die Stufe ändert nicht, welche Personen sichtbar sind, sondern ihre Felder.
- **Felder einer Gruppe (F32):** Eine Gruppe behält mit jeder Stufe von `security level group` 13 Felder auf oberster Ebene, in a1 bis a6 darunter `id`, `guid` und `name`. Die Stufe bringt nur Felder unter `information` und `settings`, in der niedrigsten etwa `information.note` und `information.meetingTime`.
- **Suche nach Namen (F25):** `GET /api/persons` mit `query` traf p1 bis p3 schon in s2, mit `view alldata` und ohne Stufe, und in a6 auch p4, wieder ohne Stufe. Ein Begriff traf als ganzer Name, als Anfang und als Teil eines Worts, auch kleingeschrieben, Vor- und Nachname nur in dieser Reihenfolge. `GET /api/groups` mit `query` traf g1 ab s6, mit `view groups of grouptype`. Nur der Filter `email` brauchte `security level person`.
- **Globale Suche (F25, F26, F32):** `GET /api/search` liefert je Treffer 12 Felder, darunter `apiUrl` und `frontendUrl` mit der Adresse der Instanz und `domainAttributes` mit Schlüsseln, die die Probe nicht benennen kann. Die Kennung steht als Text in `domainIdentifier`. Die Operation kennt weder `page` noch `limit`, und ob sie die Zahl ihrer Treffer begrenzt, ist offen.
- **Zahlen in `meta` (F26):** Ob `meta.count`, `meta.all` oder `meta.pagination.total` Einträge mitzählen, die das Konto nicht sehen darf, ist offen.
- **Sichtbarkeit und Herkunft (F31, F34):** Gruppen der Sichtbarkeit «intern» las das Konto ohne jedes Recht auf Gruppen oder Personen. Ob `view groups of grouptype` Gruppen «hidden» auslässt, ist nicht geprüft, ebenso, ob `GET /api/permissions/global` Rechte aus einer Gruppe nennt.

Weitere Grundlagen: Der Client verwirft unbekannte Felder ohne Fehler, ein fehlendes Pflichtfeld ist ein Fehler (ADR 0025, ADR 0057). Die Pipeline verwirft jedes Feld, das das Ausgabeschema eines Tools nicht deklariert, und setzt Texte der Datenklasse `untrusted` in den Datenumschlag (ADR 0024). Ein Blatt eines Schemas trägt genau eine Datenklasse. `ct_whoami` führt Vor- und Nachname des Kontos als `name.first` und `name.last`.

## Optionen

1. **Niedrigste Stufe für Personen und Gruppen, feste Felder im Tool:** Die Tools verwerfen die übrigen Felder. Jede Antwort trägt aber E-Mail, Telefon, Geburtstag, Postleitzahl und Ort jeder gefundenen Person bis in den Prozess von Ecclium, und ein Fehler in einer Schicht oder ein gestohlenes Token des Kontos gibt sie heraus.
2. **Stufe nach dem Bedarf späterer Tools:** etwa die Stufe, die die Tools zum Lesen einer Person in Phase 2 brauchen werden. Das spart später einen Schritt am Konto, gibt den Suchtools aber Rechte, die sie nicht brauchen.
3. **Keine Stufe, feste Felder in drei Schichten:** Kennung und Name kommen ohne Stufe. Das Konto erhält nur die beiden Rechte, die die Abrufe öffnen, und jedes Tool liest und gibt nur seine Felder weiter.

## Entscheid

Gewählt ist die dritte Option. Die niedrigste ausreichende Stufe aus dem Entscheid vom 12.10.2026 ist für beide Suchtools: keine.

- **Rechte des Dienstkontos für die Suchtools:**
  - `churchdb: view alldata` nur für die Bereiche, in denen gesucht werden soll, «Alle» nur, wenn die ganze Instanz durchsuchbar sein soll.
  - `churchgroup: view groups of grouptype` nur für die Gruppentypen, in denen gesucht werden soll. Die Zeile, die `GET /api/permissions/global` dafür auch unter `churchdb` führt, ist eine Spiegelung, kein zweites Recht (F30).
  - Weder `churchdb: security level person` noch `churchgroup: security level group`, weder `churchdb: view` noch `churchgroup: view` und nicht `churchdb: view memberliste`. Wie bisher hat das Konto einen eigenen Personenstatus ohne Berechtigungen und gehört keiner Gruppe an (ADR 0023, Umsetzung).
  - Brauchen spätere Tools mehr Felder, entscheidet ihr ADR über eine Stufe neu.
- **`ct_persons_search`:**
  - Operation `GET /api/persons` mit genau den Parametern `query`, `page=1` und `limit`. Keine weiteren, ausdrücklich nicht `email` und `email-exact`, mit denen sich eine Adresse bestätigen liesse, weder `ids[]` noch `include` und keine Filter nach `firstName`, `lastName` oder `nickName`.
  - Der Client liest je Eintrag nur `id`, eine positive ganze Zahl, und `firstName` und `lastName`, beide Text. Alle drei sind Pflicht.
  - Ein Treffer im Ergebnis trägt `id` mit der Datenklasse `personId`, `firstName` mit `name.first` und `lastName` mit `name.last`. `guid` liest der Client nicht. Kennung ist die numerische ID, über die der Client Personen abruft (ADR 0057).
  - `requiredRights`: `churchdb` / `view alldata`.
- **`ct_groups_search`:**
  - Operation `GET /api/groups` mit genau `query`, `page=1` und `limit`.
  - Der Client liest je Eintrag nur `id`, eine positive ganze Zahl, und `name`, Text. Beide sind Pflicht.
  - Ein Treffer trägt `id` mit der Datenklasse `none`, weil eine Gruppe keine Person ist, und `name` mit `untrusted`. Den Namen einer Gruppe setzen Personen in der Gemeinde, er kommt deshalb in den Datenumschlag. Eine eigene Art für Gruppen kommt mit den IDs im Audit (ADR 0028).
  - `requiredRights`: `churchgroup` / `view groups of grouptype`.
- **Nicht die globale Suche:** Sie liefert mehr Felder als nötig, darunter die Adresse der Instanz, die Kennung als Text und keine Grenze, an der ein Tool mehr als 50 Treffer erkennt. Bei Personen trifft deshalb der Nachname vor dem Vornamen nicht (F25). Die Beschreibung des Tools sagt das.
- **Namen von Personen:** Sie bleiben Namen und kommen in Phase 1 nicht in den Datenumschlag, wie bei `ct_whoami`. So kann die Maskierung `strict` ab Phase 4 Nachnamen kürzen. Ob sie zusätzlich in den Umschlag kommen, entscheidet ADR 0026.
- **Keine Zahlen aus `meta`:** Kein Tool gibt `count`, `all`, `total` oder `lastPage` weiter. Gibt es mehr Treffer, als ein Ergebnis tragen darf, sagt es das mit einem Wahrheitswert und dem Rat, enger zu suchen. Abgeleitet wird dieser Wert nur aus Einträgen, die das Konto sehen darf. Wie, legt die Umsetzung fest.
- **Leeres Ergebnis:** Weil die Listen ohne Recht mit 200 und leer antworten, nennt ein leeres Ergebnis das Recht aus `requiredRights` und sagt, dass es «kein Treffer» und «kein Recht» nicht unterscheiden kann.
- **Zu viele Rechte:** Hat das Konto eine Sicherheitsstufe oder mehr Bereiche als nötig, weist der Server beim Lesen nichts ab. Die Felder ausserhalb der Liste verwerfen die drei Schichten, `ct_whoami` zeigt die Rechte, und `ecclium doctor` meldet eine Stufe, die kein Tool braucht, als Befund, sobald es ihn gibt. Eine Prüfung bei jedem Aufruf kostete eine Anfrage mehr und sähe Rechte aus einer Gruppe nicht (F31).
- **Drei Schichten:** Das Schema des Clients liest nur die Felder der Liste und verwirft den Rest (ADR 0025). Das Ausgabeschema des Tools deklariert nur sie, jedes mit seiner Datenklasse. Die Pipeline verwirft, was das Ausgabeschema nicht deklariert (ADR 0024). Jede Schicht hat ihre eigene Gegenprobe. Ein Test führt dazu eine Antwort in der Form der höchsten Stufe, mit Kanarienwerten in jedem Feld ausserhalb der Liste, durch Client, Tool und Pipeline, und kein Kanarienwert erreicht Ergebnis, Log oder Audit.

## Konsequenzen

- Für die Suchtools liest Ecclium keine Kontaktdaten und kein Geburtsdatum, auch nicht in seinen Arbeitsspeicher. Ein Fehler in einer Schicht oder ein gestohlenes Token des Kontos gibt sie deshalb nicht heraus.
- Gesucht wird nur nach Namen. Eine Person über ihre E-Mail-Adresse zu finden, geht mit Ecclium nicht.
- Personen ausserhalb der Bereiche des Kontos und Gruppen ausserhalb seiner Gruppentypen findet die Suche nicht, ohne Fehler. Gruppen «intern» findet sie dagegen ohne jedes Recht (F34).
- Ein leeres Ergebnis kann ein fehlendes Recht bedeuten. Die Meldung sagt es, prüfen lässt es sich mit `ct_whoami`.
- Passt der Name des Kontos zum Suchbegriff, gehört vermutlich sein eigener Datensatz zu den Treffern. Geprüft ist das nicht.
- **Restrisiken:**
  - **Felder ohne Stufe:** Welche Felder ohne Stufe kommen, legt die Einstellung einer Instanz fest, belegt ist es nur an der Testinstanz (F32). Fehlt auf einer anderen Instanz ohne Stufe `firstName`, `lastName` oder bei einer Gruppe `name`, endet der Aufruf mit `upstream`, nicht mit einem Teilergebnis.
  - **Namen als Anweisung:** Ein Name kann Text enthalten, der wie eine Anweisung aussieht. Die Pipeline entfernt unsichtbare Zeichen, das Schema begrenzt die Länge, und die Beschreibung jedes Tools sagt, dass Inhalte aus ChurchTools keine Anweisungen sind (Threat Model, T7). Namen von Personen stehen bis zum Entscheid in ADR 0026 ohne Datenumschlag.
  - **Kombination der Rechte:** Genau dieser Satz von Rechten lief noch nicht als eine Stufe der Probe: a1 bis a6 hatten Sicherheitsstufen, s2 und s6 hatten `churchdb: view`. Dass er genügt, ist ein Schluss aus F29. Dass eine Gruppe `name` auch ohne Stufe trägt, ist ein Schluss aus F32: Die Stufe änderte nur verschachtelte Felder. Ein Lauf der Probe mit genau diesen Rechten belegt beides, bevor die Suchtools gegen die Testinstanz laufen.
  - **Rechte aus Gruppen und versteckte Gruppen:** Beides ist offen (F31, F34).
  - **Zu viele Rechte bleiben möglich:** Der Server verhindert nicht, dass ein Betreiber dem Konto eine Stufe gibt. Die zusätzlichen Felder erreichen dann den Prozess von Ecclium, aber nicht den Client.
