import { readFileSync } from 'node:fs';

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/server';
import { Ajv } from '@modelcontextprotocol/server/validators/ajv';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  bindAddress,
  createProbeApp,
  maxEntries,
  sdkVersion,
  startProbe,
  type ProbeApp,
} from '../../scripts/spike/14-protocol-version.mts';
import { Guard } from '../../scripts/spike/lib/guard.mts';
import {
  clientInfoMetaKey,
  outputWords,
  protocolVersionMetaKey,
  summarize,
  supportedVersions,
  type ProbeRequest,
} from '../../scripts/spike/lib/protocol-probe.mts';

// The probe of the protocol version (ADR 0073): a recorder in front of the
// MCP SDK. These tests drive it in the process with requests as clients
// send them, without a socket; one test binds to 127.0.0.1, which the
// network guard of the tests allows (ADR 0052).

type Line = Record<string, unknown>;

const paths = ['/pathcanaryone', '/pathcanarytwo', '/pathcanarythree'];

const envelope = {
  [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
  [CLIENT_INFO_META_KEY]: { name: 'test-client', version: '2.0.0' },
  [CLIENT_CAPABILITIES_META_KEY]: {},
};

function initialize(version = '2025-11-25'): Line {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: version,
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    },
  };
}

function legacy(method: string, params: Line = {}): Line {
  return { jsonrpc: '2.0', id: 3, method, params };
}

function modern(method: string, params: Line = {}): Line {
  return {
    jsonrpc: '2.0',
    id: 2,
    method,
    params: { ...params, _meta: envelope },
  };
}

function headersFor(
  method: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    'mcp-protocol-version': '2026-07-28',
    'mcp-method': method,
    ...extra,
  };
}

function post(
  body: unknown,
  headers: Record<string, string> = {},
  path: string = paths[0] ?? '',
): ProbeRequest {
  return {
    method: 'POST',
    path,
    headers: new Headers({
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    }),
    body: JSON.stringify(body),
  };
}

interface Harness {
  readonly app: ProbeApp;
  readonly output: string[];
  readonly lines: () => Line[];
  readonly limits: () => number;
}

const open: ProbeApp[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

function harness(strict = false): Harness {
  const output: string[] = [];
  const guard = new Guard();
  guard.allowFixed(...outputWords);
  for (const path of paths) {
    guard.block(path.slice(1));
  }
  let limits = 0;
  const app = createProbeApp({
    strict,
    paths,
    guard,
    io: {
      stdout: (text) => output.push(text),
      stderr: () => undefined,
    },
    now: () => 0,
    onLimit: () => {
      limits += 1;
    },
  });
  open.push(app);
  return {
    app,
    output,
    lines: () => output.map((text) => JSON.parse(text) as Line),
    limits: () => limits,
  };
}

async function send(h: Harness, request: ProbeRequest): Promise<Line> {
  await h.app.handle(request, '127.0.0.1');
  const line = h.lines().at(-1);
  if (line === undefined) {
    throw new Error('no line was recorded');
  }
  return line;
}

describe('a client of the era 2025', () => {
  it('is recorded with its version and name and served by the SDK', async () => {
    const h = harness();
    const init = await send(h, post(initialize()));
    expect(init).toMatchObject({
      nr: 1,
      pfad: 'k1',
      httpMethode: 'POST',
      nachricht: 'Anfrage',
      methode: 'initialize',
      kopfzeile: 'fehlt',
      koerper: '2025-11-25',
      umschlag: 'nein',
      mcpMethod: 'fehlt',
      client: { name: 'test-client', version: '1.0.0' },
      streng: { status: 200, von: 'SDK', ausgehandelt: '2025-11-25' },
    });
    expect(init).not.toHaveProperty('angeglichen');

    const list = await send(
      h,
      post(legacy('tools/list'), { 'mcp-protocol-version': '2025-11-25' }),
    );
    expect(list).toMatchObject({
      methode: 'tools/list',
      kopfzeile: '2025-11-25',
      koerper: 'fehlt',
      streng: { status: 200, von: 'SDK' },
    });
    const call = await send(
      h,
      post(legacy('tools/call', { name: 'empty', arguments: {} }), {
        'mcp-protocol-version': '2025-11-25',
      }),
    );
    expect(call).toMatchObject({
      methode: 'tools/call',
      mcpName: 'fehlt',
      streng: { status: 200 },
    });
  });
});

describe('a client of the era 2026', () => {
  it('passes with all headers the specification asks for', async () => {
    const h = harness();
    const discover = await send(
      h,
      post(modern('server/discover'), headersFor('server/discover')),
    );
    expect(discover).toMatchObject({
      methode: 'server/discover',
      kopfzeile: '2026-07-28',
      koerper: '2026-07-28',
      umschlag: 'ja',
      mcpMethod: 'gleich',
      mcpName: 'nicht verlangt',
      client: { name: 'test-client', version: '2.0.0' },
      streng: { status: 200, von: 'SDK' },
    });
    expect(
      (discover['streng'] as { angeboten?: string[] }).angeboten,
    ).toContain('2026-07-28');

    const call = await send(
      h,
      post(
        modern('tools/call', { name: 'empty', arguments: {} }),
        headersFor('tools/call', { 'mcp-name': 'empty' }),
      ),
    );
    expect(call).toMatchObject({
      mcpName: 'gleich',
      streng: { status: 200 },
    });
    expect(call).not.toHaveProperty('angeglichen');
  });

  it('sees a name header in Base64 as the same name', async () => {
    const h = harness();
    const call = await send(
      h,
      post(
        modern('tools/call', { name: 'empty', arguments: {} }),
        headersFor('tools/call', {
          'mcp-name': `=?base64?${Buffer.from('empty').toString('base64')}?=`,
        }),
      ),
    );
    expect(call).toMatchObject({
      mcpName: 'gleich (Base64)',
      streng: { status: 200 },
    });
  });
});

describe('a header that does not match the body (the prepared rule)', () => {
  const mismatch = (): ProbeRequest =>
    post(
      modern('tools/list'),
      headersFor('tools/list', {
        'mcp-protocol-version': '2025-11-25',
      }),
    );

  it('is refused by the SDK and served after the header follows the body', async () => {
    const h = harness();
    const response = await h.app.handle(mismatch(), undefined);
    const line = h.lines().at(-1);
    expect(line).toMatchObject({
      kopfzeile: '2025-11-25',
      koerper: '2026-07-28',
      streng: { status: 400, von: 'SDK', fehler: -32020 },
      angeglichen: { status: 200, von: 'SDK' },
    });
    expect(response.status).toBe(200);
  });

  it('stays refused in the strict mode (counter-check)', async () => {
    const h = harness(true);
    const response = await h.app.handle(mismatch(), undefined);
    const line = h.lines().at(-1);
    expect(line).toMatchObject({
      streng: { status: 400, fehler: -32020 },
    });
    expect(line).not.toHaveProperty('angeglichen');
    expect(response.status).toBe(400);
  });
});

describe('refusals the prepared rule does not cover', () => {
  it('a request of 2026 without Mcp-Method', async () => {
    const h = harness();
    const line = await send(
      h,
      post(modern('tools/list'), { 'mcp-protocol-version': '2026-07-28' }),
    );
    expect(line).toMatchObject({
      mcpMethod: 'fehlt',
      streng: { status: 400, fehler: -32020 },
    });
    expect(line).not.toHaveProperty('angeglichen');
  });

  it('a request of 2026 with another method in Mcp-Method', async () => {
    const h = harness();
    const line = await send(
      h,
      post(modern('tools/list'), headersFor('prompts/list')),
    );
    expect(line).toMatchObject({
      mcpMethod: 'anders',
      streng: { status: 400, fehler: -32020 },
    });
    expect(line).not.toHaveProperty('angeglichen');
  });

  it('an envelope of 2026 without the header of the version', async () => {
    const h = harness();
    const line = await send(
      h,
      post(modern('tools/list'), { 'mcp-method': 'tools/list' }),
    );
    expect(line).toMatchObject({
      kopfzeile: 'fehlt',
      koerper: '2026-07-28',
      streng: { status: 400, fehler: -32020 },
    });
    expect(line).not.toHaveProperty('angeglichen');
  });

  it('a request of 2025 with a version in the header the SDK does not know', async () => {
    const h = harness();
    const line = await send(
      h,
      post(legacy('tools/list'), { 'mcp-protocol-version': '2099-01-01' }),
    );
    expect(line).toMatchObject({
      kopfzeile: '2099-01-01',
      umschlag: 'nein',
      streng: { status: 400 },
    });
  });

  it('a call of 2026 without Mcp-Name', async () => {
    const h = harness();
    const line = await send(
      h,
      post(
        modern('tools/call', { name: 'empty', arguments: {} }),
        headersFor('tools/call'),
      ),
    );
    expect(line).toMatchObject({
      mcpName: 'fehlt',
      streng: { status: 400, fehler: -32020 },
    });
    expect(line).not.toHaveProperty('angeglichen');
  });

  it('a call of 2026 with another name in Mcp-Name', async () => {
    const h = harness();
    const line = await send(
      h,
      post(
        modern('tools/call', { name: 'empty', arguments: {} }),
        headersFor('tools/call', { 'mcp-name': 'other' }),
      ),
    );
    expect(line).toMatchObject({
      mcpName: 'anders',
      streng: { status: 400, fehler: -32020 },
    });
  });

  it('initialize with the header of 2026', async () => {
    const h = harness();
    const line = await send(
      h,
      post(initialize(), { 'mcp-protocol-version': '2026-07-28' }),
    );
    expect(line).toMatchObject({
      kopfzeile: '2026-07-28',
      koerper: '2025-11-25',
      umschlag: 'nein',
      streng: { status: 400, fehler: -32020 },
    });
    expect(line).not.toHaveProperty('angeglichen');
  });

  it('the header of 2026 without an envelope', async () => {
    const h = harness();
    const line = await send(
      h,
      post(legacy('tools/list'), headersFor('tools/list')),
    );
    expect(line).toMatchObject({
      umschlag: 'nein',
      streng: { status: 400, fehler: -32602 },
    });
  });
});

describe('what never reaches the SDK', () => {
  it('a request for a stream of changes', async () => {
    const h = harness();
    const response = await h.app.handle(
      post(modern('subscriptions/listen'), headersFor('subscriptions/listen')),
      undefined,
    );
    expect(h.lines().at(-1)).toMatchObject({
      methode: 'subscriptions/listen',
      streng: { status: 200, von: 'Attrappe', fehler: -32601 },
    });
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('a body over the limit', async () => {
    const h = harness();
    const line = await send(h, {
      ...post({}),
      body: undefined,
      tooLarge: true,
    });
    expect(line).toMatchObject({
      nachricht: 'zu gross',
      streng: { status: 413, von: 'Attrappe' },
    });
    // A body that only says so is an invalid body, not a large one.
    expect(await send(h, { ...post({}), body: 'zu gross' })).toMatchObject({
      nachricht: 'ungültig',
      streng: { von: 'SDK' },
    });
  });

  it('a path of no client, and well-known documents by their client', async () => {
    const h = harness();
    expect(await send(h, post(initialize(), {}, '/'))).toMatchObject({
      pfad: 'fremd',
      streng: { status: 404, von: 'Attrappe' },
    });
    const wellKnown = await send(h, {
      method: 'GET',
      path: `/.well-known/oauth-protected-resource${paths[1] ?? ''}`,
      headers: new Headers(),
      body: undefined,
    });
    expect(wellKnown).toMatchObject({
      pfad: 'oauth-protected-resource',
      zu: 'k2',
      httpMethode: 'GET',
      streng: { status: 404, von: 'Attrappe' },
    });
    expect(
      await send(h, {
        method: 'PUT',
        path: paths[2] ?? '',
        headers: new Headers(),
        body: undefined,
      }),
    ).toMatchObject({
      pfad: 'k3',
      httpMethode: 'andere',
      streng: { status: 405, von: 'Attrappe' },
    });
  });

  it('a GET for a stream goes to the SDK, which has none without a session', async () => {
    const h = harness();
    expect(
      await send(h, {
        method: 'GET',
        path: paths[0] ?? '',
        headers: new Headers({ accept: 'text/event-stream' }),
        body: undefined,
      }),
    ).toMatchObject({
      httpMethode: 'GET',
      streng: { status: 405, von: 'SDK' },
    });
  });
});

describe('the output', () => {
  const canaries = [
    'canary-host.example.net',
    '198.51.100.77',
    '203.0.113.9',
    'canary-origin.example',
    'canary-agent',
    'canarycookie',
    'canary/client',
    'canaryargument',
    'pathcanary',
    'querycanary',
  ];

  it('holds no address, host, path, header value or parameter', async () => {
    const h = harness();
    const request = post(
      {
        ...initialize(),
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: '/canary/client', version: 'canaryargument' },
        },
      },
      {
        host: 'canary-host.example.net',
        'x-forwarded-for': '198.51.100.77, 203.0.113.9',
        origin: 'https://canary-origin.example',
        'user-agent': 'canary-agent/9.9',
        cookie: 'session=canarycookie',
      },
    );
    await h.app.handle(request, '198.51.100.77');
    await h.app.handle(
      post(
        modern('tools/call', {
          name: 'empty',
          arguments: { q: 'canaryargument' },
        }),
        headersFor('tools/call', { 'mcp-name': 'empty' }),
        `${paths[0] ?? ''}?q=querycanary`,
      ),
      undefined,
    );
    const text = h.output.join('');
    expect(text).not.toBe('');
    for (const canary of canaries) {
      expect(text, canary).not.toContain(canary);
    }
    expect(h.lines()[0]).toMatchObject({
      origin: 'anderer Wert',
      client: { name: 'anderer Wert', version: 'anderer Wert' },
    });
    expect(h.lines()[1]).toMatchObject({ pfad: 'fremd' });
  });

  it('records the origin of a known client as it is', async () => {
    const h = harness();
    const line = await send(
      h,
      post(initialize(), { origin: 'https://claude.ai' }),
    );
    expect(line).toMatchObject({ origin: 'https://claude.ai' });
  });

  it('withholds a line whose client name equals the host', async () => {
    const h = harness();
    await h.app.handle(
      post(
        {
          ...initialize(),
          params: {
            ...(initialize()['params'] as Line),
            clientInfo: { name: 'hostcanary', version: '1' },
          },
        },
        { host: 'hostcanary' },
      ),
      undefined,
    );
    expect(h.lines().at(-1)).toMatchObject({ nr: 1, zurueckgehalten: true });
    expect(h.output.join('')).not.toContain('hostcanary');
    expect(h.app.withheld()).toBe(1);
  });

  it('shows the same client name under another host (counter-check)', async () => {
    const h = harness();
    const line = await send(
      h,
      post(
        {
          ...initialize(),
          params: {
            ...(initialize()['params'] as Line),
            clientInfo: { name: 'hostcanary', version: '1' },
          },
        },
        { host: 'other-host.example.net' },
      ),
    );
    expect(line).toMatchObject({ client: { name: 'hostcanary' } });
  });

  it('sums up the forms per path with their count', () => {
    const observation = {
      pfad: 'k1',
      httpMethode: 'POST',
      nachricht: 'Anfrage',
      methode: 'tools/list',
      kopfzeile: '2025-11-25',
      koerper: '2026-07-28',
      umschlag: 'ja',
      mcpMethod: 'gleich',
      mcpName: 'nicht verlangt',
      origin: 'fehlt',
      accept: 'JSON und SSE',
      authorization: 'nein',
      sitzung: 'nein',
    } as const;
    const entry = (nr: number) => ({
      nr,
      sekunde: nr,
      observation,
      streng: { status: 400, von: 'SDK', fehler: -32020 } as const,
      angeglichen: { status: 200, von: 'SDK' } as const,
    });
    const summary = summarize([entry(1), entry(2)], {
      datum: '16.11.2026',
      modus: 'nachsichtig',
      sdk: sdkVersion,
      ende: 'Frist',
      zurueckgehalten: 0,
    }) as Line;
    expect(summary).toMatchObject({ anfragen: 2, ende: 'Frist' });
    const k1 = (summary['pfade'] as Record<string, Line>)['k1'];
    expect(k1).toMatchObject({ anfragen: 2 });
    expect(k1?.['formen']).toEqual([
      expect.objectContaining({ kopfzeile: '2025-11-25', anzahl: 2 }),
    ]);
  });
});

describe('the limits', () => {
  it(`ends recording after ${String(maxEntries)} requests`, async () => {
    const h = harness();
    for (let index = 0; index < maxEntries; index += 1) {
      await h.app.handle(post({}, {}, '/'), undefined);
    }
    expect(h.limits()).toBe(1);
    const after = await h.app.handle(post({}, {}, '/'), undefined);
    expect(after.status).toBe(503);
    expect(h.app.entries()).toHaveLength(maxEntries);
  });

  it('binds to 127.0.0.1, ends itself at the deadline and refuses a large body', async () => {
    const output: string[] = [];
    const probe = await startProbe({
      port: 0,
      strict: false,
      durationMs: 1500,
      io: { stdout: (text) => output.push(text), stderr: () => undefined },
    });
    expect(bindAddress).toBe('127.0.0.1');
    expect(probe.address).toBe('127.0.0.1');
    const base = `http://127.0.0.1:${String(probe.port)}${probe.paths[0] ?? ''}`;
    const init = await fetch(base, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(initialize()),
    });
    expect(init.status).toBe(200);
    await init.arrayBuffer();
    const large = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(1024 * 1024 + 1),
    });
    expect(large.status).toBe(413);
    await large.arrayBuffer();
    expect(await probe.finished).toBe(0);
    const lines = output.map((text) => JSON.parse(text) as Line);
    expect(lines.at(-1)).toMatchObject({
      probe: '14-protocol-version',
      ende: 'Frist',
      anfragen: 2,
      modus: 'nachsichtig',
      sdk: sdkVersion,
    });
    await expect(fetch(base, { method: 'POST' })).rejects.toThrow();
  });
});

describe('the code behind the probe', () => {
  it('pins the same SDK as the packages and names its versions and keys', () => {
    const read = (path: string): Record<string, Record<string, string>> =>
      JSON.parse(
        readFileSync(new URL(path, import.meta.url), 'utf8'),
      ) as Record<string, Record<string, string>>;
    expect(
      read('../../package.json')['devDependencies']?.[
        '@modelcontextprotocol/server'
      ],
    ).toBe(sdkVersion);
    expect(
      read('../../packages/core/package.json')['dependencies']?.[
        '@modelcontextprotocol/server'
      ],
    ).toBe(sdkVersion);
    // The SDK lists the versions of the era 2025; the era 2026 has one.
    expect([...supportedVersions].sort()).toEqual(
      [...SUPPORTED_PROTOCOL_VERSIONS, '2026-07-28'].sort(),
    );
    expect(protocolVersionMetaKey).toBe(PROTOCOL_VERSION_META_KEY);
    expect(clientInfoMetaKey).toBe(CLIENT_INFO_META_KEY);
  });

  it('imports nothing of Ecclium, so it is never a way to run Ecclium without sign-in', () => {
    for (const file of [
      '../../scripts/spike/14-protocol-version.mts',
      '../../scripts/spike/lib/protocol-probe.mts',
    ]) {
      const text = readFileSync(new URL(file, import.meta.url), 'utf8');
      const sources = [...text.matchAll(/from '([^']+)'/g)].map(
        (match) => match[1] ?? '',
      );
      expect(sources.length).toBeGreaterThan(0);
      for (const source of sources) {
        expect(source, file).not.toMatch(/^@ecclium\/|packages\//);
      }
    }
  });

  // ADR 0059: only Ajv calls the bundled fast-uri, through the object it
  // sets as its default uriResolver. Hostile input through both eras must
  // not reach it.
  it('lets no value of a client reach the bundled fast-uri', async () => {
    const fastUri = new Ajv().opts.uriResolver as unknown as Record<
      string,
      () => unknown
    >;
    const spies = Object.keys(fastUri)
      .filter((name) => typeof fastUri[name] === 'function')
      .map((name) => vi.spyOn(fastUri, name));
    expect(spies.length).toBeGreaterThan(0);
    const h = harness();
    const hostile = {
      name: 'https://example.org/../x#/$ref',
      arguments: {
        $ref: 'https://example.org/schema#',
        $id: 'urn:x:y',
        uri: 'http://[::1]/%2e%2e',
      },
    };
    await h.app.handle(post(initialize()), undefined);
    await h.app.handle(
      post(legacy('tools/call', hostile), {
        'mcp-protocol-version': '2025-11-25',
      }),
      undefined,
    );
    await h.app.handle(
      post(modern('server/discover'), headersFor('server/discover')),
      undefined,
    );
    await h.app.handle(
      post(modern('tools/list'), headersFor('tools/list')),
      undefined,
    );
    await h.app.handle(
      post(
        modern('tools/call', hostile),
        headersFor('tools/call', { 'mcp-name': hostile.name }),
      ),
      undefined,
    );
    await h.app.handle(
      post(
        modern('resources/read', { uri: 'https://example.org/%2e%2e/x' }),
        headersFor('resources/read', {
          'mcp-name': 'https://example.org/%2e%2e/x',
        }),
      ),
      undefined,
    );
    expect(h.app.entries()).toHaveLength(6);
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual(
      spies.map(() => 0),
    );

    // Counter-check: the count sees a compiled schema with an $id.
    new Ajv().compile({ $id: 'https://example.org/probe', type: 'object' });
    expect(spies.some((spy) => spy.mock.calls.length > 0)).toBe(true);
  });
});
