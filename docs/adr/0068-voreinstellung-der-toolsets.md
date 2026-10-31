# ADR 0068: Voreinstellung von `ECCLIUM_TOOLSETS` ab Phase 4

- Status: Angenommen am 31.10.2026
- Datum: 31.10.2026
- Fällt vor: Phase 4

## Kontext

[ADR 0062](0062-toolsets.md) hält fest: Ist `ECCLIUM_TOOLSETS` leer oder nicht gesetzt, schaltet der Server kein Toolset ein und bietet nur `ct_whoami` an. Das gilt bis Phase 4, dann entscheidet ein eigenes ADR über eine andere Voreinstellung. Die Grenze sollte dafür sorgen, dass ein Server auf einem produktiven Tenant ohne ausdrückliche Einstellung nur `ct_whoami` anbietet, solange die Maskierung nur ihr Minimum kann.

Heute gibt es sieben Toolsets: `persons`, `events`, `calendars`, `wiki`, `songs`, `docs` und `api`. `all` schaltet die sechs ausser `api` ein ([ADR 0066](0066-doku-index.md), [ADR 0067](0067-generischer-lesezugriff.md)). Mit `persons`, `events` und `api` warnt jeder Start, und über stdio verlangen sie die Audit-Datei. `docs` liest nur den Index der Dokumentation, der mit Ecclium kommt, und fragt ChurchTools nie. Phase 4 bringt die Stufe `strict` und Kennungen im Audit mit Kette und Frist ([ADR 0028](0028-audit-ereignis-und-datei-sink.md)). Sie ändert aber nichts daran, dass ein eingeschaltetes Toolset dem KI-Assistenten zeigt, was das Dienstkonto lesen darf. Die Rechte des Kontos bleiben die eigentliche Grenze.

Ein Client startet den Server mit dem Eintrag, den der Betreiber einmal geschrieben hat. Ändert eine neue Version die Voreinstellung, bietet derselbe Eintrag nach einem Update mehr an, ohne dass der Betreiber etwas geändert hat.

## Optionen

1. **Leer, wie bisher:** nur `ct_whoami`. Jedes Toolset schaltet der Betreiber ausdrücklich ein.
2. **`docs` voreingestellt:** Das Toolset berührt weder ChurchTools noch Daten einer Gemeinde. Seine sechs Tools kosten aber Platz im Budget der Beschreibungen, und ein vorhandener Eintrag böte nach dem Update sechs Tools mehr an.
3. **Alles ausser `persons`, `events` und `api`:** Kalender, Wiki, Songs und Dokumentation ohne Einstellung. Bequem, aber der KI-Assistent sähe nach einem Update Termine und Seiten des Wikis, die der Betreiber nie freigegeben hat, und Seiten des Wikis tragen Freitext, auch mit Namen von Personen.

## Entscheid

Gewählt ist die erste Option. Die Voreinstellung von `ECCLIUM_TOOLSETS` bleibt auch ab Phase 4 leer: Ohne Angabe bietet der Server nur `ct_whoami` an. Ein leerer Wert bleibt gültig und heisst dasselbe.

- **Standard ist restriktiv:** Was der KI-Assistent sieht, entscheidet der Betreiber mit einem Namen je Bereich, nicht eine Version von Ecclium.
- **Ein Update schaltet nichts ein:** Wer neue Tools will, nennt ihr Toolset oder `all`.
- **`docs` wie die anderen:** Auch ein Toolset ohne Daten der Gemeinde kommt nur auf ausdrücklichen Wunsch, damit die Regel ohne Ausnahme bleibt. Es einzuschalten kostet ein Wort.

Dieses ADR ergänzt ADR 0062. Dort ersetzt es unter «Voreinstellung» den Satz «Das gilt bis Phase 4, dann entscheidet ein eigenes ADR über eine andere Voreinstellung.» Alles andere aus ADR 0062 bleibt.

## Konsequenzen

- Eine neue Installation bietet ohne Einstellung nur `ct_whoami` an. Die Beispielkonfigurationen und `.env.example` zeigen weiter `ECCLIUM_TOOLSETS=` leer, und die Doku sagt, wie ein Betreiber Toolsets einschaltet.
- Wer die Doku-Tools will, nennt `docs`, auch wenn sie keine Daten der Gemeinde lesen.
- Eine andere Voreinstellung braucht ein neues ADR, das dieses ablöst.

## Umsetzung

Nichts zu bauen. Der Katalog behandelt eine leere Liste seit dem 24.10.2026 so, gezeigt in `packages/core/src/registry/registry.test.ts`, und `docs/configuration.md` nennt «leer» als Voreinstellung (ADR 0062, Umsetzung).
