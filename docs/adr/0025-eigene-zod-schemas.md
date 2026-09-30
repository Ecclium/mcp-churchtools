# ADR 0025: Eigene zod-Schemas als Wahrheit für den ChurchTools-Client

- Status: Vorgeschlagen
- Datum: 30.09.2026
- Fällt vor: Phase 1

## Kontext

Der Kern liest Daten über die REST-API von ChurchTools. Jede Instanz veröffentlicht ihre API als OpenAPI-Dokument. Die Proben des API-Spikes lesen dieses Dokument von der jeweiligen Instanz, statt eine Kopie mitzubringen: Es kann eigene Namen der Instanz enthalten, etwa von Zusatzfeldern, und seine Pfade zeigen, welche Module sie nutzt (`scripts/spike/README.md`). Die OpenAPI-Spezifikation der ChurchTools-API, Version 3.136.2, nennt in `info.license` die Lizenz CC BY 4.0. Für die übrige Dokumentation ist der Lizenzstatus ungeklärt, deshalb liegt keine Kopie im Repository (ADR 0027).

Die Pipeline verwirft in `validateOutput` jedes Feld, das ein Tool nicht deklariert, und die Maskierung liest die Klassifikation jedes Felds aus dem globalen Register von zod (ADR 0022, ADR 0024). Beides braucht für jedes Feld eine Deklaration, die Ecclium selbst kontrolliert.

Einige Eigenschaften der API kennt Ecclium bisher nur aus der Dokumentation, an einer Instanz geprüft sind sie noch nicht (`docs/research/churchtools-api.md`, Fragen F5 bis F8): Der Aufbau der globalen Rechte-Antwort ist offen. In `meta.pagination` sind laut Dokumentation nur `current` und `lastPage` Pflichtfelder. `limit` hat laut Dokumentation keine Obergrenze. Die Antworten 400, 401, 403 und 404 sind laut Dokumentation uneinheitlich.

Festzulegen ist, woran der Client Antworten von ChurchTools prüft und wozu das OpenAPI-Dokument dient.

## Optionen

1. **Typen und Prüfung aus dem OpenAPI-Dokument erzeugen:** wenig Handarbeit, aber das Dokument unterscheidet sich je nach Instanz und Version, eine Kopie gehört bis zur Klärung der Lizenz nicht ins Repository (ADR 0027), jede Ungenauigkeit des Dokuments würde zur Prüfung selbst, und eine Klassifikation für die Maskierung enthält es nicht.
2. **Antworten nur typisieren, nicht prüfen:** schnell, aber ein unerwartetes Feld oder ein unerwarteter Typ gelangt ungeprüft bis zur Maskierung, und Abweichungen fallen erst im Betrieb auf.
3. **Eigene zod-Schemas für jeden genutzten Endpunkt,** von Hand geschrieben, die das OpenAPI-Dokument nur als Hilfe benutzen.

## Entscheid

Gewählt ist die dritte Option.

- **Wahrheit:** Für jeden Endpunkt, den der Client nutzt, gibt es ein eigenes zod-Schema für Anfrage und Antwort, auch für Paginierung und Fehler. Der Client prüft jede Antwort daran. Was ein Schema nicht deklariert, erreicht kein Tool.
- **Keine geratene Antwort:** Passt eine Antwort nicht zu ihrem Schema, endet der Aufruf mit einem klaren Fehler. Ausnahme mit Absicht: Eine unbekannte Struktur der Rechte-Antwort sperrt nur das Schreiben, nie das Lesen. Die eigene Prüfung der Rechte ist beratend, durchgesetzt werden die Rechte von ChurchTools.
- **Das OpenAPI-Dokument** dient zwei Zwecken und ist in beiden nicht die Wahrheit: Es liefert die Grundlage, um die Operationen der generischen API-Tools zu klassifizieren, die Endpunkte ohne eigenes Tool erreichen. Und ein Vertragsabgleich läuft lokal gegen eine Kopie, die nicht eingecheckt wird, damit Änderungen der API auffallen.
- **Abgrenzung:** Dieses ADR betrifft die Schemas des Clients gegenüber ChurchTools. Die Ausgabeschemas der Tools und ihre Klassifikation für die Maskierung regelt ADR 0026, die generischen API-Tools entstehen in Phase 3. Für das Minimum der Maskierung ab Phase 1 tragen die Ausgabeschemas der ersten Tools die Klassen für E-Mail-Adressen, Telefonnummern und Geburtsdaten im Register von zod (ADR 0022, ADR 0024).

## Konsequenzen

- Jeder Endpunkt kostet Handarbeit. Dafür ist jedes Feld bewusst aufgenommen, und die Zahl der Endpunkte bleibt klein, weil jeder ein Schema braucht.
- Ändert ChurchTools eine Antwort, schlägt die Prüfung fehl, statt still falsche oder zusätzliche Daten weiterzugeben. Der lokale Vertragsabgleich soll solche Änderungen vorher zeigen.
- `zod` kommt mit dem ersten Schema in Phase 1 als Abhängigkeit dazu, begründet im Commit. Dass es nicht gebündelt wird und das Register für Klassifikationen hält, legt ADR 0022 fest.
- Restrisiken: Solange keine Kopie des Dokuments im Repository liegt, läuft der Vertragsabgleich nicht in CI. Eine Änderung der API zeigt sich dann erst, wenn jemand ihn lokal ausführt oder eine Antwort im Betrieb an ihrem Schema scheitert.
- Offen: Die Aussagen zu Rechte-Antwort, Paginierung, `limit` und Fehlern stammen aus der Dokumentation. Die Proben `00-inventory` bis `03-pagination-errors` prüfen sie an einer Instanz. Ihre Ergebnisse ergänzen den Kontext dieses ADR, bevor es angenommen wird.

## Umsetzung

- Der Ort des rohen Clients steht fest: `packages/core/src/churchtools/` (ADR 0024).
- Schemas, Prüfung im Client und der lokale Vertragsabgleich folgen in Phase 1.
