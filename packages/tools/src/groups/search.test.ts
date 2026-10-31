import {
  createToolCatalog,
  createToolPipeline,
  loadConfig,
  type ToolPipelineOptions,
  type ToolRequest,
} from '@ecclium/mcp-churchtools-core';
import type {
  ReadApi,
  TenantAssignment,
  TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  assertNoCanary,
  assertPlanted,
  createChurchToolsDouble,
  createMemoryQuotaStore,
  doubleOrigin,
  makeCanaries,
  makeCanary,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { createCorePlugin } from '../core-plugin.js';
import {
  groupsSearchTool,
  moreGroupsMatched,
  noGroupMatched,
} from './search.js';

// ct_groups_search runs through the pipeline of the core on the double of
// ChurchTools, as the server runs it. The fakes of audit sink and line
// writer stand for the audit file the start opens.

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
const atGroups = (path: string): boolean =>
  path.split('?')[0] === '/api/groups';

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
    // Tools with sensitivity special count against the read budget.
    quota: createMemoryQuotaStore(),
    catalog: createToolCatalog({
      core: createCorePlugin(),
      toolsets: new Set(['persons'] as const),
      plugins: [],
      readOnly: true,
    }),
    audit,
    transport: double.transport,
    origin: doubleOrigin,
    requestsPerMinute: 300,
    clock: Object.freeze({ now: Object.freeze(() => 0) }),
    logging: { writer, minLevel: 'debug' },
  });
  const answer = (data: unknown): void => {
    double
      .intercept({ path: atGroups, method: 'GET' })
      .reply(200, JSON.stringify({ data, meta: { count: 0 } }), json);
  };
  const call = (input: unknown) =>
    pipeline.call('ct_groups_search', input, request());
  return { double, lines, drafts, answer, call };
};

const groups = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    name: `Gruppe ${String(index + 1)}`,
  }));

// A name in the data envelope: the markers with the boundary of the call
// around the text.
const enveloped = (name: string): unknown =>
  expect.stringMatching(
    new RegExp(`^<<data-[^>]+>>${name}<</data-[^>]+>>$`, 'u'),
  ) as unknown;

describe('ct_groups_search', () => {
  it('returns ID and name of each group, the name in the data envelope', async () => {
    const { double, answer, call } = setup();
    answer(groups(2));
    const outcome = await call({ query: 'Gruppe' });
    expect(outcome.ok && outcome.data).toEqual({
      groups: [
        { id: 1, name: enveloped('Gruppe 1') },
        { id: 2, name: enveloped('Gruppe 2') },
      ],
      more: false,
      notice: null,
    });
    expect(double.calls()[0]?.path).toBe('/api/groups');
    expect(double.calls()[0]?.searchParams).toEqual({
      query: 'Gruppe',
      page: '1',
      limit: '51',
    });
  });

  it('lists 50 groups and says that more matched for 51', async () => {
    const { answer, call } = setup();
    answer(groups(51));
    const outcome = await call({ query: 'Gruppe' });
    expect(outcome.ok && outcome.data.groups).toHaveLength(50);
    expect(outcome.ok && outcome.data.more).toBe(true);
    expect(outcome.ok && outcome.data.notice).toBe(moreGroupsMatched);
  });

  it('names the right for an empty result, since ChurchTools hides a missing one', async () => {
    const { answer, call } = setup();
    answer([]);
    const outcome = await call({ query: 'Gruppe' });
    expect(outcome.ok && outcome.data).toEqual({
      groups: [],
      more: false,
      notice: noGroupMatched,
    });
    expect(noGroupMatched).toContain(
      '"view groups of grouptype" in churchgroup',
    );
  });

  it.each([
    ['an empty term', { query: '' }],
    ['a term of spaces', { query: ' \t ' }],
    ['a term with a control character', { query: 'Gruppe\u007fA' }],
    ['an argument the model made up', { query: 'Gruppe', page: 2 }],
  ])('refuses %s with validation, before any request', async (_, input) => {
    const { double, call } = setup();
    const outcome = await call(input);
    expect(!outcome.ok && outcome.error.code).toBe('validation');
    expect(double.calls()).toEqual([]);
  });

  it('keeps the search term and the names out of log and audit', async () => {
    const { double, lines, drafts, answer, call } = setup();
    const term = makeCanary('name');
    answer([{ id: 4, name: canary.name.value }]);
    const outcome = await call({ query: term.value });
    // The term reached ChurchTools and the name the result, so the checks
    // below prove something.
    assertPlanted(double.calls(), [term], 'request');
    expect(lines.length).toBeGreaterThan(0);
    expect(outcome.ok && outcome.data.groups).toEqual([
      { id: 4, name: enveloped(canary.name.value) },
    ]);
    expect(drafts).toEqual([
      expect.objectContaining({ tool: 'ct_groups_search', outcome: 'ok' }),
    ]);
    assertNoCanary([lines, drafts], [term, canary.name], 'log and audit');
  });
});

// The layer of the tool (ADR 0060), without client and pipeline: whatever
// the read access hands it, the tool passes on only ID and name.
describe('the layer of the tool', () => {
  it('copies only ID and name from each hit', async () => {
    const leak = makeCanaries();
    const hit = {
      id: 3,
      name: 'Gruppe C',
      information: { note: leak.name.value, meetingTime: leak.phone.value },
    };
    const read = {
      searchGroups: () => Promise.resolve({ hits: [hit], more: false }),
    } as unknown as ReadApi;
    const result = await groupsSearchTool.execute({
      ctx: {} as TenantContext,
      input: { query: 'Gruppe' },
      read,
    });
    expect(result).toEqual({
      groups: [{ id: 3, name: 'Gruppe C' }],
      more: false,
      notice: null,
    });
    assertNoCanary(result, leak.all, 'result of the tool');
  });

  // The tool checks the term itself, not only the client behind it.
  it('refuses a term with a control character without reading', async () => {
    let reads = 0;
    const read = {
      searchGroups: () => {
        reads += 1;
        return Promise.resolve({ hits: [], more: false });
      },
    } as unknown as ReadApi;
    await expect(
      groupsSearchTool.execute({
        ctx: {} as TenantContext,
        input: { query: 'Gruppe\u0007A' },
        read,
      }),
    ).rejects.toMatchObject({ code: 'validation' });
    expect(reads).toBe(0);
  });

  it('declares exactly ID and name in its output, each with its class', () => {
    const catalog = createToolCatalog({
      core: createCorePlugin(),
      toolsets: new Set(['persons'] as const),
      plugins: [],
      readOnly: true,
    });
    const root = catalog.get('ct_groups_search')?.shape.root;
    expect(Object.keys(root?.fields ?? {})).toEqual([
      'groups',
      'more',
      'notice',
    ]);
    const list = root?.fields.groups;
    const entry = list?.kind === 'array' ? list.element : undefined;
    const fields = entry?.kind === 'object' ? entry.fields : {};
    expect(Object.keys(fields)).toEqual(['id', 'name']);
    expect(fields).toMatchObject({
      id: { kind: 'leaf', dataClass: 'groupId' },
      name: { kind: 'leaf', dataClass: 'untrusted' },
    });
  });
});
