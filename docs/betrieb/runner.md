# Runner der Routinen

**In Entwicklung.** Es gibt noch keine veröffentlichte Version. Diese Seite beschreibt `ecclium run-once` und den Daemon `ecclium runner`, so wie sie heute gebaut sind, und unter «Container», was der Runner in einem Container vorfinden muss.

Der Runner führt Routinen nach ihrem Zeitplan aus: Er liest Daten aus ChurchTools, gibt sie maskiert einem Sprachmodell oder prüft sie mit festen Prüfungen des Kerns, prüft das Ergebnis und schreibt einen Abschnitt ins Wiki oder einen Entwurf als Datei ([Routinen](../routines.md), [Richtlinie](../policy.md), [Anbieter](../providers.md)). Er läuft ohne Menschen, deshalb schreibt er ins Wiki nur, was die Richtlinie erlaubt.

Ecclium ist ein unabhängiges Projekt und steht in keiner Verbindung zum Hersteller von ChurchTools.

## Konfiguration

Der Runner liest dieselben Variablen wie der Server ([Konfiguration](../configuration.md)), mit diesen Unterschieden:

- Pflicht sind `ECCLIUM_TIME_ZONE`, `ECCLIUM_POLICY_FILE`, `ECCLIUM_ROUTINES_DIR`, `ECCLIUM_STATE_DIR`, `ECCLIUM_KILL_SWITCH_DIR` und `ECCLIUM_RUNNER_TOKENS_DIR`, dazu entweder `ECCLIUM_EGRESS_PROXY` oder `ECCLIUM_EGRESS=off` (siehe «Ausgehender Weg»).
- Der Runner liest nie das Token des Servers. `ECCLIUM_CHURCHTOOLS_TOKEN_FILE` und `ECCLIUM_CHURCHTOOLS_TOKEN` halten ihn vom Start ab. Sein eigenes Konto liegt als `ct_token_runner` im Ordner aus `ECCLIUM_RUNNER_TOKENS_DIR`, jedes Konto, das die Richtlinie nennt, als `ct_token_<Alias>` daneben, jede Datei mit den Rechten 400 oder 600. Mit dem eigenen Konto liest eine Routine, für die die Richtlinie keinen Eintrag hat. Jeder Lauf liest seine Token-Datei neu, ein neues Token wirkt also ohne Neustart.
- Schreibt eine Routine ins Wiki, verlangt der Runner `ECCLIUM_READ_ONLY=false` mit allem, was das Schreiben sonst braucht. Sonst startet er nicht, weil ein Lauf lesen und das Modell fragen würde, ohne zu schreiben.
- Für einen Entwurf als Datei braucht die Routine `ECCLIUM_DRAFTS_DIR`, den Ordner der Kill-Switches aus `ECCLIUM_KILL_SWITCH_DIR` und unter `interactive.inquiriesTo` in der Richtlinie, wen Leserinnen und Leser fragen können, auch mit `ECCLIUM_READ_ONLY=true`.
- Für Meldungen in eine Datei braucht die Routine `ECCLIUM_NOTIFY_FILE`.
- Eine Metrikdatei schreibt der Runner nur mit `ECCLIUM_RUNNER_METRICS_FILE` (siehe «Metrikdatei»), einen Ping an eine Überwachung nur mit `ECCLIUM_RUNNER_PING_URL_FILE` (siehe «Ping an eine Überwachung»).
- Den Ordner der Entwürfe, die Datei der Meldungen und die Metrikdatei legen Sie nicht in einen Ordner, den Ecclium selbst füllt oder der die Kill-Switches hält: weder in den Ordner der Schlüssel noch in den der Token-Dateien oder der Kill-Switches, noch in einen der Ordner `audit`, `quota`, `snapshots`, `queue`, `runner` oder `stop` des Zustandsordners. Ein eigener Ordner wie `output` im Zustandsordner geht. Die Metrikdatei ist zudem keine andere Datei der Konfiguration, etwa die Datei der Meldungen, die Richtlinie oder eine Schlüsseldatei, liegt nicht im Ordner der Routinen, und ihr Name beginnt mit einem Buchstaben oder einer Ziffer und hat höchstens 128 Zeichen aus Buchstaben ohne Umlaute, Ziffern, Punkt, Bindestrich und Unterstrich.
- Eine Routine mit Modell gibt dem Modell ihre Daten in der Stufe `strict`, ausser ein Eintrag der Richtlinie erlaubt `standard`. Dafür braucht sie die Schlüsseldatei der Pseudonyme in `ECCLIUM_PSEUDONYM_KEY_FILE` ([Betrieb über stdio](stdio.md), «Schlüsseldatei anlegen»), auch für eine Vorschau.
- Eine Routine mit den Prüfungen des Kerns, wie `wiki-hygiene`, hat kein Modell und braucht deshalb keine Datei der Anbieter. Ihre Prüfungen lesen in der Stufe `standard`, weil sie ihre Daten keinem Modell geben, und brauchen deshalb auch keine Schlüsseldatei der Pseudonyme ([Routinen](../routines.md), «Prüfungen des Kerns»).

`ecclium config check --runner` prüft all das ohne ChurchTools und ohne die Modelle anzufragen und nennt jede Routine mit Zeitplan, Ziel, Konto und Modell, eine Routine ohne Modell mit ihren Prüfungen.

## Befehle

- `ecclium run-once --due` führt jede Routine aus, die fällig ist, eine nach der anderen, und endet dann. Ein Container, den cron alle 15 Minuten startet, ruft diesen Befehl auf. Ob eine Routine fällig ist, entscheidet ihr Zeitplan in der Zone aus `ECCLIUM_TIME_ZONE`: die letzte Auslösung der letzten 31 Tage, die noch nicht abgeschlossen ist. Scheitert ein Lauf an einer vorübergehenden Störung, versucht ein späterer Aufruf es noch zweimal, frühestens 15 Minuten danach. Bei einer stündlichen Routine bleibt es bei einem weiteren Versuch, weil der dritte auf ihre nächste Auslösung fiele.
- `ecclium run-once <Routine>` führt eine Routine von Hand aus, mit der Periode ihrer letzten Auslösung, auch wenn sie nicht fällig ist. Der Lauf zählt gegen die Grenzen der Richtlinie wie jeder andere.
- `ecclium runner` ist der Daemon: Er startet einmal und führt dann jede Routine zu ihrer Zeit aus, bis ein Signal ihn anhält (siehe «Daemon»).
- `ecclium run-once <Routine> --preview` zeigt den Abschnitt, den ein Lauf schreiben würde, auf stdout und schreibt nichts. Die Vorschau läuft auch, bevor die Richtlinie einen Eintrag für das Ziel hat, und mit `ECCLIUM_READ_ONLY=true`. So sehen Sie den Abschnitt, bevor Sie den Eintrag in die Richtlinie aufnehmen. Lesen und Modell kosten wie bei einem Lauf. Ein Kill-Switch und die Sperre des Schreibens halten eine Vorschau nicht an, weil sie nichts schreibt; die Daten gehen trotzdem maskiert an das Modell.

Läuft eine Routine schon in einem anderen Prozess, überspringt ein zweiter Aufruf sie. Daemon und `run-once` dürfen also nebeneinander laufen, etwa für einen Lauf von Hand. Ein Lauf dauert höchstens 30 Minuten, danach bricht der Runner Lesen und Modell ab. Einen Schreibvorgang, der begonnen hat, bricht er dafür nie ab.

`ecclium audit show --run <Lauf>` zeigt einen Lauf aus dem Audit: Routine, Periode und Versuch, Beginn und Ende, den Ausgang mit Schritt und Code, die Lesungen je Tool und die Schreibvorgänge je Bestätigungsweg. Die Kennung des Laufs steht in seiner Meldung und in seiner Zeile auf stderr.

## Daemon

`ecclium runner` startet mit denselben Prüfungen wie `run-once --due` und nennt jede Routine, die nicht startet. Startet keine, endet er mit 78. Danach sieht er die Routinen beim Start an, dann zur frühesten Zeit, zu der eine fällig wird oder ihren nächsten Versuch hat, und spätestens alle 15 Minuten, damit eine Uhr, die springt, oder ein Rechner, der schlief, nichts verliert. Jeder dieser Durchgänge ist derselbe wie bei `run-once --due`. Auf stderr steht nur etwas, wenn eine Routine lief oder nicht laufen konnte; eine Routine, die nicht startet, nennt er bei jedem Durchgang.

Den Ordner der Routinen, die Richtlinie und die Datei der Anbieter liest der Daemon beim Start. Änderungen daran wirken nach einem Neustart. Tokens und Schlüssel der Modelle liest er für jeden Lauf neu.

Kommt eine Zeile des Audits nicht in die Audit-Datei, etwa bei voller Platte, schreibt der Prozess bis zu einem Neustart nichts mehr. Der Daemon beendet dann den laufenden Durchgang und sich selbst mit 75, damit ein Neustart, etwa durch die Regel `restart` von Docker Compose, die Sperre hebt. Mehr als drei Versuche einer Auslösung gibt es auch so nicht.

## Signale

SIGTERM, SIGINT und SIGHUP brechen Lesen, Modell und die Suche der Seite sofort ab, weil sie ausserhalb nichts ändern. Ein Schreibvorgang oder Entwurf, der schon begonnen hat, endet noch, beim Wiki mit Snapshot und Lesen danach, und mit seiner Zeile im Audit, dem Ende seiner Auslösung und seiner Meldung. Danach beginnt keine Routine mehr. Bei einem Lauf, der noch nicht schrieb, bleibt die Auslösung offen, der Versuch zählt, und ein späterer Aufruf versucht es wieder. Der Prozess endet so:

| Signal  | Exit-Code |
| ------- | --------- |
| SIGTERM | 143       |
| SIGINT  | 130       |
| SIGHUP  | 129       |

SIGHUP kommt etwa, wenn das Terminal des Prozesses geschlossen wird. Ein zweites Signal beendet den Prozess sofort, ausser während eines Schreibvorgangs: Dann endet er direkt danach. Andere Signale wie SIGKILL halten ihn hart an.

Ein Schreibvorgang ins Wiki beginnt, sobald der Runner die Seite gefunden hat. Nennt die Richtlinie die Seite mit ihrer Kennung (`wiki_page`), sendet er dann bis zu fünf Anfragen an ChurchTools. Erlaubt sie eine ganze Kategorie (`wiki_category`), liest er zusätzlich zweimal den Namen der Kategorie, also bis zu sieben Anfragen an ChurchTools mit je höchstens 30 Sekunden. Dazu greift er zweimal auf die Zähler im Zustandsordner zu, je höchstens 5 Sekunden. Geben Sie einem Container des Runners beim Stoppen deshalb mindestens 5 Minuten, bei Docker Compose mit `stop_grace_period: 5m`, bei `docker stop` mit `--time 300`, damit ein Schreibvorgang nicht von SIGKILL getroffen wird. Das lässt Platz für zwei Anfragen mehr. So viel Zeit lässt auch die Sperrdatei einer Routine einem abgebrochenen Lauf für sein Ende. Läuft kein Schreibvorgang, endet der Runner sofort; die Frist verlängert das Stoppen dann nicht.

Die Suche der Seite gehört nicht zum Schreibvorgang. Bei `wiki_page` liest der Runner die Seite über ihre Kennung, bei `wiki_category` sucht er sie über ihren Titel in bis zu 40 Seiten der Liste der Kategorie. Ein Signal bricht diese Suche sofort ab, und die Auslösung bleibt offen wie bei einem Lauf, der noch nicht schrieb.

## Frist der Daten

Der Runner löscht wie der Server, was seine Frist überschritten hat: Audit-Dateien nach `ECCLIUM_AUDIT_RETENTION_MONTHS`, Snapshots nach 30 Tagen und Einträge der Freigabe-Warteschlange nach 14 Tagen, jeweils mit ihren Tagesschlüsseln ([Datenschutz](../privacy.md)). `run-once` tut das bei jedem Aufruf, der Daemon beim Start und an jedem neuen UTC-Tag. Eine Vorschau löscht nichts.

## Anhalten

Kill-Switches sind Dateien im Ordner aus `ECCLIUM_KILL_SWITCH_DIR`, im Container `/config/stop` (siehe «Container»). Nur dass die Datei da ist, zählt:

- `writes-off` hält jeden Lauf an,
- `writes-off-<Mandant>` die Läufe eines Mandanten (`writes-off-default` über stdio und im Runner),
- `writes-off-routine-<Routine>` die Läufe einer Routine.

Ecclium legt den Ordner nicht an und prüft nicht, wem er gehört, damit Sie einen Kill-Switch ohne Rechte von root anlegen können. Weder die Gruppe noch andere dürfen darin schreiben, etwa mit den Rechten 755, weil sie einen Kill-Switch sonst entfernen könnten. Fehlt der Ordner oder dürfen sie es doch, startet ein Runner nicht, der ins Wiki schreibt, und eine Routine mit Entwurf ebenso nicht. Der Ordner darf im Zustandsordner liegen, aber nicht in einem der Ordner, die Ecclium dort selbst füllt.

Ein angehaltener Lauf liest nichts und schickt dem Modell keine Daten. Er endet endgültig, die Auslösung gilt als abgeschlossen. Nach dem Entfernen der Datei läuft die Routine zu ihrer nächsten Auslösung, oder Sie starten sie mit `ecclium run-once <Routine>` von Hand.

## Rücknahme

`ecclium undo --run <Lauf>` nimmt zurück, was ein Lauf im Wiki geschrieben hat, auch einen Abschnitt, den Sie mit `ecclium queue approve` aus der Freigabe-Warteschlange freigegeben haben, den neuesten Schreibvorgang zuerst. Hat jemand die Seite seither geändert, zeigt der Befehl den Unterschied und schreibt erst mit `--overwrite`. Er schreibt mit dem Konto, das die Richtlinie für die Routine nennt, nie mit dem Token des Servers, also mit der Token-Datei aus `ECCLIUM_RUNNER_TOKENS_DIR`, und er lädt die Konfiguration wie `ecclium undo` und `ecclium queue`. Läuft die Routine gerade, endet er mit 75; versuchen Sie es nach dem Lauf erneut. Der Kill-Switch der Routine hält eine Rücknahme nicht an, `writes-off` schon. Zurücknehmen lässt sich, was nicht älter als 30 Tage ist ([Sicherheit](../security.md#rücknahme)).

## Neuer Schlüssel des Prüfcodes

Geht der Schlüssel aus `ECCLIUM_MARKER_KEY_FILE` verloren oder ersetzen Sie ihn, passt der Prüfcode keines bestehenden Abschnitts mehr ([Sicherheit](../security.md#schlüssel-des-prüfcodes)). Der nächste Lauf einer Periode, die schon einen Abschnitt hat, legt seinen dann in die Freigabe-Warteschlange. So übernehmen Sie den alten Abschnitt:

1. `ecclium marker adopt --run <Lauf>` mit der Kennung des Laufs, der den Abschnitt in die Freigabe-Warteschlange stellte, oder eines anderen Laufs derselben Routine und Periode, der zu Ende lief. Der Befehl zeigt Seite, Periode, den Abschnitt, die Zeile der Kennzeichnung jetzt und neu und einen Prüfwert, und er schreibt nichts.
2. Stimmt der Abschnitt, rufen Sie den Befehl mit `--confirm <Prüfwert>` auf. Er liest die Seite neu und ändert nur den Prüfcode in der Zeile, mit dem Konto der Routine. Mit `ecclium undo <Kennung>` nehmen Sie das zurück.
3. Weisen Sie den wartenden Eintrag, den der Befehl nennt, mit `ecclium queue reject <Kennung>` ab. Eine Freigabe hängte den Abschnitt ein zweites Mal an. Der nächste Lauf der Periode ersetzt den Abschnitt jetzt wie gewohnt, von Hand mit `ecclium run-once <Routine>`.

Der Befehl lädt die Konfiguration wie `ecclium undo` und braucht `ECCLIUM_READ_ONLY=false`, `ECCLIUM_STATE_DIR`, eingeschaltete Snapshots, `ECCLIUM_MARKER_KEY_FILE` mit dem neuen Schlüssel und einen Lauf, dessen Ende das Audit mit seiner Periode festhält; ein Lauf, dessen Prozess abbrach, taugt nicht. Er braucht ausserdem einen Eintrag der Routine mit dem Ziel `wiki_page`, wie ihn `ecclium policy init --routine` vorschlägt, und einen Snapshot des Schreibvorgangs, der den Abschnitt hinterliess, also nicht älter als 30 Tage. Hat jemand den Abschnitt oder den Text darüber seither geändert, die Seite im Web-Editor gespeichert oder ein späterer Lauf derselben Periode den Abschnitt ersetzt, zeigt er nur den Bereich und signiert nichts; dann bleibt die Freigabe-Warteschlange der Weg. Läuft die Routine gerade, endet er mit 75. Der Kill-Switch der Routine hält ihn nicht an, `writes-off` und der des Mandanten schon.

## Entwürfe

Eine Routine mit dem Ziel `draft` und dem Kanal `file` schreibt ihren Entwurf als `<Routine>-<Periode>.md` in den Ordner aus `ECCLIUM_DRAFTS_DIR`, etwa `termin-vorschau-2026-W46.md`. Ein zweiter Lauf derselben Periode ersetzt die Datei. Am Ende steht die Kennzeichnung, etwa «Automatisch erstellt am 10.11.2026 durch Ecclium, Routine termin-vorschau, Lauf 2026-W46. Rückfragen an Sekretariat.» Einen Prüfcode trägt ein Entwurf nicht, weil ihn keine Seite im Wiki hält.

Ein Entwurf enthält Namen von Personen. Der Runner legt den Ordner mit den Rechten 700 und jede Datei mit 600 an. Wie lange Entwürfe liegen bleiben, entscheiden Sie: Ecclium löscht sie nicht ([Datenschutz](../privacy.md)). Löschen Sie einen Entwurf, sobald er weitergegeben ist.

## Meldungen

Nennt eine Routine unter `notify` einen Kanal, meldet der Runner jeden Lauf als eine Zeile JSON, auf stdout oder angehängt an die Datei aus `ECCLIUM_NOTIFY_FILE`:

```json
{
  "time": "2026-11-16T05:00:42.000Z",
  "routine": "dienstplan-report",
  "period": "2026-W47",
  "run": "run-id-1",
  "result": "written"
}
```

`result` ist `written`, `unchanged`, `queued`, `drafted` oder `failed`, bei `failed` steht `code` dabei und meist `step`, der Schritt, in dem der Lauf endete. Eine Meldung enthält nie einen Inhalt. Die Datei entsteht mit den Rechten 600, und Ecclium folgt keinem Link an ihrem Pfad. Rotieren Sie sie wie ein Log.

Was der Runner zu jeder Routine tut, steht ausserdem auf Deutsch auf stderr, zwischen den Zeilen des Logs und den Kopien des Audits. Zu Beginn nennt er für jedes Modell, das er braucht, Anbieter, Modell, Land und die Grundlage einer Übermittlung ausserhalb der Schweiz und des EWR.

## Metrikdatei

Mit `ECCLIUM_RUNNER_METRICS_FILE` schreibt der Runner eine Metrikdatei im Textformat von Prometheus, der Daemon nach jedem Durchgang, `run-once` nach jedem Aufruf ausser einer Vorschau. Die Datei enthält keine Personendaten:

```text
ecclium_runner_next_run_timestamp_seconds{routine="dienstplan-report"} 1794805200
ecclium_runner_last_success_timestamp_seconds{routine="dienstplan-report"} 1794200412
ecclium_runner_last_status{routine="dienstplan-report",status="written"} 1
ecclium_runner_last_status{routine="wiki-hygiene",status="refused",code="run_target_unlisted"} 1
ecclium_runner_audit_chain_head{file="audit-2026-11-11-200000-4242-1.jsonl",hash="…"} 42
```

- `next_run` ist die Zeit in Sekunden seit 1970, zu der der Runner die Routine wieder ansieht: ihre nächste Auslösung oder ihr nächster Versuch. Liegt sie beim Daemon deutlich zurück, läuft er nicht mehr.
- `last_success` ist das Ende des letzten Laufs, der geschrieben, nichts zu ändern gefunden, eingereiht oder einen Entwurf geschrieben hat.
- `last_status` nennt den Ausgang des letzten Laufs, `written`, `unchanged`, `queued`, `drafted` oder `failed`, `refused` für eine Routine, die nicht startet, oder warum ein Lauf nicht begann: `halted`, `read_only`, `unavailable`, `lock_failed`, `not_opened` oder `internal`. Bei `failed`, `refused` und `not_opened` steht der Code dabei.
- `audit_chain_head` ist der Kopf der Kette der Audit-Datei, die der Runner zuletzt geschrieben hat: Name, Nummer und SHA-256 der letzten ganzen Zeile. Wer die Metrikdatei sammelt, hat damit einen Anker ausserhalb der Datei für `ecclium audit verify`.

Die Zeiten sind Werte, keine Zeitstempel je Zeile, weil der Textfile-Collector von node_exporter keine nimmt. Der Runner ersetzt die Datei in einem Schritt. Er liest dabei seine letzte Datei und führt die Werte der Routinen weiter, die er nicht ausgeführt hat; eine Datei, die nicht genau in seinem Format ist, ersetzt er ganz. Die Datei entscheidet nie über einen Lauf.

Wie jede Datei von Ecclium ist sie privat: Der Runner legt ihren Ordner mit den Rechten 700 an, falls er fehlt, und die Datei mit 600. Ein bestehender Ordner, der dem Benutzer des Runners nicht gehört oder Rechte für andere hat, hält den Runner vom Start ab. Eine Überwachung liest die Datei deshalb als derselbe Benutzer. Lässt sich die Datei nicht schreiben, endet `run-once` mit 74, der Daemon meldet es auf stderr und versucht es beim nächsten Durchgang wieder.

## Ping an eine Überwachung

Mit `ECCLIUM_RUNNER_PING_URL_FILE` meldet der Runner jeden Durchgang, in dem er etwas zu tun hatte, an eine Prüfung im Format von [Healthchecks](https://healthchecks.io/docs/http_api/), beim gehosteten Dienst wie bei einem selbst betriebenen ([ADR 0009](../adr/0009-positivliste-ausgehend.md)). So erfahren Sie, wenn der Runner nicht mehr läuft oder ein Lauf Ihre Aufmerksamkeit braucht, ohne die Metrikdatei zu sammeln.

- Die Variable nennt eine Datei, die nur die Ping-URL enthält, etwa `https://hc-ping.com/<uuid>`, `https://hc-ping.com/<key>/<slug>` oder bei einem eigenen Dienst `https://health.example.org/ping/<uuid>`. Wer die Adresse kennt, kann der Prüfung einen Erfolg oder einen Fehler melden. Die Datei gehört deshalb dem Benutzer des Runners und hat die Rechte 600, wie eine Token-Datei. Ecclium nimmt nur `https` mit einem Namen, der einen Punkt hat, keine IP-Adresse, keinen Benutzer und keine Query.
- Der Runner liest die Datei bei seinem Start. Eine neue Adresse gilt nach einem Neustart. `ecclium config check --runner` prüft die Datei und zeigt den Port, mit `--show-values` auch den Host, nie den Pfad der Adresse.
- Nach jedem Durchgang, in dem eine Routine fällig war oder von Hand lief, sendet der Runner ein `POST` ohne Inhalt und ohne Kopfzeile `Authorization`: an die Adresse, wenn alles gelang, an die Adresse mit `/fail`, wenn ein Lauf endgültig scheiterte, ein vorübergehender Fehler auch beim zweiten Versuch einer Auslösung auftrat oder einen Lauf von Hand beendete, eine fällige Routine ihren Lauf nicht beginnen konnte, ein Lauf seine Meldung, seine Zeile im Audit oder seinen Abschluss im Gedächtnis der Läufe nicht schreiben konnte, das Schreiben nach einer Zeile des Audits, die ihre Datei nicht erreichte, gesperrt ist oder eine Routine des Runners nicht startet. Nach einem vorübergehenden Fehler beim ersten Versuch einer Auslösung sendet er nichts, der nächste Versuch entscheidet. Schon der zweite Versuch zählt, weil der dritte einer stündlichen Routine auf ihre nächste Auslösung fiele und nie käme. Eine Vorschau und ein Durchgang ohne fällige Routine senden nie einen Ping, und nach einem Signal wartet der Runner nicht auf einen.
- Ein späterer Durchgang, der gelingt, setzt eine Prüfung, die auf «down» steht, wieder auf «up».
- Setzen Sie die Frist (Period) der Prüfung auf den grössten Abstand zwischen zwei Durchgängen mit einer fälligen Routine, etwa einen Tag bei einer täglichen Routine oder sieben Tage, wenn alle nur wöchentlich laufen. Sicher ist der längste Zeitplan Ihrer Routinen, weil auch eine Routine, die nicht mehr startet, dann keinen falschen Alarm auslöst. Die Kulanzzeit (Grace) setzen Sie so, dass die zwei Wiederholungen nach einem vorübergehenden Fehler darin Platz haben, also mindestens eine Stunde. Der Daemon sendet keinen Ping, solange keine Routine fällig ist.
- Mit `ECCLIUM_EGRESS_PROXY` geht der Ping über den Proxy wie jede andere Verbindung, sein Host muss dort also erlaubt sein. Die Liste aus `ecclium init egress` nennt ihn, nie den Pfad der Adresse ([Grenze im Netz mit Squid](egress.md)). Der Ping wartet höchstens 15 Sekunden und wird nicht wiederholt. Scheitert er, steht im Log ab der Stufe `warn` eine Zeile mit `purpose` `ping`, etwa `http_status` mit dem Status oder `http_timeout`, nie die Adresse. Kein Lauf und kein Exit-Code ändert sich dadurch, und das Audit nennt den Ping nicht.
- Der Dienst der Prüfung sieht, wann der Runner meldet, ob mit Erfolg oder Fehler, seine IP-Adresse und den User-Agent mit der Version von Ecclium, nie Daten aus ChurchTools.

## Ausgehender Weg

Der Runner liest fremde Texte und schreibt danach. Er soll deshalb nur über einen Proxy nach aussen gehen, der nur die Ziele der Konfiguration durchlässt ([ADR 0035](../adr/0035-proxy-und-grenze-im-netz.md)). Er startet nur mit `ECCLIUM_EGRESS_PROXY`, etwa `http://egress:3128`, oder mit `ECCLIUM_EGRESS=off`. Mit einem Proxy prüft er bei jedem Start einen Tunnel zu ChurchTools, ohne eine Anfrage zu senden, und endet mit 69, wenn der Proxy ihn nicht gibt. Mit `off` läuft er ohne Grenze im Netz, warnt bei jedem Start, und jede Zeile eines Laufs im Audit trägt `egressOff`. Ein Runner ausserhalb von Docker, etwa für einen Lauf von Hand, braucht deshalb einen Proxy oder `ECCLIUM_EGRESS=off`. `HTTP_PROXY` und `HTTPS_PROXY` nutzt Ecclium nicht. Die Vorlage für Squid, die Liste der Ziele aus `ecclium init egress` und Ziele im lokalen Netz beschreibt [Grenze im Netz mit Squid](egress.md). Ob der Weg so steht und welche Rechte der Konten des Runners zu weit sind, prüft [`ecclium doctor`](doctor.md).

## Exit-Codes

| Code | Bedeutung                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Nichts war fällig, oder jeder Lauf hat geschrieben, nichts zu ändern gefunden, eingereiht oder einen Entwurf geschrieben. Eine Routine, die ein anderer Prozess hält, zählt bei `--due` nicht als Fehler.                                                                                                                                                                                                                       |
| 64   | Falscher Aufruf oder eine Routine, die es im Ordner nicht gibt.                                                                                                                                                                                                                                                                                                                                                                 |
| 65   | Ein Lauf scheiterte endgültig an seinen Daten oder an der Antwort des Modells, etwa an der ContentPolicy.                                                                                                                                                                                                                                                                                                                       |
| 69   | Der Proxy aus `ECCLIUM_EGRESS_PROXY` gab beim Start keinen Tunnel zu ChurchTools: nicht erreichbar, keine Antwort oder abgewiesen. Der Runner hat dann nichts gelesen.                                                                                                                                                                                                                                                          |
| 70   | Interner Fehler.                                                                                                                                                                                                                                                                                                                                                                                                                |
| 74   | Ein Entwurf, eine Meldung oder die Metrikdatei liess sich nicht schreiben.                                                                                                                                                                                                                                                                                                                                                      |
| 75   | Ein späterer Aufruf kann bestehen: eine vorübergehende Störung, das Gedächtnis der Läufe im Zustandsordner, eine Audit-Datei, die eine Zeile nicht nahm, die Sperre des Schreibens danach, die Frist eines Laufs, oder eine Routine von Hand, die ein anderer Prozess hält. Nach dem dritten Versuch einer Auslösung versucht es kein Aufruf mehr; die Routine wartet dann auf ihre nächste Auslösung oder einen Lauf von Hand. |
| 77   | Ein Kill-Switch, die Richtlinie, ein fehlendes Recht oder ein abgewiesenes Token.                                                                                                                                                                                                                                                                                                                                               |
| 78   | Die Konfiguration, oder eine Routine startet nicht, etwa weil die Token-Datei ihres Kontos, die Datei des Schlüssels ihres Modells oder der Ordner ihrer Sperrdateien sich nicht verwenden lässt. Mit `--due` laufen die übrigen Routinen trotzdem.                                                                                                                                                                             |
| 129  | Der Prozess endete nach SIGHUP.                                                                                                                                                                                                                                                                                                                                                                                                 |
| 130  | Der Prozess endete nach SIGINT.                                                                                                                                                                                                                                                                                                                                                                                                 |
| 143  | Der Prozess endete nach SIGTERM.                                                                                                                                                                                                                                                                                                                                                                                                |

Von mehreren gilt der schwerste in der Reihenfolge 70, 78, 77, 65, 74, 75. Nach einem Signal gelten 129, 130 und 143 vor allen anderen. Bei einem Lauf von Hand und einer Vorschau zählt nur die genannte Routine.

Der Daemon endet nur nach einem Signal mit 143, 130 oder 129, nach einer Sperre des Schreibens mit 75, nach einem internen Fehler mit 70, und beim Start mit 78, 69 oder 64 wie `run-once`. Was in einem Durchgang scheitert, beendet ihn nicht.

## Container

Was der Runner in einem Container vorfinden muss, legt der Runner-Container-Vertrag fest ([ADR 0036](../adr/0036-runner-container-vertrag.md)): die Tabellen dieses Abschnitts und die Abschnitte «Signale», «Exit-Codes» und «Metrikdatei» oben. Er gilt für jeden Container, der `ecclium runner` oder `ecclium run-once` ausführt, ob ihn das Bundle für das Self-Hosting startet, ein anderer Orchestrator oder ein gehosteter Dienst. Ein Test hält die Tabellen beim Code. Wer den Container startet und überwacht, heisst hier Aufseher, etwa cron, systemd oder Docker Compose.

### Benutzer und Rechte

- Der Runner läuft als Benutzer ohne root, im offiziellen Image mit der UID 65532. Ihm gehört alles, was Ecclium liest oder schreibt, unter `/config`, `/run/secrets`, `/data` und `/keys`, ausser dem Ordner `/config/stop` und den Kill-Switches darin. Gehört etwas einem anderen Benutzer, startet der Runner nicht und nennt den Grund.
- Ein neues Volume von Docker gehört root. Übergeben Sie `/data` und `/keys` vor dem ersten Start dem Benutzer des Runners, einmalig etwa mit einem Container als root ohne Netz, der nur die Capability `CHOWN` hat: zuerst `chmod 700`, dann `chown 65532:65532`.
- Die Dateien und Ordner auf Ihrem Rechner, die unter `/config` und `/run/secrets` eingebunden sind, gehören ebenfalls der UID 65532, ausser `config/stop` und den Kill-Switches darin. Ändern Sie eine davon, setzen Sie danach ihren Besitzer wieder. Eine neue Token-Datei bekommt Besitzer und Rechte, bevor Sie die alte durch Umbenennen ersetzen.
- Wem eine Datei gehört, der darf sie auch ändern. Legen Sie die Ordner für `/config` und `/run/secrets` auf Ihrem Rechner deshalb in einen Ordner, den nur root oder Sie öffnen können, mit den Rechten 700, und lassen Sie dort keinen anderen Prozess unter der UID 65532 laufen.
- Das Dateisystem des Containers ist nur lesbar, `/tmp` ein tmpfs. Der Container läuft ohne Capabilities, mit `no-new-privileges`, mit Grenzen für die Zahl der Prozesse und den Speicher, ohne veröffentlichten Port und nur in einem internen Netz mit dem Proxy (siehe «Ausgehender Weg»).
- Starten Sie den Container mit einem init, bei Docker Compose mit `init: true`, bei `docker run` mit `--init`. Der Runner richtet seine Behandlung der Signale erst nach dem Start ein; liefe er selbst als PID 1, verwürfe das Betriebssystem ein SIGTERM in dieser Zeit, und der Runner liefe weiter, bis SIGKILL ihn trifft.

### Pfade

| Pfad           | Im Container      | Inhalt                                                                                  |
| -------------- | ----------------- | --------------------------------------------------------------------------------------- |
| `/config`      | nur lesbar        | `policy.yaml`, `providers.yaml` und der Ordner `routines` mit `prompts` und `templates` |
| `/config/stop` | nur lesbar        | die Kill-Switches, mit `/config` eingebunden                                            |
| `/run/secrets` | nur lesbar        | ein eingebundener Ordner mit den Token-Dateien und Schlüsseln                           |
| `/data`        | schreibbar        | der Zustandsordner, siehe «Ordner im Zustandsordner»                                    |
| `/keys`        | schreibbar        | die Tagesschlüssel der Snapshots und der Freigabe-Warteschlange                         |
| `/tmp`         | schreibbar, tmpfs | nichts, das bleiben muss                                                                |

In `/run/secrets` liegen:

- `ct_token_runner` für das eigene Konto des Runners und `ct_token_<Alias>` für jedes Konto, das die Richtlinie nennt,
- `pseudonym_key` für Routinen mit Modell und während eines Wechsels dieses Schlüssels `pseudonym_key_previous`,
- `runner_mac_key` für Routinen, die ins Wiki schreiben,
- die Schlüssel der Modelle unter dem Pfad, den `providers.yaml` nennt, etwa `/run/secrets/model_api_key`,
- `runner_ping_url`, wenn Sie einen Ping an eine Überwachung wollen.

Jede Datei hat die Rechte 400 oder 600, der Ordner 700. Das Token des Servers liegt nie darin. Binden Sie den Ordner ein, nicht einzelne Dateien, also auch nicht über `secrets:` von Docker Compose, das jede Datei einzeln einbindet: Eine Datei, die Sie auf Ihrem Rechner durch Umbenennen ersetzen, sieht ein laufender Container nur durch einen eingebundenen Ordner, und nur so wirkt ein neues Token ohne Neustart.

Den Ordner `stop` legen Sie auf Ihrem Rechner im Ordner an, den Sie unter `/config` einbinden, im Bundle `config/stop`. Er kommt so mit `/config` in jeden Container des Runners, auch in einen Lauf von Hand und in die Befehle für Betreiber, ohne eigene Einbindung. Einen Kill-Switch legen Sie dort an, ohne Rechte von root und ohne Neustart (siehe «Anhalten»). Der Ordner gehört Ihnen und braucht Rechte, mit denen der Benutzer des Runners ihn durchsuchen kann und nur Sie darin schreiben, etwa 755. Fehlt er, kann der Runner ihn nicht durchsuchen oder dürfen Gruppe oder andere darin schreiben, startet ein Runner nicht, der ins Wiki schreibt oder Entwürfe ablegt. Ohne `ECCLIUM_KILL_SWITCH_DIR` startet der Runner gar nicht, damit er nie einen anderen Ordner liest als den, in dem Sie die Kill-Switches anlegen.

### Variablen

| Variable                              | Wert im Container                     |
| ------------------------------------- | ------------------------------------- |
| `ECCLIUM_STATE_DIR`                   | `/data`                               |
| `ECCLIUM_KEYS_DIR`                    | `/keys`                               |
| `ECCLIUM_KILL_SWITCH_DIR`             | `/config/stop`                        |
| `ECCLIUM_POLICY_FILE`                 | `/config/policy.yaml`                 |
| `ECCLIUM_PROVIDERS_FILE`              | `/config/providers.yaml`              |
| `ECCLIUM_ROUTINES_DIR`                | `/config/routines`                    |
| `ECCLIUM_RUNNER_TOKENS_DIR`           | `/run/secrets`                        |
| `ECCLIUM_PSEUDONYM_KEY_FILE`          | `/run/secrets/pseudonym_key`          |
| `ECCLIUM_PSEUDONYM_KEY_PREVIOUS_FILE` | `/run/secrets/pseudonym_key_previous` |
| `ECCLIUM_MARKER_KEY_FILE`             | `/run/secrets/runner_mac_key`         |
| `ECCLIUM_RUNNER_PING_URL_FILE`        | `/run/secrets/runner_ping_url`        |
| `ECCLIUM_DRAFTS_DIR`                  | `/data/output`                        |
| `ECCLIUM_NOTIFY_FILE`                 | `/data/notify.jsonl`                  |
| `ECCLIUM_RUNNER_METRICS_FILE`         | `/data/metrics/runner.prom`           |
| `ECCLIUM_EGRESS_PROXY`                | `http://egress:3128`                  |

- Setzen Sie eine Variable der Tabelle nur, wenn Sie brauchen, wofür sie steht: `ECCLIUM_PSEUDONYM_KEY_FILE` für Routinen mit Modell, `ECCLIUM_PSEUDONYM_KEY_PREVIOUS_FILE` während eines Wechsels dieses Schlüssels ([Betrieb über stdio](stdio.md)), `ECCLIUM_MARKER_KEY_FILE` für Routinen, die ins Wiki schreiben, `ECCLIUM_RUNNER_PING_URL_FILE` für einen Ping, `ECCLIUM_NOTIFY_FILE` für Meldungen in eine Datei. Welche Variablen sonst Pflicht sind, steht unter «Konfiguration». Setzen Sie eine Variable der Tabelle, dann mit dem Wert der Tabelle.
- `ECCLIUM_EGRESS_PROXY` nennt im Bundle den Container `egress`, sonst den Proxy Ihres Netzes.
- Die Adresse von ChurchTools, die Zeitzone und für Routinen, die ins Wiki schreiben, `ECCLIUM_READ_ONLY=false` setzen Sie selbst (siehe «Konfiguration»).
- Den Ordner `output` für Entwürfe und den Ordner `metrics` legt der Runner selbst an, weitere Ebenen nicht. Die Datei der Meldungen liegt deshalb direkt in `/data`, denn ihr Ordner muss bestehen.

### Ordner im Zustandsordner

| Ordner      | Inhalt                                                                         | Angelegt von |
| ----------- | ------------------------------------------------------------------------------ | ------------ |
| `audit`     | die Audit-Dateien                                                              | Ecclium      |
| `quota`     | Lesebudget, Grenzen je Tag, verbrauchte Freigaben und das Gedächtnis der Läufe | Ecclium      |
| `snapshots` | Snapshots der Schreibvorgänge, verschlüsselt mit Schlüsseln aus `/keys`        | Ecclium      |
| `queue`     | die Freigabe-Warteschlange                                                     | Ecclium      |
| `runner`    | die Sperrdateien der Routinen                                                  | Ecclium      |

Einen Ordner `stop` im Zustandsordner liest nur ein Server über stdio ohne `ECCLIUM_KILL_SWITCH_DIR` ([Betrieb über stdio](stdio.md)). Der Runner liest die Kill-Switches nur aus `/config/stop`.

`/data` muss zwischen zwei Läufen erhalten bleiben, in einem dauerhaften Volume, nie in einem tmpfs. Alle Container des Runners einer Installation teilen es: der Daemon, jeder `run-once` und die Befehle für Betreiber. Das gilt ausdrücklich für `/data/quota`: Ohne diesen Ordner gelten die Grenzen je Tag nicht, und eine Routine läuft für eine schon erledigte Periode noch einmal, mit Kosten beim Modell; einen zweiten Abschnitt verhindert dann nur der Prüfcode. `/data` braucht ein lokales Dateisystem, kein Netzlaufwerk wie NFS oder SMB und keinen synchronisierten Ordner. Sichern Sie `/data` und `/config`, die Entwürfe in `/data/output` nur so lange wie nötig ([Datenschutz](../privacy.md)). Die Dateien aus `/run/secrets` sichern Sie getrennt davon wie andere Zugangsdaten, vor allem `runner_mac_key`: Ein neuer Schlüssel macht jeden bisherigen Prüfcode ungültig (siehe «Neuer Schlüssel des Prüfcodes»). `/keys` sichern Sie nie.

### Grenzen

Der Container läuft mit Grenzen für die Zahl der Prozesse, Threads eingeschlossen, und für den Speicher. Der Job `e2e` in CI startet den Runner mit diesen Grenzen und liest nach jedem Lauf von `ecclium run-once` die Höchstwerte aus der cgroup des Containers; ein Lauf, der eine Grenze erreicht, lässt den Job scheitern. Am 14.11.2026 brauchte ein solcher Lauf, der eine Liste von Seiten liest, ein Modell fragt und einen Abschnitt schreibt, lokal unter Ubuntu 24.04 auf arm64 höchstens 13 Prozesse und 79 MiB Speicher, in CI auf amd64 höchstens 13 Prozesse und 68,9 MiB. Die Werte der Tabelle sind Ausgangswerte: das Doppelte der lokalen Höchstwerte, aufgerundet auf eine Zweierpotenz.

| Grenze   | Wert    | In Docker Compose |
| -------- | ------- | ----------------- |
| Prozesse | 32      | `pids_limit: 32`  |
| Speicher | 256 MiB | `mem_limit: 256m` |

Liest eine Routine viel, etwa die Einteilungen vieler Events, kann ihr Lauf mehr Speicher brauchen; gemessen ist das nicht. Endet ein Lauf mit 137, ohne dass ihn jemand gestoppt hat, und zeigt `docker inspect` bei `OOMKilled` den Wert `true`, hat der Kernel ihn wegen des Speichers beendet. Erhöhen Sie dann die Grenze für den Speicher.

### Aufseher und Lebenszeichen

- Den Daemon startet der Aufseher nach 75, 69 und 70 neu. Erst ein Neustart hebt die Sperre des Schreibens nach einer Zeile des Audits, die ihre Datei nicht erreichte. 69 heisst, dass der Proxy beim Start keinen Tunnel gab, etwa weil er noch nicht bereit war. Nach 78 und 64 hilft ein Neustart nicht: Der Grund steht im Log, und der Ping bleibt aus. Docker Compose unterscheidet die Codes nicht: Mit `restart: on-failure` oder `unless-stopped` startet der Daemon auch nach 78 und 64 wieder und endet erneut, bis Sie den Grund beheben.
- `ecclium run-once --due` ruft der Aufseher zu seiner Zeit einfach wieder auf, etwa alle 15 Minuten, auch nach 75. Nach 77 und 78 braucht es Sie.
- Ob der Runner lebt, zeigen `next_run` in der Metrikdatei und der Ping an eine Überwachung. Einen Befehl für einen Healthcheck des Containers gibt es noch nicht; er kommt mit dem Image.

### Befehle für Betreiber

Befehle zum Runner laufen in einem Container mit demselben Benutzer, denselben Pfaden und demselben Netz wie der Runner, mit schreibbarem `/data`, weil `ecclium doctor` und `ecclium run-once` dort ins Audit schreiben, und nie mit dem Token des Servers. Das gilt heute für `ecclium doctor`, `ecclium init egress`, `ecclium config check --runner`, `ecclium run-once`, `ecclium audit show` und `ecclium audit verify`. Auch Entwürfe und die Datei der Meldungen lesen, löschen und rotieren Sie so, mit dem Benutzer des Runners und demselben `/data`.

`ecclium undo --run`, `ecclium queue` für Einträge eines Laufs, `ecclium marker adopt --run` und `ecclium policy init --routine` laden die Konfiguration noch wie der Server über stdio und verlangen dessen Token, auch wenn sie mit dem Konto des Runners lesen oder schreiben. Sie brauchen also neben den Pfaden des Runners die Token-Datei des Servers, und ein Container mit beiden Token erfüllt diesen Vertrag nicht. Bis diese Befehle die Konfiguration des Runners laden, ist das eine bekannte Lücke. Setzen Sie für sie auch `ECCLIUM_KILL_SWITCH_DIR=/config/stop` wie für den Runner: Ohne die Variable suchen sie die Kill-Switches wie ein Server über stdio im Ordner `stop` des Zustandsordners. Den gibt es im Container nicht, und sie enden dann mit 78; hat ihn jemand von Hand angelegt, sähen sie Ihre Kill-Switches nicht.
