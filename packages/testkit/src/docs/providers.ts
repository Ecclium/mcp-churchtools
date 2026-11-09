/**
 * Renders `schemas/providers.v1.json`, the JSON Schema of the file of the
 * providers of language models, and `docs/providers.md`, the page for
 * operators, from the schema in core (ADR 0033). The page is German and
 * takes the meaning of each field from the table below. Tests compare both
 * with their files and fail for a field without a meaning.
 *
 * @packageDocumentation
 */
import {
  maxProvidersFileBytes,
  providersJsonSchema,
  providersLimits,
  swissAndEeaCountries,
  transferBases,
} from '@ecclium/mcp-churchtools-core';

/** A schema of JSON Schema as `z.toJSONSchema` writes it. */
interface JsonSchemaNode {
  readonly type?: string;
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly pattern?: string;
  readonly items?: JsonSchemaNode;
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly required?: readonly string[];
  readonly [keyword: string]: unknown;
}

const jsonSchema = (): JsonSchemaNode => providersJsonSchema();

/** The meaning of each field of the file, by its path. */
export const providersFieldMeanings: Readonly<Record<string, string>> =
  Object.freeze({
    schema:
      'Format der Datei, immer `providers.v1`. Ohne diese Angabe oder mit einer anderen startet Ecclium nicht.',
    providers: 'Die Anbieter, je einer für jeden Alias.',
    'providers[].alias':
      'Der Name, mit dem eine Routine das Modell in `generate.model` wählt, etwa `default`. Kleinbuchstaben, Ziffern und Bindestriche wie die Kennung einer Routine. Jeder Alias nur einmal.',
    'providers[].vendor':
      'Der Anbieter in Kleinbuchstaben, Ziffern und Bindestrichen, etwa `example`. Er steht in jedem Ereignis eines Laufs im Audit.',
    'providers[].model':
      'Das Modell, wie der Anbieter es nennt, mit Buchstaben, Ziffern, `.`, `_`, `:` und `-` und höchstens einem `/` zwischen Hersteller und Modell, etwa `example-maker/example-model-1`. Ecclium schickt es dem Anbieter im Feld `model`.',
    'providers[].hostingCountry':
      'Das Land des Rechenzentrums als Code nach ISO 3166-1 aus zwei Grossbuchstaben, etwa `CH` oder `DE`. Es entscheidet, ob es eine Grundlage der Übermittlung braucht, siehe unten.',
    'providers[].endpoint':
      'Die Adresse der Chat-Schnittstelle mit `https` und Pfad, etwa `https://model.example.org/v1/chat/completions`, in ihrer eindeutigen Form: Host in Kleinbuchstaben, keine IP-Adresse und kein `localhost`, kein Standardport, keine Query, kein Fragment und keine Zeichen mit `%`. Ecclium sendet nur an genau diese Adresse.',
    'providers[].structuredOutput':
      'Ob der Anbieter die Antwort nach einem JSON Schema strukturiert (`response_format` vom Typ `json_schema`). Mit `false` bittet Ecclium im Text um JSON und versucht es nach einer ungültigen Antwort genau einmal mehr.',
    'providers[].apiKeyFile':
      'Absoluter Pfad der Datei mit dem Schlüssel. Ecclium prüft sie wie die Token-Datei von ChurchTools: kein Link, eine gewöhnliche Datei Ihres Benutzers, keine Rechte für Gruppe und andere, etwa mit den Rechten 600, nur sichtbare ASCII-Zeichen. Der Schlüssel selbst steht nie in dieser Datei.',
    'providers[].transferBasis':
      'Die Grundlage der Übermittlung, Pflicht ausserhalb der Schweiz und des EWR und dort verboten, siehe unten.',
  });

/** One field of the file, with its path. */
interface FieldRow {
  readonly path: string;
  readonly node: JsonSchemaNode;
  readonly required: boolean;
}

// Every field, those of the entries of a list after it with [].
const fieldRows = (node: JsonSchemaNode, prefix = ''): FieldRow[] => {
  const rows: FieldRow[] = [];
  for (const [name, field] of Object.entries(node.properties ?? {})) {
    const path = `${prefix}${name}`;
    rows.push({
      path,
      node: field,
      required: (node.required ?? []).includes(name),
    });
    if (field.type === 'array' && field.items?.type === 'object') {
      rows.push(...fieldRows(field.items, `${path}[].`));
    }
  }
  return rows;
};

/**
 * The paths of every field of the schema, for the test that each one has a
 * meaning.
 *
 * @returns The paths, such as `providers[].endpoint`.
 * @example
 * ```ts
 * providersFieldPaths().includes('schema'); // true
 * ```
 */
export function providersFieldPaths(): readonly string[] {
  return fieldRows(jsonSchema()).map((row) => row.path);
}

/**
 * Renders the JSON Schema of the file of the providers.
 *
 * @returns The schema as JSON with two spaces and a line break at the end.
 * @example
 * ```ts
 * JSON.parse(renderProvidersSchema()).title; // 'ProvidersV1'
 * ```
 */
export function renderProvidersSchema(): string {
  const { $schema, ...rest } = jsonSchema();
  return `${JSON.stringify(
    {
      $schema,
      title: 'ProvidersV1',
      description:
        'The file of the providers of language models of Ecclium, version 1, in YAML or JSON. Not expressed here: an alias twice, a basis of transfer missing outside Switzerland and the EEA or given inside, and the canonical form of the endpoint, which the server refuses as well.',
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
  if (typeof node.const === 'string') return code(node.const);
  if (node.enum !== undefined) {
    return node.enum.map((value) => code(String(value))).join(' oder ');
  }
  switch (node.type) {
    case 'boolean':
      return '`true` oder `false`';
    case 'array':
      return `Liste mit ${swiss(node.minItems)} bis ${swiss(node.maxItems)} Einträgen`;
    default:
      return node.minLength === undefined
        ? `Text nach festem Muster, höchstens ${swiss(node.maxLength)} Zeichen`
        : `Text von ${swiss(node.minLength)} bis ${swiss(node.maxLength)} Zeichen`;
  }
};

const table = (
  head: readonly string[],
  rows: readonly (readonly string[])[],
): string[] => [
  `| ${head.join(' | ')} |`,
  `| ${head.map(() => '---').join(' | ')} |`,
  ...rows.map((row) => `| ${row.join(' | ')} |`),
];

const example = [
  '# Anbieter von Sprachmodellen, geprüft beim Start von Ecclium.',
  'schema: providers.v1',
  'providers:',
  '  - alias: default',
  '    vendor: example',
  '    model: example-maker/example-model-1',
  '    hostingCountry: CH',
  '    endpoint: https://model.example.org/v1/chat/completions',
  '    structuredOutput: true',
  '    apiKeyFile: /run/secrets/model_api_key',
  '  - alias: extern',
  '    vendor: example',
  '    model: example-model-2',
  '    hostingCountry: US',
  '    endpoint: https://model.example.com/v1/chat/completions',
  '    structuredOutput: false',
  '    apiKeyFile: /run/secrets/model_api_key_extern',
  '    transferBasis: standard_contractual_clauses',
];

/** What each basis of a transfer means, for the page. */
const basisMeanings: Readonly<Record<(typeof transferBases)[number], string>> =
  Object.freeze({
    adequacy_decision:
      'Ein Beschluss, dass das Land ein angemessenes Schutzniveau hat, nach DSG durch den Bundesrat, nach DSGVO durch die Europäische Kommission.',
    standard_contractual_clauses:
      'Standardvertragsklauseln, die Sie mit dem Anbieter vereinbart haben.',
    binding_corporate_rules:
      'Verbindliche Unternehmensregeln des Anbieters, die eine Behörde genehmigt hat.',
  });

/**
 * Renders `docs/providers.md`, the page of the providers for operators.
 *
 * @returns The page in Markdown with a line break at the end.
 * @example
 * ```ts
 * renderProvidersReference().startsWith('# Anbieter'); // true
 * ```
 */
export function renderProvidersReference(): string {
  const lines = [
    '# Anbieter von Sprachmodellen',
    '',
    '<!-- Erzeugt aus dem Schema im Kern. Ändern Sie den Code und rufen Sie pnpm docs:generate auf, nicht diese Datei. -->',
    '',
    'Eine Routine mit einem Erzeugungsschritt braucht ein Sprachmodell. Sie nennt es nur über einen Alias wie `default`, nie über einen Anbieter. Welcher Anbieter, welches Modell und welches Land dahinter stehen, sagt die Datei der Anbieter, damit Sie nie raten müssen, wohin Daten der Gemeinde gehen ([ADR 0033](adr/0033-runner-modell-ohne-werkzeuge.md)). Das Modell bekommt Daten und ein Ausgabeschema, nie ein Werkzeug.',
    '',
    'Stand: Der Start liest und prüft die Datei, `ecclium config check` zeigt die Anbieter. Benutzt wird sie erst vom Runner einer späteren Version.',
    '',
    '## Datei',
    '',
    '- `ECCLIUM_PROVIDERS_FILE` nennt den absoluten Pfad der Datei ([Konfiguration](configuration.md)). Die Datei ist kein Geheimnis und darf lesbar sein. Sie muss dem Benutzer gehören, unter dem Ecclium läuft, und Gruppe und andere Benutzer dürfen sie nicht ändern, etwa mit den Rechten 644. Ecclium folgt keinem Link.',
    `- Das Format ist YAML 1.2 oder JSON in UTF-8 ohne BOM, höchstens ${swiss(maxProvidersFileBytes)} Bytes, mit höchstens ${swiss(providersLimits.providers)} Anbietern. Anker und Verweise, Tags, Direktiven, ein zweites Dokument und doppelte Schlüssel nimmt Ecclium nicht an.`,
    '- Ist etwas falsch, startet Ecclium nicht und endet mit dem Code 78. Die Meldung nennt den Pfad des Felds, etwa `providers[1].transferBasis`, oder die Zeile, nie einen Wert.',
    '- Ein Feld, das wie ein Schlüssel heisst, etwa `apiKey`, `token` oder `secret`, verhindert den Start mit einer eigenen Meldung: Der Schlüssel gehört in seine eigene Datei.',
    '- Sind `LOG_TOKENS` oder `LOG_STREAM` gesetzt, liest Ecclium die Datei nicht und startet nicht, weil die Bibliothek für YAML sie sonst nach stdout schriebe.',
    '- `ecclium config check` zeigt je Alias Anbieter, Modell, Land und Grundlage, mit `--show-values` auch den Host des Endpunkts, nie den Pfad eines Schlüssels.',
    '- Editoren prüfen und vervollständigen die Datei mit dem Schema [`schemas/providers.v1.json`](../schemas/providers.v1.json).',
    '',
    '## Beispiel',
    '',
    'Anbieter, Modelle, Adressen und Pfade sind Platzhalter.',
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
        providersFieldMeanings[row.path] ?? '',
      ]),
    ),
    '',
    '## Land und Grundlage der Übermittlung',
    '',
    `In der Schweiz und im EWR braucht ein Anbieter keine Grundlage, und \`transferBasis\` darf nicht stehen, damit Land und Grundlage nie Verschiedenes sagen. Als Schweiz und EWR gelten genau diese ${String(swissAndEeaCountries.length)} Codes: ${swissAndEeaCountries.map(code).join(', ')}. Jeder andere Code gilt als ausserhalb, auch \`EU\` und ein Gebiet mit eigenem Code wie die Färöer (\`FO\`).`,
    '',
    'Ausserhalb verlangt Ecclium eine dieser Grundlagen, sonst startet es nicht:',
    '',
    ...table(
      ['Grundlage', 'Bedeutung'],
      transferBases.map((basis) => [code(basis), basisMeanings[basis]]),
    ),
    '',
    'Ob die Grundlage trägt, prüft Ecclium nicht, das verantworten Sie. Massgebend ist das Land, in dem die Daten verarbeitet werden. Hat ein Anbieter seinen Sitz in einem anderen Land als sein Rechenzentrum, kann die Weitergabe trotzdem ein Land ausserhalb betreffen, das beurteilen Sie. Diese Seite ist keine Rechtsberatung.',
    '',
    '## Weg zum Anbieter',
    '',
    '- Für jeden Anbieter baut Ecclium einen eigenen ausgehenden Weg mit genau der Adresse aus `endpoint`. Er sendet nur `POST` mit JSON an diesen Pfad, mit dem Schlüssel im Header `Authorization` nach dem Schema `Bearer`, und folgt keiner Weiterleitung.',
    '- Ein Aufruf endet nach höchstens fünf Minuten, weil ein Modell ohne Streaming erst antwortet, wenn es fertig ist. Eine Anfrage hat höchstens 2 MiB, eine Antwort höchstens 1 MiB.',
    '- Ecclium spricht nur `https`, auch mit einem Modell im eigenen Netz.',
    '- Die Daten einer Routine sind maskiert, bevor ein Anbieter sie sieht, voreingestellt in der Stufe `strict`. Ohne die Marke der Maskierung bricht der Aufruf ab, bevor der Anbieter etwas bekommt, auch bei einem Anbieter aus einem Plugin.',
    '',
    '## Chat-Schnittstelle',
    '',
    'Ecclium bringt einen Adapter für die Chat-Schnittstelle, die viele Anbieter nach dem Vorbild von OpenAI anbieten. Er sendet `model`, eine Nachricht der Rolle `system` und eine der Rolle `user` und `max_tokens`.',
    '',
    '- Mit `structuredOutput: true` sendet er das Ausgabeschema als `response_format` vom Typ `json_schema`. Passt die Antwort nicht dazu, endet der Aufruf ohne zweiten Versuch.',
    '- Mit `structuredOutput: false` bittet er im Systemtext um genau ein JSON-Objekt nach dem Schema. Ist die Antwort kein JSON, passt nicht zum Schema oder ist abgeschnitten, versucht er es genau einmal mehr, mit einem festen Satz zum Grund und nie mit dem Text der ersten Antwort.',
    '- Eine Weigerung des Modells oder ein anderer Grund, warum es aufhörte, beendet den Aufruf. Kein Text des Anbieters erscheint in einer Meldung oder im Log.',
    '- Ob ein Anbieter `json_schema` und `max_tokens` so annimmt, zeigt erst ein Lauf mit ihm. Lehnt er die Anfrage mit 400, 404 oder 422 ab, meldet Ecclium einen Fehler der Konfiguration.',
  ];
  return `${lines.join('\n')}\n`;
}
