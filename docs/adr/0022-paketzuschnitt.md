# ADR 0022: Paketzuschnitt, zwei npm-Pakete, Bündelung ausser `zod` und `plugin-api`

- Status: Angenommen am 02.10.2026
- Datum: 25.09.2026
- Fällt vor: Phase 0

## Kontext

Ecclium besteht aus Teilen mit unterschiedlicher Aufgabe und unterschiedlichem Vertrauen: dem Kern mit ChurchTools-Client, Maskierung, Absicherung der Schreibvorgänge und Protokoll, den Tools, der Schicht für Routinen, dem Runner, dem MCP-Server, der Kommandozeile und den Testhilfen. Dazu kommt eine Schnittstelle, gegen die Erweiterungen gebaut werden, auch ein kostenpflichtiges Zusatzmodul und Erweiterungen Dritter.

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

| Verzeichnis  | Paketname                             | Inhalt                                                                                                                                                                            |
| ------------ | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugin-api` | `@ecclium/mcp-churchtools-plugin-api` | Vertrag zwischen Kern und Erweiterungen                                                                                                                                           |
| `core`       | `@ecclium/mcp-churchtools-core`       | Konfiguration, Mandantenkontext, ChurchTools-Client, einziger Weg für ausgehende Verbindungen, Tool-Pipeline, Maskierung, Absicherung der Schreibvorgänge, Richtlinien, Protokoll |
| `docs-index` | `@ecclium/mcp-churchtools-docs-index` | Index mit Fakten aus der ChurchTools-Dokumentation                                                                                                                                |
| `tools`      | `@ecclium/mcp-churchtools-tools`      | Domänen-Tools, MCP-Prompts, generische API-Tools                                                                                                                                  |
| `workflows`  | `@ecclium/mcp-churchtools-workflows`  | Routinen, Richtlinien, Routine-Engine, Anbindung von Sprachmodellen                                                                                                               |
| `runner`     | `@ecclium/mcp-churchtools-runner`     | Läufe nach Zeitplan, Freigabe, Rücknahme                                                                                                                                          |
| `server`     | `@ecclium/mcp-churchtools-server`     | MCP-Server über stdio und HTTP                                                                                                                                                    |
| `cli`        | `@ecclium/mcp-churchtools`            | Zusammensetzung aller Teile und der Befehl `ecclium`                                                                                                                              |
| `testkit`    | `@ecclium/mcp-churchtools-testkit`    | Testhilfen, nur für Tests                                                                                                                                                         |

**Veröffentlichung.** Veröffentlicht werden genau zwei Pakete: das Produktpaket `@ecclium/mcp-churchtools` mit dem Befehl `ecclium` und die Schnittstelle `@ecclium/mcp-churchtools-plugin-api` mit eigener, streng semantischer Version. Die übrigen sieben bleiben privat im Workspace. Bis zur ersten Veröffentlichung sind alle neun als `private` markiert, damit keines versehentlich auf npm gelangt.

**Bündelung.** Das Produktpaket wird gebündelt, ausser `zod` und der Schnittstelle für Erweiterungen. Erweiterungen bringen beide selbst mit, und lägen sie zusätzlich im Bündel, gäbe es zwei Kopien. Deshalb hält die Schnittstelle keinen Zustand auf Modulebene, Markierungen laufen über `Symbol.for('ecclium.mcp-churchtools.*.v1')`, und Klassifikationen stehen im globalen Register von zod. Die Exporte der Schnittstelle tragen ausdrückliche Typen (`isolatedDeclarations`), damit die veröffentlichte Schnittstelle im Quelltext sichtbar ist und sich nicht über abgeleitete Typen ändert.

**Importe.** Erlaubt sind:

| Paket                | darf importieren                                    |
| -------------------- | --------------------------------------------------- |
| `plugin-api`         | kein anderes Paket, `zod` nur als Peer-Abhängigkeit |
| `core`, `docs-index` | `plugin-api`                                        |
| `tools`              | `core`, `plugin-api`, `docs-index`                  |
| `workflows`          | `core`, `plugin-api`                                |
| `runner`             | `core`, `workflows`, `plugin-api`                   |
| `server`             | `core`, `plugin-api`                                |
| `cli`                | alle, `testkit` nur in Tests                        |
| `testkit`            | alle                                                |

`testkit` ist für alle anderen Pakete nur eine devDependency und wird nie ausgeliefert.

**Durchsetzung auf drei Ebenen**, weil jede allein umgehbar ist:

1. **Paketdefinition:** Jedes Paket nennt in `package.json` nur Pakete, die es laut Tabelle importieren darf, als Abhängigkeit `workspace:*`, `testkit` nur als devDependency. `exports` gibt nur die genannten Einstiegspunkte frei. Diese Ebene schützt allein nicht: Das `package.json` im Wurzelordner nennt für die Tests alle Pakete und die Werkzeuge der Entwicklung, deshalb sind im Workspace alle Pakete von überall auflösbar.
2. **Projektreferenzen von TypeScript:** Das Build-Projekt eines Pakets referenziert genau seine Abhängigkeiten. `tsc -b` baut in dieser Reihenfolge und lehnt Zyklen ab.
3. **dependency-cruiser in CI:** prüft jeden Import gegen dieselbe Tabelle, auch relative Pfade über Paketgrenzen und aus einem Paket in den Rest des Repositorys, Importe nur für Typen und Importe von npm-Paketen, die das eigene `package.json` nicht für die Laufzeit nennt. Von der letzten Prüfung sind Tests ausgenommen, weil sie die Testwerkzeuge aus dem Wurzelordner benutzen. Als Test gilt nur, was auf `.test.ts` endet: genau die Dateien, die Vitest ausführt und der Build weglässt.

Die Tabelle steht in einer Datei, `tests/architecture/boundaries.json`. Aus ihr lesen dependency-cruiser, die Architekturregeln von ESLint und die Tests, und ein Test prüft, dass `package.json` und Projektreferenzen jedes Pakets zu ihr passen.

**Quelle statt Build.** `exports` nennt für jeden Einstiegspunkt zuerst die Quelle unter `@ecclium/source`, für den Hauptpfad `"./src/index.ts"`, danach `types` und `default` für das Ergebnis des Builds in `dist/`. TypeScript (`customConditions`) und Vitest lösen Workspace-Pakete unter dieser Bedingung auf und prüfen so immer den aktuellen Quelltext. Die beiden veröffentlichten Pakete lassen die Bedingung über `publishConfig.exports` weg.

**Zwei TypeScript-Projekte pro Paket.** `tsconfig.json` baut den Quelltext in `src/` ohne die Tests. `tsconfig.test.json` prüft die Tests ohne Ausgabe und referenziert das eigene Build-Projekt und `testkit`. So darf `testkit` alle Pakete importieren, ohne dass Projektreferenzen einen Zyklus bilden. Im Wurzelordner baut `tsconfig.build.json` alle Pakete. `tsconfig.json` umfasst zusätzlich alle Testprojekte und dient der Typprüfung und den Editoren.

**Wurzelordner.** Das `package.json` im Wurzelordner hat kein Feld `type`, weil `brand/` ein Hilfsskript in CommonJS enthält, das ein `"type": "module"` im Wurzelordner brechen würde. TypeScript-Dateien ausserhalb von `packages/` enden deshalb auf `.mts`, Konfigurationsdateien in JavaScript auf `.mjs`. Die Pakete setzen `"type": "module"` selbst.

## Konsequenzen

- Interne Schnittstellen zwischen den Paketen dürfen sich frei ändern. Öffentlicher Vertrag sind nur die beiden veröffentlichten Pakete.
- Jeder neue Import zwischen Paketen braucht eine Abhängigkeit in `package.json` und eine Projektreferenz. Neue Abhängigkeiten zwischen Paketen sind so im Review sichtbar.
- In einem Bündel sehen Scanner die enthaltenen Abhängigkeiten nicht. Stückliste (SBOM) und Hinweise auf Software Dritter entstehen deshalb aus dem Lockfile, und eine Prüfung muss sicherstellen, dass das Produktpaket keine weiteren Laufzeitabhängigkeiten nennt.
- Weil jedes Paket `testkit` in den Tests nutzt und `testkit` alle Pakete importieren darf, gibt es Zyklen über devDependencies. Sie sind gewollt. pnpm warnt deshalb im ganzen Workspace nicht mehr vor Zyklen (`ignoreWorkspaceCycles`). Zyklen zwischen Laufzeitabhängigkeiten finden weiterhin `tsc -b` und dependency-cruiser.
- Die Testprojekte prüfen keine Deklarationsdateien (`skipLibCheck`), weil die Typen der Testwerkzeuge Browser-Typen voraussetzen, die der Workspace bewusst weglässt. Die Build-Projekte prüfen ihre Deklarationsdateien weiterhin.
- Ein veröffentlichtes Paket darf die Bedingung `@ecclium/source` nicht enthalten, sonst verweist es auf Dateien, die im Paket fehlen. Das muss eine Prüfung im Release-Pfad sicherstellen.
- Ein Paket kann neben dem Einstiegspunkt weitere Unterpfade in `exports` nennen, `core` etwa `./mcp` für den Mount (ADR 0024). Andere Pakete dürfen nur diese Einstiegspunkte importieren.
- Das Beispiel eines Plugins liegt in `testkit`, dessen `package.json` und Projektreferenzen alle Pakete nennen. Seine Grenze hält allein die Regel `plugins-only-plugin-api` von dependency-cruiser.

## Umsetzung

- Pakete: `packages/*/package.json` und je ein Einstiegspunkt `packages/*/src/index.ts`, bei `core` zusätzlich `./mcp` mit `packages/core/src/mcp/mount.ts`, `./http` mit `packages/core/src/http/compose.ts`, den nur die Composition Root importiert, `./http/testing` mit `packages/core/src/http/compose-mock.ts`, den nur das Testdouble in testkit importiert (ADR 0056), und seit dem 19.10.2026 `./composition` mit `packages/core/src/composition.ts`, den ebenfalls nur die Composition Root importiert, nach der Regel `composition-only-from-composition-root` (ADR 0054).
- Projekte: `tsconfig.base.json`, `tsconfig.build.json`, `tsconfig.json`, `packages/*/tsconfig.json`, `packages/*/tsconfig.test.json`, `tests/tsconfig.json`.
- Auflösung in Tests: `vitest.config.mts`. `tests/packages.test.mts` lädt jedes Paket und jeden Unterpfad über seinen Namen und prüft, dass `exports` die Quelle zuerst nennt. Gegenprobe von Hand: Ohne die Bedingung und ohne `dist/` scheitern die Tests.
- Zyklen über `testkit`: `ignoreWorkspaceCycles` in `pnpm-workspace.yaml`.
- Tabelle und feste Orte: `tests/architecture/boundaries.json`, geprüft beim Laden durch `tests/architecture/boundaries.mts`.
- dependency-cruiser: `.dependency-cruiser.mjs` mit den Regeln aus `tests/architecture/dependency-rules.mts`, geprüft mit `pnpm check:arch`. Jede Regel hat in `tests/architecture/dependency-rules.test.mts` ein Beispiel, das sie verletzt.
- Übereinstimmung von `package.json`, Projektreferenzen und Tabelle: `tests/architecture/workspace-graph.test.mts`.
- Einziger ausgehender Weg: der Ort `egress` (`packages/core/src/http/`) in `tests/architecture/boundaries.json`, die Regel `network-only-in-egress` von dependency-cruiser und die ESLint-Sperre `[arch:network]`. Ausserhalb dieses Ordners sperren sie im Code der Pakete eine feste Liste: die eingebauten Module für HTTP, Sockets, TLS, UDP, DNS und den Inspector und das Paket `undici`, auch nur für Typen, sowie die globalen `fetch`, `WebSocket`, `EventSource` und `XMLHttpRequest`, auch über `globalThis` und hinter einer Deklaration nur für den Type-Checker. Eine andere Bibliothek, die selbst Verbindungen öffnet, erkennen sie nicht. Sie käme als neue Abhängigkeit, die im Commit begründet und im Review geprüft wird. Tests sind nicht ausgenommen. Das Testdouble auf Basis von undici liegt in core im Ort `egress` und erreicht testkit nur über den Subpfad `./http/testing`, den nur der Ort `httpDouble` importieren darf (ADR 0056). `egress` ist genau ein Ordner direkt unter `src/` von core und teilt keinen Pfad mit einem anderen Ort, das prüft das Laden von `boundaries.json`. Seit dem ausgehenden Weg trifft jedes Muster der Regel ein Modul. Der Server über HTTP lauscht ab Phase 7 auf einem Port und braucht dafür einen eigenen Ort mit Begründung.
- Direktiven: `tests/architecture/lint-rules.test.mts` lehnt im Code der Pakete jeden Kommentar ab, der eine Architekturregel abschaltet, ob mit `eslint-disable` ohne Liste, mit dem Namen einer solchen Regel oder als Konfiguration im Kommentar.
- `zod` als Peer-Abhängigkeit, seit dem 13.10.2026: `plugin-api` nennt `zod` unter `peerDependencies` mit dem Bereich `^4.6.5` und für Build und Tests genau gepinnt unter `devDependencies`. dependency-cruiser meldet eine solche Abhängigkeit mit beiden Typen, `npm-dev` und `npm-peer`. Die Regel `no-undeclared-npm` gilt deshalb für alle Pakete ausser `plugin-api`. Für `plugin-api` gilt die Regel `plugin-api-peers-only`, die ein npm-Paket nur als Peer-Abhängigkeit und kein eingebautes Modul von Node.js zulässt. `tests/architecture/workspace-graph.test.mts` erlaubt Peer-Abhängigkeiten nur `plugin-api` und dort nur `zod`, mit einer genau gepinnten Kopie im Bereich unter `devDependencies`. `plugin-api` hat keine eigene Abhängigkeit für die Laufzeit und bündelt keine.
- Klassifikationen im globalen Register von zod, seit dem 13.10.2026: `classify()` und `dataClassOf()` in `packages/plugin-api/src/data-class.ts`.
  - zod 4.6.5 legt sein globales Register auf `globalThis`, jede Kopie von zod im Prozess benutzt dasselbe. Die Klasse steht dort unter einem Schlüssel aus `Symbol.for`, den jede Kopie der Plugin-Schnittstelle gleich berechnet. Ein Schlüssel aus Text käme mit `toJSONSchema` in das JSON Schema, das ein Client mit jedem Tool erhält. Ein Schlüssel aus einem Symbol kommt dort nicht an, das prüft ein Test.
  - `get()` des Registers liefert für ein Schema, das zod aus einem anderen ableitet, etwa mit `.max()` oder `.describe()`, nichts, wenn seine Metadaten nur Schlüssel aus Symbolen haben. `dataClassOf()` liest deshalb die eigenen Einträge des Registers entlang der Kette der Originale, das nächste zuerst, so wie zod selbst Metadaten erbt. Dafür benutzt es `_map` des Registers und `_zod.parent` des Schemas. Beide stehen in den Typen von zod, `_zod.parent` aber als intern markiert. Ein Test hält fest, dass `get()` die Klasse nicht liefert. Liefert es sie mit einer späteren Version, wird dieser Umweg überflüssig.
  - Geprüft ist das mit der Kopie für die Entwicklung, bis zum 16.10.2026 zod 4.6.5, seither 4.6.7. Seit dem 19.10.2026 lösen alle Pakete des Arbeitsbereichs diese eine Kopie auf, und kein Test lädt mehr zwei Versionen von zod in einen Prozess. Der Bereich `^4.6.5` der Peer-Abhängigkeit lässt ältere und neuere Versionen zu, deren Interna anders sein können, und in einem Prozess gilt das Register der Kopie von zod, die zuerst geladen wird. Bevor das Paket erscheint, laufen die Tests deshalb auch mit der ältesten und der jüngsten Version des Bereichs.
  - Hüllen wie `.optional()`, `.nullable()` und `.default()` durchschaut `dataClassOf()` bis zum Schema, das sie umhüllen. Alle Klassen auf dem Weg zum Blatt, an Hüllen wie an Kopien, müssen übereinstimmen, sonst ist das ein Fehler. So lässt sich eine Klasse auf dem Weg nicht senken, etwa mit `.meta()`. Jeden Eintrag liest `dataClassOf()` ohne seine Prototypkette und ohne einen Getter auszuführen. Nach 1000 Schritten bricht es ab, weil die Kette dann vermutlich eine Schleife ist. Seine Fehler haben feste Texte ohne Inhalt aus dem Eintrag.
  - `classify()` klassifiziert nur ein Blatt: eine Zeichenkette, eine Zahl, eine grosse Ganzzahl, einen Wahrheitswert, ein Datum, ein Literal, eine Aufzählung, ein Template-Literal oder `null`, auch in Hüllen. Ein Container wie ein Objekt oder eine Liste und eine offene Form wie `any`, ein Record oder eine eigene Prüfung tragen keine Klasse. `classify()` ergänzt nur den eigenen Eintrag eines Schemas, aus einer Kopie seiner einfachen Werte ohne Getter, und lehnt eine zweite, andere Klasse ab.
- Tools des Kerns, seit dem 19.10.2026: `ct_whoami` in `packages/tools/src/base/whoami.ts` und das Plugin des Kerns in `packages/tools/src/core-plugin.ts` importieren wie ein Plugin von Dritten nur die Plugin-Schnittstelle und zod. Ordner und Datei stehen im Ort `plugins` in `tests/architecture/boundaries.json`, mit verbotenen und erlaubten Beispielen in `tests/architecture/dependency-rules.test.mts`. `tools` pinnt zod in derselben Version wie core, damit Kern und Tools zur Laufzeit eine Kopie teilen. Das ist 4.6.7, die Version, die auch die Plugin-Schnittstelle, testkit und das MCP-SDK auflösen, und so liegt im Arbeitsbereich nur eine Kopie von zod. `ct_whoami` ist ein Ergebnis von `defineTool`, das `execute` gegen die beiden Schemas prüft. In der ersten Fassung pinnten core und tools 4.6.5, deren Typen nicht zu denen der Kopie 4.6.7 neben der Plugin-Schnittstelle passten, und ein Cast übergab die Schemas an dieser Grenze.
- Marken in Typen der Plugin-Schnittstelle, etwa für `TenantId`, haben einen Schlüssel aus Text, keinen eigenen Typ eines Symbols. So passen die Typen zweier Kopien der Schnittstelle zueinander.
- Bündelung und Veröffentlichung folgen mit dem Release-Pfad.
