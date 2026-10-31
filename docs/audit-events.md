# Audit-Ereignisse

<!-- Erzeugt mit `pnpm docs:generate` aus dem Schema der Ereignisse. Nicht von Hand ändern. -->

Diese Seite entsteht mit `pnpm docs:generate` aus dem Schema der Audit-Ereignisse im Kern ([ADR 0028](adr/0028-audit-ereignis-und-datei-sink.md)), ebenso das JSON Schema einer Zeile in [`schemas/audit-event.v1.json`](../schemas/audit-event.v1.json). Ein Test vergleicht beide mit dem Code. Ändern Sie sie deshalb nicht von Hand.

Jede Zeile ist ein JSON-Objekt auf einer Zeile. Mit `ECCLIUM_STATE_DIR` geht sie zuerst in die Audit-Datei und danach als Kopie nach stderr, ohne den Ordner nur nach stderr. Massgeblich ist die Zeile in der Datei. Die Kopie hat ein leeres `objectRefs` und keines der Felder, die nur in die Datei gehören, denn viele Clients schreiben stderr in eine Logdatei, die Ecclium weder schützt noch löscht. Wie lange die Dateien bleiben und wer sie lesen kann, steht in [Datenschutz](privacy.md).

## Typen

| Typ | Bedeutung |
| --- | --- |
| `tool_call` | Ein Aufruf eines Tools, auch eines unbekannten, eines abgelehnten und eines gescheiterten. Jeder Aufruf ergibt genau eine Zeile, geschrieben auch dann, wenn eine Stufe der Pipeline scheitert. |

## Felder

| Feld | Form | Pflicht | Auf stderr | Bedeutung |
| --- | --- | --- | --- | --- |
| `v` | `1` | ja | ja | Version des Formats, immer 1. |
| `eventId` | Text nach festem Muster, höchstens 36 Zeichen | ja | ja | Kennung des Ereignisses, gleich der `eventId` in den Logzeilen desselben Aufrufs. |
| `ts` | Text nach festem Muster, höchstens 24 Zeichen | ja | ja | Zeit des Ereignisses in UTC, auf die Millisekunde. |
| `type` | `tool_call` | ja | ja | Art des Ereignisses, siehe «Typen». |
| `tenantId` | Text nach festem Muster, höchstens 63 Zeichen | ja | ja | Kennung des Mandanten. |
| `actor` | Objekt | ja | ja | Wer gehandelt hat. |
| `actor.kind` | `service`, `user`, `runner`, `operator` | ja | ja | Art des Akteurs: Dienst, Benutzer, Runner oder Betreiber. |
| `actor.id` | Text nach festem Muster, höchstens 97 Zeichen | ja | ja | Neutrale Bezeichnung des Akteurs, über stdio `stdio:` mit dem Subjekt aus `ECCLIUM_STDIO_SUBJECT`, nie der Name einer Person. |
| `mode` | `interactive`, `unattended`, `operator` | ja | ja | Wie der Aufruf lief: interaktiv, unbeaufsichtigt oder durch den Betreiber. |
| `runId` | Text nach festem Muster, höchstens 36 Zeichen | nein | ja | Kennung des Laufs einer Routine. |
| `routineId` | Text nach festem Muster, höchstens 63 Zeichen | nein | ja | Kennung der Routine eines Laufs. |
| `tool` | Text nach festem Muster, höchstens 63 Zeichen | nein | ja | Name des Tools, `ct_unknown` für ein Tool, das es nicht gibt. |
| `outcome` | `ok`, `error`, `denied` | ja | ja | Ausgang des Aufrufs: `ok`, `error` bei einem Fehler oder `denied` bei einer Ablehnung. |
| `confirmation` | `elicitation`, `echo`, `policy`, `operator` | nein | ja | Wie ein Schreibvorgang bestätigt wurde. |
| `policyHash` | Text nach festem Muster, höchstens 64 Zeichen | nein | ja | SHA-256 der Richtlinie eines Laufs. |
| `provider` | Objekt | nein | ja | Das Sprachmodell eines Laufs, wie die Konfiguration es nennt. |
| `provider.vendor` | Text nach festem Muster, höchstens 32 Zeichen | nein | ja | Anbieter des Modells. |
| `provider.model` | Text nach festem Muster, höchstens 64 Zeichen | nein | ja | Name des Modells beim Anbieter. |
| `provider.hostingCountry` | Text nach festem Muster, höchstens 2 Zeichen | nein | ja | Land, in dem das Modell betrieben wird, mit zwei Buchstaben. |
| `provider.endpointHost` | Text nach festem Muster, höchstens 253 Zeichen | nein | ja | Hostname des Endpunkts, nie eine Adresse mit Pfad oder Schlüssel. |
| `provider.transferBasis` | Text nach festem Muster, höchstens 32 Zeichen | nein | ja | Rechtsgrundlage einer Übermittlung ausserhalb der Schweiz und des EWR. |
| `pluginHashes` | Liste mit höchstens 64 Einträgen, je Text nach festem Muster, höchstens 64 Zeichen | nein | ja | SHA-256 der geladenen Plugins. |
| `dataProtectionRegime` | Text nach festem Muster, höchstens 32 Zeichen | nein | ja | Datenschutzrecht des Mandanten, nur im gehosteten Betrieb. |
| `objectRefs` | Liste mit höchstens 100 Einträgen, je Text nach festem Muster, höchstens 50 Zeichen | ja | leer | Kennungen der Objekte, nach denen der Aufruf fragt, und der Personen und Gruppen, die sein Ergebnis nennt, als `<Bereich>:<Kennung>`, jede einmal, zuerst die aus der Anfrage, höchstens 100. Nur die Audit-Datei nennt sie. |
| `objectRefsOmitted` | ganze Zahl von 1 bis 1'000'000 | nein | nein | Zahl der weiteren Kennungen, die der Aufruf über die 100 in `objectRefs` hinaus nannte. |
| `errorCode` | `config`, `auth`, `permission`, `not_found`, `validation`, `conflict`, `rate_limited`, `upstream`, `network`, `policy_denied`, `confirmation_required`, `license_required`, `internal` | nein | ja | Fehlercode bei `error` und `denied`. |
| `withheldAfterRead` | `true` | nein | nein | Der Server hat das Ergebnis gelesen, aber zurückgehalten, weil seine Zeile nicht so in die Datei kam, wie sie war. Die Zeile sagt dann `denied` mit `policy_denied`. |
| `durationMs` | ganze Zahl von 0 bis 86'400'000 | ja | ja | Dauer des Aufrufs in Millisekunden. |
| `seq` | ganze Zahl von 1 bis 9'007'199'254'740'991 | nein | nein | Stelle der Zeile in der Hash-Kette ihrer Datei, ab 1 für die erste ganze Zeile. Nur der Schreiber der Datei setzt sie. Ein Stück einer Zeile zählt nicht, die nächste ganze Zeile trägt dann dieselbe Stelle. |
| `prevHash` | Text nach festem Muster, höchstens 64 Zeichen | nein | nein | SHA-256 der vorigen ganzen Zeile der Datei, so wie sie dort steht, ohne ihren Zeilenumbruch, hexadezimal. Bei der ersten Zeile ist es der SHA-256 des Namens der Datei, damit sich Dateien nicht vertauschen oder umbenennen lassen. Nur der Schreiber der Datei setzt ihn. |

## Bereiche der Kennungen

Ein Eintrag von `objectRefs` hat die Form `<Bereich>:<Kennung>`, die Kennung aus höchstens 16 Ziffern oder eine GUID in Kleinbuchstaben, nie ein Name. Die Liste der Bereiche ist geschlossen, damit der Teil vor dem Doppelpunkt keinen Namen tragen kann. Die Kennungen leitet der Kern aus den Schemas der Tools ab, bei `ct_api_execute_read` aus den geprüften Werten in Pfad und Query, nie aus dem Code eines Tools.

| Bereich | Objekt |
| --- | --- |
| `person` | Person |
| `group` | Gruppe |
| `event` | Event |
| `appointment` | Termin |
| `calendar` | Kalender |
| `resource` | Ressource |
| `booking` | Buchung |
| `service` | Dienst |
| `song` | Song |
| `wiki_category` | Kategorie des Wikis |
| `wiki_page` | Seite des Wikis |
