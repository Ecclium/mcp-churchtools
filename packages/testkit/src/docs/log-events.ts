/**
 * Renders `docs/log-events.md`, the page of every log line, from the
 * catalog in the core (ADR 0054). The page is German for operators and
 * takes the meaning of each event from the tables below: families of
 * events, such as the answers of ChurchTools per operation, share one
 * sentence with the name of their object. A test compares the page with
 * its file and fails for an event without a meaning, so a new line without
 * a new page turns CI red.
 *
 * @packageDocumentation
 */
import {
  type LogEventName,
  logEvents,
  logFieldNames,
  logLevels,
} from '@ecclium/mcp-churchtools-core';

/**
 * Who sets each field of a log line and what it means, for operators. The
 * page lists them in the order of the logger, and a test fails while a
 * field has no entry here, or an entry names no field.
 */
export const logFieldMeanings: Readonly<
  Record<string, { readonly setBy: string; readonly meaning: string }>
> = Object.freeze({
  ts: {
    setBy: 'Logger',
    meaning: 'Zeit der Zeile in UTC, auf die Millisekunde.',
  },
  level: {
    setBy: 'Logger',
    meaning: `Stufe der Zeile: ${logLevels.map((level) => `\`${level}\``).join(', ')}.`,
  },
  event: {
    setBy: 'Logger',
    meaning:
      'Name des Ereignisses, einer der Namen unter «Ereignisse» oder `invalid_event`.',
  },
  tenantId: {
    setBy: 'Kern',
    meaning: 'Kennung des Mandanten, über stdio `default`.',
  },
  runId: { setBy: 'Kern', meaning: 'Kennung des Laufs einer Routine.' },
  eventId: {
    setBy: 'Kern',
    meaning:
      'Kennung des Aufrufs, gleich der `eventId` seiner Zeile im Audit. So finden Sie die Logzeilen zu einer Zeile des Audits.',
  },
  tool: { setBy: 'Kern', meaning: 'Name des Tools des Aufrufs.' },
  prompt: {
    setBy: 'Aufruf',
    meaning:
      'Name eines Prompts aus dem Katalog, nie der Wert eines Arguments.',
  },
  code: {
    setBy: 'Aufruf',
    meaning:
      'Stabiler Fehlercode, etwa `upstream` oder `policy_denied`, nie eine Meldung.',
  },
  mode: {
    setBy: 'Kern',
    meaning:
      'Wie der Aufruf lief: interaktiv, unbeaufsichtigt oder durch den Betreiber.',
  },
  redaction: { setBy: 'Kern', meaning: 'Stufe der Maskierung des Aufrufs.' },
  readOnly: { setBy: 'Kern', meaning: 'Ob der Aufruf nur lesen durfte.' },
  durationMs: {
    setBy: 'Aufruf',
    meaning: 'Dauer in Millisekunden, höchstens ein Tag.',
  },
  count: {
    setBy: 'Aufruf',
    meaning:
      "Eine Zahl, deren Bedeutung das Ereignis nennt, höchstens 1'000'000.",
  },
  method: {
    setBy: 'Aufruf',
    meaning:
      'Methode einer Anfrage an ChurchTools: `GET` liest, `POST`, `PUT`, `PATCH` und `DELETE` schreiben.',
  },
  status: {
    setBy: 'Aufruf',
    meaning: 'Status einer Antwort von ChurchTools, 100 bis 599.',
  },
  attempt: {
    setBy: 'Aufruf',
    meaning:
      'Nummer eines Versuchs, 1 bis 10. Heute setzt ihn keine Zeile, der Runner braucht ihn ab Phase 6.',
  },
  file: {
    setBy: 'Aufruf',
    meaning:
      'Name einer Audit-Datei nach ihrem festen Muster, nie ein Pfad, nur im Anker.',
  },
  seq: {
    setBy: 'Aufruf',
    meaning: 'Stelle des Kopfs der Kette einer Audit-Datei, nur im Anker.',
  },
  hash: {
    setBy: 'Aufruf',
    meaning:
      'SHA-256 des Kopfs der Kette einer Audit-Datei, hexadezimal, nur im Anker.',
  },
  dropped: {
    setBy: 'Logger',
    meaning:
      'Zahl der Felder, die ein Aufruf mitgab und der Logger wegliess, weil Name oder Wert nicht erlaubt war.',
  },
});

// The object each operation of the client reads, for the families of
// events per operation, after the prefix `churchtools_`.
const readObjects: Readonly<Record<string, string>> = Object.freeze({
  agenda: 'den Ablauf eines Events',
  appointment: 'einen Termin',
  appointments: 'die Termine von Kalendern',
  booking: 'eine Buchung',
  bookings: 'die Buchungen einer Ressource',
  calendars: 'die Kalender',
  event_assignments: 'die Einteilungen eines Events',
  event: 'ein Event',
  events: 'die Events eines Zeitraums',
  group_members: 'die Mitglieder einer Gruppe',
  group: 'eine Gruppe',
  groups: 'die Suche nach Gruppen',
  operation: 'eine Operation über `ct_api_execute_read`',
  permissions: 'die Rechte des Dienstkontos',
  person_groups: 'die Gruppen einer Person',
  person: 'eine Person',
  persons: 'die Suche nach Personen',
  resource_types: 'die Arten von Ressourcen',
  resources: 'die Ressourcen',
  search: 'die globale Suche',
  service_groups: 'die Dienstgruppen',
  services: 'die Dienste',
  song: 'einen Song',
  songs: 'die Suche nach Songs',
  whoami: 'das Dienstkonto selbst (`whoami`)',
  wiki_categories: 'die Kategorien des Wikis',
  wiki_page: 'eine Seite des Wikis',
  wiki_pages: 'die Seiten einer Kategorie des Wikis',
  wiki_search: 'die Suche im Wiki',
});

// What each category of a failure on the outbound path means, after the
// prefix `http_`.
const httpFailures: Readonly<Record<string, string>> = Object.freeze({
  refused:
    'Der ausgehende Weg hat das Ziel einer Anfrage abgewiesen, bevor er etwas sendete. Das ist ein Fehler im Code, nie im Netz.',
  connect: 'Es kam keine Verbindung zu ChurchTools zustande.',
  tls: 'Die gesicherte Verbindung kam nicht zustande, etwa wegen des Zertifikats.',
  timeout: 'Die Anfrage dauerte länger als ihre Grenze.',
  aborted:
    'Die Anfrage wurde abgebrochen, etwa weil der Client den Aufruf beendet hat.',
  interrupted: 'Die Verbindung brach ab, bevor die Antwort ganz da war.',
  too_large: 'Die Antwort war grösser als die Grenze ihrer Operation.',
  redirect:
    'ChurchTools hat auf eine andere Adresse verwiesen. Der ausgehende Weg folgt keinem Verweis.',
  encoding:
    'Die Antwort hatte eine Kodierung, die der ausgehende Weg nicht annimmt.',
  status:
    'Die Antwort hatte einen Status, den der ausgehende Weg nicht annimmt.',
  failed: 'Die Anfrage scheiterte aus einem anderen Grund im Netz.',
});

/**
 * The meaning of each event that is not one of a family, for operators. A
 * test fails while an event has neither, or a meaning names no event.
 */
export const logEventMeanings: Readonly<Record<string, string>> = Object.freeze(
  {
    tool_call:
      'Ein Aufruf eines Tools ist zu Ende, mit oder ohne Fehler. `code` nennt den Fehler, `durationMs` die Dauer. Zu jedem Aufruf gehört eine Zeile im Audit.',
    tool_output_invalid:
      'Das Ergebnis eines Tools passte nicht zu seinem Schema, oder das Audit konnte eine Kennung darin nicht nennen. Es geht nicht hinaus.',
    tool_pseudonym_failed:
      'In `strict` liess sich eine Kennung einer Person im Ergebnis nicht durch ihr Pseudonym ersetzen. Das Ergebnis geht nicht hinaus.',
    tool_boundary_failed:
      'Für den Datenumschlag liess sich keine Grenze finden, die im Ergebnis nicht vorkommt. Das Ergebnis geht nicht hinaus.',
    tool_result_too_large:
      'Das Ergebnis eines Tools war grösser als 64 KiB, so wie der Client es erhielte. Ecclium kürzt nie, der Aufruf endet mit einem Fehler.',
    audit_withheld:
      'Die Zeile eines Aufrufs kam nicht ganz in die Audit-Datei. Ecclium hält das Ergebnis zurück, der Aufruf endet mit `policy_denied`.',
    pseudonym_keys_unavailable:
      'In `strict` fehlte der Schlüssel für die Pseudonyme eines Aufrufs. Der Aufruf endet mit einem Fehler.',
    read_budget_exhausted:
      'Das Lesebudget des Akteurs für diesen UTC-Tag ist aufgebraucht. Der Aufruf endet mit `policy_denied`, ohne ChurchTools zu fragen.',
    read_budget_unavailable:
      'Ecclium konnte das Lesebudget nicht zählen. Der Aufruf endet mit `policy_denied`, ohne ChurchTools zu fragen.',
    write_refused:
      'Der Write-Guard plant oder schreibt nicht: Schreiben ist gesperrt oder nicht zu prüfen, die Art des Schreibvorgangs läuft nicht, die Rechte des Kontos sind nicht zu lesen, oder die Uhr weicht mehr als fünf Minuten von ChurchTools ab. `code` nennt den Fehler.',
    write_conflict:
      'Das Ziel eines Schreibvorgangs hat sich seit dem Plan oder seit dem Einreihen in die Freigabe-Warteschlange geändert oder liest sich nach dem Schreiben nicht wie geplant. `code` ist `conflict`.',
    write_outcome_unknown:
      'Nach einem Fehler beim Schreiben ist offen, ob die Änderung ChurchTools erreicht hat, und das Lesen danach konnte es nicht klären. Das Ziel ist von Hand zu prüfen.',
    write_audit_failed:
      'Die Zeile eines Aufrufs, der womöglich geschrieben hat, erreichte die Audit-Datei nicht. Bis zum Neustart des Servers plant und schreibt der Write-Guard nichts mehr.',
    write_plans_full:
      '100 Schreibvorgänge warten in diesem Prozess schon auf eine Bestätigung. Ein neuer Plan endet mit `policy_denied`, bis ältere beantwortet oder nach zehn Minuten verfallen sind.',
    write_answer_refused:
      'Die Antwort auf eine Rückfrage gehört nicht zu diesem Aufruf: anderes Tool, andere Eingabe, anderer Akteur oder ein Zustand in fremder Form. Ecclium schreibt nichts, der Aufruf endet mit `confirmation_required`.',
    write_answer_replayed:
      'Eine Antwort auf eine Rückfrage oder ein Token von `ct_write_confirm` kam ein zweites Mal. Ecclium schreibt nichts, der Aufruf endet mit `confirmation_required`.',
    write_plan_gone:
      'Der Plan zu einer Antwort auf eine Rückfrage oder zu einem Token von `ct_write_confirm` liegt nicht mehr vor, etwa weil er kurz vor der Antwort ablief. Ecclium schreibt nichts, der Aufruf endet mit `confirmation_required`. Eine Antwort nach zehn Minuten oder nach einem Neustart weist schon das SDK ab, nur mit `mcp_server_error` und ohne Zeile im Audit.',
    write_echo_refused:
      'Eine Bestätigung mit `ct_write_confirm` gilt nicht: Das Token ist ungültig, abgelaufen oder für einen anderen Akteur, die Zusammenfassung ist nicht die von Ecclium, oder der Plan lässt das Echo nicht zu. Ecclium schreibt nichts, der Aufruf endet mit `confirmation_required`.',
    write_not_confirmed:
      'Die Person hat eine Rückfrage abgelehnt, abgebrochen oder nicht mit «Ja» angenommen. Ecclium schreibt nichts, der Aufruf endet mit `confirmation_required`.',
    undo_call:
      'Eine Rücknahme mit `ecclium undo` ist zu Ende, mit oder ohne Fehler. `code` nennt den Fehler, `durationMs` die Dauer. Zu jeder Rücknahme gehört eine Zeile vom Typ `undo` im Audit. Text einer Seite und Felder eines Termins oder einer Buchung stehen nie darin.',
    write_queued:
      'Ein Schreibvorgang wartet als verschlüsselter Eintrag in der Freigabe-Warteschlange auf den Betreiber, unter der Kennung der Zeile seines Aufrufs im Audit. Geschrieben ist nichts.',
    write_queue_full:
      'Für diesen Mandanten warten schon 100 Einträge in der Freigabe-Warteschlange. Der Schreibvorgang wird weder geschrieben noch eingereiht, `code` ist `policy_denied`.',
    write_queue_failed:
      'Ecclium konnte einen Eintrag der Freigabe-Warteschlange nicht festhalten, zählen oder entscheiden, oder einen Entscheid nicht im Zähler der Entscheide zählen. Geschrieben ist nichts, `code` ist `internal`.',
    queue_reject_call:
      'Eine Abweisung mit `ecclium queue reject` ist zu Ende, mit oder ohne Fehler. `code` nennt den Fehler, `durationMs` die Dauer. Zu jeder gehört eine Zeile vom Typ `approval` im Audit. Inhalt des Eintrags steht nie darin.',
    queue_approve_call:
      'Eine Freigabe mit `ecclium queue approve` ist zu Ende, mit oder ohne Fehler. `code` nennt den Fehler, `durationMs` die Dauer. Zu jeder gehört eine Zeile vom Typ `approval` im Audit, nach dem Entscheid mit dem Zustand des Schreibvorgangs. Inhalt des Eintrags und Text des Ziels stehen nie darin.',
    write_committed:
      'Ein Schreibvorgang ist geschrieben und gelesen: Die Version ist die geplante, und Text oder Felder sind die gesendeten. Löscht eine Rücknahme einen Termin oder eine Buchung, ist das Gelöschte weg.',
    snapshot_failed:
      'Ecclium konnte vor dem Senden den bisherigen Stand nicht als Snapshot festhalten. Der Schreibvorgang geht nicht an ChurchTools und endet mit `failed`. `code` ist `internal`.',
    snapshot_incomplete:
      'Nach dem Anlegen einer Seite, eines Termins oder einer Buchung konnte Ecclium Kennung und Version nicht im Snapshot ergänzen. Das Angelegte bleibt, sein Snapshot aber unvollständig, und `ecclium undo` kann es nicht zurücknehmen. `code` ist `internal`.',
    policy_not_interactive:
      'Ein Schreibvorgang kam ausserhalb des interaktiven Modus. Bis der Runner den unbeaufsichtigten Teil der Richtlinie nutzt, schreibt Ecclium dort nichts. Der Aufruf endet mit `policy_denied`.',
    policy_queue_only:
      'Die Richtlinie schickt diese Art von Schreibvorgang immer in die Warteschlange der Freigaben, etwa einen in eine Gruppe oder einen Dienst. Beim Planen kommt der Schreibvorgang in die Freigabe-Warteschlange, ohne Warteschlange endet er mit `confirmation_required`. Bei der Prüfung unmittelbar vor dem Senden endet er mit `policy_denied`. In keinem Fall schreibt Ecclium.',
    policy_no_entry:
      'Die Richtlinie hat Einträge, aber keiner deckt dieses Tool und dieses Ziel. Beim Planen kommt der Schreibvorgang in die Freigabe-Warteschlange, ohne Warteschlange endet er mit `confirmation_required`. Bei der Prüfung unmittelbar vor dem Senden endet er mit `policy_denied`. In keinem Fall schreibt Ecclium.',
    policy_name_changed:
      'Das Ziel in ChurchTools trägt nicht mehr den Namen, den die Richtlinie erwartet, oder sein Name ist nicht zu lesen. Gezählt wird nichts. Beim Planen kommt der Schreibvorgang in die Freigabe-Warteschlange, ohne Warteschlange endet er mit `confirmation_required`. Bei der Prüfung unmittelbar vor dem Senden endet er mit `policy_denied`. In keinem Fall schreibt Ecclium.',
    policy_limit_reached:
      'Die Grenze der Schreibvorgänge dieses Tools auf dieses Ziel für den UTC-Tag ist erreicht. Beim Planen kommt der Schreibvorgang in die Freigabe-Warteschlange, ohne Warteschlange endet er mit `confirmation_required`. Bei der Prüfung unmittelbar vor dem Senden endet er mit `policy_denied`. In keinem Fall schreibt Ecclium.',
    policy_count_unavailable:
      'Ecclium konnte einen Schreibvorgang nicht gegen die Grenze der Richtlinie zählen, etwa ohne Ordner für den Zustand. Beim Planen kommt der Schreibvorgang in die Freigabe-Warteschlange, ohne Warteschlange endet er mit `confirmation_required`. Bei der Prüfung unmittelbar vor dem Senden endet er mit `policy_denied`, und Ecclium schreibt nicht. Nur nach einer Freigabe mit `ecclium queue approve` schreibt Ecclium trotzdem, weil die Freigabe auch die Grenze ersetzt, und der Schreibvorgang fehlt dann im Zähler des Tages.',
    marking_repeated:
      'Auf der Seite steht derselbe Abschnitt schon als eigener von Ecclium, mit der Kennzeichnung desselben Tages. Ecclium hängt ihn nicht ein zweites Mal an, der Aufruf endet mit `skipped`.',
    marking_changed:
      'Auf der Seite steht ein Abschnitt mit der Kennzeichnung des Abschnitts, den Ecclium anhängen soll, aber jemand hat ihn seither geändert. Ob es eine Wiederholung ist, entscheidet der Betreiber: Der Schreibvorgang kommt in die Freigabe-Warteschlange, ohne Warteschlange endet er mit `confirmation_required`.',
    content_too_long:
      'Ein Text eines Schreibvorgangs ist länger als 64 KiB oder hat mehr als 2000 Sternchen, Unterstriche, Tilden und Ausrufezeichen. Der Aufruf endet ohne Schreiben, der Grund steht in `contentViolations` des Audits.',
    content_unparsable:
      'Die ContentPolicy konnte einen Text nicht als Markdown lesen oder las seine geschriebene Form anders. Der Aufruf endet ohne Schreiben.',
    content_html:
      'Ein Text enthält HTML, einen Kommentar oder einen Verweis auf ein Zeichen wie `&amp;`. Der Aufruf endet ohne Schreiben.',
    content_image:
      'Ein Text enthält ein Bild. Der Aufruf endet ohne Schreiben.',
    content_link:
      'Ein Text enthält einen Link. Der Aufruf endet ohne Schreiben.',
    content_mention:
      'Ein Text erwähnt eine Person mit einem Link. Der Aufruf endet ohne Schreiben.',
    content_reference:
      'Ein Text enthält eine Referenz oder Fussnote in Markdown. Der Aufruf endet ohne Schreiben.',
    content_web_address:
      'Ein Text enthält etwas, das eine Darstellung als Webadresse verlinken könnte. Der Aufruf endet ohne Schreiben.',
    content_contact:
      'Ein Text enthält eine E-Mail-Adresse, Telefonnummer, IBAN oder AHV-Nummer, die nicht in `interactive.contacts` der Richtlinie steht. Der Aufruf endet ohne Schreiben.',
    content_masked:
      'Ein Text enthält eine Maske der Schwärzung, ein Pseudonym oder die Grenze eines Datenumschlags. Der Aufruf endet ohne Schreiben.',
    content_unsupported:
      'Ein Text nutzt Markdown ausserhalb der erlaubten Teilmenge, oder ein Titel enthält Zeichen von Markdown oder mehr als eine Zeile. Der Aufruf endet ohne Schreiben.',
    content_too_deep:
      'Ein Text verschachtelt Listen oder Hervorhebung tiefer als erlaubt. Der Aufruf endet ohne Schreiben.',
    content_marking:
      'Ein Text enthält eine Zeile, die sich als Kennzeichnung von Ecclium liest: bei einer neuen Seite oder einem Abschnitt jede, bei einer Änderung einer Seite eine, die die Seite nicht schon hat. Diese Zeile setzt nur der Kern. Der Aufruf endet ohne Schreiben.',
    read_search_refused:
      'Ein Tool, das nicht als besonders schützenswert eingestuft ist, wollte Personen oder Gruppen lesen. Ecclium weist das ab.',
    read_names_refused:
      'Ein Tool, das Namen anderer Personen nicht meldet, wollte Einteilungen in Dienste lesen. Ecclium weist das ab.',
    read_operation_refused:
      'Ein anderes Tool als `ct_api_execute_read` wollte den lesenden Zugriff auf die API nutzen. Ecclium weist das ab.',
    read_operation_collision:
      'Die Antwort einer Operation liess sich nicht eindeutig maskiert schreiben. Sie geht nicht hinaus.',
    read_operation_too_large:
      'Die Antwort einer Operation war maskiert zu gross für ein Ergebnis. Sie geht nicht hinaus.',
    mcp_validator_refused:
      'Code wollte ein JSON Schema mit dem Prüfer des MCP-SDK übersetzen, was der Mount nie tut. Der Prüfer hat abgelehnt.',
    mcp_server_error:
      'Das MCP-SDK meldete einen Fehler des Servers. Die Meldung des SDK steht nicht in der Zeile, weil sie Text des Clients enthalten kann.',
    mcp_call_failed:
      'Ein Aufruf eines Tools scheiterte im Mount, etwa an einem Ergebnis ohne die Marke der Maskierung. Der Client erhält `internal`.',
    mcp_stdio_error: 'Die Verbindung über stdio meldete einen Fehler.',
    prompt_served: 'Ein Prompt wurde abgerufen. `prompt` nennt ihn.',
    prompt_refused:
      'Ein Prompt wurde mit Argumenten abgerufen, die er nicht annimmt. `prompt` nennt ihn, nie den Wert eines Arguments.',
    prompt_unknown: 'Ein Prompt, den es nicht gibt, wurde abgerufen.',
    churchtools_context_mismatch:
      'Ein Aufruf hatte einen anderen Mandanten als der Client. Das ist ein Fehler im Code, Ecclium fragt ChurchTools nicht.',
    churchtools_throttled:
      'Die eigene Drosselung von Ecclium hat eine Anfrage an ChurchTools zurückgehalten. Der Aufruf endet mit `rate_limited`.',
    churchtools_operation_answer_refused:
      'Ecclium hat die Antwort von ChurchTools auf eine Operation über `ct_api_execute_read` nicht angenommen, etwa weil sie kein Objekt war oder zu viele Elemente hatte.',
    churchtools_whoami_anonymous:
      'ChurchTools hat das Token keinem Konto zugeordnet oder simuliert ein anderes Konto. Der Aufruf endet mit `auth`.',
    churchtools_permissions_unknown:
      'Die Rechte des Dienstkontos hatten eine Form, die Ecclium nicht kennt. `ct_whoami` nennt sie dann nicht.',
    churchtools_read_input_refused:
      'Ecclium hat eine Kennung zum Lesen einer Person oder Gruppe abgewiesen, bevor es ChurchTools fragte.',
    churchtools_wiki_input_refused:
      'Ecclium hat eine Eingabe für das Wiki abgewiesen, bevor es ChurchTools fragte.',
    churchtools_wiki_write_input_refused:
      'Ecclium hat einen Titel, einen Text oder eine Kennung zum Schreiben im Wiki abgewiesen, bevor es ChurchTools fragte.',
    churchtools_wiki_page_create_status:
      'ChurchTools hat auf das Anlegen einer Seite im Wiki nicht mit 201 geantwortet. `status` nennt den Status, `code` den Fehler. Bei 400 steht in der Kategorie womöglich schon eine Seite mit diesem Titel. Ob ChurchTools trotzdem geschrieben hat, zeigt erst das Lesen danach.',
    churchtools_wiki_page_create_refused:
      'Ecclium hat die Antwort von ChurchTools auf das Anlegen einer Seite im Wiki nicht angenommen, etwa weil sie keine Kennung der Seite nannte. Die Seite kann trotzdem entstanden sein.',
    churchtools_wiki_page_create_missing:
      'ChurchTools kennt die Kategorie nicht, in der Ecclium eine Seite anlegen wollte (404). Der Aufruf endet mit `not_found`.',
    churchtools_wiki_page_update_status:
      'ChurchTools hat auf das Ändern einer Seite im Wiki nicht mit 200 geantwortet. `status` nennt den Status, `code` den Fehler. Ob ChurchTools trotzdem geschrieben hat, zeigt erst das Lesen danach.',
    churchtools_wiki_page_update_missing:
      'ChurchTools kennt die Seite oder ihre Kategorie nicht, die Ecclium ändern wollte (404). Der Aufruf endet mit `not_found`.',
    churchtools_event_input_refused:
      'Ecclium hat eine Eingabe für Events oder Dienste abgewiesen, bevor es ChurchTools fragte.',
    churchtools_calendar_input_refused:
      'Ecclium hat eine Eingabe für Kalender, Termine oder Ressourcen abgewiesen, bevor es ChurchTools fragte.',
    churchtools_calendar_write_refused:
      'Ecclium hat eine Eingabe zum Schreiben eines Termins oder einer Buchung oder zum Lesen für einen solchen Plan abgewiesen, etwa einen Titel, eine Zeit oder eine Kennung, bevor es ChurchTools fragte.',
    churchtools_appointment_create_status:
      'ChurchTools hat auf das Anlegen eines Termins nicht mit 201 geantwortet. `status` nennt den Status, `code` den Fehler. Ob ChurchTools trotzdem geschrieben hat, zeigt erst das Lesen danach.',
    churchtools_appointment_create_refused:
      'Ecclium hat die Antwort von ChurchTools auf das Anlegen eines Termins nicht angenommen, etwa weil sie keine Kennung oder einen anderen Kalender nannte. Der Termin kann trotzdem entstanden sein.',
    churchtools_appointment_create_missing:
      'ChurchTools kennt den Kalender nicht, in dem Ecclium einen Termin anlegen wollte (404). Der Aufruf endet mit `not_found`.',
    churchtools_appointment_update_status:
      'ChurchTools hat auf das Ändern eines Termins nicht mit 200 geantwortet. `status` nennt den Status, `code` den Fehler. Ob ChurchTools trotzdem geschrieben hat, zeigt erst das Lesen danach.',
    churchtools_appointment_update_missing:
      'ChurchTools kennt den Termin oder seinen Kalender nicht, den Ecclium ändern wollte (404). Der Aufruf endet mit `not_found`.',
    churchtools_appointment_delete_status:
      'ChurchTools hat auf das Löschen eines Termins, den Ecclium angelegt hatte, nicht mit 204 geantwortet. `status` nennt den Status, `code` den Fehler. Ob ChurchTools trotzdem gelöscht hat, zeigt erst das Lesen danach.',
    churchtools_appointment_delete_missing:
      'ChurchTools kennt den Termin nicht mehr, den Ecclium zurücknehmen wollte (404). Der Aufruf endet mit `not_found`.',
    churchtools_booking_create_status:
      'ChurchTools hat auf das Anfragen einer Buchung nicht mit 201 geantwortet. `status` nennt den Status, `code` den Fehler. Bei 422 bucht ChurchTools die Ressource nur zusammen mit einem Termin. Ob ChurchTools trotzdem geschrieben hat, zeigt erst das Lesen danach.',
    churchtools_booking_create_refused:
      'Ecclium hat die Antwort von ChurchTools auf das Anfragen einer Buchung nicht angenommen, etwa weil sie keine Kennung oder eine andere Ressource nannte. Die Buchung kann trotzdem entstanden sein.',
    churchtools_booking_create_missing:
      'ChurchTools kennt die Ressource nicht, für die Ecclium eine Buchung anfragen wollte (404). Der Aufruf endet mit `not_found`.',
    churchtools_booking_delete_status:
      'ChurchTools hat auf das Löschen einer Buchung, die Ecclium angefragt hatte, nicht mit 204 geantwortet. `status` nennt den Status, `code` den Fehler. Ob ChurchTools trotzdem gelöscht hat, zeigt erst die Liste der Buchungen ihres Tages.',
    churchtools_booking_delete_missing:
      'ChurchTools kennt die Buchung nicht mehr, die Ecclium zurücknehmen wollte (404). Der Aufruf endet mit `not_found`.',
    churchtools_song_input_refused:
      'Ecclium hat eine Eingabe für Songs abgewiesen, bevor es ChurchTools fragte.',
    churchtools_search_input_refused:
      'Ecclium hat eine Eingabe für die globale Suche abgewiesen, bevor es ChurchTools fragte.',
    churchtools_search_term_refused:
      'Ecclium hat einen Suchbegriff abgewiesen, bevor es ChurchTools fragte.',
    churchtools_operation_unknown:
      'Eine Operation, die der Katalog der Escape Hatch nicht kennt, wurde verlangt. Ecclium fragt ChurchTools nicht.',
    churchtools_operation_refused:
      'Eine Operation, die der Katalog der Escape Hatch nicht freigibt, wurde verlangt. Ecclium fragt ChurchTools nicht.',
    churchtools_operation_input_refused:
      'Ecclium hat einen Wert in Pfad oder Query einer Operation abgewiesen, bevor es ChurchTools fragte.',
    churchtools_operation_too_large:
      'Die Antwort auf eine Operation war grösser als ihre Grenze.',
    http_response:
      'ChurchTools hat geantwortet. `method` nennt die Methode der Anfrage, `status` den Status, `durationMs` die Dauer.',
    audit_missing_error_code:
      'Eine Zeile mit `error` oder `denied` kam ohne Fehlercode. Die Zeile im Audit trägt einen Platzhalter.',
    audit_missing_undoes:
      'Eine Zeile vom Typ `undo` kam ohne die Kennung des Schreibvorgangs, den sie zurücknimmt. Die Zeile im Audit trägt in `undoes` die Null-UUID als Platzhalter, die keinen Schreibvorgang nennt.',
    audit_missing_queue_id:
      'Eine Zeile vom Typ `approval` kam ohne die Kennung des Eintrags der Freigabe-Warteschlange. Die Zeile im Audit trägt in `queueId` die Null-UUID als Platzhalter, die keinen Eintrag nennt.',
    audit_missing_decision:
      'Eine Zeile vom Typ `approval` kam ohne den Entscheid. Die Zeile im Audit trägt in `decision` den Platzhalter `rejected`, der keinen Schreibvorgang behauptet.',
    audit_unknown_fields:
      'Eine Zeile kam mit Feldern, die das Schema nicht kennt. `count` nennt ihre Zahl, die Felder fallen weg.',
    audit_schema_mismatch:
      'Die gebaute Zeile passte nicht zum Schema des Audits, ein Fehler im Code. Die Zeile trägt nur Platzhalter.',
    audit_unreadable:
      'Ecclium konnte die Angaben einer Zeile nicht lesen. Die Zeile trägt nur Platzhalter.',
    audit_chain_anchor:
      'Der Anker einer Audit-Datei: `file` nennt die Datei, `seq` und `hash` den Kopf ihrer Kette, beim Schliessen, beim Wechsel des Tages, beim Neuöffnen und nach jedem Aufruf, der geschrieben haben kann, auch nach `ecclium undo` und `ecclium queue approve`. `ecclium audit verify` prüft eine Datei gegen ihn.',
    audit_file_closed:
      'Die Audit-Datei ist geschlossen. `count` nennt die Zeilen, die nicht ganz in die Datei kamen.',
    audit_files_deleted:
      'Ecclium hat Audit-Dateien nach ihrer Frist oder leere Dateien gelöscht. `count` nennt ihre Zahl.',
    audit_files_not_deleted:
      'Ecclium konnte Audit-Dateien nach ihrer Frist nicht löschen oder den Ordner nicht ganz lesen. `count` nennt die Zahl der Dateien, die liegen blieben.',
    day_keys_destroyed:
      'Ecclium hat Tagesschlüssel der Snapshots nach ihrer Frist von 30 Tagen vernichtet, beim Start oder beim Wechsel des UTC-Tages. Snapshots dieser Tage lassen sich nicht mehr öffnen, in keiner Kopie. `count` nennt die Zahl der Schlüssel. Mit einem Ordner aus `ECCLIUM_STATE_DIR` löscht Ecclium dabei auch die Snapshots dieser Tage, was `snapshots_deleted` meldet.',
    day_keys_not_destroyed:
      'Ecclium konnte nicht jeden Tagesschlüssel der Snapshots nach seiner Frist vernichten, etwa weil der Ordner `snapshot` im Ordner aus `ECCLIUM_KEYS_DIR` nicht mehr privat ist oder darin ein Ordner unter dem Namen eines Schlüssels steht. Die übrigen hat es vernichtet. Ecclium versucht es spätestens nach einer Stunde erneut. Mit einem Ordner aus `ECCLIUM_STATE_DIR` steht dafür `snapshots_not_deleted`.',
    snapshots_deleted:
      'Ecclium hat Snapshots nach ihrer Frist von 30 Tagen gelöscht, beim Start oder beim Wechsel des UTC-Tages, auch wenn es nur liest. Diese Schreibvorgänge lassen sich nicht mehr zurücknehmen. `count` nennt die Zahl der gelöschten Teile, einer oder zwei je Schreibvorgang. Die Tagesschlüssel ihrer Tage meldet `day_keys_destroyed`.',
    snapshots_not_deleted:
      'Ecclium konnte nicht jeden Snapshot nach seiner Frist löschen oder nicht jeden Tagesschlüssel seines Tages vernichten, etwa weil der Ordner `snapshots` im Ordner aus `ECCLIUM_STATE_DIR` oder der Ordner `snapshot` im Ordner aus `ECCLIUM_KEYS_DIR` nicht mehr privat ist, oder weil die Uhr keinen Tag ergab. Ecclium versucht es spätestens nach einer Stunde erneut.',
    queue_entries_deleted:
      'Ecclium hat Einträge und Entscheide der Freigabe-Warteschlange nach ihrer Frist von 14 Tagen gelöscht, beim Start oder beim Wechsel des UTC-Tages, auch wenn es nur liest. Diese Schreibvorgänge lassen sich nicht mehr freigeben. `count` nennt die Zahl der gelöschten Dateien. Die Tagesschlüssel ihrer Tage meldet `queue_day_keys_destroyed`.',
    queue_day_keys_destroyed:
      'Ecclium hat Tagesschlüssel der Freigabe-Warteschlange nach ihrer Frist von 14 Tagen vernichtet, beim Start oder beim Wechsel des UTC-Tages. Einträge dieser Tage lassen sich nicht mehr öffnen, in keiner Kopie. `count` nennt die Zahl der Schlüssel.',
    queue_not_purged:
      'Ecclium konnte nicht jeden Eintrag der Freigabe-Warteschlange nach seiner Frist löschen oder nicht jeden Tagesschlüssel seines Tages vernichten, etwa weil der Ordner `queue` im Ordner aus `ECCLIUM_STATE_DIR` oder im Ordner aus `ECCLIUM_KEYS_DIR` nicht mehr privat ist, oder weil die Uhr keinen Tag ergab. Ecclium versucht es spätestens nach einer Stunde erneut.',
    stdio_start_failed:
      'Der Start über stdio ist gescheitert. `code` nennt den Grund, die Meldung für Betreiber steht davor.',
    stdio_closed:
      'Der Server über stdio ist beendet. `count` nennt die Zeilen, die nicht auf stderr kamen. Es ist die letzte Zeile.',
    process_uncaught_exception:
      'Ein Fehler wurde nirgends abgefangen. Der Prozess endet mit 70.',
    process_unhandled_rejection:
      'Eine Promise wurde abgelehnt, ohne dass jemand darauf wartete. Der Prozess endet mit 70.',
    process_sigterm: 'Der Prozess erhielt `SIGTERM` und endet.',
    process_sigint: 'Der Prozess erhielt `SIGINT` und endet.',
  },
);

const familyMeaning = (name: string): string | undefined => {
  const read = (suffix: string): string | undefined => {
    if (!name.startsWith('churchtools_') || !name.endsWith(suffix)) {
      return undefined;
    }
    const object = name.slice('churchtools_'.length, -suffix.length);
    return Object.hasOwn(readObjects, object) ? readObjects[object] : undefined;
  };
  const status = read('_status');
  if (status !== undefined) {
    return `ChurchTools hat auf das Lesen über ${status} nicht mit 200 geantwortet. \`status\` nennt den Status, \`code\` den Fehler des Aufrufs.`;
  }
  const missing = read('_missing');
  if (missing !== undefined) {
    return `ChurchTools kennt beim Lesen über ${missing} die Kennung nicht (404). Der Aufruf endet mit \`not_found\`.`;
  }
  const foreign = read('_foreign');
  if (foreign !== undefined) {
    return `Die Antwort auf ${foreign} nannte Einträge, nach denen nicht gefragt war. Ecclium hat sie abgewiesen.`;
  }
  const term = read('_term_refused');
  if (term !== undefined) {
    return `Ecclium hat einen Suchbegriff für ${term} abgewiesen, bevor es ChurchTools fragte.`;
  }
  const refused = read('_refused');
  if (refused !== undefined) {
    return `Ecclium hat die Antwort von ChurchTools auf ${refused} nicht angenommen, etwa weil sie nicht zum Schema passte.`;
  }
  if (name.startsWith('http_')) {
    const category = name.slice('http_'.length);
    if (Object.hasOwn(httpFailures, category)) {
      return `${httpFailures[category] ?? ''} \`code\` nennt den Fehler, \`durationMs\` die Dauer bis dahin, \`method\` die Methode der Anfrage.`;
    }
  }
  if (name.startsWith('audit_invalid_')) {
    return `Ein Erzeuger gab für das Feld \`${name.slice('audit_invalid_'.length)}\` einer Zeile des Audits einen Wert, den die Senke nicht annimmt. Die Zeile trägt einen Platzhalter oder lässt das Feld weg, bei einer Liste nennt \`count\` ihre Länge.`;
  }
  if (name.startsWith('audit_reserved_')) {
    return `Ein Erzeuger setzte das Feld \`${name.slice('audit_reserved_'.length)}\` einer Zeile des Audits, das nur die Senke oder der Schreiber der Datei setzt. Es fällt weg.`;
  }
  return undefined;
};

/**
 * The meaning of an event for operators: its own, or the one of its family.
 *
 * @param name - The name of the event.
 * @returns The meaning, or undefined if there is none.
 * @example
 * ```ts
 * logEventMeaning('tool_call')?.startsWith('Ein Aufruf'); // true
 * ```
 */
export function logEventMeaning(name: string): string | undefined {
  return Object.hasOwn(logEventMeanings, name)
    ? logEventMeanings[name]
    : familyMeaning(name);
}

// The sections of the page, in order: the first whose test fits an event
// takes it.
const sections: readonly {
  readonly title: string;
  readonly fits: (name: string) => boolean;
}[] = Object.freeze([
  {
    title: 'Pipeline der Tools',
    fits: (name: string) =>
      name.startsWith('tool_') ||
      name === 'audit_withheld' ||
      name.startsWith('pseudonym_') ||
      name.startsWith('read_budget_'),
  },
  {
    title: 'Write-Guard',
    fits: (name: string) =>
      name.startsWith('write_') ||
      name.startsWith('undo_') ||
      name.startsWith('queue_reject_') ||
      name.startsWith('snapshot_') ||
      name.startsWith('policy_') ||
      name.startsWith('content_') ||
      name.startsWith('marking_'),
  },
  {
    title: 'Lesender Zugriff über den Kern',
    fits: (name: string) => name.startsWith('read_'),
  },
  {
    title: 'Mount und Prompts',
    fits: (name: string) =>
      name.startsWith('mcp_') || name.startsWith('prompt_'),
  },
  {
    title: 'Client für ChurchTools',
    fits: (name: string) => name.startsWith('churchtools_'),
  },
  {
    title: 'Ausgehender Weg',
    fits: (name: string) => name.startsWith('http_'),
  },
  {
    title: 'Audit',
    fits: (name: string) => name.startsWith('audit_'),
  },
  {
    title: 'Snapshots, Freigabe-Warteschlange und Tagesschlüssel',
    fits: (name: string) =>
      name.startsWith('snapshots_') ||
      name.startsWith('queue_') ||
      name.startsWith('day_keys_'),
  },
  {
    title: 'Prozess über stdio',
    fits: (name: string) =>
      name.startsWith('stdio_') || name.startsWith('process_'),
  },
]);

const code = (text: string): string => `\`${text}\``;

/**
 * The section of each event, in the order of the page.
 *
 * @returns The titles with their events, each event once.
 * @throws {Error} When an event fits no section.
 * @example
 * ```ts
 * logEventSections()[0]?.title; // 'Pipeline der Tools'
 * ```
 */
export function logEventSections(): readonly {
  readonly title: string;
  readonly events: readonly LogEventName[];
}[] {
  const names = (Object.keys(logEvents) as LogEventName[]).sort();
  const rest = names.filter((name) => !sections.some((s) => s.fits(name)));
  if (rest.length > 0) {
    throw new Error(`No section for ${rest.join(', ')}.`);
  }
  const taken = new Set<string>();
  return sections.map((section) => {
    const events = names.filter(
      (name) => !taken.has(name) && section.fits(name),
    );
    for (const name of events) taken.add(name);
    return { title: section.title, events };
  });
}

/**
 * Renders `docs/log-events.md` from the catalog of the core.
 *
 * @returns The page in Markdown.
 * @throws {Error} When a field or an event has no meaning, or an event fits
 *   no section.
 * @example
 * ```ts
 * renderLogEventsReference().startsWith('# Logzeilen'); // true
 * ```
 */
export function renderLogEventsReference(): string {
  const meaning = (name: string): string => {
    const text = logEventMeaning(name);
    if (text === undefined) throw new Error(`No meaning for ${name}.`);
    return text;
  };
  const lines = [
    '# Logzeilen',
    '',
    '<!-- Erzeugt mit `pnpm docs:generate` aus dem Katalog der Logzeilen. Nicht von Hand ändern. -->',
    '',
    'Diese Seite entsteht mit `pnpm docs:generate` aus dem Katalog der Logzeilen im Kern ([ADR 0054](adr/0054-secret-fehler-logger-audit.md)). Ein Test liest jeden Aufruf eines Loggers im Code und scheitert an einer Zeile, die hier fehlt, an einer anderen Stufe und an einem Feld, das hier nicht steht. Ändern Sie die Seite deshalb nicht von Hand.',
    '',
    'Ecclium schreibt seine Logzeilen als JSON Lines nach stderr, über stdio also dorthin, wo der Client stderr hinschreibt, etwa in eine Logdatei je Server. Eine Zeile trägt nur die Felder unten und nur Werte einer festen Form: keinen Text aus ChurchTools, keine Namen oder Kennungen von Personen, keine Pfade, Adressen oder Hosts und kein Token. Ein Ereignis, das nicht unter «Ereignisse» steht, schreibt der Logger als `invalid_event`, auch das eines Plugins, damit kein Name aus Daten in eine Zeile kommt. Neben den Logzeilen gehen nach stderr die Kopien der Zeilen des Audits, siehe [Audit-Ereignisse](audit-events.md), und die Meldungen der Kommandozeile für Betreiber.',
    '',
    '## Felder',
    '',
    'In dieser Reihenfolge, jedes nur, wenn es einen Wert hat. Die Felder des Kerns bindet der Kern an den Logger eines Aufrufs, ein Aufruf kann sie nicht setzen.',
    '',
    '| Feld | Gesetzt von | Bedeutung |',
    '| --- | --- | --- |',
    ...logFieldNames.map((name) => {
      const field = Object.hasOwn(logFieldMeanings, name)
        ? logFieldMeanings[name]
        : undefined;
      if (field === undefined) throw new Error(`No meaning for ${name}.`);
      return `| ${code(name)} | ${field.setBy} | ${field.meaning} |`;
    }),
    '',
    '## Ereignisse',
    '',
    'Je Ereignis die Stufe und die Felder, die ein Aufruf höchstens setzt. Die Felder des Kerns kommen je nach Logger dazu.',
  ];
  for (const section of logEventSections()) {
    lines.push(
      '',
      `### ${section.title}`,
      '',
      '| Ereignis | Stufe | Felder | Bedeutung |',
      '| --- | --- | --- | --- |',
      ...section.events.map((name) => {
        const entry = logEvents[name];
        const fields =
          entry.fields.length === 0
            ? 'keine'
            : entry.fields.map(code).join(', ');
        return `| ${code(name)} | ${code(entry.level)} | ${fields} | ${meaning(name)} |`;
      }),
    );
  }
  lines.push('');
  return lines.join('\n');
}
