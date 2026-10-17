import { getEventListeners } from 'node:events';

import { loadConfig } from '@ecclium/mcp-churchtools-core';
import {
  EccliumError,
  type Plugin,
  type PluginHost,
  type ReadApi,
  type TenantAssignment,
  type ToolDefinition,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  createChurchToolsDouble,
  doubleOrigin,
  examplePlugin,
  makeCanary,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createAuditSink } from '../audit/index.js';
import { fixedSentences } from '../errors/index.js';
import { createToolCatalog } from '../registry/index.js';
import { createToolPipeline, type ToolRequest } from './pipeline.js';
import { maxInputDepth, maxInputElements } from './stages.js';

// Requests go through the real transport on the ChurchTools double, which
// connects nowhere. Tokens and texts are canaries made at run time.

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

const readMeta = {
  capability: 'read',
  domain: 'base',
  requiredRights: [],
  tier: 'free',
  sensitivity: 'none',
  unattended: 'policy',
  routineStable: false,
} as const;

// A plain tool of the test, not defineTool: core and the plugin interface
// resolve different copies of zod in the workspace.
const testTool = (
  name: `ct_${string}`,
  execute: (call: { readonly read: ReadApi; readonly ctx: unknown }) => unknown,
  extra: Record<string, unknown> = {},
): ToolDefinition =>
  ({
    name,
    meta: readMeta,
    description,
    input: z.object({}),
    output: z.object({ text: z.string().max(100_000) }),
    execute,
    ...extra,
  }) as unknown as ToolDefinition;

const testPlugin = (...tools: ToolDefinition[]): Plugin => ({
  name: 'test-plugin',
  version: '1.0.0',
  register(host: PluginHost): undefined {
    for (const tool of tools) host.addTool(tool);
    return undefined;
  },
});

const assignment = {
  tenantId: 'default',
  actor: { kind: 'user', id: 'stdio:local-stdio' },
} as unknown as TenantAssignment;

const request = (extra: Partial<ToolRequest> = {}): ToolRequest => ({
  assignment,
  mode: 'interactive',
  redaction: 'standard',
  readOnly: true,
  features: [],
  signal: new AbortController().signal,
  ...extra,
});

const frozenClock = (): { readonly now: () => number } => {
  let now = 0;
  return Object.freeze({
    now: Object.freeze((): number => {
      now += 5;
      return now;
    }),
  });
};

const setup = (tools: ToolDefinition[] = [], readOnly = false) => {
  const double = createChurchToolsDouble({ token });
  open.push(double);
  const catalog = createToolCatalog({
    plugins: [examplePlugin, testPlugin(...tools)],
    readOnly,
  });
  const auditLines: string[] = [];
  const logLines: string[] = [];
  const clock = frozenClock();
  const audit = createAuditSink({
    writer: {
      write: (line: string) => {
        auditLines.push(line);
        return true;
      },
    },
    clock,
    isKnownTool: catalog.has,
  });
  const pipeline = createToolPipeline({
    catalog,
    audit,
    transport: double.transport,
    origin: doubleOrigin,
    requestsPerMinute: 300,
    clock,
    logging: {
      writer: Object.freeze({
        write: (line: string) => {
          logLines.push(line);
          return true;
        },
      }),
      minLevel: 'debug',
    },
  });
  const events = () =>
    auditLines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const logs = () =>
    logLines.map((line) => (JSON.parse(line) as { event: string }).event);
  return { double, pipeline, events, logs, auditLines, logLines };
};

describe('a call that succeeds', () => {
  it('returns the checked data, frozen, and writes one audit event', async () => {
    const { pipeline, events, logs } = setup();
    const outcome = await pipeline.call(
      'ct_example_echo',
      { email: 'max.mustermann@example.org', notes: ['a', 'b'] },
      request(),
    );
    expect(outcome).toEqual({
      ok: true,
      data: { email: 'max.mustermann@example.org', notes: ['a', 'b'] },
    });
    if (!outcome.ok) return;
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(Object.isFrozen(outcome.data)).toBe(true);
    expect(Object.getPrototypeOf(outcome.data)).toBeNull();
    expect(Object.isFrozen(outcome.data.notes)).toBe(true);
    const [event, ...rest] = events();
    expect(rest).toEqual([]);
    expect(event).toMatchObject({
      type: 'tool_call',
      tenantId: 'default',
      actor: { kind: 'user', id: 'stdio:local-stdio' },
      mode: 'interactive',
      tool: 'ct_example_echo',
      outcome: 'ok',
      objectRefs: [],
      durationMs: 5,
    });
    expect(event).not.toHaveProperty('errorCode');
    expect(logs()).toEqual(['tool_call']);
  });

  it('reads ChurchTools through the read access of the call', async () => {
    const { double, pipeline } = setup();
    double
      .intercept({
        path: '/api/whoami?only_allow_authenticated=true',
        method: 'GET',
      })
      .reply(
        200,
        JSON.stringify({
          data: {
            id: 7,
            guid: '00000000-0000-0000-0000-000000000007',
            firstName: 'Person',
            lastName: 'A',
            email: '',
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    expect(await pipeline.call('ct_example_profile', {}, request())).toEqual({
      ok: true,
      data: { id: 7, firstName: 'Person', lastName: 'A', email: null },
    });
  });

  it('drops every field the output schema does not declare', async () => {
    const { pipeline } = setup([
      testTool('ct_extra', () =>
        Promise.resolve({ text: 'kept', secret: 'dropped' }),
      ),
    ]);
    expect(await pipeline.call('ct_extra', {}, request())).toEqual({
      ok: true,
      data: { text: 'kept' },
    });
  });

  it('takes a tool that returns a value instead of a promise', async () => {
    const { pipeline } = setup([testTool('ct_sync', () => ({ text: 'x' }))]);
    expect((await pipeline.call('ct_sync', {}, request())).ok).toBe(true);
  });
});

describe('the gate', () => {
  it('refuses every write, also when the server does not only read', async () => {
    const { pipeline, events } = setup([], false);
    const outcome = await pipeline.call(
      'ct_example_note_write',
      { note: 'x' },
      request({ readOnly: false }),
    );
    expect(outcome).toEqual({
      ok: false,
      error: { code: 'policy_denied', message: fixedSentences.policy_denied },
    });
    expect(events()[0]).toMatchObject({
      outcome: 'denied',
      errorCode: 'policy_denied',
      tool: 'ct_example_note_write',
    });
  });

  it('refuses a tool that never runs unattended outside interactive mode', async () => {
    const { pipeline } = setup();
    for (const mode of ['unattended', 'operator'] as const) {
      const outcome = await pipeline.call(
        'ct_example_echo',
        {},
        request({ mode }),
      );
      expect(!outcome.ok && outcome.error.code).toBe('policy_denied');
    }
  });

  it('refuses a pro tool without a licence and runs it with one', async () => {
    let runs = 0;
    const pro = testTool(
      'ct_pro',
      () => {
        runs += 1;
        return Promise.resolve({ text: 'x' });
      },
      { meta: { ...readMeta, tier: 'pro' } },
    );
    const { pipeline, events } = setup([pro]);
    const refused = await pipeline.call('ct_pro', {}, request());
    expect(!refused.ok && refused.error.code).toBe('license_required');
    expect(events()[0]).toMatchObject({ outcome: 'denied' });
    expect(runs).toBe(0);
    const licensed = await pipeline.call(
      'ct_pro',
      {},
      request({ features: ['pro'] }),
    );
    expect(licensed.ok).toBe(true);
    expect(runs).toBe(1);
  });

  it('answers not_found for an unknown tool, audited as ct_unknown', async () => {
    const { pipeline, events, logs } = setup();
    const outcome = await pipeline.call('ct_nothing', {}, request());
    expect(!outcome.ok && outcome.error.code).toBe('not_found');
    expect(events()[0]).toMatchObject({
      tool: 'ct_unknown',
      outcome: 'error',
      errorCode: 'not_found',
    });
    expect(logs()).toEqual([]);
  });
});

describe('the input', () => {
  const nest = (levels: number): unknown => {
    let value: unknown = 'x';
    for (let level = 1; level < levels; level += 1) value = [value];
    return { notes: value };
  };

  it.each([
    ['a value that is no JSON', { email: new Date() }],
    ['a field the schema does not know', { other: 'x' }],
    ['a wrong type', { email: 1 }],
    ['no object', 'x'],
    ['too deep a value', nest(maxInputDepth + 1)],
    [
      'too many values',
      { notes: Array.from({ length: maxInputElements }, () => 'x') },
    ],
    ['an infinite number', { email: Number.POSITIVE_INFINITY }],
    ['a symbol key', { [Symbol('x')]: 'x' }],
    ['an instance of a class', { notes: [new Map()] }],
  ])('refuses %s with the fixed sentence only', async (_, input) => {
    const { pipeline } = setup();
    const outcome = await pipeline.call('ct_example_echo', input, request());
    expect(outcome).toEqual({
      ok: false,
      error: { code: 'validation', message: fixedSentences.validation },
    });
  });

  it('refuses a getter and a hole in an array without running code', async () => {
    let calls = 0;
    const withGetter = {
      get email() {
        calls += 1;
        return 'x';
      },
    };
    const holes: unknown[] = [];
    holes.length = 2;
    const { pipeline } = setup();
    for (const input of [withGetter, { notes: holes }]) {
      const outcome = await pipeline.call('ct_example_echo', input, request());
      expect(!outcome.ok && outcome.error.code).toBe('validation');
    }
    expect(calls).toBe(0);
  });

  it('takes the deepest and largest input the limits allow', async () => {
    const { pipeline } = setup([
      testTool('ct_any', () => Promise.resolve({ text: 'x' }), {
        input: z.object({ v: z.unknown() }),
      }),
    ]);
    let deep: unknown = 1;
    for (let level = 2; level < maxInputDepth; level += 1) deep = [deep];
    const wide = Array.from({ length: maxInputElements - 2 }, () => null);
    for (const v of [deep, wide, true, Object.create(null) as object]) {
      expect((await pipeline.call('ct_any', { v }, request())).ok).toBe(true);
    }
  });
});

describe('execute', () => {
  it('passes on an error of the core with its code and message', async () => {
    const { pipeline, events } = setup([
      testTool('ct_denied', () =>
        Promise.reject(
          new EccliumError('permission', 'The account may not read this.', {
            missingRights: [{ module: 'churchwiki', right: 'view' }],
          }),
        ),
      ),
    ]);
    expect(await pipeline.call('ct_denied', {}, request())).toEqual({
      ok: false,
      error: {
        code: 'permission',
        message: 'The account may not read this.',
        missingRights: [{ module: 'churchwiki', right: 'view' }],
      },
    });
    expect(events()[0]).toMatchObject({
      outcome: 'error',
      errorCode: 'permission',
    });
  });

  it('answers internal for any other error, without its message', async () => {
    const canary = makeCanary('name').value;
    const { pipeline, auditLines, logLines } = setup([
      testTool('ct_throws', () => {
        throw new Error(canary);
      }),
      testTool('ct_rejects', () => Promise.reject(new Error(canary))),
    ]);
    for (const name of ['ct_throws', 'ct_rejects']) {
      const outcome = await pipeline.call(name, {}, request());
      expect(outcome).toEqual({
        ok: false,
        error: { code: 'internal', message: fixedSentences.internal },
      });
    }
    expect(JSON.stringify([auditLines, logLines])).not.toContain(canary);
  });

  it('revokes the read access when the call ends', async () => {
    let kept: ReadApi | undefined;
    const { pipeline } = setup([
      testTool('ct_keeps', ({ read }) => {
        kept = read;
        return Promise.resolve({ text: 'x' });
      }),
    ]);
    await pipeline.call('ct_keeps', {}, request());
    const error: unknown = await kept
      ?.whoami()
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(EccliumError);
    expect((error as EccliumError).code).toBe('internal');
  });
});

describe('the output', () => {
  it('answers internal when the result does not fit the schema', async () => {
    const { pipeline, logs } = setup([
      testTool('ct_wrong', () => Promise.resolve({ text: 1 })),
    ]);
    const outcome = await pipeline.call('ct_wrong', {}, request());
    expect(!outcome.ok && outcome.error.code).toBe('internal');
    expect(logs()).toEqual(['tool_output_invalid', 'tool_call']);
  });

  it('refuses a result above 64 KiB and takes one at the limit', async () => {
    // {"text":"…"} adds 11 bytes to the text.
    const { pipeline, logs } = setup([
      testTool('ct_large', () =>
        Promise.resolve({ text: 'x'.repeat(64 * 1024 - 10) }),
      ),
      testTool('ct_limit', () =>
        Promise.resolve({ text: 'x'.repeat(64 * 1024 - 11) }),
      ),
    ]);
    const large = await pipeline.call('ct_large', {}, request());
    expect(large).toEqual({
      ok: false,
      error: {
        code: 'upstream',
        message:
          'The result is larger than 64 KiB. Narrow the request, for example with a more specific search.',
      },
    });
    expect(logs()).toContain('tool_result_too_large');
    expect((await pipeline.call('ct_limit', {}, request())).ok).toBe(true);
  });
});

describe('the signal', () => {
  it('answers network without running the tool when the request is aborted', async () => {
    let runs = 0;
    const { pipeline } = setup([
      testTool('ct_count', () => {
        runs += 1;
        return Promise.resolve({ text: 'x' });
      }),
    ]);
    const controller = new AbortController();
    controller.abort('a reason of the client');
    const outcome = await pipeline.call(
      'ct_count',
      {},
      request({ signal: controller.signal }),
    );
    expect(!outcome.ok && outcome.error.code).toBe('network');
    expect(runs).toBe(0);
  });

  it('reads aborted through the getter, not an own property', async () => {
    const { pipeline } = setup();
    const controller = new AbortController();
    controller.abort();
    Object.defineProperty(controller.signal, 'aborted', { value: false });
    const outcome = await pipeline.call(
      'ct_example_echo',
      {},
      request({ signal: controller.signal }),
    );
    expect(!outcome.ok && outcome.error.code).toBe('network');
  });

  it('ends a running call on abort, with a fixed reason, and removes its listener', async () => {
    let seenSignal: AbortSignal | undefined;
    const { pipeline } = setup([
      testTool('ct_hangs', ({ ctx }) => {
        seenSignal = (ctx as { signal: AbortSignal }).signal;
        return new Promise(() => undefined);
      }),
    ]);
    const controller = new AbortController();
    const pending = pipeline.call(
      'ct_hangs',
      {},
      request({ signal: controller.signal }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
    controller.abort('a reason of the client');
    const outcome = await pending;
    expect(!outcome.ok && outcome.error.code).toBe('network');
    expect(seenSignal?.aborted).toBe(true);
    expect(seenSignal?.reason).toBe('ecclium_call_aborted');
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('removes its listener after a call that succeeds', async () => {
    const { pipeline } = setup();
    const controller = new AbortController();
    await pipeline.call(
      'ct_example_echo',
      {},
      request({ signal: controller.signal }),
    );
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});

describe('the outermost catch', () => {
  it('answers internal when the context cannot be made', async () => {
    const { pipeline, events } = setup();
    const outcome = await pipeline.call(
      'ct_example_echo',
      {},
      request({
        assignment: {
          tenantId: 'Not A Tenant',
          actor: { kind: 'user', id: 'x' },
        } as unknown as TenantAssignment,
      }),
    );
    expect(outcome).toEqual({
      ok: false,
      error: { code: 'internal', message: fixedSentences.internal },
    });
    expect(events()[0]).toMatchObject({
      outcome: 'error',
      errorCode: 'internal',
      tool: 'ct_example_echo',
    });
  });

  it('answers internal when the request cannot be read, and still audits', async () => {
    const { pipeline, events } = setup();
    const broken = {
      ...request(),
      get mode(): never {
        throw new Error('trap');
      },
    };
    const outcome = await pipeline.call('ct_example_echo', {}, broken);
    expect(!outcome.ok && outcome.error.code).toBe('internal');
    expect(events().filter((event) => event.type === 'tool_call')).toHaveLength(
      1,
    );
  });

  it('audits with placeholders when the assignment cannot be read', async () => {
    const { pipeline, events } = setup();
    const broken = {
      ...request(),
      get assignment(): never {
        throw new Error('trap');
      },
    };
    const outcome = await pipeline.call('ct_example_echo', {}, broken);
    expect(!outcome.ok && outcome.error.code).toBe('internal');
    expect(
      events().filter((event) => event.type === 'tool_call')[0],
    ).toMatchObject({ tenantId: 'invalid', tool: 'ct_unknown' });
  });

  it('answers internal for a signal that is no AbortSignal', async () => {
    const { pipeline } = setup();
    const outcome = await pipeline.call(
      'ct_example_echo',
      {},
      request({ signal: { aborted: false } as unknown as AbortSignal }),
    );
    expect(!outcome.ok && outcome.error.code).toBe('internal');
  });

  it('keeps the outcome when audit and clock throw', async () => {
    const double = createChurchToolsDouble({ token });
    open.push(double);
    const catalog = createToolCatalog({
      plugins: [examplePlugin],
      readOnly: true,
    });
    let reads = 0;
    const pipeline = createToolPipeline({
      catalog,
      audit: {
        record: () => {
          throw new Error('audit');
        },
        failures: () => 0,
      },
      transport: double.transport,
      origin: doubleOrigin,
      requestsPerMinute: 300,
      clock: Object.freeze({
        now: Object.freeze((): number => {
          reads += 1;
          if (reads > 1) throw new Error('clock');
          return 0;
        }),
      }),
      logging: {
        writer: Object.freeze({ write: () => true }),
        minLevel: 'info',
      },
    });
    const outcome = await pipeline.call('ct_example_echo', {}, request());
    expect(outcome.ok).toBe(true);
  });
});
