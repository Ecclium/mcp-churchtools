# ADR 0026: Redaction über klassifizierte Ausgabeschemas, Pseudonyme nach RFC 8452

- Status: Angenommen am 23.10.2026
- Datum: 23.10.2026
- Fällt vor: Phase 2

## Kontext

Antworten von ChurchTools tragen Personendaten. Sie lassen auf die Religionszugehörigkeit schliessen und gehören damit zu den besonderen Kategorien nach Art. 9 DSGVO und zu den besonders schützenswerten Daten nach revDSG (Threat Model, W1). Welche Felder einer Antwort Personendaten sind, kann der Kern nicht aus der OpenAPI-Spezifikation lesen: Sie ist an mehreren Stellen ungenau (`docs/research/churchtools-api.md`, etwa F27 und F32), und ob ein Feld eine Person beschreibt, sagt sie nicht.

Seit Phase 1 gilt:

- Der ChurchTools-Client liest nur die Felder seiner eigenen Schemas (ADR 0025, ADR 0057). Die Pipeline lässt nichts durch, was das Ausgabeschema eines Tools nicht deklariert (ADR 0024).
- Jedes Blatt eines Ausgabeschemas kann eine Datenklasse aus einer geschlossenen Liste im Register von zod tragen: `none`, `personId`, `name.first`, `name.last`, `email`, `phone`, `birthdate`, `address`, `amount` und `untrusted` (Plugin-Schnittstelle, `data-class.ts`). Aus den Klassen leitet die Registry die kleinste zulässige Sensibilität eines Tools ab (ADR 0024, Umsetzung).
- Die Pipeline maskiert E-Mail-Adressen, Telefonnummern und Geburtsdaten, auch in Fehlermeldungen, entfernt unsichtbare Zeichen aus jedem Text und setzt jeden Text der Klasse `untrusted` in einen Datenumschlag mit zufälliger Grenze (ADR 0024). Ein Blatt ohne Klasse ist erlaubt und bleibt unmaskiert. Die Stufe `strict` weist die Konfiguration ab (ADR 0055).
- Ein Blatt trägt höchstens eine Klasse. Namen von Personen tragen `name.first` und `name.last` und stehen nicht im Umschlag. Ob sie zusätzlich in den Umschlag kommen, sollte dieses ADR vor Phase 2 entscheiden (ADR 0060).

In Phase 2 kommen die übrigen Lese-Tools dazu, mit Mitgliederlisten, Dienstzuteilungen und Seiten des Wikis. Danach folgen in Phase 4 die Stufe `strict` und Pseudonyme. Die MCP-Spezifikation 2026-07-28 kennt keine Sitzung mehr, an die sich ein Pseudonym binden liesse (ADR 0053).

## Optionen

Zur Grundlage der Maskierung:

1. **Klassifizierte eigene Schemas, Pflicht für jedes Blatt:** Jedes Tool sagt für jedes Feld, was es enthält, und die Registry weist ein Tool mit einem Blatt ohne Klasse ab. Ein vergessenes Feld fällt beim Start auf, nicht erst in einer Antwort.
2. **Klassifizierte Schemas, Pflicht nur in der Durchsicht:** weniger Prüfcode, aber ein Feld ohne Klasse ginge unmaskiert hinaus, wenn die Durchsicht es übersieht.
3. **Erkennung an der Form der Werte:** findet eine E-Mail-Adresse auch dort, wo kein Schema sie erwartet, erkennt aber weder Namen noch Kennungen und irrt bei Zahlen. Sie taugt als zusätzliche Prüfung für Freitext in `strict`, nicht als Grundlage.

Zu Namen von Personen und dem Datenumschlag:

1. **Namen ausserhalb des Umschlags:** Namen behalten ihre Klassen, und `strict` kann Nachnamen kürzen. Ein Name, der wie eine Anweisung aussieht, erreicht das Modell ohne Umschlag.
2. **Namen im Umschlag:** Ein Blatt bräuchte dafür neben seiner Klasse eine zweite Angabe, und jeder Name kostete die Marken des Umschlags, etwa 80 Zeichen. Eine Mitgliederliste mit 50 Einträgen verlöre damit rund 8 KiB der Grenze von 64 KiB je Ergebnis.

Zu Pseudonymen:

1. **AES-GCM-SIV nach RFC 8452:** deterministisch, ohne Zustand rückübersetzbar, mit Schlüsseln je Mandant, Prinzipal und Tag aus einem Hauptschlüssel.
2. **HMAC mit Zuordnung im Arbeitsspeicher:** nicht rückübersetzbar, braucht eine Tabelle je Mandant, Prinzipal und Tag, die ein Neustart verliert.
3. **Zufällige Pseudonyme mit Tabelle:** braucht Zustand über Anfragen hinweg und damit einen weiteren Port (ADR 0051).

## Entscheid

- **Klassen sind Pflicht.** Jedes Blatt eines Ausgabeschemas trägt genau eine Datenklasse aus der Liste oben. Ab Phase 2 weist die Registry ein Tool mit einem Blatt ohne Klasse ab, beim Hinzufügen und damit beim Start. Ein Test läuft die Schemas aller Tools des Kerns ab.
- **Neue Klassen** kommen nur mit einem Nachtrag zu diesem ADR, der sagt, was jede Stufe mit ihr tut. Eine Klasse für Kennungen von Gruppen folgt, sobald Kennungen ins Audit kommen (ADR 0028, ADR 0060).
- **Was jede Stufe tut:**

  | Klasse       | `off`       | `standard`             | `strict`                                                        |
  | ------------ | ----------- | ---------------------- | --------------------------------------------------------------- |
  | `none`       | unverändert | unverändert            | unverändert                                                     |
  | `personId`   | unverändert | unverändert            | Pseudonym                                                       |
  | `name.first` | unverändert | unverändert            | unverändert                                                     |
  | `name.last`  | unverändert | unverändert            | gekürzt auf den ersten Buchstaben                               |
  | `email`      | unverändert | maskiert               | maskiert                                                        |
  | `phone`      | unverändert | maskiert               | maskiert                                                        |
  | `birthdate`  | unverändert | nur das Jahr           | nur das Jahr                                                    |
  | `address`    | unverändert | nur der Ort            | nur der Ort                                                     |
  | `amount`     | unverändert | gerundet oder entfernt | entfernt                                                        |
  | `untrusted`  | Umschlag    | Umschlag               | Umschlag, dazu Prüfung auf E-Mail, Telefon, IBAN und AHV-Nummer |

  Jede Maskierung ist im Ergebnis sichtbar. Unsichtbare Zeichen entfernt die Pipeline in jeder Stufe aus jedem Text, den Umschlag setzt sie in jeder Stufe, auch in `off`, weil beides gegen Injection schützt und nicht Personendaten. `off` gibt es nur über stdio, mit einer Warnung beim Start. In `strict` weist der Server rohe Kennungen von Personen in Eingaben ab.

- **Geltungsbereich:** Die Maskierung gilt für Text und strukturierten Inhalt eines Ergebnisses, für Ressourcen und für Fehlermeldungen. In Fehlermeldungen gibt es kein Schema, dort maskiert sie nach der Form der Werte (ADR 0054).
- **Bis Phase 4:** Gebaut sind die Masken für `email`, `phone` und `birthdate`. Bis die Masken für `address` und `amount` stehen, weist die Registry auch ein Blatt mit einer dieser Klassen ab, damit kein solches Feld unmaskiert hinausgeht. `strict` weist die Konfiguration bis dahin weiter ab.
- **Namen von Personen** bleiben ausserhalb des Datenumschlags, mit ihren Klassen `name.first` und `name.last`. Namen von Gruppen, Titel, Texte und jeder andere Freitext aus ChurchTools tragen `untrusted` und stehen im Umschlag.
- **Pseudonyme** entstehen in `strict` mit AES-GCM-SIV nach RFC 8452. Den Schlüssel eines Tages leitet HKDF aus dem Geheimnis `pseudonym_key` mit Mandant, Prinzipal und dem UTC-Tag ab. Prinzipal ist das Subjekt der Anmeldung am Server, im Betrieb über stdio die konfigurierte Identität (ADR 0037, ADR 0055), nie das Dienstkonto, weil sonst alle Nutzer eines Servers dieselben Pseudonyme sähen. Pseudonyme sind damit ohne Tabelle in Kennungen zurückzuübersetzen. Beim Wechsel des Hauptschlüssels gelten alter und neuer einen Tag lang nebeneinander, damit Pseudonyme des Vortags rückübersetzbar bleiben. Steht AES-GCM-SIV in Phase 4 nicht in geprüfter Form zur Verfügung, gilt die zweite Option: HMAC mit einer Zuordnung im Arbeitsspeicher je Mandant, Prinzipal und Tag.

## Konsequenzen

- Ein Tool, das ein Feld ohne Klasse ausgibt, startet nicht. Das gilt auch für Tools aus Plugins und kann ein Plugin aus Phase 1 brechen. Veröffentlicht ist bis Phase 8 keines.
- Felder mit Adressen oder Beträgen kann bis Phase 4 kein Tool ausgeben. Für die Lese-Tools von Phase 2 ist das gewollt: Das Dienstkonto liest in Phase 2 keine Kontaktdaten von Personen.
- Die Klasse sagt der Pipeline, was ein Feld enthält. Ist sie falsch gewählt, maskiert die Pipeline falsch. Dagegen stehen die Durchsicht jedes Tools und Tests mit Kanarienwerten in jedem Feld.
- Pseudonyme sind eine Pseudonymisierung im Sinn von Art. 4 Nr. 5 DSGVO, keine Anonymisierung: Wer `pseudonym_key` hat, übersetzt sie zurück. `docs/privacy.md` sagt das, sobald es Pseudonyme gibt. Der Schlüssel gehört in die Sicherung, damit Pseudonyme nach einer Wiederherstellung gleich bleiben.
- Zwei Prinzipale sehen für dieselbe Person verschiedene Pseudonyme, und am nächsten Tag ein anderes. Über Tage hinweg lassen sich Pseudonyme deshalb nicht verketten, ein Modell kann eine Person aber auch nicht über Tage wiedererkennen.
- Für AES-GCM-SIV kommt in Phase 4 voraussichtlich eine Abhängigkeit dazu. Sie wird dann wie jede neue Abhängigkeit begründet.
- **Restrisiken:**
  - **Namen als Anweisung:** Ein Name einer Person kann Text tragen, der wie eine Anweisung aussieht, und erreicht das Modell ohne Umschlag. Die Pipeline entfernt unsichtbare Zeichen, die Schemas begrenzen die Länge, und jede Beschreibung sagt, dass Inhalte aus ChurchTools Daten sind (Threat Model, T7).
  - **Maskierung ist Schadensbegrenzung:** Auch maskiert bleiben Name, Jahrgang und Ort einer Person erkennbar. Eine Anonymisierung im rechtlichen Sinn ist das nicht.
  - **Freitext:** Personendaten in Freitext, etwa in einer Seite des Wikis, erkennt `standard` nicht. `strict` prüft Freitext auf Muster, findet aber keine Namen.

## Umsetzung

- Seit Phase 1: die Klassen in der Plugin-Schnittstelle (`packages/plugin-api/src/data-class.ts`), die Masken für `email`, `phone` und `birthdate` (`packages/core/src/redaction/mask.ts`), die Maskierung von Fehlermeldungen (`packages/core/src/redaction/message.ts`), die Säuberung und der Datenumschlag (`packages/core/src/redaction/`), alle in der Stufe `redact` der Pipeline (ADR 0024).
- Phase 2: Die Registry weist Blätter ohne Klasse und Blätter mit `address` oder `amount` ab. Folgt.
- Phase 4: `strict`, die Masken für `address`, `amount` und `name.last`, Pseudonyme und die Prüfung von Freitext. Folgt.
