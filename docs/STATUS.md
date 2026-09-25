# Status

Stand: 25.09.2026, Phase 0, nach dem Gerüst des Workspace

## Aktuelle Phase

Phase 0, Fundament und Entscheide. Fertig sind das Fundament des Repositorys und das Gerüst des Workspace: neun leere Pakete mit Projektreferenzen, Schutzeinstellungen für pnpm, TypeScript 6 und Vitest. `pnpm install --frozen-lockfile && pnpm build && pnpm test` läuft lokal grün.

Nächster Schritt: Qualitätswerkzeuge, also ESLint mit typbasierten Regeln und JSDoc-Pflicht für Exporte, Prettier, Prüfungen für Lizenzen, für die wirksamen pnpm-Einstellungen und für relative Links in Markdown sowie ein Test für einheitliche Werkzeugversionen, dazu ADR 0020 und 0021. Voraussetzung: Das Gerüst des Workspace ist gemergt.

## Vorbedingungen Phase 0

Vom Maintainer bestätigt am 25.09.2026:

- Name und Namensräume sind gesichert: Ecclium, Organisation `ecclium` auf GitHub und npm.
- Versionsgeschichte (ADR 0014): Das Kern-Repository ist ab dem ersten Commit öffentlich. Kein privater Vorlauf, kein späteres Umschalten.
- Lizenz des Kerns: Apache-2.0, Beiträge über DCO (ADR 0002).

## Weitere Entscheide

- Anmeldung am Server (ADR 0037), entschieden am 25.09.2026: Im freien Kern gibt es statische Bearer-Tokens und einen OAuth-Modus, der nur Tokens eines Anmeldediensts des Betreibers prüft. Der freie Kern bringt keinen eigenen Anmeldedienst mit, und einen Betrieb über HTTP ohne Anmeldung gibt es nicht. Wird in Phase 0 als ADR festgehalten.
- Rechteinhaber in `NOTICE`, entschieden am 25.09.2026: «Die Autorinnen und Autoren von Ecclium».
- Identität bei Beiträgen, entschieden am 25.09.2026: Das Sign-off nennt eine bekannte Identität, ein Pseudonym genügt. Anonyme Beiträge werden nicht angenommen.
- Geschichte auf `main` (ADR 0014), entschieden am 25.09.2026: Sie wird nicht umgeschrieben. Einzige Ausnahme sind Personendaten, die entfernt werden müssen, und das nur nach einem offen festgehaltenen Entscheid.
- Fristen in `SECURITY.md`, entschieden am 25.09.2026: Die Fristen aus Grundsatzentscheid 10 sind Ziele, keine Zusage.

## Grundsatzentscheide

Diese Grundsatzfragen sind entschieden.

| Nr. | Frage | Entscheid |
|---|---|---|
| 1 | Produktname und npm-Scope | Ecclium. Pakete `@ecclium/mcp-churchtools` (Befehl `ecclium`) und `@ecclium/mcp-churchtools-plugin-api`. |
| 2 | Erster Tenant | Eine Testinstanz, sofern verfügbar. Sonst ein eigenes, eng berechtigtes Dienstkonto auf einem produktiven Tenant, Rechte phasenweise erweitert. Für den Runner ein zweites Konto mit noch engeren Rechten. Beide getrennt von allem, was der eigene Fork eines Referenzprojekts benutzt (ADR 0017). |
| 3 | Erstes produktives Rezept | `dienstplan-report`, vorläufig. Wird vor Phase 6 bestätigt. |
| 4 | Songs und Finanzen | Finanz- und Spendenmodule bleiben in Version 1 draussen. Songs bleiben lesend drin. |
| 5 | Snapshots | Standardmässig an, 30 Tage, abschaltbar. Verschlüsselt mit Tagesschlüsseln, Vernichtung nach Frist plus einem Tag. |
| 6 | Sprache des README | Deutsch zuerst, englische Fassung spätestens zum Release in Phase 8. |
| 7 | Arbeitsrhythmus | In Schüben, ohne Termine. Jeder Schub endet mit grünen Prüfungen und nachgeführter `docs/STATUS.md`. |
| 8 | Sichtbarkeit von Pro-Funktionen | Ein Tool `ct_about` statt Platzhalter-Tools. Hinweis pro Tool nur bei installiertem, nicht lizenziertem Plugin. Wird vor Phase 9 als ADR 0042 festgehalten. |
| 9 | Sprache der Fehlermeldungen | Für das Modell Englisch, in der Kommandozeile für Betreiber Deutsch. |
| 10 | Fristen in `SECURITY.md` | Eingangsbestätigung innerhalb von 10 Tagen, Einschätzung innerhalb von 14 Tagen, Fix für kritische Lücken innerhalb von 30 Tagen, keine Erreichbarkeit rund um die Uhr. |

## Offen

- Vorbedingung Phase 1: ADR 0003, 0018 und 0023 festhalten und als entschieden bestätigen lassen, ADR 0037 festhalten und den Wortlaut bestätigen lassen. Die ADRs 0024 und 0025 fallen ebenfalls vor Phase 1.
- `TRADEMARKS.md`: Der Text folgt nach rechtlicher Prüfung. Bis dahin keine eigene Fassung. README, ADR 0002 und `brand/README.md` verweisen schon darauf. Mit der Datei kommt der Verweis in `NOTICE` dazu. Die Prüfung klärt auch, unter welchen Bedingungen die Dateien von Logo und Icons in `brand/` kopiert und weitergegeben werden dürfen, auch in Forks.
- Zugang für den API-Spike: Testinstanz oder Dienstkonto, dazu die ID eines Wiki-Testbereichs. Stellt der Maintainer vor dem Spike bereit.
- Lizenzstatus der ChurchTools-Dokumentation: Die OpenAPI-Spezifikation der ChurchTools-API nennt in `info.license` CC BY 4.0, für die übrige Dokumentation ist der Status ungeklärt. Bis zur Klärung liegt keine Kopie der Dokumentation im Repository. Entscheid vor Phase 3 (ADR 0027).
- OAuth bei ChurchTools: Endpunkte, PKCE, Refresh, Laufzeiten und Tokenformat sind nicht dokumentiert, unter `.well-known` liegen keine Metadaten. Offen bis Phase 7 oder bis zum Pro-Modul.
- Rate-Limit der ChurchTools-API: nur inoffiziell bekannt. Das Verhalten bei 429 bleibt offen, solange keine Testinstanz zur Verfügung steht.
- Ruleset für `main`, Stufe 2 (Pflichtprüfungen, DCO-Prüfung): folgt, sobald `ci.yml` läuft. Stufe 1 ist aktiv: Pull Request nötig, kein Force-Push, lineare Historie, nur Squash. Squash-Commits übernehmen den Titel des Pull Requests und die Nachrichten der Commits samt Sign-off.
- CodeQL im Default Setup analysiert keine Pull Requests aus Forks. Entscheid vor dem ersten Beitrag von aussen, spätestens in Phase 8.
- Neu zu bewerten: pnpm 12 (Phase 8), gitleaks gegen seinen Nachfolger (spätestens Phase 8), MCP-SDK 2.1.x (vor Phase 1), der umbenannte Prometheus-Client (vor der Phase mit Metriken), TypeScript 7 (sobald typescript-eslint es trägt), Cache in CI (wenn die Laufzeit es verlangt).
- Weitere Plattformen in `mise.lock`, etwa Linux auf arm64 oder macOS auf x64, sobald jemand sie braucht.
- Node.js 24.15, die Mindestversion, läuft in CI nicht mit. Ob CI sie zusätzlich prüft, wird mit der Werkbank entschieden (ADR 0019).
- Für das Threat Model v0 vorgemerkt:
  - Die eingebaute globale Allowlist von gitleaks gilt auch für die eigenen Regeln. Sie überspringt unter anderem Bilder einschliesslich SVG, Schriften, `pnpm-lock.yaml`, `package-lock.json`, `node_modules/` und `.gitleaks.toml` selbst. Ausserdem verwirft sie Funde, deren Wert wie ein Systempfad aussieht. Die Regel für Home-Pfade meldet deshalb nur den Benutzernamen.
  - Der von lefthook erzeugte Hook lässt einen Commit ohne Prüfung durch, wenn das Programm lefthook nicht gefunden wird. Der Hook ist deshalb nur eine erste Sicherung, ein Scan in CI folgt.
  - TypeScript und `@types/node` erscheinen auf npm ohne Herkunftsnachweis (Provenance), anders als Vitest, Vite und pnpm. Die Vertrauensrichtlinie von pnpm (`trustPolicy`) schützt diese beiden Pakete deshalb nicht, es bleibt das Mindestalter von drei Tagen. Beim Einrichten automatischer Aktualisierungen zu berücksichtigen.

## Annahmen

- Die Fristen in `SECURITY.md` zählen ab Eingang der Meldung.

## Erledigt

- 25.09.2026, Fundament des Repositorys:
  - Werkzeuge über mise gepinnt, mit Prüfsummen für Linux auf x64 und macOS auf arm64 in `mise.lock` und `mise.compat.lock`: Node.js 24.21.0, pnpm 11.27.1, gitleaks 8.30.1, lefthook 2.1.14, actionlint 1.7.12, zizmor 1.30.1, shellcheck 0.11.0. Die Umgebung `compat` prüft mit Node.js 26.10.0 gegen die nächste Node-Linie.
  - gitleaks mit generischen Regeln für ChurchTools-Hosts, Tokens in Authorization-Headern und URLs, private IPv4-Adressen, E-Mail-Adressen und Home-Pfade, als Git-Hook vor jedem Commit und für jede Commit-Message. Jede eigene Regel ist mit Testwerten und ihren Platzhaltern geprüft.
  - Nachweis: Ein zum Commit vorgemerktes Test-Geheimnis wird vom Hook abgewiesen. Der automatische Test in CI folgt.
  - Grundlagen: README, NOTICE, PROMISE, SECURITY, CONTRIBUTING mit DCO, CODEOWNERS, Issue-Formulare, Vorlage für Pull Requests, `.gitignore`, `.gitattributes`, `.editorconfig`, `.env.example`. Private Vulnerability Reporting ist auf GitHub eingeschaltet.
  - Markenpaket 1.2 unverändert in `brand/`. Nachweis: Der Tree-Hash von `brand/` ist gleich dem Tree des Markenpakets bei seinem Tag für Version 1.2, `c2125f64e59c9ea90c23d653ad89ea0f4c958002`.
  - ADR-Vorlage und Index. ADR 0001 und 0002 vorgeschlagen, ADR 0014 angenommen.
- 25.09.2026, Schutz von `main` nachgewiesen: Ein direkter Push auf `main` wird abgewiesen, GitHub meldet GH013 mit «Changes must be made through a pull request». GitHub zeigt `.github/CODEOWNERS` ohne Fehler. Voraussetzung dafür ist, dass das Team `@ecclium/maintainers` sichtbar ist und Schreibrecht auf das Repository hat.
- 25.09.2026, Gerüst des Workspace:
  - pnpm-Workspace mit Schutzeinstellungen, bevor die erste Abhängigkeit dazukam: Mindestalter von drei Tagen, auch für Versionen ohne Zeitangabe und ohne Ausweichen auf jüngere Versionen, keine Herabstufung des Herkunftsnachweises, transitive Abhängigkeiten nur aus der Registry, keine Install-Skripte, Installation vor `pnpm run`, wenn `node_modules` nicht zum Lockfile passt. Alle Werte sind mit `pnpm config get` als wirksam geprüft, und `pnpm-workspace.yaml` bleibt nach der Installation unverändert.
  - Neun leere Pakete nach ADR 0022, alle privat, mit Projektreferenzen für TypeScript 6.0.3. Ziel ES2025 ohne Browser-Typen, keine in TypeScript 6.0 veralteten Optionen (ADR 0019).
  - Vitest 5.0.1 mit Abdeckung über V8. Tests und Typprüfung nutzen den Quelltext der Pakete, nicht das Ergebnis eines Builds. Gegenprobe: Ohne die Export-Bedingung und ohne `dist/` scheitern 9 von 10 Testdateien, mit ihr laufen alle.
  - Nachweis: `pnpm install --frozen-lockfile && pnpm build && pnpm test` und `pnpm typecheck` laufen lokal grün.
  - ADR 0019 und 0022 vorgeschlagen.
