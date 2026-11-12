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
    'interactive.contacts':
      'Die Kontaktangaben der Gemeinde, die ein Text stehen haben darf, den Ecclium schreibt: E-Mail-Adressen, Telefonnummern, IBAN und AHV-Nummern, je ein Wert. Jede andere solche Angabe lehnt die ContentPolicy ab. Ohne Eintrag steht keine. Eine E-Mail-Adresse gilt ohne Gross und Klein, eine Nummer nur mit ihren Ziffern, Buchstaben und einem führenden `+`, so dass `000 000 12 34` und `000-000-12-34` gleich sind, `+41 00 000 12 34` aber nicht. Einen Wert nur aus Ziffern setzen Sie in Anführungszeichen, sonst liest YAML ihn als Zahl.',
    'interactive.inquiriesTo':
      'Wen man bei Fragen erreicht, etwa `Sekretariat, sekretariat@example.org`. Der Text steht am Ende der Zeile, mit der jede Seite und jeder Abschnitt endet, die Ecclium im Wiki hinzufügt: «Automatisch erstellt am 05.11.2026 durch Ecclium, interaktiv, Prüfcode k1:ABCDEFGHIJKLM. Rückfragen an Sekretariat, sekretariat@example.org.». Er ist Klartext in einer Zeile ohne Steuerzeichen, Links und Adressen von Websites, ohne `<` vor einem Buchstaben, `/`, `!` oder `?`, ohne Zeichenreferenzen wie `&amp;` und ohne die Zeichen `[`, `]`, `` ` `` und `\\`, und eine E-Mail-Adresse oder Telefonnummer darin muss auch unter `interactive.contacts` stehen. Ohne ihn legt Ecclium keine Seite an und hängt keinen Abschnitt an, und mit `ECCLIUM_READ_ONLY=false` und dem Toolset `wiki` startet der Server nicht. Dieselbe Angabe beendet jeden Entwurf, den der Runner als Datei schreibt, und ohne sie schreibt er keinen. Nennen Sie eine Stelle statt einer Person, wenn Sie keinen Namen im Wiki wollen.',
    unattended:
      'Der Teil für Routinen, die ohne Person laufen. Ein Lauf schreibt nur auf die Ziele der Einträge seiner Routine, mit den Grenzen je Lauf und je Tag. Was kein Eintrag erlaubt, kommt in die Freigabe-Warteschlange.',
    'unattended[].routine': 'Kennung der Routine, etwa `dienstplan-report`.',
    'unattended[].credential':
      'Name des Kontos, mit dem der Runner für diese Routine liest und schreibt, damit er das engste passende Dienstkonto nimmt: das Token in der Datei `ct_token_<credential>` im Ordner aus `ECCLIUM_RUNNER_TOKENS_DIR` ([Konfiguration](configuration.md)). Ist `ECCLIUM_RUNNER_TOKENS_DIR` nicht gesetzt, fehlt die Datei oder weist Ecclium sie ab, läuft die Routine nicht, auch nicht mit dem Token des Servers. Alle Einträge einer Routine nennen denselben Namen.',
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
    'unattended[].acceptRightsDrift': `Befristete Ausnahme für Rechte, die das Konto der Routine hat, aber keine Routine dieses Kontos braucht. Ohne sie kommt jeder Schreibvorgang eines Laufs mit einem solchen Konto in die Freigabe-Warteschlange. Mit ihr schreibt der Lauf, und seine Zeile im Audit trägt \`rightsDriftAccepted\`. Für alle Einträge derselben Routine gleich, höchstens ${String(policyLimits.rightsDriftDays)} Tage. Ein umbenanntes Ziel deckt sie nicht.`,
    'unattended[].acceptRightsDrift.from':
      'Erster UTC-Tag der Ausnahme, etwa `2026-11-10`.',
    'unattended[].acceptRightsDrift.until':
      'Letzter UTC-Tag der Ausnahme, nicht vor dem ersten.',
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
  'Der Server liest die Richtlinie beim Start und nimmt das Lesebudget aus ihr. Ziele, Namen und Obergrenzen der Schreibvorgänge wendet der Write-Guard an, beim Planen und noch einmal unmittelbar vor dem Senden. Die Kontaktangaben nimmt die ContentPolicy, wenn sie einen Text prüft. Wo diese Seite sagt, ein Wunsch gehe an den Betreiber, legt der Server ihn in die Freigabe-Warteschlange, wo ihn der Betreiber mit `ecclium queue` sieht, freigibt oder abweist. Eine Freigabe mit `ecclium queue approve` ersetzt, wofür die Richtlinie den Wunsch zum Betreiber schickte, einen fehlenden Eintrag, einen anderen Namen oder die erreichte Obergrenze, und der Schreibvorgang zählt trotzdem gegen die Obergrenze seines Eintrags. Ergibt erst die Prüfung unmittelbar vor dem Senden, dass ein schon bestätigter Wunsch an den Betreiber ginge, schreibt der Server nicht und lehnt mit `policy_denied` ab. Den unbeaufsichtigten Teil wendet der Kern auf jeden Schreibvorgang eines Laufs einer Routine an. Läufe startet der Runner, von Hand mit `ecclium run-once` oder als Daemon mit `ecclium runner`.';

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
  '  contacts:',
  '    - sekretariat@example.org',
  '    - +41 00 000 12 34',
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
    '- **Zähler:** Die Zähler je Tag liegen im Zustandsordner, überstehen einen Neustart und gelten für alle Prozesse mit demselben Ordner. Beim Planen liest Ecclium den Zähler, und steht er schon bei `maxPerDay`, geht der Wunsch an den Betreiber, damit niemand einen Vorgang bestätigt, der nicht mehr geht. Gezählt wird beim Festschreiben unmittelbar vor dem Senden. Ein gezählter Vorgang, der danach scheitert, bleibt gezählt, ein abgelehnter Name zählt nicht. Ohne Zustandsordner startet ein Server, der schreiben darf, nicht ([ADR 0029](adr/0029-write-guard.md)).',
    '- **Läufe:** Ein Lauf einer Routine schreibt nur auf die Ziele der Einträge seiner Routine in `unattended`, mit den Tools dort, höchstens `maxPerRun` Mal je Lauf und `maxPerDay` Mal je UTC-Tag. Was kein Eintrag erlaubt, ein umbenanntes Ziel und eine erreichte Grenze gehen an den Betreiber, der Lauf endet nicht. Ein Lauf hängt je Periode einen Abschnitt an. Ein zweiter Lauf derselben Periode lässt ihn stehen, wenn der Text gleich ist, und ersetzt ihn an seiner Stelle, wenn nicht. Hat eine Person den Abschnitt geändert, geht der neue an den Betreiber.',
    `- **Rechte eines Kontos:** Hat das Konto eines Laufs Rechte, die kein Tool der Routinen dieses Kontos braucht, oder darf es Kategorien des Wikis bearbeiten, die kein Eintrag mit seinem \`credential\` nennt, geht jeder Schreibvorgang des Laufs an den Betreiber. Das kann nach einem Update von ChurchTools geschehen. Prüfen Sie dann die Rechte des Kontos. Bis Sie sie angepasst haben, lässt \`acceptRightsDrift\` die Läufe der Routine höchstens ${String(policyLimits.rightsDriftDays)} Tage lang trotzdem schreiben, mit einem Vermerk im Audit.`,
    '- **Widersprüche:** Dasselbe Ziel mit zwei Namen, dasselbe Tool zweimal für ein Ziel im selben Teil, `maxPerRun` über `maxPerDay`, zwei Stufen von `modelRedaction` für eine Routine, verschiedene Ausnahmen `acceptRightsDrift` an den Einträgen einer Routine oder eine Ausnahme, deren letzter Tag vor dem ersten liegt, verhindern den Start.',
    '',
    '## Vorschlag aus dem Audit',
    '',
    '`ecclium policy init --interactive` schlägt den interaktiven Teil aus den Audit-Dateien im Zustandsordner vor. Der Befehl ändert keine Datei.',
    '',
    '- **Ziele:** je Kategorie des Wikis, Kalender und Ressource, die das Audit in einer Zeile eines Schreib-Tools im interaktiven Modus nennt, ein Eintrag mit den Tools, die das Audit dort zeigt, auch bei abgelehnten Versuchen, denn gerade ein Ziel ohne Eintrag soll der Vorschlag zeigen. Ein Schreibvorgang auf eine Seite, den der Write-Guard geplant hat, nennt ihre Kategorie, einer auf einen Termin seinen Kalender und eine Buchung ihre Ressource. Die Kalender und Ressourcen stehen nach den Kategorien. Ein Eintrag, den das Audit nur aus abgelehnten oder übersprungenen Versuchen kennt, trägt darüber einen Kommentar: Entscheiden Sie, ob Ecclium dort schreiben soll.',
    `- **Grenze:** \`maxPerDay\` ist das Doppelte des höchsten Tageswerts eines Tools, mindestens 5 und höchstens ${swiss(policyLimits.maxPerDay)}. Abgelehnte und übersprungene Aufrufe zählen nicht, jeder andere schon, auch ein gescheiterter. \`readBudgetPerDay\` übernimmt der Vorschlag aus der Richtlinie, die gilt.`,
    '- **Namen:** Der Befehl fragt ChurchTools mit `ct_wiki_categories_list`, `ct_calendars_list` und `ct_resources_list` über dieselbe Pipeline wie der Server, jedes nur, wenn das Audit Ziele dieser Art nennt. Dafür muss das Toolset `wiki` eingeschaltet sein, für Kalender und Ressourcen das Toolset `calendars`. Seine Aufrufe laufen im Modus `operator`, stehen in einer eigenen Audit-Datei und verbrauchen kein Lesebudget. Nennt das Audit kein Ziel, fragt er ChurchTools nicht.',
    '- **Ausgabe:** YAML auf stdout. Ein Name steht in doppelten Anführungszeichen, jedes Zeichen ausser ASCII, Umlauten und «» ‹› als Escape von YAML, damit das Terminal nichts verändert und der Lader den Namen genau zurückliest. Ein Ziel, das ChurchTools dem Konto nicht nennt, dessen Name die Richtlinie nicht annimmt oder dessen Name verändert ankam, weil Ecclium unsichtbare Zeichen entfernt oder in der Stufe `strict` einen Teil maskiert hat, steht nur als Kommentar. Fällt so jedes Ziel heraus, steht statt einer leeren Liste ein Platzhalter darin, und Ecclium nimmt die Datei erst an, wenn Sie die Ziele von Hand eintragen, denn eine leere Liste erlaubte jeden bestätigten Schreibvorgang. Die Ziele stehen vor dem Lesebudget, damit eine abgeschnittene Ausgabe keine Datei ergibt, die Ecclium annimmt.',
    '- **Prüfen:** Leiten Sie die Ausgabe in eine Datei um, etwa mit `ecclium policy init --interactive > richtlinie.yaml`, prüfen Sie jeden Eintrag und setzen Sie die Datei dann mit `ECCLIUM_POLICY_FILE` ein.',
    '- **Exit-Codes:** 0, wenn der Vorschlag geschrieben ist, 64 für einen falschen Aufruf, 66 ohne Ordner `audit`, 69, wenn ChurchTools keine Namen gibt, 74, wenn Dateien nicht ganz lesbar waren oder der Vorschlag stdout nicht ganz erreichte, und 78 für eine ungültige Konfiguration, einen fehlenden Zustandsordner oder ein ausgeschaltetes Toolset `wiki` oder `calendars`, das der Vorschlag braucht.',
    '',
    '## Vorschlag für eine Routine',
    '',
    '`ecclium policy init --routine <Routine> --credential <Alias>` schlägt den Eintrag einer Routine im Teil `unattended` vor, für ihre Seite im Wiki. Der Befehl ändert keine Datei.',
    '',
    '- **Routine:** aus dem Ordner aus `ECCLIUM_ROUTINES_DIR`, wie der Runner sie lädt. Eine Routine, die einen Entwurf als Datei schreibt, braucht keinen Eintrag, und der Befehl sagt das in einem Kommentar.',
    '- **Konto:** Ecclium liest die Namen mit dem Konto des Alias aus `--credential`, der Token-Datei `ct_token_<Alias>` im Ordner aus `ECCLIUM_RUNNER_TOKENS_DIR`, nie mit dem Token des Servers. Das ist das Konto, mit dem die Routine später schreibt, und ein fehlendes Leserecht fällt so vor dem ersten Lauf auf.',
    '- **Namen:** Der Befehl fragt `ct_wiki_categories_list` nach der Kategorie und `ct_wiki_pages_list` nach der Seite aus `output.scope` der Routine, im Modus `operator` und mit einer eigenen Audit-Datei. Er liest jede Seite beider Listen, bis 1000 Einträge, und vergleicht die Namen in der Normalform NFC genau. Ein Name, den Ecclium verändert erhielt, weil es unsichtbare Zeichen entfernt oder in der Stufe `strict` einen Teil maskiert hat, zählt nie als Treffer.',
    `- **Eintrag:** das Ziel \`wiki_page\` mit Kategorie, GUID und dem Namen der Seite aus der Routine, das Konto als \`credential\`, das Tool der Ausgabe, \`maxPerRun: 1\`, weil ein Lauf höchstens einmal schreibt, und als \`maxPerDay\` die höchste Zahl der Auslösungen des Zeitplans an einem UTC-Tag, gerechnet in der Zone aus \`ECCLIUM_TIME_ZONE\`, und eins mehr für einen Lauf von Hand, höchstens ${swiss(policyLimits.maxPerDay)}. \`modelRedaction: standard\` und \`acceptRightsDrift\` schlägt Ecclium nie vor, sie entscheiden Sie.`,
    '- **Nur als Kommentar:** eine Kategorie, die ChurchTools dem Konto nicht nennt, eine Seite, die fehlt, denn ein Lauf legt keine an, zwei Seiten mit dem Namen, eine Liste mit mehr als 1000 Einträgen, Einträge der geltenden Richtlinie für dieselbe Routine, der Wunsch der Routine nach der Stufe `standard` für das Modell und feste Prüfungen des Kerns.',
    '- **Einfügen:** Die Ausgabe ist ein Punkt der Liste `unattended` und für sich keine Richtlinie. Fügen Sie ihn in die Datei aus `ECCLIUM_POLICY_FILE` ein, statt die Datei zu ersetzen: Ohne ihren Teil `interactive` erlaubte der Server jeden bestätigten Schreibvorgang, den sein Konto darf, und ohne `interactive.inquiriesTo` hängt ein Lauf keinen Abschnitt an. Hat die Routine schon Einträge, ersetzen Sie diese, denn alle Einträge einer Routine nennen dasselbe Konto.',
    '- **Exit-Codes:** 0, wenn der Vorschlag geschrieben ist, auch nur aus Kommentaren, 64 für einen falschen Aufruf und eine Routine, die der Ordner nicht hat, 66 ohne Ordner der Routinen, 69, wenn ChurchTools eine Liste nicht gibt, 74, wenn der Vorschlag stdout nicht ganz erreichte, und 78 für eine ungültige Konfiguration, Routinen, die sich nicht laden lassen, und ohne Zustandsordner, `ECCLIUM_TIME_ZONE`, Ordner der Token oder Token-Datei des Alias.',
    '',
    '## Hash',
    '',
    'Ecclium bildet den SHA-256 über die geprüfte Richtlinie in einer festen Form: Voreinstellungen eingesetzt, Namen in NFC, GUIDs in Kleinbuchstaben und die Schlüssel sortiert. Kommentare und die Schreibweise eines Werts ändern ihn nicht, die Reihenfolge der Einträge schon. Ohne Datei gilt der Hash der Voreinstellung. `ecclium config check` zeigt ihn, und die Zeile jedes Aufrufs eines schreibenden Tools im Audit nennt ihn als `policyHash`, auch die eines abgelehnten. So lässt sich später sagen, unter welcher Richtlinie ein Schreibvorgang lief.',
  ];
  return `${lines.join('\n')}\n`;
}
