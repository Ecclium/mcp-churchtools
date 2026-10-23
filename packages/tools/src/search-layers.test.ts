import {
  createToolCatalog,
  createToolPipeline,
  loadConfig,
  type ToolCatalog,
  type ToolPipelineOptions,
  type ToolRequest,
} from '@ecclium/mcp-churchtools-core';
import type {
  Plugin,
  TenantAssignment,
  ToolDefinition,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  assertNoCanary,
  assertPlanted,
  createChurchToolsDouble,
  doubleOrigin,
  groupsAtHighestLevel,
  makeCanaries,
  personsAtHighestLevel,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { createCorePlugin } from './core-plugin.js';
import { groupsSearchTool } from './groups/search.js';
import { personsSearchTool } from './persons/search.js';

// The three layers of ADR 0060 for the search tools. The client reads only
// the fields of the list, the tool declares and copies only them, and the
// pipeline lets nothing through that the output schema does not declare.
// The client and the tool have tests of their own layer next to their
// code; this file holds the test of the pipeline layer alone and the test
// that sends answers at the highest security levels through all three.

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
const at = (pathname: string) => (path: string) =>
  path.split('?')[0] === pathname;

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

const setup = (catalog: ToolCatalog) => {
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
    catalog,
    audit,
    transport: double.transport,
    origin: doubleOrigin,
    requestsPerMinute: 300,
    clock: Object.freeze({ now: Object.freeze(() => 0) }),
    logging: { writer, minLevel: 'debug' },
  });
  return { double, lines, drafts, pipeline };
};

const persons = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    firstName: 'Person',
    lastName: `P${String(index + 1)}`,
  }));

const groups = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    name: `Gruppe ${String(index + 1)}`,
  }));

describe('the three layers together', () => {
  const catalog = createToolCatalog({
    core: createCorePlugin({ searchTools: true }),
    plugins: [],
    readOnly: true,
  });

  it('let no field of 51 persons at the highest level but ID and names reach result, log or audit', async () => {
    const { double, lines, drafts, pipeline } = setup(catalog);
    const answer = personsAtHighestLevel(persons(51));
    assertPlanted(JSON.parse(answer.body), answer.canaries, 'answer');
    double
      .intercept({ path: at('/api/persons'), method: 'GET' })
      .reply(200, answer.body, json);
    const outcome = await pipeline.call(
      'ct_persons_search',
      { query: 'Person' },
      request(),
    );
    expect(outcome.ok && outcome.data.persons).toEqual(persons(50));
    expect(outcome.ok && outcome.data.more).toBe(true);
    assertNoCanary(outcome, answer.canaries, 'result');
    expect(lines.length).toBeGreaterThan(0);
    assertNoCanary(lines, answer.canaries, 'log');
    expect(drafts).toHaveLength(1);
    assertNoCanary(drafts, answer.canaries, 'audit');
  });

  it('let no field of 51 groups at the highest level but ID and name reach result, log or audit', async () => {
    const { double, lines, drafts, pipeline } = setup(catalog);
    const answer = groupsAtHighestLevel(groups(51));
    assertPlanted(JSON.parse(answer.body), answer.canaries, 'answer');
    double
      .intercept({ path: at('/api/groups'), method: 'GET' })
      .reply(200, answer.body, json);
    const outcome = await pipeline.call(
      'ct_groups_search',
      { query: 'Gruppe' },
      request(),
    );
    expect(outcome.ok && outcome.data.groups).toHaveLength(50);
    expect(outcome.ok && outcome.data.more).toBe(true);
    assertNoCanary(outcome, answer.canaries, 'result');
    expect(lines.length).toBeGreaterThan(0);
    assertNoCanary(lines, answer.canaries, 'log');
    expect(drafts).toHaveLength(1);
    assertNoCanary(drafts, answer.canaries, 'audit');
  });
});

// The layer of the pipeline alone: a tool with the schemas of a search
// tool whose execute returns more than they declare, as a broken client
// and a broken tool together would. The pipeline drops every field the
// output schema does not declare.
describe('the layer of the pipeline', () => {
  const leak = makeCanaries();
  const leaky = (tool: ToolDefinition, result: unknown): Plugin => ({
    name: '@ecclium/test-search-layers',
    version: '0.0.0',
    register(host): undefined {
      host.addTool({
        ...tool,
        execute: () => Promise.resolve(result),
      });
      return undefined;
    },
  });

  it('drops every field a search for persons does not declare', async () => {
    const plugin = leaky(personsSearchTool, {
      persons: [
        {
          id: 1,
          firstName: 'Person',
          lastName: 'A',
          email: leak.email.value,
          mobile: leak.phone.value,
        },
      ],
      more: false,
      notice: null,
      total: leak.name.value,
    });
    const { lines, drafts, pipeline } = setup(
      createToolCatalog({ core: plugin, plugins: [], readOnly: true }),
    );
    const outcome = await pipeline.call(
      'ct_persons_search',
      { query: 'Person' },
      request(),
    );
    expect(outcome.ok && outcome.data).toEqual({
      persons: [{ id: 1, firstName: 'Person', lastName: 'A' }],
      more: false,
      notice: null,
    });
    assertNoCanary([outcome, lines, drafts], leak.all, 'result, log, audit');
  });

  it('drops every field a search for groups does not declare', async () => {
    const plugin = leaky(groupsSearchTool, {
      groups: [
        { id: 1, name: 'Gruppe A', information: { note: leak.name.value } },
      ],
      more: false,
      notice: null,
      meta: { total: leak.phone.value },
    });
    const { lines, drafts, pipeline } = setup(
      createToolCatalog({ core: plugin, plugins: [], readOnly: true }),
    );
    const outcome = await pipeline.call(
      'ct_groups_search',
      { query: 'Gruppe' },
      request(),
    );
    expect(outcome.ok && outcome.data.groups).toEqual([
      { id: 1, name: expect.stringContaining('Gruppe A') as unknown },
    ]);
    expect(Object.keys(outcome.ok ? outcome.data : {})).toEqual([
      'groups',
      'more',
      'notice',
    ]);
    assertNoCanary([outcome, lines, drafts], leak.all, 'result, log, audit');
  });
});

// A tool that declares less than the sensitivity special may not search:
// its result would neither wait for its audit line nor be barred from
// running unattended (ADR 0028, ADR 0060).
describe('the read access of a tool below special', () => {
  it('refuses the search with policy_denied before any request', async () => {
    const plugin: Plugin = {
      name: '@ecclium/test-search-layers',
      version: '0.0.0',
      register(host): undefined {
        host.addTool({
          ...personsSearchTool,
          meta: {
            ...personsSearchTool.meta,
            sensitivity: 'personal',
            unattended: 'policy',
          },
        });
        return undefined;
      },
    };
    const { double, lines, pipeline } = setup(
      createToolCatalog({ core: plugin, plugins: [], readOnly: true }),
    );
    const outcome = await pipeline.call(
      'ct_persons_search',
      { query: 'Person' },
      request(),
    );
    expect(!outcome.ok && outcome.error.code).toBe('policy_denied');
    expect(double.calls()).toEqual([]);
    expect(lines.join('\n')).toContain('read_search_refused');
  });
});
