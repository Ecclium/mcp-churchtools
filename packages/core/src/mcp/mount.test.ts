import { PassThrough } from 'node:stream';

import { loadConfig } from '@ecclium/mcp-churchtools-core';
import type {
  Logger,
  Plugin,
  PluginHost,
  TenantResolver,
  ToolDefinition,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  createChurchToolsDouble,
  doubleOrigin,
  examplePlugin,
  makeCanary,
} from '@ecclium/mcp-churchtools-testkit';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  InMemoryTransport,
  type JSONRPCMessage,
  McpServer,
  type McpServerFactory,
  PROTOCOL_VERSION_META_KEY,
  SERVER_INFO_META_KEY,
  type Transport,
} from '@modelcontextprotocol/server';
import {
  serveStdio,
  StdioServerTransport,
  type StdioServerHandle,
} from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { auditPlaceholders, createAuditSink } from '../audit/index.js';
import { fixedSentences } from '../errors/index.js';
import {
  createStdioIdentity,
  createStdioTenantResolver,
} from '../identity/index.js';
import { createLogger } from '../logger/index.js';
import { createToolPipeline, type ToolPipeline } from '../pipeline/index.js';
import { maxResultBytes, resultBytes } from '../pipeline/stages.js';
import { createToolCatalog, RegistryRefusal } from '../registry/index.js';
import { deriveAnnotations } from './annotations.js';
import { createMcpMount, type McpMountOptions } from './mount.js';
import { deriveInputSchema, deriveOutputSchema } from './schema.js';

// Drives the mount in process through the serving entry of the SDK, in
// both eras, with the test playing the client in raw JSON-RPC. Every
// message the client receives goes through JSON first, as on the wire.
// Requests to ChurchTools go to the double, which connects nowhere.

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

const description = {
  purpose: 'Serves a test.',
  useWhen: 'A test needs it.',
  avoidWhen: 'Anything else.',
  limits: 'None.',
};

const readMeta = {
  capability: 'read',
  domain: 'base',
  requiredRights: [],
  tier: 'free',
  sensitivity: 'none',
  unattended: 'policy',
  routineStable: false,
} as const;

// A plain tool of the test, not defineTool: core and the plugin interface
// resolve different copies of zod in the workspace.
const testTool = (
  name: `ct_${string}`,
  execute: (call: {
    readonly ctx: unknown;
    readonly input: unknown;
  }) => unknown,
  extra: Record<string, unknown> = {},
): ToolDefinition =>
  ({
    name,
    meta: readMeta,
    description,
    input: z.object({}),
    output: z.object({ text: z.string().max(100_000) }),
    execute,
    ...extra,
  }) as unknown as ToolDefinition;

const testPlugin = (...tools: ToolDefinition[]): Plugin => ({
  name: 'test-plugin',
  version: '1.0.0',
  register(host: PluginHost): undefined {
    for (const tool of tools) host.addTool(tool);
    return undefined;
  },
});

const frozenClock = Object.freeze({ now: Object.freeze(() => 0) });

const boundary = 'a1b2c3d4e5f60718';
const boundaryBytes = [0xa1, 0xb2, 0xc3, 0xd4, 0xe5, 0xf6, 0x07, 0x18];
const envelope = (text: string): string =>
  `<<data-${boundary}>>${text}<</data-${boundary}>>`;

interface Setup {
  readonly options: McpMountOptions;
  readonly factory: McpServerFactory;
  readonly audit: () => readonly Json[];
  readonly logs: () => readonly Json[];
  readonly contexts: unknown[];
}

const lines = (target: string[]) =>
  Object.freeze({
    write: (line: string): boolean => {
      target.push(line);
      return true;
    },
  });

const parsed = (target: readonly string[]): readonly Json[] =>
  target.map((line) => JSON.parse(line) as Json);

const setup = (
  overrides: Partial<McpMountOptions> = {},
  tools: readonly ToolDefinition[] = [],
  mounted = true,
): Setup => {
  const double = createChurchToolsDouble({ token });
  open.push(double);
  const contexts: unknown[] = [];
  const catalog = createToolCatalog({
    plugins: [
      examplePlugin,
      testPlugin(
        testTool('ct_test_context', ({ ctx }) => {
          contexts.push(ctx);
          return { text: 'ok' };
        }),
        ...tools,
      ),
    ],
    readOnly: true,
  });
  const auditLines: string[] = [];
  const logLines: string[] = [];
  const audit = createAuditSink({
    writer: lines(auditLines),
    clock: frozenClock,
    isKnownTool: catalog.has,
  });
  const pipeline = createToolPipeline({
    catalog,
    audit,
    transport: double.transport,
    origin: doubleOrigin,
    requestsPerMinute: 300,
    clock: frozenClock,
    random: () => Uint8Array.from(boundaryBytes),
    logging: { writer: lines(logLines), minLevel: 'debug' },
  });
  const options: McpMountOptions = {
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
    logger: createLogger({
      writer: lines(logLines),
      clock: frozenClock,
      minLevel: 'debug',
    }),
    version: '0.0.0',
    ...overrides,
  };
  return {
    options,
    factory: mounted
      ? createMcpMount(options).factory
      : () => {
          throw new Error('not mounted');
        },
    audit: () => parsed(auditLines),
    logs: () => parsed(logLines),
    contexts,
  };
};

/** Answers the client gives to a request of the server. */
type Answer = (message: Json) => Json;

interface Connection {
  /** Sends a request and resolves with the response that has its id. */
  readonly request: (method: string, params?: Json) => Promise<Json>;
  /** Sends a notification. */
  readonly notify: (method: string, params?: Json) => Promise<void>;
  /** Every message the client received, as JSON gives it back. */
  readonly received: readonly Json[];
  /** The id of the last request the client sent. */
  readonly lastId: () => number;
}

const connect = async (
  factory: McpServerFactory,
  answer?: Answer,
): Promise<Connection> => {
  const [client, wire] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (reply: Json) => void>();
  const received: Json[] = [];
  let lastId = 0;
  client.onmessage = (raw) => {
    const message = JSON.parse(JSON.stringify(raw)) as Json;
    received.push(message);
    const id = message['id'];
    if (typeof message['method'] === 'string' && id !== undefined) {
      void client.send({
        jsonrpc: '2.0',
        id,
        result: answer?.(message) ?? {},
      } as unknown as JSONRPCMessage);
    } else if (typeof id === 'number') {
      pending.get(id)?.(message);
      pending.delete(id);
    }
  };
  await client.start();
  const handle: StdioServerHandle = serveStdio(factory, {
    legacy: 'serve',
    transport: wire,
  });
  open.push(handle);
  return {
    request: async (method, params) => {
      lastId += 1;
      const id = lastId;
      const reply = new Promise<Json>((resolve) => pending.set(id, resolve));
      await client.send({
        jsonrpc: '2.0',
        id,
        method,
        ...(params === undefined ? {} : { params }),
      } as unknown as JSONRPCMessage);
      return reply;
    },
    notify: (method, params) =>
      client.send({
        jsonrpc: '2.0',
        method,
        ...(params === undefined ? {} : { params }),
      } as unknown as JSONRPCMessage),
    received,
    lastId: () => lastId,
  };
};

const modernMeta: Json = {
  [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
  [CLIENT_INFO_META_KEY]: { name: 'test-client', version: '1.0.0' },
  [CLIENT_CAPABILITIES_META_KEY]: {},
};

/** One way to talk to the mount: in the 2026 era or in the 2025 era. */
interface Era {
  readonly name: 'modern' | 'legacy';
  /** Opens a connection; the 2025 era with its handshake. */
  readonly open: (factory: McpServerFactory) => Promise<Connection>;
  /** Sends a request with what the era needs around it. */
  readonly ask: (
    connection: Connection,
    method: string,
    params?: Json,
  ) => Promise<Json>;
}

const modern: Era = {
  name: 'modern',
  open: (factory) => connect(factory),
  ask: (connection, method, params = {}) =>
    connection.request(method, { ...params, _meta: modernMeta }),
};

const legacy: Era = {
  name: 'legacy',
  open: async (factory) => {
    const connection = await connect(factory);
    await connection.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'older-client', version: '0.9.0' },
    });
    await connection.notify('notifications/initialized');
    return connection;
  },
  ask: (connection, method, params = {}) => connection.request(method, params),
};

const eras = [modern, legacy];

const call = (
  era: Era,
  connection: Connection,
  name: string,
  args?: Json,
): Promise<Json> =>
  era.ask(connection, 'tools/call', {
    name,
    ...(args === undefined ? {} : { arguments: args }),
  });

describe.each(eras)('the list of tools in the $name era', (era) => {
  it('lists every tool of the catalog with its derived schemas and hints', async () => {
    const { factory, options } = setup();
    const connection = await era.open(factory);
    const reply = await era.ask(connection, 'tools/list');
    const expected = options.catalog.list().map((entry) => ({
      name: entry.name,
      description: entry.description,
      inputSchema: deriveInputSchema(entry),
      outputSchema: deriveOutputSchema(entry.shape),
      annotations: deriveAnnotations(entry.meta),
    }));
    expect(at(reply, 'result', 'tools')).toEqual(
      JSON.parse(JSON.stringify(expected)),
    );
    expect(at(reply, 'result', 'nextCursor')).toBeUndefined();
  });
});

describe('the list of tools', () => {
  it('keeps no text of the registry of zod in an input schema', async () => {
    const hint = 'internal-hint-of-the-plugin';
    const said = 'Describes the query for the model.';
    const { factory } = setup({}, [
      testTool('ct_test_meta', () => ({ text: 'ok' }), {
        input: z.object({
          query: z
            .string()
            .max(100)
            .meta({ 'x-internal': hint, description: said }),
          other: z.string().max(10).describe(said),
        }),
      }),
    ]);
    const connection = await modern.open(factory);
    const reply = await modern.ask(connection, 'tools/list');
    const tools = at(reply, 'result', 'tools') as readonly Json[];
    const tool = tools.find((entry) => entry['name'] === 'ct_test_meta');
    expect(tool?.['inputSchema']).toEqual({
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 100 },
        other: { type: 'string', maxLength: 10 },
      },
      required: ['query', 'other'],
    });
    const text = JSON.stringify(reply);
    expect(text).not.toContain('x-internal');
    expect(text).not.toContain(hint);
    expect(text).not.toContain(said);
  });

  it('declares tools without listChanged in the 2026 era', async () => {
    const { factory } = setup();
    const connection = await connect(factory);
    const reply = await connection.request('server/discover', {
      _meta: modernMeta,
    });
    expect(at(reply, 'result', 'capabilities')).toEqual({
      tools: { listChanged: false },
    });
  });

  it('declares tools without listChanged in the 2025 era', async () => {
    const { factory } = setup();
    const connection = await connect(factory);
    const reply = await connection.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'older-client', version: '0.9.0' },
    });
    expect(at(reply, 'result', 'capabilities')).toEqual({
      tools: { listChanged: false },
    });
    expect(at(reply, 'result', 'serverInfo')).toEqual({
      name: 'ecclium-mcp-churchtools',
      version: '0.0.0',
    });
  });
});

describe.each(eras)('a call in the $name era', (era) => {
  it('returns the masked data as text and as structured content', async () => {
    const { factory, audit } = setup();
    const connection = await era.open(factory);
    const reply = await call(era, connection, 'ct_example_echo', {
      email: 'max.mustermann@example.org',
      notes: ['a'],
    });
    const result = at(reply, 'result') as Json;
    expect(result['structuredContent']).toEqual({
      email: 'm***@example.org',
      notes: [envelope('a')],
    });
    expect(result['content']).toEqual([
      { type: 'text', text: JSON.stringify(result['structuredContent']) },
    ]);
    expect(result['isError']).toBeUndefined();
    expect(audit()).toMatchObject([{ tool: 'ct_example_echo', outcome: 'ok' }]);
  });

  it('ends an unknown tool in the pipeline, with one audit line', async () => {
    const { factory, audit, logs } = setup();
    const connection = await era.open(factory);
    const reply = await call(era, connection, 'ct_not_there', { a: 1 });
    expect(at(reply, 'result')).toMatchObject({
      content: [{ type: 'text', text: fixedSentences.not_found }],
      isError: true,
    });
    expect(audit()).toMatchObject([
      {
        tool: 'ct_unknown',
        outcome: 'error',
        errorCode: 'not_found',
        actor: { kind: 'user', id: 'stdio:local-stdio' },
      },
    ]);
    expect(logs()).toEqual([]);
  });

  it('ends an input that does not fit in the pipeline, with one audit line and one log line', async () => {
    const { factory, audit, logs } = setup();
    const connection = await era.open(factory);
    const canary = makeCanary('name').value;
    const reply = await call(era, connection, 'ct_example_echo', {
      notes: [canary],
      unknown: canary,
    });
    expect(at(reply, 'result')).toMatchObject({
      content: [{ type: 'text', text: fixedSentences.validation }],
      isError: true,
    });
    expect(audit()).toMatchObject([
      { tool: 'ct_example_echo', outcome: 'error', errorCode: 'validation' },
    ]);
    expect(logs()).toMatchObject([
      { event: 'tool_call', tool: 'ct_example_echo', code: 'validation' },
    ]);
    const answer = JSON.stringify(connection.received);
    expect(answer).not.toContain(canary);
  });

  it('takes a call without arguments as one with none', async () => {
    const { factory, audit } = setup();
    const connection = await era.open(factory);
    const reply = await call(era, connection, 'ct_test_context');
    expect(at(reply, 'result', 'structuredContent')).toEqual({ text: 'ok' });
    expect(audit()).toMatchObject([{ tool: 'ct_test_context', outcome: 'ok' }]);
  });

  it('gives each call a context of its own, frozen', async () => {
    const { factory, contexts } = setup();
    const connection = await era.open(factory);
    await call(era, connection, 'ct_test_context', {});
    await call(era, connection, 'ct_test_context', {});
    expect(contexts).toHaveLength(2);
    const [first, second] = contexts as [Json, Json];
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(second)).toBe(true);
    expect(first['signal']).not.toBe(second['signal']);
    expect(first['log']).not.toBe(second['log']);
  });
});

describe('the 2026 era', () => {
  it('marks a result as complete and names the server in its _meta', async () => {
    const { factory } = setup();
    const connection = await modern.open(factory);
    const reply = await call(modern, connection, 'ct_test_context', {});
    expect(at(reply, 'result', 'resultType')).toBe('complete');
    expect(at(reply, 'result', '_meta', SERVER_INFO_META_KEY)).toEqual({
      name: 'ecclium-mcp-churchtools',
      version: '0.0.0',
    });
  });
});

describe('the resolver of the tenant', () => {
  const resolverOf = (resolve: (identity: never) => unknown): TenantResolver =>
    ({ resolve }) as unknown as TenantResolver;

  it.each([
    ['undefined', () => Promise.resolve(undefined)],
    ['null', () => Promise.resolve(null)],
    ['a string', () => Promise.resolve('demo-tenant')],
    ['a number', () => Promise.resolve(1)],
    ['an array', () => Promise.resolve([])],
    // Both reach the pipeline, which cannot read them without running
    // their code.
    [
      'an object whose tenant is a getter that throws',
      () =>
        Promise.resolve({
          get tenantId(): never {
            throw new Error('person-id-1');
          },
          actor: { kind: 'user', id: 'stdio:local-stdio' },
        }),
    ],
    [
      'a proxy',
      () =>
        Promise.resolve(
          new Proxy(
            {
              tenantId: 'default',
              actor: { kind: 'user', id: 'stdio:local-stdio' },
            },
            {},
          ),
        ),
    ],
    ['a rejection', () => Promise.reject(new Error('person-id-1'))],
    [
      'a throw',
      () => {
        throw new Error('person-id-1');
      },
    ],
  ])('ends the call with auth when it answers %s', async (_label, resolve) => {
    const { factory, audit, logs } = setup({ resolver: resolverOf(resolve) });
    const connection = await modern.open(factory);
    const reply = await call(modern, connection, 'ct_example_echo', {});
    expect(at(reply, 'result')).toMatchObject({
      content: [{ type: 'text', text: fixedSentences.auth }],
      isError: true,
    });
    expect(audit()).toMatchObject([
      {
        tool: 'ct_example_echo',
        outcome: 'error',
        errorCode: 'auth',
        tenantId: auditPlaceholders.tenantId,
        actor: auditPlaceholders.actor,
      },
    ]);
    expect(logs()).toEqual([]);
    expect(JSON.stringify(connection.received)).not.toContain('person-id-1');
  });

  it('asks once per call, with the identity of the start', async () => {
    const identity = createStdioIdentity({
      stdioSubject: 'local-stdio',
      readOnly: true,
    });
    const real = createStdioTenantResolver();
    const resolve = vi.fn((given: unknown) =>
      real.resolve(given as typeof identity),
    );
    const { factory } = setup({ identity, resolver: resolverOf(resolve) });
    const connection = await modern.open(factory);
    await call(modern, connection, 'ct_test_context', {});
    await call(modern, connection, 'ct_test_context', {});
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve.mock.calls[0]?.[0]).toBe(identity);
    expect(resolve.mock.calls[1]?.[0]).toBe(identity);
  });
});

describe('the factory', () => {
  it('builds a new instance each time, without a side effect', () => {
    const resolve = vi.fn();
    const run = vi.fn();
    const pipeline: ToolPipeline = { call: run };
    const { factory, audit, logs } = setup({
      resolver: { resolve } as unknown as TenantResolver,
      pipeline,
    });
    const first = factory({ era: 'modern' });
    const second = factory({ era: 'legacy' });
    expect(first).toBeInstanceOf(McpServer);
    expect(second).toBeInstanceOf(McpServer);
    expect(first).not.toBe(second);
    expect(resolve).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(audit()).toEqual([]);
    expect(logs()).toEqual([]);
  });

  it('serves a client that falls back from server/discover to initialize', async () => {
    const { options } = setup();
    const factory = vi.fn(createMcpMount(options).factory);
    const connection = await connect(factory);
    await connection.request('server/discover', { _meta: modernMeta });
    await connection.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'older-client', version: '0.9.0' },
    });
    await connection.notify('notifications/initialized');
    const reply = await legacy.ask(connection, 'tools/list');
    expect(factory).toHaveBeenCalledTimes(2);
    expect(
      (at(reply, 'result', 'tools') as readonly Json[]).map(
        (tool) => tool['name'],
      ),
    ).toEqual(options.catalog.list().map((entry) => entry.name));
  });

  it('is part of a frozen mount with nothing else in it', () => {
    const { options } = setup();
    const mount = createMcpMount(options);
    expect(Object.isFrozen(mount)).toBe(true);
    expect(Object.getPrototypeOf(mount)).toBeNull();
    expect(Reflect.ownKeys(mount)).toEqual(['factory']);
  });
});

describe('the start', () => {
  it('stops when the input schema of a tool cannot be advertised', () => {
    const { options } = setup(
      {},
      [
        testTool('ct_test_date', () => ({ text: 'ok' }), {
          input: z.object({ when: z.date() }),
        }),
      ],
      false,
    );
    expect(() => createMcpMount(options)).toThrow(RegistryRefusal);
    try {
      createMcpMount(options);
    } catch (error) {
      expect(error).toMatchObject({
        reason: 'tool_input',
        plugin: 'test-plugin',
        tool: 'ct_test_date',
      });
    }
  });

  it.each(['', 'a b', '1'.repeat(33), 'vä', '1.0\n', 1])(
    'refuses the version %j',
    (version) => {
      const { options } = setup();
      expect(() =>
        createMcpMount({ ...options, version: version as string }),
      ).toThrow(new TypeError('The version of the server is invalid.'));
    },
  );

  it.each(['0.0.0', '1'.repeat(32), '1.0.0-rc.1+build.5'])(
    'accepts the version %j',
    (version) => {
      const { options } = setup();
      expect(() => createMcpMount({ ...options, version })).not.toThrow();
    },
  );
});

describe('errors', () => {
  it('answers with the fixed sentence when the pipeline rejects', async () => {
    const canary = makeCanary('name').value;
    const { factory } = setup({
      pipeline: { call: () => Promise.reject(new Error(canary)) },
    });
    const connection = await modern.open(factory);
    const reply = await call(modern, connection, 'ct_test_context', {});
    expect(at(reply, 'result')).toMatchObject({
      content: [{ type: 'text', text: fixedSentences.internal }],
      isError: true,
    });
    expect(JSON.stringify(connection.received)).not.toContain(canary);
  });

  it('writes a fixed event for an error of the instance, never its message', () => {
    const canary = makeCanary('name').value;
    const { factory, logs } = setup();
    const instance = factory({ era: 'modern' });
    if (!(instance instanceof McpServer)) throw new Error('not an McpServer');
    instance.server.onerror?.(new Error(`/srv/${canary}`));
    expect(logs()).toEqual([
      expect.objectContaining({ level: 'error', event: 'mcp_server_error' }),
    ]);
    expect(JSON.stringify(logs())).not.toContain(canary);
  });

  it('survives a logger that throws', () => {
    const fails = (): never => {
      throw new Error('the logger failed');
    };
    const logger: Logger = {
      debug: fails,
      info: fails,
      warn: fails,
      error: fails,
    };
    const { factory } = setup({ logger });
    const instance = factory({ era: 'modern' });
    if (!(instance instanceof McpServer)) throw new Error('not an McpServer');
    expect(() => instance.server.onerror?.(new Error('x'))).not.toThrow();
  });
});

describe('a cancelled call', () => {
  it('reaches the pipeline through the signal of the request', async () => {
    const { factory, audit } = setup({}, [
      testTool('ct_test_wait', () => new Promise(() => undefined)),
    ]);
    const connection = await legacy.open(factory);
    void call(legacy, connection, 'ct_test_wait', {});
    await vi.waitFor(() => {
      expect(connection.lastId()).toBe(2);
    });
    await connection.notify('notifications/cancelled', {
      requestId: connection.lastId(),
      reason: 'test',
    });
    await vi.waitFor(() => {
      expect(audit()).toMatchObject([
        { tool: 'ct_test_wait', outcome: 'error', errorCode: 'network' },
      ]);
    });
  });
});

/** A connection over the stdio transport of the SDK, line by line. */
const connectStdio = (factory: McpServerFactory) => {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk: Buffer) => {
    written += chunk.toString('utf8');
  });
  const transport: Transport = new StdioServerTransport(input, output);
  open.push(serveStdio(factory, { legacy: 'serve', transport }));
  return {
    send: (message: Json): void => {
      input.write(`${JSON.stringify(message)}\n`);
    },
    /** The complete lines written so far, each with its line break. */
    lines: (): string[] =>
      written
        .split('\n')
        .slice(0, -1)
        .map((line) => `${line}\n`),
  };
};

describe.each(eras)('the size of a result in the $name era', (era) => {
  // A text full of quotes, which cost the most on the wire, padded with
  // letters to land exactly on the limit the pipeline counts.
  const base = resultBytes({ text: '' });
  const quotes = Math.floor((maxResultBytes - base) / 6);
  const letters = (maxResultBytes - base - 6 * quotes) / 2;
  const fill = (extra: number): string =>
    '"'.repeat(quotes) + 'a'.repeat(letters + extra);

  it('counts the text at the limit exactly', () => {
    expect(resultBytes({ text: fill(0) })).toBe(maxResultBytes);
    expect(resultBytes({ text: fill(1) })).toBe(maxResultBytes + 2);
  });

  it('keeps the whole line of a result at the limit within 64 KiB', async () => {
    const { factory } = setup({}, [
      testTool(
        'ct_test_fill',
        ({ input }) => ({
          text: fill((input as { extra: number }).extra),
        }),
        {
          input: z.object({ extra: z.number().int().min(0).max(1) }),
        },
      ),
    ]);
    const stdio = connectStdio(factory);
    const meta = era.name === 'modern' ? { _meta: modernMeta } : {};
    if (era.name === 'legacy') {
      stdio.send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'older-client', version: '0.9.0' },
        },
      });
      stdio.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    }
    for (const extra of [0, 1]) {
      stdio.send({
        jsonrpc: '2.0',
        id: 10 + extra,
        method: 'tools/call',
        params: { name: 'ct_test_fill', arguments: { extra }, ...meta },
      });
    }
    const byId = (id: number): string | undefined =>
      stdio.lines().find((line) => (JSON.parse(line) as Json)['id'] === id);
    await vi.waitFor(() => {
      expect(byId(10)).toBeDefined();
      expect(byId(11)).toBeDefined();
    });
    const atLimit = byId(10) ?? '';
    expect(at(JSON.parse(atLimit), 'result', 'isError')).toBeUndefined();
    expect(at(JSON.parse(atLimit), 'result', 'structuredContent', 'text')).toBe(
      fill(0),
    );
    expect(Buffer.byteLength(atLimit)).toBeLessThanOrEqual(maxResultBytes);
    const over = JSON.parse(byId(11) ?? '') as Json;
    expect(at(over, 'result', 'isError')).toBe(true);
    expect(at(over, 'result', 'content', 0, 'text')).toContain('64 KiB');
  });
});
