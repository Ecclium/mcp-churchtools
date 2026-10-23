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

const yesNo = (value: boolean): string => (value ? 'ja' : 'nein');

const code = (text: string): string => `\`${text}\``;

// The leaves of an output in the order of the schema: fields of an object
// by their keys, elements of an array with [], items of a tuple by index.
const leavesOf = (node: ShapeNode, path: string, rows: LeafRow[]): void => {
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

const offeredLabel = (offered: string | undefined): string =>
  offered === undefined ? 'immer' : code(offered);

const toolSection = (
  entry: CatalogEntry,
  offered: string | undefined,
): string[] => {
  const { meta } = entry;
  const lines = [
    `## ${code(entry.name)}`,
    '',
    `- Fachbereich: ${code(meta.domain)}`,
    `- Sensitivität: ${sensitivityLabels[meta.sensitivity]}`,
    `- Unbeaufsichtigt: ${unattendedLabels[meta.unattended]}`,
    `- Für Routinen stabil: ${yesNo(meta.routineStable)}`,
    `- Angeboten: ${offeredLabel(offered)}`,
    `- Rechte in ChurchTools: ${rightsOf(entry)}`,
    '',
    '### Beschreibung',
    '',
    '```text',
    entry.description,
    '```',
    '',
    '### Ausgabe',
    '',
    '| Feld | Typ | Datenklasse | Kann fehlen | Kann null sein |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const row of leaves(entry)) {
    const dataClass =
      row.dataClass === undefined ? 'keine' : code(row.dataClass);
    lines.push(
      `| ${code(row.path)} | ${row.types.join(' oder ')} | ${dataClass} | ${yesNo(row.optional)} | ${yesNo(row.nullable)} |`,
    );
  }
  return lines;
};

/**
 * The switch that offers a tool beyond the default catalog. Today only the
 * two search tools need one (ADR 0055).
 */
export const searchToolsSwitch = 'ECCLIUM_SEARCH_TOOLS=true';

/**
 * Renders the reference of the tools of the core, with every tool the core
 * can offer, sorted by name, and notes which switch offers a tool that the
 * default catalog leaves out.
 *
 * @returns The Markdown of `docs/tools.md`, ending with a line break.
 * @example
 * ```ts
 * renderToolsReference().startsWith('# Tools\n'); // true
 * ```
 */
export function renderToolsReference(): string {
  const byDefault = createToolCatalog({
    core: createCorePlugin({ searchTools: false }),
    plugins: [],
    readOnly: true,
  });
  const all = createToolCatalog({
    core: createCorePlugin({ searchTools: true }),
    plugins: [],
    readOnly: true,
  });
  const offered = (entry: CatalogEntry): string | undefined =>
    byDefault.get(entry.name) === undefined ? searchToolsSwitch : undefined;
  const entries = all.list();
  const lines = [
    '# Tools',
    '',
    '<!-- Erzeugt mit `pnpm docs:generate` aus dem Katalog des Kerns. Nicht von Hand ändern. -->',
    '',
    'Diese Seite entsteht mit `pnpm docs:generate` aus dem Katalog der Tools des Kerns. Ein Test vergleicht sie mit dem Code. Ändern Sie sie deshalb nicht von Hand.',
    '',
    'Die Beschreibungen der Tools sind englisch und stehen hier unverändert, weil das Modell eines MCP-Clients genau diesen Text liest. Die nötigen Rechte und die Sätze zum Datenumschlag setzt der Kern selbst dazu. Was jede Stufe der Maskierung mit einer Datenklasse tut, steht in [ADR 0026](adr/0026-klassifizierte-ausgabeschemas.md), welche Rechte das Dienstkonto braucht, in [`betrieb/dienstkonto.md`](betrieb/dienstkonto.md).',
    '',
    '## Übersicht',
    '',
    '| Tool | Fachbereich | Sensitivität | Unbeaufsichtigt | Für Routinen stabil | Angeboten |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const entry of entries) {
    const { meta } = entry;
    lines.push(
      `| ${code(entry.name)} | ${code(meta.domain)} | ${sensitivityLabels[meta.sensitivity]} | ${unattendedLabels[meta.unattended]} | ${yesNo(meta.routineStable)} | ${offeredLabel(offered(entry))} |`,
    );
  }
  for (const entry of entries) {
    lines.push('', ...toolSection(entry, offered(entry)));
  }
  lines.push(
    '',
    '## Freitextfelder',
    '',
    'Diese Felder tragen die Datenklasse `untrusted`. Ihr Text kommt aus ChurchTools, und die Pipeline setzt ihn in einen Datenumschlag mit zufälliger Grenze, damit das Modell ihn als Daten erkennt.',
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
