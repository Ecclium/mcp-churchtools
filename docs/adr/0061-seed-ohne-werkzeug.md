# ADR 0061: Seed der Testinstanz ohne Werkzeug der Community

- Status: Angenommen am 23.10.2026
- Datum: 23.10.2026
- Fällt vor: Phase 2

## Kontext

Ab Phase 2 legt `scripts/seed/` die synthetischen Testdaten der Testinstanz reproduzierbar an, damit jedes Lese-Tool gegen Daten mit Inhalt laufen kann (ADR 0049). Bis dahin entstanden die wenigen Objekte, die der Spike braucht, von Hand: die Seiten der schreibenden Proben, die Personen p1 bis p4 und die Gruppen g1 und g2 von `08-persons-groups-read` (`docs/research/churchtools-api.md`).

ADR 0049 liess offen, ob der Seed ein Werkzeug aus der Community von ChurchTools als Abhängigkeit der Entwicklung nutzen darf, etwa eines für Infrastruktur als Code. ADR 0020 erlaubt Hilfsskripten unter `scripts/` nur, was Node.js mitbringt, ein solches Werkzeug bräuchte deshalb ein ADR, das ADR 0020 ablöst. Es käme nur mit einer Lizenz aus der Liste für Werkzeuge der Entwicklung und unter den Regeln der Lieferkette in Frage (ADR 0050), und sein Quelltext würde nicht übernommen (ADR 0017).

Eine Suche im Web am 23.10.2026 fand kein solches Werkzeug für ChurchTools. Das heisst nicht, dass es keines gibt.

Der Seed muss können: Objekte über dokumentierte Operationen anlegen, jedes mit einem Kennzeichen versehen, beim Zurücksetzen nur gekennzeichnete Objekte entfernen und vor der ersten schreibenden Anfrage hinter dem Wächter aus ADR 0049 stehen. Für die Proben des Spikes gibt es diesen Wächter schon (`scripts/spike/lib/gate.mts`), ebenso einen Client, der jede Operation im OpenAPI-Dokument der Instanz nachschlägt, bevor er sie aufruft.

## Optionen

1. **Eigener Code nur mit Node.js:** Der Seed nutzt den Wächter und den Client der Proben. Keine neue Abhängigkeit, ADR 0020 bleibt. Dafür entsteht mehr eigener Code, und jede Operation zum Anlegen muss der Seed selbst kennen.
2. **Werkzeug der Community als Abhängigkeit der Entwicklung:** weniger eigener Code, falls es ein passendes gibt. Dafür eine neue Abhängigkeit mit Zugriff auf ein Konto mit Schreibrechten, deren Herkunft, Lizenz und Abhängigkeiten zu prüfen wären, und ein Wächter, der sich vor ihre Anfragen stellen muss.
3. **Testdaten nur von Hand:** kein Code, aber nicht reproduzierbar, und jede neue Probe braucht neue Handarbeit.

## Entscheid

Gewählt ist die erste Option.

- Der Seed liegt unter `scripts/seed/`, läuft wie die übrigen Hilfsskripte als `.mts` direkt in Node.js und nutzt nur, was Node.js mitbringt. ADR 0020 bleibt unverändert.
- Er ruft nur Operationen auf, die das OpenAPI-Dokument der Instanz dokumentiert, und schlägt jede vor dem ersten Aufruf dort nach. Fehlt eine Operation oder lehnt die Instanz sie ab, legt er das Objekt nicht an, meldet es, und es wird ein offener Punkt in `docs/STATUS.md`.
- Er steht hinter dem Wächter aus ADR 0049: ein ausdrücklicher Schalter, ein eigenes Seed-Konto mit eigener Token-Datei, getrennt von allen anderen Konten, die Kennkategorie, die er vorher lesend prüft, und eine Bestätigung durch eine Person im Terminal vor der ersten schreibenden Anfrage. Ein Test zeigt, dass er gegen einen Mock ohne Kennkategorie abbricht.
- Jedes Objekt, das er anlegt, trägt ein Kennzeichen, an dem er es wiedererkennt. Zurückgesetzt wird nur, was dieses Kennzeichen trägt. Objekte ohne Kennzeichen bleiben stehen, darunter die von Hand angelegten Personen und Gruppen von `08-persons-groups-read` und die leere Seite «main», die ChurchTools in jeder neuen Kategorie des Wikis anlegt.
- Er legt nur synthetische Daten nach den Regeln für Platzhalter an. Er läuft nie in CI, gegen keinen produktiven Tenant und wird nie veröffentlicht. Seine Ausgabe gibt wie die der Proben nur Struktur und feste Wörter aus.
- Taucht ein Werkzeug der Community auf, das den Bedarf deckt, wird neu bewertet, mit einem eigenen ADR.

## Konsequenzen

- Keine neue Abhängigkeit, die Lieferkette bleibt, wie sie ist.
- Der Seed bringt mehr eigenen Code als ein fertiges Werkzeug. Er teilt Wächter und Client mit den Proben, damit nur ein Wächter gepflegt wird.
- Bisher ist nur das Schreiben im Wiki geprüft (F10 bis F17). Ob die Instanz Personen, Gruppen, Termine, Ressourcen, Buchungen, Events mit Diensten und Songs über die API anlegen lässt, und mit welchen Rechten, zeigt erst der erste Lauf des Seeds. Was nicht geht, bleibt Handarbeit, und der Seed nennt es.
- Das Seed-Konto braucht Rechte zum Anlegen in den synthetischen Bereichen. Es ist damit das Konto mit den weitesten Rechten auf der Testinstanz und gehört wie alle Konten der Testinstanz keiner Gruppe an (ADR 0049).
- **Restrisiken:**
  - **Verwechslung:** Der Wächter erkennt die Testinstanz nur an der Kennkategorie. Legt jemand eine Kategorie mit diesem Namen auf einem produktiven Tenant an, hält ihn nichts auf (Threat Model, T23). Schalter, eigenes Konto und die Bestätigung im Terminal verringern das, schliessen es aber nicht aus.
  - **Kennzeichen:** Erkennt der Seed ein Objekt an seinem Kennzeichen, kann auch ein Objekt mit einem nachgeahmten Kennzeichen zurückgesetzt werden. Auf der Testinstanz mit ausschliesslich synthetischen Daten ist das hingenommen.
