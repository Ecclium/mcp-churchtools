# ADR 0052: Tests ohne Aussenverbindung

- Status: Vorgeschlagen
- Datum: 11.10.2026
- Fällt vor: Phase 1

## Kontext

Tests und Prüfungen bauen keine echte Verbindung auf, weder zu einer ChurchTools-Instanz noch zu einem Dienst im Internet. ADR 0049 schliesst CI gegen echte Instanzen aus, das Threat Model nennt die Verwechslung von Testinstanz und Tenant (T23) und Prüfungen, die mit dem Code eines Pull Requests laufen (L6). Bisher hält das nur die Sorgfalt der Tests: Die Tests der Proben übergeben ein eigenes `fetch`, und kein Test öffnet einen Socket nach aussen. Erzwungen ist es nicht. In Phase 1 entsteht Code, der Verbindungen öffnet, der ausgehende Weg mit undici (ADR 0022). Ein Test, der einen Client mit seinen Voreinstellungen erzeugt, erreicht dann einen echten Host, und das fällt nicht auf, solange das Netz da ist.

Bedingungen:

- CI prüft mit drei Versionen von Node.js: 24.21.0 im Job `check`, 26.10.0 in `compat` und 24.15.0 in `minimum` (ADR 0019). Vitest 5.0.3 startet die Testdateien in eigenen Prozessen (Pool `forks`).
- Tests starten Kindprozesse: git, mise, lefthook, gitleaks und Node.js.
- Jobs, die mise benutzen, behalten nur `contents: read` (ADR 0050). Es kommt keine neue Abhängigkeit und keine fremde Action dazu (ADR 0021).
- Jeder gehostete Runner ist eine eigene VM für einen Job, und jeder Schritt hat sudo ohne Passwort (GitHub Docs, «GitHub-hosted runners», Abschnitt «Administrative privileges», abgerufen am 10.10.2026).
- Ubuntu 24.04 beschränkt unprivilegierte Benutzer-Namensräume über AppArmor: Ein Prozess darf einen anlegen, erhält darin aber keine Capabilities (Ubuntu 24.04 LTS, Release Notes, Abschnitt «Unprivileged user namespace restrictions», abgerufen am 10.10.2026). Ohne Capabilities kann er dort weder seine Benutzer-ID abbilden noch Loopback einschalten. Aufheben lässt sich das mit `kernel.apparmor_restrict_unprivileged_userns=0`.
- Ein neuer Netz-Namensraum hat nur das Gerät `lo`, und es ist anfangs ausgeschaltet.
- Das Berechtigungsmodell von Node.js kennt die Freigabe für das Netz, `--allow-net`, erst ab Version 25.0.0, mit Stabilität 1.1. Ohne diese Freigabe sperrt es das Netz ganz, auch `127.0.0.1` (Dokumentation von Node.js 26, «Command-line API», Abschnitt «--allow-net», abgerufen am 10.10.2026).

## Optionen

1. **Nur Konvention und Durchsicht:** kostet nichts, aber ein vergessenes `fetch` fällt erst auf, wenn das Netz fehlt.
2. **Sperre im Testprozess:** fängt jede Verbindung aus dem Code der Tests am Ort des Aufrufs ab, mit einer klaren Meldung, lokal und in CI. Programme, die nicht Node.js sind, und Wege an den gesperrten Funktionen vorbei sieht sie nicht.
3. **Netz-Namensraum in CI:** fängt jeden Prozess, gleich in welcher Sprache, aber nur in CI und mit einer knappen Meldung des Betriebssystems.
4. **Berechtigungsmodell von Node.js:** fehlt in zwei der drei Versionen, sperrt auch Loopback und braucht eigene Freigaben für Dateien, Kindprozesse und Worker.
5. **Fremde Action mit Filter für ausgehende Verbindungen:** eine weitere Action in der Lieferkette und eine Positivliste für den ganzen Job samt Installation.
6. **Sperre im Testprozess und Netz-Namensraum in CI.**

Für den Namensraum auf `ubuntu-24.04` kommen diese Wege in Frage:

- a. **Unprivilegiert ohne Änderung:** scheitert an der Einschränkung durch AppArmor.
- b. **Einschränkung für den Job aufheben, dann unprivilegiert:** Ein äusserer Benutzer-Namensraum mit neuem Netz-Namensraum schaltet Loopback ein, ein innerer bildet wieder den Benutzer des Runners ab, ohne Capabilities. Es braucht einen einzigen Aufruf von sudo, die Umgebung bleibt unverändert.
- c. **Namensraum mit sudo anlegen, dann zurück zum Benutzer des Runners:** mit `setpriv`, ohne Zusatzgruppen und mit `no_new_privs`. Keine Kernel-Einstellung ändert sich, aber sudo setzt die Umgebung zurück, `PATH` und `HOME` müssen ausdrücklich mit.
- d. **Docker mit `--network none`:** braucht ein gepinntes Image in der Lieferkette und Mounts für das Arbeitsverzeichnis und die Werkzeuge von mise. Der Container hat keine Loopback-Adresse für IPv6.
- e. **Filter nach Benutzer mit iptables:** eine Namensauflösung über systemd-resolved liefe an einer Regel nach Benutzer vorbei.

## Entscheid

Gewählt ist Option 6, für den Namensraum der Weg b mit c als Rückfall im selben Lauf.

- **Sperre im Testprozess:** Vitest lädt in jeden Testprozess die Setup-Datei `tests/support/no-network.setup.mts`. Sie installiert `tests/support/no-network.mts`.
  - Erlaubt sind TCP, TLS und UDP zu `127.0.0.1` und `::1`, geschrieben als IP-Literal, und TCP-Server, die auf einer dieser Adressen lauschen.
  - Gesperrt sind:
    - jede andere Adresse, auch `127.0.0.2`, `::ffff:127.0.0.1` und `0.0.0.0`;
    - jede Namensauflösung, auch `localhost`;
    - Verbindungen über lokale Sockets und Named Pipes;
    - TCP-Server ohne Adresse oder auf einer anderen Adresse, weil sie einen Port im lokalen Netz öffnen;
    - Worker-Threads, in denen die Sperre nicht gälte;
    - die Bindungen für Sockets und DNS hinter `process.binding`;
    - `http.setGlobalProxyFromEnv`.
  - Die Sperre sitzt an diesen Stellen:
    - in `net.Socket.prototype.connect`, über das TLS, HTTP, HTTP/2, `fetch` und `WebSocket` von Node.js laufen;
    - in `net.Server.prototype.listen`;
    - in allen Funktionen zur Namensauflösung von `dns` und `dns.promises` samt ihren `Resolver`;
    - in `dgram`.
  - Jeder Versuch lässt den laufenden Test scheitern, auch wenn der Code den Fehler abfängt. Was keinem Test zuzuordnen ist, etwa in einem Test mit `it.fails` oder nach den Haken eines Tests, lässt die Datei scheitern. Einen Versuch, den kein Haken eines Tests sieht, weil er beim Laden der Datei, nach dem letzten Test oder in einer Datei mit nur übersprungenen Tests geschieht, meldet die Sperre zusätzlich als unbehandelten Fehler, an dem der ganze Lauf scheitert. Die Meldung nennt nur Art, Host und Port, nie Kopfzeilen oder Pfade.
  - Die ersetzten Funktionen lassen sich nicht überschreiben, `vi.spyOn` scheitert an ihnen.
  - Kindprozesse mit Node.js erben die Sperre über `NODE_OPTIONS`. Ein solcher Prozess endet nach einem gesperrten Versuch mit Code 70, auch wenn er den Fehler abgefangen hat. Ein Test, der ein Programm mit eigener Prüfung seiner Umgebung startet, gibt ihm mit `withoutNetworkGuard` eine Umgebung ohne die Sperre. Diesen Prozess deckt dann nur der Namensraum in CI. Die Sperre lädt `node:process` und macht so fd 2 jedes Kindprozesses, der sie erbt, nicht blockierend, wenn fd 2 eine Pipe oder ein Socket ist, nach der Probe zu `node:process` auch fd 0 und fd 1 (ADR 0054). Ein Test, der prüft, ob ein Deskriptor blockiert, startet sein Kind deshalb mit einer eigenen Umgebung ohne die Sperre, wie `tests/blocking-descriptors.test.mts`.
  - Die Setup-Datei entfernt die Variablen für einen Proxy und `NODE_USE_ENV_PROXY` aus der Umgebung des Testprozesses. Folgt Node.js beim Start schon einem Proxy auf Loopback, genannt in `HTTP_PROXY`, `HTTPS_PROXY` oder `ALL_PROXY`, bricht der Lauf vor dem ersten Test ab, weil der Proxy jede Verbindung weitertragen würde.
- **Netz-Namensraum in CI:** Die Jobs `check`, `compat` und `minimum` führen Build und Prüfungen in einem Netz-Namensraum aus, dessen einziges Gerät Loopback ist. Checkout, mise und die Installation laufen vorher mit Netz.
  - Die Einschränkung durch AppArmor wird nur auf einem Runner von GitHub aufgehoben, nie auf einem anderen Rechner.
  - Auf einem Runner von GitHub stoppt der Wrapper vor dem Namensraum Docker für den Rest des Jobs. Docker läuft ausserhalb des Namensraums und erreicht das Netz für jeden Prozess, der seinen Socket benutzen darf. Der Benutzer des Runners darf das als Mitglied der Gruppe `docker`, und Weg b behält seine Gruppen. Lässt sich Docker nicht stoppen, scheitert der Job.
  - Die Prüfungen laufen als Benutzer des Runners, ohne Capabilities. mise läuft dort ohne Netz.
  - Gelingt Weg b nicht, versucht derselbe Lauf Weg c. Entsteht kein Namensraum, scheitert der Job. Ohne Namensraum laufen die Prüfungen nie.
  - Eine Netzprobe zeigt vor dem Namensraum, dass der Job das Netz erreicht, und darin, dass es nur `lo` gibt und keine Verbindung nach aussen gelingt, auch nicht über den Socket von Docker.
- **Gegenprobe:** Absichtlich verbindende Tests liegen ausserhalb des include-Musters in `tests/fixtures/network/`. Ein Test startet sie in eigenen Läufen von Vitest mit der Konfiguration des Workspace. Er verlangt, dass jeder Test, der eine Verbindung versucht, mit der Meldung der Sperre scheitert, dass Versuche, die kein Test meldet, die Datei oder den Lauf scheitern lassen, und dass das Gegenstück über Loopback besteht. Ein weiterer Test startet einen Prozess mit Node.js und der Sperre, der jeden Weg nach aussen probiert, und verlangt, dass jeder Versuch am Fehler der Sperre scheitert, nicht erst am Netz.
- **Lokal** gilt nur die Sperre im Testprozess. Den Namensraum legt nur CI an.

## Konsequenzen

- Ein Test, der einen Server braucht, bindet ihn an `127.0.0.1` oder `::1` und spricht ihn über diese Adresse an, nie über `localhost`. Tests des ausgehenden Wegs übergeben `fetch` oder einen Dispatcher. `vi.spyOn`, nock und ähnliches Abfangen auf `net`, `dns` und `dgram` gehen nicht.
- Ein Kindprozess mit Node.js, der das Netz versucht, endet mit Code 70. Ein Test, der den genauen Code eines solchen Prozesses erwartet, sieht diesen Code.
- Ein Werkzeug, das im Testprozess Worker-Threads startet, läuft dort nicht.
- In den Jobs `check`, `compat` und `minimum` steht Docker für Build und Prüfungen nicht zur Verfügung.
- Restrisiken:
  - Lokal sieht die Sperre nur Node.js: den Testprozess und Kindprozesse, die `NODE_OPTIONS` erben. Ohne Sperre laufen git, mise, lefthook, gitleaks und andere Programme, Kindprozesse mit einer Umgebung ohne die Sperre, native Erweiterungen und der Hauptprozess von Vitest mit Konfiguration und Reportern. In CI fängt der Namensraum diese Fälle.
  - Loopback ist für jeden Port erlaubt. Ein Dienst auf `127.0.0.1` eines Rechners der Entwicklung, etwa ein Proxy, kann eine Verbindung weitertragen, wenn ein Test ihn ausdrücklich anspricht. Im Namensraum in CI läuft kein solcher Dienst.
  - Ein Netz-Namensraum trennt keine lokalen Sockets mit Pfad. Den Socket von Docker schliesst CI, indem es Docker stoppt. Andere bleiben offen, etwa der Systembus von D-Bus. Code, der sie gezielt nutzt, erreicht das Netz weiter. Sperre und Namensraum fangen Versehen, nicht Absicht. Gegen Absicht schützen weiter die Freigabe von Läufen aus Forks und die Durchsicht (L6).
  - Mit Weg b bleibt die Einschränkung durch AppArmor bis zum Ende des Jobs aufgehoben. Die VM dient nur diesem Job, und sudo ohne Passwort steht jedem Schritt ohnehin offen. Die Prüfungen selbst laufen ohne Root.
  - UDP bindet beim Senden implizit an alle Adressen. Die Sperre prüft das Ziel, nicht diese Bindung. Auch ein UDP-Socket, der ausdrücklich an alle Adressen bindet, eine Mitgliedschaft in einer Multicast-Gruppe und `inspector.open` sperrt sie nicht.
  - Ändert GitHub das Image so, dass der Namensraum nicht mehr entsteht, scheitern die drei Jobs, bis der Weg angepasst ist.

## Umsetzung

- Sperre: `tests/support/no-network.mts`, Setup-Datei `tests/support/no-network.setup.mts`, eingebunden über `setupFiles` in `vitest.config.mts`.
- Tests der Sperre und Gegenprobe: `tests/support/no-network.test.mts` mit den Dateien in `tests/fixtures/network/`: `attempts.mts` für den Prozess mit der Sperre, `connects.mts`, `environment.mts`, `hidden.mts`, `late-load.mts` und `loopback.mts` für die eigenen Läufe von Vitest, `vitest.config.mts` für diese Läufe. Geprüft auf Node.js 24.21.0, 26.10.0 und 24.15.0.
- Netz-Namensraum: `scripts/ci/without-network.sh` stoppt auf einem Runner von GitHub Docker und legt dann den Namensraum an, mit Weg b und Rückfall auf Weg c, und gibt den gelaufenen Weg und die Fakten des Runners als Annotation aus. Der Schritt «Build, then run every check without network» der Jobs `check`, `compat` und `minimum` in `.github/workflows/ci.yml` ruft ihn auf, mit `MISE_OFFLINE`. Checkout, mise und die Installation laufen davor mit Netz.
- Netzprobe: `scripts/ci/check-network.mts` zeigt vor dem Namensraum, dass der Job das Netz erreicht, und darin, dass es nur `lo` gibt, dass Loopback über IPv4 und IPv6 trägt und dass Namensauflösung, Verbindung nach aussen und Verbindung zum Socket von Docker sofort scheitern. Ihr Urteil prüft `tests/scripts/check-network.test.mts`.
- `tests/workflows/network-namespace.test.mts` verlangt, dass jede Ausführung der Prüfungen in einem Workflow über den Wrapper läuft, in jedem der drei Jobs genau einmal, mit `MISE_OFFLINE`, ohne Bedingung und ohne `continue-on-error`. Er prüft Reihenfolge und Fehlerbehandlung des Wrappers samt dem Stoppen von Docker, jeweils mit absichtlich falschen Fassungen, und lässt shellcheck über ihn laufen. In CI verlangt ein Test zusätzlich, dass die Tests im Namensraum laufen und nur `lo` sehen.
- Die ersten zwei Läufe in CI am 11.10.2026, auf `ubuntu-24.04` in den Jobs `check`, `compat` und `minimum`, sind grün:
  - Beide Läufe nahmen Weg b. Die Einschränkung durch AppArmor stand vorher auf 1.
  - Vor dem Namensraum gibt es `eth0` und `lo`, Namensauflösung und Verbindung nach aussen gelingen.
  - Im Namensraum gibt es nur `lo`. Loopback über IPv4 und IPv6 trägt, die Namensauflösung scheitert nach 1 bis 4 ms mit `EAI_AGAIN`, die Verbindung nach aussen nach höchstens 1 ms mit `ENETUNREACH`. Der Runner löst Namen über `hosts: files dns` auf, kein Modul von nsswitch fragt dabei über einen lokalen Socket.
  - Der erste Lauf zeigte, dass der Benutzer des Runners zur Gruppe `docker` gehört und den Socket von Docker beschreiben darf. Seither stoppt der Wrapper Docker. Im zweiten Lauf antwortete der Socket vor dem Stoppen und scheiterte im Namensraum mit `ECONNREFUSED`.
  - Der Schritt dauerte 45 bis 78 s im ersten und 75 bis 76 s im zweiten Lauf, auf `main` vorher 75 bis 76 s. Der Namensraum kostet keine messbare Zeit.
- Rote Läufe am 11.10.2026, in einem Pull Request, der nicht gemergt wurde (#78): Ein Test, der sich aus dem Testprozess mit `github.com:443` verband, scheiterte in den Jobs `check`, `compat` und `minimum` an der Sperre. Derselbe Versuch aus einem Kindprozess ohne die Sperre scheiterte dort am Namensraum, mit `EAI_AGAIN`. Die übrigen Prüfungen blieben grün.
