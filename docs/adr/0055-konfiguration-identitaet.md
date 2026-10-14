# ADR 0055: Konfiguration, Identität und Mandantenkontext, mit der Tabelle der Variablen

- Status: Vorgeschlagen
- Datum: 14.10.2026
- Fällt vor: Phase 1

## Kontext

Bevor der Server einen Aufruf annimmt, muss er wissen, mit welcher ChurchTools-Instanz und welchem Token er arbeitet, wer ihn benutzt und mit welchen Einschränkungen. Diese Angaben kommen von der Person, die den Server betreibt, meist als Umgebungsvariablen in der Konfiguration ihres KI-Assistenten. Ein Fehler darin darf nicht still zu einem unsicheren Betrieb führen.

Folgende Entscheide und Bedrohungen geben den Rahmen vor:

- **Threat Model:**
  - T1: Daten einer Gemeinde erscheinen bei einer anderen.
  - T4: ein Login-Token fliesst ab.
  - T5: Personendaten erreichen das Protokoll.
  - T18: was auf stdout und stderr schreiben darf.
- **ADR 0003:** Der Mandant ist ein ausdrücklicher Parameter. Im Self-Hosting gibt es genau einen, `default`.
- **ADR 0023:** Ein Token kommt aus einer Datei, über stdio ausnahmsweise aus der Umgebung, mit Warnung beim Start.
- **ADR 0037:** Eine einzige Stelle macht aus einer geprüften Anmeldung eine Identität.
- **ADR 0051:** Kein Zustand auf Modulebene.
- **ADR 0053:** Orte für stdout und stderr.
- **ADR 0054:** `Secret`, die Muster des Audits und die Ersatzwerte `invalid`.

Geprüft an Node.js 24.21.0 und zod 4.6.5:

- **Umgebung:** Unter Linux und macOS unterscheidet `process.env` Gross- und Kleinschreibung, auch bei Kindprozessen. `ECCLIUM_X`, `ecclium_x` und `Ecclium_X` sind dort drei Variablen. Unter Windows sucht Node.js einen Namen ohne Rücksicht darauf, `Object.keys` liefert ihn aber so, wie er gesetzt ist. Sein Prototyp liefert geerbte Namen wie `toString`, die `in` findet, `Object.keys` aber nicht. Ein leerer Wert ist gesetzt und leer, nicht fehlend.
- **zod:**
  - `z.coerce.boolean` macht aus `"false"` den Wert `true`.
  - `z.stringbool` nimmt `yes`, `1` und `TRUE` an.
  - `z.coerce.number` nimmt `0x10` und `1e3` an.
  - `z.url` kürzt Leerraum, entfernt Tabulatoren und nimmt Zugangsdaten und `http:` an.
- **Adressen:** Der WHATWG-Parser macht aus vielen Schreibweisen dieselbe Origin, etwa Grossbuchstaben, `:443`, `ex%61mple`, einem Rückstrich, einem Tabulator im Host oder einem `ｅ` in voller Breite. Aus `https://example.church.tools%2F@other.example/` wird die Origin `https://other.example`. Ein Punkt am Ende bleibt in der Origin, und die Schreibweisen `0xC0.0.2.1` und `3221225985` werden zu `192.0.2.1`.
- **Öffnen der Token-Datei:**
  - `O_NOFOLLOW` weist nur einen Link an der letzten Stelle des Pfads ab, nicht in einem Ordner darüber.
  - Ohne `O_NONBLOCK` blockiert das Öffnen einer FIFO, bis jemand schreibt.
  - Ein Ordner, `/dev/zero` und `/dev/null` lassen sich öffnen.
  - `fstat` auf dem geöffneten Deskriptor zeigt Art, Eigentümer, Rechte und Grösse der Datei, auch wenn danach jemand eine andere Datei an denselben Pfad legt.
- **Lesen der Token-Datei:**
  - `readFileSync` auf einem Deskriptor liest bis zum Ende, auch wenn die Datei nach der Prüfung der Grösse gewachsen ist.
  - Nach einem Treffer eines regulären Ausdrucks steht die Eingabe in `RegExp.$_`, lesbar für jeden Code im Prozess.
- **Befehle:** `parseArgs` aus `node:util` wiederholt ein unerwartetes Argument wörtlich in seiner Fehlermeldung.

## Optionen

1. **Namen der Variablen:** ohne Präfix wie `READ_ONLY`, oder mit Präfix `ECCLIUM_`. Ohne Präfix lässt sich eine vertippte Variable nicht von `HOME` oder `PATH` unterscheiden, und der Start kann bei ihr nicht abbrechen.
2. **Prüfen der Werte:** mit den Umwandlungen von zod, oder exakt mit eigenen Regeln. Die Umwandlungen machen aus Tippfehlern gültige Werte.
3. **Token-Datei:** mit `readFileSync` und einer Prüfung der Rechte über den Pfad, oder über einen Deskriptor mit Grenze. Nur der Deskriptor schliesst den Wechsel der Datei, eine FIFO und ein unbegrenztes Lesen aus.
4. **Deutsche Startmeldungen nach stderr:** über den Logger, über `packages/cli/src/output/`, oder über einen eigenen Ort. Der Logger schreibt nur ASCII und hat kein Feld für Text. `output/` darf der Betrieb über stdio nicht erreichen.

## Entscheid

Jede Variable trägt das Präfix `ECCLIUM_`. Werte werden exakt geprüft, die Token-Datei über einen Deskriptor gelesen. Startmeldungen erhalten einen eigenen Ort, der nur nach stderr schreibt.

### Quellen und Vorrang

- Der Vorrang lautet: Flag der Kommandozeile, dann Umgebung, dann `config.yaml`, dann Voreinstellung. Ein Geheimnis in `config.yaml` bricht den Start ab.
- In Phase 1 gibt es nur Umgebung, Dateien über `*_FILE` und Voreinstellungen. `config.yaml` und Flags für Werte folgen später. Optionen eines Befehls wie `--show-values` sind keine Konfiguration.
- Der Kern liest `process.env` nie selbst. Die Kommandozeile reicht die Umgebung als Parameter weiter. Eine Architekturregel erlaubt das Lesen von `process.env` nur ihrem Einstieg.

### Namen

- Der Start bricht bei jeder Variable mit dem Präfix ab, die nicht genau ein bekannter Name ist. Das Präfix wird ohne Rücksicht auf die Schreibweise erkannt.
- Ein bekannter Name in anderer Schreibweise ergibt eine Meldung mit dem richtigen Namen. Namen späterer Phasen ergeben «wird von dieser Version noch nicht unterstützt»: `ECCLIUM_TOOLSETS`, `ECCLIUM_WRITE_CONFIRMATION`, `ECCLIUM_STATE_DIR`, `ECCLIUM_EGRESS`, `ECCLIUM_EGRESS_ALLOW_LAN` und `ECCLIUM_ALLOWED_HOSTS`.
- `ECCLIUM_EGRESS_PROXY` bricht ab, bis ein ausdrücklicher Proxy mit ADR 0035 kommt.
- Mandant, Modus, Transport und Akteur sind keine Variablen. `ECCLIUM_TENANT`, `ECCLIUM_MODE`, `ECCLIUM_TRANSPORT` und `ECCLIUM_ACTOR` sind deshalb unbekannt und brechen ab.
- Die eigenen Variablen des Repositorys mit diesem Präfix, etwa die der Proben, haben keine Ausnahme. Server und Proben laufen nicht in derselben Shell, und Tests mit Kindprozessen geben eine ausdrücklich gefilterte Umgebung weiter.
- Ein Tippfehler im Präfix selbst, etwa `ECLIUM_READ_ONLY`, fällt nicht auf. Es bleiben dann die sicheren Voreinstellungen, und ohne Adresse oder Token bricht der Start ohnehin ab.
- `NODE_TLS_REJECT_UNAUTHORIZED` mit dem Wert `0` bricht den Start ab, in jeder Schreibweise des Namens, weil Node.js ihn unter Windows ohne Rücksicht darauf liest. Mit diesem Wert prüfte Node.js die Zertifikate von ChurchTools nicht mehr. Es ist die einzige Variable ohne Präfix, die der Lader liest.

### Werte

- Jeder Wert ist genau so zu schreiben, wie die Tabelle ihn nennt. Wahrheitswerte sind genau `true` oder `false`, Aufzählungen exakt.
- Ein leerer Wert ist ein Fehler, nicht «nicht gesetzt».
- Jeder Wert hat eine Höchstlänge, die vor jedem Muster geprüft wird. Kein Wert wird gekürzt, umgewandelt oder normalisiert.
- Keine Meldung und keine Fehlermeldung enthält einen eingegebenen Wert, weil ein Token in der falschen Variable stehen kann. Der Bericht des Laders enthält nie das Token, den Pfad der Token-Datei oder einen abgewiesenen Wert. Er nennt Werte aus der Tabelle und geprüfte Werte, darunter Host und Port der Adresse und das Subjekt. Diese maskiert die Kommandozeile, wie der Abschnitt zu `ecclium config check` festlegt.
- zod wird nur gefragt, ob ein Wert passt, nie nach seinem Fehler. Das Token und die Adresse prüft eigener Code, weil zod sie umwandeln würde.

### Tabelle der Variablen (Phase 1)

| Variable                         | Werte                            | Voreinstellung | Geheimnis  | Nur über stdio       | Beim Start                                                                      |
| -------------------------------- | -------------------------------- | -------------- | ---------- | -------------------- | ------------------------------------------------------------------------------- |
| `ECCLIUM_CHURCHTOOLS_URL`        | kanonische Origin mit `https`    | keine          | nein       | nein                 | fehlt oder ungültig: Abbruch                                                    |
| `ECCLIUM_CHURCHTOOLS_TOKEN_FILE` | absoluter Pfad                   | keine          | der Inhalt | nein                 | eine Prüfung der Datei scheitert: Abbruch                                       |
| `ECCLIUM_CHURCHTOOLS_TOKEN`      | Login-Token                      | keine          | ja         | ja                   | sonst Abbruch; mit `_FILE` zusammen Abbruch; über stdio Warnung bei jedem Start |
| `ECCLIUM_READ_ONLY`              | `true`, `false`                  | `true`         | nein       | nein                 | ungültig: Abbruch                                                               |
| `ECCLIUM_REDACTION`              | `standard`, `off`, `strict`      | `standard`     | nein       | `off` nur über stdio | `strict` bricht ab, bis die vollständige Maskierung steht; `off` warnt          |
| `ECCLIUM_SEARCH_TOOLS`           | `true`, `false`                  | `false`        | nein       | nein                 | `true`: Startmeldung, die beide Suchtools nennt                                 |
| `ECCLIUM_STDIO_SUBJECT`          | Bezeichnung nach Muster          | `local-stdio`  | nein       | ja                   | ungültig oder `invalid`: Abbruch                                                |
| `ECCLIUM_LOG_LEVEL`              | `debug`, `info`, `warn`, `error` | `info`         | nein       | nein                 | ungültig: Abbruch                                                               |

Fest und nicht konfigurierbar sind:

- der Mandant über stdio: `default`;
- der Modus: die Wurzel der Komposition legt ihn fest;
- die Liste der Funktionen: im freien Kern leer.

Eine Variable für die Drosselung kommt mit dem ChurchTools-Client dazu, ebenso jede weitere Variable einer späteren Phase.

### Adresse der Instanz

- `ECCLIUM_CHURCHTOOLS_URL` muss genau die kanonische Origin mit `https` sein, mit oder ohne abschliessenden `/`. Der Server normalisiert nichts. So kann die Positivliste der Hosts nie von dem abweichen, was die Konfiguration angenommen hat.
- Der Host ist ein DNS-Name mit mindestens einem Punkt, nach dem Muster für Hosts aus ADR 0054. Ein internationaler Name kommt nur als Punycode. Jeder Port ausser 0 ist erlaubt.
- Abgewiesen werden:
  - IP-Adressen in jeder Schreibweise;
  - `localhost` und Namen auf `.localhost`;
  - Namen aus einem einzigen Teil;
  - ein Punkt am Ende;
  - Zugangsdaten, Pfad, Query und Fragment.
- Jede Regel hat ihren eigenen Code, und keine Meldung nennt die Adresse.

### Token-Datei

1. Der Pfad muss absolut sein, weil ein KI-Assistent den Server aus einem unbekannten Arbeitsordner startet.
2. Geöffnet wird mit `O_RDONLY`, `O_NOFOLLOW`, `O_NONBLOCK` und `O_NOCTTY`.
3. Auf dem Deskriptor muss die Datei eine reguläre Datei sein, die dem eigenen Benutzer gehört und keine Rechte für Gruppe oder andere hat.
4. Angenommen werden höchstens 4098 Bytes. Gelesen wird in einer Schleife über `readSync` höchstens ein Byte mehr, damit eine längere Datei auffällt.
5. Genau ein abschliessender Zeilenumbruch, LF oder CR LF, wird entfernt. Jedes übrige Byte muss ein sichtbares ASCII-Zeichen sein. Geprüft wird Byte für Byte, nie mit einem regulären Ausdruck. Dann entsteht das `Secret`.
6. Ein BOM von UTF-8 oder UTF-16 wird abgewiesen, mit eigenem Hinweis, nie entfernt.
7. Kein Fehler gibt die Meldung des Dateisystems weiter, weil sie den Pfad enthält.

Grenzen:

- Ordner über der Datei gelten als vertrauenswürdig, weil `O_NOFOLLOW` sie nicht prüft.
- Fehlen `process.getuid` oder `O_NOFOLLOW`, wie unter Windows, bricht das Lesen ab, statt die Prüfung des Eigentümers zu überspringen. Dort bleibt nur das Token in der Umgebung über stdio.
- Secret-Mounts von Containern und Kubernetes werden abgewiesen, weil sie über Links oder mit anderen Rechten kommen. Eine Lockerung für das offizielle Image folgt in Phase 7.

### Token aus der Umgebung

- `ECCLIUM_CHURCHTOOLS_TOKEN` gilt nur, wenn die Wurzel der Komposition den Server über stdio startet. Das legt der Befehl fest, nie eine Variable.
- Jeder Start meldet die Warnung, dass das Token im Klartext in der Konfiguration des Assistenten steht und jedem Kindprozess sichtbar wäre.
- Stehen Datei und Variable zusammen, bricht der Start ab, statt eine Quelle stillschweigend vorzuziehen.
- Nach dem Laden entfernt die Kommandozeile die Variable aus `process.env`. Unter Linux zeigt `/proc/<pid>/environ` weiter den Stand beim Start.

### Identität und Mandant über stdio

- Die Identität über stdio hat die Quelle `stdio` und das Subjekt aus `ECCLIUM_STDIO_SUBJECT`.
- Das Subjekt ist eine neutrale Bezeichnung nach dem Muster `^[a-z][a-z0-9-]{0,31}$`, voreingestellt `local-stdio`. `invalid` wird abgewiesen, damit niemand es mit dem Ersatzwert des Audits verwechselt.
- Die Scopes sind `read` und nur bei `ECCLIUM_READ_ONLY=false` zusätzlich `write`. Die Identität behauptet so nie mehr, als die Konfiguration erlaubt.
- Der `TenantResolver` für stdio ordnet den Mandanten `default` und den Akteur zu:
  - Art: `user`. Über stdio ruft eine Person über ihren KI-Assistenten auf, auch wenn sie unbekannt bleibt.
  - ID: `stdio:<Subjekt>`, aus Quelle und Subjekt wie bei einer Anmeldung über HTTP. Ein Akteur über stdio und einer über ein Bearer-Token mit demselben Subjekt verwechseln sich so nie.
- Andere Quellen löst er nicht auf.

### Mandantenkontext

- Der Kern erzeugt für jeden Aufruf eines Tools einen neuen Kontext. Die Fabrik dafür gibt kein Einstieg von `core` heraus, nur Mount und Pipeline erzeugen einen Kontext.
- Kontext und Akteur sind eingefroren und haben keinen Prototyp. Die Liste der Funktionen ist eine eingefrorene Kopie.
- Der Logger im Kontext ist an Mandant, Modus, Maskierung und `readOnly` des Kontexts gebunden, so dass beide nie auseinanderlaufen.
- Die Uhr muss schon eingefroren sein.
- Der Mandant `invalid` und der Akteur `invalid` werden abgewiesen. Das sind die Ersatzwerte aus ADR 0054.
- Nicht eingefroren wird das `AbortSignal`, weil ein eingefrorenes Signal sich nicht mehr abbrechen lässt.

### Maskierung

`strict` bricht den Start ab, bis die vollständige Maskierung steht. `off` gilt nur über stdio, mit Warnung bei jedem Start.

### Freigabe der Suchtools

- `ct_persons_search` und `ct_groups_search` werden nur mit `ECCLIUM_SEARCH_TOOLS=true` registriert. Der Start meldet das dann mit beiden Namen.
- In Phase 2 ersetzt `ECCLIUM_TOOLSETS` diesen Schalter.

### `ecclium config check`

- Der Befehl zeigt jede Einstellung mit ihrer Herkunft: Umgebung, Datei oder Voreinstellung.
- Ein Geheimnis zeigt er nie, weder Wert noch Länge noch Anfang, nur «verborgen» und die Quelle. Bei einer Datei steht dazu, dass Eigentümer und Dateirechte geprüft sind.
- Den Pfad zur Token-Datei und ungültige Werte zeigt er nie.
- Host und ein abweichendes Subjekt sind maskiert, mit `--show-values` sichtbar. So passt die Ausgabe ohne Bearbeitung in ein öffentliches Issue.
- Namen unbekannter Variablen nennt er, wenn sie dem Muster `^ECCLIUM_[A-Z0-9_]{1,64}$` folgen, damit sich ein Tippfehler finden lässt.
- Er fragt ChurchTools nicht an und sagt das.
- Fehler beim Aufruf erscheinen mit festen Texten, nie mit der Meldung von `parseArgs`.
- Exit-Codes:

  | Code | Bedeutung               |
  | ---- | ----------------------- |
  | 0    | gültige Konfiguration   |
  | 64   | falscher Aufruf         |
  | 70   | interner Fehler         |
  | 78   | ungültige Konfiguration |

### Startmeldungen

- Der Kern meldet Probleme und Warnungen nur als Codes. Die deutschen Texte stehen in einem Katalog in `packages/cli/src/messages/`.
- Vor dem Start über stdio schreibt `packages/cli/src/notices/` sie nach stderr, Zeile für Zeile mit `writeSync`, nie über `process.stderr`. Der Ort schreibt nur Texte aus dem Katalog und ist damit kein Kanal für freien Text.
- ADR 0053 legt fest, dass nach stderr nur der Logger und die Meldungen der Kommandozeile schreiben, und dass die Orte im Code in `tests/architecture/boundaries.json` stehen. Die Startmeldungen sind solche Meldungen der Kommandozeile, nur aus einem Ordner, den der Betrieb über stdio erreichen darf. Der neue Ort setzt ADR 0053 deshalb um, er ändert es nicht.

## Konsequenzen

- **Strenge Fehler beim Start:** Wer `READ_ONLY` aus einer alten Vorlage ohne Präfix übernimmt, bekommt keine Wirkung. Wer `ecclium_read_only` schreibt, bekommt einen Abbruch mit dem richtigen Namen.
- **Proben und Server getrennt:** Die Proben des Repositorys und der Server laufen nicht in derselben Shell, und jeder Test mit Kindprozessen gibt seine Umgebung ausdrücklich vor.
- **Subjekt als Name:** Ein Name in der Form `max-mustermann` passt auf das Muster des Subjekts. Das Muster schliesst E-Mail-Adressen, Leerzeichen, Punkte und Grossbuchstaben aus, aber keinen Namen als Bezeichnung. Pseudonyme und Kontingente folgen dem Subjekt.
- **Token in der Umgebung:** Es steht im Klartext in der Konfiguration des Assistenten. Unter Linux kann derselbe Benutzer es in `/proc` lesen, solange der Prozess läuft.
- **Token-Datei:** Ordner über der Datei und Zugriffslisten von macOS prüft der Server nicht. Unter macOS besteht `/dev/fd/0` jede Prüfung, wenn stdin aus einer eigenen Datei mit den Rechten 0600 kommt. Unter Windows gibt es keine Token-Datei.
- **Namen in der Ausgabe:** Unbekannte Variablennamen erscheinen in `config check` und in den Startmeldungen. Ein Name trägt nie einen Wert, eine erfundene Bezeichnung könnte aber Text tragen.
- **Host sichtbar:** Mit `--show-values` zeigt `config check` den Host der Instanz.
- **Zustand von zod:** Die Schemas von zod auf Modulebene ändern beim ersten Prüfen innere Zwischenspeicher, wie in ADR 0054.
- **Lesen der Umgebung:** Andere Pakete könnten `process.env` lesen, wenn die Regel dazu fehlt. Deshalb steht sie, bevor ein Paket die Umgebung braucht.
