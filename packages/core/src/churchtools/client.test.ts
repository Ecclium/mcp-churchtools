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
  groupsAtHighestLevel,
  makeCanaries,
  makeCanary,
  personsAtHighestLevel,
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

  // undefined leaves the key out of the JSON: an account that may not see
  // persons gets its own person without the e-mail.
  it.each([
    ['', null],
    [null, null],
    [undefined, null],
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
            'view category': [0, 2],
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
      granted: {
        churchwiki: { view: [3, 4], 'view category': [0, 2], 'view own': true },
      },
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
    ['a list with -1', { data: { churchwiki: { view: [0, -1] } } }],
    ['a list with 1.5', { data: { churchwiki: { view: [1.5] } } }],
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

describe('searchPersons and searchGroups', () => {
  // Matches the path without the query; the test reads what was sent from
  // the calls of the double.
  const at = (pathname: string) => (path: string) =>
    path.split('?')[0] === pathname;
  const persons = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: index + 1,
      firstName: 'Person',
      lastName: `P${String(index + 1)}`,
    }));
  const groupList = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: index + 1,
      name: `Gruppe ${String(index + 1)}`,
    }));
  const list = (data: unknown, meta: unknown = { count: 1 }) =>
    JSON.stringify({ data, meta });

  it('sends exactly query, page 1 and limit 51 and gives the hits of the list only', async () => {
    const { double, client, ctx } = setup();
    double.intercept({ path: at('/api/persons'), method: 'GET' }).reply(
      200,
      list([
        { ...persons(1)[0], email: 'max.mustermann@example.org', guid: 'g' },
        { id: 9, firstName: '', lastName: 'B', title: 'x' },
      ]),
      json,
    );
    const result = await client.searchPersons(ctx(), '  Person ');
    expect(result).toEqual({
      hits: [
        { id: 1, firstName: 'Person', lastName: 'P1' },
        { id: 9, firstName: '', lastName: 'B' },
      ],
      more: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.hits)).toBe(true);
    expect(Object.getPrototypeOf(result)).toBeNull();
    for (const hit of result.hits) {
      expect(Object.isFrozen(hit)).toBe(true);
      expect(Object.getPrototypeOf(hit)).toBeNull();
      expect(Object.keys(hit)).toEqual(['id', 'firstName', 'lastName']);
    }
    const calls = double.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/api/persons');
    expect(calls[0]?.searchParams).toEqual({
      query: 'Person',
      page: '1',
      limit: '51',
    });
  });

  it('gives 50 hits and more for 51 entries, and no more for 50 or none', async () => {
    const { double, client, ctx } = setup();
    for (const count of [51, 50, 0]) {
      double
        .intercept({ path: at('/api/persons'), method: 'GET' })
        .reply(200, list(persons(count)), json);
    }
    const full = await client.searchPersons(ctx(), 'Person');
    expect(full.hits).toHaveLength(50);
    expect(full.hits.at(-1)?.id).toBe(50);
    expect(full.more).toBe(true);
    const fifty = await client.searchPersons(ctx(), 'Person');
    expect(fifty.hits).toHaveLength(50);
    expect(fifty.more).toBe(false);
    expect(await client.searchPersons(ctx(), 'Person')).toEqual({
      hits: [],
      more: false,
    });
  });

  it('reads no number from meta, whatever it says', async () => {
    const { double, client, ctx } = setup();
    double.intercept({ path: at('/api/persons'), method: 'GET' }).reply(
      200,
      list(persons(2), {
        count: 900,
        all: 'x',
        pagination: { total: -1, lastPage: null },
      }),
      json,
    );
    expect(await client.searchPersons(ctx(), 'Person')).toEqual({
      hits: persons(2),
      more: false,
    });
  });

  it.each([
    ['52 entries', list(persons(52))],
    ['no data', JSON.stringify({ meta: { count: 0 } })],
    ['data no list', JSON.stringify({ data: { id: 1 } })],
    ['a first name null', list([{ id: 1, firstName: null, lastName: 'A' }])],
    ['no last name', list([{ id: 1, firstName: 'P' }])],
    [
      'a last name that is a number',
      list([{ id: 1, firstName: 'P', lastName: 1 }]),
    ],
    ['id 0', list([{ id: 0, firstName: 'P', lastName: 'A' }])],
    ['id "1"', list([{ id: '1', firstName: 'P', lastName: 'A' }])],
    ['no id', list([{ firstName: 'P', lastName: 'A' }])],
    [
      'a name of 256 characters',
      list([{ id: 1, firstName: 'a'.repeat(256), lastName: 'A' }]),
    ],
    [
      'a lone surrogate',
      list([{ id: 1, firstName: 'a\uD800', lastName: 'A' }]),
    ],
    ['an entry that is no object', list([1])],
  ])('gives upstream for %s, never a part', async (_, body) => {
    const { double, client, ctx, lines } = setup();
    double
      .intercept({ path: at('/api/persons'), method: 'GET' })
      .reply(200, body, json);
    expect(await codeOf(client.searchPersons(ctx(), 'Person'))).toBe(
      'upstream',
    );
    expect(lines.map((line) => line.event)).toEqual([
      'churchtools_persons_refused',
    ]);
  });

  it('takes names of 255 characters', async () => {
    const { double, client, ctx } = setup();
    const long = 'a'.repeat(255);
    double
      .intercept({ path: at('/api/persons'), method: 'GET' })
      .reply(200, list([{ id: 1, firstName: long, lastName: long }]), json);
    expect((await client.searchPersons(ctx(), 'a')).hits[0]?.firstName).toBe(
      long,
    );
  });

  it.each([
    ['an empty term', ''],
    ['a term of spaces', '   '],
    ['a term with a line break', 'Person\nA'],
    ['a term of 101 characters', 'a'.repeat(101)],
    ['a term with a lone surrogate', 'a\uD800'],
  ])(
    'refuses %s with validation, before a request and a place of the throttle',
    async (_, query) => {
      const { double, client, ctx, lines } = setup(6);
      let thrown: unknown;
      try {
        await client.searchPersons(ctx(), query);
      } catch (error) {
        thrown = error;
      }
      expect(isEccliumError(thrown) && thrown.code).toBe('validation');
      expect(isEccliumError(thrown) && thrown.message).toBe(
        'The search term needs 1 to 100 characters after removing spaces at both ends, and no control characters.',
      );
      expect(await codeOf(client.searchGroups(ctx(), query))).toBe(
        'validation',
      );
      expect(lines.map((line) => line.event)).toEqual([
        'churchtools_persons_term_refused',
        'churchtools_groups_term_refused',
      ]);
      expect(double.calls()).toHaveLength(0);
      // The throttle of 6 per minute holds one place; it is still free.
      double
        .intercept({ path: at('/api/persons'), method: 'GET' })
        .reply(200, list([]), json);
      expect((await client.searchPersons(ctx(), 'Person')).hits).toEqual([]);
    },
  );

  it('refuses a term that is no string, as a plugin could pass one', async () => {
    const { client, ctx } = setup();
    // The types forbid it; a plugin built without them can still do it.
    const query = { query: 'Person' } as unknown as string;
    expect(await codeOf(client.searchPersons(ctx(), query))).toBe('validation');
  });

  it.each([
    [401, 'auth'],
    [403, 'permission'],
    [404, 'upstream'],
    [400, 'internal'],
    [500, 'upstream'],
    [429, 'rate_limited'],
  ])('maps status %i to %s for both searches', async (status, code) => {
    const { double, client, ctx, lines } = setup();
    double
      .intercept({ path: at('/api/persons'), method: 'GET' })
      .reply(status, '{}', json);
    double
      .intercept({ path: at('/api/groups'), method: 'GET' })
      .reply(status, '{}', json);
    expect(await codeOf(client.searchPersons(ctx(), 'Person'))).toBe(code);
    expect(await codeOf(client.searchGroups(ctx(), 'Gruppe'))).toBe(code);
    expect(lines).toEqual([
      { event: 'churchtools_persons_status', fields: { status, code } },
      { event: 'churchtools_groups_status', fields: { status, code } },
    ]);
  });

  it('refuses a context of another instance before it sends', async () => {
    const { double, client, ctx } = setup();
    expect(
      await codeOf(client.searchGroups(ctx('https://other.example'), 'G')),
    ).toBe('internal');
    expect(double.calls()).toHaveLength(0);
  });

  it('searches groups with exactly query, page and limit and gives ID and name only', async () => {
    const { double, client, ctx } = setup();
    double.intercept({ path: at('/api/groups'), method: 'GET' }).reply(
      200,
      list([
        { id: 4, name: 'Gruppe A', guid: 'g', information: { note: 'x' } },
        { id: 5, name: '' },
      ]),
      json,
    );
    const result = await client.searchGroups(ctx(), 'Gruppe');
    expect(result).toEqual({
      hits: [
        { id: 4, name: 'Gruppe A' },
        { id: 5, name: '' },
      ],
      more: false,
    });
    expect(Object.getPrototypeOf(result.hits[0])).toBeNull();
    expect(double.calls()[0]?.path).toBe('/api/groups');
    expect(double.calls()[0]?.searchParams).toEqual({
      query: 'Gruppe',
      page: '1',
      limit: '51',
    });
  });

  it('gives 50 groups and more for 51 entries', async () => {
    const { double, client, ctx } = setup();
    double
      .intercept({ path: at('/api/groups'), method: 'GET' })
      .reply(200, list(groupList(51)), json);
    const result = await client.searchGroups(ctx(), 'Gruppe');
    expect(result.hits).toHaveLength(50);
    expect(result.more).toBe(true);
  });

  it.each([
    ['a name null', list([{ id: 1, name: null }])],
    ['no name', list([{ id: 1 }])],
    ['52 entries', list(groupList(52))],
  ])('gives upstream for a group list with %s', async (_, body) => {
    const { double, client, ctx, lines } = setup();
    double
      .intercept({ path: at('/api/groups'), method: 'GET' })
      .reply(200, body, json);
    expect(await codeOf(client.searchGroups(ctx(), 'Gruppe'))).toBe('upstream');
    expect(lines.map((line) => line.event)).toEqual([
      'churchtools_groups_refused',
    ]);
  });

  // The limits fit 51 entries at the highest security level, and no more:
  // an answer above 1 MiB or with more than 100'000 elements is refused.
  it('refuses a search answer above 1 MiB and one above 100000 elements', async () => {
    const { double, client, ctx } = setup();
    const padded = persons(51).map((entry) => ({
      ...entry,
      note: 'a'.repeat(21_000),
    }));
    expect(list(padded).length).toBeGreaterThan(1024 * 1024);
    double
      .intercept({ path: at('/api/persons'), method: 'GET' })
      .reply(200, list(padded), json);
    expect(await codeOf(client.searchPersons(ctx(), 'Person'))).toBe(
      'upstream',
    );
    const crowded = [
      { ...persons(1)[0], ids: Array.from({ length: 100_000 }, () => 1) },
    ];
    expect(list(crowded).length).toBeLessThan(1024 * 1024);
    double
      .intercept({ path: at('/api/persons'), method: 'GET' })
      .reply(200, list(crowded), json);
    expect(await codeOf(client.searchPersons(ctx(), 'Person'))).toBe(
      'upstream',
    );
    const below = [
      { ...persons(1)[0], ids: Array.from({ length: 99_000 }, () => 1) },
    ];
    double
      .intercept({ path: at('/api/persons'), method: 'GET' })
      .reply(200, list(below), json);
    expect((await client.searchPersons(ctx(), 'Person')).hits).toEqual(
      persons(1),
    );
  });

  // The layer of the client (ADR 0060): an answer at the highest security
  // levels, 51 entries with every field, gives only ID and names, and none
  // of the other fields reaches the result or the log.
  it('takes 51 persons at the highest level and keeps only ID and names', async () => {
    const { double, client, ctx, lines } = setup();
    const answer = personsAtHighestLevel(persons(51));
    assertPlanted(JSON.parse(answer.body), answer.canaries, 'answer');
    double
      .intercept({ path: at('/api/persons'), method: 'GET' })
      .reply(200, answer.body, json);
    const result = await client.searchPersons(ctx(), 'Person');
    expect(result).toEqual({ hits: persons(50), more: true });
    assertNoCanary(result, answer.canaries, 'result');
    assertNoCanary(lines, answer.canaries, 'log');
  });

  it('takes 51 groups at the highest level and keeps only ID and name', async () => {
    const { double, client, ctx, lines } = setup();
    const answer = groupsAtHighestLevel(groupList(51));
    assertPlanted(JSON.parse(answer.body), answer.canaries, 'answer');
    double
      .intercept({ path: at('/api/groups'), method: 'GET' })
      .reply(200, answer.body, json);
    const result = await client.searchGroups(ctx(), 'Gruppe');
    expect(result).toEqual({ hits: groupList(50), more: true });
    assertNoCanary(result, answer.canaries, 'result');
    assertNoCanary(lines, answer.canaries, 'log');
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

  it('is frozen and shows nothing but its seven operations', () => {
    const { client } = setup();
    expect(Object.keys(client)).toEqual([
      'whoami',
      'permissions',
      'searchPersons',
      'searchGroups',
      'wikiCategories',
      'wikiPages',
      'wikiPage',
    ]);
    expect(Object.isFrozen(client)).toBe(true);
  });
});

describe('the wiki', () => {
  const guid = '00000000-0000-4000-8000-000000000001';
  const pagePath = `/api/wiki/categories/4/pages/${guid}`;
  const at = (pathname: string) => (path: string) =>
    path.split('?')[0] === pathname;
  // The object ChurchTools puts in meta for the person who created and
  // who last changed a page (`docs/research/churchtools-api.md`,
  // «Personendaten in Wiki-Antworten»), with canaries in every text.
  const personMeta = (name: string, email: string) => ({
    title: name,
    domainType: 'person',
    domainIdentifier: '7',
    apiUrl: `https://example.church.tools/api/persons/7?${email}`,
    domainAttributes: {
      firstName: name,
      lastName: name,
      guid: '00000000-0000-0000-0000-000000000007',
      isArchived: false,
    },
  });
  const entry = (index: number, name = 'Person', email = 'x') => ({
    guid: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    identifier: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    title: `Seite ${String(index)}`,
    version: index,
    isMarkdown: index % 2 === 1,
    onStartpage: false,
    redirectTo: null,
    wikiCategory: { id: 4, name: 'Kategorie', permissions: {} },
    permissions: { canEdit: false, canDelete: false },
    meta: {
      createdDate: '2026-10-09T08:00:00Z',
      createdPerson: personMeta(name, email),
      modifiedDate: '2026-10-09T08:00:00Z',
      modifiedPerson: personMeta(name, email),
    },
  });
  const pageList = (
    entries: readonly unknown[],
    current = 1,
    lastPage = 1,
  ): string =>
    JSON.stringify({
      data: entries,
      meta: {
        count: entries.length,
        pagination: { total: entries.length, limit: 25, current, lastPage },
      },
    });
  const pageAnswer = (data: Record<string, unknown> = {}) =>
    JSON.stringify({
      data: { ...entry(2), text: '# Titel\n\nText', ...data },
    });
  const categoryList = (count: number, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      data: Array.from({ length: count }, (_, index) => ({
        id: index + 1,
        name: `Kategorie ${String(index + 1)}`,
        nameTranslated: `Kategorie ${String(index + 1)}`,
        sortKey: index,
        permissions: { canEdit: false, canDelete: false },
        ...extra,
      })),
      meta: { count },
      permissions: { editMasterData: false },
    });

  it('lists the categories with ID and name only, without a query', async () => {
    const { double, client, ctx } = setup();
    double
      .intercept({ path: '/api/wiki/categories', method: 'GET' })
      .reply(200, categoryList(2), json);
    const result = await client.wikiCategories(ctx());
    expect(result).toEqual([
      { id: 1, name: 'Kategorie 1' },
      { id: 2, name: 'Kategorie 2' },
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    for (const category of result) {
      expect(Object.getPrototypeOf(category)).toBeNull();
      expect(Object.isFrozen(category)).toBe(true);
    }
    expect(double.calls()[0]?.searchParams).toEqual({});
  });

  it('gives all of 1000 categories, and upstream above 1000', async () => {
    const { double, client, ctx, lines } = setup();
    double
      .intercept({ path: '/api/wiki/categories', method: 'GET' })
      .reply(200, categoryList(1000), json);
    double
      .intercept({ path: '/api/wiki/categories', method: 'GET' })
      .reply(200, categoryList(1001), json);
    expect(await client.wikiCategories(ctx())).toHaveLength(1000);
    expect(await codeOf(client.wikiCategories(ctx()))).toBe('upstream');
    expect(lines.map((line) => line.event)).toEqual([
      'churchtools_wiki_categories_refused',
    ]);
  });

  it.each([
    ['a name null', { name: null }],
    ['an ID 0', { id: 0 }],
    ['a name of 256 characters', { name: 'x'.repeat(256) }],
  ])('gives upstream for a category with %s', async (_, extra) => {
    const { double, client, ctx } = setup();
    double
      .intercept({ path: '/api/wiki/categories', method: 'GET' })
      .reply(200, categoryList(1, extra), json);
    expect(await codeOf(client.wikiCategories(ctx()))).toBe('upstream');
  });

  it('lists the pages of a category with exactly the category, the page and limit 25', async () => {
    const { double, client, ctx } = setup();
    const name = makeCanary('name');
    const email = makeCanary('email');
    double
      .intercept({ path: at('/api/wiki/pages'), method: 'GET' })
      .reply(
        200,
        pageList([entry(1, name.value, email.value), entry(2)], 2, 3),
        json,
      );
    const result = await client.wikiPages(ctx(), 4, 2);
    expect(result).toEqual({
      pages: [
        {
          guid: '00000000-0000-4000-8000-000000000001',
          title: 'Seite 1',
          isMarkdown: true,
          version: 1,
        },
        {
          guid: '00000000-0000-4000-8000-000000000002',
          title: 'Seite 2',
          isMarkdown: false,
          version: 2,
        },
      ],
      more: true,
    });
    assertNoCanary(result, [name, email], 'pages');
    expect(Object.getPrototypeOf(result.pages[0])).toBeNull();
    expect(Object.isFrozen(result.pages)).toBe(true);
    expect(double.calls()[0]?.path).toBe('/api/wiki/pages');
    expect(double.calls()[0]?.searchParams).toEqual({
      'wiki_category_ids[]': '4',
      page: '2',
      limit: '25',
    });
  });

  it('takes exactly 25 entries', async () => {
    const { double, client, ctx } = setup();
    double
      .intercept({ path: at('/api/wiki/pages'), method: 'GET' })
      .reply(
        200,
        pageList(Array.from({ length: 25 }, (_, i) => entry(i + 1))),
        json,
      );
    expect((await client.wikiPages(ctx(), 4, 1)).pages).toHaveLength(25);
  });

  it('says no more on the last page and on a page behind it', async () => {
    const { double, client, ctx } = setup();
    double
      .intercept({ path: at('/api/wiki/pages'), method: 'GET' })
      .reply(200, pageList([entry(1)], 3, 3), json);
    double
      .intercept({ path: at('/api/wiki/pages'), method: 'GET' })
      .reply(200, pageList([], 4, 3), json);
    expect((await client.wikiPages(ctx(), 4, 3)).more).toBe(false);
    expect(await client.wikiPages(ctx(), 4, 4)).toEqual({
      pages: [],
      more: false,
    });
  });

  it.each([
    [
      '26 entries',
      pageList(Array.from({ length: 26 }, (_, i) => entry(i + 1))),
    ],
    ['a GUID of another form', pageList([{ ...entry(1), guid: 'Startseite' }])],
    ['no isMarkdown', pageList([{ ...entry(1), isMarkdown: undefined }])],
    ['a version 0', pageList([{ ...entry(1), version: 0 }])],
    ['no pagination', JSON.stringify({ data: [entry(1)], meta: { count: 1 } })],
  ])('gives upstream for a page list with %s', async (_, body) => {
    const { double, client, ctx, lines } = setup();
    double
      .intercept({ path: at('/api/wiki/pages'), method: 'GET' })
      .reply(200, body, json);
    expect(await codeOf(client.wikiPages(ctx(), 4, 1))).toBe('upstream');
    expect(lines.map((line) => line.event)).toEqual([
      'churchtools_wiki_pages_refused',
    ]);
  });

  // The types forbid most of these; a plugin built without them can still
  // pass them.
  it.each([
    [0, 1],
    [4, 0],
    [-1, 1],
    [1.5, 1],
    [4, Number.NaN],
    [4, 1001],
    ['4' as unknown as number, 1],
  ])(
    'refuses the category %j and page %j before any request',
    async (categoryId, page) => {
      const { double, client, ctx, lines } = setup();
      expect(await codeOf(client.wikiPages(ctx(), categoryId, page))).toBe(
        'validation',
      );
      expect(double.calls()).toHaveLength(0);
      expect(lines.map((line) => line.event)).toEqual([
        'churchtools_wiki_input_refused',
      ]);
    },
  );

  it('reads a page by its GUID in the newest version, without the persons of meta', async () => {
    const { double, client, ctx } = setup();
    const name = makeCanary('name');
    const email = makeCanary('email');
    double.intercept({ path: pagePath, method: 'GET' }).reply(
      200,
      pageAnswer({
        guid,
        meta: { modifiedPerson: personMeta(name.value, email.value) },
      }),
      json,
    );
    const page = await client.wikiPage(ctx(), 4, guid);
    expect(page).toEqual({
      guid,
      title: 'Seite 2',
      isMarkdown: false,
      version: 2,
      text: '# Titel\n\nText',
    });
    assertNoCanary(page, [name, email], 'page');
    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.getPrototypeOf(page)).toBeNull();
    expect(double.calls()[0]?.searchParams).toEqual({});
  });

  it('reads exactly the version asked for, and refuses another one', async () => {
    const { double, client, ctx, lines } = setup();
    double
      .intercept({ path: `${pagePath}/versions/2`, method: 'GET' })
      .reply(200, pageAnswer(), json);
    double
      .intercept({ path: `${pagePath}/versions/3`, method: 'GET' })
      .reply(200, pageAnswer(), json);
    expect((await client.wikiPage(ctx(), 4, guid, 2)).version).toBe(2);
    expect(await codeOf(client.wikiPage(ctx(), 4, guid, 3))).toBe('upstream');
    expect(lines.map((line) => line.event)).toEqual([
      'churchtools_wiki_page_refused',
    ]);
  });

  it('reads a page without text as empty', async () => {
    const { double, client, ctx } = setup();
    double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(200, pageAnswer({ text: null }), json);
    expect((await client.wikiPage(ctx(), 4, guid)).text).toBe('');
  });

  it.each([
    [404, 'not_found', 'churchtools_wiki_page_missing'],
    [403, 'permission', 'churchtools_wiki_page_status'],
    [401, 'auth', 'churchtools_wiki_page_status'],
    [500, 'upstream', 'churchtools_wiki_page_status'],
  ])('maps status %i of a page to %s', async (status, code, event) => {
    const { double, client, ctx, lines } = setup();
    double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(status, '{}', json);
    expect(await codeOf(client.wikiPage(ctx(), 4, guid))).toBe(code);
    expect(lines).toEqual([{ event, fields: { status, code } }]);
  });

  // A 404 means a missing page only where one object is read by its ID;
  // the lists have fixed paths, so there it stays upstream.
  it('keeps 404 of the lists as upstream', async () => {
    const { double, client, ctx } = setup();
    double
      .intercept({ path: '/api/wiki/categories', method: 'GET' })
      .reply(404, '{}', json);
    double
      .intercept({ path: at('/api/wiki/pages'), method: 'GET' })
      .reply(404, '{}', json);
    expect(await codeOf(client.wikiCategories(ctx()))).toBe('upstream');
    expect(await codeOf(client.wikiPages(ctx(), 4, 1))).toBe('upstream');
  });

  it.each([
    [4, 'Startseite', undefined],
    [4, '../../whoami', undefined],
    [4, `${guid}/versions`, undefined],
    [4, guid.slice(1), undefined],
    [0, guid, undefined],
    [4, guid, 0],
    [4, guid, 1.5],
  ])(
    'refuses the category %j, GUID %j and version %j before any request',
    async (categoryId, id, version) => {
      const { double, client, ctx } = setup();
      expect(
        await codeOf(client.wikiPage(ctx(), categoryId, id, version)),
      ).toBe('validation');
      expect(double.calls()).toHaveLength(0);
    },
  );

  it.each([
    ['no title', { title: undefined }],
    ['a text that is a number', { text: 1 }],
    ['a version 0', { version: 0 }],
  ])('gives upstream for a page with %s', async (_, data) => {
    const { double, client, ctx } = setup();
    double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(200, pageAnswer(data), json);
    expect(await codeOf(client.wikiPage(ctx(), 4, guid))).toBe('upstream');
  });
});
