# ADR 0008: Signierte Offline-Lizenzdateien statt Online-Aktivierung

- Status: Entwurf
- Datum: 30.09.2026
- Fällt vor: Phase 9

## Kontext

Neben dem freien Kern soll es ein kostenpflichtiges Zusatzmodul geben. Seine Funktionen brauchen eine Lizenz, und der Kern muss sie prüfen können. Die Stufe `gate` der Pipeline berücksichtigt dafür die Lizenz (ADR 0024).

Dabei gelten zwei Bedingungen. Erstens: Was im freien Kern ist, bleibt dort und kommt nie hinter eine Bezahlschranke (`PROMISE.md`). Zweitens: Ecclium verbindet nur zu den Zielen, die der Betreiber kennt, und der Runner erreicht im Self-Hosting nur die Ziele auf einer Positivliste (ADR 0009). Festzulegen ist, wie eine Lizenz geprüft wird.

## Optionen

1. **Online-Aktivierung mit Rückmeldung an den Lizenzgeber:** Ein Widerruf wirkt sofort, aber jede Installation braucht eine Verbindung zum Lizenzgeber, die Positivliste wird länger, der Lizenzgeber erfährt etwas über die Nutzung, und bei einem Ausfall seines Dienstes fallen die Funktionen aus.
2. **Ein Schlüssel ohne Signatur:** einfach, aber leicht zu fälschen.
3. **Eine signierte Lizenzdatei, die der Kern ohne Netz prüft.**

## Entscheid

Entwurf: Vorgesehen ist die dritte Option.

- Eine Lizenzdatei besteht aus den Nutzdaten als Bytes und einer getrennten Ed25519-Signatur darüber, mit einer Kennung des Schlüssels (`kid`). Der Kern enthält zwei öffentliche Schlüssel, damit ein Wechsel des Schlüssels ohne Ausfall möglich ist. Geprüft wird mit `node:crypto`, ohne zusätzliche Abhängigkeit.
- Eine Lizenz gilt 12 Monate, danach noch 30 Tage Kulanz. Die Prüfung braucht kein Netz und meldet nichts an den Lizenzgeber.
- **Nur für das Zusatzmodul:** Eine Lizenz schaltet nur Funktionen des Zusatzmoduls frei. Keine Funktion des freien Kerns hängt an einer Lizenz. Fehlt sie oder ist sie abgelaufen, ändert sich am freien Kern nichts, und die Funktionen des Zusatzmoduls zeigen einen Hinweis statt eines Fehlers.
- **Abgrenzung:** Wie Erweiterungen geladen werden, wem sie vertrauen und wann sie Ports ersetzen dürfen, regelt ADR 0041. Wie Funktionen des Zusatzmoduls im freien Kern sichtbar sind, regelt ADR 0042.

## Konsequenzen

- Restrisiken: Ein Widerruf wirkt erst mit dem Ablauf der Lizenz. Das ist der Preis dafür, dass keine Installation mit dem Lizenzgeber sprechen muss.
- Der Lizenzgeber erfährt nicht, wo und wie oft Ecclium läuft.
- Wer die privaten Schlüssel verwahrt und wie Lizenzen ausgestellt werden, gehört nicht in dieses Repository.
- Offen: Welche Angaben die Nutzdaten enthalten, wird vor Phase 9 festgelegt.
