# ADR 0071: Grenze zwischen Kern und Pro bei Schreib-Tools

- Status: Angenommen am 01.11.2026
- Datum: 01.11.2026
- Fällt vor: Phase 5

## Kontext

Mit Phase 5 bekommt Ecclium Tools, die in ChurchTools schreiben. Vorher ist festzulegen, welche davon zum freien Kern gehören und welche zum kostenpflichtigen Pro-Modul. Was einmal im freien Kern war, bleibt dort (`PROMISE.md`). Eine Grenze, die erst später gezogen wird, liesse sich deshalb nur noch in eine Richtung verschieben.

Vorgesehen sind diese Schreib-Tools:

- **Wiki:** `ct_wiki_page_create`, `ct_wiki_page_update` und `ct_wiki_page_append_section` legen eine Seite an, ändern sie oder hängen einen Abschnitt an.
- **Termine und Buchungen:** `ct_appointments_create`, `ct_appointments_update` und `ct_bookings_create`.
- **Gruppen und Dienste:** `ct_groups_add_member` und `ct_groups_remove_member` nehmen eine Person in eine Gruppe auf oder entfernen sie daraus. `ct_services_request` fragt eine Person für einen Dienst an.
- **Schreibende Escape Hatch:** `ct_api_execute_write` führt eine schreibende Operation nach `operationId` aus, für Abläufe, die kein eigenes Tool abdeckt. Lesend gibt es die Escape Hatch im Kern schon, mit `ct_api_search_actions` und `ct_api_execute_read` ([ADR 0067](0067-generischer-lesezugriff.md)).
- **Bestätigung:** `ct_write_confirm` bestätigt einen geplanten Schreibvorgang per Echo, wenn ein Client keine Rückfrage zeigen kann. Das Modell schickt dann eine Kennung und die Zusammenfassung zurück, die der Server erzeugt hat.

Am 01.11.2026 ist keines dieser Tools gebaut.

Was einen Schreibvorgang sicher macht, liegt nicht im Tool. Ein Schreib-Tool plant nur ein Vorhaben, also eine Art von Schreibvorgang, die der Kern kennt, etwa «Seite im Wiki anlegen» oder «Mitglied einer Gruppe hinzufügen». Schreiben kann allein der Kern, mit einem Nachweis, nach einer Bestätigung, nach der Richtlinie und mit einem Eintrag im Protokoll ([Threat Model](../threat-model.md), T8). Zu entscheiden ist also nicht, wo die Sicherheit liegt, sondern welche Tools der freie Kern anbietet und welche das Pro-Modul anbietet und pflegt.

Dabei gelten diese Bedingungen:

- Der freie Kern soll für eine einzelne Gemeinde vollständig brauchbar sein, auch zum Schreiben.
- Sicherheitsfunktionen gehören in den freien Kern. Eine Gemeinde soll weder für Datenschutz noch für einen sicheren Schreibvorgang bezahlen müssen.
- Keine Funktion des freien Kerns hängt an einer Lizenz. Die Funktion für Lizenzschlüssel im Sinn der Elastic License 2.0 umfasst die öffentlichen Schlüssel, ihre Prüfung und den Teil der Stufe `gate`, der Funktionen des Pro-Moduls freischaltet ([ADR 0058](0058-elastic-license-2-0.md), dazu der Entwurf [ADR 0008](0008-signierte-offline-lizenzen.md)).
- Ein Plugin fügt der Pipeline keine Stufe hinzu und entfernt keine ([ADR 0024](0024-eine-tool-pipeline.md)).

## Optionen

1. **Alle Schreib-Tools im Kern:** Auch Gruppenmitglieder, Dienstanfragen und die schreibende Escape Hatch sind frei. Für eine Gemeinde ist das am bequemsten. Der freie Kern müsste aber Tools pflegen, die vor allem Organisationen mit vielen Gruppen, Diensten und eigenen Abläufen brauchen, und jede Änderung an diesen Teilen der API von ChurchTools träfe ihn. Einmal frei, kämen die Tools nie mehr ins Pro-Modul.
2. **Vier Tools im Pro-Modul, ihre Vorhaben und Regeln im Kern:** `ct_groups_add_member`, `ct_groups_remove_member`, `ct_services_request` und `ct_api_execute_write` liegen im Pro-Modul, alle übrigen Tools im Kern. Die Vorhaben der vier Tools und alle Regeln dafür liegen im Kern, unabhängig von einer Lizenz.
3. **Vier Tools samt Vorhaben und Regeln im Pro-Modul:** Der Kern wüsste nichts von Gruppenmitgliedschaften und Dienstanfragen. Weil der Kern nur ausführt, was er kennt, müsste das Pro-Modul selbst schreiben und selbst festlegen, wie sicher seine Schreibvorgänge sind, und ihre Sicherheit hinge an einer Lizenz. Das widerspricht dem Grundsatz, dass Schreib-Tools nur planen und nur der Kern schreibt (Threat Model, T8).
4. **Auch Wiki, Termine und Buchungen im Pro-Modul:** Der freie Kern könnte dann nur lesen. Für eine Gemeinde wäre er nicht vollständig, und gerade Seiten im Wiki anzulegen und nachzuführen ist der wichtigste Anwendungsfall.

## Entscheid

Gewählt ist die zweite Option.

- **Im Pro-Modul liegen genau vier Tools:** `ct_groups_add_member`, `ct_groups_remove_member`, `ct_services_request` und `ct_api_execute_write`. Sie tragen die Stufe `pro`, die nur eine gültige Lizenz freischaltet. Ein lesendes Tool dieser Stufe endet ohne Lizenz schon heute in der Stufe `gate` mit `license_required`. Wo diese Prüfung beim Schreiben steht, legt ADR 0029 fest.
- **Im Kern liegen alle übrigen Tools:** alle Lese-Tools mit der lesenden Escape Hatch, die Schreib-Tools für Wiki, Termine und Buchungen und `ct_write_confirm`. Der Kern schreibt selbst, mit dem Write-Guard, dem Teil des Kerns, der jeden Schreibvorgang plant, bestätigen lässt und festschreibt, und mit Snapshot und Rücknahme.
- **Die Vorhaben hinter den vier Tools liegen im Kern:** «Mitglied einer Gruppe hinzufügen», «Mitglied aus einer Gruppe entfernen», «Dienstanfrage an eine Person» und «Operation nach `operationId`». Ein Tool des Pro-Moduls plant nur eines dieser Vorhaben. Ziel, nötige Rechte, ob es sich zurücknehmen lässt und den Schutz gegen Wiederholung leitet der Kern selbst aus dem Vorhaben ab, unabhängig davon, was das Tool angibt, und schreiben kann nur der Kern.
- **Die Regeln für diese Vorhaben liegen im Kern** und hängen an keiner Lizenz. Sie gelten für jedes Plugin gleich, auch für das Pro-Modul, und ein Plugin kann sie nur verschärfen, nie lockern. Für alle vier gilt die Sensitivität `special`, nie ein unbeaufsichtigter Lauf, nie eine Bestätigung per Echo und ein Schutz gegen Wiederholung mit einer Nonce, einem Wert, der nur einmal gilt. Gruppenmitgliedschaften brauchen zusätzlich einen eigenen Schalter des Kerns, voreingestellt aus. Eine Operation nach `operationId` gilt als nicht rücknehmbar und geht immer in die Freigabe-Warteschlange, wo nur der Betreiber freigibt. Sie braucht ausserdem die Einstufung jeder schreibenden Operation im Katalog des Kerns, zwei Schalter und eine Liste erlaubter Operationen, wie ADR 0067 es für den schreibenden Teil vorsieht, und Operationen mit `DELETE` nimmt der Kern nicht an. Festgehalten werden die Regeln in den ADRs, die sie betreffen:
  - ADR 0029 (geplant): der Write-Guard, die Wege der Bestätigung und der Vertrag für Schreib-Tools aus Plugins. Kein Schreib-Tool aus einem Plugin lässt sich per Echo bestätigen.
  - ADR 0032 (geplant): die Richtlinie, mit den Zielarten für Gruppen und für Dienste von Events nur im interaktiven Teil.
  - ADR 0041 (geplant): Ein Plugin plant eines dieser Vorhaben nur, wenn der Betreiber es dafür ausdrücklich zulässt. Ein signiertes Manifest allein genügt nicht.
- **Begründung:** Die vier Tools brauchen vor allem Organisationen mit vielen Gruppen, Diensten und eigenen Abläufen, und sie verlangen laufende Pflege, etwa wenn ChurchTools diese Teile seiner API ändert. Diese Pflege trägt das Pro-Modul. Die Grenze stützt sich ausdrücklich nicht auf das Vier-Augen-Prinzip, also darauf, dass eine zweite Person jeden Schreibvorgang freigibt. Der Kern macht die Tools sicher, mit Bestätigung, Freigabe-Warteschlange, Richtlinie und Protokoll, auch ohne Pro-Modul. Ein Vier-Augen-Prinzip mit Oberfläche und Benachrichtigung ist Komfort im Pro-Modul.
- **Zeitplan:** In Phase 5 baut der Kern in der Schnittstelle für Plugins die Typen der vier Vorhaben und ihre Regeln und prüft sie mit einem Plugin aus dem Paket `testkit`. Die Ausführung gegen ChurchTools entsteht erst mit den Tools des Pro-Moduls, frühestens in Phase 9. Bis dahin endet ein solches Vorhaben mit `policy_denied`.
- **Der Kern bleibt vollständig:** Mit dem freien Kern liest eine Gemeinde alles, was die Lese-Tools bieten, und schreibt ins Wiki, in Termine und in Buchungen. Gruppenmitgliedschaften und Dienstanfragen pflegt sie ohne Pro-Modul direkt in ChurchTools.
- **`PROMISE.md` ist nicht berührt:** Keines der vier Tools war je im freien Kern, in keiner Fassung und in keinem Commit. Die Grenze schiebt nichts hinter eine Bezahlschranke.
- **Keine Lizenz für die Vorhaben:** Die Vorhaben und ihre Regeln gehören nicht zur Funktion für Lizenzschlüssel ([ADR 0058](0058-elastic-license-2-0.md)). Fehlt eine Lizenz, ändert sich an ihnen und an den Tools des Kerns nichts.

## Konsequenzen

- Der Kern enthält Code für Vorhaben, die bis zu den Tools des Pro-Moduls kein Tool des Kerns ausführt: Typen, Regeln und ihre Tests. Er gehört trotzdem zum Write-Guard und braucht dieselbe volle Abdeckung.
- Weil die Vorhaben im Kern liegen und an keiner Lizenz hängen, kann auch ein fremdes Plugin sie planen. Es gelten dieselben Regeln, und der Betreiber muss das Plugin dafür ausdrücklich zulassen (ADR 0041). Das Pro-Modul bietet gepflegte und geprüfte Tools, nicht den Zugang zu den Vorhaben.
- Eine Gemeinde ohne Pro-Modul pflegt Gruppenmitgliedschaften und fragt Personen für Dienste nicht über Ecclium an, sondern direkt in ChurchTools.
- Bevor die Ausführung der vier Vorhaben entsteht, klärt eine schreibende Probe an der Testinstanz hinter dem Wächter nach [ADR 0049](0049-testumgebung.md), welche Endpunkte und Methoden sie brauchen. Braucht das Entfernen eines Mitglieds `DELETE`, erweitert ein ADR, das [ADR 0056](0056-ausgehender-weg.md) ergänzt, den ausgehenden Weg nur für dieses Vorhaben. Die schreibende Escape Hatch bleibt ohne `DELETE`.
- Vor dem ersten Release der vier Tools, auch für das Self-Hosting, prüft ein Security-Review die vier Vorhaben im Kern und die vier Tools gegen die Regeln des Kerns.
- Wie Funktionen des Pro-Moduls ohne Lizenz sichtbar werden, regelt ADR 0042 (geplant): ein Tool `ct_about` statt Platzhalter-Tools.
- Das [Threat Model](../threat-model.md) führt T8 und T14 nach: Bestätigt wird über eine Rückfrage, die Freigabe-Warteschlange oder per Echo, per Echo nur für rücknehmbare Tools des Kerns ohne `special`, und Schreib-Tools aus Plugins planen nur Vorhaben des Kerns.
- Eine andere Grenze braucht ein neues ADR. Nach `PROMISE.md` kann sie Tools nur aus dem Pro-Modul in den Kern holen, nie umgekehrt.
