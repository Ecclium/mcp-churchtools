# ADR 0022: Paketzuschnitt, zwei npm-Pakete, Bündelung ausser `zod` und `plugin-api`

- Status: Vorgeschlagen
- Datum: 25.09.2026
- Fällt vor: Phase 0

## Kontext

Ecclium besteht aus Teilen mit unterschiedlicher Aufgabe und unterschiedlichem Vertrauen: dem Kern mit ChurchTools-Client, Maskierung, Absicherung der Schreibvorgänge und Protokoll, den Tools, der Schicht für Rezepte, dem Runner, dem MCP-Server, der Kommandozeile und den Testhilfen. Dazu kommt eine Schnittstelle, gegen die Erweiterungen gebaut werden, auch ein kostenpflichtiges Zusatzmodul und Erweiterungen Dritter.

Zu entscheiden ist, wie der Code in Pakete geschnitten wird, welche Importe zwischen ihnen erlaubt sind und wie das durchgesetzt wird, welche Pakete veröffentlicht werden und in welcher Form, und wie die Pakete einander im Workspace finden.

Dabei gelten diese Bedingungen:

- Eine Erweiterung bringt ihre eigene Kopie der Schnittstelle mit. Gibt es im selben Prozess zwei Kopien, versagen `instanceof`, Markierungen und Register über die Grenze hinweg, sobald sie an eine der Kopien gebunden sind.
- Wer Ecclium mit `npx` startet, soll genau den geprüften Code erhalten, nicht frisch aufgelöste Abhängigkeiten.
- Jede einzelne Ebene der Durchsetzung lässt sich umgehen. Wer nur `exports` prüft, übersieht relative Pfade über Paketgrenzen hinweg. Wer nur Typen prüft, übersieht Importe zur Laufzeit.
- Prüfungen dürfen nicht von einem früheren Build abhängen, sonst prüfen sie womöglich einen veralteten Stand.

## Optionen

Zum Zuschnitt:

1. **Ein einziges Paket:** einfach, aber ohne prüfbare Grenzen, und die Schnittstelle für Erweiterungen lässt sich nicht getrennt versionieren.
2. **Jedes Paket auf npm:** klare Grenzen, aber jede interne Schnittstelle wird zum öffentlichen Vertrag, jede Installation löst viele Abhängigkeiten frisch auf, und jedes Release betrifft alle Pakete.
3. **Workspace mit mehreren Paketen, davon zwei veröffentlicht:** Die Grenzen sind im Workspace prüfbar, öffentlich sind nur das Produktpaket und die Schnittstelle für Erweiterungen.

Zur Auflösung im Workspace:

1. **Nur über das Ergebnis des Builds in `dist/`:** Prüfungen hängen vom letzten Build ab.
2. **Pfadabbildungen in TypeScript (`paths`, `baseUrl`) und eigene Aliasse in Vitest:** zwei Mechanismen, die auseinanderlaufen können. `baseUrl` ist ab TypeScript 6.0 veraltet und funktioniert in TypeScript 7.0 nicht mehr (Meldung TS5101 von TypeScript 6.0.3).
3. **Eigene Export-Bedingung:** `exports` nennt zuerst die TypeScript-Quelle unter einer eigenen Bedingung. TypeScript, Vitest und die Prüfung der Architektur lösen darüber auf, veröffentlichte Pakete lassen die Bedingung weg.

## Entscheid

Gewählt ist jeweils die dritte Option.

**Pakete.** Der Workspace hat neun Pakete unter `packages/`:

| Verzeichnis | Paketname | Inhalt |
|---|---|---|
| `plugin-api` | `@ecclium/mcp-churchtools-plugin-api` | Vertrag zwischen Kern und Erweiterungen |
| `core` | `@ecclium/mcp-churchtools-core` | Konfiguration, Mandantenkontext, ChurchTools-Client, einziger Weg für ausgehende Verbindungen, Tool-Pipeline, Maskierung, Absicherung der Schreibvorgänge, Richtlinien, Protokoll |
| `docs-index` | `@ecclium/mcp-churchtools-docs-index` | Index mit Fakten aus der ChurchTools-Dokumentation |
| `tools` | `@ecclium/mcp-churchtools-tools` | Domänen-Tools, MCP-Prompts, generische API-Tools |
| `workflows` | `@ecclium/mcp-churchtools-workflows` | Rezepte, Richtlinien, Rezept-Engine, Anbindung von Sprachmodellen |
| `runner` | `@ecclium/mcp-churchtools-runner` | Läufe nach Zeitplan, Freigabe, Rücknahme |
| `server` | `@ecclium/mcp-churchtools-server` | MCP-Server über stdio und HTTP |
| `cli` | `@ecclium/mcp-churchtools` | Zusammensetzung aller Teile und der Befehl `ecclium` |
| `testkit` | `@ecclium/mcp-churchtools-testkit` | Testhilfen, nur für Tests |

**Veröffentlichung.** Veröffentlicht werden genau zwei Pakete: das Produktpaket `@ecclium/mcp-churchtools` mit dem Befehl `ecclium` und die Schnittstelle `@ecclium/mcp-churchtools-plugin-api` mit eigener, streng semantischer Version. Die übrigen sieben bleiben privat im Workspace. Bis zur ersten Veröffentlichung sind alle neun als `private` markiert, damit keines versehentlich auf npm gelangt.

**Bündelung.** Das Produktpaket wird gebündelt, ausser `zod` und der Schnittstelle für Erweiterungen. Erweiterungen bringen beide selbst mit, und lägen sie zusätzlich im Bündel, gäbe es zwei Kopien. Deshalb hält die Schnittstelle keinen Zustand auf Modulebene, Markierungen laufen über `Symbol.for('ecclium.mcp-churchtools.*.v1')`, und Klassifikationen stehen im globalen Register von zod. Die Exporte der Schnittstelle tragen ausdrückliche Typen (`isolatedDeclarations`), damit die veröffentlichte Schnittstelle im Quelltext sichtbar ist und sich nicht über abgeleitete Typen ändert.

**Importe.** Erlaubt sind:

| Paket | darf importieren |
|---|---|
| `plugin-api` | kein anderes Paket, `zod` nur als Peer-Abhängigkeit |
| `core`, `docs-index` | `plugin-api` |
| `tools` | `core`, `plugin-api`, `docs-index` |
| `workflows` | `core`, `plugin-api` |
| `runner` | `core`, `workflows`, `plugin-api` |
| `server` | `core`, `plugin-api` |
| `cli` | alle, `testkit` nur in Tests |
| `testkit` | alle |

`testkit` ist für alle anderen Pakete nur eine devDependency und wird nie ausgeliefert.

**Durchsetzung auf drei Ebenen**, weil jede allein umgehbar ist:

1. **Paketdefinition:** Jedes Paket nennt in `package.json` genau die Pakete, die es importieren darf, als Abhängigkeit `workspace:*`, `testkit` nur als devDependency. pnpm macht nur deklarierte Abhängigkeiten auflösbar, und `exports` gibt nur den Einstiegspunkt frei.
2. **Projektreferenzen von TypeScript:** Das Build-Projekt eines Pakets referenziert genau seine Abhängigkeiten. `tsc -b` baut in dieser Reihenfolge und lehnt Zyklen ab.
3. **dependency-cruiser in CI:** prüft jeden Import gegen dieselbe Tabelle, auch relative Pfade über Paketgrenzen.

**Quelle statt Build.** `exports` nennt zuerst `"@ecclium/source": "./src/index.ts"`, danach `types` und `default` für das Ergebnis des Builds in `dist/`. TypeScript (`customConditions`) und Vitest lösen Workspace-Pakete unter dieser Bedingung auf und prüfen so immer den aktuellen Quelltext. Die beiden veröffentlichten Pakete lassen die Bedingung über `publishConfig.exports` weg.

**Zwei TypeScript-Projekte pro Paket.** `tsconfig.json` baut den Quelltext in `src/` ohne die Tests. `tsconfig.test.json` prüft die Tests ohne Ausgabe und referenziert das eigene Build-Projekt und `testkit`. So darf `testkit` alle Pakete importieren, ohne dass Projektreferenzen einen Zyklus bilden. Im Wurzelordner baut `tsconfig.build.json` alle Pakete. `tsconfig.json` umfasst zusätzlich alle Testprojekte und dient der Typprüfung und den Editoren.

**Wurzelordner.** Das `package.json` im Wurzelordner hat kein Feld `type`, weil `brand/` ein Hilfsskript in CommonJS enthält, das ein `"type": "module"` im Wurzelordner brechen würde. TypeScript-Dateien ausserhalb von `packages/` enden deshalb auf `.mts`, Konfigurationsdateien in JavaScript auf `.mjs`. Die Pakete setzen `"type": "module"` selbst.

## Konsequenzen

- Interne Schnittstellen zwischen den Paketen dürfen sich frei ändern. Öffentlicher Vertrag sind nur die beiden veröffentlichten Pakete.
- Jeder neue Import zwischen Paketen braucht eine Abhängigkeit in `package.json` und eine Projektreferenz. Neue Abhängigkeiten zwischen Paketen sind so im Review sichtbar.
- In einem Bündel sehen Scanner die enthaltenen Abhängigkeiten nicht. Stückliste (SBOM) und Hinweise auf Software Dritter entstehen deshalb aus dem Lockfile, und eine Prüfung muss sicherstellen, dass das Produktpaket keine weiteren Laufzeitabhängigkeiten nennt.
- Weil jedes Paket `testkit` in den Tests nutzt und `testkit` alle Pakete importieren darf, gibt es Zyklen über devDependencies. Sie sind gewollt. pnpm warnt deshalb im ganzen Workspace nicht mehr vor Zyklen (`ignoreWorkspaceCycles`). Zyklen zwischen Laufzeitabhängigkeiten finden weiterhin `tsc -b` und dependency-cruiser.
- Die Testprojekte prüfen keine Deklarationsdateien (`skipLibCheck`), weil die Typen der Testwerkzeuge Browser-Typen voraussetzen, die der Workspace bewusst weglässt. Die Build-Projekte prüfen ihre Deklarationsdateien weiterhin.
- Ein veröffentlichtes Paket darf die Bedingung `@ecclium/source` nicht enthalten, sonst verweist es auf Dateien, die im Paket fehlen. Das muss eine Prüfung im Release-Pfad sicherstellen.

## Umsetzung

- Pakete: `packages/*/package.json` und je ein Einstiegspunkt `packages/*/src/index.ts`.
- Projekte: `tsconfig.base.json`, `tsconfig.build.json`, `tsconfig.json`, `packages/*/tsconfig.json`, `packages/*/tsconfig.test.json`, `tests/tsconfig.json`.
- Auflösung in Tests: `vitest.config.mts`. `tests/packages.test.mts` lädt jedes Paket über seinen Namen und prüft, dass `exports` die Quelle zuerst nennt. Gegenprobe von Hand: Ohne die Bedingung und ohne `dist/` scheitern die Tests.
- Zyklen über `testkit`: `ignoreWorkspaceCycles` in `pnpm-workspace.yaml`.
- In Phase 0 folgen die Regeln für dependency-cruiser und eine Prüfung, dass Projektreferenzen und Abhängigkeiten übereinstimmen. Bündelung und Veröffentlichung folgen mit dem Release-Pfad.
