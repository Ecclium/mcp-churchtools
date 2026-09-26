# REST-API von ChurchTools: Fragen und Befunde

Stand: 26.09.2026, Gerüst vor dem API-Spike

Dieses Dokument hält fest, was Ecclium über die REST-API von ChurchTools wissen muss, bevor die ersten Tools entstehen, und worauf sich jede Aussage stützt. Eine Aussage gilt erst als belegt, wenn eine Probe sie an einer Instanz bestätigt hat. «Laut Dokumentation» heisst: so beschrieben, im Spike noch nicht geprüft. Was weder Dokumentation noch Spike belegen, steht unter «Offen» in [`docs/STATUS.md`](../STATUS.md).

## Methode

- Die Fragen ergeben sich aus den Tools, die Ecclium für Wiki, Rechte und Anmeldung braucht.
- Der erste Teil des Spikes liest nur. Die Proben in [`scripts/spike/`](../../scripts/spike/README.md) laufen mit einem eng berechtigten Dienstkonto gegen eine Wiki-Kategorie nur für Tests. Sie geben nur die Struktur der Antworten aus, keine Werte, mit der Version von ChurchTools als einziger Ausnahme.
- Ein zweiter Teil folgt. Er schreibt nur in der Testkategorie und nur mit einem ausdrücklichen Schalter und prüft die Fragen zum Ändern von Wiki-Seiten.
- Die Ausgaben der Proben werden vor dem Weitergeben durchgesehen. In dieses Dokument kommen nur Befunde über die Struktur und das Verhalten der API, nie Daten einer Gemeinde.
- Jeder Befund nennt die Version von ChurchTools, an der er geprüft wurde, und die Probe, die ihn belegt. Ein Befund gilt für diese Version, bis eine spätere Prüfung etwas anderes zeigt.

## Quellen

- OpenAPI-Spezifikation der ChurchTools-API, Version 3.136.2. Die Proben lesen das Dokument der jeweiligen Instanz unter `/system/runtime/swagger/openapi.json`. Die Spezifikation nennt in `info.license` die Lizenz CC BY 4.0. Das Repository enthält trotzdem keine Kopie, bis der Lizenzstatus der übrigen Dokumentation geklärt ist (ADR 0027).
- ChurchTools Academy, die Hilfeseiten des Herstellers, mit den Abschnitten zur API.
- Ein Beitrag eines Mitarbeiters des Herstellers im Forum von ChurchTools zum Rate-Limit.

Das Repository nennt keinen Host einer Instanz, auch nicht den einer Demo-Instanz.

## Fragen

| Nr. | Frage                                                                                                                            | Probe                             | Stand vor dem Spike                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Welche Version von ChurchTools läuft, und dokumentiert die Instanz alle Operationen, die Ecclium braucht?                        | `00-inventory`                    | Offen.                                                                                                                                              |
| F2  | Wie meldet sich ein Dienstkonto mit einem Token an?                                                                              | `01-auth`                         | Laut Dokumentation mit dem Header `Authorization: Login` und dem Token.                                                                             |
| F3  | Entsteht bei einer Anfrage mit Token eine Sitzung, erkennbar an einem Cookie?                                                    | `01-auth`                         | Offen.                                                                                                                                              |
| F4  | Was erhält eine Anfrage ohne Token oder mit ungültigem Token, mit und ohne `only_allow_authenticated=true`?                      | `01-auth`                         | Offen.                                                                                                                                              |
| F5  | Wie ist die Antwort von `GET /api/permissions/global` aufgebaut, und wie lässt sich der Umfang der Rechte eines Kontos erkennen? | `02-permissions`                  | Offen.                                                                                                                                              |
| F6  | Welche Felder hat `meta.pagination`, und was liefert eine Seite hinter der letzten?                                              | `03-pagination-errors`            | Laut Dokumentation sind `current` und `lastPage` die einzigen Pflichtfelder.                                                                        |
| F7  | Hat `limit` eine Obergrenze, und wie zeigt die API sie an?                                                                       | `03-pagination-errors`            | Laut Dokumentation keine Obergrenze.                                                                                                                |
| F8  | Wie sehen die Antworten 400, 401, 403 und 404 aus?                                                                               | `01-auth`, `03-pagination-errors` | Laut Dokumentation uneinheitlich.                                                                                                                   |
| F9  | Woran erkennt man das Format einer Wiki-Seite?                                                                                   | `04-wiki-read`                    | Laut Dokumentation am Feld `isMarkdown`.                                                                                                            |
| F10 | Wann steigt die Version einer Wiki-Seite, und entspricht `version` einer Seite der neuesten Version ihrer Liste?                 | `04-wiki-read`, zweiter Teil      | Laut Dokumentation steigt `version` nur bei einer Änderung des Texts.                                                                               |
| F11 | Lässt sich beim Ändern einer Wiki-Seite verhindern, dass eine Änderung von Hand überschrieben wird?                              | zweiter Teil                      | Laut Dokumentation gibt es keine Versionsbedingung: kein `If-Match`, kein `version` im `PATCH`, keine Antwort 409.                                  |
| F12 | Braucht eine schreibende Anfrage an die REST-API ein CSRF-Token?                                                                 | zweiter Teil                      | Laut ChurchTools Academy nicht.                                                                                                                     |
| F13 | Wie verändert der Web-Editor eine Markdown-Seite, die dort ohne Änderung gespeichert wird?                                       | zweiter Teil                      | Offen. Wichtig für den Prüfcode der Kennzeichnung.                                                                                                  |
| F14 | Gibt es ein Rate-Limit, und wie meldet die API es?                                                                               | keine                             | Nicht offiziell dokumentiert. Ein Forumsbeitrag eines Mitarbeiters nennt 600 Anfragen pro Minute und IP-Adresse. Ohne Testinstanz bleibt 429 offen. |
| F15 | Wie arbeitet OAuth bei ChurchTools?                                                                                              | keine                             | Endpunkte, PKCE, Refresh, Laufzeiten und Tokenformat sind nicht dokumentiert, unter `.well-known` liegen keine Metadaten.                           |

## Befunde

Noch keine. Nach dem Spike steht hier je Frage der Befund, mit der Version von ChurchTools und der Probe, die ihn belegt.
