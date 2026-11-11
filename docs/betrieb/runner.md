# Runner der Routinen

**In Entwicklung.** Es gibt noch keine veröffentlichte Version. Diese Seite beschreibt `ecclium run-once` und den Daemon `ecclium runner`, so wie sie heute gebaut sind. Der Vertrag für den Container des Runners und die Ping-URL kommen später und ergänzen diese Seite.

Der Runner führt Routinen nach ihrem Zeitplan aus: Er liest Daten aus ChurchTools, gibt sie maskiert einem Sprachmodell, prüft die Antwort und schreibt einen Abschnitt ins Wiki oder einen Entwurf als Datei ([Routinen](../routines.md), [Richtlinie](../policy.md), [Anbieter](../providers.md)). Er läuft ohne Menschen, deshalb schreibt er ins Wiki nur, was die Richtlinie erlaubt.

Ecclium ist ein unabhängiges Projekt und steht in keiner Verbindung zum Hersteller von ChurchTools.

## Konfiguration

Der Runner liest dieselben Variablen wie der Server ([Konfiguration](../configuration.md)), mit diesen Unterschieden:

- Pflicht sind `ECCLIUM_TIME_ZONE`, `ECCLIUM_POLICY_FILE`, `ECCLIUM_ROUTINES_DIR`, `ECCLIUM_STATE_DIR` und `ECCLIUM_RUNNER_TOKENS_DIR`.
- Der Runner liest nie das Token des Servers. `ECCLIUM_CHURCHTOOLS_TOKEN_FILE` und `ECCLIUM_CHURCHTOOLS_TOKEN` halten ihn vom Start ab. Sein eigenes Konto liegt als `ct_token_runner` im Ordner aus `ECCLIUM_RUNNER_TOKENS_DIR`, jedes Konto, das die Richtlinie nennt, als `ct_token_<Alias>` daneben, jede Datei mit den Rechten 600. Mit dem eigenen Konto liest eine Routine, für die die Richtlinie keinen Eintrag hat. Jeder Lauf liest seine Token-Datei neu, ein neues Token wirkt also ohne Neustart.
- Schreibt eine Routine ins Wiki, verlangt der Runner `ECCLIUM_READ_ONLY=false` mit allem, was das Schreiben sonst braucht. Sonst startet er nicht, weil ein Lauf lesen und das Modell fragen würde, ohne zu schreiben.
- Für einen Entwurf als Datei braucht die Routine `ECCLIUM_DRAFTS_DIR`, den Ordner `stop` im Zustandsordner und unter `interactive.inquiriesTo` in der Richtlinie, wen Leserinnen und Leser fragen können, auch mit `ECCLIUM_READ_ONLY=true`.
- Für Meldungen in eine Datei braucht die Routine `ECCLIUM_NOTIFY_FILE`.
- Eine Metrikdatei schreibt der Runner nur mit `ECCLIUM_RUNNER_METRICS_FILE` (siehe «Metrikdatei»).
- Den Ordner der Entwürfe, die Datei der Meldungen und die Metrikdatei legen Sie nicht in einen Ordner, den Ecclium selbst füllt: weder in den Ordner der Schlüssel noch in den der Token-Dateien, noch in einen der Ordner `audit`, `quota`, `snapshots`, `queue`, `runner` oder `stop` des Zustandsordners. Ein eigener Ordner wie `output` im Zustandsordner geht. Die Metrikdatei ist zudem keine andere Datei der Konfiguration, etwa die Datei der Meldungen, die Richtlinie oder eine Schlüsseldatei, liegt nicht im Ordner der Routinen, und ihr Name beginnt mit einem Buchstaben oder einer Ziffer und hat höchstens 128 Zeichen aus Buchstaben ohne Umlaute, Ziffern, Punkt, Bindestrich und Unterstrich.
- Eine Routine gibt dem Modell ihre Daten in der Stufe `strict`, ausser ein Eintrag der Richtlinie erlaubt `standard`. Dafür braucht sie die Schlüsseldatei der Pseudonyme in `ECCLIUM_PSEUDONYM_KEY_FILE` ([Betrieb über stdio](stdio.md), «Schlüsseldatei anlegen»), auch für eine Vorschau.

`ecclium config check --runner` prüft all das ohne ChurchTools und ohne die Modelle anzufragen und nennt jede Routine mit Zeitplan, Ziel, Konto und Modell.

## Befehle

- `ecclium run-once --due` führt jede Routine aus, die fällig ist, eine nach der anderen, und endet dann. Ein Container, den cron alle 15 Minuten startet, ruft diesen Befehl auf. Ob eine Routine fällig ist, entscheidet ihr Zeitplan in der Zone aus `ECCLIUM_TIME_ZONE`: die letzte Auslösung der letzten 31 Tage, die noch nicht abgeschlossen ist. Scheitert ein Lauf an einer vorübergehenden Störung, versucht ein späterer Aufruf es noch zweimal, frühestens 15 Minuten danach.
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

SIGTERM, SIGINT und SIGHUP brechen Lesen und Modell sofort ab, weil beide ausserhalb nichts ändern. Ein Schreibvorgang, der schon begonnen hat, endet noch, mit Snapshot, Lesen danach, seiner Zeile im Audit, dem Ende seiner Auslösung und seiner Meldung. Danach beginnt keine Routine mehr. Bei einem Lauf, der noch nicht schrieb, bleibt die Auslösung offen, der Versuch zählt, und ein späterer Aufruf versucht es wieder. Der Prozess endet nach SIGTERM mit 143, nach SIGINT mit 130 und nach SIGHUP, etwa wenn sein Terminal geschlossen wird, mit 129.

Ein zweites Signal beendet den Prozess sofort, ausser während eines Schreibvorgangs: Dann endet er direkt danach. Andere Signale wie SIGKILL halten ihn hart an. Geben Sie einem Container des Runners beim Stoppen mindestens 60 Sekunden, bei Docker Compose etwa mit `stop_grace_period: 60s`, damit ein Schreibvorgang nie von SIGKILL getroffen wird.

## Frist der Daten

Der Runner löscht wie der Server, was seine Frist überschritten hat: Audit-Dateien nach `ECCLIUM_AUDIT_RETENTION_MONTHS`, Snapshots nach 30 Tagen und Einträge der Freigabe-Warteschlange nach 14 Tagen, jeweils mit ihren Tagesschlüsseln ([Datenschutz](../privacy.md)). `run-once` tut das bei jedem Aufruf, der Daemon beim Start und an jedem neuen UTC-Tag. Eine Vorschau löscht nichts.

## Anhalten

Kill-Switches sind Dateien im Ordner `stop` des Zustandsordners. Nur dass die Datei da ist, zählt:

- `writes-off` hält jeden Lauf an,
- `writes-off-<Mandant>` die Läufe eines Mandanten (`writes-off-default` über stdio und im Runner),
- `writes-off-routine-<Routine>` die Läufe einer Routine.

Ein angehaltener Lauf liest nichts und schickt dem Modell keine Daten. Er endet endgültig, die Auslösung gilt als abgeschlossen. Nach dem Entfernen der Datei läuft die Routine zu ihrer nächsten Auslösung, oder Sie starten sie mit `ecclium run-once <Routine>` von Hand.

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

## Exit-Codes

| Code | Bedeutung                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Nichts war fällig, oder jeder Lauf hat geschrieben, nichts zu ändern gefunden, eingereiht oder einen Entwurf geschrieben. Eine Routine, die ein anderer Prozess hält, zählt bei `--due` nicht als Fehler.                                                                                                                                                                                                                       |
| 64   | Falscher Aufruf oder eine Routine, die es im Ordner nicht gibt.                                                                                                                                                                                                                                                                                                                                                                 |
| 65   | Ein Lauf scheiterte endgültig an seinen Daten oder an der Antwort des Modells, etwa an der ContentPolicy.                                                                                                                                                                                                                                                                                                                       |
| 70   | Interner Fehler.                                                                                                                                                                                                                                                                                                                                                                                                                |
| 74   | Ein Entwurf, eine Meldung oder die Metrikdatei liess sich nicht schreiben.                                                                                                                                                                                                                                                                                                                                                      |
| 75   | Ein späterer Aufruf kann bestehen: eine vorübergehende Störung, das Gedächtnis der Läufe im Zustandsordner, eine Audit-Datei, die eine Zeile nicht nahm, die Sperre des Schreibens danach, die Frist eines Laufs, oder eine Routine von Hand, die ein anderer Prozess hält. Nach dem dritten Versuch einer Auslösung versucht es kein Aufruf mehr; die Routine wartet dann auf ihre nächste Auslösung oder einen Lauf von Hand. |
| 77   | Ein Kill-Switch, die Richtlinie, ein fehlendes Recht oder ein abgewiesenes Token.                                                                                                                                                                                                                                                                                                                                               |
| 78   | Die Konfiguration, oder eine Routine startet nicht, etwa weil die Token-Datei ihres Kontos, die Datei des Schlüssels ihres Modells oder der Ordner ihrer Sperrdateien sich nicht verwenden lässt. Mit `--due` laufen die übrigen Routinen trotzdem.                                                                                                                                                                             |
| 129  | Der Prozess endete nach SIGHUP.                                                                                                                                                                                                                                                                                                                                                                                                 |
| 130  | Der Prozess endete nach SIGINT.                                                                                                                                                                                                                                                                                                                                                                                                 |
| 143  | Der Prozess endete nach SIGTERM.                                                                                                                                                                                                                                                                                                                                                                                                |

Von mehreren gilt der schwerste in der Reihenfolge 70, 78, 77, 65, 74, 75. Nach einem Signal gelten 129, 130 und 143 vor allen anderen. Bei einem Lauf von Hand und einer Vorschau zählt nur die genannte Routine.

Der Daemon endet nur nach einem Signal mit 143, 130 oder 129, nach einer Sperre des Schreibens mit 75, nach einem internen Fehler mit 70, und beim Start mit 78 oder 64 wie `run-once`. Was in einem Durchgang scheitert, beendet ihn nicht.
