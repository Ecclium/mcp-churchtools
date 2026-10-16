# ADR 0056: Ausgehender Weg mit Positivliste der Hosts

- Status: Vorgeschlagen
- Datum: 16.10.2026
- Fällt vor: Phase 1

## Kontext

Der Kern spricht mit ChurchTools über HTTPS und schickt dabei ein Login-Token mit, das ohne zweiten Faktor alle Rechte seines Kontos trägt. Später kommen ein Anbieter eines Sprachmodells und im OAuth-Modus ein Anmeldedienst dazu. Nach einer gelungenen Prompt-Injection wäre ein Abfluss an eine beliebige Adresse der schwerste Schaden. Festzulegen ist, wie der eine ausgehende Weg des Kerns gebaut ist, was er prüft und was er nie aus der Hand gibt.

Folgende Entscheide und Bedrohungen geben den Rahmen vor:

- **Threat Model:**
  - T4: ein Login-Token fliesst ab.
  - T12: Daten fliessen an eine beliebige Adresse ab.
  - T20: Ecclium verbraucht das Rate-Limit der Gemeinde.
- **ADR 0009 (Entwurf):** Eine Positivliste im Code, abgeleitet aus der Konfiguration, ohne Platzhalter für ganze Domains.
- **ADR 0022:** Verbindungen öffnet nur der Ort `egress`, `packages/core/src/http/`.
- **ADR 0023:** Das Token geht nur in den Header `Authorization: Login <token>`, nie in die Query, und der Client sendet nie einen Cookie.
- **ADR 0051:** Der Pool der Verbindungen ist eine der zwei benannten Ausnahmen für Zustand über eine Anfrage hinaus, je Instanz, ohne Inhalte und Zugangsdaten.
- **ADR 0052:** Tests öffnen keine Verbindung nach aussen, nur über `127.0.0.1` und `::1`, und lösen keinen Namen auf.
- **ADR 0054:** Nur der ausgehende Weg macht aus einem `Secret` wieder seinen Wert. Fehler tragen einen stabilen Code, der Logger nur Felder einer Positivliste.
- **ADR 0055:** Die Konfiguration nimmt als Adresse nur die kanonische Origin mit `https`, und der Start weist `NODE_TLS_REJECT_UNAUTHORIZED=0` ab.

Geprüft am 16.10.2026 an undici 8.12.2 und Node.js 24.21.0, wo nicht anders genannt:

- **undici 8.12.2** erschien am 15.10.2026, unter MIT, ohne Abhängigkeiten, ohne Skripte bei der Installation und mit Herkunftsnachweis. Acht Advisories vom 15.10.2026 betreffen die Versionen 8.0.0 bis 8.12.1, keine betrifft 8.12.2. OSV führte sie an diesem Tag noch nicht.
- **Gebündelter Code:** undici bringt den Parser llhttp in Version 9.3.1 als WASM mit (MIT, `lib/llhttp/`), dazu den experimentellen Parser Milo als WASM (ISC, `lib/milo/`), den die Variable `UNDICI_USE_MILO` einschaltet, und Code eines eigenständig lizenzierten Projekts für `fetch`. Die Version von llhttp steht nur im Repository von undici, `deps/llhttp/include/llhttp.h`, nicht im Paket. Node.js 24.21.0 bringt llhttp 9.4.3 mit. 9.4.2 und 9.4.3 kamen dort mit Sicherheitsreleases: Eine Statuszeile darf nicht mehr mit zwei Wagenrückläufen enden, und ein leeres `Transfer-Encoding` wird abgewiesen. Eine Advisory, die llhttp 9.3.1 nennt, war am 16.10.2026 nicht bekannt.
- **Verbindungen:** `buildConnector` bietet ohne ausdrückliche Option per ALPN auch HTTP/2 an. Ist `connect` eine Funktion, wirkt die Frist `connectTimeout` des Pools nicht, die Frist gehört dann an `buildConnector`. Der Pool kennt eine harte Grenze für den Körper einer Antwort, `maxResponseSize`, und bricht ab, bevor er puffert. Eine Anfrage, die auf eine freie Verbindung wartet, bricht der Pool bei einem Abbruch ihres Signals nicht ab: Er merkt sich den Grund und verwirft sie erst, wenn eine Verbindung sie nimmt. Zerstört der Aufrufer den Körper einer Antwort, der schon ganz angekommen ist, löst undici danach auf ihm einen Fehler aus. Ohne Listener beendet der den Prozess. `keepAliveTimeout` folgt dem Hinweis des Servers bis `keepAliveMaxTimeout`. Einer Weiterleitung folgt `request()` nur mit einem eigenen Interceptor. Es sendet kein `accept-encoding` und dekodiert nichts.
- **TLS:** `tls.connect` setzt `rejectUnauthorized` nach `NODE_TLS_REJECT_UNAUTHORIZED` nur als Vorgabe, eine ausdrückliche Option gewinnt (`lib/internal/tls/wrap.js`). Ohne Option `ca` vertraut TLS dem Speicher von Node.js, den `NODE_EXTRA_CA_CERTS`, `NODE_USE_SYSTEM_CA` und `--use-system-ca` erweitern. Ein abgewiesenes Zertifikat meldet den Code von OpenSSL, etwa `DEPTH_ZERO_SELF_SIGNED_CERT`, ein falscher Name `ERR_TLS_CERT_ALTNAME_INVALID`. Den schon verbundenen Socket, den `buildConnector` als `httpSocket` annimmt, legt es unter TLS, mit SNI und Prüfung des Namens wie sonst.
- **Fehler:** Ein Abbruch wirft den Grund des Signals. Der Text von `ConnectTimeoutError` nennt den Host, sein `cause` hält weitere Fehler. Der `MockAgent` wirft bei einer Anfrage, die zu keinem Interceptor passt, einen Fehler, dessen Text die Kopfzeilen der Anfrage enthält, `Authorization` eingeschlossen.
- **Diagnose:** undici veröffentlicht auf `undici:client:sendHeaders` den ganzen Kopf jeder Anfrage, `Authorization` eingeschlossen, und auf den Kanälen `undici:request:*` die Anfrage, Kopfzeilen und Körper der Antwort und Fehler. Jeder Code im Prozess kann sie über `node:diagnostics_channel` abonnieren. Nennt `NODE_DEBUG` `undici`, `fetch` oder `websocket`, schreibt undici Methode, Origin, Pfad mit Query und Fehlertexte über `util.debuglog` nach stderr, am Logger vorbei. Sektionen von Node.js tun das ebenso, geprüft auf Node.js 26.10.0: `stream` schreibt die ersten Bytes jedes Stücks, das ein Stream liest, also auch der Antworten und der Eingabe über stdio, `net` den Host einer Verbindung. Welche Sektionen es gibt, ändert sich mit Node.js.
- **Laden:** Das Laden von undici legt einen Standard-Agent auf `globalThis` ab (`Symbol.for('undici.globalDispatcher.2')` und `.1`), den auch das eingebaute `fetch` von Node.js benutzt. undici lädt dabei `node:assert`. Das Laden von `node:assert` als CommonJS macht fd 2 nicht blockierend, gemessen auf Node.js 24.15.0, 24.21.0 und 26.10.0. `node:http`, `node:net` und `node:tls` als CommonJS tun es nicht.

## Optionen

1. **Das eingebaute `fetch`:** keine Abhängigkeit, aber seine Version von undici hängt an Node.js, es folgt Weiterleitungen und dekodiert Antworten, und ein eigener Dispatcher braucht ohnehin undici. Ein `MockAgent` für Tests braucht undici ebenfalls.
2. **`node:https` direkt:** keine Abhängigkeit und das aktuelle llhttp von Node.js, aber Pool, Fristen, Grenzen und Testdoubles wären eigener Code.
3. **undici mit eigenem Pool je Origin, festen Optionen und Prüfungen davor:** eine Abhängigkeit mit gebündeltem Code, dafür Pool, Fristen, Grenzen und `MockAgent` aus einer Hand.

## Entscheid

Gewählt ist die dritte Option.

- **Ein Transport je Origin.** Ein Transport kennt genau eine Origin, die geprüfte Adresse der Konfiguration, und genau ein `Secret`. Seine Positivliste ist diese eine Origin. Ein Anbieter eines Sprachmodells oder ein Anmeldedienst bekommt später einen eigenen Transport mit eigener Origin und eigenem Geheimnis oder keinem. So kann das Token eines Transports nie an eine andere Origin gehen, und Pool und Drosselung sind je Instanz getrennt. Der Vertrag ist in Phase 1 auf ChurchTools zugeschnitten: Schema `Login`, nur GET und keine Kopfzeilen vom Aufrufer. Andere Ziele brauchen eine Erweiterung, die nichts davon lockert.
- **Prüfung vor dem Socket.** Vor jeder Anfrage prüft der Transport das Ziel: `https`, genau seine Origin, keine Benutzerangaben, kein Fragment, kein Pfad, der mit `//` beginnt, Namen von Parametern nur aus Buchstaben, Ziffern und Unterstrichen mit einem `[]` am Ende, weder `login_token` noch `with_session`, und das Token nicht in der Adresse, weder roh noch mit `%XX` dekodiert. Die Prüfung liest eine frische Kopie der URL und benutzt keinen regulären Ausdruck. An undici gehen danach die feste Origin des Transports und nur Pfad und Query.
- **Kopfzeilen und Antwort.** Der Transport setzt `authorization: Login <token>`, `accept: application/json` und einen festen `user-agent`, den die Composition Root beim Bau übergibt, etwa Ecclium mit seiner Version, in druckbarem ASCII und mit höchstens 256 Zeichen. Der Wert des Headers `authorization` entsteht für jede Anfrage neu und liegt auf keinem Objekt, das ein Aufrufer erreicht. Von der Antwort gehen Status, Körper und nur `content-type`, `retry-after` und `date` weiter, jede nur einmal, in druckbarem ASCII und mit höchstens 256 Zeichen. `set-cookie` und alles andere bleiben im Transport. Eine Antwort mit `content-encoding` ausser `identity` wird abgewiesen, ebenso ein Status ausserhalb von 200 bis 299 und 400 bis 599.
- **TLS.** Der Transport baut seinen Connector selbst, mit `rejectUnauthorized: true` ausdrücklich, ohne HTTP/2 und ohne TLS-Optionen mit Funktionswert. SNI und Prüfung des Namens gelten immer der festen Origin. Er vertraut dem Speicher von Node.js, wie ihn die Umgebung beim Start einrichtet. Einen Dispatcher, `connect`-Optionen oder einen Socket nimmt seine Fabrik nicht an.
- **Parser.** `useMilo: false`, damit keine Variable der Umgebung den Parser wechselt, und `maxHeaderSize` 16 KiB ausdrücklich.
- **Fristen und Grenzen.** Verbindungsaufbau 10 s, Kopfzeilen der Antwort 15 s, Pause im Körper 15 s, die ganze Anfrage 30 s. Keep-Alive 10 s, auch als Obergrenze für den Hinweis des Servers, höchstens 4 Verbindungen je Pool. Jeder Aufruf nennt `maxResponseBytes`, höchstens 8 MiB, und der Pool bricht über 8 MiB ab. Mehr Aufrufe, als der Pool Verbindungen hat, warten im Transport, nicht im Pool. Die Gesamtfrist bricht mit einem eigenen, festen Grund ab. Das Signal des Aufrufers verbindet ein Listener, den der Transport über die Klasse anlegt und am Ende entfernt. Ein Abbruch oder die Gesamtfrist beendet einen Aufruf sofort, wo er auch wartet, und eine Antwort, die danach noch kommt, verwirft er ungelesen.
- **Weiterleitungen.** Keine. Eine Antwort 3xx ist ein Fehler.
- **Fehler.** Der Transport wirft nur `HttpTransportError`, einen `EccliumError` mit einer Kategorie und deren Code, ohne Text und ohne Ursache: `refused` (`internal`) für ein abgewiesenes Ziel, `connect`, `tls`, `timeout`, `aborted`, `interrupted` und `failed` (alle `network`), `too_large`, `redirect`, `encoding` und `status` (alle `upstream`). Die Kategorie folgt aus dem Code des geworfenen Werts, der Phase der Anfrage und dem eigenen Grund der Gesamtfrist, nie aus Text, Stack, Kopfzeilen oder Ursache. Bei `too_large`, `redirect`, `encoding` und `status` zerstört er den Körper, bevor er wirft, damit keine Verbindung des Pools hängen bleibt, und hängt vorher einen Listener für den Fehler an, den undici danach auslösen kann.
- **Protokoll.** Eine Zeile je Anfrage, `http_response` mit Status und Dauer oder `http_<kategorie>` mit Code und Dauer, ohne Host, URL oder Text.
- **Bau und Lebensdauer.** Einen echten Transport baut nur die Composition Root, über den Subpfad `./http` von core. Er ist ein eingefrorenes Objekt aus Funktionen, `get`, `close` und `destroy`. Pool, Connector und Token liegen nur in seinen Closures. Er setzt nie den globalen Dispatcher und schickt nie über ihn.
- **Testdouble.** Ein zweiter Subpfad, `./http/testing`, baut denselben Transport auf einem `MockAgent`, den er selbst anlegt, für den er `disableNetConnect()` aufruft und den er nie herausgibt. Ihn importiert nur der Ort des Testdoubles in testkit. Seine Liste der Aufrufe gibt die Kopfzeilen mit `authorization` im Klartext zurück, damit ein Test prüfen kann, was der Transport gesendet hat. Das ist die eine Stelle, an der ein Aufrufer den Header erreicht: testkit importieren nur Tests (ADR 0022), und Tests halten nur Kanarienwerte. Für Tests mit einem Server im selben Prozess nimmt der interne Bauweg einen schon verbundenen Socket und kürzere Fristen an. Diesen Weg erreicht kein Einstieg eines Pakets.
- **Diagnose.** Kein Code der Pakete importiert `node:diagnostics_channel`. Der Start weist jedes `NODE_DEBUG` ab, das eine Sektion einschaltet, gleich welche. Eine Liste verbotener Sektionen veraltete mit der nächsten Version von Node.js.

## Konsequenzen

- Jedes Ziel ausser der Instanz braucht einen eigenen Transport aus der Composition Root. Ein Tool kann keinen bauen.
- Der Transport parst jede Antwort mit dem gebündelten llhttp. Fehlen ihm Korrekturen, die Node.js schon ausliefert, betrifft das jede Antwort von ChurchTools. Die Grenze dafür: eine feste Origin, TLS mit geprüftem Zertifikat, keine Weiterleitung, kein Proxy. Eine verfälschte Antwort müsste von ChurchTools selbst kommen oder von jemandem mit einem gültigen Zertifikat für die Instanz. Jede neue Version von undici wird vor dem Einbau von Hand geprüft: Version von llhttp, Advisories von undici, llhttp und Node.js. Renovate übernimmt sie ohnehin nicht selbst.
- Ein Test mit der genauen Version von undici und den Prüfsummen seiner WASM-Dateien bricht bei jeder anderen Version, bis die Liste unter «Umsetzung» und die Prüfsummen im Test nachgeführt sind. Er liest die Liste und bricht auch, wenn sie nicht mehr zu Version und Prüfsummen passt. Die Prüfung des gebündelten Codes des MCP-SDK (ADR 0053) sieht diese Dateien nicht.
- **Restrisiken:**
  - **fd 2:** Jeder Prozess, der den Transport lädt, schreibt danach nicht mehr blockierend nach stderr. Der Server über stdio verliert das schon durch das MCP-SDK. Wie Logger und Audit damit umgehen, entscheidet der Start über stdio, für alle Prozesse gleich (ADR 0054).
  - **Diagnose-Kanäle:** Code eines Plugins oder einer Abhängigkeit kann die Kanäle von undici trotzdem abonnieren und liest dann Token, Kopfzeilen und Antworten. Die Regel sieht nur den Code der Pakete.
  - **Vertrauensspeicher:** Wer die Umgebung des Prozesses setzt, kann mit `NODE_EXTRA_CA_CERTS`, `NODE_USE_SYSTEM_CA` oder `--use-system-ca` einer eigenen Zertifizierungsstelle vertrauen lassen und das Token mitlesen. Wer die Umgebung setzt, kann allerdings auch über `NODE_OPTIONS` Code laden. Eine eigene Zertifizierungsstelle bleibt so für eine selbst betriebene Instanz mit internem Zertifikat möglich. Der Start über stdio soll warnen, wenn eine dieser Einstellungen aktiv ist (Umsetzung, offen).
  - **Globaler Dispatcher:** Der Standard-Agent, den undici beim Laden anlegt, ist Zustand auf einem globalen Objekt (ADR 0051, Restrisiken). Er gilt nicht je Mandant, und der Transport benutzt ihn nie. Das eingebaute `fetch` eines anderen Moduls ginge über ihn, an der Positivliste vorbei. Die Regel `[arch:network]` sperrt `fetch` im Code der Pakete.
  - **Code am Kern vorbei:** Eine Abhängigkeit, die selbst eine Verbindung öffnet, sieht die Positivliste nicht (ADR 0009).
  - **Prüfung des Tokens im Ziel:** Sie fängt ein Token, das versehentlich in Pfad oder Query gerät, nicht eines, das jemand gezielt anders kodiert.
- Der Cache der TLS-Sitzungen in `buildConnector` gehört zum Pool und damit zur benannten Ausnahme aus ADR 0051: je Transport, ohne Inhalte aus ChurchTools, ein Neustart verwirft ihn.

## Umsetzung

- **Transport:** `packages/core/src/http/transport.ts` mit dem Agent und seinem Connector, den festen Grenzen `transportLimits`, der Warteschlange vor dem Pool, der Prüfung des User-Agents und dem Lesen der Antwort. Die Prüfung des Ziels steht in `target.ts`, die Kategorien der Fehler in `failure.ts`, der Filter der Kopfzeilen in `response-headers.ts`. `http/index.ts` gibt anderen Modulen von core nur die Typen des Transports weiter.
- **Fabriken:** `packages/core/src/http/compose.ts` hinter dem Subpfad `./http` baut den echten Transport, `packages/core/src/http/compose-mock.ts` hinter `./http/testing` den auf einem `MockAgent`. `createChurchToolsDouble` in `packages/testkit/src/http-double/` umhüllt ihn für Tests.
- **Regeln:** Die Orte `transportBuilders` (`packages/cli/src/stdio/`) und `httpDouble` (`packages/testkit/src/http-double/`) in `tests/architecture/boundaries.json`, deren Lage das Laden prüft. Die Regeln `transport-only-from-composition-root`, `mocked-transport-only-in-testkit` und `no-diagnostics-channel` von dependency-cruiser und `[arch:diagnostics]` in ESLint. `tests/architecture/export-surface.test.mts` hält die Fabriken in ihren Subpfaden und den internen Bauweg aus jedem Einstieg.
- **Start:** `packages/core/src/config/load.ts` weist jedes `NODE_DEBUG` mit einer Sektion ab, mit dem Problem `debug_output_enabled`.
- **Tests:** `packages/core/src/http/*.test.ts` mit dem `MockAgent`, einem Dispatcher des Tests, der nur auf Anweisung antwortet, und einem Stream-Paar im Speicher decken den Ordner zu 100 Prozent ab. `tests/http-transport-tls.test.mts` prüft in eigenen Prozessen Vertrauen, Name, ALPN, User-Agent, Fristen, Abbruch, die Grenze des Pools, abgewiesene Antworten, die schon ganz angekommen sind, und das Freigeben einer Verbindung. `tests/blocking-descriptors.test.mts` zeigt fd 2 nach dem Laden von undici, `tests/undici-pin.test.mts` hält Version und gebündelten Code fest.
- **Gebündelter Code von undici 8.12.2,** geprüft am 16.10.2026:

  | Code                           | Lizenz | Datei                            | SHA-256               | Ergebnis                           |
  | ------------------------------ | ------ | -------------------------------- | --------------------- | ---------------------------------- |
  | llhttp 9.3.1 als WASM          | MIT    | `lib/llhttp/llhttp-wasm.js`      | `5d8313d6fe8145d8...` | keine Advisory bei GitHub oder OSV |
  | llhttp 9.3.1 als WASM mit SIMD | MIT    | `lib/llhttp/llhttp_simd-wasm.js` | `a3f30f3307ab3c19...` | wie oben                           |
  | Milo als WASM                  | ISC    | `lib/milo/no-simd.js`            | `ece090d1e2e962e0...` | abgeschaltet (`useMilo: false`)    |
  | Milo als WASM mit SIMD         | ISC    | `lib/milo/simd.js`               | `3bc5b7120aa8732d...` | abgeschaltet                       |

  Die vollen Prüfsummen stehen in `tests/undici-pin.test.mts`. Code des Projekts für `fetch` liegt unter `lib/web/`, der Transport benutzt ihn nicht.

- **Mindestalter:** undici 8.12.2 kam am 16.10.2026 mit einer Ausnahme vom Mindestalter von drei Tagen in `pnpm-workspace.yaml`, wegen der acht Advisories für 8.0.0 bis 8.12.1. Die Ausnahme fällt weg, sobald die Version drei Tage alt ist.
- **Offen:** Die Warnung des Starts über stdio, wenn `NODE_EXTRA_CA_CERTS`, `NODE_USE_SYSTEM_CA` oder `--use-system-ca` den Speicher der vertrauten Zertifikate erweitern, als Text des Katalogs mit einem Test im Kindprozess. Sie entsteht mit dem Start über stdio, zusammen mit dem Umgang mit fd 2 (ADR 0054).
