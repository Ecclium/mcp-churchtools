import type { AddressInfo, Socket } from 'node:net';
import { createServer } from 'node:net';
import { PassThrough } from 'node:stream';

import type { Logger, LogFields } from '@ecclium/mcp-churchtools-plugin-api';
import { makeCanary } from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createHttpTransport,
  createModelHttpTransport,
  createPingHttpTransport,
} from './compose.js';
import { HttpTransportError } from './failure.js';
import {
  isProbeTarget,
  probeEgressProxy,
  probeEgressTarget,
  proxyProbeLimits,
} from './proxy-probe.js';
import { Secret } from './secret.js';
import {
  createProxyAgent,
  createTransport,
  type HttpTransport,
  type TransportLimits,
  transportLimits,
} from './transport.js';

// The outbound path through a proxy (ADR 0035), against a proxy on the
// loopback address that this test plays itself (ADR 0052). It never opens
// a connection to the target: it answers CONNECT as a case needs and keeps
// every byte the transport sent it. The origin lies under .example
// (RFC 2606) and resolves nowhere, since a proxy resolves the names.

const origin = 'https://demo.example';
const canary = makeCanary('token');
const token = new Secret(canary.value);
const userAgent = 'Ecclium/0.0.0-test';
const clock = Object.freeze({ now: (): number => 0 });

interface Line {
  readonly event: string;
  readonly fields: LogFields | undefined;
}

const recordingLogger = (): { logger: Logger; lines: Line[] } => {
  const lines: Line[] = [];
  const record = (event: string, fields?: LogFields): void => {
    lines.push({ event, fields });
  };
  return {
    logger: Object.freeze({
      debug: record,
      info: record,
      warn: record,
      error: record,
    }),
    lines,
  };
};

/** A proxy on the loopback address, as a case plays it. */
interface FakeProxy {
  /** Its address, `http://127.0.0.1:<port>`. */
  readonly url: string;
  /** Every byte it got, in order. */
  readonly received: Buffer[];
  /** The head of each CONNECT, without the blank line. */
  readonly heads: string[];
  close(): Promise<void>;
}

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
});

const startProxy = async (
  answer: (socket: Socket) => void,
): Promise<FakeProxy> => {
  const received: Buffer[] = [];
  const heads: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    let head = '';
    let answered = false;
    socket.on('data', (chunk: Buffer) => {
      received.push(chunk);
      if (answered) return;
      head += chunk.toString('latin1');
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      answered = true;
      heads.push(head.slice(0, end));
      answer(socket);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  const proxy: FakeProxy = {
    url: `http://127.0.0.1:${String(port)}`,
    received,
    heads,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
  open.push(proxy);
  return proxy;
};

const refuse = (socket: Socket): void => {
  socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
};
const hangUp = (socket: Socket): void => {
  socket.destroy();
};
// Resets the connection instead of closing it, as a proxy that fails does.
const reset = (socket: Socket): void => {
  socket.resetAndDestroy();
};
const keepSilent = (): void => undefined;
// Gives the tunnel, then hangs up on the first bytes inside it.
const tunnelThenHangUp = (socket: Socket): void => {
  socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
  socket.once('data', () => {
    socket.destroy();
  });
};

const transportThrough = (
  proxy: string,
  limits: Partial<TransportLimits> = {},
): { transport: HttpTransport; lines: Line[] } => {
  const { logger, lines } = recordingLogger();
  const merged = { ...transportLimits, ...limits };
  const transport = createTransport(createProxyAgent(merged, proxy), {
    origin,
    token,
    userAgent,
    logger,
    clock,
    limits: merged,
  });
  open.push({ close: () => transport.destroy() });
  return { transport, lines };
};

const categoryOf = (call: Promise<unknown>): Promise<unknown> =>
  call.then(
    () => 'answered',
    (error: unknown) =>
      error instanceof HttpTransportError ? error.category : error,
  );

const everything = (proxy: FakeProxy): string =>
  Buffer.concat(proxy.received).toString('latin1');

describe('a transport through a proxy', () => {
  it('asks for a tunnel to the origin and sends the token through no clear text', async () => {
    const proxy = await startProxy(tunnelThenHangUp);
    const { transport } = transportThrough(proxy.url);
    // The proxy hangs up inside the tunnel, so the call fails; what
    // matters is what the proxy got.
    await categoryOf(
      transport.get(new URL(`${origin}/api/whoami`), { maxResponseBytes: 64 }),
    );
    expect(proxy.heads).toHaveLength(1);
    const [line, ...headers] = (proxy.heads[0] ?? '').split('\r\n');
    expect(line).toBe('CONNECT demo.example:443 HTTP/1.1');
    expect(headers.map((header) => header.toLowerCase())).toContain(
      'host: demo.example',
    );
    // No header with the token, no proxy-authorization, and nothing of
    // the token anywhere in the bytes, also not inside the tunnel, where
    // TLS starts with a ClientHello.
    const sent = everything(proxy);
    expect(sent.toLowerCase()).not.toContain('authorization');
    for (const core of canary.cores) expect(sent).not.toContain(core);
    const inside = Buffer.concat(proxy.received).subarray(
      (proxy.heads[0] ?? '').length + 4,
    );
    expect(inside[0]).toBe(0x16);
  });

  it('gives proxy and logs http_proxy when the proxy refuses the tunnel', async () => {
    const proxy = await startProxy(refuse);
    const { transport, lines } = transportThrough(proxy.url);
    expect(
      await categoryOf(
        transport.get(new URL(`${origin}/api`), { maxResponseBytes: 64 }),
      ),
    ).toBe('proxy');
    expect(lines.map((line) => line.event)).toEqual(['http_proxy']);
  });

  it('gives proxy when the proxy hangs up before it answers', async () => {
    const proxy = await startProxy(hangUp);
    const { transport } = transportThrough(proxy.url);
    expect(
      await categoryOf(
        transport.get(new URL(`${origin}/api`), { maxResponseBytes: 64 }),
      ),
    ).toBe('proxy');
  });

  it('gives timeout when the proxy takes the connection and stays silent', async () => {
    const proxy = await startProxy(keepSilent);
    // The answer to CONNECT gets the connect limit, not the limit for the
    // headers of an answer, which is five minutes for a model.
    const { transport } = transportThrough(proxy.url, {
      connectMs: 200,
      headersMs: 60_000,
      totalMs: 5_000,
    });
    expect(
      await categoryOf(
        transport.get(new URL(`${origin}/api`), { maxResponseBytes: 64 }),
      ),
    ).toBe('timeout');
  });

  it('asks for the next tunnel while the proxy still holds the first', async () => {
    const proxy = await startProxy(keepSilent);
    const { transport } = transportThrough(proxy.url, { totalMs: 2_000 });
    const calls = [1, 2].map(() =>
      categoryOf(
        transport.get(new URL(`${origin}/api`), { maxResponseBytes: 64 }),
      ),
    );
    await expect.poll(() => proxy.heads.length, { timeout: 1_000 }).toBe(2);
    expect(await Promise.all(calls)).toEqual(['timeout', 'timeout']);
  });

  it('ends the call at once when the caller aborts while it waits for the tunnel', async () => {
    const proxy = await startProxy(keepSilent);
    const { transport } = transportThrough(proxy.url);
    const controller = new AbortController();
    const call = categoryOf(
      transport.get(new URL(`${origin}/api`), {
        maxResponseBytes: 64,
        signal: controller.signal,
      }),
    );
    // Once the CONNECT is out.
    await expect.poll(() => proxy.heads.length).toBe(1);
    controller.abort();
    expect(await call).toBe('aborted');
  });

  it('refuses another origin before the proxy hears of it', async () => {
    const proxy = await startProxy(refuse);
    const { transport } = transportThrough(proxy.url);
    expect(
      await categoryOf(
        transport.get(new URL('https://other.example/api'), {
          maxResponseBytes: 64,
        }),
      ),
    ).toBe('refused');
    expect(proxy.received).toEqual([]);
  });
});

describe('the factories with a proxy', () => {
  it('build both transports through a checked proxy', async () => {
    const proxy = await startProxy(refuse);
    const { logger } = recordingLogger();
    const churchTools = createHttpTransport({
      origin,
      token,
      userAgent,
      logger,
      clock,
      proxy: proxy.url,
    });
    open.push({ close: () => churchTools.destroy() });
    const model = createModelHttpTransport({
      endpoint: 'https://model.example/v1/chat/completions',
      key: token,
      userAgent,
      logger,
      clock,
      proxy: proxy.url,
    });
    open.push({ close: () => model.destroy() });
    expect(
      await categoryOf(
        churchTools.get(new URL(`${origin}/api`), { maxResponseBytes: 64 }),
      ),
    ).toBe('proxy');
    expect(
      await categoryOf(
        model.post({
          maxResponseBytes: 64,
          body: new Uint8Array([0x7b, 0x7d]),
        }),
      ),
    ).toBe('proxy');
    expect(proxy.heads.map((head) => head.split('\r\n')[0])).toEqual([
      'CONNECT demo.example:443 HTTP/1.1',
      'CONNECT model.example:443 HTTP/1.1',
    ]);
  });

  // The path of the ping works like a secret (ADR 0009): the proxy learns
  // host and port from CONNECT, and the path goes only through the tunnel,
  // inside TLS.
  it('send the ping through a tunnel that names only host and port', async () => {
    const proxy = await startProxy(tunnelThenHangUp);
    const { logger, lines } = recordingLogger();
    const secretPath = canary.cores[1] ?? '';
    const ping = createPingHttpTransport({
      url: new Secret(`https://ping.example/ping/${secretPath}`),
      userAgent,
      logger,
      clock,
      proxy: proxy.url,
    });
    open.push({ close: () => ping.destroy() });
    await expect(ping.ping('fail', {})).rejects.toBeInstanceOf(
      HttpTransportError,
    );
    expect(proxy.heads.map((head) => head.split('\r\n')[0])).toEqual([
      'CONNECT ping.example:443 HTTP/1.1',
    ]);
    const sent = everything(proxy);
    expect(sent).not.toContain(secretPath);
    expect(sent).not.toContain('/fail');
    expect(sent.toLowerCase()).not.toContain('authorization');
    expect(JSON.stringify(lines)).not.toContain(secretPath);
  });

  it.each([
    'https://egress:3128',
    'http://egress',
    'http://user:secret@egress:3128',
    'socks5://egress:1080',
  ])('refuse the proxy %j before a pool exists', (proxy) => {
    const { logger } = recordingLogger();
    expect(() =>
      createHttpTransport({ origin, token, userAgent, logger, clock, proxy }),
    ).toThrow('The proxy of a transport must be canonical.');
    expect(() =>
      createModelHttpTransport({
        endpoint: 'https://model.example/v1/chat/completions',
        key: token,
        userAgent,
        logger,
        clock,
        proxy,
      }),
    ).toThrow('The proxy of a transport must be canonical.');
  });
});

describe('probeEgressProxy', () => {
  it('takes the limits of the transport', () => {
    expect(proxyProbeLimits).toEqual({
      connectMs: transportLimits.connectMs,
      answerMs: transportLimits.connectMs,
    });
    expect(Object.isFrozen(proxyProbeLimits)).toBe(true);
  });

  it('is fine when the proxy gives the tunnel, and sends nothing into it', async () => {
    const proxy = await startProxy((socket) => {
      socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
    });
    expect(await probeEgressProxy({ proxy: proxy.url, origin })).toEqual({
      ok: true,
    });
    const [line, ...headers] = (proxy.heads[0] ?? '').split('\r\n');
    expect(line).toBe('CONNECT demo.example:443 HTTP/1.1');
    // The same host header as the ProxyAgent of the transport sends.
    expect(headers.map((header) => header.toLowerCase())).toContain(
      'host: demo.example',
    );
    // Only the head of CONNECT, no byte of TLS behind it.
    expect(everything(proxy)).toBe(`${proxy.heads[0] ?? ''}\r\n\r\n`);
  });

  it('asks for the port of an origin that has one', async () => {
    const proxy = await startProxy((socket) => {
      socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
    });
    await probeEgressProxy({
      proxy: proxy.url,
      origin: 'https://demo.example:8443',
    });
    expect(proxy.heads[0]?.split('\r\n')[0]).toBe(
      'CONNECT demo.example:8443 HTTP/1.1',
    );
  });

  it('gives refused when the proxy answers with another status', async () => {
    const proxy = await startProxy(refuse);
    expect(await probeEgressProxy({ proxy: proxy.url, origin })).toEqual({
      ok: false,
      reason: 'refused',
    });
  });

  it('gives no_answer when the proxy hangs up, resets or stays silent', async () => {
    const closing = await startProxy(hangUp);
    expect(await probeEgressProxy({ proxy: closing.url, origin })).toEqual({
      ok: false,
      reason: 'no_answer',
    });
    const resetting = await startProxy(reset);
    expect(await probeEgressProxy({ proxy: resetting.url, origin })).toEqual({
      ok: false,
      reason: 'no_answer',
    });
    const silent = await startProxy(keepSilent);
    expect(
      await probeEgressProxy(
        { proxy: silent.url, origin },
        { connectMs: 1_000, answerMs: 200 },
      ),
    ).toEqual({ ok: false, reason: 'no_answer' });
  });

  it('gives unreachable when nobody listens on the port', async () => {
    const proxy = await startProxy(keepSilent);
    const url = proxy.url;
    await proxy.close();
    expect(await probeEgressProxy({ proxy: url, origin })).toEqual({
      ok: false,
      reason: 'unreachable',
    });
  });

  it.each([
    [{ proxy: 'http://egress', origin }],
    [{ proxy: 'http://egress:3128', origin: 'http://demo.example' }],
    [{ proxy: 'http://egress:3128', origin: 'https://demo.example/' }],
  ])('refuses %j before a socket opens', async (options) => {
    await expect(probeEgressProxy(options)).rejects.toThrow(
      'The proxy and the origin must be checked.',
    );
  });
});

describe('probeEgressTarget', () => {
  const target = { host: 'demo.example', port: 443 } as const;
  const given = (socket: Socket): void => {
    socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
  };

  it('is fine without TLS when the proxy gives the tunnel, and sends nothing into it', async () => {
    const proxy = await startProxy(given);
    expect(
      await probeEgressTarget({ proxy: proxy.url, ...target, tls: false }),
    ).toEqual({ ok: true });
    const [line, ...headers] = (proxy.heads[0] ?? '').split('\r\n');
    expect(line).toBe('CONNECT demo.example:443 HTTP/1.1');
    expect(headers.map((header) => header.toLowerCase())).toContain(
      'host: demo.example',
    );
    expect(everything(proxy)).toBe(`${proxy.heads[0] ?? ''}\r\n\r\n`);
  });

  it('asks for a port other than 443 with the port in the host header', async () => {
    const proxy = await startProxy(given);
    await probeEgressTarget({
      proxy: proxy.url,
      host: 'model.example',
      port: 8443,
      tls: false,
    });
    const [line, ...headers] = (proxy.heads[0] ?? '').split('\r\n');
    expect(line).toBe('CONNECT model.example:8443 HTTP/1.1');
    expect(headers.map((header) => header.toLowerCase())).toContain(
      'host: model.example:8443',
    );
  });

  it.each([403, 503])(
    'gives refused with the status %i of the answer',
    async (status) => {
      const proxy = await startProxy((socket) => {
        socket.end(
          `HTTP/1.1 ${String(status)} No\r\nContent-Length: 0\r\n\r\n`,
        );
      });
      expect(
        await probeEgressTarget({ proxy: proxy.url, ...target, tls: true }),
      ).toEqual({ ok: false, reason: 'refused', status });
    },
  );

  it('gives no_answer when the proxy hangs up, and unreachable when nobody listens', async () => {
    const closing = await startProxy(hangUp);
    expect(
      await probeEgressTarget({ proxy: closing.url, ...target, tls: true }),
    ).toEqual({ ok: false, reason: 'no_answer' });
    const gone = await startProxy(keepSilent);
    const url = gone.url;
    await gone.close();
    expect(
      await probeEgressTarget({ proxy: url, ...target, tls: true }),
    ).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('gives tls when the other end of the tunnel does not speak TLS, after a hello with the name of the target', async () => {
    const proxy = await startProxy(tunnelThenHangUp);
    expect(
      await probeEgressTarget({ proxy: proxy.url, ...target, tls: true }),
    ).toEqual({ ok: false, reason: 'tls' });
    const inside = Buffer.concat(proxy.received).subarray(
      (proxy.heads[0] ?? '').length + 4,
    );
    // A ClientHello, with the name of the target as SNI in clear text.
    expect(inside[0]).toBe(0x16);
    expect(inside.toString('latin1')).toContain('demo.example');
    expect(everything(proxy).toLowerCase()).not.toContain('authorization');
  });

  it('makes the handshake on the socket of the tunnel with the name of the target', async () => {
    const proxy = await startProxy(given);
    const calls: unknown[] = [];
    let destroyed = 0;
    expect(
      await probeEgressTarget(
        { proxy: proxy.url, ...target, tls: true },
        proxyProbeLimits,
        (options, callback) => {
          calls.push({
            ...options,
            httpSocket: options.httpSocket !== undefined,
          });
          const secured = new (class extends PassThrough {
            override destroy(error?: Error): this {
              destroyed += 1;
              return super.destroy(error);
            }
          })() as unknown as Socket;
          callback(null, secured);
        },
      ),
    ).toEqual({ ok: true });
    expect(calls).toEqual([
      {
        hostname: 'demo.example',
        protocol: 'https:',
        port: '443',
        servername: 'demo.example',
        httpSocket: true,
      },
    ]);
    expect(destroyed).toBe(1);
  });

  it('gives tls when the handshake fails or the connector throws', async () => {
    const proxy = await startProxy(given);
    expect(
      await probeEgressTarget(
        { proxy: proxy.url, ...target, tls: true },
        proxyProbeLimits,
        (_, callback) => {
          callback(
            Object.assign(new Error('x'), { code: 'CERT_HAS_EXPIRED' }),
            null,
          );
        },
      ),
    ).toEqual({ ok: false, reason: 'tls' });
    expect(
      await probeEgressTarget(
        { proxy: proxy.url, ...target, tls: true },
        proxyProbeLimits,
        () => {
          throw new Error('x');
        },
      ),
    ).toEqual({ ok: false, reason: 'tls' });
  });

  it.each([
    [{ proxy: 'http://egress', host: 'demo.example', port: 443, tls: true }],
    [{ proxy: 'http://egress:3128', host: '192.0.2.1', port: 443, tls: true }],
    [
      {
        proxy: 'http://egress:3128',
        host: 'Demo.example',
        port: 443,
        tls: true,
      },
    ],
    [{ proxy: 'http://egress:3128', host: 'localhost', port: 443, tls: true }],
    [
      {
        proxy: 'http://egress:3128',
        host: 'demo.example/x',
        port: 443,
        tls: true,
      },
    ],
    [{ proxy: 'http://egress:3128', host: 'demo.example', port: 0, tls: true }],
    [
      {
        proxy: 'http://egress:3128',
        host: 'demo.example',
        port: 1.5,
        tls: true,
      },
    ],
    [
      {
        proxy: 'http://egress:3128',
        host: 'demo.example',
        port: 70_000,
        tls: true,
      },
    ],
    [
      {
        proxy: 'http://egress:3128',
        host: 'demo.example',
        port: 443,
        tls: 'yes' as unknown as boolean,
      },
    ],
  ])('refuses %j before a socket opens', async (options) => {
    await expect(probeEgressTarget(options)).rejects.toThrow(
      'The proxy and the target must be checked.',
    );
  });
});

describe('isProbeTarget', () => {
  it('takes a name of the configuration with its port', () => {
    expect(isProbeTarget('demo.example', 443)).toBe(true);
    expect(isProbeTarget('ecclium-doctor.invalid', 443)).toBe(true);
    expect(isProbeTarget('model.example', 8443)).toBe(true);
  });

  it.each([
    ['192.0.2.1', 443],
    ['[2001:db8::1]', 443],
    ['demo.example', 443.5],
    ['demo.example', '443'],
    [42, 443],
    ['demo', 443],
  ])('refuses %j on port %j', (host, port) => {
    expect(isProbeTarget(host, port)).toBe(false);
  });
});
