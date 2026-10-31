# ADR 0028: Audit-Ereignis v1 und Datei-Sink im freien Kern

- Status: Angenommen am 31.10.2026
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

Ecclium soll von Landeskirchen und Kirchgemeinden ebenso genutzt werden wie von Freikirchen. Für sie gilt verschiedenes Recht. Geprüft am 31.10.2026 an den öffentlichen Texten, ohne Rechtsberatung:

- **Freikirche in der Schweiz,** meist ein Verein: das Datenschutzgesetz (DSG) mit der Datenschutzverordnung (DSV, SR 235.11). Art. 4 DSV in der Fassung vom 1. Dezember 2025 verlangt von Privaten, die besonders schützenswerte Personendaten in grossem Umfang automatisiert bearbeiten, ein Protokoll, wenn vorbeugende Massnahmen den Schutz der Daten nicht gewährleisten: zumindest über das Speichern, Verändern, Bekanntgeben, Löschen und Vernichten und über das Zugreifen auf die Daten. Es nennt die bearbeitende Person, Art, Datum und Uhrzeit der Bearbeitung und wird «während mindestens einem Jahr getrennt vom System, in welchem die Personendaten bearbeitet werden» aufbewahrt, zugänglich nur für die Stellen, die den Datenschutz prüfen oder die Sicherheit der Daten gewährleisten. Die Übergangsbestimmung in Art. 46 Abs. 1 DSV betrifft nur die Protokolle der Bundesorgane nach Art. 4 Abs. 2, nicht die von Privaten.
- **Landeskirche oder Kirchgemeinde in der Schweiz:** das Datenschutzrecht ihres Kantons, teils ergänzt durch Regeln der Landeskirchen. Im Kanton Solothurn gilt das Informations- und Datenschutzgesetz (InfoDG, BGS 114.1, § 3) für die anerkannten Kirchen und ihre Kirchgemeinden. Im Kanton Zürich verweisen die Kirchenordnungen auf das Gesetz über die Information und den Datenschutz (IDG, LS 170.4), daneben gilt das Kirchliche Datenschutz-Reglement (LS 180.7). Was diese Rechte für ein Protokoll verlangen, ist nicht geprüft, ebenso wenig das Recht der übrigen Kantone.
- **Freikirche in der EU** ohne eigenes kirchliches Datenschutzrecht: die DSGVO. Sie verlangt ein Protokoll nicht ausdrücklich und nennt keine Frist, wohl aber eine angemessene Sicherheit der Verarbeitung (Art. 32) und die Rechenschaft des Verantwortlichen (Art. 5 Abs. 2).
- **Katholische Stellen in Deutschland:** das Gesetz über den Kirchlichen Datenschutz (KDG) mit seiner Durchführungsverordnung (KDG-DVO), beide geändert durch Beschluss der Vollversammlung des Verbands der Diözesen Deutschlands vom 24. November 2025 und von den Bistümern in Kraft gesetzt, im Bistum Hildesheim zum 1. März 2026. § 6 Abs. 2 Bst. f KDG-DVO verlangt als Eingabekontrolle, dass sich nachträglich prüfen lässt, ob und von wem Daten in IT-Systemen verarbeitet worden sind, für mindestens sechs Monate. Verarbeiten umfasst nach § 4 Nr. 3 KDG auch das Auslesen und das Abfragen. Die besonderen Kategorien, etwa religiöse Überzeugungen, gehören zur Datenschutzklasse III (§ 13 KDG-DVO). Die Zugehörigkeit zu einer Kirche ist nach § 4 Nr. 2 KDG keine besondere Kategorie.
- **Evangelische Stellen in Deutschland:** das Datenschutzgesetz der EKD (DSG-EKD) mit der IT-Sicherheitsverordnung (ITSVO-EKD) vom 29. Mai 2015. Weder die Verordnung noch ihre Begründung regeln ein Protokoll der Zugriffe oder eine Frist. Das DSG-EKD selbst ist darauf nicht geprüft.

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
2. **Immer, mit Voreinstellungen nach den strengsten bekannten Vorgaben:** Mit dem Zustandsordner steht jeder Aufruf in der Datei, ein Jahr lang. Eine Gemeinde ohne Pflicht hat mehr Daten auf der Platte, als sie bräuchte.
3. **Immer, mit einer Variable für das Recht,** die im Audit steht und eine Mindestfrist je Recht erzwingt: genauer, aber eine Variable mehr, und für kantonales Recht gibt es keine Frist, die Ecclium erzwingen könnte.

Für die Kennungen im Audit:

1. **Nur die Kennungen aus der Eingabe:** klein, aber wer über eine Suche oder eine Liste gelesen wurde, steht nicht im Protokoll.
2. **Die Kennungen aus der Eingabe und die Kennungen von Personen und Gruppen im Ergebnis:** Auf eine Anfrage hin lässt sich zeigen, wer die Daten einer Person gelesen hat, auch über eine Suche.
3. **Alle Kennungen im Ergebnis,** auch von Events, Terminen und Seiten: vollständig, aber viel mehr Daten im Protokoll, ohne dass eine Auskunft über eine Person sie braucht.

Für die Kopie auf stderr, sobald die Datei Kennungen trägt:

1. **Die Kopie geht weiter, ohne Kennungen:** Wer Logs sammelt, behält die Ereignisse und den Anker der Kette, die Kennungen bleiben in der Datei.
2. **Die Kopie entfällt:** Wer Logs sammelt, sieht die Aufrufe dann nicht mehr, und ADR 0053 müsste in diesem Punkt abgelöst werden.

Für die Frist:

1. **Fest zwölf Monate:** einfach, aber eine längere Vorgabe eines Kantons oder eines Reglements liesse sich nur mit eigenen Kopien erfüllen.
2. **Eine Variable, die nur verlängert:** zwölf Monate als Untergrenze. Eine Gemeinde ohne Pflicht könnte die Daten nicht früher löschen.
3. **Eine Variable von 1 bis 120 Monaten, voreingestellt auf zwölf, mit einer Warnung darunter:** Jede Gemeinde kann ihrer Vorgabe folgen, und wer kürzt, sieht beim Start, dass die Frist unter dem einen Jahr der DSV liegt.

Für leere Dateien:

1. **Beim geordneten Ende entfernen:** Die Prüfung beim Start bleibt, der Server löscht dafür aber Dateien, eng begrenzt.
2. **Die Datei erst mit der ersten Zeile anlegen:** nie eine leere Datei, aber ein Ordner, der nicht taugt, fällt erst beim ersten Aufruf auf statt beim Start.
3. **So lassen und dokumentieren:** nichts zu bauen, aber ein Ordner voller leerer Dateien, eine je Start.

Für `fsync`:

1. **Nie,** wie in Phase 1: Ein Absturz des Systems kostet Zeilen, die als geschrieben galten.
2. **Nach jeder Zeile:** Keine Zeile geht so verloren, aber jeder Aufruf wartet auf die Platte.
3. **Nach einer Messung:** nach jeder Zeile, wenn es wenig kostet, sonst an festen Stellen.

## Entscheid

Gewählt ist für den Ort die vierte Option. Sie entsteht in Phase 1 in einer ersten Form für den Betrieb über stdio, Phase 4 baut den Datei-Sink darauf aus. Für das Protokoll der Lesezugriffe und für die Kennungen gilt jeweils die zweite Option, für die Kopie auf stderr die erste, für die Frist die dritte, für leere Dateien die erste und für `fsync` die dritte.

### Ordner und Datei

- **Variable:** `ECCLIUM_STATE_DIR` nennt den Ordner für Zustand des Servers, vorerst nur im Betrieb über stdio (ADR 0055). Der Wert ist ein absoluter, normalisierter Pfad mit höchstens 960 Zeichen und 960 Bytes in UTF-8, damit der Pfad einer Audit-Datei darin unter der Grenze von 1'024 Bytes für Pfade unter macOS bleibt: kein Trenner am Ende, kein `.`, kein `..`, kein `//`. Mit einem Trenner am Ende folgt `lstat` einem Link. Lader und `ecclium config check` prüfen ohne zu schreiben, dass der Ordner kein Link ist, ein Ordner ist, dem aufrufenden Benutzer gehört und Gruppe und anderen keine Rechte gibt. Einen vorhandenen Unterordner `audit` prüfen sie ebenso. Fehlt die Variable, gibt es keine Audit-Datei, und das Audit geht wie bisher nur nach stderr.
- **Ordner `audit`:** Der Start legt `<ECCLIUM_STATE_DIR>/audit` mit 0700 an, ohne `recursive`, weil das rekursive Anlegen auf einem Link zu einem Ordner still gelingt. Ist er schon da, prüft der Start ihn wie der Lader.
- **Datei:** eine je Prozess und UTC-Tag, mit dem Namen `audit-<JJJJ-MM-TT>-<hhmmss>-<pid>-<n>.jsonl`, Datum und Uhrzeit des Öffnens in UTC, die Kennung des Prozesses und eine Folgenummer, die nur aufwärts zählt. Geöffnet wird sie mit `O_WRONLY`, `O_APPEND`, `O_CREAT`, `O_EXCL`, `O_NOFOLLOW` und `O_NOCTTY` und dem Modus 0600, also nie eine Datei, die schon da ist, und nie über einen Link. Danach prüft der Server am Deskriptor, dass es eine gewöhnliche Datei mit genau einem Link ist, die ihm gehört und anderen keine Rechte gibt, dass der Pfad auf dieselbe Kombination aus Gerät und Inode zeigt und dass der Ordner `audit` noch derselbe ist. Ein Deskriptor unter 3 wird geschlossen und abgewiesen, weil eine Zeile sonst auf stdin, stdout oder stderr ginge. Kein Fehler und keine Meldung nennt einen Pfad.
- **Schreiben:** jede Zeile mit einem `writeSync` an das Ende der Datei, ein Teilschreibvorgang am Versatz fortgesetzt, höchstens vier Aufrufe je Zeile. Die Datei nimmt nur Zeilen aus druckbarem ASCII wie der Zeilenschreiber für stderr. Ein abgerissenes Stück schliesst der Server in derselben Datei mit `~` und einem Zeilenumbruch ab. Mit einem Zeilenumbruch allein könnte aus einem Stück, dem nur der Zeilenumbruch fehlt, eine gültige Zeile werden. Gelingt das nicht, trägt die nächste Zeile den Abschluss, und vor dem Schliessen einer Datei versucht der Server ihn noch einmal. Leser zählen nur Zeilen, die mit einem Zeilenumbruch enden und nicht mit `~`, denn nach EFBIG oder EBADF kann ein Stück ohne Abschluss am Ende einer Datei bleiben.
- **Neu öffnen:** Hat die Datei keinen Link mehr, weil jemand sie gelöscht hat, oder meldet das Schreiben EBADF, ESTALE oder EFBIG, öffnet der Server eine neue Datei mit allen Prüfungen, höchstens einmal je Zeile und mit höchstens 64 Versuchen je Prozess. Danach bleibt er ohne neue Datei, bis er neu startet, und Tools mit `sensitivity: special` laufen nicht. Einen Deskriptor, den `fstat` nicht mehr als die geöffnete Datei zeigt, schliesst er nie, denn er kann schon jemand anderem gehören. Bei ENOSPC, EDQUOT und EIO bleibt die Datei offen, und die Zeile ist verloren. Ein Stück einer Zeile bleibt am Ende der alten Datei stehen. Zeigt die Uhr nach dem Datum der offenen Datei einen neuen UTC-Tag, beginnt der Server eine neue Datei, nie rückwärts. Gelingt das nicht, schreibt er in der alten weiter und versucht diesen Tag nicht noch einmal. Ein Wechsel des Tages zählt nicht zu den 64 Versuchen, damit ein langer Lauf eine Datei je Tag behält.
- **Kein `fsync` in Phase 1:** Eine geschriebene Zeile übersteht einen Absturz von Server oder Client, aber keinen Stromausfall und keinen Absturz des Betriebssystems. Ab Phase 4 gilt «`fsync`» unten.
- **Ende:** Nach dem Schliessen des Transports schreibt der Server `audit_file_closed` mit der Zahl der verlorenen Zeilen, dann schliesst er die Datei, dann folgt `stdio_closed` wie bisher als letzte Zeile. Spätere Zeilen gelten als verloren und öffnen keine Datei mehr.
- **Windows:** Ohne `getuid`, `O_NOFOLLOW`, `O_DIRECTORY` oder `O_NOCTTY` lassen sich Eigentümer und Links nicht prüfen. Dort gibt es über stdio weder die Audit-Datei noch Tools mit `sensitivity: special`, und ein gesetztes `ECCLIUM_STATE_DIR` bricht den Start mit einer eigenen Meldung ab.

### Audit, Sperre und Start

- **Reihenfolge:** Mit der Datei geht jede Audit-Zeile zuerst in die Datei und erst danach als Kopie über den Zeilenschreiber nach stderr. Das Log bleibt nur auf stderr. Die Entscheide von ADR 0053 und ADR 0024, dass das Audit über stdio nach stderr geht, bleiben damit wahr.
- **Ergebnis von `record`:** `true` genau dann, wenn die Zeile ganz in der Datei steht und die Senke nichts melden musste (ADR 0054). Ein Verlust der Kopie auf stderr ändert das Ergebnis nicht.
- **Zurückhalten:** Das Ergebnis eines Tools mit `sensitivity: special` gibt die Pipeline nur heraus, wenn `record` `true` gibt. Sonst antwortet sie mit `policy_denied` und einem festen Satz und schreibt die Logzeile `audit_withheld` mit derselben `eventId`. Das gilt auch, wenn vor `record` etwas im `finally` wirft. Die Audit-Zeile sagt dann `denied` mit `policy_denied`, nie zuerst `ok`: Muss die Senke etwas melden, schreibt sie die Zeile gleich so, und nimmt die Datei die Zeile nicht ganz auf, geht die Kopie auf stderr so hinaus. Für alle anderen Tools ändert sich nichts, auch für `ct_whoami` mit `personal`.
- **Wache im `gate`:** Für ein Tool mit `sensitivity: special` fragt das `gate`, ob die Audit-Datei bereit ist: offen, noch mit Link und das letzte Schreiben gelungen. Ist sie geschlossen oder gelöscht, versucht der Schreiber einmal, eine neue zu öffnen. Nach einem gescheiterten Schreiben zeigt erst die nächste Zeile, etwa die Zeile des abgewiesenen Aufrufs, ob die Datei wieder Zeilen aufnimmt. Ist sie nicht bereit, endet der Aufruf mit `policy_denied` und einem anderen festen Satz, bevor die Eingabe geprüft und ChurchTools gefragt wird. So kostet eine kaputte Datei keinen Lesezugriff und kein Kontingent. Die Aufzählung der Prüfungen im `gate` in ADR 0024 nennt Beispiele. Reihenfolge und Menge der Stufen bleiben, diese Prüfung ist Teil des `gate`.
- **Start:** Ist ein Tool mit `sensitivity: special` registriert und fehlt `ECCLIUM_STATE_DIR`, startet der Server über stdio nicht, mit einer eigenen Meldung und dem Code 78. Ist der Ordner gesetzt, öffnet die erste Stufe des Starts die Datei, auch wenn nur `ct_whoami` registriert ist, solange fd 2 noch blockiert und bevor SDK und undici laden. Scheitert das, folgt eine Meldung mit den übrigen Startmeldungen und der Code 78. Wer den Ordner setzt, will das Audit beim Server.
- **Keine IDs bis Phase 4:** `objectRefs` bleibt leer, bis die Kennungen nach «Objekt-IDs» unten gebaut sind. Bis dahin ist die Kopie nach stderr dieselbe Zeile wie in der Datei.
- **Keine Löschung in Phase 1:** Die Dateien haben noch keine Frist und wachsen, eine je Start und Tag. Weil sie keine IDs tragen, ist eine Frist erst mit den IDs nötig. Ab Phase 4 gelten «Frist und Löschung» und «Leere Dateien» unten.
- **Keine neue Ausnahme nach ADR 0051:** Der Server hängt an die Datei nur an und liest ihren Inhalt nie, auch nicht für die Kette. Sie trägt keine Inhalte und keinen Zustand zwischen zwei Anfragen. Der Schreiber hält nur Deskriptor, Datum, Zähler und ab Phase 4 den Kopf der Kette in einer Closure, die die Wurzel der Komposition baut und der Senke übergibt. `AuditSink` ist einer der Ports, die die Wurzel der Komposition zusammensetzt. Als Persistenz auf der Platte beschreibt `docs/privacy.md` die Datei ab Phase 1.
- **Netzlaufwerke:** In Phase 1 rät die Doku zu einem lokalen Ordner, nicht auf einem Netzlaufwerk und nicht in einem synchronisierten Ordner. Eine Prüfung beim Start gibt es nicht, unter macOS lässt sich ein Netzlaufwerk nicht verlässlich erkennen.

### Recht

- **Protokoll als Entscheid des Produkts:** Mit `ECCLIUM_STATE_DIR` protokolliert Ecclium jeden Aufruf eines Tools in der Audit-Datei, mit den Kennungen nach «Objekt-IDs», auch reine Lesezugriffe, gleich ob ein Recht es für die Gemeinde verlangt. Daten aus ChurchTools lassen auf die Religionszugehörigkeit schliessen, die strengsten bekannten Vorgaben verlangen ein Protokoll auch über das Zugreifen, und eine Gemeinde soll auf die Anfrage einer Person zeigen können, wer deren Daten über Ecclium gelesen hat.
- **Wo die Datei Pflicht ist:** Über stdio verlangen die Toolsets `persons`, `events` und `api` den Ordner, und ihre Ergebnisse gehen nur mit ihrer Zeile in der Datei hinaus. Mit den übrigen Toolsets startet der Server auch ohne den Ordner, dann gibt es kein Protokoll auf der Platte, und eine Zeile eines solchen Tools kann in der Datei fehlen, gezählt in `audit_file_closed`. Wer ein Protokoll braucht, setzt `ECCLIUM_STATE_DIR` immer.
- **Wer zugegriffen hat:** Die Zeile nennt das Subjekt aus `ECCLIUM_STDIO_SUBJECT` (ADR 0055), eine neutrale Bezeichnung, nach der Doku nie der Name einer Person. Verlangt ein Recht, wie die DSV und die KDG-DVO, dass sich die Person feststellen lässt, gibt der Betreiber jeder Person einen eigenen Eintrag mit eigenem Subjekt, etwa einem Kürzel, und hält die Zuordnung getrennt fest.
- **Voreinstellungen nach den strengsten bekannten Vorgaben:** Das Audit hält Lesezugriffe fest und bewahrt sie in der Voreinstellung zwölf Monate auf. Das ist nicht kürzer als das eine Jahr der DSV und die sechs Monate der KDG-DVO. Für kantonales Recht und für Reglemente der Landeskirchen kennt Ecclium keine Frist, ein Betreiber kann die Frist verlängern.
- **Getrennt vom System:** Die Datei liegt beim Server. Die Ablage getrennt vom System, wie die DSV sie verlangt, leistet der freie Kern allein nicht. Der Betreiber muss die Dateien selbst an einen anderen Ort kopieren. Weitere Ziele für das Audit, etwa ein anderer Rechner, gehören nicht zum freien Kern.
- **Kein Recht in der Konfiguration:** Eine Variable, mit der ein Betreiber sein Recht angibt, gibt es in Phase 4 nicht. Die Voreinstellungen gelten für alle, und [Datenschutz](../privacy.md) sagt je Recht, was Ecclium abdeckt und was der Betreiber selbst tun muss. Das Feld `dataProtectionRegime` des Ereignisses bleibt für den gehosteten Betrieb, in dem ein Betreiber Gemeinden mit verschiedenem Recht bedient.
- **Kein Versprechen:** Ecclium verspricht keine Konformität mit einem Datenschutzrecht. Weder dieses ADR noch die Doku sind Rechtsberatung.

### Objekt-IDs

- **Welche:** Die Zeile eines Aufrufs nennt in `objectRefs` die Kennungen der Objekte, nach denen er fragt, und die Kennungen der Personen und Gruppen, die sein Ergebnis nennt, jede einmal, zuerst die aus der Eingabe, dann die aus dem Ergebnis, jeweils in ihrer Reihenfolge. Kennungen anderer Objekte im Ergebnis, etwa von Events oder Seiten, nennt sie nicht. Bei `ct_api_execute_read`, dessen Antwort kein Schema hat, nennt sie nur die Kennungen, nach denen der Aufruf fragt, aus dem Pfad und aus Parametern der Query wie `ids[]` (ADR 0067).
- **Woher:** Die Pipeline leitet sie aus den Schemas des Tools ab, nicht aus Angaben seines Codes, damit ein Tool sie nicht weglassen kann. Im Ergebnis zählen die Felder mit den Datenklassen `personId` und `groupId`. In der Eingabe tragen Felder mit Kennungen die Art ihres Objekts, Personen und Gruppen über dieselben Klassen. Die Art eines Parameters der Escape Hatch, im Pfad oder in der Query, hält die Einstufung der Operation fest.
- **Form:** wie bisher `<Bereich>:<Kennung>`, die Kennung aus Ziffern oder eine UUID. Zu `person`, `group`, `wiki_category` und `wiki_page` kommen die Arten der Objekte, nach denen Tools fragen, etwa `event`, `calendar`, `appointment`, `resource` und `song`. Die Liste bleibt geschlossen, damit der Teil vor dem Doppelpunkt keinen Namen tragen kann. Welche Bereiche es gibt, hält die «Umsetzung» fest, sobald sie gebaut sind.
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

### Frist und Löschung

- **Variable:** `ECCLIUM_AUDIT_RETENTION_MONTHS` nennt die Frist in ganzen Monaten, von 1 bis 120, voreingestellt auf 12. Ein anderer Wert bricht den Start ab, wie bei jeder Variable mit einer Meldung, die die erlaubten Werte nennt und nicht den Wert. Unter 12 warnen `ecclium config check` und jeder Start, dass die Frist unter dem einen Jahr der DSV liegt, und brechen nicht ab. Ohne `ECCLIUM_STATE_DIR` bewirkt die Variable nichts, und beide sagen das.
- **Zählung:** Eine Datei vom UTC-Tag im Namen bleibt mindestens bis zum Ende des Tages, der so viele Kalendermonate später liegt, wie die Frist nennt. Gibt es diesen Tag im Zielmonat nicht, gilt dessen letzter Tag. Gelöscht wird sie frühestens am Tag danach und nur, wenn auch ihre letzte Änderung so lange zurückliegt. Mit zwölf Monaten bleibt eine Datei vom 31.10.2026 also mindestens bis zum Ende des 31.10.2027, eine vom 29.02.2028 bis zum Ende des 28.02.2029. So bleibt jede Zeile mindestens die volle Frist, auch in einer Datei, die nach einem gescheiterten Wechsel des Tages länger beschrieben wurde.
- **Wann:** beim Start und bei jedem Wechsel des Tages.
- **Was:** nur im Ordner `audit`, nur gewöhnliche Dateien, deren Name genau dem festen Muster entspricht, ohne einem Link zu folgen, und nur Dateien, die dem Benutzer gehören und anderen keine Rechte geben, wie beim Öffnen. Nie die eigene offene Datei. Andere Dateien im Ordner bleiben liegen. Keine Meldung nennt einen Pfad. Ist eine Datei schon weg, etwa weil ein anderer Prozess sie zuerst entfernt hat, gilt sie als gelöscht. Scheitert das Löschen sonst, schreibt der Server eine Logzeile mit der Zahl der Dateien und läuft weiter.
- **Kopien:** Kopien in Backups, in synchronisierten Ordnern, an einem getrennten Ort oder in Logs löscht Ecclium nicht.
- **Tabelle von ADR 0055:** Diese Zeile kommt dazu:

| Variable                         | Werte                    | Voreinstellung | Geheimnis | Nur über stdio | Beim Start                                                                                    |
| -------------------------------- | ------------------------ | -------------- | --------- | -------------- | --------------------------------------------------------------------------------------------- |
| `ECCLIUM_AUDIT_RETENTION_MONTHS` | ganze Zahl von 1 bis 120 | 12             | nein      | ja             | ungültig: Abbruch; unter 12: Warnung; ohne `ECCLIUM_STATE_DIR`: Meldung, dass sie nicht wirkt |

### Leere Dateien

- Der Start öffnet die Datei weiter in seiner ersten Stufe, damit ein Ordner, der nicht taugt, den Start sofort abbricht.
- Beim geordneten Ende prüft der Server am Deskriptor, ob seine Datei null Bytes hat. Dann entfernt er sie nach dem Schliessen, wenn der Pfad noch auf dieselbe Kombination aus Gerät und Inode zeigt. Eine Datei mit einem Rest einer Zeile ist nicht leer und bleibt.
- Leere Dateien, die ein Absturz oder ein Ende ohne Ordnung zurücklässt, entfernt die Löschung beim nächsten Start oder Wechsel des Tages, mit denselben Grenzen wie oben, sobald der Tag im Namen und die letzte Änderung vor dem aktuellen UTC-Tag liegen. Leere Dateien des laufenden Tages bleiben bis dahin, weil sie meist einem laufenden Prozess gehören.
- Auch ein Prozess, der seit einem früheren Tag ohne Aufruf läuft, hält noch eine leere Datei dieses Tages offen, und ein anderer Prozess kann sie entfernen. Beim nächsten Schreiben beginnt er dann eine Datei für den neuen Tag. Das zählt wie jeder Wechsel des Tages nicht zu den 64 Versuchen.

### Kette

- Jede ganze Zeile der Datei trägt `seq` und `prevHash`. `seq` zählt die ganzen Zeilen einer Datei ab 1. `prevHash` ist der SHA-256 der vorigen ganzen Zeile in Bytes, ohne ihren Zeilenumbruch, hexadezimal geschrieben. Die erste Zeile hängt am Namen der Datei: Ihr `prevHash` ist der SHA-256 dieses Namens. So lassen sich Dateien nicht vertauschen oder umbenennen, ohne dass `ecclium audit verify` es sieht.
- Die Felder füllt nur der Schreiber der Datei, nie der Erzeuger eines Ereignisses. Den Hash der letzten Zeile hält er selbst.
- Reste einer Zeile gehören nicht zur Kette. Scheitert eine Zeile, trägt die nächste ganze Zeile dieselbe `seq` und den Hash der letzten ganzen Zeile.
- Eine neue Datei, nach einem Wechsel des Tages oder einem Neuöffnen, beginnt eine neue Kette.
- SHA-256 kommt aus `node:crypto`, ohne neue Abhängigkeit.

### Kettenanker

- Beim Schliessen einer Datei, also beim Ende, beim Wechsel des Tages und beim Neuöffnen, schreibt der Server eine eigene Logzeile auf stderr mit dem Namen der Datei, der `seq` und dem Hash ihrer letzten ganzen Zeile. Mit den Schreib-Tools kommt sie auch nach jedem Schreibvorgang, und sobald es die Metrikdatei des Runners gibt, steht der Anker auch dort.
- Eine Datei ohne Zeile hat keinen Anker. Der Name der Datei nennt Datum, Uhrzeit, die Kennung des Prozesses und eine Folgenummer, keinen Pfad.
- Wer Logs sammelt, und sei es nur mit einer Rotation, hat damit einen Anker ausserhalb der Datei. Wer den Rechner kontrolliert, muss dann auch jede Kopie des Logs fälschen. Fälschungssicher ist das nicht.

### `audit verify` und `audit show`

- `ecclium audit verify` prüft jede Datei im Ordner `audit` gegen ihre Kette und, wenn übergeben, gegen Anker aus einem Log. Es erkennt eine geänderte, fehlende oder zusätzliche Zeile, eine vertauschte Reihenfolge, eine umbenannte oder vertauschte Datei und eine Datei, deren letzte Zeile nicht zum Anker passt, auch eine, die nach dem Anker gekürzt wurde. Ein Anker zu einer Datei, deren Frist abgelaufen ist, gilt ohne die Datei nicht als Fehler.
- `ecclium audit show` fasst die Dateien als deutschen Klartext für Gemeindeleitende zusammen: je UTC-Tag und Tool die Zahl der Aufrufe je Ausgang und die zurückgehaltenen Ergebnisse. Es sucht auch nach einer Kennung wie `person:<Kennung>` und zeigt, wann, mit welchem Tool und unter welchem Subjekt ein Aufruf sie nannte, etwa für eine Auskunft. Die Läufe einer Routine mit `--run` kommen mit dem Runner.
- Beide lesen nur, öffnen jede Datei, ohne einem Link zu folgen, prüfen Ordner und Dateien wie der Start und brauchen die Konfiguration über stdio mit `ECCLIUM_STATE_DIR`. Ihre Ausgabe nennt keine Pfade und Kennungen nur, wenn danach gefragt ist. Sie enden mit Codes nach sysexits und mit Meldungen auf Deutsch.

### Gelesen, aber zurückgehalten

- Hält die Pipeline ein Ergebnis zurück, nachdem ChurchTools geantwortet hat, und steht die Zeile trotzdem in der Datei, etwa weil die Senke sie gleich als Ablehnung schreibt, trägt die Zeile neben `denied` und `policy_denied` ein Merkmal dafür. Ohne das Merkmal sähe sie aus wie eine Ablehnung vor dem Lesen, etwa im `gate`. Es sagt dem Betreiber, dass der Server die Daten gelesen, aber nicht herausgegeben hat.
- Mit Kennungen kann auch das Ergebnis selbst eine Zeile ungültig machen. Dann hält die Pipeline zurück, obwohl gelesen wurde, und das Merkmal macht das in der Datei sichtbar. Es steht nur dort, wie die Kennungen. Auf stderr meldet wie bisher die Logzeile `audit_withheld` jedes zurückgehaltene Ergebnis, ohne Kennungen.

### `fsync`

- Gemessen wird unter macOS und Linux, was `fsync` je Zeile kostet. Bleibt es auf beiden unter 1 ms je Zeile, folgt auf jede Zeile ein `fsync`, bevor `record` `true` gibt. Sonst folgt es beim Anker, beim Wechsel des Tages und beim Schliessen. Messung und Ergebnis stehen unter «Umsetzung».

### Schema und Katalog

- Eine Zeile der Datei ist als JSON Schema in `schemas/audit-event.v1.json` veröffentlicht, erzeugt aus dem zod-Schema in `core` mit `z.toJSONSchema` von zod 4, ohne neue Abhängigkeit. CI prüft wie bei `docs/tools.md`, dass die Datei der Erzeugung entspricht. Die Kopie auf stderr folgt demselben Schema ohne die Felder, die nur in die Datei gehören.
- Ein Katalog nennt jeden Typ eines Ereignisses mit seinen Feldern und ihrer Bedeutung, ebenfalls aus dem Code erzeugt und in CI geprüft.

## Konsequenzen

- Wer Tools mit `sensitivity: special` einschaltet, legt einmal einen privaten Ordner an und setzt eine Variable mehr. Das Audit liegt dann beim Server, gleich was der Client mit stderr macht.
- **Was garantiert ist:** Jedes Ergebnis eines Tools mit `sensitivity: special`, das hinausgeht, hat seine Zeile ganz in der Datei. `ok` heisst an den Transport übergeben, nicht beim Client angekommen. Zeilen anderer Tools können in der Datei fehlen. Der Schreiber zählt sie und nennt die Zahl beim Ende in `audit_file_closed`.
- **Der Betreiber selbst:** Die Datei schützt nicht gegen ihn. Er kann sie löschen, umbenennen, kürzen oder ändern. Die Kette erkennt eine geänderte, fehlende oder vertauschte Zeile und eine umbenannte Datei, Zeilen, die am Ende fehlen, aber nur mit einem Anker. Wer die Datei ändern kann, kann auch die Kette neu berechnen, das zeigt erst der Anker in einer Kopie des Logs. Backups und synchronisierte Ordner kopieren die Datei.
- **Löschen durch den Server:** Ab Phase 4 löscht der Server Dateien. Ein Fehler darin könnte mehr löschen als gewollt, deshalb die engen Grenzen und ein Test, der zeigt, dass nichts ausserhalb davon verschwindet. Leere Dateien des laufenden Tages bleiben bis zum nächsten Tag liegen.
- **Anker:** Endet ein Prozess ohne Ordnung, fehlt der Anker seiner letzten Datei. Ein Anker auf stderr ist nur so viel wert wie die Sammlung der Logs, und liest ein Client stderr nicht, kann er verloren gehen.
- **Zwischen Prüfung und Öffnen:** Derselbe Benutzer kann den Ordner oder `audit` zwischen Prüfung und Öffnen tauschen, weil Node.js kein `openat` hat. Der Abgleich der Inodes nach dem Öffnen macht das Fenster klein, schliesst es aber nicht.
- **ACLs:** Geerbte ACLs prüft niemand. Unter macOS war eine Datei mit 0600 über eine geerbte ACL trotzdem für alle lesbar.
- **Ohne `fsync`** gehen bei einem Absturz des Systems Zeilen verloren, die als geschrieben galten. Kommt `fsync` nach der Messung nur an festen Stellen, gilt das für die Zeilen seit dem letzten.
- **Hängender Ordner:** Ein Ordner auf einem Netzlaufwerk, das nicht antwortet, hält bei jedem Schreiben den ganzen Server an, auch die Antworten und die Signale.
- **Zurückgehaltene Aufrufe** haben bei ChurchTools gelesen und Kontingent verbraucht, und ihre Dauer verrät, dass sie liefen. Die Wache im `gate` vermeidet das, solange die Datei schon vorher kaputt ist.
- **Uhr:** Uhrzeit, Datum der Datei und Wechsel des Tages kommen von der Uhr des Systems. Scheitert die Uhr, meldet die Senke die Zeit, und das Ergebnis eines Tools mit `sensitivity: special` wird zurückgehalten.
- **Leser** zählen nur Zeilen, die mit einem Zeilenumbruch enden, und überspringen Zeilen, die kein JSON sind oder mit `~` enden. Ein Stück ohne Abschluss kann am Ende einer Datei stehen, nach EFBIG mit derselben `eventId` wie die ganze Zeile in der nächsten Datei.
- **Ausnahme ohne Fang:** Sie beendet den Prozess mit 70, und ein laufender Aufruf verliert seine Zeile (ADR 0054). Sein Ergebnis geht dann aber auch nicht hinaus.
- **stderr des Hosts:** Erbt der Server stderr vom Host, macht er auch dessen stderr nicht blockierend, unter macOS gemessen. Das ändert die Datei nicht.
- **Recht:** Die Datei liegt beim Server und damit nicht getrennt vom System. Wer Art. 4 DSV erfüllen muss, kopiert die Dateien selbst an einen getrennten Ort mit beschränktem Zugriff. Ecclium verspricht keine Konformität mit einem Datenschutzrecht. So steht es in [Datenschutz](../privacy.md).
- **Kennungen auf der Platte:** Mit den Kennungen trägt die Datei Personendaten. Wer sie lesen kann, sieht, wessen Daten wann über Ecclium gelesen wurden, auch ohne Namen. Darum gehen die Kennungen nicht nach stderr, und darum hat die Datei eine Frist mit Löschung.
- **Protokoll ohne Pflicht:** Eine Gemeinde, für die kein Recht ein Protokoll verlangt, hat trotzdem eines auf der Platte, ein Jahr lang. Sie kann die Frist kürzen und bekommt beim Start eine Warnung.
- **Ohne Zustandsordner:** Ein Server mit den Toolsets ohne Pflicht zum Ordner, etwa `wiki` oder `calendars`, protokolliert nur auf stderr, ohne Kennungen und ohne Frist. Die Doku rät deshalb, den Ordner immer zu setzen.
- **Lücke der Escape Hatch:** Bei `ct_api_execute_read` stehen nur die Kennungen im Protokoll, nach denen der Aufruf fragt. Personen, die eine Liste ohne solche Kennungen liefert, stehen nicht darin.
- **Ein Subjekt für alle:** Teilen sich mehrere Personen einen Eintrag mit demselben Subjekt, zeigt das Protokoll nicht, wer von ihnen gelesen hat.

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
- Seit dem 31.10.2026 entschieden und noch nicht gebaut: Schema, Katalog und Kennungen samt Klasse `groupId`, dann Kette, Anker, Frist, Löschung, leere Dateien und die Messung zu `fsync`, dann `ecclium audit verify` und `ecclium audit show`. Bis dahin bleibt `objectRefs` leer, und die Dateien haben weder Kette noch Frist.
- Offen: Ob ChurchTools Lesezugriffe über die API selbst je Konto protokolliert, ist nicht geprüft.
