import {
  createToolCatalog,
  type ToolOutcome,
  type ToolPipeline,
  type ToolRequest,
} from '@ecclium/mcp-churchtools-core';
import type {
  Identity,
  LogFields,
  Logger,
  TenantResolver,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  examplePlugin,
  makeCanary,
  redactedOutcome,
} from '@ecclium/mcp-churchtools-testkit';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';

import { maxHttpBodyDepth, nestsTooDeep } from './body.js';
import {
  createHttpApp,
  type HttpApp,
  type HttpAppOptions,
  maxHttpBodyBytes,
  mcpPath,
} from './index.js';
import { asJsonWhenSingle, onlyMessageOf } from './stream.js';

// Drives the server over HTTP in process, through its function fetch,
// without a socket (ADR 0073). The test plays the client in raw JSON-RPC.
// The pipeline is a stand-in that records what each call brought along:
// what runs behind the mount is the subject of its own tests.

type Json = Readonly<Record<string, unknown>>;

/** Reads a value along a path of keys, undefined where the path ends. */
const at = (value: unknown, ...path: readonly (string | number)[]): unknown =>
  path.reduce<unknown>(
    (current, key) =>
      typeof current === 'object' && current !== null
        ? (current as Readonly<Record<string | number, unknown>>)[key]
        : undefined,
    value,
  );

const open: HttpApp[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((app) => app.close()));
});

const catalog = createToolCatalog({
  core: examplePlugin,
  plugins: [],
  readOnly: true,
  toolsets: new Set(['wiki'] as const),
});

const done: ToolOutcome = redactedOutcome({ email: 'm***@example.org' });

interface Logged {
  readonly level: string;
  readonly event: string;
  readonly fields: LogFields | undefined;
}

const recordingLogger = (events: Logged[]): Logger => {
  const level =
    (name: string) =>
    (event: string, fields?: LogFields): void => {
      events.push({ level: name, event, fields });
    };
  return {
    debug: level('debug'),
    info: level('info'),
    warn: level('warn'),
    error: level('error'),
  };
};

const identityA: Identity = Object.freeze({
  source: 'bearer',
  subject: 'person-id-1',
  scopes: Object.freeze(['read'] as const),
});
const identityB: Identity = Object.freeze({
  source: 'bearer',
  subject: 'person-id-2',
  scopes: Object.freeze(['read'] as const),
});

// The sign-in of the test: a fixed word per principal. Schub 4 brings the
// real check; here it only has to tell two principals and a stranger apart.
const tokenA = makeCanary('token').value;
const tokenB = 'second-principal';

// Two principals in two tenants.
const resolver: TenantResolver = Object.freeze({
  resolve: (identity: Identity) =>
    Promise.resolve(
      Object.freeze({
        tenantId: (identity.subject === 'person-id-2'
          ? 'second-tenant'
          : 'demo-tenant') as never,
        actor: Object.freeze({
          kind: 'user',
          id: `bearer:${identity.subject}`,
        }) as never,
      }),
    ),
});

const origin = 'http://127.0.0.1:8787';

const setup = (overrides: Partial<HttpAppOptions> = {}) => {
  const events: Logged[] = [];
  const calls: { readonly name: string; readonly request: ToolRequest }[] = [];
  const pipeline: ToolPipeline = {
    undo: () => Promise.resolve({ kind: 'off' }),
    adopt: () => Promise.resolve({ kind: 'off' }),
    reject: () => Promise.resolve({ kind: 'off' }),
    approve: () => Promise.resolve({ kind: 'off' }),
    listQueue: () => Promise.resolve({ kind: 'off' }),
    showQueue: () => Promise.resolve({ kind: 'off' }),
    callForRun: () =>
      Promise.resolve({ ok: false, code: 'internal', transient: false }),
    writeForRun: () =>
      Promise.resolve({
        ok: false,
        code: 'internal',
        sent: false,
        transient: false,
      }),
    endRun: () => false,
    call: (name, _input, request) => {
      calls.push({ name, request });
      return Promise.resolve(done);
    },
  };
  const app = createHttpApp({
    catalog,
    pipeline,
    authenticate: (request) => {
      const header = request.headers.get('authorization');
      return Promise.resolve(
        header === `Bearer ${tokenA}`
          ? identityA
          : header === `Bearer ${tokenB}`
            ? identityB
            : undefined,
      );
    },
    resolver,
    mode: 'interactive',
    redaction: 'standard',
    readOnly: true,
    logger: recordingLogger(events),
    version: '0.0.0',
    ...overrides,
  });
  open.push(app);
  return { app, events, calls };
};

const envelope = {
  [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
  [CLIENT_INFO_META_KEY]: { name: 'test-client', version: '1.0.0' },
  [CLIENT_CAPABILITIES_META_KEY]: {},
};

interface Sent {
  readonly method?: string;
  readonly path?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly raw?: string;
}

const send = (
  app: HttpApp,
  body: unknown,
  { method = 'POST', path = mcpPath, headers = {}, raw }: Sent = {},
): Promise<Response> =>
  app.fetch(
    new Request(`${origin}${path}`, {
      method,
      headers: {
        host: '127.0.0.1:8787',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokenA}`,
        ...headers,
      },
      ...(method === 'GET' || method === 'HEAD'
        ? {}
        : { body: raw ?? JSON.stringify(body) }),
    }),
  );

/** A request of the 2026 era with the headers it needs. */
const modern = (
  app: HttpApp,
  method: string,
  params: Json = {},
  headers: Readonly<Record<string, string>> = {},
): Promise<Response> =>
  send(
    app,
    { jsonrpc: '2.0', id: 2, method, params: { ...params, _meta: envelope } },
    {
      headers: {
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': method,
        ...(method === 'tools/call' && typeof params['name'] === 'string'
          ? { 'mcp-name': params['name'] }
          : {}),
        ...headers,
      },
    },
  );

/** A request of the 2025 era, as claude.ai sends it over HTTP. */
const legacy = (
  app: HttpApp,
  method: string,
  params: Json = {},
  headers: Readonly<Record<string, string>> = {},
): Promise<Response> =>
  send(
    app,
    { jsonrpc: '2.0', id: 3, method, params },
    { headers: { 'mcp-protocol-version': '2025-11-25', ...headers } },
  );

const initialize = {
  protocolVersion: '2025-11-25',
  capabilities: {},
  clientInfo: { name: 'older-client', version: '0.9.0' },
};

const json = async (response: Response): Promise<Json> => {
  expect(response.headers.get('content-type')).toMatch(/^application\/json/);
  return (await response.json()) as Json;
};

describe('the server over HTTP', () => {
  it('cannot be built without a check of the sign-in', () => {
    expect(() =>
      createHttpApp({
        catalog,
        authenticate: undefined as never,
      } as unknown as HttpAppOptions),
    ).toThrow(TypeError);
  });

  it('refuses a request without a sign-in with 401, before the handler and without reading the body', async () => {
    const { app, events, calls } = setup();
    let read = false;
    for (const authorization of ['', 'Bearer other', `Bearer ${tokenA}x`]) {
      // No buffer: the stream is pulled only when someone reads the body.
      const body = new ReadableStream<Uint8Array>(
        {
          pull: (controller) => {
            read = true;
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      const response = await app.fetch(
        new Request(`${origin}${mcpPath}`, {
          method: 'POST',
          headers: {
            host: '127.0.0.1:8787',
            'content-type': 'application/json',
            ...(authorization === '' ? {} : { authorization }),
          },
          body,
          duplex: 'half',
        }),
      );
      expect(response.status).toBe(401);
      expect(at(await json(response), 'error', 'message')).toBe(
        'This server needs a valid sign-in.',
      );
    }
    expect(read).toBe(false);
    expect(calls).toEqual([]);
    expect(events.map((event) => event.event)).toEqual([
      'http_auth_refused',
      'http_auth_refused',
      'http_auth_refused',
    ]);
  });

  it('counts a check of the sign-in that rejects as a refusal', async () => {
    const { app } = setup({
      authenticate: () => Promise.reject(new Error('person-id-1')),
    });
    const response = await modern(app, 'tools/list');
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain('person-id-1');
  });

  it('refuses a host that is not allowed with 403, before the sign-in', async () => {
    const { app, events } = setup();
    const response = await send(
      app,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { headers: { host: 'rebound.example.org' } },
    );
    expect(response.status).toBe(403);
    expect(events).toEqual([]);
  });

  it('answers 404 with an empty body on any other path', async () => {
    const { app } = setup();
    const response = await send(app, {}, { path: '/other' });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
  });
});

describe('the 2026 era over HTTP', () => {
  it('serves discovery, the list of tools and a call, every answer as JSON', async () => {
    const { app, calls } = setup();
    const discovered = await json(await modern(app, 'server/discover'));
    expect(JSON.stringify(discovered)).toContain('ecclium-mcp-churchtools');
    const listed = await json(await modern(app, 'tools/list'));
    expect(at(listed, 'result', 'tools')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'ct_example_echo' }),
      ]),
    );
    const called = await json(
      await modern(app, 'tools/call', {
        name: 'ct_example_echo',
        arguments: {},
      }),
    );
    expect(at(called, 'result', 'isError')).toBeUndefined();
    expect(calls.map((call) => call.name)).toEqual(['ct_example_echo']);
    expect(calls[0]?.request.assignment).toMatchObject({
      tenantId: 'demo-tenant',
      actor: { kind: 'user', id: 'bearer:person-id-1' },
    });
  });

  it('keeps two principals of two tenants apart in one process', async () => {
    const { app, calls } = setup();
    await modern(app, 'tools/call', { name: 'ct_example_echo', arguments: {} });
    await modern(
      app,
      'tools/call',
      { name: 'ct_example_echo', arguments: {} },
      { authorization: `Bearer ${tokenB}` },
    );
    await modern(app, 'tools/call', { name: 'ct_example_echo', arguments: {} });
    expect(calls.map((call) => call.request.assignment?.tenantId)).toEqual([
      'demo-tenant',
      'second-tenant',
      'demo-tenant',
    ]);
  });

  it('refuses subscriptions/listen before the handler, also behind a byte order mark and in a list', async () => {
    const { app, events } = setup();
    const listen = {
      jsonrpc: '2.0',
      id: 'x-1',
      method: 'subscriptions/listen',
      params: { _meta: envelope },
    };
    const headers = {
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'subscriptions/listen',
    };
    const bom = String.fromCharCode(0xfeff);
    for (const raw of [
      JSON.stringify(listen),
      `${bom}${JSON.stringify(listen)}`,
      JSON.stringify([listen]),
      // A key that occurs twice counts the last time, for the check and the
      // SDK alike.
      JSON.stringify(listen).replace(
        '"method":"subscriptions/listen"',
        '"method":"tools/list","method":"subscriptions/listen"',
      ),
    ]) {
      const response = await send(app, undefined, { raw, headers });
      expect(response.status).toBe(200);
      const answer = await json(response);
      expect(at(answer, 'error', 'code')).toBe(-32601);
      expect(response.headers.get('content-type')).not.toMatch(/event-stream/);
    }
    expect(events.map((event) => event.event)).toEqual(
      Array.from({ length: 4 }, () => 'http_listen_refused'),
    );
  });

  it('answers with the ID of the refused request', async () => {
    const { app } = setup();
    const answer = await json(await modern(app, 'subscriptions/listen', {}));
    expect(answer['id']).toBe(2);
  });

  it('declares that the lists of tools and prompts do not change', async () => {
    const { app } = setup();
    const discovered = await json(await modern(app, 'server/discover'));
    expect(at(discovered, 'result', 'capabilities')).toMatchObject({
      tools: { listChanged: false },
      prompts: { listChanged: false },
    });
  });
});

describe('the 2025 era over HTTP', () => {
  it('serves an older client without a session, as claude.ai sends it, every answer as JSON', async () => {
    const { app, calls } = setup();
    const initialized = await json(await legacy(app, 'initialize', initialize));
    expect(at(initialized, 'result', 'protocolVersion')).toBe('2025-11-25');
    const listed = await json(await legacy(app, 'tools/list'));
    expect(at(listed, 'result', 'tools')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'ct_example_echo' }),
      ]),
    );
    const called = await json(
      await legacy(app, 'tools/call', {
        name: 'ct_example_echo',
        arguments: {},
      }),
    );
    expect(at(called, 'result', 'isError')).toBeUndefined();
    expect(calls[0]?.request.assignment?.tenantId).toBe('demo-tenant');
  });

  it('answers GET and DELETE with 405 and opens no stream', async () => {
    const { app } = setup();
    for (const method of ['GET', 'DELETE']) {
      const response = await send(app, undefined, {
        method,
        headers: { 'mcp-protocol-version': '2025-11-25' },
      });
      expect(response.status).toBe(405);
      expect(response.headers.get('content-type') ?? '').not.toMatch(
        /event-stream/,
      );
    }
  });
});

describe('the body of a request', () => {
  it('refuses a POST without JSON as its content type with 415', async () => {
    const { app, events } = setup();
    for (const type of ['text/plain', '']) {
      const response = await send(
        app,
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { headers: { 'content-type': type } },
      );
      expect(response.status).toBe(415);
    }
    expect(events.map((event) => event.event)).toEqual([
      'http_body_not_json',
      'http_body_not_json',
    ]);
  });

  it('refuses a body over 1 MiB with 413, with or without a declared length', async () => {
    const { app, events } = setup();
    const raw = `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"x":"${'a'.repeat(maxHttpBodyBytes)}"}}`;
    const declared = await send(app, undefined, { raw });
    expect(declared.status).toBe(413);
    const encoded = new TextEncoder().encode(raw);
    const streamed = await app.fetch(
      new Request(`${origin}${mcpPath}`, {
        method: 'POST',
        headers: {
          host: '127.0.0.1:8787',
          'content-type': 'application/json',
          authorization: `Bearer ${tokenA}`,
        },
        body: new ReadableStream<Uint8Array>({
          start: (controller) => {
            for (let start = 0; start < encoded.length; start += 65_536) {
              controller.enqueue(encoded.subarray(start, start + 65_536));
            }
            controller.close();
          },
        }),
        duplex: 'half',
      }),
    );
    expect(streamed.status).toBe(413);
    expect(events.map((event) => event.event)).toEqual([
      'http_body_too_large',
      'http_body_too_large',
    ]);
  });

  it('refuses a body that is no JSON with 400 and a parse error', async () => {
    const { app, events } = setup();
    const response = await send(app, undefined, { raw: '{"jsonrpc":' });
    expect(response.status).toBe(400);
    expect(at(await json(response), 'error', 'code')).toBe(-32700);
    expect(events.map((event) => event.event)).toEqual([
      'http_body_unparsable',
    ]);
  });

  it('refuses a body deeper than 64 levels with 400 and passes one of 64 on', async () => {
    const { app, events, calls } = setup();
    const nested = (depth: number): unknown => {
      let value: unknown = 'x';
      for (let level = 1; level < depth; level += 1) value = { v: value };
      return value;
    };
    // The message itself is the first level, its params the second.
    // The message is the first level, its params the second, the
    // arguments the third; nested(n) adds n - 1 levels below them.
    const call = (depth: number) =>
      modern(app, 'tools/call', {
        name: 'ct_example_echo',
        arguments: { deep: nested(depth - 2) },
      });
    const deep = await call(maxHttpBodyDepth + 1);
    expect(deep.status).toBe(400);
    expect(at(await json(deep), 'error', 'code')).toBe(-32600);
    expect(events.map((event) => event.event)).toEqual(['http_body_too_deep']);
    const allowed = await call(maxHttpBodyDepth);
    expect(allowed.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('measures depth without recursion, also for a body as deep as 1 MiB allows', () => {
    const deep = JSON.parse(
      `${'['.repeat(400_000)}${']'.repeat(400_000)}`,
    ) as unknown;
    expect(nestsTooDeep(deep)).toBe(true);
    expect(nestsTooDeep({ a: [{ b: 1 }] })).toBe(false);
    expect(nestsTooDeep('x')).toBe(false);
  });
});

describe('what the server writes', () => {
  it('names no token and no value of the client in an answer or the log', async () => {
    const { app, events } = setup();
    const canary = makeCanary('name').value;
    const headerCanary = `CANARY${String(Date.now())}header`;
    const answers = [
      await modern(app, 'tools/call', {
        name: 'ct_example_echo',
        arguments: { text: canary },
      }),
      await send(app, undefined, { raw: `{"${canary}":` }),
      await send(app, undefined, {
        headers: { authorization: `Bearer ${headerCanary}` },
      }),
      await modern(app, 'subscriptions/listen', { [canary]: canary }),
    ];
    for (const answer of answers) {
      const text = await answer.text();
      expect(text).not.toContain(tokenA);
      expect(text).not.toContain(canary);
      expect(text).not.toContain(headerCanary);
    }
    const logged = JSON.stringify(events);
    expect(logged).not.toContain(tokenA);
    expect(logged).not.toContain(canary);
    expect(logged).not.toContain(headerCanary);
    for (const event of events) expect(event.fields).toBeUndefined();
  });
});

describe('a stream of one message', () => {
  const stream = (text: string, status = 200): Response =>
    new Response(text, {
      status,
      headers: { 'content-type': 'text/event-stream' },
    });

  it('goes on as JSON with its status', async () => {
    const answer = await asJsonWhenSingle(
      stream(
        'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n',
        202,
      ),
    );
    expect(answer.status).toBe(202);
    expect(answer.headers.get('content-type')).toBe('application/json');
    expect(await answer.json()).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
  });

  it('stays a stream with two messages or one that is no JSON', async () => {
    for (const text of [
      'data: {"a":1}\n\ndata: {"b":2}\n\n',
      'data: not json\n\n',
    ]) {
      const answer = await asJsonWhenSingle(stream(text));
      expect(answer.headers.get('content-type')).toBe('text/event-stream');
      expect(await answer.text()).toBe(text);
    }
    expect(onlyMessageOf('event: ping\n\n')).toBeUndefined();
  });

  it('leaves an answer that is no stream as it is', async () => {
    const plain = new Response('{"x":1}', {
      headers: { 'content-type': 'application/json' },
    });
    expect(await asJsonWhenSingle(plain)).toBe(plain);
  });
});
