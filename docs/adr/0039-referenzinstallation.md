# ADR 0039: Kein dauerhaftes Staging, eine Referenzinstallation bei einer Gemeinde

- Status: Vorgeschlagen
- Datum: 16.11.2026
- Fällt vor: Phase 7

## Kontext

Ecclium soll sich von einer Person ohne Entwicklerhintergrund in unter zehn Minuten selbst betreiben lassen. Ob Anleitung, Bundle für das Self-Hosting und Images das leisten, zeigen Tests nur zum Teil: Der Job `e2e` startet Runner und Proxy mit Stellvertretern für ChurchTools und ein Modell, die Testinstanz trägt nur synthetische Daten ([ADR 0049](0049-testumgebung.md)), und beide richtet jemand ein, der den Code kennt. Was eine Gemeinde beim Aufsetzen von Hand tun muss, weil Anleitung oder Bundle es nicht abdecken, findet erst eine echte Installation.

Das Projekt wird von einer Person entwickelt. Eine dauerhafte Umgebung für Staging kostet Betrieb und Geld, läuft mit der Zeit vom Stand einer Gemeinde weg und bräuchte eigene Daten, die nach den Regeln des Projekts synthetisch sein müssten.

## Optionen

1. **Dauerhaftes Staging:** eine eigene Installation, die jeden Stand von `main` übernimmt. Sie prüft den Betrieb laufend, kostet aber Pflege und zeigt nicht, was eine Gemeinde mit der Anleitung erlebt.
2. **Nur Testinstanz und CI:** ohne Aufwand, aber die erste echte Installation wäre die einer fremden Gemeinde nach dem Release.
3. **Eine Referenzinstallation bei einer Gemeinde,** strikt nach der Anleitung aufgesetzt, vor dem Release.

## Entscheid

Gewählt ist die dritte Option.

- **Strikt nach der Anleitung:** Der Maintainer setzt bei einer Gemeinde eine Installation mit dem Bundle für das Self-Hosting und genau nach der Anleitung für Betreiber auf. Jeder Schritt, der von Hand nötig war und nicht in der Anleitung steht, gilt als Fehler in Anleitung oder Bundle und wird vor der Abnahme der Phase behoben.
- **Eigene Konten:** Ecclium bekommt dort eigene Konten, das Konto des Servers nur mit Leserechten nach der Anleitung für das Dienstkonto, das des Runners nur für seine Routinen ([ADR 0023](0023-kein-token-passthrough.md)). Konten, Tokens und Daten, die andere Software dort benutzt, verwendet Ecclium nie ([ADR 0017](0017-clean-room-gegenueber-fork.md)).
- **Erst lesend:** Die Installation beginnt mit einem Server, der nur liest, und mit `dienstplan-report` nach Zeitplan. Schreib-Tools kommen nur dazu, wenn die Gemeinde sie will, nach ihrer Richtlinie.
- **Images:** Bis zum ersten veröffentlichten Image baut die Installation die Images aus den Paketen des geprüften Stands auf ihrem Rechner, mit dem Schritt dafür in der Anleitung. Mit dem ersten Release wechselt sie auf das veröffentlichte Image und prüft dabei dessen Herkunft so, wie es jede Gemeinde tut.
- **Nachweise ohne Daten:** In `docs/STATUS.md` steht, was von Hand nötig war, welche Clients sich über den Reverse-Proxy verbanden und ob die Routine nach Zeitplan lief, ohne Hostname, ohne Namen der Gemeinde, ohne Personen und ohne Kennungen. Logs, Audit-Dateien und Daten der Installation kommen nie ins Repository.
- **Kein Staging:** Unfertige Funktionen laufen nie zuerst dort. Ziel für Tests mit einer echten Instanz bleibt die Testinstanz ([ADR 0049](0049-testumgebung.md)).

## Konsequenzen

- Die Anleitung wird vor dem Release einmal unter echten Bedingungen geprüft. Was eine fremde Gemeinde von Hand tun müsste, wird vorher sichtbar.
- Die Installation verarbeitet echte Daten einer Gemeinde. Dafür ist die Gemeinde mit ihrem Betreiber verantwortlich, wie bei jeder anderen Installation ([`docs/privacy.md`](../privacy.md)).
- Ohne dauerhaftes Staging prüfen nur CI und die Testinstanz einen Stand vor seinem Release. Ein Fehler, den beide nicht zeigen, trifft zuerst die Referenzinstallation; deshalb beginnt sie lesend, und die Kill-Switches gelten dort wie überall.
- Restrisiken: Die Installation hängt an der Bereitschaft einer Gemeinde. Der Weg mit selbst gebauten Images vor dem ersten Release ist einer, den später keine Gemeinde geht; den Bezug des veröffentlichten Images und die Prüfung seiner Herkunft prüft erst der Release.
