/**
 * Renders `schemas/audit-event.v1.json`, the JSON Schema of a line of the
 * audit file, and `docs/audit-events.md`, the catalog of the audit events,
 * from the schema in the core (ADR 0028). The schema comes from
 * `z.toJSONSchema`, without a dependency of its own; the page is German
 * for operators and takes the meaning of each field from the table below.
 * Tests compare both with their files and fail for a field without a
 * meaning, so a changed event without new files turns CI red.
 *
 * @packageDocumentation
 */
import {
  auditEventV1Schema,
  fileOnlyFields,
  objectDomains,
} from '@ecclium/mcp-churchtools-core';
import { z } from 'zod';

/** The meaning of each type of event, for operators. */
export const auditTypeMeanings: Readonly<Record<string, string>> =
  Object.freeze({
    tool_call:
      'Ein Aufruf eines Tools, auch eines unbekannten, eines abgelehnten und eines gescheiterten. Jeder Aufruf ergibt genau eine Zeile, geschrieben auch dann, wenn eine Stufe der Pipeline scheitert.',
  });

/**
 * The meaning of each field, by its path in the line, for operators. A
 * test fails while a field of the schema has no meaning here, or a meaning
 * names no field.
 */
export const auditFieldMeanings: Readonly<Record<string, string>> =
  Object.freeze({
    v: 'Version des Formats, immer 1.',
    eventId:
      'Kennung des Ereignisses, gleich der `eventId` in den Logzeilen desselben Aufrufs.',
    ts: 'Zeit des Ereignisses in UTC, auf die Millisekunde.',
    type: 'Art des Ereignisses, siehe «Typen».',
    tenantId: 'Kennung des Mandanten.',
    actor: 'Wer gehandelt hat.',
    'actor.kind': 'Art des Akteurs: Dienst, Benutzer, Runner oder Betreiber.',
    'actor.id':
      'Neutrale Bezeichnung des Akteurs, über stdio `stdio:` mit dem Subjekt aus `ECCLIUM_STDIO_SUBJECT`, nie der Name einer Person.',
    mode: 'Wie der Aufruf lief: interaktiv, unbeaufsichtigt oder durch den Betreiber.',
    runId: 'Kennung des Laufs einer Routine.',
    routineId: 'Kennung der Routine eines Laufs.',
    tool: 'Name des Tools, `ct_unknown` für ein Tool, das es nicht gibt.',
    outcome:
      'Ausgang des Aufrufs: `ok`, `error` bei einem Fehler oder `denied` bei einer Ablehnung.',
    confirmation: 'Wie ein Schreibvorgang bestätigt wurde.',
    policyHash: 'SHA-256 der Richtlinie eines Laufs.',
    provider: 'Das Sprachmodell eines Laufs, wie die Konfiguration es nennt.',
    'provider.vendor': 'Anbieter des Modells.',
    'provider.model': 'Name des Modells beim Anbieter.',
    'provider.hostingCountry':
      'Land, in dem das Modell betrieben wird, mit zwei Buchstaben.',
    'provider.endpointHost':
      'Hostname des Endpunkts, nie eine Adresse mit Pfad oder Schlüssel.',
    'provider.transferBasis':
      'Rechtsgrundlage einer Übermittlung ausserhalb der Schweiz und des EWR.',
    pluginHashes: 'SHA-256 der geladenen Plugins.',
    dataProtectionRegime:
      'Datenschutzrecht des Mandanten, nur im gehosteten Betrieb.',
    objectRefs:
      'Kennungen der Objekte, nach denen der Aufruf fragt, und der Personen und Gruppen, die sein Ergebnis nennt, als `<Bereich>:<Kennung>`, jede einmal, zuerst die aus der Anfrage, höchstens 100. Nur die Audit-Datei nennt sie.',
    objectRefsOmitted:
      'Zahl der weiteren Kennungen, die der Aufruf über die 100 in `objectRefs` hinaus nannte.',
    errorCode: 'Fehlercode bei `error` und `denied`.',
    withheldAfterRead:
      'Der Server hat das Ergebnis gelesen, aber zurückgehalten, weil seine Zeile nicht so in die Datei kam, wie sie war. Die Zeile sagt dann `denied` mit `policy_denied`.',
    durationMs: 'Dauer des Aufrufs in Millisekunden.',
    seq: 'Stelle der Zeile in der Hash-Kette ihrer Datei. Nur der Schreiber der Datei setzt sie, mit der Kette.',
    prevHash:
      'SHA-256 der vorigen Zeile der Datei, bei der ersten Zeile des Namens der Datei. Nur der Schreiber der Datei setzt ihn, mit der Kette.',
  });

/** What each kind of object of `objectRefs` names, for operators. */
export const objectDomainLabels: Readonly<Record<string, string>> =
  Object.freeze({
    person: 'Person',
    group: 'Gruppe',
    event: 'Event',
    appointment: 'Termin',
    calendar: 'Kalender',
    resource: 'Ressource',
    booking: 'Buchung',
    service: 'Dienst',
    song: 'Song',
    wiki_category: 'Kategorie des Wikis',
    wiki_page: 'Seite des Wikis',
  });

/** A schema of JSON Schema as `z.toJSONSchema` writes it. */
interface JsonSchemaNode {
  readonly type?: string;
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly maxLength?: number;
  readonly maxItems?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly items?: JsonSchemaNode;
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly required?: readonly string[];
  readonly [keyword: string]: unknown;
}

const jsonSchema = (): JsonSchemaNode =>
  z.toJSONSchema(auditEventV1Schema, {
    target: 'draft-2020-12',
    io: 'output',
  }) as JsonSchemaNode;

/**
 * Renders the JSON Schema of a line of the audit file.
 *
 * @returns The schema as JSON with two spaces and a line break at the end.
 * @example
 * ```ts
 * JSON.parse(renderAuditEventSchema()).title; // 'AuditEventV1'
 * ```
 */
export function renderAuditEventSchema(): string {
  const { $schema, ...rest } = jsonSchema();
  return `${JSON.stringify(
    {
      $schema,
      title: 'AuditEventV1',
      description: `One line of the audit file of Ecclium, version 1. The copy on stderr is the same line with an empty objectRefs and without ${fileOnlyFields.join(', ')}. Not expressed here: an outcome of ok has no errorCode and error and denied have one, objectRefsOmitted comes only with 100 objectRefs, and withheldAfterRead only with denied and policy_denied.`,
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
  if (node.const !== undefined) {
    return code(
      typeof node.const === 'string' ? node.const : JSON.stringify(node.const),
    );
  }
  if (node.enum !== undefined) {
    return node.enum.map((value) => code(String(value))).join(', ');
  }
  switch (node.type) {
    case 'integer':
      return `ganze Zahl von ${swiss(node.minimum)} bis ${swiss(node.maximum)}`;
    case 'array':
      return `Liste mit höchstens ${swiss(node.maxItems)} Einträgen, je ${formOf(node.items ?? {})}`;
    case 'object':
      return 'Objekt';
    default:
      return node['pattern'] === undefined
        ? `Text, höchstens ${swiss(node.maxLength)} Zeichen`
        : `Text nach festem Muster, höchstens ${swiss(node.maxLength)} Zeichen`;
  }
};

/** One field of the line, with its path. */
interface FieldRow {
  readonly path: string;
  readonly node: JsonSchemaNode;
  readonly required: boolean;
}

// Every field of the line, the fields of an object after it.
const fieldRows = (
  node: JsonSchemaNode,
  prefix = '',
  required = true,
): FieldRow[] => {
  const rows: FieldRow[] = [];
  for (const [name, field] of Object.entries(node.properties ?? {})) {
    const path = `${prefix}${name}`;
    const fieldRequired = required && (node.required ?? []).includes(name);
    rows.push({ path, node: field, required: fieldRequired });
    if (field.type === 'object') {
      rows.push(...fieldRows(field, `${path}.`, fieldRequired));
    }
  }
  return rows;
};

/**
 * The paths of every field of a line, in the order of the schema.
 *
 * @returns The paths, such as `actor.kind`.
 * @example
 * ```ts
 * auditFieldPaths().includes('objectRefs'); // true
 * ```
 */
export function auditFieldPaths(): readonly string[] {
  return fieldRows(jsonSchema()).map((row) => row.path);
}

// What the copy on stderr holds of a field.
const onStderr = (path: string): string => {
  if (path === 'objectRefs') return 'leer';
  return fileOnlyFields.includes(path) ? 'nein' : 'ja';
};

const meaningOf = (table: Readonly<Record<string, string>>, key: string) => {
  const meaning = Object.hasOwn(table, key) ? table[key] : undefined;
  if (meaning === undefined) {
    throw new Error(`The catalog has no meaning for ${key}.`);
  }
  return meaning;
};

/**
 * Renders the catalog of the audit events.
 *
 * @returns The page in Markdown.
 * @throws {Error} When a type, a field or a kind of object has no meaning.
 * @example
 * ```ts
 * renderAuditEventsReference().startsWith('# Audit-Ereignisse'); // true
 * ```
 */
export function renderAuditEventsReference(): string {
  const schema = jsonSchema();
  const types = schema.properties?.['type'];
  const typeNames = [types?.const].filter(
    (value): value is string => typeof value === 'string',
  );
  const lines = [
    '# Audit-Ereignisse',
    '',
    '<!-- Erzeugt mit `pnpm docs:generate` aus dem Schema der Ereignisse. Nicht von Hand ändern. -->',
    '',
    'Diese Seite entsteht mit `pnpm docs:generate` aus dem Schema der Audit-Ereignisse im Kern ([ADR 0028](adr/0028-audit-ereignis-und-datei-sink.md)), ebenso das JSON Schema einer Zeile in [`schemas/audit-event.v1.json`](../schemas/audit-event.v1.json). Ein Test vergleicht beide mit dem Code. Ändern Sie sie deshalb nicht von Hand.',
    '',
    'Jede Zeile ist ein JSON-Objekt auf einer Zeile. Mit `ECCLIUM_STATE_DIR` geht sie zuerst in die Audit-Datei und danach als Kopie nach stderr, ohne den Ordner nur nach stderr. Massgeblich ist die Zeile in der Datei. Die Kopie hat ein leeres `objectRefs` und keines der Felder, die nur in die Datei gehören, denn viele Clients schreiben stderr in eine Logdatei, die Ecclium weder schützt noch löscht. Wie lange die Dateien bleiben und wer sie lesen kann, steht in [Datenschutz](privacy.md).',
    '',
    '## Typen',
    '',
    '| Typ | Bedeutung |',
    '| --- | --- |',
    ...typeNames.map(
      (name) => `| ${code(name)} | ${meaningOf(auditTypeMeanings, name)} |`,
    ),
    '',
    '## Felder',
    '',
    '| Feld | Form | Pflicht | Auf stderr | Bedeutung |',
    '| --- | --- | --- | --- | --- |',
    ...fieldRows(schema).map(
      (row) =>
        `| ${code(row.path)} | ${formOf(row.node)} | ${row.required ? 'ja' : 'nein'} | ${onStderr(row.path)} | ${meaningOf(auditFieldMeanings, row.path)} |`,
    ),
    '',
    '## Bereiche der Kennungen',
    '',
    'Ein Eintrag von `objectRefs` hat die Form `<Bereich>:<Kennung>`, die Kennung aus höchstens 16 Ziffern oder eine GUID in Kleinbuchstaben, nie ein Name. Die Liste der Bereiche ist geschlossen, damit der Teil vor dem Doppelpunkt keinen Namen tragen kann. Die Kennungen leitet der Kern aus den Schemas der Tools ab, bei `ct_api_execute_read` aus den geprüften Werten in Pfad und Query, nie aus dem Code eines Tools.',
    '',
    '| Bereich | Objekt |',
    '| --- | --- |',
    ...objectDomains.map(
      (domain) =>
        `| ${code(domain)} | ${meaningOf(objectDomainLabels, domain)} |`,
    ),
    '',
  ];
  return lines.join('\n');
}
