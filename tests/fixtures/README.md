# Testdaten

Alle Testdaten in diesem Repository sind erfunden. Sie stammen aus keiner echten ChurchTools-Instanz, keiner Gemeinde und keiner Person.

- **Platzhalter:** `https://example.church.tools`, `demo-tenant`, `person-id-1`, `max.mustermann@example.org`, `10.0.0.0/8` und die weiteren Platzhalter am Anfang von `.gitleaks.toml`.
- **Kanarienwerte:** Tests, die zeigen sollen, dass ein Wert nirgends erscheint, erzeugen ihn zur Laufzeit, teils zufällig. So besteht kein Test nur deshalb, weil ein fester Wert zufällig nicht vorkommt.
- **Synthetisches OpenAPI-Dokument:** Die Proben für den API-Spike werden gegen ein kleines, erfundenes OpenAPI-Dokument getestet, `tests/spike/support.mts`. Es enthält nur die Pfade, die die Proben benutzen, und belegt nichts über die echte API. Was die echte API liefert, klärt der Spike selbst.

Wer neue Testdaten anlegt, erfindet sie ebenso und benutzt die Platzhalter. Echte Antworten einer Instanz gehören nicht ins Repository, auch nicht gekürzt oder verfremdet.
