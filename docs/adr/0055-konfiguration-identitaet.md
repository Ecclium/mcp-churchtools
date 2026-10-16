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
- Der Kern liest `process.env` nie selbst. Die Kommandozeile reicht die Umgebung als Parameter weiter. Eine Architekturregel weist das Lesen von `process.env`, `process.argv` und `process.report` ausserhalb ihres Einstiegs ab, in den Formen, die sie im Code sieht, ebenso einen Aufruf von `parseArgs` ohne `args`, der `process.argv` selbst liest. Was sie nicht sieht, steht unter «Konsequenzen». Auch ein Argument kann ein Token enthalten, und der Bericht des Prozesses nennt die ganze Umgebung.

### Namen

- Der Start bricht bei jeder Variable mit dem Präfix ab, die nicht genau ein bekannter Name ist. Das Präfix wird ohne Rücksicht auf die Schreibweise erkannt.
- Ein bekannter Name in anderer Schreibweise ergibt eine Meldung mit dem richtigen Namen. Namen späterer Phasen ergeben «wird von dieser Version noch nicht unterstützt»: `ECCLIUM_TOOLSETS`, `ECCLIUM_WRITE_CONFIRMATION`, `ECCLIUM_STATE_DIR`, `ECCLIUM_EGRESS`, `ECCLIUM_EGRESS_ALLOW_LAN` und `ECCLIUM_ALLOWED_HOSTS`.
- `ECCLIUM_EGRESS_PROXY` bricht ab, bis ein ausdrücklicher Proxy mit ADR 0035 kommt.
- Mandant, Modus, Transport und Akteur sind keine Variablen. `ECCLIUM_TENANT`, `ECCLIUM_MODE`, `ECCLIUM_TRANSPORT` und `ECCLIUM_ACTOR` sind deshalb unbekannt und brechen ab.
- Die eigenen Variablen des Repositorys mit diesem Präfix, etwa die der Proben, haben keine Ausnahme. Server und Proben laufen nicht in derselben Shell, und Tests mit Kindprozessen geben eine ausdrücklich gefilterte Umgebung weiter.
- Ein Tippfehler im Präfix selbst, etwa `ECLIUM_READ_ONLY`, fällt nicht auf. Es bleiben dann die Voreinstellungen, und ohne Adresse oder Token bricht der Start ab. Eine Ausnahme: Steht über stdio das Token in `ECCLIUM_CHURCHTOOLS_TOKEN` und hat der Name der Token-Datei einen solchen Tippfehler, gilt das Token aus der Umgebung, nur mit der Warnung beim Start. Der Abbruch für zwei Quellen greift dann nicht.
- `NODE_TLS_REJECT_UNAUTHORIZED` mit dem Wert `0` bricht den Start ab, in jeder Schreibweise des Namens, weil Node.js ihn unter Windows ohne Rücksicht darauf liest. Mit diesem Wert prüfte Node.js die Zertifikate von ChurchTools nicht mehr.
- `NODE_DEBUG` bricht den Start ab, sobald eines seiner Muster mehr als Leerzeichen enthält, ebenfalls in jeder Schreibweise des Namens. Node.js schriebe sonst am Logger vorbei nach stderr, mit einer Sektion von undici Adresse, Pfad und Query jeder Anfrage, mit `stream` Teile der Antworten (ADR 0056). Ausser diesen beiden liest der Lader keine Variable ohne Präfix.

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
- Jeder Start meldet die Warnung, dass das Token im Klartext in der Konfiguration des Assistenten steht und andere Programme desselben Benutzers es lesen können, solange der Server läuft.
- Stehen Datei und Variable zusammen, bricht der Start ab, statt eine Quelle stillschweigend vorzuziehen.
- Bevor die Kommandozeile etwas anderes tut, kopiert sie die Umgebung für den Lader und entfernt die Variable in jeder Schreibweise aus `process.env`, auch bei einem falschen Aufruf. Kindprozesse und anderer Code im Prozess sehen sie danach nicht mehr. Andere Programme desselben Benutzers sehen weiter den Stand beim Start, unter Linux in `/proc/<pid>/environ`, unter macOS etwa mit `ps eww`.

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
- Vor dem Start über stdio schreibt `packages/cli/src/notices/` sie nach stderr, Zeile für Zeile mit `writeSync`, nie über `process.stderr`. Der Ort schreibt nur Texte aus dem Katalog und ist damit kein Kanal für freien Text: Einen Text des Katalogs machen nur `problemText` und `warningText`. Der Typ weist eine gewöhnliche Zeichenkette ab, ein Cast oder eine Typprüfung käme darum herum, das muss eine Durchsicht finden.
- Jede Zeile prüft ein Stolperdraht gegen eine Positivliste der Zeichen: druckbares ASCII, die Umlaute und die Anführungszeichen «» und ‹›. Bleibt eine Zeile abgerissen, hören die Startmeldungen auf und versuchen einen Zeilenumbruch. Gelingt auch der nicht, melden sie die Zeile als abgerissen, und der Start über stdio entscheidet, was vor der ersten Logzeile geschieht.
- ADR 0053 legt fest, dass nach stderr nur der Logger und die Meldungen der Kommandozeile schreiben, und dass die Orte im Code in `tests/architecture/boundaries.json` stehen. Die Startmeldungen sind solche Meldungen der Kommandozeile, nur aus einem Ordner, den der Betrieb über stdio erreichen darf. Der neue Ort setzt ADR 0053 deshalb um, er ändert es nicht.
- Katalog und Startmeldungen erreichen die Orte, die nach stdout schreiben, nie, auch nicht über ein anderes Modul. Das prüft eine eigene Regel, schon bevor der Start über stdio sie importiert.
- Startmeldungen erscheinen nur, bevor der Zeilenschreiber des Loggers besteht. Eine Meldung, die mitten in der Zeile abbricht, nähme sonst der nächsten Logzeile ihre Form als JSON.
- Der Start über stdio kommt aus einem eigenen Einstieg unter `packages/cli/src/stdio/`, nie über den Befehl der Kommandozeile. So erfasst die Regel für den Betrieb über stdio den ganzen Prozess.

## Konsequenzen

- **Strenge Fehler beim Start:** Wer `READ_ONLY` aus einer alten Vorlage ohne Präfix übernimmt, bekommt keine Wirkung. Wer `ecclium_read_only` schreibt, bekommt einen Abbruch mit dem richtigen Namen.
- **Proben und Server getrennt:** Die Proben des Repositorys und der Server laufen nicht in derselben Shell, und jeder Test mit Kindprozessen gibt seine Umgebung ausdrücklich vor.
- **Subjekt als Name:** Ein Name in der Form `max-mustermann` passt auf das Muster des Subjekts. Das Muster schliesst E-Mail-Adressen, Leerzeichen, Punkte und Grossbuchstaben aus, aber keinen Namen als Bezeichnung. Pseudonyme und Kontingente folgen dem Subjekt.
- **Token in der Umgebung:** Es steht im Klartext in der Konfiguration des Assistenten. Andere Programme desselben Benutzers können es unter Linux und macOS lesen, solange der Prozess läuft, auch nachdem die Kommandozeile die Variable entfernt hat.
- **Grenzen der Regeln:** `[arch:environment]` und `[arch:require]` lesen Code, nicht was zur Laufzeit geschieht. `node:vm`, das Tests für Objekte aus einem anderen Realm brauchen, der Konstruktor eines Funktionswerts, ein Lesen von `/proc/self/environ` oder `/proc/self/cmdline` über das Dateisystem und der Code von Abhängigkeiten bleiben ihnen verborgen. Bei `parseArgs` sieht die Regel nur einen Aufruf unter diesem Namen ohne einen Schlüssel `args`: eine umbenannte oder weitergereichte Funktion, `args: undefined` und eine Option namens `args` entgehen ihr. Ausserhalb des Befehls der Kommandozeile, der Kanarienwerte von testkit und der Tests der Pakete kann kein Modul `parseArgs` aus `node:util` importieren, weil `[arch:util-module]` jeden Import aus `node:util` abweist (ADR 0054). Dort bleiben diese Lücken, und nur das Review findet sie.
- **Token-Datei:** Ordner über der Datei und Zugriffslisten von macOS prüft der Server nicht. Unter macOS besteht `/dev/fd/0` jede Prüfung, wenn stdin aus einer eigenen Datei mit den Rechten 0600 kommt. Unter Windows gibt es keine Token-Datei.
- **Namen in der Ausgabe:** Unbekannte Variablennamen erscheinen in `config check` und in den Startmeldungen. Ein Name trägt nie einen Wert, eine erfundene Bezeichnung könnte aber Text tragen.
- **Host sichtbar:** Mit `--show-values` zeigt `config check` den Host der Instanz.
- **Host verborgen:** Ohne `--show-values` zeigt `config check` nicht, ob die Konfiguration auf die Testinstanz oder einen produktiven Tenant zeigt (Threat Model, T23).
- **Tippfehler im Namen der Token-Datei:** Über stdio gilt dann still das Token aus der Umgebung, wie unter «Namen» beschrieben. Nur die Warnung beim Start zeigt es.
- **Absturz vor dem Fang:** Scheitert der Prozess, bevor die Kommandozeile Fehler fängt, etwa beim Laden eines Moduls, endet er mit dem Code 1 von Node.js und einem Stack auf stderr.
- **Zustand von zod:** Die Schemas von zod auf Modulebene ändern beim ersten Prüfen innere Zwischenspeicher, wie in ADR 0054.
- **Lesen der Umgebung:** Andere Pakete könnten `process.env` lesen, wenn die Regel dazu fehlt. Deshalb steht sie, bevor ein Paket die Umgebung braucht.

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
- Regeln, gemergt am 16.10.2026: der Ort `environment` mit der ESLint-Regel `[arch:environment]` für `process.env`, `process.argv`, `process.report` und `parseArgs` ohne `args`, `eval` und `Function` unter `[arch:require]` (Importe aus `node:process` weist seither `[arch:process]` ab, ADR 0054), der Ort `stdioReachable` mit der Regel `no-stdout-from-stdio-modules` von dependency-cruiser und ein Test, der im Syntaxbaum der Schreiber `process` und `console` sucht. Die Regel `churchtools-token-assignment` von gitleaks, die auch `ECCLIUM_CHURCHTOOLS_TOKEN` erkennt, kam mit dem Kern am 15.10.2026.
- `.env.example` nennt die Variablen mit Präfix, `tests/env-example.test.mts` gleicht die Datei mit der Tabelle ab.
- Offen: der Start über stdio mit den Startmeldungen vor dem Zeilenschreiber und dem Test mit Kanarienwerten im Kindprozess, die Prüfung des Tokens mit `whoami`, die Variable für die Drosselung und die Registrierung der Suchtools nach `ECCLIUM_SEARCH_TOOLS`.
