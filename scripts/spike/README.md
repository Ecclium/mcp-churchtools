# API-Spike: lesende Proben

Diese Skripte prüfen, wie sich die REST-API von ChurchTools bei einer echten Instanz verhält: Anmeldung mit einem Token, Rechte, Paginierung, Fehler und Wiki. Sie lesen nur, und sie geben nur die Struktur der Antworten aus, nicht deren Inhalt. Die Ergebnisse fliessen in `docs/research/churchtools-api.md` ein.

Die Proben verringern das Risiko, dass Daten Ihrer Gemeinde in eine Ausgabe geraten. Ausschliessen können sie es nicht. Lesen Sie deshalb jede Ausgabe durch, bevor Sie sie weitergeben (siehe «Durchsicht vor dem Weitergeben»).

## Was die Proben lesen

| Probe                      | Liest                                                                                                                                                                                                                                                                                                                | Beantwortet                                                                                                                                                                                                                                                                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `00-inventory.mts`         | `GET /system/runtime/swagger/openapi.json`, `GET /api/info`                                                                                                                                                                                                                                                          | Version von ChurchTools als Haupt- und Nebennummer. Für jede Operation der Proben, ob Ihre Instanz sie dokumentiert. Die übrigen Pfade nennt die Probe nicht, weil sie zeigen würden, welche Module aktiv sind. Von der Antwort auf `/api/info` zeigt sie nur Status und Version, weil diese Antwort Name und Einstellungen der Instanz enthält. |
| `01-auth.mts`              | `GET /api/whoami` sechsmal: mit dem Token, ohne Token und mit einem ungültigen Zufallswert, jeweils mit und ohne `only_allow_authenticated=true`                                                                                                                                                                     | Ob das Token angenommen wird, Struktur von `whoami`, Format einer 401-Antwort, was eine Anfrage ohne Anmeldung erhält und ob eine Antwort ein Cookie setzt.                                                                                                                                                                                      |
| `02-permissions.mts`       | `GET /api/permissions/global`                                                                                                                                                                                                                                                                                        | Struktur der Rechte des Dienstkontos und ihr Umfang, als Wahrheitswerte und Anzahlklassen.                                                                                                                                                                                                                                                       |
| `03-pagination-errors.mts` | `GET /api/wiki/pages` für die Testkategorie mit `limit` 1, 2, 100 und 1000, mit einer Seite hinter der letzten und mit ungültigen Werten für `page` und `limit`. `GET /api/wiki/categories/{id}/pages/{identifier}` mit einer zufälligen, unbekannten Kennung. Optional beide Seitenlisten der gesperrten Kategorie. | Wie die Paginierung arbeitet, Felder von `meta.pagination`, wirksame Obergrenze von `limit`, Format der Fehler 400, 404 und 403.                                                                                                                                                                                                                 |
| `04-wiki-read.mts`         | `GET /api/wiki/categories/{id}/pages` für die Testkategorie, dann für höchstens drei Seiten daraus die Seite, ihre Versionen und die neueste Version                                                                                                                                                                 | Struktur von Seite und Versionsliste, ob die Felder `version` und `isMarkdown` vorkommen, ob die Version einer Seite der neuesten Version ihrer Liste entspricht.                                                                                                                                                                                |

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
- Schlüssel erscheinen mit ihrem Namen, wenn das OpenAPI-Dokument Ihrer Instanz sie für diese Antwort deklariert. In `02` gilt stattdessen: Ein Schlüssel erscheint mit Namen, wenn er nur aus kleingeschriebenen Wörtern besteht. Dort werden Namen von Modulen und Rechten als Schlüssel erwartet, die das Dokument nicht einzeln aufzählt. Ein deklarierter Schlüssel erscheint nur mit Namen, wenn er die Form eines Bezeichners hat: höchstens 64 Zeichen aus ASCII-Buchstaben, Ziffern, `_` und `$`, ohne Ziffer am Anfang. Ein Schlüssel wie `@deprecated` erscheint deshalb immer ohne Namen. Alle anderen Schlüssel erscheinen als `<key#1>`, `<key#2>` und so weiter.
- Kopfzeilen erscheinen mit Namen, wenn der Name auf einer festen Liste bekannter Kopfzeilen steht, etwa `content-type` oder `retry-after`, und mit der Klasse ihres Werts: Zahl, Datum oder Text. Alle anderen Kopfzeilen erscheinen nur als Anzahl.
- Cookies erscheinen nur als Anzahl und mit ihren Attributen, nie mit Name oder Wert, weil ein Name den Namen der Instanz tragen kann.
- Rechte in `02` und das Feld `isMarkdown` in `04` erscheinen als «wahr» oder «falsch».

## Sicherung vor jeder Ausgabe

Bevor eine Probe etwas ausgibt, prüft sie die ganze Ausgabe zweimal:

1. Jedes Wort muss bekannt sein: ein festes Wort der Proben, ein zugelassener Schlüssel oder die Version.
2. Kein zugelassener Schlüssel darf als ganzes Wort etwas enthalten, das aus der Instanz oder von Ihrem Rechner stammt: den Host und seine Teile, das Token, die Werte der Variablen, Ihren Benutzernamen und Ihr Home-Verzeichnis, die Werte aller Kopfzeilen und Cookies und jede Zeichenkette und Zahl aus den Antworten. Gross- und Kleinschreibung zählen nicht, die URL-kodierte Form wird mitgeprüft.

Eine Ausnahme gilt für Schlüssel, die das OpenAPI-Dokument Ihrer Instanz an ihrer Stelle deklariert: Ein Wert aus einer Antwort, der genau so lautet wie der ganze Schlüssel, sperrt ihn nicht, ohne Rücksicht auf Gross- und Kleinschreibung. Solch ein Schlüssel steht in der Ausgabe, weil das Dokument ihn nennt. ChurchTools schickt solche Werte selbst, etwa `{"@deprecated": {"identifier": "guid"}}` in jeder Wiki-Seite oder den Namen eines Modells wie `WikiPage` in einer Fehlerantwort. Ein Wert, der als ganzes Wort nur Teil eines Schlüssels ist, sperrt ihn weiter. Der Host und seine Teile, das Token, die Werte der Variablen, Ihr Benutzername, Ihr Home-Verzeichnis und die Werte der Kopfzeilen und Cookies sperren auch einen gleichlautenden Schlüssel. Die Namen der Rechte aus `02-permissions` prüft die Sicherung ohne diese Ausnahme. Nennt das OpenAPI-Dokument Ihrer Instanz einen eigenen Namen als Schlüssel und kommt derselbe Name als Wert in einer Antwort vor, hält die Sicherung ihn nicht mehr zurück. Achten Sie bei der Durchsicht darauf.

Schlägt eine Prüfung an, gibt die Probe nur die Stellen der Treffer als JSON-Pointer aus und endet mit Code 3.

Vom Host stehen der ganze Name, der Port und jeder Teil auf der Sperrliste, auch in der Schreibweise mit Umlauten und bei einer IPv6-Adresse jede Gruppe. Ausgenommen sind nur bei Instanzen unter `church.tools` die Wörter «church» und «tools», die alle diese Instanzen teilen. Sonst würde schon ein Recht wie «admin church category» jede Ausgabe von `02-permissions` zurückhalten.

Die Werte des OpenAPI-Dokuments stehen nicht auf der Sperrliste. Das Dokument beschreibt die API, und die Ausgabe braucht seine Schlüssel. Enthält das Dokument Ihrer Instanz eigene Namen, etwa von Zusatzfeldern, können diese als Schlüssel erscheinen. Achten Sie bei der Durchsicht darauf.

## Voraussetzungen

- Node.js 24.21.0, wie in `.nvmrc`. Die Proben brauchen nur Node.js selbst, keine Pakete und kein `pnpm install`.
- Ein Dienstkonto in ChurchTools mit einem Login-Token. Es darf das Wiki sehen und die Testkategorie lesen, sonst nichts. Beim Recht «Einzelne Wiki-Kategorien sehen» wählen Sie nur die Testkategorie, nie «alle». In ChurchTools kann auch ein Personenstatus Rechte vergeben. Auf einer Testinstanz mit synthetischen Daten brachte jeder vorgegebene Status bis auf einen eigene Rechte mit, etwa auf Personendaten und Kalender. Geben Sie dem Dienstkonto deshalb einen eigenen Status ohne Berechtigungen, und nehmen Sie es in keine Gruppe auf. Ob es nur die beiden Rechte hat, zeigt `02-permissions` (Schritt 6), soweit `GET /api/permissions/global` alle Rechte nennt. Ob diese Antwort auch Rechte aus Gruppen enthält, ist ungeprüft.
- Eine Wiki-Kategorie nur für Tests, mit einigen Seiten aus erfundenem Inhalt, mindestens eine davon mit mehreren Versionen. `04` liest höchstens drei Seiten in der Reihenfolge der Liste. Auf der Testinstanz beobachtet: Eine Seite, die Sie in der Weboberfläche anlegen, hat schon zwei Versionen, die erste ohne Text. In jeder neuen Kategorie legt ChurchTools von selbst eine leere Seite «main» an, die Kategorie hat also eine Seite mehr, als Sie angelegt haben.
- Optional eine zweite Kategorie ohne vertrauliche Seiten, die das Dienstkonto nicht lesen darf.
- Ein privater Ordner ausserhalb jedes Git-Arbeitsbaums für Token, State-Datei und Ausgaben.

Die Proben prüfen Token-Datei und State-Datei vor dem Lesen: kein symbolischer Link, eine reguläre Datei, die Ihnen gehört, keine Rechte für andere, ausserhalb jedes Git-Arbeitsbaums. Die Token-Datei enthält genau eine Zeile aus druckbaren ASCII-Zeichen und ist höchstens 4 KiB gross. Die State-Datei legt `00-inventory` selbst an, mit Modus 0600. Sie darf vorher nicht existieren. Existiert sie schon, bricht `00-inventory` mit Code 2 ab, bevor es eine Anfrage sendet.

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

   Wollen Sie `00-inventory` wiederholen, löschen Sie zuerst die State-Datei. Oder geben Sie in `ECCLIUM_SPIKE_STATE_FILE` eine neue an und danach allen Proben dieselbe. Leiten Sie die Ausgabe einer Wiederholung in eine neue Datei um: Die Shell leert die Zieldatei von `>` schon vor dem Start der Probe. Bricht `00-inventory` dann ab, weil die State-Datei existiert, ist die frühere Ausgabe leer.

5. Führen Sie `01-auth` und `02-permissions` aus:

   ```bash
   for P in 01-auth 02-permissions; do
     env -i ECCLIUM_SPIKE_BASE_URL="$URL" ECCLIUM_SPIKE_TOKEN_FILE="$D/token" ECCLIUM_SPIKE_STATE_FILE="$D/state.json" ECCLIUM_SPIKE_WIKI_CATEGORY_ID="$KATEGORIE" ECCLIUM_SPIKE_FORBIDDEN_CATEGORY_ID="$GESPERRT" "$NODE" "$R/scripts/spike/$P.mts" > "$D/ausgabe/$P.json"
     echo "$P: Code $?"
   done
   ```

6. Halten Sie hier an und prüfen Sie `02-permissions.json`, bevor `03` und `04` die Testkategorie lesen. Erwartet sind Code 0, unter `antwort` der Status 200 und im Modul `churchwiki` genau zwei Rechte: `view` mit «wahr» und `view category` mit `anzahl` «1». Jedes andere Recht steht auf «falsch» oder ist eine Liste mit `anzahl` «0». Dieser Befehl gibt jedes Recht aus, das nicht auf «falsch» steht und keine leere Liste ist, also auch die beiden erwarteten:

   ```bash
   env -i "$NODE" -e '
   let out = {};
   try { out = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); } catch {}
   const daten = out.antwort?.status === 200 ? out.antwort.struktur?.felder?.data : undefined;
   if (daten?.typ !== "Objekt") { console.log("ABBRUCH: keine Antwort 200 mit Rechten"); process.exit(1); }
   if (daten.weitereFelder) console.log("weitere Module nicht gezeigt");
   for (const [modul, rechte] of Object.entries(daten.felder)) {
     if (rechte.typ !== "Objekt" || rechte.weitereFelder) console.log(`${modul}: nicht vollständig gezeigt`);
     for (const [recht, w] of Object.entries(rechte.felder ?? {}))
       if (w.wert !== "falsch" && w.anzahl !== "0") console.log(`${modul}: ${recht}: ${w.wert ?? w.anzahl ?? w.typ}`);
   }
   ' "$D/ausgabe/02-permissions.json"
   ```

   Erwartet sind genau diese zwei Zeilen:

   ```text
   churchwiki: view: wahr
   churchwiki: view category: 1
   ```

   Steht dort etwas anderes, machen Sie nicht weiter. Schränken Sie die Rechte des Dienstkontos ein, wie unter «Voraussetzungen» beschrieben, und wiederholen Sie nur `02-permissions`. Die State-Datei bleibt gültig. Welche Kategorie das Konto lesen darf, zeigt `02` nicht.

7. Führen Sie `03-pagination-errors` und `04-wiki-read` aus:

   ```bash
   for P in 03-pagination-errors 04-wiki-read; do
     env -i ECCLIUM_SPIKE_BASE_URL="$URL" ECCLIUM_SPIKE_TOKEN_FILE="$D/token" ECCLIUM_SPIKE_STATE_FILE="$D/state.json" ECCLIUM_SPIKE_WIKI_CATEGORY_ID="$KATEGORIE" ECCLIUM_SPIKE_FORBIDDEN_CATEGORY_ID="$GESPERRT" "$NODE" "$R/scripts/spike/$P.mts" > "$D/ausgabe/$P.json"
     echo "$P: Code $?"
   done
   ```

   In `03` nennt der Eintrag in `limitTest` mit `angefragt` 100 unter `eintraege`, wie viele Seiten das Konto lesen kann, solange es weniger als 100 sind: Ihre Seiten der Testkategorie und die Seite «main». Stimmt die Zahl nicht, prüfen Sie `KATEGORIE` und die Rechte des Kontos.

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

Die Umleitung `>` legt die Zieldatei an oder leert sie, bevor die Probe startet. Bei Code 2, 4 und 70 bleibt sie leer. Bei Code 3 enthält sie nur `zurueckgehalten` und die Liste `stellen`. Eine frühere Ausgabe unter demselben Namen ist danach überschrieben.

## Durchsicht vor dem Weitergeben

1. Öffnen Sie jede Datei in `$D/ausgabe` und lesen Sie sie ganz. Erwartet sind nur Wörter der Proben, Schlüssel der API, Klassen, Statuscodes und die Version.
2. Suchen Sie nach allem, was Ihre Instanz, Ihre Gemeinde oder Personen erkennbar macht: Host, Namen, Gruppen, IDs.
3. Prüfen Sie die Ausgaben im Klon des Repositorys mit gitleaks und den Regeln des Projekts, und zusätzlich mit einem eigenen Mustersatz, falls Sie einen mit den Namen Ihrer Instanz und Gemeinde pflegen:

   ```bash
   mise exec -- gitleaks dir --redact --no-banner --config .gitleaks.toml "$D/ausgabe"
   ```

4. Geben Sie nur Dateien weiter, die diese Durchsicht bestanden haben.

## Aufräumen

1. Machen Sie das Token ungültig. Melden Sie sich als Dienstkonto an und erneuern Sie sein Login-Token, ohne das neue zu kopieren. Oder deaktivieren Sie das Dienstkonto.
2. Nach dem Erneuern prüfen Sie mit der alten Token-Datei, dass die Instanz das alte Token abweist:

   ```bash
   env -i ECCLIUM_SPIKE_BASE_URL="$URL" ECCLIUM_SPIKE_TOKEN_FILE="$D/token" ECCLIUM_SPIKE_STATE_FILE="$D/state.json" ECCLIUM_SPIKE_WIKI_CATEGORY_ID="$KATEGORIE" ECCLIUM_SPIKE_FORBIDDEN_CATEGORY_ID="$GESPERRT" "$NODE" "$R/scripts/spike/01-auth.mts" > "$D/ausgabe/01-auth-nach-erneuerung.json"
   echo "Code $?"
   ```

   Erwartet ist unter `anfragen.mitToken` der Status 401. Auf einer Testinstanz mit synthetischen Daten und ChurchTools 3.137 war das etwa zehn Sekunden nach dem Erneuern so. Steht dort 200, gilt das alte Token noch, deaktivieren Sie dann das Dienstkonto. Sehen Sie auch diese Ausgabe durch, bevor Sie sie weitergeben.

3. Löschen Sie danach die Token-Datei.
4. Löschen Sie den Ordner `$R`, die State-Datei und die Ausgaben, sobald die Ergebnisse im Research-Dokument stehen. Die State-Datei enthält das vollständige OpenAPI-Dokument Ihrer Instanz.

## Tests

Die Tests in `tests/spike/` laufen mit `pnpm test`, ohne Netz, gegen eine synthetische Instanz, deren Antworten voller Kanarienwerte sind. Keiner dieser Werte darf in einer Ausgabe erscheinen. Woher die Testdaten stammen, steht in [`tests/fixtures/README.md`](../../tests/fixtures/README.md).
