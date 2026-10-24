import { loadConfig } from '@ecclium/mcp-churchtools-core';
import {
  classify,
  type IsoDate,
  type Plugin,
  type PluginHost,
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
  quotaContext,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createAuditSink } from '../audit/index.js';
import { quotaTimeoutMs, specialReadBudget } from '../quota/index.js';
import { createToolCatalog } from '../registry/index.js';
import { createToolPipeline, type ToolRequest } from './pipeline.js';

// The daily read budget of the tools with sensitivity special (ADR 0063):
// one budget for all of them, per actor and UTC day, counted once the input
// is valid and before ChurchTools is asked. The store is one in memory or
// one whose answers a test sets.

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
const runs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  runs.length = 0;
  await Promise.all(open.splice(0).map((item) => item.close()));
});

const description = {
  purpose: 'Serves a test.',
  useWhen: 'A test needs it.',
  avoidWhen: 'Anything else.',
  limits: 'None.',
};

const tool = (
  name: `ct_${string}`,
  sensitivity: 'personal' | 'special',
): ToolDefinition =>
  ({
    name,
    meta: {
      capability: 'read',
      domain: 'wiki',
      requiredRights: [],
      tier: 'free',
      sensitivity,
      unattended: 'never',
      routineStable: false,
    },
    description,
    input: z.strictObject({ query: z.string().max(10) }),
    output: z.object({ text: classify(z.string(), 'none') }),
    execute: () => {
      runs.push(name);
      return Promise.resolve({ text: 'found' });
    },
  }) as unknown as ToolDefinition;

const testPlugin: Plugin = {
  name: 'test-plugin',
  version: '1.0.0',
  register(host: PluginHost): undefined {
    host.addTool(tool('ct_test_special', 'special'));
    host.addTool(tool('ct_test_other_special', 'special'));
    host.addTool(tool('ct_test_personal', 'personal'));
    return undefined;
  },
};

const requestOf = (
  id = 'stdio:local-stdio',
  signal = new AbortController().signal,
): ToolRequest => ({
  assignment: {
    tenantId: 'default',
    actor: { kind: 'user', id },
  } as unknown as TenantAssignment,
  mode: 'interactive',
  redaction: 'standard',
  readOnly: true,
  features: [],
  signal,
});

// 24.10.2026, 23:59:30 UTC.
const lateEvening = Date.UTC(2026, 9, 24, 23, 59, 30);
const day = '2026-10-24' as IsoDate;
const ctx = quotaContext('default', 'user', 'stdio:local-stdio');

const setup = (
  options: {
    readonly quota?: QuotaStore | null;
    readonly ready?: () => boolean;
  } = {},
) => {
  const double = createChurchToolsDouble({ token });
  open.push(double);
  const catalog = createToolCatalog({
    core: examplePlugin,
    plugins: [testPlugin],
    readOnly: true,
    toolsets: new Set(['wiki'] as const),
  });
  const lines: string[] = [];
  const time = { now: lateEvening };
  // The context takes only a frozen clock whose method is frozen as well.
  const clock = Object.freeze({ now: Object.freeze(() => time.now) });
  const writer = Object.freeze({
    write: (line: string) => {
      lines.push(line);
      return true;
    },
  });
  const audit = createAuditSink({
    writer,
    file: {
      write: () => true,
      ready: () => options.ready?.() ?? true,
    },
    clock,
    isKnownTool: catalog.has,
  });
  const quota =
    options.quota === null
      ? undefined
      : (options.quota ?? createMemoryQuotaStore());
  const pipeline = createToolPipeline({
    catalog,
    audit,
    transport: double.transport,
    origin: doubleOrigin,
    requestsPerMinute: 300,
    clock,
    logging: { writer, minLevel: 'debug' },
    ...(quota === undefined ? {} : { quota }),
  });
  const parse = (line: string) => JSON.parse(line) as Record<string, unknown>;
  return {
    time,
    quota,
    call: (
      name: string,
      input: unknown = { query: 'a' },
      request = requestOf(),
    ) => pipeline.call(name, input, request),
    audits: () => lines.filter((line) => line.startsWith('{"v":1,')).map(parse),
    logs: () => lines.filter((line) => !line.startsWith('{"v":1,')).map(parse),
  };
};

const exhausted = `The daily budget of ${String(specialReadBudget)} calls of tools with special personal data is used up. It resets at 00:00 UTC.`;
const unavailable =
  'The server cannot count this call against the daily read budget now, so the tool did not run. Ask the operator to check the folder of state.';

describe('the daily read budget', () => {
  it(`lets ${String(specialReadBudget)} calls of all special tools through and refuses the next until the day ends`, async () => {
    const { call, time, audits, logs } = setup();
    for (let index = 0; index < specialReadBudget; index += 1) {
      const name =
        index % 2 === 0 ? 'ct_test_special' : 'ct_test_other_special';
      expect((await call(name)).ok, String(index)).toBe(true);
    }
    expect(runs).toHaveLength(specialReadBudget);
    expect(await call('ct_test_special')).toEqual({
      ok: false,
      error: { code: 'policy_denied', message: exhausted },
    });
    expect(await call('ct_test_other_special')).toMatchObject({
      ok: false,
      error: { code: 'policy_denied', message: exhausted },
    });
    expect(runs).toHaveLength(specialReadBudget);
    // The audit line says denied, the log line why, under the same ID.
    const denied = audits().at(-1);
    expect(denied).toMatchObject({
      tool: 'ct_test_other_special',
      outcome: 'denied',
      errorCode: 'policy_denied',
    });
    const reasons = logs().filter(
      (line) => line['event'] === 'read_budget_exhausted',
    );
    expect(reasons).toHaveLength(2);
    expect(reasons.at(-1)?.['eventId']).toBe(denied?.['eventId']);
    // A new UTC day, a new budget.
    time.now = lateEvening + 60_000;
    expect((await call('ct_test_special')).ok).toBe(true);
  });

  it('keeps the budgets of two actors apart', async () => {
    const { call, quota } = setup();
    for (let index = 0; index < specialReadBudget; index += 1) {
      await quota?.increment(ctx, 'special_reads', day);
    }
    expect((await call('ct_test_special')).ok).toBe(false);
    expect(
      (await call('ct_test_special', { query: 'a' }, requestOf('stdio:other')))
        .ok,
    ).toBe(true);
  });

  it('counts no call that fails before, nor one of a tool with other data', async () => {
    let ready = false;
    const { call, quota } = setup({ ready: () => ready });
    expect((await call('ct_test_special')).ok).toBe(false);
    ready = true;
    expect((await call('ct_test_special', { query: 'a'.repeat(11) })).ok).toBe(
      false,
    );
    expect((await call('ct_test_special', { other: 1 })).ok).toBe(false);
    expect((await call('ct_test_personal')).ok).toBe(true);
    expect(await quota?.read(ctx, 'special_reads', day)).toBe(0);
    expect((await call('ct_test_special')).ok).toBe(true);
    expect(await quota?.read(ctx, 'special_reads', day)).toBe(1);
  });

  it('does not run a tool with special data without a store, but every other tool', async () => {
    const { call, logs } = setup({ quota: null });
    expect(await call('ct_test_special')).toEqual({
      ok: false,
      error: { code: 'policy_denied', message: unavailable },
    });
    expect(runs).toEqual([]);
    expect(logs().map((line) => line['event'])).toContain(
      'read_budget_unavailable',
    );
    expect((await call('ct_test_personal')).ok).toBe(true);
  });

  it.each<[string, QuotaStore['increment']]>([
    [
      'throws',
      () => {
        throw new Error('store');
      },
    ],
    ['rejects', () => Promise.reject(new Error('store'))],
    ['answers 0', () => Promise.resolve(0)],
    ['answers a fraction', () => Promise.resolve(1.5)],
    ['answers a text', () => Promise.resolve('1' as unknown as number)],
    ['answers NaN', () => Promise.resolve(Number.NaN)],
  ])('refuses the call when the store %s', async (_, increment) => {
    const { call } = setup({
      quota: { increment, read: () => Promise.resolve(0) },
    });
    expect(await call('ct_test_special')).toEqual({
      ok: false,
      error: { code: 'policy_denied', message: unavailable },
    });
    expect(runs).toEqual([]);
  });

  it('refuses the call when the store does not answer in time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { call } = setup({
      quota: {
        increment: () => new Promise<number>(() => undefined),
        read: () => Promise.resolve(0),
      },
    });
    const pending = call('ct_test_special');
    await vi.advanceTimersByTimeAsync(quotaTimeoutMs);
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: 'policy_denied', message: unavailable },
    });
    expect(runs).toEqual([]);
  });

  it('ends a call the client cancels while the store counts, before the tool runs', async () => {
    const controller = new AbortController();
    const counting: ((value: number) => void)[] = [];
    const { call } = setup({
      quota: {
        increment: () =>
          new Promise<number>((resolve) => {
            counting.push(resolve);
          }),
        read: () => Promise.resolve(0),
      },
    });
    const pending = call(
      'ct_test_special',
      { query: 'a' },
      requestOf('stdio:local-stdio', controller.signal),
    );
    await vi.waitFor(() => {
      expect(counting).toHaveLength(1);
    });
    controller.abort();
    counting[0]?.(1);
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: 'network' },
    });
    expect(runs).toEqual([]);
  });

  it('counts with the day of the clock in UTC and refuses a clock without a day', async () => {
    const { call, time, quota } = setup();
    time.now = Date.UTC(2026, 9, 25, 0, 0, 0);
    expect((await call('ct_test_special')).ok).toBe(true);
    expect(
      await quota?.read(ctx, 'special_reads', '2026-10-25' as IsoDate),
    ).toBe(1);
    time.now = Number.NaN;
    expect(await call('ct_test_special')).toMatchObject({
      ok: false,
      error: { message: unavailable },
    });
  });
});
