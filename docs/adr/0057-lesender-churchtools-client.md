# ADR 0057: Lesender ChurchTools-Client

- Status: Vorgeschlagen
- Datum: 17.10.2026
- Fällt vor: Phase 1

## Kontext

Die Tools des Kerns lesen ChurchTools über die `ReadApi` der Plugin-Schnittstelle, in Phase 1 nur das eigene Konto (`whoami`) und dessen Rechte. Zwischen der `ReadApi` und dem Transport aus ADR 0056 fehlt ein Client: Er baut die Anfragen, liest die Antworten in festen Grenzen, prüft sie mit eigenen Schemas (ADR 0025) und macht aus jedem Status und jeder Abweichung einen Fehler mit festem Code (ADR 0054). Die Antworten kommen von einer Instanz, die der Betreiber nicht kontrolliert, und können Text aus der Gemeinde, aber auch gezielt geformte Daten enthalten.

Folgende Entscheide und Befunde geben den Rahmen vor:

- **ADR 0023:** Nur der Header `Authorization: Login <token>`, nie die Query, nie ein Cookie. Ob ein Token gilt, zeigt nur `GET /api/whoami` mit `only_allow_authenticated=true`.
- **ADR 0025:** Eigene zod-Schemas. Ein unbekanntes Feld verwirft der Client ohne Fehler, ein falscher Typ oder ein fehlendes Pflichtfeld ist ein Fehler. Das Fehlerschema nimmt keine Felder auf, die Werte aus der Anfrage tragen.
- **ADR 0051:** Kein Zustand über eine Anfrage hinaus, mit zwei benannten Ausnahmen, dem Pool der Verbindungen und dem Zähler der Drosselung je Instanz.
- **ADR 0056:** Ein Transport je Origin, nur GET, feste Kopfzeilen, ganze Antwort bis zur Grenze des Aufrufs, Status nur 200 bis 299 und 400 bis 599, Fehler mit fester Kategorie.
- **Befunde an ChurchTools 3.137** (`docs/research/churchtools-api.md`): Ohne `only_allow_authenticated=true` antwortet whoami auf ein ungültiges Token mit 200 und einer anonymen Person mit leerer `guid` und leerem `firstName` (F4), mit dem Parameter mit 401 (F23). Die Rechte kommen als Module mit Namen und Werten, ein Wert ist ein Wahrheitswert oder eine Liste von IDs (F5, F30). Listen tragen `meta.pagination` mit `total`, `limit`, `current` und `lastPage` oder nur `meta.count` (F6). Wiederholte Werte gehen als `ids[]` (F24). Fehlerkörper wiederholen gesendete Werte unter `errors` (F28). Beobachtet sind die Status 200, 201, 204, 400, 401, 403, 404 und 500, nie ein 3xx oder ein 429 und keine Kopfzeile zum Rate-Limit (F14, F22). ChurchTools begrenzt Anfragen inoffiziell auf 600 je Minute und IP-Adresse (F14).
- **JSON:** RFC 8259 verbietet dem Sender ein BOM (Abschnitt 8.1). `JSON.parse` hat keine Grenze für Tiefe oder Zahl der Elemente.

## Optionen

1. **Client ohne eigene Prüfungen, die Pipeline prüft:** wenig Code, aber jede Stelle, die den Client benutzt, müsste Grenzen und Status selbst behandeln, und geparst wäre schon ohne Grenze.
2. **Generierter Client aus dem OpenAPI-Dokument der Instanz:** deckt viele Operationen ab, übernimmt aber jedes Feld und jeden Typ des Dokuments, das für Rechte und Fehler nicht stimmt, und braucht eine Abhängigkeit.
3. **Eigener schmaler Client mit festen Operationen, Grenzen vor dem Parsen und eigenen Schemas:** mehr eigener Code, dafür prüft eine Stelle jede Antwort gleich.

## Entscheid

Gewählt ist die dritte Option.

- **Umfang:** In Phase 1 kennt der Client genau zwei Operationen, `whoami(ctx)` mit `GET /api/whoami?only_allow_authenticated=true` und `permissions(ctx)` mit `GET /api/permissions/global`. Dazu kommen geprüfte Bausteine für Seiten, Listen von IDs und die Metadaten von Listen. Ihre erste Nutzung kommt mit den Suchtools in Phase 1, für Listen von IDs ist sie offen. Nur GET. Jede Operation sendet genau eine Anfrage und folgt keiner weiteren Seite von sich aus.
- **Bau:** `createChurchToolsClient({ transport, origin, requestsPerMinute, clock })` prüft die Origin wie der Transport und wirft sonst einen `TypeError`. Er gibt ein eingefrorenes Objekt aus Closures zurück. Je Origin entsteht genau ein Client, auch spätere schreibende Operationen kommen in ihn und unter seine Drosselung. Dass Transport und Client zur selben Origin gehören, sichert die Composition Root.
- **Mandant:** Jeder Aufruf prüft zuerst, dass `ctx.instance` die Origin des Clients ist. Sonst endet er mit `internal`, bevor die Drosselung einen Platz vergibt und bevor eine Anfrage entsteht.
- **Anfragen:** Pfade sind Konstanten je Operation. Werte kommen nur als Parameter der Query hinein, nie aus einer URL, einem Pfad oder einer Kopfzeile des Aufrufers. Ab Phase 2 gilt für Pfadparameter eine positive Liste: Eine ID ist eine positive sichere ganze Zahl und steht als Dezimalziffern im Pfad. Eine GUID bekommt eine feste Form, sobald eine Probe sie gezeigt hat. Nach dem Bau prüft der Client, dass der Pfad genau der erwartete ist. Wiki-Seiten spricht er nur über die GUID an, Personen und Gruppen über die numerische ID. Seiten fragen immer `page` und `limit` an, `limit` von 1 bis 100, in Phase 1 nur die erste Seite mit höchstens 50 Einträgen. IDs gehen einzeln als `ids[]`.
- **Antwort lesen**, in fester Reihenfolge und ohne regulären Ausdruck über fremde Werte:
  1. Status. Nur 200 wird gelesen.
  2. Medientyp `application/json`, ohne Parameter und ohne Rücksicht auf Gross- und Kleinschreibung verglichen.
  3. Ein BOM am Anfang ist ein Fehler, nie wird es entfernt.
  4. UTF-8 streng dekodiert, ungültige Bytes sind ein Fehler.
  5. Vor dem Parsen höchstens 16 Ebenen und eine Grenze der Elemente je Operation, gezählt ausserhalb von Strings.
  6. `JSON.parse`. Die Wurzel muss ein Objekt sein.
  7. Je Operation die Vorprüfung, das Schema und die Abbildung auf ein eingefrorenes Ergebnis ohne Prototyp.

  Jede Abweisung ergibt `upstream`. Grenzen: whoami 256 KiB und 5'000 Elemente, die Rechte 1 MiB und 200'000 Elemente.

- **Status:** 200 wird gelesen, 401 ergibt `auth`, 403 `permission`, 429 sofort `rate_limited`. 400 ergibt `internal`, weil der Client jede Eingabe vor dem Senden prüft und ein 400 deshalb ein eigener Fehler oder eine geänderte API ist. 404 auf einem festen Pfad ergibt `upstream`, ebenso jeder andere Status. Den Körper einer Antwort ausser 200 liest der Client nie, also auch nicht `errors` mit den gesendeten Werten.
- **Retry-After:** Nur ganze Sekunden von 1 bis 3600 gelten. Dann nennt die Nachricht die Wartezeit, sonst gilt der feste Satz von `rate_limited`. Der rohe Wert erscheint nie in einer Nachricht oder im Protokoll.
- **Schemas:** `z.object` verwirft unbekannte Felder. Strings haben eine Obergrenze, IDs sind positive sichere ganze Zahlen, in den Listen der Rechte auch 0. Ein String, der nicht wohlgeformt ist, ist ein Fehler. Schemas haben weder `transform` noch `preprocess`. Der Client fragt nur ab, ob ein Schema passt, nie Meldung oder Pfad eines Fehlers. Ergebnisse entstehen ohne Prototyp und eingefroren, nie durch Kopieren von Schlüsseln aus der Antwort.
- **whoami:** Vor dem Schema prüft der Client, ob die Antwort eine anonyme Person ist. Ist `data.guid` der leere String oder `meta.simulatingUserId` gesetzt, ergibt das `auth`. Diese Prüfung kommt zuerst, weil die anonyme Antwort bis auf `guid` und `firstName` nicht belegt ist und das volle Schema sie sonst als `upstream` abwiese. Den Vornamen nimmt sie nicht dazu, weil ein Dienstkonto ihn leer haben kann. Das Ergebnis trägt `id`, `firstName`, `lastName` und `email`. `email` ist ein Text oder `null`, ein leerer Text wird zu `null`.
- **Rechte:** Vor jedem Schema prüft der Client die Namen der Module und Rechte auf der geparsten Antwort: druckbares ASCII, 1 bis 100 Zeichen, nicht `__proto__`, `constructor` oder `prototype`, höchstens 100 Module mit je höchstens 500 Rechten. Die Prüfung kommt vor zod, weil `z.record` `__proto__` still entfernt und eine spätere Prüfung den Namen nie sähe. Ein Wert ist ein Wahrheitswert oder eine Liste von IDs ab 0 mit höchstens 10'000 Einträgen. Die 0 ist eine gewöhnliche ID und heisst nie «alle»: ChurchTools 3.137 führt sie bei sieben Rechten neben weiteren IDs, etwa bei den Kategorien des Wikis, und ältere Tabellen zählen ab 0. Sie gewährt also nur das Recht auf das Objekt 0. Eine negative oder gebrochene Zahl ergibt `unknown`. Übernommen werden nur `true` und nicht leere Listen. Jede Abweichung ergibt `unknown`, nie ein Teilergebnis. Fehler aus Status, Medientyp, Kodierung und Grenzen bleiben Fehler. `permissions()` belegt keine Anmeldung, das tut nur whoami.
- **Drosselung:** Der Client baut beim Bau eine eigene Drosselung, einen Eimer mit `requestsPerMinute` Anfragen je Minute und einer Kapazität von einem Sechstel davon, aufgerundet. Er nimmt je Anfrage einen Platz, nach der Prüfung des Mandanten und vor dem Transport. Ohne Platz endet der Aufruf sofort mit `rate_limited` und der Wartezeit in ganzen Sekunden, ohne Timer. Liefert die Uhr keine endliche Zahl oder wirft sie, füllt nichts auf. Der Eimer ist die benannte Ausnahme aus ADR 0051: ohne Inhalte und Zugangsdaten, je Client, ein Neustart setzt ihn zurück, Prozesse teilen nichts.
- **Variable:** `ECCLIUM_CHURCHTOOLS_REQUESTS_PER_MINUTE`, eine ganze Zahl von 1 bis 500, voreingestellt 300. Mit der Kapazität von einem Sechstel kommen in einer Minute höchstens 350 Anfragen zusammen, bei 500 höchstens 584, beides unter der Grenze je IP-Adresse.
- **Kein Cache, keine Wiederholung:** whoami und die Rechte werden bei jedem Aufruf neu gelesen. Der Client wiederholt nichts, auch nicht bei 5xx oder einem Fehler des Netzes.
- **Abbruch:** `ctx.signal` geht unverändert an den Transport. Fehler des Transports gibt der Client unverändert weiter.
- **Protokoll:** Der Client schreibt nur über `ctx.log`, mit festen Ereignissen je Operation und nur den Feldern `status` und `code`. Pfad, Namen, Werte, Medientyp und Retry-After schreibt er nie. Die Zeile je Anfrage schreibt der Transport.
- **User-Agent und Cookies:** Der User-Agent hat die Form `Ecclium/<version>` mit der Version des Produktpakets. Quelle und Setzen kommen mit der Composition Root, der Client setzt keinen. Cookies sieht der Client nie, der Transport verwirft sie.
- **Vertragsabgleich:** Eine Beschreibung der Schemas als JSON Schema im Modus `input` liegt im Repository und wird in einem Test festgehalten. Ein Skript gleicht sie lokal mit dem OpenAPI-Dokument der Instanz ab und gibt nur Struktur aus. Es läuft nicht in CI. Der Modus `input` gilt, weil der Abgleich prüft, was ChurchTools sendet, und `output` jedes Objekt fälschlich als geschlossen beschriebe.

## Konsequenzen

- Jede Antwort von ChurchTools geht durch dieselben Grenzen, bevor sie geparst wird, und kein Text aus einem Fehlerkörper erreicht Modell, Protokoll oder Nachricht.
- Ein Status oder eine Form, die der Client nicht kennt, ergibt einen Fehler statt eines geratenen Ergebnisses. Eine geänderte API fällt so auf, kostet aber Verfügbarkeit, bis Schema oder Grenze nachgeführt sind.
- Die Grenzen sind nicht genau gemessen. Im ersten Lauf gegen die Testinstanz lagen beide Antworten unter 16 KiB.
- Die Drosselung schützt das Kontingent der Gemeinde vor Ecclium selbst, nicht vor anderen Programmen hinter derselben IP-Adresse. Ein 429 leert den Eimer nicht.
- `email-exact` aus der Suche nach Personen geht nicht durch die Prüfung der Namen im Transport, weil er einen Bindestrich enthält. Kein Tool in Phase 1 braucht ihn.
- **Restrisiken:**
  - **Form von «Alle»:** Wie ChurchTools «Alle» bei `view alldata`, `security level person` und `security level group` kodiert, ist nicht belegt. Hat es eine andere Form als eine Liste von IDs, sind die Rechte eines solchen Kontos `unknown`. Das sperrt nur das Schreiben.
  - **Namen der Rechte:** Im ersten Lauf war jeder Name druckbares ASCII. Liefert eine andere Instanz oder Version einen anderen Namen, sind ihre Rechte immer `unknown`.
  - **Ungültiges Token bei den Rechten:** Im ersten Lauf antwortete `GET /api/permissions/global` auf ein ungültiges Token mit 401. Belegt ist das nur für diese Version, deshalb belegt weiterhin nur whoami eine Anmeldung.
  - **Kodierung:** Im ersten Lauf antwortete ChurchTools mit `accept-encoding: identity` unkomprimiert. Belegt ist das für ChurchTools 3.137.

## Umsetzung

- **Client:** `packages/core/src/churchtools/` mit `client.ts` (Fabrik, `whoami`, `permissions`), `request.ts` (Reihenfolge von Mandant, Drosselung, Transport und Lesen), `answer.ts`, `json-shape.ts` und `retry-after.ts` (Lesen der Antwort), `query.ts` (Seiten und `ids[]`), `schemas.ts` und `rights.ts`. Kein Einstieg von core gibt den Client weiter.
- **Drosselung:** `packages/core/src/throttle/`, nur vom Client gebaut.
- **Variable:** `ECCLIUM_CHURCHTOOLS_REQUESTS_PER_MINUTE` in `packages/core/src/config/variables.ts` (ADR 0055).
- **Vertragsabgleich:** `packages/core/src/churchtools/contract.json`, festgehalten von `contract.test.ts`, und `scripts/contract/check.mts` mit README.
- **Tests:** `packages/core/src/churchtools/*.test.ts` und `packages/core/src/throttle/*.test.ts` über das Double für ChurchTools aus testkit decken beide Ordner zu 100 Prozent ab.
- **Erster Lauf:** am 17.10.2026 gegen die Testinstanz, mit dem Vertragsabgleich. Die Befunde stehen in `docs/research/churchtools-api.md` (Rechte, Weitere Befunde).
- Offen: die Form von «Alle» bei den Rechten für Personen und Gruppen (`docs/STATUS.md`, Offen).
