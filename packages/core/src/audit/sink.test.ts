import { runInNewContext } from 'node:vm';

import type { AuditEventV1 } from '@ecclium/mcp-churchtools-plugin-api';
import { assertNoCanary, makeCanaries } from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { LineWriter } from '../logger/index.js';
import {
  type AuditDraft,
  auditEventV1Schema,
  auditLimits,
  type AuditSinkOptions,
  createAuditSink,
} from './index.js';

const firstId = 'a1b2c3d4-0000-4000-8000-000000000001';
const secondId = 'a1b2c3d4-0000-4000-8000-000000000002';
const nilId = '00000000-0000-0000-0000-000000000000';
const now = Date.parse('2026-10-13T08:00:00.000Z');

const base: AuditDraft = {
  type: 'tool_call',
  tenantId: 'demo-tenant',
  actor: { kind: 'user', id: 'stdio:local-stdio' },
  mode: 'interactive',
  tool: 'ct_group_search',
  outcome: 'ok',
  objectRefs: ['group:12'],
  durationMs: 12,
};

const baseLine =
  '{"v":1,"eventId":"a1b2c3d4-0000-4000-8000-000000000001","ts":"2026-10-13T08:00:00.000Z","type":"tool_call","tenantId":"demo-tenant","actor":{"kind":"user","id":"stdio:local-stdio"},"mode":"interactive","tool":"ct_group_search","outcome":"ok","objectRefs":["group:12"],"durationMs":12}';

interface LogLine {
  readonly event: string;
  readonly [key: string]: unknown;
}

/** A sink that writes into a list, with fixed time and IDs. */
function make(options: Partial<AuditSinkOptions> = {}): {
  readonly sink: ReturnType<typeof createAuditSink>;
  readonly lines: string[];
  readonly audit: () => string[];
  readonly logs: () => LogLine[];
  readonly toolChecks: string[];
} {
  const lines: string[] = [];
  const writer: LineWriter = {
    write: (line) => {
      lines.push(line);
      return true;
    },
  };
  const ids = [firstId, secondId];
  const toolChecks: string[] = [];
  const sink = createAuditSink({
    writer,
    clock: { now: () => now },
    isKnownTool: (name) => {
      toolChecks.push(name);
      return name === 'ct_group_search';
    },
    newId: () => ids.shift() ?? nilId,
    ...options,
  });
  return {
    sink,
    lines,
    audit: () => lines.filter((line) => line.startsWith('{"v":1,')),
    logs: () =>
      lines
        .filter((line) => !line.startsWith('{"v":1,'))
        .map((line) => JSON.parse(line) as LogLine),
    toolChecks,
  };
}

/** The one audit line, parsed. */
const event = (lines: readonly string[]): Record<string, unknown> => {
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] ?? '') as Record<string, unknown>;
};

const events = (logs: readonly LogLine[]): string[] =>
  logs.map((line) => line.event);

describe('a valid event', () => {
  it('gives exactly one line, and no log line', () => {
    const { sink, lines } = make();
    sink.record(base);
    expect(lines).toEqual([baseLine]);
    expect(auditEventV1Schema.safeParse(JSON.parse(baseLine)).success).toBe(
      true,
    );
  });

  it('is written in a fixed order, whatever the order of the draft', () => {
    const reversed = Object.fromEntries(
      Object.entries(base).reverse(),
    ) as unknown as AuditDraft;
    const { sink, lines } = make();
    sink.record(reversed);
    expect(lines).toEqual([baseLine]);
  });

  it('is written with every optional field in its place', () => {
    const { sink, lines, logs } = make();
    sink.record({
      ...base,
      runId: '0b0e9a3c-3f7e-4c62-9a55-6a1f0d2c7e11',
      routineId: 'weekly-report',
      outcome: 'error',
      confirmation: 'policy',
      policyHash: 'a'.repeat(64),
      provider: {
        vendor: 'example-ai',
        model: 'example-model-1',
        hostingCountry: 'CH',
        endpointHost: 'api.example.org',
        transferBasis: 'adequacy_decision',
      },
      pluginHashes: ['b'.repeat(64)],
      dataProtectionRegime: 'ch_dsg',
      errorCode: 'upstream',
    });
    expect(Object.keys(event(lines))).toEqual([
      'v',
      'eventId',
      'ts',
      'type',
      'tenantId',
      'actor',
      'mode',
      'runId',
      'routineId',
      'tool',
      'outcome',
      'confirmation',
      'policyHash',
      'provider',
      'pluginHashes',
      'dataProtectionRegime',
      'objectRefs',
      'errorCode',
      'durationMs',
    ]);
    expect(logs()).toEqual([]);
  });

  it('stays one bounded line at its largest', () => {
    const { sink, lines, logs } = make();
    sink.record({
      ...base,
      objectRefs: Array.from(
        { length: auditLimits.objectRefs },
        () => 'wiki_page:0b0e9a3c-3f7e-4c62-9a55-6a1f0d2c7e11',
      ),
      pluginHashes: Array.from({ length: auditLimits.pluginHashes }, () =>
        'f'.repeat(64),
      ),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.length).toBeLessThan(16_384);
    expect(logs()).toEqual([]);
  });

  it('takes the time and an ID once per record, synchronously', () => {
    let clockCalls = 0;
    let idCalls = 0;
    const { sink, audit } = make({
      clock: {
        now: () => {
          clockCalls += 1;
          return now;
        },
      },
      newId: () => {
        idCalls += 1;
        return idCalls === 1 ? firstId : secondId;
      },
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- record is a closure and works detached
    const record: (draft: AuditDraft) => unknown = sink.record;
    expect(record(base)).toBeUndefined();
    expect(audit()).toHaveLength(1);
    sink.record(base);
    expect(clockCalls).toBe(2);
    expect(idCalls).toBe(2);
    expect(audit()[1]).toContain(secondId);
  });

  it('treats an optional field set to undefined as absent', () => {
    const { sink, lines } = make();
    sink.record({ ...base, runId: undefined, provider: undefined });
    expect(lines).toEqual([baseLine]);
  });

  it('accepts a draft without prototype and a class instance', () => {
    class Draft {
      readonly type = 'tool_call';
      readonly tenantId = 'demo-tenant';
      readonly actor = { kind: 'user', id: 'stdio:local-stdio' };
      readonly mode = 'interactive';
      readonly tool = 'ct_group_search';
      readonly outcome = 'ok';
      readonly objectRefs = ['group:12'];
      readonly durationMs = 12;
    }
    const bare = Object.assign(Object.create(null) as object, base);
    for (const draft of [bare, new Draft()]) {
      const { sink, lines } = make();
      sink.record(draft as AuditDraft);
      expect(lines).toEqual([baseLine]);
    }
  });
});

describe('fields the sink sets itself', () => {
  it('overwrites v, eventId and ts and drops seq and prevHash, each reported', () => {
    const { sink, audit, logs } = make();
    sink.record({
      ...base,
      v: 2,
      eventId: secondId,
      ts: '2000-01-01T00:00:00.000Z',
      seq: 7,
      prevHash: 'a'.repeat(64),
    } as AuditDraft);
    expect(audit()).toEqual([baseLine]);
    expect(events(logs())).toEqual([
      'audit_reserved_v',
      'audit_reserved_event_id',
      'audit_reserved_ts',
      'audit_reserved_seq',
      'audit_reserved_prev_hash',
    ]);
  });
});

describe('an invalid event', () => {
  it('is written with placeholders and one log line per field, in order', () => {
    const { sink, lines } = make();
    sink.record({
      type: 'other',
      tenantId: 'Demo',
      actor: { kind: 'person', id: 'max.mustermann@example.org' },
      mode: 'admin',
      tool: 'ct_max_mustermann',
      outcome: 'maybe',
      objectRefs: ['Max Mustermann'],
      durationMs: -1,
    } as unknown as AuditDraft);
    expect(lines[0]).toBe(
      '{"v":1,"eventId":"a1b2c3d4-0000-4000-8000-000000000001","ts":"2026-10-13T08:00:00.000Z","type":"tool_call","tenantId":"invalid","actor":{"kind":"service","id":"invalid"},"mode":"unattended","tool":"ct_unknown","outcome":"error","objectRefs":[],"errorCode":"internal","durationMs":0}',
    );
    const logs = lines.slice(1).map((line) => JSON.parse(line) as LogLine);
    expect(events(logs)).toEqual([
      'audit_invalid_type',
      'audit_invalid_tenant_id',
      'audit_invalid_actor_kind',
      'audit_invalid_actor_id',
      'audit_invalid_mode',
      'audit_invalid_tool',
      'audit_invalid_outcome',
      'audit_invalid_object_refs',
      'audit_missing_error_code',
      'audit_invalid_duration_ms',
    ]);
    for (const log of logs) {
      expect(log).toMatchObject({
        level: 'error',
        eventId: firstId,
        code: 'validation',
      });
      expect(log).not.toHaveProperty('tenantId');
      expect(log).not.toHaveProperty('dropped');
    }
    expect(lines.join('\n')).not.toMatch(/mustermann|Mustermann|admin|maybe/);
  });

  it('names the valid tenant in its log lines', () => {
    const { sink, logs } = make();
    sink.record({ ...base, mode: 'admin' } as unknown as AuditDraft);
    expect(logs()).toEqual([
      {
        ts: '2026-10-13T08:00:00.000Z',
        level: 'error',
        event: 'audit_invalid_mode',
        tenantId: 'demo-tenant',
        eventId: firstId,
        code: 'validation',
      },
    ]);
  });

  it.each([
    ['upper case', 'Demo-Tenant'],
    ['a trailing line break', 'demo-tenant\n'],
    ['an underscore', 'demo_tenant'],
    ['a dot', 'demo.tenant'],
    ['a number', 7],
    ['nothing', undefined],
  ])('replaces a tenant with %s', (_what, tenantId) => {
    const { sink, audit, logs } = make();
    sink.record({ ...base, tenantId } as unknown as AuditDraft);
    expect(event(audit())['tenantId']).toBe('invalid');
    expect(events(logs())).toEqual(['audit_invalid_tenant_id']);
  });

  it('replaces a huge tenant at once', () => {
    const { sink, audit } = make();
    const started = performance.now();
    sink.record({ ...base, tenantId: `a${'b'.repeat(10_000_000)}` });
    expect(performance.now() - started).toBeLessThan(200);
    expect(event(audit())['tenantId']).toBe('invalid');
  });

  it.each([
    ['an e-mail address', { kind: 'user', id: 'max.mustermann@example.org' }],
    ['a name', { kind: 'user', id: 'Max Mustermann' }],
    ['a name after a source', { kind: 'user', id: 'stdio:max.mustermann' }],
  ])('replaces the whole actor for %s', (_what, actor) => {
    const { sink, lines } = make();
    sink.record({ ...base, actor } as AuditDraft);
    expect(event(lines.slice(0, 1))['actor']).toEqual({
      kind: 'service',
      id: 'invalid',
    });
    expect(lines.join('\n')).not.toMatch(/mustermann|Mustermann/);
  });

  it.each([
    ['null', null],
    ['a string', 'service'],
    ['an array', ['service', 'x']],
    ['a proxy', new Proxy({ kind: 'service', id: 'x' }, {})],
  ])('replaces an actor that is %s', (_what, actor) => {
    const { sink, audit, logs } = make();
    sink.record({ ...base, actor } as unknown as AuditDraft);
    expect(event(audit())['actor']).toEqual({ kind: 'service', id: 'invalid' });
    expect(events(logs())[0]).toMatch(/^audit_invalid_actor/);
  });

  it('keeps an error code only where the outcome needs one', () => {
    const okWithCode = make();
    okWithCode.sink.record({ ...base, errorCode: 'internal' });
    expect(event(okWithCode.audit())).not.toHaveProperty('errorCode');
    expect(events(okWithCode.logs())).toEqual(['audit_invalid_error_code']);

    const errorWithout = make();
    errorWithout.sink.record({ ...base, outcome: 'error' });
    expect(event(errorWithout.audit())['errorCode']).toBe('internal');
    expect(events(errorWithout.logs())).toEqual(['audit_missing_error_code']);

    const deniedWithCode = make();
    deniedWithCode.sink.record({
      ...base,
      outcome: 'denied',
      errorCode: 'policy_denied',
    });
    expect(event(deniedWithCode.audit())['errorCode']).toBe('policy_denied');
    expect(deniedWithCode.logs()).toEqual([]);
  });

  it.each(['toString', 'constructor', '__proto__', 'INTERNAL', 'teapot', 7])(
    'replaces the error code %j',
    (errorCode) => {
      const { sink, audit, logs } = make();
      sink.record({
        ...base,
        outcome: 'error',
        errorCode,
      } as unknown as AuditDraft);
      expect(event(audit())['errorCode']).toBe('internal');
      expect(events(logs())).toEqual(['audit_invalid_error_code']);
    },
  );

  it.each([-1, 86_400_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '12'])(
    'replaces the duration %j with 0, never with null',
    (durationMs) => {
      const { sink, audit, logs } = make();
      sink.record({ ...base, durationMs } as unknown as AuditDraft);
      expect(audit()[0]).toContain('"durationMs":0}');
      expect(events(logs())).toEqual(['audit_invalid_duration_ms']);
    },
  );

  it('writes -0 as 0', () => {
    const { sink, audit } = make();
    sink.record({ ...base, durationMs: -0 });
    expect(audit()[0]).toContain('"durationMs":0}');
  });
});

describe('tool names', () => {
  it('asks the registry only about names that fit the pattern', () => {
    const { sink, audit, logs, toolChecks } = make();
    for (const tool of [
      'ct_max_mustermann',
      'ct_getPerson',
      'max.mustermann@example.org',
      'ct_unknown',
    ]) {
      sink.record({ ...base, tool });
    }
    expect(toolChecks).toEqual(['ct_max_mustermann']);
    expect(
      audit().map((line) => (JSON.parse(line) as AuditEventV1).tool),
    ).toEqual(['ct_unknown', 'ct_unknown', 'ct_unknown', 'ct_unknown']);
    expect(events(logs())).toEqual([
      'audit_invalid_tool',
      'audit_invalid_tool',
      'audit_invalid_tool',
    ]);
    expect(audit().join('\n')).not.toMatch(/mustermann|getPerson/);
  });

  it('counts only a true answer of the registry, and survives its failure', () => {
    for (const isKnownTool of [
      () => 'yes' as unknown as boolean,
      () => 1 as unknown as boolean,
      () => {
        throw new Error('registry broken');
      },
    ]) {
      const { sink, audit } = make({ isKnownTool });
      sink.record(base);
      expect(event(audit())['tool']).toBe('ct_unknown');
    }
  });
});

describe('lists', () => {
  it.each([
    ['a name', ['Max Mustermann']],
    ['an e-mail address', ['max.mustermann@example.org']],
    ['a name as ID', ['person:max']],
    ['a name as kind', ['mustermann:1']],
    ['a number', [12]],
    ['a hole', Object.assign([], { 1: 'group:12' })],
    ['one entry too many', Array.from({ length: 101 }, () => 'group:12')],
    ['no array', { length: 1, 0: 'group:12' }],
    ['a string', 'group:12'],
  ])('drop the whole object references for %s', (_what, objectRefs) => {
    const { sink, audit, logs } = make();
    sink.record({ ...base, objectRefs } as unknown as AuditDraft);
    expect(event(audit())['objectRefs']).toEqual([]);
    expect(events(logs())).toEqual(['audit_invalid_object_refs']);
    expect(audit()[0]).not.toMatch(/ustermann/);
  });

  it('report the length of a list that is too long, capped', () => {
    const sparse: string[] = [];
    sparse.length = 2 ** 32 - 1;
    const { sink, logs } = make();
    const started = performance.now();
    sink.record({ ...base, objectRefs: sparse });
    expect(performance.now() - started).toBeLessThan(200);
    expect(logs()).toMatchObject([
      { event: 'audit_invalid_object_refs', count: 1_000_000 },
    ]);
    expect(logs()[0]).not.toHaveProperty('dropped');
  });

  it('read a list by index only, with no iterator, getter or trap', () => {
    let calls = 0;
    const iterated = ['group:12'];
    Object.defineProperty(iterated, Symbol.iterator, {
      value: () => {
        calls += 1;
        return ['person:max'][Symbol.iterator]();
      },
    });
    const withGetter = ['group:12'];
    Object.defineProperty(withGetter, 0, {
      get: () => {
        calls += 1;
        return 'group:12';
      },
    });
    const proxy = new Proxy(['group:12'], {
      getOwnPropertyDescriptor: () => {
        calls += 1;
        return undefined;
      },
    });
    const { sink, audit } = make();
    sink.record({ ...base, objectRefs: iterated });
    sink.record({ ...base, objectRefs: withGetter });
    sink.record({ ...base, objectRefs: proxy });
    expect(calls).toBe(0);
    expect(
      audit().map((line) => (JSON.parse(line) as AuditEventV1).objectRefs),
    ).toEqual([['group:12'], [], []]);
  });

  it('copy no other property of a list', () => {
    const canary = makeCanaries().token;
    const refs = Object.assign(['group:12'], { note: canary.value });
    const { sink, lines } = make();
    sink.record({ ...base, objectRefs: refs });
    expect(lines).toEqual([baseLine]);
  });

  it('drop the plugin hashes for a bad entry, as an optional field', () => {
    const { sink, audit, logs } = make();
    sink.record({ ...base, pluginHashes: ['a'.repeat(64), 'not a hash'] });
    expect(event(audit())).not.toHaveProperty('pluginHashes');
    expect(events(logs())).toEqual(['audit_invalid_plugin_hashes']);
  });

  it('drop plugin hashes past their bound', () => {
    const { sink, audit, logs } = make();
    sink.record({
      ...base,
      pluginHashes: Array.from({ length: auditLimits.pluginHashes + 1 }, () =>
        'a'.repeat(64),
      ),
    });
    expect(event(audit())).not.toHaveProperty('pluginHashes');
    expect(logs()).toMatchObject([
      { event: 'audit_invalid_plugin_hashes', count: 65 },
    ]);
  });
});

describe('the provider', () => {
  const provider = {
    vendor: 'example-ai',
    model: 'example-model-1',
    hostingCountry: 'CH',
    endpointHost: 'api.example.org',
  };

  it.each([
    ['endpointHost', 'https://api.example.org/v1?key=x', 'endpoint_host'],
    ['model', 'sk-ant-api-key with spaces', 'model'],
    ['hostingCountry', 'Switzerland', 'hosting_country'],
    ['vendor', 'Example Inc.', 'vendor'],
    ['transferBasis', 'Art. 46 DSGVO', 'transfer_basis'],
  ])('is left out when %s is %j', (key, value, name) => {
    const { sink, audit, logs, lines } = make();
    sink.record({ ...base, provider: { ...provider, [key]: value } });
    expect(event(audit())).not.toHaveProperty('provider');
    expect(events(logs())).toEqual([`audit_invalid_provider_${name}`]);
    expect(lines.join('\n')).not.toContain(value);
  });

  it('is written with its known keys only', () => {
    const canary = makeCanaries().token;
    const { sink, audit, logs } = make();
    sink.record({
      ...base,
      provider: { ...provider, apiKey: canary.value },
    } as AuditDraft);
    expect(event(audit())['provider']).toEqual(provider);
    expect(logs()).toMatchObject([{ event: 'audit_unknown_fields', count: 1 }]);
    assertNoCanary([audit(), logs()], [canary], 'lines');
  });
});

describe('other optional fields', () => {
  it.each([
    ['runId', 'not-a-uuid', 'audit_invalid_run_id'],
    ['routineId', 'Weekly Report', 'audit_invalid_routine_id'],
    ['confirmation', 'shout', 'audit_invalid_confirmation'],
    ['policyHash', 'abc', 'audit_invalid_policy_hash'],
    [
      'dataProtectionRegime',
      'Swiss data protection act',
      'audit_invalid_data_protection_regime',
    ],
  ])('leave out %s when it is invalid', (key, value, name) => {
    const { sink, audit, logs } = make();
    sink.record({ ...base, [key]: value });
    expect(audit()).toEqual([baseLine]);
    expect(events(logs())).toEqual([name]);
  });
});

describe('unknown keys', () => {
  it('are counted, never named', () => {
    const canaries = makeCanaries();
    const { sink, audit, logs } = make();
    sink.record({
      ...base,
      body: canaries.token.value,
      email: canaries.email.value,
      [canaries.name.value]: 1,
      [Symbol('x')]: 1,
      actor: { ...base.actor, name: canaries.name.value },
    } as AuditDraft);
    expect(audit()).toEqual([baseLine]);
    expect(logs()).toEqual([
      {
        ts: '2026-10-13T08:00:00.000Z',
        level: 'error',
        event: 'audit_unknown_fields',
        tenantId: 'demo-tenant',
        eventId: firstId,
        code: 'validation',
        count: 5,
      },
    ]);
    assertNoCanary([audit(), logs()], canaries.all, 'lines');
  });
});

describe('a hostile draft', () => {
  it('runs no code of an object given as the value of a field', () => {
    let calls = 0;
    const count = (): number => {
      calls += 1;
      return 3;
    };
    const hostile = (): object => ({
      get length() {
        return count();
      },
      toString: () => String(count()),
      valueOf: count,
      [Symbol.toPrimitive]: count,
    });
    const trapped = new Proxy(
      {},
      {
        get: () => count(),
        getOwnPropertyDescriptor: () => {
          count();
          return undefined;
        },
      },
    );
    const { sink, audit } = make();
    sink.record({
      ...base,
      type: hostile(),
      tenantId: hostile(),
      actor: { kind: hostile(), id: trapped },
      mode: hostile(),
      runId: trapped,
      tool: hostile(),
      outcome: hostile(),
      confirmation: hostile(),
      provider: {
        vendor: hostile(),
        model: trapped,
        hostingCountry: 'CH',
        endpointHost: 'api.example.org',
      },
      dataProtectionRegime: hostile(),
      durationMs: hostile(),
    } as unknown as AuditDraft);
    expect(calls).toBe(0);
    expect(event(audit())).toMatchObject({
      tenantId: 'invalid',
      actor: { kind: 'service', id: 'invalid' },
      durationMs: 0,
    });
  });

  it('has no getter run, and a field behind one counts as invalid', () => {
    const canary = makeCanaries().token;
    let calls = 0;
    const draft = { ...base };
    Object.defineProperty(draft, 'tenantId', {
      enumerable: true,
      get: () => {
        calls += 1;
        throw new Error(canary.value);
      },
    });
    const { sink, audit, logs } = make();
    sink.record(draft);
    expect(calls).toBe(0);
    expect(event(audit())['tenantId']).toBe('invalid');
    expect(events(logs())).toEqual(['audit_invalid_tenant_id']);
    assertNoCanary([audit(), logs()], [canary], 'lines');
  });

  it('reports a getter on an optional field instead of skipping it', () => {
    let calls = 0;
    const draft = { ...base };
    Object.defineProperty(draft, 'runId', {
      enumerable: true,
      get: () => {
        calls += 1;
        return '0b0e9a3c-3f7e-4c62-9a55-6a1f0d2c7e11';
      },
    });
    const { sink, audit, logs } = make();
    sink.record(draft);
    expect(calls).toBe(0);
    expect(audit()).toEqual([baseLine]);
    expect(events(logs())).toEqual(['audit_invalid_run_id']);
  });

  it.each([
    ['a proxy', new Proxy({ ...base }, {})],
    [
      'a revoked proxy',
      (() => {
        const revoked = Proxy.revocable({ ...base }, {});
        revoked.revoke();
        return revoked.proxy;
      })(),
    ],
    ['null', null],
    ['a string', 'tool_call'],
    ['a number', 7],
    ['a function', () => base],
  ])(
    'that is %s gives a line of placeholders and one log line',
    (_what, draft) => {
      const { sink, lines } = make();
      sink.record(draft as unknown as AuditDraft);
      expect(lines).toEqual([
        '{"v":1,"eventId":"a1b2c3d4-0000-4000-8000-000000000001","ts":"2026-10-13T08:00:00.000Z","type":"tool_call","tenantId":"invalid","actor":{"kind":"service","id":"invalid"},"mode":"unattended","outcome":"error","objectRefs":[],"errorCode":"internal","durationMs":0}',
        `{"ts":"2026-10-13T08:00:00.000Z","level":"error","event":"audit_unreadable","eventId":"${firstId}","code":"validation"}`,
      ]);
    },
  );

  it('runs no trap of a proxy', () => {
    let traps = 0;
    const trap = (): never => {
      traps += 1;
      throw new Error('trap');
    };
    const { sink } = make();
    sink.record(
      new Proxy(
        { ...base },
        {
          get: trap,
          getOwnPropertyDescriptor: trap,
          ownKeys: trap,
          getPrototypeOf: trap,
        },
      ),
    );
    expect(traps).toBe(0);
  });

  it('reads no inherited field', () => {
    const draft = Object.create({
      errorCode: 'internal',
      runId: '0b0e9a3c-3f7e-4c62-9a55-6a1f0d2c7e11',
      seq: 3,
    }) as Record<string, unknown>;
    Object.assign(draft, base);
    const { sink, lines } = make();
    sink.record(draft as unknown as AuditDraft);
    expect(lines).toEqual([baseLine]);
  });

  it('is not changed by keys added to Object.prototype', () => {
    const prototype = Object.prototype as Record<string, unknown>;
    const added: Record<string, PropertyDescriptor> = {
      polluted: { value: 1, enumerable: true },
      runId: { value: '0b0e9a3c-3f7e-4c62-9a55-6a1f0d2c7e11' },
      transferBasis: { value: 'polluted' },
      errorCode: { value: 'internal' },
      toJSON: { value: () => ({ pwned: true }) },
    };
    const { sink, lines } = make();
    for (const [key, descriptor] of Object.entries(added)) {
      Object.defineProperty(prototype, key, {
        ...descriptor,
        configurable: true,
        writable: true,
      });
    }
    try {
      sink.record(base);
      sink.record({
        ...base,
        provider: {
          vendor: 'example-ai',
          model: 'example-model-1',
          hostingCountry: 'CH',
          endpointHost: 'api.example.org',
        },
      });
    } finally {
      for (const key of Object.keys(added)) {
        Reflect.deleteProperty(prototype, key);
      }
    }
    expect(lines[0]).toBe(baseLine);
    expect(lines).toHaveLength(2);
    expect(lines.join('\n')).not.toMatch(/polluted|pwned|runId|errorCode/);
  });

  it('counts an own key __proto__ from JSON as unknown', () => {
    const draft = JSON.parse(
      `{"__proto__":{"seq":1,"errorCode":"internal"},${JSON.stringify(base).slice(1)}`,
    ) as AuditDraft;
    const { sink, audit, logs } = make();
    sink.record(draft);
    expect(audit()).toEqual([baseLine]);
    expect(logs()).toMatchObject([{ event: 'audit_unknown_fields', count: 1 }]);
  });

  it('is not changed and not frozen by the sink', () => {
    const draft = structuredClone(base);
    const { sink } = make();
    sink.record(draft);
    expect(draft).toEqual(base);
    expect(Object.isFrozen(draft)).toBe(false);
    expect(Object.isFrozen(draft.actor)).toBe(false);
    expect(Object.isFrozen(draft.objectRefs)).toBe(false);
  });

  it('works from another realm', () => {
    const draft = runInNewContext(`(${JSON.stringify(base)})`) as AuditDraft;
    const { sink, lines } = make();
    sink.record(draft);
    expect(lines).toEqual([baseLine]);
  });
});

describe('time and ID', () => {
  it.each([
    ['NaN', Number.NaN],
    ['a string', '5'],
    ['null', null],
    ['a year beyond 9999', 253_402_300_800_000],
    ['a bigint', 5n],
  ])('fall back when the clock gives %s', (_what, value) => {
    const { sink, audit, logs } = make({
      clock: { now: () => value as number },
    });
    sink.record(base);
    expect(event(audit())['ts']).toBe('1970-01-01T00:00:00.000Z');
    expect(events(logs())).toEqual(['audit_invalid_ts']);
  });

  it('fall back when the clock throws', () => {
    const canary = makeCanaries().token;
    const { sink, lines } = make({
      clock: {
        now: () => {
          throw new Error(canary.value);
        },
      },
    });
    sink.record(base);
    expect(event(lines.slice(0, 1))['ts']).toBe('1970-01-01T00:00:00.000Z');
    assertNoCanary(lines, [canary], 'lines');
  });

  it.each([
    [
      'throws',
      () => {
        throw new Error('no entropy');
      },
    ],
    ['is in upper case', () => firstId.toUpperCase()],
    ['is no UUID', () => 'event-1'],
  ])('use the nil UUID when the ID source %s', (_what, newId) => {
    const { sink, lines } = make({ newId });
    sink.record(base);
    const [line, log] = lines.map((text) => JSON.parse(text) as LogLine);
    expect(line?.['eventId']).toBe(nilId);
    expect(log).toMatchObject({
      event: 'audit_invalid_event_id',
      eventId: nilId,
    });
  });
});

describe('writing', () => {
  it('counts a line the writer could not write, and goes on', () => {
    let answer: () => boolean = () => false;
    const lines: string[] = [];
    const { sink } = make({
      writer: {
        write: (line) => {
          lines.push(line);
          return answer();
        },
      },
    });
    sink.record(base);
    answer = () => {
      throw new Error('writer broken');
    };
    sink.record(base);
    answer = () => true;
    sink.record(base);
    expect(sink.failures()).toBe(2);
    expect(lines).toHaveLength(3);
  });

  it('writes the audit line before any log line, and survives a failing log', () => {
    const lines: string[] = [];
    const { sink } = make({
      writer: {
        write: (line) => {
          lines.push(line);
          if (lines.length > 1) throw new Error('log broken');
          return true;
        },
      },
    });
    sink.record({ ...base, mode: 'admin' } as unknown as AuditDraft);
    expect(lines[0]).toMatch(/^\{"v":1,/);
    expect(sink.failures()).toBe(0);
  });

  it('keeps audit and log lines apart on one stream', () => {
    const { sink, lines } = make();
    sink.record({ ...base, mode: 'admin' } as unknown as AuditDraft);
    sink.record(base);
    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const isAudit = 'v' in parsed;
      expect(isAudit).toBe('type' in parsed);
      expect(isAudit).toBe(!('level' in parsed) && !('event' in parsed));
    }
    expect(lines.filter((line) => line.startsWith('{"v":1,'))).toHaveLength(2);
  });

  it('shares no count between two sinks', () => {
    const failing = make({ writer: { write: () => false } });
    const working = make();
    failing.sink.record(base);
    failing.sink.record(base);
    working.sink.record(base);
    expect(failing.sink.failures()).toBe(2);
    expect(working.sink.failures()).toBe(0);
  });
});

describe('createAuditSink', () => {
  it('refuses missing options with a fixed message', () => {
    const writer: LineWriter = { write: () => true };
    const clock = { now: () => now };
    const isKnownTool = () => true;
    for (const options of [
      { clock, isKnownTool },
      { writer, isKnownTool },
      { writer, clock },
      { writer, clock, isKnownTool, newId: 'x' },
    ]) {
      expect(() => createAuditSink(options as never)).toThrow(
        new TypeError(
          'The audit sink needs a writer, a clock, a tool check and an ID source.',
        ),
      );
    }
  });

  it('gives a frozen sink', () => {
    const { sink } = make();
    expect(Object.isFrozen(sink)).toBe(true);
  });
});

describe('zod inside the sink', () => {
  it('is never asked for an error, so no error map sees a value', () => {
    const canary = makeCanaries().token;
    let calls = 0;
    z.config({
      customError: () => {
        calls += 1;
        return canary.value;
      },
    });
    try {
      const { sink, lines } = make();
      sink.record({
        ...base,
        tenantId: 'Demo',
        objectRefs: ['Max Mustermann'],
      });
      expect(calls).toBe(0);
      assertNoCanary(lines, [canary], 'lines');
    } finally {
      z.config({ customError: undefined });
    }
  });
});

describe('the sink over hostile values', () => {
  it('leaks no canary from any field into any line', () => {
    const canaries = makeCanaries();
    const { sink, lines } = make();
    for (const canary of canaries.all) {
      sink.record({
        type: canary.value,
        tenantId: canary.value,
        actor: { kind: canary.value, id: canary.value },
        mode: canary.value,
        runId: canary.value,
        routineId: canary.value,
        tool: canary.value,
        outcome: canary.value,
        confirmation: canary.value,
        policyHash: canary.value,
        provider: {
          vendor: canary.value,
          model: canary.value,
          hostingCountry: canary.value,
          endpointHost: canary.value,
          transferBasis: canary.value,
        },
        pluginHashes: [canary.value],
        dataProtectionRegime: canary.value,
        objectRefs: [canary.value],
        errorCode: canary.value,
        durationMs: canary.value,
        [canary.value]: canary.value,
      } as unknown as AuditDraft);
    }
    expect(lines.filter((line) => line.startsWith('{"v":1,'))).toHaveLength(4);
    assertNoCanary(lines, canaries.all, 'lines');
    for (const line of lines) expect(line).toMatch(/^[\x20-\x7e]+$/);
  });
});
