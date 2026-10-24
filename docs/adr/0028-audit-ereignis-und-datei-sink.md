# ADR 0028: Audit-Ereignis v1 und Datei-Sink im freien Kern

- Status: Vorgeschlagen
- Datum: 23.10.2026
- Fällt vor: Phase 4

## Kontext

Die Suchtools `ct_persons_search` und `ct_groups_search` lesen Personen und Gruppen einer Gemeinde. Aus solchen Daten lässt sich auf die Religionszugehörigkeit schliessen, eine besondere Kategorie nach Art. 9 DSGVO und besonders schützenswert nach Art. 5 Bst. c DSG. Die Tools tragen deshalb `sensitivity: special`. Bevor es sie gibt, ist zu entscheiden, wo ihr Audit im Betrieb über stdio festgehalten wird und ob ein Ergebnis ohne Audit-Zeile hinausgehen darf (Threat Model, W6).

Bisher schreibt das Audit im Betrieb über stdio über den Zeilenschreiber des Loggers nach stderr (ADR 0053, ADR 0054). Sobald das MCP-SDK und undici geladen sind, ist fd 2 nicht blockierend. Ein Client, der stderr nicht leert, kostet dann Zeilen, gezählt und beim Ende mit `stdio_closed` gemeldet. `record` gab bisher nichts zurück, und die Umsetzung von ADR 0024 hielt fest, dass ein Fehler des Audits das Ergebnis eines lesenden Aufrufs nicht ändert.

Gemessen am 19. und 22.10.2026 unter macOS 27 auf arm64 und unter Linux mit Kernel 7.2 in einem Container auf arm64, je mit Node.js 24.21.0 und 26.10.0:

- Ein Client auf Node.js, der den Server mit `stdio: 'pipe'` startet, gibt ihm als stderr einen UNIX-Socket. Ohne Leser nimmt er unter macOS rund 131 KB auf, unter Linux je nach Grösse der Zeilen rund 33 bis 220 KB. Eine Pipe nimmt höchstens 64 KiB auf, ein FIFO unter macOS 8 KiB.
- Der echte Server mit einem Client, der stderr nie liest: Alle Antworten kamen an, im Audit fehlten Zeilen nach etwa 161 Aufrufen unter macOS und 114 unter Linux. Die meisten dieser schnellen Aufrufe liefen in die eigene Drosselung.
- `process.stderr._handle.setBlocking(true)` macht fd 2 unter macOS und Linux wieder blockierend, ist aber nicht dokumentiert. Bei vollem Puffer steht dann der ganze Prozess, auch Timer und das Ende nach SIGTERM, bis der Client liest. Einen dokumentierten Weg gab es nur unter Linux und nur für eine Pipe: `/proc/self/fd/2` neu geöffnet blockiert. Für einen Socket ergibt das ENXIO, und unter macOS teilt `/dev/fd/2` den nicht blockierenden Zustand.
- Eine Datei als Ziel verlor nie eine Zeile und hielt den Server nie an.

Die MCP-Spezifikation erlaubt dem Client, stderr aufzufangen, weiterzugeben oder zu verwerfen. Claude Code liest stderr laufend, Claude Desktop schreibt es laut seiner Dokumentation in eine Logdatei je Server, und die Clients der SDKs für TypeScript und Python geben es in der Voreinstellung an das stderr des Hosts weiter. Über stderr ist eine Zeile also höchstens vom Kernel oder vom Client angenommen. Verwirft der Client sie, stürzt er ab oder wird er beendet, ist sie weg und gilt trotzdem als geschrieben.

Über stdio ist der Client ein lokaler Prozess derselben Person, die das Token hält. Das Audit ist dort eine Aufzeichnung für den Betreiber, keine Kontrolle gegen den Client.

Art. 4 der Datenschutzverordnung der Schweiz verlangt bei automatisierter Bearbeitung besonders schützenswerter Personendaten in grossem Umfang ein Protokoll, wenn vorbeugende Massnahmen nicht genügen: mindestens über Speichern, Ändern, Lesen, Bekanntgeben und Löschen, mindestens ein Jahr lang, getrennt vom System und mit beschränktem Zugriff. Ob eine Gemeinde darunter fällt und welches Recht für sie gilt, ist nicht geklärt. Diese Angaben sind keine Rechtsberatung.

`ECCLIUM_STATE_DIR` ist in ADR 0055 als Name für einen späteren Ordner mit Zustand reserviert. Das Lesebudget in Phase 2 braucht einen solchen Ordner für die Zähler.

## Optionen

1. **Wie bisher, nur Doku:** Ein Client, der stderr nicht leert, verliert Audit-Zeilen still, während Ergebnisse der Suchtools weiter hinausgehen. Keine Garantie.
2. **stderr mit Sperre je Aufruf:** `record` meldet, ob die Zeile ganz an stderr ging, sonst hält die Pipeline das Ergebnis zurück. Die Garantie bleibt «angenommen», ein Client, der stderr verwirft, bekommt trotzdem Daten, und ein Client, der nie liest, nach vollem Puffer nur noch Ablehnungen.
3. **fd 2 blockierend:** Kein Verlust, aber eine nicht dokumentierte Schnittstelle, und ein Client, der stderr nicht leert, hält den ganzen Server an, auch die Antworten auf stdout.
4. **Eigene Audit-Datei mit Sperre:** Der Server hält das Audit selbst fest, unabhängig vom Client. Kosten: eine Variable, ein Ordner, Prüfungen der Rechte und später Aufbewahrung, Kette und Löschung.

## Entscheid

Gewählt ist die vierte Option. Sie entsteht in Phase 1 in einer ersten Form für den Betrieb über stdio, Phase 4 baut den Datei-Sink darauf aus.

### Ordner und Datei

- **Variable:** `ECCLIUM_STATE_DIR` nennt den Ordner für Zustand des Servers, vorerst nur im Betrieb über stdio (ADR 0055). Der Wert ist ein absoluter, normalisierter Pfad mit höchstens 960 Zeichen und 960 Bytes in UTF-8, damit der Pfad einer Audit-Datei darin unter der Grenze von 1'024 Bytes für Pfade unter macOS bleibt: kein Trenner am Ende, kein `.`, kein `..`, kein `//`. Mit einem Trenner am Ende folgt `lstat` einem Link. Lader und `ecclium config check` prüfen ohne zu schreiben, dass der Ordner kein Link ist, ein Ordner ist, dem aufrufenden Benutzer gehört und Gruppe und anderen keine Rechte gibt. Einen vorhandenen Unterordner `audit` prüfen sie ebenso. Fehlt die Variable, gibt es keine Audit-Datei, und das Audit geht wie bisher nur nach stderr.
- **Ordner `audit`:** Der Start legt `<ECCLIUM_STATE_DIR>/audit` mit 0700 an, ohne `recursive`, weil das rekursive Anlegen auf einem Link zu einem Ordner still gelingt. Ist er schon da, prüft der Start ihn wie der Lader.
- **Datei:** eine je Prozess und UTC-Tag, mit dem Namen `audit-<JJJJ-MM-TT>-<hhmmss>-<pid>-<n>.jsonl`, Datum und Uhrzeit des Öffnens in UTC, die Kennung des Prozesses und eine Folgenummer, die nur aufwärts zählt. Geöffnet wird sie mit `O_WRONLY`, `O_APPEND`, `O_CREAT`, `O_EXCL`, `O_NOFOLLOW` und `O_NOCTTY` und dem Modus 0600, also nie eine Datei, die schon da ist, und nie über einen Link. Danach prüft der Server am Deskriptor, dass es eine gewöhnliche Datei mit genau einem Link ist, die ihm gehört und anderen keine Rechte gibt, dass der Pfad auf dieselbe Kombination aus Gerät und Inode zeigt und dass der Ordner `audit` noch derselbe ist. Ein Deskriptor unter 3 wird geschlossen und abgewiesen, weil eine Zeile sonst auf stdin, stdout oder stderr ginge. Kein Fehler und keine Meldung nennt einen Pfad.
- **Schreiben:** jede Zeile mit einem `writeSync` an das Ende der Datei, ein Teilschreibvorgang am Versatz fortgesetzt, höchstens vier Aufrufe je Zeile. Die Datei nimmt nur Zeilen aus druckbarem ASCII wie der Zeilenschreiber für stderr. Ein abgerissenes Stück schliesst der Server in derselben Datei mit `~` und einem Zeilenumbruch ab. Mit einem Zeilenumbruch allein könnte aus einem Stück, dem nur der Zeilenumbruch fehlt, eine gültige Zeile werden. Gelingt das nicht, trägt die nächste Zeile den Abschluss, und vor dem Schliessen einer Datei versucht der Server ihn noch einmal. Leser zählen nur Zeilen, die mit einem Zeilenumbruch enden und nicht mit `~`, denn nach EFBIG oder EBADF kann ein Stück ohne Abschluss am Ende einer Datei bleiben.
- **Neu öffnen:** Hat die Datei keinen Link mehr, weil jemand sie gelöscht hat, oder meldet das Schreiben EBADF, ESTALE oder EFBIG, öffnet der Server eine neue Datei mit allen Prüfungen, höchstens einmal je Zeile und mit höchstens 64 Versuchen je Prozess. Danach bleibt er ohne neue Datei, bis er neu startet, und Tools mit `sensitivity: special` laufen nicht. Einen Deskriptor, den `fstat` nicht mehr als die geöffnete Datei zeigt, schliesst er nie, denn er kann schon jemand anderem gehören. Bei ENOSPC, EDQUOT und EIO bleibt die Datei offen, und die Zeile ist verloren. Ein Stück einer Zeile bleibt am Ende der alten Datei stehen. Zeigt die Uhr nach dem Datum der offenen Datei einen neuen UTC-Tag, beginnt der Server eine neue Datei, nie rückwärts. Gelingt das nicht, schreibt er in der alten weiter und versucht diesen Tag nicht noch einmal. Ein Wechsel des Tages zählt nicht zu den 64 Versuchen, damit ein langer Lauf eine Datei je Tag behält.
- **Kein `fsync`:** Eine geschriebene Zeile übersteht einen Absturz von Server oder Client, aber keinen Stromausfall und keinen Absturz des Betriebssystems. Was `fsync` je Zeile kostet, ist nicht gemessen.
- **Ende:** Nach dem Schliessen des Transports schreibt der Server `audit_file_closed` mit der Zahl der verlorenen Zeilen, dann schliesst er die Datei, dann folgt `stdio_closed` wie bisher als letzte Zeile. Spätere Zeilen gelten als verloren und öffnen keine Datei mehr.
- **Windows:** Ohne `getuid`, `O_NOFOLLOW`, `O_DIRECTORY` oder `O_NOCTTY` lassen sich Eigentümer und Links nicht prüfen. Dort gibt es über stdio weder die Audit-Datei noch Tools mit `sensitivity: special`, und ein gesetztes `ECCLIUM_STATE_DIR` bricht den Start mit einer eigenen Meldung ab.

### Audit, Sperre und Start

- **Reihenfolge:** Mit der Datei geht jede Audit-Zeile zuerst in die Datei und erst danach als Kopie über den Zeilenschreiber nach stderr. Das Log bleibt nur auf stderr. Die Entscheide von ADR 0053 und ADR 0024, dass das Audit über stdio nach stderr geht, bleiben damit wahr.
- **Ergebnis von `record`:** `true` genau dann, wenn die Zeile ganz in der Datei steht und die Senke nichts melden musste (ADR 0054). Ein Verlust der Kopie auf stderr ändert das Ergebnis nicht.
- **Zurückhalten:** Das Ergebnis eines Tools mit `sensitivity: special` gibt die Pipeline nur heraus, wenn `record` `true` gibt. Sonst antwortet sie mit `policy_denied` und einem festen Satz und schreibt die Logzeile `audit_withheld` mit derselben `eventId`. Das gilt auch, wenn vor `record` etwas im `finally` wirft. Die Audit-Zeile sagt dann `denied` mit `policy_denied`, nie zuerst `ok`: Muss die Senke etwas melden, schreibt sie die Zeile gleich so, und nimmt die Datei die Zeile nicht ganz auf, geht die Kopie auf stderr so hinaus. Für alle anderen Tools ändert sich nichts, auch für `ct_whoami` mit `personal`.
- **Wache im `gate`:** Für ein Tool mit `sensitivity: special` fragt das `gate`, ob die Audit-Datei bereit ist: offen, noch mit Link und das letzte Schreiben gelungen. Ist sie geschlossen oder gelöscht, versucht der Schreiber einmal, eine neue zu öffnen. Nach einem gescheiterten Schreiben zeigt erst die nächste Zeile, etwa die Zeile des abgewiesenen Aufrufs, ob die Datei wieder Zeilen aufnimmt. Ist sie nicht bereit, endet der Aufruf mit `policy_denied` und einem anderen festen Satz, bevor die Eingabe geprüft und ChurchTools gefragt wird. So kostet eine kaputte Datei keinen Lesezugriff und kein Kontingent. Die Aufzählung der Prüfungen im `gate` in ADR 0024 nennt Beispiele. Reihenfolge und Menge der Stufen bleiben, diese Prüfung ist Teil des `gate`.
- **Start:** Ist ein Tool mit `sensitivity: special` registriert und fehlt `ECCLIUM_STATE_DIR`, startet der Server über stdio nicht, mit einer eigenen Meldung und dem Code 78. Ist der Ordner gesetzt, öffnet die erste Stufe des Starts die Datei, auch wenn nur `ct_whoami` registriert ist, solange fd 2 noch blockiert und bevor SDK und undici laden. Scheitert das, folgt eine Meldung mit den übrigen Startmeldungen und der Code 78. Wer den Ordner setzt, will das Audit beim Server.
- **Keine IDs bis Phase 4:** `objectRefs` bleibt leer. Nur so darf die Kopie nach stderr gehen, das viele Clients in eine Logdatei schreiben, die Ecclium weder schützt noch löscht.
- **Keine Löschung in Phase 1:** Die Dateien haben noch keine Frist und wachsen, eine je Start und Tag. Weil sie keine IDs tragen, ist eine Frist erst mit den IDs nötig.
- **Keine neue Ausnahme nach ADR 0051:** Der Server hängt an die Datei nur an und liest sie nie. Sie trägt keine Inhalte und keinen Zustand zwischen zwei Anfragen. Der Schreiber hält nur Deskriptor, Datum und Zähler in einer Closure, die die Wurzel der Komposition baut und der Senke übergibt. `AuditSink` ist einer der Ports, die die Wurzel der Komposition zusammensetzt. Als Persistenz auf der Platte beschreibt `docs/privacy.md` die Datei ab Phase 1.
- **Netzlaufwerke:** In Phase 1 rät die Doku zu einem lokalen Ordner, nicht auf einem Netzlaufwerk und nicht in einem synchronisierten Ordner. Eine Prüfung beim Start gibt es nicht, unter macOS lässt sich ein Netzlaufwerk nicht verlässlich erkennen.

### Folgt vor Phase 4

- IDs von Objekten im Audit. Vorher legt dieses ADR oder eines, das es ablöst, fest, ob die Kopie auf stderr dann entfällt oder ohne IDs hinausgeht. Entfällt sie, löst das ADR ADR 0053 in diesem Punkt ab und führt die Umsetzung von ADR 0024 nach.
- Eine Hash-Kette je Datei mit `seq` und `prevHash`, ein täglicher Kettenanker im Log und in der Metrikdatei, `ecclium audit verify` und `ecclium audit show`.
- Eine Frist von zwölf Monaten mit Löschung, das JSON Schema `schemas/audit-event.v1.json` und ein Merkmal in der Datei für «gelesen, aber zurückgehalten». Mit IDs hängt die Gültigkeit einer Zeile vom Ergebnis ab, das Zurückhalten verrät dann etwas über das Ergebnis.
- Ob `fsync` dazukommt.

Das ADR bleibt «Vorgeschlagen», bis diese Teile darin stehen und der Maintainer geklärt hat, welches Datenschutzrecht für eine Gemeinde gilt und ob es ein Protokoll der Lesezugriffe verlangt. Wird es früher angenommen, löst ein neues ADR es vor Phase 4 ab.

## Konsequenzen

- Wer Tools mit `sensitivity: special` einschaltet, legt einmal einen privaten Ordner an und setzt eine Variable mehr. Das Audit liegt dann beim Server, gleich was der Client mit stderr macht.
- **Was garantiert ist:** Jedes Ergebnis eines Tools mit `sensitivity: special`, das hinausgeht, hat seine Zeile ganz in der Datei. `ok` heisst an den Transport übergeben, nicht beim Client angekommen. Zeilen anderer Tools können in der Datei fehlen. Der Schreiber zählt sie und nennt die Zahl beim Ende in `audit_file_closed`.
- **Der Betreiber selbst:** Die Datei schützt nicht gegen ihn. Er kann sie löschen, umbenennen, kürzen oder ändern, erkannt wird nur das Löschen. Backups und synchronisierte Ordner kopieren sie.
- **Zwischen Prüfung und Öffnen:** Derselbe Benutzer kann den Ordner oder `audit` zwischen Prüfung und Öffnen tauschen, weil Node.js kein `openat` hat. Der Abgleich der Inodes nach dem Öffnen macht das Fenster klein, schliesst es aber nicht.
- **ACLs:** Geerbte ACLs prüft niemand. Unter macOS war eine Datei mit 0600 über eine geerbte ACL trotzdem für alle lesbar.
- **Ohne `fsync`** gehen bei einem Absturz des Systems Zeilen verloren, die als geschrieben galten.
- **Hängender Ordner:** Ein Ordner auf einem Netzlaufwerk, das nicht antwortet, hält bei jedem Schreiben den ganzen Server an, auch die Antworten und die Signale.
- **Zurückgehaltene Aufrufe** haben bei ChurchTools gelesen und Kontingent verbraucht, und ihre Dauer verrät, dass sie liefen. Die Wache im `gate` vermeidet das, solange die Datei schon vorher kaputt ist.
- **Uhr:** Uhrzeit, Datum der Datei und Wechsel des Tages kommen von der Uhr des Systems. Scheitert die Uhr, meldet die Senke die Zeit, und das Ergebnis eines Tools mit `sensitivity: special` wird zurückgehalten.
- **Leser** zählen nur Zeilen, die mit einem Zeilenumbruch enden, und überspringen Zeilen, die kein JSON sind oder mit `~` enden. Ein Stück ohne Abschluss kann am Ende einer Datei stehen, nach EFBIG mit derselben `eventId` wie die ganze Zeile in der nächsten Datei.
- **Ausnahme ohne Fang:** Sie beendet den Prozess mit 70, und ein laufender Aufruf verliert seine Zeile (ADR 0054). Sein Ergebnis geht dann aber auch nicht hinaus.
- **stderr des Hosts:** Erbt der Server stderr vom Host, macht er auch dessen stderr nicht blockierend, unter macOS gemessen. Das ändert die Datei nicht.
- **Recht:** Die Datei liegt in Phase 1 vermutlich nicht getrennt vom System, und Ecclium verspricht keine Konformität mit einem Datenschutzrecht. So steht es in `docs/privacy.md` und in der Seite für Betreiber.

## Umsetzung

- Seit dem 23.10.2026 gebaut, vor den Suchtools:
  - die Variable und die Prüfung des Ordners in `packages/core/src/config/state-dir.ts` (ADR 0055);
  - der Schreiber der Audit-Datei in `packages/core/src/audit/file-writer.ts` mit Öffnen, Schreiben, Neuöffnen, Wechsel des Tages, `ready` und `close`, getestet mit Dateifunktionen im Speicher und an echten Ordnern;
  - die Senke mit `file`, der Rückgabe von `record`, der Option `required`, `hasFile` und `ready` in `packages/core/src/audit/sink.ts` (ADR 0054);
  - die Wache im `gate` und das Zurückhalten in `packages/core/src/pipeline/pipeline.ts` (ADR 0024);
  - das Öffnen in der ersten Stufe des Starts in `packages/cli/src/stdio/index.ts`, die Übergabe an die Senke und `audit_file_closed` in `serve.ts` und die Texte in `packages/cli/src/messages/start.ts`;
  - Tests am echten Prozess in `tests/stdio-start.test.mts` und, mit dem Test-Plugin `createSpecialPlugin` aus `testkit` und dem Szenario `audit-file` des Fixtures, in `tests/mcp-stdio.test.mts`. `tests/blocking-descriptors.test.mts` zeigt, dass der Schreiber fd 2 blockierend lässt;
  - volle Abdeckung für `packages/core/src/audit/` und `packages/core/src/pipeline/` im Job `coverage-security-core`;
  - die Seiten [Betrieb über stdio](../betrieb/stdio.md) und [Datenschutz](../privacy.md) und das Threat Model.
- Seit dem 23.10.2026 laufen die Suchtools `ct_persons_search` und `ct_groups_search` mit `sensitivity: special` hinter dieser Sperre. Mit `ECCLIUM_SEARCH_TOOLS=true` und ohne `ECCLIUM_STATE_DIR` endet schon `ecclium config check` mit 78. `tests/stdio-start.test.mts` zeigt am echten Prozess, dass ein Suchtool sein Ergebnis zurückhält, wenn seine Zeile nicht in die Datei kommt (ADR 0060).
- Seit dem 24.10.2026 tritt das Toolset `persons` an die Stelle von `ECCLIUM_SEARCH_TOOLS=true`: Mit `persons` und ohne `ECCLIUM_STATE_DIR` endet `ecclium config check` mit 78, und der Start prüft weiterhin jedes Tool seines Katalogs (ADR 0062).
- Offen: alles unter «Folgt vor Phase 4» und die Klärung des Datenschutzrechts. Ob ChurchTools Lesezugriffe über die API selbst je Konto protokolliert, ist nicht geprüft.
