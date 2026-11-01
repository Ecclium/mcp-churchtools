# Sicherheit im Betrieb

**In Entwicklung.** Es gibt noch keine veröffentlichte Version. Diese Seite sagt, wie Ecclium die Daten Ihrer Gemeinde schützt, wo dieser Schutz endet und was Sie selbst tun können, so wie es heute gebaut ist. Wie Sie eine Lücke melden, steht in [SECURITY.md](../SECURITY.md), was Ecclium auf der Platte ablegt, in [Datenschutz](privacy.md), alle Bedrohungen und Restrisiken im [Threat Model](threat-model.md).

## Zuerst die Grenzen

- Ecclium begrenzt, was es aus ChurchTools herausgibt. Was ein KI-Assistent danach mit diesen Daten tut, bestimmen der Client und das Modell, nicht Ecclium.
- Die Maskierung begrenzt den Schaden, sie anonymisiert nicht. Daten aus ChurchTools lassen auf die Religionszugehörigkeit einer Person schliessen.
- ChurchTools setzt die Rechte durch. Ecclium liest mit den Rechten seines Dienstkontos und nur mit ihnen. Je enger Sie das Konto halten, desto weniger kann Ecclium herausgeben ([Dienstkonto](betrieb/dienstkonto.md)).
- Die Tools der Bereiche geben nur feste Felder weiter. Mit dem Toolset `api` gibt Ecclium dagegen ganze Antworten von ChurchTools weiter, mit allem, was die Rechte des Kontos öffnen (unten, «Lesender Zugriff auf die API»).
- In dieser Version liest Ecclium nur. Tools, die in ChurchTools schreiben, gibt es noch nicht.

## Andere Tools im selben Client

Ein KI-Assistent hat oft mehrere MCP-Server oder eigene Tools zugleich, etwa für das Web, E-Mail, Dateien oder eine Shell. Liest das Modell über Ecclium Daten und gibt sie über ein solches Tool weiter, aus Versehen oder weil ein Text im Wiki es dazu verleitet, greift keine Grenze dieses Servers. Ecclium sieht diesen Weg nicht und kann ihn nicht sperren. Diesen Fall nennt das Threat Model T24.

Das empfehlen wir:

- Betreiben Sie Ecclium nicht im selben Client neben Servern oder Tools, die frei ins Netz schreiben oder Nachrichten senden können. Geht es nicht anders, trennen Sie die Arbeit mit Ecclium in eine eigene Sitzung oder ein eigenes Profil des Clients.
- Schalten Sie mit `ECCLIUM_TOOLSETS` nur die Bereiche ein, die Sie brauchen. Ohne Angabe bietet der Server nur `ct_whoami` an ([Konfiguration](configuration.md)). Das Toolset `api` gehört nicht zu `all` und kommt nur, wenn Sie es ausdrücklich nennen. Schalten Sie es in einem Client mit Tools, die ins Netz schreiben, nicht ein.
- Stellen Sie Tools mit Netzzugriff im Client nicht auf «immer erlauben». Bestätigen Sie jeden Aufruf einzeln, dann ist der Dialog des Clients die Stelle, an der ein Abfluss auffällt.
- Wählen Sie `ECCLIUM_REDACTION=strict`, wenn Ecclium neben solchen Tools laufen muss. Die Stufe kürzt zusätzlich Nachnamen, ersetzt Kennungen von Personen durch Pseudonyme und durchsucht Freitext nach E-Mail-Adressen, Telefonnummern, IBAN und AHV-Nummern. Sie braucht eine Schlüsseldatei in `ECCLIUM_PSEUDONYM_KEY_FILE` und geht nicht zusammen mit dem Toolset `api`, siehe unten «Stufe `strict`».

## Was die Maskierung leistet und was nicht

Die Maskierung arbeitet mit den Datenklassen, die jedes Feld eines Ergebnisses trägt. Welches Feld welche Klasse trägt, steht in der [Referenz der Tools](tools.md), was jede Stufe mit einer Klasse tut, in [ADR 0026](adr/0026-klassifizierte-ausgabeschemas.md). In der Voreinstellung `standard` gilt:

- Maskiert werden E-Mail-Adressen, Telefonnummern und Geburtsdaten, aber nur in Feldern, die ein Tool so klassifiziert. Strasse, Postleitzahl und Koordinaten einer Adresse und Beträge ersetzt sie ganz durch eine Marke, kein Tool des Kerns gibt sie aber heute aus. Sichtbar bleiben das erste Zeichen und die Domain einer Adresse, die ersten vier Ziffern einer Nummer und das Jahr eines Geburtsdatums. Von den Tools mit festen Feldern gibt nur `ct_whoami` ein solches Feld aus, die Adresse des Dienstkontos. Die übrigen lesen Kontaktdaten gar nicht erst, weil jedes nur Felder einer festen Liste liest ([ADR 0064](adr/0064-leserechte-und-felder-der-lese-tools.md)). Wie `ct_api_execute_read` maskiert, steht unten.
- In den Ergebnissen der Tools mit festen Feldern durchsucht `standard` Freitext nicht nach Mustern, erst `strict` tut das. Texte des Wikis, Notizen, Beschreibungen und Titel befreit die Pipeline nur von unsichtbaren Zeichen und setzt sie in den Datenumschlag. Steht in einer Seite des Wikis eine Telefonnummer, geht sie unmaskiert an den Client.
- Namen von Personen stehen unverändert in den Ergebnissen der Tools, die Personen nennen. Nachnamen kürzt erst `strict`.
- In der Meldung eines gescheiterten Aufrufs erkennt die Maske Kontaktdaten nur an ihrer Form. Einen Namen erkennt sie dort nicht, und jede Folge von sieben Ziffern maskiert sie wie eine Telefonnummer.
- Mit `ECCLIUM_REDACTION=off` maskiert der Server nichts. Das geht nur über stdio und mit einer Warnung beim Start ([Konfiguration](configuration.md)).

## Keine Umgehung der Maskierung

Jedes Ergebnis eines Tools geht durch dieselbe Pipeline, bevor es den Client erreicht. Dass kein Weg an ihr vorbeiführt, belegen drei Teile, die bei jeder Änderung des Codes in der CI laufen ([ADR 0026](adr/0026-klassifizierte-ausgabeschemas.md)):

- **Typen.** Ein Tool gibt sein Ergebnis der Pipeline, nie dem Client. Nach der Maskierung, dem Datenumschlag und der Prüfung der Grösse vergibt nur die Pipeline dem Ergebnis eine Marke, und der Teil, der die Antwort an den Client schreibt, nimmt als Erfolg nur ein Ergebnis mit dieser Marke an. Er prüft sie auch zur Laufzeit, weil Code, der für sich übersetzt wird, die Typen umgehen kann. Ein Ergebnis ohne die Marke geht nicht hinaus, an seiner Stelle meldet der Server einen internen Fehler und schreibt ein festes Ereignis ins Log. Die Meldung eines gescheiterten Aufrufs trägt keine Marke, sie maskiert die Pipeline nach der Form ihrer Werte (oben). Die Marke schützt gegen ein Versehen und gegen eine Umwandlung des Typs, nicht gegen Code, der ein schon markiertes Ergebnis auseinandernimmt. Ein solches sehen nur der Teil, der die Antwort schreibt, und das MCP-SDK.
- **Architektur.** Im Code, der ausgeliefert wird, meldet nur eine Stelle beim MCP-SDK etwas an, der Mount, und er beantwortet jede Anfrage `tools/call` über die eine Pipeline. Tools kommen nur über den Host eines Plugins in den Katalog, wo die Registry jedes Feld ohne Datenklasse abweist. Regeln der Architektur prüfen das bei jedem Lauf: Ausser dem Mount meldet nur eine Probe im Paket für Tests beim SDK etwas an, nur der Mount, der Server und diese Probe importieren das SDK, und nur die Pipeline vergibt die Marke. Für jede Regel gibt es ein Beispiel, an dem sie rot wird.
- **Laufzeit.** Ein Test ruft jedes der 32 Tools des Kerns mit einer Antwort von ChurchTools auf, in `off`, `standard` und `strict`, ohne die beiden Tools der Escape Hatch in `strict`, und durchsucht das ganze Ergebnis der Pipeline nach Rohwerten: nach Werten aus Feldern, die ein Tool nicht weitergibt, ab `standard` nach E-Mail-Adressen, Telefonnummern und Geburtsdaten, in `strict` nach Nachnamen, Kennungen von Personen und nach E-Mail-Adressen, Telefonnummern, IBAN und AHV-Nummern in Freitext. Log und Audit durchsucht er nach dem Token und nach den Werten, die ein Tool nicht weitergibt. Ein neues Tool ohne einen solchen Fall lässt den Test scheitern.

Dazu kommen Tests, die viele Werte erzeugen, mit der Bibliothek fast-check ([ADR 0070](adr/0070-property-tests-mit-fast-check.md)). Sie setzen Testwerte in jedes klassifizierte Feld jedes Tools und eines eigens gebauten Tools mit jeder Klasse, in jeder Stufe, auch in Vollbreite, in anderen Formen derselben Zeichen und mit unsichtbaren Zeichen dazwischen, und prüfen jedes Feld gegen die Tabelle in ADR 0026. Golden-Tests vergleichen das ganze Ergebnis eines Datensatzes mit jeder Klasse je Stufe mit der erwarteten Ausgabe. Die Tests der Maskierung und des Audits decken jede Zeile und jede Verzweigung ihres Codes ab.

Wo die Prüfung von Freitext in `strict` endet, steht unten unter «Stufe `strict`».

## Stufe `strict`

Mit `ECCLIUM_REDACTION=strict` gibt Ecclium dem KI-Assistenten weniger als in der Voreinstellung `standard` ([ADR 0069](adr/0069-stufe-strict.md)). Wählen Sie die Stufe, wenn Ecclium neben Tools laufen muss, die ins Netz schreiben oder Nachrichten senden, oder wenn der KI-Assistent für seine Arbeit nicht wissen muss, wer genau gemeint ist. Wie Sie sie einschalten, steht unter [Betrieb über stdio](betrieb/stdio.md#stufe-strict-und-schlüsseldatei).

Was `strict` zusätzlich zu `standard` tut:

- **Nachnamen** kürzt die Stufe auf den ersten Buchstaben mit Punkt, aus «Muster» wird «M.». Ein Name aus einem einzigen Zeichen, wie viele Namen in chinesischer oder koreanischer Schrift, wird ganz zur Marke. Vornamen bleiben stehen.
- **Kennungen von Personen** ersetzt sie in jedem Ergebnis durch ein Pseudonym, `p1_` und 39 Kleinbuchstaben und Ziffern, auch die Kennung des Dienstkontos in `ct_whoami`. Die Tools, die eine Person über ihre Kennung lesen, nehmen dann nur ein Pseudonym an. Eine Zahl oder ein verändertes Pseudonym weist Ecclium ab, ohne ChurchTools zu fragen. So kann der KI-Assistent keine Kennung erraten oder durchzählen.
- **Freitext,** also Seiten des Wikis, Notizen, Beschreibungen und Titel, durchsucht sie nach E-Mail-Adressen, Telefonnummern, IBAN und AHV-Nummern und ersetzt jeden Treffer durch eine sichtbare Marke.

Was gleich bleibt wie in `standard`:

- Die Masken für E-Mail-Adressen, Telefonnummern, Geburtsdaten, Adressen und Beträge in Feldern mit ihrer Datenklasse.
- Kennungen von Gruppen, Events, Terminen, Seiten und anderen Objekten. Sie bleiben in jeder Stufe, wie [ADR 0026](adr/0026-klassifizierte-ausgabeschemas.md) es festhält.
- Die Audit-Datei nennt weiter die echten Kennungen der Personen, nie ein Pseudonym, damit Sie auf eine Anfrage hin zeigen können, wer wessen Daten gelesen hat ([Datenschutz](privacy.md)). Log und Kopie des Audits auf stderr nennen keine Kennung.

Die Pseudonyme:

- Sie gelten je Instanz von ChurchTools, Subjekt aus `ECCLIUM_STDIO_SUBJECT` und UTC-Tag. Dieselbe Person hat für dasselbe Subjekt am selben Tag dasselbe Pseudonym, für ein anderes Subjekt oder am nächsten Tag ein anderes. Clients mit demselben Subjekt, etwa Claude Desktop und Claude Code mit `local-stdio` auf einem Rechner, sehen also dieselben Pseudonyme. Wer das trennen will, gibt jedem Client ein eigenes Subjekt.
- Ecclium nimmt ein Pseudonym am Tag seiner Ausgabe und am folgenden UTC-Tag an, damit ein Gespräch über Mitternacht UTC weiterläuft. Ein älteres weist es ab. Über Tage hinweg kann der KI-Assistent eine Person an ihrem Pseudonym nicht wiedererkennen.
- Sie entstehen aus einem Schlüssel, den Sie anlegen. Wer ihn hat, kann jedes Pseudonym in die Kennung zurückübersetzen. Pseudonyme sind deshalb eine Pseudonymisierung, keine Anonymisierung ([Datenschutz](privacy.md#pseudonyme)). Behandeln Sie die Schlüsseldatei wie die Token-Datei.
- Ecclium legt kein Pseudonym auf der Platte ab und braucht keine Tabelle. Geht der Schlüssel verloren, lassen sich nur die Pseudonyme des laufenden und des letzten Tages nicht mehr zurückübersetzen.

Was `strict` nicht tut:

- **Nicht mit `api`.** Die Antwort von `ct_api_execute_read` hat kein bekanntes Schema, die Stufe könnte Namen und Kennungen darin nicht finden. `strict` zusammen mit dem Toolset `api` bricht den Start deshalb ab.
- **Namen in Freitext** erkennt die Prüfung nicht, ebenso wenig Namen von Gruppen und die Vornamen. Aus Vorname, Initiale, Gruppen und Diensten kann ein KI-Assistent eine Person oft trotzdem erschliessen. Die Stufe macht das schwerer, nicht unmöglich.
- **Formen ausserhalb der Prüfung.** Die Prüfung von Freitext erkennt Werte nur an ihrer Form, und die Tests halten ihre Grenzen fest. Sie erkennt eine IBAN in einem Stück oder in Gruppen zu vier mit je einem Leerzeichen, eine AHV-Nummer in einem Stück oder mit demselben Punkt, Leerzeichen oder Bindestrich zwischen den Gruppen und eine Telefonnummer, die mit `+`, `(` oder `0` beginnt. Eine IBAN mit Bindestrichen, eine AHV-Nummer mit gemischten Trennern oder eine Telefonnummer ohne Vorwahl geht in einer Seite des Wikis unmaskiert hinaus, ausser ein Teil davon, der mit `0` beginnt, sieht wie eine Telefonnummer aus. Ebenso wenig erkennt sie Buchstaben anderer Schriften, die nur wie lateinische aussehen, etwa ein kyrillisches «а», und Ziffern anderer Schriften, etwa eine Telefonnummer in arabisch-indischen Ziffern. Felder mit einer Datenklasse maskiert die Pipeline dagegen unabhängig von ihren Zeichen.
- **Schutz vor dem Betreiber.** Wer den Rechner verwaltet, kann die Schlüsseldatei lesen. Solange der Server läuft, steht der Schlüssel auch im Speicher des Prozesses, als Text, den JavaScript nicht löschen kann.

## Datenumschlag

Jeder Freitext aus ChurchTools steht in einem Ergebnis zwischen zwei Marken mit einer zufälligen Grenze, die für jeden Aufruf neu entsteht. Text aus ChurchTools kann den Umschlag nicht schliessen, weil er die Grenze nicht kennt. Die Beschreibungen der Tools sagen dem Modell, dass Inhalte aus ChurchTools Daten sind und keine Anweisungen. Ob das Modell einer Anweisung im Umschlag trotzdem folgt, entscheidet das Modell.

Auch die Texte der Dokumentation, die mit Ecclium kommt, stehen im Umschlag: Titel und Text der Hilfeseiten der Academy, Beschreibungen und Definitionen aus dem OpenAPI-Dokument und die Bezeichnungen der Rechte (unten, «Texte der Dokumentation»). Ebenso steht die ganze Antwort von `ct_api_execute_read` als ein Text im Umschlag.

Ohne Umschlag bleiben vier Arten von Text. Namen von Personen stehen ausserhalb, damit `strict` sie kürzen kann. Ein Name, der wie eine Anweisung aussieht, erreicht das Modell also ohne Umschlag. Die Namen von Modulen und Rechten, die `ct_whoami` nennt, vergibt ChurchTools, und der Client lässt nur kurze Namen aus druckbaren Zeichen durch. Die Meldung eines gescheiterten Aufrufs steht nicht im Umschlag, die Maske prüft sie, wie oben beschrieben. Die Namen von Operationen und Rechten, Methoden und Pfade, die die Tools der Dokumentation und `ct_api_search_actions` nennen, stehen ausserhalb, aber nur in fester Form: eine `operationId` und ein Pfad nur aus den Zeichen eines Namens oder Pfads, ohne Leerzeichen und Anführungszeichen, der Name eines Rechts als kurze Zeile druckbarer Zeichen wie bei `ct_whoami`. Dazu kommen die Namen der Parameter und ihre festen Werte aus dem OpenAPI-Dokument, die `ct_api_search_actions` nennt, als kurze Zeile druckbarer Zeichen ohne Leerzeichen, und Pfade, Links und Abschnitte der Academy nur aus Kleinbuchstaben, Ziffern, `-`, `_` und `%`. Welche Felder Freitext sind, listet die [Referenz der Tools](tools.md) unter «Freitextfelder».

## Obergrenzen je Aufruf

- Jedes Tool mit festen Feldern liest je Aufruf höchstens eine feste Zahl von Einträgen, etwa 25 Termine oder 50 Mitglieder einer Gruppe, und sagt, ob es weitere gibt. Die Grenze steht in der Beschreibung des Tools. `ct_api_execute_read` begrenzt nur die Grösse der Antwort (unten, «Lesender Zugriff auf die API»).
- Ein Ergebnis ist höchstens 64 KiB gross, gemessen an dem, was der Client erhält. Darin stehen die Daten zweimal, als Text und strukturiert, dazu eine Reserve von 1 KiB für die übrige Nachricht, für die Daten bleiben also knapp 32 KiB. Die Kennung einer Anfrage wählt der Client, eine sehr lange Kennung macht die Antwort grösser. Ecclium kürzt nie ein Ergebnis. Wäre es grösser, endet der Aufruf mit einem Fehler, und eine lange Seite des Wikis liest ein Tool in Teilen.
- Die Obergrenze verhindert den Export in einem einzigen Aufruf, nicht den in vielen. Dafür gibt es das Lesebudget.

## Lesebudget und Audit-Datei

Die Tools, die in der Übersicht der [Referenz der Tools](tools.md) unter «Lesebudget» ein «ja» tragen, haben zusammen ein Budget von 200 Aufrufen je Akteur und UTC-Tag. Das sind die Tools mit besonders schützenswerten Personendaten und jedes andere, das Namen oder Kennungen anderer Personen ausgibt, etwa die Einteilungen in Dienste ([ADR 0063](adr/0063-quotastore-als-datei.md), [ADR 0064](adr/0064-leserechte-und-felder-der-lese-tools.md)).

- Jeder Aufruf mit gültiger Eingabe zählt, bevor Ecclium ChurchTools fragt, auch jede weitere Seite einer Liste. Ein Aufruf, dessen Eingabe der Server abweist, zählt nicht.
- Über dem Budget endet jeder Aufruf dieser Tools bis zum nächsten UTC-Tag mit `policy_denied`. Kann Ecclium nicht zählen, endet er ebenso.
- Die Zähler liegen in einer Datei im Ordner `quota` des Zustandsordners. Sie überstehen einen Neustart, und zwei Prozesse mit demselben Ordner teilen sie ([Datenschutz](privacy.md)).
- Über stdio entsteht der Akteur aus dem Subjekt in `ECCLIUM_STDIO_SUBJECT`. Das Budget gilt also je Installation und Subjekt, nicht je Person, die den Client benutzt, und nicht je Person, deren Daten gelesen werden.
- Wer den Zustandsordner schreiben kann, kann die Zähler löschen. Das Budget bremst ein Modell und einen Client, nicht den Betreiber.
- Die 200 sind in dieser Version fest. Einstellbar wird das Budget mit der Richtlinie in Phase 5.
- Die übrigen Tools zählen nicht, etwa die für das Wiki, Events, Termine und Buchungen. Für sie gilt nur die Obergrenze je Aufruf, obwohl auch ihr Freitext Personendaten enthalten kann, etwa eine Seite des Wikis mit Namen und Telefonnummern.

Dieselben Tools geben ihr Ergebnis erst heraus, wenn ihre Zeile ganz in der Audit-Datei steht ([ADR 0028](adr/0028-audit-ereignis-und-datei-sink.md)). Ist eines davon eingeschaltet und `ECCLIUM_STATE_DIR` nicht gesetzt, startet der Server über stdio nicht. Eine Zeile der Audit-Datei nennt Zeit, Akteur, Tool, Ausgang und Dauer und die Kennungen der Objekte, nach denen der Aufruf fragt, und der Personen und Gruppen, die sein Ergebnis nennt. Sie zeigt also, wann welches Tool lief und wessen Daten es las, ohne Namen. Damit trägt die Datei selbst Personendaten. Die Kopie auf stderr nennt keine Kennungen ([Datenschutz](privacy.md), [Audit-Ereignisse](audit-events.md)).

## Log

Ecclium schreibt Logzeilen nach stderr, aber nur Ereignisse und Felder aus einem festen Katalog, den [Logzeilen](log-events.md) ganz zeigen ([ADR 0054](adr/0054-secret-fehler-logger-audit.md)). Keine Zeile trägt Text aus ChurchTools, Namen oder Kennungen von Personen, Pfade oder ein Token, und jeder Wert hat eine feste Form. Ein Ereignis, das nicht im Katalog steht, auch eines aus einem Plugin, schreibt der Logger als `invalid_event`, damit kein Name aus Daten in eine Zeile kommt. Ein Test liest jeden Aufruf eines Loggers im Code und scheitert an einer Zeile ohne Eintrag. Wohin der Client stderr schreibt, bestimmt er. Diese Dateien schützt und löscht Ecclium nicht.

## Lesender Zugriff auf die API

Mit dem Toolset `api` ruft `ct_api_execute_read` eine lesende Operation der API von ChurchTools auf und gibt die ganze Antwort weiter, nicht nur feste Felder ([ADR 0067](adr/0067-generischer-lesezugriff.md)). Das ist der grösste Unterschied zu den übrigen Tools, und Sie sollten ihn kennen, bevor Sie `api` einschalten.

Was Ecclium dabei begrenzt:

- **Nur freigegebene Operationen.** Ein Katalog nennt jede Operation mit `GET` aus dem OpenAPI-Dokument, und jede ist von Hand eingestuft. Freigegeben sind die Bereiche, für die Ecclium Tools hat, und die Rechte mit ihren Stammdaten. Ausgeschlossen sind unter anderem Operationen mit Tokens oder Geheimnissen, Dateien, Finanzen, Protokolle, Exporte, Einstellungen, Seelsorge und Gesundheit, Kommunikation zwischen Personen und die Liste der Geburtstage. Eine feste Regel nach dem Pfad hält die gefährlichsten Arten ab, was auch immer die Einstufung sagt. Eine Operation, die nicht freigegeben ist oder die der Katalog nicht kennt, weist Ecclium ab, bevor es ChurchTools fragt.
- **Nur der eigene Pfad und der eigene Host.** Den Pfad baut Ecclium nur aus der Vorlage der Operation. Jeder Wert darin hat eine geschlossene Form, etwa eine ganze Zahl oder die GUID einer Seite des Wikis, und Zeichen wie `..`, `/`, `%`, `?` oder `#` weist es ab. Parameter der Query sendet es nur, wenn die Operation sie kennt, Kopfzeilen und Adressen aus einer Eingabe nie. Der ausgehende Weg erreicht nur die Adresse Ihrer Instanz. Ein Generator mit festem Startwert prüft das mit Pfaden wie `../`, doppelt kodierten Zeichen und sehr langen Werten.
- **Maskierung.** In jeder Stufe ausser `ECCLIUM_REDACTION=off` gilt: Felder mit einem Geheimnis, etwa den Link zum Abonnieren eines Kalenders oder Namen mit `token`, `password` oder `secret`, verbirgt Ecclium ganz. E-Mail-Adressen, Telefonnummern und Geburtsdaten maskiert es nach dem Namen des Felds, E-Mail-Adressen und Telefonnummern auch nach ihrer Form in jedem Text. Ein Datum erkennt es nur am Namen des Felds als Geburtsdatum, damit Termine und Buchungen ihre Daten behalten.
- **Grenzen eines Aufrufs.** Eine Antwort wird nie gekürzt. Ist sie grösser als etwa 20 bis 30 KiB JSON, endet der Aufruf mit dem Hinweis, weniger Einträge zu holen.
- **Wie die Tools für Personen.** `ct_api_execute_read` läuft nie unbeaufsichtigt, zählt gegen das Lesebudget und gibt sein Ergebnis nur mit seiner Zeile in der Audit-Datei heraus. Jeder Start mit `api` warnt auf stderr.

Was Ecclium nicht begrenzt:

- **Was die Rechte des Kontos öffnen.** In den freigegebenen Operationen sieht der KI-Assistent alles, was das Dienstkonto sehen darf. Adressen, Angaben zur Konfession, Notizen und alle Felder, die die Maske nicht kennt, gehen unmaskiert hinaus. Ein Recht, das Sie für ein anderes Tool vergeben, gilt hier mit. Hat das Konto etwa eine Stufe von «Personendaten sehen - bis zum gewählten Sicherheitslevel», gibt `ct_api_execute_read` die Angaben dieser Stufe weiter. Vergeben Sie mit `api` deshalb nur Rechte, deren Daten der KI-Assistent ganz sehen darf ([Dienstkonto](betrieb/dienstkonto.md)).
- **Die Einstufung von Hand.** Eine Operation mit `GET`, die etwas auslöst oder ein Geheimnis liefert, ohne dass Pfad oder Beschreibung es zeigen, erkennt nur die Durchsicht. Ein Geheimnis unter einem Namen, den die Maske nicht kennt, ginge hinaus. Eine Telefonnummer in Freitext erkennt die Maske nur ab `+`, `(` oder `0`, ein Geburtsdatum in Freitext nicht.
- **Die Stufe `off`.** Mit `ECCLIUM_REDACTION=off` maskiert Ecclium nichts, auch nicht den Link zum Abonnieren eines Kalenders oder ein Feld mit einem Token. Schalten Sie `off` nie zusammen mit `api` ein.
- **Viele Daten auf einmal.** Freigegeben sind auch Operationen, die viel liefern, etwa alle Mitgliedschaften aller Gruppen. Die Grenze eines Ergebnisses und die Rechte des Kontos begrenzen sie, die Zahl der Aufrufe das Lesebudget.

Lehnt ChurchTools eine Operation ab, nennt der Fehler die Rechte, die das Projekt ihr mit Beleg zugeordnet hat. Für die meisten Operationen gibt es noch keine Zuordnung. Der Prompt `rechte_diagnose` hilft, ein fehlendes Recht zu finden. Sein Text lässt nur Rechte vorschlagen, die die Dokumentation mit Beleg verlangt, und von einer Sicherheitsstufe für Personen abraten ([Prompts](prompts.md)). Ob der KI-Assistent sich daran hält, entscheidet das Modell. Prüfen Sie deshalb jedes Recht, bevor Sie es vergeben.

## Texte der Dokumentation

Die Tools des Toolsets `docs` und `ct_api_search_actions` schlagen in einem Index nach, der mit Ecclium kommt. Er enthält Fakten aus dem OpenAPI-Dokument von ChurchTools unter CC BY 4.0 und den aufbereiteten Text frei zugänglicher Hilfeseiten der ChurchTools Academy, die Ecclium mit Erlaubnis des Herstellers, Namensnennung und Link wiedergibt ([ADR 0027](adr/0027-inhalte-des-doku-index.md), [ADR 0066](adr/0066-doku-index.md)). Zur Laufzeit fragt der Index weder ChurchTools noch das Netz.

- **Fremde Inhalte.** Die Texte stammen nicht aus Ihrer Instanz, aber aus dem Netz, und können wie ein Text im Wiki Anweisungen enthalten. Sie stehen deshalb im Datenumschlag, und die Beschreibungen der Tools sagen, dass sie Daten sind.
- **Wie sie ins Repository kommen.** Eine Person holt sie mit `pnpm docs:refresh` von den Quellen und sieht die Änderungen im Diff durch, bevor sie in eine Version kommen. Prüfungen weisen HTML, unsichtbare Zeichen und jeden Host ausser dem Platzhalter und `churchtools.academy` ab. Ein manipulierter Text, der diese Prüfungen besteht, käme mit der nächsten Version zu Ihnen. Davor schützt nur die Durchsicht.
- **Falsche Fakten.** Welche Operation welches Recht verlangt, ordnet das Projekt von Hand zu, jede Paarung mit Beleg. Fehlt eine Zuordnung, heisst das nicht, dass kein Recht nötig ist. Eine falsche Zuordnung könnte zu einem zu weiten Recht raten. Prüfen Sie deshalb jedes Recht, bevor Sie es vergeben, und vergeben Sie es nur für die Objekte, die gelesen werden sollen.
- **Widerruf.** Die Erlaubnis für die Texte der Academy hat der Hersteller mündlich gegeben. Nimmt er sie zurück, erscheint die nächste Version ohne diese Texte. Eine Version, die Sie schon installiert haben, behält sie, bis Sie sie ersetzen.

## Was später kommt

- Phase 5: Tools, die schreiben, mit Bestätigung über eine Rückfrage im Client, eine Freigabe durch den Betreiber oder ein Echo, und was jeder dieser Wege beweist und was nicht. Dazu das Lesebudget in der Richtlinie.
- Phase 6: der Runner für Routinen, dessen Modell keine Werkzeuge hat, eine Positivliste für ausgehende Verbindungen und Schalter als Dateien, die das Schreiben ohne Neustart abstellen.
- Phase 8: eine Anleitung, wie Sie Pakete und Images vor der Installation prüfen.
