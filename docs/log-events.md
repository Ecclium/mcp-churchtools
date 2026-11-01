# Logzeilen

<!-- Erzeugt mit `pnpm docs:generate` aus dem Katalog der Logzeilen. Nicht von Hand ändern. -->

Diese Seite entsteht mit `pnpm docs:generate` aus dem Katalog der Logzeilen im Kern ([ADR 0054](adr/0054-secret-fehler-logger-audit.md)). Ein Test liest jeden Aufruf eines Loggers im Code und scheitert an einer Zeile, die hier fehlt, an einer anderen Stufe und an einem Feld, das hier nicht steht. Ändern Sie die Seite deshalb nicht von Hand.

Ecclium schreibt seine Logzeilen als JSON Lines nach stderr, über stdio also dorthin, wo der Client stderr hinschreibt, etwa in eine Logdatei je Server. Eine Zeile trägt nur die Felder unten und nur Werte einer festen Form: keinen Text aus ChurchTools, keine Namen oder Kennungen von Personen, keine Pfade, Adressen oder Hosts und kein Token. Ein Ereignis, das nicht unter «Ereignisse» steht, schreibt der Logger als `invalid_event`, auch das eines Plugins, damit kein Name aus Daten in eine Zeile kommt. Neben den Logzeilen gehen nach stderr die Kopien der Zeilen des Audits, siehe [Audit-Ereignisse](audit-events.md), und die Meldungen der Kommandozeile für Betreiber.

## Felder

In dieser Reihenfolge, jedes nur, wenn es einen Wert hat. Die Felder des Kerns bindet der Kern an den Logger eines Aufrufs, ein Aufruf kann sie nicht setzen.

| Feld | Gesetzt von | Bedeutung |
| --- | --- | --- |
| `ts` | Logger | Zeit der Zeile in UTC, auf die Millisekunde. |
| `level` | Logger | Stufe der Zeile: `debug`, `info`, `warn`, `error`. |
| `event` | Logger | Name des Ereignisses, einer der Namen unter «Ereignisse» oder `invalid_event`. |
| `tenantId` | Kern | Kennung des Mandanten, über stdio `default`. |
| `runId` | Kern | Kennung des Laufs einer Routine. |
| `eventId` | Kern | Kennung des Aufrufs, gleich der `eventId` seiner Zeile im Audit. So finden Sie die Logzeilen zu einer Zeile des Audits. |
| `tool` | Kern | Name des Tools des Aufrufs. |
| `prompt` | Aufruf | Name eines Prompts aus dem Katalog, nie der Wert eines Arguments. |
| `code` | Aufruf | Stabiler Fehlercode, etwa `upstream` oder `policy_denied`, nie eine Meldung. |
| `mode` | Kern | Wie der Aufruf lief: interaktiv, unbeaufsichtigt oder durch den Betreiber. |
| `redaction` | Kern | Stufe der Maskierung des Aufrufs. |
| `readOnly` | Kern | Ob der Aufruf nur lesen durfte. |
| `durationMs` | Aufruf | Dauer in Millisekunden, höchstens ein Tag. |
| `count` | Aufruf | Eine Zahl, deren Bedeutung das Ereignis nennt, höchstens 1'000'000. |
| `method` | Aufruf | Methode einer Anfrage an ChurchTools: `GET` liest, `POST`, `PUT`, `PATCH` und `DELETE` schreiben. |
| `status` | Aufruf | Status einer Antwort von ChurchTools, 100 bis 599. |
| `attempt` | Aufruf | Nummer eines Versuchs, 1 bis 10. Heute setzt ihn keine Zeile, der Runner braucht ihn ab Phase 6. |
| `file` | Aufruf | Name einer Audit-Datei nach ihrem festen Muster, nie ein Pfad, nur im Anker. |
| `seq` | Aufruf | Stelle des Kopfs der Kette einer Audit-Datei, nur im Anker. |
| `hash` | Aufruf | SHA-256 des Kopfs der Kette einer Audit-Datei, hexadezimal, nur im Anker. |
| `dropped` | Logger | Zahl der Felder, die ein Aufruf mitgab und der Logger wegliess, weil Name oder Wert nicht erlaubt war. |

## Ereignisse

Je Ereignis die Stufe und die Felder, die ein Aufruf höchstens setzt. Die Felder des Kerns kommen je nach Logger dazu.

### Pipeline der Tools

| Ereignis | Stufe | Felder | Bedeutung |
| --- | --- | --- | --- |
| `audit_withheld` | `warn` | `code` | Die Zeile eines Aufrufs kam nicht ganz in die Audit-Datei. Ecclium hält das Ergebnis zurück, der Aufruf endet mit `policy_denied`. |
| `pseudonym_keys_unavailable` | `warn` | keine | In `strict` fehlte der Schlüssel für die Pseudonyme eines Aufrufs. Der Aufruf endet mit einem Fehler. |
| `read_budget_exhausted` | `warn` | keine | Das Lesebudget des Akteurs für diesen UTC-Tag ist aufgebraucht. Der Aufruf endet mit `policy_denied`, ohne ChurchTools zu fragen. |
| `read_budget_unavailable` | `warn` | keine | Ecclium konnte das Lesebudget nicht zählen. Der Aufruf endet mit `policy_denied`, ohne ChurchTools zu fragen. |
| `tool_boundary_failed` | `warn` | keine | Für den Datenumschlag liess sich keine Grenze finden, die im Ergebnis nicht vorkommt. Das Ergebnis geht nicht hinaus. |
| `tool_call` | `info` | `code`, `durationMs` | Ein Aufruf eines Tools ist zu Ende, mit oder ohne Fehler. `code` nennt den Fehler, `durationMs` die Dauer. Zu jedem Aufruf gehört eine Zeile im Audit. |
| `tool_output_invalid` | `warn` | keine | Das Ergebnis eines Tools passte nicht zu seinem Schema, oder das Audit konnte eine Kennung darin nicht nennen. Es geht nicht hinaus. |
| `tool_pseudonym_failed` | `warn` | keine | In `strict` liess sich eine Kennung einer Person im Ergebnis nicht durch ihr Pseudonym ersetzen. Das Ergebnis geht nicht hinaus. |
| `tool_result_too_large` | `warn` | keine | Das Ergebnis eines Tools war grösser als 64 KiB, so wie der Client es erhielte. Ecclium kürzt nie, der Aufruf endet mit einem Fehler. |

### Lesender Zugriff über den Kern

| Ereignis | Stufe | Felder | Bedeutung |
| --- | --- | --- | --- |
| `read_names_refused` | `warn` | `code` | Ein Tool, das Namen anderer Personen nicht meldet, wollte Einteilungen in Dienste lesen. Ecclium weist das ab. |
| `read_operation_collision` | `warn` | `code` | Die Antwort einer Operation liess sich nicht eindeutig maskiert schreiben. Sie geht nicht hinaus. |
| `read_operation_refused` | `warn` | `code` | Ein anderes Tool als `ct_api_execute_read` wollte den lesenden Zugriff auf die API nutzen. Ecclium weist das ab. |
| `read_operation_too_large` | `warn` | `code` | Die Antwort einer Operation war maskiert zu gross für ein Ergebnis. Sie geht nicht hinaus. |
| `read_search_refused` | `warn` | `code` | Ein Tool, das nicht als besonders schützenswert eingestuft ist, wollte Personen oder Gruppen lesen. Ecclium weist das ab. |

### Mount und Prompts

| Ereignis | Stufe | Felder | Bedeutung |
| --- | --- | --- | --- |
| `mcp_call_failed` | `error` | keine | Ein Aufruf eines Tools scheiterte im Mount, etwa an einem Ergebnis ohne die Marke der Maskierung. Der Client erhält `internal`. |
| `mcp_server_error` | `error` | keine | Das MCP-SDK meldete einen Fehler des Servers. Die Meldung des SDK steht nicht in der Zeile, weil sie Text des Clients enthalten kann. |
| `mcp_stdio_error` | `error` | keine | Die Verbindung über stdio meldete einen Fehler. |
| `mcp_validator_refused` | `error` | keine | Code wollte ein JSON Schema mit dem Prüfer des MCP-SDK übersetzen, was der Mount nie tut. Der Prüfer hat abgelehnt. |
| `prompt_refused` | `warn` | `prompt`, `code` | Ein Prompt wurde mit Argumenten abgerufen, die er nicht annimmt. `prompt` nennt ihn, nie den Wert eines Arguments. |
| `prompt_served` | `info` | `prompt` | Ein Prompt wurde abgerufen. `prompt` nennt ihn. |
| `prompt_unknown` | `warn` | keine | Ein Prompt, den es nicht gibt, wurde abgerufen. |

### Client für ChurchTools

| Ereignis | Stufe | Felder | Bedeutung |
| --- | --- | --- | --- |
| `churchtools_agenda_missing` | `warn` | `code`, `status` | ChurchTools kennt beim Lesen über den Ablauf eines Events die Kennung nicht (404). Der Aufruf endet mit `not_found`. |
| `churchtools_agenda_refused` | `warn` | `code` | Ecclium hat die Antwort von ChurchTools auf den Ablauf eines Events nicht angenommen, etwa weil sie nicht zum Schema passte. |
| `churchtools_agenda_status` | `warn` | `code`, `status` | ChurchTools hat auf das Lesen über den Ablauf eines Events nicht mit 200 geantwortet. `status` nennt den Status, `code` den Fehler des Aufrufs. |
| `churchtools_appointment_foreign` | `warn` | `code` | Die Antwort auf einen Termin nannte Einträge, nach denen nicht gefragt war. Ecclium hat sie abgewiesen. |
| `churchtools_appointment_missing` | `warn` | `code`, `status` | ChurchTools kennt beim Lesen über einen Termin die Kennung nicht (404). Der Aufruf endet mit `not_found`. |
| `churchtools_appointment_refused` | `warn` | `code` | Ecclium hat die Antwort von ChurchTools auf einen Termin nicht angenommen, etwa weil sie nicht zum Schema passte. |
| `churchtools_appointment_status` | `warn` | `code`, `status` | ChurchTools hat auf das Lesen über einen Termin nicht mit 200 geantwortet. `status` nennt den Status, `code` den Fehler des Aufrufs. |
| `churchtools_appointments_foreign` | `warn` | `code` | Die Antwort auf die Termine von Kalendern nannte Einträge, nach denen nicht gefragt war. Ecclium hat sie abgewiesen. |
| `churchtools_appointments_refused` | `warn` | `code` | Ecclium hat die Antwort von ChurchTools auf die Termine von Kalendern nicht angenommen, etwa weil sie nicht zum Schema passte. |
| `churchtools_appointments_status` | `warn` | `code`, `status` | ChurchTools hat auf das Lesen über die Termine von Kalendern nicht mit 200 geantwortet. `status` nennt den Status, `code` den Fehler des Aufrufs. |
| `churchtools_bookings_foreign` | `warn` | `code` | Die Antwort auf die Buchungen einer Ressource nannte Einträge, nach denen nicht gefragt war. Ecclium hat sie abgewiesen. |
| `churchtools_bookings_refused` | `warn` | `code` | Ecclium hat die Antwort von ChurchTools auf die Buchungen einer Ressource nicht angenommen, etwa weil sie nicht zum Schema passte. |
| `churchtools_bookings_status` | `warn` | `code`, `status` | ChurchTools hat auf das Lesen über die Buchungen einer Ressource nicht mit 200 geantwortet. `status` nennt den Status, `code` den Fehler des Aufrufs. |
| `churchtools_calendar_input_refused` | `warn` | `code` | Ecclium hat eine Eingabe für Kalender, Termine oder Ressourcen abgewiesen, bevor es ChurchTools fragte. |
| `churchtools_calendars_refused` | `warn` | `code` | Ecclium hat die Antwort von ChurchTools auf die Kalender nicht angenommen, etwa weil sie nicht zum Schema passte. |
| `churchtools_calendars_status` | `warn` | `code`, `status` | ChurchTools hat auf das Lesen über die Kalender nicht mit 200 geantwortet. `status` nennt den Status, `code` den Fehler des Aufrufs. |
| `churchtools_context_mismatch` | `error` | `code` | Ein Aufruf hatte einen anderen Mandanten als der Client. Das ist ein Fehler im Code, Ecclium fragt ChurchTools nicht. |
| `churchtools_event_assignments_missing` | `warn` | `code`, `status` | ChurchTools kennt beim Lesen über die Einteilungen eines Events die Kennung nicht (404). Der Aufruf endet mit `not_found`. |
| `churchtools_event_assignments_refused` | `warn` | `code` | Ecclium hat die Antwort von ChurchTools auf die Einteilungen eines Events nicht angenommen, etwa weil sie nicht zum Schema passte. |
| `churchtools_event_assignments_status` | `warn` | `code`, `status` | ChurchTools hat auf das Lesen über die Einteilungen eines Events nicht mit 200 geantwortet. `status` nennt den Status, `code` den Fehler des Aufrufs. |
| `churchtools_event_input_refused` | `warn` | `code` | Ecclium hat eine Eingabe für Events oder Dienste abgewiesen, bevor es ChurchTools fragte. |
| `churchtools_event_missing` | `warn` | `code`, `status` | ChurchTools kennt beim Lesen über ein Event die Kennung nicht (404). Der Aufruf endet mit `not_found`. |
| `churchtools_event_refused` | `warn` | `code` | Ecclium hat die Antwort von ChurchTools auf ein Event nicht angenommen, etwa weil sie nicht zum Schema passte. |
| `churchtools_event_status` | `warn` | `code`, `status` | ChurchTools hat auf das Lesen über ein Event nicht mit 200 geantwortet. `status` nennt den Status, `code` den Fehler des Aufrufs. |
| `churchtools_events_refused` | `warn` | `code` | Ecclium hat die Antwort von ChurchTools auf die Events eines Zeitraums nicht angenommen, etwa weil sie nicht zum Schema passte. |
| `churchtools_events_status` | `warn` | `code`, `status` | ChurchTools hat auf das Lesen über die Events eines Zeitraums nicht mit 200 geantwortet. `status` nennt den Status, `code` den Fehler des Aufrufs. |
| `churchtools_group_members_missing` | `warn` | `code`, `status` | ChurchTools kennt beim Lesen über die Mitglieder einer Gruppe die Kennung nicht (404). Der Aufruf endet mit `not_found`. |
| `churchtools_group_members_refused` | `warn` | `code` | Ecclium hat die Antwort von ChurchTools auf die Mitglieder einer Gruppe nicht angenommen, etwa weil sie nicht zum Schema passte. |
| `churchtools_group_members_status` | `warn` | `code`, `status` | ChurchTools hat auf das Lesen über die Mitglieder einer Gruppe nicht mit 200 geantwortet. `status` nennt den Status, `code` den Fehler des Aufrufs. |
| `churchtools_group_missing` | `warn` | `code`, `status` | ChurchTools kennt beim Lesen über eine Gruppe die Kennung nicht (404). Der Aufruf endet mit `not_found`. |
| `churchtools_group_refused` | `warn` | `code` | Ecclium hat die Antwort von ChurchTools auf eine Gruppe nicht angenommen, etwa weil sie nicht zum Schema passte. |
| `churchtools_group_status` | `warn` | `code`, `status` | ChurchTools hat auf das Lesen über eine Gruppe nicht mit 200 geantwortet. `status` nennt den Status, `code` den Fehler des Aufrufs. |
| `churchtools_groups_refused` | `warn` | `code` | Ecclium hat die Antwort von ChurchTools auf die Suche nach Gruppen nicht angenommen, etwa weil sie nicht zum Schema passte. |
| `churchtools_groups_status` | `warn` | `code`, `status` | ChurchTools hat auf das Lesen über die Suche nach Gruppen nicht mit 200 geantwortet. `status` nennt den Status, `code` den Fehler des Aufrufs. |
| `churchtools_groups_term_refused` | `warn` | `code` | Ecclium hat einen Suchbegriff für die Suche nach Gruppen abgewiesen, bevor es ChurchTools fragte. |
| `churchtools_operation_answer_refused` | `warn` | `code` | Ecclium hat die Antwort von ChurchTools auf eine Operation über `ct_api_execute_read` nicht angenommen, etwa weil sie kein Objekt war oder zu viele Elemente hatte. |
| `churchtools_operation_input_refused` | `warn` | `code` | Ecclium hat einen Wert in Pfad oder Query einer Operation abgewiesen, bevor es ChurchTools fragte. |
| `churchtools_operation_missing` | `warn` | `code`, `status` | ChurchTools kennt beim Lesen über eine Operation über `ct_api_execute_read` die Kennung nicht (404). Der Aufruf endet mit `not_found`. |
| `churchtools_operation_refused` | `warn` | `code` | Eine Operation, die der Katalog der Escape Hatch nicht freigibt, wurde verlangt. Ecclium fragt ChurchTools nicht. |
| `churchtools_operation_status` | `warn` | `code`, `status` | ChurchTools hat auf das Lesen über eine Operation über `ct_api_execute_read` nicht mit 200 geantwortet. `status` nennt den Status, `code` den Fehler des Aufrufs. |
| `churchtools_operation_too_large` | `warn` | `code` | Die Antwort auf eine Operation war grösser als ihre Grenze. |
| `churchtools_operation_unknown` | `warn` | `code` | Eine Operation, die der Katalog der Escape Hatch nicht kennt, wurde verlangt. Ecclium fragt ChurchTools nicht. |
| `churchtools_permissions_refused` | `warn` | `code` | Ecclium hat die Antwort von ChurchTools auf die Rechte des Dienstkontos nicht angenommen, etwa weil sie nicht zum Schema passte. |
| `churchtools_permissions_status` | `warn` | `code`, `status` | ChurchTools hat auf das Lesen über die Rechte des Dienstkontos nicht mit 200 geantwortet. `status` nennt den Status, `code` den Fehler des Aufrufs. |
| `churchtools_permissions_unknown` | `warn` | keine | Die Rechte des Dienstkontos hatten eine Form, die Ecclium nicht kennt. `ct_whoami` nennt sie dann nicht. |
| `churchtools_person_groups_missing` | `warn` | `code`, `status` | ChurchTools kennt beim Lesen über die Gruppen einer Person die Kennung nicht (404). Der Aufruf endet mit `not_found`. |
| `churchtools_person_groups_refused` | `warn` | `code` | Ecclium hat die Antwort von ChurchTools auf die Gruppen einer Person nicht angenommen, etwa weil sie nicht zum Schema passte. |
| `churchtools_person_groups_status` | `warn` | `code`, `status` | ChurchTools hat auf das Lesen über die Gruppen einer Person nicht mit 200 geantwortet. `status` nennt den Status, `code` den Fehler des Aufrufs. |
| `churchtools_person_missing` | `warn` | `code`, `status` | ChurchTools kennt beim Lesen über eine Person die Kennung nicht (404). Der Aufruf endet mit `not_found`. |
| `churchtools_person_refused` | `warn` | `code` | Ecclium hat die Antwort von ChurchTools auf eine Person nicht angenommen, etwa weil sie nicht zum Schema passte. |
| `churchtools_person_status` | `warn` | `code`, `status` | ChurchTools hat auf das Lesen über eine Person nicht mit 200 geantwortet. `status` nennt den Status, `code` den Fehler des Aufrufs. |
| `churchtools_persons_refused` | `warn` | `code` | Ecclium hat die Antwort von ChurchTools auf die Suche nach Personen nicht angenommen, etwa weil sie nicht zum Schema passte. |
| `churchtools_persons_status` | `warn` | `code`, `status` | ChurchTools hat auf das Lesen über die Suche nach Personen nicht mit 200 geantwortet. `status` nennt den Status, `code` den Fehler des Aufrufs. |
| `churchtools_persons_term_refused` | `warn` | `code` | Ecclium hat einen Suchbegriff für die Suche nach Personen abgewiesen, bevor es ChurchTools fragte. |
| `churchtools_read_input_refused` | `warn` | `code` | Ecclium hat eine Kennung zum Lesen einer Person oder Gruppe abgewiesen, bevor es ChurchTools fragte. |
| `churchtools_resource_types_refused` | `warn` | `code` | Ecclium hat die Antwort von ChurchTools auf die Arten von Ressourcen nicht angenommen, etwa weil sie nicht zum Schema passte. |
| `churchtools_resource_types_status` | `warn` | `code`, `status` | ChurchTools hat auf das Lesen über die Arten von Ressourcen nicht mit 200 geantwortet. `status` nennt den Status, `code` den Fehler des Aufrufs. |
| `churchtools_resources_refused` | `warn` | `code` | Ecclium hat die Antwort von ChurchTools auf die Ressourcen nicht angenommen, etwa weil sie nicht zum Schema passte. |
| `churchtools_resources_status` | `warn` | `code`, `status` | ChurchTools hat auf das Lesen über die Ressourcen nicht mit 200 geantwortet. `status` nennt den Status, `code` den Fehler des Aufrufs. |
| `churchtools_search_foreign` | `warn` | `code` | Die Antwort auf die globale Suche nannte Einträge, nach denen nicht gefragt war. Ecclium hat sie abgewiesen. |
| `churchtools_search_input_refused` | `warn` | `code` | Ecclium hat eine Eingabe für die globale Suche abgewiesen, bevor es ChurchTools fragte. |
| `churchtools_search_refused` | `warn` | `code` | Ecclium hat die Antwort von ChurchTools auf die globale Suche nicht angenommen, etwa weil sie nicht zum Schema passte. |
| `churchtools_search_status` | `warn` | `code`, `status` | ChurchTools hat auf das Lesen über die globale Suche nicht mit 200 geantwortet. `status` nennt den Status, `code` den Fehler des Aufrufs. |
| `churchtools_search_term_refused` | `warn` | `code` | Ecclium hat einen Suchbegriff abgewiesen, bevor es ChurchTools fragte. |
| `churchtools_service_groups_refused` | `warn` | `code` | Ecclium hat die Antwort von ChurchTools auf die Dienstgruppen nicht angenommen, etwa weil sie nicht zum Schema passte. |
| `churchtools_service_groups_status` | `warn` | `code`, `status` | ChurchTools hat auf das Lesen über die Dienstgruppen nicht mit 200 geantwortet. `status` nennt den Status, `code` den Fehler des Aufrufs. |
| `churchtools_services_refused` | `warn` | `code` | Ecclium hat die Antwort von ChurchTools auf die Dienste nicht angenommen, etwa weil sie nicht zum Schema passte. |
| `churchtools_services_status` | `warn` | `code`, `status` | ChurchTools hat auf das Lesen über die Dienste nicht mit 200 geantwortet. `status` nennt den Status, `code` den Fehler des Aufrufs. |
| `churchtools_song_input_refused` | `warn` | `code` | Ecclium hat eine Eingabe für Songs abgewiesen, bevor es ChurchTools fragte. |
| `churchtools_song_missing` | `warn` | `code`, `status` | ChurchTools kennt beim Lesen über einen Song die Kennung nicht (404). Der Aufruf endet mit `not_found`. |
| `churchtools_song_refused` | `warn` | `code` | Ecclium hat die Antwort von ChurchTools auf einen Song nicht angenommen, etwa weil sie nicht zum Schema passte. |
| `churchtools_song_status` | `warn` | `code`, `status` | ChurchTools hat auf das Lesen über einen Song nicht mit 200 geantwortet. `status` nennt den Status, `code` den Fehler des Aufrufs. |
| `churchtools_songs_refused` | `warn` | `code` | Ecclium hat die Antwort von ChurchTools auf die Suche nach Songs nicht angenommen, etwa weil sie nicht zum Schema passte. |
| `churchtools_songs_status` | `warn` | `code`, `status` | ChurchTools hat auf das Lesen über die Suche nach Songs nicht mit 200 geantwortet. `status` nennt den Status, `code` den Fehler des Aufrufs. |
| `churchtools_throttled` | `warn` | `code` | Die eigene Drosselung von Ecclium hat eine Anfrage an ChurchTools zurückgehalten. Der Aufruf endet mit `rate_limited`. |
| `churchtools_whoami_anonymous` | `warn` | `code` | ChurchTools hat das Token keinem Konto zugeordnet oder simuliert ein anderes Konto. Der Aufruf endet mit `auth`. |
| `churchtools_whoami_refused` | `warn` | `code` | Ecclium hat die Antwort von ChurchTools auf das Dienstkonto selbst (`whoami`) nicht angenommen, etwa weil sie nicht zum Schema passte. |
| `churchtools_whoami_status` | `warn` | `code`, `status` | ChurchTools hat auf das Lesen über das Dienstkonto selbst (`whoami`) nicht mit 200 geantwortet. `status` nennt den Status, `code` den Fehler des Aufrufs. |
| `churchtools_wiki_categories_refused` | `warn` | `code` | Ecclium hat die Antwort von ChurchTools auf die Kategorien des Wikis nicht angenommen, etwa weil sie nicht zum Schema passte. |
| `churchtools_wiki_categories_status` | `warn` | `code`, `status` | ChurchTools hat auf das Lesen über die Kategorien des Wikis nicht mit 200 geantwortet. `status` nennt den Status, `code` den Fehler des Aufrufs. |
| `churchtools_wiki_input_refused` | `warn` | `code` | Ecclium hat eine Eingabe für das Wiki abgewiesen, bevor es ChurchTools fragte. |
| `churchtools_wiki_page_create_missing` | `warn` | `code`, `status` | ChurchTools kennt die Kategorie nicht, in der Ecclium eine Seite anlegen wollte (404). Der Aufruf endet mit `not_found`. |
| `churchtools_wiki_page_create_refused` | `warn` | `code` | Ecclium hat die Antwort von ChurchTools auf das Anlegen einer Seite im Wiki nicht angenommen, etwa weil sie keine Kennung der Seite nannte. Die Seite kann trotzdem entstanden sein. |
| `churchtools_wiki_page_create_status` | `warn` | `code`, `status` | ChurchTools hat auf das Anlegen einer Seite im Wiki nicht mit 201 geantwortet. `status` nennt den Status, `code` den Fehler. Bei 400 steht in der Kategorie womöglich schon eine Seite mit diesem Titel. Ob ChurchTools trotzdem geschrieben hat, zeigt erst das Lesen danach. |
| `churchtools_wiki_page_missing` | `warn` | `code`, `status` | ChurchTools kennt beim Lesen über eine Seite des Wikis die Kennung nicht (404). Der Aufruf endet mit `not_found`. |
| `churchtools_wiki_page_refused` | `warn` | `code` | Ecclium hat die Antwort von ChurchTools auf eine Seite des Wikis nicht angenommen, etwa weil sie nicht zum Schema passte. |
| `churchtools_wiki_page_status` | `warn` | `code`, `status` | ChurchTools hat auf das Lesen über eine Seite des Wikis nicht mit 200 geantwortet. `status` nennt den Status, `code` den Fehler des Aufrufs. |
| `churchtools_wiki_page_update_missing` | `warn` | `code`, `status` | ChurchTools kennt die Seite oder ihre Kategorie nicht, die Ecclium ändern wollte (404). Der Aufruf endet mit `not_found`. |
| `churchtools_wiki_page_update_status` | `warn` | `code`, `status` | ChurchTools hat auf das Ändern einer Seite im Wiki nicht mit 200 geantwortet. `status` nennt den Status, `code` den Fehler. Ob ChurchTools trotzdem geschrieben hat, zeigt erst das Lesen danach. |
| `churchtools_wiki_pages_refused` | `warn` | `code` | Ecclium hat die Antwort von ChurchTools auf die Seiten einer Kategorie des Wikis nicht angenommen, etwa weil sie nicht zum Schema passte. |
| `churchtools_wiki_pages_status` | `warn` | `code`, `status` | ChurchTools hat auf das Lesen über die Seiten einer Kategorie des Wikis nicht mit 200 geantwortet. `status` nennt den Status, `code` den Fehler des Aufrufs. |
| `churchtools_wiki_search_foreign` | `warn` | `code` | Die Antwort auf die Suche im Wiki nannte Einträge, nach denen nicht gefragt war. Ecclium hat sie abgewiesen. |
| `churchtools_wiki_search_refused` | `warn` | `code` | Ecclium hat die Antwort von ChurchTools auf die Suche im Wiki nicht angenommen, etwa weil sie nicht zum Schema passte. |
| `churchtools_wiki_search_status` | `warn` | `code`, `status` | ChurchTools hat auf das Lesen über die Suche im Wiki nicht mit 200 geantwortet. `status` nennt den Status, `code` den Fehler des Aufrufs. |
| `churchtools_wiki_write_input_refused` | `warn` | `code` | Ecclium hat einen Titel, einen Text oder eine Kennung zum Schreiben im Wiki abgewiesen, bevor es ChurchTools fragte. |

### Ausgehender Weg

| Ereignis | Stufe | Felder | Bedeutung |
| --- | --- | --- | --- |
| `http_aborted` | `warn` | `code`, `durationMs`, `method` | Die Anfrage wurde abgebrochen, etwa weil der Client den Aufruf beendet hat. `code` nennt den Fehler, `durationMs` die Dauer bis dahin, `method` die Methode der Anfrage. |
| `http_connect` | `warn` | `code`, `durationMs`, `method` | Es kam keine Verbindung zu ChurchTools zustande. `code` nennt den Fehler, `durationMs` die Dauer bis dahin, `method` die Methode der Anfrage. |
| `http_encoding` | `warn` | `code`, `durationMs`, `method` | Die Antwort hatte eine Kodierung, die der ausgehende Weg nicht annimmt. `code` nennt den Fehler, `durationMs` die Dauer bis dahin, `method` die Methode der Anfrage. |
| `http_failed` | `warn` | `code`, `durationMs`, `method` | Die Anfrage scheiterte aus einem anderen Grund im Netz. `code` nennt den Fehler, `durationMs` die Dauer bis dahin, `method` die Methode der Anfrage. |
| `http_interrupted` | `warn` | `code`, `durationMs`, `method` | Die Verbindung brach ab, bevor die Antwort ganz da war. `code` nennt den Fehler, `durationMs` die Dauer bis dahin, `method` die Methode der Anfrage. |
| `http_redirect` | `warn` | `code`, `durationMs`, `method` | ChurchTools hat auf eine andere Adresse verwiesen. Der ausgehende Weg folgt keinem Verweis. `code` nennt den Fehler, `durationMs` die Dauer bis dahin, `method` die Methode der Anfrage. |
| `http_refused` | `warn` | `code`, `durationMs`, `method` | Der ausgehende Weg hat das Ziel einer Anfrage abgewiesen, bevor er etwas sendete. Das ist ein Fehler im Code, nie im Netz. `code` nennt den Fehler, `durationMs` die Dauer bis dahin, `method` die Methode der Anfrage. |
| `http_response` | `info` | `durationMs`, `method`, `status` | ChurchTools hat geantwortet. `method` nennt die Methode der Anfrage, `status` den Status, `durationMs` die Dauer. |
| `http_status` | `warn` | `code`, `durationMs`, `method` | Die Antwort hatte einen Status, den der ausgehende Weg nicht annimmt. `code` nennt den Fehler, `durationMs` die Dauer bis dahin, `method` die Methode der Anfrage. |
| `http_timeout` | `warn` | `code`, `durationMs`, `method` | Die Anfrage dauerte länger als ihre Grenze. `code` nennt den Fehler, `durationMs` die Dauer bis dahin, `method` die Methode der Anfrage. |
| `http_tls` | `warn` | `code`, `durationMs`, `method` | Die gesicherte Verbindung kam nicht zustande, etwa wegen des Zertifikats. `code` nennt den Fehler, `durationMs` die Dauer bis dahin, `method` die Methode der Anfrage. |
| `http_too_large` | `warn` | `code`, `durationMs`, `method` | Die Antwort war grösser als die Grenze ihrer Operation. `code` nennt den Fehler, `durationMs` die Dauer bis dahin, `method` die Methode der Anfrage. |

### Audit

| Ereignis | Stufe | Felder | Bedeutung |
| --- | --- | --- | --- |
| `audit_chain_anchor` | `info` | `file`, `seq`, `hash` | Der Anker einer Audit-Datei: `file` nennt die Datei, `seq` und `hash` den Kopf ihrer Kette, beim Schliessen, beim Wechsel des Tages und beim Neuöffnen. `ecclium audit verify` prüft eine Datei gegen ihn. |
| `audit_file_closed` | `info` | `count` | Die Audit-Datei ist geschlossen. `count` nennt die Zeilen, die nicht ganz in die Datei kamen. |
| `audit_files_deleted` | `info` | `count` | Ecclium hat Audit-Dateien nach ihrer Frist oder leere Dateien gelöscht. `count` nennt ihre Zahl. |
| `audit_files_not_deleted` | `warn` | `count` | Ecclium konnte Audit-Dateien nach ihrer Frist nicht löschen oder den Ordner nicht ganz lesen. `count` nennt die Zahl der Dateien, die liegen blieben. |
| `audit_invalid_actor` | `error` | `code`, `count` | Ein Erzeuger gab für das Feld `actor` einer Zeile des Audits einen Wert, den die Senke nicht annimmt. Die Zeile trägt einen Platzhalter oder lässt das Feld weg, bei einer Liste nennt `count` ihre Länge. |
| `audit_invalid_actor_id` | `error` | `code`, `count` | Ein Erzeuger gab für das Feld `actor_id` einer Zeile des Audits einen Wert, den die Senke nicht annimmt. Die Zeile trägt einen Platzhalter oder lässt das Feld weg, bei einer Liste nennt `count` ihre Länge. |
| `audit_invalid_actor_kind` | `error` | `code`, `count` | Ein Erzeuger gab für das Feld `actor_kind` einer Zeile des Audits einen Wert, den die Senke nicht annimmt. Die Zeile trägt einen Platzhalter oder lässt das Feld weg, bei einer Liste nennt `count` ihre Länge. |
| `audit_invalid_confirmation` | `error` | `code`, `count` | Ein Erzeuger gab für das Feld `confirmation` einer Zeile des Audits einen Wert, den die Senke nicht annimmt. Die Zeile trägt einen Platzhalter oder lässt das Feld weg, bei einer Liste nennt `count` ihre Länge. |
| `audit_invalid_data_protection_regime` | `error` | `code`, `count` | Ein Erzeuger gab für das Feld `data_protection_regime` einer Zeile des Audits einen Wert, den die Senke nicht annimmt. Die Zeile trägt einen Platzhalter oder lässt das Feld weg, bei einer Liste nennt `count` ihre Länge. |
| `audit_invalid_duration_ms` | `error` | `code`, `count` | Ein Erzeuger gab für das Feld `duration_ms` einer Zeile des Audits einen Wert, den die Senke nicht annimmt. Die Zeile trägt einen Platzhalter oder lässt das Feld weg, bei einer Liste nennt `count` ihre Länge. |
| `audit_invalid_error_code` | `error` | `code`, `count` | Ein Erzeuger gab für das Feld `error_code` einer Zeile des Audits einen Wert, den die Senke nicht annimmt. Die Zeile trägt einen Platzhalter oder lässt das Feld weg, bei einer Liste nennt `count` ihre Länge. |
| `audit_invalid_event_id` | `error` | `code`, `count` | Ein Erzeuger gab für das Feld `event_id` einer Zeile des Audits einen Wert, den die Senke nicht annimmt. Die Zeile trägt einen Platzhalter oder lässt das Feld weg, bei einer Liste nennt `count` ihre Länge. |
| `audit_invalid_mode` | `error` | `code`, `count` | Ein Erzeuger gab für das Feld `mode` einer Zeile des Audits einen Wert, den die Senke nicht annimmt. Die Zeile trägt einen Platzhalter oder lässt das Feld weg, bei einer Liste nennt `count` ihre Länge. |
| `audit_invalid_object_refs` | `error` | `code`, `count` | Ein Erzeuger gab für das Feld `object_refs` einer Zeile des Audits einen Wert, den die Senke nicht annimmt. Die Zeile trägt einen Platzhalter oder lässt das Feld weg, bei einer Liste nennt `count` ihre Länge. |
| `audit_invalid_object_refs_omitted` | `error` | `code`, `count` | Ein Erzeuger gab für das Feld `object_refs_omitted` einer Zeile des Audits einen Wert, den die Senke nicht annimmt. Die Zeile trägt einen Platzhalter oder lässt das Feld weg, bei einer Liste nennt `count` ihre Länge. |
| `audit_invalid_outcome` | `error` | `code`, `count` | Ein Erzeuger gab für das Feld `outcome` einer Zeile des Audits einen Wert, den die Senke nicht annimmt. Die Zeile trägt einen Platzhalter oder lässt das Feld weg, bei einer Liste nennt `count` ihre Länge. |
| `audit_invalid_plugin_hashes` | `error` | `code`, `count` | Ein Erzeuger gab für das Feld `plugin_hashes` einer Zeile des Audits einen Wert, den die Senke nicht annimmt. Die Zeile trägt einen Platzhalter oder lässt das Feld weg, bei einer Liste nennt `count` ihre Länge. |
| `audit_invalid_policy_hash` | `error` | `code`, `count` | Ein Erzeuger gab für das Feld `policy_hash` einer Zeile des Audits einen Wert, den die Senke nicht annimmt. Die Zeile trägt einen Platzhalter oder lässt das Feld weg, bei einer Liste nennt `count` ihre Länge. |
| `audit_invalid_provider` | `error` | `code`, `count` | Ein Erzeuger gab für das Feld `provider` einer Zeile des Audits einen Wert, den die Senke nicht annimmt. Die Zeile trägt einen Platzhalter oder lässt das Feld weg, bei einer Liste nennt `count` ihre Länge. |
| `audit_invalid_provider_endpoint_host` | `error` | `code`, `count` | Ein Erzeuger gab für das Feld `provider_endpoint_host` einer Zeile des Audits einen Wert, den die Senke nicht annimmt. Die Zeile trägt einen Platzhalter oder lässt das Feld weg, bei einer Liste nennt `count` ihre Länge. |
| `audit_invalid_provider_hosting_country` | `error` | `code`, `count` | Ein Erzeuger gab für das Feld `provider_hosting_country` einer Zeile des Audits einen Wert, den die Senke nicht annimmt. Die Zeile trägt einen Platzhalter oder lässt das Feld weg, bei einer Liste nennt `count` ihre Länge. |
| `audit_invalid_provider_model` | `error` | `code`, `count` | Ein Erzeuger gab für das Feld `provider_model` einer Zeile des Audits einen Wert, den die Senke nicht annimmt. Die Zeile trägt einen Platzhalter oder lässt das Feld weg, bei einer Liste nennt `count` ihre Länge. |
| `audit_invalid_provider_transfer_basis` | `error` | `code`, `count` | Ein Erzeuger gab für das Feld `provider_transfer_basis` einer Zeile des Audits einen Wert, den die Senke nicht annimmt. Die Zeile trägt einen Platzhalter oder lässt das Feld weg, bei einer Liste nennt `count` ihre Länge. |
| `audit_invalid_provider_vendor` | `error` | `code`, `count` | Ein Erzeuger gab für das Feld `provider_vendor` einer Zeile des Audits einen Wert, den die Senke nicht annimmt. Die Zeile trägt einen Platzhalter oder lässt das Feld weg, bei einer Liste nennt `count` ihre Länge. |
| `audit_invalid_routine_id` | `error` | `code`, `count` | Ein Erzeuger gab für das Feld `routine_id` einer Zeile des Audits einen Wert, den die Senke nicht annimmt. Die Zeile trägt einen Platzhalter oder lässt das Feld weg, bei einer Liste nennt `count` ihre Länge. |
| `audit_invalid_run_id` | `error` | `code`, `count` | Ein Erzeuger gab für das Feld `run_id` einer Zeile des Audits einen Wert, den die Senke nicht annimmt. Die Zeile trägt einen Platzhalter oder lässt das Feld weg, bei einer Liste nennt `count` ihre Länge. |
| `audit_invalid_tenant_id` | `error` | `code`, `count` | Ein Erzeuger gab für das Feld `tenant_id` einer Zeile des Audits einen Wert, den die Senke nicht annimmt. Die Zeile trägt einen Platzhalter oder lässt das Feld weg, bei einer Liste nennt `count` ihre Länge. |
| `audit_invalid_tool` | `error` | `code`, `count` | Ein Erzeuger gab für das Feld `tool` einer Zeile des Audits einen Wert, den die Senke nicht annimmt. Die Zeile trägt einen Platzhalter oder lässt das Feld weg, bei einer Liste nennt `count` ihre Länge. |
| `audit_invalid_ts` | `error` | `code`, `count` | Ein Erzeuger gab für das Feld `ts` einer Zeile des Audits einen Wert, den die Senke nicht annimmt. Die Zeile trägt einen Platzhalter oder lässt das Feld weg, bei einer Liste nennt `count` ihre Länge. |
| `audit_invalid_type` | `error` | `code`, `count` | Ein Erzeuger gab für das Feld `type` einer Zeile des Audits einen Wert, den die Senke nicht annimmt. Die Zeile trägt einen Platzhalter oder lässt das Feld weg, bei einer Liste nennt `count` ihre Länge. |
| `audit_missing_error_code` | `error` | `code`, `count` | Eine Zeile mit `error` oder `denied` kam ohne Fehlercode. Die Zeile im Audit trägt einen Platzhalter. |
| `audit_reserved_event_id` | `error` | `code`, `count` | Ein Erzeuger setzte das Feld `event_id` einer Zeile des Audits, das nur die Senke oder der Schreiber der Datei setzt. Es fällt weg. |
| `audit_reserved_prev_hash` | `error` | `code`, `count` | Ein Erzeuger setzte das Feld `prev_hash` einer Zeile des Audits, das nur die Senke oder der Schreiber der Datei setzt. Es fällt weg. |
| `audit_reserved_seq` | `error` | `code`, `count` | Ein Erzeuger setzte das Feld `seq` einer Zeile des Audits, das nur die Senke oder der Schreiber der Datei setzt. Es fällt weg. |
| `audit_reserved_ts` | `error` | `code`, `count` | Ein Erzeuger setzte das Feld `ts` einer Zeile des Audits, das nur die Senke oder der Schreiber der Datei setzt. Es fällt weg. |
| `audit_reserved_v` | `error` | `code`, `count` | Ein Erzeuger setzte das Feld `v` einer Zeile des Audits, das nur die Senke oder der Schreiber der Datei setzt. Es fällt weg. |
| `audit_reserved_withheld_after_read` | `error` | `code`, `count` | Ein Erzeuger setzte das Feld `withheld_after_read` einer Zeile des Audits, das nur die Senke oder der Schreiber der Datei setzt. Es fällt weg. |
| `audit_schema_mismatch` | `error` | `code`, `count` | Die gebaute Zeile passte nicht zum Schema des Audits, ein Fehler im Code. Die Zeile trägt nur Platzhalter. |
| `audit_unknown_fields` | `error` | `code`, `count` | Eine Zeile kam mit Feldern, die das Schema nicht kennt. `count` nennt ihre Zahl, die Felder fallen weg. |
| `audit_unreadable` | `error` | `code`, `count` | Ecclium konnte die Angaben einer Zeile nicht lesen. Die Zeile trägt nur Platzhalter. |

### Prozess über stdio

| Ereignis | Stufe | Felder | Bedeutung |
| --- | --- | --- | --- |
| `process_sigint` | `info` | keine | Der Prozess erhielt `SIGINT` und endet. |
| `process_sigterm` | `info` | keine | Der Prozess erhielt `SIGTERM` und endet. |
| `process_uncaught_exception` | `error` | `code` | Ein Fehler wurde nirgends abgefangen. Der Prozess endet mit 70. |
| `process_unhandled_rejection` | `error` | `code` | Eine Promise wurde abgelehnt, ohne dass jemand darauf wartete. Der Prozess endet mit 70. |
| `stdio_closed` | `info` | `count` | Der Server über stdio ist beendet. `count` nennt die Zeilen, die nicht auf stderr kamen. Es ist die letzte Zeile. |
| `stdio_start_failed` | `error` | `code` | Der Start über stdio ist gescheitert. `code` nennt den Grund, die Meldung für Betreiber steht davor. |
