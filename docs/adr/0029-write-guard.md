# ADR 0029: Write-Guard: Planen und Festschreiben, Nachweise nur im Kern, Wege der Bestätigung, Schutz vor Wiederholung, Zustands-Ports, Vertrag für Schreib-Tools aus Plugins

- Status: Vorgeschlagen
- Datum: 01.11.2026
- Fällt vor: Phase 5
- Ergänzt: [ADR 0028](0028-audit-ereignis-und-datei-sink.md) und [ADR 0063](0063-quotastore-als-datei.md)

## Kontext

Mit Phase 5 schreibt Ecclium in ChurchTools: Seiten im Wiki anlegen, ändern und um einen Abschnitt ergänzen, Termine anlegen und ändern und Buchungen anfragen ([ADR 0071](0071-grenze-zwischen-kern-und-pro.md)). Bis dahin lehnt die Stufe `gate` jedes Schreib-Tool mit `policy_denied` ab ([ADR 0024](0024-eine-tool-pipeline.md), Umsetzung). Festzulegen ist, wie ein Schreibvorgang entsteht, wer ihn bestätigt, wer ihn festschreibt und wie er im Protokoll steht. Dabei gilt:

- **Nur der Kern schreibt:** Ein Schreib-Tool plant ein Vorhaben, also eine Art von Schreibvorgang, die der Kern kennt und selbst ausführt, etwa «Abschnitt an eine Seite anhängen». Schreiben kann nur der Kern, mit einem Nachweis ([Threat Model](../threat-model.md), T8). Das gilt auch für Tools aus Plugins (ADR 0071).
- **Bestätigung (T8):** Claude Code zeigt eine Rückfrage über Elicitation als Dialog, der Code-Tab von Claude Desktop ebenso. Der Chat von Claude Desktop deklariert keine Elicitation. `claude -p` deklariert sie und bricht eine Rückfrage ohne Hook ab, und ein Hook nimmt sie ohne Dialog an. Der Server sieht in keinem Feld einen Unterschied zu einer Antwort mit Dialog (Läufe vom 11.10.2026, [`docs/research/mcp-sdk-und-elicitation.md`](../research/mcp-sdk-und-elicitation.md), Ergebnisse).
- **Keine Versionsbedingung (T9):** Die API nimmt beim Ändern einer Seite keine Bedingung an, die ein Überschreiben verhindert. Wer zuletzt schreibt, gewinnt (F11 in [`docs/research/churchtools-api.md`](../research/churchtools-api.md)). Die Version einer Seite steigt mit jeder Änderung des Texts um eins, ein `PATCH` mit demselben Text legt keine Version an (F10), und die API speichert den gesendeten Text genau (F17).
- **Zustand:** Zustand über eine Anfrage hinaus gibt es nur in benannten Ports mit eigenem ADR ([ADR 0051](0051-zustand-zwischen-anfragen.md)). Der `requestState` einer Rückfrage ist signiert, befristet und an Methode, Mandant und Prinzipal gebunden, über stdio mit einem Schlüssel je Prozess. Was höchstens einmal gelten darf, verbraucht der Kern selbst ([ADR 0053](0053-mcp-sdk-und-instanzmodell.md)). Der `QuotaStore` löscht die Dateien früherer Tage beim ersten Zählen eines neuen Tags (ADR 0063).
- **Audit:** Das Ergebnis eines Tools mit `sensitivity: special` geht nur hinaus, wenn seine Zeile ganz in der Audit-Datei steht (ADR 0028). Dass ein gescheitertes Audit das Schreiben sperrt, liess [ADR 0054](0054-secret-fehler-logger-audit.md) für ein späteres ADR offen. Das Feld `outcome` des Ereignisses kennt nur `ok`, `error` und `denied`, und neue Felder kommen nur als optionale dazu.
- **Herkunft:** Seit dem 19.10.2026 hält der Katalog fest, ob ein Tool aus dem Kern oder aus einem Plugin kommt, und ein Plugin unter dem Namen des Kerns verhindert den Start (ADR 0024, Umsetzung).

## Optionen

1. **Tools schreiben selbst** über einen Client mit schreibenden Methoden und rufen Bestätigung und Protokoll als Hilfsfunktionen auf. Jedes Tool könnte einen Schritt auslassen, und ein Plugin bestimmte selbst, wie sicher es schreibt.
2. **Planen und Festschreiben getrennt:** Das Tool plant, der Kern versiegelt den Plan, holt eine Bestätigung auf einem Weg, den Herkunft und Vorhaben zulassen, und schreibt mit einem Nachweis, den nur er erzeugt.
3. **Jeder Schreibvorgang über die Freigabe-Warteschlange:** am sichersten, aber jede Änderung wartet auf den Betreiber im Terminal, auch wenn die Person am Client selbst bestätigen könnte.

## Entscheid

Gewählt ist die zweite Option.

### Ablauf

- **Zustände:** `intent`, `rightsChecked`, `policyChecked`, `idempotencyChecked`, `planned`, `confirmed`, `snapshotted`, `applied`, `verified`, `audited`. Endzustände: `denied`, `skipped`, `queued`, `conflict`, `failed`, `rolledBack`.
- **Planen:** Ein Tool mit `capability: 'write'` bekommt in `execute` einen `WritePort` mit genau einer Methode, `plan`. Ein lesendes Tool bekommt keinen. `plan` prüft die Rechte beratend, die Richtlinie ([ADR 0032](0032-richtlinie-und-pruefcode.md)) und die Idempotenz und gibt einen versiegelten Plan mit Unterschied und Zusammenfassung zurück. Es schreibt nie. Ein Probelauf ist ein Plan ohne Bestätigung.
- **Bestätigen und Festschreiben** übernimmt der Kern in derselben Stufe `execute`. Menge und Reihenfolge der Stufen bleiben wie in ADR 0024. Das Ergebnis an das Modell baut der Kern aus Plan und Ausgang in einer festen Form, mit Zustand, Ziel, neuer Version und der Kennung für die Rücknahme. Das Tool formt es nicht.
- **Plan-Hash:** SHA-256 über eine feste Kodierung von Mandant, Akteur, Tool, Art des Vorhabens, Ziel, Basisversion und dem Hash des neuen Inhalts. Beim Festschreiben leitet der Kern den Plan aus dem aktuellen Stand neu ab. Weicht der Hash ab, endet der Vorgang in `conflict`.
- **Plan ohne Änderung:** Ändert ein Plan nichts, endet er schon beim Planen in `skipped`. ChurchTools legt für denselben Text keine Version an (F10), die Prüfung nach dem Schreiben meldete sonst einen Konflikt.

### Versiegelter Plan und Nachweis

- `SealedPlan` und `Proof` sind Klassen des Kerns mit privaten Feldern. Weil Plugins getrennt kompiliert werden, prüft der Kern sie zur Laufzeit, nicht nur über ihre Typen. Erzeugt werden sie nur im neuen Ort `writeGuard` (`packages/core/src/write/`), den eine Regel der Architektur hält. Festschreiben rufen nur die Pipeline und der Weg des Betreibers für `ecclium queue approve` und `ecclium undo`.
- Einen `Proof` gibt es nur aus drei Quellen: aus einer geprüften Bestätigung über eine Rückfrage oder das Echo, aus der Richtlinie im unbeaufsichtigten Lauf (ab Phase 6, nie für die vier Vorhaben des Pro-Moduls) und aus einer Freigabe des Betreibers. Den Kontext eines geprüften Betreibers erzeugt nur der Kern, in Phase 5 nur die lokale Kommandozeile. Eine Anmeldung für Betreiber mit eigenem Scope braucht ein eigenes ADR, bevor es sie gibt.
- Den Modus eines Aufrufs setzt nur die Wurzel der Komposition ([ADR 0055](0055-konfiguration-identitaet.md)). Eine Anfrage erreicht den Nachweis aus der Richtlinie deshalb nie.

### Bestätigung

- `ECCLIUM_WRITE_CONFIRMATION` hat drei Werte:
  - `echo-allowed`, voreingestellt über stdio: eine Rückfrage, wenn der Client Elicitation deklariert, sonst das Echo, wenn der Plan es zulässt, sonst die Freigabe-Warteschlange. Über HTTP gilt der Wert ab Phase 7 nur ausdrücklich gesetzt, mit einer Warnung beim Start.
  - `elicitation-or-queue`, voreingestellt über HTTP ab Phase 7: eine Rückfrage oder die Freigabe-Warteschlange, nie das Echo. `ct_write_confirm` ist dann nicht registriert.
  - `queue`: Jeder Schreibvorgang geht in die Freigabe-Warteschlange, auch bei einem Client mit Elicitation, und nur der Betreiber gibt frei.
- Ein Wunsch, den die Richtlinie nicht abdeckt (ADR 0032), und jede Operation nach `operationId` gehen immer in die Freigabe-Warteschlange, gleich welcher Wert gilt.
- **Rückfrage:** nur, wenn der Client Elicitation deklariert hat. Sie zeigt Zusammenfassung und Unterschied, die der Kern aus dem versiegelten Plan erzeugt. Eine angenommene Rückfrage gilt als Bestätigung, wie ein Freigabedialog des Clients. Ablehnen, Abbrechen, ein Fehler und der Ablauf der Frist schreiben nichts und legen nichts in die Freigabe-Warteschlange. Angenommenen Inhalt prüft der Server selbst gegen sein Schema, weil der Shim des SDK es nicht tut (ADR 0053).
- **`requestState`:** mit dem Codec des SDK, signiert mit HMAC, gültig 600 Sekunden, gebunden an Methode, Mandant und Prinzipal, mit einem Digest der Parameter, dem Plan-Hash und einer Nonce. Er trägt keine Geheimnisse und keine Personendaten. Den Plan selbst hält der `PlanStore`.
- **Echo:** `ct_write_confirm` im Bereich `base`, registriert nur mit `echo-allowed` und eingeschaltetem Schreiben. Es verlangt das Token und die Zusammenfassung, die der Server erzeugt hat, damit die Person beides im Freigabedialog des Clients sieht. Es gilt nur für den Plan eines Tools mit der Herkunft `core`, mit `reversible: snapshot` nach der Ableitung des Kerns, ohne `special` und für keines der vier Vorhaben des Pro-Moduls. Jeden anderen Plan und eine abweichende Zusammenfassung lehnt es mit `confirmation_required` und dem Hinweis auf die Freigabe-Warteschlange ab. Das Token ist mit dem Schlüssel des Prozesses signiert, gilt 600 Sekunden und einmal (`replayGuard: nonce`). Beim Festschreiben prüft der Kern den Weg noch einmal gegen den neu abgeleiteten Plan, so dass auch ein ersetzter `PlanStore` daran nichts ändert. `ecclium audit show` weist die Bestätigungen per Echo als eigene Zahl aus.
- **Freigabe-Warteschlange:** Sie kommt ganz in Phase 5. Der Port `ApprovalQueue` in der Schnittstelle für Plugins hat Einreihen, Lesen, Freigeben und Ablehnen als eigene Operationen mit Prinzipal, damit später eine Oberfläche ausserhalb des Prozesses sie bedienen kann. Der freie Kern legt die Einträge im Zustandsordner ab, verschlüsselt mit Tagesschlüsseln, mit der Frist nach ADR 0031 (geplant). `ecclium queue list`, `show`, `approve` und `reject` melden auf Deutsch. `approve` leitet den Plan neu ab und schreibt ihn mit einem Nachweis des Betreibers sofort fest. Eine Freigabe nennt den Plan-Hash und gilt einmal und nur bis zum Ende der Frist. Beides prüft der Kern, nicht die Warteschlange. Eine Warteschlange aus einem Plugin speichert und zeigt Freigaben, erzeugt aber nie einen Nachweis. Ein Vier-Augen-Prinzip verlangt zusätzliche Freigaben und ersetzt keine.
- **Verbrauchte Freigaben (ergänzt ADR 0063):** Der Kern zählt jede Freigabe im `QuotaStore` unter einem Hash aus ihrer Kennung und dem Plan-Hash, am Tag, an dem der Plan in die Warteschlange kam. Diesen Tag hält der Kern im verschlüsselten Eintrag selbst fest. Eins heisst frisch, mehr heisst verbraucht. Gezählt wird für den Mandanten, nicht für die Person, die freigibt, damit eine zweite Identität dieselbe Freigabe nicht noch einmal einlöst. Weil der Store die Dateien früherer Tage löscht, liegen diese Zähler in einer eigenen Art Datei, nur mit Hashes und Zahlen und ohne Akteur, die bis zum Ende der Frist der Warteschlange und einen Tag darüber bleibt. Die Dateien des Lesebudgets behalten ihre Löschung. Einen vierten Port gibt es nicht.

### Schutz vor Wiederholung

- Den `replayGuard` eines Vorhabens leitet der Kern ab, nicht die Metadaten des Tools: `baseVersion` für das Ändern einer Seite und eines Termins, `marker` für das Anlegen einer Seite und das Anhängen eines Abschnitts (Kennzeichnung mit Prüfcode, ADR 0032), `nonce` für das Anlegen von Terminen und Buchungen und für die vier Vorhaben des Pro-Moduls. Für die Tools des Kerns hält ein Test fest, dass ihre Metadaten der Ableitung gleichen, damit die Referenz der Tools stimmt.
- `baseVersion`: Nach dem Festschreiben ist die Basisversion verbraucht, eine Wiederholung endet in `conflict`.
- `marker`: Vor dem Anlegen sucht der Kern eine eigene Seite oder einen eigenen Abschnitt mit derselben Kennzeichnung. Findet er sie, endet der Vorgang in `skipped`.
- `nonce`: Die Nonce steht im `requestState`, im Token des Echos oder im Eintrag der Warteschlange und gilt einmal.

### `PlanStore`

- **Was:** versiegelte Pläne zwischen Planen und Festschreiben, für die zweite Runde einer Rückfrage und für das Echo. Pläne tragen Inhalte und liegen deshalb nur im Arbeitsspeicher, nie in einer Datei. Pläne in der Freigabe-Warteschlange liegen nicht hier, sondern verschlüsselt in der Warteschlange.
- **Bindung und Frist:** Schlüssel aus Mandant, Prinzipal und Plan-Hash. Ein Plan lässt sich einmal entnehmen und gilt 600 Sekunden, so lange wie der `requestState`. Höchstens 100 offene Pläne je Prozess. Darüber endet ein neuer Plan mit `policy_denied`, bis ältere ablaufen.
- **Neustart:** Offene Pläne sind weg, und die Person plant neu. Das schliesst sicher.
- **Zwei Instanzen:** Über stdio hat jeder Prozess seinen eigenen Store und seinen eigenen Schlüssel, ein Plan des einen lässt sich im anderen nicht bestätigen. Für mehrere Instanzen über HTTP ersetzt ein Plugin den Port, und der Ersatz besteht dieselben Prüfungen in `testkit`.

### `NonceStore`

- **Was:** verbrauchte Nonces aus `requestState` und Token des Echos, nur Zufallswerte, im Arbeitsspeicher.
- **Bindung und Frist:** Schlüssel aus Mandant, Prinzipal und Nonce, Frist 660 Sekunden, die Laufzeit des Tokens und eine Minute für die Uhren. Höchstens 10'000 Einträge je Prozess. Darüber gilt jede neue Nonce als verbraucht.
- **Neustart:** Die Nonces sind weg. Das ist sicher, weil der Schlüssel für `requestState` und Token über stdio bei jedem Start zufällig neu entsteht, 32 Bytes, nie gespeichert (ADR 0053). Nach einem Neustart gilt kein altes Token.
- **Zwei Instanzen:** eigene Schlüssel, ein Token des einen gilt im anderen nicht. Woher der Schlüssel über HTTP kommt, wenn mehrere Prozesse die Runden einer Rückfrage bedienen, bleibt offen für Phase 7.
- Verbrauchte Freigaben liegen nicht hier, weil sie einen Neustart überstehen müssen.

### Fenster zwischen Lesen und Schreiben (T9)

- Unmittelbar vor dem Schreiben liest der Kern das Ziel neu und vergleicht Version und Hash des Texts mit der Basis des Plans. Weicht etwas ab, endet der Vorgang in `conflict`, ohne zu schreiben.
- Danach liest er wieder: Die Version muss genau eins über der Basis liegen und der Text genau der gesendete sein (F10, F17). Sonst endet der Vorgang in `conflict`, obwohl geschrieben ist. Der Kern nimmt dann nicht selbst zurück, weil eine Rücknahme die Änderung eines Menschen überschreiben könnte. Der Snapshot macht den Vorgang rücknehmbar, das Audit macht ihn sichtbar.
- Eine schreibende Anfrage wiederholt der Kern nie. Bleibt offen, ob sie geschrieben hat, etwa nach einem Fehler im Netz oder einer Antwort 5xx, 408 oder 429, liest er nach und entscheidet zwischen `verified`, `conflict` und `failed`. Lässt sich das nicht klären, endet der Vorgang in `failed`, mit dem Hinweis, das Ziel zu prüfen.
- Woran sich die Änderung eines Termins erkennen lässt, klären Schreibproben an der Testinstanz ([ADR 0049](0049-testumgebung.md)). Bis dahin gibt es kein Tool, das einen Termin ändert.

### Audit beim Schreiben (ergänzt ADR 0028)

- Ein Schreib-Tool läuft nur mit bereiter Audit-Datei, wie ein Tool mit `sensitivity: special`. Das `gate` prüft das vor dem Planen, der Kern noch einmal unmittelbar vor dem Festschreiben. Über stdio braucht Schreiben deshalb den Zustandsordner, und unter Windows gibt es über stdio keine Schreib-Tools.
- Jeder Aufruf ergibt weiter genau eine Zeile (ADR 0024). Auch jede Runde einer Rückfrage und jeder Befehl `queue approve` oder `undo` ist ein Aufruf. Der Schreibvorgang selbst steht in genau einer Zeile, der des Aufrufs oder Befehls, der festschreibt, mit dem Weg in `confirmation` und den Kennungen des Ziels in `objectRefs`.
- `outcome` behält seine drei Werte, weil sich das Format nur mit neuen optionalen Feldern rückwärtsverträglich erweitern lässt. Neu ist das optionale Feld `writeState` mit dem Zustand am Ende des Aufrufs: `planned`, `queued`, `verified`, `skipped`, `denied`, `conflict`, `failed` oder `rolledBack`. Bei `planned`, `queued`, `verified` und `skipped` ist `outcome` `ok`, bei `denied` ebenfalls `denied`, sonst `error`, je mit dem Fehlercode, etwa `conflict`. Lehnt eine Person eine Rückfrage ab, steht `denied` mit `confirmation_required`.
- Nach jedem Schreibvorgang steht ein Kettenanker auf dem Log, wie ADR 0028 es vorsieht.
- Scheitert die Zeile, nachdem ChurchTools geschrieben hat, bleibt die Änderung bestehen. Das Ergebnis geht trotzdem an das Modell, weil es den Vorgang sonst wiederholen könnte. Der Prozess schreibt danach bis zu seinem Neustart nicht mehr: Jeder weitere Plan endet mit `policy_denied`, und eine Logzeile nennt den Grund. Erwogen war eine Zeile vor dem Schreiben. Sie hätte die Lücke geschlossen, aber jedem Schreibvorgang zwei Ereignisse gegeben.

### Vertrag für Schreib-Tools aus Plugins

- Ein Plugin plant nur Vorhaben, die der Kern kennt und selbst ausführt: die Vorhaben des Kerns (Seite anlegen, Seite ändern, Abschnitt anhängen, Termin anlegen, Termin ändern, Buchung anfragen) und die vier Vorhaben des Pro-Moduls. Ihre Typen stehen in der Schnittstelle für Plugins. Die `ReadApi` bekommt die Lesezugriffe, die ein Plan braucht.
- Ziel, Geltungsbereich, nötige Rechte, Rücknehmbarkeit und `replayGuard` leitet der Kern aus dem Vorhaben ab, gleich was das Tool angibt. Bei der Sensitivität (`none`, `personal`, `special`, in steigender Strenge) und bei der Regel für unbeaufsichtigte Läufe (`policy`, dann `never`) gilt die strengere Angabe aus Ableitung und Metadaten.
- Unterschied und Zusammenfassung für Rückfrage, Echo und Freigabe-Warteschlange erzeugt der Kern aus dem versiegelten Plan. Bestätigung, Nachweis und Festschreiben bleiben im Kern.
- Die Herkunft eines Tools legt die Wurzel der Komposition fest: Sie übergibt das Plugin des Kerns getrennt von der Liste der Plugins, Name, Version und Reihenfolge eines Plugins bestimmen die Herkunft nie, und ein Plugin unter dem Namen des Kerns verhindert den Start (ADR 0024, Umsetzung). Kein Schreib-Tool aus einem Plugin lässt sich per Echo bestätigen.
- Sonst gelten dieselben Regeln wie für die Tools des Kerns: Metadaten-Pflicht, `ECCLIUM_READ_ONLY`, Kill-Switches, Richtlinie, Obergrenzen, Lesebudget, ContentPolicy und Audit. Ein Plugin kann sie nur verschärfen, nie lockern.
- Vorhaben mit `special` oder `reversible: no` und Operationen nach `operationId` plant ein Plugin nur, wenn der Betreiber es dafür ausdrücklich zulässt (ADR 0041, geplant). Bis es diese Zulassung gibt, endet ein solcher Plan mit `policy_denied`.

### Vorhaben des Pro-Moduls

- «Mitglied einer Gruppe hinzufügen», «Mitglied aus einer Gruppe entfernen», «Dienstanfrage an eine Person» und «Operation nach `operationId`» haben die Regeln aus ADR 0071: immer `special`, nie unbeaufsichtigt, nie per Echo, mit `nonce`.
- Gruppenmitgliedschaften brauchen den Schalter `ECCLIUM_WRITE_GROUP_MEMBERSHIPS`, voreingestellt `false`. Ohne ihn endet der Plan mit `policy_denied`.
- Eine Operation nach `operationId` gilt als nicht rücknehmbar und geht immer in die Freigabe-Warteschlange. Die Einstufung jeder schreibenden Operation, die zwei Schalter, die Liste erlaubter Operationen und der Ausschluss von `DELETE` entstehen vor dem Tool, mit eigenem ADR ([ADR 0067](0067-generischer-lesezugriff.md), ADR 0071).
- In Phase 5 baut der Kern Typen und Regeln und prüft sie mit einem Plugin aus `testkit`. Die Ausführung gegen ChurchTools kommt frühestens in Phase 9. Bis dahin endet jedes dieser Vorhaben mit `policy_denied`.

### Lizenz und Reihenfolge im `gate`

- Das `gate` prüft für jedes Tool in dieser Reihenfolge: die Regel für unbeaufsichtigte Läufe, die Lizenz und die Bereitschaft der Audit-Datei. Danach folgt die Prüfung der Eingabe. Ein Schreib-Tool der Stufe `pro` ohne Lizenz endet damit mit `license_required`, bevor es plant. So steht es in ADR 0071 als Aufgabe dieses ADR.
- Die Ablehnung jedes Schreibens im `gate` fällt mit dem Write-Guard weg. Bis die Bestätigung gebaut ist, endet ein Schreibversuch mit `confirmation_required`.
- Die Vorhaben selbst hängen an keiner Lizenz (ADR 0071).

### Kill-Switches, Uhr, Voraussetzungen

- **Kill-Switches** sind Dateien in dem Ordner, den `ECCLIUM_KILL_SWITCH_DIR` nennt, über stdio voreingestellt `<ECCLIUM_STATE_DIR>/stop`, im Container ein Ordner unter `/config`, der nur lesbar eingebunden ist. `writes-off` sperrt jedes Schreiben, `writes-off-<Mandant>` das eines Mandanten, ab Phase 6 `writes-off-routine-<Routine>` das einer Routine. Es zählt nur, dass die Datei da ist. Der Kern schaut vor jedem Planen und unmittelbar vor jedem Festschreiben nach, ein Neustart ist nicht nötig. Lässt sich der Ordner nicht prüfen, ist das Schreiben ebenfalls gesperrt. Ein gesperrter Vorgang endet mit `policy_denied`.
- **Uhr:** Weicht die Uhr des Systems mehr als fünf Minuten vom `Date`-Header der Lesung unmittelbar vor dem Schreiben ab (F22), schreibt der Kern nicht und meldet es. Tagesschlüssel, Zähler und Kennzeichnung hängen am Datum.
- **Nur lesen:** Mit `ECCLIUM_READ_ONLY=true` kommen Schreib-Tools nicht in den Katalog (ADR 0024), und `plan` lehnt jedes Vorhaben ab, falls doch eines ankommt.
- **Voraussetzungen:** Schreiben verlangt `ECCLIUM_READ_ONLY=false`, den Zustandsordner, den Ordner der Tagesschlüssel `ECCLIUM_KEYS_DIR` (ADR 0031, geplant) und für das Wiki den Schlüssel des Prüfcodes und die Ansprechperson der Kennzeichnung (ADR 0032). Fehlt etwas, bricht der Start mit 78 ab. Jeder Start mit Schreiben warnt.
- **Rechte:** Der Kern prüft vor dem Planen beratend mit `GET /api/whoami` und `GET /api/permissions/global` ([ADR 0057](0057-lesender-churchtools-client.md)). Fehlt ein Recht, endet der Vorgang mit `permission` und den fehlenden Rechten. Kennt der Client die Struktur der Rechte nicht, sperrt das das Schreiben, nie das Lesen. Durchsetzen tut ChurchTools.

### Rücknahme

- Alle sechs Schreib-Tools des Kerns lassen sich zurücknehmen und tragen `reversible: snapshot`. Vor dem Ändern und Anhängen sichert der Kern den vorigen Stand des betroffenen Felds (ADR 0031, geplant).
- **Neuanlagen:** Eine neue Seite löscht `ecclium undo` nie, weil Ecclium in Version 1 keine Seite löscht. Es ersetzt ihren Text durch einen festen Hinweis, dass Ecclium sie angelegt und zurückgenommen hat. Einen Termin oder eine Buchung, die Ecclium angelegt hat, löscht `undo`, wenn sie seither niemand geändert hat. Nur dafür bekommt der ausgehende Weg `DELETE` (ADR 0072, geplant).
- `ecclium undo` nimmt bis Phase 6 die Kennung des Ereignisses eines Schreibvorgangs aus dem Audit und läuft mit einem Nachweis des Betreibers durch den Write-Guard. Hat jemand das Ziel seither geändert, zeigt es den Unterschied und verlangt eine ausdrückliche Entscheidung.
- Sind Snapshots abgeschaltet, lässt sich kein Schreibvorgang zurücknehmen, und das Echo lehnt jeden Plan ab.

## Konsequenzen

- Kein Tool und kein Plugin schreibt an der Pipeline vorbei, und kein Nachweis entsteht ausserhalb des Kerns. Write-Guard und Regeln der Vorhaben brauchen volle Abdeckung im Job `coverage-security-core`, auch die Vorhaben des Pro-Moduls, die bis Phase 9 kein Tool ausführt.
- Neue Variablen sind `ECCLIUM_WRITE_CONFIRMATION`, `ECCLIUM_KILL_SWITCH_DIR` und `ECCLIUM_WRITE_GROUP_MEMBERSHIPS`, dazu `ECCLIUM_KEYS_DIR` aus ADR 0031. Sie kommen mit ihrem Bau in die Tabelle von ADR 0055.
- Der Ort `writeGuard` bekommt Regeln der Architektur, je mit einer Beispieldatei, die rot wird.
- Ein Schreibvorgang über eine Rückfrage ergibt zwei Zeilen im Audit, eine je Runde, einer über die Freigabe-Warteschlange zwei, eine beim Einreihen und eine beim Freigeben. Wer Schreibvorgänge zählt, liest `writeState`.
- Über stdio können zwei Clients mit demselben Zustandsordner Pläne nur im eigenen Prozess bestätigen, teilen aber Obergrenzen, Lesebudget und verbrauchte Freigaben.
- Dieses ADR gilt in Phase 5 nur über stdio. Über HTTP bleiben für Phase 7 offen, wie ältere Clients ohne Sitzung bestätigen und woher der Schlüssel des `requestState` bei mehreren Prozessen kommt (ADR 0053).
- **Restrisiken:**
  - **Rückfrage ohne Mensch (T8):** Ein Hook im Client kann eine Rückfrage annehmen, ohne dass jemand sie sieht, und der Server erkennt das nicht. Das Audit nennt den Weg. Wer sicher sein will, dass ein Mensch freigibt, setzt `ECCLIUM_WRITE_CONFIRMATION=queue`. `docs/security.md` wird das nennen.
  - **Echo (T8):** Es macht den Willen eines Menschen sichtbar, beweist ihn aber nicht, und «immer erlauben» im Client macht es wirkungslos. Deshalb gilt es nur für rücknehmbare Pläne von Tools des Kerns.
  - **Fenster (T9):** Speichert ein Mensch zwischen dem Lesen unmittelbar davor und dem Schreiben, überschreibt Ecclium seine Änderung. Die Prüfung danach meldet das als `conflict`, und der Snapshot nimmt den Vorgang zurück.
  - **Audit nach dem Schreiben:** Scheitert die Zeile nach dem Schreiben, fehlt der Vorgang in der Audit-Datei. Als Spur bleiben die Logzeile, der Anker und die Versionen in ChurchTools.
  - **Zähler der Freigaben:** Wer den Zustandsordner löscht oder ändert, kann eine Freigabe noch einmal einlösen, solange ihr Eintrag in der Warteschlange liegt. Wie beim Lesebudget schützt der Store vor dem Modell, nicht vor dem Betreiber.
