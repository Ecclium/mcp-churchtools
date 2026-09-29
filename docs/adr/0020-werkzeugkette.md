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
- **ESLint 10** mit typescript-eslint in der strengen, typbasierten Einstellung und eslint-plugin-jsdoc. Jeder Export braucht einen Dokumentationskommentar mit Zweck, Parametern, Ergebnis und Fehlerfällen, exportierte Funktionen und Klassen der Pakete zusätzlich ein Beispiel. Im Code der Pakete ist `console` verboten, weil stdout im Betrieb über stdio dem MCP-Protokoll gehört. Auf stdout und stderr schreiben nur die Orte, die ADR 0018 nennt: der Logger und die Meldungen der Kommandozeile für Betreiber.
- **Prettier 3** formatiert Code, Konfiguration und Dokumentation. `brand/`, das Lockfile und der Lizenztext bleiben unverändert.
- **lefthook 2** richtet die Git-Hooks ein: gitleaks für jeden Commit und jede Commit-Message, Prettier für die gestagten Dateien und die Prüfung des Sign-offs.
- **Hilfsskripte** liegen als `.mts` unter `scripts/` und laufen ohne Build direkt in Node.js, das die Typen entfernt. Sie nutzen nur, was Node.js mitbringt.
- **dependency-cruiser 18** prüft die Architekturregeln, also jeden Import in den Paketen gegen die Grenzen aus ADR 0022, ADR 0018 und ADR 0024. Es liest TypeScript mit dem installierten Compiler und unterstützt TypeScript 7 noch nicht.
- **`pnpm check`** ist der eine Befehl für alle lokalen Prüfungen: Formatierung, Typen, Lint, Architekturregeln, Lizenzen, Schutzeinstellungen von pnpm, Links in der Dokumentation und zuletzt die Tests, die als erster Schritt Code aus einem Pull Request ausführen. CI ruft dieselben Befehle auf. `pnpm ci:local` führt zusätzlich die Prüfung der Workflows ohne Netz, den Scan der Geschichte und der Dateinamen sowie `pnpm check` auf allen drei Versionen von Node.js aus.
- **GitHub Actions** führt CI aus. Jeder Job, der Werkzeuge braucht, installiert sie mit mise aus denselben Dateien wie ein Entwicklungsrechner. Die Version von mise selbst ist in den Workflows gepinnt, weil eine neuere Version Lockdateien in einem Format schreiben kann, das eine ältere nicht liest.
- **Renovate** schlägt Aktualisierungen vor, unter den Regeln von ADR 0021. Dieselbe Version von mise, die CI benutzt, aktualisiert die Lockdateien.
- Ein Bundler für das Produktpaket kommt, wenn er gebraucht wird.

## Konsequenzen

- Wer mitarbeitet, braucht nur mise. Alles andere kommt in einer festen, geprüften Version.
- TypeScript 7 und pnpm 12 warten, bis ihre Umgebung sie trägt. Das kostet Geschwindigkeit, schützt aber vor einem Wechsel auf eine junge Neuschreibung. Für TypeScript 7 müssen neben typescript-eslint auch dependency-cruiser und die Tests der Architektur, die die Programmier-API von TypeScript benutzen, bereit sein. Ohne einen Compiler, den es lesen kann, findet dependency-cruiser keine Module und meldet trotzdem Erfolg. Die Tests der Architekturregeln prüfen deshalb, dass es Module findet.
- Dass die Konfiguration keine veraltete Option nutzt, prüft ein Test über alle tsconfig-Dateien. `tsc -b` allein genügt nicht, weil es die Optionen der Dateien, die nur auf andere Projekte verweisen, nicht prüft.
- Typbasiertes Lint ist langsamer als Lint ohne Typen. Bei der Grösse des Projekts fällt das nicht ins Gewicht.
- Die Pflicht zur Dokumentation kostet beim Schreiben Zeit. Das ist gewollt, weil Fremde den Code lesen.
- Hilfsskripte dürfen nur Syntax nutzen, die sich durch Entfernen der Typen in JavaScript verwandelt. Für die Pakete gilt dieselbe Regel (`erasableSyntaxOnly`), es gibt also keine zweite Art, TypeScript zu schreiben.

## Umsetzung

- Werkzeuge: `mise.toml`, `mise.lock`, `mise.compat.toml`, `mise.compat.lock`, `mise.minimum.toml`, `mise.minimum.lock`.
- Paketmanager: `packageManager` in `package.json`, Schutzeinstellungen in `pnpm-workspace.yaml` (ADR 0021).
- Compiler: `tsconfig.base.json`, `tsconfig.build.json`, `tsconfig.json` und je Paket `tsconfig.json` und `tsconfig.test.json` (ADR 0022).
- Tests: `vitest.config.mts`. Lint: `eslint.config.mjs`. Formatierung: `.prettierrc.json`, `.prettierignore`. Hooks: `lefthook.yml`.
- Architekturregeln: `.dependency-cruiser.mjs`, geprüft mit `pnpm check:arch`, und die Tests unter `tests/architecture/`, darunter `tsconfig-options.test.mts` für die veralteten Optionen.
- Prüfungen: Skripte unter `scripts/`, zusammengefasst in `pnpm check`, und `scripts/ci/` für die Prüfungen der Pull Requests. `tests/toolchain.test.mts` prüft, dass die Versionen von Node.js, pnpm und mise in allen Dateien übereinstimmen, dass jede Lockdatei von mise im Format liegt, das die gepinnte Version liest, und dass jede Abhängigkeit genau gepinnt ist.
- CI: `.github/workflows/ci.yml`, `.github/workflows/pr-meta.yml` und `.github/workflows/scorecard.yml` (ADR 0021). `pnpm ci:local` führt die Prüfungen aus `ci.yml` lokal aus, soweit sie ohne GitHub möglich sind.
- Renovate: `.github/renovate.json5`.
