import { runInNewContext } from 'node:vm';

import type {
  Clock,
  Logger,
  RunId,
  TenantId,
} from '@ecclium/mcp-churchtools-plugin-api';
import { assertNoCanary, makeCanaries } from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it } from 'vitest';

import * as fieldsModule from './fields.js';
import {
  type BoundLogFields,
  createLogger,
  createStderrWriter,
  fallbackTimestamp,
  type LineWriter,
  type LoggerOptions,
  maxDropped,
  replacedEventName,
} from './index.js';

const runId = '0b0e9a3c-3f7e-4c62-9a55-6a1f0d2c7e11' as RunId;
const eventId = '5d2c1f7a-8e4b-4a3d-b6c9-1e2f3a4b5c6d';
const fullBound: BoundLogFields = {
  tenantId: 'demo-tenant' as TenantId,
  runId,
  eventId,
  tool: 'ct_group_search',
  mode: 'interactive',
  redaction: 'standard',
  readOnly: true,
};
const order = [
  'ts',
  'level',
  'event',
  'tenantId',
  'runId',
  'eventId',
  'tool',
  'prompt',
  'code',
  'mode',
  'redaction',
  'readOnly',
  'durationMs',
  'count',
  'status',
  'attempt',
  'dropped',
];
const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A clock at a fixed time that counts its calls. */
function clockAt(now: unknown = 1_760_000_000_123): {
  readonly clock: Clock;
  readonly calls: () => number;
} {
  let calls = 0;
  return {
    clock: {
      now: () => {
        calls += 1;
        return now as number;
      },
    },
    calls: () => calls,
  };
}

/** A writer that keeps its lines in a list. */
function listWriter(): {
  readonly writer: LineWriter;
  readonly lines: string[];
} {
  const lines: string[] = [];
  return {
    writer: {
      write: (line) => {
        lines.push(line);
        return true;
      },
    },
    lines,
  };
}

/** A logger that writes into a list. */
function make(options: Partial<LoggerOptions> = {}): {
  readonly log: Logger;
  readonly lines: string[];
  readonly parsed: () => Record<string, unknown>[];
  readonly clockCalls: () => number;
} {
  const { writer, lines } = listWriter();
  const time = clockAt();
  const log = createLogger({
    writer,
    clock: time.clock,
    minLevel: 'debug',
    ...options,
  });
  return {
    log,
    lines,
    parsed: () =>
      lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    clockCalls: time.calls,
  };
}

/** The one line a logger wrote, parsed. */
const only = (lines: readonly string[]): Record<string, unknown> => {
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] ?? '') as Record<string, unknown>;
};

describe('a log line', () => {
  it('holds every field in a fixed order, on one line of JSON', () => {
    const { log, lines } = make({ bound: fullBound });
    log.info('cache_skipped', {
      attempt: 1,
      status: 404,
      count: 3,
      durationMs: 12,
      code: 'not_found',
      prompt: 'dienstplan_wochenende',
      note: 'x',
    });
    const line = only(lines);
    expect(Object.keys(line)).toEqual(order);
    expect(line).toEqual({
      ts: '2025-10-09T08:53:20.123Z',
      level: 'info',
      event: 'cache_skipped',
      ...fullBound,
      prompt: 'dienstplan_wochenende',
      code: 'not_found',
      durationMs: 12,
      count: 3,
      status: 404,
      attempt: 1,
      dropped: 1,
    });
    expect(lines[0]).not.toMatch(/[\n\r]/);
  });

  it('is at most 619 characters long', () => {
    const { log, lines } = make({
      bound: {
        tenantId: `a${'b'.repeat(62)}` as TenantId,
        runId,
        eventId,
        tool: `ct_${'a'.repeat(60)}`,
        mode: 'interactive',
        redaction: 'standard',
        readOnly: false,
      },
    });
    const fields: Record<string, unknown> = {
      prompt: `a${'b'.repeat(62)}`,
      code: 'confirmation_required',
      durationMs: 86_400_000,
      count: 1_000_000,
      status: 599,
      attempt: 10,
    };
    for (let key = 0; key < maxDropped; key += 1) fields[key] = 0;
    log.debug('a'.repeat(64), fields as never);
    expect(lines[0]).toHaveLength(619);
  });
});

describe('the time of a line', () => {
  it('comes from the clock, once per written line, cut to milliseconds', () => {
    const time = clockAt(1_760_000_000_123.9);
    const { writer, lines } = listWriter();
    const log = createLogger({ writer, clock: time.clock, minLevel: 'info' });
    log.info('a');
    log.debug('b');
    expect(only(lines)['ts']).toBe('2025-10-09T08:53:20.123Z');
    expect(time.calls()).toBe(1);
  });

  it.each([
    ['-1', -1, '1969-12-31T23:59:59.999Z'],
    ['0', 0, '1970-01-01T00:00:00.000Z'],
    ['the end of 9999', 253_402_300_799_999, '9999-12-31T23:59:59.999Z'],
  ])('accepts %s', (_what, now, expected) => {
    const { writer, lines } = listWriter();
    createLogger({ writer, clock: clockAt(now).clock, minLevel: 'info' }).info(
      'a',
    );
    expect(only(lines)['ts']).toBe(expected);
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['a time beyond the range of Date', 8.64e15 + 1],
    ['a year beyond 9999', 8.64e15],
    ['a year before 0', -62_198_755_200_001],
    ['a bigint', 1_760_000_000_123n],
    ['a string', '1760000000123'],
    ['undefined', undefined],
  ])('falls back for %s', (_what, now) => {
    const { writer, lines } = listWriter();
    const clock = { now: () => now as number };
    createLogger({ writer, clock, minLevel: 'info' }).info('a');
    expect(only(lines)['ts']).toBe(fallbackTimestamp);
  });

  it('falls back when the clock throws, and uses it again afterwards', () => {
    let first = true;
    const { writer, lines } = listWriter();
    const log = createLogger({
      writer,
      clock: {
        now: () => {
          if (first) {
            first = false;
            throw new Error('clock broken');
          }
          return 1_760_000_000_123;
        },
      },
      minLevel: 'info',
    });
    log.info('a');
    log.info('b');
    const times = lines.map((line) => (JSON.parse(line) as { ts: string }).ts);
    expect(times).toEqual([fallbackTimestamp, '2025-10-09T08:53:20.123Z']);
    for (const time of times) expect(time).toMatch(isoTimestamp);
  });
});

describe('levels', () => {
  it.each([
    ['debug', 4],
    ['info', 3],
    ['warn', 2],
    ['error', 1],
  ] as const)(
    'from %s write %i of four lines, each at its level',
    (minLevel, count) => {
      const { log, parsed } = make({ minLevel });
      log.debug('a');
      log.info('a');
      log.warn('a');
      log.error('a');
      expect(parsed().map((line) => line['level'])).toEqual(
        ['debug', 'info', 'warn', 'error'].slice(4 - count),
      );
    },
  );

  it('do no work for a line below the level', () => {
    let calls = 0;
    const count = (): number => {
      calls += 1;
      return 1;
    };
    const hostile = {
      get count() {
        return count();
      },
    };
    const event = { toString: () => String(count()) };
    const { log, lines, clockCalls } = make({ minLevel: 'error' });
    log.debug(event as never, hostile);
    log.warn(
      event as never,
      new Proxy({}, { ownKeys: () => [String(count())] }),
    );
    expect(lines).toHaveLength(0);
    expect(clockCalls()).toBe(0);
    expect(calls).toBe(0);
  });
});

describe('createLogger', () => {
  it.each(['constructor', 'INFO', '', 'trace', undefined, 'toString'])(
    'refuses the level %j with a fixed message',
    (minLevel) => {
      expect(() =>
        createLogger({
          writer: listWriter().writer,
          clock: clockAt().clock,
          minLevel: minLevel as never,
        }),
      ).toThrow(
        new TypeError('The logger needs a writer, a clock and a level.'),
      );
    },
  );

  it('refuses a missing writer or clock', () => {
    const { clock } = clockAt();
    const { writer } = listWriter();
    for (const options of [
      { writer: null, clock, minLevel: 'info' },
      { writer: {}, clock, minLevel: 'info' },
      { writer, clock: null, minLevel: 'info' },
      { writer, clock: { now: 5 }, minLevel: 'info' },
    ]) {
      expect(() => createLogger(options as never)).toThrow(TypeError);
    }
  });

  it.each([
    ['a tenant in upper case', { tenantId: 'Demo' }],
    ['a tool name in camel case', { tool: 'ct_getPerson' }],
    ['a run in upper case', { runId: runId.toUpperCase() }],
    ['an event ID with a line break', { eventId: `${eventId}\n` }],
    ['readOnly as a string', { readOnly: 'false' }],
    ['an unknown mode', { mode: 'admin' }],
    ['an unknown level of redaction', { redaction: 'none' }],
    ['a field a call sets', { count: 1 }],
    ['an unknown field', { note: 'x' }],
    ['a symbol key', { [Symbol('x')]: 1 }],
    [
      'a tenant behind a getter',
      Object.defineProperty({}, 'tenantId', {
        get: () => 'demo-tenant',
        enumerable: true,
      }),
    ],
    ['a map', new Map([['tenantId', 'demo-tenant']])],
    ['a proxy', new Proxy({ tenantId: 'demo-tenant' }, {})],
    ['null', null],
  ])('refuses a bound with %s, with a fixed message', (_what, bound) => {
    expect(() => make({ bound: bound as never })).toThrow(
      new TypeError('The bound log fields are not valid.'),
    );
  });

  it('takes a bound field given as undefined as absent', () => {
    const { log, parsed } = make({
      bound: { tenantId: 'demo-tenant' as TenantId, tool: undefined },
    });
    log.info('a');
    expect(parsed()[0]).toEqual({
      ts: '2025-10-09T08:53:20.123Z',
      level: 'info',
      event: 'a',
      tenantId: 'demo-tenant',
    });
  });

  it('keeps a copy of the bound fields', () => {
    const bound = { tenantId: 'demo-tenant' as TenantId };
    const { log, parsed } = make({ bound });
    (bound as { tenantId: string }).tenantId = 'other-tenant';
    log.info('a');
    expect(parsed()[0]?.['tenantId']).toBe('demo-tenant');
  });

  it('gives a frozen logger whose methods work detached and return nothing', () => {
    const { log, lines } = make();
    expect(Object.isFrozen(log)).toBe(true);
    expect(Object.keys(log)).toEqual(['debug', 'info', 'warn', 'error']);
    // A value hung on a method would reach every holder of the logger.
    for (const method of Object.values(log)) {
      expect(Object.isFrozen(method)).toBe(true);
      expect(() => {
        (method as unknown as Record<string, unknown>)['stash'] = 'value';
      }).toThrow(TypeError);
    }
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the point is to call it detached
    const info: (event: string) => unknown = log.info;
    expect(info('a')).toBeUndefined();
    expect(lines).toHaveLength(1);
  });
});

describe('event names', () => {
  it.each(['a', 'cache_skipped', `a${'b'.repeat(63)}`])(
    'writes %s as it is',
    (event) => {
      const { log, lines } = make();
      log.info(event);
      expect(only(lines)['event']).toBe(event);
    },
  );

  it.each([
    '',
    'Cache',
    'a-b',
    `a${'b'.repeat(64)}`,
    '\u017f',
    '\u212a',
    'a\n',
    'a\u2028',
    'ok\ud800',
    '\udfff',
  ])('replaces %j and keeps it out of the line', (event) => {
    const { log, lines } = make();
    log.warn(event, { count: 1 });
    const line = only(lines);
    expect(line).toMatchObject({
      level: 'warn',
      event: replacedEventName,
      count: 1,
    });
    expect(line).not.toHaveProperty('dropped');
    expect(lines[0]).not.toMatch(/\\u|\\n/);
  });

  it('replaces a value that is no string without coercing it', () => {
    let calls = 0;
    const spy = (): string => {
      calls += 1;
      return 'evil"x';
    };
    const { log, parsed } = make();
    for (const event of [
      { toString: spy, toJSON: spy },
      Object.assign(Object.create(null) as object, { toString: spy }),
      ['cache_skipped'],
      42,
      null,
      Symbol('a'),
    ]) {
      log.info(event as never);
    }
    expect(parsed().map((line) => line['event'])).toEqual(
      Array.from({ length: 6 }, () => replacedEventName),
    );
    expect(calls).toBe(0);
  });

  it('replaces a huge name with a canary at once', () => {
    const canary = makeCanaries().token;
    const { log, lines } = make();
    const started = performance.now();
    log.info(`a${canary.value}${'b'.repeat(10_000_000)}`);
    expect(performance.now() - started).toBeLessThan(200);
    assertNoCanary(lines, [canary], 'line');
  });

  it('lets a name in lower case through, so names must be constants (a known limit)', () => {
    const { log, lines } = make();
    log.info('a7f3k9q2w8e4r6t1y5u0');
    expect(only(lines)['event']).toBe('a7f3k9q2w8e4r6t1y5u0');
  });
});

describe('the fields of a call', () => {
  it('drop every name that is not allowed, also v and type', () => {
    const { log, lines } = make();
    log.info('a', {
      message: 'm',
      name: 'n',
      path: '/tmp/x',
      host: 'example.church.tools',
      url: 'https://example.church.tools/api',
      text: 't',
      v: 1,
      type: 'tool_call',
      stack: 's',
      error: 'e',
      body: 'b',
      token: 't',
      email: 'max.mustermann@example.org',
      count: 1,
    });
    expect(only(lines)).toEqual({
      ts: '2025-10-09T08:53:20.123Z',
      level: 'info',
      event: 'a',
      count: 1,
      dropped: 13,
    });
  });

  it('cannot replace ts, level, event or dropped', () => {
    const { log, lines } = make();
    log.info('real', {
      ts: '2000-01-01T00:00:00.000Z',
      level: 'error',
      event: 'fake',
      dropped: 0,
    });
    expect(only(lines)).toEqual({
      ts: '2025-10-09T08:53:20.123Z',
      level: 'info',
      event: 'real',
      dropped: 4,
    });
    for (const key of ['"ts"', '"level"', '"event"', '"dropped"']) {
      expect(lines[0]?.split(key)).toHaveLength(2);
    }
  });

  it('take no field that only the core binds, with or without a bound', () => {
    const call = {
      tenantId: 'other-tenant',
      runId: '11111111-1111-4111-8111-111111111111',
      eventId: '22222222-2222-4222-8222-222222222222',
      tool: 'ct_other_tool',
      mode: 'operator',
      redaction: 'off',
      readOnly: false,
      count: 1,
    };
    const bound = make({ bound: fullBound });
    bound.log.info('a', call);
    expect(only(bound.lines)).toMatchObject({
      ...fullBound,
      count: 1,
      dropped: 7,
    });
    const unbound = make();
    unbound.log.info('a', call);
    expect(only(unbound.lines)).toEqual({
      ts: '2025-10-09T08:53:20.123Z',
      level: 'info',
      event: 'a',
      count: 1,
      dropped: 7,
    });
    for (const lines of [bound.lines, unbound.lines]) {
      expect(lines[0]).not.toMatch(/other|1111|2222|operator/);
    }
  });

  it.each([
    ['durationMs', [0, 86_400_000], [-1, 86_400_001]],
    ['count', [0, 1_000_000], [-1, 1_000_001]],
    ['status', [100, 599], [99, 600]],
    ['attempt', [1, 10], [0, 11]],
  ] as const)(
    'keep %s only as a whole number in its range',
    (name, good, bad) => {
      const { log, parsed } = make();
      for (const value of [
        ...good,
        ...bad,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        '200',
        true,
        null,
        2n,
      ]) {
        log.info('a', { [name]: value } as never);
      }
      expect(parsed().map((line) => line[name] ?? line['dropped'])).toEqual([
        good[0],
        good[1],
        ...Array.from({ length: 9 }, () => 1),
      ]);
    },
  );

  it('write -0 as 0 and keep zeros', () => {
    const { log, lines } = make();
    log.info('a', { durationMs: -0, count: 0 });
    expect(lines[0]).toContain('"durationMs":0,"count":0');
  });

  it('keep only a stable error code, compared exactly', () => {
    const { log, parsed } = make();
    for (const code of [
      'internal',
      'INTERNAL',
      'constructor',
      'toString',
      'teapot',
    ]) {
      log.info('a', { code });
    }
    expect(parsed().map((line) => line['code'] ?? null)).toEqual([
      'internal',
      null,
      null,
      null,
      null,
    ]);
  });
});

describe('the object of fields', () => {
  it('is read as a plain object, also without prototype or frozen, and never changed', () => {
    const plain = { count: 1, note: 'x' };
    const bare = Object.assign(Object.create(null) as object, { count: 1 });
    const frozen = Object.freeze({ count: 1, note: 'x' });
    const { log, parsed } = make();
    log.info('a', plain);
    log.info('a', bare);
    log.info('a', frozen);
    expect(parsed().map((line) => [line['count'], line['dropped']])).toEqual([
      [1, 1],
      [1, undefined],
      [1, 1],
    ]);
    expect(plain).toEqual({ count: 1, note: 'x' });
  });

  it.each([
    ['an error', Object.assign(new Error('ENOENT: /tmp/x'), { count: 1 })],
    ['a map', new Map([['count', 1]])],
    [
      'a class instance',
      new (class Fields {
        readonly count = 1;
      })(),
    ],
    ['a date', new Date(0)],
    ['an array', [1]],
    ['a string object', Object('count') as object],
    ['a function', Object.assign(() => undefined, { count: 1 })],
    [
      'a plain object of another realm',
      runInNewContext('({ count: 1 })') as unknown,
    ],
  ])('is refused whole when it is %s', (_what, value) => {
    const { log, lines } = make();
    log.info('a', value as never);
    const line = only(lines);
    expect(line).not.toHaveProperty('count');
    expect(line['dropped']).toBe(1);
    expect(lines[0]).not.toMatch(/ENOENT|tmp/);
  });

  it.each([
    ['undefined', undefined, undefined],
    ['null', null, 1],
    ['a string', 'abc', 1],
    ['a number', 42, 1],
    ['a boolean', true, 1],
    ['a symbol', Symbol('a'), 1],
  ])('given as %s gives dropped %j', (_what, value, dropped) => {
    const { log, lines } = make();
    log.info('a', value as never);
    expect(only(lines)['dropped']).toBe(dropped);
  });

  it('runs no getter and counts it as dropped', () => {
    const canary = makeCanaries().token;
    let calls = 0;
    const { log, lines } = make();
    log.info('a', {
      get count() {
        calls += 1;
        return canary.value;
      },
      status: 200,
    });
    expect(calls).toBe(0);
    expect(only(lines)).toMatchObject({ status: 200, dropped: 1 });
    assertNoCanary(lines, [canary], 'line');
  });

  it('runs no trap of a proxy', () => {
    let traps = 0;
    const handler: ProxyHandler<object> = Object.fromEntries(
      [
        'get',
        'getOwnPropertyDescriptor',
        'ownKeys',
        'getPrototypeOf',
        'has',
      ].map((trap) => [
        trap,
        () => {
          traps += 1;
          throw new Error('trap');
        },
      ]),
    );
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const { log, parsed } = make();
    for (const value of [
      new Proxy({ count: 1 }, handler),
      new Proxy({ count: 1 }, {}),
      revoked.proxy,
      runInNewContext('new Proxy({ count: 1 }, {})') as unknown,
    ]) {
      log.info('a', value as never);
    }
    expect(traps).toBe(0);
    expect(parsed().map((line) => [line['count'], line['dropped']])).toEqual(
      Array.from({ length: 4 }, () => [undefined, 1]),
    );
  });

  it('counts symbol keys and properties that are not enumerable', () => {
    const fields = Object.defineProperty(
      { count: 2, [Symbol('x')]: 1 },
      'status',
      { value: 200, enumerable: false },
    );
    const { log, lines } = make();
    log.info('a', fields);
    const line = only(lines);
    expect(line).toMatchObject({ count: 2, dropped: 2 });
    expect(line).not.toHaveProperty('status');
  });

  it('takes an own key __proto__ as a key like any other', () => {
    const fields = JSON.parse('{"__proto__":{"count":5},"count":1}') as object;
    const { log, lines } = make();
    log.info('a', fields as never);
    expect(only(lines)).toMatchObject({ count: 1, dropped: 1 });
    expect(lines[0]).not.toContain('__proto__');
    expect(({} as { count?: number }).count).toBeUndefined();
  });

  it('copes with keys that shadow methods of Object.prototype', () => {
    const { log, lines } = make();
    log.info('a', {
      hasOwnProperty: 1,
      toString: 2,
      valueOf: 3,
      constructor: 4,
      count: 1,
    });
    expect(only(lines)).toMatchObject({ count: 1, dropped: 4 });
  });

  it('ignores fields and toJSON added to Object.prototype', () => {
    const { log, lines } = make();
    const prototype = Object.prototype as Record<string, unknown>;
    Object.defineProperty(prototype, 'count', {
      value: 5,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(prototype, 'toJSON', {
      value: () => ({ pwned: true }),
      configurable: true,
      writable: true,
    });
    try {
      log.info('polluted', {});
      log.info('polluted', { status: 200 });
    } finally {
      delete prototype['count'];
      delete prototype['toJSON'];
    }
    expect(lines).toEqual([
      '{"ts":"2025-10-09T08:53:20.123Z","level":"info","event":"polluted"}',
      '{"ts":"2025-10-09T08:53:20.123Z","level":"info","event":"polluted","status":200}',
    ]);
  });

  it('caps the count of dropped fields', () => {
    const fields: Record<string, number> = { count: 1 };
    for (let key = 0; key <= maxDropped; key += 1) fields[key] = 0;
    const { log, lines } = make();
    log.info('a', fields);
    expect(only(lines)).toMatchObject({ count: 1, dropped: maxDropped });
  });

  it('copes with a module namespace', () => {
    const { log, lines } = make();
    log.info('a', fieldsModule as never);
    expect(only(lines)).not.toHaveProperty('count');
  });

  it('keeps out what a tool passes by mistake, such as its context', () => {
    const canaries = makeCanaries();
    const { log, lines } = make({ bound: fullBound });
    log.info('a', {
      tenantId: 'demo-tenant',
      baseUrl: 'https://example.church.tools',
      user: { id: 'person-id-1', email: canaries.email.value },
      name: canaries.name.value,
      count: 5,
    } as never);
    expect(only(lines)).toMatchObject({ count: 5, dropped: 4 });
    expect(lines[0]).not.toMatch(/example\.church\.tools|person-id-1/);
    assertNoCanary(lines, canaries.all, 'line');
  });
});

describe('a logger under stress', () => {
  it('never throws when its writer throws', () => {
    const canary = makeCanaries().token;
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const thrown of [
      new Error(canary.value),
      canary.value,
      revoked.proxy,
    ]) {
      const log = createLogger({
        writer: {
          write: () => {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- the point is to throw values that are not errors
            throw thrown;
          },
        },
        clock: clockAt().clock,
        minLevel: 'info',
      });
      log.info('a', { count: 1 });
    }
  });

  it('drops a line that its writer asks for while it writes', () => {
    const lines: string[] = [];
    const decoder = new TextDecoder();
    const writer = createStderrWriter({
      writeSync: (_fd, buffer, offset, length) => {
        b.info('nested_b');
        a.error('nested_a');
        lines.push(decoder.decode(buffer.subarray(offset, offset + length)));
        return length;
      },
    });
    const a = createLogger({
      writer,
      clock: clockAt().clock,
      minLevel: 'info',
    });
    const b = createLogger({
      writer,
      clock: clockAt().clock,
      minLevel: 'info',
    });
    a.info('outer');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"event":"outer"');
    expect(writer.stats()).toMatchObject({ written: 1, reentrant: 1 });
  });

  it('drops a line that its clock asks for, but not one of another logger', () => {
    const { writer, lines } = listWriter();
    const other = createLogger({
      writer,
      clock: clockAt().clock,
      minLevel: 'info',
    });
    const log: Logger = createLogger({
      writer,
      clock: {
        now: () => {
          log.info('from_clock');
          other.info('from_other');
          return 1_760_000_000_123;
        },
      },
      minLevel: 'info',
    });
    log.info('outer');
    log.info('outer');
    expect(
      lines.map((line) => (JSON.parse(line) as { event: string }).event),
    ).toEqual(['from_other', 'outer', 'from_other', 'outer']);
  });

  it('calls clock and writer as methods', () => {
    class FixedClock {
      readonly #now = 1_760_000_000_123;
      now(): number {
        return this.#now;
      }
    }
    class Writer {
      readonly #lines: string[] = [];
      write(line: string): boolean {
        this.#lines.push(line);
        return true;
      }
      lines(): readonly string[] {
        return this.#lines;
      }
    }
    const writer = new Writer();
    createLogger({ writer, clock: new FixedClock(), minLevel: 'info' }).info(
      'a',
    );
    expect(only(writer.lines())['ts']).toBe('2025-10-09T08:53:20.123Z');
  });

  it('writes only lines of printable ASCII with allowed keys in order, whatever it gets', () => {
    // A seeded generator, so that a failure can be repeated.
    let seed = 0x2f6b_1d3a;
    const next = (): number => {
      seed = (seed + 0x6d2b_79f5) | 0;
      let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
      return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
    };
    const pick = <T>(list: readonly T[]): T =>
      list[Math.floor(next() * list.length)] as T;
    const keys = [...order, 'message', 'v', 'type', '__proto__', 'constructor'];
    const values: readonly unknown[] = [
      'cache_skipped',
      'demo-tenant',
      'ct_group_search',
      runId,
      'internal',
      'operator',
      'strict',
      'a\u2028b',
      'ok\ud800',
      '\u001b[2J',
      '\u00fc',
      0,
      -0,
      1,
      599,
      86_400_000,
      1.5,
      -1,
      Number.NaN,
      true,
      false,
      null,
      {},
      [],
    ];
    const levels = ['debug', 'info', 'warn', 'error'] as const;
    const { log, lines } = make({ bound: fullBound });
    for (let round = 0; round < 500; round += 1) {
      const fields: Record<string, unknown> = {};
      for (let count = Math.floor(next() * 6); count > 0; count -= 1) {
        fields[pick(keys)] = pick(values);
      }
      const event = pick([...values, 'a', 'Bad', `a${'b'.repeat(70)}`]);
      log[pick(levels)](event as never, fields as never);
    }
    expect(lines).toHaveLength(500);
    for (const line of lines) {
      expect(line).toMatch(/^[\x20-\x7e]+$/);
      const keysOfLine = Object.keys(JSON.parse(line) as object);
      expect(keysOfLine).toEqual(
        order.filter((key) => keysOfLine.includes(key)),
      );
    }
  });

  it('leaks no canary from events, values or keys', () => {
    const canaries = makeCanaries();
    const { log, lines } = make({ bound: fullBound });
    for (const canary of canaries.all) {
      log.info(canary.value, {
        count: canary.value,
        [canary.value]: 1,
        code: canary.value,
        nested: { value: canary.value },
      } as never);
    }
    expect(lines).toHaveLength(canaries.all.length);
    assertNoCanary(lines, canaries.all, 'lines');
  });
});
