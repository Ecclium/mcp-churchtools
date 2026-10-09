# ADR 0025: Eigene zod-Schemas als Wahrheit für den ChurchTools-Client

- Status: Vorgeschlagen
- Datum: 30.09.2026
- Fällt vor: Phase 1

## Kontext

Der Kern liest Daten über die REST-API von ChurchTools. Jede Instanz veröffentlicht ihre API als OpenAPI-Dokument. Die Proben des API-Spikes lesen dieses Dokument von der jeweiligen Instanz, statt eine Kopie mitzubringen: Es kann eigene Namen der Instanz enthalten, etwa von Zusatzfeldern, und seine Pfade zeigen, welche Module sie nutzt (`scripts/spike/README.md`). Die OpenAPI-Spezifikation der ChurchTools-API, Version 3.136.2, nennt in `info.license` die Lizenz CC BY 4.0. Für die übrige Dokumentation ist der Lizenzstatus ungeklärt, deshalb liegt keine Kopie im Repository (ADR 0027).

Die Pipeline verwirft in `validateOutput` jedes Feld, das ein Tool nicht deklariert, und die Maskierung liest die Klassifikation jedes Felds aus dem globalen Register von zod (ADR 0022, ADR 0024). Beides braucht für jedes Feld eine Deklaration, die Ecclium selbst kontrolliert.

Die lesenden Proben des API-Spikes haben die API an einer Testinstanz mit synthetischen Daten geprüft, an ChurchTools 3.137 und unter dem Vorbehalt aus ADR 0049. Die Befunde stehen in `docs/research/churchtools-api.md`, zu diesem ADR gehören vor allem F4 bis F8, F18 und F19:

- **Das Dokument beschreibt nicht alles:** Die Schlüssel der geprüften Fehlerantworten 400, 401, 403 und 404 deklariert es an diesen Stellen nicht.
- **Rechte:** `GET /api/permissions/global` liefert ein Objekt je Modul, darin je Recht einen Wahrheitswert oder eine Liste. Die einzige nicht leere Liste enthielt eine Zahl. Auch Rechte, die ein Konto nicht hat, stehen darin, als `false` oder als leere Liste. Nicht jeder Name eines Rechts besteht nur aus kleingeschriebenen Wörtern.
- **Paginierung:** `meta.pagination` von `GET /api/wiki/pages` hat `total`, `limit`, `current` und `lastPage`. Hinter der letzten Seite kommt 200 mit leerer Liste. Die Seitenliste einer Kategorie und die Versionsliste einer Seite tragen nur `meta.count`.
- **`limit`:** `limit=100` nimmt die API an, `limit=1000` lehnt sie mit 400 ab, statt still zu kürzen. Die genaue Grenze ist offen. `page` und `limit` mit `0`, `-1` oder `x` ergeben 400.
- **Fehler:** Die vier geprüften Fehlerantworten haben dieselbe Form, drei Texte, ein viertes Feld und eine Liste. Die Namen der Felder sind nur an einer Antwort 404 von Hand beobachtet.
- **Anmeldung:** `GET /api/whoami` antwortet ohne Token mit 200 und einer anonymen Person, erst mit `only_allow_authenticated=true` mit 401.
- **Fehlendes Recht:** Die Seitenliste einer Kategorie ohne Leserecht antwortet mit 403, die übergreifende Seitenliste mit einem Filter auf dieselbe Kategorie mit 200 und einer leeren Liste.
- **Wiki-Seiten:** Sie haben kein Feld `id`, sondern `identifier` und `guid`, und die Pfade funktionieren mit `identifier`. Die Listen enthalten keinen Text. `version` und `isMarkdown` stehen in jeder Version. Jede Seite trägt zusätzlich ein Objekt unter einem Schlüssel, den die Proben wegen des «@» nicht benennen, von Hand beobachtet als `@deprecated`. Jede Antwort nennt Vor- und Nachname und `guid` der Person, die eine Seite angelegt und zuletzt geändert hat.

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
- Ändert ChurchTools den Typ eines Felds oder fehlt ein Pflichtfeld, schlägt die Prüfung fehl, statt still falsche Daten weiterzugeben. Der lokale Vertragsabgleich soll solche Änderungen vorher zeigen.
- **Unbekannte Felder:** Ein Feld, das ein Schema nicht kennt, verwirft der Client ohne Fehler. Ein neues Feld von ChurchTools bricht so keinen Aufruf und erreicht trotzdem kein Tool. Das gilt auch für die Namen der Personen in Wiki-Antworten, solange kein Tool sie braucht.
- **Anmeldung prüfen:** Ob ein Token gilt, prüft der Client nur mit `GET /api/whoami` und `only_allow_authenticated=true`. Ohne den Parameter ergibt auch ein fehlendes Token 200.
- **Fehlerschema:** Das Schema der Fehlerantworten nimmt keine Felder auf, die Werte aus der Anfrage tragen, also weder die Meldungstexte noch `args`. Den Fall bestimmt der Statuscode.
- `zod` kommt mit dem ersten Schema in Phase 1 als Abhängigkeit dazu, begründet im Commit. Dass es nicht gebündelt wird und das Register für Klassifikationen hält, legt ADR 0022 fest.
- Restrisiken: Solange keine Kopie des Dokuments im Repository liegt, läuft der Vertragsabgleich nicht in CI. Eine Änderung der API zeigt sich dann erst, wenn jemand ihn lokal ausführt oder eine Antwort im Betrieb an ihrem Schema scheitert.
- Offen: das Format der Datumsfelder, welche Felder das Dokument als optional oder nullable deklariert und ob es `@deprecated` deklariert. Das klärt der Vertragsabgleich in Phase 1. Die genaue Obergrenze von `limit`, die Darstellung von «alle» in der Rechte-Antwort, die Namen der Fehlerfelder, welches Feld `@deprecated` ablöst und ob die Pfade auch eine `guid` annehmen, zeigt nur eine Instanz. Das klären Proben oder Tests des Clients an der Testinstanz in Phase 1 (ADR 0049).

## Umsetzung

- Der Ort des rohen Clients steht fest: `packages/core/src/churchtools/` (ADR 0024).
- Schemas, Prüfung im Client und der lokale Vertragsabgleich folgen in Phase 1.
- Die Befunde der Proben, auf die sich der Kontext stützt, stehen in `docs/research/churchtools-api.md`.
