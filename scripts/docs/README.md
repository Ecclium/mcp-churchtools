# Fakten des Doku-Index auffrischen

`pnpm docs:refresh` schreibt die vier Dateien unter `packages/docs-index/data/` aus ihren Quellen neu: die Fakten zu den Operationen, zu den Rechten und zu den Hilfeseiten der Academy und `SOURCES.json` (ADR 0027, ADR 0066). Keine Person schreibt diese Dateien von Hand. Das Skript läuft lokal, nie in CI und nie hinter der Netzsperre der Tests.

## Was es liest

- **Das OpenAPI-Dokument** aus der State-Datei der Probe `00-inventory` in `scripts/spike/`, ohne Anfrage. Führen Sie `00-inventory` unmittelbar vorher aus, damit Dokument und Version zur Instanz passen.
- **Die Rechte** mit einer Anfrage `GET /api/permissions/global` mit dem Konto der Token-Datei. Das Konto braucht dafür kein Recht. Die Antwort nennt jedes Recht, das die Instanz dem Konto zeigt, eines ohne Wert als `false` oder leere Liste. Übernommen werden nur Modul, Name und Art des Werts, nie ein Wert. Ein Name, der nicht nur aus kleinen Wörtern besteht, bleibt draussen und wird nur gezählt, weil er ein Wert der Instanz sein könnte.
- **Die Hilfeseiten der Academy** unter `https://churchtools.academy` über die Schnittstelle von WordPress, ohne Anmeldung und ohne Token, mit dem User-Agent `ecclium-docs-refresh` und mindestens drei Sekunden Pause zwischen zwei Abrufen. Zuerst liest es `robots.txt` und hält sich daran, auch an ein `Crawl-delay` bis 30 Sekunden. Es fragt nur nach Kennung, Slug, Link, Stand, letzter Änderung, Titel, Inhalt, Kategorien und Wissensbasen einer Seite, nie nach ihren Autorinnen und Autoren. Übernommen werden die deutschen Seiten der Abschnitte `personen`, `gruppen`, `events` (mit der Kategorie `songs`), `kalender`, `ressourcen`, `wiki`, `rechteverwaltung-verstehen`, `rechteverwaltung-anpassen` und `rechteverwaltung-nach-modulen`, dazu die Kategorie `api` im Abschnitt `integrationen`.

## Was es schreibt

- `operations.json`: je Operation `operationId`, Methode, Pfad, Tags, Texte, ob sie veraltet ist, Parameter, Anfrage und Antworten. Schemas reichen drei Schritte tief. Ein Schema, das einem Schema unter `components` gleicht, trägt dessen Namen. Ohne `servers`, Beispiele, Vorgaben, Erweiterungen und die Operationen mit `x-internal`.
- `rights.json`: je Recht Modul, Name und Art des Werts. Bezeichnungen und erklärende Seiten bringt erst die Zuordnung von Operationen zu Rechten.
- `academy.json`: je Hilfeseite Pfad, Titel, Abschnitt, Wissensbasis, Tag der letzten Änderung und Text als Markdown in beschränkter Form: Überschriften, Absätze, Listen, Tabellen und Code. Bilder, Videos, eingebettete Rahmen, Abbildungen mit ihrer Unterschrift, Skripte und Formulare entfallen mit ihrem Inhalt. Ein Link bleibt nur, wenn er auf eine deutsche Seite der Academy zeigt, als Pfad. Von jedem anderen Link bleibt der Text.
- `SOURCES.json`: je Quelle die Abrufzeit in UTC und einen SHA-256. Beim OpenAPI-Dokument ist es der SHA-256 des Dokuments in kompakter JSON-Form, wie die State-Datei es hält, und die Abrufzeit ist die Zeit, zu der `00-inventory` die State-Datei schrieb. Bei den Rechten ist es der SHA-256 der Antwort in kompakter JSON-Form, bei der Academy der SHA-256 des HTML jeder Seite.

In jedem Text entfernt es Steuerzeichen und Zeichen, die man nicht sieht, etwa weiche Trennzeichen und Leerzeichen ohne Breite, und schreibt ihn in NFKC. Ein Host einer Instanz unter `church.tools` wird `example.church.tools`. Jede andere URL und jeder andere Host ausser dem der Academy wird «(Link entfernt)», in Texten des OpenAPI-Dokuments «(link removed)», eine E-Mail-Adresse «(E-Mail-Adresse entfernt)». Ein `<`, mit dem ein Tag beginnen könnte, wird `&lt;`, auch in Code.

Hat eine Quelle eine Form, die das Format nicht fassen kann, etwa eine andere Lizenz als CC BY 4.0, eine unbekannte Art eines Schemas oder einen Link ausserhalb der deutschen Seiten der Academy, bricht es ab, nennt die Stelle mit Feldnamen und Nummern und schreibt keine Datei.

Nach stdout gehen nur Zahlen, Grössen und feste Wörter, nie ein Text, ein Link oder ein Host einer Quelle. Dafür sorgt dieselbe Sicherung wie bei den Proben.

## Aufruf

Mit denselben Variablen wie die Proben, nach `00-inventory`:

```bash
ECCLIUM_SPIKE_BASE_URL=https://example.church.tools ECCLIUM_SPIKE_TOKEN_FILE=/pfad/zur/token-datei ECCLIUM_SPIKE_STATE_FILE=/pfad/zur/state-datei pnpm docs:refresh
pnpm build
pnpm check
```

Token-Datei und State-Datei müssen ausserhalb jedes Git-Arbeitsbaums liegen und dürfen nur von Ihrem Benutzer lesbar sein. `pnpm build` und `pnpm check` prüfen die neuen Dateien mit allen Regeln aus ADR 0066. Sehen Sie die Änderungen unter `packages/docs-index/data/` vor einem Commit durch.

Mit `pnpm docs:refresh --kategorien` liest das Skript nur die Kategorien der Academy und gibt ihre Slugs nach Abschnitt aus, etwa um zu entscheiden, ob eine Kategorie ausserhalb der Abschnitte dazukommt. Es schreibt dann nichts.
