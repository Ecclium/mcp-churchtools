# ADR 0009: Positivliste für ausgehende Verbindungen, auch im Self-Hosting

- Status: Angenommen am 09.11.2026
- Datum: 30.09.2026
- Fällt vor: Phase 6

## Kontext

Der Runner liest fremde Texte aus ChurchTools, gibt Daten an ein Sprachmodell und schreibt danach. Gelingt eine indirekte Prompt-Injection über einen Wiki-Text, ist ein Abfluss von Daten an eine beliebige Adresse der schwerste mögliche Schaden. Der Server liest ebenfalls fremde Texte und gibt sie an einen MCP-Client weiter.

Ecclium braucht nur wenige Ziele: die ChurchTools-Instanz, den Anbieter des Sprachmodells, den der Betreiber konfiguriert, und im OAuth-Modus den Anmeldedienst des Betreibers (ADR 0037). Festzulegen ist, wie Verbindungen zu allen anderen Zielen verhindert werden.

## Optionen

1. **Keine Einschränkung:** einfach, aber ein Fehler im Code oder eine kompromittierte Abhängigkeit erreicht jede Adresse.
2. **Nur eine Grenze im Netz,** ein Proxy als einziger Weg nach aussen: wirksam auch gegen Code, der am Kern vorbei Verbindungen öffnet, aber nur dort, wo das Netz kontrolliert wird. Der Server muss einen Port anbieten, und im Betrieb über stdio gibt es kein Netz, das Ecclium kontrolliert.
3. **Eine Positivliste im Code, immer, und im Self-Hosting zusätzlich eine Grenze im Netz für den Runner.**

## Entscheid

Gewählt ist die dritte Option.

- **Im Code, in jeder Betriebsart:** Alle ausgehenden Verbindungen laufen über einen einzigen Weg im Kern (ADR 0022). Er prüft das Ziel gegen die Positivliste, bevor eine Verbindung aufgebaut wird. Die Liste leitet sich aus der Konfiguration ab: aus der ChurchTools-URL, aus den Basis-URLs der Modellanbieter und im OAuth-Modus aus Issuer und `jwks_uri` des Anmeldediensts. Dazu kommt eine Ping-URL im Format von Healthchecks, mit der der Runner einen Lauf meldet, aber nur, wenn der Betreiber sie setzt. Weil ihr Pfad wie ein Geheimnis wirkt, kommt sie aus einer Datei, steht nie im Log, und der Ping sendet keinen Inhalt. Sie enthält keine Platzhalter für ganze Domains. Ecclium meldet nichts an das Projekt und nichts an den Lizenzgeber des Zusatzmoduls.
- **Im Self-Hosting, standardmässig an:** Der Runner hängt nur an einem internen Netz. Nur ein Proxy-Container verbindet nach aussen und lässt nur die Ziele der Liste zu. Ein Sprachmodell im lokalen Netz ist nur mit ausdrücklich genanntem Host und Port erlaubt.
- Der Server hat keine Grenze im Netz, weil er einen Port anbietet. Für ihn gilt die Liste im Code.
- **Ausweg:** Die Grenze im Netz lässt sich abschalten. Ecclium warnt dann beim Start und vermerkt es im Audit.
- **Abgrenzung:** Proxy, Vorlage für seine Konfiguration und die Anbindung im Code regelt ADR 0035.

## Konsequenzen

- Ein neues Ziel braucht eine Änderung der Konfiguration. Das ist gewollt: Der Betreiber sieht jedes Ziel.
- Restrisiken: Die Liste im Code hält Code nicht auf, der am Kern vorbei eine Verbindung öffnet, etwa in einer kompromittierten Abhängigkeit. Das leistet nur die Grenze im Netz, und die gibt es nur für den Runner im Self-Hosting. Das Permission Model von Node.js kann ab Node.js 25 das Netz sperren, aber nur ganz oder gar nicht (Dokumentation von Node.js, «Command-line API», Option `--allow-net`, dort als in Entwicklung gekennzeichnet). Gegen Code am Kern vorbei hilft es deshalb nur einem Prozess, der kein Netz braucht (ADR 0019). Ob die Images es nutzen, regelt ADR 0038.
- Dass nur der ausgehende Weg im Kern Verbindungen öffnet, legt ADR 0022 fest. Seit Phase 1 prüfen es eine Regel von dependency-cruiser und eine ESLint-Sperre (ADR 0022, Umsetzung), für den Code der Pakete, nicht den ihrer Abhängigkeiten. Die Positivliste im Code ist mit dem ausgehenden Weg in Phase 1 nach dem Entwurf entstanden (ADR 0056). Die Grenze im Netz entsteht mit dem Runner in Phase 6, Proxy und Anbindung regelt ADR 0035.
- Angenommen am 09.11.2026 mit dem Plan für Phase 6. Gegenüber dem Entwurf kommt die Ping-URL als Ziel dazu. Der Code ändert sich dadurch erst, wenn der Runner sie bekommt.

## Umsetzung

- **Ping-URL, seit dem 13.11.2026:** `ECCLIUM_RUNNER_PING_URL_FILE` nennt eine Datei mit der Adresse ([ADR 0055](0055-konfiguration-identitaet.md)). Nur die Konfiguration des Runners liest sie, beim Start und mit `ecclium config check --runner`, mit den Prüfungen der Token-Datei, und die Konfiguration hält die Adresse als `Secret`. `parsePingUrl` in `packages/core/src/http/origin.ts` prüft sie mit den Regeln des Endpunkts eines Modells und einem Pfad, der mit `/fail` die Grenze eines Endpunkts hält.
- **Zweck `ping` im ausgehenden Weg, seit dem 13.11.2026:** `createPingTransport` in `transport.ts`, gebaut von `createPingHttpTransport` in `compose.ts`, sendet nur `POST` ohne Körper und ohne Kopfzeile `Authorization` an genau den Pfad der Adresse oder an ihn mit `/fail`, über eine Verbindung, mit 10 Sekunden für Verbindung, Kopfzeilen und Körper und 15 Sekunden für den ganzen Aufruf. Ein Verweis (3xx) ist wie überall `redirect`, jeder andere Status ausser 2xx der Fehler `status`, dessen Logzeile den Status nennt. Die Positivliste im Code ist wie bei ChurchTools und den Modellen die eine Origin des Transports, aus der Konfiguration. Die Zeilen des Logs tragen `purpose` `ping` und nie die Adresse.
- **Runner, seit dem 13.11.2026:** Welcher Ping nach einem Durchgang geht, entscheidet `pingOf` im Paket `runner` nur aus dem, was aus jeder Routine wurde. Die Wurzel der Komposition des Runners baut den Transport für jeden Ping und zerstört ihn danach, damit keine Verbindung `ecclium run-once` offen hält, und sendet nach einem Signal keinen Ping. Ein Ping, der scheitert, ändert keinen Lauf und keinen Exit-Code, und das Audit nennt ihn nicht. Die Doku für Betreiber steht in [Runner](../betrieb/runner.md), «Ping an eine Überwachung».
- **Tests:** der Transport auf einem `MockAgent` und durch einen Proxy auf Loopback, der im `CONNECT` nur Host und Port sieht, die Prüfung der Adresse und der Datei, und der Runner von Ende zu Ende mit einem Kanarienwert im Pfad der Adresse, der weder auf stdout und stderr noch im Log, in den Meldungen oder in der Audit-Datei steht.
