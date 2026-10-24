import { loadConfig } from '@ecclium/mcp-churchtools-core';
import type {
  TenantAssignment,
  TenantId,
  TenantResolver,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  assertNoCanary,
  assertPlanted,
  type CanarySet,
  createChurchToolsDouble,
  doubleOrigin,
  examplePlugin,
  makeCanaries,
  makeControlValue,
  type MockedHttpTransport,
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
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAuditSink } from '../audit/index.js';
import { createStdioIdentity } from '../identity/index.js';
import { createLogger, type LineWriter } from '../logger/index.js';
import { createToolPipeline } from '../pipeline/index.js';
import { createToolCatalog } from '../registry/index.js';
import { createMcpMount } from './mount.js';

// Two ChurchTools instances served side by side in one process, as the
// server over HTTP will serve several tenants (ADR 0003): a double, a
// pipeline, a resolver and a mount for each, and one writer for every line,
// as on stderr. The catalog and the audit sink are shared, like everything
// the process holds once. No result, token or line of one tenant may reach
// the other. The example profile tool of testkit stands in for the tools
// of the core, which core cannot import; requests go through the real
// transport on the doubles, which connect nowhere. The tenant comes only
// from the resolver of each mount, the ID of a test run from
// makeControlValue.

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

const otherOrigin = 'https://other.example';

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
});

const frozenClock = Object.freeze({ now: Object.freeze(() => 0) });

const whoamiPath = '/api/whoami?only_allow_authenticated=true';
const json = { headers: { 'content-type': 'application/json' } };

const modernMeta: Json = {
  [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
  [CLIENT_INFO_META_KEY]: { name: 'test-client', version: '1.0.0' },
  [CLIENT_CAPABILITIES_META_KEY]: {},
};

const parsed = (lines: readonly string[]): readonly Json[] =>
  lines.map((line) => JSON.parse(line) as Json);

// An audit line carries the version of its schema, a log line never does.
const kind = (line: Json): unknown =>
  line['v'] === undefined ? line['event'] : 'audit';

/** One connection of a client, in the 2026 era. */
interface Connection {
  /** Calls the profile tool and resolves with the response. */
  readonly call: (id: number) => Promise<Json>;
}

const connect = async (factory: McpServerFactory): Promise<Connection> => {
  const [client, wire] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (reply: Json) => void>();
  client.onmessage = (raw) => {
    // As on the wire, every message goes through JSON first.
    const message = JSON.parse(JSON.stringify(raw)) as Json;
    const id = message['id'];
    if (typeof id === 'number' && message['method'] === undefined) {
      pending.get(id)?.(message);
      pending.delete(id);
    }
  };
  await client.start();
  open.push(serveStdio(factory, { legacy: 'serve', transport: wire }));
  return {
    call: async (id) => {
      const reply = new Promise<Json>((resolve) => pending.set(id, resolve));
      await client.send({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: {
          name: 'ct_example_profile',
          arguments: {},
          _meta: modernMeta,
        },
      } as unknown as JSONRPCMessage);
      return reply;
    },
  };
};

/** One tenant with its instance, as the test serves it. */
interface Tenant {
  /** The tenant, a control value of the run. */
  readonly id: string;
  /** The origin of its instance. */
  readonly origin: string;
  /** The ID of the account its instance answers with. */
  readonly person: number;
  /** Its token and the name and e-mail address of its account. */
  readonly canary: CanarySet;
  /** The double of its instance. */
  readonly double: MockedHttpTransport;
  /** A connection of a client to its mount. */
  readonly connection: Connection;
}

const setup = async (requestsPerMinute: number) => {
  const written: string[] = [];
  const writer: LineWriter = Object.freeze({
    write: (line: string): boolean => {
      written.push(line);
      return true;
    },
  });
  const catalog = createToolCatalog({
    core: examplePlugin,
    plugins: [],
    readOnly: true,
    toolsets: new Set(['wiki'] as const),
  });
  const audit = createAuditSink({
    writer,
    clock: frozenClock,
    isKnownTool: catalog.has,
  });

  const tenant = async (origin: string, person: number): Promise<Tenant> => {
    const canary = makeCanaries();
    const id = makeControlValue();
    const loaded = loadConfig({
      environment: {
        ECCLIUM_CHURCHTOOLS_URL: origin,
        ECCLIUM_CHURCHTOOLS_TOKEN: canary.token.value,
      },
      transport: 'stdio',
    });
    if (!loaded.ok) throw new Error('the configuration of the test is invalid');
    const { config } = loaded;
    // Bound to the tenant of the instance, as the composition root binds
    // the logger of a transport, so the lines of the transport show where
    // a call really went.
    const logger = createLogger({
      writer,
      clock: frozenClock,
      minLevel: 'debug',
      bound: { tenantId: id as TenantId },
    });
    const double = createChurchToolsDouble({
      token: config.churchtoolsToken,
      origin: config.churchtoolsOrigin,
      logger,
      clock: frozenClock,
    });
    open.push(double);
    const pipeline = createToolPipeline({
      catalog,
      audit,
      transport: double.transport,
      origin: config.churchtoolsOrigin,
      requestsPerMinute,
      clock: frozenClock,
      logging: { writer, minLevel: 'debug' },
    });
    const resolver: TenantResolver = Object.freeze({
      resolve: () =>
        Promise.resolve({
          tenantId: id,
          actor: { kind: 'user', id: 'stdio:local-stdio' },
        } as unknown as TenantAssignment),
    });
    const mount = createMcpMount({
      catalog,
      pipeline,
      identity: createStdioIdentity({
        stdioSubject: 'local-stdio',
        readOnly: true,
      }),
      resolver,
      mode: 'interactive',
      redaction: 'standard',
      readOnly: true,
      logger,
      version: '0.0.0',
    });
    return {
      id,
      origin: config.churchtoolsOrigin,
      person,
      canary,
      double,
      connection: await connect(mount.factory),
    };
  };

  return {
    a: await tenant(doubleOrigin, 101),
    b: await tenant(otherOrigin, 202),
    written,
  };
};

/** The answer of whoami with the account of the tenant. */
const account = (tenant: Tenant): string =>
  JSON.stringify({
    data: {
      id: tenant.person,
      guid: `00000000-0000-0000-0000-${String(tenant.person).padStart(12, '0')}`,
      firstName: tenant.canary.name.cores[0],
      lastName: tenant.canary.name.cores[1],
      email: tenant.canary.email.value,
    },
  });

/**
 * Lets the double of the tenant answer whoami once, but only when the test
 * releases the answer.
 */
const hold = (tenant: Tenant): (() => void) => {
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  tenant.double
    .intercept({ path: whoamiPath, method: 'GET' })
    .reply(async () => {
      await released;
      return { statusCode: 200, data: account(tenant), responseOptions: json };
    });
  return () => {
    release();
  };
};

describe('two tenants in one process', () => {
  it('keep results, tokens and lines apart while their calls run at the same time', async () => {
    const { a, b, written } = await setup(300);
    const answers = new Map([
      [a, [hold(a), hold(a)]],
      [b, [hold(b), hold(b)]],
    ]);
    let settled = 0;
    const calls = (
      [
        [a, 1],
        [b, 1],
        [a, 2],
        [b, 2],
      ] as const
    ).map(([tenant, id]) =>
      tenant.connection.call(id).then((reply) => {
        settled += 1;
        return { tenant, reply };
      }),
    );

    // All four calls have their context and wait for ChurchTools at once.
    await vi.waitFor(() => {
      expect(a.double.calls()).toHaveLength(2);
      expect(b.double.calls()).toHaveLength(2);
    });
    expect(written).toEqual([]);

    // The answers come back one at a time, from one tenant and then the
    // other, so the lines of each call stand together: the line of the
    // transport, bound to the instance, then the audit line and the log
    // line, whose tenant comes from the resolver.
    for (const [index, tenant] of [a, b, a, b].entries()) {
      const start = written.length;
      answers.get(tenant)?.shift()?.();
      await vi.waitFor(() => {
        expect(settled).toBe(index + 1);
      });
      const lines = parsed(written.slice(start));
      expect(lines.map(kind)).toEqual(['http_response', 'audit', 'tool_call']);
      expect(lines.map((line) => line['tenantId'])).toEqual([
        tenant.id,
        tenant.id,
        tenant.id,
      ]);
    }

    // Each result carries the account of its own instance, the e-mail
    // address masked, and nothing of the other tenant.
    for (const { tenant, reply } of await Promise.all(calls)) {
      const other = tenant === a ? b : a;
      expect(at(reply, 'result', 'structuredContent')).toEqual({
        id: tenant.person,
        firstName: tenant.canary.name.cores[0],
        lastName: tenant.canary.name.cores[1],
        email: `${tenant.canary.email.value.charAt(0)}***@example.org`,
      });
      assertNoCanary(reply, other.canary.all, 'result');
    }

    // Each double saw only the token of its own tenant.
    for (const [tenant, other] of [
      [a, b],
      [b, a],
    ] as const) {
      assertPlanted(tenant.double.calls(), [tenant.canary.token], 'request');
      assertNoCanary(tenant.double.calls(), [other.canary.token], 'request');
    }

    // Exactly two audit lines for each tenant, and no value of either in
    // any line.
    const audits = parsed(written).filter((line) => kind(line) === 'audit');
    for (const tenant of [a, b]) {
      expect(audits.filter((line) => line['tenantId'] === tenant.id)).toEqual([
        expect.objectContaining({
          tool: 'ct_example_profile',
          mode: 'interactive',
          outcome: 'ok',
        }),
        expect.objectContaining({
          tool: 'ct_example_profile',
          mode: 'interactive',
          outcome: 'ok',
        }),
      ]);
    }
    expect(audits).toHaveLength(4);
    assertNoCanary(
      written,
      [...a.canary.all, ...b.canary.all],
      'audit and log',
    );
  });

  it('throttle each instance on its own', async () => {
    // A rate of 6 per minute holds one request, and the clock stands still,
    // so the second call of a tenant finds its bucket empty.
    const { a, b, written } = await setup(6);
    for (const tenant of [a, b]) {
      tenant.double
        .intercept({ path: whoamiPath, method: 'GET' })
        .reply(200, account(tenant), json);
    }
    for (const [tenant, id, errorCode] of [
      [a, 1, undefined],
      [a, 2, 'rate_limited'],
      [b, 1, undefined],
      [b, 2, 'rate_limited'],
    ] as const) {
      const start = written.length;
      const reply = await tenant.connection.call(id);
      expect(at(reply, 'result', 'isError')).toBe(
        errorCode === undefined ? undefined : true,
      );
      // Every line of the call carries the tenant of the mount it came
      // through, the line of the transport included.
      const lines = parsed(written.slice(start));
      expect(lines.length).toBeGreaterThan(1);
      expect(lines.filter((line) => line['tenantId'] !== tenant.id)).toEqual(
        [],
      );
      expect(lines.filter((line) => kind(line) === 'audit')).toEqual([
        expect.objectContaining(
          errorCode === undefined
            ? { outcome: 'ok' }
            : { outcome: 'error', errorCode },
        ),
      ]);
    }
    expect(a.double.calls()).toHaveLength(1);
    expect(b.double.calls()).toHaveLength(1);
  });

  it('refuse in the transport of one instance an address of the other, before any request', async () => {
    const { a, b, written } = await setup(300);
    for (const [tenant, other] of [
      [a, b],
      [b, a],
    ] as const) {
      await expect(
        tenant.double.transport.get(new URL('/api/whoami', other.origin), {
          maxResponseBytes: 1024,
        }),
      ).rejects.toMatchObject({ category: 'refused', code: 'internal' });
    }
    expect(a.double.calls()).toEqual([]);
    expect(b.double.calls()).toEqual([]);
    expect(parsed(written)).toEqual([
      expect.objectContaining({ event: 'http_refused', tenantId: a.id }),
      expect.objectContaining({ event: 'http_refused', tenantId: b.id }),
    ]);
  });
});
