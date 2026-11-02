/**
 * Renders `schemas/policy.v1.json`, the JSON Schema of the file of the
 * policy, and `docs/policy.md`, the page for operators, from the schema in
 * the core (ADR 0032). The page is German and takes the meaning of each
 * field and each kind of target from the tables below. Tests compare both
 * with their files and fail for a field without a meaning, so a changed
 * schema without new files turns CI red.
 *
 * @packageDocumentation
 */
import { policyJsonSchema, policyLimits } from '@ecclium/mcp-churchtools-core';

/**
 * The meaning of each field of the file, by its path, `[]` for an entry of
 * a list. A test fails while a field of the schema has no meaning here, or
 * a meaning names no field. The fields of a target stand in
 * {@link policyTargetFieldMeanings}.
 */
export const policyFieldMeanings: Readonly<Record<string, string>> =
  Object.freeze({
    schema:
      'Format der Datei, immer `policy.v1`. Ohne diese Angabe oder mit einer anderen startet Ecclium nicht.',
    interactive:
      'Der Teil für Schreibvorgänge, die eine Person über ihren KI-Assistenten bestätigt, und das Lesebudget.',
    'interactive.readBudgetPerDay': `Wie oft ein Akteur je UTC-Tag Tools mit besonders schützenswerten Daten und Tools, die Namen anderer Personen nennen, zusammen aufrufen darf. Ohne Angabe ${String(policyLimits.defaultReadBudgetPerDay)}, 0 sperrt diese Tools für alle.`,
    'interactive.targets':
      'Die Ziele, auf die bestätigte Schreibvorgänge gehen dürfen. Ohne Eintrag ist erlaubt, was das Dienstkonto darf, ausser bei Gruppen und Diensten. Mit einem Eintrag ist die Liste abschliessend.',
    'interactive.targets[].target': 'Das Ziel, siehe «Ziele».',
    'interactive.targets[].tools':
      'Die Schreib-Tools, die auf das Ziel schreiben dürfen, mit ihrem Namen wie `ct_wiki_page_create`.',
    'interactive.targets[].maxPerDay':
      'Wie oft je Prinzipal und UTC-Tag jedes dieser Tools auf das Ziel schreiben darf.',
    unattended:
      'Der Teil für Routinen, die ohne Person laufen. Ecclium prüft ihn beim Start, benutzt wird er erst mit dem Runner einer späteren Version.',
    'unattended[].routine': 'Kennung der Routine, etwa `dienstplan-report`.',
    'unattended[].credential':
      'Name der Zugangsdaten, mit denen der Runner für diese Routine schreibt, damit er das engste passende Dienstkonto nimmt.',
    'unattended[].modelRedaction':
      'Stufe der Maskierung für den Aufruf des Sprachmodells der Routine: `strict`, die Voreinstellung, oder `standard`. Für dieselbe Routine überall gleich.',
    'unattended[].target':
      'Das Ziel, siehe «Ziele». Gruppen und Dienste gibt es hier nicht.',
    'unattended[].tools':
      'Die Schreib-Tools, mit denen die Routine auf das Ziel schreiben darf.',
    'unattended[].maxPerRun':
      'Wie oft jedes dieser Tools je Lauf auf das Ziel schreiben darf, höchstens so oft wie je Tag.',
    'unattended[].maxPerDay':
      'Wie oft jedes dieser Tools je UTC-Tag auf das Ziel schreiben darf. Läufe von Hand zählen mit.',
  });

/** The meaning of each field of a target, by its path in the target. */
export const policyTargetFieldMeanings: Readonly<Record<string, string>> =
  Object.freeze({
    kind: 'Art des Ziels, siehe die Tabelle.',
    id: 'Kennung des Ziels in ChurchTools.',
    categoryId: 'Kennung der Kategorie, in der die Seite liegt.',
    guid: 'GUID der Seite, wie `ct_wiki_pages_list` sie zeigt.',
    name: 'Der Name, den Sie erwarten: Titel der Seite oder Name des Ziels in ChurchTools.',
    event: 'Das Event, zu dem der Dienst gehört.',
    'event.id': 'Kennung des Events.',
    'event.name': 'Der Name des Events, den Sie erwarten.',
    service: 'Der Dienst im Event.',
    'service.id': 'Kennung des Dienstes.',
    'service.name': 'Der Name des Dienstes, den Sie erwarten.',
  });

/** What each kind of target is, where it may stand and what it covers. */
export const policyTargetKinds: readonly {
  readonly kind: string;
  readonly label: string;
  readonly parts: string;
  readonly covers: string;
}[] = Object.freeze([
  {
    kind: 'wiki_category',
    label: 'Kategorie des Wikis',
    parts: 'beide',
    covers:
      'Neue Seiten in der Kategorie und Änderungen an jeder ihrer Seiten.',
  },
  {
    kind: 'wiki_page',
    label: 'Seite des Wikis',
    parts: 'beide',
    covers:
      'Nur diese Seite. Ein Eintrag für die Seite geht dem ihrer Kategorie vor.',
  },
  {
    kind: 'calendar',
    label: 'Kalender',
    parts: 'beide',
    covers: 'Neue Termine im Kalender und Änderungen an seinen Terminen.',
  },
  {
    kind: 'resource',
    label: 'Ressource',
    parts: 'beide',
    covers: 'Buchungen der Ressource.',
  },
  {
    kind: 'group',
    label: 'Gruppe',
    parts: 'nur `interactive`',
    covers: 'Mitglieder der Gruppe hinzufügen oder entfernen.',
  },
  {
    kind: 'service',
    label: 'Dienst eines Events',
    parts: 'nur `interactive`',
    covers: 'Anfragen für diesen Dienst in diesem Event.',
  },
]);

/** A schema of JSON Schema as `z.toJSONSchema` writes it. */
interface JsonSchemaNode {
  readonly type?: string;
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly items?: JsonSchemaNode;
  readonly oneOf?: readonly JsonSchemaNode[];
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly required?: readonly string[];
  readonly [keyword: string]: unknown;
}

const jsonSchema = (): JsonSchemaNode => policyJsonSchema();

/**
 * Renders the JSON Schema of the file of the policy.
 *
 * @returns The schema as JSON with two spaces and a line break at the end.
 * @example
 * ```ts
 * JSON.parse(renderPolicySchema()).title; // 'PolicyV1'
 * ```
 */
export function renderPolicySchema(): string {
  const { $schema, ...rest } = jsonSchema();
  return `${JSON.stringify(
    {
      $schema,
      title: 'PolicyV1',
      description:
        'The file of the policy of Ecclium, version 1, in YAML or JSON. Not expressed here: one target with two names, a tool twice for one target, maxPerRun above maxPerDay and one routine with two levels of modelRedaction, which the server refuses as well.',
      ...rest,
    },
    null,
    2,
  )}\n`;
}

const code = (text: string): string => `\`${text}\``;

// A number as the pages of Ecclium write it, with ' between thousands.
const swiss = (value: number | undefined): string =>
  String(value).replaceAll(/\B(?=(?:\d{3})+$)/gu, "'");

// The form of a value, from its schema.
const formOf = (node: JsonSchemaNode): string => {
  // Every constant of the schema of the policy is a text.
  if (typeof node.const === 'string') return code(node.const);
  if (node.enum !== undefined) {
    return node.enum.map((value) => code(String(value))).join(' oder ');
  }
  if (node.oneOf !== undefined) return 'Ziel';
  switch (node.type) {
    case 'integer':
      return `ganze Zahl von ${swiss(node.minimum)} bis ${swiss(node.maximum)}`;
    case 'array':
      return node.minItems === undefined
        ? `Liste mit höchstens ${swiss(node.maxItems)} Einträgen`
        : `Liste mit ${swiss(node.minItems)} bis ${swiss(node.maxItems)} Einträgen`;
    case 'object':
      return 'Objekt';
    default:
      return node.minLength === undefined
        ? `Text nach festem Muster, höchstens ${swiss(node.maxLength)} Zeichen`
        : `Text von ${swiss(node.minLength)} bis ${swiss(node.maxLength)} Zeichen ohne Steuerzeichen`;
  }
};

/** One field of the file or of a target, with its path. */
interface FieldRow {
  readonly path: string;
  readonly node: JsonSchemaNode;
  readonly required: boolean;
}

// Every field, the fields of an object after it and those of the entries
// of a list with []. A target is one field: its fields have a table of
// their own.
const fieldRows = (node: JsonSchemaNode, prefix = ''): FieldRow[] => {
  const rows: FieldRow[] = [];
  for (const [name, field] of Object.entries(node.properties ?? {})) {
    const path = `${prefix}${name}`;
    rows.push({
      path,
      node: field,
      required: (node.required ?? []).includes(name),
    });
    if (field.type === 'object') rows.push(...fieldRows(field, `${path}.`));
    if (field.type === 'array' && field.items?.type === 'object') {
      rows.push(...fieldRows(field.items, `${path}[].`));
    }
  }
  return rows;
};

// The fields of every kind of target, each path once, in the order the
// kinds first name it.
const targetRows = (): FieldRow[] => {
  const interactive =
    jsonSchema().properties?.['interactive']?.properties?.['targets']?.items
      ?.properties?.['target']?.oneOf ?? [];
  const rows = new Map<string, FieldRow>();
  for (const branch of interactive) {
    for (const row of fieldRows(branch)) {
      if (!rows.has(row.path)) rows.set(row.path, row);
    }
  }
  return [...rows.values()];
};

/**
 * The paths of every field of the file, in the order of the schema.
 *
 * @returns The paths, such as `interactive.targets[].maxPerDay`.
 * @example
 * ```ts
 * policyFieldPaths().includes('interactive.readBudgetPerDay'); // true
 * ```
 */
export function policyFieldPaths(): readonly string[] {
  return fieldRows(jsonSchema()).map((row) => row.path);
}

/**
 * The paths of every field of a target, of all kinds together.
 *
 * @returns The paths, such as `event.name`.
 * @example
 * ```ts
 * policyTargetFieldPaths().includes('guid'); // true
 * ```
 */
export function policyTargetFieldPaths(): readonly string[] {
  return targetRows().map((row) => row.path);
}

/**
 * What the server does with the policy in this version, for the page.
 * It changes with the versions that use more of it.
 */
export const policyState =
  'Der Server liest die Richtlinie beim Start und nimmt das Lesebudget aus ihr. Ziele, Namen und Obergrenzen der Schreibvorgänge wendet der Write-Guard an, beim Planen und noch einmal unmittelbar vor dem Senden. Wo diese Seite sagt, ein Wunsch gehe an den Betreiber, lehnt der Server ihn mit `policy_denied` ab, bis die Freigabe-Warteschlange kommt. Den unbeaufsichtigten Teil benutzt erst der Runner einer späteren Version, bis dahin schreibt Ecclium nur in einer Unterhaltung.';

const example = [
  '# Richtlinie der Gemeinde, geprüft beim Start von Ecclium.',
  'schema: policy.v1',
  'interactive:',
  '  readBudgetPerDay: 200',
  '  targets:',
  '    - target: { kind: wiki_category, id: 12, name: Berichte }',
  '      tools: [ct_wiki_page_create, ct_wiki_page_append_section]',
  '      maxPerDay: 10',
  '    - target:',
  '        kind: wiki_page',
  '        categoryId: 12',
  '        guid: 00000000-0000-4000-8000-000000000001',
  '        name: Dienstplan-Auswertung',
  '      tools: [ct_wiki_page_update]',
  '      maxPerDay: 4',
  '    - target:',
  '        kind: service',
  '        event: { id: 5, name: Gottesdienst }',
  '        service: { id: 7, name: Technik }',
  '      tools: [ct_services_request]',
  '      maxPerDay: 5',
  'unattended:',
  '  - routine: dienstplan-report',
  '    credential: bericht',
  '    modelRedaction: strict',
  '    target:',
  '      kind: wiki_page',
  '      categoryId: 12',
  '      guid: 00000000-0000-4000-8000-000000000001',
  '      name: Dienstplan-Auswertung',
  '    tools: [ct_wiki_page_append_section]',
  '    maxPerRun: 2',
  '    maxPerDay: 4',
];

const table = (
  head: readonly string[],
  rows: readonly (readonly string[])[],
): string[] => [
  `| ${head.join(' | ')} |`,
  `| ${head.map(() => '---').join(' | ')} |`,
  ...rows.map((row) => `| ${row.join(' | ')} |`),
];

/**
 * Renders `docs/policy.md`, the page of the policy for operators.
 *
 * @returns The page in Markdown with a line break at the end.
 * @example
 * ```ts
 * renderPolicyReference().startsWith('# Richtlinie'); // true
 * ```
 */
export function renderPolicyReference(): string {
  const lines = [
    '# Richtlinie',
    '',
    '<!-- Erzeugt aus dem Schema im Kern. Ändern Sie den Code und rufen Sie pnpm docs:generate auf, nicht diese Datei. -->',
    '',
    'Die Richtlinie legt fest, auf welche Ziele Schreibvorgänge von Ecclium gehen dürfen, wie oft je Tag, und wie viel ein Akteur je Tag lesen darf ([ADR 0032](adr/0032-richtlinie-und-pruefcode.md)). Eine Bestätigung allein genügt nicht: Ohne Grenze dürfte ein gestohlenes Token, ein kompromittierter Client oder ein Tool, das im Client auf «immer erlauben» steht, alles, was das Dienstkonto in ChurchTools darf.',
    '',
    `Stand: ${policyState}`,
    '',
    '## Datei',
    '',
    '- `ECCLIUM_POLICY_FILE` nennt den absoluten Pfad der Datei ([Konfiguration](configuration.md)). Die Datei ist kein Geheimnis und darf lesbar sein. Sie muss dem Benutzer gehören, unter dem Ecclium läuft, und Gruppe und andere Benutzer dürfen sie nicht ändern, etwa mit den Rechten 644. Ecclium folgt keinem Link.',
    `- Das Format ist YAML 1.2 oder JSON in UTF-8 ohne BOM, höchstens ${swiss(262_144)} Bytes. Kommentare mit \`#\` sind erlaubt. Anker und Verweise, Tags, Direktiven wie \`%YAML\`, ein zweites Dokument, doppelte Schlüssel und Schlüssel, die kein Text sind, nimmt Ecclium nicht an.`,
    '- Ecclium liest die Datei beim Start, auch wenn der Server nur liest, weil das Lesebudget daraus kommt. Eine Änderung wirkt nach einem Neustart. `ecclium config check` prüft die Datei vorher und zeigt den Hash, die Zahl der Einträge und das Lesebudget.',
    '- Ist etwas falsch, startet Ecclium nicht und endet mit dem Code 78. Die Meldung nennt den Pfad des Felds, etwa `interactive.targets[2].maxPerDay`, oder die Zeile, nie einen Wert.',
    '- Sind `LOG_TOKENS` oder `LOG_STREAM` gesetzt, liest Ecclium die Datei nicht und startet nicht, weil die Bibliothek für YAML sie sonst nach stdout schriebe.',
    '- Editoren prüfen und vervollständigen die Datei mit dem Schema [`schemas/policy.v1.json`](../schemas/policy.v1.json).',
    '',
    '## Ohne Datei',
    '',
    `Ohne \`ECCLIUM_POLICY_FILE\` gilt die Voreinstellung: keine Einträge und ein Lesebudget von ${String(policyLimits.defaultReadBudgetPerDay)} Aufrufen je Akteur und UTC-Tag. Bestätigte Schreibvorgänge dürfen dann auf jedes Ziel, das das Dienstkonto schreiben darf, ausser bei Gruppen und Diensten: Ohne Eintrag gehen sie wie jede Operation der schreibenden Escape Hatch an den Betreiber zur Freigabe. Das hält die Einrichtung einfach. Empfohlen sind Einträge für die Ziele, auf die Ecclium schreiben soll, und Schreibrechte des Dienstkontos nur für diese Ziele.`,
    '',
    '## Beispiel',
    '',
    'Die Kennungen und Namen sind Platzhalter.',
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
        formOf(row.node),
        row.required ? 'ja' : 'nein',
        policyFieldMeanings[row.path] ?? '',
      ]),
    ),
    '',
    `Jeder Teil hat höchstens ${swiss(policyLimits.entries)} Einträge, jeder Eintrag 1 bis ${swiss(policyLimits.tools)} Tools.`,
    '',
    '## Ziele',
    '',
    'Ein Ziel ist immer eine Kennung mit dem Namen, den Sie erwarten, nie der ganze Mandant.',
    '',
    ...table(
      ['Art', 'Was', 'Teil', 'Was ein Eintrag erlaubt'],
      policyTargetKinds.map((entry) => [
        code(entry.kind),
        entry.label,
        entry.parts,
        entry.covers,
      ]),
    ),
    '',
    ...table(
      ['Feld des Ziels', 'Form', 'Bedeutung'],
      targetRows().map((row) => [
        code(row.path),
        // Each kind fixes its own value; the first kind alone would mislead.
        row.path === 'kind'
          ? 'eine Art aus der Tabelle oben'
          : formOf(row.node),
        policyTargetFieldMeanings[row.path] ?? '',
      ]),
    ),
    '',
    '## Regeln',
    '',
    '- **Name:** Ecclium vergleicht den erwarteten Namen in der Normalform NFC genau mit dem Namen in ChurchTools. Weicht er ab, weil jemand das Ziel umbenannt oder eine Kennung neu vergeben hat, schreibt Ecclium nicht auf dieses Ziel, und der Wunsch geht an den Betreiber. Das Lesen trifft das nicht.',
    '- **Abschliessend:** Hat `interactive.targets` einen Eintrag, darf ein bestätigter Schreibvorgang nur noch auf die genannten Ziele mit den genannten Tools. Jeder andere Wunsch und jeder über `maxPerDay` geht an den Betreiber, statt abgelehnt zu werden, damit die Person handlungsfähig bleibt.',
    '- **Gruppen und Dienste:** Mitgliedschaften in Gruppen und Anfragen für Dienste betreffen Personen. Ohne Eintrag gehen sie an den Betreiber, und Routinen schreiben sie nie. Operationen der schreibenden Escape Hatch gehen immer an den Betreiber, weil die Richtlinie für sie keine Art von Ziel kennt.',
    '- **Zähler:** Die Zähler je Tag liegen im Zustandsordner, überstehen einen Neustart und gelten für alle Prozesse mit demselben Ordner. Beim Planen liest Ecclium den Zähler und lehnt ab, wenn er schon bei `maxPerDay` steht, damit niemand einen Vorgang bestätigt, der nicht mehr geht. Gezählt wird beim Festschreiben unmittelbar vor dem Senden. Ein gezählter Vorgang, der danach scheitert, bleibt gezählt, ein abgelehnter Name zählt nicht. Ohne Zustandsordner lässt sich nicht zählen, dann geht jeder Wunsch auf ein Ziel mit Eintrag an den Betreiber.',
    '- **Widersprüche:** Dasselbe Ziel mit zwei Namen, dasselbe Tool zweimal für ein Ziel im selben Teil, `maxPerRun` über `maxPerDay` oder zwei Stufen von `modelRedaction` für eine Routine verhindern den Start.',
    '',
    '## Hash',
    '',
    'Ecclium bildet den SHA-256 über die geprüfte Richtlinie in einer festen Form: Voreinstellungen eingesetzt, Namen in NFC, GUIDs in Kleinbuchstaben und die Schlüssel sortiert. Kommentare und die Schreibweise eines Werts ändern ihn nicht, die Reihenfolge der Einträge schon. Ohne Datei gilt der Hash der Voreinstellung. `ecclium config check` zeigt ihn, und die Zeile jedes Aufrufs eines schreibenden Tools im Audit nennt ihn als `policyHash`, auch die eines abgelehnten. So lässt sich später sagen, unter welcher Richtlinie ein Schreibvorgang lief.',
  ];
  return `${lines.join('\n')}\n`;
}
