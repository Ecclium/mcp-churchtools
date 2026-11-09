import { createHash } from 'node:crypto';

import { loadConfig } from '@ecclium/mcp-churchtools-core';
import {
  classify,
  defineWriteTool,
  EccliumError,
  type Plugin,
  type PluginHost,
  type ProviderInfo,
  type QuotaStore,
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
import { createFileKeyProvider } from '../keys/file-provider.js';
import { KeyMaterial } from '../keys/index.js';
import { defaultPolicy } from '../policy/check.js';
import { policyHashOf } from '../policy/hash.js';
import { pseudonymPrefix } from '../redaction/pseudonym.js';
import { createToolCatalog } from '../registry/index.js';
import { createToolPipeline, type RunCallRequest } from './pipeline.js';

// A read of a run of a routine (ADR 0033): the stages of every call in the
// mode unattended, at most the entries the input may pass on, the names of
// the persons for the report, the run in every audit line, and whether a
// failure may pass on a later try (ADR 0034).

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

const meta = {
  capability: 'read',
  domain: 'events',
  requiredRights: [],
  tier: 'free',
  sensitivity: 'personal',
  unattended: 'policy',
  routineStable: true,
} as const;

const id = () => z.number().int().nonnegative();

// What a test lets the tools do, reset before each.
const behaviour: { people: number; fail?: Error } = { people: 3 };

// Lists persons with their names, as the list of assignments does.
const peopleTool = {
  name: 'ct_test_people',
  meta,
  description,
  input: z.strictObject({ page: classify(id(), 'none').optional() }),
  output: z.object({
    page: classify(id(), 'none'),
    people: z
      .array(
        z.object({
          personId: classify(id(), 'personId'),
          firstName: classify(z.string().max(50), 'name.first'),
          lastName: classify(z.string().max(50), 'name.last'),
          note: classify(z.string().max(200), 'untrusted'),
        }),
      )
      .max(10),
    more: classify(z.boolean(), 'none'),
  }),
  execute: () => {
    if (behaviour.fail !== undefined) return Promise.reject(behaviour.fail);
    return Promise.resolve({
      page: 1,
      people: [
        {
          personId: 12,
          firstName: 'Max',
          lastName: 'Mustermann',
          note: 'Kontakt: max.mustermann@example.org',
        },
        { personId: 13, firstName: 'Erika', lastName: 'Musterfrau', note: '' },
        { personId: 14, firstName: 'Mara', lastName: 'Muster', note: '' },
      ].slice(0, behaviour.people),
      more: false,
    });
  },
} as unknown as ToolDefinition;

// Names no person and is no list.
const textTool = {
  name: 'ct_test_text',
  meta: { ...meta, domain: 'wiki', sensitivity: 'none' },
  description,
  input: z.strictObject({}),
  output: z.object({ text: classify(z.string().max(70_000), 'untrusted') }),
  execute: () =>
    Promise.resolve({
      text: behaviour.people > 3 ? 'x'.repeat(66_000) : 'Plan',
    }),
} as unknown as ToolDefinition;

// A read tool a routine may not rely on.
const unstableTool = {
  ...textTool,
  name: 'ct_test_unstable',
  meta: { ...meta, domain: 'wiki', sensitivity: 'none', routineStable: false },
} as unknown as ToolDefinition;

// A write tool, even one stable for routines, never runs in a read of a run.
const writeTool = defineWriteTool({
  name: 'ct_test_write',
  meta: {
    capability: 'write',
    domain: 'wiki',
    requiredRights: [],
    tier: 'free',
    sensitivity: 'personal',
    unattended: 'policy',
    routineStable: true,
    reversible: 'snapshot',
    replayGuard: 'baseVersion',
  },
  description,
  input: z.object({ text: classify(z.string().max(100), 'untrusted') }),
  execute: () => Promise.reject(new Error('never')),
});

const testPlugin: Plugin = {
  name: 'test-plugin',
  version: '1.0.0',
  register(host: PluginHost): undefined {
    for (const tool of [peopleTool, textTool, unstableTool, writeTool]) {
      host.addTool(tool);
    }
    return undefined;
  },
};

const provider: ProviderInfo = Object.freeze({
  vendor: 'example-vendor',
  model: 'example-model',
  hostingCountry: 'CH',
  endpointHost: 'models.example.org',
});

const runId = '0b5c4a4e-7f1d-4c39-9e43-2b5b8f1c6a10';

const request = (
  overrides: Partial<RunCallRequest> & { readonly routineId?: string } = {},
): RunCallRequest => ({
  assignment: {
    tenantId: 'default',
    actor: { kind: 'runner', id: 'runner:dienstplan-report' },
  } as unknown as TenantAssignment,
  redaction: 'strict',
  features: [],
  signal: new AbortController().signal,
  run: {
    runId,
    routineId: overrides.routineId ?? 'dienstplan-report',
    provider,
  },
  maxEntries: 60,
  ...overrides,
});

const setup = (
  options: {
    readonly ready?: boolean;
    readonly written?: boolean;
    readonly quota?: QuotaStore;
  } = {},
) => {
  behaviour.people = 3;
  delete behaviour.fail;
  const double = createChurchToolsDouble({ token });
  open.push(double);
  const catalog = createToolCatalog({
    core: examplePlugin,
    plugins: [testPlugin],
    readOnly: false,
    toolsets: new Set(['wiki', 'events'] as const),
  });
  const fileLines: string[] = [];
  const logLines: string[] = [];
  const clock = Object.freeze({
    now: Object.freeze(() => Date.UTC(2026, 10, 9, 5)),
  });
  const writer = Object.freeze({
    write: (line: string) => {
      logLines.push(line);
      return true;
    },
  });
  const audit = createAuditSink({
    writer,
    file: {
      write: (line) => {
        fileLines.push(line);
        return options.written ?? true;
      },
      ready: () => options.ready ?? true,
    },
    clock,
    isKnownTool: catalog.has,
  });
  const pipeline = createToolPipeline({
    policy: defaultPolicy,
    quota: options.quota ?? createMemoryQuotaStore(),
    catalog,
    audit,
    transport: double.transport,
    origin: doubleOrigin,
    requestsPerMinute: 300,
    clock,
    logging: { writer, minLevel: 'debug' },
    keys: createFileKeyProvider({
      current: new KeyMaterial(
        createHash('sha256').update('seed').digest('hex'),
      ),
    }),
  });
  const parse = (line: string) => JSON.parse(line) as Record<string, unknown>;
  return {
    pipeline,
    inFile: () => fileLines.map(parse),
    logs: () => logLines.map(parse),
  };
};

describe('a read of a run', () => {
  it('gives pseudonyms to the model and the names to the run, and names the run in the audit', async () => {
    const { pipeline, inFile, logs } = setup();
    const outcome = await pipeline.callForRun('ct_test_people', {}, request());
    if (!outcome.ok) throw new Error('the read failed');
    const people = outcome.data['people'] as {
      personId: string;
      lastName: string;
      note: string;
    }[];
    const [first] = people;
    expect(first?.personId.startsWith(pseudonymPrefix)).toBe(true);
    expect(first?.lastName).toBe('M.');
    expect(JSON.stringify(outcome.data)).not.toContain('max.mustermann');
    expect(outcome.entries).toBe(3);
    expect(outcome.more).toBe(false);
    expect(outcome.persons).toEqual(
      Object.fromEntries([
        [people[0]?.personId, 'Max Mustermann'],
        [people[1]?.personId, 'Erika Musterfrau'],
        [people[2]?.personId, 'Mara Muster'],
      ]),
    );
    const [line] = inFile();
    expect(line).toMatchObject({
      type: 'tool_call',
      mode: 'unattended',
      actor: { kind: 'runner', id: 'runner:dienstplan-report' },
      tool: 'ct_test_people',
      outcome: 'ok',
      runId,
      routineId: 'dienstplan-report',
      policyHash: policyHashOf(defaultPolicy),
      provider,
    });
    expect(line?.['objectRefs']).toEqual([
      'person:12',
      'person:13',
      'person:14',
    ]);
    expect(logs().some((entry) => entry['runId'] === runId)).toBe(true);
  });

  it('gives IDs in the level standard and the names by ID', async () => {
    const { pipeline } = setup();
    const outcome = await pipeline.callForRun(
      'ct_test_people',
      {},
      request({ redaction: 'standard' }),
    );
    if (!outcome.ok) throw new Error('the read failed');
    expect(outcome.persons).toEqual({
      '12': 'Max Mustermann',
      '13': 'Erika Musterfrau',
      '14': 'Mara Muster',
    });
    const [first] = outcome.data['people'] as { lastName: string }[];
    expect(first?.lastName).toBe('Mustermann');
  });

  it('passes on at most the entries of its input and says that more follow', async () => {
    const { pipeline, inFile } = setup();
    const outcome = await pipeline.callForRun(
      'ct_test_people',
      {},
      request({ maxEntries: 1, redaction: 'standard' }),
    );
    if (!outcome.ok) throw new Error('the read failed');
    expect(outcome.entries).toBe(1);
    expect(outcome.more).toBe(true);
    expect(outcome.data['more']).toBe(true);
    expect(outcome.data['people']).toHaveLength(1);
    expect(Object.keys(outcome.persons)).toEqual(['12']);
    // The audit names the entries that went on, not those left behind.
    expect(inFile()[0]?.['objectRefs']).toEqual(['person:12']);
  });

  it('reads a result without a list as one entry and leaves a model out of the line without one', async () => {
    const { pipeline, inFile } = setup();
    const outcome = await pipeline.callForRun(
      'ct_test_text',
      {},
      request({ run: { runId, routineId: 'wiki-hygiene' } }),
    );
    expect(outcome).toMatchObject({ ok: true, entries: 1, persons: {} });
    expect(inFile()[0]).toMatchObject({ routineId: 'wiki-hygiene', runId });
    expect(inFile()[0]).not.toHaveProperty('provider');
  });

  it('refuses a tool that is not stable for routines and every write tool', async () => {
    const { pipeline, inFile } = setup();
    for (const name of ['ct_test_unstable', 'ct_test_write']) {
      await expect(
        pipeline.callForRun(name, { text: 'Plan' }, request()),
      ).resolves.toEqual({
        ok: false,
        code: 'policy_denied',
        transient: false,
      });
    }
    expect(inFile().map((line) => line['outcome'])).toEqual([
      'denied',
      'denied',
    ]);
  });

  it('ends a request the composition root built wrong as internal', async () => {
    const { pipeline } = setup();
    const internal = { ok: false, code: 'internal', transient: false };
    for (const wrong of [
      request({ redaction: 'off' as 'strict' }),
      request({ maxEntries: 0 }),
      request({ maxEntries: 1.5 }),
      request({ routineId: 'Dienstplan' }),
      request({ routineId: 7 as unknown as string }),
      request({ run: { runId: 'not-a-uuid', routineId: 'dienstplan-report' } }),
    ]) {
      await expect(
        pipeline.callForRun('ct_test_text', {}, wrong),
      ).resolves.toEqual(internal);
    }
    await expect(
      pipeline.callForRun(
        'ct_test_text',
        {},
        null as unknown as RunCallRequest,
      ),
    ).resolves.toEqual(internal);
  });

  it('tells a failure that may pass from one that will not', async () => {
    const { pipeline } = setup();
    await expect(
      pipeline.callForRun('ct_test_none', {}, request()),
    ).resolves.toEqual({ ok: false, code: 'not_found', transient: false });
    await expect(
      pipeline.callForRun('ct_test_people', { page: -1 }, request()),
    ).resolves.toEqual({ ok: false, code: 'validation', transient: false });
    for (const code of ['upstream', 'network', 'rate_limited'] as const) {
      behaviour.fail = new EccliumError(code);
      await expect(
        pipeline.callForRun('ct_test_people', {}, request()),
      ).resolves.toEqual({ ok: false, code, transient: true });
    }
    behaviour.fail = new EccliumError('permission');
    await expect(
      pipeline.callForRun('ct_test_people', {}, request()),
    ).resolves.toEqual({ ok: false, code: 'permission', transient: false });
    // The same read gives the same size, however often it is tried.
    delete behaviour.fail;
    behaviour.people = 4;
    await expect(
      pipeline.callForRun('ct_test_text', {}, request()),
    ).resolves.toEqual({ ok: false, code: 'upstream', transient: false });
  });

  it('may try again when the audit file or the store of quotas cannot take the call', async () => {
    const notReady = setup({ ready: false });
    await expect(
      notReady.pipeline.callForRun('ct_test_people', {}, request()),
    ).resolves.toEqual({ ok: false, code: 'policy_denied', transient: true });

    const notWritten = setup({ written: false });
    await expect(
      notWritten.pipeline.callForRun('ct_test_people', {}, request()),
    ).resolves.toEqual({ ok: false, code: 'policy_denied', transient: true });

    const failing = setup({
      quota: {
        ...createMemoryQuotaStore(),
        increment: () => Promise.reject(new Error('store down')),
      },
    });
    await expect(
      failing.pipeline.callForRun('ct_test_people', {}, request()),
    ).resolves.toEqual({ ok: false, code: 'policy_denied', transient: true });
  });

  it('ends for good when the read budget of the day is used up', async () => {
    const exhausted = setup({
      quota: {
        ...createMemoryQuotaStore(),
        increment: () =>
          Promise.resolve(defaultPolicy.interactive.readBudgetPerDay + 1),
      },
    });
    await expect(
      exhausted.pipeline.callForRun('ct_test_people', {}, request()),
    ).resolves.toEqual({ ok: false, code: 'policy_denied', transient: false });
  });
});
