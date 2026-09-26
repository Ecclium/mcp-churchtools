# Status

Stand: 26.09.2026, Phase 0, nach den lesenden Proben des API-Spikes

## Aktuelle Phase

Phase 0, Fundament und Entscheide. Fertig sind das Fundament des Repositorys, das Gerüst des Workspace, die Qualitätswerkzeuge und der erste Teil des API-Spikes: Helfer und lesende Proben, die nur die Struktur der Antworten ausgeben, und das Gerüst von `docs/research/churchtools-api.md`. `pnpm check` fasst alle Prüfungen zusammen und läuft lokal grün.

Nächster Schritt: schreibende Proben für den zweiten Teil des Spikes, nur in der Testkategorie und nur mit einem ausdrücklichen Schalter. Voraussetzung: Die lesenden Proben sind gemergt. Sobald zudem der Zugang aus «Offen» bereitsteht, führt der Maintainer die lesenden Proben nach `scripts/spike/README.md` aus und gibt die durchgesehenen Ausgaben frei.

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
- Begriff «Routine», entschieden am 26.09.2026: Die geplanten Abläufe von Ecclium heissen «Routinen», nicht mehr «Rezepte», im Code `routine`. Der Begriff ist für Gemeindeleitende klarer. Was noch nachzuführen ist, steht unter «Offen».

## Grundsatzentscheide

Diese Grundsatzfragen sind entschieden.

| Nr. | Frage                           | Entscheid                                                                                                                                                                                                                                                                                           |
| --- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Produktname und npm-Scope       | Ecclium. Pakete `@ecclium/mcp-churchtools` (Befehl `ecclium`) und `@ecclium/mcp-churchtools-plugin-api`.                                                                                                                                                                                            |
| 2   | Erster Tenant                   | Eine Testinstanz, sofern verfügbar. Sonst ein eigenes, eng berechtigtes Dienstkonto auf einem produktiven Tenant, Rechte phasenweise erweitert. Für den Runner ein zweites Konto mit noch engeren Rechten. Beide getrennt von allem, was der eigene Fork eines Referenzprojekts benutzt (ADR 0017). |
| 3   | Erste produktive Routine        | `dienstplan-report`, vorläufig. Wird vor Phase 6 bestätigt.                                                                                                                                                                                                                                         |
| 4   | Songs und Finanzen              | Finanz- und Spendenmodule bleiben in Version 1 draussen. Songs bleiben lesend drin.                                                                                                                                                                                                                 |
| 5   | Snapshots                       | Standardmässig an, 30 Tage, abschaltbar. Verschlüsselt mit Tagesschlüsseln, Vernichtung nach Frist plus einem Tag.                                                                                                                                                                                  |
| 6   | Sprache des README              | Deutsch zuerst, englische Fassung spätestens zum Release in Phase 8.                                                                                                                                                                                                                                |
| 7   | Arbeitsrhythmus                 | In Schüben, ohne Termine. Jeder Schub endet mit grünen Prüfungen und nachgeführter `docs/STATUS.md`.                                                                                                                                                                                                |
| 8   | Sichtbarkeit von Pro-Funktionen | Ein Tool `ct_about` statt Platzhalter-Tools. Hinweis pro Tool nur bei installiertem, nicht lizenziertem Plugin. Wird vor Phase 9 als ADR 0042 festgehalten.                                                                                                                                         |
| 9   | Sprache der Fehlermeldungen     | Für das Modell Englisch, in der Kommandozeile für Betreiber Deutsch.                                                                                                                                                                                                                                |
| 10  | Fristen in `SECURITY.md`        | Eingangsbestätigung innerhalb von 10 Tagen, Einschätzung innerhalb von 14 Tagen, Fix für kritische Lücken innerhalb von 30 Tagen, keine Erreichbarkeit rund um die Uhr.                                                                                                                             |

## Offen

- Vorbedingung Phase 1: ADR 0003, 0018 und 0023 festhalten und als entschieden bestätigen lassen, ADR 0037 festhalten und den Wortlaut bestätigen lassen. Die ADRs 0024 und 0025 fallen ebenfalls vor Phase 1.
- `TRADEMARKS.md`: Der Text folgt nach rechtlicher Prüfung. Bis dahin keine eigene Fassung. README, ADR 0002 und `brand/README.md` verweisen schon darauf. Mit der Datei kommt der Verweis in `NOTICE` dazu. Die Prüfung klärt auch, unter welchen Bedingungen die Dateien von Logo und Icons in `brand/` kopiert und weitergegeben werden dürfen, auch in Forks.
- Zugang für den API-Spike: Testinstanz oder Dienstkonto, dazu die ID einer Wiki-Kategorie nur für Tests und optional die einer zweiten Kategorie, die das Dienstkonto nicht lesen darf. Stellt der Maintainer vor dem Spike bereit. Dann laufen die lesenden Proben nach `scripts/spike/README.md`, und ihre durchgesehenen Ergebnisse kommen in `docs/research/churchtools-api.md`.
- Fragen F1 bis F15 zur API von ChurchTools: Stand vor dem Spike in `docs/research/churchtools-api.md`. Als belegt gilt eine Antwort erst, wenn eine Probe sie an einer Instanz bestätigt hat.
- Begriff «Routine»: ADR 0022, der ADR-Index und die Kommentare in `packages/runner` und `packages/workflows` verwenden noch «Rezept» oder `recipe`. `brand/` in Version 1.3 mit dem neuen Begriff liefert der Maintainer.
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
  - TypeScript, `@types/node`, ESLint, `@eslint/js` und Prettier erscheinen auf npm ohne Herkunftsnachweis (Provenance), anders als Vitest, Vite, typescript-eslint, eslint-plugin-jsdoc und pnpm. Die Vertrauensrichtlinie von pnpm (`trustPolicy`) schützt diese Pakete deshalb nicht, es bleibt das Mindestalter von drei Tagen. Sie werden nie automatisch übernommen (ADR 0021).
  - Die Proben des Spikes vertrauen dem OpenAPI-Dokument der Instanz: Seine Werte stehen nicht auf der Sperrliste, seine Schlüssel dürfen in der Ausgabe erscheinen. Eigene Namen einer Instanz im Dokument fängt nur die Durchsicht vor dem Weitergeben.
  - In `02-permissions` erscheinen Namen von Rechten, wenn sie aus kleingeschriebenen Wörtern bestehen. Verrät ein solcher Name etwas über die Gemeinde und kommt er in keiner Antwort als Wert vor, fängt ihn ebenfalls nur die Durchsicht.

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
- 26.09.2026, Qualitätswerkzeuge:
  - gitleaks prüft zusätzlich auf Dateien, die nie ins Repository gehören, auf interne Hostnamen, IPv4- und IPv6-Adressen, Telefonnummern, AHV-Nummern und IBAN. Die Platzhalter stehen am Anfang von `.gitleaks.toml`. Ein Kommentar `gitleaks:allow` schaltet einen Fund nicht mehr ab. Nachweis: Jede eigene Regel schlägt auf einen zur Testzeit erzeugten Wert an, ihre Platzhalter gehen durch, und Geschichte, Arbeitsbaum und alle Commit-Messages sind ohne Fund.
  - Prettier 3.9.8 für Code, Konfiguration und Dokumentation, im Hook für die gestagten Dateien. Die bestehenden Dokumente sind formatiert, ihr Text ist unverändert.
  - ESLint 10.11.0 mit typescript-eslint 8.70.1 in der strengen, typbasierten Einstellung und eslint-plugin-jsdoc 64.5.4. Pflicht für Dokumentationskommentare an Exporten, Verbot direkter Ausgabe im Code der Pakete. Gegenprobe mit absichtlich falschen Dateien.
  - Prüfskripte für Lizenzen, für die wirksamen Einstellungen von pnpm und für relative Links in Markdown, mit Tests. Gegenprobe: Ein falsch geschriebener Schlüssel, ein abgeschwächter Wert und ein Link ohne Ziel lassen die Prüfung scheitern.
  - Test, der die Versionen von Node.js und pnpm über alle Konfigurationsdateien abgleicht und prüft, dass jede Abhängigkeit genau gepinnt ist.
  - Nachweis: `pnpm check` läuft lokal grün, mit 67 Tests in 14 Dateien.
  - ADR 0020 und 0021 vorgeschlagen.
- 26.09.2026, erster Teil des API-Spikes, lesende Proben:
  - Helfer in `scripts/spike/lib/`: Die Ausgabe zeigt nur Struktur, Klassen und die Version von ChurchTools. Vor jeder Ausgabe prüft eine Sicherung jedes Wort gegen eine Positivliste und jeden Schlüssel aus der Instanz gegen eine Sperrliste mit allem, was aus der Instanz oder vom Rechner stammt. Bei einem Treffer erscheinen nur JSON-Pointer. Anfragen nur als GET an die eine Origin, das Token nur im Header, keine Weiterleitungen, Zeit- und Grössengrenzen. Token- und State-Datei werden auf dem geöffneten Handle geprüft. Fehler zeigen nur feste Codes mit deutschen Hinweisen.
  - Fünf lesende Proben `00-inventory` bis `04-wiki-read` mit README: Vorbereitung, Ausführung aus einem geprüften Commit mit `env -i`, Codes, Durchsicht vor dem Weitergeben, Aufräumen. Jede Probe schlägt ihre Operationen über Methode und Pfad im OpenAPI-Dokument der Instanz nach und ruft nichts auf, was die Instanz nicht dokumentiert.
  - Gerüst von `docs/research/churchtools-api.md` mit 15 Fragen, der Probe dazu und dem Stand laut Dokumentation.
  - Nachweis: Alle Proben laufen in den Tests gegen eine synthetische Instanz, deren Antworten voller Kanarienwerte sind. Keiner davon erscheint in einer Ausgabe. Gegenprobe: Sechs absichtlich eingebaute Fehler lassen die Tests scheitern, darunter das Token in der URL, eine ungeprüfte Kennung im Pfad und der Wert einer Kopfzeile in der Ausgabe. Als Programm gestartet, bricht jede Probe ohne Umgebung mit Code 2 und einem deutschen Hinweis ab, ohne Anfrage. `pnpm check` läuft lokal grün, mit 167 Tests in 21 Dateien.
