<picture>
  <source media="(prefers-color-scheme: dark)" srcset="logo/ecclium-logo-negativ.svg">
  <img src="logo/ecclium-logo.svg" alt="Ecclium" width="240">
</picture>

# Markenrichtlinie Ecclium

Version 1.3, Stand 26.09.2026

Neu in 1.3: Der feste Begriff «Rezept» heisst neu «Routine» (Kapitel 7 und 9, auch in der Kennzeichnung). Das Icon `icon-rezept.svg` ist durch `icon-routine.svg` mit neuem Motiv ersetzt.

Dieser Ordner enthält Logo, Icons, Farben, Schriften und die Regeln, nach denen Ecclium auftritt. Er richtet sich an alle, die Dokumentation, Oberflächen, Vorträge oder Beiträge über Ecclium gestalten. Für den Gebrauch von Name und Logo durch Dritte gilt [TRADEMARKS.md](../TRADEMARKS.md).

## Auf einen Blick

- **Claim:** KI nach den Regeln der Gemeinde.
- **Leitsatz:** Erst der Plan. Dann die Änderung.
- **Versprechen:** Ecclium nimmt der Gemeinde wiederkehrende Arbeit ab und legt über jeden Schritt Rechenschaft ab.
- **Eigenschaften:** verlässlich, offen, zugewandt, sorgfältig.
- **Farben:** Graphit `#1E2124`, Kalk `#F3F3EF`, Messing `#A57C2C`.
- **Schriften:** Archivo und DM Mono, beide frei lizenziert und selbst gehostet.
- **Bildsprache:** der Grundriss. Keine Fotos, keine Kirchensymbole, kein Funkelsymbol für KI.

## 1. Name

- Im Text immer «Ecclium» mit grossem E. Die Kleinschreibung gibt es nur in der Wortmarke.
- Produkte heissen «Ecclium» plus ein gewöhnliches Wort: heute **Ecclium MCP**. Keine Fantasienamen, keine eigenen Produktlogos.
- Die unterstützte Software steht nur als Zusatz: «Ecclium MCP für ChurchTools». ChurchTools erscheint nie im Logo und nie in einem Namen, der wie ein gemeinsames Produkt klingt.
- Wo ChurchTools genannt wird, steht dieser Hinweis: «Ecclium ist ein unabhängiges Projekt und steht in keiner Verbindung zum Hersteller von ChurchTools.»
- Technische Namen: Repository `ecclium/mcp-churchtools`, Paket `@ecclium/mcp-churchtools`.

## 2. Logo

Das Zeichen ist der Grundriss eines runden Raums. Die Aussenwand hat unten rechts einen Eingang, die Innenwand in Messing teilt den Raum. Zusammen ergeben sie ein kleines e. Die Wortmarke «ecclium» ist Archivo 600 in Breite 108, als Pfade gezeichnet.

### Welche Datei wofür

| Datei in `logo/` | Einsatz |
|---|---|
| `ecclium-logo.svg` | Standard auf hellem Grund |
| `ecclium-logo-negativ.svg` | auf Graphit und im dunklen Thema |
| `ecclium-logo-gestapelt.svg`, `-gestapelt-negativ.svg` | nur auf quadratischen Flächen |
| `ecclium-logo-einfarbig-graphit.svg`, `-einfarbig-weiss.svg` | nur wo keine zweite Farbe geht: Stempel, Gravur, Prägung |
| `ecclium-logo-currentcolor.svg`, `ecclium-zeichen-currentcolor.svg` | im Code, übernimmt die Textfarbe |
| `ecclium-zeichen.svg`, `-negativ.svg`, `-einfarbig-*.svg` | Zeichen allein, nur wo der Name schon daneben steht oder der Platz fehlt |
| `ecclium-wortmarke.svg`, `-negativ.svg` | Wortmarke allein, etwa in einer Fusszeile |

Dazu in `icon/` das App-Icon (Kachel in Graphit), der GitHub-Avatar, `favicon.svg` (passt sich hellem und dunklem Browser an) und `favicon.ico`. In `png/` liegen gerasterte Fassungen, in `social/` die Vorschaubilder für GitHub (1280 × 640) und Links (1200 × 630).

### Regeln

- **Schutzraum:** rundum mindestens ein halber Zeichendurchmesser. Dort steht kein Text, keine Linie, kein Bildrand.
- **Mindestgrösse:** Kombination 96 px breit oder 25 mm im Druck. Zeichen allein 16 px oder 5 mm. Unter 24 px das App-Icon oder `favicon.svg` verwenden.
- **Hintergrund:** Farbversion auf Kalk oder Weiss, Negativversion auf Graphit oder dunklem Grund. Nie auf unruhigen Bildern.
- **Nicht erlaubt:** drehen, spiegeln, verzerren; Farben von Wand und Innenwand tauschen; die Innenwand in der Farbversion weglassen; die Wortmarke in einer Schrift neu setzen; das Logo in Versalien; Konturen, Schatten, Verläufe; das Zeichen als Buchstaben in Wörtern; das Logo neben oder in einer Einheit mit dem Logo von ChurchTools.

### Einbinden

Logo im README im Hauptordner des Repositorys, hell und dunkel:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/logo/ecclium-logo-negativ.svg">
  <img src="brand/logo/ecclium-logo.svg" alt="Ecclium" width="240">
</picture>
```

Favicons auf Website und Doku. Browser mit SVG-Unterstützung nehmen `favicon.svg`, ältere die ICO-Datei. Die Angabe `sizes="32x32"` verhindert, dass Chrome die ICO-Datei vorzieht:

```html
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon-180.png">
```

Im Web-Manifest `ecclium-app-icon-192.png` und `ecclium-app-icon-512.png` eintragen. Als Social Preview des Repositorys `social/ecclium-social-preview-1280x640.png` hochladen (Einstellungen des Repositorys, Bereich Social preview).

## 3. Farbe

Marke und Funktion sind getrennt. Die Markenfarben gelten nur für Logo, App-Icon und Grundriss-Grafiken:

| Name | HEX | Rolle |
|---|---|---|
| Graphit | `#1E2124` | Wand des Zeichens, Text, dunkler Grund |
| Kalk | `#F3F3EF` | heller Grund, Wand auf Dunkel |
| Messing | `#A57C2C` | Innenwand, Akzent auf Hell |
| Messing hell | `#C9A55A` | Innenwand und Akzent auf Dunkel |

Oberflächen verwenden die Tokens aus `tokens/tokens.css`, hell und dunkel. Die wichtigsten Regeln:

- Text in `--ink` auf `--surface`, `--surface-raised` oder `--surface-sunken`, Sekundärtext in `--ink-muted`.
- Messing sparsam: `--accent` für Grafik, Fokus und Schrift ab 24 px, `--accent-text` für Überzeilen, `--accent-soft` als Fläche. Höchstens eine Hervorhebung in Messing pro Ansicht, nie Fliesstext in Messing.
- Eine Ansicht ist, was gleichzeitig zu sehen ist: ein Bildschirm der Anwendung, ein Abschnitt der Website, eine Folie. Eine Grundriss-Grafik zählt als eine Hervorhebung, auch wenn Messing darin mehrere Bedeutungen trägt (Kapitel 6). Jede davon ist beschriftet oder in der Legende erklärt, und daneben steht keine zweite Hervorhebung in Messing. Nicht als Hervorhebung zählen der Fokusring, die Unterstreichung leiser Buttons, Überzeilen und das Quadrat vor der Kennzeichnung.
- Eine Hauptaktion pro Ansicht in `--action` mit `--on-action`.
- Statusfarben (`--success`, `--warning`, `--danger`, `--info`, je mit `-soft`) nur für Zustände und immer mit Wort und Icon.
- Das dunkle Thema folgt der Systemeinstellung. Mit `data-theme="light"` oder `data-theme="dark"` am Element `html` lässt es sich festlegen.

Alle Textfarben erreichen auf ihren Flächen mindestens 4,5:1, in beiden Themen. `--accent` und `--control` erreichen mindestens 3:1.

## 4. Schrift

- **Archivo** für alles, was Menschen lesen. Titel breiter gesetzt: `font-variation-settings: "wdth" 112` für grosse Titel, 108 für Zwischentitel, Text in normaler Breite.
- **DM Mono** für alles, was eine Maschine erzeugt oder liest: Überzeilen in Versalien, Befehle, Kennungen, Kennzeichnung, Protokoll. Ziffern in Tabellen mit `font-variant-numeric: tabular-nums`.
- Beide Schriften liegen in `fonts/` und werden selbst gehostet. Auf Seiten von Ecclium werden sie nie von Google-Servern geladen, weil dabei die IP-Adressen der Besuchenden an Google gehen.
- Grössen für Website und Doku: display 64/68, h1 44/50, h2 30/36, h3 22/28, lead 20/31, body 17/27, Zeilen höchstens 68 Zeichen. In Anwendungen: Titel 22/28, Text 15/22, Beschriftung 13/18.

## 5. Raum und Form

- Abstände auf Basis 4 px: 4, 8, 12, 16, 24, 32, 48, 64, 96 (`--space-1` bis `--space-24`).
- Website: 12 Spalten, Abstand 24 px, Inhalt höchstens 1200 px breit, Seitenrand 64 px am Desktop und 16 px am Telefon.
- Fast eckig: Karten, Tabellen und Planblätter ohne Radius, Buttons, Felder und Chips 2 px, Menüs und Dialoge 4 px. Rund sind nur das Zeichen und Statuspunkte.
- Ebenen entstehen durch Fläche und Linie. Schatten nur für schwebende Elemente.
- Linien: 1 px für Trennung und Raster, 1,5 px für Icons, 2 px für Wände und Tabellenköpfe.

## 6. Grundriss-Grafik

Die eigene Bildsprache von Ecclium. Richtlinien, Geltungsbereiche und Abläufe werden als Grundriss gezeigt:

- Wände rechtwinklig, ohne Perspektive, ohne Möbel, ohne Türen.
- **Erlaubt:** Fläche `--accent-soft`, innen eine Linie in `--accent`, Beschriftung in DM Mono.
- **Gesperrt:** Schraffur unter 45 Grad, Beschriftung «GESPERRT».
- **Nur lesen:** Wände als Haarlinie, Beschriftung «NUR LESEN».
- **Obergrenze:** Masslinie in `--accent` mit Endstrichen, Wert in DM Mono.
- **Ausgewählter Raum:** Rahmen 1 px gestrichelt (4 4) in `--ink`.
- Nur Platzhalternamen, nie Daten einer echten Gemeinde.

### Laufweg

Der Laufweg zeigt, welche Räume der KI-Assistent in einem Lauf betritt und was er dort tut.

- **Weg:** Linie 1,5 px in `--accent` entlang der Gänge, mit Abzweigen in die Räume.
- **GELESEN:** ein gefülltes Quadrat von 6 px in `--accent`, wo der Weg in einem Raum endet, den der Assistent nur liest.
- **ENDE AN DER WAND:** ein Querstrich von 2 px in `--line-strong` an der Wand eines gesperrten Raums. Der Weg führt nicht hinein.
- **VORSCHAU:** ein gestrichelter Rahmen von 1 px (Strich 4, Lücke 3) in `--line-strong` um das, was in einem erlaubten Raum geschrieben würde.
- **Legende:** unten in DM Mono. Sie nennt den Weg und jedes Zeichen, das im Grundriss vorkommt.

### Schrittplan

Ein Ablauf in Schritten, ein Raum je Schritt. Wände in `--line-strong`, Beschriftung in DM Mono.

| Zustand | Wand | Fläche und Innenlinie | Knoten | Beschriftung |
|---|---|---|---|---|
| offen | 1 px, gestrichelt (4 4) | keine | leer, Rand `--line-strong` | «OFFEN» |
| jetzt | 2 px | Fläche `--accent-soft`, Innenlinie `--accent` | gefüllt, `--accent` | «JETZT» |
| erledigt | 2 px | keine | `--accent` | «ERLEDIGT» |

Der Weg zwischen den Räumen ist eine gestrichelte Haarlinie in `--line` (3 5). Der zurückgelegte Teil liegt darüber, 2 px in `--accent`.

## 7. Icons und Bilder

- Icons von [Lucide](https://lucide.dev) im 24er-Raster, Linie 1,5 px, mit eckigen Enden und spitzen Ecken (`stroke-linecap: square; stroke-linejoin: miter`). Grössen 16, 20, 24 px.
- Eigene Icons für die Begriffe von Ecclium liegen in `icons/`: Routine, Richtlinie, Protokoll, Freigabe, Rücknahme, Kennzeichnung. Messing höchstens als ein Detail.
- Keine Emoji, kein Funkelsymbol für KI, keine Roboter. Keine Kreuze, Tauben, Flammen oder Kirchtürme als Motiv.
- Keine Fotos in Version 1, keine Stockbilder von Menschen, keine erzeugten Bilder von Menschen.
- Bildschirmfotos nur mit erfundenen Daten: `https://example.church.tools`, `max.mustermann@example.org`, «Person A».

## 8. Bewegung und Barrierefreiheit

Die Werte stehen als Tokens in `tokens/tokens.css` (`--motion-*`).

### Überall

- Zustandswechsel 120 ms (`--motion-state`), Ein- und Ausblenden 200 ms (`--motion-fade`), Kurve `cubic-bezier(0.2, 0, 0, 1)` (`--motion-ease`). Nichts federt, nichts pulsiert.
- Laden zeigt Text mit Fortschritt («Lese Termine (14 von 14)»), keinen drehenden Kreis. Das Zeichen wird nie zur Ladeanzeige.

### Nur auf der Startseite der Website

Dort ist zusätzlich erlaubt:

- **Grundriss im Kopf:** Die Wände zeichnen sich Raum für Raum ein, je 600 ms (`--motion-draw`), 80 ms versetzt. Danach blenden Flächen und Beschriftungen in 200 ms ein, danach zeichnet sich der Laufweg des Assistenten in gleichmässigem Tempo, also linear statt mit der Kurve oben. Zusammen dauert das knapp 3 Sekunden. Eine Wiederholung gibt es nur auf Knopfdruck, etwa «Laufweg neu zeichnen», nie von selbst.
- **Fortschritt:** Eine Leiste folgt dem Scrollen.
- **Leitsatz:** Er erscheint beim Scrollen in zwei Hälften, die Masslinie darunter zieht mit.
- **Schrittplan:** Der Laufweg folgt dem Scrollen, die Räume wechseln von offen über jetzt zu erledigt (Kapitel 6).
- **Abschnitte:** Sie blenden beim ersten Erscheinen ein, Deckkraft in 400 ms (`--motion-reveal`), ein Anstieg um 12 px in 600 ms (`--motion-rise`). Kleine Grundrisse zeichnen sich dabei ein.
- **Lauf:** Ein Lauf mit erfundenen Daten startet, sobald er sichtbar ist. Die Protokollzeilen erscheinen nacheinander, «Lese Termine (n von 14)» zählt hoch, und der Lauf hält vor dem Schreiben an, bis jemand «Freigeben» wählt. Danach schreibt sich die Kennzeichnungszeile Zeichen für Zeichen, ohne blinkende Marke. Anhalten und Fortsetzen sind jederzeit möglich.
- **Maskierung:** Eine Schraffur wischt in 600 ms über die Werte und gibt in 400 ms den maskierten Stand frei.

### Ohne Ausnahme

- Bei `prefers-reduced-motion: reduce` entfällt jede Bewegung. Zustände wechseln sofort, der Schrittplan springt von Raum zu Raum.
- Alle Inhalte sind ohne Bewegung und ohne Skript vollständig lesbar.
- Jedes interaktive Element zeigt beim Tastaturfokus `--focus-ring`. Klickflächen mindestens 44 px hoch. Zustände nie nur über Farbe.
- Alle anderen Seiten der Website, die Doku und die Anwendung folgen nur den Regeln unter «Überall».

## 9. Sprache

Ecclium spricht wie jemand, der in der Gemeinde Verantwortung trägt: ruhig, genau, freundlich, ohne Fachjargon.

- Anrede «Sie», überall. «Wir» steht für das Projekt und kommt sparsam vor. Bedienelemente als Verb ohne Anrede: «Freigeben», «Ablehnen», «Routine prüfen».
- Kurze Sätze im Aktiv. Zahlen, Zeiten und Grenzen genau: «1 von 2 erlaubten Vorgängen», nicht «ein paar Änderungen».
- Grenzen zuerst und offen: «Die Maskierung begrenzt den Schaden, sie anonymisiert nicht.» Nie absolute Sicherheit versprechen.
- Vertrauen entsteht durch Daten- und Informationssicherheit und offen dokumentierte Schutzmassnahmen, nicht durch Personen oder Referenzen.
- Die KI ist ein Werkzeug: «der KI-Assistent». Sie denkt und versteht nicht.
- «Gemeinde» als Oberbegriff, dazu «kirchliche Organisationen». Keine frommen Floskeln, keine Bibelzitate in Produkttexten, keine Begriffe, die nur in einer Konfession üblich sind.
- Deutsch für alles, was Menschen lesen, Englisch nur für Code, Befehle und Kennungen. Schweizer Schreibweise mit `ss`, Anführungszeichen «so», keine Geviertstriche, keine Ausrufezeichen, keine Emoji.
- Formate: 28.09.2026, 06:00, «Woche 40», Kennung `2026-W40`, 4'000, CHF 49.
- Nicht verwenden: revolutionär, nahtlos, einzigartig, smart, magisch, mühelos, «100 % sicher», «einfach», wo es nicht einfach ist.

### Feste Begriffe

Routine, Richtlinie, Lauf, Vorschau, Freigabe, Kennzeichnung, Protokoll, Rücknahme. «Routine» ist weiblich: die Routine, der Routine, Mehrzahl Routinen. Die Zustände eines Schreibvorgangs heissen immer so:

| Zustand | Farbe | Bedeutung |
|---|---|---|
| Vorschlag | info | geplant, noch nichts geschrieben |
| Wartet auf Freigabe | warning | in der Freigabe-Warteschlange |
| Konflikt | warning | Seite wurde inzwischen von Hand geändert |
| Ausgeführt | success | geschrieben, gekennzeichnet, rücknehmbar |
| Zurückgenommen | neutral | per Rücknahme wiederhergestellt |
| Abgelehnt | danger | durch Richtlinie oder Mensch verworfen |

### Meldungen

Jede Meldung sagt, was geschieht oder geschah, warum, und was Sie jetzt tun können.

| Situation | So | Nicht so |
|---|---|---|
| Vor dem Schreiben | «Ecclium hängt einen Abschnitt an die Seite ‹Dienstplan-Auswertung› an. Es wird nichts überschrieben. Sie können die Änderung bis 28.10.2026 zurücknehmen.» | «Änderungen werden jetzt angewendet.» |
| Fehler | «Nicht geschrieben: Dem Dienstkonto fehlt das Recht ‹Wiki bearbeiten› in der Kategorie ‹Berichte›. Ergänzen Sie das Recht in ChurchTools oder passen Sie die Richtlinie an.» | «Fehler 403» |
| Leer | «Keine offenen Freigaben. Der nächste Lauf von ‹dienstplan-report› ist am Montag, 06:00.» | «Hier ist noch nichts.» |

### Kennzeichnung

Jeder Inhalt, den Ecclium erzeugt, trägt am Ende diese Zeile, in DM Mono mit einem Quadrat in Messing davor:

> Automatisch erstellt am 28.09.2026 durch Ecclium, Routine dienstplan-report, Lauf 2026-W40, Prüfcode k1:ABCDEFGHIJKLM. Rückfragen an [Verantwortliche Person].

### Kernsätze

- **Kurzbeschrieb:** Ecclium verbindet KI-Assistenten mit der Gemeindesoftware ChurchTools. Der Assistent kann Daten lesen und, wo die Gemeinde es erlaubt, auch schreiben. Wiederkehrende Aufgaben wie der wöchentliche Dienstplan-Bericht laufen nach Zeitplan. Jede Änderung wird vorher gezeigt, gekennzeichnet und protokolliert und lässt sich zurücknehmen. Ecclium ist quelloffen, lässt sich selbst betreiben und legt besonderen Wert auf Daten- und Informationssicherheit. Ecclium ist ein unabhängiges Projekt und steht in keiner Verbindung zum Hersteller von ChurchTools.
- **Profil:** Kontrolle ist eingebaut, nicht versprochen. Offen und selbst betreibbar. Gemacht für Gemeinden, egal welcher Prägung.
- **Für Gemeindeleitende:** «KI-Anbindung» statt «MCP». Der Zusatz MCP ist für IT-Verantwortliche gedacht, die danach suchen.

Solange Version 0.1.0 nicht erschienen ist, stehen diese Sätze nur mit dem Hinweis «in Entwicklung».

## 10. Dateien

```
brand/
├── README.md          diese Richtlinie
├── logo/              Kombination, gestapelt, Zeichen, Wortmarke (SVG)
├── icon/              App-Icon, GitHub-Avatar, favicon.svg, favicon.ico
├── png/               gerasterte Fassungen
├── social/            Vorschaubilder für GitHub und Links
├── icons/             sechs eigene Icons
├── tokens/            tokens.json (Quelle) und tokens.css
├── fonts/             Archivo und DM Mono als WOFF2 mit Lizenz
└── src/               Skripte und Vorlagen, aus denen alles entsteht
```

Alles in `logo/`, `icon/`, `png/`, `social/` und `tokens/tokens.css` entsteht aus Skripten. Änderungen deshalb nur in `src/` vornehmen und neu erzeugen, aus dem Ordner `brand/`:

```sh
python3 src/build_tokens_css.py # tokens.css aus tokens.json
python3 src/generate_logos.py   # SVG aus der Konstruktion
node src/render_png.js          # PNG und Social-Bilder, braucht playwright
python3 src/build_ico.py        # favicon.ico aus den PNG, braucht Pillow
```

## 11. Lizenzen

- **Archivo** und **DM Mono:** SIL Open Font License 1.1, Lizenztexte in `fonts/`. Die Schriften dürfen frei verwendet, eingebettet und weitergegeben werden, aber nicht einzeln verkauft werden. Die Dateien in `fonts/` enthalten nur den Zeichensatz Latin.
- **Lucide:** ISC-Lizenz. Wer Lucide-Icons als Dateien ins Repository übernimmt, legt den Lizenztext bei.
- **Name und Logo von Ecclium** sind nicht Teil der Lizenz des Quellcodes. Ihr Gebrauch ist in [TRADEMARKS.md](../TRADEMARKS.md) geregelt.
- **ChurchTools** ist eine Marke ihres Inhabers.
