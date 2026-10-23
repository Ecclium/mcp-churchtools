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
  doubleOrigin,
  makeCanaries,
  makeCanary,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { createCorePlugin } from '../core-plugin.js';
import {
  morePersonsMatched,
  noPersonMatched,
  personsSearchTool,
} from './search.js';

// ct_persons_search runs through the pipeline of the core on the double of
// ChurchTools, as the server runs it: catalog, gate with the audit file,
// input check, read access, output check, redaction and audit. The fakes of
// audit sink and line writer stand for the audit file the start opens.

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
const atPersons = (path: string): boolean =>
  path.split('?')[0] === '/api/persons';

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

const setup = (fileReady = true) => {
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
    ready: () => fileReady,
    failures: () => 0,
  });
  const pipeline = createToolPipeline({
    catalog: createToolCatalog({
      core: createCorePlugin({ searchTools: true }),
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
      .intercept({ path: atPersons, method: 'GET' })
      .reply(200, JSON.stringify({ data, meta: { count: 0 } }), json);
  };
  const call = (input: unknown) =>
    pipeline.call('ct_persons_search', input, request());
  return { double, lines, drafts, answer, call };
};

const persons = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    firstName: 'Person',
    lastName: `P${String(index + 1)}`,
  }));

describe('ct_persons_search', () => {
  it('returns ID and names of each person, without the data envelope', async () => {
    const { double, answer, call } = setup();
    answer(persons(2));
    const outcome = await call({ query: '  Person ' });
    expect(outcome.ok && outcome.data).toEqual({
      persons: persons(2),
      more: false,
      notice: null,
    });
    expect(double.calls()[0]?.searchParams).toEqual({
      query: 'Person',
      page: '1',
      limit: '51',
    });
  });

  it('lists 50 persons and says that more matched for 51', async () => {
    const { answer, call } = setup();
    answer(persons(51));
    const outcome = await call({ query: 'Person' });
    expect(outcome.ok && outcome.data).toEqual({
      persons: persons(50),
      more: true,
      notice: morePersonsMatched,
    });
  });

  it('names the right for an empty result, since ChurchTools hides a missing one', async () => {
    const { answer, call } = setup();
    answer([]);
    const outcome = await call({ query: 'Person' });
    expect(outcome.ok && outcome.data).toEqual({
      persons: [],
      more: false,
      notice: noPersonMatched,
    });
    expect(noPersonMatched).toContain('"view alldata" in churchdb');
    expect(noPersonMatched).toContain('no match and a missing right');
  });

  it.each([
    ['an empty term', { query: '' }],
    ['a term of spaces', { query: '   ' }],
    ['a term of 101 characters', { query: 'a'.repeat(101) }],
    ['a term with a control character', { query: 'Person\u0000A' }],
    ['a term with a lone surrogate', { query: 'a\uD800' }],
    ['no term', {}],
    ['an argument the model made up', { query: 'Person', limit: 500 }],
    ['a term that is no string', { query: 1 }],
  ])('refuses %s with validation, before any request', async (_, input) => {
    const { double, call } = setup();
    const outcome = await call(input);
    expect(!outcome.ok && outcome.error.code).toBe('validation');
    expect(double.calls()).toEqual([]);
  });

  it('does not run without a ready audit file, before any request', async () => {
    const { double, drafts, call } = setup(false);
    const outcome = await call({ query: 'Person' });
    expect(!outcome.ok && outcome.error.code).toBe('policy_denied');
    expect(double.calls()).toEqual([]);
    expect(drafts).toEqual([
      expect.objectContaining({
        tool: 'ct_persons_search',
        outcome: 'denied',
      }),
    ]);
  });

  it('keeps the search term and the names out of log and audit', async () => {
    const { double, lines, drafts, answer, call } = setup();
    const term = makeCanary('name');
    const [firstName = '', lastName = ''] = canary.name.cores;
    answer([{ id: 7, firstName, lastName }]);
    const outcome = await call({ query: term.value });
    // The term reached ChurchTools and the names the result, so the checks
    // below prove something.
    assertPlanted(double.calls(), [term], 'request');
    expect(outcome.ok && outcome.data.persons).toEqual([
      { id: 7, firstName, lastName },
    ]);
    expect(lines.length).toBeGreaterThan(0);
    expect(drafts).toEqual([
      expect.objectContaining({ tool: 'ct_persons_search', outcome: 'ok' }),
    ]);
    assertNoCanary(
      [lines, drafts],
      [term, canary.name, canary.token],
      'log and audit',
    );
  });
});

// The layer of the tool (ADR 0060), without client and pipeline: whatever
// the read access hands it, the tool passes on only ID and names.
describe('the layer of the tool', () => {
  it('copies only ID and names from each hit', async () => {
    const leak = makeCanaries();
    const hit = {
      id: 3,
      firstName: 'Person',
      lastName: 'C',
      email: leak.email.value,
      mobile: leak.phone.value,
      note: leak.name.value,
    };
    const read = {
      searchPersons: (query: string) => {
        expect(query).toBe('Person');
        return Promise.resolve({ hits: [hit], more: false });
      },
    } as unknown as ReadApi;
    const result = await personsSearchTool.execute({
      ctx: {} as TenantContext,
      input: { query: ' Person ' },
      read,
    });
    expect(result).toEqual({
      persons: [{ id: 3, firstName: 'Person', lastName: 'C' }],
      more: false,
      notice: null,
    });
    assertNoCanary(result, leak.all, 'result of the tool');
  });

  it('declares exactly ID and names in its output, each with its class', () => {
    const catalog = createToolCatalog({
      core: createCorePlugin({ searchTools: true }),
      plugins: [],
      readOnly: true,
    });
    const root = catalog.get('ct_persons_search')?.shape.root;
    expect(Object.keys(root?.fields ?? {})).toEqual([
      'persons',
      'more',
      'notice',
    ]);
    const list = root?.fields.persons;
    const entry = list?.kind === 'array' ? list.element : undefined;
    const fields = entry?.kind === 'object' ? entry.fields : {};
    expect(Object.keys(fields)).toEqual(['id', 'firstName', 'lastName']);
    expect(fields).toMatchObject({
      id: { kind: 'leaf', dataClass: 'personId' },
      firstName: { kind: 'leaf', dataClass: 'name.first' },
      lastName: { kind: 'leaf', dataClass: 'name.last' },
    });
  });
});
