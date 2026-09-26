# API-Spike: lesende Proben

Diese Skripte prüfen, wie sich die REST-API von ChurchTools bei einer echten Instanz verhält: Anmeldung mit einem Token, Rechte, Paginierung, Fehler und Wiki. Sie lesen nur, und sie geben nur die Struktur der Antworten aus, nicht deren Inhalt. Die Ergebnisse fliessen in `docs/research/churchtools-api.md` ein.

Die Proben verringern das Risiko, dass Daten Ihrer Gemeinde in eine Ausgabe geraten. Ausschliessen können sie es nicht. Lesen Sie deshalb jede Ausgabe durch, bevor Sie sie weitergeben (siehe «Durchsicht vor dem Weitergeben»).

## Was die Proben lesen

| Probe                      | Liest                                                                                                                                                                                                                                                                                                                | Beantwortet                                                                                                                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `00-inventory.mts`         | `GET /system/runtime/swagger/openapi.json`, `GET /api/info`                                                                                                                                                                                                                                                          | Version von ChurchTools als Haupt- und Nebennummer. Für jede Operation der Proben, ob Ihre Instanz sie dokumentiert. Die übrigen Pfade nennt die Probe nicht, weil sie zeigen würden, welche Module aktiv sind. |
| `01-auth.mts`              | `GET /api/whoami` sechsmal: mit dem Token, ohne Token und mit einem ungültigen Zufallswert, jeweils mit und ohne `only_allow_authenticated=true`                                                                                                                                                                     | Ob das Token angenommen wird, Struktur von `whoami`, Format einer 401-Antwort, was eine Anfrage ohne Anmeldung erhält und ob eine Antwort ein Cookie setzt.                                                     |
| `02-permissions.mts`       | `GET /api/permissions/global`                                                                                                                                                                                                                                                                                        | Struktur der Rechte des Dienstkontos und ihr Umfang, als Wahrheitswerte und Anzahlklassen.                                                                                                                      |
| `03-pagination-errors.mts` | `GET /api/wiki/pages` für die Testkategorie mit `limit` 1, 2, 100 und 1000, mit einer Seite hinter der letzten und mit ungültigen Werten für `page` und `limit`. `GET /api/wiki/categories/{id}/pages/{identifier}` mit einer zufälligen, unbekannten Kennung. Optional beide Seitenlisten der gesperrten Kategorie. | Wie die Paginierung arbeitet, Felder von `meta.pagination`, wirksame Obergrenze von `limit`, Format der Fehler 400, 404 und 403.                                                                                |
| `04-wiki-read.mts`         | `GET /api/wiki/categories/{id}/pages` für die Testkategorie, dann für höchstens drei Seiten daraus die Seite, ihre Versionen und die neueste Version                                                                                                                                                                 | Struktur von Seite und Versionsliste, ob die Felder `version` und `isMarkdown` vorkommen, ob die Version einer Seite der neuesten Version ihrer Liste entspricht.                                               |

In ChurchTools schreibt keine Probe etwas. Lokal legt `00-inventory` die State-Datei an. Sie enthält die Version und das OpenAPI-Dokument Ihrer Instanz, damit die übrigen Proben ihre Operationen darin nachschlagen können. Die Operationen zum Anlegen und Ändern von Wiki-Seiten schlägt `00-inventory` nur nach, aufgerufen werden sie nie.

Ausser `/api/info`, `/api/whoami`, `/api/permissions/global` und dem OpenAPI-Dokument liest keine Probe etwas ausserhalb der Testkategorie. Die einzige Ausnahme ist die gesperrte Kategorie, wenn Sie eine angeben: `03` fragt ihre Seitenlisten ab, um die Antwort 403 zu sehen. Wählen Sie dafür eine Kategorie ohne vertrauliche Seiten. Darf das Dienstkonto sie doch lesen, beschreibt die Ausgabe auch ihre Struktur.

Jede Probe sucht ihre Operationen vor dem ersten Aufruf im OpenAPI-Dokument Ihrer Instanz, über Methode und Pfad. Fehlt eine Operation dort, meldet die Probe «nicht dokumentiert» und ruft sie nicht auf.

## Anfragen

- Nur `GET`, nur an die Basis-URL.
- Das Token steht nur im Header `Authorization: Login`, nie in einer URL. Die Proben fordern keine Sitzung an.
- Die Proben folgen keiner Weiterleitung, sie brechen mit `HTTP_REDIRECT` ab.
- Jede Anfrage hat ein Zeitlimit von 20 Sekunden und eine Grössengrenze von 5 MiB, für das OpenAPI-Dokument 32 MiB.
- Eine Kennung aus einer Antwort kommt nur in einen Pfad, wenn sie die Form einer Kennung hat: eine positive ganze Zahl, oder höchstens 200 Zeichen aus ASCII-Buchstaben, Ziffern und `-_.~`, ohne Punkt oder Tilde am Anfang.
- Der User-Agent ist `ecclium-spike`, damit die Anfragen in Zugriffsprotokollen erkennbar sind.

## Was die Ausgabe enthält

Jede Probe schreibt JSON auf stdout und kurze Hinweise auf stderr. Auf stderr stehen zuerst die Version von Node.js und die SHA-256-Werte aller Dateien `.mts` und `.md` dieses Ordners. Vergleichen Sie sie mit der Beschreibung des Pull Requests, aus dem der Commit stammt.

- Texte erscheinen nur als «leer» oder «nicht leer», Zahlen nur als Typ, Anzahlen nur als Klasse: 0, 1, 2–9, 10–99, 100–999, ab 1000.
- Genaue Zahlen gibt es nur in `03`, weil die Frage sie verlangt: die Anzahl der gelieferten Einträge und das Echo von `limit`.
- Der einzige Wert aus der Instanz ist die Version von ChurchTools als Haupt- und Nebennummer, etwa `3.136`.
- Schlüssel erscheinen mit ihrem Namen, wenn das OpenAPI-Dokument Ihrer Instanz sie für diese Antwort deklariert. In `02` gilt stattdessen: Ein Schlüssel erscheint mit Namen, wenn er nur aus kleingeschriebenen Wörtern besteht. Dort werden Namen von Modulen und Rechten als Schlüssel erwartet, die das Dokument nicht einzeln aufzählt. Alle anderen Schlüssel erscheinen als `<key#1>`, `<key#2>` und so weiter.
- Kopfzeilen erscheinen mit Namen, wenn der Name auf einer festen Liste bekannter Kopfzeilen steht, etwa `content-type` oder `retry-after`, und mit der Klasse ihres Werts: Zahl, Datum oder Text. Alle anderen Kopfzeilen erscheinen nur als Anzahl.
- Cookies erscheinen nur als Anzahl und mit ihren Attributen, nie mit Name oder Wert, weil ein Name den Namen der Instanz tragen kann.
- Rechte in `02` und das Feld `isMarkdown` in `04` erscheinen als «wahr» oder «falsch».

## Sicherung vor jeder Ausgabe

Bevor eine Probe etwas ausgibt, prüft sie die ganze Ausgabe zweimal:

1. Jedes Wort muss bekannt sein: ein festes Wort der Proben, ein zugelassener Schlüssel oder die Version.
2. Kein zugelassener Schlüssel darf als ganzes Wort etwas enthalten, das aus der Instanz oder von Ihrem Rechner stammt: den Host und seine Teile, das Token, die Werte der Variablen, Ihren Benutzernamen und Ihr Home-Verzeichnis, die Werte aller Kopfzeilen und Cookies und jede Zeichenkette und Zahl aus den Antworten. Gross- und Kleinschreibung zählen nicht, die URL-kodierte Form wird mitgeprüft.

Schlägt eine Prüfung an, gibt die Probe nur die Stellen der Treffer als JSON-Pointer aus und endet mit Code 3.

Die Werte des OpenAPI-Dokuments stehen nicht auf der Sperrliste. Das Dokument beschreibt die API, und die Ausgabe braucht seine Schlüssel. Enthält das Dokument Ihrer Instanz eigene Namen, etwa von Zusatzfeldern, können diese als Schlüssel erscheinen. Achten Sie bei der Durchsicht darauf.

## Voraussetzungen

- Node.js 24.21.0, wie in `.nvmrc`. Die Proben brauchen nur Node.js selbst, keine Pakete und kein `pnpm install`.
- Ein Dienstkonto in ChurchTools mit einem Login-Token. Es darf die Testkategorie lesen und sonst möglichst wenig.
- Eine Wiki-Kategorie nur für Tests, mit einigen Seiten aus erfundenem Inhalt, mindestens eine davon mit mehreren Versionen.
- Optional eine zweite Kategorie ohne vertrauliche Seiten, die das Dienstkonto nicht lesen darf.
- Ein privater Ordner ausserhalb jedes Git-Arbeitsbaums für Token, State-Datei und Ausgaben.

Die Proben prüfen Token-Datei und State-Datei vor dem Lesen: kein symbolischer Link, eine reguläre Datei, die Ihnen gehört, keine Rechte für andere, ausserhalb jedes Git-Arbeitsbaums. Die Token-Datei enthält genau eine Zeile aus druckbaren ASCII-Zeichen und ist höchstens 4 KiB gross. Die State-Datei legt `00-inventory` selbst an, mit Modus 0600. Sie darf vorher nicht existieren.

## Ausführung

Die Befehle sind für zsh und bash geschrieben. Ersetzen Sie die Werte in Grossbuchstaben und die Adresse der Instanz.

1. Legen Sie die Variablen für diese Sitzung fest. `SHA` ist der Commit aus dem Pull Request, dessen Skripte Sie geprüft haben. Ohne gesperrte Kategorie lassen Sie `GESPERRT` leer.

   ```bash
   D="$HOME/.config/ecclium-spike"
   URL=https://example.church.tools
   KATEGORIE=KATEGORIE_ID
   GESPERRT=GESPERRTE_KATEGORIE_ID
   SHA=COMMIT_AUS_DEM_PULL_REQUEST
   ```

2. Legen Sie den privaten Ordner und eine leere Token-Datei an. `~/.config` muss dafür bestehen:

   ```bash
   mkdir -m 700 "$D" "$D/ausgabe"
   (umask 077 && touch "$D/token")
   ```

   Öffnen Sie `$D/token` in einem Editor und fügen Sie das Token als einzige Zeile ein. Geben Sie es nicht auf der Kommandozeile ein, sonst steht es in der History der Shell.

3. Holen Sie die Skripte des geprüften Commits aus dem Klon des Repositorys, nicht aus einem Arbeitsbaum mit lokalen Änderungen, und bestimmen Sie den Pfad zu Node.js:

   ```bash
   R="$D/lauf-$SHA"
   mkdir -m 700 "$R"
   git archive "$SHA" scripts/spike | tar -x -C "$R"
   NODE="$(mise which node)"
   "$NODE" --version
   ```

4. Führen Sie `00-inventory` aus. `env -i` startet die Probe ohne Ihre übrigen Umgebungsvariablen. Vergleichen Sie danach die SHA-256-Werte auf dem Bildschirm mit dem Pull Request.

   ```bash
   env -i ECCLIUM_SPIKE_BASE_URL="$URL" ECCLIUM_SPIKE_TOKEN_FILE="$D/token" ECCLIUM_SPIKE_STATE_FILE="$D/state.json" "$NODE" "$R/scripts/spike/00-inventory.mts" > "$D/ausgabe/00-inventory.json"
   echo "Code $?"
   ```

5. Führen Sie die übrigen Proben aus:

   ```bash
   for P in 01-auth 02-permissions 03-pagination-errors 04-wiki-read; do
     env -i ECCLIUM_SPIKE_BASE_URL="$URL" ECCLIUM_SPIKE_TOKEN_FILE="$D/token" ECCLIUM_SPIKE_STATE_FILE="$D/state.json" ECCLIUM_SPIKE_WIKI_CATEGORY_ID="$KATEGORIE" ECCLIUM_SPIKE_FORBIDDEN_CATEGORY_ID="$GESPERRT" "$NODE" "$R/scripts/spike/$P.mts" > "$D/ausgabe/$P.json"
     echo "$P: Code $?"
   done
   ```

Eine Probe bricht vor der ersten Anfrage ab, wenn `NODE_OPTIONS`, `NODE_DEBUG`, `NODE_PATH` oder `NODE_EXTRA_CA_CERTS` gesetzt ist oder `NODE_TLS_REJECT_UNAUTHORIZED=0` gilt. Diese Variablen könnten fremden Code laden oder ein fremdes Zertifikat gelten lassen, über das jemand das Token mitlesen könnte. Mit `env -i` sind sie nicht gesetzt.

## Codes

| Code | Bedeutung                                                                                                                                                                                          |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Ausgabe geschrieben.                                                                                                                                                                               |
| 2    | Eine Variable oder Datei fehlt, eine Datei ist unsicher, oder die Umgebung ist unsicher. Der Hinweis auf stderr nennt den Grund. Die Probe hat in diesem Fall in der Regel keine Anfrage gesendet. |
| 3    | Ausgabe zurückgehalten, siehe «Sicherung vor jeder Ausgabe».                                                                                                                                       |
| 4    | Netz oder Antwort: `NETZ_DNS`, `NETZ_VERBINDUNG`, `NETZ`, `TLS`, `TIMEOUT`, `HTTP_REDIRECT`, `ANTWORT_ZU_GROSS` oder `ANTWORT_UNGUELTIG`.                                                          |
| 70   | Unerwarteter Fehler in der Probe (`INTERN`).                                                                                                                                                       |

Fehler erscheinen nur als fester Code mit einem festen Hinweis, nie mit einer Meldung oder einem Stack, weil diese Daten aus einer Antwort enthalten könnten.

## Durchsicht vor dem Weitergeben

1. Öffnen Sie jede Datei in `$D/ausgabe` und lesen Sie sie ganz. Erwartet sind nur Wörter der Proben, Schlüssel der API, Klassen, Statuscodes und die Version.
2. Suchen Sie nach allem, was Ihre Instanz, Ihre Gemeinde oder Personen erkennbar macht: Host, Namen, Gruppen, IDs.
3. Prüfen Sie die Ausgaben im Klon des Repositorys mit gitleaks und den Regeln des Projekts, und zusätzlich mit einem eigenen Mustersatz, falls Sie einen mit den Namen Ihrer Instanz und Gemeinde pflegen:

   ```bash
   mise exec -- gitleaks dir --redact --no-banner --config .gitleaks.toml "$D/ausgabe"
   ```

4. Geben Sie nur Dateien weiter, die diese Durchsicht bestanden haben.

## Aufräumen

- Löschen Sie den Ordner `$R`, die State-Datei und die Ausgaben, sobald die Ergebnisse im Research-Dokument stehen. Die State-Datei enthält das vollständige OpenAPI-Dokument Ihrer Instanz.
- Machen Sie das Token nach dem Spike ungültig oder deaktivieren Sie das Dienstkonto.

## Tests

Die Tests in `tests/spike/` laufen mit `pnpm test`, ohne Netz, gegen eine synthetische Instanz, deren Antworten voller Kanarienwerte sind. Keiner dieser Werte darf in einer Ausgabe erscheinen. Woher die Testdaten stammen, steht in [`tests/fixtures/README.md`](../../tests/fixtures/README.md).
