import { PassThrough } from 'node:stream';

import {
  createStdioIdentity,
  createStdioTenantResolver,
  createToolCatalog,
  type ToolOutcome,
  type ToolPipeline,
} from '@ecclium/mcp-churchtools-core';
import type { LogFields, Logger } from '@ecclium/mcp-churchtools-plugin-api';
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
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  maxStdioMessageBytes,
  startStdioServer,
  type StdioServer,
  type StdioServerOptions,
} from './index.js';

// Drives the server over stdio in process, over streams in memory that the
// transport of the SDK reads and writes line by line. The pipeline is a
// stand-in: what runs behind the mount is the subject of its own tests.
// The real stdin and stdout of a child process are the subject of
// tests/mcp-stdio.test.mts, because package tests start no processes.

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

const open: StdioServer[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((server) => server.close()));
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

const setup = (overrides: Partial<StdioServerOptions> = {}) => {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk: Buffer) => {
    written += chunk.toString('utf8');
  });
  const events: Logged[] = [];
  const calls: { readonly name: string; readonly input: unknown }[] = [];
  const pipeline: ToolPipeline = {
    call: (name, value) => {
      calls.push({ name, input: value });
      return Promise.resolve(done);
    },
  };
  const server = startStdioServer({
    catalog,
    pipeline,
    identity: createStdioIdentity({
      stdioSubject: 'local-stdio',
      readOnly: true,
    }),
    resolver: createStdioTenantResolver(),
    mode: 'interactive',
    redaction: 'standard',
    readOnly: true,
    logger: recordingLogger(events),
    version: '0.0.0',
    input,
    output,
    ...overrides,
  });
  open.push(server);
  /** Every message written so far, one per complete line. */
  const received = (): readonly Json[] =>
    written
      .split('\n')
      .slice(0, -1)
      .map((line) => JSON.parse(line) as Json);
  return {
    server,
    input,
    events,
    calls,
    received,
    /** Writes the text as it is, in one chunk. */
    write: (text: string): void => {
      input.write(text);
    },
    send: (message: Json): void => {
      input.write(`${JSON.stringify(message)}\n`);
    },
    /** Waits for the response with the id. */
    reply: async (id: number): Promise<Json> => {
      let found: Json | undefined;
      await vi.waitFor(() => {
        found = received().find((message) => message['id'] === id);
        expect(found).toBeDefined();
      });
      return found ?? {};
    },
  };
};

const modernMeta: Json = {
  [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
  [CLIENT_INFO_META_KEY]: { name: 'test-client', version: '1.0.0' },
  [CLIENT_CAPABILITIES_META_KEY]: {},
};

const initialize: Json = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'older-client', version: '0.9.0' },
  },
};

/** A call of the echo tool whose line, break included, has the length. */
const callOfLength = (id: number, bytes: number): string => {
  const message = (pad: string): string =>
    `${JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: {
        name: 'ct_example_echo',
        arguments: { pad },
        _meta: modernMeta,
      },
    })}\n`;
  const line = message('a'.repeat(bytes - Buffer.byteLength(message(''))));
  expect(Buffer.byteLength(line)).toBe(bytes);
  return line;
};

describe('the server over stdio', () => {
  it('serves the 2026 era after server/discover', async () => {
    const { send, reply } = setup();
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
      params: { _meta: modernMeta },
    });
    expect(at(await reply(1), 'result', 'capabilities')).toEqual({
      tools: { listChanged: false },
      prompts: { listChanged: false },
    });
  });

  it('serves the 2025 era after initialize instead of refusing it', async () => {
    const { send, reply } = setup();
    send(initialize);
    const answer = await reply(1);
    expect(answer['error']).toBeUndefined();
    expect(at(answer, 'result', 'serverInfo')).toEqual({
      name: 'ecclium-mcp-churchtools',
      version: '0.0.0',
    });
  });

  it('lists the tools of the catalog and runs a call through the pipeline', async () => {
    const { send, reply, calls } = setup();
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: modernMeta },
    });
    const tools = at(await reply(1), 'result', 'tools') as readonly Json[];
    expect(tools.map((tool) => tool['name'])).toEqual(
      catalog.list().map((entry) => entry.name),
    );
    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'ct_example_echo',
        arguments: { email: 'max.mustermann@example.org' },
        _meta: modernMeta,
      },
    });
    expect(at(await reply(2), 'result', 'structuredContent')).toEqual({
      email: 'm***@example.org',
    });
    expect(calls).toEqual([
      {
        name: 'ct_example_echo',
        input: { email: 'max.mustermann@example.org' },
      },
    ]);
  });
});

describe('the size of a message', () => {
  it('is 1 MiB at most', () => {
    expect(maxStdioMessageBytes).toBe(1_048_576);
  });

  it('answers a message of exactly 1 MiB that arrives alone in one chunk', async () => {
    const { write, reply, calls, events } = setup();
    write(callOfLength(1, maxStdioMessageBytes));
    expect(at(await reply(1), 'result', 'structuredContent')).toEqual({
      email: 'm***@example.org',
    });
    expect(calls).toHaveLength(1);
    expect(events).toEqual([]);
  });

  // The limit holds for the input the transport has not read yet, the
  // rest of an unfinished message plus the chunk that just came in, not
  // for one message. The same two messages, each under 1 MiB, pass in
  // chunks of their own and end the connection in one chunk together.
  it('answers two messages under 1 MiB in chunks of their own', async () => {
    const { write, reply, calls, events } = setup();
    write(callOfLength(1, 600_000));
    write(callOfLength(2, 600_000));
    await reply(1);
    await reply(2);
    expect(calls).toHaveLength(2);
    expect(events).toEqual([]);
  });

  it('ends the connection on the same two messages in one chunk, without an answer', async () => {
    const { write, input, received, calls, events } = setup();
    write(callOfLength(1, 600_000) + callOfLength(2, 600_000));
    await vi.waitFor(() => {
      expect(input.listenerCount('data')).toBe(0);
    });
    expect(events).toEqual([
      { level: 'error', event: 'mcp_stdio_error', fields: undefined },
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(received()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('ends the connection on a message one byte larger', async () => {
    const { write, send, input, received, calls, events } = setup();
    write(callOfLength(1, maxStdioMessageBytes + 1));
    // The transport stops reading once it has closed.
    await vi.waitFor(() => {
      expect(input.listenerCount('data')).toBe(0);
    });
    expect(events).toEqual([
      { level: 'error', event: 'mcp_stdio_error', fields: undefined },
    ]);
    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'server/discover',
      params: { _meta: modernMeta },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(received()).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('an error of the connection', () => {
  it('writes the fixed event for a message that is no JSON-RPC, and the connection goes on', async () => {
    const canary = makeCanary('name').value;
    const { send, write, reply, events } = setup();
    send(initialize);
    await reply(1);
    write(`${JSON.stringify({ note: canary })}\n`);
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(at(await reply(2), 'result', 'tools')).toHaveLength(
      catalog.list().length,
    );
    expect(events).toContainEqual({
      level: 'error',
      event: 'mcp_stdio_error',
      fields: undefined,
    });
    expect(events.every((logged) => logged.fields === undefined)).toBe(true);
    expect(JSON.stringify(events)).not.toContain(canary);
  });

  it('skips a line that is no JSON, without an event', async () => {
    const { send, write, reply, events } = setup();
    send(initialize);
    await reply(1);
    write('{"jsonrpc":"2.0","id":2,\n');
    send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    await reply(3);
    expect(events).toEqual([]);
  });

  it('survives a logger that throws', async () => {
    const fails = (): never => {
      throw new Error('the logger failed');
    };
    const { send, write, reply } = setup({
      logger: { debug: fails, info: fails, warn: fails, error: fails },
    });
    write('{"note":"no JSON-RPC"}\n');
    send(initialize);
    expect(at(await reply(1), 'result', 'serverInfo')).toBeDefined();
  });
});

describe('the running server', () => {
  it('is frozen and holds nothing but close and closed', () => {
    const { server } = setup();
    expect(Object.isFrozen(server)).toBe(true);
    expect(Object.getPrototypeOf(server)).toBeNull();
    expect(Reflect.ownKeys(server)).toEqual(['close', 'closed']);
  });

  it('stops reading once closed, also when closed twice', async () => {
    const { server, input } = setup();
    await vi.waitFor(() => {
      expect(input.listenerCount('data')).toBe(1);
    });
    await server.close();
    await server.close();
    expect(input.listenerCount('data')).toBe(0);
  });

  it('does not start with a version that breaks its form', () => {
    expect(() => setup({ version: 'a b' })).toThrow(
      new TypeError('The version of the server is invalid.'),
    );
  });
});

/** Whether the promise has settled by the next turn of the event loop. */
const settledSoon = async (promise: Promise<void>): Promise<boolean> => {
  const later = new Promise<boolean>((resolve) => {
    setImmediate(() => {
      resolve(false);
    });
  });
  return Promise.race([promise.then(() => true), later]);
};

describe('the end of the connection', () => {
  it('stays open while the client keeps its input open', async () => {
    const { server, send, reply } = setup();
    send(initialize);
    await reply(1);
    expect(await settledSoon(server.closed)).toBe(false);
  });

  it('settles closed when the input ends', async () => {
    const { server, input } = setup();
    input.end();
    await expect(server.closed).resolves.toBeUndefined();
    expect(input.listenerCount('data')).toBe(0);
  });

  it('settles closed when unread input passes the limit', async () => {
    const { server, write, events } = setup();
    write(callOfLength(1, maxStdioMessageBytes + 1));
    await expect(server.closed).resolves.toBeUndefined();
    expect(events).toEqual([
      { level: 'error', event: 'mcp_stdio_error', fields: undefined },
    ]);
  });

  it('settles closed on close, also when closed twice', async () => {
    const { server } = setup();
    const { closed } = server;
    await server.close();
    await server.close();
    await expect(server.closed).resolves.toBeUndefined();
    expect(server.closed).toBe(closed);
  });

  it('settles closed and never rejects when closing the transport fails', async () => {
    const input = new PassThrough();
    // The transport pauses its input once it stops reading.
    input.pause = (): never => {
      throw new Error('the input cannot pause');
    };
    const { server } = setup({ input });
    await vi.waitFor(() => {
      expect(input.listenerCount('data')).toBe(1);
    });
    input.end();
    await expect(server.closed).resolves.toBeUndefined();
  });
});
