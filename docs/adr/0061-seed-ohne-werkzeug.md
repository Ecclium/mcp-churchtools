# ADR 0061: Seed der Testinstanz ohne Werkzeug der Community

- Status: Angenommen am 23.10.2026
- Datum: 23.10.2026
- Fällt vor: Phase 2

## Kontext

Ab Phase 2 legt `scripts/seed/` die synthetischen Testdaten der Testinstanz reproduzierbar an, damit jedes Lese-Tool gegen synthetische Daten mit Inhalt laufen kann (ADR 0049). Bis dahin legten die schreibenden Proben ihre Seiten im Wiki selbst an und entfernten sie wieder (ADR 0049, Umsetzung). Die Personen p1 bis p4 und die Gruppen g1 und g2 von `08-persons-groups-read` entstanden von Hand (`scripts/spike/README.md`).

ADR 0049 liess offen, ob der Seed ein Werkzeug aus der Community von ChurchTools als Abhängigkeit der Entwicklung nutzen darf, etwa eines für Infrastruktur als Code. ADR 0020 erlaubt Hilfsskripten unter `scripts/` nur, was Node.js mitbringt, ein solches Werkzeug bräuchte deshalb ein ADR, das ADR 0020 ablöst. Es käme nur mit einer Lizenz aus der Liste für Werkzeuge der Entwicklung (`scripts/check-licenses.mts`) und unter den Regeln der Lieferkette in Frage (ADR 0021, abgelöst durch ADR 0050, das sie übernimmt), und sein Quelltext würde nicht übernommen (ADR 0017).

Gesucht wurde am 23.10.2026:

- In der npm-Registry nach «churchtools»: vier Pakete, zwei Clients für die API und zwei MCP-Server. Keines legt Testdaten an.
- Auf GitHub nach «churchtools terraform»: zwei junge Werkzeuge für Struktur als Code, ein Provider für OpenTofu und Terraform in Go unter der MPL-2.0 und eine Kommandozeile in TypeScript unter der MIT-Lizenz. Beide verwalten nach ihrer eigenen Beschreibung nur die Struktur einer Instanz, also Standorte, Gruppentypen, Gruppen und Rechte, und nie Personen. Termine, Dienste, Songs und Seiten des Wikis kommen in ihren Beschreibungen nicht vor.
- Auf GitHub nach «churchtools seed», «churchtools fixtures», «churchtools provisioning» und «churchtools infrastructure»: kein Treffer.

Der Seed muss vier Dinge leisten: Er legt Objekte über dokumentierte Operationen an, versieht jedes mit einem Kennzeichen, entfernt beim Zurücksetzen nur gekennzeichnete Objekte und steht vor der ersten schreibenden Anfrage hinter dem Wächter aus ADR 0049. Für die schreibenden Proben des Spikes gibt es diesen Wächter schon (`scripts/spike/lib/gate.mts`), dazu Bausteine, mit denen eine Probe jede Operation im OpenAPI-Dokument der Instanz nachschlägt, bevor sie sie aufruft (`scripts/spike/lib/spec.mts`, `operations.mts`). Der Wächter lässt heute nur ein Konto mit genau den drei Rechten des Wikis durch, die die Proben brauchen, und der Client der Proben schreibt nur drei Operationen des Wikis (`scripts/spike/lib/http.mts`).

## Optionen

1. **Eigener Code nur mit Node.js:** Der Seed baut auf den Bausteinen der Proben auf. Keine neue Abhängigkeit, ADR 0020 bleibt. Dafür entsteht mehr eigener Code: Der Wächter braucht für das Seed-Konto eine eigene feste Liste der Rechte, und der Client muss die Operationen zum Anlegen kennen.
2. **Eines der beiden Werkzeuge für die Struktur, dazu eigener Code für den Rest:** Gruppentypen, Gruppen und Rechte entstünden deklarativ. Personen, Termine, Dienste, Songs und Seiten des Wikis bräuchten trotzdem eigenen Code. Dazu käme eine neue Abhängigkeit, die ein Konto mit Rechten zur Verwaltung der Rechte braucht, aus einem jungen Projekt mit kaum Nutzern. Herkunft, Lizenz und Abhängigkeiten wären zu prüfen, und der Wächter müsste sich vor ihre Anfragen stellen. Für den Provider kämen OpenTofu oder Terraform als weiteres Werkzeug dazu.
3. **Testdaten nur von Hand:** kein Code, aber nicht reproduzierbar, und jede neue Probe braucht neue Handarbeit.

## Entscheid

Gewählt ist die erste Option.

- Der Seed liegt unter `scripts/seed/`, läuft wie die übrigen Hilfsskripte als `.mts` direkt in Node.js und nutzt nur, was Node.js mitbringt. ADR 0020 bleibt unverändert.
- Er ruft nur Operationen auf, die das OpenAPI-Dokument der Instanz dokumentiert, und schlägt jede vor dem ersten Aufruf dort nach. Fehlt eine Operation oder lehnt die Instanz sie ab, legt er das Objekt nicht an und meldet das mit einem festen Wort. Die Lücke wird ein offener Punkt in `docs/STATUS.md`.
- Er steht hinter dem Wächter aus ADR 0049: ein ausdrücklicher Schalter, ein eigenes Seed-Konto mit eigener Token-Datei, getrennt von allen anderen Konten, und die Kennkategorie, die er vorher lesend prüft. Dazu verlangt er wie die schreibenden Proben vor der ersten schreibenden Anfrage eine Bestätigung durch eine Person im Terminal. Der Wächter der Proben wird dafür um eine eigene feste Liste der Rechte des Seed-Kontos erweitert, und der Client um die Operationen zum Anlegen, jede Erweiterung mit Gegenprobe. Ein Test zeigt, dass der Seed gegen einen Mock ohne Kennkategorie abbricht.
- Jedes Objekt, das er anlegt, trägt ein Kennzeichen, an dem er es wiedererkennt. Zurückgesetzt wird nur, was dieses Kennzeichen trägt. Objekte ohne Kennzeichen bleiben stehen, darunter die von Hand angelegten Personen und Gruppen von `08-persons-groups-read` und die leere Seite «main», die jede neue Kategorie des Wikis von selbst erhält (F16, von Hand beobachtet).
- Er legt nur synthetische Daten nach den Regeln für Platzhalter in `CONTRIBUTING.md` an. Er läuft nie in CI und gegen keinen produktiven Tenant, und er wird nie veröffentlicht. Er gibt wie die Proben nur Struktur und feste Wörter aus.
- Taucht ein Werkzeug der Community auf, das den Bedarf deckt, wird dieser Entscheid in einem eigenen ADR neu bewertet.

## Konsequenzen

- Keine neue Abhängigkeit, die Lieferkette bleibt, wie sie ist.
- Der Seed bringt mehr eigenen Code als ein fertiges Werkzeug. Er teilt die Bausteine von Wächter und Client mit den Proben, damit nur ein Wächter gepflegt wird.
- Bisher ist nur das Schreiben im Wiki geprüft (F10 bis F13, F16, F17, F20 und F21). Ob die Instanz Personen, Gruppen, Termine, Ressourcen, Buchungen, Events mit Diensten und Songs über die API anlegen lässt, und mit welchen Rechten, zeigt erst der erste Lauf des Seeds. Was nicht geht, bleibt Handarbeit, und der Seed nennt es.
- Das Seed-Konto braucht Rechte zum Anlegen in den synthetischen Bereichen. Es ist damit das Konto mit den weitesten Rechten auf der Testinstanz und gehört wie alle Konten der Testinstanz keiner Gruppe an (ADR 0049).
- **Restrisiken:**
  - **Verwechslung:** Der Wächter erkennt die Testinstanz nur an der Kennkategorie. Legt jemand auf einem produktiven Tenant eine Kategorie mit diesem Namen an, schreibt der Seed dort, ohne dass der Wächter ihn aufhält (Threat Model, T23). Schalter, eigenes Konto und die Bestätigung im Terminal verringern das, schliessen es aber nicht aus.
  - **Kennzeichen:** Erkennt der Seed ein Objekt an seinem Kennzeichen, kann auch ein Objekt mit einem nachgeahmten Kennzeichen zurückgesetzt werden. Auf der Testinstanz mit ausschliesslich synthetischen Daten ist das hingenommen.
