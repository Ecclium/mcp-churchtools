import { readRequestBody } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';

import { maxHttpBodyBytes } from './body.js';
import {
  answerOf,
  bodyStreamOf,
  HttpBindError,
  type HttpListenOptions,
  httpLimits,
  type IncomingRequest,
  listenHttp,
  maxHttpHeaderBytes,
  requestOf,
} from './listen.js';

// The parts of the bridge without a socket (ADR 0073). The one test that
// binds to 127.0.0.1 is tests/http-listen.test.mts, outside the packages,
// where the client may open connections.

// A request of node:http as the bridge reads it, without a body: the
// body reaches requestOf as a stream of its own.
const incoming = (
  url: string,
  rawHeaders: readonly string[] = ['Host', '127.0.0.1:8787'],
  method = 'POST',
): IncomingRequest => ({
  url,
  method,
  rawHeaders,
  [Symbol.asyncIterator]: () => ({
    next: () => Promise.resolve({ done: true as const, value: undefined }),
  }),
});

const nobody = (): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.close();
    },
  });

// A puller over fixed chunks that counts how often it was asked.
const counted = (chunks: readonly Uint8Array[]) => {
  const state = { pulls: 0 };
  const queue = [...chunks];
  const pull = (): Promise<Uint8Array | undefined> => {
    state.pulls += 1;
    return Promise.resolve(queue.shift());
  };
  return { state, pull };
};

describe('the request the bridge builds', () => {
  it('has a fixed base with the path of the client, never its Host', () => {
    const request = requestOf(
      incoming('/mcp?x=1', ['Host', 'evil.example.org']),
      nobody(),
      new AbortController().signal,
    );
    expect(request?.url).toBe('http://ingress.invalid/mcp?x=1');
    expect(request?.headers.get('host')).toBe('evil.example.org');
  });

  it('keeps a path that starts with two slashes a path', () => {
    const request = requestOf(
      incoming('//evil.example.org/mcp'),
      nobody(),
      new AbortController().signal,
    );
    expect(new URL(request?.url ?? '').host).toBe('ingress.invalid');
    expect(new URL(request?.url ?? '').pathname).toBe('//evil.example.org/mcp');
  });

  it.each([
    ['the absolute form a proxy takes', 'http://evil.example.org/mcp'],
    ['the asterisk form', '*'],
    ['an empty target', ''],
    ['the authority form', 'evil.example.org:443'],
  ])('refuses %s', (_, url) => {
    expect(
      requestOf(incoming(url), nobody(), new AbortController().signal),
    ).toBeUndefined();
  });

  it('refuses a method fetch does not take', () => {
    expect(
      requestOf(
        incoming('/mcp', ['Host', '127.0.0.1:8787'], 'TRACE'),
        nobody(),
        new AbortController().signal,
      ),
    ).toBeUndefined();
  });

  it('joins two headers of the same name, in their order', () => {
    const request = requestOf(
      incoming('/mcp', [
        'Host',
        '127.0.0.1:8787',
        'Origin',
        'http://127.0.0.1:8787',
        'host',
        'evil.example.org',
      ]),
      nobody(),
      new AbortController().signal,
    );
    expect(request?.headers.get('host')).toBe(
      '127.0.0.1:8787, evil.example.org',
    );
  });

  it('gives GET and HEAD no body and passes the signal on', () => {
    const controller = new AbortController();
    const request = requestOf(
      incoming('/mcp', ['Host', '127.0.0.1:8787'], 'GET'),
      nobody(),
      controller.signal,
    );
    expect(request?.body).toBeNull();
    controller.abort();
    expect(request?.signal.aborted).toBe(true);
  });
});

describe('the body the bridge hands on', () => {
  it('pulls nothing before a reader asks', async () => {
    const { state, pull } = counted([new Uint8Array([123, 125])]);
    const request = requestOf(
      incoming('/mcp'),
      bodyStreamOf(pull, maxHttpBodyBytes),
      new AbortController().signal,
    );
    await Promise.resolve();
    expect(state.pulls).toBe(0);
    expect(await request?.text()).toBe('{}');
    expect(state.pulls).toBe(2);
  });

  it('ends with an error after more than the limit, so a reader without a limit stops', async () => {
    const chunk = new Uint8Array(6);
    const { pull } = counted([chunk, chunk, chunk, chunk]);
    const response = new Response(bodyStreamOf(pull, 10));
    await expect(response.arrayBuffer()).rejects.toThrow();
  });

  it('lets the reader of the SDK see the chunk past the limit and answer too large', async () => {
    const chunk = new Uint8Array(6);
    const { pull } = counted([chunk, chunk, chunk, chunk]);
    const request = new Request('http://ingress.invalid/mcp', {
      method: 'POST',
      body: bodyStreamOf(pull, 10),
      duplex: 'half',
    });
    expect(await readRequestBody(request, 10)).toEqual({ tooLarge: true });
  });

  it('passes a body up to the limit unchanged', async () => {
    const { pull } = counted([new TextEncoder().encode('{"a":1}')]);
    const response = new Response(bodyStreamOf(pull, 7));
    expect(await response.text()).toBe('{"a":1}');
  });
});

describe('the answer the bridge writes', () => {
  it('is whole, with its length and without the headers of one connection', async () => {
    const headers = new Headers({
      'content-type': 'application/json',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'keep-alive': 'timeout=99',
      'transfer-encoding': 'chunked',
      'content-length': '999',
      upgrade: 'websocket',
    });
    headers.append('set-cookie', 'a=1');
    headers.append('set-cookie', 'b=2');
    const answer = await answerOf(
      new Response('{"ok":true}', { status: 201, headers }),
    );
    expect(answer.status).toBe(201);
    expect(new TextDecoder().decode(answer.body)).toBe('{"ok":true}');
    const pairs: [string, string][] = [];
    for (let index = 0; index < answer.headers.length; index += 2) {
      pairs.push([
        answer.headers[index] ?? '',
        answer.headers[index + 1] ?? '',
      ]);
    }
    expect(pairs).toEqual([
      ['cache-control', 'no-store'],
      ['content-type', 'application/json'],
      ['set-cookie', 'a=1'],
      ['set-cookie', 'b=2'],
      ['content-length', '11'],
    ]);
  });
});

describe('the answer to HEAD', () => {
  it('has no length, which would have to be that of the same GET', async () => {
    const answer = await answerOf(new Response(null, { status: 405 }), true);
    expect(answer.headers).not.toContain('content-length');
    const plain = await answerOf(new Response(null, { status: 405 }));
    expect(plain.headers).toContain('content-length');
  });
});

describe('the binding', () => {
  // The checks run before the application is built or a port opens, so
  // the options of the application need not be complete here.
  const options = (more: Partial<HttpListenOptions>): HttpListenOptions =>
    ({ port: 0, ...more }) as unknown as HttpListenOptions;

  it.each([
    ['a name', 'localhost'],
    ['an IPv4 address with a leading zero', '127.000.0.1'],
    ['an IPv6 address in brackets', '[::1]'],
    ['an address with a port', '127.0.0.1:8787'],
    ['nothing', ''],
  ])('refuses %s as the address', async (_, host) => {
    await expect(listenHttp(options({ host }))).rejects.toMatchObject({
      name: 'HttpBindError',
      reason: 'address',
    });
  });

  it.each(['0.0.0.0', '::', '10.0.0.1'])(
    'refuses %s without a list of allowed hosts',
    async (host) => {
      const refused = listenHttp(options({ host }));
      await expect(refused).rejects.toBeInstanceOf(HttpBindError);
      await expect(refused).rejects.toMatchObject({
        reason: 'allowed-hosts',
        message:
          'The server over HTTP binds to an address other than loopback only with a list of allowed hosts.',
      });
    },
  );

  it.each([-1, 65_536, 1.5, Number.NaN])(
    'refuses the port %s',
    async (port) => {
      await expect(listenHttp(options({ port }))).rejects.toMatchObject({
        reason: 'port',
      });
    },
  );

  it.each([
    ['no time at all', { headersMs: 0 }],
    ['a fraction', { keepAliveMs: 1.5 }],
    ['headers that may take longer than the request', { headersMs: 200_000 }],
  ])('refuses limits with %s', async (_, limits) => {
    await expect(listenHttp(options({ limits }))).rejects.toThrow(TypeError);
  });

  it('keeps the limits of ADR 0073', () => {
    expect(httpLimits).toEqual({
      headersMs: 10_000,
      requestMs: 120_000,
      keepAliveMs: 5_000,
      checkEveryMs: 1_000,
      closeMs: 10_000,
    });
    expect(maxHttpHeaderBytes).toBe(16_384);
  });
});
