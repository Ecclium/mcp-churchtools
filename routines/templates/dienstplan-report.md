### Dienstplan ab Woche {{period}}

#### Unbesetzte Dienste
{{#unbesetzt}}
- {{datum}}, {{termin}}: {{dienst}}
{{/unbesetzt}}
{{^unbesetzt}}
Alle Dienste sind besetzt.
{{/unbesetzt}}

#### Offene Anfragen
{{#offen}}
- {{datum}}, {{termin}}: {{dienst}}, angefragt bei {{person}}
{{/offen}}
{{^offen}}
Keine Anfrage wartet auf eine Zusage.
{{/offen}}

#### Mehrfach eingeteilt
{{#mehrfach}}
- {{person}}: {{anzahl}} Einteilungen
{{/mehrfach}}
{{^mehrfach}}
Niemand ist mehrfach eingeteilt.
{{/mehrfach}}

#### Hinweise
{{#hinweise}}
- {{text}}
{{/hinweise}}
{{^hinweise}}
Keine Hinweise.
{{/hinweise}}
