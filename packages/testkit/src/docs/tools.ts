/**
 * Renders `docs/tools.md`, the reference of the tools of the core, from the
 * catalog the registry builds. The page is German for operators, the
 * descriptions stay English and unchanged, because they are the text the
 * model reads (ADR 0024). A test compares the page with the file, so a
 * changed tool without a new page turns CI red.
 *
 * @packageDocumentation
 */
import {
  type CatalogEntry,
  createToolCatalog,
  type ShapeNode,
  toolsetNames,
  toolsetOf,
} from '@ecclium/mcp-churchtools-core';
import type { DataClass } from '@ecclium/mcp-churchtools-plugin-api';
import { createCorePlugin } from '@ecclium/mcp-churchtools-tools';

/** One leaf of an output, with the path an operator reads. */
interface LeafRow {
  readonly path: string;
  readonly types: readonly string[];
  readonly dataClass: DataClass | undefined;
  readonly optional: boolean;
  readonly nullable: boolean;
}

const sensitivityLabels = Object.freeze({
  none: 'keine',
  personal: 'personenbezogen',
  special: 'besonders schützenswert',
});

const unattendedLabels = Object.freeze({
  never: 'nie',
  policy: 'nach Richtlinie',
});

// A fence longer than any run of backticks in the text, so that no
// description can end its block early.
const fenceFor = (text: string): string => {
  let longest = 0;
  for (const run of text.match(/`+/gu) ?? []) {
    longest = Math.max(longest, run.length);
  }
  return '`'.repeat(Math.max(3, longest + 1));
};

const yesNo = (value: boolean): string => (value ? 'ja' : 'nein');

const code = (text: string): string => `\`${text}\``;

const containerTypes = Object.freeze({
  object: 'Objekt',
  array: 'Liste',
  tuple: 'Tupel',
});

// The leaves of an output in the order of the schema: fields of an object
// by their keys, elements of an array with [], items of a tuple by index.
// A container below the root that may be missing or null gets a row of its
// own, because its leaves then are missing too, which their rows do not
// show.
const leavesOf = (node: ShapeNode, path: string, rows: LeafRow[]): void => {
  if (node.kind !== 'leaf' && path !== '' && (node.optional || node.nullable)) {
    rows.push({
      path,
      types: [containerTypes[node.kind]],
      dataClass: undefined,
      optional: node.optional,
      nullable: node.nullable,
    });
  }
  if (node.kind === 'object') {
    for (const [key, child] of Object.entries(node.fields)) {
      leavesOf(child, path === '' ? key : `${path}.${key}`, rows);
    }
    return;
  }
  if (node.kind === 'array') {
    leavesOf(node.element, `${path}[]`, rows);
    return;
  }
  if (node.kind === 'tuple') {
    node.items.forEach((item, index) => {
      leavesOf(item, `${path}[${String(index)}]`, rows);
    });
    return;
  }
  rows.push({
    path,
    types: node.types,
    dataClass: node.dataClass,
    optional: node.optional,
    nullable: node.nullable || node.types.includes('null'),
  });
};

const leaves = (entry: CatalogEntry): readonly LeafRow[] => {
  const rows: LeafRow[] = [];
  leavesOf(entry.shape.root, '', rows);
  return rows;
};

const rightsOf = (entry: CatalogEntry): string =>
  entry.meta.requiredRights.length === 0
    ? 'keine'
    : entry.meta.requiredRights
        .map(({ module, right }) => `${code(right)} in ${code(module)}`)
        .join(', ');

// The settings without which the server does not offer a tool: its
// toolset (ADR 0062), the folder of the audit file for special data over
// stdio (ADR 0028), and, for a tool that writes, ECCLIUM_READ_ONLY=false.
const offeredLabel = (entry: CatalogEntry): string => {
  const { domain, sensitivity, capability } = entry.meta;
  const toolset = toolsetOf(domain);
  // The catalog of the page offers no tool of an area without a toolset.
  if (toolset === undefined) throw new TypeError(`no toolset for ${domain}`);
  const needs = [
    ...(toolset === 'base'
      ? []
      : [`${code(toolset)} in ${code('ECCLIUM_TOOLSETS')}`]),
    ...(sensitivity === 'special' ? [code('ECCLIUM_STATE_DIR')] : []),
    ...(capability === 'write' ? [code('ECCLIUM_READ_ONLY=false')] : []),
  ];
  return needs.length === 0 ? 'immer' : needs.join(', mit ');
};

const toolSection = (entry: CatalogEntry): string[] => {
  const { meta } = entry;
  const lines = [
    `## ${code(entry.name)}`,
    '',
    `- Bereich: ${code(meta.domain)}`,
    `- Sensibilität: ${sensitivityLabels[meta.sensitivity]}`,
    `- Unbeaufsichtigt: ${unattendedLabels[meta.unattended]}`,
    `- Für Routinen stabil: ${yesNo(meta.routineStable)}`,
    `- Angeboten: ${offeredLabel(entry)}`,
    `- Rechte in ChurchTools: ${rightsOf(entry)}`,
    '',
    '### Beschreibung',
    '',
    `${fenceFor(entry.description)}text`,
    entry.description,
    fenceFor(entry.description),
    '',
    '### Ausgabe',
    '',
    '| Feld | Typ | Datenklasse | Kann fehlen | Kann null sein |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const row of leaves(entry)) {
    const dataClass = row.dataClass === undefined ? '' : code(row.dataClass);
    lines.push(
      `| ${code(row.path)} | ${row.types.join(' oder ')} | ${dataClass} | ${yesNo(row.optional)} | ${yesNo(row.nullable)} |`,
    );
  }
  return lines;
};

/**
 * Renders the reference of the tools of the core, with every tool the core
 * can offer, also those that write, sorted by name, and notes the toolset
 * and the other settings each one needs.
 *
 * @returns The Markdown of `docs/tools.md`, ending with a line break.
 * @example
 * ```ts
 * renderToolsReference().startsWith('# Tools\n'); // true
 * ```
 */
export function renderToolsReference(): string {
  const entries = createToolCatalog({
    core: createCorePlugin(),
    plugins: [],
    readOnly: false,
    toolsets: new Set(toolsetNames),
  }).list();
  const lines = [
    '# Tools',
    '',
    '<!-- Erzeugt mit `pnpm docs:generate` aus dem Katalog des Kerns. Nicht von Hand ändern. -->',
    '',
    'Diese Seite entsteht mit `pnpm docs:generate` aus dem Katalog der Tools des Kerns. Ein Test vergleicht sie mit dem Code. Ändern Sie sie deshalb nicht von Hand.',
    '',
    'Die Beschreibungen der Tools sind englisch und stehen hier genau so, wie das Modell eines MCP-Clients sie liest, mit den Rechten und den Sätzen zum Datenumschlag, die der Kern selbst dazusetzt. Was jede Stufe der Maskierung mit einer Datenklasse tut, steht in [ADR 0026](adr/0026-klassifizierte-ausgabeschemas.md), welche Rechte das Dienstkonto braucht, in [`betrieb/dienstkonto.md`](betrieb/dienstkonto.md).',
    '',
    '## Übersicht',
    '',
    '| Tool | Bereich | Sensibilität | Unbeaufsichtigt | Für Routinen stabil | Angeboten |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  const legend = [
    '',
    '«Unbeaufsichtigt» sagt, ob eine Routine das Tool ohne Aufsicht aufrufen darf: nie oder nur so, wie die Richtlinie des Betreibers es erlaubt. «Für Routinen stabil» heisst, dass Routinen sich auf Name und Eingabe des Tools verlassen dürfen, eine inkompatible Änderung daran ist eine neue Hauptversion. «Angeboten» nennt die Einstellungen, ohne die der Server das Tool nicht anbietet. Statt des Namens eines Toolsets genügt `all` in `ECCLIUM_TOOLSETS`.',
  ];
  // Said only while it holds, so that the first tool that writes changes
  // the page instead of leaving a false sentence on it.
  if (entries.every((entry) => entry.meta.capability === 'read')) {
    legend.push('', 'Alle Tools dieser Seite lesen nur.');
  }
  for (const entry of entries) {
    const { meta } = entry;
    lines.push(
      `| ${code(entry.name)} | ${code(meta.domain)} | ${sensitivityLabels[meta.sensitivity]} | ${unattendedLabels[meta.unattended]} | ${yesNo(meta.routineStable)} | ${offeredLabel(entry)} |`,
    );
  }
  lines.push(...legend);
  for (const entry of entries) {
    lines.push('', ...toolSection(entry));
  }
  lines.push(
    '',
    '## Freitextfelder',
    '',
    'Diese Felder tragen die Datenklasse `untrusted`. Ihr Text kommt aus ChurchTools, und die Pipeline setzt ihn in einen Datenumschlag mit zufälliger Grenze, damit das Modell ihn als Daten erkennt. Namen von Personen mit den Datenklassen `name.first` und `name.last` stehen bewusst ausserhalb des Umschlags, damit die Maskierung `strict` Nachnamen kürzen kann. Auch sie hat jemand in der Gemeinde geschrieben ([ADR 0026](adr/0026-klassifizierte-ausgabeschemas.md)).',
    '',
    '| Tool | Feld |',
    '| --- | --- |',
  );
  for (const entry of entries) {
    for (const row of leaves(entry)) {
      if (row.dataClass === 'untrusted') {
        lines.push(`| ${code(entry.name)} | ${code(row.path)} |`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}
