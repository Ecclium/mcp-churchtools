# ADR 0019: Node-Linie: 24 LTS, Images auf 26, Wechselregel im Oktober

- Status: Vorgeschlagen
- Datum: 25.09.2026
- Fällt vor: Phase 0

## Kontext

Ecclium läuft auf Node.js. Festzulegen ist, welche Versionen unterstützt werden, mit welcher entwickelt und geprüft wird, auf welcher die Container-Images laufen und wann sich das ändert. Gemeinden betreiben Ecclium selbst, oft ohne eigene Entwicklerinnen und Entwickler. Jede unterstützte Version muss deshalb noch Sicherheitskorrekturen erhalten, und ein Wechsel muss planbar sein.

Der Zeitplan des Node.js-Projekts (Datei `schedule.json` im Repository `nodejs/Release`, Stand 25.09.2026) nennt:

| Linie      | LTS ab     | Wartung ab | Ende       |
| ---------- | ---------- | ---------- | ---------- |
| Node.js 22 | 29.10.2024 | 21.10.2025 | 30.04.2027 |
| Node.js 24 | 28.10.2025 | 20.10.2026 | 30.04.2028 |
| Node.js 26 | 28.10.2026 | 20.10.2027 | 30.04.2029 |

Ab Node.js 27 erscheint nur noch eine Hauptversion pro Jahr, im April, und jede wird im Oktober zur LTS-Version. Die Unterscheidung zwischen geraden und ungeraden Linien entfällt (Ankündigung «Evolving the Node.js Release Schedule» vom 10.03.2026).

Für Ecclium zählen ausserdem einzelne Fähigkeiten, belegt in den Release Notes der jeweiligen Version:

- Type Stripping, also das Ausführen von TypeScript-Dateien ohne Build, gilt ab Node.js 24.12.0 als stabil. Die Hilfsskripte des Projekts sollen so laufen.
- `require(esm)`, das Laden von ES-Modulen aus CommonJS, gilt ab Node.js 24.15.0 als stabil.
- Das Permission Model von Node.js kennt ab Node.js 25.0.0 die Option `--allow-net`. Unter Node.js 24 lässt sich der Netzzugriff damit nicht einschränken.
- Das Permission Model erhält laufend Sicherheitskorrekturen, in der Linie 24 etwa mit 24.13.0 und 24.17.0.

## Optionen

1. **Nur Node.js 26:** die neueste Linie mit `--allow-net`, aber bis zum 28.10.2026 keine LTS-Version, und auf vielen Systemen noch nicht verfügbar.
2. **Node.js 22 und neuer:** der grösste Kreis von Systemen, aber Node.js 22 endet am 30.04.2027, voraussichtlich vor einer ersten stabilen Version von Ecclium, und Type Stripping ist dort nicht stabil.
3. **Node.js 24 ab 24.15 und Node.js 26:** die laufende LTS-Linie als Grundlage, die nächste Linie von Anfang an mitgeprüft.

## Entscheid

- Unterstützt sind Node.js 24 ab 24.15 sowie Node.js 26 und neuer. Node.js 22 und 25 werden nicht unterstützt. 24.15 ist die erste Version, in der Type Stripping und `require(esm)` als stabil gelten.
- Entwickelt wird mit der neuesten Version von Node.js 24, heute 24.21.0. So gelangt keine Schnittstelle, die es erst in einer neueren Linie gibt, unbemerkt in den Code. CI prüft zusätzlich mit der nächsten Linie, heute Node.js 26.10.0.
- Die Container-Images laufen auf Node.js 26, sobald diese Linie LTS ist, also ab dem 28.10.2026. Nur dort begrenzt das Permission Model auch den Netzzugriff.
- TypeScript übersetzt nach ES2025, weil Node.js ab 24.15 den ganzen Sprachstand ES2025 ausführt. Typen für Browser (DOM) sind nicht eingebunden, weil kein Teil von Ecclium im Browser läuft.
- Die Typen für Node.js (`@types/node`) folgen der Linie 24, der ältesten unterstützten.
- **Wechselregel:** Jedes Jahr im Oktober, wenn eine neue Linie LTS wird, wechseln die Container-Images auf diese Linie, und CI prüft ab dann die nächste mit. Wann die älteste unterstützte Linie wegfällt, entscheidet ein neues ADR, spätestens vor ihrem Ende.

## Konsequenzen

- Wer Ecclium ohne Container betreibt, braucht Node.js 24.15 oder neuer. Die Mindestversion ist eine Grenze der Kompatibilität, keine Empfehlung. Betreiben Sie die neueste Version Ihrer Linie, denn Sicherheitskorrekturen erscheinen laufend, auch für das Permission Model.
- CI prüft die neueste Version von Node.js 24 und die nächste Linie, nicht die Mindestversion selbst. Nutzt der Code eine Schnittstelle, die erst nach 24.15 in Node.js 24 dazukam, fällt das nicht von selbst auf.
- Ab dem 28.10.2026 laufen Container und Betrieb ohne Container auf verschiedenen Linien. CI prüft deshalb beide.
- Node.js 24 geht am 20.10.2026 in die Wartung und endet am 30.04.2028. Bis dahin braucht es den Entscheid, die Linie aufzugeben.
- Ein Wechsel der Linie ist kein Routine-Update. Automatische Aktualisierungen heben die Hauptversion von Node.js nicht an.

## Umsetzung

- `mise.toml` pinnt Node.js 24.21.0 für Entwicklung und CI, `mise.compat.toml` pinnt Node.js 26.10.0 für die Prüfung mit der nächsten Linie. `.nvmrc` nennt 24.21.0 für nvm und fnm.
- `engines.node` im Wurzel-`package.json`: `^24.15.0 || >=26.0.0`.
- `tsconfig.base.json`: `target` und `lib` auf `es2025`, ohne DOM. `@types/node` in Version 24.
- Die Prüfung mit Node.js 26 in CI und die Regel, die automatische Aktualisierungen der Hauptversion verhindert, folgen mit der Werkbank in Phase 0. Die Container-Images folgen in Phase 7.
