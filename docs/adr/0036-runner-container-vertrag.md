# ADR 0036: Runner-Container-Vertrag

- Status: Vorgeschlagen
- Datum: 13.11.2026
- Fällt vor: Phase 6
- Ergänzt: [ADR 0004](0004-getrennte-images.md), [ADR 0033](0033-runner-modell-ohne-werkzeuge.md), [ADR 0034](0034-zeitplan-semantik.md), [ADR 0035](0035-proxy-und-grenze-im-netz.md)

## Kontext

Der Runner führt Routinen ohne Menschen aus, liest dabei fremde Texte und schreibt danach ins Wiki ([ADR 0033](0033-runner-modell-ohne-werkzeuge.md)). Er läuft als Daemon `ecclium runner` oder als Einzellauf `ecclium run-once`, den ein Aufseher von aussen startet, etwa cron alle 15 Minuten ([ADR 0034](0034-zeitplan-semantik.md)). Im Self-Hosting hängt er nur an einem internen Netz mit einem Proxy ([ADR 0035](0035-proxy-und-grenze-im-netz.md)). [ADR 0004](0004-getrennte-images.md) sieht ein eigenes Image für ihn vor und überlässt diesem ADR, wie der Container von aussen zu betreiben ist.

Festzulegen ist, was der Prozess des Runners in einem Container vorfinden muss: Pfade, Besitzer und Rechte, was nur lesbar ist und was bleibt, Variablen, Netz, Signale und Exit-Codes. Das braucht nicht nur die Compose-Datei des Bundles für das Self-Hosting. Auch ein Betreiber, der den Runner ohne Compose startet, und ein gehosteter Dienst, der für jeden Lauf einen frischen Container startet, sollen ihn betreiben können, ohne dass der Kern von ihnen weiss.

Aus dem Code, Stand 13.11.2026:

- **Besitzer:** Jeder Ordner und jede Datei, die Ecclium liest oder schreibt, muss dem Benutzer des Prozesses gehören. Der Zustandsordner, der Ordner der Tagesschlüssel und der Ordner der Token haben keine Rechte für Gruppe und andere, ebenso Token- und Schlüsseldateien. Richtlinie, Anbieter und Routinen dürfen andere lesen, aber nicht schreiben. Sonst startet der Runner nicht und nennt den Grund. Nur beim Ordner `stop` und den Kill-Switches darin prüft Ecclium keinen Besitzer, dort zählt nur, dass eine Datei da ist ([ADR 0029](0029-write-guard.md)).
- **Lage:** Der Ordner der Tagesschlüssel und der Ordner der Token dürfen nicht im Zustandsordner liegen, damit eine Sicherung des Zustandsordners weder die Schlüssel seiner Snapshots noch die Token enthält ([ADR 0031](0031-persistenz-und-tagesschluessel.md)).
- **Ordner:** Ecclium legt Ordner nie rekursiv an, nur eine Ebene unter einem bestehenden Ordner. Der Ordner einer Datei der Meldungen muss bestehen.
- **Kill-Switches:** Sie liegen im Ordner `stop` des Zustandsordners. Ein Runner, der schreibt, startet ohne diesen Ordner nicht.
- **Mehrere Prozesse:** Jeder Prozess schreibt eine eigene Audit-Datei, angelegt mit `O_EXCL`, so dass sich zwei Container mit derselben Kennung des Prozesses nicht stören. Die Sperrdatei einer Routine kennt den Namensraum der Prozesse. Der `QuotaStore` braucht `link`, `rename` und `fsync` auf Ordnern ([ADR 0063](0063-quotastore-als-datei.md)).
- **Befehle für Betreiber:** `ecclium doctor`, `ecclium init egress`, `ecclium config check --runner`, `ecclium run-once` und der Daemon laden die Konfiguration des Runners, die das Token des Servers abweist. `ecclium audit show` und `ecclium audit verify` brauchen nur den Zustandsordner. `ecclium undo`, `ecclium queue`, `ecclium marker adopt` und `ecclium policy init` laden die Konfiguration über stdio und verlangen das Token des Servers, auch wenn sie für einen Lauf mit dem Konto des Runners schreiben.

Eine Probe am 13.11.2026 mit Docker 29.8.2 unter OrbStack auf arm64, im Image `node:24-trixie-slim` mit dem gebauten Stand, als UID 65532, mit nur lesbarem Dateisystem, ohne Capabilities, mit `no-new-privileges` und ohne Netz:

- Ein frisches Volume von Docker unter `/data` gehört root mit 755. `ecclium config check --runner` endet damit mit 78, weil der Ordner einem anderen Benutzer gehört. Nach `chmod 700` und `chown 65532:65532` durch einen Container als root, nur mit der Capability `CHOWN`, endet er mit 0.
- Eine Token-Datei, die ein zweiter Container per Umbenennen ersetzt, sieht der laufende Container durch einen eingebundenen Ordner sofort neu, als einzeln eingebundene Datei weiter alt.
- Mit den Pfaden und Werten dieses Vertrags endet `ecclium config check --runner` mit 0.
- `ECCLIUM_DRAFTS_DIR=/data/output/drafts` hielt den Runner vom Start ab, weil `/data/output` fehlte.
- Der Daemon läuft als PID 1. `docker stop` beendet ihn sofort mit 143, mit der Logzeile `process_sigterm` und dem Abschluss der Audit-Datei.
- Zwei `ecclium run-once --due` in frischen Containern auf demselben `/data` enden je mit 0.

## Optionen

1. **Die Compose-Datei als Vertrag:** Wer den Runner anders startet, liest sie und leitet ab, was gilt. Was davon Pflicht und was Wahl des Bundles ist, bleibt offen, und eine Änderung am Bundle ändert still den Vertrag.
2. **Ein Vertrag auf der Ebene des Prozesses:** Pfade, Besitzer, Rechte, Variablen, Signale und Exit-Codes, unabhängig davon, wer den Container startet. Das Bundle ist eine Umsetzung davon, ein Test hält die Tabellen beim Code.
3. **Keine festen Pfade,** jeder Betreiber wählt sie über die Variablen. Möglich ist das immer, aber Anleitungen, Befehle für Betreiber und Prüfungen könnten sich auf keinen Ort verlassen.

## Entscheid

Gewählt ist die zweite Option. Die Tabellen im Abschnitt «Container» von [Runner der Routinen](../betrieb/runner.md#container) gehören zum Vertrag, ebenso dort die Exit-Codes und die Metrikdatei. Ein Test vergleicht sie in beide Richtungen mit den Konstanten des Codes.

- **Geltung:** für das Image des Runners ([ADR 0004](0004-getrennte-images.md)) und bis dahin für jeden Container, der `ecclium runner` oder `ecclium run-once` ausführt. Der Vertrag sagt, was der Prozess vorfinden muss. Wie ein Aufseher das herstellt, ob mit Compose, einem anderen Orchestrator oder einem gehosteten Dienst, ist dessen Sache. Basis-Image, Benutzer des Images und Permission Model regelt ADR 0038, die Compose-Datei das Bundle.
- **Benutzer:** ein Benutzer ohne root, im offiziellen Image die UID 65532. Ihm gehört alles, was Ecclium liest oder schreibt, unter `/config`, `/run/secrets`, `/data` und `/keys`, ausser dem Ordner `stop` und den Kill-Switches darin. Ein frisches Volume gehört root und wird vor dem ersten Start übergeben. Wer eine Datei unter `/config` auf dem Rechner des Betreibers ändert, setzt danach ihren Besitzer wieder; sonst startet der Runner nicht und nennt den Grund. Eine Lockerung für Systeme, die Besitzer und Rechte nicht korrekt abbilden, etwa Docker Desktop oder manche NAS, kommt als Schalter des Images.
- **Dateisystem und Rechte:** Das Dateisystem des Containers ist nur lesbar, `/tmp` ein tmpfs. Schreiben darf der Prozess nur unter `/data` und `/keys`. Der Container läuft ohne Capabilities, mit `no-new-privileges` und mit Grenzen für die Zahl der Prozesse und den Speicher.
- **`/config`, nur lesbar:** `policy.yaml`, `providers.yaml` und der Ordner `routines` mit `prompts` und `templates`.
- **`/run/secrets`, nur lesbar:** ein eingebundener Ordner, nicht einzelne Dateien, mit `ct_token_runner`, `ct_token_<Alias>` für jedes Konto der Richtlinie, `pseudonym_key`, `runner_mac_key` für Routinen, die ins Wiki schreiben, den Schlüsseln der Modelle, die `providers.yaml` nennt, und `runner_ping_url`, wenn der Betreiber einen Ping will. Nie das Token des Servers. Ein Ordner, weil der Code für die Token einen Ordner des Benutzers verlangt und weil eine Token-Datei, die der Betreiber per Umbenennen ersetzt, nur durch einen eingebundenen Ordner ohne Neustart wirkt.
- **`/data`, schreibbar:** der Zustandsordner. Darin legt Ecclium `audit`, `quota`, `snapshots`, `queue` und `runner` selbst an, der Runner `output` für Entwürfe und `metrics` für `runner.prom`. `stop` ist ein nur lesbar eingebundener Ordner des Betreibers, im Bundle `config/stop`, in dem er Kill-Switches anlegt, ohne den Container neu zu starten. Meldungen in eine Datei gehen nach `/data/notify.jsonl`, weil ihr Ordner bestehen muss.
- **`/keys`, schreibbar:** die Tagesschlüssel der Snapshots und der Warteschlange. Ausserhalb von `/data`, weil der Code ihn im Zustandsordner abweist.
- **Was bleibt:** `/data` bleibt zwischen zwei Läufen erhalten und gehört allen Containern des Runners einer Installation gemeinsam: dem Daemon, jedem `run-once` und den Befehlen für Betreiber. Ausdrücklich gilt das für `/data/quota`: Dort stehen das Lesebudget, die Grenzen je Tag, die verbrauchten Freigaben und das Gedächtnis der Läufe. Ohne diesen Ordner gelten die Grenzen je Tag nicht, und eine Routine läuft für eine schon erledigte Periode noch einmal, mit Kosten beim Modell; einen zweiten Abschnitt verhindert dann nur der Prüfcode. `/data` liegt auf einem lokalen Dateisystem mit `O_EXCL`, harten Links, `rename` und `fsync` auf Ordnern, nicht auf NFS, SMB oder einem synchronisierten Ordner. `/keys` bleibt ebenfalls erhalten, wird aber nie gesichert.
- **Variablen:** Die Pfade oben setzt der Aufseher mit den Werten aus der Tabelle. Adresse von ChurchTools, Zeitzone und, für Routinen, die schreiben, `ECCLIUM_READ_ONLY=false` setzt der Betreiber.
- **Netz:** Der Container veröffentlicht keinen Port und hängt nur an einem internen Netz, in dem er den Proxy aus `ECCLIUM_EGRESS_PROXY` erreicht ([ADR 0035](0035-proxy-und-grenze-im-netz.md)). `ECCLIUM_EGRESS=off` bleibt der sichtbare Ausweg.
- **Prozess:** Node.js ist PID 1 und braucht kein `init`, weil der Runner keine Kindprozesse startet und SIGTERM, SIGINT und SIGHUP selbst behandelt. Ein Schreibvorgang, der begonnen hat, endet immer noch, mit Snapshot, Lesen danach und Zeile im Audit, und besteht aus mehreren Anfragen an ChurchTools mit je höchstens 30 Sekunden. Der Aufseher gibt dem Container beim Stoppen deshalb mindestens 5 Minuten, so lange wie die Sperrdatei einer Routine einem abgebrochenen Lauf für sein Ende lässt. Läuft kein Schreibvorgang, endet der Prozess sofort.
- **Exit-Codes und Aufseher:** Der Daemon braucht einen Aufseher, der ihn nach 75 neu startet, weil erst ein Neustart die Sperre des Schreibens nach einer verlorenen Zeile des Audits hebt, ebenso nach 69, wenn der Proxy beim Start noch nicht bereit war, und nach 70. 78 und 64 heilt ein Neustart nicht; sie zeigen sich im Log und an einem ausbleibenden Ping. `run-once` ruft der Aufseher zur nächsten Zeit einfach wieder auf. Nach 77 und 78 braucht es den Betreiber.
- **Lebenszeichen:** `next_run` in der Metrikdatei und der Ping an eine Überwachung. Ein Befehl für einen Healthcheck des Containers kommt mit dem Image.
- **Befehle für Betreiber:** Befehle zum Runner laufen in einem Container mit demselben Benutzer, denselben Pfaden und demselben Netz wie der Runner, mit schreibbarem `/data`, weil auch sie ins Audit schreiben, und nie mit dem Token des Servers. Heute gilt das für `ecclium doctor`, `ecclium init egress`, `ecclium config check --runner`, `ecclium run-once`, `ecclium audit show` und `ecclium audit verify`.

## Konsequenzen

- Der Runner lässt sich ohne Compose betreiben: von einem Betreiber mit eigenem Orchestrator und von einem gehosteten Dienst, der für jeden Lauf einen frischen Container startet. Was gilt, steht in Tabellen, die ein Test beim Code hält.
- Der Betreiber kann einen Kill-Switch auf seinem Rechner anlegen, ohne Rechte von root und ohne Neustart. Fehlt die Einbindung von `stop`, startet ein Runner, der schreibt, nicht.
- Das Permission Model im Image muss auch `/keys` schreiben lassen, nicht nur `/data` und `/tmp`.
- `ecclium undo --run`, `ecclium queue` für Einträge eines Laufs, `ecclium marker adopt --run` und `ecclium policy init --routine` erfüllen den Vertrag noch nicht: Sie verlangen das Token des Servers. Bis sie die Konfiguration des Runners laden, brauchen sie neben den Pfaden des Runners die Token-Datei des Servers, und ein Container mit beiden Token liegt ausserhalb dieses Vertrags.
- **Restrisiken:**
  - Ein Ordner `stop`, den jemand von Hand im Volume anlegt, verdeckt eine vergessene Einbindung: Der Runner startet, und ein Kill-Switch auf dem Rechner des Betreibers wirkt nicht. Eine spätere Fassung von `ecclium doctor` soll das erkennen.
  - Die Probe lief unter OrbStack auf arm64. Besitzer bei Ordnern, die vom Mac eingebunden sind, bildet OrbStack anders ab als Linux; die Probe nahm deshalb nur Volumes. Unter Linux belegt das erst der E2E-Job in CI.
  - Schreiben der Daemon und ein `run-once` die Metrikdatei im selben Augenblick, gewinnt der spätere. Die Datei spiegelt nur, kein Lauf hängt von ihr ab.

## Umsetzung

- **Tabellen, seit dem 13.11.2026:** Abschnitt «Container» in [Runner der Routinen](../betrieb/runner.md#container) mit Pfaden, Variablen, Ordnern im Zustandsordner, Signalen und der Frist beim Stoppen. Exit-Codes und Metrikdatei stehen auf derselben Seite.
- **Konstanten, seit dem 13.11.2026:** `stateFolders` in `packages/core/src/config/state-dir.ts` nennt die Ordner im Zustandsordner einmal, Lader, Stores und die Kill-Switches der Komposition nehmen sie von dort. `runnerSignals` in `packages/cli/src/runner/host.ts` nennt Signal, Logzeile und Exit-Code, die Wache über die Signale meldet sich damit an. `metricNames` in `packages/runner/src/metrics.ts` nennt die Namen der Metriken. Das Verhalten hat sich dadurch nicht geändert.
- **Test, seit dem 13.11.2026:** `tests/runner-container.test.mts` vergleicht in beide Richtungen: Variablen und Pfade mit der Tabelle der Variablen, und die dokumentierte Umgebung, unter einen Ordner des Tests verschoben, lädt mit echten Dateien als gültige Konfiguration des Runners; die Ordner im Zustandsordner mit `stateFolders`; die Signale mit `runnerSignals`; die Exit-Codes mit `runnerSeverities` und `exitCodeOf` samt Reihenfolge; die Exit-Codes von [`ecclium doctor`](../betrieb/doctor.md) mit den Codes, die sein Befehl nennt; die Namen der Metriken mit `metricNames`; die Frist beim Stoppen mit der Nachfrist der Sperrdatei.
- **Probe, am 13.11.2026:** wie im Kontext beschrieben.
- **Offen:** Der E2E-Job in CI startet den Runner nach diesem Vertrag mit Compose unter Linux. Die vier Befehle oben laden noch die Konfiguration über stdio. Grenzen für Prozesse und Speicher misst der E2E-Job.
