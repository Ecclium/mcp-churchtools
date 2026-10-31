import {
  createToolCatalog,
  createToolPipeline,
  loadConfig,
  type ToolCatalog,
  type ToolPipelineOptions,
  type ToolRequest,
  type ToolsetName,
  toolsetsOfAll,
} from '@ecclium/mcp-churchtools-core';
import type { Facts } from '@ecclium/mcp-churchtools-docs-index';
import type { TenantAssignment } from '@ecclium/mcp-churchtools-plugin-api';
import {
  createChurchToolsDouble,
  createMemoryQuotaStore,
  doubleOrigin,
  makeCanaries,
  syntheticDocsIndex,
  syntheticFacts,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { createCorePlugin } from '../core-plugin.js';
import { operationNotFound, operationRefused } from './execute-read.js';
import { defaultActionHits } from './search-actions.js';

// The two tools of the escape hatch run through the pipeline of the core
// on the double of ChurchTools, as the server runs them, with the toolset
// api (ADR 0067). The list of operations is the real catalog of the core;
// the docs index holds synthetic facts with two real IDs of it, so that
// the search finds them and shows their rights.

type AuditSink = ToolPipelineOptions['audit'];
type AuditDraft = Parameters<AuditSink['record']>[0];
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

const json = { headers: { 'content-type': 'application/json' } };

// The synthetic facts with three operations the catalog of the core knows:
// two it reads and one it excludes, with a mapping for one of them.
const facts = (): Facts => {
  const base = syntheticFacts();
  const operations = [
    ...base.operations.entries,
    {
      operationId: 'get-wiki-categories',
      method: 'get',
      path: '/wiki/categories',
      tags: ['Wiki'],
      summary: 'Get all wiki categories',
      deprecated: false,
      parameters: [],
      responses: [{ status: '200', content: [] }],
    },
    {
      operationId: 'get-groups-groupId',
      method: 'get',
      path: '/groups/{groupId}',
      tags: ['Groups'],
      summary: 'Get one group with its synthetic details',
      deprecated: false,
      parameters: [
        {
          name: 'groupId',
          in: 'path',
          required: true,
          schema: { type: ['integer'] },
        },
      ],
      responses: [{ status: '200', content: [] }],
    },
    {
      operationId: 'get-persons-birthdays',
      method: 'get',
      path: '/persons/birthdays',
      tags: ['Persons'],
      summary: 'Get the birthdays of wiki groups',
      deprecated: false,
      parameters: [],
      responses: [{ status: '200', content: [] }],
    },
  ].sort((a, b) => (a.operationId < b.operationId ? -1 : 1));
  const mapping = [
    ...base.operationRights.entries,
    {
      operationId: 'get-groups-groupId',
      needs: [
        {
          rights: [{ module: 'synthetic', name: 'view things' }],
          without: 'refused',
          evidence: [
            { kind: 'finding', id: 'F1', version: '3.137', shows: 'necessary' },
          ],
        },
      ],
    },
  ].sort((a, b) => (a.operationId < b.operationId ? -1 : 1));
  return {
    ...base,
    operations: { ...base.operations, entries: operations },
    operationRights: { ...base.operationRights, entries: mapping },
  } as unknown as Facts;
};

const request = (redaction: 'standard' | 'off' = 'standard'): ToolRequest => ({
  assignment: {
    tenantId: 'default',
    actor: { kind: 'user', id: 'stdio:local-stdio' },
  } as unknown as TenantAssignment,
  mode: 'interactive',
  redaction,
  readOnly: true,
  features: [],
  signal: new AbortController().signal,
});

const catalogOf = (toolsets: readonly ToolsetName[]): ToolCatalog =>
  createToolCatalog({
    core: createCorePlugin({ docs: syntheticDocsIndex(facts()) }),
    toolsets: new Set(toolsets),
    plugins: [],
    readOnly: true,
  });

const setup = () => {
  const double = createChurchToolsDouble({
    token: loaded.config.churchtoolsToken,
  });
  open.push(double);
  const lines: string[] = [];
  const drafts: AuditDraft[] = [];
  const writer: LineWriter = Object.freeze({
    write: (line: string) => {
      lines.push(line);
      return true;
    },
  });
  const audit: AuditSink = Object.freeze({
    record: (draft: AuditDraft) => {
      drafts.push(draft);
      return true;
    },
    hasFile: true,
    ready: () => true,
    failures: () => 0,
  });
  const pipeline = createToolPipeline({
    quota: createMemoryQuotaStore(),
    catalog: catalogOf(['api']),
    audit,
    transport: double.transport,
    origin: doubleOrigin,
    requestsPerMinute: 300,
    clock: Object.freeze({ now: Object.freeze(() => 0) }),
    logging: { writer, minLevel: 'debug' },
  });
  const call = (name: string, input: unknown, redaction?: 'standard' | 'off') =>
    pipeline.call(name, input, request(redaction));
  return { double, lines, drafts, call };
};

// The text inside the envelope of a result.
const unwrap = (value: unknown): string => {
  const text = String(value);
  const match = /^<<data-[^>]+>>([\s\S]*)<<\/data-[^>]+>>$/u.exec(text);
  if (match === null) throw new Error('not in the data envelope');
  return match[1] ?? '';
};

describe('the tools of the escape hatch', () => {
  it('are offered only with the toolset api, which all leaves out', () => {
    const names = (toolsets: readonly ToolsetName[]) =>
      catalogOf(toolsets)
        .list()
        .map((entry) => entry.name)
        .filter((name) => name.startsWith('ct_api_'));
    expect(names(['api'])).toEqual([
      'ct_api_execute_read',
      'ct_api_search_actions',
    ]);
    expect(names(toolsetsOfAll)).toEqual([]);
    expect(names(['docs'])).toEqual([]);
  });

  it('are added only with a docs index', () => {
    const catalog = createToolCatalog({
      core: createCorePlugin(),
      toolsets: new Set(['api'] as const),
      plugins: [],
      readOnly: true,
    });
    expect(catalog.has('ct_api_search_actions')).toBe(false);
    expect(catalog.has('ct_api_execute_read')).toBe(false);
  });

  it('read with the audit file and the read budget only where they pass on whole answers', () => {
    const catalog = catalogOf(['api']);
    const read = catalog.get('ct_api_execute_read');
    expect(read?.meta.sensitivity).toBe('special');
    expect(read?.meta.unattended).toBe('never');
    expect(read?.asSpecial).toBe(true);
    expect(read?.description).toContain(
      'ChurchTools rights: those of the operation, as ct_api_search_actions names them.',
    );
    const search = catalog.get('ct_api_search_actions');
    expect(search?.meta.sensitivity).toBe('none');
    expect(search?.asSpecial).toBe(false);
    expect(search?.description).toContain('ChurchTools rights: none.');
  });
});

describe('ct_api_search_actions', () => {
  it('finds only operations the escape hatch reads, with parameters and rights, without asking ChurchTools', async () => {
    const { double, call } = setup();
    const outcome = await call('ct_api_search_actions', {
      query: 'wiki groups things',
    });
    expect(outcome.ok).toBe(true);
    const data = outcome.ok
      ? (outcome.data as unknown as {
          hits: {
            operationId: string;
            path: string;
            summary: string | null;
            sensitivity: string;
            pathParameters: unknown[];
            queryParameters: { name: string }[];
            rights: { status: string; needs: unknown[] };
          }[];
          more: boolean;
          source: { license: string };
        })
      : undefined;
    const ids = data?.hits.map((hit) => hit.operationId) ?? [];
    // The birthdays and the synthetic operations rank, but the core does
    // not read them.
    expect([...ids].sort()).toEqual([
      'get-groups-groupId',
      'get-wiki-categories',
    ]);
    const group = data?.hits.find(
      (hit) => hit.operationId === 'get-groups-groupId',
    );
    expect(group?.path).toBe('/api/groups/{groupId}');
    expect(unwrap(group?.summary)).toBe(
      'Get one group with its synthetic details',
    );
    expect(group?.sensitivity).toBe('special');
    expect(group?.pathParameters).toEqual([
      {
        name: 'groupId',
        kind: 'integer',
        required: true,
        list: false,
        values: [],
      },
    ]);
    expect(group?.queryParameters.map((entry) => entry.name)).toContain(
      'include[]',
    );
    expect(group?.rights.status).toBe('needs');
    expect(group?.rights.needs).toHaveLength(1);
    expect(
      data?.hits.find((hit) => hit.operationId === 'get-wiki-categories')
        ?.rights.status,
    ).toBe('unmapped');
    expect(data?.more).toBe(false);
    expect(data?.source.license).toBe('CC BY 4.0');
    expect(double.calls()).toEqual([]);
  });

  // The birthdays rank first for these words, but the core does not read
  // them; the search ranks only among the operations it reads, so the one
  // hit asked for is a readable one (ADR 0067).
  it('ranks only among the operations the core reads, before the limit', async () => {
    const { call } = setup();
    const outcome = await call('ct_api_search_actions', {
      query: 'birthdays wiki groups',
      limit: 1,
    });
    const hits = outcome.ok
      ? (outcome.data as unknown as { hits: { operationId: string }[] }).hits
      : [];
    expect(hits).toHaveLength(1);
    expect(hits[0]?.operationId).not.toBe('get-persons-birthdays');
  });

  it('keeps to the limit and says when more matched', async () => {
    const { call } = setup();
    const outcome = await call('ct_api_search_actions', {
      query: 'wiki groups',
      limit: 1,
    });
    expect(outcome.ok && outcome.data).toMatchObject({ more: true });
    expect(
      outcome.ok && (outcome.data as unknown as { hits: unknown[] }).hits,
    ).toHaveLength(1);
    expect(defaultActionHits).toBe(5);
  });

  it.each([{ query: '' }, { query: 'wiki', limit: 11 }, { query: 'x', y: 1 }])(
    'refuses the input %j',
    async (input) => {
      const { call } = setup();
      const outcome = await call('ct_api_search_actions', input);
      expect(outcome.ok || outcome.error.code).toBe('validation');
    },
  );
});

describe('ct_api_execute_read', () => {
  it('reads an operation and returns the masked answer in the data envelope', async () => {
    const { double, call, drafts } = setup();
    double.intercept({ path: '/api/groups/12', method: 'GET' }).reply(
      200,
      JSON.stringify({
        data: { id: 12, name: 'Gruppe A', email: 'max.mustermann@example.org' },
      }),
      json,
    );
    const outcome = await call('ct_api_execute_read', {
      operationId: 'get-groups-groupId',
      path: { groupId: 12 },
    });
    expect(outcome.ok).toBe(true);
    const data = outcome.ok
      ? (outcome.data as unknown as {
          operationId: string;
          sensitivity: string;
          answer: string;
        })
      : undefined;
    expect(data?.operationId).toBe('get-groups-groupId');
    expect(data?.sensitivity).toBe('special');
    expect(JSON.parse(unwrap(data?.answer))).toEqual({
      data: { id: 12, name: 'Gruppe A', email: 'm***@example.org' },
    });
    expect(double.calls()).toHaveLength(1);
    expect(drafts.map((draft) => draft.outcome)).toEqual(['ok']);
  });

  it('passes the answer unmasked with the level off', async () => {
    const { double, call } = setup();
    double
      .intercept({ path: '/api/groups/12', method: 'GET' })
      .reply(
        200,
        JSON.stringify({ data: { email: 'max.mustermann@example.org' } }),
        json,
      );
    const outcome = await call(
      'ct_api_execute_read',
      { operationId: 'get-groups-groupId', path: { groupId: 12 } },
      'off',
    );
    expect(
      JSON.parse(
        unwrap(
          outcome.ok && (outcome.data as unknown as { answer: string }).answer,
        ),
      ),
    ).toEqual({ data: { email: 'max.mustermann@example.org' } });
  });

  it('names the mapped rights when ChurchTools refuses', async () => {
    const { double, call } = setup();
    double
      .intercept({ path: '/api/groups/12', method: 'GET' })
      .reply(403, '{}', json);
    const outcome = await call('ct_api_execute_read', {
      operationId: 'get-groups-groupId',
      path: { groupId: 12 },
    });
    expect(outcome.ok ? undefined : outcome.error).toEqual({
      code: 'permission',
      message: operationRefused,
      missingRights: [{ module: 'synthetic', right: 'view things' }],
    });
  });

  it('points to the search when ChurchTools refuses an operation without a mapping', async () => {
    const { double, call } = setup();
    double
      .intercept({ path: '/api/wiki/categories', method: 'GET' })
      .reply(403, '{}', json);
    const outcome = await call('ct_api_execute_read', {
      operationId: 'get-wiki-categories',
    });
    expect(outcome.ok ? undefined : outcome.error).toEqual({
      code: 'permission',
      message: operationRefused,
    });
  });

  it('says that the object is missing for a 404', async () => {
    const { double, call } = setup();
    double
      .intercept({ path: '/api/groups/12', method: 'GET' })
      .reply(404, '{}', json);
    const outcome = await call('ct_api_execute_read', {
      operationId: 'get-groups-groupId',
      path: { groupId: 12 },
    });
    expect(outcome.ok ? undefined : outcome.error).toEqual({
      code: 'not_found',
      message: operationNotFound,
    });
  });

  it.each([
    [
      'an excluded operation',
      { operationId: 'get-persons-birthdays' },
      'policy_denied',
    ],
    ['the CSRF token', { operationId: 'get-csrftoken' }, 'policy_denied'],
    ['an unknown operation', { operationId: 'get-nothing' }, 'validation'],
    [
      'a path that leaves the template',
      { operationId: 'get-groups-groupId', path: { groupId: '../12' } },
      'validation',
    ],
    [
      'an undeclared parameter',
      { operationId: 'get-wiki-categories', query: { login_token: 'x' } },
      'validation',
    ],
    [
      'a filter the core never sends',
      { operationId: 'get-persons', query: { birthday_after: '2000-01-01' } },
      'validation',
    ],
  ] as const)('refuses %s before any request', async (_name, input, code) => {
    const { double, call } = setup();
    const outcome = await call('ct_api_execute_read', input);
    expect(outcome.ok || outcome.error.code).toBe(code);
    expect(double.calls()).toEqual([]);
  });

  it.each([
    { operationId: 'get-wiki-categories', headers: { a: 'b' } },
    { operationId: '../wiki' },
    { operationId: 'get-wiki-categories', path: { 'a/b': 1 } },
    { operationId: 'get-wiki-categories', query: { q: { nested: 1 } } },
    {
      operationId: 'get-wiki-search',
      query: { query: 'x'.repeat(201) },
    },
  ])('refuses the input %j by its schema', async (input) => {
    const { double, call } = setup();
    const outcome = await call('ct_api_execute_read', input);
    expect(outcome.ok || outcome.error.code).toBe('validation');
    expect(double.calls()).toEqual([]);
  });

  it('ends with upstream and the hint on limit for an answer too large for one result', async () => {
    const { double, call } = setup();
    double
      .intercept({ path: '/api/wiki/categories', method: 'GET' })
      .reply(200, JSON.stringify({ data: 'x'.repeat(40_000) }), json);
    const outcome = await call('ct_api_execute_read', {
      operationId: 'get-wiki-categories',
    });
    expect(outcome.ok || outcome.error.code).toBe('upstream');
    expect(outcome.ok || outcome.error.message).toContain('limit');
  });
});
