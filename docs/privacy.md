# Datenschutz

**In Entwicklung.** Es gibt noch keine veröffentlichte Version. Diese Seite sagt, was Ecclium im Betrieb über stdio auf der Platte ablegt und was nicht, so wie es heute gebaut ist.

## Zuerst die Grenzen

- Ecclium verspricht keine Konformität mit einem Datenschutzrecht. Ob für Ihre Gemeinde das Datenschutzgesetz der Schweiz, die DSGVO oder ein kirchliches Datenschutzrecht gilt und was es verlangt, klären Sie. Diese Seite ist keine Rechtsberatung.
- Daten aus ChurchTools lassen auf die Religionszugehörigkeit einer Person schliessen, eine besondere Kategorie von Personendaten. Die Maskierung von Ecclium begrenzt den Schaden, sie anonymisiert nicht.
- Was Ecclium auf der Platte ablegt, liegt auf demselben Rechner wie der Server, unter Ihrem Benutzer. Wer unter diesem Benutzer Programme ausführt oder den Rechner verwaltet, kann es lesen, ändern oder löschen. Backups und synchronisierte Ordner kopieren es.

## Was Ecclium nicht ablegt

Ecclium hat keine Datenbank und keinen Zwischenspeicher für Antworten von ChurchTools. Personendaten, Inhalte des Wikis und andere Antworten hält der Server nur im Arbeitsspeicher, solange ein Aufruf läuft. Log und Audit tragen keine solchen Inhalte und kein Token.

## Was Ecclium ablegt

### Audit-Datei

Nur wenn `ECCLIUM_STATE_DIR` gesetzt ist, schreibt Ecclium eine Audit-Datei in den Ordner `audit` darin, eine Datei je Start und UTC-Tag. Wie Sie den Ordner anlegen, steht unter [Betrieb über stdio](betrieb/stdio.md).

- **Inhalt:** je Aufruf eines Tools eine Zeile mit Zeit, Mandant, Subjekt aus `ECCLIUM_STDIO_SUBJECT`, Modus, Tool, Ausgang, bei einem Fehler sein Code, der Dauer und der ID des Ereignisses. Keine Inhalte aus ChurchTools, keine IDs von Personen oder Gruppen und kein Token. Auch die Zeile eines Aufrufs von `ct_persons_search` oder `ct_groups_search` nennt weder den Suchbegriff noch einen Namen oder eine Kennung. Das Subjekt ist eine neutrale Bezeichnung wie `local-stdio`. Setzen Sie dafür nie den Namen einer Person.
- **Wer sie lesen kann:** Der Ordner hat die Rechte 700, die Datei 600, also nur Ihr Benutzer und wer den Rechner verwaltet. Geerbte Zugriffslisten prüft Ecclium nicht.
- **Frist:** Ecclium löscht die Dateien in dieser Version nicht, und es gibt keine Frist. Wie lange Sie sie aufbewahren, entscheiden Sie. Sobald das Audit IDs von Personen oder Gruppen trägt, kommt eine Frist mit Löschung dazu.
- **Getrennt vom System:** Die Datei liegt auf demselben Rechner wie der Server und ist damit vermutlich nicht getrennt vom System, wie es manche Rechte für Protokolle verlangen.
- **Kopie auf stderr:** Jede Zeile geht zusätzlich als Kopie nach stderr. Wohin der Client stderr schreibt, bestimmt er, Claude Desktop etwa in eine Logdatei je Server. Diese Kopien schützt und löscht Ecclium nicht.

### Token-Datei

Die Datei mit dem Login-Token legen Sie selbst an. Ecclium liest sie und schreibt sie nie. Wie Sie sie schützen, steht unter [Betrieb über stdio](betrieb/stdio.md).
