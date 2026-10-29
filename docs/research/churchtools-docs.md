# Quellen des Doku-Index: Fragen und Befunde

Stand: 29.10.2026, Befunde aus dem ersten Lauf von `10-docs-sources` an ChurchTools 3.138

Dieses Dokument hält fest, was der Index der Dokumentation aus seinen Quellen nehmen kann und worauf sich jede Aussage stützt. Welche Inhalte in den Index kommen, entscheidet [ADR 0027](../adr/0027-inhalte-des-doku-index.md). Die Befunde heissen D1, D2 und so weiter, die Befunde zur REST-API selbst stehen mit F-Nummern in [`churchtools-api.md`](churchtools-api.md). Eine Aussage gilt als belegt, wenn die Probe sie gezeigt hat. «Laut Dokument» heisst: so steht es im OpenAPI-Dokument, die Probe hat es nicht geprüft. Was offen bleibt, steht auch unter «Offen» in [`docs/STATUS.md`](../STATUS.md).

## Methode

- Die Probe [`10-docs-sources`](../../scripts/spike/README.md) gibt nur Struktur aus: Anzahlen, Klassen, feste Wörter, Grössen und die Slugs der Abschnitte der Academy, keinen Text, keinen Link und keinen Host einer Quelle.
- Das OpenAPI-Dokument stammt von der Testinstanz mit synthetischen Daten ([ADR 0049](../adr/0049-testumgebung.md)), gelesen mit `00-inventory` am 29.10.2026, unmittelbar vor dem Lauf. Ihr Hostname steht nicht in diesem Repository.
- Die Rechtedefinitionen fragte die Probe mit dem Dienstkonto des Servers ab. `02-permissions` zeigte vor dem Lauf, dass es nur das Wiki und die Kennkategorie sehen darf.
- Die Academy unter `https://churchtools.academy` las die Probe ohne Anmeldung und ohne Token, mit dem User-Agent `ecclium-spike` und drei Sekunden Pause zwischen zwei Abrufen. Das waren 18 Abrufe in etwa 90 Sekunden. Kein Text einer Seite wurde gespeichert.
- Nach Korrekturen aus der Durchsicht lief die Probe am selben Tag ein zweites Mal. Ihre Ausgabe war gleich.

## Fragen

| Nr. | Frage                                                                                                  | Quelle  | Stand             |
| --- | ------------------------------------------------------------------------------------------------------ | ------- | ----------------- |
| D1  | Was trägt `info`: Lizenz, Urheber, Hinweis zum Urheberrecht, Ausschluss der Gewährleistung?            | OpenAPI | Belegt.           |
| D2  | Ist die Version des Dokuments die Version von ChurchTools?                                             | OpenAPI | Belegt: nein.     |
| D3  | Wie viele Operationen gibt es je Methode, wie viele haben eine `operationId`, wie viele sind veraltet? | OpenAPI | Belegt.           |
| D4  | Wie verteilen sich die `GET`-Operationen auf die Präfixe?                                              | OpenAPI | Belegt.           |
| D5  | Nennen die Beschreibungen die Rechte, die eine Operation verlangt?                                     | OpenAPI | Teilweise belegt. |
| D6  | Tragen `servers`, Beispiele oder Beschreibungen einen Host?                                            | OpenAPI | Belegt.           |
| D7  | Wie gross sind die Teile des Dokuments?                                                                | OpenAPI | Belegt.           |
| D8  | Darf das Dienstkonto die Rechtedefinitionen lesen, und enthalten sie Werte der Instanz?                | Rechte  | Teilweise belegt. |
| D9  | Was erlaubt `robots.txt` der Academy?                                                                  | Academy | Belegt.           |
| D10 | Liefert die Schnittstelle von WordPress die Hilfeseiten ohne Anmeldung?                                | Academy | Belegt: ja.       |
| D11 | Wie viele Hilfeseiten gibt es, in welchen Abschnitten, und wie gross sind ihre Texte?                  | Academy | Belegt.           |
| D12 | In welchen Sprachen gibt es die Hilfeseiten?                                                           | Academy | Belegt.           |
| D13 | Wann wurden die Hilfeseiten zuletzt geändert?                                                          | Academy | Belegt.           |
| D14 | Was enthalten die Hilfeseiten ausser Text: Bilder, Videos, Links, Hosts von Instanzen?                 | Academy | Belegt.           |
| D15 | Beschreibt das OpenAPI-Dokument jede Instanz derselben Version gleich?                                 | OpenAPI | Offen.            |

## Befunde

### OpenAPI-Dokument

**D1, belegt.** `info` trägt `title`, `description`, `version`, `license` und `contact`, aber keine `termsOfService`. `license.name` ist CC BY 4.0, und `license.url` führt zu Creative Commons. Eine SPDX-Kennung in `license.identifier` fehlt. `contact` trägt die Schlüssel `name`, `url` und `email`, URL und E-Mail auf Hosts des Herstellers. Was in `name` steht, zeigt die Probe nicht. Titel und Beschreibung, die Beschreibung rund 1 KiB, nennen weder einen Hinweis zum Urheberrecht noch einen Ausschluss der Gewährleistung, gesucht nach den üblichen Wörtern auf Deutsch und Englisch, und nicht die Firma «ChurchTools Innovations». Für die Namensnennung kommen damit `contact`, die Lizenz und ihr Link in Frage. Einen Ausschluss der Gewährleistung bringt `info` nicht mit, an anderer Stelle hat die Probe nicht gesucht. Fehlt er im ganzen Dokument, kann er nur aus dem Text der Lizenz kommen.

**D2, belegt.** `info.version` ist 0.1.0, die Instanz meldet 3.138. Die Version des Dokuments sagt also nichts über die Version von ChurchTools. Für den Index zählt die Version der Instanz, `SOURCES.json` hält beide fest, wie ADR 0027 es vorsieht. Das Dokument ist in OpenAPI 3.1.0 geschrieben.

**D3, belegt.** Das Dokument beschreibt 851 Operationen: 365 mit `GET`, 216 mit `POST`, 118 mit `PUT`, 24 mit `PATCH`, 126 mit `DELETE` und 2 mit `OPTIONS`. Jede trägt eine `operationId`, keine kommt zweimal vor. Damit taugt die `operationId` als Schlüssel der Fakten. 12 Operationen sind veraltet, davon 6 mit `GET`. 742 Operationen tragen die Erweiterung `x-last-checked`, 5 die Erweiterung `x-internal`. Ob interne Operationen in den Index gehören, ist offen. Unter `components.schemas` stehen 1'131 Schemas.

**D4, belegt.** Die 365 `GET`-Operationen verteilen sich auf 82 Präfixe, den ersten Abschnitt nach `/api/`. Auf die Bereiche, die Ecclium schon liest, und die Rechte entfallen 173: `persons` 35, `person` 9, `groups` 41, `group` 13, `publicgroups` 6, `events` 10, `event` 1, `services` 2, `servicegroups` 2, `calendars` 13, `resources` 3, `resource` 1, `resourcetypes` 2, `bookings` 2, `songs` 4, `song` 4, `wiki` 7, `permissions` 16, `search` 1 und `whoami` 1. Die meisten übrigen haben `finance` mit 53, `sync` mit 21 und `externallogins` mit 10. Darunter stehen Teile, die der generische Lesezugriff nach dem Plan der Phase fest ausschliesst, etwa `finance`, `csrftoken`, `logs` und `files`.

**D5, teilweise belegt.** Von den 851 Operationen tragen 100 bis 999 eine Beschreibung oder Zusammenfassung, und ebenfalls 100 bis 999 davon nennen Rechte oder Berechtigungen. Die Probe sucht ausserdem die Rechte aus den Metadaten der Tools als ganze Wörter, ein Recht aus einem Wort wie `view` nur zusammen mit seinem Modul. So nennen 2 bis 9 Beschreibungen `view category`, das es in `churchcal` und in `churchwiki` gibt, 2 bis 9 `view agenda`, 2 bis 9 `view songcategory` und 2 bis 9 `view` zusammen mit `churchwiki`. Keine nennt `view alldata`, `view groups of grouptype`, `security level group`, `view resource`, `view events` oder `view servicegroup` so. Laut Dokument beginnen viele Beschreibungen die Voraussetzung mit «Requires», nennen das Recht aber in wechselnder Form, mal mit Modul und Doppelpunkt, mal als «permission» am Ende, mal ohne Modul. Mit festen Suchbegriffen lässt sich die Zuordnung von Operationen zu Rechten deshalb nicht aus den Beschreibungen ableiten. Sie entsteht von Hand, mit der Beschreibung als einem Beleg unter mehreren.

**D6, belegt.** Kein Text des Dokuments nennt den Host der Testinstanz. `servers` nennt einen Platzhalter und sonst keinen Host. In Beispielen und Vorgaben (`example`, `examples`, `default`) stehen mindestens 1'000 Texte: 100 bis 999 nennen einen Platzhalter, 10 bis 99 einen Host des Herstellers, 10 bis 99 einen anderen Host und einer einen Host unter `church.tools`, der weder Platzhalter noch Testinstanz ist. 100 bis 999 enthalten eine E-Mail-Adresse. In Beschreibungen nennen 10 bis 99 Texte einen anderen Host, keiner einen Host unter `church.tools` und keiner eine E-Mail-Adresse. Für den Index folgt: Beispiele und `servers` kommen nie in die Fakten, und Links in Beschreibungen fallen weg oder werden geprüft, bevor eine Beschreibung in die Fakten kommt, weil dort nach ADR 0027 nur der Platzhalter und der Host der Academy stehen dürfen.

**D7, belegt.** Ohne Leerzeichen geschrieben ist das Dokument 11,7 MiB gross: `paths` 6,9 MiB, `components.schemas` 4,7 MiB, die übrigen Teile von `components` 47 KiB, `info` 2 KiB, `tags` 4 KiB. Beim Abruf im Oktober 2026 war die Antwort der Instanz rund 41 MB gross. Woher der Unterschied kommt, hat die Probe nicht untersucht. Wie gross die Fakten daraus werden, hängt an der Tiefe der Schemas, die sie übernehmen.

**D15, offen.** Ob ein Dokument jede Instanz derselben Version gleich beschreibt oder nur die Module, die auf ihr aktiv sind, kann eine einzelne Instanz nicht zeigen. `00-inventory` nennt deshalb keine Pfade, und `10-docs-sources` nennt die Präfixe nur auf der Testinstanz. Die Fakten stammen aus dem Dokument der Testinstanz. Beschreibt es ein Modul nicht, fehlt das Modul im Index.

### Rechtedefinitionen

**D8, teilweise belegt.** Das Dokument beschreibt `GET /api/permissions/definitions`. Dem Dienstkonto, das nur das Wiki und die Kennkategorie sehen darf, antwortet die Instanz mit 403 und einer Fehlerantwort in der üblichen Form. Laut Dokument verlangt die Operation `administer persons` in `churchcore`, ein Recht der Verwaltung von Personen, und die Auswahlwerte der Antwort stammen aus dem Katalog der Instanz, ohne Filter nach Sichtbarkeit. Laut Dokument enthält die Antwort damit Werte der Instanz, geprüft hat die Probe das nicht. Das Dienstkonto hat dieses Recht nicht. `GET /api/permissions/global` liest es dagegen schon heute: 11 Module mit 123 Rechten, je mit Name und Art des Werts, gezeigt von `02-permissions` am 29.10.2026. Wie diese Antwort aufgebaut ist, beschreibt F30 in [`churchtools-api.md`](churchtools-api.md). Bezeichnungen und Erklärungen der Rechte nennt sie nicht.

### Academy

**D9, belegt.** `robots.txt` hat eine Gruppe für alle Agenten und keine für `ecclium-spike`. Sie erlaubt jeden Pfad, den die Probe liest, nennt kein `Crawl-delay` und verweist auf eine Sitemap. Von Hand gelesen sperrte sie am 29.10.2026 nur `/wp-admin/`.

**D10, belegt.** `/de/wp-json/` antwortet ohne Anmeldung mit 200. Die Schnittstelle bietet die Namensräume `wp/v2`, `betterdocs` und `wpml/v1` und die Routen `/wp/v2/docs`, `/wp/v2/doc_category` und `/wp/v2/knowledge_base`. Die Namen deuten darauf hin, dass die Hilfeseiten ein eigener Beitragstyp des Plugins BetterDocs sind, eingeteilt in Kategorien und Wissensbasen, und dass WPML die Sprachen verwaltet. Die Übersicht `/de/help/` antwortet ebenfalls mit 200. Von Hand gesehen trägt eine Hilfeseite in der Schnittstelle auch Felder zu ihren Autorinnen und Autoren. Die Probe fragt sie nicht ab, und sie kommen nicht in den Index.

**D11, belegt.** Es gibt 524 deutsche Hilfeseiten, alle veröffentlicht, keine mit Passwort geschützt. Ihr HTML umfasst 3,6 MiB, ihr Text ohne Tags 1,3 MiB. Sie verteilen sich auf 143 Kategorien mit 38 obersten Abschnitten, eine Seite hat keine Kategorie, und auf 7 Wissensbasen: `churchtools-module` mit 284 Seiten und 699 KiB Text, `website-und-finder` mit 78 und 171 KiB, `system-einstellungen` mit 52 und 160 KiB, `rechteverwaltung` mit 38 und 75 KiB, `mein-churchtools` mit 34 und 90 KiB, `verwaltung` mit 30 und 70 KiB und `rahmenvertragspartner` mit 8 und 22 KiB. Zu den Bereichen von Ecclium gehören die Abschnitte `personen` mit 32 Seiten und 92 KiB, `gruppen` mit 58 und 169 KiB, `events` mit 28 und 67 KiB, `kalender` mit 31 und 52 KiB, `ressourcen` mit 13 und 29 KiB und `wiki` mit 10 und 13 KiB, zur Rechteverwaltung `rechteverwaltung-verstehen` mit 14, `rechteverwaltung-anpassen` mit 6 und `rechteverwaltung-nach-modulen` mit 18 Seiten. Einen eigenen Abschnitt für Songs oder für die API gibt es nicht. Wo die Academy sie behandelt, ist offen. Der Text der Abschnitte, die ADR 0027 nennt, liegt zusammen bei rund 500 KiB.

**D12, belegt.** Die Übersicht verweist mit `hreflang` auf Deutsch, Englisch und eine Voreinstellung. Auf Englisch gibt es 511 Hilfeseiten. Der Index nimmt nach ADR 0027 nur die deutschen.

**D13, belegt.** Die älteste letzte Änderung einer Hilfeseite stammt aus dem Oktober 2024, die neueste aus dem Oktober 2026. 8 Seiten wurden zuletzt 2024 geändert, 46 im Jahr 2025 und 470 im Jahr 2026. Ob die Seiten laufend einzeln geändert werden oder 2026 gesammelt, zeigt diese Verteilung nicht. Das Abrufdatum in jedem Ergebnis, das ADR 0027 verlangt, sagt in jedem Fall, wie alt ein Text ist.

**D14, belegt.** 100 bis 999 Hilfeseiten enthalten Bilder, 10 bis 99 Videos oder eingebettete Rahmen, 10 bis 99 Tabellen und 10 bis 99 Code. 100 bis 999 Seiten verlinken auf die Academy selbst, 10 bis 99 auf Seiten des Herstellers, 10 bis 99 auf andere Hosts und 10 bis 99 auf Instanzen unter `church.tools`, keine auf den Host der Testinstanz. 2 bis 9 Seiten haben relative Links, 2 bis 9 Links auf eine E-Mail-Adresse. Im Text, ausserhalb von Links, nennen 10 bis 99 Seiten einen Host einer Instanz unter `church.tools`. Für den Index folgt, was ADR 0027 vorsieht: Bilder und Videos kommen nicht hinein, Links nur als Pfad der Academy, Links auf andere Hosts fallen weg, und ein Host einer Instanz im Text wird zum Platzhalter.
