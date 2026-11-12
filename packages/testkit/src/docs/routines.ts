/**
 * Renders `schemas/routine.v1.json`, the JSON Schema of a routine, and
 * `docs/routines.md`, the page for operators, from the schema in the
 * package of the workflows (ADR 0033). The page is German and takes the
 * meaning of each field from the table below. Tests compare both with
 * their files and fail for a field without a meaning, so a changed
 * schema without new files turns CI red.
 *
 * @packageDocumentation
 */
import {
  checkBlockFields,
  draftChannels,
  notifyChannels,
  routineFileLimits,
  routineJsonSchema,
  routineLimits,
} from '@ecclium/mcp-churchtools-workflows';

/** A schema of JSON Schema as `z.toJSONSchema` writes it. */
interface JsonSchemaNode {
  readonly type?: string;
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minProperties?: number;
  readonly maxProperties?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly items?: JsonSchemaNode;
  readonly oneOf?: readonly JsonSchemaNode[];
  readonly anyOf?: readonly JsonSchemaNode[];
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly additionalProperties?: JsonSchemaNode | boolean;
  readonly required?: readonly string[];
  readonly [keyword: string]: unknown;
}

const jsonSchema = (): JsonSchemaNode => routineJsonSchema();

// A number as the pages of Ecclium write it, with ' between thousands.
const swiss = (value: number | undefined): string =>
  String(value).replaceAll(/\B(?=(?:\d{3})+$)/gu, "'");

/**
 * The placeholder a path shows for a name the routine chooses, by the path
 * of the map. A test fails while a map of the schema has none.
 */
const mapNames: Readonly<Record<string, string>> = Object.freeze({
  'inputs[].params': '<Parameter>',
  'generate.output.blocks': '<Block>',
  'generate.output.blocks.<Block>.fields': '<Feld>',
});

/**
 * The meaning of each field of a routine, by its path: `[]` for an entry
 * of a list, a name in angle brackets for a name the routine chooses. A
 * test fails while a field of the schema has no meaning here, or a
 * meaning names no field.
 */
export const routineFieldMeanings: Readonly<Record<string, string>> =
  Object.freeze({
    schema:
      'Format der Datei, immer `routine.v1`. Ohne diese Angabe oder mit einer anderen nimmt Ecclium die Routine nicht an.',
    id: 'Kennung der Routine, gleich dem Namen ihrer Datei ohne `.yaml`, etwa `dienstplan-report`. Unter dieser Kennung nennt die Richtlinie die Routine.',
    schedule:
      'Zeitplan mit fünf Feldern, siehe «Zeitplan». Die Zeitzone kommt aus `ECCLIUM_TIME_ZONE`.',
    inputs:
      'Was ein Lauf liest, bevor das Modell etwas sieht. Pflicht mit `generate`, mit `checks` nicht erlaubt, siehe «Eingaben».',
    'inputs[].name':
      'Name der Eingabe, unter dem das Modell ihre Daten sieht und eine spätere Eingabe sie mit `forEach` nennt.',
    'inputs[].tool':
      'Das Lese-Tool, etwa `ct_events_list`. Nur Lese-Tools, auf die sich Routinen verlassen können, siehe «Eingaben».',
    'inputs[].forEach':
      'Name einer früheren Eingabe: Das Tool läuft dann einmal je Eintrag dieser Eingabe.',
    'inputs[].params':
      'Die Parameter des Tools mit ihrem Namen aus dem Tool, etwa `from`.',
    'inputs[].params.<Parameter>':
      'Ein Text, eine Zahl oder ein Wahrheitswert. Ein Text wie `+14d` oder `-30d` zählt Tage ab der geplanten Auslösung. Mit `forEach` setzt `{ field: id }` das Feld `id` des jeweiligen Eintrags ein.',
    'inputs[].params.<Parameter>.field':
      'Das Feld eines Eintrags der Eingabe aus `forEach`.',
    'inputs[].maxItems':
      'Wie viele Einträge die Eingabe höchstens liefert, über alle ihre Aufrufe zusammen.',
    generate:
      'Der Schritt mit einem Sprachmodell. Eine Routine hat ihn oder `checks`, nicht beides.',
    'generate.prompt':
      'Pfad der Prompt-Datei in Markdown, im Ordner der Routinen oder einem Ordner darunter, etwa `prompts/dienstplan-report.md`.',
    'generate.model':
      'Das Modell als Name aus der Konfiguration der Anbieter, etwa `default`, nie der Name eines Anbieters.',
    'generate.redaction':
      'Wunsch für die Maskierung der Daten zum Modell, `strict` oder `standard`. Die Richtlinie entscheidet, und der Wunsch macht höchstens strenger. Voreingestellt ist `strict`.',
    'generate.maxOutputTokens': `Wie viele Tokens die Antwort des Modells höchstens hat, voreingestellt ${swiss(routineLimits.defaultOutputTokens)}.`,
    'generate.output': 'Die Form der Antwort des Modells.',
    'generate.output.blocks':
      'Die Blöcke der Antwort mit dem Namen, unter dem die Vorlage sie wiederholt.',
    'generate.output.blocks.<Block>': 'Ein Block der Antwort.',
    'generate.output.blocks.<Block>.maxItems':
      'Wie viele Einträge der Block höchstens hat.',
    'generate.output.blocks.<Block>.fields':
      'Die Felder jedes Eintrags mit dem Namen, unter dem die Vorlage sie zeigt.',
    'generate.output.blocks.<Block>.fields.<Feld>':
      'Ein Feld, siehe «Arten von Feldern».',
    'generate.output.blocks.<Block>.fields.<Feld>.type': 'Art des Felds.',
    'generate.output.blocks.<Block>.fields.<Feld>.maxLength':
      'Nur bei `text`: wie viele Zeichen der Text höchstens hat.',
    'generate.output.blocks.<Block>.fields.<Feld>.min':
      'Nur bei `integer`: die kleinste erlaubte Zahl.',
    'generate.output.blocks.<Block>.fields.<Feld>.max':
      'Nur bei `integer`: die grösste erlaubte Zahl.',
    checks:
      'Feste Prüfungen des Kerns statt eines Modells, siehe «Prüfungen des Kerns».',
    'checks[].check': 'Name der Prüfung.',
    'checks[].olderThanDays':
      'Nur bei `stalePages`: nach wie vielen Tagen ohne Änderung eine Seite zählt.',
    'checks[].maxItems':
      'Wie viele Einträge der Block der Prüfung höchstens hat.',
    template:
      'Pfad der Vorlage in Markdown, im Ordner der Routinen oder einem Ordner darunter, siehe «Vorlage».',
    output: 'Wohin das Ergebnis eines Laufs geht, siehe «Ziele».',
    'output.target': 'Art des Ziels, siehe «Ziele».',
    'output.tool':
      'Nur bei `wiki`: das Schreib-Tool. Heute nur `ct_wiki_page_append_section`, das einen eigenen Abschnitt je Periode anhängt.',
    'output.scope':
      'Nur bei `wiki`: die Seite über ihre Namen. Die Richtlinie bindet sie an Kennungen.',
    'output.scope.category': 'Name der Kategorie des Wikis.',
    'output.scope.page': 'Titel der Seite.',
    'output.channel': `Nur bei \`draft\`: der Kanal. Im freien Kern ${draftChannels.map((channel) => `\`${channel}\``).join(', ')}.`,
    'output.idempotencyKey':
      'Kennung der Routine, ein Doppelpunkt und genau einer der Platzhalter `{isoWeek}`, `{date}` oder `{month}`, etwa `dienstplan-report:{isoWeek}`. Er legt die Periode fest, siehe «Ziele».',
    notify: 'Meldungen nach einem Lauf, ohne Inhalt.',
    'notify[].channel': `Der Kanal der Meldung. Im freien Kern ${notifyChannels.map((channel) => `\`${channel}\``).join(' oder ')}.`,
  });

/** One field of a routine, with its path. */
interface FieldRow {
  readonly path: string;
  readonly nodes: readonly JsonSchemaNode[];
  readonly required: boolean;
}

// The properties of a node, of every branch of a union together: a name
// that several branches have is one row with the nodes of all of them. It
// counts as required only where every branch has it and requires it, so
// that a field of one kind of target reads as optional.
const propertiesOf = (
  node: JsonSchemaNode,
): readonly (readonly [string, JsonSchemaNode[], boolean])[] => {
  const branches = node.oneOf ?? node.anyOf ?? [node];
  const merged = new Map<string, [JsonSchemaNode[], number]>();
  for (const branch of branches) {
    for (const [name, child] of Object.entries(branch.properties ?? {})) {
      const required = (branch.required ?? []).includes(name) ? 1 : 0;
      const entry = merged.get(name);
      if (entry === undefined) merged.set(name, [[child], required]);
      else merged.set(name, [[...entry[0], child], entry[1] + required]);
    }
  }
  return [...merged.entries()].map(([name, [nodes, required]]) => [
    name,
    nodes,
    required === branches.length,
  ]);
};

const hasProperties = (node: JsonSchemaNode): boolean =>
  propertiesOf(node).length > 0;

// Every field, the fields of an object after it, those of the entries of
// a list with [] and those of a map with the placeholder of its names.
const fieldRows = (node: JsonSchemaNode, prefix = ''): FieldRow[] => {
  const rows: FieldRow[] = [];
  for (const [name, nodes, required] of propertiesOf(node)) {
    const path = `${prefix}${name}`;
    rows.push({ path, nodes, required });
    rows.push(...childRows(nodes, path));
  }
  return rows;
};

const childRows = (
  nodes: readonly JsonSchemaNode[],
  path: string,
): FieldRow[] => {
  const rows: FieldRow[] = [];
  for (const node of nodes) {
    if (node.type === 'array' && node.items !== undefined) {
      if (hasProperties(node.items)) {
        rows.push(...fieldRows(node.items, `${path}[].`));
      }
    } else if (
      typeof node.additionalProperties === 'object' &&
      node.properties === undefined
    ) {
      const name = mapNames[path];
      if (name === undefined) {
        throw new TypeError(`The map ${path} has no placeholder.`);
      }
      const inner = `${path}.${name}`;
      rows.push({
        path: inner,
        nodes: [node.additionalProperties],
        required: false,
      });
      rows.push(...childRows([node.additionalProperties], inner));
    } else if (hasProperties(node)) {
      rows.push(...fieldRows(node, `${path}.`));
    }
  }
  return rows;
};

const code = (text: string): string => `\`${text}\``;

const listOf = (values: readonly string[]): string =>
  values.length < 2
    ? (values[0] ?? '')
    : `${values.slice(0, -1).join(', ')} oder ${values.at(-1) ?? ''}`;

// The form of a value, from the nodes of all branches that have it.
const formOf = (nodes: readonly JsonSchemaNode[]): string => {
  const constants = nodes
    .map((node) => node.const)
    .filter((value): value is string => typeof value === 'string');
  if (constants.length === nodes.length && constants.length > 0) {
    return listOf([...new Set(constants)].map(code));
  }
  const [node] = nodes;
  if (node === undefined) return '';
  if (node.enum !== undefined) {
    return listOf(node.enum.map((value) => code(String(value))));
  }
  if (node.anyOf !== undefined) {
    return 'Text, ganze Zahl, Wahrheitswert oder Verweis auf ein Feld';
  }
  if (node.oneOf !== undefined) return 'Objekt einer Art';
  switch (node.type) {
    case 'integer':
      return `ganze Zahl von ${swiss(node.minimum)} bis ${swiss(node.maximum)}`;
    case 'array':
      return `Liste mit ${swiss(node.minItems)} bis ${swiss(node.maxItems)} Einträgen`;
    case 'object':
      return node.properties === undefined
        ? `Zuordnung mit ${swiss(node.minProperties)} bis ${swiss(node.maxProperties)} Einträgen`
        : 'Objekt';
    default:
      return node.minLength === undefined
        ? `Text nach festem Muster, höchstens ${swiss(node.maxLength)} Zeichen`
        : `Text von ${swiss(node.minLength)} bis ${swiss(node.maxLength)} Zeichen ohne Steuerzeichen`;
  }
};

/**
 * The paths of every field of a routine, in the order of the schema.
 *
 * @returns The paths, such as `inputs[].forEach`.
 * @example
 * ```ts
 * routineFieldPaths().includes('output.idempotencyKey'); // true
 * ```
 */
export function routineFieldPaths(): readonly string[] {
  return fieldRows(jsonSchema()).map((row) => row.path);
}

/**
 * Renders the JSON Schema of a file of a routine.
 *
 * @returns The schema as JSON with two spaces and a line break at the end.
 * @example
 * ```ts
 * JSON.parse(renderRoutineSchema()).title; // 'RoutineV1'
 * ```
 */
export function renderRoutineSchema(): string {
  const { $schema, ...rest } = jsonSchema();
  return `${JSON.stringify(
    {
      $schema,
      title: 'RoutineV1',
      description:
        'A routine of Ecclium, version 1, in YAML or JSON. Not expressed here: generate or checks but not both, inputs with generate and never with checks, forEach only on an earlier input without a loop of its own, { field } only with forEach, min not above max, the names of the core for checks, a key that starts with the ID of the routine, the channels the core knows, the rules of the schedule beyond its five fields and the name period, which the template keeps; the loader refuses all of them as well.',
      ...rest,
    },
    null,
    2,
  )}\n`;
}

const example = [
  '# Wöchentlicher Bericht über die Dienste der kommenden zwei Wochen.',
  'schema: routine.v1',
  'id: dienstplan-report',
  "schedule: '0 6 * * MON'",
  'inputs:',
  '  - name: termine',
  '    tool: ct_events_list',
  "    params: { from: '+0d', to: '+14d' }",
  '    maxItems: 40',
  '  - name: einteilungen',
  '    tool: ct_services_get_assignments',
  '    forEach: termine',
  '    params:',
  '      eventId: { field: id }',
  '    maxItems: 200',
  'generate:',
  '  prompt: prompts/dienstplan-report.md',
  '  model: default',
  '  output:',
  '    blocks:',
  '      unbesetzt:',
  '        maxItems: 30',
  '        fields:',
  '          datum: { type: date }',
  '          dienst: { type: text, maxLength: 80 }',
  '      mehrfach:',
  '        maxItems: 30',
  '        fields:',
  '          person: { type: person }',
  '          anzahl: { type: integer, min: 2, max: 50 }',
  'template: templates/dienstplan-report.md',
  'output:',
  '  target: wiki',
  '  tool: ct_wiki_page_append_section',
  '  scope: { category: Berichte, page: Dienstplan-Auswertung }',
  "  idempotencyKey: 'dienstplan-report:{isoWeek}'",
  'notify:',
  '  - channel: stdout',
];

const exampleTemplate = [
  '### Dienstplan {{period}}',
  '',
  '#### Unbesetzte Dienste',
  '{{#unbesetzt}}',
  '- {{datum}}: {{dienst}}',
  '{{/unbesetzt}}',
  '{{^unbesetzt}}',
  'Alle Dienste sind besetzt.',
  '{{/unbesetzt}}',
  '',
  '#### Mehrfach eingeteilt',
  '{{#mehrfach}}',
  '- {{person}}: {{anzahl}} Einteilungen',
  '{{/mehrfach}}',
];

const fieldKinds: readonly (readonly [string, string, string])[] = [
  [
    'text',
    '`maxLength`',
    'Klartext. Der Kern setzt ihn als reinen Text ein, Zeichen von Markdown zeichnen darin nichts aus, und jedes Feld geht durch die ContentPolicy.',
  ],
  ['integer', '`min` und `max`', 'Eine ganze Zahl in diesen Grenzen.'],
  ['date', 'feste Form', 'Ein Datum wie `2026-11-09`.'],
  [
    'person',
    'feste Form',
    'Verweis auf eine Person aus den Daten des Laufs. Das Modell sieht in `strict` ihr Pseudonym, in `standard` ihre Kennung, im Bericht steht ihr Name, wie ChurchTools ihn liefert.',
  ],
];

const checkMeanings: Readonly<Record<string, string>> = Object.freeze({
  stalePages:
    'Seiten des Wikis, die seit `olderThanDays` Tagen niemand geändert hat.',
  brokenLinks:
    'Links im Wiki auf Seiten, die das Konto der Routine nicht findet. Ein Link auf eine Seite, die das Konto nicht sehen darf, erscheint wie einer auf eine fehlende Seite.',
});

const table = (
  head: readonly string[],
  rows: readonly (readonly string[])[],
): string[] => [
  `| ${head.join(' | ')} |`,
  `| ${head.map(() => '---').join(' | ')} |`,
  ...rows.map((row) => `| ${row.join(' | ')} |`),
];

/**
 * What the core does with routines in this version, for the page. It
 * changes with the versions that use more of them.
 */
export const routinesState =
  'Der Runner führt Routinen von Hand mit `ecclium run-once` aus und als Daemon mit `ecclium runner` zu ihrer Zeit ([Runner](betrieb/runner.md)). `ecclium policy init --routine` lädt die Routinen, um den Eintrag einer Routine in der Richtlinie vorzuschlagen ([Richtlinie](policy.md)). Der Server liest den Ordner der Routinen nicht.';

/**
 * Renders `docs/routines.md`, the page of the routines for operators.
 *
 * @returns The page in Markdown with a line break at the end.
 * @example
 * ```ts
 * renderRoutinesReference().startsWith('# Routinen'); // true
 * ```
 */
export function renderRoutinesReference(): string {
  const lines = [
    '# Routinen',
    '',
    '<!-- Erzeugt aus dem Schema im Paket der Workflows. Ändern Sie den Code und rufen Sie pnpm docs:generate auf, nicht diese Datei. -->',
    '',
    'Eine Routine beschreibt einen wiederkehrenden Ablauf: wann er läuft, was er in ChurchTools liest, wie ein Sprachmodell oder eine feste Prüfung daraus Blöcke mit festen Feldern füllt, in welche Vorlage die Blöcke kommen und wohin das Ergebnis geht ([ADR 0033](adr/0033-runner-modell-ohne-werkzeuge.md)). Das Modell bekommt nur Daten und die Form der Antwort, nie ein Tool. Ziel und Aktion stehen fest, bevor es etwas sieht, und die Richtlinie entscheidet, ob ein Lauf dorthin schreiben darf ([Richtlinie](policy.md)).',
    '',
    `Stand: ${routinesState}`,
    '',
    '## Ordner',
    '',
    `- \`ECCLIUM_ROUTINES_DIR\` nennt den absoluten Pfad des Ordners ([Konfiguration](configuration.md)). Darin liegt je Routine eine Datei \`<Kennung>.yaml\`, höchstens ${swiss(routineFileLimits.routines)}. Eine Datei mit der Endung \`.yml\` oder ein Name, der keine Kennung ist, lässt den Lader abbrechen, damit keine Routine still fehlt. Andere Dateien, etwa ein README, übergeht er.`,
    `- Prompts und Vorlagen liegen im Ordner selbst oder in einem Ordner darunter, etwa \`prompts/\` und \`templates/\`. Die Routine nennt sie mit einem Pfad wie \`prompts/dienstplan-report.md\`, in Kleinbuchstaben, ohne \`..\` und ohne absoluten Pfad. So liest eine Routine keine Datei ausserhalb des Ordners.`,
    '- Ordner und Dateien müssen dem Benutzer gehören, unter dem Ecclium läuft, und Gruppe und andere Benutzer dürfen sie nicht ändern, etwa mit den Rechten 755 und 644. Ecclium folgt keinem Link.',
    `- Eine Routine hat höchstens ${swiss(routineFileLimits.routineBytes)} Bytes, ein Prompt und eine Vorlage je höchstens ${swiss(routineFileLimits.promptBytes)} Bytes, alle in UTF-8 ohne BOM. Die Routine ist YAML 1.2 oder JSON mit denselben Regeln wie die Richtlinie: keine Anker und Verweise, keine Tags, keine Direktiven, kein zweites Dokument, keine doppelten Schlüssel.`,
    '- Über die Felder hinaus weist der Lader zurück: einen Prompt mit Steuerzeichen ausser Tabulator und Zeilenende, zwei Eingaben mit einem Namen, eine Prüfung oder einen Kanal der Meldung zweimal, ein `forEach` ohne Parameter `{ field }`, eine Zahl mit `min` über `max`, einen Schlüssel einer anderen Routine und einen Kanal, den Ecclium nicht kennt.',
    '- Ist etwas falsch, hält der Lader beim ersten Problem an. Die Meldung nennt die Routine und den Pfad des Felds, etwa `inputs[1].forEach`, oder die Zeile, nie einen Wert.',
    '- Editoren prüfen und vervollständigen eine Routine mit dem Schema [`schemas/routine.v1.json`](../schemas/routine.v1.json).',
    '- Routinen, die Ecclium mitbringt, liegen mit ihren Prompts, Vorlagen und einer Anleitung zum Anpassen unter [`routines/`](../routines/README.md). Kopieren Sie sie mit Prompt und Vorlage in den Ordner aus `ECCLIUM_ROUTINES_DIR`.',
    '',
    '## Beispiel',
    '',
    'Gekürzt aus der mitgelieferten Routine `dienstplan-report` unter [`routines/`](../routines/README.md). Kategorie und Seite sind Platzhalter.',
    '',
    '```yaml',
    ...example,
    '```',
    '',
    '## Felder',
    '',
    ...table(
      ['Feld', 'Form', 'Pflicht', 'Bedeutung'],
      fieldRows(jsonSchema()).map((row) => [
        code(row.path),
        formOf(row.nodes),
        row.required ? 'ja' : 'nein',
        routineFieldMeanings[row.path] ?? '',
      ]),
    ),
    '',
    '«Pflicht» heisst: in jeder Routine, die den Teil darüber hat. Ein Feld, das nur eine Art von Ziel oder Prüfung kennt, etwa `output.scope` für `wiki` oder `checks[].olderThanDays` für `stalePages`, steht mit «nein» und ist für diese Art Pflicht.',
    '',
    'Namen von Eingaben, Blöcken und Feldern bestehen aus Kleinbuchstaben, Ziffern und `_` und beginnen mit einem Buchstaben. Der Name `period` gehört der Vorlage.',
    '',
    '## Eingaben',
    '',
    '- Eine Eingabe ruft ein Lese-Tool über dieselbe Pipeline wie der Server, mit Maskierung und Protokoll. Erlaubt sind nur Lese-Tools, auf die sich Routinen verlassen können und die unbeaufsichtigt laufen dürfen. Das prüft die Vorbereitung eines Laufs, bevor er etwas liest, ebenso die Parameter gegen das Tool, die Felder von `{ field }` und relative Tage bis 366 Tage.',
    '- Mit `forEach` läuft das Tool einmal je Eintrag einer früheren Eingabe, die selbst kein `forEach` hat. Die Zahl der Aufrufe ist so höchstens `maxItems` der früheren Eingabe, dazu die Folgeseiten, bis `maxItems` erreicht ist. Tools, die Namen anderer Personen nennen, zählen gegen das Lesebudget ([Richtlinie](policy.md)): Im Beispiel liest ein Lauf mit 40 Terminen die Einteilungen mit mindestens 40 Aufrufen, einem je 25 Plätze eines Termins.',
    '- Relative Tage wie `+0d` oder `+14d` zählen ab der geplanten Auslösung, nicht ab dem Beginn des Laufs. Ein verspäteter Lauf liest so denselben Zeitraum wie ein pünktlicher.',
    '',
    '## Arten von Feldern',
    '',
    'Jedes Feld ist begrenzt: Text mit `maxLength`, eine Zahl mit `min` und `max`, Datum und Verweis auf eine Person durch ihre feste Form. Einen Text ohne `maxLength` und eine Zahl ohne `min` oder `max` nimmt der Lader nicht an. Eine Antwort des Modells mit einem unbekannten Feld, einem Wert über einer Grenze oder einem Verweis auf eine Person, die nicht in den Daten stand, ist ungültig.',
    '',
    ...table(
      ['Art', 'Grenze', 'Inhalt'],
      fieldKinds.map(([kind, limit, meaning]) => [code(kind), limit, meaning]),
    ),
    '',
    '## Prüfungen des Kerns',
    '',
    'Eine Routine mit `checks` hat kein Modell und keine Eingaben. Jede Prüfung füllt einen Block mit ihrem Namen und festen Feldern, den die Vorlage wie einen Block des Modells wiederholt. Die Prüfungen selbst kommen mit einer späteren Version.',
    '',
    ...table(
      ['Prüfung', 'Was sie findet', 'Felder'],
      Object.entries(checkBlockFields).map(([name, fields]) => [
        code(name),
        checkMeanings[name] ?? '',
        Object.entries(fields)
          .map(([field, kind]) => `${code(field)} (${code(kind.type)})`)
          .join(', '),
      ]),
    ),
    '',
    '## Zeitplan',
    '',
    '- Fünf Felder mit einem Leerzeichen dazwischen: Minute (0 bis 59), Stunde (0 bis 23), Tag des Monats (1 bis 31), Monat (1 bis 12 oder `JAN` bis `DEC`) und Wochentag (0 für Sonntag bis 6 oder `SUN` bis `SAT`). Kein Feld für Sekunden oder Jahre ([ADR 0034](adr/0034-zeitplan-semantik.md)).',
    '- Ein Feld enthält `*`, einen Wert, einen Bereich wie `MON-FRI`, einen Schritt wie `*/2` oder `8-18/2` oder eine Liste davon mit Kommas. Einen Wert mit Schritt wie `5/15`, `L`, `W`, `#`, `?` und die 7 für Sonntag nimmt Ecclium nicht an, weil Nachbauten von cron sie verschieden lesen.',
    '- Die Minute ist ein einzelner Wert wie `0` oder `30`, eine Routine löst also höchstens einmal je Stunde aus. Jede Auslösung kann ein Modell aufrufen und belegt Platz im Gedächtnis der Läufe.',
    '- Tag des Monats und Wochentag dürfen nicht beide eingeschränkt sein: cron verbindet die beiden mit «oder», manche Nachbauten mit «und».',
    '- Der Zeitplan muss an einem Tag auslösen, den es gibt. `0 6 31 2 *`, der 31. Februar, weist der Lader ab, `0 6 29 2 *` löst in jedem Schaltjahr aus.',
    '- Der Zeitplan gilt in der Zeitzone aus `ECCLIUM_TIME_ZONE` ([Konfiguration](configuration.md)). Der Runner verlangt die Variable.',
    '- Eine Zeit, die es beim Wechsel zur Sommerzeit nicht gibt, läuft zur ersten Zeit danach, die es gibt. Eine Zeit, die es beim Wechsel zur Winterzeit zweimal gibt, läuft einmal, beim ersten Mal. Wählen Sie trotzdem eine Zeit ausserhalb der Stunde von 02:00 bis 03:00, in der in Mitteleuropa die Sommerzeit wechselt.',
    '- Fällig ist die letzte geplante Auslösung bis jetzt, höchstens 31 Tage zurück, solange kein Lauf sie abgeschlossen hat. Ältere verpasste Auslösungen holt der Runner nicht nach. Scheitert ein Lauf an einer vorübergehenden Störung, etwa weil das Modell oder ChurchTools nicht erreichbar ist, versucht der Runner dieselbe Auslösung höchstens dreimal, jeden Versuch mindestens 15 Minuten nach dem vorigen.',
    '',
    '## Vorlage',
    '',
    'Die Vorlage ist Markdown mit vier Marken und sonst nichts: keine Bedingungen, keine Ausdrücke, kein Code.',
    '',
    '- `{{#block}}` und `{{/block}}` wiederholen die Zeilen dazwischen für jeden Eintrag des Blocks, `{{feld}}` darin steht für ein Feld des Eintrags.',
    '- `{{^block}}` und `{{/block}}` zeigen die Zeilen dazwischen nur, wenn der Block leer ist.',
    '- `{{period}}` steht für die Periode des Laufs, etwa `2026-W46`, überall.',
    '- Eine Marke eines Blocks steht allein auf ihrer Zeile, die beim Rendern wegfällt. Blöcke stehen nicht ineinander. Jeder Block muss einmal wiederholt werden, damit nichts verloren geht, was der Lauf füllt. Jedes andere `{{` weist der Lader ab.',
    '- Das Ergebnis geht als Ganzes noch einmal durch die ContentPolicy, dann hängt der Kern die Kennzeichnung mit Routine, Periode und Prüfcode an.',
    '',
    '```markdown',
    ...exampleTemplate,
    '```',
    '',
    '## Ziele',
    '',
    '- `wiki` hängt mit `ct_wiki_page_append_section` einen eigenen Abschnitt je Periode an die Seite in `scope` an. Ein zweiter Lauf derselben Periode ändert diesen Abschnitt oder lässt ihn stehen, er verdoppelt ihn nie. Die Seite braucht einen Eintrag im Teil `unattended` der Richtlinie, sonst startet die Routine nicht. Ecclium sucht die Seite selbst, legt nie eine an und schreibt nicht, wenn es sie nicht gibt oder ihr Titel in der Kategorie zweimal vorkommt.',
    '- Ein Lauf mit Ziel `wiki` liest und schreibt mit dem Konto, das die Einträge seiner Routine als `credential` nennen: mit dem Token aus der Datei `ct_token_<credential>` im Ordner aus `ECCLIUM_RUNNER_TOKENS_DIR` ([Konfiguration](configuration.md)), bei jedem Lauf neu gelesen. Ist `ECCLIUM_RUNNER_TOKENS_DIR` nicht gesetzt, fehlt die Datei oder weist Ecclium sie ab, läuft die Routine nicht, auch nicht mit dem Token des Servers.',
    '- Eine leere Datei `writes-off-routine-<Kennung>` im Ordner `stop` des Zustandsordners hält das Schreiben der Läufe einer Routine und die Freigabe dessen, was sie in die Warteschlange legten, an, ohne Neustart. Was die Richtlinie nicht abdeckt, legt der Lauf in die Freigabe-Warteschlange ([Richtlinie](policy.md)).',
    '- `draft` gibt einen Entwurf oder Bericht an einen Kanal. Der Kanal `file` schreibt eine Datei je Routine und Periode, die ein zweiter Lauf derselben Periode ersetzt, und schreibt nichts in ChurchTools.',
    '- Die Periode kommt aus der geplanten Auslösung in der Zeitzone aus `ECCLIUM_TIME_ZONE`, nie aus der Zeit des Laufs: `{isoWeek}` wie `2026-W46`, `{date}` wie `2026-11-09`, `{month}` wie `2026-11`.',
    '- Eine Meldung nach dem Lauf nennt Routine, Periode und Ausgang, nie Inhalt.',
  ];
  return `${lines.join('\n')}\n`;
}
