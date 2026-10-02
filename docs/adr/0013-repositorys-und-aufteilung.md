# ADR 0013: Repositorys und Aufteilung öffentlich und privat

- Status: Vorgeschlagen
- Datum: 02.10.2026
- Fällt vor: Phase 0

## Kontext

Zu Ecclium gehören der freie Kern unter der Apache License 2.0 (ADR 0002), das kostenpflichtige Pro-Modul, der gehostete Betrieb und das Markenpaket mit Logo, Icons, Farben, Schriften und Sprachregeln. Der Kern ist ab dem ersten Commit öffentlich (ADR 0014). Das Pro-Modul steht unter einer kommerziellen Lizenz, und der Betrieb hat Einstellungen und Entscheide, die nicht öffentlich sind.

Zu entscheiden ist, wie diese Teile auf Repositorys verteilt sind und was zwischen ihnen fliessen darf.

## Optionen

1. **Ein Repository für alles:** ein einziger Ort. Dann wäre entweder auch das Pro-Modul und der Betrieb öffentlich, oder der Kern wäre nicht öffentlich ab dem ersten Commit, wie es ADR 0014 verlangt.
2. **Der Kern öffentlich, alles Übrige in einem gemeinsamen privaten Repository:** weniger Repositorys. Pro-Modul und Betrieb teilten aber Zugriffsrechte, Geschichte und Prüfungen, obwohl der Betrieb Zugänge und Einstellungen berührt, die das Pro-Modul nicht braucht.
3. **Ein eigenes Repository je Teil:** Jeder Teil hat eigene Zugriffsrechte, Lizenz und Geschichte. Die Teile verbinden sich nur über veröffentlichte Pakete und gelieferte Versionen.

## Entscheid

Gewählt ist die dritte Option.

- **Kern:** dieses Repository, öffentlich ab dem ersten Commit, unter der Apache License 2.0. Hier steht alles, was Mitwirkende und Betreibende brauchen: Code, Entscheide als ADR, Stand und offene Punkte in `docs/STATUS.md`, Bedrohungen und Gegenmassnahmen in `docs/threat-model.md`.
- **Pro-Modul:** gehört in ein eigenes, nicht öffentliches Repository unter einer kommerziellen Lizenz. Es nutzt den Kern nur so, wie ADR 0015 es festlegt.
- **Gehosteter Betrieb:** gehört in ein eigenes, nicht öffentliches Repository. Dort liegen seine Entscheide. Im Index dieses Repositorys stehen sie nur mit ihrer Nummer und dem Status «Betrieblich, nicht öffentlich» (ADR 0001). Ihre Bedrohungen stehen nicht im Threat Model dieses Repositorys.
- **Markenpaket:** wird in einer eigenen Quelle gepflegt und in Versionen geliefert. `brand/` übernimmt jede Version unverändert, nachgewiesen über den Tree-Hash gegen den Tag der Version. Im Kern wird `brand/` nie geändert. Den Gebrauch von Name und Logo regelt `TRADEMARKS.md`, nicht die Lizenz des Quellcodes (ADR 0002).

Zwischen den Teilen gilt:

- **Abhängigkeit nur in eine Richtung:** Pro-Modul und Betrieb dürfen vom öffentlichen Kern abhängen, der Kern nie von ihnen. Er kennt nur seine eigene Schnittstelle für Erweiterungen (ADR 0022).
- **Keine Verweise nach innen:** Der Kern nennt keine privaten Repositorys, Pfade oder Inhalte. Ein Entscheid, den Mitwirkende des Kerns brauchen, steht als ADR in diesem Repository und begründet sich dort selbst.
- **Nur über Pull Requests:** Was aus einem nicht öffentlichen Teil in den Kern kommt, kommt als gewöhnlicher öffentlicher Pull Request, mit denselben Prüfungen und derselben Durchsicht wie jeder andere Beitrag.

## Konsequenzen

- Der Kern muss für sich verständlich sein. Eine Begründung, die ausserhalb entstanden ist und den Kern betrifft, gilt hier erst, wenn sie als ADR in diesem Repository steht.
- Eine Erweiterungsstelle, die das Pro-Modul braucht, entsteht zuerst öffentlich im Kern (ADR 0015).
- Der Kern und der gehostete Betrieb zählen die Nummern ihrer ADRs gemeinsam. Der Index zeigt die betrieblichen Nummern ohne Titel, damit die Zählung keine Lücken hat. Entscheide zum Pro-Modul, die den Kern betreffen, stehen als ADR in diesem Repository.
- Die Tabelle der erlaubten Importe regelt nur die Pakete dieses Workspace. Ein npm-Paket erkennen die Regeln für Importe nur, wenn das `package.json` des importierenden Pakets es nicht nennt (ADR 0022). Eine Abhängigkeit des Kerns von einem nicht öffentlichen Paket fiele deshalb erst in der Durchsicht auf und in der Prüfung der Lizenzen, die jede Lizenz ausserhalb ihrer Listen zurückweist (ADR 0021). Dass ein nicht öffentlicher Teil nichts in den Kern trägt, was dort nicht hingehört, sichern die Prüfungen auf vertrauliche Daten (ADR 0014) und die Durchsicht, nicht die Trennung selbst.
- Der Abgleich des Markenpakets über den Tree-Hash ist ein Nachweis von Hand und für jede neue Version nötig (Threat Model L16).

## Umsetzung

- Index mit den betrieblichen Nummern: `docs/adr/README.md`.
- Nachweise für die Versionen des Markenpakets: `docs/STATUS.md`.
- Tabelle der erlaubten Importe: `tests/architecture/boundaries.json` (ADR 0022).
