# ADR 0028: Audit-Ereignis v1 und Datei-Sink im freien Kern

- Status: Vorgeschlagen
- Datum: 23.10.2026, ergänzt am 31.10.2026
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

Ecclium soll von Landeskirchen und Kirchgemeinden ebenso genutzt werden wie von Freikirchen. Für sie gilt verschiedenes Recht. Geprüft am 31.10.2026 an den öffentlichen Texten, ohne Rechtsberatung:

- **Freikirche in der Schweiz,** meist ein Verein: das Datenschutzgesetz (DSG) mit der Datenschutzverordnung (DSV, SR 235.11). Art. 4 DSV in der Fassung vom 1. Dezember 2025 verlangt von Privaten, die besonders schützenswerte Personendaten in grossem Umfang automatisiert bearbeiten, ein Protokoll, wenn vorbeugende Massnahmen den Schutz der Daten nicht gewährleisten: zumindest über das Speichern, Verändern, Bekanntgeben, Löschen und Vernichten und über das Zugreifen auf die Daten. Es nennt die bearbeitende Person, Art, Datum und Uhrzeit der Bearbeitung und wird «während mindestens einem Jahr getrennt vom System, in welchem die Personendaten bearbeitet werden» aufbewahrt, zugänglich nur für die Stellen, die den Datenschutz prüfen oder die Sicherheit der Daten gewährleisten. Für besonders schützenswerte Personendaten gilt keine Übergangsfrist.
- **Landeskirche oder Kirchgemeinde in der Schweiz:** das Datenschutzrecht ihres Kantons, teils ergänzt durch Regeln der Landeskirchen. Im Kanton Solothurn gilt das Informations- und Datenschutzgesetz (InfoDG, BGS 114.1, § 3) für die anerkannten Kirchen und ihre Kirchgemeinden. Im Kanton Zürich verweisen die Kirchenordnungen auf das Gesetz über die Information und den Datenschutz (IDG, LS 170.4), daneben gilt das Kirchliche Datenschutz-Reglement (LS 180.7). Was diese Rechte für ein Protokoll verlangen, ist nicht geprüft, ebenso wenig das Recht der übrigen Kantone.
- **Freikirche in der EU** ohne eigenes kirchliches Datenschutzrecht: die DSGVO. Sie verlangt ein Protokoll nicht ausdrücklich und nennt keine Frist, wohl aber eine angemessene Sicherheit der Verarbeitung (Art. 32) und die Rechenschaft des Verantwortlichen (Art. 5 Abs. 2).
- **Katholische Stellen in Deutschland:** das Gesetz über den Kirchlichen Datenschutz (KDG) mit seiner Durchführungsverordnung (KDG-DVO), geändert durch Beschluss der Vollversammlung des Verbands der Diözesen Deutschlands vom 24. November 2025 und seit dem 1. März 2026 in Kraft. § 6 Abs. 2 Bst. f KDG-DVO verlangt als Eingabekontrolle, dass sich nachträglich prüfen lässt, ob und von wem Daten in IT-Systemen verarbeitet worden sind, für mindestens sechs Monate. Verarbeiten umfasst nach § 4 KDG auch das Auslesen und das Abfragen. Die besonderen Kategorien, also auch die Religionszugehörigkeit, gehören zur Datenschutzklasse III (§ 13 KDG-DVO).
- **Evangelische Stellen in Deutschland:** das Datenschutzgesetz der EKD (DSG-EKD) mit der IT-Sicherheitsverordnung (ITSVO-EKD) vom 29. Mai 2015. Weder die Verordnung noch ihre Begründung regeln ein Protokoll der Zugriffe oder eine Frist.

Ob eine einzelne Gemeinde unter eine dieser Pflichten fällt, hängt von ihr ab, etwa vom Umfang ihrer Daten und von ihren übrigen Massnahmen. Das klärt Ecclium nicht.

Bis Phase 4 trägt das Audit keine Kennungen von Objekten, `objectRefs` bleibt leer, und die Dateien haben weder Kette noch Frist. Jeder Start über stdio öffnet eine eigene Datei, auch wenn danach kein Tool läuft, und ein Client startet den Server schon, wenn er seinen Eintrag lädt. Am 23.10.2026 entstanden so in knapp 40 Minuten 37 Dateien, 36 davon leer. Am 28.10.2026 ergab ein Start von Claude Desktop in fünf Sekunden vier Dateien, nur eine davon mit Zeilen. Eine Metrikdatei, Läufe von Routinen und Container gibt es erst mit dem Runner und dem Betrieb über HTTP.

`ECCLIUM_STATE_DIR` ist in ADR 0055 als Name für einen späteren Ordner mit Zustand reserviert. Das Lesebudget in Phase 2 braucht einen solchen Ordner für die Zähler.

## Optionen

Für den Ort des Audits über stdio:

1. **Wie bisher, nur Doku:** Ein Client, der stderr nicht leert, verliert Audit-Zeilen still, während Ergebnisse der Suchtools weiter hinausgehen. Keine Garantie.
2. **stderr mit Sperre je Aufruf:** `record` meldet, ob die Zeile ganz an stderr ging, sonst hält die Pipeline das Ergebnis zurück. Die Garantie bleibt «angenommen», ein Client, der stderr verwirft, bekommt trotzdem Daten, und ein Client, der nie liest, nach vollem Puffer nur noch Ablehnungen.
3. **fd 2 blockierend:** Kein Verlust, aber eine nicht dokumentierte Schnittstelle, und ein Client, der stderr nicht leert, hält den ganzen Server an, auch die Antworten auf stdout.
4. **Eigene Audit-Datei mit Sperre:** Der Server hält das Audit selbst fest, unabhängig vom Client. Kosten: eine Variable, ein Ordner, Prüfungen der Rechte und später Aufbewahrung, Kette und Löschung.

Für das Protokoll der Lesezugriffe:

1. **Nur, wo ein Recht es verlangt:** Der Betreiber nennt sein Recht, und Ecclium protokolliert danach. Für kantonales Recht kennt Ecclium die Vorgaben nicht, und wer sein Recht falsch einschätzt, hat kein Protokoll.
2. **Immer, mit Voreinstellungen nach den strengsten bekannten Vorgaben:** Jeder Lesezugriff mit Personendaten steht in der Datei, ein Jahr lang. Eine Gemeinde ohne Pflicht hat mehr Daten auf der Platte, als sie bräuchte.
3. **Immer, mit einer Variable für das Recht,** die im Audit steht und eine Mindestfrist je Recht erzwingt: genauer, aber eine Variable mehr, und für kantonales Recht gibt es keine Frist, die Ecclium erzwingen könnte.

Für die Kennungen im Audit:

1. **Nur die Kennungen aus der Eingabe:** klein, aber wer über eine Suche oder eine Liste gelesen wurde, steht nicht im Protokoll.
2. **Die Kennungen aus der Eingabe und die Kennungen von Personen und Gruppen im Ergebnis:** Auf eine Anfrage hin lässt sich zeigen, wer die Daten einer Person gelesen hat, auch über eine Suche.
3. **Alle Kennungen im Ergebnis,** auch von Events, Terminen und Seiten: vollständig, aber viel mehr Daten im Protokoll, ohne dass eine Auskunft über eine Person sie braucht.

Für die Kopie auf stderr, sobald die Datei Kennungen trägt:

1. **Die Kopie geht weiter, ohne Kennungen:** Wer Logs sammelt, behält die Ereignisse und den Anker der Kette, die Kennungen bleiben in der Datei.
2. **Die Kopie entfällt:** Wer Logs sammelt, sieht die Aufrufe dann nicht mehr, und ADR 0053 müsste in diesem Punkt abgelöst werden.

## Entscheid

Gewählt ist für den Ort die vierte Option. Sie entsteht in Phase 1 in einer ersten Form für den Betrieb über stdio, Phase 4 baut den Datei-Sink darauf aus. Für das Protokoll der Lesezugriffe und für die Kennungen gilt jeweils die zweite Option, für die Kopie auf stderr die erste.

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
- **Keine IDs bis Phase 4:** `objectRefs` bleibt leer, bis die Kennungen nach «Objekt-IDs» unten gebaut sind. Bis dahin ist die Kopie nach stderr dieselbe Zeile wie in der Datei.
- **Keine Löschung in Phase 1:** Die Dateien haben noch keine Frist und wachsen, eine je Start und Tag. Weil sie keine IDs tragen, ist eine Frist erst mit den IDs nötig.
- **Keine neue Ausnahme nach ADR 0051:** Der Server hängt an die Datei nur an und liest sie nie. Sie trägt keine Inhalte und keinen Zustand zwischen zwei Anfragen. Der Schreiber hält nur Deskriptor, Datum und Zähler in einer Closure, die die Wurzel der Komposition baut und der Senke übergibt. `AuditSink` ist einer der Ports, die die Wurzel der Komposition zusammensetzt. Als Persistenz auf der Platte beschreibt `docs/privacy.md` die Datei ab Phase 1.
- **Netzlaufwerke:** In Phase 1 rät die Doku zu einem lokalen Ordner, nicht auf einem Netzlaufwerk und nicht in einem synchronisierten Ordner. Eine Prüfung beim Start gibt es nicht, unter macOS lässt sich ein Netzlaufwerk nicht verlässlich erkennen.

### Recht

- **Protokoll als Entscheid des Produkts:** Ecclium protokolliert jeden Aufruf eines Tools mit den Kennungen nach «Objekt-IDs», auch reine Lesezugriffe, gleich ob ein Recht es für die Gemeinde verlangt. Daten aus ChurchTools lassen auf die Religionszugehörigkeit schliessen, die strengsten bekannten Vorgaben verlangen ein Protokoll auch über das Zugreifen, und eine Gemeinde soll auf die Anfrage einer Person zeigen können, wer deren Daten über Ecclium gelesen hat.
- **Voreinstellungen nach den strengsten bekannten Vorgaben:** Das Audit hält Lesezugriffe fest und bewahrt sie in der Voreinstellung zwölf Monate auf. Das deckt das eine Jahr der DSV und die sechs Monate der KDG-DVO. Für kantonales Recht und für Reglemente der Landeskirchen kennt Ecclium keine Frist, ein Betreiber kann die Frist verlängern.
- **Getrennt vom System:** Die Datei liegt beim Server. Die Ablage getrennt vom System, wie die DSV sie verlangt, leistet der freie Kern allein nicht. Der Betreiber muss die Dateien selbst an einen anderen Ort kopieren. Weitere Ziele für das Audit, etwa ein anderer Rechner, gehören nicht zum freien Kern.
- **Kein Recht in der Konfiguration:** Eine Variable, mit der ein Betreiber sein Recht angibt, gibt es in Phase 4 nicht. Die Voreinstellungen gelten für alle, und [Datenschutz](../privacy.md) sagt je Recht, was Ecclium abdeckt und was der Betreiber selbst tun muss. Das Feld `dataProtectionRegime` des Ereignisses bleibt für den gehosteten Betrieb, in dem ein Betreiber Gemeinden mit verschiedenem Recht bedient.
- **Kein Versprechen:** Ecclium verspricht keine Konformität mit einem Datenschutzrecht. Weder dieses ADR noch die Doku sind Rechtsberatung.

### Objekt-IDs

- **Welche:** Die Zeile eines Aufrufs nennt in `objectRefs` die Kennungen der Objekte, nach denen er fragt, und die Kennungen der Personen und Gruppen, die sein Ergebnis nennt, jede einmal, zuerst die aus der Eingabe, dann die aus dem Ergebnis, jeweils in ihrer Reihenfolge. Kennungen anderer Objekte im Ergebnis, etwa von Events oder Seiten, nennt sie nicht. Bei `ct_api_execute_read`, dessen Antwort kein Schema hat, nennt sie nur die Kennungen aus dem Pfad der Operation (ADR 0067).
- **Woher:** Die Pipeline leitet sie aus den Schemas des Tools ab, nicht aus Angaben seines Codes, damit ein Tool sie nicht weglassen kann. Im Ergebnis zählen die Felder mit den Datenklassen `personId` und `groupId`. In der Eingabe tragen Felder mit Kennungen die Art ihres Objekts, Personen und Gruppen über dieselben Klassen. Die Art eines Pfadparameters der Escape Hatch hält die Einstufung der Operation fest.
- **Form:** wie bisher `<Bereich>:<Kennung>`, die Kennung aus Ziffern oder eine UUID. Zu `person`, `group`, `wiki_category` und `wiki_page` kommen die Arten der Objekte, nach denen Tools fragen, etwa `event`, `calendar`, `appointment`, `resource` und `song`. Die Liste bleibt geschlossen, damit der Teil vor dem Doppelpunkt keinen Namen tragen kann. Welche Bereiche es gibt, steht unter «Umsetzung».
- **Wie viele:** höchstens 100 je Zeile. Die Seiten der Tools sind so bemessen, dass 100 reichen. Nennt ein Aufruf trotzdem mehr, stehen die ersten 100 in der Zeile und dazu die Zahl der übrigen, damit erkennbar bleibt, dass Kennungen fehlen.
- **Ohne Ergebnis:** Die Zeile eines abgelehnten oder gescheiterten Aufrufs nennt die Kennungen aus der Eingabe, wenn diese zum Schema passt, sonst keine.
- **Wo:** nur in der Audit-Datei. Ohne `ECCLIUM_STATE_DIR` geht das Audit nur nach stderr und bleibt ohne Kennungen. Tools mit `sensitivity: special` und Tools, die Namen anderer Personen nennen, laufen über stdio ohnehin nur mit der Datei.

### Kopie auf stderr

- Die Kopie nach stderr geht weiter, auch wenn die Zeile in der Datei Kennungen trägt, aber ohne sie: Sie hat ein leeres `objectRefs` und keines der Felder, die nur in die Datei gehören, also weder die Zahl der übrigen Kennungen noch die Felder der Kette noch das Merkmal «gelesen, aber zurückgehalten». Viele Clients schreiben stderr in eine Logdatei, die Ecclium weder schützt noch löscht. Kennungen gehören dort nicht hin. Wer Logs sammelt, behält die Ereignisse und den Kettenanker.
- Die Entscheide von ADR 0053 und ADR 0024, dass das Audit über stdio nach stderr geht, bleiben damit wahr. Massgeblich ist die Zeile in der Datei, die auf stderr bleibt eine Kopie.

### Klasse `groupId`

- Neu ist die Datenklasse `groupId` für Kennungen von Gruppen. ADR 0026 verlangt sie, sobald Kennungen ins Audit kommen, dieses ADR ergänzt es damit.
- Jede Stufe lässt sie unverändert, `off`, `standard` und `strict`. Anders als `personId` bekommt sie in `strict` kein Pseudonym, weil sie keine Person bezeichnet. Sie dient dem Audit: Die Pipeline nimmt Felder dieser Klasse in die `objectRefs` auf.
- Weitere Klassen für Kennungen entstehen nur, wenn ein Tool sie braucht.

### Folgt vor Phase 4

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
- **Recht:** Die Datei liegt beim Server und damit nicht getrennt vom System. Wer Art. 4 DSV erfüllen muss, kopiert die Dateien selbst an einen getrennten Ort mit beschränktem Zugriff. Ecclium verspricht keine Konformität mit einem Datenschutzrecht. So steht es in [Datenschutz](../privacy.md).
- **Kennungen auf der Platte:** Mit den Kennungen trägt die Datei Personendaten. Wer sie lesen kann, sieht, wessen Daten wann über Ecclium gelesen wurden, auch ohne Namen. Darum gehen die Kennungen nicht nach stderr, und darum hat die Datei eine Frist mit Löschung.
- **Protokoll ohne Pflicht:** Eine Gemeinde, für die kein Recht ein Protokoll verlangt, hat trotzdem eines auf der Platte, ein Jahr lang. Sie kann die Frist kürzen und bekommt beim Start eine Warnung.

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
- Seit dem 26.10.2026 gelten Zurückhalten, Wache im `gate` und Prüfung beim Start auch für Tools, die der Katalog wie eines mit `sensitivity: special` behandelt, weil ihre Ausgabe Kennungen oder Namen anderer Personen trägt (ADR 0064), als erstes `ct_services_get_assignments` im Toolset `events`. Mit `events` und ohne `ECCLIUM_STATE_DIR` endet `ecclium config check` mit 78.
- Offen: alles unter «Folgt vor Phase 4» und die Klärung des Datenschutzrechts. Ob ChurchTools Lesezugriffe über die API selbst je Konto protokolliert, ist nicht geprüft.
