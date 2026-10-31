import { loadConfig } from '@ecclium/mcp-churchtools-core';
import {
  classify,
  EccliumError,
  type Plugin,
  type PluginHost,
  type ReadApi,
  refersTo,
  type TenantAssignment,
  type ToolDefinition,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  createChurchToolsDouble,
  createMemoryQuotaStore,
  doubleOrigin,
  examplePlugin,
  makeCanary,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createAuditSink } from '../audit/index.js';
import {
  type CatalogEntry,
  createToolCatalog,
  type ToolCatalog,
} from '../registry/index.js';
import { createToolPipeline, type ToolRequest } from './pipeline.js';

// The IDs of a call in its audit line (ADR 0028): those the input asks for,
// then those a read of the escape hatch asks for, then the persons and
// groups the result names, each once, at most 100, derived from the
// schemas and the checked request, never from the code of the tool. They
// stand only in the audit file, never in the copy on stderr.

const loaded = loadConfig({
  environment: {
    ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
    ECCLIUM_CHURCHTOOLS_TOKEN: makeCanary('token').value,
  },
  transport: 'stdio',
});
if (!loaded.ok) throw new Error('the configuration of the test is invalid');
const token = loaded.config.churchtoolsToken;

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
});

const description = {
  purpose: 'Serves a test.',
  useWhen: 'A test needs it.',
  avoidWhen: 'Anything else.',
  limits: 'None.',
};

const meta = (domain: 'wiki' | 'api') => ({
  capability: 'read',
  domain,
  requiredRights: [],
  tier: 'free',
  sensitivity: 'special',
  unattended: 'never',
  routineStable: false,
});

const id = () => z.number().int().nonnegative();

// Names a person and an event in its input, and as many members with a
// person and a group as the input asks for in its result.
const refsTool: ToolDefinition = {
  name: 'ct_test_refs',
  meta: meta('wiki'),
  description,
  input: z.strictObject({
    personId: classify(id(), 'personId'),
    eventId: refersTo(id(), 'event').optional(),
    count: classify(z.number().int().min(0).max(200), 'none').optional(),
    fail: classify(z.enum(['error', 'output']), 'none').optional(),
  }),
  output: z.object({
    members: z
      .array(
        z.object({
          personId: classify(id(), 'personId'),
          groupId: classify(id(), 'groupId').nullable(),
        }),
      )
      .max(200),
  }),
  execute: ({ input }: { readonly input: unknown }) => {
    const {
      personId,
      count = 2,
      fail,
    } = input as {
      personId: number;
      count?: number;
      fail?: string;
    };
    if (fail === 'error') return Promise.reject(new EccliumError('upstream'));
    if (fail === 'output') return Promise.resolve({ members: 'none' } as never);
    return Promise.resolve({
      members: [
        { personId, groupId: null },
        ...Array.from({ length: count }, (_, index) => ({
          personId: 1000 + index,
          groupId: 6,
        })),
      ],
    });
  },
} as unknown as ToolDefinition;

// Reads persons by their IDs through the escape hatch.
const apiTool: ToolDefinition = {
  name: 'ct_test_api',
  meta: meta('api'),
  description,
  input: z.strictObject({}),
  output: z.object({ text: classify(z.string().max(1000), 'none') }),
  execute: async ({ read }: { readonly read: ReadApi }) => {
    const result = await read.operation({
      operationId: 'get-persons',
      query: { 'ids[]': [7, 8], 'status_ids[]': [1] },
    });
    return { text: result.json };
  },
} as unknown as ToolDefinition;

// Takes the GUID of a page and names a group by a text, which a plugin
// could fill with anything. The ID of a person must be a number (ADR 0069).
const badIdsTool: ToolDefinition = {
  name: 'ct_test_bad_ids',
  meta: meta('wiki'),
  description,
  input: z.strictObject({
    guid: refersTo(z.string().max(100), 'wiki_page'),
    owner: classify(z.string().max(50), 'none'),
  }),
  output: z.object({ owner: classify(z.string().max(50), 'groupId') }),
  execute: ({ input }: { readonly input: unknown }) =>
    Promise.resolve({ owner: (input as { owner: string }).owner }),
} as unknown as ToolDefinition;

// Reads the members of a group through the escape hatch and asks for 100
// persons, so that the call names 101 IDs.
const apiManyTool: ToolDefinition = {
  name: 'ct_test_api_many',
  meta: meta('api'),
  description,
  input: z.strictObject({}),
  output: z.object({ text: classify(z.string().max(1000), 'none') }),
  execute: async ({ read }: { readonly read: ReadApi }) => {
    const result = await read.operation({
      operationId: 'get-groups-id-members',
      path: { groupId: 3 },
      query: {
        'person_id[]': Array.from({ length: 100 }, (_, index) => index + 1),
      },
    });
    return { text: result.json };
  },
} as unknown as ToolDefinition;

// Its input has a check that throws on every value: a call the gate
// refuses fits no schema the walk of the IDs could read.
const throwingTool: ToolDefinition = {
  name: 'ct_test_throwing',
  meta: meta('wiki'),
  description,
  input: z.strictObject({
    query: classify(
      z.string().refine(() => {
        throw new Error('check');
      }),
      'none',
    ),
  }),
  output: z.object({ text: classify(z.string(), 'none') }),
  execute: () => Promise.resolve({ text: 'x' }),
} as unknown as ToolDefinition;

const testPlugin: Plugin = {
  name: 'test-plugin',
  version: '1.0.0',
  register(host: PluginHost): undefined {
    host.addTool(refsTool);
    host.addTool(apiTool);
    host.addTool(throwingTool);
    host.addTool(badIdsTool);
    host.addTool(apiManyTool);
    return undefined;
  },
};

const request = (mode: ToolRequest['mode'] = 'interactive'): ToolRequest => ({
  assignment: {
    tenantId: 'default',
    actor: { kind: 'user', id: 'stdio:local-stdio' },
  } as unknown as TenantAssignment,
  mode,
  redaction: 'standard',
  readOnly: true,
  features: [],
  signal: new AbortController().signal,
});

const json = { headers: { 'content-type': 'application/json' } };

const setup = (
  options: {
    readonly adjust?: (catalog: ToolCatalog) => ToolCatalog;
    readonly sinkClock?: { readonly now: () => number };
  } = {},
) => {
  const double = createChurchToolsDouble({ token });
  open.push(double);
  const built = createToolCatalog({
    core: examplePlugin,
    plugins: [testPlugin],
    readOnly: true,
    toolsets: new Set(['wiki', 'api'] as const),
  });
  const catalog = options.adjust?.(built) ?? built;
  const fileLines: string[] = [];
  const stderr: string[] = [];
  const clock = Object.freeze({ now: Object.freeze(() => 1_000) });
  const audit = createAuditSink({
    writer: {
      write: (line) => {
        stderr.push(line);
        return true;
      },
    },
    file: {
      write: (line) => {
        fileLines.push(line);
        return true;
      },
      ready: () => true,
    },
    clock: options.sinkClock ?? clock,
    isKnownTool: catalog.has,
  });
  const pipeline = createToolPipeline({
    quota: createMemoryQuotaStore(),
    catalog,
    audit,
    transport: double.transport,
    origin: doubleOrigin,
    requestsPerMinute: 300,
    clock,
    logging: {
      writer: Object.freeze({
        write: (line: string) => {
          stderr.push(line);
          return true;
        },
      }),
      minLevel: 'debug',
    },
  });
  const parse = (line: string) => JSON.parse(line) as Record<string, unknown>;
  return {
    double,
    call: (name: string, input: unknown, mode?: ToolRequest['mode']) =>
      pipeline.call(name, input, request(mode)),
    inFile: () => fileLines.map(parse),
    stderr: () => stderr.join('\n'),
    copies: () =>
      stderr.filter((line) => line.startsWith('{"v":1,')).map(parse),
  };
};

describe('the IDs of a call', () => {
  it('stand in the file, those of the input first, and never on stderr', async () => {
    const { call, inFile, copies, stderr } = setup();
    const outcome = await call('ct_test_refs', { personId: 5, eventId: 9 });
    expect(outcome.ok).toBe(true);
    const [line] = inFile();
    expect(line).toMatchObject({
      tool: 'ct_test_refs',
      outcome: 'ok',
      objectRefs: [
        'person:5',
        'event:9',
        'person:1000',
        'group:6',
        'person:1001',
      ],
    });
    expect(line).not.toHaveProperty('objectRefsOmitted');
    expect(copies()).toMatchObject([{ outcome: 'ok', objectRefs: [] }]);
    expect(stderr()).not.toMatch(/person:|group:|event:/u);
  });

  it('come once each, also when input and result name the same person', async () => {
    const { call, inFile } = setup();
    await call('ct_test_refs', { personId: 1000, count: 1 });
    expect(inFile()[0]?.['objectRefs']).toEqual(['person:1000', 'group:6']);
  });

  it('are the first 100, with the count of the others', async () => {
    const { call, inFile } = setup();
    expect((await call('ct_test_refs', { personId: 5, count: 120 })).ok).toBe(
      true,
    );
    const [line] = inFile();
    const refs = line?.['objectRefs'] as string[];
    expect(refs).toHaveLength(100);
    expect(refs.slice(0, 3)).toEqual(['person:5', 'person:1000', 'group:6']);
    // 1 + 120 persons and one group, 100 of them in the line.
    expect(line?.['objectRefsOmitted']).toBe(22);
  });

  it('are those of the input for a call the gate refuses, if the input fits', async () => {
    const { call, inFile } = setup();
    await call('ct_test_refs', { personId: 5, eventId: 9 }, 'unattended');
    await call('ct_test_refs', { personId: 'Max' }, 'unattended');
    expect(inFile()).toMatchObject([
      {
        outcome: 'denied',
        errorCode: 'policy_denied',
        objectRefs: ['person:5', 'event:9'],
      },
      { outcome: 'denied', objectRefs: [] },
    ]);
  });

  it('are none for an input that does not fit', async () => {
    const { call, inFile } = setup();
    await call('ct_test_refs', { personId: 5, extra: 1 });
    await call('ct_test_refs', 'no object');
    expect(inFile()).toMatchObject([
      { errorCode: 'validation', objectRefs: [] },
      { errorCode: 'validation', objectRefs: [] },
    ]);
  });

  it('are those of the input for a call that fails or returns a wrong result', async () => {
    const { call, inFile } = setup();
    await call('ct_test_refs', { personId: 5, fail: 'error' });
    await call('ct_test_refs', { personId: 5, fail: 'output' });
    expect(inFile()).toMatchObject([
      { errorCode: 'upstream', objectRefs: ['person:5'] },
      { errorCode: 'internal', objectRefs: ['person:5'] },
    ]);
  });

  it('cost a refused call neither its line nor its outcome when the input cannot be read', async () => {
    const { call, inFile } = setup();
    const outcome = await call(
      'ct_test_throwing',
      { query: 'a' },
      'unattended',
    );
    expect(!outcome.ok && outcome.error.code).toBe('policy_denied');
    expect(inFile()).toMatchObject([
      { outcome: 'denied', errorCode: 'policy_denied', objectRefs: [] },
    ]);
  });

  it('keep a call with an ID the audit could not name from ChurchTools and its result in the server', async () => {
    const { call, inFile } = setup();
    const guid = 'A1B2C3D4-0000-4000-8000-000000000001';
    const refused = await call('ct_test_bad_ids', { guid: 'Max', owner: '1' });
    expect(!refused.ok && refused.error.code).toBe('validation');
    const kept = await call('ct_test_bad_ids', { guid, owner: 'Max' });
    expect(!kept.ok && kept.error.code).toBe('internal');
    const named = await call('ct_test_bad_ids', { guid, owner: '12' });
    expect(named.ok).toBe(true);
    expect(inFile()).toMatchObject([
      { errorCode: 'validation', objectRefs: [] },
      {
        errorCode: 'internal',
        objectRefs: [`wiki_page:${guid.toLowerCase()}`],
      },
      {
        outcome: 'ok',
        objectRefs: [`wiki_page:${guid.toLowerCase()}`, 'group:12'],
      },
    ]);
  });

  it('are the first 100 of a read of the escape hatch, with the count of the others', async () => {
    const { call, double, inFile } = setup();
    double
      .intercept({
        path: (path: string) => path.split('?')[0] === '/api/groups/3/members',
        method: 'GET',
      })
      .reply(200, { data: [] }, json);
    expect((await call('ct_test_api_many', {})).ok).toBe(true);
    const [line] = inFile();
    const refs = line?.['objectRefs'] as string[];
    expect(refs).toHaveLength(100);
    expect(refs.slice(0, 2)).toEqual(['group:3', 'person:1']);
    expect(line?.['objectRefsOmitted']).toBe(1);
  });

  it('are none for an unknown tool', async () => {
    const { call, inFile } = setup();
    await call('ct_test_unknown', { personId: 5 });
    expect(inFile()).toMatchObject([{ tool: 'ct_unknown', objectRefs: [] }]);
  });

  it('are those a read of the escape hatch asks for, from the checked request', async () => {
    const { call, double, inFile } = setup();
    double
      .intercept({
        path: (path: string) => path.split('?')[0] === '/api/persons',
        method: 'GET',
      })
      .reply(200, { data: [] }, json);
    expect((await call('ct_test_api', {})).ok).toBe(true);
    expect(inFile()).toMatchObject([
      { tool: 'ct_test_api', objectRefs: ['person:7', 'person:8'] },
    ]);
  });

  it('stay with the mark in the file when the result is held back after the read', async () => {
    let calls = 0;
    const { call, inFile, copies } = setup({
      sinkClock: {
        now: () => {
          calls += 1;
          throw new Error('clock');
        },
      },
    });
    const outcome = await call('ct_test_refs', { personId: 5, count: 0 });
    expect(calls).toBeGreaterThan(0);
    expect(!outcome.ok && outcome.error.code).toBe('policy_denied');
    expect(inFile()).toMatchObject([
      {
        outcome: 'denied',
        errorCode: 'policy_denied',
        withheldAfterRead: true,
        objectRefs: ['person:5'],
      },
    ]);
    expect(copies()[0]).not.toHaveProperty('withheldAfterRead');
    expect(copies()[0]?.['objectRefs']).toEqual([]);
  });

  it('keep a result in the server when they cannot be derived', async () => {
    // A shape that the check of the IDs and the redaction read as it is
    // and the walk of the IDs for the audit reads broken: the third read
    // gives a list where the result is an object, which no loop can walk.
    let reads = 0;
    const adjust = (catalog: ToolCatalog): ToolCatalog => {
      const entry = catalog.get('ct_test_refs') as CatalogEntry;
      const broken = Object.freeze({
        root: Object.freeze({
          kind: 'array',
          optional: false,
          nullable: false,
          element: Object.freeze({
            kind: 'leaf',
            dataClass: 'personId',
            types: ['number'],
            optional: false,
            nullable: false,
          }),
        }),
      });
      const changed = Object.create(null) as Record<string, unknown>;
      for (const [key, value] of Object.entries(entry)) changed[key] = value;
      Object.defineProperty(changed, 'shape', {
        get: () => {
          reads += 1;
          return reads <= 2 ? entry.shape : broken;
        },
      });
      return Object.freeze({
        ...catalog,
        get: (name: string) =>
          name === 'ct_test_refs'
            ? (changed as unknown as CatalogEntry)
            : catalog.get(name),
      });
    };
    const { call, inFile } = setup({ adjust });
    const outcome = await call('ct_test_refs', { personId: 5 });
    expect(reads).toBe(3);
    expect(outcome).toMatchObject({ ok: false, error: { code: 'internal' } });
    // The IDs of the request stay, as for any call without a result.
    expect(inFile()).toMatchObject([
      { outcome: 'error', errorCode: 'internal', objectRefs: ['person:5'] },
    ]);
  });
});
