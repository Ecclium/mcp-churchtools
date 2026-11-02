# ADR 0030: ContentPolicy mit Längengrenze und Normalisierung, nur Markdown-Ziele

- Status: Vorgeschlagen
- Datum: 02.11.2026
- Fällt vor: Phase 5
- Ergänzt: [ADR 0021](0021-supply-chain-baseline.md), dessen Entscheid [ADR 0050](0050-token-der-mise-action.md) übernimmt, um eine Lizenz für Werkzeuge der Entwicklung

## Kontext

Mit Phase 5 schreibt Ecclium Texte in ChurchTools: Seiten und Abschnitte im Wiki, später Titel und Beschreibungen von Terminen und Buchungen und ab Phase 6 Berichte von Routinen ([ADR 0029](0029-write-guard.md), [ADR 0072](0072-schreibende-anfragen.md)). Einen solchen Text schreibt ein Modell, eine Person oder der Betreiber. Ein Modell kann dabei Anweisungen aus gelesenen Texten folgen ([Threat Model](../threat-model.md), T6 und T7), und die Bestätigung eines Menschen beweist nicht, dass er den Text gelesen hat (T8). Was im Text steht, lesen danach alle, die die Seite sehen, und eine Buchungsanfrage geht als Mail an die Verwalter der Ressource (F48).

Ein Text kann auf mehreren Wegen mehr tun, als er zeigt:

- Ein Bild lädt beim Anzeigen eine Adresse, die Daten tragen kann. Ein Link führt dorthin, wenn jemand klickt (T12).
- Eine Erwähnung steht im Markdown als gewöhnlicher Link auf die Ansicht einer Person, mit ihrem Namen und ihrer ID. Ob sie eine Person benachrichtigt, ist offen (F21).
- HTML, auch ein Kommentar, bleibt in einer Markdown-Seite stehen (F17) und kann Anweisungen für spätere Leser und Modelle tragen.
- Die Ansicht einer Markdown-Seite zeigt eine nackte URL als Link, und der Web-Editor schreibt sie beim Speichern als Link in den Text (F20, F13). Welche Bibliothek ChurchTools zum Darstellen nutzt, ist nicht belegt, und manche verlinken auch eine Domain ohne Schema.
- Ein Modell, das maskierte Antworten zurück ins Wiki trägt, schriebe `[masked]` oder ein Pseudonym an die Stelle eines Werts.

Am 01.11.2026 ist entschieden: In Version 1 schreibt Ecclium keine Erwähnungen, keine Links ausser auf Seiten in erlaubten Kategorien und keine nackten URLs, auch interaktiv nicht (`docs/STATUS.md`, Plan für Phase 5). Am 02.11.2026 hat der Maintainer drei weitere Fragen entschieden:

1. Ein Update ersetzt den ganzen Text einer Seite, also geht der ganze neue Text durch die Prüfung, auch was vorher schon dort stand.
2. E-Mail-Adressen, Telefonnummern, IBAN und AHV-Nummern stehen interaktiv nur in einem Text, wenn sie in einer Liste der Richtlinie stehen.
3. Links auf Seiten des Wikis kommen erst, wenn ihre Form an einer Instanz belegt ist. Belegt ist nur die Form einer Erwähnung (F21).

Lexer für Markdown hatten wiederholt Eingaben, die sie sehr lange rechnen liessen. Ein Worker mit Zeitgrenze geht unter dem Permission Model von Node.js nicht. Gemessen am 02.11.2026 auf einem Laptop: `marked` 18.1.2 sucht für jedes Sternchen, jeden Unterstrich, jede Tilde und jedes Ausrufezeichen ohne Gegenstück das Ende durch den ganzen restlichen Text. Ein Text unter 64 KiB brauchte mit Unterstrichen über 20 Sekunden, mit Tilden 15 und mit Ausrufezeichen über 2, mit 2'000 solchen Zeichen höchstens etwa eine Viertelsekunde. Jedes andere Zeichen von ASCII, bis zur Grenze der Länge wiederholt, brauchte weniger als eine Zehntelsekunde. `marked` 18.1.3 vom 02.11.2026 behebt das laut seinen Hinweisen für Hervorhebung, ist aber jünger als das Mindestalter aus [ADR 0021](0021-supply-chain-baseline.md).

## Optionen

Für den Weg eines Texts:

1. **Prüfen und den Text unverändert schreiben:** einfach, aber geschrieben wird dann, was der Prüfer nur gelesen hat. Jede Stelle, an der zwei Parser einen Text verschieden lesen, wird zur Lücke.
2. **Verbotenes still entfernen und den Rest schreiben:** Der Schreibvorgang gelänge immer, aber in ChurchTools stünde ein anderer Text, als das Modell schrieb und der Mensch bestätigte.
3. **Lesen, als Baum der erlaubten Teilmenge neu schreiben, Verstösse ablehnen:** Geschrieben wird nur, was ein eigener Serialisierer aus dem Baum erzeugt. Mehr Code, aber kein Rohtext eines Tokens erreicht ChurchTools.

Für den Lexer: ein eigener (eine neue Quelle von Fehlern an der Stelle, die über den Text entscheidet), der Lexer von `marked` (mit Herkunftsnachweis, ohne Abhängigkeiten) oder markdown-it (ohne Herkunftsnachweis, mit sechs Abhängigkeiten).

## Entscheid

Gewählt ist die dritte Option mit dem Lexer von `marked`.

- **Geltung:** Jeder Text, den Ecclium in ChurchTools schreibt, geht durch die ContentPolicy, gleich ob ein Modell, eine Person oder der Betreiber ihn schrieb. Text in Markdown prüft `checkMarkdown`, Text ohne Markdown wie der Titel einer Seite `checkPlainText`.
- **Schritte für Markdown**, in dieser Reihenfolge:
  1. Höchstens 64 KiB in UTF-8 je Feld, die Grenze, die auch der Client für den Text einer Seite setzt ([ADR 0072](0072-schreibende-anfragen.md)), gemessen vor und nach der Normalisierung, weil NFKC einen Text länger machen kann, und noch einmal nach dem Schreiben, weil Escapes Zeichen hinzufügen. Ein Text mit einem einzelnen Surrogat ist nicht lesbar.
  2. Entfernen unsichtbarer Zeichen wie in der Schwärzung ([ADR 0024](0024-eine-tool-pipeline.md)), NFKC, noch einmal Entfernen, bis sich nichts mehr ändert, und `\n` am Ende jeder Zeile. Geschrieben wird diese Form, damit in ChurchTools steht, was geprüft wurde.
  3. Höchstens 2'000 Sternchen, Unterstriche, Tilden und Ausrufezeichen zusammen, escaped oder nicht, damit der Lexer auch bei bösartigen Texten unter einer Viertelsekunde bleibt. Die Grenze bleibt, wenn eine spätere Version von `marked` das Problem behebt.
  4. Der Lexer von `marked` mit GFM, je Text neu gebaut mit vollständigen Optionen, nie über `marked.use` oder `setOptions`. Wirft er, etwa weil der Stapel ausgeht, wird der Text abgelehnt.
  5. Ein eigener Baum der erlaubten Teilmenge. Jedes andere Token ist ein Grund zur Ablehnung, nichts wird still entfernt.
  6. Ein eigener Serialisierer schreibt den Baum, nie den Rohtext eines Tokens.
  7. Der Lexer liest das Geschriebene noch einmal. Kommt dabei nicht genau dieselbe Form heraus, oder ist das Geschriebene nicht seine eigene Normalform, wird der Text abgelehnt: `marked` liest Hervorhebung nach einem Satzzeichen nicht immer gleich, und verbundene Teile können Zeichen zusammenbringen, die NFKC zusammensetzt. Was durchgeht, ist damit immer eine Form, die unverändert zurückkommt.
  8. Die Prüfung dessen, was ein Leser sieht, auf beiden Lesarten, ohne die Variantenwähler U+FE00 bis U+FE0F, die die Normalform für Emoji behält, und mit leeren Zeichen wie U+2800 als Leerzeichen, damit sie keine Nummer und keine Adresse verstecken.
- **Erlaubte Teilmenge:** Überschriften der Stufen 1 bis 6 (auch unterstrichene, geschrieben mit `#`), Absätze, Listen mit Punkten oder Nummern bis neun Stellen, eng oder mit Leerzeilen, höchstens fünf Ebenen tief, darin nur Absätze und Listen, Tabellen mit Ausrichtung, in Zellen nur Text und Hervorhebung, und keine Zeile breiter als ihr Kopf, weil der Lexer die Zellen darüber hinaus still verwirft, fett und kursiv, höchstens zehn Ebenen ineinander.
- **Abgelehnt** mit festen Gründen: Roh-HTML und Kommentare, Verweise auf Zeichen wie `&amp;` oder `&#60;` (sie gehören zu HTML, und der Lexer übersetzt sie nur zum Teil), Bilder, Links jeder Art (auch `javascript:` und `data:`), Erwähnungen, Referenzen und ihre Definitionen samt Fussnoten, Code im Text und als Block, Zitate, Trennlinien, harte Zeilenumbrüche, Durchgestrichenes, Aufgabenlisten, Überschriften und Tabellen in einer Liste. Harte Umbrüche fehlen auch, weil der Web-Editor die Form mit zwei Leerzeichen umschreibt (F13) und offen ist, ob die Darstellung die Form mit Backslash kennt.
- **Nackte Adressen:** Eine Adresse, die GFM ohne Link-Syntax als Link liest, wird wieder Text, und die Prüfung des Lesbaren entscheidet. Abgelehnt ist in jeder Überschrift, jedem Absatz und jeder Zelle, mit Hervorhebung zusammengesetzt und Zeilenumbrüchen als Leerzeichen: `//` vor einem Zeichen eines Hostnamens, auch nach einem Schema, `mailto:` und `xmpp:`, `www.` am Anfang eines Worts, ein Punkt nach einem Zeichen eines Hostnamens vor dem letzten Teil eines Hostnamens und ein `@` vor einem Hostnamen mit Punkt. Als Zeichen eines Hostnamens gilt alles ausser Leerraum und den Satzzeichen von ASCII ohne den Bindestrich, wie bei linkify-it, das auch Symbole wie `+` und jede Schrift in einen Hostnamen nimmt. Als letzter Teil gelten zwei oder mehr Buchstaben von ASCII, denen keine Ziffer und kein Bindestrich folgt, `xn--` eines Teils in einer anderen Schrift und zwei oder mehr Zeichen jenseits von ASCII. Fehlalarme sind gewollt: `St.Gallen`, `bericht.pdf`, `Node.js` und `Treffpunkt@19.30`, das linkify-it als E-Mail-Adresse verlinkt, gelten als Adresse, `z.B.`, `d.h.`, `Mt.5` und `01.11.2026` nicht. Der Satz an das Modell rät zu einem Leerzeichen nach dem Punkt.
- **Masken der Schwärzung:** Abgelehnt ist ein Text mit `[masked]` oder einer anderen Marke der Prüfung von Freitext, einer maskierten E-Mail-Adresse oder Telefonnummer, einem Pseudonym oder der Grenze eines Datenumschlags.
- **Kontaktangaben:** E-Mail-Adressen, Telefonnummern, IBAN mit gültiger Prüfsumme und AHV-Nummern mit gültiger Prüfziffer erkennt derselbe Code wie die Prüfung von Freitext in `strict`. Erlaubt ist ein Wert nur, wenn er in der Liste steht, die die ContentPolicy bekommt: interaktiv eine Liste der Kontaktangaben der Gemeinde in der Richtlinie, leer voreingestellt, aus der auch «Rückfragen an» in der Kennzeichnung kommt. Für Routinen kommt ab Phase 6 dazu, was in der redigierten Eingabe stand. Verglichen wird eine E-Mail-Adresse ohne Gross und Klein und eine Nummer nur über Ziffern, Buchstaben und ein führendes `+`. Die Domain einer erkannten E-Mail-Adresse zählt nicht als eigene Webadresse. Personen-IDs stehen in einem Text nur als Link einer Erwähnung oder als Pseudonym, beides ist abgelehnt. Eine nackte Zahl lässt sich nicht als Kennung einer Person erkennen.
- **Text ohne Markdown:** dieselbe Grenze, Normalisierung und Prüfung des Lesbaren, eine Zeile, auch ohne die Trenner U+2028 und U+2029, kein `<` vor einem Buchstaben, `/`, `!` oder `?`, kein Verweis auf ein Zeichen und keines der Zeichen `[`, `]`, Backtick und Backslash. Er wird geschrieben, wie er nach der Normalisierung ist, ohne Escapes, und soll deshalb auch dann nichts tun, wenn ihn eine Darstellung als Markdown liest.
- **Ganzer Text bei einem Update:** Was eine Seite schon enthielt, gilt nicht als geprüft. Eine Seite mit Bildern, Links, HTML oder Erwähnungen kann Ecclium nur ergänzen. Beim Anhängen eines Abschnitts prüft die ContentPolicy nur den neuen Abschnitt.
- **Interne Links:** In Version 1 vorerst keine. Sie kommen mit den Schreib-Tools des Wikis, wenn eine Probe an einer Instanz die Form eines Links auf eine Seite belegt hat, und nur auf Seiten in erlaubten Kategorien.
- **Kanonische Form:** Der Serialisierer schreibt jede Form auf eine Art: `#` für Überschriften, `-` vor Punkten einer Liste (`*` für die zweite von zwei Listen in Folge, `)` statt `.` ebenso), die Breite der Marke als Einzug, `**` für fett, `*` für kursiv, Tabellen mit einer Zeile der Ausrichtung, eine Leerzeile zwischen Blöcken. Jedes Zeichen, das Markdown beginnen könnte, steht im Text mit Backslash, eine Zeile, die wie ein Punkt einer Liste, eine Unterstreichung, eine Zeile einer Tabelle oder eine Nummer beginnt, ebenso. Fett nach fett und fett in fett werden ein Teil, ebenso kursiv, damit keine Folge von vier Sternchen entsteht, die Parser verschieden lesen. Fett in kursiv in fett schreibt trotzdem fünf Sternchen in Folge, solche Texte fängt das zweite Lesen. Über diese Form geht der Prüfcode `k1:` ([ADR 0032](0032-richtlinie-und-pruefcode.md)).
- **Gründe:** `tooLong`, `unparsable`, `html`, `image`, `link`, `mention`, `reference`, `webAddress`, `contact`, `masked`, `unsupported` und `tooDeep`, je mit einem festen englischen Satz für das Modell, der nie den Text zitiert. Eine Ablehnung nennt alle gefundenen Gründe in fester Reihenfolge.
- **Abhängigkeiten:** `marked` 18.1.2 zur Laufzeit, gebündelt, nur in `packages/core/src/content/lexer.ts` (Ort `contentLexer`). markdown-it 15.0.3 nur als Entwicklungsabhängigkeit für den Differenztest (Ort `contentDifferential`). `argparse`, das markdown-it für seine Kommandozeile mitbringt, steht unter PSF-2.0. Diese Lizenz ist damit für Werkzeuge der Entwicklung erlaubt, wie MPL-2.0, nicht zur Laufzeit.

## Konsequenzen

- Ein Modell muss manche Texte umschreiben: Abkürzungen ohne Leerzeichen, Dateinamen und Domains, Kontaktangaben ohne Eintrag, Code, Zitate und Trennlinien. Es bekommt dafür feste Sätze mit dem Grund.
- NFKC ändert Zeichen, die eine Person gewählt hat: Eine Ellipse wird zu drei Punkten, eine hochgestellte Zwei zu einer gewöhnlichen, ein geschütztes Leerzeichen zu einem gewöhnlichen. ChurchTools schreibt eine Ellipse im Titel ohnehin als drei Punkte.
- Ein Update schreibt die ganze Seite in der kanonischen Form, auch Teile, die niemand geändert hat, und die Bestätigung zeigt das als Unterschied. Eine Seite mit Elementen ausserhalb der Teilmenge, auch mit harten Umbrüchen, die der Web-Editor schreibt, lässt sich nur ergänzen.
- Eine E-Mail-Adresse aus der Liste der Richtlinie kann in der Ansicht als Link auf sie erscheinen. Der Differenztest lässt genau das zu und sonst keinen Link.
- Verweise auf Zeichen werden abgelehnt, auch harmlose wie `&amp;`. Ein `&` ohne Verweis bleibt ein Zeichen.
- Ändert sich der Serialisierer so, dass die kanonische Form eines Abschnitts anders ausfällt, braucht der Prüfcode ein neues Präfix.
- `marked` 18.1.3 kommt, sobald es das Mindestalter hat. Die Grenze von 2'000 Zeichen der Hervorhebung bleibt danach, falls das Problem wiederkehrt.
- Restrisiko: Welche Bibliothek ChurchTools zum Darstellen nutzt, ist nicht belegt. Der Differenztest prüft mit markdown-it und linkify-it, die auch Domains ohne Schema verlinken, und die Prüfung der Adressen ist bewusst breiter als linkify-it. Eine Darstellung, die anders liest als beide, kann trotzdem etwas als Link zeigen, etwa eine nackte IP-Adresse, die linkify-it nur mit einer eigenen Einstellung verlinkt. Ein Abschnitt in einer Seite, die ein Mensch im Web-Editor speichert, kann der Editor danach umschreiben (F13).
- Restrisiko: Kontaktangaben findet die Prüfung nur in den Formen der Prüfung von Freitext. Eine Telefonnummer ohne führende `0`, `+` oder `(`, etwa `41 79 …` oder eine Nummer im Stil `1-800-…`, und eine IBAN, die nicht in Gruppen zu vier steht, gehen durch.

## Umsetzung

### Teil 1: die ContentPolicy als reine Funktion (02.11.2026)

- `packages/core/src/content/`: `normalize.ts` (Grenze, Normalform, Grenze der Hervorhebung), `lexer.ts` (Baum der Teilmenge, Ort `contentLexer`), `tree.ts`, `serialize.ts`, `scan.ts` (Adressen, Masken, Kontaktangaben, `contactKeyOf` für Einträge einer Liste), `check.ts` mit `checkMarkdown` und `checkPlainText`, `violations.ts` mit den Gründen und ihren Sätzen. Der Einstieg von `core` exportiert nichts davon.
- Die Erkennung von Kontaktangaben ist aus der Prüfung von Freitext in `strict` als `findPersonalData` herausgelöst. Deren Ausgabe ist für jeden Text gleich geblieben.
- Regeln `marked-only-in-content-lexer` und `markdown-it-only-in-differential-test` mit Beispielen, die rot werden, in `tests/architecture/`.
- Die Durchsicht vor dem Merge fand weitere Lücken, die geschlossen sind: Tilden und Ausrufezeichen in der Grenze der Hervorhebung, die Suche nach Telefonnummern in einer langen Folge wie `0.0.0.` in linearer Zeit (64 KiB brauchten 22 Sekunden, auch in `strict`), Nummern in kurzen Gruppen mit Punkten, weitere unsichtbare Zeichen, Tabellen mit breiteren Zeilen, Adressen mit `xn--`, nach Zeichen jenseits von ASCII, mit `//`, `mailto:` oder einem `@` ohne Buchstaben nach dem Punkt, ein grosses I mit Punkt vor `www.`, die Normalform nach dem Verbinden von Teilen und die Zeichen von Markdown in Titeln.
- Tests: ein Korpus von Angriffen (HTML, Kommentar, Verweis auf Zeichen, Links mit `javascript:` und `data:`, ein Bild, das Daten wegschickt, Erwähnungen in der Form aus F21, Referenzen und Fussnoten, nackte Adressen auch in voller Breite und mit unsichtbaren Zeichen, Kontaktangaben, Masken, Code und Zitate, die sich als System ausgeben), Property-Tests mit fast-check (Rundweg jedes Texts, fester Punkt, verkleidete Werte) und der Differenztest mit markdown-it, dessen Gegenprobe HTML, Links, Bilder und Code findet. Läufe ohne festen Startwert mit je 30'000 Texten fanden vor dem Merge vier Lücken, die geschlossen sind: das zweite Lesen, die Verschmelzung von fett mit fett, die breiteren Zeichen eines Hostnamens samt `@` und der Doppelpunkt am Anfang einer Zeile.
- `coverage-security-core` verlangt 100 Prozent für `packages/core/src/content/`.
- Die Prüfung im Write-Guard, die Liste `contacts` der Richtlinie und das Feld des Audits folgen im zweiten Teil.
