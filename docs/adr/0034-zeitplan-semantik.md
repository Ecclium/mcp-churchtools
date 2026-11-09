# ADR 0034: Zeitplan der Routinen: croner als einzige Quelle, eine Semantik für Daemon und `run-once --due`

- Status: Vorgeschlagen
- Datum: 09.11.2026
- Fällt vor: Phase 6
- Ergänzt: [ADR 0063](0063-quotastore-als-datei.md)

## Kontext

Eine Routine nennt einen Zeitplan als Cron-Ausdruck, etwa «Montag um 06:00» ([ADR 0033](0033-runner-modell-ohne-werkzeuge.md)). Der Runner läuft auf zwei Arten: als Daemon, der selbst die Zeit abwartet, und als Einzellauf `ecclium run-once --due`, den etwas anderes von aussen aufruft, etwa ein Cron-Container alle 15 Minuten oder im gehosteten Betrieb ein Job. Beide müssen dieselben Läufe auslösen. Sonst liefe eine Routine im Self-Hosting anders als gehostet, und ein Fehler zeigte sich nur in einer Betriebsart.

Dazu kommen die bekannten Fallen von Zeitplänen: Zeitzonen, die Wechsel der Sommerzeit, ein Runner, der zur geplanten Zeit nicht lief, zwei Einzelläufe, die sich überschneiden, und ein Lauf, der scheitert. Jeder Lauf mit Modell kostet beim Anbieter, und jeder schreibende Lauf zählt gegen die Obergrenzen der Richtlinie ([ADR 0032](0032-richtlinie-und-pruefcode.md)).

Für die Auswertung von Cron-Ausdrücken ist `croner` vorgesehen. In der Registry von npm geprüft am 09.11.2026: Version 11.0.0 vom 26.10.2026, MIT, ohne Abhängigkeiten, mit Herkunftsnachweis über einen vertrauenswürdigen Herausgeber. Die Linie 10, zuletzt 10.0.1 vom 01.02.2026, trägt keinen Herkunftsnachweis.

## Optionen

1. **Eigener Code für Cron:** keine Abhängigkeit, aber Zeitzonen und Sommerzeit sind genau die Stellen, an denen eigener Code am ehesten falsch rechnet.
2. **Der Zeitplan des Betriebssystems,** etwa cron oder Timer von systemd: nichts im Kern, aber jede Plattform rechnet anders, die Zeitzone liegt ausserhalb von Ecclium, und im gehosteten Betrieb gibt es kein solches cron.
3. **croner als einzige Quelle** für Daemon und Einzellauf, mit einer Funktion im Kern, die beide aufrufen.

## Entscheid

Gewählt ist die dritte Option, mit `croner` 11.0.0.

### Ausdruck und Zeitzone

- Ein Zeitplan hat fünf Felder: Minute, Stunde, Tag des Monats, Monat, Wochentag. Erlaubt sind Zahlen, Bereiche, Listen, Schritte und die englischen Kürzel der Tage und Monate. Ein Feld für Sekunden oder Jahre und weitere Sonderzeichen weist der Lader ab.
- Eine Routine darf Tag des Monats und Wochentag nicht zugleich einschränken. cron und seine Nachbauten lesen diese Verbindung verschieden, als «und» oder als «oder», und eine Routine soll keine Lesart brauchen.
- Die Zeitzone kommt aus der Konfiguration als Name nach IANA, voreingestellt `Europe/Zurich`. Ein unbekannter Name bricht den Start ab.
- Eine Auslösung, deren Zeit es beim Wechsel zur Sommerzeit nicht gibt, findet zur ersten Zeit danach statt, die es gibt. Eine, deren Zeit es beim Wechsel zur Winterzeit zweimal gibt, findet einmal statt, beim ersten Mal. Ob croner 11.0.0 sich so verhält, prüfen Tests für beide Wechsel. Tut es das nicht, gleicht der Kern es aus und hält das unter «Umsetzung» fest. Die Doku rät zu Zeiten ausserhalb der Stunde von 02:00 bis 03:00, in der die Wechsel in Mitteleuropa liegen.
- `croner` lädt nur ein Modul im Kern, gehalten von einer Regel wie bei `yaml`. Es ist genau gepinnt, und eine neue Version sieht eine Person vor dem Merge an.

### Fällig

- Fällig ist für eine Routine die letzte geplante Auslösung bis jetzt, wenn sie höchstens 31 Tage zurückliegt und noch nicht abgeschlossen ist (unten). Ältere verpasste Auslösungen holt der Runner nicht nach. War er eine Woche aus, läuft ein wöchentlicher Bericht einmal, für die Periode der letzten Auslösung. Eine Routine, die seltener als monatlich auslöst, läuft nur, wenn der Runner in den 31 Tagen nach ihrer Auslösung läuft.
- Das rechnet eine einzige Funktion des Kerns aus Ausdruck, Zeitzone, der Uhr des Kerns und dem Gedächtnis unten, auch die Wiederholung. Der Daemon ruft sie zu jeder Auslösung, zu jeder Zeit einer Wiederholung und einmal beim Start, `run-once --due` bei jedem Aufruf.
- Relative Angaben einer Routine, etwa `from: "+0d"` einer Eingabe, zählen ab der geplanten Auslösung, nicht ab der Zeit des Laufs. Ein verspäteter Lauf liest so denselben Zeitraum wie ein pünktlicher.
- Abgeschlossen ist eine Auslösung, sobald ein Lauf für sie geschrieben hat, nichts zu ändern fand, seinen Schreibwunsch in die Freigabe-Warteschlange legte oder aus einem Grund endete, den eine Wiederholung nicht ändert: ein Kill-Switch, eine Ablehnung der Richtlinie, eine ungültige Antwort des Modells nach dem erlaubten zweiten Versuch ([ADR 0033](0033-runner-modell-ohne-werkzeuge.md)) oder ein Verstoss gegen die ContentPolicy. Die Meldung nach dem Lauf nennt den Grund.
- Wiederholt wird nur ein Lauf, der an einer vorübergehenden Störung scheiterte: der Anbieter des Modells oder ChurchTools nicht erreichbar, eine Frist abgelaufen, eine Antwort mit 429 oder 5xx, der `QuotaStore` nicht verfügbar. Mit dem ersten Lauf gibt es höchstens drei Versuche je Auslösung, jeder frühestens 15 Minuten nach dem vorigen. Danach wartet die Routine auf ihre nächste Auslösung. So wiederholen Daemon und Einzellauf gleich, auch wenn jemand den Einzellauf jede Minute aufruft.

### Periode

- Die Periode eines Laufs kommt aus der geplanten Auslösung in der Zeitzone der Konfiguration, nie aus der Zeit des Laufs: `{isoWeek}` als Woche nach ISO 8601 wie `2026-W46`, `{date}` wie `2026-11-09` und `{month}` wie `2026-11`.
- `idempotencyKey` einer Routine ist ihre Kennung, ein Doppelpunkt und genau einer dieser Platzhalter, etwa `dienstplan-report:{isoWeek}`. Der Wert des Platzhalters ist die Periode, die in die Kennzeichnung und in den Prüfcode geht ([ADR 0032](0032-richtlinie-und-pruefcode.md)).
- Löst ein Zeitplan in einer Periode mehrmals aus, ändert ein späterer Lauf den Abschnitt seiner Periode oder lässt ihn stehen und verdoppelt ihn nie ([ADR 0033](0033-runner-modell-ohne-werkzeuge.md)).

### Gedächtnis der Läufe

- Ob eine Auslösung einer Routine abgeschlossen ist und wie viele Versuche sie hatte, hält der `QuotaStore` fest ([ADR 0063](0063-quotastore-als-datei.md)), in einer eigenen Art Datei wie die verbrauchten Freigaben: zwei Zähler je Auslösung unter Schlüsseln aus Kennung der Routine und Zeitpunkt der Auslösung, nie Inhalt, je Mandant. Die Datei bleibt 32 Tage nach dem Tag der Auslösung, so lange wie die längste Periode und einen Tag länger, und deckt damit die 31 Tage, in denen eine Auslösung fällig sein kann. Einen Port neben `PlanStore`, `NonceStore` und `QuotaStore` braucht es dafür nicht ([ADR 0051](0051-zustand-zwischen-anfragen.md)). Entschieden am 09.11.2026 mit dem Plan für Phase 6.
- Die Schnittstelle für Plugins bekommt dafür eine neue Form der Schlüssel neben `special_reads`, den Schlüsseln der Richtlinie und der Freigaben, und eine feste Frist wie `approvalCountDays`. Ein Ersatz des `QuotaStore` aus einem Plugin muss sie kennen und besteht dafür dieselben Prüfungen aus `testkit`.
- Ist der `QuotaStore` nicht verfügbar, beginnt kein Lauf, weil der Runner nicht wüsste, ob eine Auslösung schon lief und ob eine Obergrenze erreicht ist.
- Fehlt das Gedächtnis, etwa nach dem Verlust des Zustandsordners, läuft die letzte Auslösung jeder Routine noch einmal. Im Wiki schreibt sie dank Prüfcode nichts doppelt, eine Datei ersetzt sie, und es kostet einen Aufruf des Modells.

### Überschneidung und Läufe von Hand

- Eine Sperrdatei je Routine im Zustandsordner verhindert, dass zwei Prozesse dieselbe Routine zugleich ausführen, nach dem Vorbild der Sperrdatei des `QuotaStore` ([ADR 0063](0063-quotastore-als-datei.md)). Sie nennt Prozess, Rechner und Beginn. Weil ein Lauf Minuten dauern kann, gilt sie erst als verlassen, wenn sie älter ist als die feste Höchstdauer eines Laufs, nach der der Runner einen Lauf abbricht, oder wenn ihr Prozess auf demselben Rechner nicht mehr läuft. Ein zweiter Prozess überspringt die Routine und sagt es, das zählt nicht als Versuch. Wer die Sperre hat, prüft unter ihr noch einmal, ob die Auslösung fällig ist.
- `ecclium run-once <Routine>` führt eine Routine von Hand aus, mit der Periode ihrer letzten Auslösung, auch wenn sie nicht fällig ist. Der Lauf zählt gegen die Obergrenzen der Richtlinie wie jeder andere, und schliesst er ab, gilt auch diese Auslösung als abgeschlossen.
- Die Exit-Codes und das Verhalten bei Signalen legt der Runner-Container-Vertrag fest (ADR 0036).

## Konsequenzen

- `croner` 11.0.0 kommt als Laufzeitabhängigkeit ins Produktpaket, gebündelt. Die Linie 10 kommt nicht in Frage, weil sie keinen Herkunftsnachweis trägt.
- Daemon und Einzellauf haben eine Semantik. Wer den Einzellauf öfter aufruft, als Routinen fällig werden, verursacht keine zusätzlichen Läufe.
- Eine neue Variable für die Zeitzone kommt mit ihrem Bau in die Tabelle von [ADR 0055](0055-konfiguration-identitaet.md).
- **Restrisiken:**
  - Geht die Uhr des Rechners falsch, laufen Routinen zur falschen Zeit oder in der falschen Periode. `ecclium doctor` prüft die Uhr, sobald es ihn gibt.
  - Ein Lauf, der kurz vor dem Ende seiner Periode beginnt und danach endet, gehört zur Periode seiner Auslösung. Das ist gewollt, kann aber überraschen.
  - Drei Versuche je Auslösung können bei einem gestörten Anbieter dreimal kosten.
  - Ein Prozess, der abstürzt, hält die Sperre seiner Routine bis zur Höchstdauer eines Laufs, wenn der Kern nicht sehen kann, ob er noch läuft, etwa in einem anderen Container.

## Umsetzung

- **Form des Zeitplans, seit dem 09.11.2026:** `packages/workflows/src/routine/schedule.ts` prüft beim Laden einer Routine die fünf Felder mit einem Leerzeichen dazwischen, Bereiche von Minute (0 bis 59), Stunde (0 bis 23), Tag des Monats (1 bis 31), Monat (1 bis 12 oder `JAN` bis `DEC`) und Wochentag (0 bis 6 oder `SUN` bis `SAT`), Bereiche mit Anfang nicht nach dem Ende, Schritte von 1 bis zur Grösse des Felds nach `*` oder einem Bereich und Listen mit Kommas, der ganze Zeitplan höchstens 100 Zeichen. Die 7 für Sonntag und einen Wert mit Schritt wie `5/15` nimmt er nicht an, weil Nachbauten von cron sie verschieden lesen. Tag des Monats und Wochentag gelten als eingeschränkt, sobald das Feld nicht genau `*` ist. Ob ein Zeitplan überhaupt je auslöst, etwa am 31. Februar, prüft croner, sobald es die Fälligkeit rechnet.
