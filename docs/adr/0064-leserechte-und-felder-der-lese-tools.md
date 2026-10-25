# ADR 0064: Leserechte des Dienstkontos und feste Felder der Lese-Tools

- Status: Angenommen am 25.10.2026
- Datum: 25.10.2026
- Fällt vor: Phase 2

## Kontext

Phase 2 bringt die übrigen Lese-Tools: Personen und Gruppen, Events, Dienste und Abläufe, Kalender, Termine, Ressourcen und Buchungen, Songs, die Suche im Wiki und die globale Suche (`docs/STATUS.md`, Weitere Entscheide, Plan für Phase 2). Wie ADR 0060 für die Suchtools legt dieses ADR fest, welche Rechte das Dienstkonto des Servers dafür erhält und welche Felder jedes Tool liest und weitergibt, bevor die Tools entstehen.

Entschieden sind schon: Das Konto erhält keine Sicherheitsstufe für Personen. Für `ct_groups_get` erhält es die niedrigste Stufe für Gruppen. Listen mit Personen blättern mit höchstens 50 Einträgen je Seite, und jede Seite zählt gegen das Lesebudget. Einteilungen in Dienste mit Namen gelten als `personal`, nicht als `special`, aber Zurückhalten über die Audit-Datei und Lesebudget gelten auch für Tools, die Namen anderer Personen ausgeben. `ct_search` gibt je Treffer nur Art, Kennung und Titel weiter, nur für Arten, die eine Probe belegt, höchstens 50 (`docs/STATUS.md`, Plan für Phase 2). Bei einem Dienst, der die Namen der Eingeteilten verbirgt, gibt kein Tool die Person weiter (Entscheid vom 25.10.2026).

Die Befunde stammen aus `08-persons-groups-read` und `09-domains-read` an ChurchTools 3.137 auf der Testinstanz (ADR 0049) und stehen in `docs/research/churchtools-api.md`:

- **Rechte je Operation (F29, F36):** Personen öffnet `churchdb: view alldata` je Bereich, Gruppen `churchgroup: view groups of grouptype` je Gruppentyp. Ein Event öffnet `churchservice: view events` je Kalender, seine Einteilungen dazu `view servicegroup` je Dienstgruppe, seinen Ablauf `view agenda` je Kalender, auch ohne `view events`. Kalender und Termine öffnet `churchcal: view category` je Kalender, Ressourcen und Buchungen `churchresource: view resource` je Ressource, Songs `churchservice: view songcategory` je Kategorie. Dienste, Dienstgruppen und Ressourcentypen liest jedes Konto ohne diese Rechte.
- **Das Recht `view` der Module (F36):** Im Lauf mit genau dem Satz dieses ADR ergaben alle Abrufe beider Proben ohne `churchservice: view`, `churchcal: view` und `churchresource: view` dasselbe wie mit ihnen. Kein Abruf braucht sie.
- **Antworten ohne Recht (F29, F36):** Listen antworten mit 200 und leer, Einzelabrufe und die Listen der Termine und Buchungen mit 403. Ohne `view servicegroup` antwortet ein Event mit 200 und leerem `eventServices`.
- **Felder (F32, F34, F37):** Eine andere Person hat ohne Sicherheitsstufe 16 Felder. Eine Gruppe hat mit der niedrigsten Stufe sieben Felder mehr, darunter `information.note` und `information.meetingTime`. Einteilungen nennen die eingeteilte und die anfragende Person mit Vor- und Nachname. Bei einem Dienst, der die Namen verbirgt, kam ein Platzhalter statt des Namens und keine positive ID. Kalender tragen `randomUrl`, Termine einen Ort mit Strasse und Koordinaten, viele Objekte IDs von Personen in `meta`.
- **Blättern (F26, F27, F38):** Personen-, Gruppen- und Mitgliederliste sowie die Lieder tragen `meta.pagination`. Die Events tragen nur `meta.count`, und `page` wirkte dort nicht. Die globale Suche und die übrigen Listen kennen weder `page` noch `limit`.
- **Suche (F25, F40):** Die globale Suche zählt die Arten `action`, `group`, `person`, `song` und `wiki_page` auf. `person` und `group` belegt `08`, `song` und `wiki_page` belegt `09`, eine Suche nur nach `action` lehnt die Instanz ab. `GET /api/songs` sucht mit `query`, `GET /api/wiki/search` auch ohne `wiki_category_ids[]`.

Weitere Grundlagen: Der Client verwirft unbekannte Felder (ADR 0025, ADR 0057). Die Pipeline lässt nichts durch, was das Ausgabeschema nicht deklariert, und setzt Texte der Klasse `untrusted` in den Datenumschlag (ADR 0024). Jedes Blatt trägt eine Datenklasse, und bis Phase 4 weist die Registry die Klassen `address` und `amount` ab (ADR 0026). Ein Ergebnis über 64 KiB ist ein Fehler (ADR 0024).

## Optionen

1. **Rechte und Felder, wie die Tools sie brauchen könnten:** Das Konto erhält die Rechte der Module mit «Alle» und `view`, die Tools geben aus, was ChurchTools liefert. Einfach einzurichten, aber jede Antwort trägt Orte, Links zum Abonnieren und IDs von Personen bis zum Client.
2. **Enge Rechte, feste Felder je Tool in drei Schichten:** Das Konto erhält nur die Rechte, die einen Abruf öffnen, mit Werten nur für die Kalender, Dienstgruppen, Ressourcen und Kategorien, die gelesen werden sollen. Jedes Tool liest und gibt nur seine Felder weiter, wie ADR 0060 es für die Suchtools festlegt.

## Entscheid

Gewählt ist die zweite Option.

**Rechte des Dienstkontos.** Der Betreiber vergibt sie direkt am Konto, nur für die Tools, die er einschaltet, und jedes Recht mit Wert nur für die Objekte, die gelesen werden sollen. «Alle» passt nur, wenn die ganze Instanz gemeint ist.

| Tool                                                               | Rechte                                                                                                      |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `ct_persons_get`                                                   | `churchdb: view alldata` je Bereich                                                                         |
| `ct_persons_get_groups`                                            | `churchdb: view alldata` je Bereich, `churchgroup: view groups of grouptype` je Gruppentyp                  |
| `ct_groups_get`                                                    | `churchgroup: view groups of grouptype` je Gruppentyp, `churchgroup: security level group` niedrigste Stufe |
| `ct_groups_get_members`                                            | `churchgroup: view groups of grouptype` je Gruppentyp, `churchdb: view alldata` je Bereich                  |
| `ct_events_list`, `ct_events_get`                                  | `churchservice: view events` je Kalender                                                                    |
| `ct_events_get_agenda`                                             | `churchservice: view agenda` je Kalender                                                                    |
| `ct_services_list`                                                 | keines                                                                                                      |
| `ct_services_get_assignments`                                      | `churchservice: view events` je Kalender, `churchservice: view servicegroup` je Dienstgruppe                |
| `ct_calendars_list`, `ct_appointments_list`, `ct_appointments_get` | `churchcal: view category` je Kalender                                                                      |
| `ct_resources_list`, `ct_bookings_list`                            | `churchresource: view resource` je Ressource                                                                |
| `ct_songs_search`, `ct_songs_get`                                  | `churchservice: view songcategory` je Kategorie                                                             |
| `ct_wiki_search`                                                   | `churchwiki: view` und `view category` je Kategorie, wie die übrigen Tools des Wikis                        |
| `ct_search`                                                        | die Rechte der Arten, die gesucht werden sollen, aus den Zeilen oben und aus ADR 0060                       |

Das Konto erhält weder `churchservice: view` noch `churchcal: view` noch `churchresource: view`, keine Sicherheitsstufe für Personen, keine Gruppe und kein Recht zum Schreiben, wie bisher (ADR 0060). Jedes Tool nennt in `requiredRights` die Rechte, die seinen Abruf öffnen.

**Gemeinsame Regeln aller Tools dieses ADR.**

- **Drei Schichten wie ADR 0060:** Das Schema des Clients liest nur die Felder unten, das Ausgabeschema deklariert nur sie mit ihrer Klasse, die Pipeline lässt nichts anderes durch. Ein Test schickt je Operation eine Antwort mit Kanarienwerten in jedem anderen Feld durch alle drei Schichten.
- **Nie gelesen und nie weitergegeben:** `randomUrl` und `randomString`, die Verweise `apiUrl` und `frontendUrl`, IDs von Personen in `meta` und in `answeredPid`, `onBehalfOfPid`, `adminIds`, `eventAdminIds` und `requesterPersonId`, die anfragende Person einer Einteilung, `responsible` und `serviceGroupNotes` im Ablauf, deren Form unbekannt ist, die Kopien unter `@deprecated`, Dateien und Links von Arrangements und Strasse, Postleitzahl, Ort und Koordinaten eines Termins.
- **Klassen:** Kennungen von Personen `personId`, Vor- und Nachnamen `name.first` und `name.last` ausserhalb des Umschlags (ADR 0026). Titel, Namen von Objekten, Notizen, Beschreibungen, Orte und Vorschauen aus ChurchTools `untrusted`. Daten mit Zeit, Zahlen, Wahrheitswerte und Kennungen anderer Objekte `none`. Daten mit Zeit gibt ein Tool als Text weiter, wie ChurchTools sie liefert, mit «T» und `Z` (F37).
- **Zeitraum statt freiem Blättern:** Events, Termine und Buchungen fragt ein Tool mit `from` und `to` ab, höchstens 31 Tage. Es gibt höchstens 50 Einträge weiter und meldet mit `more`, dass weitere folgen. Bei den Events sendet es `limit=51`, verlässt sich aber nicht darauf, weil nicht belegt ist, dass es kürzt (F38).
- **Listen ohne `page`:** Kalender, Ressourcen und Dienste liefert ChurchTools in einer Antwort. Das Tool blättert darin selbst, 50 je Aufruf, wie `ct_wiki_categories_list`.
- **Leeres Ergebnis:** Antwortet ChurchTools ohne Recht leer, nennt das Ergebnis das Recht aus `requiredRights` und sagt, dass sich «nichts gefunden» und «kein Recht» nicht unterscheiden lassen. Ein 403 endet als Ablehnung, die das Recht nennt.
- **Namen anderer Personen in `personal`-Tools:** Die Registry leitet es aus dem Ausgabeschema ab. Ein Tool, dessen Ausgabe ein Blatt der Klasse `personId`, `name.first` oder `name.last` trägt, gibt sein Ergebnis nur hinaus, wenn die Zeile des Aufrufs ganz in der Audit-Datei steht, und zählt gegen das Lesebudget, wie ein Tool mit `sensitivity: special`. Unbeaufsichtigt bleibt es nach der Richtlinie erlaubt. Ausgenommen ist `ct_whoami` im Bereich `base`, das nur das eigene Konto nennt. Eine Ableitung kann ein Tool nicht vergessen, ein Merkmal in den Metadaten schon.
- **`routineStable`:** Für jedes Tool `false`, bis der Lauf vor dem Abschluss von Phase 2 seine Form bestätigt.

**Die Tools.**

- **`ct_persons_get`** (`special`, `unattended: never`): `GET /api/persons/{personId}` über die numerische ID. Liest `id`, `firstName`, `lastName` und `isArchived`, nicht `guid` und keines der übrigen Felder ohne Stufe.
- **`ct_persons_get_groups`** (`special`): `GET /api/persons/{personId}/groups` ohne Parameter. Liest je Eintrag aus dem Objekt `group` die ID aus `domainIdentifier`, wenn sie eine positive ganze Zahl ist, und den Titel, dazu `groupTypeRoleId` und `groupMemberStatus`, nicht das Objekt `person`. Höchstens 50, mit `more`.
- **`ct_groups_get`** (`special`): `GET /api/groups/{groupId}` über die ID. Liest `id`, `name` und sechs der sieben Felder der niedrigsten Stufe: `information.meetingTime` und `information.note` als `untrusted`, `information.maxMembers`, `information.targetGroupId`, `information.dateOfFoundation` und `information.endDate` als `none`, nicht `settings.qrCodeCheckinAutomaticEmail`. Das Format der beiden Daten ist nicht belegt (F32), das Schema nimmt nur ein Datum oder `null` an.
- **`ct_groups_get_members`** (`special`): `GET /api/groups/{groupId}/members` über die ID mit `page` und `limit=50`, ohne `personFields[]` und ohne `include`. Liest je Eintrag `personId`, Vor- und Nachname aus `person.domainAttributes`, `groupTypeRoleId` und `groupMemberStatus`. Jede Seite zählt gegen das Budget.
- **`ct_events_list`** (`personal`): `GET /api/events` mit `from`, `to` und `limit=51`, ohne `include`, `direction` und `canceled`. Liest je Event `id`, `name`, `startDate`, `endDate`, `isCanceled` und vom Kalender die ID aus `domainIdentifier`, wenn sie eine positive ganze Zahl ist, und den Titel.
- **`ct_events_get`** (`personal`): `GET /api/events/{eventId}`. Dieselben Felder, dazu `note` und `description`, nie `eventServices`.
- **`ct_events_get_agenda`** (`personal`): `GET /api/events/{eventId}/agenda`. Liest `name`, `isFinal` und je Punkt `position`, `type`, `title`, `start`, `duration`, `isBeforeEvent`, `note` und von einem Lied `songId`, `arrangementId`, `title` und `arrangement`.
- **`ct_services_list`** (`none`): `GET /api/services` und `GET /api/servicegroups`. Liest je Dienst `id`, `name`, `serviceGroupId` und `hidePersonName`, je Dienstgruppe `id` und `name`.
- **`ct_services_get_assignments`** (`personal`, Namen anderer Personen): `GET /api/events/{eventId}` und `GET /api/services`. Liest je Einteilung `serviceId`, `isAccepted`, `agreed`, `personId` und Vor- und Nachname der eingeteilten Person. Verbirgt der Dienst laut `hidePersonName` die Namen, oder trägt die Person keinen Vornamen und keine positive ID, gibt das Tool nur Dienst und Status weiter, ohne Kennung und Namen, auch wenn ChurchTools sie liefert.
- **`ct_calendars_list`** (`none`): `GET /api/calendars`. Liest `id`, `name`, `isPublic` und `isPrivate`.
- **`ct_appointments_list`** (`personal`): `GET /api/calendars/appointments` mit höchstens zehn IDs in `calendar_ids[]`, `from` und `to`, ohne `include[]` und `query`. Liest je Vorkommen aus `appointment.base` `id`, `title`, `subtitle`, `allDay`, die ID des Kalenders und `address.name`, aus `appointment.calculated` `startDate` und `endDate`.
- **`ct_appointments_get`** (`personal`): `GET /api/calendars/{calendarId}/appointments/{appointmentId}`. Dieselben Felder aus `appointment`, dazu `description` und `link`, und je Vorkommen aus `calculatedDates` `startDate` und `endDate`.
- **`ct_resources_list`** (`none`): `GET /api/resources` und `GET /api/resourcetypes`. Liest je Ressource `id`, `name` und `resourceTypeId`, je Ressourcentyp `id` und `name`.
- **`ct_bookings_list`** (`personal`): `GET /api/bookings` mit höchstens zehn IDs in `resource_ids[]`, `from` und `to`, ohne `include[]`, `query`, `person_id` und `status_ids[]`. Liest je Buchung aus `booking.base` `id`, `title`, `resourceId`, `statusId` und `appointmentId`, aus `booking.calculated` `startDate` und `endDate`.
- **`ct_songs_search`** (`none`): `GET /api/songs` mit `query`, `page` und `limit=25`. Liest je Lied `id`, `name`, den Namen der Kategorie, `author`, `copyright` und `ccli`, je Arrangement `id`, `name`, `key` und `isDefault`.
- **`ct_songs_get`** (`none`): `GET /api/songs/{songId}`, dieselben Felder.
- **`ct_wiki_search`** (`personal`): `GET /api/wiki/search` mit `query` und höchstens einer Kategorie in `wiki_category_ids[]`. Liest je Treffer `domainIdentifier`, `domainAttributes.wikiCategoryId`, `title` und `preview`. Höchstens 25 Treffer, mit `more`.
- **`ct_search`** (`special`): `GET /api/search` mit `query` und genau einer Art in `domain_types[]`, für `person`, `group`, `song` und `wiki_page`, nie `action`. Liest je Treffer `domainIdentifier` und `title`. Treffer einer Person kommen mit `personId` und dem Titel als `name.last`, damit die Maskierung `strict` ab Phase 4 ihn kürzt, die übrigen mit `none` und `untrusted`. Höchstens 50 je Art, mit `more`.

## Konsequenzen

- Mit den Rechten dieses ADR liest Ecclium keine Kontaktdaten, keinen Geburtstag und keine Adresse einer Person, auch nicht in seinen Arbeitsspeicher. Vom Ort eines Termins liest der Client nur den Namen.
- Der Betreiber muss je Tool die richtigen Kalender, Dienstgruppen, Ressourcen, Kategorien, Bereiche und Gruppentypen wählen. Fehlt einer, sieht das Tool dessen Objekte nicht und meldet keinen Fehler. `docs/betrieb/dienstkonto.md` beschreibt die Rechte je Tool.
- Ein Konto, das den Ablauf eines Events lesen darf, aber nicht das Event, liest den Ablauf trotzdem (F36). Wie es die ID eines solchen Events findet, ist offen.
- Weil Termine und Buchungen nur mit IDs abgefragt werden, braucht ein Lauf zuerst `ct_calendars_list` oder `ct_resources_list`.
- Dienste, Dienstgruppen und Ressourcentypen liest jedes Konto (F36). `ct_services_list` braucht deshalb kein Recht.
- **Restrisiken:**
  - **Rechte nur an der Testinstanz belegt:** Welche Felder ohne Stufe kommen und welches Recht welchen Abruf öffnet, gilt für ChurchTools 3.137 und die Einstellungen der Testinstanz. Fehlt auf einer anderen Instanz ein Pflichtfeld, endet der Aufruf mit `upstream`.
  - **Verborgene Namen:** Auf der Testinstanz lieferte ChurchTools bei einem Dienst, der die Namen verbirgt, einen Platzhalter und keine positive ID. Ob das von der Einstellung des Dienstes oder vom Stand der Anfrage abhängt, ist offen. Das Tool verlässt sich nicht darauf.
  - **Freitext:** Titel, Notizen, Beschreibungen, Vorschauen des Wikis und Namen von Orten können Personen nennen oder wie Anweisungen aussehen. Sie stehen im Datenumschlag, maskiert werden sie in Phase 2 nicht.
  - **`limit` bei Events:** Ob es kürzt, ist offen (F38). Gibt ChurchTools mehr zurück, liest der Client bis zu seiner Grenze für Antworten, und das Tool gibt 50 weiter.
  - **Zu viele Rechte:** Der Server weist ein Konto mit mehr Rechten nicht ab, wie in ADR 0060. Mit «Alle» sieht das Konto mehr Objekte, mit einer Sicherheitsstufe für Personen erreichen Kontaktdaten den Prozess von Ecclium, aber nicht den Client.

## Umsetzung

Seit dem 25.10.2026:

- **Lauf mit genau diesem Satz:** Am 25.10.2026 wurden am Dienstkonto des Servers in der Weboberfläche der Testinstanz die Rechte der Tabelle gesetzt, im Lauf z1 mit `view` der drei Module, jedes Recht mit Wert nur für ein synthetisches Objekt. Die Gegenprobe y1 nahm die drei `view` wieder weg. `02-permissions` zeigte vor jedem Lauf genau diese Rechte. `08-persons-groups-read` und `09-domains-read` ergaben in y1 dasselbe wie in z1, `09` dasselbe wie in der Stufe d6 mit allen Rechten der Bereiche (`docs/research/churchtools-api.md`, F36). Das Konto behält den Satz von y1 für die Läufe der Tools bis zur Abnahme von Phase 2.
- **Proben:** `08` prüft seinen Wächter seither mit denselben Leserechten wie `09`, damit beide mit diesem Satz laufen. `09` prüft zusätzlich, ob ein verborgener Name echt ist, die Suche nach Liedern und die Suche im Wiki ohne Kategorie.
- **Tools:** Sie entstehen in den Schüben für Personen und Gruppen, Events, Kalender und Ressourcen und für Songs und die Suche. Die Ableitung der Registry für Namen anderer Personen kommt mit dem ersten Tool, das solche Namen ausgibt, ohne `sensitivity: special` zu tragen.
- **Personen und Gruppen:** seit dem 25.10.2026 `ct_persons_get`, `ct_persons_get_groups`, `ct_groups_get` und `ct_groups_get_members` in `packages/tools/src/persons/` und `groups/`, alle `special` und `unattended: never` im Toolset `persons`, mit den Operationen, Parametern, Feldern und Klassen oben. Der Client liest sie mit eigenen Schemas (ADR 0057), der Lesezugriff gibt die vier Abrufe wie die Suchen nur Tools mit `sensitivity: special`. Dazu kamen Entscheide, die das ADR offen liess: Der Stand einer Mitgliedschaft hat die Form eines Worts von ChurchTools aus Kleinbuchstaben und Unterstrich, höchstens 32 Zeichen, mit der Klasse `none`, jede andere Form endet mit `upstream`. Ist die Kennung einer Gruppe in `domainIdentifier` keine ganze Zahl ab 1 in einfacher Schreibweise, gibt das Tool die Gruppe mit `null` als Kennung weiter. Die Angaben einer Gruppe kommen alle oder keine. Fehlen alle, wie bei einem Konto ohne die Stufe für Gruppen, gibt `ct_groups_get` Kennung und Name mit einem Hinweis auf das Recht weiter, fehlt ein Teil, endet der Aufruf mit `upstream`. Die Treffzeit liest der Client bis 255 Zeichen, die Notiz bis 10'000. Bei der Mitgliederliste kommt `more` aus `meta.pagination.lastPage`, das allein der Client aus `meta` liest. Eine leere spätere Seite sagt, ob noch Seiten folgen. Der Smoke-Test ruft die vier Tools mit der ersten Person und der ersten Gruppe der Suchen auf und meldet nur noch die Stufe für Personen als Befund.
