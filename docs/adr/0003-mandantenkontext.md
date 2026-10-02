# ADR 0003: Mandantenkontext als expliziter Parameter

- Status: Angenommen am 02.10.2026
- Datum: 30.09.2026
- Fällt vor: Phase 1

## Kontext

Ecclium läuft mit demselben Code in drei Betriebsarten: lokal über stdio für eine Person, im Self-Hosting über HTTP für eine Gemeinde und im gehosteten Betrieb, in dem ein Prozess mehrere Gemeinden bedient. Den gehosteten Betrieb ermöglicht ein kostenpflichtiges Zusatzmodul, tragen muss ihn der Kern.

Jede Anfrage und jeder Lauf gehört zu genau einer ChurchTools-Instanz, dem Mandanten, und zu einem Akteur. Daran hängen die Basis-URL, die Zugangsdaten, der Cache, die Maskierung, die Pseudonyme, das Protokoll und die Richtlinie für Schreibvorgänge. Ein Fehler in dieser Zuordnung zeigt Daten einer Gemeinde bei einer anderen, in einer Antwort, im Cache oder im Protokoll.

Der Server hält zwischen zwei Anfragen keinen Zustand, für jede Anfrage entsteht eine Server-Instanz (ADR 0018). Festzulegen ist, wie der Mandant zu den Schichten gelangt und woher er stammt. Nachträglich eingebaut wäre das der teuerste Umbau, weil er jede Schicht berührt.

## Optionen

1. **Ein Mandant pro Prozess, global in der Konfiguration:** einfach für eine Gemeinde, aber ein Prozess kann nie zwei Mandanten bedienen, und der spätere Umbau berührt jede Schicht.
2. **Ein impliziter Kontext pro Anfrage,** etwa über `AsyncLocalStorage`: kein zusätzlicher Parameter, aber unsichtbar. Ob der richtige Mandant gilt, hängt davon ab, dass keine Grenze zwischen asynchronen Aufrufen und kein Cache den Kontext verliert oder vermischt, und Erweiterungen sehen nicht, wovon sie abhängen.
3. **Ein expliziter Mandantenkontext als Parameter,** pro Anfrage oder Lauf erzeugt und an jede Schicht übergeben.

## Entscheid

Gewählt ist die dritte Option.

- **Kontext:** Jede Schicht, die Daten eines Mandanten berührt, bekommt einen `TenantContext` als Parameter. Er entsteht pro Anfrage an den Server oder pro Lauf des Runners und wird nie global, auf Modulebene oder über seine Anfrage hinaus gehalten. Er nennt mindestens den Mandanten, die Basis-URL seiner Instanz, den Akteur, den Modus (interaktiv, unbeaufsichtigt oder durch den Betreiber), die geltende Stufe der Maskierung, den Schalter für nur lesen, die freigeschalteten Funktionen, eine Uhr, ein Signal zum Abbrechen und einen Logger, der an Mandant und Lauf gebunden ist.
- **Herkunft:** Der Mandant stammt nur aus einer geprüften Quelle, nie aus Eingaben des Modells, aus Parametern eines Tools oder aus Kopfzeilen einer Anfrage.
  - Im Betrieb über stdio aus der Konfiguration des Prozesses.
  - Im Betrieb über HTTP aus der geprüften Anmeldung am Server (ADR 0037). Eine Anmeldung, der kein Mandant zugeordnet ist, wird abgelehnt.
  - Im Runner aus seiner eigenen Konfiguration, für jeden Lauf neu.
- **Eine Stelle:** Aus der geprüften Quelle leitet genau ein Port, der `TenantResolver`, Mandant und Akteur ab. Bei einer Anmeldung über HTTP besteht der Akteur aus Quelle und Subjekt der geprüften Anmeldung (ADR 0037), damit ein statisches Token und ein Token des Anmeldediensts mit demselben Subjekt nie derselbe Akteur sind. Die Kommandozeile setzt den Port als Composition Root zusammen, ein Zusatzmodul kann ihn ersetzen.
- **Self-Hosting:** Eine Installation bedient genau einen Mandanten. Er heisst `default`.
- **Gebunden an den Mandanten:** Ein Cache bindet jeden Eintrag an Mandant und Akteur, der Schlüssel besteht aus Mandant, Akteur und Route. Pseudonyme und Schlüssel gelten pro Mandant. Jeder Protokolleintrag und jedes Ereignis im Audit nennt den Mandanten.
- **Nachweis ab Phase 1:** Ein Pflichttest bedient zwei Mandanten mit verschiedenen Basis-URLs parallel in einem Prozess und zeigt, dass nichts zwischen ihnen übergeht, weder im Cache noch in den Logs noch im Audit.

## Konsequenzen

- Jede Funktion, die Daten eines Mandanten berührt, hat einen Parameter mehr. Das ist gewollt: Wovon sie abhängt, steht in ihrer Signatur, auch für Erweiterungen.
- Der gehostete Betrieb braucht im Kern keinen Umbau. Das Zusatzmodul ersetzt die Ports für Mandanten und Zugangsdaten. Unter welchen Bedingungen eine Erweiterung einen Port ersetzen darf, regelt ADR 0041.
- Die Form des Kontexts wird Teil von `@ecclium/mcp-churchtools-plugin-api` und damit ein öffentlicher Vertrag. Bis zur Version 1.0 dieser Schnittstelle darf sie sich noch ändern.
- Weil der Server keinen Zustand hält, gibt es keine Sitzung, an der ein Mandant hängen bleiben könnte. Was über eine Anfrage hinaus gilt, etwa eine offene Bestätigung, bindet der Kern selbst an Mandant und Akteur.
- Restrisiken: Die Typen verhindern nicht, dass ein Modul einen Kontext aufbewahrt und in einer späteren Anfrage wieder benutzt. Das fangen der Test mit zwei Mandanten und das Review. Ein Fehler in der Zuordnung von Anmeldung zu Mandant trifft jede Schicht. Deshalb gibt es dafür genau eine Stelle.

## Umsetzung

- Die Paketbeschreibungen von `core` und `plugin-api` nennen den Mandantenkontext (ADR 0022). Beide Pakete sind noch leer.
- Typ, `TenantResolver` und der Test mit zwei Mandanten folgen in Phase 1.
