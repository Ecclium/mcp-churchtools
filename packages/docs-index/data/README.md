# Fakten des Doku-Index

Aus den Dateien dieses Ordners baut `pnpm build` den Index der Dokumentation von ChurchTools, in dem die Doku-Tools nachschlagen. Welche Inhalte hineinkommen, legt [ADR 0027](../../../docs/adr/0027-inhalte-des-doku-index.md) fest, Form, Bau und Prüfungen [ADR 0066](../../../docs/adr/0066-doku-index.md).

| Datei             | Inhalt                                                                                                                       | Quelle und Bedingungen                                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `operations.json` | je Operation `operationId`, Methode, Pfad, Tags, Beschreibungen, Parameter und Schemas bis zur Tiefe 4, ohne Beispiele       | OpenAPI-Dokument von ChurchTools unter CC BY 4.0. Die Fakten sind von Ecclium bearbeitet und stehen ebenfalls unter CC BY 4.0.           |
| `rights.json`     | je Recht Modul, Name und Art des Werts, wo eine Hilfeseite sie nennt, die Bezeichnung und die Seiten, die das Recht erklären | Modul, Name und Art aus `GET /api/permissions/global` einer Instanz, ohne ihre Werte. Bezeichnungen aus der Academy, wie `academy.json`. |
| `academy.json`    | je frei zugänglicher Hilfeseite Titel, Abschnitt, Wissensbasis, letzte Änderung und Text in einfachem Markdown               | ChurchTools Academy. Alle Rechte liegen beim Hersteller, Ecclium gibt die Texte mit seiner Erlaubnis wieder, mit Namensnennung und Link. |
| `SOURCES.json`    | je Quelle Abrufzeit und SHA-256, beim OpenAPI-Dokument seine Version und die der Instanz, bei der Academy jede Seite         |                                                                                                                                          |

Die drei Dateien mit Fakten nennen in ihrem Feld `notice` selbst ihre Quelle und deren Bedingungen und stehen nicht unter der Elastic License 2.0 des Quellcodes.

## Wer die Dateien schreibt

`pnpm docs:refresh` schreibt sie aus den Quellen, keine Person von Hand. Bis zum ersten Lauf sind sie leer und gültig. Eine Rohquelle, also eine abgerufene Seite oder das OpenAPI-Dokument als Ganzes, liegt nie hier und nie im Paket.

## Was geprüft wird

`pnpm check` prüft die Dateien, und der Bau bricht ab, wenn eine Regel verletzt ist:

- Jede Datei liegt unter ihrer Grenze, hat ihr Format und steht in kanonischer Form: JSON mit zwei Leerzeichen Einzug, Felder in fester Reihenfolge, Einträge und Listen sortiert, ein Zeilenende am Schluss. Prettier fasst sie deshalb nicht an.
- Als Host stehen nur `example.church.tools` und `churchtools.academy` darin, als E-Mail-Adresse nur eine unter `example.org`.
- Kein Text enthält HTML, und ein Link in einer Hilfeseite führt nur zu einer anderen Hilfeseite, als Pfad.
- Eine Datei mit Einträgen hat ihre Quelle in `SOURCES.json` und umgekehrt, und jede Seite, die ein Recht nennt, steht in `academy.json`.
- Der gebaute Index ist höchstens 5'000'000 Bytes gross und bei jedem Bau gleich.

Eine Meldung nennt Datei, Eintrag und Feld, nie den Wert. In diesem Ordner liegen nur die vier Dateien und dieses README.
