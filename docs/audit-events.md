# Audit-Ereignisse

<!-- Erzeugt mit `pnpm docs:generate` aus dem Schema der Ereignisse. Nicht von Hand ändern. -->

Diese Seite entsteht mit `pnpm docs:generate` aus dem Schema der Audit-Ereignisse im Kern ([ADR 0028](adr/0028-audit-ereignis-und-datei-sink.md)), ebenso das JSON Schema einer Zeile in [`schemas/audit-event.v1.json`](../schemas/audit-event.v1.json). Ein Test vergleicht beide mit dem Code. Ändern Sie sie deshalb nicht von Hand.

Jede Zeile ist ein JSON-Objekt auf einer Zeile. Mit `ECCLIUM_STATE_DIR` geht sie zuerst in die Audit-Datei und danach als Kopie nach stderr, ohne den Ordner nur nach stderr. Massgeblich ist die Zeile in der Datei. Die Kopie hat ein leeres `objectRefs` und keines der Felder, die nur in die Datei gehören, denn viele Clients schreiben stderr in eine Logdatei, die Ecclium weder schützt noch löscht. Wie lange die Dateien bleiben und wer sie lesen kann, steht in [Datenschutz](privacy.md).

## Typen

| Typ | Bedeutung |
| --- | --- |
| `tool_call` | Ein Aufruf eines Tools, auch eines unbekannten, eines abgelehnten und eines gescheiterten. Jeder Aufruf ergibt genau eine Zeile, geschrieben auch dann, wenn eine Stufe der Pipeline scheitert. |
| `undo` | Ein Lauf von `ecclium undo`, der einen Schreibvorgang von Ecclium aus seinem verschlüsselten Snapshot zurücknimmt ([ADR 0031](adr/0031-persistenz-und-tagesschluessel.md)). Jeder Lauf, der den Snapshot sucht, ergibt genau eine Zeile, mit `undoes` und ohne `tool`. Ein Lauf, der vorher am Aufruf oder an der Konfiguration scheitert, ergibt keine. `ecclium audit show` zählt diese Zeilen als Rücknahmen in einer eigenen Zeile, `ecclium policy init` leitet aus ihnen weder Ziele noch Grenzen ab. |
| `approval` | Ein Entscheid des Betreibers über einen Eintrag der Freigabe-Warteschlange mit `ecclium queue` ([ADR 0031](adr/0031-persistenz-und-tagesschluessel.md)). Jeder Lauf, der einen Eintrag sucht, ergibt genau eine Zeile, mit `queueId` und `decision` und ohne `tool`. Eine Abweisung schreibt nichts in ChurchTools und hat weder `writeState` noch `confirmation`. Eine Freigabe schreibt sofort ([ADR 0029](adr/0029-write-guard.md)): Ist sie entschieden, nennt ihre Zeile den Zustand des Schreibvorgangs in `writeState`, `confirmation: operator`, sobald der Nachweis verbraucht ist, `policyHash` und das Ziel. Ihre `eventId` ist die Kennung, mit der `ecclium undo` den Schreibvorgang zurücknimmt. Den Wunsch selbst hält die Zeile des Aufrufs vom Typ `tool_call` mit `writeState: queued` fest, deren `eventId` die `queueId` ist. `ecclium audit show` zählt Freigaben und Abweisungen je in einer eigenen Zeile, `ecclium policy init` leitet aus ihnen weder Ziele noch Grenzen ab. |

## Felder

| Feld | Form | Pflicht | Auf stderr | Bedeutung |
| --- | --- | --- | --- | --- |
| `v` | `1` | ja | ja | Version des Formats, immer 1. |
| `eventId` | Text nach festem Muster, höchstens 36 Zeichen | ja | ja | Kennung des Ereignisses, gleich der `eventId` in den Logzeilen desselben Aufrufs. |
| `ts` | Text nach festem Muster, höchstens 24 Zeichen | ja | ja | Zeit des Ereignisses in UTC, auf die Millisekunde. |
| `type` | `tool_call`, `undo`, `approval` | ja | ja | Art des Ereignisses, siehe «Typen». |
| `undoes` | Text nach festem Muster, höchstens 36 Zeichen | nein | ja | Kennung (`eventId`) der Zeile des Schreibvorgangs, den ein Lauf von `ecclium undo` zurücknimmt ([ADR 0031](adr/0031-persistenz-und-tagesschluessel.md)). In jeder Zeile vom Typ `undo` und in keiner anderen. Die Null-UUID steht für eine Kennung, die fehlte oder nicht passte, und nennt keinen Schreibvorgang. |
| `queueId` | Text nach festem Muster, höchstens 36 Zeichen | nein | ja | Kennung des Eintrags der Freigabe-Warteschlange, über den der Betreiber entschieden hat, gleich der `eventId` der Zeile des Aufrufs, der den Schreibvorgang eingereiht hat ([ADR 0031](adr/0031-persistenz-und-tagesschluessel.md)). In jeder Zeile vom Typ `approval` und in keiner anderen. Die Null-UUID steht für eine Kennung, die fehlte oder nicht passte, und nennt keinen Eintrag. |
| `decision` | `approved`, `rejected` | nein | ja | Was der Betreiber über den Eintrag entschieden hat: `approved` für eine Freigabe, `rejected` für eine Abweisung. In jeder Zeile vom Typ `approval` und in keiner anderen. |
| `tenantId` | Text nach festem Muster, höchstens 63 Zeichen | ja | ja | Kennung des Mandanten. |
| `actor` | Objekt | ja | ja | Wer gehandelt hat. |
| `actor.kind` | `service`, `user`, `runner`, `operator` | ja | ja | Art des Akteurs: Dienst, Benutzer, Runner oder Betreiber. |
| `actor.id` | Text nach festem Muster, höchstens 97 Zeichen | ja | ja | Neutrale Bezeichnung des Akteurs, über stdio `stdio:` mit dem Subjekt aus `ECCLIUM_STDIO_SUBJECT`, nie der Name einer Person. |
| `mode` | `interactive`, `unattended`, `operator` | ja | ja | Wie der Aufruf lief: interaktiv, unbeaufsichtigt oder durch den Betreiber. |
| `runId` | Text nach festem Muster, höchstens 36 Zeichen | nein | ja | Kennung des Laufs einer Routine. |
| `routineId` | Text nach festem Muster, höchstens 63 Zeichen | nein | ja | Kennung der Routine eines Laufs. |
| `tool` | Text nach festem Muster, höchstens 63 Zeichen | nein | ja | Name des Tools, `ct_unknown` für ein Tool, das es nicht gibt. Nie in einer Zeile vom Typ `undo` oder `approval`, denn eine Rücknahme und ein Entscheid über die Freigabe-Warteschlange rufen kein Tool auf. |
| `outcome` | `ok`, `error`, `denied` | ja | ja | Ausgang des Aufrufs: `ok`, `error` bei einem Fehler oder `denied` bei einer Ablehnung. |
| `confirmation` | `elicitation`, `echo`, `policy`, `operator` | nein | ja | Wie ein Schreibvorgang bestätigt wurde. |
| `writeState` | `planned`, `queued`, `verified`, `skipped`, `denied`, `conflict`, `failed`, `rolledBack` | nein | ja | Der Zustand eines Schreibvorgangs am Ende des Aufrufs: `planned`, `queued`, `verified` oder `skipped` bei `ok`, `denied` bei `denied`, `conflict`, `failed` oder `rolledBack` bei `error`. `denied` heisst, dass Ecclium nichts gesendet hat, auch bei einem Konflikt vor dem Schreiben, dann mit dem Fehlercode `conflict`. `conflict` heisst, dass Ecclium geschrieben hat und das Ziel danach nicht wie geplant liest. Wer Schreibvorgänge zählt, liest dieses Feld. |
| `policyHash` | Text nach festem Muster, höchstens 64 Zeichen | nein | ja | SHA-256 der Richtlinie, die einen Aufruf eines schreibenden Tools beurteilt hat, wie `ecclium config check` ihn zeigt. Jede Zeile eines schreibenden Tools nennt ihn, auch eine abgelehnte, ebenso jede Zeile einer entschiedenen Freigabe. Später nennt ihn auch jede Zeile eines Laufs des Runners. |
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
| `contentViolations` | Liste mit höchstens 13 Einträgen, je `tooLong`, `unparsable`, `html`, `image`, `link`, `mention`, `reference`, `webAddress`, `contact`, `masked`, `unsupported`, `tooDeep`, `marking` | nein | ja | Warum die ContentPolicy den Text eines Schreibvorgangs abgelehnt hat, als feste Namen wie `webAddress` oder `contact`, nie mit dem Text ([ADR 0030](adr/0030-contentpolicy.md)). Nur in einer Zeile mit `denied`. |
| `withheldAfterRead` | `true` | nein | nein | Der Server hat das Ergebnis gelesen, aber zurückgehalten, weil seine Zeile nicht so in die Datei kam, wie sie war. Die Zeile sagt dann `denied` mit `policy_denied`. |
| `rightsDriftAccepted` | `true` | nein | ja | Ein Schreibvorgang eines Laufs, dessen Konto Rechte hat, die keine seiner Routinen braucht, und den die befristete Ausnahme `acceptRightsDrift` der Richtlinie an der Prüfung der Rechte vorbeiliess. Ob er schrieb, sagt `writeState`. |
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
