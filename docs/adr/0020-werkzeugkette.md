# ADR 0020: Werkzeugkette: pnpm 11, TypeScript 6, Vitest 5, Renovate

- Status: Vorgeschlagen
- Datum: 26.09.2026
- Fällt vor: Phase 0

## Kontext

Ecclium ist ein Monorepo in TypeScript, das eine Person pflegt und Fremde lesen, prüfen und erweitern sollen. Die Werkzeuge müssen auf jedem Rechner und in CI gleich laufen, sich mit wenig Aufwand aktuell halten lassen und selbst möglichst wenig Angriffsfläche bieten. Jedes Werkzeug ist eine Abhängigkeit, die ein Angreifer übernehmen könnte (ADR 0021).

Festzulegen sind Paketmanager, Compiler, Tests, Lint und Formatierung, die Quelle der Werkzeuge ausserhalb von npm, die Form der Hilfsskripte und der Weg der Aktualisierungen.

## Optionen

1. **npm-Workspaces mit den Standardwerkzeugen:** keine zusätzliche Installation, aber npm kennt kein Mindestalter für neue Versionen und kein Verbot von Install-Skripten pro Paket.
2. **Eine Laufzeit mit eingebauten Werkzeugen, etwa Bun oder Deno:** wenige Teile, aber eine zweite Laufzeit neben Node.js, auf dem Ecclium läuft, und weniger Kontrolle über die einzelnen Prüfungen.
3. **pnpm, TypeScript, Vitest, ESLint und Prettier, gepinnt über mise:** verbreitete Werkzeuge mit eigenen Schutzeinstellungen, einzeln austauschbar.

## Entscheid

Gewählt ist die dritte Option.

- **mise** liefert Node.js und alle Werkzeuge, die nicht aus npm kommen: pnpm, gitleaks, lefthook, actionlint, zizmor und shellcheck. `mise.toml` pinnt jede Version exakt, `mise.lock` hält Download-Adresse und Prüfsumme pro Plattform fest, installiert wird im Locked-Modus. `mise.compat.toml` pinnt die nächste Node-Linie für die Prüfung der Kompatibilität (ADR 0019).
- **pnpm 11** ist der Paketmanager, gepinnt in `packageManager` mit dem Hash der Version. pnpm 12 erschien am 26.08.2026 als Neuschreibung mit eigenen Binärdateien pro Plattform und wird vor dem ersten Release neu bewertet.
- **TypeScript 6.0** mit Projektreferenzen und `tsc -b` für Build und Typprüfung. TypeScript 7 ist eine Neuimplementierung in Go und wird von typescript-eslint noch nicht unterstützt (Peer-Bereich `<6.1.0` in Version 8.70.1). Die Konfiguration nutzt keine Option, die TypeScript 6.0 als veraltet markiert, damit der Wechsel später ohne Umbau gelingt.
- **Vitest 5** mit Abdeckung über V8 für alle Tests. Tests laufen aus dem Quelltext, nicht aus dem Build (ADR 0022).
- **ESLint 10** mit typescript-eslint in der strengen, typbasierten Einstellung und eslint-plugin-jsdoc. Jeder Export braucht einen Dokumentationskommentar mit Zweck, Parametern, Ergebnis und Fehlerfällen, exportierte Funktionen und Klassen der Pakete zusätzlich ein Beispiel. Im Code der Pakete ist direkte Ausgabe über `console`, `process.stdout` und `process.stderr` verboten, weil stdout im Betrieb über stdio dem MCP-Protokoll gehört.
- **Prettier 3** formatiert Code, Konfiguration und Dokumentation. `brand/`, das Lockfile und der Lizenztext bleiben unverändert.
- **lefthook 2** richtet die Git-Hooks ein: gitleaks für jeden Commit und jede Commit-Message, Prettier für die gestagten Dateien.
- **Hilfsskripte** liegen als `.mts` unter `scripts/` und laufen ohne Build direkt in Node.js, das die Typen entfernt. Sie nutzen nur, was Node.js mitbringt.
- **`pnpm check`** ist der eine Befehl für alle lokalen Prüfungen: Formatierung, Typen, Lint, Tests, Lizenzen, Schutzeinstellungen von pnpm und Links in der Dokumentation. CI ruft dieselben Befehle auf.
- **Renovate** schlägt Aktualisierungen vor, unter den Regeln von ADR 0021.
- Weitere Werkzeuge kommen, wenn sie gebraucht werden: dependency-cruiser 18 für die Architekturregeln und ein Bundler für das Produktpaket.

## Konsequenzen

- Wer mitarbeitet, braucht nur mise. Alles andere kommt in einer festen, geprüften Version.
- TypeScript 7 und pnpm 12 warten, bis ihre Umgebung sie trägt. Das kostet Geschwindigkeit, schützt aber vor einem Wechsel auf eine junge Neuschreibung.
- Typbasiertes Lint ist langsamer als Lint ohne Typen. Bei der Grösse des Projekts fällt das nicht ins Gewicht.
- Die Pflicht zur Dokumentation kostet beim Schreiben Zeit. Das ist gewollt, weil Fremde den Code lesen.
- Hilfsskripte dürfen nur Syntax nutzen, die sich durch Entfernen der Typen in JavaScript verwandelt. Für die Pakete gilt dieselbe Regel (`erasableSyntaxOnly`), es gibt also keine zweite Art, TypeScript zu schreiben.

## Umsetzung

- Werkzeuge: `mise.toml`, `mise.lock`, `mise.compat.toml`, `mise.compat.lock`.
- Paketmanager: `packageManager` in `package.json`, Schutzeinstellungen in `pnpm-workspace.yaml` (ADR 0021).
- Compiler: `tsconfig.base.json`, `tsconfig.build.json`, `tsconfig.json` und je Paket `tsconfig.json` und `tsconfig.test.json` (ADR 0022).
- Tests: `vitest.config.mts`. Lint: `eslint.config.mjs`. Formatierung: `.prettierrc.json`, `.prettierignore`. Hooks: `lefthook.yml`.
- Prüfungen: Skripte unter `scripts/`, zusammengefasst in `pnpm check`. `tests/toolchain.test.mts` prüft, dass die Versionen von Node.js und pnpm in allen Dateien übereinstimmen und jede Abhängigkeit genau gepinnt ist.
- Renovate und die Prüfungen in CI folgen mit der Werkbank in Phase 0.
