import { loadConfig } from '@ecclium/mcp-churchtools-core';
import {
  isEccliumError,
  type LogFields,
  type TenantContext,
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

import { createChurchToolsClient } from './client.js';

// Every request goes through the real transport on the ChurchTools double,
// which answers from interceptors and connects nowhere. Bodies are
// invented, hosts lie under .example or are the placeholder instance, and
// tokens are canaries made at run time.

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

interface Line {
  readonly event: string;
  readonly fields: LogFields | undefined;
}

// A clock that runs one second per reading.
const runningClock = () => {
  let now = 0;
  return Object.freeze({
    now: (): number => {
      now += 1_000;
      return now;
    },
  });
};

const setup = (requestsPerMinute = 300) => {
  const double = createChurchToolsDouble({ token });
  open.push(double);
  const client = createChurchToolsClient({
    transport: double.transport,
    origin: doubleOrigin,
    requestsPerMinute,
    clock: runningClock(),
  });
  const lines: Line[] = [];
  const record = (event: string, fields?: LogFields): void => {
    lines.push({ event, fields });
  };
  const ctx = (instance = doubleOrigin): TenantContext =>
    Object.freeze({
      instance,
      signal: new AbortController().signal,
      log: Object.freeze({
        debug: record,
        info: record,
        warn: record,
        error: record,
      }),
      clock: runningClock(),
    }) as unknown as TenantContext;
  return { double, client, ctx, lines };
};

const whoamiPath = '/api/whoami?only_allow_authenticated=true';
const json = { headers: { 'content-type': 'application/json' } };

const person = (data: Record<string, unknown> = {}) =>
  JSON.stringify({
    data: {
      id: 7,
      guid: '00000000-0000-0000-0000-000000000007',
      firstName: 'Person',
      lastName: 'A',
      email: 'max.mustermann@example.org',
      ...data,
    },
    meta: { simulatingUserId: null },
  });

const codeOf = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call;
  } catch (error) {
    if (isEccliumError(error)) return error.code;
    throw error;
  }
  throw new Error('expected the call to fail');
};

describe('whoami', () => {
  it('asks once with only_allow_authenticated and gives exactly the fields of Me', async () => {
    const { double, client, ctx } = setup();
    double
      .intercept({ path: whoamiPath, method: 'GET' })
      .reply(200, person({ title: 'x', sexId: 1 }), json);
    const me = await client.whoami(ctx());
    expect(me).toEqual({
      id: 7,
      firstName: 'Person',
      lastName: 'A',
      email: 'max.mustermann@example.org',
    });
    expect(Object.isFrozen(me)).toBe(true);
    expect(Object.getPrototypeOf(me)).toBeNull();
    expect(double.calls()).toHaveLength(1);
  });

  it.each([
    ['', null],
    [null, null],
  ])('gives null for the e-mail address %j', async (email, expected) => {
    const { double, client, ctx } = setup();
    double
      .intercept({ path: whoamiPath, method: 'GET' })
      .reply(200, person({ email }), json);
    expect((await client.whoami(ctx())).email).toBe(expected);
  });

  it('never sends whoami without the parameter', async () => {
    const { double, client, ctx } = setup();
    double
      .intercept({ path: '/api/whoami', method: 'GET' })
      .reply(200, person(), json);
    double
      .intercept({
        path: '/api/whoami?only_allow_authenticated=false',
        method: 'GET',
      })
      .reply(200, person(), json);
    expect(await codeOf(client.whoami(ctx()))).toBe('network');
  });

  it.each([
    [
      'the anonymous answer',
      JSON.stringify({
        data: { id: 0, guid: '', firstName: '', isAnonymous: true },
      }),
    ],
    [
      'an anonymous answer with id -1',
      JSON.stringify({ data: { id: -1, guid: '', firstName: '' } }),
    ],
    [
      'an anonymous answer with id null',
      JSON.stringify({ data: { id: null, guid: '' } }),
    ],
    ['an anonymous answer without id', JSON.stringify({ data: { guid: '' } })],
    ['a full answer with an empty guid', person({ guid: '' })],
    [
      'an answer that simulates another person',
      JSON.stringify({
        data: (JSON.parse(person()) as { data: unknown }).data,
        meta: { simulatingUserId: 9 },
      }),
    ],
  ])('gives auth for %s, without another request', async (_, body) => {
    const { double, client, ctx, lines } = setup();
    double
      .intercept({ path: whoamiPath, method: 'GET' })
      .reply(200, body, json);
    expect(await codeOf(client.whoami(ctx()))).toBe('auth');
    expect(double.calls()).toHaveLength(1);
    expect(lines.map((line) => line.event)).toContain(
      'churchtools_whoami_anonymous',
    );
  });

  it.each([
    ['guid null', person({ guid: null })],
    ['guid a number', person({ guid: 1 })],
    [
      'no guid',
      JSON.stringify({
        data: { id: 7, firstName: 'P', lastName: 'A', email: null },
      }),
    ],
    ['data no object', JSON.stringify({ data: [1] })],
    ['id 1e400', person().replace('"id":7', '"id":1e400')],
    ['id 2^53+1', person({ id: 2 ** 53 + 1 })],
    ['id 0', person({ id: 0 })],
    ['id 1.5', person({ id: 1.5 })],
    ['id "1"', person({ id: '1' })],
    ['id true', person({ id: true })],
    ['a name of 10000 characters', person({ lastName: 'a'.repeat(10_000) })],
    ['a lone surrogate', person({ firstName: 'a\uD800b' })],
    ['a lone low surrogate', person({ firstName: 'a\uDC00b' })],
    ['an e-mail address that is a number', person({ email: 1 })],
  ])('gives upstream for %s', async (_, body) => {
    const { double, client, ctx } = setup();
    double
      .intercept({ path: whoamiPath, method: 'GET' })
      .reply(200, body, json);
    expect(await codeOf(client.whoami(ctx()))).toBe('upstream');
  });

  it('takes a name with a surrogate pair', async () => {
    const { double, client, ctx } = setup();
    double
      .intercept({ path: whoamiPath, method: 'GET' })
      .reply(200, person({ firstName: 'Ann\u{1F600}' }), json);
    expect((await client.whoami(ctx())).firstName).toBe('Ann\u{1F600}');
  });

  it('takes an empty first name with a guid', async () => {
    const { double, client, ctx } = setup();
    double
      .intercept({ path: whoamiPath, method: 'GET' })
      .reply(200, person({ firstName: '' }), json);
    expect((await client.whoami(ctx())).firstName).toBe('');
  });

  it('keeps __proto__ and constructor of the answer away from every prototype', async () => {
    const { double, client, ctx } = setup();
    const body = person().replace(
      '"id":7',
      '"__proto__":{"polluted":1},"constructor":{"x":1},"id":7',
    );
    double
      .intercept({ path: whoamiPath, method: 'GET' })
      .reply(200, body, json);
    const me = await client.whoami(ctx());
    expect(Object.keys(me)).toEqual(['id', 'firstName', 'lastName', 'email']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses an answer above its size and answers the next call', async () => {
    const { double, client, ctx } = setup();
    double
      .intercept({ path: whoamiPath, method: 'GET' })
      .reply(200, person({ lastName: 'a'.repeat(256 * 1024) }), json);
    expect(await codeOf(client.whoami(ctx()))).toBe('upstream');
    double
      .intercept({ path: whoamiPath, method: 'GET' })
      .reply(200, person(), json);
    expect((await client.whoami(ctx())).id).toBe(7);
  });

  it.each([
    [401, 'auth'],
    [403, 'permission'],
    [404, 'upstream'],
    [400, 'internal'],
    [500, 'upstream'],
    [429, 'rate_limited'],
  ])(
    'maps status %i to %s and logs status and code only',
    async (status, code) => {
      const { double, client, ctx, lines } = setup();
      double
        .intercept({ path: whoamiPath, method: 'GET' })
        .reply(status, '{}', json);
      expect(await codeOf(client.whoami(ctx()))).toBe(code);
      expect(lines).toEqual([
        { event: 'churchtools_whoami_status', fields: { status, code } },
      ]);
    },
  );

  it('names the wait of a 429 from ChurchTools', async () => {
    const { double, client, ctx } = setup();
    double
      .intercept({ path: whoamiPath, method: 'GET' })
      .reply(429, '', { headers: { 'retry-after': '30' } });
    await expect(client.whoami(ctx())).rejects.toMatchObject({
      code: 'rate_limited',
      message:
        'ChurchTools limits the number of requests. Wait 30 seconds, then try again.',
    });
  });

  it('keeps the values of an error body out of error and log', async () => {
    const { double, client, ctx, lines } = setup();
    const canaries = makeCanaries();
    const fields = {
      message: canaries.token.value,
      translatedMessage: canaries.email.value,
      args: [canaries.name.value],
      errors: [{ value: canaries.phone.value }],
    };
    assertPlanted(fields, canaries.all, 'error body');
    double
      .intercept({ path: whoamiPath, method: 'GET' })
      .reply(400, JSON.stringify(fields), json);
    let thrown: unknown;
    try {
      await client.whoami(ctx());
    } catch (error) {
      thrown = error;
    }
    assertNoCanary(thrown, canaries.all, 'error');
    assertNoCanary(lines, canaries.all, 'log');
  });
});

describe('permissions', () => {
  const path = '/api/permissions/global';

  it('gives the set rights only, frozen and without prototypes', async () => {
    const { double, client, ctx } = setup();
    double.intercept({ path, method: 'GET' }).reply(
      200,
      JSON.stringify({
        data: {
          churchwiki: {
            view: [3, 4],
            edit: [],
            admin: false,
            'view own': true,
          },
          churchdb: { x: false },
        },
      }),
      json,
    );
    const result = await client.permissions(ctx());
    expect(result).toEqual({
      kind: 'known',
      granted: { churchwiki: { view: [3, 4], 'view own': true } },
    });
    if (result.kind !== 'known') return;
    expect(Object.getPrototypeOf(result.granted)).toBeNull();
    expect(Object.getPrototypeOf(result.granted.churchwiki)).toBeNull();
    expect(Object.isFrozen(result.granted.churchwiki?.view)).toBe(true);
  });

  it.each([
    ['data no object', { data: [1] }],
    ['a module no object', { data: { churchwiki: true } }],
    [
      'a module __proto__',
      JSON.parse('{"data":{"__proto__":{"view":true}}}') as unknown,
    ],
    ['a right constructor', { data: { churchwiki: { constructor: true } } }],
    [
      'a name with a blank at the end',
      { data: { 'churchwiki ': { view: true } } },
    ],
    ['an empty name', { data: { churchwiki: { '': true } } }],
    ['a name that is not ASCII', { data: { churchwiki: { vièw: true } } }],
    ['a value that is a number', { data: { churchwiki: { view: 1 } } }],
    ['a list with 0', { data: { churchwiki: { view: [0] } } }],
    ['a list with a text', { data: { churchwiki: { view: ['1'] } } }],
    [
      'a list of 10001 IDs',
      {
        data: {
          churchwiki: { view: Array.from({ length: 10_001 }, (_, i) => i + 1) },
        },
      },
    ],
    [
      '101 modules',
      {
        data: Object.fromEntries(
          Array.from({ length: 101 }, (_, i) => [`m${String(i)}`, {}]),
        ),
      },
    ],
    [
      '501 rights',
      {
        data: {
          m: Object.fromEntries(
            Array.from({ length: 501 }, (_, i) => [`r${String(i)}`, true]),
          ),
        },
      },
    ],
  ])('gives unknown for %s, never a part', async (_, body) => {
    const { double, client, ctx, lines } = setup();
    double
      .intercept({ path, method: 'GET' })
      .reply(200, JSON.stringify(body), json);
    expect(await client.permissions(ctx())).toEqual({ kind: 'unknown' });
    expect(lines.map((line) => line.event)).toEqual([
      'churchtools_permissions_unknown',
    ]);
  });

  it('takes 100 modules and 500 rights', async () => {
    const { double, client, ctx } = setup();
    const data: Record<string, Record<string, boolean>> = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`m${String(i)}`, { r: true }]),
    );
    data.m0 = Object.fromEntries(
      Array.from({ length: 500 }, (_, i) => [`r${String(i)}`, true]),
    );
    double
      .intercept({ path, method: 'GET' })
      .reply(200, JSON.stringify({ data }), json);
    expect((await client.permissions(ctx())).kind).toBe('known');
  });

  it('keeps errors of the answer as errors', async () => {
    const { double, client, ctx } = setup();
    double.intercept({ path, method: 'GET' }).reply(200, 'not json', json);
    double.intercept({ path, method: 'GET' }).reply(401, '{}', json);
    expect(await codeOf(client.permissions(ctx()))).toBe('upstream');
    expect(await codeOf(client.permissions(ctx()))).toBe('auth');
  });
});

describe('the client', () => {
  it.each([
    'https://example.church.tools/',
    'http://example.church.tools',
    'example.church.tools',
  ])('refuses the origin %j when it is built', (origin) => {
    const double = createChurchToolsDouble({ token });
    open.push(double);
    expect(() =>
      createChurchToolsClient({
        transport: double.transport,
        origin,
        requestsPerMinute: 300,
        clock: runningClock(),
      }),
    ).toThrow(TypeError);
  });

  it('refuses a context of another instance before it takes a place or sends', async () => {
    const { double, client, ctx, lines } = setup(6);
    expect(await codeOf(client.whoami(ctx('https://other.example')))).toBe(
      'internal',
    );
    expect(lines.map((line) => line.event)).toEqual([
      'churchtools_context_mismatch',
    ]);
    expect(double.calls()).toHaveLength(0);
    double
      .intercept({ path: whoamiPath, method: 'GET' })
      .reply(200, person(), json);
    expect((await client.whoami(ctx())).id).toBe(7);
  });

  it('refuses a request once its throttle is empty, with the wait', async () => {
    const { double, client, ctx, lines } = setup(6);
    double
      .intercept({ path: whoamiPath, method: 'GET' })
      .reply(200, person(), json);
    await client.whoami(ctx());
    let thrown: unknown;
    try {
      await client.whoami(ctx());
    } catch (error) {
      thrown = error;
    }
    expect(isEccliumError(thrown) && thrown.code).toBe('rate_limited');
    expect(isEccliumError(thrown) && thrown.message).toMatch(
      /^Ecclium limits its own requests to ChurchTools\. Wait \d+ seconds, then try again\.$/,
    );
    expect(lines.map((line) => line.event)).toEqual(['churchtools_throttled']);
    expect(double.calls()).toHaveLength(1);
  });

  it('shares no throttle between two clients', async () => {
    const a = setup(6);
    const b = setup(6);
    a.double
      .intercept({ path: whoamiPath, method: 'GET' })
      .reply(200, person(), json);
    b.double
      .intercept({ path: whoamiPath, method: 'GET' })
      .reply(200, person(), json);
    await a.client.whoami(a.ctx());
    expect(await codeOf(a.client.whoami(a.ctx()))).toBe('rate_limited');
    expect((await b.client.whoami(b.ctx())).id).toBe(7);
  });

  it('passes errors of the transport on unchanged', async () => {
    const { client, ctx } = setup();
    expect(await codeOf(client.whoami(ctx()))).toBe('network');
  });

  it('is frozen and shows nothing but its two operations', () => {
    const { client } = setup();
    expect(Object.keys(client)).toEqual(['whoami', 'permissions']);
    expect(Object.isFrozen(client)).toBe(true);
  });
});
