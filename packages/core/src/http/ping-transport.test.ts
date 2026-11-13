import type { Logger, LogFields } from '@ecclium/mcp-churchtools-plugin-api';
import { makeCanary } from '@ecclium/mcp-churchtools-testkit';
import { type Dispatcher, MockAgent, type MockCallHistory } from 'undici';
import { afterEach, describe, expect, it } from 'vitest';

import { createPingHttpTransport } from './compose.js';
import { createMockedPingTransport } from './compose-mock.js';
import { HttpTransportError } from './failure.js';
import { parsePingUrl } from './origin.js';
import { Secret } from './secret.js';
import {
  agentOptions,
  createPingTransport,
  pingTransportLimits,
  transportLimits,
} from './transport.js';

// The transport to the ping of the runner (ADR 0009, ADR 0035) on a
// MockAgent of undici, which refuses every connection to the network. The
// host lies under .example (RFC 2606); the path holds a canary made at run
// time, because the path of a ping works like a secret.

const origin = 'https://ping.example';
const canary = makeCanary('token');
const secretPart = canary.cores[0] ?? '';
const path = `/ping/${secretPart}`;
const userAgent = 'Ecclium/0.0.0-test';

interface Line {
  readonly level: string;
  readonly event: string;
  readonly fields: LogFields | undefined;
}

const recordingLogger = (): { logger: Logger; lines: Line[] } => {
  const lines: Line[] = [];
  const record =
    (level: string) =>
    (event: string, fields?: LogFields): void => {
      lines.push({ level, event, fields });
    };
  return {
    logger: Object.freeze({
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    }),
    lines,
  };
};
const clock = Object.freeze({ now: (): number => 0 });

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
});

const mocked = (settingsPath = path) => {
  const agent = new MockAgent({ enableCallHistory: true });
  agent.disableNetConnect();
  open.push(agent);
  const { logger, lines } = recordingLogger();
  const transport = createPingTransport(agent, {
    origin,
    path: settingsPath,
    userAgent,
    logger,
    clock,
    limits: pingTransportLimits,
  });
  const history = agent.getCallHistory() as MockCallHistory;
  return { pool: agent.get(origin), transport, lines, history };
};

const refusal = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpTransportError);
    return (error as HttpTransportError).category;
  }
  throw new Error('The call did not fail.');
};

describe('the limits of the transport to the ping', () => {
  it('are frozen, short and for one connection without body', () => {
    expect(Object.isFrozen(pingTransportLimits)).toBe(true);
    expect(pingTransportLimits).toEqual({
      connectMs: 10_000,
      headersMs: 10_000,
      bodyMs: 10_000,
      totalMs: 15_000,
      keepAliveMs: 10_000,
      connections: 1,
      maxResponseBytes: 64 * 1024,
      maxHeaderBytes: 16 * 1024,
      maxRequestBytes: 0,
    });
    expect(pingTransportLimits.totalMs).toBeLessThan(transportLimits.totalMs);
    expect(agentOptions(pingTransportLimits)).toMatchObject({
      allowH2: false,
      useMilo: false,
      maxOrigins: 1,
      connections: 1,
      pipelining: 1,
    });
  });
});

describe('createPingTransport', () => {
  it('sends a POST without body and without Authorization header to the path', async () => {
    const { pool, transport, lines, history } = mocked();
    pool.intercept({ path, method: 'POST' }).reply(200, 'OK');
    await expect(transport.ping('success', {})).resolves.toBeUndefined();
    const [call] = history.calls();
    expect(call?.method).toBe('POST');
    expect(call?.path).toBe(path);
    expect(call?.body ?? undefined).toBeUndefined();
    expect(call?.headers).toEqual({
      accept: 'application/json',
      'accept-encoding': 'identity',
      'user-agent': userAgent,
    });
    expect(lines).toEqual([
      {
        level: 'info',
        event: 'http_response',
        fields: { durationMs: 0, method: 'POST', status: 200, purpose: 'ping' },
      },
    ]);
  });

  it('reports a failed pass to the path with /fail', async () => {
    const { pool, transport, history } = mocked();
    pool.intercept({ path: `${path}/fail`, method: 'POST' }).reply(200, 'OK');
    await transport.ping('fail', {});
    expect(history.calls().map((call) => call.path)).toEqual([`${path}/fail`]);
  });

  it.each([404, 429, 500])(
    'fails with status %i and names the status, never the address',
    async (status) => {
      const { pool, transport, lines } = mocked();
      pool.intercept({ path, method: 'POST' }).reply(status, 'not found');
      expect(await refusal(transport.ping('success', {}))).toBe('status');
      expect(lines).toEqual([
        {
          level: 'warn',
          event: 'http_status',
          fields: {
            code: 'upstream',
            durationMs: 0,
            method: 'POST',
            purpose: 'ping',
            status,
          },
        },
      ]);
    },
  );

  it('takes every status from 200 to 299', async () => {
    const { pool, transport } = mocked();
    for (const status of [200, 201, 204, 299]) {
      pool.intercept({ path, method: 'POST' }).reply(status, '');
      await expect(transport.ping('success', {})).resolves.toBeUndefined();
    }
  });

  it('refuses a redirect without naming a status', async () => {
    const { pool, transport, lines } = mocked();
    pool.intercept({ path, method: 'POST' }).reply(302, '', {
      headers: { location: 'https://other.example/' },
    });
    expect(await refusal(transport.ping('success', {}))).toBe('redirect');
    expect(lines.map((line) => line.fields?.['status'])).toEqual([undefined]);
  });

  it('refuses an answer larger than its limit', async () => {
    const { pool, transport } = mocked();
    pool
      .intercept({ path, method: 'POST' })
      .reply(200, 'x'.repeat(pingTransportLimits.maxResponseBytes + 1));
    expect(await refusal(transport.ping('success', {}))).toBe('too_large');
  });

  it('takes the signal of the caller', async () => {
    const { transport, history } = mocked();
    const controller = new AbortController();
    controller.abort();
    expect(
      await refusal(transport.ping('success', { signal: controller.signal })),
    ).toBe('aborted');
    expect(history.calls()).toEqual([]);
  });

  it('refuses a path with a query before a socket opens', async () => {
    const { transport, history } = mocked(`${path}?x=1`);
    expect(await refusal(transport.ping('success', {}))).toBe('refused');
    expect(await refusal(transport.ping('fail', {}))).toBe('refused');
    expect(history.calls()).toEqual([]);
  });

  it('never writes the path of the address to the log', async () => {
    const { pool, transport, lines } = mocked();
    pool.intercept({ path, method: 'POST' }).reply(200, 'OK');
    pool.intercept({ path: `${path}/fail`, method: 'POST' }).reply(404, path);
    await transport.ping('success', {});
    await refusal(transport.ping('fail', {}));
    expect(JSON.stringify(lines)).not.toContain(secretPart);
  });

  it('closes and destroys its dispatcher', async () => {
    const calls: string[] = [];
    const dispatcher = {
      close: () => {
        calls.push('close');
        return Promise.resolve();
      },
      destroy: () => {
        calls.push('destroy');
        return Promise.resolve();
      },
    } as unknown as Dispatcher;
    const transport = createPingTransport(dispatcher, {
      origin,
      path,
      userAgent,
      logger: recordingLogger().logger,
      clock,
      limits: pingTransportLimits,
    });
    await transport.close();
    await transport.destroy();
    expect(calls).toEqual(['close', 'destroy']);
  });
});

describe('createPingHttpTransport', () => {
  const url = new Secret(`${origin}${path}`);
  const options = {
    url,
    userAgent,
    logger: recordingLogger().logger,
    clock,
  };

  it('builds the transport without opening a connection', async () => {
    const transport = createPingHttpTransport(options);
    await transport.destroy();
    const proxied = createPingHttpTransport({
      ...options,
      proxy: 'http://egress:3128',
    });
    await proxied.destroy();
  });

  it.each([
    ['an address that is no secret', { url: `${origin}${path}` }],
    [
      'an address without https',
      { url: new Secret(`http://ping.example${path}`) },
    ],
    ['an address with a query', { url: new Secret(`${origin}${path}?x=1`) }],
    ['a User-Agent with a line break', { userAgent: 'Ecc\nlium' }],
    ['a proxy that is not canonical', { proxy: 'http://Egress:3128' }],
  ])('refuses %s, never showing the address', (_case, change) => {
    let thrown: unknown;
    try {
      createPingHttpTransport({
        ...options,
        ...(change as Partial<typeof options>),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect(String(thrown)).not.toContain(secretPart);
  });
});

describe('createMockedPingTransport', () => {
  const options = {
    url: new Secret(`${origin}${path}`),
    userAgent,
    logger: recordingLogger().logger,
    clock,
  };

  it('answers from interceptors and reports each call', async () => {
    const mockedPing = createMockedPingTransport(options);
    open.push(mockedPing);
    mockedPing
      .intercept({ path: `${path}/fail`, method: 'POST' })
      .reply(200, 'OK');
    await mockedPing.transport.ping('fail', {});
    mockedPing.assertNoPendingInterceptors();
    expect(mockedPing.calls()).toEqual([
      expect.objectContaining({
        method: 'POST',
        path: `${path}/fail`,
        body: undefined,
      }),
    ]);
    expect(mockedPing.calls()[0]?.headers['authorization']).toBeUndefined();
  });

  it.each([
    ['an address that is no secret', { url: `${origin}${path}` }],
    ['an address without a path', { url: new Secret(origin) }],
    ['a User-Agent with a line break', { userAgent: 'Ecc\nlium' }],
  ])('refuses %s', (_case, change) => {
    expect(() =>
      createMockedPingTransport({
        ...options,
        ...(change as Partial<typeof options>),
      }),
    ).toThrow(TypeError);
  });
});

describe('parsePingUrl', () => {
  it.each([
    'https://hc-ping.example/7a1f2c3e-0b4d-4e5f-8a6b-9c0d1e2f3a4b',
    'https://hc-ping.example/AbCdEfGhIjKlMnOpQrStUv/backup-report',
    'https://health.example.org/ping/7a1f2c3e-0b4d-4e5f-8a6b-9c0d1e2f3a4b',
    'https://health.example.org:8443/ping/check',
  ])('takes the forms of Healthchecks, such as %s', (input) => {
    const checked = parsePingUrl(input);
    expect(checked.ok).toBe(true);
  });

  it('splits the address into origin, path and host', () => {
    expect(parsePingUrl('https://ping.example.org/check-1')).toEqual({
      ok: true,
      origin: 'https://ping.example.org',
      path: '/check-1',
      host: 'ping.example.org',
    });
  });

  it.each([
    ['http://ping.example.org/check', 'url_not_https'],
    ['https://ping.example.org', 'url_path'],
    ['https://ping.example.org/check/', 'url_path'],
    ['https://ping.example.org/check?x=1', 'url_path'],
    ['https://ping.example.org/check#x', 'url_path'],
    ['https://user@ping.example.org/check', 'url_credentials'],
    ['https://192.0.2.1/check', 'url_ip_address'],
    ['https://ping/check', 'url_single_label'],
    ['https://Ping.example.org/check', 'url_not_canonical'],
  ])('refuses %s with %s', (input, code) => {
    expect(parsePingUrl(input)).toEqual({ ok: false, code });
  });

  it('keeps room for /fail in the limit of the path', () => {
    const fits = `/${'a'.repeat(250)}`;
    expect(parsePingUrl(`https://ping.example.org${fits}`).ok).toBe(true);
    expect(parsePingUrl(`https://ping.example.org${fits}a`)).toEqual({
      ok: false,
      code: 'url_path',
    });
  });
});
