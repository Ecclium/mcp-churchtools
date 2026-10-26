import {
  createToolCatalog,
  RegistryRefusal,
} from '@ecclium/mcp-churchtools-core';
import { wikiPageListLimit } from '@ecclium/mcp-churchtools-plugin-api';
import { examplePlugin } from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it } from 'vitest';

import { maxListedIds, maxListedRights } from './base/whoami.js';
import {
  appointmentsGetTool,
  appointmentsListTool,
  bookingsListTool,
  calendarsListTool,
  createCorePlugin,
  eventsGetAgendaTool,
  eventsGetTool,
  eventsListTool,
  groupsGetMembersTool,
  groupsGetTool,
  groupsSearchTool,
  personsGetGroupsTool,
  personsGetTool,
  personsSearchTool,
  resourcesListTool,
  servicesGetAssignmentsTool,
  servicesListTool,
  whoamiTool,
  wikiCategoriesListTool,
  wikiPageGetTool,
  wikiPagesListTool,
} from './index.js';
import { categoriesPerCall } from './wiki/categories.js';
import { maxPartBytes } from './wiki/parts.js';

// The entry hands out the plugin of the free core. The registry of the core
// takes it as the core and keeps each tool with its metadata, a shape whose
// every leaf has a data class, and the input schema the mount advertises.

const catalog = createToolCatalog({
  core: createCorePlugin(),
  plugins: [],
  readOnly: true,
});

const withSearch = createToolCatalog({
  core: createCorePlugin(),
  toolsets: new Set(['persons'] as const),
  plugins: [],
  readOnly: true,
});

const withWiki = createToolCatalog({
  core: createCorePlugin(),
  toolsets: new Set(['wiki'] as const),
  plugins: [],
  readOnly: true,
});

describe('@ecclium/mcp-churchtools-tools', () => {
  it('hands out the plugin of the core with ct_whoami only by default', () => {
    expect(
      catalog.list().map((tool) => [tool.name, tool.plugin, tool.origin]),
    ).toEqual([['ct_whoami', '@ecclium/mcp-churchtools', 'core']]);
  });

  it('gives every leaf of every tool of the core a class with a mask (ADR 0026)', () => {
    const shapes = withSearch
      .list()
      .map((tool) => [tool.name, tool.shape.unclassified, tool.shape.unmasked]);
    expect(shapes).toEqual([
      ['ct_groups_get', 0, 0],
      ['ct_groups_get_members', 0, 0],
      ['ct_groups_search', 0, 0],
      ['ct_persons_get', 0, 0],
      ['ct_persons_get_groups', 0, 0],
      ['ct_persons_search', 0, 0],
      ['ct_whoami', 0, 0],
    ]);
  });

  it('adds the six tools of persons and groups with the toolset persons', () => {
    expect(
      withSearch.list().map((tool) => [tool.name, tool.plugin, tool.origin]),
    ).toEqual([
      ['ct_groups_get', '@ecclium/mcp-churchtools', 'core'],
      ['ct_groups_get_members', '@ecclium/mcp-churchtools', 'core'],
      ['ct_groups_search', '@ecclium/mcp-churchtools', 'core'],
      ['ct_persons_get', '@ecclium/mcp-churchtools', 'core'],
      ['ct_persons_get_groups', '@ecclium/mcp-churchtools', 'core'],
      ['ct_persons_search', '@ecclium/mcp-churchtools', 'core'],
      ['ct_whoami', '@ecclium/mcp-churchtools', 'core'],
    ]);
  });

  it('adds the three tools of the wiki with the toolset wiki, each fully classified', () => {
    expect(
      withWiki
        .list()
        .map((tool) => [tool.name, tool.origin, tool.shape.unclassified]),
    ).toEqual([
      ['ct_whoami', 'core', 0],
      ['ct_wiki_categories_list', 'core', 0],
      ['ct_wiki_page_get', 'core', 0],
      ['ct_wiki_pages_list', 'core', 0],
    ]);
  });

  it('offers only ct_whoami without a toolset, and is frozen', () => {
    const plugin = createCorePlugin();
    expect(
      createToolCatalog({ core: plugin, plugins: [], readOnly: true })
        .list()
        .map((tool) => tool.name),
    ).toEqual(['ct_whoami']);
    expect(Object.isFrozen(plugin)).toBe(true);
  });

  it('carries the name the catalog reserves for the core', () => {
    let refusal: unknown;
    try {
      createToolCatalog({
        core: examplePlugin,
        plugins: [createCorePlugin()],
        readOnly: true,
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(RegistryRefusal);
    expect((refusal as RegistryRefusal).reason).toBe('plugin_reserved');
  });
});

describe.each([
  ['ct_whoami', whoamiTool],
  ['ct_persons_search', personsSearchTool],
  ['ct_persons_get', personsGetTool],
  ['ct_persons_get_groups', personsGetGroupsTool],
  ['ct_groups_search', groupsSearchTool],
  ['ct_groups_get', groupsGetTool],
  ['ct_groups_get_members', groupsGetMembersTool],
  ['ct_wiki_categories_list', wikiCategoriesListTool],
  ['ct_wiki_pages_list', wikiPagesListTool],
  ['ct_wiki_page_get', wikiPageGetTool],
  ['ct_events_list', eventsListTool],
  ['ct_events_get', eventsGetTool],
  ['ct_events_get_agenda', eventsGetAgendaTool],
  ['ct_services_list', servicesListTool],
  ['ct_services_get_assignments', servicesGetAssignmentsTool],
  ['ct_calendars_list', calendarsListTool],
  ['ct_appointments_list', appointmentsListTool],
  ['ct_appointments_get', appointmentsGetTool],
  ['ct_resources_list', resourcesListTool],
  ['ct_bookings_list', bookingsListTool],
])('the description of %s', (_, tool) => {
  it('has four sections of one line each, naming no tool', () => {
    const sections = Object.entries(tool.description);
    expect(sections.map(([key]) => key)).toEqual([
      'purpose',
      'useWhen',
      'avoidWhen',
      'limits',
    ]);
    for (const [key, text] of sections) {
      expect(text, key).not.toMatch(/[\n\r]/);
      expect(text, key).not.toContain('ct_');
    }
  });
});

describe('ct_whoami in the catalog', () => {
  const tool = catalog.get('ct_whoami');

  it('reads only, never unattended, and needs no right', () => {
    expect(tool?.meta).toEqual({
      capability: 'read',
      domain: 'base',
      requiredRights: [],
      tier: 'free',
      sensitivity: 'personal',
      unattended: 'never',
      routineStable: false,
    });
  });

  it('gives every leaf of its output a data class', () => {
    expect(tool?.shape.unclassified).toBe(0);
    expect(tool?.shape.minimumSensitivity).toBe('personal');
  });

  it('advertises an input without properties', () => {
    expect(tool?.inputSchema).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });

  it('names its limits with the numbers it applies', () => {
    const { limits } = whoamiTool.description;
    expect(limits).toContain(`the ${String(maxListedIds)} lowest IDs`);
    expect(limits).toContain(`more than ${String(maxListedRights)} set rights`);
    expect(limits).toContain('through a group may be missing');
    expect(limits).toContain('revoked right can still show');
  });
});

describe.each([
  [
    'ct_persons_search',
    'persons',
    { module: 'churchdb', right: 'view alldata' },
  ],
  [
    'ct_groups_search',
    'groups',
    { module: 'churchgroup', right: 'view groups of grouptype' },
  ],
])('%s in the catalog', (name, domain, right) => {
  const tool = withSearch.get(name);

  it('reads only, holds special data, never runs unattended and names its right', () => {
    expect(tool?.meta).toEqual({
      capability: 'read',
      domain,
      requiredRights: [right],
      tier: 'free',
      sensitivity: 'special',
      unattended: 'never',
      routineStable: false,
    });
  });

  it('gives every leaf of its output a data class', () => {
    expect(tool?.shape.unclassified).toBe(0);
  });

  it('advertises exactly a search term of 1 to 100 characters with one that is no space', () => {
    expect(tool?.inputSchema).toEqual({
      type: 'object',
      properties: {
        query: {
          type: 'string',
          minLength: 1,
          maxLength: 100,
          pattern: '\\S',
        },
      },
      required: ['query'],
      additionalProperties: false,
    });
  });

  it('names its right in the description the model reads', () => {
    expect(tool?.description).toContain(
      `Required ChurchTools rights: "${right.right}" in ${right.module}.`,
    );
  });
});

const viewAllData = { module: 'churchdb', right: 'view alldata' };
const viewGroups = { module: 'churchgroup', right: 'view groups of grouptype' };
const groupLevel = { module: 'churchgroup', right: 'security level group' };
const id = {
  type: 'integer',
  exclusiveMinimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
};

// The four reads by ID of ADR 0064: special like the searches, each with
// the rights that open its read, and an input of IDs only.
describe.each([
  ['ct_persons_get', 'persons', [viewAllData], { personId: id }, ['personId']],
  [
    'ct_persons_get_groups',
    'persons',
    [viewAllData, viewGroups],
    { personId: id },
    ['personId'],
  ],
  [
    'ct_groups_get',
    'groups',
    [viewGroups, groupLevel],
    { groupId: id },
    ['groupId'],
  ],
  [
    'ct_groups_get_members',
    'groups',
    [viewGroups, viewAllData],
    { groupId: id, page: { type: 'integer', minimum: 1, maximum: 1000 } },
    ['groupId'],
  ],
])('%s in the catalog', (name, domain, rights, properties, required) => {
  const tool = withSearch.get(name);

  it('reads only, holds special data, never runs unattended and names its rights', () => {
    expect(tool?.meta).toEqual({
      capability: 'read',
      domain,
      requiredRights: rights,
      tier: 'free',
      sensitivity: 'special',
      unattended: 'never',
      routineStable: false,
    });
    expect(tool?.description).toContain(
      `Required ChurchTools rights: ${rights
        .map((right) => `"${right.right}" in ${right.module}`)
        .join(', ')}.`,
    );
  });

  it('gives every leaf of its output a data class with a mask', () => {
    expect([tool?.shape.unclassified, tool?.shape.unmasked]).toEqual([0, 0]);
  });

  it('advertises only the IDs it reads by, and a page for the members', () => {
    expect(tool?.inputSchema).toEqual({
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    });
  });
});

const view = { module: 'churchwiki', right: 'view' };
const viewCategory = { module: 'churchwiki', right: 'view category' };

describe.each([
  ['ct_wiki_categories_list', [view]],
  ['ct_wiki_pages_list', [view, viewCategory]],
  ['ct_wiki_page_get', [view, viewCategory]],
])('%s in the catalog', (name, rights) => {
  const tool = withWiki.get(name);

  it('reads only, holds personal data, runs unattended only by policy and names its rights', () => {
    expect(tool?.meta).toEqual({
      capability: 'read',
      domain: 'wiki',
      requiredRights: rights,
      tier: 'free',
      sensitivity: 'personal',
      unattended: 'policy',
      routineStable: false,
    });
    expect(tool?.description).toContain(
      `Required ChurchTools rights: ${rights
        .map((right) => `"${right.right}" in ${right.module}`)
        .join(', ')}.`,
    );
  });
});

describe('the input of the tools of the wiki', () => {
  it('asks only for an optional page of 1 to 40 to list the categories', () => {
    expect(withWiki.get('ct_wiki_categories_list')?.inputSchema).toEqual({
      type: 'object',
      properties: { page: { type: 'integer', minimum: 1, maximum: 40 } },
      additionalProperties: false,
    });
  });

  it('names in each description the numbers its tool applies', () => {
    expect(wikiCategoriesListTool.description.limits).toContain(
      `At most ${String(categoriesPerCall)} categories per call`,
    );
    expect(wikiPagesListTool.description.limits).toContain(
      `At most ${String(wikiPageListLimit)} pages per call`,
    );
    expect(wikiPageGetTool.description.limits).toContain(
      `at most ${String(maxPartBytes)} bytes`,
    );
  });

  it('asks for a category and an optional page of 1 to 1000 to list pages', () => {
    const schema = withWiki.get('ct_wiki_pages_list')
      ?.inputSchema as unknown as {
      properties: Record<string, unknown>;
      required: unknown;
    };
    expect(Object.keys(schema.properties)).toEqual(['categoryId', 'page']);
    expect(schema.required).toEqual(['categoryId']);
    expect(schema.properties['page']).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 1000,
    });
  });

  it('asks for a category, a GUID and an optional part and version to read a page', () => {
    const schema = withWiki.get('ct_wiki_page_get')?.inputSchema as unknown as {
      properties: Record<string, unknown>;
      required: unknown;
    };
    expect(Object.keys(schema.properties)).toEqual([
      'categoryId',
      'guid',
      'part',
      'version',
    ]);
    expect(schema.required).toEqual(['categoryId', 'guid']);
    expect(schema.properties['guid']).toMatchObject({
      type: 'string',
      pattern:
        '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$',
    });
  });
});
