import { once } from 'node:events';
import { connect, type Socket } from 'node:net';
import process from 'node:process';

import {
  createToolCatalog,
  type ToolOutcome,
  type ToolPipeline,
} from '@ecclium/mcp-churchtools-core';
import type {
  Identity,
  LogFields,
  Logger,
  TenantResolver,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  type HttpListener,
  listenHttp,
  maxHttpBodyBytes,
  maxHttpHeaderBytes,
} from '@ecclium/mcp-churchtools-server/http';
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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The one test that binds the server over HTTP to a port (ADR 0073), on
// 127.0.0.1 with a port the system picks, as the network guard of the
// tests allows (ADR 0052). Every other test calls the application in
// process. The client is a raw socket, because fetch can send neither a
// chosen Host, two headers of the same name, the absolute form of a
// target nor headers that arrive slowly. The limits of time are short, so
// that the timeouts of Node.js fire within the test.

const token = makeCanary('token').value;

const identity: Identity = Object.freeze({
  source: 'bearer',
  subject: 'person-id-1',
  scopes: Object.freeze(['read'] as const),
});

const resolver: TenantResolver = Object.freeze({
  resolve: () =>
    Promise.resolve(
      Object.freeze({
        tenantId: 'demo-tenant' as never,
        actor: Object.freeze({
          kind: 'user',
          id: 'bearer:person-id-1',
        }) as never,
      }),
    ),
});

const done: ToolOutcome = redactedOutcome({ email: 'm***@example.org' });

interface Logged {
  readonly level: string;
  readonly event: string;
  readonly fields: LogFields | undefined;
}
const logged: Logged[] = [];
const logger: Logger = Object.freeze({
  debug: (event: string, fields?: LogFields) => {
    logged.push({ level: 'debug', event, fields });
  },
  info: (event: string, fields?: LogFields) => {
    logged.push({ level: 'info', event, fields });
  },
  warn: (event: string, fields?: LogFields) => {
    logged.push({ level: 'warn', event, fields });
  },
  error: (event: string, fields?: LogFields) => {
    logged.push({ level: 'error', event, fields });
  },
});
const events = (): string[] => logged.map((entry) => entry.event);

// A call of a tool can be held until the client goes away, to see that
// the signal of the request aborts.
const held: {
  next: boolean;
  started?: () => void;
  aborted?: () => void;
} = { next: false };

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
  call: (_name, _input, request) => {
    if (!held.next) return Promise.resolve(done);
    held.next = false;
    held.started?.();
    return new Promise<ToolOutcome>((resolve) => {
      request.signal.addEventListener('abort', () => {
        held.aborted?.();
        resolve(done);
      });
    });
  },
};

let server: HttpListener;
const stderr = vi.spyOn(process.stderr, 'write');
const consoleCalls = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
  (level) => vi.spyOn(console, level),
);

beforeAll(async () => {
  server = await listenHttp({
    catalog: createToolCatalog({
      core: examplePlugin,
      plugins: [],
      readOnly: true,
      toolsets: new Set(['wiki'] as const),
    }),
    pipeline,
    authenticate: (request) =>
      Promise.resolve(
        request.headers.get('authorization') === `Bearer ${token}`
          ? identity
          : undefined,
      ),
    resolver,
    mode: 'interactive',
    redaction: 'standard',
    readOnly: true,
    logger,
    version: '0.0.0',
    port: 0,
    limits: {
      headersMs: 300,
      requestMs: 2_000,
      keepAliveMs: 2_000,
      checkEveryMs: 50,
      closeMs: 500,
    },
  });
  stderr.mockClear();
  for (const spy of consoleCalls) spy.mockClear();
});

afterAll(async () => {
  await server.close();
  stderr.mockRestore();
  for (const spy of consoleCalls) spy.mockRestore();
});

interface Answer {
  readonly status: number;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string;
}

/**
 * A raw client: writes bytes, reads answers one after the other. An answer
 * with Content-Length ends after its body, one without it at the close of
 * the connection, as the answers Node.js writes itself.
 */
const open = async () => {
  const socket: Socket = connect({ host: '127.0.0.1', port: server.port });
  await once(socket, 'connect');
  const state = { buffer: Buffer.alloc(0), closed: false };
  const waiting: (() => void)[] = [];
  const wake = (): void => {
    for (const resume of waiting.splice(0)) resume();
  };
  socket.on('data', (chunk: Buffer) => {
    state.buffer = Buffer.concat([state.buffer, chunk]);
    wake();
  });
  socket.on('close', () => {
    state.closed = true;
    wake();
  });
  // A write after the server closed fails; the test reads what came back.
  socket.on('error', () => undefined);

  const parse = (): Answer | undefined => {
    const end = state.buffer.indexOf('\r\n\r\n');
    if (end < 0) return undefined;
    const lines = state.buffer
      .subarray(0, end)
      .toString('latin1')
      .split('\r\n');
    const status = Number(lines[0]?.split(' ')[1]);
    const headers = lines.slice(1).map((line) => {
      const colon = line.indexOf(':');
      return [
        line.slice(0, colon).toLowerCase(),
        line.slice(colon + 1).trim(),
      ] as const;
    });
    const length = headers.find(([name]) => name === 'content-length')?.[1];
    const start = end + 4;
    if (length === undefined) {
      if (!state.closed) return undefined;
      const body = state.buffer.subarray(start).toString('utf8');
      state.buffer = Buffer.alloc(0);
      return { status, headers, body };
    }
    const stop = start + Number(length);
    if (state.buffer.length < stop) return undefined;
    const body = state.buffer.subarray(start, stop).toString('utf8');
    state.buffer = state.buffer.subarray(stop);
    return { status, headers, body };
  };

  const answer = async (): Promise<Answer | undefined> => {
    for (;;) {
      const parsed = parse();
      if (parsed !== undefined) return parsed;
      if (state.closed) return undefined;
      await new Promise<void>((resume) => waiting.push(resume));
    }
  };

  const closed = async (): Promise<void> => {
    while (!state.closed) {
      await new Promise<void>((resume) => waiting.push(resume));
    }
  };

  return {
    socket,
    write: (data: string | Uint8Array): void => {
      if (!socket.destroyed) socket.write(data);
    },
    answer,
    closed,
    end: (): void => {
      socket.destroy();
    },
  };
};

const host = (): string => `127.0.0.1:${String(server.port)}`;

const envelope = {
  [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
  [CLIENT_INFO_META_KEY]: { name: 'test-client', version: '1.0.0' },
  [CLIENT_CAPABILITIES_META_KEY]: {},
};

/** A request of the 2026 era as raw text, with headers to replace. */
const post = (
  method: string,
  params: Readonly<Record<string, unknown>> = {},
  replace: Readonly<Record<string, string>> = {},
): string => {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method,
    params: { ...params, _meta: envelope },
  });
  const headers: Record<string, string> = {
    Host: host(),
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${token}`,
    'Mcp-Protocol-Version': '2026-07-28',
    'Mcp-Method': method,
    ...(typeof params['name'] === 'string'
      ? { 'Mcp-Name': params['name'] }
      : {}),
    'Content-Length': String(Buffer.byteLength(body)),
    ...replace,
  };
  const lines = Object.entries(headers).map(
    ([name, value]) => `${name}: ${value}`,
  );
  return `POST /mcp HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n${body}`;
};

const noCors = (answer: Answer | undefined): void => {
  expect(answer).toBeDefined();
  expect(
    answer?.headers.filter(([name]) => name.startsWith('access-control-')),
  ).toEqual([]);
};

describe('the server over HTTP on 127.0.0.1', () => {
  it('answers a list of tools as JSON, in one piece with its length', async () => {
    const client = await open();
    client.write(post('tools/list'));
    const answer = await client.answer();
    client.end();
    expect(answer?.status).toBe(200);
    expect(
      answer?.headers.find(([name]) => name === 'content-type')?.[1],
    ).toMatch(/^application\/json/);
    expect(answer?.headers.some(([name]) => name === 'transfer-encoding')).toBe(
      false,
    );
    expect(JSON.parse(answer?.body ?? '')).toMatchObject({ id: 1 });
    noCors(answer);
  });

  it('refuses a Host with another port and two Host headers with 403', async () => {
    const before = logged.length;
    const client = await open();
    client.write(
      post('tools/list', {}, { Host: `127.0.0.1:${String(server.port + 1)}` }),
    );
    expect((await client.answer())?.status).toBe(403);
    client.write(
      post('tools/list').replace(
        '\r\nContent-Type',
        `\r\nHost: ${host()}\r\nContent-Type`,
      ),
    );
    expect((await client.answer())?.status).toBe(403);
    client.end();
    expect(logged.slice(before).map((entry) => entry.event)).toEqual([
      'http_host_refused',
      'http_host_refused',
    ]);
  });

  it('refuses a target in the absolute form with 400 and a fixed sentence', async () => {
    const before = logged.length;
    const client = await open();
    client.write(
      post('tools/list').replace('POST /mcp ', `POST http://${host()}/mcp `),
    );
    const answer = await client.answer();
    client.end();
    expect(answer?.status).toBe(400);
    expect(answer?.body).toContain(
      'This server takes only requests to a path, with headers it can read.',
    );
    expect(logged.slice(before).map((entry) => entry.event)).toEqual([
      'http_request_malformed',
    ]);
  });

  it('answers 401 without a sign-in before the body has arrived', async () => {
    const client = await open();
    client.write(
      `POST /mcp HTTP/1.1\r\nHost: ${host()}\r\nContent-Type: application/json\r\nContent-Length: 500000\r\n\r\n{`,
    );
    const answer = await client.answer();
    client.end();
    expect(answer?.status).toBe(401);
  });

  it('answers OPTIONS without a header for CORS, with and without a sign-in', async () => {
    const preflight = (authorization: string): string =>
      `OPTIONS /mcp HTTP/1.1\r\nHost: ${host()}\r\nOrigin: http://${host()}\r\nAccess-Control-Request-Method: POST\r\nAccess-Control-Request-Headers: authorization, content-type\r\n${authorization}Content-Length: 0\r\n\r\n`;
    const client = await open();
    client.write(preflight(''));
    const refused = await client.answer();
    client.write(preflight(`Authorization: Bearer ${token}\r\n`));
    const signedIn = await client.answer();
    client.end();
    expect(refused?.status).toBe(401);
    expect(signedIn?.status).toBe(405);
    noCors(refused);
    noCors(signedIn);
  });

  it('refuses a body in chunks over 1 MiB with 413, reads away the rest and keeps the connection', async () => {
    const before = logged.length;
    const client = await open();
    client.write(
      `POST /mcp HTTP/1.1\r\nHost: ${host()}\r\nContent-Type: application/json\r\nAuthorization: Bearer ${token}\r\nTransfer-Encoding: chunked\r\n\r\n`,
    );
    // About 640 KiB past the limit: more than Node.js buffers on its own
    // once the body was read in part, less than the bridge reads away.
    const piece = Buffer.alloc(64 * 1024, 'a');
    const pieces = Math.ceil(maxHttpBodyBytes / piece.length) + 10;
    for (let index = 0; index < pieces; index += 1) {
      client.write(`${piece.length.toString(16)}\r\n`);
      client.write(piece);
      client.write('\r\n');
    }
    client.write('0\r\n\r\n');
    const refused = await client.answer();
    expect(refused?.status).toBe(413);
    // The rest of the body was read away, so the connection takes the
    // next request.
    client.write(post('tools/list'));
    expect((await client.answer())?.status).toBe(200);
    client.end();
    expect(logged.slice(before).map((entry) => entry.event)).toEqual([
      'http_body_too_large',
    ]);
  });

  it('ends the connection when the rest of a body runs past 1 MiB more', async () => {
    const client = await open();
    client.write(
      `POST /mcp HTTP/1.1\r\nHost: ${host()}\r\nContent-Type: application/json\r\nAuthorization: Bearer ${token}\r\nTransfer-Encoding: chunked\r\n\r\n`,
    );
    const piece = Buffer.alloc(64 * 1024, 'a');
    const pieces = Math.ceil((3 * maxHttpBodyBytes) / piece.length);
    for (
      let index = 0;
      index < pieces && !client.socket.destroyed;
      index += 1
    ) {
      client.write(`${piece.length.toString(16)}\r\n`);
      client.write(piece);
      client.write('\r\n');
    }
    await client.closed();
    client.end();
  });

  it.each([
    [
      'headers over 16 KiB',
      () =>
        `GET /mcp HTTP/1.1\r\nHost: ${host()}\r\nX-Pad: ${'a'.repeat(maxHttpHeaderBytes)}\r\n\r\n`,
      431,
    ],
    [
      'Content-Length together with Transfer-Encoding',
      () =>
        `POST /mcp HTTP/1.1\r\nHost: ${host()}\r\nContent-Length: 3\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n`,
      400,
    ],
  ])(
    'answers %s as Node.js does, with a line of its own in the log',
    async (_, text, status) => {
      const before = logged.length;
      const client = await open();
      client.write(text());
      const answer = await client.answer();
      await client.closed();
      expect(answer?.status).toBe(status);
      expect(logged.slice(before).map((entry) => entry.event)).toEqual([
        'http_client_error',
      ]);
    },
  );

  it('leaves HTTP/1.1 without Host to Node.js, which answers 400 and closes', async () => {
    const before = logged.length;
    const client = await open();
    client.write('GET /mcp HTTP/1.1\r\n\r\n');
    const answer = await client.answer();
    await client.closed();
    expect(answer?.status).toBe(400);
    expect(logged.slice(before)).toEqual([]);
  });

  it('answers headers that do not arrive in time with 408 and ends the connection', async () => {
    const before = logged.length;
    const client = await open();
    client.write(`POST /mcp HTTP/1.1\r\nHost: ${host()}\r\n`);
    const answer = await client.answer();
    await client.closed();
    expect(answer?.status).toBe(408);
    expect(logged.slice(before).map((entry) => entry.event)).toEqual([
      'http_client_error',
    ]);
  });

  it('aborts the signal of a call when the client goes away', async () => {
    const started = new Promise<void>((resolve) => {
      held.started = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      held.aborted = resolve;
    });
    held.next = true;
    const client = await open();
    client.write(
      post('tools/call', { name: 'ct_example_echo', arguments: {} }),
    );
    await started;
    client.end();
    await aborted;
  });

  it('writes nothing past the logger and never names the token', () => {
    expect(stderr).not.toHaveBeenCalled();
    for (const spy of consoleCalls) expect(spy).not.toHaveBeenCalled();
    expect(JSON.stringify(logged)).not.toContain(token);
    expect(new Set(events())).not.toContain('http_server_error');
  });

  it('takes no connection after close', async () => {
    await server.close();
    const socket = connect({ host: '127.0.0.1', port: server.port });
    const [error] = (await once(socket, 'error')) as [NodeJS.ErrnoException];
    expect(error.code).toBe('ECONNREFUSED');
  });
});
