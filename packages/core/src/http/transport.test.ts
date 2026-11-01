import { getEventListeners } from 'node:events';
import type { Socket } from 'node:net';
import { duplexPair, Readable } from 'node:stream';
import { inspect } from 'node:util';

import type { Logger, LogFields } from '@ecclium/mcp-churchtools-plugin-api';
import { isEccliumError } from '@ecclium/mcp-churchtools-plugin-api';
import { assertNoCanary, makeCanary } from '@ecclium/mcp-churchtools-testkit';
import { type Dispatcher, getGlobalDispatcher, MockAgent } from 'undici';
import { afterEach, describe, expect, it } from 'vitest';

import * as compose from './compose.js';
import { HttpTransportError } from './failure.js';
import { Secret } from './secret.js';
import {
  agentOptions,
  createAgent,
  createTransport,
  type HttpTransport,
  isUserAgent,
  type TransportLimits,
  transportLimits,
} from './transport.js';

// The transport runs here on a MockAgent of undici, which sees every
// request exactly as the transport sends it, on a dispatcher of the test
// that answers only when told, and, for the connector, on one end of a
// pair of streams in memory. No socket opens. Hosts lie under .example
// (RFC 2606); tokens are canaries made at run time.

const origin = 'https://demo.example';
const canary = makeCanary('token');
const token = new Secret(canary.value);
const userAgent = 'Ecclium/0.0.0-test';

interface Line {
  readonly level: string;
  readonly event: string;
  readonly fields: LogFields | undefined;
}

const recordingLogger = (): { logger: Logger; lines: Line[] } => {
  const lines: Line[] = [];
  const record =
    (level: string) =>
    (event: string, fields?: LogFields): void => {
      lines.push({ level, event, fields });
    };
  return {
    logger: Object.freeze({
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    }),
    lines,
  };
};

const steppingClock = () => {
  let now = 1_000;
  return Object.freeze({
    now: (): number => {
      now += 5;
      return now;
    },
  });
};

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
});

const mocked = (limits: TransportLimits = transportLimits) => {
  const agent = new MockAgent({ enableCallHistory: true });
  agent.disableNetConnect();
  open.push(agent);
  const { logger, lines } = recordingLogger();
  const transport = createTransport(agent, {
    origin,
    token,
    userAgent,
    logger,
    clock: steppingClock(),
    limits,
  });
  return { agent, pool: agent.get(origin), transport, lines };
};

interface Sent {
  readonly path: string;
  answer(data: {
    readonly statusCode: number;
    readonly body: Readable;
    readonly headers?: Readonly<Record<string, string>>;
  }): void;
  fail(error: Error): void;
}

// A dispatcher that answers a request only when the test says so: for a
// body in several parts, which MockAgent always joins into one, and for a
// request that undici never answers.
const stubbed = (limits: TransportLimits = transportLimits) => {
  const sent: Sent[] = [];
  const dispatcher = {
    request: (options: Dispatcher.RequestOptions) =>
      new Promise((resolve, reject) => {
        sent.push({
          path: options.path,
          answer: (data) => {
            resolve({ headers: {}, ...data });
          },
          fail: reject,
        });
      }),
    close: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  };
  const { logger, lines } = recordingLogger();
  const transport = createTransport(dispatcher as unknown as Dispatcher, {
    origin,
    token,
    userAgent,
    logger,
    clock: steppingClock(),
    limits,
  });
  return { transport, sent, lines };
};

// A body in the given parts.
const parts = (...texts: string[]): Readable =>
  Readable.from(texts.map((text) => Buffer.from(text)));

// A body that, like one of undici that has fully arrived, emits an error
// when it is destroyed.
const errorOnDestroy = (): Readable =>
  new Readable({
    read() {
      // The test never pushes.
    },
    destroy(_error, callback) {
      callback(new Error('aborted'));
    },
  });

// Lets timers and pending callbacks run.
const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

const url = (path: string): URL => new URL(`${origin}${path}`);

// What a transport holds, in this order: five methods, close and destroy.
const allMethods = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'close',
  'destroy',
];

const failure = async (call: Promise<unknown>): Promise<HttpTransportError> => {
  try {
    await call;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpTransportError);
    return error as HttpTransportError;
  }
  throw new Error('expected the call to fail');
};

describe('a request', () => {
  it('goes to the origin as GET with exactly the Authorization, Accept and User-Agent headers', async () => {
    const { agent, pool, transport } = mocked();
    pool
      .intercept({ path: '/api/persons?page=1&limit=50', method: 'GET' })
      .reply(200, '{"data":[]}');
    await transport.get(url('/api/persons?page=1&limit=50'), {
      maxResponseBytes: 1024,
    });
    const call = agent.getCallHistory()?.lastCall();
    expect(call?.method).toBe('GET');
    expect(call?.origin).toBe(origin);
    expect(call?.path).toBe('/api/persons');
    expect(call?.searchParams).toEqual({ page: '1', limit: '50' });
    expect(call?.headers).toEqual({
      authorization: `Login ${canary.value}`,
      accept: 'application/json',
      'accept-encoding': 'identity',
      'user-agent': userAgent,
    });
    expect(call?.body ?? null).toBeNull();
  });

  it('carries the token nowhere but in the Authorization header', async () => {
    const { agent, pool, transport } = mocked();
    pool.intercept({ path: '/api/whoami', method: 'GET' }).reply(200, '{}');
    await transport.get(url('/api/whoami'), { maxResponseBytes: 1024 });
    const call = agent.getCallHistory()?.lastCall();
    const { authorization, ...others } = (call?.headers ?? {}) as Record<
      string,
      string
    >;
    expect(authorization).toBe(`Login ${canary.value}`);
    assertNoCanary(others, [canary], 'other headers');
    assertNoCanary(call?.fullUrl, [canary], 'address');
    expect(Object.keys(others)).toEqual([
      'accept',
      'accept-encoding',
      'user-agent',
    ]);
    expect(call?.fullUrl).not.toContain('login_token');
    expect(call?.fullUrl).not.toContain('with_session');
  });

  it('sends no request for a target the check refuses', async () => {
    const { agent, transport, lines } = mocked();
    for (const target of [
      new URL('https://other.example/api'),
      url('/api?login_token=1'),
      url('/api#part'),
    ]) {
      const error = await failure(
        transport.get(target, { maxResponseBytes: 1024 }),
      );
      expect(error.category).toBe('refused');
      expect(error.code).toBe('internal');
    }
    expect(agent.getCallHistory()?.calls()).toEqual([]);
    expect(lines.map((line) => line.event)).toEqual([
      'http_refused',
      'http_refused',
      'http_refused',
    ]);
  });

  it.each([
    ['no limit', {}],
    ['a limit of 0', { maxResponseBytes: 0 }],
    ['a limit above 8 MiB', { maxResponseBytes: 8 * 1024 * 1024 + 1 }],
    ['a limit that is no whole number', { maxResponseBytes: 1.5 }],
    ['a limit as text', { maxResponseBytes: '1024' }],
    [
      'a limit behind a getter',
      Object.defineProperty({}, 'maxResponseBytes', { get: () => 1024 }),
    ],
    ['a signal that is no AbortSignal', { maxResponseBytes: 1024, signal: {} }],
    ['options that are no object', null],
  ])('refuses %s', async (_, options) => {
    const { agent, transport } = mocked();
    const error = await failure(transport.get(url('/api'), options as never));
    expect(error.category).toBe('refused');
    expect(agent.getCallHistory()?.calls()).toEqual([]);
  });

  it('refuses a target that is no URL', async () => {
    const { transport } = mocked();
    const error = await failure(
      transport.get(`${origin}/api` as unknown as URL, {
        maxResponseBytes: 1024,
      }),
    );
    expect(error.category).toBe('refused');
  });

  it('accepts the largest limit', async () => {
    const { pool, transport } = mocked();
    pool.intercept({ path: '/api', method: 'GET' }).reply(200, 'x');
    const answer = await transport.get(url('/api'), {
      maxResponseBytes: 8 * 1024 * 1024,
    });
    expect(answer.status).toBe(200);
  });
});

describe('an answer', () => {
  it('gives status, the kept headers and the whole body, frozen', async () => {
    const { pool, transport, lines } = mocked();
    pool
      .intercept({ path: '/api/whoami', method: 'GET' })
      .reply(200, '{"data":{"id":1}}', {
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'session=1; Path=/',
          date: 'Fri, 16 Oct 2026 16:00:00 GMT',
          server: 'nginx',
        },
      });
    const answer = await transport.get(url('/api/whoami'), {
      maxResponseBytes: 1024,
    });
    expect(answer.status).toBe(200);
    expect({ ...answer.headers }).toEqual({
      'content-type': 'application/json',
      date: 'Fri, 16 Oct 2026 16:00:00 GMT',
    });
    expect(new TextDecoder().decode(answer.body)).toBe('{"data":{"id":1}}');
    expect(Object.isFrozen(answer)).toBe(true);
    expect(Object.getPrototypeOf(answer)).toBeNull();
    expect(Object.keys(answer)).toEqual(['status', 'headers', 'body']);
    expect(lines).toEqual([
      {
        level: 'info',
        event: 'http_response',
        fields: { durationMs: 5, method: 'GET', status: 200 },
      },
    ]);
  });

  it('passes on an error status with its body', async () => {
    const { pool, transport } = mocked();
    pool.intercept({ path: '/api', method: 'GET' }).reply(404, '{}');
    const answer = await transport.get(url('/api'), { maxResponseBytes: 64 });
    expect(answer.status).toBe(404);
  });

  it('joins a body that arrives in parts, in their order', async () => {
    const { transport, sent } = stubbed();
    const call = transport.get(url('/api'), { maxResponseBytes: 18 });
    await settle();
    sent[0]?.answer({
      statusCode: 200,
      body: parts('first-', 'second-', 'third'),
    });
    const answer = await call;
    expect(answer.body).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(answer.body)).toBe('first-second-third');
  });

  it('is refused on the part that crosses the limit of the call', async () => {
    const { transport, sent } = stubbed();
    const call = transport.get(url('/api'), { maxResponseBytes: 17 });
    await settle();
    const body = parts('first-', 'second-', 'third');
    sent[0]?.answer({ statusCode: 200, body });
    expect((await failure(call)).category).toBe('too_large');
    expect(body.destroyed).toBe(true);
  });

  it.each([600, 999])('is refused for status %i', async (status) => {
    const { pool, transport, lines } = mocked();
    pool.intercept({ path: '/api', method: 'GET' }).reply(status, 'x');
    const error = await failure(
      transport.get(url('/api'), { maxResponseBytes: 64 }),
    );
    expect(error.category).toBe('status');
    expect(error.code).toBe('upstream');
    expect(lines.map((line) => line.event)).toEqual(['http_status']);
  });

  it.each([
    ['redirect', 302, {}],
    ['status', 600, {}],
    ['encoding', 200, { 'content-encoding': 'gzip' }],
  ])(
    'drops a body that has arrived without an unhandled error, for %s',
    async (category, statusCode, headers) => {
      const { transport, sent } = stubbed();
      const call = transport.get(url('/api'), { maxResponseBytes: 64 });
      await settle();
      const body = errorOnDestroy();
      sent[0]?.answer({ statusCode, body, headers });
      expect((await failure(call)).category).toBe(category);
      await settle();
      expect(body.destroyed).toBe(true);
    },
  );

  it.each([301, 302, 303, 307, 308, 300, 399])(
    'is refused as a redirect for status %i',
    async (status) => {
      const { pool, transport, lines } = mocked();
      pool.intercept({ path: '/api', method: 'GET' }).reply(status, 'moved', {
        headers: { location: 'https://other.example/' },
      });
      const error = await failure(
        transport.get(url('/api'), { maxResponseBytes: 64 }),
      );
      expect(error.category).toBe('redirect');
      expect(error.code).toBe('upstream');
      expect(lines.map((line) => line.event)).toEqual(['http_redirect']);
    },
  );

  it('is taken for status 200, 299, 400 and 599', async () => {
    const { pool, transport } = mocked();
    for (const status of [200, 299, 400, 599]) {
      pool
        .intercept({ path: `/${String(status)}`, method: 'GET' })
        .reply(status, '');
      expect(
        (
          await transport.get(url(`/${String(status)}`), {
            maxResponseBytes: 1,
          })
        ).status,
      ).toBe(status);
    }
  });

  it('is refused with a content-encoding', async () => {
    const { pool, transport } = mocked();
    pool
      .intercept({ path: '/api', method: 'GET' })
      .reply(200, 'x', { headers: { 'content-encoding': 'gzip' } });
    const error = await failure(
      transport.get(url('/api'), { maxResponseBytes: 64 }),
    );
    expect(error.category).toBe('encoding');
  });

  it('is refused one byte above the limit of the call and taken at it', async () => {
    const { pool, transport } = mocked();
    pool.intercept({ path: '/a', method: 'GET' }).reply(200, '12345678901');
    pool.intercept({ path: '/b', method: 'GET' }).reply(200, '1234567890');
    const error = await failure(
      transport.get(url('/a'), { maxResponseBytes: 10 }),
    );
    expect(error.category).toBe('too_large');
    const answer = await transport.get(url('/b'), { maxResponseBytes: 10 });
    expect(answer.body.byteLength).toBe(10);
  });
});

// A body of JSON in UTF-8, as the client builds it.
const json = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value));

// The body a MockAgent saw, as text. Its types name a string, but it keeps
// the Uint8Array the transport sent.
const sentText = (body: unknown): string =>
  new TextDecoder().decode(body as Uint8Array);

describe('a write', () => {
  const page = '/api/wiki/categories/1/pages';
  const onePage = `${page}/00000000-0000-4000-8000-000000000001`;
  // A path of its forms for each write with a body.
  const pathOf = { post: page, put: '/api/bookings/4', patch: onePage };

  it.each(['post', 'put', 'patch'] as const)(
    'sends %s with its body as application/json and the same headers as a read',
    async (name) => {
      const method = name.toUpperCase();
      const path = pathOf[name];
      const { agent, pool, transport, lines } = mocked();
      pool.intercept({ path, method }).reply(200, '{}');
      const answer = await transport[name](url(path), {
        body: json({ text: 'Ä' }),
        maxResponseBytes: 1024,
      });
      expect(answer.status).toBe(200);
      const call = agent.getCallHistory()?.lastCall();
      expect(call?.method).toBe(method);
      expect(call?.path).toBe(path);
      expect(sentText(call?.body)).toBe('{"text":"Ä"}');
      expect(call?.searchParams).toEqual({});
      expect(call?.headers).toEqual({
        authorization: `Login ${canary.value}`,
        accept: 'application/json',
        'accept-encoding': 'identity',
        'user-agent': userAgent,
        'content-type': 'application/json',
      });
      expect(lines).toEqual([
        {
          level: 'info',
          event: 'http_response',
          fields: { durationMs: 5, method, status: 200 },
        },
      ]);
    },
  );

  it('sends DELETE without body and without content-type, and takes 204 without body', async () => {
    const { agent, pool, transport, lines } = mocked();
    pool
      .intercept({ path: '/api/bookings/4', method: 'DELETE' })
      .reply(204, '');
    const answer = await transport.delete(url('/api/bookings/4'), {
      maxResponseBytes: 1024,
    });
    expect(answer.status).toBe(204);
    expect(answer.body).toHaveLength(0);
    const call = agent.getCallHistory()?.lastCall();
    expect(call?.method).toBe('DELETE');
    expect(call?.body ?? null).toBeNull();
    expect(Object.keys(call?.headers ?? {})).not.toContain('content-type');
    expect(lines.at(-1)?.fields).toEqual({
      durationMs: 5,
      method: 'DELETE',
      status: 204,
    });
  });

  it('sends the body as it was when the call started', async () => {
    const { agent, pool, transport } = mocked();
    pool.intercept({ path: page, method: 'POST' }).reply(201, '{}');
    const body = json({ text: 'before' });
    const call = transport.post(url(page), { body, maxResponseBytes: 1024 });
    body.set(new TextEncoder().encode('{"text":"after!"}'));
    await call;
    expect(sentText(agent.getCallHistory()?.lastCall()?.body)).toBe(
      '{"text":"before"}',
    );
  });

  it('accepts a body of one byte and of exactly the limit', async () => {
    const { pool, transport } = mocked();
    pool.intercept({ path: page, method: 'POST' }).reply(201, '{}').times(2);
    for (const size of [1, 1024 * 1024]) {
      const answer = await transport.post(url(page), {
        body: new Uint8Array(size).fill(0x20),
        maxResponseBytes: 1024,
      });
      expect(answer.status).toBe(201);
    }
  });

  // Each row is the whole options object, never spread, so that a getter
  // reaches the transport as a getter.
  const limit = { maxResponseBytes: 1024 };
  it.each([
    ['no body', { ...limit }],
    ['an empty body', { ...limit, body: new Uint8Array(0) }],
    [
      'a body one byte above 1 MiB',
      { ...limit, body: new Uint8Array(1024 * 1024 + 1) },
    ],
    [
      'a body above 1 MiB with an own byteLength that claims 1',
      {
        ...limit,
        body: Object.defineProperty(
          new Uint8Array(1024 * 1024 + 1),
          'byteLength',
          {
            value: 1,
          },
        ),
      },
    ],
    ['a body as text', { ...limit, body: '{}' }],
    ['a body as ArrayBuffer', { ...limit, body: new ArrayBuffer(2) }],
    [
      'a body as DataView',
      { ...limit, body: new DataView(new ArrayBuffer(2)) },
    ],
    ['a body as Uint16Array', { ...limit, body: new Uint16Array(2) }],
    ['a body as array of numbers', { ...limit, body: [0x7b, 0x7d] }],
    ['a body in a proxy', { ...limit, body: new Proxy(json({}), {}) }],
    [
      'a body behind a getter',
      Object.defineProperty({ ...limit }, 'body', {
        get: () => json({}),
        enumerable: true,
      }),
    ],
  ])('refuses a POST with %s and sends nothing', async (_, options) => {
    const { agent, transport, lines } = mocked();
    expect(Object.keys(options)).toContain('maxResponseBytes');
    const error = await failure(transport.post(url(page), options as never));
    expect(error.category).toBe('refused');
    expect(agent.getCallHistory()?.calls()).toEqual([]);
    expect(lines).toEqual([
      {
        level: 'warn',
        event: 'http_refused',
        fields: { code: 'internal', durationMs: 5, method: 'POST' },
      },
    ]);
  });

  // The length comes from the view itself, not from an own property, which
  // could claim more than it holds.
  it('takes a small body whose own byteLength claims more than the limit', async () => {
    const { agent, pool, transport } = mocked();
    pool.intercept({ path: page, method: 'POST' }).reply(201, '{}');
    const body = Object.defineProperty(json({}), 'byteLength', {
      value: 1024 * 1024 * 1024,
    });
    const answer = await transport.post(url(page), {
      body,
      maxResponseBytes: 1024,
    });
    expect(answer.status).toBe(201);
    expect(sentText(agent.getCallHistory()?.lastCall()?.body)).toBe('{}');
  });

  it('refuses a body for GET and DELETE and sends nothing', async () => {
    const { agent, transport } = mocked();
    for (const call of [
      transport.get(url('/api/whoami'), {
        body: json({}),
        maxResponseBytes: 1024,
      } as never),
      transport.delete(url('/api/bookings/4'), {
        body: json({}),
        maxResponseBytes: 1024,
      } as never),
    ]) {
      expect((await failure(call)).category).toBe('refused');
    }
    expect(agent.getCallHistory()?.calls()).toEqual([]);
  });

  // The same body passes once the transport sends another token, so the
  // case is caught by the token, not by its shape.
  it('refuses a body that carries the token, as it is or escaped for JSON, and takes both for another token', async () => {
    const escaped = json({ text: `see ${canary.value} here` });
    const target = url(onePage);
    const raw = new TextEncoder().encode(`{"text":"${canary.value}"}`);
    // The canary holds a quote and a backslash, so the two forms differ.
    expect(JSON.stringify(canary.value).slice(1, -1)).not.toBe(canary.value);
    const first = mocked();
    for (const body of [escaped, raw]) {
      const error = await failure(
        first.transport.patch(target, {
          body,
          maxResponseBytes: 1024,
        }),
      );
      expect(error.category).toBe('refused');
    }
    expect(first.agent.getCallHistory()?.calls()).toEqual([]);
    const agent = new MockAgent({ enableCallHistory: true });
    agent.disableNetConnect();
    open.push(agent);
    agent
      .get(origin)
      .intercept({ path: onePage, method: 'PATCH' })
      .reply(200, '{}')
      .times(2);
    const other = createTransport(agent, {
      origin,
      token: new Secret(makeCanary('token').value),
      userAgent,
      logger: recordingLogger().logger,
      clock: steppingClock(),
      limits: transportLimits,
    });
    for (const body of [escaped, raw]) {
      const answer = await other.patch(target, {
        body,
        maxResponseBytes: 1024,
      });
      expect(answer.status).toBe(200);
    }
  });

  it.each(['post', 'put', 'patch', 'delete'] as const)(
    'refuses %s with a query and sends nothing',
    async (name) => {
      const { agent, transport } = mocked();
      const options =
        name === 'delete'
          ? { maxResponseBytes: 1024 }
          : { body: json({}), maxResponseBytes: 1024 };
      const error = await failure(
        transport[name](url('/api/bookings/4?a=1'), options as never),
      );
      expect(error.category).toBe('refused');
      expect(agent.getCallHistory()?.calls()).toEqual([]);
    },
  );

  it('refuses DELETE on a page of the wiki, a person or a group and sends nothing', async () => {
    const { agent, transport } = mocked();
    for (const path of [onePage, '/api/persons/1', '/api/groups/1']) {
      const error = await failure(
        transport.delete(url(path), { maxResponseBytes: 1024 }),
      );
      expect(error.category).toBe('refused');
    }
    expect(agent.getCallHistory()?.calls()).toEqual([]);
  });

  it('refuses POST, PUT and PATCH outside their forms, also on a person or a group, and sends nothing', async () => {
    const { agent, transport } = mocked();
    const options = { body: json({}), maxResponseBytes: 1024 };
    for (const call of [
      transport.post(url('/api/persons'), options),
      transport.post(url('/api/groups/1/members/2'), options),
      transport.put(url('/api/persons/1'), options),
      transport.put(url(onePage), options),
      transport.patch(url('/api/groups/1'), options),
      transport.patch(url(`${page}/Dienstplan`), options),
    ]) {
      expect((await failure(call)).category).toBe('refused');
    }
    expect(agent.getCallHistory()?.calls()).toEqual([]);
  });

  it('checks the target of a write as that of a read', async () => {
    const { agent, transport } = mocked();
    for (const target of [
      new URL(`https://other.example${page}`),
      url(`${page}#part`),
      url(`/api/${canary.value}`),
    ]) {
      const error = await failure(
        transport.post(target, { body: json({}), maxResponseBytes: 1024 }),
      );
      expect(error.category).toBe('refused');
    }
    expect(agent.getCallHistory()?.calls()).toEqual([]);
  });

  it('passes on an error status of a write with its body, and names the method of a failure', async () => {
    const { pool, transport, lines } = mocked();
    pool.intercept({ path: page, method: 'POST' }).reply(400, '{"x":1}');
    pool.intercept({ path: '/api/bookings/4', method: 'PUT' }).reply(302, '');
    const answer = await transport.post(url(page), {
      body: json({}),
      maxResponseBytes: 1024,
    });
    expect(answer.status).toBe(400);
    expect(new TextDecoder().decode(answer.body)).toBe('{"x":1}');
    const error = await failure(
      transport.put(url('/api/bookings/4'), {
        body: json({}),
        maxResponseBytes: 1024,
      }),
    );
    expect(error.category).toBe('redirect');
    expect(lines.map((line) => line.fields?.['method'])).toEqual([
      'POST',
      'PUT',
    ]);
  });
});

describe('a failure', () => {
  const slowLimits: TransportLimits = { ...transportLimits, totalMs: 50 };

  it('gives timeout when the whole call takes longer than its limit', async () => {
    const { pool, transport } = mocked(slowLimits);
    pool.intercept({ path: '/api', method: 'GET' }).reply(200, 'x').delay(500);
    const error = await failure(
      transport.get(url('/api'), { maxResponseBytes: 64 }),
    );
    expect(error.category).toBe('timeout');
    expect(error.code).toBe('network');
  });

  it('gives aborted when the caller aborts, before or during the call', async () => {
    const { pool, transport } = mocked();
    const early = new AbortController();
    early.abort(new Error(canary.value));
    const before = await failure(
      transport.get(url('/api'), {
        maxResponseBytes: 64,
        signal: early.signal,
      }),
    );
    expect(before.category).toBe('aborted');

    pool.intercept({ path: '/api', method: 'GET' }).reply(200, 'x').delay(500);
    const late = new AbortController();
    const call = transport.get(url('/api'), {
      maxResponseBytes: 64,
      signal: late.signal,
    });
    setTimeout(() => {
      late.abort(new Error(canary.value));
    }, 20);
    const during = await failure(call);
    expect(during.category).toBe('aborted');
    assertNoCanary(during, [canary], 'error after an abort');
  });

  it('reads whether the caller aborted from the class, not an own property', async () => {
    const { transport } = mocked();
    const controller = new AbortController();
    controller.abort();
    Object.defineProperty(controller.signal, 'aborted', { value: false });
    const error = await failure(
      transport.get(url('/api'), {
        maxResponseBytes: 64,
        signal: controller.signal,
      }),
    );
    expect(error.category).toBe('aborted');
  });

  it('removes its listener from the signal of the caller', async () => {
    const { pool, transport } = mocked();
    pool.intercept({ path: '/api', method: 'GET' }).reply(200, 'x');
    const controller = new AbortController();
    const call = transport.get(url('/api'), {
      maxResponseBytes: 64,
      signal: controller.signal,
    });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
    await call;
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('listens through the class, not through own methods of the signal', async () => {
    const { pool, transport } = mocked();
    pool.intercept({ path: '/a', method: 'GET' }).reply(200, 'x');
    pool.intercept({ path: '/b', method: 'GET' }).reply(200, 'x').delay(500);
    const controller = new AbortController();
    const refuse = () => {
      throw new Error(canary.value);
    };
    Object.assign(controller.signal, {
      addEventListener: refuse,
      removeEventListener: refuse,
    });
    const signal = controller.signal;
    expect(
      (await transport.get(url('/a'), { maxResponseBytes: 64, signal })).status,
    ).toBe(200);
    const call = transport.get(url('/b'), { maxResponseBytes: 64, signal });
    controller.abort();
    expect((await failure(call)).category).toBe('aborted');
    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
  });

  it('gives connect for a connection that fails and failed for anything else', async () => {
    const { pool, transport } = mocked();
    pool
      .intercept({ path: '/a', method: 'GET' })
      .replyWithError(
        Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
      );
    pool
      .intercept({ path: '/b', method: 'GET' })
      .replyWithError(new Error('broken'));
    expect(
      (await failure(transport.get(url('/a'), { maxResponseBytes: 64 })))
        .category,
    ).toBe('connect');
    expect(
      (await failure(transport.get(url('/b'), { maxResponseBytes: 64 })))
        .category,
    ).toBe('failed');
  });

  it('keeps the token out of an error of undici that carries the request headers', async () => {
    const { pool, transport, lines } = mocked();
    // The interceptor waits for other headers, so undici refuses the
    // request with an error whose text lists the headers it got.
    pool
      .intercept({
        path: '/api',
        method: 'GET',
        headers: { authorization: 'Login other' },
      })
      .reply(200, 'x');
    const error = await failure(
      transport.get(url('/api'), { maxResponseBytes: 64 }),
    );
    expect(error.category).toBe('failed');
    expect(isEccliumError(error)).toBe(true);
    expect(error.message).toBe('');
    expect('cause' in error).toBe(false);
    assertNoCanary(error, [canary], 'error');
    assertNoCanary(
      inspect(error, { depth: null, showHidden: true }),
      [canary],
      'inspected error',
    );
    assertNoCanary(JSON.stringify(error), [canary], 'error as JSON');
    assertNoCanary(lines, [canary], 'log');
  });

  it('keeps the token out of an error of undici that names it in message, cause and headers', async () => {
    const { pool, transport, lines } = mocked();
    const planted = Object.assign(new Error(`Login ${canary.value}`), {
      code: 'ECONNRESET',
      cause: new Error(canary.value),
      headers: { authorization: `Login ${canary.value}` },
    });
    pool.intercept({ path: '/api', method: 'GET' }).replyWithError(planted);
    const error = await failure(
      transport.get(url('/api'), { maxResponseBytes: 64 }),
    );
    expect(error.category).toBe('connect');
    assertNoCanary(
      inspect(error, { depth: null, showHidden: true }),
      [canary],
      'error',
    );
    assertNoCanary(lines, [canary], 'log');
  });
});

describe('a call that waits', () => {
  it('ends at its deadline when undici never answers', async () => {
    const { transport, sent } = stubbed({ ...transportLimits, totalMs: 50 });
    const error = await failure(
      transport.get(url('/api'), { maxResponseBytes: 64 }),
    );
    expect(error.category).toBe('timeout');
    expect(sent).toHaveLength(1);
  });

  it('waits for a free connection outside undici and leaves at once on an abort', async () => {
    const { transport, sent } = stubbed({ ...transportLimits, connections: 1 });
    const first = new AbortController();
    const second = new AbortController();
    const one = transport.get(url('/one'), {
      maxResponseBytes: 64,
      signal: first.signal,
    });
    const two = transport.get(url('/two'), {
      maxResponseBytes: 64,
      signal: second.signal,
    });
    await settle();
    expect(sent.map((request) => request.path)).toEqual(['/one']);
    second.abort();
    expect((await failure(two)).category).toBe('aborted');
    first.abort();
    expect((await failure(one)).category).toBe('aborted');
    const three = transport.get(url('/three'), { maxResponseBytes: 64 });
    await settle();
    expect(sent.map((request) => request.path)).toEqual(['/one', '/three']);
    sent[1]?.answer({ statusCode: 200, body: parts('ok') });
    expect((await three).status).toBe(200);
  });

  it('hands its connection to the next call when it ends', async () => {
    const { transport, sent } = stubbed({ ...transportLimits, connections: 1 });
    const one = transport.get(url('/one'), { maxResponseBytes: 64 });
    const two = transport.get(url('/two'), { maxResponseBytes: 64 });
    await settle();
    expect(sent).toHaveLength(1);
    sent[0]?.answer({ statusCode: 200, body: parts('1') });
    expect((await one).status).toBe(200);
    await settle();
    expect(sent.map((request) => request.path)).toEqual(['/one', '/two']);
    sent[1]?.fail(new Error('broken'));
    expect((await failure(two)).category).toBe('failed');
  });

  it('drops an answer that comes after the abort, and ignores a late error', async () => {
    const { transport, sent } = stubbed();
    const first = new AbortController();
    const second = new AbortController();
    const one = transport.get(url('/one'), {
      maxResponseBytes: 64,
      signal: first.signal,
    });
    const two = transport.get(url('/two'), {
      maxResponseBytes: 64,
      signal: second.signal,
    });
    await settle();
    first.abort();
    second.abort();
    expect((await failure(one)).category).toBe('aborted');
    expect((await failure(two)).category).toBe('aborted');
    const body = errorOnDestroy();
    sent[0]?.answer({ statusCode: 200, body });
    sent[1]?.fail(new Error(canary.value));
    await settle();
    expect(body.destroyed).toBe(true);
  });
});

describe('the transport', () => {
  it('shows no token, dispatcher or pool, also while a call runs', async () => {
    const { pool, transport } = mocked();
    pool.intercept({ path: '/api', method: 'GET' }).reply(200, 'x').delay(100);
    const call = transport.get(url('/api'), { maxResponseBytes: 64 });
    expect(Reflect.ownKeys(transport)).toEqual(allMethods);
    expect(Object.isFrozen(transport)).toBe(true);
    assertNoCanary(
      inspect(transport, {
        depth: null,
        showHidden: true,
        customInspect: false,
      }),
      [canary],
      'inspected transport',
    );
    assertNoCanary(JSON.stringify(transport), [canary], 'transport as JSON');
    await call;
  });

  it('closes and destroys its dispatcher', async () => {
    const calls: string[] = [];
    const dispatcher = {
      close: () => {
        calls.push('close');
        return Promise.resolve();
      },
      destroy: () => {
        calls.push('destroy');
        return Promise.resolve();
      },
    };
    const { logger } = recordingLogger();
    const transport: HttpTransport = createTransport(dispatcher as never, {
      origin,
      token,
      userAgent,
      logger,
      clock: steppingClock(),
      limits: transportLimits,
    });
    await transport.close();
    await transport.destroy();
    expect(calls).toEqual(['close', 'destroy']);
  });
});

describe('the agent', () => {
  it('has the fixed limits', () => {
    expect({ ...transportLimits }).toEqual({
      connectMs: 10_000,
      headersMs: 15_000,
      bodyMs: 15_000,
      totalMs: 30_000,
      keepAliveMs: 10_000,
      connections: 4,
      maxResponseBytes: 8 * 1024 * 1024,
      maxHeaderBytes: 16 * 1024,
      maxRequestBytes: 1024 * 1024,
    });
    expect(Object.isFrozen(transportLimits)).toBe(true);
  });

  it('turns off HTTP/2 and Milo, serves one origin and sends one request per connection at a time', () => {
    expect({ ...agentOptions(transportLimits) }).toEqual({
      allowH2: false,
      useMilo: false,
      maxOrigins: 1,
      connections: 4,
      pipelining: 1,
      headersTimeout: 15_000,
      bodyTimeout: 15_000,
      keepAliveTimeout: 10_000,
      keepAliveMaxTimeout: 10_000,
      maxResponseSize: 8 * 1024 * 1024,
      maxHeaderSize: 16 * 1024,
    });
  });

  // The other end of a pair of streams stands in for the server. The
  // connector puts the transport's end under TLS for the origin.
  const throughPair = (
    serve: (server: NodeJS.ReadWriteStream) => void,
    limits: TransportLimits,
  ) => {
    const { logger, lines } = recordingLogger();
    const agent = createAgent(limits, () => {
      const [client, server] = duplexPair();
      serve(server);
      return client as unknown as Socket;
    });
    open.push(agent);
    const transport = createTransport(agent, {
      origin,
      token,
      userAgent,
      logger,
      clock: steppingClock(),
      limits,
    });
    return { transport, lines };
  };

  it('gives tls when the other end does not speak TLS', async () => {
    const { transport, lines } = throughPair((server) => {
      server.once('data', () => {
        server.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      });
    }, transportLimits);
    const error = await failure(
      transport.get(url('/api'), { maxResponseBytes: 64 }),
    );
    expect(error.category).toBe('tls');
    expect(lines.map((line) => line.event)).toEqual(['http_tls']);
  });

  it('gives connect when the handshake does not finish within its limit', async () => {
    const { transport } = throughPair(() => undefined, {
      ...transportLimits,
      connectMs: 200,
    });
    const error = await failure(
      transport.get(url('/api'), { maxResponseBytes: 64 }),
    );
    expect(error.category).toBe('connect');
    assertNoCanary(
      inspect(error, { depth: null, showHidden: true }),
      [canary],
      'error',
    );
  });
});

describe('createHttpTransport', () => {
  const { logger } = recordingLogger();
  const clock = steppingClock();

  it('builds a transport for a canonical origin and a secret', () => {
    const transport = compose.createHttpTransport({
      origin,
      token,
      userAgent,
      logger,
      clock,
    });
    open.push(transport);
    expect(Reflect.ownKeys(transport)).toEqual(allMethods);
  });

  it.each([
    'https://demo.example/',
    'https://DEMO.example',
    'http://demo.example',
  ])('refuses the origin %s', (value) => {
    expect(() =>
      compose.createHttpTransport({
        origin: value,
        token,
        userAgent,
        logger,
        clock,
      }),
    ).toThrow('The origin of a transport must be canonical.');
  });

  it('refuses a token that is no Secret', () => {
    expect(() =>
      compose.createHttpTransport({
        origin,
        token: { value: canary.value } as unknown as Secret,
        userAgent,
        logger,
        clock,
      }),
    ).toThrow(TypeError);
  });

  it('refuses a User-Agent that is not printable', () => {
    expect(() =>
      compose.createHttpTransport({
        origin,
        token,
        userAgent: 'Ecclium\r\nx-other: 1',
        logger,
        clock,
      }),
    ).toThrow('The User-Agent of a transport must be printable.');
  });

  it('leaves the global dispatcher of undici alone', async () => {
    const before = getGlobalDispatcher();
    open.push(
      compose.createHttpTransport({ origin, token, userAgent, logger, clock }),
    );
    const { pool, transport } = mocked();
    pool.intercept({ path: '/api', method: 'GET' }).reply(200, 'x');
    await transport.get(url('/api'), { maxResponseBytes: 64 });
    expect(getGlobalDispatcher()).toBe(before);
  });

  it('passes on nothing but the factory and the types', () => {
    expect(Object.keys(compose)).toEqual(['createHttpTransport']);
  });
});

describe('isUserAgent', () => {
  it.each([
    'Ecclium/1.0.0',
    'Ecclium/1.0.0 (+https://example.org/ecclium)',
    'x',
    'x'.repeat(256),
  ])('accepts %j', (value) => {
    expect(isUserAgent(value)).toBe(true);
  });

  it.each([
    '',
    ' Ecclium',
    'Ecclium ',
    'Ecc\tlium',
    'Ecc\nlium',
    'Ecclium/\u00e4',
    'Ecclium\u007f',
    'x'.repeat(257),
    1,
    undefined,
  ])('refuses %j', (value) => {
    expect(isUserAgent(value)).toBe(false);
  });
});
