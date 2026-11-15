# Runner einrichten

**In Entwicklung.** Es gibt noch keine veröffentlichte Version, kein Image und kein Bundle für das Self-Hosting. Diese Seite führt der Reihe nach vom gebauten Quellcode bis zur ersten Routine, die nach Zeitplan läuft, auf einem Rechner unter Ihrem Benutzer. Die Einzelheiten zu jedem Schritt stehen in der Referenz [Runner der Routinen](runner.md). Was in einem Lauf geschieht und warum Ecclium ihn so eng führt, steht unter [Routinen und Läufe](../workflows.md).

Ecclium ist ein unabhängiges Projekt und steht in keiner Verbindung zum Hersteller von ChurchTools.

## Zuerst die Grenzen

- Der Runner schreibt, ohne dass eine Person bestätigt. Gehen Sie die Schritte in dieser Reihenfolge: erst prüfen, dann der Eintrag der Richtlinie und die Vorschau, dann ein Lauf von Hand, zuletzt der Zeitplan.
- Eine Routine mit Modell gibt Daten Ihrer Gemeinde an den Anbieter des Modells, maskiert, aber nicht anonym. Klären Sie vor Schritt 5, was unter [Datenschutz](../privacy.md#was-an-den-anbieter-des-sprachmodells-geht) steht.
- Direkt auf einem Rechner hat der Runner keine Grenze im Netz. Die gibt es erst in einem Container an einem internen Netz hinter dem Proxy (Schritt 12).
- Die Befehle dieser Seite sind am gebauten Stand geprüft, soweit sie ChurchTools nicht brauchen. Ein Lauf mit einem echten Modell an einer Testinstanz mit synthetischen Daten steht noch aus.

## Was Sie brauchen

- Den gebauten Checkout und den Pfad von Node.js, wie unter [Betrieb über stdio](stdio.md#bauen). Der Runner ist derselbe Einstieg `packages/cli/dist/bin.js` mit anderen Befehlen.
- Einen Rechner, der zu den Zeiten der Routinen läuft, mit einem lokalen Dateisystem, kein Netzlaufwerk und kein synchronisierter Ordner.
- In ChurchTools das Recht, Dienstkonten anzulegen und ihnen Rechte zu geben.
- Für eine Routine mit Modell einen Anbieter mit einer Chat-Schnittstelle nach dem Vorbild von OpenAI über `https` und einen Schlüssel dafür ([Anbieter](../providers.md)).

Den Server über stdio brauchen Sie dafür nicht. Runner und Server teilen kein Token: Der Runner startet nicht, wenn `ECCLIUM_CHURCHTOOLS_TOKEN_FILE` oder `ECCLIUM_CHURCHTOOLS_TOKEN` gesetzt ist.

## Welche Routine zuerst

Ecclium bringt drei Routinen mit ([Mitgelieferte Routinen](../../routines/README.md)). Sie brauchen verschieden viel:

| Routine             | Schreibt                          | Konto                        | Modell | Braucht zusätzlich                                                        |
| ------------------- | --------------------------------- | ---------------------------- | ------ | ------------------------------------------------------------------------- |
| `termin-vorschau`   | eine Datei, nichts in ChurchTools | das eigene Konto des Runners | ja     | Anbieter, Schlüsseldatei der Pseudonyme, Ordner der Entwürfe              |
| `wiki-hygiene`      | einen Abschnitt im Wiki           | ein Konto mit Eintrag        | nein   | Eintrag der Richtlinie, Schreiben eingeschaltet                           |
| `dienstplan-report` | einen Abschnitt im Wiki           | ein Konto mit Eintrag        | ja     | Anbieter, Schlüsseldatei der Pseudonyme, Eintrag, Schreiben eingeschaltet |

Beginnen Sie mit einer Routine und nehmen Sie die nächste erst dazu, wenn die erste läuft. Die Beispiele richten `dienstplan-report` ein. Wo eine andere Routine weniger braucht, steht es dabei.

## 1. Ordner anlegen

```sh
mkdir -m 700 /pfad/zum/runner
mkdir -m 700 /pfad/zum/runner/secrets /pfad/zum/runner/data /pfad/zum/runner/keys /pfad/zum/runner/log
mkdir -m 755 /pfad/zum/runner/config /pfad/zum/runner/config/routines /pfad/zum/runner/config/stop
```

- `config` hält die Richtlinie, die Datei der Anbieter, die Routinen und in `stop` die Kill-Switches. Nichts darin ist ein Geheimnis. Jede Datei gehört Ihrem Benutzer, und weder Gruppe noch andere dürfen darin schreiben.
- `secrets` hält die Token-Dateien und Schlüssel. Der Ordner liegt nie im Zustandsordner, damit keine Sicherung des Zustandsordners ein Token enthält.
- `data` ist der Zustandsordner mit Audit, Zählern, Snapshots, Freigabe-Warteschlange und Sperrdateien. Er muss zwischen zwei Läufen erhalten bleiben: Ohne ihn gelten die Grenzen je Tag nicht, und eine Routine läuft für eine erledigte Periode noch einmal.
- `keys` hält die Tagesschlüssel der Snapshots und der Warteschlange. Sichern Sie diesen Ordner nie ([Datenschutz](../privacy.md#tagesschlüssel)).
- `log` nimmt die Ausgabe des Runners auf, wenn cron ihn startet (Schritt 11).

Die Aufteilung entspricht den Pfaden `/config`, `/run/secrets`, `/data` und `/keys` im Container ([Runner der Routinen](runner.md#container)).

## 2. Konten in ChurchTools

Der Runner arbeitet nie mit dem Konto des Servers. Legen Sie eigene Dienstkonten an, wie unter [Dienstkonto in ChurchTools](dienstkonto.md) beschrieben, jedes mit eigenem Status ohne Rechte und ohne Mitgliedschaft in einer Gruppe:

- **Das eigene Konto des Runners,** hier mit dem Alias `runner`. Mit ihm liest jede Routine, die keinen Eintrag in der Richtlinie hat, von den mitgelieferten `termin-vorschau`. Es schreibt nie, und kein Eintrag der Richtlinie darf es nennen. Der Runner verlangt seine Token-Datei bei jedem Start, auch wenn noch keine Routine damit liest.
- **Je ein Konto für Routinen, die ins Wiki schreiben,** mit einem Alias Ihrer Wahl, etwa `berichte`. Den Alias nennt der Eintrag der Routine in der Richtlinie als `credential`.

Geben Sie jedem Konto genau die Rechte seiner Routinen. Welche das sind, steht je Routine unter [Mitgelieferte Routinen](../../routines/README.md). Hat ein Konto mehr, schreibt ein Lauf nicht, sondern legt seinen Abschnitt in die Freigabe-Warteschlange.

Legen Sie für einen Bericht im Wiki die Kategorie und die Seite selbst an, etwa die Kategorie «Berichte» mit der Seite «Dienstplan-Auswertung». Ecclium legt keine Seite an. Der Bericht nennt Personen mit ihrem Namen: Wählen Sie eine Kategorie, die nur die Personen sehen, die diese Daten in ChurchTools ohnehin sehen.

## 3. Token-Dateien

Legen Sie je Konto eine Datei an, wie unter [Betrieb über stdio](stdio.md#token-datei), mit dem Namen `ct_token_` und dem Alias:

```sh
(umask 077 && touch /pfad/zum/runner/secrets/ct_token_runner /pfad/zum/runner/secrets/ct_token_berichte)
```

Öffnen Sie jede Datei in einem Editor und fügen Sie das Login-Token des Kontos als einzige Zeile ein. Geben Sie ein Token nie auf der Kommandozeile ein. Der Runner liest jede Token-Datei für jeden Lauf neu. Ein neues Token wirkt deshalb ohne Neustart: Legen Sie die neue Datei daneben an und ersetzen Sie die alte durch Umbenennen.

## 4. Schlüsseldateien

```sh
(umask 077 && openssl rand -hex 32 > /pfad/zum/runner/secrets/pseudonym_key)
(umask 077 && openssl rand -hex 32 > /pfad/zum/runner/secrets/runner_mac_key)
```

- `pseudonym_key` braucht jede Routine mit Modell, auch für eine Vorschau, weil ihre Daten in der Stufe `strict` zum Modell gehen ([Betrieb über stdio](stdio.md#schlüsseldatei-anlegen)). `wiki-hygiene` braucht ihn nicht.
- `runner_mac_key` ist der Schlüssel des Prüfcodes der Kennzeichnung. Ihn braucht jede Routine, die ins Wiki schreibt. Sichern Sie ihn: Ein neuer Schlüssel macht jeden bisherigen Prüfcode ungültig ([Sicherheit](../security.md#schlüssel-des-prüfcodes)).

Beide Dateien enthalten verschiedene Schlüssel, sonst startet Ecclium nicht.

## 5. Anbieter des Modells

Für eine Routine mit Modell legen Sie die Datei der Anbieter an und daneben, in `secrets`, die Datei mit dem Schlüssel des Anbieters, wie eine Token-Datei. `wiki-hygiene` braucht beides nicht.

```yaml
# /pfad/zum/runner/config/providers.yaml
schema: providers.v1
providers:
  - alias: default
    vendor: example
    model: example-maker/example-model-1
    hostingCountry: CH
    endpoint: https://model.example.org/v1/chat/completions
    structuredOutput: true
    apiKeyFile: /pfad/zum/runner/secrets/model_api_key
```

Anbieter, Modell, Land und Adresse setzen Sie nach den Angaben Ihres Anbieters ([Anbieter](../providers.md)). Liegt sein Rechenzentrum ausserhalb der Schweiz und des EWR, verlangt Ecclium `transferBasis`, sonst startet es nicht. Die Datei erhält die Rechte 644.

## 6. Routinen

Kopieren Sie aus dem Ordner `routines` des Checkouts nur die Routinen, die Sie einrichten, mit ihrem Prompt und ihrer Vorlage:

```sh
mkdir -m 755 /pfad/zum/runner/config/routines/prompts /pfad/zum/runner/config/routines/templates
cp /pfad/zum/checkout/routines/dienstplan-report.yaml /pfad/zum/runner/config/routines/
cp /pfad/zum/checkout/routines/prompts/dienstplan-report.md /pfad/zum/runner/config/routines/prompts/
cp /pfad/zum/checkout/routines/templates/dienstplan-report.md /pfad/zum/runner/config/routines/templates/
chmod -R go-w /pfad/zum/runner/config
```

Passen Sie in der Routine an, was die [Mitgelieferten Routinen](../../routines/README.md) nennen, bei `dienstplan-report` Kategorie und Seite unter `output.scope`, bei `termin-vorschau` die Kalender unter `calendarIds`. `wiki-hygiene` hat keinen Prompt.

Legen Sie nur Routinen in den Ordner, die laufen sollen. Eine Routine, die ins Wiki schreibt, hält den ganzen Runner vom Start ab, solange `ECCLIUM_READ_ONLY` nicht `false` ist. Eine Vorschau läuft trotzdem.

## 7. Richtlinie beginnen

Der Runner verlangt eine Datei der Richtlinie, auch bevor sie einen Eintrag für eine Routine hat. Beginnen Sie mit dieser, mit den Rechten 644:

```yaml
# /pfad/zum/runner/config/policy.yaml
schema: policy.v1
interactive:
  inquiriesTo: Sekretariat
```

`inquiriesTo` ist der Text nach «Rückfragen an» in der Kennzeichnung jedes Berichts und jedes Entwurfs. Nennen Sie eine Stelle statt einer Person, wenn Sie keinen Namen im Wiki wollen ([Richtlinie](../policy.md)).

## 8. Aufruf und Prüfung

Legen Sie ein kleines Skript an, das den Runner immer mit derselben Umgebung startet, hier `/pfad/zum/runner/ecclium-runner` mit den Rechten 700. Es enthält nur Pfade, keine Geheimnisse:

```sh
#!/bin/sh
exec env -i \
  ECCLIUM_CHURCHTOOLS_URL=https://example.church.tools \
  ECCLIUM_TIME_ZONE=Europe/Zurich \
  ECCLIUM_POLICY_FILE=/pfad/zum/runner/config/policy.yaml \
  ECCLIUM_PROVIDERS_FILE=/pfad/zum/runner/config/providers.yaml \
  ECCLIUM_ROUTINES_DIR=/pfad/zum/runner/config/routines \
  ECCLIUM_KILL_SWITCH_DIR=/pfad/zum/runner/config/stop \
  ECCLIUM_RUNNER_TOKENS_DIR=/pfad/zum/runner/secrets \
  ECCLIUM_PSEUDONYM_KEY_FILE=/pfad/zum/runner/secrets/pseudonym_key \
  ECCLIUM_STATE_DIR=/pfad/zum/runner/data \
  ECCLIUM_EGRESS=off \
  /pfad/zu/node /pfad/zum/checkout/packages/cli/dist/bin.js "$@"
```

- Mit `env -i` sieht der Runner nur diese Variablen und keine aus Ihrer Shell.
- `ECCLIUM_TIME_ZONE` ist Pflicht. In dieser Zone gelten die Zeitpläne.
- `ECCLIUM_EGRESS=off` steht hier, weil der Runner ohne Proxy sonst nicht startet. Jeder Start warnt dann, und jeder Lauf trägt den Vermerk im Audit. Schritt 12 sagt, wie Sie zum Proxy kommen.
- Lassen Sie `ECCLIUM_PROVIDERS_FILE` und `ECCLIUM_PSEUDONYM_KEY_FILE` weg, wenn keine Ihrer Routinen ein Modell hat. Für `termin-vorschau` kommt `ECCLIUM_DRAFTS_DIR=/pfad/zum/runner/data/output` dazu.

Prüfen Sie die Konfiguration, ohne ChurchTools oder ein Modell anzufragen:

```sh
/pfad/zum/runner/ecclium-runner config check --runner
```

Der Befehl zeigt jede Einstellung mit ihrer Herkunft, nie ein Token, und nennt jede Routine mit Zeitplan, Ziel, Konto und Modell. Er endet mit 0, wenn alles stimmt, sonst mit 78 und einem Hinweis zu jedem Problem. Mit `dienstplan-report` im Ordner meldet er jetzt, dass der Runner nicht startet, weil die Routine ins Wiki schreibt und `ECCLIUM_READ_ONLY` nicht auf `false` steht. Das ist an dieser Stelle richtig: Geschrieben wird erst nach Schritt 10. Den Befund, dass der interaktive Teil der Richtlinie keine Einträge hat, dürfen Sie für einen Runner ohne Server stehen lassen.

## 9. Eintrag der Richtlinie und Vorschau

Lassen Sie sich den Eintrag der Routine vorschlagen. Der Befehl liest die Kategorie und die Seite mit dem Konto, mit dem die Routine später schreibt, und ändert keine Datei:

```sh
/pfad/zum/runner/ecclium-runner policy init --routine dienstplan-report --credential berichte
```

Er schreibt einen Punkt der Liste `unattended` auf stdout, mit der Seite über ihre Kennung und ihren Namen, dem Konto, dem Tool und den Grenzen je Lauf und je Tag. Was er nicht vorschlagen kann, etwa eine Seite, die fehlt, steht als Kommentar da. Prüfen Sie den Vorschlag und fügen Sie ihn in die Richtlinie ein, unter einer Zeile `unattended:` ([Richtlinie](../policy.md#vorschlag-für-eine-routine)). Die Stufe `standard` zum Modell und die Ausnahme `acceptRightsDrift` schlägt Ecclium nie vor.

Sehen Sie sich dann an, was ein Lauf schreiben würde:

```sh
/pfad/zum/runner/ecclium-runner run-once dienstplan-report --preview
```

Die Vorschau liest mit dem Konto aus dem Eintrag, fragt das Modell und zeigt den Abschnitt auf stdout, ohne die Zeile der Kennzeichnung. Sie schreibt nichts. Lesen und Modell kosten wie bei einem Lauf. Stimmt der Abschnitt nicht, ändern Sie Prompt, Vorlage oder Routine und sehen Sie ihn sich erneut an.

Hat eine Routine keinen Eintrag, liest die Vorschau mit dem eigenen Konto des Runners. So sehen Sie `termin-vorschau`, die nie einen Eintrag braucht.

## 10. Schreiben einschalten und ein Lauf von Hand

Für eine Routine, die ins Wiki schreibt, ergänzen Sie im Skript aus Schritt 8:

```sh
  ECCLIUM_READ_ONLY=false \
  ECCLIUM_KEYS_DIR=/pfad/zum/runner/keys \
  ECCLIUM_MARKER_KEY_FILE=/pfad/zum/runner/secrets/runner_mac_key \
```

Prüfen Sie erneut mit `config check --runner`. Der Befehl nennt die Routine jetzt unter «Routinen, die starten», mit ihrem Konto. Starten Sie dann einen Lauf von Hand:

```sh
/pfad/zum/runner/ecclium-runner run-once dienstplan-report
```

Der Lauf zählt gegen die Grenzen der Richtlinie wie jeder andere. Danach steht auf der Seite ein Abschnitt für die Periode, mit der Kennzeichnung am Ende. Die Kennung des Laufs steht in seiner Zeile auf stderr:

```sh
/pfad/zum/runner/ecclium-runner audit show --run <Lauf>
```

Der Befehl zeigt, was der Lauf gelesen und geschrieben hat. Starten Sie den Lauf ein zweites Mal: Er ändert den Abschnitt der Periode oder lässt ihn stehen, er hängt keinen zweiten an. Endet ein Lauf mit einem anderen Code als 0, sagt die Tabelle der [Exit-Codes](runner.md#exit-codes), was zu tun ist. Legt er seinen Abschnitt in die Freigabe-Warteschlange, nennt `ecclium queue list --runner` den Grund, meist zu weite Rechte des Kontos oder ein anderer Name des Ziels.

## 11. Zeitplan

Am einfachsten ruft cron alle 15 Minuten den Einzellauf auf. Er führt jede Routine aus, die fällig ist, und endet:

```text
*/15 * * * * /pfad/zum/runner/ecclium-runner run-once --due >> /pfad/zum/runner/log/runner.log 2>&1
```

- Wie oft cron ruft, ändert nicht, wie oft eine Routine läuft: Fällig ist nur die letzte geplante Auslösung, solange kein Lauf sie abgeschlossen hat. Nach einer vorübergehenden Störung versucht ein späterer Aufruf dieselbe Auslösung noch höchstens zweimal.
- Rotieren Sie die Datei im Ordner `log`. Sie enthält die Zeilen des Logs und die Kopien des Audits ohne Kennungen, keine Inhalte aus ChurchTools.
- Statt cron können Sie den Daemon `ecclium-runner runner` unter einem Aufseher betreiben, der ihn nach den Exit-Codes 75, 69 und 70 neu startet und ihm beim Stoppen mindestens 5 Minuten gibt ([Runner der Routinen](runner.md#aufseher-und-lebenszeichen)). Routinen, Richtlinie und Anbieter liest der Daemon nur beim Start.

## 12. Grenze im Netz

Mit `ECCLIUM_EGRESS=off` begrenzt nur die Positivliste im Code, wohin der Runner verbindet. Die Grenze im Netz setzt voraus, dass der Runner selbst keinen direkten Weg nach aussen hat:

- Der Runner läuft in einem Container an einem internen Netz, mit `ECCLIUM_EGRESS_PROXY=http://egress:3128` an Stelle von `ECCLIUM_EGRESS=off`.
- Nur ein zweiter Container mit Squid verbindet nach aussen, mit der Vorlage aus `deploy/selfhost/egress/` und der Liste der Ziele aus `ecclium-runner init egress` ([Grenze im Netz mit Squid](egress.md)).
- Was der Container des Runners vorfinden muss, steht unter [Runner der Routinen](runner.md#container): Benutzer, Pfade, Variablen, nur lesbares Dateisystem, Signale und Grenzen.

Die Compose-Datei, die beides zusammenstellt, kommt mit dem Bundle für das Self-Hosting. Bis dahin bauen Sie den Aufbau selbst nach diesen beiden Seiten. Der Job `e2e` in CI startet ihn bei jedem Pull Request mit `scripts/e2e/compose.yaml`. Diese Datei ist für Tests gemacht, nicht für den Betrieb, zeigt aber die Netze und Einbindungen.

Ob der Weg steht, prüft `ecclium-runner doctor` dort, wo der Runner läuft: einen Tunnel zu jedem Ziel der Liste, 403 für einen Namen ausserhalb und keinen direkten Weg zu ChurchTools. Er liest dazu die Rechte jedes Kontos des Runners und meldet zu weite und fehlende ([Prüfen mit `ecclium doctor`](doctor.md)). Mit `ECCLIUM_EGRESS=off` prüft er den Weg nicht und meldet das als Befund.

## 13. Überwachen

- **Meldungen:** Die mitgelieferten Routinen melden jeden Lauf als eine Zeile JSON auf stdout, ohne Inhalt. Mit `ECCLIUM_NOTIFY_FILE` und dem Kanal `file` in der Routine gehen sie in eine Datei ([Runner der Routinen](runner.md#meldungen)).
- **Metrikdatei:** Mit `ECCLIUM_RUNNER_METRICS_FILE` schreibt der Runner je Routine den nächsten Lauf, den letzten Erfolg und den letzten Ausgang im Textformat von Prometheus ([Runner der Routinen](runner.md#metrikdatei)).
- **Ping:** Mit `ECCLIUM_RUNNER_PING_URL_FILE` meldet er Erfolg oder Fehler an eine Prüfung im Format von Healthchecks. So erfahren Sie auch, wenn der Runner gar nicht mehr läuft ([Runner der Routinen](runner.md#ping-an-eine-überwachung)).
- **Lesen:** Lesen Sie die ersten Berichte einer neuen Routine und danach regelmässig einen. Ob der Inhalt stimmt, prüft Ecclium nicht.

## Im Betrieb

- **Anhalten:** Eine leere Datei `writes-off` im Ordner `config/stop` hält jeden Lauf an, `writes-off-routine-<Routine>` die Läufe einer Routine, ohne Neustart ([Runner der Routinen](runner.md#anhalten)).
- **Freigabe-Warteschlange:** `ecclium-runner queue list --runner` zeigt, was wartet und warum, `queue show --runner <Kennung>` den ganzen Unterschied, `queue approve --runner <Kennung>` gibt frei, `queue reject --runner <Kennung>` weist ab. Ein Eintrag verfällt nach 14 Tagen.
- **Rücknahme:** `ecclium-runner undo --run <Lauf>` nimmt zurück, was ein Lauf ins Wiki geschrieben hat, in der Voreinstellung 30 Tage lang ([Runner der Routinen](runner.md#rücknahme)).
- **Neues Token:** Ersetzen Sie die Token-Datei durch Umbenennen. Nach einem Vorfall ändern Sie zuerst das Passwort des Kontos ([Dienstkonto in ChurchTools](dienstkonto.md#nach-einem-vorfall)).
- **Sicherung:** Sichern Sie `config` und `data`, Entwürfe in `data/output` nur so lange wie nötig. Die Dateien aus `secrets` sichern Sie getrennt wie andere Zugangsdaten, vor allem `runner_mac_key`. `keys` sichern Sie nie.
- **Nach einer Änderung** an Routinen, Richtlinie, Anbietern oder Rechten: `config check --runner`, dann `doctor`, dann eine Vorschau.

## Grenzen

- Diese Seite beschreibt den Betrieb aus dem Quellcode unter Ihrem Benutzer. Wer unter diesem Benutzer Programme ausführt oder den Rechner verwaltet, kann Token, Schlüssel und Zustand lesen und ändern.
- Ohne Container und Proxy gibt es keine Grenze im Netz (Schritt 12).
- Die Uhr des Rechners, den Ablauf der Tokens und die Rechte des Kontos des Servers prüft `ecclium doctor` noch nicht.
- Ob Ihr Anbieter die Anfragen so annimmt, wie Ecclium sie sendet, zeigt erst die erste Vorschau mit ihm ([Anbieter](../providers.md#chat-schnittstelle)).
