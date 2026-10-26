import {
  createToolCatalog,
  promptDataSentence,
  type ToolCatalog,
} from '@ecclium/mcp-churchtools-core';
import {
  type PromptDefinition,
  promptNamePattern,
} from '@ecclium/mcp-churchtools-plugin-api';
import { describe, expect, it } from 'vitest';

import {
  createCorePlugin,
  rotaWeekendPrompt,
  wikiDraftPrompt,
} from './index.js';

// The prompts of the core through the registry of the core, as the server
// offers them, and their texts against the rules for texts for people.

const catalogWith = (
  toolsets: readonly ('persons' | 'events' | 'calendars' | 'wiki' | 'songs')[],
): ToolCatalog =>
  createToolCatalog({
    core: createCorePlugin(),
    plugins: [],
    readOnly: true,
    toolsets: new Set(toolsets),
  });

const prompts: readonly (readonly [string, PromptDefinition])[] = [
  ['dienstplan_wochenende', rotaWeekendPrompt],
  ['wiki_seite_entwerfen', wikiDraftPrompt],
];

describe('the prompts of the core in the catalog', () => {
  it('offers no prompt without toolsets', () => {
    expect(catalogWith([]).prompts()).toEqual([]);
  });

  it('offers each prompt with the toolset of its tools only', () => {
    expect(
      catalogWith(['events'])
        .prompts()
        .map((p) => p.name),
    ).toEqual(['dienstplan_wochenende']);
    expect(
      catalogWith(['wiki'])
        .prompts()
        .map((p) => p.name),
    ).toEqual(['wiki_seite_entwerfen']);
    for (const toolset of ['persons', 'calendars', 'songs'] as const) {
      expect(catalogWith([toolset]).prompts(), toolset).toEqual([]);
    }
  });

  it('offers both with all toolsets, as prompts of the core', () => {
    const all = catalogWith([
      'persons',
      'events',
      'calendars',
      'wiki',
      'songs',
    ]);
    expect(
      all.prompts().map((p) => [p.name, p.plugin, p.origin, p.tools]),
    ).toEqual([
      [
        'dienstplan_wochenende',
        '@ecclium/mcp-churchtools',
        'core',
        ['ct_events_list', 'ct_services_list', 'ct_services_get_assignments'],
      ],
      [
        'wiki_seite_entwerfen',
        '@ecclium/mcp-churchtools',
        'core',
        ['ct_wiki_categories_list', 'ct_wiki_search', 'ct_wiki_page_get'],
      ],
    ]);
  });

  it('relies only on tools that read', () => {
    const all = catalogWith(['events', 'wiki']);
    for (const prompt of all.prompts()) {
      for (const tool of prompt.tools) {
        expect(all.get(tool)?.meta.capability, tool).toBe('read');
      }
    }
  });
});

describe.each(prompts)('the texts of %s', (name, prompt) => {
  const texts = [
    prompt.title,
    prompt.description,
    prompt.text,
    ...prompt.arguments.map((argument) => argument.description),
  ];

  it('has a German name in the form of a prompt name', () => {
    expect(prompt.name).toBe(name);
    expect(promptNamePattern.test(prompt.name)).toBe(true);
  });

  it('writes ss, quotes «so», no dash of the em and no exclamation mark', () => {
    for (const text of texts) {
      expect(text).not.toMatch(/[ß—–!"„“”‚‘’]/u);
    }
  });

  it('names no tool and gives the steps without addressing anyone', () => {
    for (const text of texts) expect(text).not.toContain('ct_');
    expect(prompt.text).not.toMatch(
      /\b(?:Sie|Ihr|Ihre|Ihren|du|dein|deine)\b/u,
    );
  });

  it('says that nothing in ChurchTools changes', () => {
    expect(prompt.text).toContain('nichts in ChurchTools ändern');
  });
});

describe('dienstplan_wochenende', () => {
  const entry = catalogWith(['events']).prompt('dienstplan_wochenende');

  it('fills the Saturday into the text and ends with the sentence of the core', () => {
    const filled = entry?.fill({ samstag: '2026-10-31' });
    expect(filled?.ok).toBe(true);
    const text = filled?.ok === true ? filled.text : '';
    expect(
      text.startsWith(
        'Überblick über den Dienstplan für das Wochenende von Samstag, 2026-10-31, und dem Sonntag danach.\n',
      ),
    ).toBe(true);
    expect(text.endsWith(`\n\n${promptDataSentence}`)).toBe(true);
    expect(text).not.toMatch(/[{}]/);
  });

  it('takes only a Saturday', () => {
    for (const day of ['2026-10-30', '2026-11-01', '2026-02-29']) {
      expect(entry?.fill({ samstag: day }), day).toEqual({
        ok: false,
        argument: 'samstag',
      });
    }
  });
});

describe('wiki_seite_entwerfen', () => {
  const entry = catalogWith(['wiki']).prompt('wiki_seite_entwerfen');

  it('puts the keywords between the first line and the steps', () => {
    const filled = entry?.fill({
      stichworte: 'Kaffee nach dem Gottesdienst\nwer, wann, wo',
    });
    const text = filled?.ok === true ? filled.text : '';
    expect(text).toContain(
      'aus diesen Stichworten:\n\nKaffee nach dem Gottesdienst\nwer, wann, wo\n\nVorgehen:\n',
    );
    expect(text).toContain('Ecclium legt die Seite nicht an.');
  });

  it(`takes keywords of up to 2'000 characters`, () => {
    expect(entry?.fill({ stichworte: 'a'.repeat(2000) }).ok).toBe(true);
    expect(entry?.fill({ stichworte: 'a'.repeat(2001) })).toEqual({
      ok: false,
      argument: 'stichworte',
    });
  });
});
