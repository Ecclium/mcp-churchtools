# ADR 0063: Der `QuotaStore` als Datei und das Lesebudget

- Status: Vorgeschlagen
- Datum: 24.10.2026
- Fällt vor: Phase 2

## Kontext

Tools mit `sensitivity: special` geben Daten weiter, die auf die Religionszugehörigkeit schliessen lassen. Ihre Obergrenzen pro Aufruf verhindern einen Export in einem Aufruf, nicht einen in zweihundert. Deshalb bekommen sie ein Lesebudget pro Prinzipal und Tag. Der Prinzipal ist bei Ecclium der Akteur eines Aufrufs, über stdio abgeleitet aus `ECCLIUM_STDIO_SUBJECT` (ADR 0055). Die Voreinstellung von 200 Aufrufen ist entschieden, einstellbar wird das Budget mit der Richtlinie (Grundsatzentscheide, Nummer 11, ADR 0032). Für Phase 2 ist ein gemeinsames Budget für alle diese Tools entschieden, je Akteur und UTC-Tag, fest. Mit einem Budget je Tool liesse sich ein Export auf mehrere Tools verteilen.

Ein Zähler über eine Anfrage hinaus ist Zustand. ADR 0051 erlaubt ihn nur in einem benannten Port mit eigenem ADR, der jeden Eintrag an Mandant und Akteur bindet. Der Port für Kontingente heisst `QuotaStore`. Ein Zähler im Arbeitsspeicher fiele bei jedem Neustart auf null. Über stdio startet ein Client den Server oft neu: Am 23.10.2026 entstanden in knapp 40 Minuten 37 Audit-Dateien, eine je Start. Mehrere Prozesse laufen dabei auch gleichzeitig. Ein Budget je Prozess wäre damit keines.

Für die Audit-Datei gibt es schon einen Ordner unter `ECCLIUM_STATE_DIR`, der dem Benutzer gehört und für andere gesperrt ist, und Prüfungen am offenen Deskriptor gegen Links und Vertauschungen (ADR 0028). Ohne diesen Ordner laufen Tools mit `sensitivity: special` über stdio nicht.

## Optionen

1. **Zähler im Arbeitsspeicher:** einfach, aber ein Neustart setzt das Budget zurück, und jeder Prozess hat sein eigenes.
2. **Eine Datei je Prozess, die nur wächst:** Jeder Aufruf hängt eine Zeile an die Datei seines Prozesses, und der Zähler ist die Summe über alle Dateien des Tages. Das braucht keine Sperre. Bei einem Neustart je Minute entstehen aber Dutzende Dateien am Tag, jeder Aufruf liest sie alle, und das Aufräumen muss sie alle kennen.
3. **Eine Datei je Mandant und Tag mit Sperre und atomarem Schreiben:** eine kleine Datei mit Zählern, eine Sperrdatei je Änderung und Schreiben über eine temporäre Datei. Mehr Code für Sperre und Fehlerfälle, dafür liest und schreibt ein Aufruf eine Datei.
4. **SQLite über `node:sqlite`:** Sperren und Transaktionen gäbe es fertig. Dazu kämen eine Datenbank mit eigenen Nebendateien, ein Verhalten auf Netzlaufwerken, das eigens zu prüfen wäre, und ein Modul von Node.js, das das Projekt sonst nicht nutzt.

## Entscheid

Gewählt ist die dritte Option.

- **Port:** `QuotaStore` in der Schnittstelle für Plugins mit `increment(ctx, key, day)` und `read(ctx, key, day)`. Ein Zähler gehört zu Mandant und Akteur aus dem Kontext, einem Schlüssel und einem Tag in UTC. Der einzige Schlüssel ist heute `special_reads`. `isIsoDate` prüft einen Tag. Ein Store nimmt Mandant und Akteur nur aus dem Kontext, nie aus einer Angabe eines Tools.
- **Datei:** `<ECCLIUM_STATE_DIR>/quota/<Mandant>-<JJJJ-MM-TT>.json`, der Ordner mit 0700, die Datei mit 0600. Darin stehen je Akteur und Schlüssel eine Zahl, die Version, der Mandant und der Tag, sonst nichts. Eine Datei über 64 KiB, mit mehr als 1000 Akteuren oder in einer anderen Form gilt als defekt.
- **Sperre und Schreiben:** Jede Änderung läuft unter einer Sperrdatei, die mit `O_EXCL` entsteht und die ID des Prozesses, den Namen des Hosts, die Zeit und eine Zufallszahl enthält. Der Store liest die Datei, ändert den Zähler und schreibt eine neue Datei unter einem eigenen Namen, mit `fsync`, und benennt sie dann um. Ein Leser sieht damit immer eine ganze Datei und braucht keine Sperre. Wer die Sperre nicht in 2 Sekunden bekommt, bekommt einen Fehler, und jeder weitere Versuch prüft diese Frist, damit eine Sperre, die sich nicht räumen lässt, den Prozess nie anhält. Eine Sperre, die älter als 10 Sekunden ist, gilt als zurückgelassen: Der Store benennt sie unter einem eigenen Namen um und entfernt sie. War das, was er umbenannt hat, nicht die alte Sperre, gemessen an Gerät, Inode und Alter, legt er es mit einem Link zurück, damit eine Sperre, die ein dritter Prozess inzwischen gesetzt hat, stehen bleibt. Seine eigene Sperre entfernt der Store nach der Änderung nur, solange sie noch seine ist, gemessen an Gerät, Inode und Inhalt. Der Inhalt zählt mit, weil Linux einer neuen Datei oft die Inode einer eben entfernten gibt, und die Zufallszahl macht den Inhalt jeder Sperre einmalig. Die Änderungen eines Prozesses laufen nacheinander. Die Sperre nennt den Host, damit eine Person eine zurückgelassene Sperre einem Rechner zuordnen kann, wenn mehrere Rechner denselben Ordner nutzen.
- **Prüfungen:** Jede Datei öffnet der Store, ohne einem Link zu folgen, und ohne auf einen Schreiber zu warten, falls an ihrer Stelle ein FIFO liegt. Am Deskriptor prüft er Art, Eigentümer, Rechte und Zahl der Links. Wie bei der Audit-Datei vergleicht er nach jedem Öffnen den Deskriptor mit dem Pfad und den Ordner mit dem, den er vor der Änderung geprüft hat. Mandant, Akteur, Schlüssel und Tag prüft er selbst gegen ihre Muster, bevor ein Dateiname entsteht.
- **Aufräumen:** Beim ersten Zählen an einem neuen Tag entfernt der Store die Dateien desselben Mandanten mit früherem Datum im Namen, dazu ihre Sperren, beiseitegelegte Sperren und temporäre Dateien, die ein Prozess zurückgelassen hat, nur Namen genau dieser Formen.
- **Lesebudget:** Die Pipeline zählt jeden Aufruf eines Tools mit `sensitivity: special` einmal, nachdem die Eingabe geprüft ist und bevor ChurchTools gefragt wird. Ein Aufruf, der vorher scheitert, an der Eingabe, an der Audit-Datei oder an der Lizenz, zählt nicht. Über 200 Aufrufen endet ein Aufruf mit `policy_denied` und einem festen Satz, der den Tageswechsel um 00:00 UTC nennt, bis zum Ende des Tages. Ein Aufruf über dem Budget zählt mit, das ändert nichts.
- **Im Audit:** Das Audit verzeichnet einen solchen Aufruf mit `denied` und `policy_denied`, wie jede andere Ablehnung. Den Grund nennt die Logzeile `read_budget_exhausted` mit derselben ID des Ereignisses. Das Format des Audits bleibt unverändert.
- **Fehler des Stores:** Fehlt der Store, wirft er, antwortet er nicht in 5 Sekunden oder gibt er keine ganze Zahl ab 1, endet der Aufruf mit `policy_denied`, einem eigenen festen Satz und der Logzeile `read_budget_unavailable`. Das trifft nur Tools mit `sensitivity: special`, nie `ct_whoami` und kein anderes Tool.
- **Start über stdio:** Die erste Stufe legt den Ordner `quota` an und prüft ihn, gleich nach der Audit-Datei und noch bevor fd 2 nicht mehr blockiert. Scheitert das, endet der Start mit 78 und einer Meldung. Die zweite Stufe baut den Store. `ecclium config check` prüft einen vorhandenen Ordner `quota` wie den Ordner `audit`.
- **Tools mit `personal`, die Namen anderer Personen ausgeben:** Für sie gilt das Lesebudget ebenfalls, wie für Phase 2 entschieden. Das ADR zu Rechten und Feldern der Lese-Tools legt fest, welche Tools das sind, und erweitert die Bedingung in der Pipeline. Bis dahin gibt es keines.
- **Konformität:** Prüfungen in testkit, die jeder Store besteht, auch ein späterer Ersatz aus einem Plugin.

## Konsequenzen

- Ein Neustart behält das Budget, und alle Prozesse mit demselben Zustandsordner teilen es.
- Das Budget schützt vor einem Export durch das Modell, etwa nach einer Injection, nicht vor dem Betreiber. Wer die Datei löscht, ein anderes Subjekt in `ECCLIUM_STDIO_SUBJECT` setzt, einen anderen Zustandsordner nimmt oder die Uhr verstellt, bekommt ein neues Budget.
- Der Tag ist der UTC-Tag. In der Schweiz beginnt ein neues Budget um 01:00 oder 02:00 Ortszeit.
- Jede Zählung kostet eine Sperrdatei, ein Lesen, ein Schreiben mit `fsync` und eine Umbenennung, nur für Tools mit `sensitivity: special`. Der Store ruft das Dateisystem synchron auf. Die Frist von 5 Sekunden greift deshalb nur, solange der Store auf eine Sperre wartet. Ein Netzlaufwerk, das nicht antwortet, hält wie bei der Audit-Datei den ganzen Server an, und die Doku rät davon ab.
- **Restrisiken:**
  - **Zwei Prozesse und eine zurückgelassene Sperre:** Erkennen zwei Prozesse gleichzeitig dieselbe zurückgelassene Sperre, kann der zweite in einem seltenen Fall die frische Sperre des ersten beiseitelegen. Setzt ein dritter Prozess in diesem Moment eine eigene, bleibt sie stehen, und der erste zählt ohne Sperre weiter. Dann können zwei Zählungen gleichzeitig laufen und eine verloren gehen. Eine verlorene Zählung schenkt einen Aufruf, mehr nicht.
  - **Host in der Sperre:** Der Name des Rechners enthält oft einen Personennamen. Die Sperrdatei lebt nur für eine Zählung, eine zurückgelassene bleibt aber bis zum nächsten Zählen oder bis zum nächsten Tag liegen. `docs/privacy.md` nennt das.
  - **Ohne `openat`:** Wie bei der Audit-Datei kann Node.js eine Vertauschung zwischen Prüfung und Öffnen nicht ganz ausschliessen (ADR 0028).

## Umsetzung

Seit dem 24.10.2026 gebaut:

- **Port:** `packages/plugin-api/src/quota.ts` mit `QuotaStore`, `QuotaKey`, `quotaKeys`, `IsoDate` und `isIsoDate`.
- **Store:** `packages/core/src/quota/file-store.ts` mit `createFileQuotaStore` und `prepareQuotaFolder`, das Budget, die Frist von 5 Sekunden und der Tag in `budget.ts`. Beides erreicht nur die Wurzel der Komposition über `./composition`. Der Name des Ordners steht neben dem des Ordners `audit` in `packages/core/src/config/state-dir.ts`, das ihn für `ecclium config check` prüft.
- **Pipeline:** das Zählen nach `validateInput` in `packages/core/src/pipeline/pipeline.ts`, die Tests in `pipeline-budget.test.ts`.
- **Start:** der Ordner in der ersten Stufe in `packages/cli/src/stdio/index.ts`, der Store in `serve.ts`, die Meldungen in `packages/cli/src/messages/config.ts` und `start.ts`.
- **Tests:** die Prüfungen jedes Stores und ein Store im Arbeitsspeicher in `packages/testkit/src/quota/`, der Datei-Store gegen echte Ordner in `file-store.test.ts`, zwei Prozesse in `tests/quota-processes.test.mts` und das Budget über einen Neustart am echten Prozess in `tests/stdio-start.test.mts`.
