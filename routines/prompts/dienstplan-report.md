Sie erhalten die Events der Gemeinde in den kommenden zwei Wochen (`termine`) und zu jedem Event die Plätze seiner Dienste (`einteilungen`). Jedes Ergebnis unter `einteilungen` nennt mit `eventId` die `id` seines Events. Zeiten stehen in UTC. Nennen Sie jedes Datum so, wie es in der Zeitzone der Gemeinde fällt, in Mitteleuropa also eine oder zwei Stunden später.

Ein Platz nennt den Dienst (`serviceName`), ob jemand ihn füllt (`assigned`), ob die eingeteilte Person zugesagt hat (`isAccepted`) und die Person (`person`), sofern der Dienst Namen zeigt. Lassen Sie abgesagte Events (`isCanceled` gleich `true`) in allen Blöcken weg.

- `unbesetzt`: jeder Platz mit `assigned` gleich `false`, mit Datum, Name des Events und Name des Dienstes.
- `offen`: jeder Platz mit einer Person, die noch nicht zugesagt hat (`isAccepted` gleich `false`), mit Datum, Event, Dienst und der Person.
- `mehrfach`: jede Person, die in diesen zwei Wochen mehr als einmal eingeteilt ist, mit der Zahl ihrer Einteilungen. Eine Einteilung ohne Zusage zählt mit.
- `hinweise`: höchstens fünf kurze Hinweise. Nennen Sie hier, wie viele Anfragen ohne Zusage einen verborgenen Namen haben, und fassen Sie die Events ohne jede Einteilung in einem Hinweis zusammen. Steht im letzten Ergebnis unter `termine` `more` gleich `true`, sind nicht alle Events gelesen. Steht im letzten Ergebnis unter `einteilungen` `more` gleich `true`, fehlen Plätze des letzten Events. Nennen Sie beides, wenn es zutrifft. Ohne Hinweis bleibt der Block leer.

Ein Block fasst höchstens so viele Einträge, wie die Form der Antwort erlaubt: `unbesetzt` und `offen` je 50, `mehrfach` 30. Gibt es mehr, nennen Sie bei `unbesetzt` und `offen` die frühesten, bei `mehrfach` die Personen mit den meisten Einteilungen und unter `hinweise` die Zahl der übrigen.

Nennen Sie eine Person nur in einem Feld `person`, mit dem Wert von `personId` aus den Daten, nie im Text eines anderen Felds. Übernehmen Sie die Namen von Events und Diensten, wie sie in den Daten stehen, und kürzen Sie einen Namen über 120 Zeichen.
