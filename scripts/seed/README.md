# Seed der Testinstanz

Der Seed legt die synthetischen Testdaten der Testinstanz an und setzt sie zurück ([ADR 0061](../../docs/adr/0061-seed-ohne-werkzeug.md)). Er läuft nur auf einer Testinstanz mit ausschliesslich synthetischen Daten ([ADR 0049](../../docs/adr/0049-testumgebung.md)), nie in CI und nie gegen eine produktive Instanz. Er nutzt nur, was Node.js mitbringt, und die gemeinsamen Bausteine der Proben in [`scripts/spike/lib/`](../spike/lib/).

## Befehle

| Befehl          | Was er tut                                                                                                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pruefen`       | Alle Prüfungen des Wächters, dann für jedes Objekt des Datensatzes, ob es da ist. Schreibt nichts und fragt nicht nach.                                                                             |
| `anlegen`       | Legt jedes Objekt an, das fehlt, und lässt jedes vorhandene stehen. Fragt vorher im Terminal nach.                                                                                                  |
| `zuruecksetzen` | Löscht Seiten, Events, Termine, Songs und Buchungen mit dem Kennzeichen, in dieser Reihenfolge, Events mit `sendMail=false`. Struktur, Personen und Gruppen bleiben. Fragt vorher im Terminal nach. |

## Datensatz

Jeder Name und jeder Titel beginnt mit dem Kennzeichen «Seedprobe», jede Person trägt es als Nachnamen. Daran erkennt der Seed seine Objekte, eine State-Datei gibt es nicht. Objekte anderer Herkunft, etwa die der Proben mit «Spikeprobe» oder «Synthetisch», berührt er nicht. Was es zweimal gibt, meldet er als «mehrfach» und lässt es stehen.

- **Struktur:** ein Gruppentyp, ein Kalender, ein Ressourcentyp mit einer Ressource, eine Dienstgruppe mit zwei Diensten, von denen einer die Namen verbirgt, eine Songkategorie und eine Kategorie des Wikis.
- **Personen und Gruppen:** sechs Personen «Person A Seedprobe» bis «Person F Seedprobe» ohne Kontaktdaten und zwei Gruppen mit je vier von ihnen.
- **Inhalte:** zwei Songs mit Arrangements, vier Termine ab dem ersten Samstag mindestens zwei Tage nach dem Lauf, darunter eine Serie und einer über den ganzen Tag mit einer Buchung, zwei Events mit Diensten, Einteilungen und einem Ablauf, eine Buchung und drei Seiten im Wiki: eine in Markdown, eine in HTML und eine lange, die die Lese-Tools in Teilen liefern.

Bereich, Gruppenstatus und Standort kann die API nicht anlegen. Einen Status legt sie seit ChurchTools 3.138 nur mit einer Sicherheitsstufe an, die der Seed wählen müsste. Alle vier kommen deshalb aus der Umgebung, der Status am besten der der synthetischen Personen der Proben, damit das Dienstkonto die Personen des Seeds ebenso sieht.

## Das Seed-Konto

Ein eigenes Konto nur für den Seed: mit einem Status ohne Berechtigungen, in keiner Gruppe, mit Zwei-Faktor-Anmeldung und einer eigenen Token-Datei mit den Rechten 600. Der Wächter verlangt genau diese Rechte, jedes andere steht auf «falsch» oder ist leer:

| Modul            | Rechte                                                                                                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `churchwiki`     | `view`, `view category` nur für die Kennkategorie und die Kategorie «Seedprobe», `edit category` höchstens für «Seedprobe», `edit masterdata`                                                 |
| `churchdb`       | `view`, `view alldata` nur für den Bereich aus `ECCLIUM_SEED_DEPARTMENT_ID`, `create person`, `write access`, `edit masterdata`, dazu die Rechte auf Gruppen, die ChurchTools hier wiederholt |
| `churchgroup`    | `view`, `create groups of grouptype`, `view groups of grouptype`, `edit group memberships of grouptype`, `edit masterdata`                                                                    |
| `churchcal`      | `view`, `view category`, `edit category`, `admin church category`                                                                                                                             |
| `churchresource` | `view`, `view resource`, `create bookings`, `administer bookings`, `edit masterdata`                                                                                                          |
| `churchservice`  | `view`, `view servicegroup`, `edit servicegroup`, `view events`, `edit events`, `view agenda`, `edit agenda`, `view songcategory`, `edit songcategory`, `edit masterdata`                     |

Ausser im Wiki gelten die Rechte für «Alle», weil der Seed Kalender, Ressourcen, Dienstgruppen und Songkategorien selbst anlegt und dort danach schreibt. Im Wiki nie «Alle»: Sonst wird die Kennkategorie bearbeitbar, und der Wächter bricht ab.

Die Kategorie «Seedprobe» legt der Seed im ersten Lauf an, zusammen mit dem Kalender. Sehen und bearbeiten darf das Konto sie erst, wenn Sie ihm diese beiden Rechte geben. Die Seiten entstehen deshalb im zweiten Lauf von `anlegen`. Ein späterer Lauf legt die Kategorie nie noch einmal an.

## Ausführung

Node.js 24.21.0, wie in `.nvmrc`. Kein `pnpm install` nötig. Starten Sie den Seed mit `env -i`, damit keine andere Variable mitläuft, und tippen Sie den Schalter von Hand ein:

```sh
env -i \
  ECCLIUM_SEED_BASE_URL=https://example.church.tools \
  ECCLIUM_SEED_ALLOW_WRITE=example \
  ECCLIUM_SEED_TOKEN_FILE=/pfad/zur/token-seed \
  ECCLIUM_SEED_DEPARTMENT_ID=2 \
  ECCLIUM_SEED_STATUS_ID=0 \
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

Personen haben keine E-Mail-Adresse und bekommen keine Einladung, Mitglieder kommen mit `informLeader: false` in eine Gruppe, die Dienste senden weder Anfragen noch Erinnerungen, und Events löscht der Seed mit `sendMail=false`. In einen Dienst teilt er erst ein, wenn er zurückgelesen hat, dass der Dienst keine Mails sendet. Macht ChurchTools das Seed-Konto zum Mitglied einer neuen Gruppe, nimmt der Seed es wieder heraus.

## Fehler und Abbruch

Lehnt die Instanz eine schreibende Anfrage ab, steht ihr Status in der Ausgabe, und der Seed macht mit allem weiter, was nicht davon abhängt. Nach einem Fehler im Netz oder einem Zeitlimit hört er auf, weil niemand weiss, ob die Instanz geschrieben hat, und nennt den Code unter `abbruch`. Keine Anfrage geht zweimal hinaus. Vor jeder schreibenden Anfrage wartet er etwas mehr als eine Sekunde.

Ist ein Termin schon da, lässt der Seed auch sein Event, die Einteilungen und den Ablauf stehen. Ein Event, das ein früherer Lauf nur halb angelegt hat, braucht deshalb zuerst `zuruecksetzen`.

## Ausgabe

Wie bei den Proben stehen auf stderr zuerst die Version von Node.js und die SHA-256 der Dateien dieses Ordners und von `scripts/spike/lib/`. Vergleichen Sie sie mit dem Pull Request. Auf stdout steht JSON nur aus Kürzeln des Datensatzes (`st`, `pA`, `gH`, `a1`, `e2`, `w3` …), festen Wörtern wie «angelegt», «vorhanden», «fehlt» oder «geloescht» und Statuscodes. Keine IDs, keine Namen, keine Daten. Vor der Ausgabe prüft sie dieselbe Sicherung wie bei den Proben ([`scripts/spike/README.md`](../spike/README.md), «Sicherung vor jeder Ausgabe»).

## Codes

| Code | Bedeutung                                                                              |
| ---- | -------------------------------------------------------------------------------------- |
| 0    | Gelaufen. Ob alles angelegt ist und ob der Seed abgebrochen hat, steht in der Ausgabe. |
| 2    | Umgebung, Datei oder Wächter. Es wurde nichts geschrieben.                             |
| 3    | Ausgabe zurückgehalten.                                                                |
| 4    | Die Instanz ist nicht erreichbar oder liefert kein lesbares OpenAPI-Dokument.          |
| 70   | Interner Fehler.                                                                       |

## Tests

Die Tests in `tests/seed/` laufen mit `pnpm test`, ohne Netz, gegen eine synthetische Instanz im Speicher, deren Antworten Kanarienwerte tragen. Keiner davon darf in einer Ausgabe erscheinen. Ein Test zeigt, dass jeder Befehl ohne Kennkategorie abbricht, bevor eine schreibende Anfrage hinausgeht.
