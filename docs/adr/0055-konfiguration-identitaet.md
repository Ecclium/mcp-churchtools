# ADR 0055: Konfiguration, Identität und Mandantenkontext, mit der Tabelle der Variablen

- Status: Angenommen am 23.10.2026
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
- **Befehle:** `parseArgs` aus `node:util` wiederholt eine unbekannte Option wörtlich in seiner Fehlermeldung. Eine Option, die zweimal im Aufruf steht, nimmt es ohne Fehler an.

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
- Der Kern liest `process.env` nie selbst. Die Kommandozeile reicht die Umgebung als Parameter weiter. Eine Architekturregel weist das Lesen von `process.env`, `process.argv`, `process.execArgv` und `process.report` ausserhalb ihres Einstiegs ab, in den Formen, die sie im Code sieht, ebenso einen Aufruf von `parseArgs` ohne `args`, der `process.argv` selbst liest. Was sie nicht sieht, steht unter «Konsequenzen». Auch ein Argument kann ein Token enthalten, und der Bericht des Prozesses nennt die ganze Umgebung.

### Namen

- Der Start bricht bei jeder Variable mit dem Präfix ab, die nicht genau ein bekannter Name ist. Das Präfix wird ohne Rücksicht auf die Schreibweise erkannt.
- Ein bekannter Name in anderer Schreibweise ergibt eine Meldung mit dem richtigen Namen. Namen späterer Phasen ergeben «wird von dieser Version noch nicht unterstützt»: `ECCLIUM_TOOLSETS`, `ECCLIUM_WRITE_CONFIRMATION`, `ECCLIUM_EGRESS`, `ECCLIUM_EGRESS_ALLOW_LAN` und `ECCLIUM_ALLOWED_HOSTS`. `ECCLIUM_STATE_DIR` stand bis zum 23.10.2026 auch auf dieser Liste und ist seither für die Audit-Datei freigeschaltet (ADR 0028).
- `ECCLIUM_EGRESS_PROXY` bricht ab, bis ein ausdrücklicher Proxy mit ADR 0035 kommt.
- Mandant, Modus, Transport und Akteur sind keine Variablen. `ECCLIUM_TENANT`, `ECCLIUM_MODE`, `ECCLIUM_TRANSPORT` und `ECCLIUM_ACTOR` sind deshalb unbekannt und brechen ab.
- Die eigenen Variablen des Repositorys mit diesem Präfix, etwa die der Proben, haben keine Ausnahme. Server und Proben laufen nicht in derselben Shell, und Tests mit Kindprozessen geben eine ausdrücklich gefilterte Umgebung weiter.
- Ein Tippfehler im Präfix selbst, etwa `ECLIUM_READ_ONLY`, fällt nicht auf. Es bleiben dann die Voreinstellungen, und ohne Adresse oder Token bricht der Start ab. Eine Ausnahme: Steht über stdio das Token in `ECCLIUM_CHURCHTOOLS_TOKEN` und hat der Name der Token-Datei einen solchen Tippfehler, gilt das Token aus der Umgebung, nur mit der Warnung beim Start. Der Abbruch für zwei Quellen greift dann nicht.
- `NODE_TLS_REJECT_UNAUTHORIZED` mit dem Wert `0` bricht den Start ab, in jeder Schreibweise des Namens, weil Node.js ihn unter Windows ohne Rücksicht darauf liest. Mit diesem Wert prüfte Node.js die Zertifikate von ChurchTools nicht mehr.
- `NODE_DEBUG` bricht den Start ab, sobald eines seiner Muster mehr als Leerzeichen enthält, ebenfalls in jeder Schreibweise des Namens. Node.js schriebe sonst am Logger vorbei nach stderr, mit einer Sektion von undici Adresse, Pfad und Query jeder Anfrage, mit `stream` Teile der Antworten (ADR 0056).
- Für die Einstellungen von Node.js zu TLS liest der Lader ausserdem `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, `NODE_USE_SYSTEM_CA`, `SSL_CERT_FILE` und `SSL_CERT_DIR`, ebenfalls in jeder Schreibweise des Namens, und die Optionen, mit denen Node.js gestartet ist, die ihm die Kommandozeile als `execArgv` weiterreicht. Was er daraus macht, legt ADR 0056 fest. Ausser diesen sieben liest der Lader keine Variable ohne Präfix, und keine Meldung nennt einen ihrer Werte.

### Werte

- Jeder Wert ist genau so zu schreiben, wie die Tabelle ihn nennt. Wahrheitswerte sind genau `true` oder `false`, Aufzählungen exakt.
- Ein leerer Wert ist ein Fehler, nicht «nicht gesetzt».
- Jeder Wert hat eine Höchstlänge, die vor jedem Muster geprüft wird. Kein Wert wird gekürzt, umgewandelt oder normalisiert.
- Keine Meldung und keine Fehlermeldung enthält einen eingegebenen Wert, weil ein Token in der falschen Variable stehen kann. Der Bericht des Laders enthält nie das Token, den Pfad der Token-Datei oder einen abgewiesenen Wert. Er nennt Werte aus der Tabelle und geprüfte Werte, darunter Host und Port der Adresse, den Zustandsordner und das Subjekt. Diese maskiert die Kommandozeile, wie der Abschnitt zu `ecclium config check` festlegt.
- zod wird nur gefragt, ob ein Wert passt, nie nach seinem Fehler. Das Token und die Adresse prüft eigener Code, weil zod sie umwandeln würde.

### Tabelle der Variablen (Phase 1)

| Variable                                  | Werte                                                 | Voreinstellung | Geheimnis  | Nur über stdio       | Beim Start                                                                                                             |
| ----------------------------------------- | ----------------------------------------------------- | -------------- | ---------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ECCLIUM_CHURCHTOOLS_URL`                 | kanonische Origin mit `https`                         | keine          | nein       | nein                 | fehlt oder ungültig: Abbruch                                                                                           |
| `ECCLIUM_CHURCHTOOLS_TOKEN_FILE`          | absoluter Pfad                                        | keine          | der Inhalt | nein                 | eine Prüfung der Datei scheitert: Abbruch                                                                              |
| `ECCLIUM_CHURCHTOOLS_TOKEN`               | Login-Token                                           | keine          | ja         | ja                   | sonst Abbruch; mit `_FILE` zusammen Abbruch; über stdio Warnung bei jedem Start                                        |
| `ECCLIUM_CHURCHTOOLS_REQUESTS_PER_MINUTE` | ganze Zahl von 1 bis 500                              | `300`          | nein       | nein                 | ungültig: Abbruch, ohne den Wert zu nennen                                                                             |
| `ECCLIUM_READ_ONLY`                       | `true`, `false`                                       | `true`         | nein       | nein                 | ungültig: Abbruch                                                                                                      |
| `ECCLIUM_REDACTION`                       | `standard`, `off`, `strict`                           | `standard`     | nein       | `off` nur über stdio | `strict` bricht ab, bis die vollständige Maskierung steht; `off` warnt                                                 |
| `ECCLIUM_PSEUDONYM_KEY_FILE`              | absoluter Pfad                                        | keine          | der Inhalt | nein                 | eine Prüfung der Datei scheitert: Abbruch                                                                              |
| `ECCLIUM_PSEUDONYM_KEY_PREVIOUS_FILE`     | absoluter Pfad                                        | keine          | der Inhalt | nein                 | wie oben; ohne die erste oder gleich: Abbruch; Warnung bei jedem Start                                                 |
| `ECCLIUM_SEARCH_TOOLS`                    | `true`, `false`                                       | `false`        | nein       | nein                 | `true`: Startmeldung mit beiden Namen; über stdio ohne Zustandsordner Abbruch                                          |
| `ECCLIUM_STATE_DIR`                       | absoluter, normalisierter Pfad, höchstens 960 Zeichen | keine          | nein       | ja                   | eine Prüfung des Ordners scheitert: Abbruch; nicht gesetzt: keine Audit-Datei                                          |
| `ECCLIUM_AUDIT_RETENTION_MONTHS`          | ganze Zahl von 1 bis 120                              | `12`           | nein       | ja                   | ungültig: Abbruch, ohne den Wert zu nennen; unter 12: Warnung; ohne `ECCLIUM_STATE_DIR`: Meldung, dass sie nicht wirkt |
| `ECCLIUM_STDIO_SUBJECT`                   | Bezeichnung nach Muster                               | `local-stdio`  | nein       | ja                   | ungültig oder `invalid`: Abbruch                                                                                       |
| `ECCLIUM_LOG_LEVEL`                       | `debug`, `info`, `warn`, `error`                      | `info`         | nein       | nein                 | ungültig: Abbruch                                                                                                      |

Fest und nicht konfigurierbar sind:

- der Mandant über stdio: `default`;
- der Modus: die Wurzel der Komposition legt ihn fest;
- die Liste der Funktionen: im freien Kern leer.

Die Variable für die Drosselung kam mit dem ChurchTools-Client dazu (ADR 0057), die für den Zustandsordner mit der Audit-Datei (ADR 0028). Jede weitere Variable kommt mit ihrer Phase.

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
- Jeder Start meldet die Warnung, dass das Token im Klartext in der Konfiguration des Assistenten steht und andere Programme desselben Benutzers es lesen können, solange der Server läuft.
- Stehen Datei und Variable zusammen, bricht der Start ab, statt eine Quelle stillschweigend vorzuziehen.
- Bevor die Kommandozeile etwas anderes tut, kopiert sie die Umgebung für den Lader und entfernt die Variable in jeder Schreibweise aus `process.env`, auch bei einem falschen Aufruf. Kindprozesse und anderer Code im Prozess sehen sie danach nicht mehr. Andere Programme desselben Benutzers sehen weiter den Stand beim Start, unter Linux in `/proc/<pid>/environ`, unter macOS etwa mit `ps eww`.

### Zustandsordner

- `ECCLIUM_STATE_DIR` nennt einen Ordner für Zustand des Servers. Mit ihm schreibt der Start über stdio die Audit-Datei in den Unterordner `audit` (ADR 0028). Ohne die Variable gibt es keine Audit-Datei, und das ist gültig.
- Der Wert muss ein absoluter Pfad in seiner eindeutigen Form sein: kein Trenner am Ende, kein `.`, kein `..` und kein `//`. Der Lader normalisiert nichts, damit er genau den Ordner prüft, den die Konfiguration nennt. Mit einem Trenner am Ende folgte `lstat` einem Link. Höchstens 960 Zeichen und 960 Bytes in UTF-8, damit der Pfad einer Audit-Datei darin unter der Grenze von 1'024 Bytes für Pfade unter macOS bleibt. Die Zeichen prüft der Lader wie bei jeder Variable, die Bytes die Prüfung des Ordners mit dem Code `state_dir_too_long`.
- Der Lader prüft mit `lstat`, ohne einem Link an der letzten Stelle zu folgen: ein Ordner, kein Link, dem eigenen Benutzer gehörend, ohne Rechte für Gruppe oder andere. Einen vorhandenen Unterordner `audit` prüft er ebenso, ein fehlender ist in Ordnung. Er legt nichts an und öffnet nichts, damit `ecclium config check` auf der Platte nichts ändert.
- Fehlen `process.getuid`, `O_NOFOLLOW`, `O_DIRECTORY` oder `O_NOCTTY`, wie unter Windows, bricht der Start mit einem eigenen Code ab, vor jeder Prüfung des Pfads, der dort anders geschrieben wird. Dort gibt es über stdio weder die Audit-Datei noch Tools mit `sensitivity: special`.
- Jede Prüfung hat ihren eigenen Code, und kein Code und keine Meldung nennt den Pfad. Ordner über dem Zustandsordner gelten als vertrauenswürdig, wie bei der Token-Datei.

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
- Solange es die Suchtools noch nicht gab, blieb `true` gültig und wirkungslos, damit eine Konfiguration für eine spätere Version trotzdem startete. Die Startmeldung sagte dann, dass die Suchtools erst mit einer späteren Version kommen und die Einstellung bis dahin nicht wirkt. Mit den Suchtools gilt wieder die Meldung mit beiden Namen. Erwogen war, `true` bis dahin abzuweisen wie die Variablen späterer Phasen. Das hätte Tabelle, `.env.example`, Lader und Tests jetzt und mit den Suchtools wieder geändert.
- Seit dem 23.10.2026 gibt es die Suchtools, und die Startmeldung nennt beide Namen. Über stdio verlangen sie den Zustandsordner für die Audit-Datei (ADR 0028): Fehlt er, meldet der Lader das Problem `search_tools_without_state_dir` an `ECCLIUM_STATE_DIR`, weil der Ordner fehlt und nicht der Wert des Schalters falsch ist, und `ecclium config check` und der Start enden mit 78.
- In Phase 2 ersetzt `ECCLIUM_TOOLSETS` diesen Schalter.

### `ecclium config check`

- Der Befehl zeigt jede Einstellung mit ihrer Herkunft: Umgebung, Datei oder Voreinstellung.
- Ein Geheimnis zeigt er nie, weder Wert noch Länge noch Anfang, nur «verborgen» und die Quelle. Bei einer Datei steht dazu, dass Eigentümer und Dateirechte geprüft sind.
- Den Pfad zur Token-Datei und ungültige Werte zeigt er nie.
- Host, ein abweichendes Subjekt und der Zustandsordner sind maskiert, mit `--show-values` sichtbar. So passt die Ausgabe ohne Bearbeitung in ein öffentliches Issue. Den Zustandsordner zeigt er auch dann nur in druckbarem ASCII, sonst als «gesetzt», weil der Schreiber der Ausgabe andere Zeichen samt der ganzen Zeile verwirft. Ein nicht gesetzter Zustandsordner erscheint als «keine Audit-Datei».
- Namen unbekannter Variablen nennt er, wenn sie dem Muster `^ECCLIUM_[A-Z0-9_]{1,64}$` folgen, damit sich ein Tippfehler finden lässt.
- Er fragt ChurchTools nicht an und sagt das.
- Der Aufruf kennt nur `--show-values` und `-h` oder `--help`. Eine Option, die zweimal vorkommt, weist er ab, weil `parseArgs` sie annähme.
- Fehler beim Aufruf erscheinen mit festen Texten auf stderr, nie mit der Meldung von `parseArgs` und nie mit einem Argument, weil darin ein Token stehen kann.
- Der Bericht geht nach stdout. Kann stdout nicht mehr schreiben, etwa weil der Leser einer Pipe fehlt, bleibt der Exit-Code der der Gültigkeit.
- Ein interner Fehler ergibt eine feste Zeile auf stderr, ohne Stack und ohne Meldung. Den geworfenen Wert liest die Kommandozeile nicht.
- Exit-Codes, nach `sysexits.h`:

  | Code | Bedeutung               |
  | ---- | ----------------------- |
  | 0    | gültige Konfiguration   |
  | 64   | falscher Aufruf         |
  | 70   | interner Fehler         |
  | 78   | ungültige Konfiguration |

  Die Codes meiden 1, den Code von Node.js für eine nicht gefangene Ausnahme. So gilt ein Absturz nie als ungültige Konfiguration.

### Startmeldungen

- Der Kern meldet Probleme und Warnungen nur als Codes. Die deutschen Texte stehen in einem Katalog in `packages/cli/src/messages/`.
- Vor dem Start über stdio schreibt `packages/cli/src/notices/` sie nach stderr, Zeile für Zeile mit `writeSync`, nie über `process.stderr`. Der Ort schreibt nur Texte aus dem Katalog und ist damit kein Kanal für freien Text: Einen Text des Katalogs machen nur `problemText`, `warningText` und, für den Start über stdio, `startText` und `refusalText`. Der Typ weist eine gewöhnliche Zeichenkette ab, ein Cast oder eine Typprüfung käme darum herum, das muss eine Durchsicht finden.
- Jede Zeile prüft ein Stolperdraht gegen eine Positivliste der Zeichen: druckbares ASCII, die Umlaute und die Anführungszeichen «» und ‹›. Bleibt eine Zeile abgerissen, hören die Startmeldungen auf und versuchen einen Zeilenumbruch. Gelingt auch der nicht, melden sie die Zeile als abgerissen, und der Zeilenschreiber beginnt seine erste Zeile dann mit einem Zeilenumbruch.
- ADR 0053 legt fest, dass nach stderr nur der Logger und die Meldungen der Kommandozeile schreiben, und dass die Orte im Code in `tests/architecture/boundaries.json` stehen. Die Startmeldungen sind solche Meldungen der Kommandozeile, nur aus einem Ordner, den der Betrieb über stdio erreichen darf. Der neue Ort setzt ADR 0053 deshalb um, er ändert es nicht.
- Katalog und Startmeldungen erreichen die Orte, die nach stdout schreiben, nie, auch nicht über ein anderes Modul. Das prüft eine eigene Regel, schon bevor der Start über stdio sie importiert.
- Startmeldungen erscheinen nur, bevor der Zeilenschreiber des Loggers besteht. Eine Meldung, die mitten in der Zeile abbricht, nähme sonst der nächsten Logzeile ihre Form als JSON.
- Der Start über stdio kommt aus einem eigenen Einstieg unter `packages/cli/src/stdio/`, nie über den Befehl der Kommandozeile. So erfasst die Regel für den Betrieb über stdio den Prozess ab diesem Einstieg. Der Einstieg der Kommandozeile davor, `bin.ts`, ist ein eigens bewachter Teil desselben Prozesses (siehe «Start über stdio»).

### Start über stdio

- Der Start über stdio ist der Unterbefehl `ecclium stdio` des einen Befehls `ecclium`, damit ein späterer Aufruf über `npx` oder einen Container den Befehl gleich nennt. Er nimmt kein weiteres Argument an, auch `--help` nicht. Jedes weitere Argument weist er mit einem festen Text und dem Code 64 ab, ohne es zu zerlegen oder zu wiederholen. Erwogen waren ein eigener Befehl, der `npx` ohne Angabe des Befehls mehrdeutig machte, und der Start über stdio für `ecclium` ohne Argumente: Wer nur `ecclium` tippt, bekäme dann statt der Hilfe einen wartenden Server.
- Der Einstieg `packages/cli/src/bin.ts` übernimmt für jeden Befehl zuerst die Umgebung und lädt erst dann mit `import()` und einer festen Zeichenkette entweder den Einstieg des Starts unter `packages/cli/src/stdio/` oder den Befehl der Kommandozeile in `main.ts`. So lädt der Start `main.ts` nie, dessen `node:util` fd 2 nicht blockierend machte, bevor die Startmeldungen hinausgehen (ADR 0054). Zwei Regeln lassen `bin.ts` statisch nur `environment.ts` und mit `import()` nur `main.ts` und den Einstieg des Starts importieren, und ein Test hält seine Importe fest.
- Der Start läuft in zwei Stufen. Die erste weist Argumente ab, lädt die Konfiguration, baut den Katalog der Tools und schreibt die Startmeldungen, alles bevor Server, SDK und undici laden. Eine ungültige Konfiguration endet mit 78, eine Ablehnung der Registry mit 70, beide nach ihren Startmeldungen und ohne Zeilenschreiber. Steht ein Tool mit `sensitivity: special` im Katalog und fehlt der Zustandsordner, endet sie ebenfalls mit 78. Ist der Zustandsordner gesetzt, öffnet sie die Audit-Datei, solange fd 2 noch blockiert, und endet mit 78, wenn das scheitert (ADR 0028). Erst dann lädt sie die zweite Stufe, die Zeilenschreiber, Logger, Audit, Transport, Pipeline und Server baut.
- Der Start fragt ChurchTools nicht an, wie `ecclium config check`. Ob ChurchTools das Token annimmt, zeigt ein Aufruf von `ct_whoami`. So geht das Token nicht bei jedem Start eines Clients hinaus.
- Er endet mit den Codes von `ecclium config check`, mit 0, sobald der Client die Verbindung beendet hat, und dazu mit 130 nach `SIGINT` und 143 nach `SIGTERM`, 128 und die Nummer des Signals, wie eine Shell es meldet. Ein zweites Signal beendet ihn sofort.

## Konsequenzen

- **Strenge Fehler beim Start:** Wer `READ_ONLY` aus einer alten Vorlage ohne Präfix übernimmt, bekommt keine Wirkung. Wer `ecclium_read_only` schreibt, bekommt einen Abbruch mit dem richtigen Namen.
- **Proben und Server getrennt:** Die Proben des Repositorys und der Server laufen nicht in derselben Shell, und jeder Test mit Kindprozessen gibt seine Umgebung ausdrücklich vor.
- **Subjekt als Name:** Ein Name in der Form `max-mustermann` passt auf das Muster des Subjekts. Das Muster schliesst E-Mail-Adressen, Leerzeichen, Punkte und Grossbuchstaben aus, aber keinen Namen als Bezeichnung. Pseudonyme und Kontingente folgen dem Subjekt.
- **Token in der Umgebung:** Es steht im Klartext in der Konfiguration des Assistenten. Andere Programme desselben Benutzers können es unter Linux und macOS lesen, solange der Prozess läuft, auch nachdem die Kommandozeile die Variable entfernt hat.
- **Grenzen der Regeln:** `[arch:environment]` und `[arch:require]` lesen Code, nicht was zur Laufzeit geschieht. `node:vm`, das Tests für Objekte aus einem anderen Realm brauchen, der Konstruktor eines Funktionswerts, ein Lesen von `/proc/self/environ` oder `/proc/self/cmdline` über das Dateisystem und der Code von Abhängigkeiten bleiben ihnen verborgen. Bei `parseArgs` sieht die Regel nur einen Aufruf unter diesem Namen ohne einen Schlüssel `args`: eine umbenannte oder weitergereichte Funktion, `args: undefined` und eine Option namens `args` entgehen ihr. Ausserhalb des Befehls der Kommandozeile, der Kanarienwerte von testkit und der Tests der Pakete kann kein Modul `parseArgs` aus `node:util` importieren, weil `[arch:util-module]` jeden Import aus `node:util` abweist (ADR 0054). Dort bleiben diese Lücken, und nur das Review findet sie.
- **Token-Datei:** Ordner über der Datei und Zugriffslisten von macOS prüft der Server nicht. Unter macOS besteht `/dev/fd/0` jede Prüfung, wenn stdin aus einer eigenen Datei mit den Rechten 0600 kommt. Unter Windows gibt es keine Token-Datei.
- **Namen in der Ausgabe:** Unbekannte Variablennamen erscheinen in `config check` und in den Startmeldungen. Ein Name trägt nie einen Wert, eine erfundene Bezeichnung könnte aber Text tragen.
- **Host sichtbar:** Mit `--show-values` zeigt `config check` den Host der Instanz.
- **Zustandsordner sichtbar:** Mit `--show-values` zeigt `config check` den Pfad des Zustandsordners. Er kann den Namen eines Benutzers enthalten.
- **Host verborgen:** Ohne `--show-values` zeigt `config check` nicht, ob die Konfiguration auf die Testinstanz oder einen produktiven Tenant zeigt (Threat Model, T23).
- **Tippfehler im Namen der Token-Datei:** Über stdio gilt dann still das Token aus der Umgebung, wie unter «Namen» beschrieben. Nur die Warnung beim Start zeigt es.
- **Absturz vor dem Fang:** Scheitert der Prozess, bevor die Kommandozeile Fehler fängt, etwa beim Laden eines Moduls, endet er mit dem Code 1 von Node.js und einem Stack auf stderr.
- **Zustand von zod:** Die Schemas von zod auf Modulebene ändern beim ersten Prüfen innere Zwischenspeicher, wie in ADR 0054.
- **Lesen der Umgebung:** Andere Pakete könnten `process.env` lesen, wenn die Regel dazu fehlt. Deshalb steht sie, bevor ein Paket die Umgebung braucht.
- **Bundle:** Ein Bundle ohne Aufteilung des Codes zöge `main.ts` und damit `node:util` wieder vor die Startmeldungen. Der Release-Pfad in Phase 8 prüft, dass der Weg über stdio im ausgelieferten Paket `node:util` nicht lädt.

## Umsetzung

- Kern, gemergt am 15.10.2026:
  - `packages/core/src/config/` mit der Tabelle in `variables.ts`, den Codes in `codes.ts`, dem Lesen der Token-Datei in `token-file.ts` und dem Lader in `load.ts`;
  - die Prüfung der Adresse in `packages/core/src/http/origin.ts`;
  - Identität und `TenantResolver` über stdio in `packages/core/src/identity/stdio.ts`;
  - der Mandantenkontext in `packages/core/src/tenant/`;
  - `tests/token-file.test.mts` mit `tests/fixtures/config/read-token-file.mts` für eine FIFO in einem Kindprozess.
- Kommandozeile, gemergt am 16.10.2026:
  - der Katalog der Texte in `packages/cli/src/messages/`, die Startmeldungen in `packages/cli/src/notices/` und die Ausgabe in `packages/cli/src/output/`, mit der gemeinsamen Schleife für Teilschreibvorgänge in `packages/cli/src/send.ts`;
  - `ecclium config check` in `packages/cli/src/commands/config-check.ts`, `main.ts`, `exit-codes.ts` und `bin.ts`, mit dem Eintrag `bin` in `packages/cli/package.json`;
  - die Übernahme der Umgebung in `packages/cli/src/environment.ts` und `tests/token-environment.test.mts` mit `tests/fixtures/config/take-environment.mts`, der zeigt, dass ein Kindprozess das Token nicht mehr sieht.
- Regeln, gemergt am 16.10.2026: der Ort `environment` mit der ESLint-Regel `[arch:environment]` für `process.env`, `process.argv`, `process.report` und `parseArgs` ohne `args`, seit dem 19.10.2026 auch für `process.execArgv`; `eval` und `Function` unter `[arch:require]` (Importe aus `node:process` weist seither `[arch:process]` ab, ADR 0054), der Ort `stdioReachable` mit der Regel `no-stdout-from-stdio-modules` von dependency-cruiser und ein Test, der im Syntaxbaum der Schreiber `process` und `console` sucht. Die Regel `churchtools-token-assignment` von gitleaks, die auch `ECCLIUM_CHURCHTOOLS_TOKEN` erkennt, kam mit dem Kern am 15.10.2026.
- `.env.example` nennt die Variablen mit Präfix, `tests/env-example.test.mts` gleicht die Datei mit der Tabelle ab.
- Variable für die Drosselung: `ECCLIUM_CHURCHTOOLS_REQUESTS_PER_MINUTE` in `packages/core/src/config/variables.ts`, Zeichen für Zeichen geprüft, mit dem Problem `invalid_integer` und der Zeile «Anfragen je Minute» in `ecclium config check` (ADR 0057).
- Start über stdio, seit dem 19.10.2026: der Unterbefehl `ecclium stdio` in `packages/cli/src/bin.ts`, die erste Stufe in `packages/cli/src/stdio/index.ts`, der Katalog aus dem Plugin des Kerns in `catalog.ts` und die zweite Stufe in `serve.ts`, die Texte für den Start und für jeden Grund einer Ablehnung der Registry in `packages/cli/src/messages/start.ts`, die Version in `packages/cli/src/version.ts` und die Codes 130 und 143 in `exit-codes.ts`. Die Regeln `bin-imports-only-environment` und `bin-loads-only-main-or-stdio` von dependency-cruiser stehen in `tests/architecture/dependency-rules.mts`. `tests/stdio-start.test.mts` prüft den echten Prozess mit Kanarienwerten. Die Startmeldungen gehen vor dem Zeilenschreiber hinaus, danach schreibt Ecclium auf stderr nur JSON. Node.js selbst kann weitere Zeilen schreiben (ADR 0054). Die Beispiele für Clients stehen in `docs/betrieb/stdio.md` und `docs/betrieb/beispiele/`, `tests/client-examples.test.mts` gleicht sie ab.
- Einstellungen von Node.js für TLS, seit dem 19.10.2026: Der Lader liest dafür `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, `NODE_USE_SYSTEM_CA`, `SSL_CERT_FILE` und `SSL_CERT_DIR` und das neue Feld `execArgv` seiner Quellen, das `run()` und `startStdio()` aus `bin.ts` erhalten (ADR 0056).
- Prüfung des Tokens: Der Start ruft `whoami` nicht auf, das zeigt erst ein Aufruf von `ct_whoami` (siehe «Start über stdio»).
- Zustandsordner, seit dem 23.10.2026: `ECCLIUM_STATE_DIR` in der Tabelle in `variables.ts`, die Prüfung des Ordners in `packages/core/src/config/state-dir.ts` mit der Naht `stateDirFiles` im Lader und in `ecclium config check`, die Herkunft `unset` und die Art `path` im Bericht, die Zeile «Zustandsordner» in `packages/cli/src/output/report.ts` und die Texte der Codes in `packages/cli/src/messages/config.ts`. Die erste Stufe des Starts öffnet mit dem Ordner die Audit-Datei, bevor die zweite lädt, und endet mit 78, wenn das scheitert oder ein Tool mit `sensitivity: special` ohne den Ordner im Katalog steht (ADR 0028). `tests/stdio-start.test.mts` zeigt das am echten Prozess.
- Smoke-Test, seit dem 23.10.2026: `scripts/smoke/main.mts` gibt dem Server nur `ECCLIUM_CHURCHTOOLS_URL`, `ECCLIUM_CHURCHTOOLS_TOKEN_FILE`, `ECCLIUM_READ_ONLY=true` ohne Rücksicht auf die Shell, einen eigenen Zustandsordner und mit seinem Schalter `ECCLIUM_SEARCH_TOOLS=true`, nichts sonst. Seine eigenen Variablen `ECCLIUM_SMOKE_ALLOW_SEARCH` und `ECCLIUM_SMOKE_QUERY` erreichen den Server nie und stehen deshalb nicht in der Tabelle und nicht in `.env.example`. Das Token nimmt er nur aus der Datei. `tests/scripts/smoke.test.mts` prüft die Umgebung des Kindes.
- Suchtools, seit dem 23.10.2026: `createCorePlugin` in `packages/tools/src/core-plugin.ts` nimmt `ct_persons_search` und `ct_groups_search` nur mit `searchTools` in den Katalog, und `packages/cli/src/stdio/catalog.ts` reicht `config.searchTools` durch. Der Lader meldet über stdio `search_tools_without_state_dir`, wenn der Schalter ohne Zustandsordner gesetzt ist. Die Prüfung im Start für Tools mit `sensitivity: special` ohne Ordner bleibt als zweite Wache. `tests/stdio-start.test.mts` zeigt am echten Prozess die drei Tools mit Schalter und Ordner und das Ende mit 78 ohne Ordner (ADR 0060).
- Toolsets, seit dem 24.10.2026: `ECCLIUM_TOOLSETS` steht in der Tabelle in `variables.ts` an der Stelle von `ECCLIUM_SEARCH_TOOLS` und nicht mehr unter den Namen späterer Phasen, wie es «Freigabe der Suchtools» vorsah (ADR 0062). Was oben zur Freigabe der Suchtools und in den Punkten zu Smoke-Test und Suchtools über den Schalter steht, gilt seither für das Toolset `persons`: Der Lader meldet `toolsets_without_state_dir` statt `search_tools_without_state_dir`, der Smoke-Test setzt `ECCLIUM_TOOLSETS=persons`, und `createCorePlugin()` nimmt keine Option mehr. `ECCLIUM_SEARCH_TOOLS` bricht den Start mit `search_tools_replaced` ab.
- Referenz der Konfiguration, seit dem 23.10.2026: `docs/configuration.md` entsteht mit `pnpm docs:generate` aus dieser Tabelle in `packages/core/src/config/variables.ts` und den deutschen Beschreibungen in `packages/cli/src/messages/variables.ts`. Ein Test in `packages/testkit/src/docs/references.test.ts` vergleicht die Datei mit dem Code, ein zweiter in der Kommandozeile verlangt für jede Variable der Tabelle eine Beschreibung.
- Frist der Audit-Dateien, seit dem 31.10.2026: `ECCLIUM_AUDIT_RETENTION_MONTHS` in der Tabelle in `variables.ts` nach `ECCLIUM_STATE_DIR`, nur über stdio, Zeichen für Zeichen geprüft wie die Drosselung, mit dem eigenen Problem `invalid_retention`, den Warnungen `audit_retention_short` und `audit_retention_without_state_dir`, dem Feld `auditRetentionMonths` der Konfiguration und der Zeile «Frist in Monaten» in `ecclium config check`. Was die Frist bewirkt, legt ADR 0028 fest.
- Befehle für das Audit, seit dem 31.10.2026: `ecclium audit verify` und `ecclium audit show` in `packages/cli/src/commands/` ([ADR 0028](0028-audit-ereignis-und-datei-sink.md), Umsetzung). Sie laden ihre Konfiguration mit `loadAuditConfig`, das jeden Namen mit dem Präfix sortiert wie `loadConfig`, aber nur `ECCLIUM_STATE_DIR` und `ECCLIUM_AUDIT_RETENTION_MONTHS` liest, und melden das neue Problem `state_dir_required`. Der Aufruf kennt dafür `--log`, die einzige Option, die mehrmals stehen darf, `--object`, `--since` und `--until`. Eine Option eines anderen Befehls weist er ab wie eine unbekannte, und die Texte für einen falschen Aufruf und einen internen Fehler nennen alle Befehle. Dazu kommen die Exit-Codes 65 (Befund in den Daten), 66 (Eingabe fehlt) und 74 (Datei nicht ganz lesbar) nach `sysexits.h`, die `ecclium config check` nicht nutzt.
- Schlüssel für Pseudonyme, seit dem 31.10.2026: `ECCLIUM_PSEUDONYM_KEY_FILE` und `ECCLIUM_PSEUDONYM_KEY_PREVIOUS_FILE` in der Tabelle in `variables.ts` nach `ECCLIUM_REDACTION`, beide nicht nur über stdio und ohne Voreinstellung ([ADR 0069](0069-stufe-strict.md), vorgeschlagen). Den Inhalt prüft der Leser der Token-Datei unverändert, mit eigenen Codes `pseudonym_key_file_*` und `pseudonym_key_invalid` über die Naht `tokenFiles`, dazu die Probleme `pseudonym_key_previous_without_current` und `pseudonym_key_same` und die Warnung `pseudonym_key_change`. `ecclium config check` zeigt die Zeilen «Pseudonym-Schlüssel» und «Früherer Schlüssel» mit der Herkunft `file` oder `unset` und nie einen Pfad, und `.env.example` nennt beide nur in Kommentaren, weil ein Pfad als Platzhalter jeden Start abbräche.
