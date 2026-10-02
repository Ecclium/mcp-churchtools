# ADR 0015: Pro-Modul bindet den Kern als veröffentlichte Abhängigkeit, nicht als Submodul

- Status: Vorgeschlagen
- Datum: 02.10.2026
- Fällt vor: Phase 0

## Kontext

Das Pro-Modul erweitert den freien Kern um Funktionen für Organisationen. Es liegt in einem eigenen, nicht öffentlichen Repository (ADR 0013). Um eigene Tools anzubieten oder Ports des Kerns zu ersetzen, braucht es die Schnittstelle des Kerns für Erweiterungen. Zu entscheiden ist, auf welchem Weg es den Kern einbindet.

Dabei gelten diese Bedingungen:

- Der Kern kennt das Pro-Modul nicht. Fehlt es, läuft alles Freie unverändert (`PROMISE.md`, ADR 0008).
- Eine Erweiterung bringt ihre eigene Kopie der Schnittstelle und von `zod` mit. Deshalb hält die Schnittstelle keinen Zustand auf Modulebene (ADR 0022).
- Der Kern ist öffentlich, das Pro-Modul nicht.

## Optionen

1. **Der Kern als Git-Submodul oder Subtree im Repository des Pro-Moduls:** Das Pro-Modul sähe jeden Stand des Kerns, auch unveröffentlichte, und könnte interne Module importieren. Interne Schnittstellen würden so zum Vertrag, ohne dass der Kern es merkt.
2. **Eine Kopie oder ein Fork des Kerns:** Jede Änderung im Kern müsste von Hand nachgezogen werden, und Abweichungen vom freien Kern blieben unsichtbar.
3. **Die veröffentlichten npm-Pakete:** Das Pro-Modul hängt von den Paketen ab, die der Kern veröffentlicht, in genau gepinnten Versionen, wie jede Erweiterung Dritter.

## Entscheid

Gewählt ist die dritte Option.

- Das Pro-Modul bindet den Kern nur über die beiden veröffentlichten Pakete ein (ADR 0022). Es kompiliert nur gegen die Schnittstelle `@ecclium/mcp-churchtools-plugin-api` und wird zur Laufzeit vom Produktpaket `@ecclium/mcp-churchtools` geladen.
- Es gibt kein Submodul, keinen Subtree, keine Kopie des Kerns, keine Verknüpfung in einen gemeinsamen Workspace und keinen Import interner Module des Kerns.
- Braucht das Pro-Modul eine neue Stelle zum Erweitern, entsteht sie zuerst öffentlich in der Schnittstelle des Kerns, mit Tests im Kern, und erscheint mit einem Release. Erst danach nutzt das Pro-Modul sie.
- Dieses ADR legt nur den Weg der Einbindung fest. Im Kern entsteht dafür nur die Schnittstelle für Erweiterungen, der Code des Pro-Moduls gehört nicht in dieses Repository.

## Konsequenzen

- Die Schnittstelle für Erweiterungen ist der einzige Vertrag zwischen Kern und Pro-Modul. Bis zu ihrer Version 1.0 darf sie sich noch ändern (ADR 0003), danach gilt eine streng semantische Version (ADR 0022).
- Das Pro-Modul nutzt dieselbe Schnittstelle wie Erweiterungen Dritter. Wann eine Erweiterung Ports des Kerns ersetzen darf, regelt ADR 0041, wie eine Lizenz geprüft wird, ADR 0008.
- Eine Änderung, die das Pro-Modul braucht, erscheint zuerst in einem Release des Kerns. Das Pro-Modul setzt deshalb den Release-Pfad voraus (ADR 0040).
- Wer das Pro-Modul zusammen mit dem Kern weitergibt, gibt den Kern unter der Apache License 2.0 weiter, mit den Hinweisen aus `NOTICE` (ADR 0002).
- Restrisiko: Ob das Pro-Modul wirklich nur die Schnittstelle benutzt, kann dieses Repository nicht prüfen, weil es den Code des Pro-Moduls nicht sieht. Zur Laufzeit gelten für das Pro-Modul dieselben Grenzen wie für jede Erweiterung: die feste Pipeline (ADR 0024) und die Regeln für Erweiterungen (ADR 0041).
