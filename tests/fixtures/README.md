# Testdaten

Alle Testdaten in diesem Repository sind erfunden. Sie stammen aus keiner echten ChurchTools-Instanz, keiner Gemeinde und keiner Person.

- **Platzhalter:** `https://example.church.tools`, `demo-tenant`, `person-id-1`, `max.mustermann@example.org`, `10.0.0.0/8` und die weiteren Platzhalter am Anfang von `.gitleaks.toml`.
- **Kanarienwerte:** Tests, die zeigen sollen, dass ein Wert nirgends erscheint, erzeugen ihn zur Laufzeit, teils zufällig. So besteht kein Test nur deshalb, weil ein fester Wert zufällig nicht vorkommt.
- **Synthetisches OpenAPI-Dokument:** Die Proben für den API-Spike werden gegen ein kleines, erfundenes OpenAPI-Dokument getestet, `tests/spike/support.mts`. Es enthält nur die Pfade, die die Proben benutzen, und belegt nichts über die echte API. Was die echte API liefert, klärt der Spike selbst.
- **Netzsperre:** `tests/fixtures/network/` enthält ein Skript und Tests, die absichtlich Verbindungen versuchen. Ziele sind nur Namen und Adressen für Dokumentation, `example.org`, `192.0.2.1` und `2001:db8::1` (RFC 2606, RFC 5737, RFC 3849), dazu Formen von Loopback, die die Sperre zulassen oder abweisen muss, etwa `127.0.0.1`, `::1`, `127.0.0.2` und `localhost`, und ein erfundener Pfad eines lokalen Sockets mit einem Kanarienwert. Die Dateien liegen ausserhalb des include-Musters von Vitest. Nur `tests/support/no-network.test.mts` startet sie, jeweils in einem eigenen Prozess.
- **Beispiele für die Architekturregeln:** Die Tests unter `tests/architecture/` kopieren die Quellen der Pakete in einen temporären Ordner und fügen dort kurze, erfundene Dateien hinzu, die je eine Regel verletzen, oder ändern eine Kopie von `package.json` und `tsconfig.json`. Die Beispiele stehen im Code der Tests, der temporäre Ordner wird danach gelöscht. Nichts davon landet im Repository.

Wer neue Testdaten anlegt, erfindet sie ebenso und benutzt die Platzhalter. Echte Antworten einer Instanz gehören nicht ins Repository, auch nicht gekürzt oder verfremdet.
