### Dienstplan {{period}}

#### Unbesetzte Dienste
{{#unbesetzt}}
- {{datum}}, {{termin}}: {{dienst}}
{{/unbesetzt}}
{{^unbesetzt}}
Alle Dienste sind besetzt.
{{/unbesetzt}}

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
