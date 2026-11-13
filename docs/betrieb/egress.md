# Grenze im Netz mit Squid

Der Runner liest fremde Texte und schreibt danach. Im Self-Hosting hängt er deshalb nur an einem internen Netz, und nur ein Proxy verbindet nach aussen ([ADR 0035](../adr/0035-proxy-und-grenze-im-netz.md)). Der Proxy lässt nur die Ziele der Konfiguration durch, auch für Code, der am Kern von Ecclium vorbei eine Verbindung öffnet. Diese Seite beschreibt die Vorlage für Squid, die Liste der Ziele und wie Sie beides prüfen. Die Compose-Datei, die alles zusammenstellt, kommt mit dem Bundle für das Self-Hosting.

## Aufbau

- Der Runner hängt nur am Netz `runner-int`, das Docker als `internal` anlegt. Er erreicht von dort nur den Proxy und setzt `ECCLIUM_EGRESS_PROXY=http://egress:3128` ([Runner](runner.md#ausgehender-weg)).
- Der Container `egress` mit Squid hängt an `runner-int` und an einem zweiten Netz nach aussen. Er veröffentlicht keinen Port.
- Squid liest die Vorlage [`deploy/selfhost/egress/squid.conf`](../../deploy/selfhost/egress/squid.conf) als `/etc/squid/squid.conf` und die Liste der Ziele als `/etc/squid/ecclium-targets.conf`, beide nur lesbar.
- Das Image steht in der Kopfzeile der Vorlage, `ubuntu/squid` mit Tag und Digest. Mit genau diesem Image ist die Vorlage geprüft. Renovate schlägt einen neuen Digest vor, übernommen wird er von Hand.
- Das Image startet Squid über pebble, das die Ausgabe von Squid nicht ins Log des Containers gibt. Starten Sie Squid deshalb direkt, mit dem Entrypoint `/usr/sbin/squid-gnutls` und den Argumenten `-f /etc/squid/squid.conf -N`. Squid läuft so ohne root.

## Was die Vorlage zulässt

Alle Regeln `http_access` stehen in der Vorlage. In dieser Reihenfolge:

1. Nur `CONNECT`, also nur ein Tunnel. Jede andere Anfrage weist Squid ab. TLS läuft durch den Tunnel bis zum Ziel, Squid bricht es nicht auf.
2. Ein Ziel im lokalen Netz aus `ECCLIUM_EGRESS_ALLOW_LAN` geht auf seinem eigenen Port, auch an einer privaten Adresse, ausser sein Name löst auf Loopback, Link-Local, unspezifiziert, Multicast oder einen reservierten Bereich auf.
3. Jedes andere Ziel muss auf der Liste stehen, mit genau seinem Namen und Port. Ein Name darunter, etwa mit `www.` davor, oder die IP-Adresse des Namens passt nicht.
4. Ausserhalb des lokalen Netzes nur Port 443.
5. Keine private oder besondere Adresse, für IPv4 und IPv6: die Bereiche aus RFC 1918, CGNAT, Loopback, Link-Local, ULA, Dokumentation, NAT64, 6to4, Teredo, Multicast und reserviert. Squid prüft das nach der Auflösung des Namens, also auch für einen öffentlichen Namen, der auf eine interne Adresse zeigt.
6. Alles andere weist Squid ab.

Bis zur dritten Regel prüft Squid nur Methode, Name und Port. Für einen Namen, der nicht auf der Liste steht, fragt er deshalb nie DNS, so dass auch eine Anfrage an DNS keine Daten nach draussen trägt.

Squid hält nichts im Cache. Das Zugriffslog geht auf stdout und nennt je Verbindung Zeit, Dauer, Client, Ergebnis, Bytes, Methode, Host, Port und die Adresse des Ziels, nie einen Pfad oder eine Query.

## Liste der Ziele erzeugen

`ecclium init egress` schreibt die Liste aus der Konfiguration des Runners auf stdout. Der Befehl ändert keine Datei und fragt nichts über das Netz, auch nicht den Proxy. Leiten Sie die Ausgabe in eine neue Datei und ersetzen Sie die alte erst, wenn der Befehl mit 0 endet:

```sh
ecclium init egress > ecclium-targets.conf.neu && mv ecclium-targets.conf.neu ecclium-targets.conf
```

- Auf der Liste stehen ChurchTools, jeder Anbieter aus `ECCLIUM_PROVIDERS_FILE` und der Host der Ping-URL, jeder mit genau seinem Namen und Port. Der Pfad der Ping-URL steht nie darin.
- Die Liste enthält nur Zeilen `acl` und hängt Paare aus Name und Port an die zwei Listen an, die die Vorlage anlegt. Eine Regel kann sie nicht hinzufügen: Squid liest sie erst nach der letzten Regel. Eine leere Liste lässt nichts durch.
- Erzeugen Sie die Liste nach jeder Änderung der Adresse von ChurchTools, der Anbieter, der Ping-URL oder von `ECCLIUM_EGRESS_ALLOW_LAN` neu und starten Sie danach den Container `egress` neu.
- Bei einem Problem schreibt der Befehl nichts auf stdout. Mit 78 endet er bei einer ungültigen Konfiguration des Runners und bei einem Ziel mit einem anderen Port als 443, das nicht in `ECCLIUM_EGRESS_ALLOW_LAN` steht, weil die Vorlage es nie durchliesse. Mit 74 endet er, wenn die Liste nicht ganz auf stdout ging.

## Ziele im lokalen Netz

Ein Modell oder eine selbst betriebene ChurchTools-Instanz im eigenen Netz nennen Sie in `ECCLIUM_EGRESS_ALLOW_LAN`, etwa `modell.example.org:8443`. Jedes Ziel muss Name und Port der Adresse von ChurchTools oder des Endpunkts eines Anbieters sein, mit ausgeschriebenem Port, auch 443. Wie jede Adresse der Konfiguration ist es ein Name mit Punkt, keine IP-Adresse und nicht `localhost`. Ein solches Ziel darf einen anderen Port als 443 haben und an einer privaten Adresse liegen. Die Variable wirkt nur über die Liste: Ein Runner mit `ECCLIUM_EGRESS=off` warnt, wenn sie gesetzt ist.

## Prüfen

- `ecclium config check --runner` prüft die Konfiguration, ohne etwas anzufragen.
- Der Runner bittet bei jedem Start um einen Tunnel zu ChurchTools, ohne eine Anfrage zu senden, und endet mit 69, wenn der Proxy ihn nicht gibt. Das Zugriffslog von Squid zeigt dann `TCP_DENIED/403` mit Host und Port.
- Von Hand prüfen Sie aus einem Container im Netz `runner-int`, dass ein Tunnel zu ChurchTools geht, einer zu einem anderen Host nicht und eine Verbindung ohne Proxy scheitert, etwa mit `curl -sS -o /dev/null -w '%{http_connect}\n' -x http://egress:3128 https://example.church.tools/`. Erwartet sind 200 für ChurchTools und 403 für einen Host, der nicht auf der Liste steht.

## Grenzen

- Squid löst die Namen auf der Liste selbst auf. Zeigt der Name eines Ziels später auf eine andere öffentliche Adresse, geht der Tunnel dorthin. Eine private Adresse weist die Vorlage ausserhalb des lokalen Netzes immer ab.
- Squid sieht Host und Port jedes Ziels, Zeitpunkte und Grössen, nie Inhalte oder ein Token.
- Der Proxy verlangt keine Anmeldung. Er ist nur aus dem Netz `runner-int` erreichbar und veröffentlicht keinen Port.
- Canonical baut das Image unregelmässig neu. Prüfen Sie bei einem Hinweis auf eine Lücke in Squid, ob ein neuer Digest bereitsteht.
- Der Server hat keine Grenze im Netz. Für ihn gilt die Positivliste im Code ([ADR 0009](../adr/0009-positivliste-ausgehend.md)).
