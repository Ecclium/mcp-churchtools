import {
  createToolCatalog,
  createToolPipeline,
  loadConfig,
  type ToolCatalog,
  type ToolPipelineOptions,
  type ToolRequest,
  type ToolsetName,
} from '@ecclium/mcp-churchtools-core';
import type { DocsIndex } from '@ecclium/mcp-churchtools-docs-index';
import type { TenantAssignment } from '@ecclium/mcp-churchtools-plugin-api';
import {
  createChurchToolsDouble,
  createMemoryQuotaStore,
  doubleOrigin,
  makeCanaries,
  syntheticDocsIndex,
  syntheticFacts,
  syntheticRightsPage,
  syntheticThingsPage,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { createCorePlugin } from '../core-plugin.js';
import { academyPageNotFound, academyPartOutOfRange } from './academy.js';
import {
  academyTerms,
  findingPlace,
  interfacePlace,
  openApiPlace,
} from './common.js';
import { renderDefinition } from './definition.js';
import {
  definitionPartOutOfRange,
  operationAskedWrongly,
  operationNotFound,
  pathNotFound,
  rightsNotes,
  severalOperations,
} from './operations.js';
import { rightNote, rightNotFound } from './rights.js';

// The six docs tools run through the pipeline of the core, as the server
// runs them, with the toolset docs and a docs index from synthetic facts
// (ADR 0066). They read only the index: the double of ChurchTools must see
// no request at all.

type AuditSink = ToolPipelineOptions['audit'];
type LineWriter = ToolPipelineOptions['logging']['writer'];

const canary = makeCanaries();
const loaded = loadConfig({
  environment: {
    ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
    ECCLIUM_CHURCHTOOLS_TOKEN: canary.token.value,
  },
  transport: 'stdio',
});
if (!loaded.ok) throw new Error('the configuration of the test is invalid');

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
});

const request = (): ToolRequest => ({
  assignment: {
    tenantId: 'default',
    actor: { kind: 'user', id: 'stdio:local-stdio' },
  } as unknown as TenantAssignment,
  mode: 'interactive',
  redaction: 'standard',
  readOnly: true,
  features: [],
  signal: new AbortController().signal,
});

const docsTools = [
  'ct_docs_get_operation',
  'ct_docs_get_right',
  'ct_docs_read_academy',
  'ct_docs_search_academy',
  'ct_docs_search_api',
  'ct_docs_search_rights',
];

const catalogOf = (
  docs: DocsIndex | undefined,
  toolsets: readonly ToolsetName[] = ['docs'],
): ToolCatalog =>
  createToolCatalog({
    core: createCorePlugin(docs === undefined ? {} : { docs }),
    toolsets: new Set(toolsets),
    plugins: [],
    readOnly: true,
  });

const setup = (docs: DocsIndex = syntheticDocsIndex()) => {
  const double = createChurchToolsDouble({
    token: loaded.config.churchtoolsToken,
  });
  open.push(double);
  const writer: LineWriter = Object.freeze({ write: () => true });
  const audit: AuditSink = Object.freeze({
    record: () => true,
    hasFile: false,
    ready: () => true,
    failures: () => 0,
  });
  const pipeline = createToolPipeline({
    quota: createMemoryQuotaStore(new Map()),
    catalog: catalogOf(docs),
    audit,
    transport: double.transport,
    origin: doubleOrigin,
    requestsPerMinute: 300,
    clock: Object.freeze({ now: Object.freeze(() => 0) }),
    logging: { writer, minLevel: 'debug' },
  });
  const call = async (name: string, input: unknown) => {
    const outcome = await pipeline.call(name, input, request());
    // No docs tool ever reaches ChurchTools.
    expect(double.calls()).toEqual([]);
    return outcome;
  };
  const data = async (name: string, input: unknown) => {
    const outcome = await call(name, input);
    if (!outcome.ok) throw new Error(`${name} failed: ${outcome.error.code}`);
    return outcome.data;
  };
  const failure = async (name: string, input: unknown) => {
    const outcome = await call(name, input);
    if (outcome.ok) throw new Error(`${name} did not fail`);
    return outcome.error;
  };
  return { call, data, failure };
};

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

// A text in the data envelope: the markers with the boundary of the call
// around it.
const enveloped = (text: string): unknown =>
  expect.stringMatching(
    new RegExp(`^<<data-[^>]+>>${escape(text)}<</data-[^>]+>>$`, 'u'),
  ) as unknown;

// The text inside the envelope of a result.
const unwrap = (value: unknown): string => {
  const text = String(value);
  const match = /^<<data-[^>]+>>([\s\S]*)<<\/data-[^>]+>>$/u.exec(text);
  if (match === null) throw new Error('not in the data envelope');
  return match[1] ?? '';
};

const openApiSource = {
  name: 'OpenAPI document of ChurchTools',
  path: '/system/runtime/swagger/openapi.json',
  documentVersion: '0.1.0',
  churchToolsVersion: '3.138',
  retrieved: '2026-10-29',
  license: 'CC BY 4.0',
  adapted: true,
};

const permissionsSource = {
  name: 'Rights of a ChurchTools instance',
  path: '/api/permissions/global',
  churchToolsVersion: '3.137',
  retrieved: '2026-10-28',
};

const academySource = {
  name: 'ChurchTools Academy',
  retrieved: '2026-10-27',
  terms: academyTerms,
};

const academyLink = (path: string) => `https://churchtools.academy${path}`;

const finding = (
  id: string,
  shows: 'necessary' | 'sufficient' | null = null,
) => ({
  kind: 'finding',
  finding: id,
  churchToolsVersion: '3.137',
  shows,
  where: findingPlace,
  title: null,
  link: null,
});

describe('the docs tools', () => {
  it('are in the catalog only with the toolset docs and a docs index', () => {
    const offered = (catalog: ToolCatalog) =>
      catalog
        .list()
        .map((entry) => entry.name)
        .filter((name) => name.startsWith('ct_docs_'));
    expect(offered(catalogOf(syntheticDocsIndex()))).toEqual(docsTools);
    expect(
      offered(catalogOf(syntheticDocsIndex(), ['persons', 'wiki', 'songs'])),
    ).toEqual([]);
    // Without the index the plugin adds no docs tool, even with docs on.
    expect(offered(catalogOf(undefined))).toEqual([]);
  });

  it('read nothing from ChurchTools, need no right and are not stable', () => {
    const catalog = catalogOf(syntheticDocsIndex());
    for (const name of docsTools) {
      const entry = catalog.get(name);
      expect(entry?.meta, name).toMatchObject({
        capability: 'read',
        domain: 'docs',
        requiredRights: [],
        sensitivity: 'none',
        unattended: 'policy',
        routineStable: false,
        tier: 'free',
      });
      expect(entry?.asSpecial, name).toBe(false);
    }
  });
});

describe('ct_docs_search_api', () => {
  it('finds operations with their path below /api and the source', async () => {
    const { data } = setup();
    const result = await data('ct_docs_search_api', {
      query: 'members of a thing',
      limit: 1,
    });
    expect(result).toEqual({
      hits: [
        {
          operationId: 'getSyntheticThingMembers',
          method: 'GET',
          path: '/api/synthetic/things/{thingId}/members',
          summary: enveloped('List the members of a synthetic thing'),
          deprecated: false,
        },
      ],
      more: true,
      source: openApiSource,
    });
  });

  it('says more only when more matched', async () => {
    const { data } = setup();
    const all = await data('ct_docs_search_api', { query: 'synthetic' });
    expect(all['hits']).toHaveLength(5);
    expect(all['more']).toBe(false);
    const none = await data('ct_docs_search_api', { query: 'nichts' });
    expect(none).toEqual({ hits: [], more: false, source: openApiSource });
  });

  it.each([
    [{ query: '' }],
    [{ query: '   ' }],
    [{ query: 'a\u0007b' }],
    [{ query: 'x'.repeat(201) }],
    [{ query: 'thing', limit: 26 }],
    [{ query: 'thing', limit: 0 }],
    [{ query: 'thing', other: true }],
  ])('refuses the input %j', async (input) => {
    const { failure } = setup();
    expect((await failure('ct_docs_search_api', input)).code).toBe(
      'validation',
    );
  });
});

describe('ct_docs_get_operation', () => {
  it('gives the rights of an operation with labels and evidence', async () => {
    const { data } = setup();
    const result = await data('ct_docs_get_operation', {
      operationId: 'getSyntheticThingMembers',
    });
    expect(result['rights']).toEqual({
      status: 'needs',
      needs: [
        {
          oneOf: [
            {
              module: 'synthetic',
              name: 'view thing members',
              label: enveloped('Mitglieder der Dinge sehen'),
            },
          ],
          withoutThem: 'entries left out',
          evidence: [
            {
              kind: 'academy',
              finding: null,
              churchToolsVersion: null,
              shows: null,
              where: null,
              title: enveloped('Rechte für Dinge'),
              link: academyLink(syntheticRightsPage),
            },
            finding('Mitglieder ohne Recht', 'sufficient'),
            {
              kind: 'openapi',
              finding: null,
              churchToolsVersion: null,
              shows: null,
              where: openApiPlace,
              title: null,
              link: null,
            },
          ],
        },
        {
          oneOf: [
            {
              module: 'synthetic',
              name: 'view things',
              label: enveloped('Dinge sehen'),
            },
          ],
          withoutThem: null,
          evidence: [finding('F1', 'necessary')],
        },
      ],
      notNeeded: [],
      noneEvidence: [],
      reason: null,
      note: rightsNotes.needs,
    });
    expect(result).toMatchObject({
      operationId: 'getSyntheticThingMembers',
      method: 'GET',
      path: '/api/synthetic/things/{thingId}/members',
      deprecated: false,
      summary: enveloped('List the members of a synthetic thing'),
      part: 1,
      parts: 1,
      source: openApiSource,
    });
  });

  it('gives the definition as text in the data envelope', async () => {
    const { data } = setup();
    const facts = syntheticFacts();
    const fact = facts.operations.entries.find(
      (entry) => entry.operationId === 'getSyntheticThing',
    );
    if (fact === undefined) throw new Error('the fixture changed');
    const result = await data('ct_docs_get_operation', {
      operationId: 'getSyntheticThing',
    });
    expect(unwrap(result['definition'])).toBe(renderDefinition(fact));
    expect(unwrap(result['definition'])).toContain(
      '- thingId (path, required): integer',
    );
    expect(result['rights']).toMatchObject({
      status: 'needs',
      notNeeded: [
        {
          right: { module: 'synthetic', name: 'view' },
          evidence: [finding('F1')],
        },
      ],
    });
  });

  it('says why an operation has no mapping, and when it needs none', async () => {
    const { data } = setup();
    const open = await data('ct_docs_get_operation', {
      operationId: 'deleteSyntheticThing',
    });
    // The reason is the project's own text and stands outside the envelope.
    expect(open['rights']).toEqual({
      status: 'open',
      needs: [],
      notNeeded: [],
      noneEvidence: [],
      reason: 'Kein Befund und keine Beschreibung nennt ein Recht.',
      note: rightsNotes.open,
    });
    expect(open['deprecated']).toBe(true);
    const none = await data('ct_docs_get_operation', {
      operationId: 'listSyntheticThings',
    });
    expect(none['rights']).toEqual({
      status: 'none',
      needs: [],
      notNeeded: [],
      noneEvidence: [finding('F1')],
      reason: null,
      note: rightsNotes.none,
    });
  });

  it('says that an operation without a mapping may still need rights', async () => {
    const facts = syntheticFacts();
    const docs = syntheticDocsIndex({
      ...facts,
      operationRights: {
        ...facts.operationRights,
        entries: facts.operationRights.entries.filter(
          (entry) => entry.operationId !== 'postSyntheticThing',
        ),
      },
    });
    const { data } = setup(docs);
    const result = await data('ct_docs_get_operation', {
      operationId: 'postSyntheticThing',
    });
    expect(result['rights']).toEqual({
      status: 'unmapped',
      needs: [],
      notNeeded: [],
      noneEvidence: [],
      reason: null,
      note: rightsNotes.unmapped,
    });
  });

  it.each([
    ['GET', '/api/synthetic/things/12', 'getSyntheticThing'],
    ['get', '/synthetic/things/{id}', 'getSyntheticThing'],
    ['GET', '/api/synthetic/things/7/members', 'getSyntheticThingMembers'],
    ['POST', '/api/synthetic/things', 'postSyntheticThing'],
    ['DELETE', '/api/synthetic/things/7', 'deleteSyntheticThing'],
  ])('finds %s %s by method and path', async (method, path, operationId) => {
    const { data } = setup();
    const result = await data('ct_docs_get_operation', { method, path });
    expect(result['operationId']).toBe(operationId);
  });

  it('names every operation when two fit a method and path', async () => {
    const facts = syntheticFacts();
    const twin = facts.operations.entries.find(
      (entry) => entry.operationId === 'getSyntheticThing',
    );
    if (twin === undefined) throw new Error('the fixture changed');
    const entries = [
      ...facts.operations.entries,
      {
        ...twin,
        operationId: 'getSyntheticThingByName',
        path: '/synthetic/things/{name}',
      },
    ].sort((a, b) => (a.operationId < b.operationId ? -1 : 1));
    const { failure } = setup(
      syntheticDocsIndex({
        ...facts,
        operations: { ...facts.operations, entries },
      }),
    );
    const error = await failure('ct_docs_get_operation', {
      method: 'GET',
      path: '/api/synthetic/things/12',
    });
    expect(error).toMatchObject({
      code: 'validation',
      message: severalOperations([
        'getSyntheticThing',
        'getSyntheticThingByName',
      ]),
    });
  });

  it.each([
    [{ operationId: 'getNothing' }, 'not_found', operationNotFound],
    [
      { method: 'PUT', path: '/api/synthetic/things/1' },
      'not_found',
      pathNotFound,
    ],
    [{ method: 'GET', path: '/api/other' }, 'not_found', pathNotFound],
    [
      { operationId: 'getSyntheticThing', method: 'GET', path: '/x' },
      'validation',
      operationAskedWrongly,
    ],
    [
      { operationId: 'getSyntheticThing', method: 'GET' },
      'validation',
      operationAskedWrongly,
    ],
    [{ method: 'GET' }, 'validation', operationAskedWrongly],
    [{ path: '/api/synthetic/things' }, 'validation', operationAskedWrongly],
    [{}, 'validation', operationAskedWrongly],
    [
      { operationId: 'getSyntheticThing', part: 2 },
      'validation',
      definitionPartOutOfRange(1),
    ],
  ])('answers %j with %s', async (input, code, message) => {
    const { failure } = setup();
    expect(await failure('ct_docs_get_operation', input)).toMatchObject({
      code,
      message,
    });
  });

  it.each([
    [{ operationId: '1bad' }],
    [{ operationId: 'a b' }],
    [{ method: 'CONNECT', path: '/api/synthetic/things' }],
    [{ method: 'GET', path: 'api/synthetic/things' }],
    [{ method: 'GET', path: '/api/synthetic things' }],
    [{ operationId: 'getSyntheticThing', part: 0 }],
    [{ operationId: 'getSyntheticThing', extra: 1 }],
  ])('refuses the input %j before the index', async (input) => {
    const { failure } = setup();
    expect((await failure('ct_docs_get_operation', input)).code).toBe(
      'validation',
    );
  });

  it('gives a long definition in parts that join to the whole', async () => {
    const facts = syntheticFacts();
    const long = (index: number) =>
      `Line ${String(index)} of a long synthetic description, with "quotes" and ä.`.repeat(
        40,
      );
    const entries = facts.operations.entries.map((entry) =>
      entry.operationId === 'listSyntheticThings'
        ? {
            ...entry,
            parameters: Array.from({ length: 20 }, (_, index) => ({
              name: `filter${String(index).padStart(2, '0')}`,
              in: 'query' as const,
              required: false,
              description: long(index),
              schema: { type: ['string' as const] },
            })),
          }
        : entry,
    );
    const docs = syntheticDocsIndex({
      ...facts,
      operations: { ...facts.operations, entries },
    });
    const { data, failure } = setup(docs);
    const first = await data('ct_docs_get_operation', {
      operationId: 'listSyntheticThings',
    });
    const parts = Number(first['parts']);
    expect(parts).toBeGreaterThan(2);
    const texts = [unwrap(first['definition'])];
    for (let part = 2; part <= parts; part += 1) {
      const next = await data('ct_docs_get_operation', {
        operationId: 'listSyntheticThings',
        part,
      });
      expect(next['part']).toBe(part);
      expect(next['rights']).toEqual(first['rights']);
      texts.push(unwrap(next['definition']));
    }
    const fact = docs.getOperation('listSyntheticThings')?.fact;
    if (fact === undefined) throw new Error('the fixture changed');
    expect(texts.join('')).toBe(renderDefinition(fact));
    expect(
      await failure('ct_docs_get_operation', {
        operationId: 'listSyntheticThings',
        part: parts + 1,
      }),
    ).toMatchObject({
      code: 'validation',
      message: definitionPartOutOfRange(parts),
    });
  });
});

describe('ct_docs_search_rights', () => {
  it('finds rights with their labels and where each label comes from', async () => {
    const { data } = setup();
    const result = await data('ct_docs_search_rights', {
      query: 'Dinge bearbeiten',
      limit: 1,
    });
    expect(result).toEqual({
      hits: [
        {
          module: 'synthetic',
          name: 'edit things',
          kind: 'list',
          label: enveloped('Dinge bearbeiten'),
          labelSource: {
            kind: 'finding',
            title: null,
            link: null,
            finding: 'F2',
            churchToolsVersion: '3.137',
            where: interfacePlace,
          },
        },
      ],
      more: true,
      source: permissionsSource,
      academy: academySource,
    });
    const view = await data('ct_docs_search_rights', {
      query: 'Mitglieder der Dinge sehen',
      limit: 1,
    });
    expect(view['hits']).toEqual([
      {
        module: 'synthetic',
        name: 'view thing members',
        kind: 'list',
        label: enveloped('Mitglieder der Dinge sehen'),
        labelSource: {
          kind: 'academy',
          title: enveloped('Rechte für Dinge'),
          link: academyLink(syntheticRightsPage),
          finding: null,
          churchToolsVersion: null,
          where: null,
        },
      },
    ]);
  });
});

describe('ct_docs_get_right', () => {
  it('names the operations that need a right, below /api', async () => {
    const { data } = setup();
    const result = await data('ct_docs_get_right', {
      module: 'synthetic',
      name: 'view things',
    });
    expect(result).toEqual({
      module: 'synthetic',
      name: 'view things',
      kind: 'list',
      label: enveloped('Dinge sehen'),
      labelSource: {
        kind: 'academy',
        title: enveloped('Rechte für Dinge'),
        link: academyLink(syntheticRightsPage),
        finding: null,
        churchToolsVersion: null,
        where: null,
      },
      pages: [
        {
          title: enveloped('Rechte für Dinge'),
          path: syntheticRightsPage,
          link: academyLink(syntheticRightsPage),
        },
      ],
      neededBy: [
        {
          operationId: 'getSyntheticThing',
          method: 'GET',
          path: '/api/synthetic/things/{thingId}',
          oneOf: [{ module: 'synthetic', name: 'view things' }],
          withoutThem: 'refused with 403',
          evidence: [finding('F1', 'necessary')],
        },
        {
          operationId: 'getSyntheticThingMembers',
          method: 'GET',
          path: '/api/synthetic/things/{thingId}/members',
          oneOf: [{ module: 'synthetic', name: 'view things' }],
          withoutThem: null,
          evidence: [finding('F1', 'necessary')],
        },
        {
          operationId: 'postSyntheticThing',
          method: 'POST',
          path: '/api/synthetic/things',
          oneOf: [
            { module: 'synthetic', name: 'edit things' },
            { module: 'synthetic', name: 'view things' },
          ],
          withoutThem: null,
          evidence: [finding('F2', 'sufficient')],
        },
      ],
      moreNeededBy: false,
      notNeededBy: [],
      moreNotNeededBy: false,
      note: rightNote,
      source: permissionsSource,
      academy: academySource,
    });
  });

  it('names the operations a finding showed do not need a right', async () => {
    const { data } = setup();
    const result = await data('ct_docs_get_right', {
      module: 'synthetic',
      name: 'view',
    });
    expect(result['neededBy']).toEqual([]);
    expect(result['notNeededBy']).toEqual([
      {
        operationId: 'getSyntheticThing',
        method: 'GET',
        path: '/api/synthetic/things/{thingId}',
        evidence: [finding('F1')],
      },
    ]);
  });

  it('names the finding of a label from the web interface', async () => {
    const { data } = setup();
    const result = await data('ct_docs_get_right', {
      module: 'synthetic',
      name: 'edit things',
    });
    expect(result['labelSource']).toEqual({
      kind: 'finding',
      title: null,
      link: null,
      finding: 'F2',
      churchToolsVersion: '3.137',
      where: interfacePlace,
    });
  });

  it.each([
    [{ module: 'synthetic', name: 'view nothing' }, 'not_found'],
    [{ module: 'other', name: 'view' }, 'not_found'],
    [{ module: 'synthetic' }, 'validation'],
    [{ module: ' synthetic', name: 'view' }, 'validation'],
    [{ module: 'synthetic', name: 'view', more: 1 }, 'validation'],
  ])('answers %j with %s', async (input, code) => {
    const { failure } = setup();
    const error = await failure('ct_docs_get_right', input);
    expect(error.code).toBe(code);
    if (code === 'not_found') expect(error.message).toBe(rightNotFound);
  });
});

describe('ct_docs_search_academy', () => {
  it('finds help pages with title, path and link', async () => {
    const { data } = setup();
    const result = await data('ct_docs_search_academy', {
      query: 'Dinge verwalten',
      limit: 1,
    });
    expect(result).toEqual({
      hits: [
        {
          title: enveloped('Dinge verwalten'),
          path: syntheticThingsPage,
          link: academyLink(syntheticThingsPage),
          section: 'synthetisch',
        },
      ],
      more: true,
      source: academySource,
    });
  });
});

describe('ct_docs_read_academy', () => {
  it('reads a help page with its title, link and text', async () => {
    const { data } = setup();
    const result = await data('ct_docs_read_academy', {
      path: syntheticThingsPage,
    });
    const page = syntheticFacts().academy.entries.find(
      (entry) => entry.path === syntheticThingsPage,
    );
    expect(result).toEqual({
      title: enveloped('Dinge verwalten'),
      path: syntheticThingsPage,
      link: academyLink(syntheticThingsPage),
      section: 'synthetisch',
      modified: '2025-06-30',
      part: 1,
      parts: 1,
      text: enveloped(page?.text ?? ''),
      source: academySource,
    });
  });

  it('gives a long page in parts that join to the whole', async () => {
    const facts = syntheticFacts();
    const text = Array.from(
      { length: 900 },
      (_, index) => `Zeile ${String(index)} einer langen Seite über Dinge.`,
    )
      // The page explains a right, so it still names it.
      .concat(['Die Liste braucht das Recht (view thing members).'])
      .join('\n');
    const docs = syntheticDocsIndex({
      ...facts,
      academy: {
        ...facts.academy,
        entries: facts.academy.entries.map((entry) =>
          entry.path === syntheticThingsPage ? { ...entry, text } : entry,
        ),
      },
    });
    const { data, failure } = setup(docs);
    const first = await data('ct_docs_read_academy', {
      path: syntheticThingsPage,
    });
    const parts = Number(first['parts']);
    expect(parts).toBeGreaterThan(1);
    const texts = [unwrap(first['text'])];
    for (let part = 2; part <= parts; part += 1) {
      const next = await data('ct_docs_read_academy', {
        path: syntheticThingsPage,
        part,
      });
      texts.push(unwrap(next['text']));
    }
    expect(texts.join('')).toBe(text);
    expect(
      await failure('ct_docs_read_academy', {
        path: syntheticThingsPage,
        part: parts + 1,
      }),
    ).toMatchObject({
      code: 'validation',
      message: academyPartOutOfRange(parts),
    });
  });

  it.each([
    [{ path: '/de/help/fehlt/' }, 'not_found'],
    [{ path: '/en/help/things/' }, 'validation'],
    [{ path: 'https://churchtools.academy/de/help/things/' }, 'validation'],
    [{ path: '/de/help/../things/' }, 'validation'],
    [{ path: syntheticThingsPage, part: 0 }, 'validation'],
  ])('answers %j with %s', async (input, code) => {
    const { failure } = setup();
    const error = await failure('ct_docs_read_academy', input);
    expect(error.code).toBe(code);
    if (code === 'not_found') expect(error.message).toBe(academyPageNotFound);
  });
});
