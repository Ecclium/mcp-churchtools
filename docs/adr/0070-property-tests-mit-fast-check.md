# ADR 0070: Bibliothek für Property-Tests: fast-check als Entwicklungsabhängigkeit

- Status: Vorgeschlagen am 31.10.2026
- Datum: 31.10.2026
- Fällt vor: Phase 4

## Kontext

Die Maskierung soll für jedes personenbezogene Feld jedes Tools in jeder Stufe belegt sein, auch für Varianten eines Werts, die nach NFKC und ohne unsichtbare Zeichen gleich sind ([ADR 0026](0026-klassifizierte-ausgabeschemas.md), [ADR 0069](0069-stufe-strict.md)). Tests mit Beispielen prüfen die Werte, die jemand ausgewählt hat. Property-Tests erzeugen viele Eingaben nach einer Regel und prüfen eine Eigenschaft, die für jede gelten muss.

Dazu kommen diese Fakten:

- Seit Phase 3 prüft `packages/core/src/churchtools/operation-fuzz.test.ts` die Pfadparameter des generischen Lesezugriffs mit einem eigenen Generator mit festem Startwert, ohne Abhängigkeit ([ADR 0067](0067-generischer-lesezugriff.md)). Er kennt keine Unicode-Varianten und verkleinert einen Fehlerfall nicht.
- fast-check 4.10.2 vom 19.09.2026 ist die neueste Version, steht unter MIT und hat eine einzige Abhängigkeit, `pure-rand` (`^8.0.0`, aufgelöst 8.4.2 vom 10.07.2026, MIT, ohne Abhängigkeiten). Beide sind mit Herkunftsnachweis über einen vertrauenswürdigen Herausgeber veröffentlicht, ebenso die Versionen davor (geprüft am 31.10.2026 an der Registry). Keines der beiden stand vorher im Lockfile.
- Jede neue Abhängigkeit braucht einen Grund, und pnpm installiert nur Versionen, die mindestens drei Tage alt sind und keinen schwächeren Herkunftsnachweis haben als frühere ([ADR 0021](0021-supply-chain-baseline.md), abgelöst durch [ADR 0050](0050-token-der-mise-action.md), das diese Regeln übernimmt).
- Code der Pakete importiert nur npm-Pakete, die sein eigenes Manifest für die Laufzeit nennt. Tests sind ausgenommen, sie nutzen die Werkzeuge der Wurzel ([ADR 0022](0022-paketzuschnitt.md)).

## Optionen

1. **fast-check 4.10.2 als Entwicklungsabhängigkeit der Wurzel:** verkleinert einen Fehlerfall von selbst, erzeugt Unicode, kombiniert Generatoren und nennt Startwert und Pfad eines Fehlschlags.
2. **Den eigenen Generator aus Phase 3 ausbauen:** keine Abhängigkeit, aber Unicode-Varianten, das Verkleinern und das Kombinieren müssten wir selbst bauen und selbst prüfen.
3. **fast-check zusätzlich als Abhängigkeit von testkit**, damit testkit Generatoren für alle Tests anbietet: bequem, aber fast-check stünde dann im Manifest eines Pakets, und Renovate sähe es einmal als Werkzeug und einmal als Abhängigkeit.

## Entscheid

Gewählt ist Option 1.

- fast-check steht genau gepinnt als `4.10.2` in den `devDependencies` der Wurzel, wie die anderen Werkzeuge dort. Nur Testdateien importieren es. In kein Paket kommt es, also auch nicht ins Produktpaket.
- Was die Tests teilen, liegt in testkit als gewöhnliche Funktionen ohne fast-check: Kanarienwerte und ihre Varianten, gesteuert über Zahlen, die der Test von fast-check bekommt. So verkleinert fast-check auch die Wahl der Variante, und testkit bleibt ohne neue Abhängigkeit.
- **Fester Startwert** je Eigenschaft, wie beim Generator aus Phase 3, damit ein Lauf in CI wiederholbar ist und eine fremde Änderung nicht zufällig rot wird. Ein Fehlschlag nennt Startwert und Pfad. Mit beiden lässt er sich lokal nachstellen. Die Zahl der Fälle ist begrenzt, und jeder Test hat eine eigene Frist, damit auch der Lauf unter der Messung der Abdeckung in seiner Frist bleibt.
- **Varianten** erzeugen die Tests so, wie die Masken es versprechen: Vollbreite und andere Kompatibilitätsformen, die NFKC auf ASCII faltet, und unsichtbare Zeichen an beliebiger Stelle. Buchstaben anderer Schriften, die nur gleich aussehen, und Ziffern anderer Schriften faltet NFKC nicht. Die Prüfung von Freitext erkennt sie nicht, und ein eigener Test hält diese Grenze fest. In Feldern mit einer Klasse maskiert die Pipeline unabhängig von den Zeichen, dort erzeugen die Tests auch andere Schriften.
- **Das Orakel** ist die Tabelle in ADR 0026: je Klasse und Stufe, was mit einem Wert geschieht. In `off` muss ein Kanarienwert unverändert im Ergebnis stehen, damit ein Test zeigt, dass er überhaupt etwas sieht.
- Renovate mergt Patch und Minor von fast-check selbst, wie die übrigen Werkzeuge der Positivliste in `.github/renovate.json5`, nach der Prüfung oben. Eine neue Version von `pure-rand` prüft `lockfile-provenance` wie jede neue Version im Lockfile.
- Der Generator aus Phase 3 bleibt, wie er ist.

## Konsequenzen

- Eine Eigenschaft gilt für viele Eingaben statt für wenige, und ein Fehlschlag kommt verkleinert, mit Startwert und Pfad.
- Zwei Pakete mehr laufen in Tests, also auf dem Rechner der Entwicklung und in CI, nie im Betrieb. Dagegen stehen das Mindestalter, die Vertrauensrichtlinie von pnpm und `lockfile-provenance`.
- Mit festem Startwert prüft jeder Lauf dieselben Fälle. Neue Fälle kommen nur, wenn sich ein Test oder sein Startwert ändert. Das nehmen wir für wiederholbare Läufe in Kauf.
- Property-Tests für die Richtlinie und die ContentPolicy kommen mit deren Bau in Phase 5 und 6 dazu.

## Umsetzung

Folgt mit den Tests.
