import { inspect } from 'node:util';

import type {
  Clock,
  RunId,
  TenantContext,
  TenantId,
} from '@ecclium/mcp-churchtools-plugin-api';
import { makeCanary } from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  actorKinds,
  auditFieldSchemas,
  auditPlaceholders,
} from '../audit/index.js';
import { systemClock } from '../clock.js';
import type { LineWriter } from '../logger/index.js';
import {
  createTenantContext,
  maxFeatures,
  type TenantContextOptions,
} from './context.js';

// A clock as the factory wants it: a frozen plain object whose own method
// is frozen as well.
const fakeClock: Clock = Object.freeze({
  now: Object.freeze(() => 1_760_000_000_000),
});

interface Lines {
  readonly writer: LineWriter;
  readonly lines: string[];
  readonly parsed: () => Record<string, unknown>[];
}

const recorder = (): Lines => {
  const lines: string[] = [];
  return {
    writer: Object.freeze({
      write: (line: string) => {
        lines.push(line);
        return true;
      },
    }),
    lines,
    parsed: () =>
      lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
};

type Options = Record<string, unknown>;

const valid = (lines: Lines = recorder()): Options => ({
  assignment: {
    tenantId: 'default',
    actor: { kind: 'user', id: 'stdio:local-stdio' },
  },
  instance: 'https://example.church.tools',
  mode: 'interactive',
  redaction: 'standard',
  readOnly: true,
  features: [],
  clock: fakeClock,
  signal: new AbortController().signal,
  logging: { writer: lines.writer, minLevel: 'info' },
});

const make = (options: Options): TenantContext =>
  createTenantContext(options as unknown as TenantContextOptions);

const runId = '7d3c5a0e-4b1f-4c2a-9e8d-2f6b1a0c9d11';
const eventId = '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createTenantContext gives', () => {
  it('a context with exactly the fields of TenantContext', () => {
    expect(Reflect.ownKeys(make(valid()))).toEqual([
      'tenantId',
      'instance',
      'actor',
      'mode',
      'redaction',
      'readOnly',
      'features',
      'clock',
      'signal',
      'log',
    ]);
    expect(Reflect.ownKeys(make({ ...valid(), runId }))).toEqual([
      'tenantId',
      'instance',
      'actor',
      'mode',
      'runId',
      'redaction',
      'readOnly',
      'features',
      'clock',
      'signal',
      'log',
    ]);
  });

  it('the values it was given, copied where a caller could change them', () => {
    const options = valid();
    const context = make({ ...options, features: ['feature-a'] });
    expect(context).toMatchObject({
      tenantId: 'default',
      instance: 'https://example.church.tools',
      actor: { kind: 'user', id: 'stdio:local-stdio' },
      mode: 'interactive',
      redaction: 'standard',
      readOnly: true,
      features: ['feature-a'],
    });
    expect(context.actor).not.toBe(
      (options['assignment'] as { actor: unknown }).actor,
    );
    expect(context.clock).toBe(fakeClock);
    expect(context.signal).toBe(options['signal']);
  });

  it('a copy that later changes of the options do not reach', () => {
    const features = ['feature-a'];
    const actor = { kind: 'user', id: 'stdio:local-stdio' };
    const context = make({
      ...valid(),
      assignment: { tenantId: 'default', actor },
      features,
    });
    features.push('feature-b');
    actor.id = 'stdio:other';
    expect(context.features).toEqual(['feature-a']);
    expect(context.features).not.toBe(features);
    expect(context.actor.id).toBe('stdio:local-stdio');
  });

  // The two-tenant cases of ADR 0003 need a context for any valid tenant.
  it('a context for any tenant and instance that pass the audit', () => {
    const context = make({
      ...valid(),
      assignment: {
        tenantId: 'demo-tenant',
        actor: { kind: 'service', id: 'service' },
      },
      instance: 'https://demo.example:8443',
      redaction: 'off',
      readOnly: false,
      mode: 'unattended',
      runId,
    });
    expect(context.tenantId).toBe('demo-tenant');
    expect(context.instance).toBe('https://demo.example:8443');
    expect(context.runId).toBe(runId);
  });

  it('a context that holds the writer nowhere', () => {
    const lines = recorder();
    const context = make({ ...valid(lines), tool: 'ct_whoami', eventId });
    const seen = new Set<unknown>();
    const walk = (value: unknown, depth: number): void => {
      if (typeof value !== 'object' && typeof value !== 'function') return;
      if (value === null || seen.has(value) || depth > 3) return;
      seen.add(value);
      expect(value).not.toBe(lines.writer);
      for (const key of Reflect.ownKeys(value)) {
        if (value === context && key === 'signal') continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor !== undefined && 'value' in descriptor) {
          walk(descriptor.value, depth + 1);
        }
      }
    };
    walk(context, 0);
    expect(Object.keys(context.log)).toEqual([
      'debug',
      'info',
      'warn',
      'error',
    ]);
  });
});

describe('createTenantContext refuses', () => {
  const refuses = (options: Options, message: string): void => {
    expect(() => make(options)).toThrow(new TypeError(message));
  };

  it.each([
    ['the placeholder of the audit', auditPlaceholders.tenantId],
    ['a capital', 'Default'],
    ['a space', ' default'],
    ['no string', 42],
    ['a missing tenant', undefined],
  ])('a tenant with %s', (_, tenantId) => {
    refuses(
      {
        ...valid(),
        assignment: {
          tenantId,
          actor: { kind: 'user', id: 'stdio:local-stdio' },
        },
      },
      'The tenant is invalid.',
    );
  });

  it.each(actorKinds)(
    'the placeholder actor of the audit with the kind %s',
    (kind) => {
      refuses(
        {
          ...valid(),
          assignment: {
            tenantId: 'default',
            actor: { kind, id: auditPlaceholders.actor.id },
          },
        },
        'The actor is invalid.',
      );
    },
  );

  it.each([
    ['an e-mail address', { kind: 'user', id: 'stdio:max.mustermann' }],
    ['a capital', { kind: 'user', id: 'stdio:Max' }],
    ['98 characters', { kind: 'user', id: `stdio:${'a'.repeat(92)}` }],
    ['the kind USER', { kind: 'USER', id: 'stdio:local-stdio' }],
    ['the kind admin', { kind: 'admin', id: 'stdio:local-stdio' }],
    ['no object', 'stdio:local-stdio'],
  ])('an actor with %s', (_, actor) => {
    refuses(
      { ...valid(), assignment: { tenantId: 'default', actor } },
      'The actor is invalid.',
    );
  });

  // Whatever the factory takes, the audit takes as well, so the sink never
  // puts a placeholder in its place.
  it('nothing the audit would refuse', () => {
    const context = make(valid());
    expect(auditFieldSchemas.tenantId.safeParse(context.tenantId).success).toBe(
      true,
    );
    expect(auditFieldSchemas.actorId.safeParse(context.actor.id).success).toBe(
      true,
    );
    expect(
      auditFieldSchemas.actorKind.safeParse(context.actor.kind).success,
    ).toBe(true);
  });

  it.each([
    'https://example.church.tools/',
    'http://example.church.tools',
    'https://DEMO.example',
    new URL('https://example.church.tools'),
    '',
  ])('the instance %s, which is no checked origin', (instance) => {
    refuses({ ...valid(), instance }, 'The instance is not a checked origin.');
  });

  it.each(['INTERACTIVE', 'admin', undefined])('the mode %j', (mode) => {
    refuses({ ...valid(), mode }, 'The mode is unknown.');
  });

  it.each(['Standard', 'none', undefined])('the redaction %j', (redaction) => {
    refuses({ ...valid(), redaction }, 'The redaction level is unknown.');
  });

  it('strict redaction until the full redaction exists', () => {
    refuses(
      { ...valid(), redaction: 'strict' },
      'The redaction level strict waits for the full redaction.',
    );
  });

  it.each(['false', 0, undefined])('the read-only flag %j', (readOnly) => {
    refuses({ ...valid(), readOnly }, 'The read-only flag is not a boolean.');
  });

  it('features that are no plain list of short visible names, unread', () => {
    const getter = vi.fn(() => 'feature-a');
    const withGetter: unknown[] = [];
    Object.defineProperty(withGetter, '0', { get: getter, enumerable: true });
    const withHole: unknown[] = [];
    withHole[1] = 'feature-a';
    class Features extends Array<string> {}
    const cases: unknown[] = [
      withHole,
      withGetter,
      new Proxy(['feature-a'], {}),
      Features.from(['feature-a']),
      Array.from(
        { length: maxFeatures + 1 },
        (_, index) => `f-${String(index)}`,
      ),
      ['a'.repeat(65)],
      [''],
      ['feature a'],
      ['m\u00fcller'],
      [42],
      'feature-a',
      undefined,
    ];
    for (const features of cases) {
      refuses({ ...valid(), features }, 'The features are invalid.');
    }
    expect(getter).not.toHaveBeenCalled();
    expect(
      make({
        ...valid(),
        features: Array.from(
          { length: maxFeatures },
          (_, index) => `f-${String(index)}`,
        ),
      }).features,
    ).toHaveLength(maxFeatures);
  });

  it('a clock that is not frozen, or whose method could still change', () => {
    class FakeClock {
      now(): number {
        return 1;
      }
    }
    const cases: unknown[] = [
      { now: Object.freeze(() => 1) },
      Object.freeze({ now: () => 1 }),
      Object.freeze(new FakeClock()),
      Object.freeze({ now: 1 }),
      new Proxy(fakeClock, {}),
      undefined,
    ];
    for (const clock of cases) {
      refuses(
        { ...valid(), clock },
        'The clock and its method must be frozen.',
      );
    }
    expect(make({ ...valid(), clock: systemClock }).clock).toBe(systemClock);
  });

  it.each([
    [
      'a look-alike',
      () => ({ aborted: false, addEventListener: () => undefined }),
    ],
    [
      'an object made from the prototype',
      () => Object.create(AbortSignal.prototype) as object,
    ],
    [
      'a proxy of a real signal',
      () => new Proxy(new AbortController().signal, {}),
    ],
    ['nothing', () => undefined],
  ])('as signal %s', (_, signal) => {
    refuses(
      { ...valid(), signal: signal() },
      'The signal is not an AbortSignal.',
    );
  });

  it.each([
    ['runId', 'not-a-uuid', 'The run is invalid.'],
    ['runId', auditPlaceholders.eventId, 'The run is invalid.'],
    ['eventId', 'NOT-A-UUID', 'The event is invalid.'],
    ['eventId', auditPlaceholders.eventId, 'The event is invalid.'],
    ['tool', 'ct_Max', 'The tool is invalid.'],
    ['tool', 'whoami', 'The tool is invalid.'],
    ['tool', auditPlaceholders.tool, 'The tool is invalid.'],
  ])('the %s %j', (key, value, message) => {
    refuses({ ...valid(), [key]: value }, message);
  });

  it('options it cannot read as plain data, without running their code', () => {
    const getter = vi.fn(() => 'stdio:local-stdio');
    const actor = Object.defineProperty({ kind: 'user' }, 'id', {
      get: getter,
      enumerable: true,
    });
    refuses(
      { ...valid(), assignment: { tenantId: 'default', actor } },
      'The actor is invalid.',
    );
    expect(getter).not.toHaveBeenCalled();
    const trap = vi.fn();
    const traps: ProxyHandler<object> = {
      get: trap,
      getOwnPropertyDescriptor: trap,
      ownKeys: trap,
    };
    expect(() =>
      createTenantContext(
        new Proxy(valid(), traps) as unknown as TenantContextOptions,
      ),
    ).toThrow('The context options are invalid.');
    refuses(
      {
        ...valid(),
        assignment: new Proxy(valid()['assignment'] as object, traps),
      },
      'The tenant is invalid.',
    );
    refuses(
      { ...valid(), logging: 'stderr' },
      'The logging options are invalid.',
    );
    expect(trap).not.toHaveBeenCalled();
  });

  it('with a fixed message that holds no value', () => {
    const canary = makeCanary('name').value;
    for (const options of [
      { ...valid(), mode: canary },
      { ...valid(), instance: canary },
      { ...valid(), assignment: { tenantId: canary, actor: {} } },
      { ...valid(), features: [canary] },
    ]) {
      const error = (() => {
        try {
          make(options);
        } catch (thrown) {
          return thrown;
        }
        return undefined;
      })();
      expect(error).toBeInstanceOf(TypeError);
      expect(inspect(error)).not.toContain(canary);
    }
  });
});

describe('the context is frozen', () => {
  it('with its actor, features, logger and clock, without prototypes', () => {
    const context = make({ ...valid(), features: ['feature-a'] });
    for (const value of [
      context,
      context.actor,
      context.features,
      context.log,
      context.clock,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(Object.getPrototypeOf(context)).toBeNull();
    expect(Object.getPrototypeOf(context.actor)).toBeNull();
    expect(() => {
      Object.setPrototypeOf(context, {});
    }).toThrow(TypeError);
  });

  // Reflect.set fails without an error, so every case checks the value
  // afterwards as well.
  it('and keeps every field whatever a caller tries', () => {
    const context = make(valid());
    const before = { ...context };
    for (const key of Reflect.ownKeys(context)) {
      expect(() => {
        (context as unknown as Record<PropertyKey, unknown>)[key] = 'changed';
      }, String(key)).toThrow(TypeError);
      expect(Reflect.set(context, key, 'changed')).toBe(false);
      expect(Reflect.deleteProperty(context, key)).toBe(false);
      expect(() =>
        Object.defineProperty(context, key, { value: 'changed' }),
      ).toThrow(TypeError);
    }
    expect({ ...context }).toEqual(before);
    expect(() => {
      (context as unknown as Record<string, unknown>)['extra'] = 1;
    }).toThrow(TypeError);
  });

  // On a frozen empty array, sort, reverse and fill do not throw, so they
  // prove nothing here.
  it('with an empty list of features that takes no entry', () => {
    const { features } = make(valid());
    const list = features as string[];
    expect(() => list.push('x')).toThrow(TypeError);
    expect(() => {
      list.length = 0;
    }).toThrow(TypeError);
    expect(() => list.splice(0, 0, 'x')).toThrow(TypeError);
    expect(() => Object.defineProperty(list, 0, { value: 'x' })).toThrow(
      TypeError,
    );
    expect(features).toEqual([]);
  });

  it('with a list of features that keeps its entries', () => {
    const { features } = make({
      ...valid(),
      features: ['feature-a', 'feature-b'],
    });
    const list = features as string[];
    expect(() => {
      list[0] = 'x';
    }).toThrow(TypeError);
    expect(() => list.sort()).toThrow(TypeError);
    expect(() => list.reverse()).toThrow(TypeError);
    expect(() => list.copyWithin(0, 1)).toThrow(TypeError);
    expect(() => {
      list.length = 1;
    }).toThrow(TypeError);
    expect(features).toEqual(['feature-a', 'feature-b']);
  });

  it('with an actor that keeps its kind and ID', () => {
    const { actor } = make(valid());
    expect(() => {
      (actor as { id: string }).id = 'x';
    }).toThrow(TypeError);
    expect(() => {
      (actor as { kind: string }).kind = 'operator';
    }).toThrow(TypeError);
    expect(actor).toEqual({ kind: 'user', id: 'stdio:local-stdio' });
  });

  it('and gives no value set on Object.prototype', () => {
    const prototype = Object.prototype as Record<string, unknown>;
    try {
      prototype['runId'] = 'polluted';
      expect(make(valid()).runId).toBeUndefined();
    } finally {
      Reflect.deleteProperty(prototype, 'runId');
    }
  });

  it('and a spread copy of it changes nothing', () => {
    const context = make(valid());
    const copy = { ...context, redaction: 'off' };
    expect(copy).not.toBe(context);
    expect(context.redaction).toBe('standard');
  });
});

describe('the signal of the context', () => {
  // A frozen signal can no longer abort: abort() throws, and the signal
  // stays as it was.
  it('is not frozen and still aborts', () => {
    const controller = new AbortController();
    const context = make({ ...valid(), signal: controller.signal });
    const listener = vi.fn();
    context.signal.addEventListener('abort', listener);
    expect(Object.isFrozen(context.signal)).toBe(false);
    expect(() => {
      controller.abort();
    }).not.toThrow();
    expect(context.signal.aborted).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('may be aborted already or come from AbortSignal.timeout', () => {
    const controller = new AbortController();
    controller.abort();
    expect(make({ ...valid(), signal: controller.signal }).signal.aborted).toBe(
      true,
    );
    expect(
      make({ ...valid(), signal: AbortSignal.timeout(60_000) }).signal,
    ).toBeInstanceOf(AbortSignal);
  });

  it('gets no listener from the factory', () => {
    const spy = vi.spyOn(EventTarget.prototype, 'addEventListener');
    make(valid());
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('the logger of the context', () => {
  it('binds the values of the context to every line', () => {
    const lines = recorder();
    // Every value differs from the defaults, so a logger bound to a fixed
    // value instead of the one of the context shows.
    const context = make({
      ...valid(lines),
      mode: 'unattended',
      redaction: 'off',
      readOnly: false,
      runId,
      tool: 'ct_whoami',
      eventId,
    });
    context.log.info('cache_skipped', { count: 2 });
    expect(lines.parsed()).toEqual([
      {
        ts: '2025-10-09T08:53:20.000Z',
        level: 'info',
        event: 'cache_skipped',
        tenantId: 'default',
        runId,
        eventId,
        tool: 'ct_whoami',
        mode: 'unattended',
        redaction: 'off',
        readOnly: false,
        count: 2,
      },
    ]);
  });

  it('lets no call override the bound values or add the actor', () => {
    const lines = recorder();
    const context = make({
      ...valid(lines),
      assignment: {
        tenantId: 'demo-tenant',
        actor: { kind: 'user', id: 'stdio:local-stdio' },
      },
      redaction: 'off',
    });
    context.log.info('call_done', {
      tenantId: 'default',
      mode: 'operator',
      redaction: 'standard',
      actor: 'stdio:other',
    });
    const [line] = lines.parsed();
    expect(line).toMatchObject({
      tenantId: 'demo-tenant',
      mode: 'interactive',
      redaction: 'off',
      dropped: 4,
    });
    expect(lines.lines[0]).not.toContain('stdio:');
  });

  it('writes from its lowest level up', () => {
    const lines = recorder();
    const context = make({
      ...valid(lines),
      logging: { writer: lines.writer, minLevel: 'warn' },
    });
    context.log.info('skipped');
    context.log.warn('kept');
    expect(lines.parsed().map((line) => line['event'])).toEqual(['kept']);
  });

  it('is refused with the placeholder tenant before any line', () => {
    const lines = recorder();
    expect(() =>
      make({
        ...valid(lines),
        assignment: {
          tenantId: auditPlaceholders.tenantId,
          actor: { kind: 'user', id: 'stdio:local-stdio' },
        },
      }),
    ).toThrow('The tenant is invalid.');
    expect(lines.lines).toEqual([]);
  });

  it('is its own for every context', () => {
    expect(make(valid()).log).not.toBe(make(valid()).log);
  });
});

describe('two contexts', () => {
  it('write lines that each carry only their own values', () => {
    const lines = recorder();
    const first = make(valid(lines));
    const second = make({
      ...valid(lines),
      assignment: {
        tenantId: 'demo-tenant',
        actor: { kind: 'user', id: 'stdio:local-stdio' },
      },
      instance: 'https://demo.example',
      redaction: 'off',
      readOnly: false,
    });
    first.log.info('one');
    second.log.info('two');
    first.log.info('three');
    expect(
      lines.parsed().map(({ event, tenantId, redaction, readOnly }) => ({
        event,
        tenantId,
        redaction,
        readOnly,
      })),
    ).toEqual([
      {
        event: 'one',
        tenantId: 'default',
        redaction: 'standard',
        readOnly: true,
      },
      {
        event: 'two',
        tenantId: 'demo-tenant',
        redaction: 'off',
        readOnly: false,
      },
      {
        event: 'three',
        tenantId: 'default',
        redaction: 'standard',
        readOnly: true,
      },
    ]);
  });

  // The threat model names exactly this case: a value left on a shared
  // object passes from one call to the next.
  it('share no object on which a value could be left', () => {
    const lines = recorder();
    const first = make({
      ...valid(lines),
      clock: systemClock,
      features: ['f'],
    });
    const second = make({
      ...valid(lines),
      clock: systemClock,
      features: ['f'],
    });
    const parts = (context: TenantContext): unknown[] => [
      Object.getOwnPropertyDescriptor(context.clock, 'now')?.value,
      Object.getOwnPropertyDescriptor(context.log, 'info')?.value,
      context.features,
      context.actor,
    ];
    for (const target of parts(first)) {
      expect(() => {
        (target as Record<string, unknown>)['stash'] = 'from-first';
      }).toThrow(TypeError);
    }
    for (const target of parts(second)) {
      expect((target as Record<string, unknown>)['stash']).toBeUndefined();
    }
  });

  it('made from the same options are distinct but equal', () => {
    const options = valid();
    const first = make(options);
    const second = make(options);
    expect(second).not.toBe(first);
    expect(second.actor).not.toBe(first.actor);
    expect(second.log).not.toBe(first.log);
    expect({ ...second, log: undefined }).toEqual({ ...first, log: undefined });
  });
});

describe('the types of the options', () => {
  it('fit a context built from typed values', () => {
    const lines = recorder();
    const options: TenantContextOptions = {
      assignment: {
        tenantId: 'default' as TenantId,
        actor: { kind: 'user', id: 'stdio:local-stdio' },
      },
      instance: 'https://example.church.tools',
      mode: 'interactive',
      redaction: 'standard',
      readOnly: true,
      features: [],
      clock: fakeClock,
      signal: new AbortController().signal,
      logging: { writer: lines.writer, minLevel: 'info' },
      runId: runId as RunId,
      tool: 'ct_whoami',
      eventId,
    };
    expect(createTenantContext(options).runId).toBe(runId);
  });
});
