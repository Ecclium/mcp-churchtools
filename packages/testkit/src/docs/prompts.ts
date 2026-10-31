/**
 * Renders `docs/prompts.md`, the reference of the prompts of the core, from
 * the catalog the registry builds (ADR 0065). The page is German, like the
 * prompts, and shows each text as a person sends it, with the sentence the
 * core adds. A test compares the page with the file, so a changed prompt
 * without a new page turns CI red.
 *
 * @packageDocumentation
 */
import {
  type CatalogEntry,
  createToolCatalog,
  promptDataSentence,
  type PromptEntry,
  type ToolCatalog,
  toolsetNames,
  toolsetOf,
} from '@ecclium/mcp-churchtools-core';
import type { PromptArgument } from '@ecclium/mcp-churchtools-plugin-api';
import { createCorePlugin } from '@ecclium/mcp-churchtools-tools';

import { syntheticDocsIndex } from '../fixtures/docs-facts.js';

const code = (text: string): string => `\`${text}\``;

// Numbers as the texts for people write them: 2'000.
const number = (value: number): string =>
  String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, "'");

const weekdays = Object.freeze([
  'Montag',
  'Dienstag',
  'Mittwoch',
  'Donnerstag',
  'Freitag',
  'Samstag',
  'Sonntag',
]);

const kindOf = (argument: PromptArgument): string => {
  if (argument.kind === 'text') {
    return `Text, höchstens ${number(argument.maxLength)} Zeichen`;
  }
  return argument.weekday === undefined
    ? 'Tag als JJJJ-MM-TT'
    : `Tag als JJJJ-MM-TT, nur ${weekdays[argument.weekday - 1] ?? ''}`;
};

// A fence longer than any run of backticks in the text.
const fenceFor = (text: string): string => {
  let longest = 0;
  for (const run of text.match(/`+/gu) ?? []) {
    longest = Math.max(longest, run.length);
  }
  return '`'.repeat(Math.max(3, longest + 1));
};

// The settings without which the server does not offer a prompt: the
// toolsets of its tools and, where one of them names persons, the folder of
// the audit file (ADR 0028, ADR 0064).
const offeredLabel = (prompt: PromptEntry, catalog: ToolCatalog): string => {
  const tools = prompt.tools.map((name) => catalog.get(name));
  if (tools.some((tool) => tool === undefined)) {
    throw new TypeError(`a tool of ${prompt.name} is not in the catalog`);
  }
  const entries = tools as readonly CatalogEntry[];
  const toolsets = [
    ...new Set(entries.map((tool) => toolsetOf(tool.meta.domain))),
  ].filter((toolset) => toolset !== 'base' && toolset !== undefined);
  const needs = [
    ...toolsets.map(
      (toolset) => `${code(toolset)} in ${code('ECCLIUM_TOOLSETS')}`,
    ),
    ...(entries.some((tool) => tool.asSpecial)
      ? [code('ECCLIUM_STATE_DIR')]
      : []),
  ];
  return needs.length === 0 ? 'immer' : needs.join(', mit ');
};

const promptSection = (prompt: PromptEntry, catalog: ToolCatalog): string[] => {
  const text = `${prompt.template}\n\n${promptDataSentence}`;
  const lines = [
    `## ${code(prompt.name)}`,
    '',
    `- Titel: «${prompt.title}»`,
    `- Angeboten: ${offeredLabel(prompt, catalog)}`,
    `- Tools: ${prompt.tools.map(code).join(', ')}`,
    '',
    prompt.description,
    '',
    '### Argumente',
    '',
  ];
  if (prompt.arguments.length === 0) {
    lines.push('Keine.');
  } else {
    lines.push('| Argument | Art | Beschreibung |', '| --- | --- | --- |');
    for (const argument of prompt.arguments) {
      lines.push(
        `| ${code(argument.name)} | ${kindOf(argument)} | ${argument.description} |`,
      );
    }
  }
  lines.push('', '### Text', '', `${fenceFor(text)}text`, text, fenceFor(text));
  return lines;
};

/**
 * Renders the reference of the prompts of the core, with every prompt the
 * core can offer, sorted by name, and the settings each one needs.
 *
 * @returns The Markdown of `docs/prompts.md`, ending with a line break.
 * @example
 * ```ts
 * renderPromptsReference().startsWith('# Prompts\n'); // true
 * ```
 */
export function renderPromptsReference(): string {
  const catalog = createToolCatalog({
    core: createCorePlugin({ docs: syntheticDocsIndex() }),
    plugins: [],
    readOnly: false,
    toolsets: new Set(toolsetNames),
  });
  const prompts = catalog.prompts();
  const lines = [
    '# Prompts',
    '',
    '<!-- Erzeugt mit `pnpm docs:generate` aus dem Katalog des Kerns. Nicht von Hand ändern. -->',
    '',
    'Diese Seite entsteht mit `pnpm docs:generate` aus dem Katalog des Kerns. Ein Test vergleicht sie mit dem Code. Ändern Sie sie deshalb nicht von Hand.',
    '',
    'Ein Prompt ist eine feste Vorlage für einen häufigen Ablauf. Sie wählen ihn in Ihrem KI-Assistenten aus, geben die Argumente ein, und sein Text erscheint im Gespräch als Ihre Nachricht. In Claude Code heisst er `/mcp__<Name des Servers>__<Name des Prompts>`, etwa `/mcp__ecclium__dienstplan_wochenende 2026-10-31`. Claude Code setzt in ein Argument nur das erste Wort ein, auch zwischen Anführungszeichen (geprüft mit Version 2.1.314). Am 31.10.2026 sah der KI-Assistent die ganze Eingabe trotzdem daneben und arbeitete mit ihr, ob das immer so ist, ist nicht geprüft. Für die Rechte-Diagnose geben Sie in Claude Code deshalb am besten ein Wort ohne Leerzeichen ein, etwa den Namen des Tools oder die `operationId`. Andere Clients wie Claude Desktop bieten Prompts in ihrer Oberfläche an, wenn sie Prompts unterstützen. Der Server liest dafür nichts aus ChurchTools: Er prüft die Argumente, setzt sie in den Text und schreibt eine Zeile ins Log, keine ins Audit. Erst die Tools, die der KI-Assistent danach aufruft, lesen aus ChurchTools ([ADR 0065](adr/0065-mcp-prompts-als-feste-vorlagen.md)).',
    '',
    `Der Server bietet einen Prompt nur an, wenn er alle Tools anbietet, auf die sich der Prompt stützt. Ohne Toolsets bietet er also keinen an. Jeder Text endet mit dem Satz «${promptDataSentence}», den der Kern selbst dazusetzt. Kein Text nennt ein Tool beim Namen, der KI-Assistent findet die Tools über ihre Beschreibungen in [docs/tools.md](tools.md). Lehnt der Server ein Argument ab, nennt die Meldung nur seinen Namen, nie den Wert.`,
    '',
    '## Übersicht',
    '',
    '| Prompt | Titel | Argumente | Angeboten |',
    '| --- | --- | --- | --- |',
  ];
  for (const prompt of prompts) {
    const names =
      prompt.arguments.length === 0
        ? 'keine'
        : prompt.arguments.map((argument) => code(argument.name)).join(', ');
    lines.push(
      `| ${code(prompt.name)} | ${prompt.title} | ${names} | ${offeredLabel(prompt, catalog)} |`,
    );
  }
  lines.push(
    '',
    'Alle Argumente sind Pflicht. Unsichtbare Zeichen in einem Text entfernt der Server, bevor er ihn einsetzt.',
  );
  for (const prompt of prompts) {
    lines.push('', ...promptSection(prompt, catalog));
  }
  return `${lines.join('\n')}\n`;
}
