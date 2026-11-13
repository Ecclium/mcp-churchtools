# Prüfen mit `ecclium doctor`

`ecclium doctor` prüft, worauf der Runner sich verlässt, und schreibt einen Bericht auf stdout, der ohne Nacharbeit in ein öffentliches Issue darf. Diese erste Fassung prüft den Runner, noch nicht den Server. Sie schreibt nichts nach ChurchTools, fragt kein Modell an und legt ausser einer Zeile im Audit je Konto nichts ab. Zum Proxy baut sie nur Tunnel, die sie nach dem Handshake mit TLS wieder schliesst, und zu ChurchTools öffnet sie eine Verbindung ohne Proxy, um zu prüfen, dass sie scheitert.

## Aufruf

```sh
ecclium doctor
ecclium doctor --show-values
```

Rufen Sie `doctor` dort auf, wo der Runner läuft, mit derselben Umgebung: im Self-Hosting im Netz `runner-int`, sonst prüft er den Weg eines anderen Rechners. `doctor` lädt die Konfiguration der Art `runner`. Ist sie ungültig, zeigt er die Probleme wie `ecclium config check --runner`, prüft nichts weiter und fragt nichts an.

## Was `doctor` prüft

- **Ausgehender Weg** ([Grenze im Netz mit Squid](egress.md)):
  - Über den Proxy aus `ECCLIUM_EGRESS_PROXY` ein Tunnel zu jedem Ziel der Liste aus `ecclium init egress`, also zu ChurchTools, zu jedem Anbieter der Datei der Anbieter und zum Host der Ping-URL, je mit einem Handshake mit TLS im Tunnel. Zertifikat und Name prüft `doctor` wie jede Verbindung von Ecclium. Eine Anfrage geht nie hinaus, auch nicht an ein Modell oder an die Ping-URL.
  - Ein Tunnel zu `ecclium-doctor.invalid:443`, einem Namen ausserhalb jeder Liste. Erwartet ist 403. Gibt der Proxy den Tunnel, lässt er fremde Ziele durch. Antwortet er mit 502 oder 503, hat er den Namen aufzulösen versucht, statt ihn an der Liste abzuweisen.
  - Eine Verbindung über TCP direkt zu ChurchTools, ohne den Proxy, ohne TLS und ohne Daten. Sie muss scheitern. Löst schon der Name nicht auf, sagt der Bericht das: Ob eine Verbindung zu einer IP-Adresse durchkäme, zeigt die Prüfung dann nicht. Kommt in 10 Sekunden keine Verbindung zustande, gilt das wie für den Runner mit derselben Frist als kein Weg; ob schon der Name nicht auflöste, zeigt die Prüfung dann nicht.
  - Weist der Proxy jedes Ziel mit 403 ab, auch ChurchTools, ist die Liste wohl unvollständig oder stammt aus einer anderen Konfiguration. Erzeugen Sie sie neu und ersetzen Sie die Datei.
  - Erreicht `doctor` den Proxy nicht, prüft er die übrigen Ziele nicht. Gibt der Proxy auf einen Tunnel in der Frist keine Antwort, prüft er die übrigen weiter, weil Squid länger auf ein Ziel wartet als `doctor` auf die Antwort.
  - Mit `ECCLIUM_EGRESS=off` prüft `doctor` den Weg nicht und meldet einen Befund.
- **Anbieter:** je Anbieter Modell, Land und Grundlage der Übermittlung wie in `ecclium config check`, welche Routinen ihn nutzen, und für jedes genutzte Modell, ob sich die Datei des Schlüssels verwenden lässt. Den Schlüssel liest `doctor` und verwirft ihn sofort.
- **Richtlinie:** Hash, Einträge, Lesebudget und die Befunde, wie `ecclium config check` sie zeigt.
- **Routinen:** welche starten und welche nicht, mit Grund.
- **Konten des Runners:** das eigene Konto `runner` und jeder Alias der Richtlinie. Je Konto liest `doctor` die Rechte mit `ct_whoami` und dem Token des Kontos, im Modus `operator` und mit einer Zeile im Audit. Er vergleicht sie wie der Write-Guard vor dem Schreiben eines Laufs mit den Rechten, die die Tools der startenden Routinen des Kontos brauchen, und bei `edit category` mit den Kategorien der Einträge des Kontos ([ADR 0032](../adr/0032-richtlinie-und-pruefcode.md)). Rechte zählen nur für Routinen, die starten: Was nur eine Routine braucht, die nicht startet, etwa ohne ihren Anbieter, gilt als zu weit. Rechte, die die Routinen brauchen und die das Konto nicht hat, nennt der Bericht ebenfalls als Befund, weil ein Lauf dann am Lesen oder Schreiben scheitert. Gilt eine Ausnahme `acceptRightsDrift`, nennt der Bericht ihr Ende. Eine Ausnahme, obwohl die Rechte passen, ist ein Befund, weil sie eine spätere Drift verdecken würde.

## Bericht

- Ziele heissen nach ihrer Rolle, etwa «ChurchTools» oder «Anbieter ‹default›». Rechte stehen mit Modul und Name, Routinen und Konten mit ihrer Kennung und ihrem Alias. Der Bericht nennt keinen Host, keinen Pfad, keine ID aus ChurchTools und keinen Namen einer Person.
- Mit `--show-values` nennt er Name und Port jedes Ziels und den Host jedes Endpunkts, nie einen Pfad oder ein Token. Den Bericht einer ungültigen Konfiguration zeigt er immer ohne Werte; die Werte zeigt `ecclium config check --runner --show-values`.
- Eine Zeile, die mit «Befund» beginnt, verlangt einen Blick. Die übrigen sagen, was in Ordnung ist oder was nicht geprüft wurde.
- Auf stderr stehen die Zeilen des Logs, etwa der Abschluss der Audit-Datei.

## Exit-Codes

| Code | Bedeutung                                                                                                                                                                                                   |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Kein Befund zu Weg, Anbietern, Routinen und Konten. Befunde zur Richtlinie zählen nicht, weil sie oft gewollt sind, etwa ein leerer interaktiver Teil bei einem Runner ohne Server.                         |
| 64   | Falscher Aufruf.                                                                                                                                                                                            |
| 65   | Mindestens ein Befund zu Weg, Anbietern, Routinen oder Konten, auch mit `ECCLIUM_EGRESS=off` und für jede Prüfung, die nicht zustande kam oder nicht ganz, etwa Rechte, die `ct_whoami` nicht lesen konnte. |
| 70   | Interner Fehler.                                                                                                                                                                                            |
| 78   | Die Konfiguration des Runners ist ungültig. `doctor` prüft dann nichts weiter.                                                                                                                              |

## Was diese Fassung nicht prüft

- Die Sperre privater und besonderer Adressen im Proxy. Ein Name ausserhalb der Liste endet in der Vorlage schon vorher mit 403, auch eine private Adresse als Ziel. Die Sperre selbst bräuchte einen Namen der Liste, der auf eine private Adresse zeigt. Sie belegt nur ein Lauf der Vorlage mit Docker ([Grenze im Netz mit Squid](egress.md#prüfen)).
- Ob die Ping-URL ihre Prüfung erreicht: `doctor` prüft nur Tunnel und TLS zu ihrem Host, ohne Ping.
- Die Uhrzeit, den Ablauf der Tokens, das Alter des Images und die Rechte des Kontos des Servers, auch eine Sicherheitsstufe, die kein Tool braucht, und Schreibrechte trotz `ECCLIUM_READ_ONLY=true`. Sie kommen mit einer späteren Fassung von `doctor`.
- `ct_whoami` nennt je Recht höchstens 10 IDs und gibt bei mehr als 150 gesetzten Rechten einen Fehler. Darf ein Konto in mehr als 10 Kategorien schreiben, prüft `doctor` das Recht `edit category` nicht ganz und meldet einen Befund; einen Fehler meldet er ebenso.
- Rechte, die ein Konto über eine Gruppe hat, zeigt `ct_whoami` womöglich nicht.
