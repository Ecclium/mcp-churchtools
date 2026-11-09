import type { Logger, LogFields } from '@ecclium/mcp-churchtools-plugin-api';
import { makeCanary } from '@ecclium/mcp-churchtools-testkit';
import { type Dispatcher, MockAgent, type MockCallHistory } from 'undici';
import { afterEach, describe, expect, it } from 'vitest';

import { createModelHttpTransport, createHttpTransport } from './compose.js';
import { createMockedModelTransport } from './compose-mock.js';
import { HttpTransportError } from './failure.js';
import { Secret } from './secret.js';
import {
  agentOptions,
  createModelTransport,
  createTransport,
  modelTransportLimits,
  transportLimits,
} from './transport.js';

// The transport to the endpoint of a model (ADR 0033) on a MockAgent of
// undici, which refuses every connection to the network. Hosts lie under
// .example (RFC 2606); keys are canaries made at run time.

const origin = 'https://model.example';
const path = '/v1/chat/completions';
const endpoint = `${origin}${path}`;
const canary = makeCanary('token');
const key = new Secret(canary.value);
const userAgent = 'Ecclium/0.0.0-test';
const json = new TextEncoder().encode('{"model":"example-model-1"}');

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
  const transport = createModelTransport(agent, {
    origin,
    path: settingsPath,
    token: key,
    userAgent,
    logger,
    clock,
    limits: modelTransportLimits,
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

describe('the limits of a transport to a model', () => {
  it('are frozen and wider than those for ChurchTools only where a model needs it', () => {
    expect(Object.isFrozen(modelTransportLimits)).toBe(true);
    expect(modelTransportLimits).toEqual({
      connectMs: 10_000,
      headersMs: 300_000,
      bodyMs: 60_000,
      totalMs: 300_000,
      keepAliveMs: 10_000,
      connections: 2,
      maxResponseBytes: 1024 * 1024,
      maxHeaderBytes: 16 * 1024,
      maxRequestBytes: 2 * 1024 * 1024,
    });
    expect(modelTransportLimits.connectMs).toBe(transportLimits.connectMs);
    expect(modelTransportLimits.maxResponseBytes).toBeLessThan(
      transportLimits.maxResponseBytes,
    );
    expect(agentOptions(modelTransportLimits)).toMatchObject({
      allowH2: false,
      useMilo: false,
      maxOrigins: 1,
      connections: 2,
      pipelining: 1,
      headersTimeout: 300_000,
    });
  });
});

describe('createModelTransport', () => {
  it('sends a POST with the key as a bearer token to the path, and logs its purpose', async () => {
    const { pool, transport, lines, history } = mocked();
    pool.intercept({ path, method: 'POST' }).reply(200, '{"ok":true}', {
      headers: { 'content-type': 'application/json' },
    });
    const answer = await transport.post({ body: json, maxResponseBytes: 1024 });
    expect(answer.status).toBe(200);
    expect(new TextDecoder().decode(answer.body)).toBe('{"ok":true}');
    const [call] = history.calls();
    expect(call?.method).toBe('POST');
    expect(call?.path).toBe(path);
    expect(call?.headers).toMatchObject({
      authorization: `Bearer ${canary.value}`,
      accept: 'application/json',
      'accept-encoding': 'identity',
      'content-type': 'application/json',
      'user-agent': userAgent,
    });
    expect(lines).toEqual([
      {
        level: 'info',
        event: 'http_response',
        fields: {
          durationMs: 0,
          method: 'POST',
          status: 200,
          purpose: 'model',
        },
      },
    ]);
  });

  it('never sends the scheme of ChurchTools, and ChurchTools never gets a bearer token', async () => {
    const model = mocked();
    model.pool.intercept({ path, method: 'POST' }).reply(200, '{}');
    await model.transport.post({ body: json, maxResponseBytes: 1024 });
    const sent = model.history.calls()[0]?.headers ?? {};
    expect(String(sent['authorization'])).not.toContain('Login');

    const agent = new MockAgent({ enableCallHistory: true });
    agent.disableNetConnect();
    open.push(agent);
    const churchTools = createTransport(agent, {
      origin: 'https://demo.example',
      token: key,
      userAgent,
      logger: recordingLogger().logger,
      clock,
      limits: transportLimits,
    });
    agent
      .get('https://demo.example')
      .intercept({ path: '/api/whoami', method: 'GET' })
      .reply(200, '{}');
    await churchTools.get(new URL('https://demo.example/api/whoami'), {
      maxResponseBytes: 1024,
    });
    const history = agent.getCallHistory() as MockCallHistory;
    expect(history.calls()[0]?.headers['authorization']).toBe(
      `Login ${canary.value}`,
    );
  });

  it('logs a failure with its purpose', async () => {
    const { pool, transport, lines } = mocked();
    pool.intercept({ path, method: 'POST' }).reply(302, '');
    expect(
      await refusal(transport.post({ body: json, maxResponseBytes: 1024 })),
    ).toBe('redirect');
    expect(lines).toEqual([
      {
        level: 'warn',
        event: 'http_redirect',
        fields: {
          code: 'upstream',
          durationMs: 0,
          method: 'POST',
          purpose: 'model',
        },
      },
    ]);
  });

  it('refuses a body that carries the key, before anything is sent', async () => {
    const { transport, history, lines } = mocked();
    const body = new TextEncoder().encode(`{"text":"${canary.value}"}`);
    expect(
      await refusal(transport.post({ body, maxResponseBytes: 1024 })),
    ).toBe('refused');
    expect(history.calls()).toHaveLength(0);
    expect(lines[0]?.fields).toMatchObject({ purpose: 'model' });
  });

  it('refuses a body larger than the limit of a model', async () => {
    const { transport, history } = mocked();
    const body = new Uint8Array(modelTransportLimits.maxRequestBytes + 1).fill(
      0x20,
    );
    expect(
      await refusal(transport.post({ body, maxResponseBytes: 1024 })),
    ).toBe('refused');
    expect(history.calls()).toHaveLength(0);
  });

  it.each([
    ['a path the parser changes', 'v1/chat/completions'],
    ['a path with a query', '/v1/chat/completions?stream=true'],
    ['a path on another host', '//elsewhere.example/v1'],
  ])('refuses every call for %s', async (_case, settingsPath) => {
    const { transport, history } = mocked(settingsPath);
    expect(
      await refusal(transport.post({ body: json, maxResponseBytes: 1024 })),
    ).toBe('refused');
    expect(history.calls()).toHaveLength(0);
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
    const transport = createModelTransport(dispatcher, {
      origin,
      path,
      token: key,
      userAgent,
      logger: recordingLogger().logger,
      clock,
      limits: modelTransportLimits,
    });
    await transport.close();
    await transport.destroy();
    expect(calls).toEqual(['close', 'destroy']);
    expect(Object.isFrozen(transport)).toBe(true);
    expect(Object.keys(transport)).toEqual(['post', 'close', 'destroy']);
  });
});

describe('createModelHttpTransport', () => {
  const options = {
    endpoint,
    key,
    userAgent,
    logger: recordingLogger().logger,
    clock,
  };

  it('builds a transport for a canonical endpoint', async () => {
    const transport = createModelHttpTransport(options);
    expect(Object.keys(transport)).toEqual(['post', 'close', 'destroy']);
    await transport.close();
  });

  it.each([
    ['an endpoint without a path', { endpoint: origin }],
    ['an endpoint with a query', { endpoint: `${endpoint}?x=1` }],
    ['a key that is no secret', { key: canary.value }],
    ['a User-Agent with a line break', { userAgent: 'Ecc\nlium' }],
  ])('refuses %s before a pool exists', (_case, change) => {
    expect(() =>
      createModelHttpTransport({
        ...options,
        ...(change as Partial<typeof options>),
      }),
    ).toThrow(TypeError);
  });

  it('is not the factory for ChurchTools', () => {
    expect(createModelHttpTransport).not.toBe(createHttpTransport);
  });
});

describe('createMockedModelTransport', () => {
  const options = {
    endpoint,
    key,
    userAgent,
    logger: recordingLogger().logger,
    clock,
  };

  it('answers from interceptors and reports each call', async () => {
    const mocked = createMockedModelTransport(options);
    open.push(mocked);
    mocked.intercept({ path, method: 'POST' }).reply(200, '{}');
    await mocked.transport.post({ body: json, maxResponseBytes: 1024 });
    mocked.assertNoPendingInterceptors();
    expect(mocked.calls()).toEqual([
      expect.objectContaining({
        method: 'POST',
        path,
        body: '{"model":"example-model-1"}',
      }),
    ]);
    expect(mocked.calls()[0]?.headers['authorization']).toBe(
      `Bearer ${canary.value}`,
    );
  });

  it.each([
    ['an endpoint without a path', { endpoint: origin }],
    ['a key that is no secret', { key: canary.value }],
    ['a User-Agent with a line break', { userAgent: 'Ecc\nlium' }],
  ])('refuses %s', (_case, change) => {
    expect(() =>
      createMockedModelTransport({
        ...options,
        ...(change as Partial<typeof options>),
      }),
    ).toThrow(TypeError);
  });
});
