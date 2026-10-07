# ADR 0049: Testumgebung mit synthetischen Daten, eigenen Dienstkonten, Wächter gegen Verwechslung und Testdaten als Code

- Status: Entwurf
- Datum: 07.10.2026
- Fällt vor: Phase 1

## Kontext

Ecclium braucht eine echte ChurchTools-Instanz, an der es das Verhalten der API prüfen kann: im API-Spike in Phase 0, mit den Lese-Tools ab Phase 1, mit den Schreib-Tools ab Phase 5 und im Lauf mit einem echten Modell vor jedem Release. Tests in CI laufen dagegen nur gegen Mocks, ohne Verbindung nach aussen.

Ein produktiver Tenant enthält Daten, die auf die Religionszugehörigkeit von Personen schliessen lassen (Threat Model, W1). Ein erster Lauf der Proben auf einem produktiven Tenant wurde am 29.09.2026 beendet, weil das verfügbare Konto mehr Rechte hatte, als der Spike braucht. Der Weg mit einem eng berechtigten Konto auf einem produktiven Tenant vom 02.10.2026 hätte das Lesen auf eine Testkategorie beschränkt, das Schreiben aber trotzdem in einer echten Gemeinde stattfinden lassen. Seit dem 07.10.2026 steht eine Testinstanz mit ausschliesslich synthetischen Daten zur Verfügung.

Mit einer Testinstanz entsteht eine neue Gefahr: die Verwechslung. Ein vertauschter Wert in der Konfiguration kann Testdaten oder Schreibvorgänge in eine echte Gemeinde tragen, ein Token eines produktiven Tenants an die Testinstanz schicken oder echte Daten auf die Testinstanz bringen (Threat Model, T23).

## Optionen

1. **Nur Mocks:** Kein Zugriff auf eine echte Instanz. Das Verhalten der API bliebe unbelegt, auch das, worauf ADR 0025 seine Schemas stützt.
2. **Produktiver Tenant mit eng berechtigtem Konto:** Echte Antworten, aber echte Daten in der Nähe, Schreibvorgänge in einer Gemeinde und eine Zustimmung ihrer Verantwortlichen für jeden Lauf.
3. **Testinstanz mit synthetischen Daten:** Eigene Konten, ein Wächter gegen Verwechslung und Testdaten, die als Code entstehen. Die Instanz kann anders eingestellt sein als ein gewöhnlicher Tenant.

## Entscheid

Gewählt ist die dritte Option.

- **Nur synthetische Daten:** Auf der Testinstanz liegen nur erfundene Daten nach den Platzhalterregeln des Projekts, etwa «Person A» oder `max.mustermann@example.org`. Keine Kopie, kein Export und kein Auszug aus einem produktiven Tenant, auch nicht pseudonymisiert. Echte Daten auf der Testinstanz sind ein Vorfall und werden gemeldet.
- **Hostname und IDs nie im Repository:** Der Hostname der Testinstanz wird behandelt wie der eines produktiven Tenants. Er steht nicht im Code, in Tests, Fixtures, Logs, `docs/research/`, Issues oder Commit-Messages, sondern kommt nur aus der Konfiguration, aus der Umgebung oder aus einer Datei ausserhalb des Repositorys. Dasselbe gilt für IDs von Objekten auf der Testinstanz: Tests arbeiten mit Platzhaltern und Mocks. Öffentliche Texte nennen sie «eine Testinstanz mit synthetischen Daten», ohne zu sagen, wer sie bereitstellt. Die generische Regel für Hosts unter `church.tools` in `.gitleaks.toml` fängt einen solchen Hostnamen ab (ADR 0014).
- **Eigene Dienstkonten:** Jede Aufgabe hat ein eigenes Konto auf der Testinstanz mit eigener Token-Datei ausserhalb des Repositorys, übergeben über eine Variable `*_FILE`: ein Konto, das für den Spike liest, ein Konto, das nur in einem Testbereich des Wikis schreibt, ab Phase 1 eines für den Server und später eines für den Runner. Keines davon benutzt etwas, das der eigene Fork eines Referenzprojekts benutzt (ADR 0017).
- **Produktive Tenants:** Gegen einen produktiven Tenant läuft bis Phase 4 nur `ct_whoami`, geschrieben wird dort nie. Gegen die Testinstanz dürfen ab Phase 1 alle registrierten Lese-Tools laufen, weil dort keine Daten liegen, die eine Maskierung schützen müsste.
- **Wächter gegen Verwechslung:** Jedes Skript, das gegen eine echte Instanz schreibt, etwa die schreibenden Proben des Spikes, ein schreibender Smoke-Test, der Seed oder der Spike zu OAuth, prüft vor der ersten schreibenden Anfrage drei Dinge und bricht sonst ab: einen ausdrücklichen Schalter in der Umgebung, ein eigenes Konto der Testinstanz mit eigener Token-Datei, getrennt von allen anderen Zugangsdaten, und eine Wiki-Kategorie mit einem festen Kennnamen, den der Code des Wächters vorgibt und den das Skript vorher lesend prüft. Fehlt die Kategorie, gilt die Instanz als produktiv. Ein Test belegt den Wächter: Gegen einen Mock ohne die Kategorie bricht das Skript ab.
- **Testdaten als Code:** Ab Phase 2 legt `scripts/seed/` die Testdaten reproduzierbar an, darunter Seiten für den Spike und für den Lauf mit einem echten Modell. Jedes angelegte Objekt trägt ein Kennzeichen. Zurückgesetzt wird nur, was dieses Kennzeichen trägt. Der Seed ist ein Werkzeug der Entwicklung ausserhalb der Pakete, wird nie veröffentlicht, läuft nur hinter dem Wächter und nie in CI. Er darf, abweichend von ADR 0020, ein Werkzeug aus der Community von ChurchTools als Abhängigkeit der Entwicklung nutzen, wenn dessen Lizenz auf der Positivliste steht und es die Regeln aus ADR 0021 erfüllt. Welches, wird vor Phase 2 entschieden und im Commit begründet. Quelltext eines solchen Werkzeugs wird nicht übernommen (ADR 0002, ADR 0017).
- **Keine CI gegen echte Instanzen:** Die Testinstanz ist ein Ziel für Läufe von Hand, nicht für CI. Ein Job in CI gegen die Testinstanz bräuchte ein Geheimnis auf GitHub und ein eigenes ADR.
- **Kein Staging von Ecclium:** Die Testinstanz ist eine ChurchTools-Instanz mit synthetischen Daten, gegen die Ecclium läuft. Eine dauerhaft betriebene Installation von Ecclium selbst ist sie nicht.

## Konsequenzen

- Befunde von der Testinstanz gelten für ihre Version und ihre Einstellungen. Eine Instanz für Tests kann anders eingestellt sein als ein gewöhnlicher Tenant, etwa bei Sitzungen, bei der Freigabe anderer Domains oder bei den lizenzierten Modulen. Das Research-Dokument hält Befunde unter diesem Vorbehalt fest.
- Der Wächter erkennt eine Verwechslung nur an der Kennkategorie. Legt jemand eine Kategorie mit diesem Namen auf einem produktiven Tenant an, hält ihn nichts auf.
- Proben, die nur lesen, haben keinen Wächter. Sie schicken ihr Token an die Instanz, die in der Konfiguration steht. Getrennte Ordner für die Zugangsdaten jeder Instanz verringern die Gefahr, ein Token an den falschen Host zu schicken, verhindern können sie es nicht.
- Für jede Aufgabe ein eigenes Konto heisst mehr Konten und Token-Dateien, die gepflegt und nach einem Vorfall erneuert werden müssen.
- Ein Werkzeug aus der Community als Abhängigkeit für den Seed ist eine weitere Abhängigkeit in der Lieferkette, mit den Risiken aus ADR 0021.
- Der Weg über ein Konto auf einem produktiven Tenant vom 02.10.2026 entfällt.
