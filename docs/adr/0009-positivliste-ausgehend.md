# ADR 0009: Positivliste für ausgehende Verbindungen, auch im Self-Hosting

- Status: Entwurf
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

Entwurf: Vorgesehen ist die dritte Option.

- **Im Code, in jeder Betriebsart:** Alle ausgehenden Verbindungen laufen über einen einzigen Weg im Kern (ADR 0022). Er prüft das Ziel gegen die Positivliste, bevor eine Verbindung aufgebaut wird. Die Liste leitet sich aus der Konfiguration ab: aus der ChurchTools-URL, aus der Basis-URL des Modellanbieters und im OAuth-Modus aus Issuer und `jwks_uri` des Anmeldediensts. Sie enthält keine Platzhalter für ganze Domains. Ecclium meldet nichts an das Projekt und nichts an den Lizenzgeber des Zusatzmoduls.
- **Im Self-Hosting, standardmässig an:** Der Runner hängt nur an einem internen Netz. Nur ein Proxy-Container verbindet nach aussen und lässt nur die Ziele der Liste zu. Ein Sprachmodell im lokalen Netz ist nur mit ausdrücklich genanntem Host und Port erlaubt.
- Der Server hat keine Grenze im Netz, weil er einen Port anbietet. Für ihn gilt die Liste im Code.
- **Ausweg:** Die Grenze im Netz lässt sich abschalten. Ecclium warnt dann beim Start und vermerkt es im Audit.
- **Abgrenzung:** Proxy, Vorlage für seine Konfiguration und die Anbindung im Code regelt ADR 0035.

## Konsequenzen

- Ein neues Ziel braucht eine Änderung der Konfiguration. Das ist gewollt: Der Betreiber sieht jedes Ziel.
- Restrisiken: Die Liste im Code hält Code nicht auf, der am Kern vorbei eine Verbindung öffnet, etwa in einer kompromittierten Abhängigkeit. Das leistet nur die Grenze im Netz, und die gibt es nur für den Runner im Self-Hosting. Das Permission Model von Node.js kann ab Node.js 25 das Netz sperren, aber nur ganz oder gar nicht (Dokumentation von Node.js, «Command-line API», Option `--allow-net`, dort als in Entwicklung gekennzeichnet). Gegen Code am Kern vorbei hilft es deshalb nur einem Prozess, der kein Netz braucht (ADR 0019). Ob die Images es nutzen, regelt ADR 0038.
- Offen: Dass nur der Kern Verbindungen öffnet, legt ADR 0022 fest, eine Architekturregel prüft es noch nicht. Die Positivliste im Code und diese Regel entstehen mit dem ausgehenden Weg in Phase 1, die Grenze im Netz mit dem Runner in Phase 6. Die Positivliste im Code entsteht in Phase 1 nach diesem Entwurf. Er wird vor Phase 6 zur Bestätigung vorgelegt, und ändert die Bestätigung etwas daran, wird der Code nachgeführt.
