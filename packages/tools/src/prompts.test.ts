import {
  createToolCatalog,
  promptDataSentence,
  type ToolCatalog,
  type ToolsetName,
} from '@ecclium/mcp-churchtools-core';
import {
  type PromptDefinition,
  promptNamePattern,
} from '@ecclium/mcp-churchtools-plugin-api';
import { syntheticDocsIndex } from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it } from 'vitest';

import {
  createCorePlugin,
  rightsDiagnosisPrompt,
  rotaWeekendPrompt,
  wikiDraftPrompt,
} from './index.js';

// The prompts of the core through the registry of the core, as the server
// offers them, and their texts against the rules for texts for people.

// The composition root hands the plugin a docs index only with `docs` or
// `api`, as here; built once, because a docs index takes a moment.
const docs = syntheticDocsIndex();

const catalogWith = (toolsets: readonly ToolsetName[]): ToolCatalog =>
  createToolCatalog({
    core: createCorePlugin(
      toolsets.includes('docs') || toolsets.includes('api') ? { docs } : {},
    ),
    plugins: [],
    readOnly: true,
    toolsets: new Set(toolsets),
  });

const prompts: readonly (readonly [string, PromptDefinition])[] = [
  ['dienstplan_wochenende', rotaWeekendPrompt],
  ['wiki_seite_entwerfen', wikiDraftPrompt],
  ['rechte_diagnose', rightsDiagnosisPrompt],
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
    expect(
      catalogWith(['docs'])
        .prompts()
        .map((p) => p.name),
    ).toEqual(['rechte_diagnose']);
    for (const toolset of ['persons', 'calendars', 'songs', 'api'] as const) {
      expect(catalogWith([toolset]).prompts(), toolset).toEqual([]);
    }
  });

  it('adds the rights diagnosis only with a docs index', () => {
    // Without the index the docs tools are missing, so the registry would
    // refuse the prompt; the plugin leaves it out and the catalog builds.
    const withoutIndex = createToolCatalog({
      core: createCorePlugin(),
      plugins: [],
      readOnly: true,
      toolsets: new Set(['docs']),
    });
    expect(withoutIndex.prompts()).toEqual([]);
    expect(withoutIndex.prompt('rechte_diagnose')).toBeUndefined();
  });

  it('offers all three with all toolsets, as prompts of the core', () => {
    const all = catalogWith([
      'persons',
      'events',
      'calendars',
      'wiki',
      'songs',
      'docs',
      'api',
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
        'rechte_diagnose',
        '@ecclium/mcp-churchtools',
        'core',
        [
          'ct_whoami',
          'ct_docs_search_api',
          'ct_docs_get_operation',
          'ct_docs_get_right',
          'ct_docs_read_academy',
        ],
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
    const all = catalogWith(['events', 'wiki', 'docs']);
    expect(all.prompts()).toHaveLength(3);
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

describe('rechte_diagnose', () => {
  const entry = catalogWith(['docs']).prompt('rechte_diagnose');

  it('puts what failed between the first line and the steps', () => {
    const filled = entry?.fill({
      zugriff: 'GET /api/groups/12/members\nThe account lacks a right.',
    });
    const text = filled?.ok === true ? filled.text : '';
    expect(
      text.startsWith(
        'Diagnose der Rechte nach einem fehlgeschlagenen Zugriff auf ChurchTools. Fehlgeschlagen ist:\n\nGET /api/groups/12/members\nThe account lacks a right.\n\nVorgehen:\n',
      ),
    ).toBe(true);
    expect(text.endsWith(`\n\n${promptDataSentence}`)).toBe(true);
    expect(text).not.toMatch(/[{}]/);
  });

  it('proposes no right wider than the guide to the service account', () => {
    // The limits of what the diagnosis may propose (ADR 0060, ADR 0064).
    for (const part of [
      'Nur Rechte nennen, die die Dokumentation mit Beleg verlangt.',
      'keine Sicherheitsstufe für Personen, kein Recht zum Schreiben oder Verwalten und nicht «Alle»',
      'Keine Rechte vorschlagen, die die Dokumentation als nicht nötig nennt',
      'das sagen und davon abraten',
    ]) {
      expect(rightsDiagnosisPrompt.text, part).toContain(part);
    }
  });

  it('tells a rule of Ecclium and a refused token from a missing right', () => {
    expect(rightsDiagnosisPrompt.text).toContain(
      'öffnet kein Recht in ChurchTools',
    );
    expect(rightsDiagnosisPrompt.text).toContain(
      'Ein abgewiesenes Token betrifft den Zugang des Kontos, nicht seine Rechte.',
    );
  });

  it(`takes what failed with up to 2'000 characters`, () => {
    expect(entry?.fill({ zugriff: 'a'.repeat(2000) }).ok).toBe(true);
    for (const value of ['a'.repeat(2001), '', ' \n ']) {
      expect(entry?.fill({ zugriff: value }), value).toEqual({
        ok: false,
        argument: 'zugriff',
      });
    }
  });
});
