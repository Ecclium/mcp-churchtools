# ADR 0026: Redaction über klassifizierte Ausgabeschemas, Pseudonyme nach RFC 8452

- Status: Angenommen am 23.10.2026
- Datum: 23.10.2026
- Fällt vor: Phase 2

## Kontext

Antworten von ChurchTools tragen Personendaten. Diese Daten lassen auf die Religionszugehörigkeit schliessen und gehören damit zu den besonderen Kategorien nach Art. 9 DSGVO und zu den besonders schützenswerten Daten nach revDSG (Threat Model, W1). Welche Felder einer Antwort Personendaten sind, kann der Kern nicht aus der OpenAPI-Spezifikation lesen: Sie ist an mehreren Stellen ungenau (`docs/research/churchtools-api.md`, etwa F27 und F32), und ob ein Feld eine Person beschreibt, sagt sie nicht.

Seit Phase 1 gilt:

- Der ChurchTools-Client liest nur die Felder seiner eigenen Schemas (ADR 0025, ADR 0057). Die Pipeline lässt nichts durch, was das Ausgabeschema eines Tools nicht deklariert (ADR 0024).
- Jedes Blatt eines Ausgabeschemas kann eine Datenklasse aus einer geschlossenen Liste im Register von zod tragen: `none`, `personId`, `name.first`, `name.last`, `email`, `phone`, `birthdate`, `address`, `amount` und `untrusted` (Plugin-Schnittstelle, `data-class.ts`). Aus den Klassen leitet die Registry die kleinste zulässige Sensibilität eines Tools ab (ADR 0024, Umsetzung).
- Die Pipeline maskiert E-Mail-Adressen, Telefonnummern und Geburtsdaten, auch in Fehlermeldungen, entfernt unsichtbare Zeichen aus jedem Text und setzt jeden Text der Klasse `untrusted` in einen Datenumschlag mit zufälliger Grenze (ADR 0024). Ein Blatt ohne Klasse ist erlaubt und bleibt unmaskiert. Die Konfiguration weist die Stufe `strict` ab (ADR 0055).
- Ein Blatt trägt höchstens eine Klasse. Namen von Personen tragen `name.first` und `name.last` und stehen nicht im Umschlag. Ob sie zusätzlich in den Umschlag kommen, sollte dieses ADR vor Phase 2 entscheiden (ADR 0060).

In Phase 2 kommen die übrigen Lese-Tools dazu, mit Mitgliederlisten, Dienstzuteilungen und Seiten des Wikis. Danach folgen in Phase 4 die Stufe `strict` und Pseudonyme. Die MCP-Spezifikation 2026-07-28 kennt keine Sitzung mehr (ADR 0018, übernommen von ADR 0053), an die sich ein Pseudonym binden liesse.

## Optionen

Zur Grundlage der Maskierung:

1. **Klassifizierte eigene Schemas, Pflicht für jedes Blatt:** Jedes Tool sagt für jedes Feld, was es enthält, und die Registry weist ein Tool mit einem Blatt ohne Klasse ab. Ein vergessenes Feld fällt beim Start auf, nicht erst in einer Antwort.
2. **Klassifizierte Schemas, Pflicht nur in der Durchsicht:** weniger Prüfcode, aber ein Feld ohne Klasse ginge unmaskiert hinaus, wenn die Durchsicht es übersieht.
3. **Erkennung an der Form der Werte:** findet eine E-Mail-Adresse auch dort, wo kein Schema sie erwartet, erkennt aber weder Namen noch Kennungen und irrt bei Zahlen. Sie taugt als zusätzliche Prüfung für Freitext in `strict`, nicht als Grundlage.

Zu Namen von Personen und dem Datenumschlag:

1. **Namen ausserhalb des Umschlags:** Namen behalten ihre Klassen, und `strict` kann Nachnamen kürzen. Ein Name, der wie eine Anweisung aussieht, erreicht das Modell ohne Umschlag.
2. **Namen im Umschlag:** Ein Blatt bräuchte dafür neben seiner Klasse eine zweite Angabe. Die Marken des Umschlags kosten je Feld 51 Zeichen (`packages/core/src/redaction/envelope.ts`). Eine Liste mit 50 Personen und je zwei Namen trüge damit rund 5 KiB mehr, und weil ein Ergebnis die Daten als Text und strukturiert enthält, rund 10 KiB der Grenze von 64 KiB je Ergebnis (ADR 0024).

Zu Pseudonymen:

1. **AES-GCM-SIV nach RFC 8452:** deterministisch, ohne Zustand rückübersetzbar, mit Schlüsseln je Mandant, Prinzipal und Tag aus einem eigenen Geheimnis.
2. **HMAC mit Zuordnung im Arbeitsspeicher:** nicht rückübersetzbar, braucht eine Tabelle je Mandant, Prinzipal und Tag, die ein Neustart verliert. Die Tabelle ist Zustand über Anfragen hinweg und bräuchte nach ADR 0051 einen eigenen Port oder eine benannte Ausnahme.
3. **Zufällige Pseudonyme mit Tabelle:** braucht ebenso Zustand über Anfragen hinweg, und die Tabelle müsste einen Neustart überstehen.

## Entscheid

Gewählt ist zu jeder der drei Fragen die erste Option.

- **Klassen sind Pflicht.** Jedes Blatt eines Ausgabeschemas trägt genau eine Datenklasse aus der Liste oben. `none` ist die ausdrückliche Klasse für ein Feld ohne Personendaten, ein Blatt ohne Angabe ist ein Fehler. Ab Phase 2 weist die Registry ein Tool mit einem Blatt ohne Klasse ab, wenn es in den Katalog kommt, also beim Start des Servers. Ein Test geht die Schemas aller Tools des Kerns durch.
- **Neue Klassen** kommen nur mit einem ADR, das dieses ergänzt oder ablöst und sagt, was jede Stufe mit ihnen tut. Eine Klasse für Kennungen von Gruppen folgt, sobald Kennungen ins Audit kommen (ADR 0028, ADR 0060).
- **Was jede Stufe tut:**

  | Klasse       | `off`       | `standard`               | `strict`                                                        |
  | ------------ | ----------- | ------------------------ | --------------------------------------------------------------- |
  | `none`       | unverändert | unverändert              | unverändert                                                     |
  | `personId`   | unverändert | unverändert              | Pseudonym                                                       |
  | `name.first` | unverändert | unverändert              | unverändert                                                     |
  | `name.last`  | unverändert | unverändert              | gekürzt auf den ersten Buchstaben                               |
  | `email`      | unverändert | maskiert                 | maskiert                                                        |
  | `phone`      | unverändert | maskiert                 | maskiert                                                        |
  | `birthdate`  | unverändert | nur das Jahr             | nur das Jahr                                                    |
  | `address`    | unverändert | festgelegt mit der Maske | festgelegt mit der Maske                                        |
  | `amount`     | unverändert | durch eine Marke ersetzt | durch eine Marke ersetzt                                        |
  | `untrusted`  | Umschlag    | Umschlag                 | Umschlag, dazu Prüfung auf E-Mail, Telefon, IBAN und AHV-Nummer |

  E-Mail-Adressen und Telefonnummern zeigen mit Sternen, dass ein Teil fehlt. Ein Geburtsdatum erscheint nur noch als Jahr. Einen Wert, den eine Maske nicht lesen kann, ersetzt sie ganz durch eine Marke. Unsichtbare Zeichen entfernt die Pipeline in jeder Stufe aus jedem Text, und den Umschlag setzt sie in jeder Stufe, auch in `off`. Beides schützt gegen eingeschleuste Anweisungen, nicht die Personendaten. `off` gibt es nur über stdio, mit einer Warnung beim Start. In `strict` weist der Server rohe Kennungen von Personen in Eingaben ab.

- **Adressen:** ChurchTools liefert Strasse, Zusatz, Postleitzahl, Ort, Land und Koordinaten als getrennte Felder (F32). Welche davon `address` tragen und was `standard` stehen lässt, etwa den Ort, legt das ADR fest, das die Maske für Adressen in Phase 4 bringt.
- **Beträge** kommen in Version 1 nicht vor, weil Finanz- und Spendenmodule draussen bleiben (Grundsatzentscheid 4 in `docs/STATUS.md`). Eine Rundung statt des Ersetzens kann ein späteres ADR einführen.
- **Geltungsbereich:** Die Maskierung gilt für Text und strukturierten Inhalt eines Ergebnisses, für Ressourcen und für Fehlermeldungen. In Fehlermeldungen gibt es kein Schema, dort maskiert sie nach der Form der Werte (ADR 0054).
- **Bis Phase 4:** Gebaut sind die Masken für `email`, `phone` und `birthdate`. Bis die Masken für `address` und `amount` stehen, weist die Registry auch ein Blatt mit einer dieser Klassen ab, damit kein solches Feld unmaskiert hinausgeht. Die Konfiguration weist `strict` bis dahin weiter ab.
- **Namen von Personen** bleiben ausserhalb des Datenumschlags, mit ihren Klassen `name.first` und `name.last`. Namen von Gruppen, Titel, Texte und jeder andere Freitext aus ChurchTools tragen `untrusted` und stehen im Umschlag. Ein Titel, der der Name einer Person ist, gilt als Name, nicht als Freitext.
- **Pseudonyme** entstehen in `strict` mit AES-GCM-SIV nach RFC 8452. Den Schlüssel eines Tages leitet HKDF aus dem Geheimnis `pseudonym_key` mit Mandant, Prinzipal und dem UTC-Tag ab. Prinzipal ist der Akteur eines Aufrufs mit seiner ID nach ADR 0055, über stdio `stdio:<Subjekt>`, nie das Dienstkonto, weil sonst alle Nutzer eines Servers dieselben Pseudonyme sähen. Pseudonyme sind damit ohne Tabelle in Kennungen zurückzuübersetzen. Beim Wechsel von `pseudonym_key` gelten alter und neuer Schlüssel einen Tag lang nebeneinander, damit Pseudonyme des Vortags rückübersetzbar bleiben. Steht AES-GCM-SIV in Phase 4 nicht in geprüfter Form zur Verfügung, gilt die zweite Option zu Pseudonymen, mit einem eigenen ADR für ihre Tabelle nach ADR 0051.

## Konsequenzen

- Ein Tool, das ein Feld ohne Klasse ausgibt, startet nicht. Das gilt auch für Tools aus Plugins und kann ein Plugin aus Phase 1 brechen. Bis Phase 8 ist kein Plugin veröffentlicht, ein Bruch trifft also nur Plugins in Entwicklung.
- Felder mit Adressen oder Beträgen kann bis Phase 4 kein Tool ausgeben. Für die Lese-Tools von Phase 2 ist das gewollt: Das Dienstkonto liest in Phase 2 keine Kontaktdaten von Personen.
- Die Klasse sagt der Pipeline, was ein Feld enthält. Ist sie falsch gewählt, maskiert die Pipeline falsch. Dagegen stehen die Durchsicht jedes Tools und Tests mit Kanarienwerten in jedem Feld.
- Pseudonyme sind eine Pseudonymisierung im Sinn von Art. 4 Nr. 5 DSGVO, keine Anonymisierung: Wer `pseudonym_key` hat, übersetzt sie zurück. `docs/privacy.md` sagt das, sobald es Pseudonyme gibt. Der Schlüssel gehört in die Sicherung, damit Pseudonyme nach einer Wiederherstellung gleich bleiben.
- Zwei Prinzipale sehen für dieselbe Person verschiedene Pseudonyme, und am nächsten Tag jeder ein anderes. Über Tage hinweg lassen sich Pseudonyme deshalb nicht verketten, ein Modell kann eine Person aber auch nicht über Tage wiedererkennen.
- Für AES-GCM-SIV kommt in Phase 4 voraussichtlich eine Abhängigkeit dazu. Sie wird dann wie jede neue Abhängigkeit begründet.
- **Restrisiken:**
  - **Namen als Anweisung:** Ein Name einer Person kann Text tragen, der wie eine Anweisung aussieht, und erreicht das Modell ohne Umschlag. Die Pipeline entfernt unsichtbare Zeichen, die Schemas begrenzen die Länge, und jede Beschreibung sagt, dass Inhalte aus ChurchTools Daten sind (Threat Model, T7).
  - **Maskierung ist Schadensbegrenzung:** Auch maskiert bleiben Name, Jahrgang und Ort einer Person erkennbar. Eine Anonymisierung im rechtlichen Sinn ist das nicht.
  - **Freitext:** Personendaten in Freitext, etwa in einer Seite des Wikis, erkennt `standard` nicht. `strict` prüft Freitext auf Muster, findet aber keine Namen.
  - **Fehlermeldungen:** Die Maske für Meldungen erkennt nur die Form von E-Mail-Adressen, Telefonnummern und Daten, auch in `strict` keinen Namen und kein Token. Anders als ADR 0054 erwartet, ändert die vollständige Maskierung daran nichts. Dagegen steht die Regel aus ADR 0054, dass Tools keine Inhalte des Mandanten und keinen Text fremder Fehler in eine Meldung setzen.

## Umsetzung

- Seit Phase 1: die Klassen in der Plugin-Schnittstelle (`packages/plugin-api/src/data-class.ts`), die Masken für `email`, `phone` und `birthdate` (`packages/core/src/redaction/mask.ts`) in der Stufe `redact`, die Säuberung und der Datenumschlag (`packages/core/src/redaction/`) in den Stufen `redact` und `markUntrusted` und die Maskierung von Fehlermeldungen (`packages/core/src/redaction/message.ts`) auf dem Weg der Fehler der Pipeline (ADR 0024).
- Seit dem 23.10.2026: Die Registry weist ein Tool mit einem Blatt ohne Klasse ab (`tool_unclassified`) und eines mit einem Blatt der Klasse `address` oder `amount` (`tool_unmasked`), in `packages/core/src/registry/registry.ts`, gezählt beim Prüfen des Ausgabeschemas in `schema.ts`. Ein Test geht alle Tools des Kerns durch.
- Phase 4: `strict`, die Masken für `address`, `amount` und `name.last`, Pseudonyme und die Prüfung von Freitext. Folgt.
