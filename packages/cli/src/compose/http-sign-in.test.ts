import { Buffer } from 'node:buffer';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createBearerSignIn,
  createBearerTenantResolver,
  createBearerToken,
  hashBearerToken,
  loadConfig,
  readBearerLastUse,
  serializeBearerTokens,
} from '@ecclium/mcp-churchtools-core';
import {
  createLogger,
  createStderrWriter,
} from '@ecclium/mcp-churchtools-core/composition';
import {
  createHttpApp,
  type HttpApp,
  mcpPath,
} from '@ecclium/mcp-churchtools-server/http';
import {
  createChurchToolsDouble,
  createMemoryQuotaStore,
  doubleOrigin,
  makeCanaries,
  type MockedHttpTransport,
} from '@ecclium/mcp-churchtools-testkit';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { createStdioCatalog } from '../stdio/catalog.js';
import { composeToolPipeline } from './pipeline.js';

// The sign-in with static bearer tokens end to end in process (ADR 0074):
// the check of the core against a real file of tokens, the resolver of
// the tokens, the pipeline as the composition root builds it, with its
// audit sink and the real logger, and the server over HTTP, without a
// socket. The double of ChurchTools connects nowhere. The clock is fixed,
// and every token comes into being at run time.

type Json = Readonly<Record<string, unknown>>;

const now = Date.UTC(2026, 10, 26, 12);
const clock = Object.freeze({ now: Object.freeze(() => now) });
const canary = makeCanaries();

const folder = mkdtempSync(join(tmpdir(), 'ecclium-http-sign-in-'));
afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

const reader = createBearerToken();
const writer = createBearerToken();
const tokensFile = join(folder, 'http-tokens.yaml');
writeFileSync(
  tokensFile,
  serializeBearerTokens([
    {
      name: 'reader',
      sha256: hashBearerToken(reader),
      scopes: ['read'],
      createdAt: '2026-11-26',
      expiresAt: '2027-05-25',
    },
    {
      name: 'writer',
      sha256: hashBearerToken(writer),
      scopes: ['read', 'write'],
      createdAt: '2026-11-26',
      expiresAt: '2027-05-25',
    },
  ]),
  { mode: 0o600 },
);
chmodSync(tokensFile, 0o600);

const loaded = loadConfig({
  environment: {
    ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
    ECCLIUM_CHURCHTOOLS_TOKEN: canary.token.value,
  },
  transport: 'stdio',
});
if (!loaded.ok) throw new Error('the configuration of the test is invalid');
const config = loaded.config;

// The catalog of a server that may write to the wiki: the gate and the
// list of tools are the subject here, not the write itself.
const catalog = createStdioCatalog({ readOnly: false, toolsets: ['wiki'] });
const writeTools = catalog
  .list()
  .filter((entry) => entry.meta.capability === 'write')
  .map((entry) => entry.name);
const writeTool = 'ct_wiki_page_append_section';

const doubles: MockedHttpTransport[] = [];
const apps: HttpApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    doubles.splice(0).map((double) => double.close().catch(() => undefined)),
  );
});

const setup = (file = tokensFile) => {
  // Every line of the process, the copy of the audit and the log alike.
  const lines: string[] = [];
  const stderr = createStderrWriter({
    writeSync: (_fd, buffer, offset, length) => {
      lines.push(
        Buffer.from(buffer)
          .subarray(offset, offset + length)
          .toString('utf8'),
      );
      return length;
    },
  });
  const composed = composeToolPipeline({
    config,
    catalog,
    writer: stderr,
    clock,
    createTransport: (options) => {
      const double = createChurchToolsDouble({
        token: options.token,
        origin: options.origin,
      });
      doubles.push(double);
      return double.transport;
    },
  });
  const logger = createLogger({ writer: stderr, clock, minLevel: 'debug' });
  const store = createMemoryQuotaStore();
  const signIn = createBearerSignIn({
    tokensFile: file,
    clock,
    lastUse: { store, logger },
  });
  const app = createHttpApp({
    catalog,
    pipeline: composed.pipeline,
    authenticate: (request) => signIn(request.headers.get('authorization')),
    resolver: createBearerTenantResolver(),
    mode: 'interactive',
    redaction: config.redaction,
    readOnly: false,
    logger,
    version: '0.0.0',
  });
  apps.push(app);
  const parsed = (): readonly Json[] =>
    lines
      .join('')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Json);
  return {
    app,
    store,
    audit: () => parsed().filter((line) => line['type'] === 'tool_call'),
    events: () =>
      parsed()
        .filter((line) => line['type'] === undefined)
        .map((line) => line['event']),
    logLines: () => parsed().filter((line) => line['type'] === undefined),
    calls: () => doubles.flatMap((double) => double.calls()),
    text: () => lines.join(''),
  };
};

// A body of JSON-RPC with the token and the headers given, on the path of
// MCP with the query given.
const post = (
  app: HttpApp,
  token: string | undefined,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
  query = '',
): Promise<Response> =>
  app.fetch(
    new Request(`http://127.0.0.1:8765${mcpPath}${query}`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:8765',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...headers,
      },
      body: JSON.stringify(body),
    }),
    { localPort: 8765 },
  );

// A request of the 2025 era, as claude.ai sends it, without a session.
const ask = (
  app: HttpApp,
  token: string | undefined,
  method: string,
  params: Json = {},
  headers: Readonly<Record<string, string>> = {},
  query = '',
): Promise<Response> =>
  post(
    app,
    token,
    { jsonrpc: '2.0', id: 7, method, params },
    { 'mcp-protocol-version': '2025-11-25', ...headers },
    query,
  );

// A request of the 2026 era, with the envelope of the protocol in _meta.
// The keys are those of the protocol, written out, since this package
// does not import the SDK.
const envelope = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': {
    name: 'test-client',
    version: '1.0.0',
  },
  'io.modelcontextprotocol/clientCapabilities': {},
};
const askModern = (
  app: HttpApp,
  token: string | undefined,
  name: string,
  meta: Json = {},
): Promise<Response> =>
  post(
    app,
    token,
    {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name, arguments: {}, _meta: { ...envelope, ...meta } },
    },
    {
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': name,
    },
  );

const toolNames = async (response: Response): Promise<readonly unknown[]> => {
  const body = (await response.json()) as {
    result: { tools: readonly Json[] };
  };
  return body.result.tools.map((tool) => tool['name']);
};

describe('the sign-in with a bearer token over HTTP, end to end', () => {
  it('holds write tools in the catalog of the test', () => {
    expect(writeTools).toContain(writeTool);
  });

  it('lists no write tool to a token with the scope read, and all of them to one with write', async () => {
    const { app } = setup();
    const read = await toolNames(await ask(app, reader, 'tools/list'));
    const write = await toolNames(await ask(app, writer, 'tools/list'));
    for (const name of writeTools) {
      expect(read).not.toContain(name);
      expect(write).toContain(name);
    }
    expect(read.length).toBeGreaterThan(0);
  });

  it('answers a write tool of a token with read with 403, and the audit holds the refused call of its actor', async () => {
    const { app, audit, events, calls, text } = setup();
    const response = await ask(
      app,
      reader,
      'tools/call',
      {
        name: writeTool,
        arguments: {},
        _meta: { scopes: ['read', 'write'], tenantId: 'second-tenant' },
      },
      // Neither a header, nor the query, nor _meta names another tenant,
      // mode or scope that counts.
      {
        'x-tenant-id': 'second-tenant',
        'x-ecclium-mode': 'operator',
        'x-ecclium-scopes': 'read write',
      },
      '?scope=write&tenant=second-tenant&mode=operator',
    );
    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toBe(
      'Bearer realm="ecclium", error="insufficient_scope", scope="write"',
    );
    expect(((await response.json()) as Json)['id']).toBe(7);
    expect(audit()).toEqual([
      expect.objectContaining({
        type: 'tool_call',
        tenantId: 'default',
        actor: { kind: 'user', id: 'bearer:reader' },
        mode: 'interactive',
        tool: writeTool,
        outcome: 'denied',
        errorCode: 'permission',
        writeState: 'denied',
      }),
    ]);
    expect(events()).toContain('http_scope_refused');
    // Nothing reached ChurchTools, and no line names a token.
    expect(calls()).toEqual([]);
    expect(text()).not.toContain(reader);
    expect(text()).not.toContain(canary.token.value);
  });

  it('counter-check: lets the same call of a token with write pass the gate, to the check of the audit file behind it', async () => {
    const { app, audit } = setup();
    const response = await ask(app, writer, 'tools/call', {
      name: writeTool,
      arguments: {},
    });
    expect(response.status).toBe(200);
    // Without a folder of state the gate refuses every write tool after
    // the check of the scope, as policy_denied (ADR 0028).
    expect(audit()).toEqual([
      expect.objectContaining({
        actor: { kind: 'user', id: 'bearer:writer' },
        tool: writeTool,
        outcome: 'denied',
        errorCode: 'policy_denied',
      }),
    ]);
  });

  it('answers a write tool of a token with read with 403 in the 2026 era too, also beside a read in a list of messages', async () => {
    const { app, audit, calls } = setup();
    const modern = await askModern(app, reader, writeTool, {
      scopes: ['read', 'write'],
    });
    expect(modern.status).toBe(403);
    expect(((await modern.json()) as Json)['id']).toBe(8);
    const listed = await post(
      app,
      reader,
      [
        { jsonrpc: '2.0', id: 9, method: 'tools/list' },
        {
          jsonrpc: '2.0',
          id: 10,
          method: 'tools/call',
          params: { name: writeTool, arguments: {} },
        },
      ],
      { 'mcp-protocol-version': '2025-11-25' },
    );
    expect(listed.status).toBe(403);
    expect(listed.headers.get('www-authenticate')).toBe(
      'Bearer realm="ecclium", error="insufficient_scope", scope="write"',
    );
    // A list is no message of the protocol: its id is null.
    expect(((await listed.json()) as Json)['id']).toBeNull();
    // The call of the 2026 era is the one audited; nothing reached
    // ChurchTools.
    expect(audit()[0]).toMatchObject({
      actor: { kind: 'user', id: 'bearer:reader' },
      errorCode: 'permission',
    });
    expect(audit().every((line) => line['errorCode'] === 'permission')).toBe(
      true,
    );
    expect(calls()).toEqual([]);
  });

  it('refuses a token from the request after its revoke, and every token while the file is broken', async () => {
    const own = join(folder, 'own-tokens.yaml');
    const token = createBearerToken();
    const entry = {
      name: 'reader',
      sha256: hashBearerToken(token),
      scopes: ['read'] as const,
      createdAt: '2026-11-26',
      expiresAt: '2027-05-25',
    };
    writeFileSync(own, serializeBearerTokens([entry]), { mode: 0o600 });
    chmodSync(own, 0o600);
    const { app, logLines } = setup(own);
    expect((await ask(app, token, 'tools/list')).status).toBe(200);
    writeFileSync(own, serializeBearerTokens([]));
    const revoked = await ask(app, token, 'tools/list');
    writeFileSync(own, 'version: [\n');
    const broken = await ask(app, token, 'tools/list');
    writeFileSync(own, serializeBearerTokens([entry]));
    const again = await ask(app, token, 'tools/list');
    expect([revoked.status, broken.status, again.status]).toEqual([
      401, 401, 200,
    ]);
    expect(revoked.headers.get('www-authenticate')).toBe(
      'Bearer realm="ecclium", error="invalid_token"',
    );
    expect(
      logLines()
        .filter((line) => line['event'] === 'http_auth_refused')
        .map((line) => line['reason']),
    ).toEqual(['unknown', 'tokens_file']);
  });

  it('refuses a request without a token and one with an unknown token with 401, and the real logger keeps the reason', async () => {
    const { app, logLines, audit } = setup();
    const missing = await ask(app, undefined, 'tools/list');
    const unknown = await ask(app, createBearerToken(), 'tools/list');
    expect([missing.status, unknown.status]).toEqual([401, 401]);
    expect(missing.headers.get('www-authenticate')).toBe(
      'Bearer realm="ecclium"',
    );
    expect(unknown.headers.get('www-authenticate')).toBe(
      'Bearer realm="ecclium", error="invalid_token"',
    );
    expect(
      logLines()
        .filter((line) => line['event'] === 'http_auth_refused')
        .map((line) => line['reason']),
    ).toEqual(['missing', 'unknown']);
    expect(audit()).toEqual([]);
  });

  it('notes the day each token signed in, and nothing for a token it refused', async () => {
    const { app, store } = setup();
    await ask(app, reader, 'tools/list');
    await ask(app, createBearerToken(), 'tools/list');
    await expect(readBearerLastUse(store, 'reader')).resolves.toBe(
      '2026-11-26',
    );
    await expect(readBearerLastUse(store, 'writer')).resolves.toBeUndefined();
  });
});
