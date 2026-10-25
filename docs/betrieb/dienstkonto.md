# Dienstkonto in ChurchTools

**In Entwicklung.** Es gibt noch keine veröffentlichte Version. Diese Seite beschreibt das Konto, mit dem Ecclium ChurchTools liest: wie Sie es anlegen, welche Rechte es braucht, wie Sie sein Login-Token ablegen, prüfen und erneuern und was nach einem Vorfall zu tun ist. Wie Sie den Server bauen und in einen Client einbinden, steht unter [Betrieb über stdio](stdio.md).

## Warum ein eigenes Konto

Ecclium greift mit dem Login-Token eines Kontos auf ChurchTools zu. Das Token trägt alle Rechte dieses Kontos und wirkt ohne zweiten Faktor, auch wenn das Konto eine Zwei-Faktor-Anmeldung hat. Was das Konto in ChurchTools sehen darf, kann über Ecclium ein KI-Assistent sehen, soweit ein Tool es weitergibt. Ein Token eines Clients reicht Ecclium nie an ChurchTools weiter ([ADR 0023](../adr/0023-kein-token-passthrough.md)).

Nehmen Sie deshalb nie Ihr persönliches Konto, sondern ein Dienstkonto nur für Ecclium. So begrenzen Sie seine Rechte auf das, was die Tools brauchen, und können sein Token erneuern, ohne dass Menschen betroffen sind.

## Konto anlegen

- Legen Sie eine Person mit einer sachlichen Bezeichnung als Vor- und Nachname an, etwa «Ecclium Serverkonto», nicht mit dem Namen eines Menschen. Der KI-Assistent sieht beide unmaskiert. Tragen Sie, falls überhaupt, eine E-Mail-Adresse ein, die keiner einzelnen Person gehört.
- Geben Sie dem Konto einen eigenen Personenstatus ohne Berechtigungen. In ChurchTools vergibt auch ein Personenstatus Rechte: Auf einer Testinstanz brachte jeder vorgegebene Status bis auf einen eigene Rechte mit, unter anderem auf Personendaten.
- Nehmen Sie das Konto in keine Gruppe auf. Rechte, die es über eine Gruppe erhielte, zeigt `ct_whoami` womöglich nicht, das ist nicht geprüft.
- Schalten Sie für das Konto die Zwei-Faktor-Anmeldung ein. Ohne sie gibt ChurchTools mit Benutzername und Passwort über `POST /api/login/token` das Login-Token des Kontos heraus, ohne Anmeldung und ohne weiteres Recht. Mit ihr antwortete dieser Endpunkt auf einer Testinstanz mit einem Fehler, und das Login-Token galt in Ecclium weiter ([Befunde zu OAuth](../research/churchtools-oauth.md), O12). Melden Sie sich dafür als das Dienstkonto an und wählen Sie über das Profilbild oben rechts «Mein Profil», dort im Abschnitt «Zwei-Faktor-Authentifizierung» den Knopf «Aktivieren». Den Code liefert eine App wie FreeOTP.
- Geben Sie dem Konto ein langes zufälliges Passwort. Bewahren Sie Passwort und zweiten Faktor auf wie andere Zugangsdaten der Gemeinde, getrennt von der Token-Datei.

## Rechte

Vergeben Sie die Rechte direkt am Konto, nur die der Tools, die Sie einschalten:

| Tool                                     | Recht in ChurchTools                                                                                                                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ct_whoami`                              | keines                                                                                                                                                                                                                                |
| `ct_persons_search`                      | «Personen eines Bereiches sehen» (`churchdb: view alldata`), nur für die Bereiche, in denen gesucht werden soll, «Alle» nur für die ganze Instanz                                                                                     |
| `ct_groups_search`                       | «Gruppen eines Gruppentyps sehen - ausser versteckte» (`churchgroup: view groups of grouptype`), nur für die Gruppentypen, in denen gesucht werden soll                                                                               |
| `ct_persons_get`                         | `churchdb: view alldata` für die Bereiche der Personen, die gelesen werden sollen                                                                                                                                                     |
| `ct_persons_get_groups`                  | `churchdb: view alldata` für die Bereiche der Personen und `churchgroup: view groups of grouptype` für die Gruppentypen, die gelesen werden sollen                                                                                    |
| `ct_groups_get`                          | `churchgroup: view groups of grouptype` für die Gruppentypen und «Gruppeninfos sehen - bis zum gewählten Sicherheitslevel» (`churchgroup: security level group`) mit der niedrigsten Stufe, auf einer Testinstanz «Stufe 1 (Niedrig)» |
| `ct_groups_get_members`                  | `churchgroup: view groups of grouptype` für die Gruppentypen und `churchdb: view alldata` für die Bereiche der Mitglieder, die gelesen werden sollen                                                                                  |
| `ct_wiki_categories_list`                | «"Wiki" sehen» (`churchwiki: view`)                                                                                                                                                                                                   |
| `ct_wiki_pages_list`, `ct_wiki_page_get` | «"Wiki" sehen» (`churchwiki: view`) und `churchwiki: view category`, nur für die Kategorien, die gelesen werden sollen                                                                                                                |

Geben Sie dem Konto keine Stufe von «Personendaten sehen - bis zum gewählten Sicherheitslevel». Kennung und Name kommen ohne sie, und schon die niedrigste Stufe schickt E-Mail-Adresse, Telefon, Geburtstag, Postleitzahl und Ort jeder gelesenen Person an Ecclium. Ecclium gäbe sie nicht weiter, aber sie lägen im Arbeitsspeicher des Servers ([ADR 0060](../adr/0060-leserechte-und-felder-der-suchtools.md), [ADR 0064](../adr/0064-leserechte-und-felder-der-lese-tools.md)). Von «Gruppeninfos sehen - bis zum gewählten Sicherheitslevel» braucht nur `ct_groups_get` die niedrigste Stufe. Diese Stufe bringt Treffzeit, Notiz, Höchstzahl, Zielgruppe, Gründung und Ende einer Gruppe, aber kein Feld mit Personendaten. Die Notiz schreiben Personen der Gemeinde, sie kann trotzdem Personen nennen. Fehlt sie, gibt das Tool den Namen ohne diese Angaben weiter und nennt das Recht. Eine höhere Stufe brauchen die Tools nicht. Auch «‹Personen› sehen», «‹Gruppen› sehen» und «Mitgliederliste sehen» brauchen sie nicht: Auf einer Testinstanz erschienen die Mitglieder einer Gruppe ohne «Mitgliederliste sehen». Rechte zum Schreiben und zur Verwaltung braucht diese Version von Ecclium nicht, sie liest nur.

Die Mitglieder einer Gruppe nennt ChurchTools nur, soweit das Konto ihre Bereiche sehen darf. Mitglieder aus anderen Bereichen lässt es ohne Eintrag weg. Fehlt `view alldata` für die Person, nennt ChurchTools auch ihre Gruppen nicht, und fehlt `view groups of grouptype` für einen Gruppentyp, fehlen dessen Gruppen. In beiden Fällen antwortet es mit einer leeren Liste statt mit einem Fehler, und das Tool sagt, dass sich ein leeres Ergebnis und ein fehlendes Recht nicht unterscheiden lassen.

Die weiteren Lese-Tools für Events, Dienste und Abläufe, Kalender und Termine, Ressourcen und Buchungen, Songs und die Suche kommen mit Phase 2. Welche Rechte jedes braucht, legt [ADR 0064](../adr/0064-leserechte-und-felder-der-lese-tools.md) fest, und die Tabelle oben nennt sie, sobald es das Tool gibt. Keines davon braucht «‹Events› sehen», «‹Kalender› sehen» oder «‹Ressourcen› sehen».

Die Tools des Wikis zeigen nur Kategorien, für die das Konto `view category` hat. Fehlt es für eine Kategorie, nennt ChurchTools ihre Seiten nicht und antwortet mit einer leeren Liste statt mit einem Fehler.

Öffnen Sie die Rechte nach dem Speichern noch einmal. Auf einer Testinstanz waren nach dem Speichern einmal alle Wiki-Kategorien angehakt statt einer. Hat das Konto mehr Rechte als nötig, weist Ecclium es nicht ab. Welche es hat, zeigt `ct_whoami`, und der Smoke-Test meldet eine Sicherheitsstufe für Personen als Befund.

## Login-Token

Das Login-Token holen Sie als das Konto selbst: Melden Sie sich als Dienstkonto an, wählen Sie über das Profilbild oben rechts «Mein Profil» und dort im Abschnitt «Login-Token» den Knopf «Login-Token anzeigen». Danach erscheint dort auch der Knopf «Login-Token erneuern». Die Beschriftungen auf dieser Seite stammen aus ChurchTools 3.137, gesehen am 23.10.2026, und können sich mit späteren Versionen ändern.

Legen Sie das Token in eine Datei, die nur Ihr Benutzer lesen kann, wie unter [Token-Datei](stdio.md#token-datei) beschrieben. Wer das Token kennt, handelt als dieses Konto, bis es in ChurchTools erneuert ist. Geben Sie es nie auf der Kommandozeile ein und nie in eine Konfiguration, die andere lesen.

## Prüfen

1. `ecclium config check` prüft Adresse, Token-Datei und Einstellungen, ohne ChurchTools zu fragen, siehe [Konfiguration prüfen](stdio.md#konfiguration-prüfen).
2. Ob ChurchTools das Token annimmt und welche Rechte das Konto hat, zeigt ein Aufruf von `ct_whoami` im Client oder der [Smoke-Test](stdio.md#smoke-test). Vergleichen Sie die Rechte mit der Tabelle oben.

## Rechte ändern oder entziehen

Prüfen Sie nach jeder Änderung mit `ct_whoami`, was das Token sieht. Das Rücklesen der Rechte in ChurchTools genügt nicht: Auf einer Testinstanz mit ChurchTools 3.137 sah das Token ein über die API entzogenes Recht noch mindestens etwa zwanzig Minuten lang. ChurchTools nannte das einen Fehler im Zwischenspeicher der Rechte, der spätestens nach dem nächsten Cron-Job verschwindet und behoben werden soll. In der Weboberfläche zeigte sich am 22.10.2026 jede Vergabe und jeder Entzug im nächsten Lauf einer Probe, ein Entzug einmal schon nach wenigen Sekunden. Steht ein entzogenes Recht noch da, zeigte es sich auf der Testinstanz nach einer Anmeldung des Kontos in der Weboberfläche nicht mehr. Dass die Anmeldung den Zwischenspeicher leert, ist ein Schluss. Die Einzelheiten stehen unter [Befunde zur API von ChurchTools](../research/churchtools-api.md).

## Token erneuern

Erneuern Sie das Token in ChurchTools, legen Sie das neue in die Token-Datei und starten Sie den Client neu, denn der Server liest die Datei beim Start. Ein erneuertes Token macht das alte ungültig: Auf einer Testinstanz wies ChurchTools das alte Token etwa zehn Sekunden nach dem Erneuern ab. Prüfen Sie danach mit `ct_whoami` oder dem Smoke-Test, dass das neue gilt.

## Nach einem Vorfall

Liegt das Token oder die Token-Datei womöglich bei jemand anderem:

1. Ändern Sie zuerst das Passwort des Kontos und prüfen Sie, dass die Zwei-Faktor-Anmeldung eingeschaltet ist. Ohne sie gibt ChurchTools mit Benutzername und Passwort über `POST /api/login/token` das Login-Token heraus. Ein neues Token allein genügt deshalb nicht.
2. Erneuern Sie danach das Token und legen Sie das neue ab, wie oben beschrieben.
3. Prüfen Sie, dass ChurchTools das alte Token abweist, etwa mit dem Smoke-Test ohne seinen Schalter und mit einer Kopie der alten Datei: `ct_whoami` scheitert dann.
4. Prüfen Sie die Rechte des Kontos mit `ct_whoami` und sehen Sie die Audit-Datei durch, siehe [Audit-Datei](stdio.md#audit-datei).

## Ausser Betrieb nehmen

Entfernen Sie den Eintrag `ecclium` aus dem Client, erneuern Sie das Token in ChurchTools, damit das alte nicht mehr gilt, entziehen Sie dem Konto alle Rechte und löschen Sie die Token-Datei. Ob das Sperren der Person ein Login-Token beendet, ist nicht geprüft.

## Grenzen

- Rechte aus Gruppen zeigt `ct_whoami` womöglich nicht. Deshalb gehört das Dienstkonto in keine Gruppe.
- Ein entzogenes Recht kann noch eine Weile wirken, siehe «Rechte ändern oder entziehen».
- Ein Login-Token von ChurchTools hat keine dokumentierte Ablaufzeit.
