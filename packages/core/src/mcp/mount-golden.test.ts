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
  type McpServerFactory,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createAuditSink } from '../audit/index.js';
import {
  createStdioIdentity,
  createStdioTenantResolver,
} from '../identity/index.js';
import { createLogger } from '../logger/index.js';
import { createToolPipeline } from '../pipeline/index.js';
import { type CatalogEntry, createToolCatalog } from '../registry/index.js';
import { createMcpMount } from './mount.js';
import { deriveOutputSchema } from './schema.js';

// The golden test of the output schema (ADR 0059). In operation nobody
// checks a result against the schema the mount advertises: the mount
// answers tools/call itself, and the SDK checks only the form of a result.
// This test does it with the Ajv of the SDK, which only tests may use: a
// masked result with the data envelope, as a client receives it, fits the
// advertised schema, and the same result breaks the schema of the tool.

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

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
});

const frozenClock = Object.freeze({ now: Object.freeze(() => 0) });
const silent = Object.freeze({ write: (): boolean => true });

const mount = (): {
  readonly factory: McpServerFactory;
  readonly echo: CatalogEntry;
} => {
  const double = createChurchToolsDouble({ token });
  open.push(double);
  const catalog = createToolCatalog({
    core: examplePlugin,
    plugins: [],
    readOnly: true,
  });
  const pipeline = createToolPipeline({
    catalog,
    audit: createAuditSink({
      writer: silent,
      clock: frozenClock,
      isKnownTool: catalog.has,
    }),
    transport: double.transport,
    origin: doubleOrigin,
    requestsPerMinute: 300,
    clock: frozenClock,
    logging: { writer: silent, minLevel: 'debug' },
  });
  const echo = catalog.get('ct_example_echo');
  if (echo === undefined) throw new Error('the example plugin lacks its echo');
  const { factory } = createMcpMount({
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
      writer: silent,
      clock: frozenClock,
      minLevel: 'debug',
    }),
    version: '0.0.0',
  });
  return { factory, echo };
};

/** Sends requests in the 2026 era and gives back each response as JSON. */
const connect = async (
  factory: McpServerFactory,
): Promise<(method: string, params: Json) => Promise<Json>> => {
  const [client, wire] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (reply: Json) => void>();
  let lastId = 0;
  client.onmessage = (raw) => {
    const message = JSON.parse(JSON.stringify(raw)) as Json;
    const id = message['id'];
    if (typeof id === 'number') {
      pending.get(id)?.(message);
      pending.delete(id);
    }
  };
  await client.start();
  open.push(serveStdio(factory, { legacy: 'serve', transport: wire }));
  return async (method, params) => {
    lastId += 1;
    const id = lastId;
    const reply = new Promise<Json>((resolve) => pending.set(id, resolve));
    await client.send({
      jsonrpc: '2.0',
      id,
      method,
      params: {
        ...params,
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
          [CLIENT_INFO_META_KEY]: { name: 'test-client', version: '1.0.0' },
          [CLIENT_CAPABILITIES_META_KEY]: {},
        },
      },
    } as unknown as JSONRPCMessage);
    return reply;
  };
};

const result = (reply: Json): Json => {
  const value = reply['result'];
  if (typeof value !== 'object' || value === null) {
    throw new Error('the reply has no result');
  }
  return value as Json;
};

// Every class the echo knows, and a note exactly as long as the tool
// allows: the envelope makes it longer.
const input = {
  email: 'max.mustermann@example.org',
  phone: '+41 00 123 45 67',
  birthdate: '2000-01-01',
  notes: ['Person A', 'x'.repeat(2000)],
};

const validate = (schema: unknown, value: unknown): boolean =>
  new AjvJsonSchemaValidator().getValidator(schema as Json)(value).valid;

describe('the output schema the mount advertises', () => {
  it('fits a masked result with the data envelope, as the client receives it', async () => {
    const { factory, echo } = mount();
    const send = await connect(factory);
    const tools = result(await send('tools/list', {}))['tools'] as Json[];
    const advertised = tools.find(
      (tool) => tool['name'] === 'ct_example_echo',
    )?.['outputSchema'];
    expect(advertised).toEqual(
      JSON.parse(JSON.stringify(deriveOutputSchema(echo.shape))),
    );
    const call = result(
      await send('tools/call', { name: 'ct_example_echo', arguments: input }),
    );
    expect(call['isError']).toBeUndefined();
    const data = call['structuredContent'] as Json;
    expect(data['email']).not.toBe(input.email);
    expect(data['notes']).toHaveLength(2);
    expect((data['notes'] as string[])[1]?.length).toBeGreaterThan(2000);
    expect(validate(advertised, data)).toBe(true);
  });

  it('breaks the schema of the tool with the same result, the counter-check', async () => {
    const { factory, echo } = mount();
    const send = await connect(factory);
    const call = result(
      await send('tools/call', { name: 'ct_example_echo', arguments: input }),
    );
    const ownSchema = z.toJSONSchema(echo.output, {
      target: 'draft-2020-12',
      io: 'output',
    });
    // The unmasked input fits the schema of the tool, so the schema itself
    // is sound, and so does the result without the long note: only the
    // envelope around that note makes the result break it.
    const data = call['structuredContent'] as Json;
    const notes = data['notes'] as readonly string[];
    expect(validate(ownSchema, input)).toBe(true);
    expect(validate(ownSchema, { ...data, notes: notes.slice(0, 1) })).toBe(
      true,
    );
    expect(validate(ownSchema, data)).toBe(false);
  });
});
