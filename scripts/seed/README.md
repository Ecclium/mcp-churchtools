# Seed der Testinstanz

Der Seed legt die synthetischen Testdaten der Testinstanz an und setzt sie zurück ([ADR 0061](../../docs/adr/0061-seed-ohne-werkzeug.md)). Er läuft nur auf einer Testinstanz mit ausschliesslich synthetischen Daten ([ADR 0049](../../docs/adr/0049-testumgebung.md)), nie in CI und nie gegen eine produktive Instanz. Er nutzt nur, was Node.js mitbringt, und die gemeinsamen Bausteine der Proben in [`scripts/spike/lib/`](../spike/lib/).

## Befehle

| Befehl          | Was er tut                                                                                                                                                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pruefen`       | Alle Prüfungen des Wächters, dann für Struktur, Personen, Gruppen, Songs, Termine, Events, die Buchung und die Seiten, ob sie da sind, bei einem Event auch, ob es den Titel seines Termins als Namen trägt. Einteilungen und Ablauf prüft er nicht. Schreibt nichts und fragt nicht nach. |
| `anlegen`       | Legt jedes Objekt an, das fehlt, und lässt jedes vorhandene stehen. Fragt vorher im Terminal nach.                                                                                                                                                                                         |
| `zuruecksetzen` | Löscht Seiten, Events, Termine, Songs und Buchungen mit dem Kennzeichen, in dieser Reihenfolge, Events mit `sendMail=false`. Struktur, Personen und Gruppen bleiben. Fragt vorher im Terminal nach.                                                                                        |

## Datensatz

Jeder Name und jeder Titel beginnt mit dem Kennzeichen «Seedprobe», jede Person trägt es als Nachnamen. Daran erkennt der Seed seine Objekte, eine State-Datei gibt es nicht, und er sucht sie nur in seiner eigenen Struktur: Gruppen in seinem Gruppentyp, Songs in seiner Songkategorie, Buchungen an seiner Ressource, das prüft er in jedem Eintrag selbst. Objekte anderer Herkunft, etwa die der Proben mit «Spikeprobe» oder «Synthetisch», berührt er nicht. Was es zweimal gibt, meldet er als «mehrfach» und lässt es stehen.

- **Struktur:** ein Gruppentyp, ein Kalender, ein Ressourcentyp mit einer Ressource, eine Dienstgruppe mit zwei Diensten, von denen einer die Namen verbirgt, eine Songkategorie und eine Kategorie des Wikis.
- **Personen und Gruppen:** sechs Personen «Person A Seedprobe» bis «Person F Seedprobe» ohne Kontaktdaten und zwei Gruppen mit je vier von ihnen.
- **Inhalte:** zwei Songs mit Arrangements, vier Termine ab dem ersten Samstag mindestens zwei Tage nach dem Lauf, darunter eine Serie und einer über den ganzen Tag mit einer Buchung, zwei Events mit Diensten, Einteilungen und einem Ablauf, eine Buchung und drei Seiten im Wiki: eine in Markdown, eine in HTML und eine lange, die die Lese-Tools in Teilen liefern. Bei den Events bleibt ein Platz offen, und eine Person dient an beiden Tagen.
- **Korpus der Prompt-Injections:** je Fall des Korpus aus `packages/testkit/src/injection/` eine Seite in Markdown «Seedprobe Korpus <Kennung>» mit dem Text des Falls, in der Kategorie «Seedprobe». Den Fall `en-javascript-link` lässt der Seed aus: Ob ChurchTools einen Link entschärft, dessen Ziel ein Skript ausführt, ist nicht geprüft, und ein Klick darauf liefe im Browser einer Person auf der Instanz. Dazu kommen zwei Termine, deren Titel nach «Seedprobe Korpus: » die Zeile eines Falls tragen: einer mit Event und einem offenen Platz am Sonntag nach dem Samstag, für `dienstplan-report`, und einer ohne Event eine Woche später, für `termin-vorschau`. Läuft die Routine in der Woche von `anlegen`, liegt jeder im Zeitraum, den sie liest. Schreibt ein Modell einen Titel nur ab, bleibt er Text, den die ContentPolicy durchlässt; den Bericht ändert nur ein Modell, das der Anweisung folgt. Die Texte hält der Seed selbst in `lib/corpus.mts`, ein Test in `tests/seed/` hält sie gleich mit dem Korpus. Hosts stehen darin nur unter `example`, `example.org` und `example.church.tools`, und die Erwähnung nennt `person-id-1`, keine Person der Instanz. Der Seed sendet die Texte so. Ob ChurchTools HTML-Kommentare und Unicode-Tag-Zeichen unverändert speichert und wie es sie zeigt, prüft er nicht.

Bereich und Gruppenstatus kann die API nicht anlegen. Einen Status legt sie seit ChurchTools 3.138 nur mit einer Sicherheitsstufe an, die der Seed wählen müsste. Den Standort nimmt der Seed aus der Umgebung, damit seine Personen und Gruppen neben denen der Proben liegen. Verlangt die Instanz für jede neue Person die Angaben zur Datenschutzerklärung, wie die Testinstanz, nimmt der Seed Art und Herkunft der Zustimmung ebenfalls aus der Umgebung, mit dem Tag des Laufs als Datum. Alle diese Werte kommen aus der Umgebung, der Status am besten der der synthetischen Personen der Proben, damit das Dienstkonto die Personen des Seeds ebenso sieht.

## Das Seed-Konto

Ein eigenes Konto nur für den Seed: mit einem Status ohne Berechtigungen, in keiner Gruppe, mit Zwei-Faktor-Anmeldung und einer eigenen Token-Datei mit den Rechten 600. Der Wächter lässt höchstens diese Rechte zu, jedes andere muss auf «falsch» stehen oder leer sein:

| Modul            | Rechte                                                                                                                                                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `churchwiki`     | `view`, `view category` nur für die Kennkategorie und die Kategorie «Seedprobe», `edit category` höchstens für «Seedprobe», `edit masterdata`                                                                                                       |
| `churchdb`       | `view`, `view alldata` nur für den Bereich aus `ECCLIUM_SEED_DEPARTMENT_ID`, `security level person` nur in der niedrigsten Stufe, `create person`, `write access`, `edit masterdata`, dazu die Rechte auf Gruppen, die ChurchTools hier wiederholt |
| `churchgroup`    | `view`, `create groups of grouptype`, `view groups of grouptype`, `edit group memberships of grouptype`, `edit masterdata`                                                                                                                          |
| `churchcal`      | `view`, `view category`, `edit category`, `admin church category`                                                                                                                                                                                   |
| `churchresource` | `view`, `view resource`, `create bookings`, `administer bookings`, `edit masterdata`                                                                                                                                                                |
| `churchservice`  | `view`, `view servicegroup`, `edit servicegroup`, `view events`, `edit events`, `view agenda`, `edit agenda`, `view songcategory`, `edit songcategory`, `edit masterdata`                                                                           |

Ohne Sicherheitsstufe für Personen darf das Konto kein Feld einer Person schreiben und deshalb keine Person anlegen. ChurchTools antwortet dann mit 403. Die niedrigste Stufe genügt, sie zeigt dem Konto bei den Personen seines Bereichs auch Kontaktdaten. Dort liegen nur synthetische Personen. Legt der Seed eine Gruppe an, gibt ChurchTools dem Konto das Recht, sie zu bearbeiten (`edit group`). Der Wächter lässt das nicht durch, entfernen Sie es nach dem Lauf, der die Gruppen angelegt hat.

Ausser im Wiki gelten die Rechte für «Alle», weil der Seed Kalender, Ressourcen, Dienstgruppen und Songkategorien selbst anlegt und dort danach schreibt. Im Wiki nie «Alle»: Sonst wird die Kennkategorie bearbeitbar, und der Wächter bricht ab.

Die Kategorie «Seedprobe» legt der Seed im ersten Lauf an, zusammen mit dem Kalender. Sehen und bearbeiten darf das Konto sie erst, wenn Sie ihm diese beiden Rechte geben. Die Seiten entstehen deshalb im zweiten Lauf von `anlegen`. Ein späterer Lauf legt die Kategorie nie noch einmal an, weil das Konto sie ohne diese Rechte nicht sieht. Bricht der erste Lauf vor der Kategorie ab oder lehnt die Instanz sie ab, legen Sie die Kategorie «Seedprobe» von Hand an. Löschen Sie den Kalender von Hand, legt der nächste Lauf mit dem Kalender auch eine neue Kategorie an.

## Ausführung

Node.js 24.21.0, wie in `.nvmrc`. Kein `pnpm install` nötig. Starten Sie den Seed mit `env -i`, damit keine andere Variable mitläuft, und tippen Sie den Schalter von Hand ein:

```sh
env -i \
  ECCLIUM_SEED_BASE_URL=https://example.church.tools \
  ECCLIUM_SEED_ALLOW_WRITE=example \
  ECCLIUM_SEED_TOKEN_FILE=/pfad/zur/token-seed \
  ECCLIUM_SEED_DEPARTMENT_ID=2 \
  ECCLIUM_SEED_STATUS_ID=0 \
  ECCLIUM_SEED_PRIVACY_TYPE_ID=3 \
  ECCLIUM_SEED_PRIVACY_WHO_ID=1 \
  ECCLIUM_SEED_GROUP_STATUS_ID=1 \
  ECCLIUM_SEED_CAMPUS_ID=2 \
  node scripts/seed/seed.mts pruefen
```

Die Adresse oben ist der Platzhalter, den der Wächter abweist. `ECCLIUM_SEED_ALLOW_WRITE` muss dem ersten Teil des Hosts entsprechen. `anlegen` und `zuruecksetzen` brauchen ein Terminal für die Bestätigung mit «ja».

## Der Wächter

Vor jeder Anfrage prüft der Seed nur mit seiner Umgebung: Der Schalter passt zum Host, die Adresse ist nicht der Platzhalter, keine andere Token-Variable ist gesetzt (`ECCLIUM_SPIKE_TOKEN_FILE`, `ECCLIUM_SPIKE_WRITE_TOKEN_FILE`, `ECCLIUM_CHURCHTOOLS_TOKEN_FILE`, `ECCLIUM_CHURCHTOOLS_TOKEN`), und die IDs sind ganze Zahlen, nur der Status darf 0 sein. Dann liest er das OpenAPI-Dokument und prüft lesend:

- Die Instanz dokumentiert jede Operation des Seeds und jeden Parameter, den er sendet, auch `sendMail` beim Löschen eines Events.
- Genau eine Kategorie heisst `testinstanz-kennung`, und das Konto darf sie weder bearbeiten noch löschen. Ausser ihr sieht es höchstens «Seedprobe». Fehlt sie, gilt die Instanz als produktiv.
- Die Rechte des Kontos stehen in der Tabelle oben.

Erst dann fragt er im Terminal nach und gibt den Client heraus, der schreibt. Was er nicht prüfen kann, wertet er als Grund zum Abbruch.

## Keine Nachrichten

Der Seed ist so gebaut, dass er keine Nachricht auslöst: Personen haben keine E-Mail-Adresse und bekommen keine Einladung, Mitglieder kommen mit `informLeader: false` in eine Gruppe, die Dienste senden weder Anfragen noch Erinnerungen, und Events löscht der Seed mit `sendMail=false`. Einen Termin mit Event löscht er erst, wenn das Event gelöscht ist, weil ChurchTools sonst das Event ohne `sendMail=false` mitnimmt. In einen Dienst teilt er erst ein, wenn er zurückgelesen hat, dass der Dienst keine Mails sendet, und er setzt Person und Zusage mit `isAccepted` in einem Aufruf. Macht ChurchTools das Seed-Konto zum Mitglied einer neuen Gruppe, nimmt der Seed es wieder heraus. Ob ChurchTools die Verwalter einer Ressource über eine Buchung benachrichtigt, ist nicht geprüft. Die Felder im Body prüft der Wächter nicht gegen das OpenAPI-Dokument.

## Fehler und Abbruch

Lehnt die Instanz eine schreibende Anfrage ab, steht ihr Status in der Ausgabe, und der Seed macht mit allem weiter, was nicht davon abhängt. Kann er eine Liste nicht lesen, legt er nichts an, was darin stehen müsste, und meldet «antwort unerwartet». Das gilt auch für die Liste der Seiten einer Kategorie, wenn sie in `meta.count` mehr Seiten nennt, als sie bringt, weil sie nicht blättert. Nach einem Fehler im Netz oder einem Zeitlimit hört er auf, weil niemand weiss, ob die Instanz geschrieben hat, nennt den Code unter `abbruch` und meldet die Anfrage, die er zuletzt geschickt hat, als «ungewiss». Prüfen Sie dieses Objekt in der Weboberfläche. Keine Anfrage geht zweimal hinaus. Vor jeder schreibenden Anfrage wartet er etwas mehr als eine Sekunde, für die Seiten und Termine des Korpus zusammen rund 22 Sekunden.

Ist ein Termin schon da, lässt der Seed auch sein Event, die Einteilungen und den Ablauf stehen, und ist ein Song da, auch seine Arrangements. Ein Termin, ein Event oder ein Song, die ein früherer Lauf nur halb angelegt hat, etwa weil ein Dienst oder die Ressource fehlte, braucht deshalb zuerst `zuruecksetzen`.

Termine, Events und Buchungen sucht der Seed von 90 Tagen vor bis 120 Tage nach dem Lauf. Liegt ein früherer Lauf weiter zurück, findet `anlegen` dessen Termine nicht mehr und legt einen zweiten Satz an, den `zuruecksetzen` ebenso wenig findet. Setzen Sie die Daten deshalb zurück, bevor 90 Tage vergangen sind. Weil `anlegen` nur anlegt, was fehlt, liegen die Termine eines früheren Laufs bei einem späteren in der Vergangenheit. Soll eine Routine sie lesen, setzen Sie kurz vorher zurück und legen neu an.

## Ausgabe

Wie bei den Proben stehen auf stderr zuerst die Version von Node.js und die SHA-256 der Dateien dieses Ordners, von `scripts/spike/00-inventory.mts` und von `scripts/spike/lib/`. Vergleichen Sie sie mit dem Pull Request. Auf stdout steht JSON nur aus Kürzeln des Datensatzes (`gy`, `pA`, `gH`, `a1`, `e2`, `w3` …, für die Seiten des Korpus die Kennung des Falls wie `de-html-comment`), festen Wörtern wie «angelegt», «vorhanden», «fehlt», «geloescht» oder «anderer Name» und Statuscodes. Keine IDs, keine Namen, keine Daten. Vor der Ausgabe prüft sie dieselbe Sicherung wie bei den Proben ([`scripts/spike/README.md`](../spike/README.md), «Sicherung vor jeder Ausgabe»).

## Codes

| Code | Bedeutung                                                                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | Gelaufen, ohne Abbruch. Ob alles angelegt ist, steht in der Ausgabe.                                                                                                           |
| 2    | Umgebung, Datei oder Wächter. Es wurde nichts geschrieben.                                                                                                                     |
| 3    | Ausgabe zurückgehalten.                                                                                                                                                        |
| 4    | Die Instanz ist nicht erreichbar, liefert kein lesbares OpenAPI-Dokument, oder der Lauf hat nach einem Fehler im Netz abgebrochen. Den Code nennt die Ausgabe unter `abbruch`. |
| 70   | Interner Fehler.                                                                                                                                                               |

## Tests

Die Tests in `tests/seed/` laufen mit `pnpm test`, ohne Netz, gegen eine synthetische Instanz im Speicher, deren Antworten Kanarienwerte tragen. Keiner davon darf in einer Ausgabe erscheinen. Ein Test zeigt, dass jeder Befehl ohne Kennkategorie abbricht, bevor eine schreibende Anfrage hinausgeht.
