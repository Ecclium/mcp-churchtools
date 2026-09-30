# ADR 0004: Getrennte Container-Images für Server und Runner, gleicher Inhalt aus dem npm-Tarball, Trennung über Rechte und Zugangsdaten

- Status: Entwurf
- Datum: 30.09.2026
- Fällt vor: Phase 7

## Kontext

Im Self-Hosting laufen zwei Dienste. Der Server beantwortet Anfragen von MCP-Clients, liest aus ChurchTools, schreibt nur, wenn der Betreiber Schreib-Tools freischaltet, und muss einen Port anbieten. Der Runner führt Routinen nach Zeitplan aus, schreibt nur, was die Richtlinie erlaubt, bietet keinen Port an und erreicht im Self-Hosting das Netz nur über einen Proxy (ADR 0009). Die beiden brauchen verschiedene Zugangsdaten, Rechte und Netze.

Veröffentlicht wird genau ein Produktpaket, `@ecclium/mcp-churchtools`, gebündelt und mit dem Befehl `ecclium` (ADR 0022). Festzulegen ist, ob Server und Runner ein gemeinsames Image haben oder zwei, und was darin liegt.

## Optionen

1. **Ein Image, die Rolle über den Befehl:** ein Build und eine Prüfung, aber die Rolle ist nur ein Argument beim Start. Wer ein Image betreibt, sieht ihm nicht an, wofür es gedacht ist, und Rechte und Netze hängen allein an der Compose-Datei.
2. **Zwei Images mit verschiedenem Inhalt,** der Server ohne den Code des Runners: weniger Code im Server, aber zwei Builds, zwei Prüfungen und zwei Stände, die auseinanderlaufen können, obwohl das veröffentlichte Paket beides enthält.
3. **Zwei Images mit gleichem Inhalt aus genau dem npm-Tarball,** getrennt über Befehl, Rechte, Zugangsdaten und Netz.

## Entscheid

Entwurf: Vorgesehen ist die dritte Option.

- Zwei Images, `ghcr.io/ecclium/mcp-churchtools-server` und `ghcr.io/ecclium/mcp-churchtools-runner`. Beide enthalten genau das veröffentlichte npm-Paket, damit in keinem Image Code liegt, der nicht auch im Paket geprüft wurde.
- Jedes Image hat seinen festen Befehl. Der Server bekommt sein eigenes Dienstkonto, der Runner ein eigenes, auf seine Routinen beschränktes (ADR 0023). Der Runner hängt nur an einem internen Netz (ADR 0009).
- **Abgrenzung:** Basis-Image, Signaturen und Attestations regelt ADR 0038. Wie der Runner-Container von aussen zu betreiben ist, regelt der Runner-Container-Vertrag in ADR 0036.

## Konsequenzen

- Beide Images haben dieselbe Stückliste und werden gemeinsam geprüft. Ein Fund betrifft immer beide.
- Restrisiken: Der Code des Runners liegt auch im Image des Servers. Wer den Server-Container übernimmt, hat diesen Code, aber nicht die Zugangsdaten des Runners und nicht dessen Netz.
- Offen: Der Entwurf wird vor Phase 7 zusammen mit ADR 0038 zur Bestätigung vorgelegt. Der Runner-Container-Vertrag in ADR 0036 fällt schon vor Phase 6.
