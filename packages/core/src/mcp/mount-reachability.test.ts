import { loadConfig } from '@ecclium/mcp-churchtools-core';
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
} from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { Ajv } from '@modelcontextprotocol/server/validators/ajv';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAuditSink } from '../audit/index.js';
import {
  createStdioIdentity,
  createStdioTenantResolver,
} from '../identity/index.js';
import { createLogger } from '../logger/index.js';
import { createToolPipeline } from '../pipeline/index.js';
import { createToolCatalog } from '../registry/index.js';
import { createMcpMount } from './mount.js';

// The test of reachability of ADR 0059. The SDK bundles fast-uri 3.1.0
// with known advisories, and only Ajv calls it, through the object it sets
// as its default uriResolver. This test counts every call on that object
// while a client drives the mount through whole sessions of both eras with
// hostile input, and expects none. It also counts the throwing validator
// the mount gives every instance, through the fixed event it writes.
// Nothing here checks a result with Ajv: Ajv serves only to reach the
// object, and the engine that does so is built before the count starts.
//
// The counter-check runs in the 2025 era only, where elicitInput still
// asks the validator of the instance: the client declares form
// elicitation and accepts with content, and the throwing validator ends
// the question with -32603 before Ajv compiles anything.

type Json = Readonly<Record<string, unknown>>;

const loaded = loadConfig({
  environment: {
    ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
    ECCLIUM_CHURCHTOOLS_TOKEN: makeCanary('token').value,
  },
  transport: 'stdio',
});
if (!loaded.ok) throw new Error('the configuration of the test is invalid');
const token = loaded.config.churchtoolsToken;

// The object Ajv uses as uriResolver unless told otherwise: the bundled
// fast-uri, the same for every engine in the bundle.
const fastUri = new Ajv().opts.uriResolver as unknown as Record<
  string,
  unknown
>;
const fastUriFunctions = Object.keys(fastUri)
  .filter((name) => typeof fastUri[name] === 'function')
  .sort();

const open: { close(): Promise<void> }[] = [];
const spies: { readonly mock: { readonly calls: readonly unknown[] } }[] = [];
beforeEach(() => {
  for (const name of fastUriFunctions) {
    spies.push(vi.spyOn(fastUri as Record<string, () => unknown>, name));
  }
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
  spies.splice(0);
  vi.restoreAllMocks();
});

const fastUriCalls = (): number =>
  spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0);

const frozenClock = Object.freeze({ now: Object.freeze(() => 0) });

const mount = (): {
  readonly factory: McpServerFactory;
  readonly instances: McpServer[];
  readonly events: () => readonly string[];
  readonly audited: () => number;
} => {
  const double = createChurchToolsDouble({ token });
  open.push(double);
  const logLines: string[] = [];
  const writer = Object.freeze({
    write: (line: string): boolean => {
      logLines.push(line);
      return true;
    },
  });
  const catalog = createToolCatalog({
    core: examplePlugin,
    plugins: [],
    readOnly: true,
    toolsets: new Set(['wiki'] as const),
  });
  const pipeline = createToolPipeline({
    catalog,
    audit: createAuditSink({
      writer,
      clock: frozenClock,
      isKnownTool: catalog.has,
    }),
    transport: double.transport,
    origin: doubleOrigin,
    requestsPerMinute: 300,
    clock: frozenClock,
    logging: { writer, minLevel: 'debug' },
  });
  const built = createMcpMount({
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
    logger: createLogger({ writer, clock: frozenClock, minLevel: 'debug' }),
    version: '0.0.0',
  });
  const instances: McpServer[] = [];
  const factory: McpServerFactory = (context) => {
    const instance = built.factory(context);
    if (instance instanceof McpServer) instances.push(instance);
    return instance;
  };
  return {
    factory,
    instances,
    events: () =>
      logLines
        .map((line) => (JSON.parse(line) as Json)['event'])
        .filter((event): event is string => typeof event === 'string'),
    audited: () =>
      logLines.filter(
        (line) => (JSON.parse(line) as Json)['type'] === 'tool_call',
      ).length,
  };
};

interface Client {
  /** Sends a message; a request resolves with its response, else undefined. */
  readonly send: (message: Json) => Promise<Json | undefined>;
  /** Every message the client received. */
  readonly received: readonly Json[];
}

/** A client in raw JSON-RPC; it answers each request of the server. */
const connect = async (
  factory: McpServerFactory,
  answer: (request: Json) => Json = () => ({}),
): Promise<Client> => {
  const [client, wire] = InMemoryTransport.createLinkedPair();
  const pending = new Map<unknown, (reply: Json) => void>();
  const received: Json[] = [];
  client.onmessage = (raw) => {
    const message = JSON.parse(JSON.stringify(raw)) as Json;
    received.push(message);
    const id = message['id'];
    if (typeof message['method'] === 'string' && id !== undefined) {
      void client.send({
        jsonrpc: '2.0',
        id,
        result: answer(message),
      } as unknown as JSONRPCMessage);
    } else if (id !== undefined) {
      pending.get(id)?.(message);
      pending.delete(id);
    }
  };
  await client.start();
  open.push(serveStdio(factory, { legacy: 'serve', transport: wire }));
  return {
    send: async (message) => {
      const id = message['id'];
      const reply =
        typeof message['method'] === 'string' && id !== undefined
          ? new Promise<Json>((resolve) => pending.set(id, resolve))
          : undefined;
      await client.send(message as unknown as JSONRPCMessage);
      return reply;
    },
    received,
  };
};

// Values that look like what fast-uri would parse: references, ids,
// schemas, encoded dots, a host in brackets and a port out of range.
const uris = [
  'http://example.org/schema#/$defs/a',
  'urn:uuid:00000000-0000-0000-0000-000000000000',
  'https://json-schema.org/draft/2020-12/schema',
  'http://[v1.example]:99999/%2e%2e/%2E%2E/a',
  'http://example.org@example.org:0/../a',
  '#/definitions/a',
];

const hostileArguments: readonly unknown[] = [
  { $ref: uris[0], $id: uris[1], $schema: uris[2] },
  { notes: uris, email: uris[3] },
  { $defs: { a: { $ref: '#/$defs/a' } }, $dynamicRef: '#a' },
  JSON.parse('{"__proto__": {"$ref": "#"}, "constructor": {"$id": "x"}}'),
  { notes: [JSON.stringify({ $ref: uris[4], format: 'uri' })] },
];

/** Calls that reach the mount, and calls the SDK refuses before it. */
const hostileCalls = (meta: Json): Json[] => [
  ...['ct_example_echo', 'ct_example_profile', ...uris].flatMap((name) =>
    hostileArguments.map((args) => ({ name, arguments: args, ...meta })),
  ),
  { name: 'ct_example_echo', arguments: uris, ...meta },
  { name: uris[0], arguments: { $ref: uris[0] }, ...meta },
  { name: 1, arguments: { $id: uris[1] }, ...meta },
  {
    name: 'ct_example_echo',
    arguments: {},
    requestState: uris[0],
    inputResponses: {
      a: { action: 'accept', content: { $ref: uris[0], $id: uris[1] } },
    },
    ...meta,
  },
];

const otherRequests: readonly (readonly [string, Json])[] = [
  ['tools/list', { cursor: uris[0] }],
  ['resources/read', { uri: uris[3] }],
  ['resources/list', {}],
  ['prompts/get', { name: uris[0] }],
  ['completion/complete', { ref: { type: 'ref/resource', uri: uris[0] } }],
  ['logging/setLevel', { level: 'debug' }],
  ['ping', {}],
];

/** Drives one session: every hostile call and request, one by one. */
const drive = async (client: Client, meta: Json, from: number) => {
  let id = from;
  for (const params of hostileCalls(meta)) {
    id += 1;
    await client.send({ jsonrpc: '2.0', id, method: 'tools/call', params });
  }
  for (const [method, params] of otherRequests) {
    id += 1;
    await client.send({
      jsonrpc: '2.0',
      id,
      method,
      params: { ...params, ...meta },
    });
  }
  // A response to a request the server never sent, and a notification
  // nobody expects.
  await client.send({
    jsonrpc: '2.0',
    id: uris[0],
    result: { action: 'accept', content: { $ref: uris[0] } },
  });
  await client.send({
    jsonrpc: '2.0',
    method: 'notifications/roots/list_changed',
    params: { $ref: uris[0] },
  });
  // The entry handles messages in order, so the answer to this request
  // comes after everything before it.
  await client.send({
    jsonrpc: '2.0',
    id: id + 1,
    method: 'tools/list',
    params: meta,
  });
};

const modernMeta: Json = {
  _meta: {
    [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
    [CLIENT_INFO_META_KEY]: { name: uris[0], version: uris[1] },
    [CLIENT_CAPABILITIES_META_KEY]: {
      elicitation: { form: {}, url: {} },
      sampling: {},
      roots: { listChanged: true },
    },
  },
};

describe('the counter', () => {
  it('watches the functions of fast-uri', () => {
    expect(fastUriFunctions).toEqual([
      'equal',
      'normalize',
      'parse',
      'resolve',
      'resolveComponent',
      'serialize',
    ]);
  });

  it('sees fast-uri when Ajv builds an engine', () => {
    expect(fastUriCalls()).toBe(0);
    expect(new Ajv().opts.uriResolver).toBe(fastUri);
    expect(fastUriCalls()).toBeGreaterThan(0);
  });
});

describe('a whole session with hostile input', () => {
  it('never reaches fast-uri or the validator in the 2026 era', async () => {
    const { factory, events, instances, audited } = mount();
    const client = await connect(factory, () => ({
      action: 'accept',
      content: { $ref: uris[0] },
    }));
    await client.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
      params: modernMeta,
    });
    await drive(client, modernMeta, 1);
    expect(instances.length).toBeGreaterThan(0);
    expect(audited()).toBeGreaterThanOrEqual(40);
    expect(client.received.length).toBeGreaterThan(50);
    expect(fastUriCalls()).toBe(0);
    expect(events()).not.toContain('mcp_validator_refused');
  });

  it('never reaches fast-uri or the validator in the 2025 era', async () => {
    const { factory, events, instances, audited } = mount();
    const client = await connect(factory, () => ({
      action: 'accept',
      content: { $ref: uris[0] },
    }));
    await client.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {
          elicitation: { form: {}, url: {} },
          sampling: {},
          roots: { listChanged: true },
        },
        clientInfo: { name: uris[0], version: uris[1] },
      },
    });
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await drive(client, {}, 1);
    expect(instances).toHaveLength(1);
    expect(audited()).toBeGreaterThanOrEqual(40);
    expect(client.received.length).toBeGreaterThan(50);
    expect(fastUriCalls()).toBe(0);
    expect(events()).not.toContain('mcp_validator_refused');
  });
});

describe('the counter-check in the 2025 era', () => {
  it('ends elicitInput at the throwing validator with -32603, before Ajv', async () => {
    const { factory, events, instances } = mount();
    const client = await connect(factory, (request) =>
      request['method'] === 'elicitation/create'
        ? { action: 'accept', content: { name: 'Person A' } }
        : {},
    );
    await client.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: { elicitation: { form: {} } },
        clientInfo: { name: 'older-client', version: '0.9.0' },
      },
    });
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const [instance] = instances;
    if (instance === undefined) throw new Error('no instance was built');
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- the counter-check of ADR 0059 calls the deprecated elicitInput on purpose
    const question = instance.server.elicitInput({
      mode: 'form',
      message: 'A question of the test.',
      requestedSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    });
    await expect(question).rejects.toMatchObject({ code: -32603 });
    expect(
      client.received.filter(
        (message) => message['method'] === 'elicitation/create',
      ),
    ).toHaveLength(1);
    expect(
      events().filter((event) => event === 'mcp_validator_refused'),
    ).toEqual(['mcp_validator_refused']);
    expect(fastUriCalls()).toBe(0);
  });
});
