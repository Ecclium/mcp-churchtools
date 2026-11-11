# Runner der Routinen

**In Entwicklung.** Es gibt noch keine veröffentlichte Version. Diese Seite beschreibt `ecclium run-once`, so wie es heute gebaut ist. Der Daemon `ecclium runner`, die Metrikdatei und der Vertrag für den Container des Runners kommen später und ergänzen diese Seite.

Der Runner führt Routinen nach ihrem Zeitplan aus: Er liest Daten aus ChurchTools, gibt sie maskiert einem Sprachmodell, prüft die Antwort und schreibt einen Abschnitt ins Wiki oder einen Entwurf als Datei ([Routinen](../routines.md), [Richtlinie](../policy.md), [Anbieter](../providers.md)). Er läuft ohne Menschen, deshalb schreibt er ins Wiki nur, was die Richtlinie erlaubt.

Ecclium ist ein unabhängiges Projekt und steht in keiner Verbindung zum Hersteller von ChurchTools.

## Konfiguration

Der Runner liest dieselben Variablen wie der Server ([Konfiguration](../configuration.md)), mit diesen Unterschieden:

- Pflicht sind `ECCLIUM_TIME_ZONE`, `ECCLIUM_POLICY_FILE`, `ECCLIUM_ROUTINES_DIR`, `ECCLIUM_STATE_DIR` und `ECCLIUM_RUNNER_TOKENS_DIR`.
- Der Runner liest nie das Token des Servers. `ECCLIUM_CHURCHTOOLS_TOKEN_FILE` und `ECCLIUM_CHURCHTOOLS_TOKEN` halten ihn vom Start ab. Sein eigenes Konto liegt als `ct_token_runner` im Ordner aus `ECCLIUM_RUNNER_TOKENS_DIR`, jedes Konto, das die Richtlinie nennt, als `ct_token_<Alias>` daneben, jede Datei mit den Rechten 600. Mit dem eigenen Konto liest eine Routine, für die die Richtlinie keinen Eintrag hat. Jeder Lauf liest seine Token-Datei neu, ein neues Token wirkt also ohne Neustart.
- Schreibt eine Routine ins Wiki, verlangt der Runner `ECCLIUM_READ_ONLY=false` mit allem, was das Schreiben sonst braucht. Sonst startet er nicht, weil ein Lauf lesen und das Modell fragen würde, ohne zu schreiben.
- Für einen Entwurf als Datei braucht die Routine `ECCLIUM_DRAFTS_DIR`, den Ordner `stop` im Zustandsordner und unter `interactive.inquiriesTo` in der Richtlinie, wen Leserinnen und Leser fragen können, auch mit `ECCLIUM_READ_ONLY=true`.
- Für Meldungen in eine Datei braucht die Routine `ECCLIUM_NOTIFY_FILE`.
- Den Ordner der Entwürfe und die Datei der Meldungen legen Sie nicht in einen Ordner, den Ecclium selbst füllt: weder in den Ordner der Schlüssel noch in den der Token-Dateien, noch in einen der Ordner `audit`, `quota`, `snapshots`, `queue`, `runner` oder `stop` des Zustandsordners. Ein eigener Ordner wie `output` im Zustandsordner geht.
- Eine Routine gibt dem Modell ihre Daten in der Stufe `strict`, ausser ein Eintrag der Richtlinie erlaubt `standard`. Dafür braucht sie die Schlüsseldatei der Pseudonyme in `ECCLIUM_PSEUDONYM_KEY_FILE` ([Betrieb über stdio](stdio.md), «Schlüsseldatei anlegen»), auch für eine Vorschau.

`ecclium config check --runner` prüft all das ohne ChurchTools und ohne die Modelle anzufragen und nennt jede Routine mit Zeitplan, Ziel, Konto und Modell.

## Befehle

- `ecclium run-once --due` führt jede Routine aus, die fällig ist, eine nach der anderen, und endet dann. Ein Container, den cron alle 15 Minuten startet, ruft diesen Befehl auf. Ob eine Routine fällig ist, entscheidet ihr Zeitplan in der Zone aus `ECCLIUM_TIME_ZONE`: die letzte Auslösung der letzten 31 Tage, die noch nicht abgeschlossen ist. Scheitert ein Lauf an einer vorübergehenden Störung, versucht ein späterer Aufruf es noch zweimal, frühestens 15 Minuten danach.
- `ecclium run-once <Routine>` führt eine Routine von Hand aus, mit der Periode ihrer letzten Auslösung, auch wenn sie nicht fällig ist. Der Lauf zählt gegen die Grenzen der Richtlinie wie jeder andere.
- `ecclium run-once <Routine> --preview` zeigt den Abschnitt, den ein Lauf schreiben würde, auf stdout und schreibt nichts. Die Vorschau läuft auch, bevor die Richtlinie einen Eintrag für das Ziel hat, und mit `ECCLIUM_READ_ONLY=true`. So sehen Sie den Abschnitt, bevor Sie den Eintrag in die Richtlinie aufnehmen. Lesen und Modell kosten wie bei einem Lauf. Ein Kill-Switch und die Sperre des Schreibens halten eine Vorschau nicht an, weil sie nichts schreibt; die Daten gehen trotzdem maskiert an das Modell.

Läuft eine Routine schon in einem anderen Prozess, überspringt ein zweiter Aufruf sie. Ein Lauf dauert höchstens 30 Minuten, danach bricht der Runner Lesen und Modell ab. Einen Schreibvorgang, der begonnen hat, bricht er dafür nie ab.

Ein Signal wie SIGTERM beendet einen Aufruf heute aber sofort, auch mitten in einem Schreibvorgang. Die Behandlung der Signale kommt mit dem Daemon. Stoppen Sie einen laufenden Aufruf bis dahin nicht, etwa mit `docker stop`, und geben Sie einem Container, der `run-once` ausführt, genug Zeit bis zu seinem Ende.

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

## Exit-Codes von `run-once`

| Code | Bedeutung                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Nichts war fällig, oder jeder Lauf hat geschrieben, nichts zu ändern gefunden, eingereiht oder einen Entwurf geschrieben. Eine Routine, die ein anderer Prozess hält, zählt bei `--due` nicht als Fehler.                                                                                                                                                                                                                       |
| 64   | Falscher Aufruf oder eine Routine, die es im Ordner nicht gibt.                                                                                                                                                                                                                                                                                                                                                                 |
| 65   | Ein Lauf scheiterte endgültig an seinen Daten oder an der Antwort des Modells, etwa an der ContentPolicy.                                                                                                                                                                                                                                                                                                                       |
| 70   | Interner Fehler.                                                                                                                                                                                                                                                                                                                                                                                                                |
| 74   | Ein Entwurf oder eine Meldung liess sich nicht schreiben.                                                                                                                                                                                                                                                                                                                                                                       |
| 75   | Ein späterer Aufruf kann bestehen: eine vorübergehende Störung, das Gedächtnis der Läufe im Zustandsordner, eine Audit-Datei, die eine Zeile nicht nahm, die Sperre des Schreibens danach, die Frist eines Laufs, oder eine Routine von Hand, die ein anderer Prozess hält. Nach dem dritten Versuch einer Auslösung versucht es kein Aufruf mehr; die Routine wartet dann auf ihre nächste Auslösung oder einen Lauf von Hand. |
| 77   | Ein Kill-Switch, die Richtlinie, ein fehlendes Recht oder ein abgewiesenes Token.                                                                                                                                                                                                                                                                                                                                               |
| 78   | Die Konfiguration, oder eine Routine startet nicht, etwa weil die Token-Datei ihres Kontos, die Datei des Schlüssels ihres Modells oder der Ordner ihrer Sperrdateien sich nicht verwenden lässt. Mit `--due` laufen die übrigen Routinen trotzdem.                                                                                                                                                                             |

Von mehreren gilt der schwerste in der Reihenfolge 70, 78, 77, 65, 74, 75. Bei einem Lauf von Hand und einer Vorschau zählt nur die genannte Routine.
