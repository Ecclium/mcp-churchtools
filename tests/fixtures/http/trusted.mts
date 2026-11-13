// Runs in its own Vitest process, started by tests/http-transport-tls.test.mts
// with NODE_EXTRA_CA_CERTS naming both certificates of the parent test:
// a for the origin demo.example, b for other.example. Node.js reads that
// variable only when the process starts.
import { subscribe, unsubscribe } from 'node:diagnostics_channel';

import { describe, expect, it } from 'vitest';

import { probeEgressTarget } from '../../../packages/core/src/http/proxy-probe.ts';
import {
  canary,
  origin,
  startTunnelProxy,
  throughProxy,
  throughServer,
  userAgent,
} from './server.mts';

const target = (path: string): URL => new URL(`${origin}${path}`);

const categoryOf = (call: Promise<unknown>): Promise<unknown> =>
  call.then(
    () => 'answered',
    (error: unknown) => (error as { category?: unknown }).category,
  );

describe('a transport against a trusted certificate', () => {
  it('answers over TLS and HTTP/1.1 for the name of the origin', async () => {
    const agents: (string | undefined)[] = [];
    const codings: (string | undefined)[] = [];
    const { transport, seen } = throughServer('a', (request, response) => {
      agents.push(request.headers['user-agent']);
      codings.push(request.headers['accept-encoding']);
      response.end('ok');
    });
    const answer = await transport.get(target('/api/whoami'), {
      maxResponseBytes: 64,
    });
    expect(answer.status).toBe(200);
    expect(new TextDecoder().decode(answer.body)).toBe('ok');
    expect(seen.alpn).toBe('http/1.1');
    expect(agents).toEqual([userAgent]);
    expect(codings).toEqual(['identity']);
    await transport.close();
  });

  it('refuses a trusted certificate for another name', async () => {
    const { transport } = throughServer('b', (_, response) => {
      response.end('never');
    });
    expect(
      await categoryOf(transport.get(target('/api'), { maxResponseBytes: 64 })),
    ).toBe('tls');
    await transport.close();
  });

  it('gives timeout when the headers of the answer do not come', async () => {
    const { transport } = throughServer('a', () => undefined, {
      headersMs: 1_000,
    });
    expect(
      await categoryOf(transport.get(target('/api'), { maxResponseBytes: 64 })),
    ).toBe('timeout');
    await transport.destroy();
  });

  it('gives timeout when the body pauses', async () => {
    const { transport } = throughServer(
      'a',
      (_, response) => {
        response.writeHead(200, { 'content-length': '10' });
        response.write('12345');
      },
      { bodyMs: 1_000 },
    );
    expect(
      await categoryOf(transport.get(target('/api'), { maxResponseBytes: 64 })),
    ).toBe('timeout');
    await transport.destroy();
  });

  it('gives interrupted when the server breaks off the body', async () => {
    const { transport } = throughServer('a', (_, response) => {
      response.writeHead(200, { 'content-length': '10' });
      response.write('12345', () => {
        response.socket?.destroy();
      });
    });
    expect(
      await categoryOf(transport.get(target('/api'), { maxResponseBytes: 64 })),
    ).toBe('interrupted');
    await transport.destroy();
  });

  // The call would take the body; only the limit of the pool refuses it.
  it('gives too_large when the pool refuses a body above its limit', async () => {
    const { transport } = throughServer(
      'a',
      (_, response) => {
        response.end('x'.repeat(4_096));
      },
      {},
      { maxResponseBytes: 1_024 },
    );
    expect(
      await categoryOf(
        transport.get(target('/api'), { maxResponseBytes: 8_192 }),
      ),
    ).toBe('too_large');
    await transport.destroy();
  });

  // undici emits an error on a body that has fully arrived when it is
  // destroyed. Without a listener the process would end; the parent sees
  // that in the exit status.
  it.each([
    ['redirect', 302, {}, 'moved'],
    ['redirect', 302, { 'content-length': '0' }, ''],
    ['redirect', 304, {}, ''],
    ['status', 600, {}, 'x'],
    ['encoding', 200, { 'content-encoding': 'gzip' }, 'abc'],
  ])(
    'gives %s for status %i with a body that has arrived, and goes on',
    async (category, status, headers, body) => {
      const { transport } = throughServer(
        'a',
        (request, response) => {
          if (request.url === '/refused') {
            response.writeHead(status, headers);
            response.end(body);
          } else {
            response.end('ok');
          }
        },
        { connections: 1 },
      );
      expect(
        await categoryOf(
          transport.get(target('/refused'), { maxResponseBytes: 64 }),
        ),
      ).toBe(category);
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      const answer = await transport.get(target('/api'), {
        maxResponseBytes: 64,
      });
      expect(answer.status).toBe(200);
      await transport.close();
    },
  );

  it('frees its only connection after an answer it refuses', async () => {
    const { transport } = throughServer(
      'a',
      (request, response) => {
        if (request.url === '/moved') {
          response.writeHead(302, { location: 'https://other.example/' });
          response.end('x'.repeat(1_048_576));
        } else {
          response.end('ok');
        }
      },
      { connections: 1, bodyMs: 2_000 },
    );
    expect(
      await categoryOf(
        transport.get(target('/moved'), { maxResponseBytes: 64 }),
      ),
    ).toBe('redirect');
    for (let index = 0; index < 3; index += 1) {
      const answer = await transport.get(target('/api'), {
        maxResponseBytes: 64,
      });
      expect(answer.status).toBe(200);
    }
    await transport.close();
  });

  // A connection that closes while a write waits for its answer fails that
  // write, and undici sends again only requests it has not yet written, so
  // the server sees the write once. The category is connect, as for any
  // socket that breaks before the headers: for a write it does not show
  // that nothing arrived, only refused does (ADR 0072).
  it('sends a write once when the server closes the connection before it answers', async () => {
    const writes: string[] = [];
    const { transport } = throughServer('a', (request, response) => {
      if (request.method !== 'POST') {
        response.end('ok');
        return;
      }
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      request.on('end', () => {
        writes.push(Buffer.concat(chunks).toString('utf8'));
        response.socket?.destroy();
      });
    });
    expect(
      await categoryOf(
        transport.post(target('/api/wiki/categories/1/pages'), {
          body: new TextEncoder().encode('{"text":"once"}'),
          maxResponseBytes: 64,
        }),
      ),
    ).toBe('connect');
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
    const answer = await transport.get(target('/api'), {
      maxResponseBytes: 64,
    });
    expect(answer.status).toBe(200);
    expect(writes).toEqual(['{"text":"once"}']);
    await transport.close();
  });

  // The rule [arch:diagnostics] keeps the packages away from these channels,
  // because undici publishes the whole request there. This case shows that
  // it still does, so that a change in undici becomes visible.
  it('lets undici publish the Authorization header on a diagnostics channel', async () => {
    const seen: string[] = [];
    const listener = (message: unknown): void => {
      seen.push(String((message as { headers?: unknown }).headers));
    };
    subscribe('undici:client:sendHeaders', listener);
    try {
      const { transport } = throughServer('a', (_, response) => {
        response.end('ok');
      });
      await transport.get(target('/api'), { maxResponseBytes: 64 });
      await transport.close();
    } finally {
      unsubscribe('undici:client:sendHeaders', listener);
    }
    expect(seen.join('\n')).toContain(`authorization: Login ${canary.value}`);
  });
});

// Through a proxy (ADR 0035): the tunnel carries TLS to the origin, so
// the proxy sees the host and the port, never the token, and the name of
// the origin is checked against the certificate as without a proxy.
describe('a transport through a proxy', () => {
  it('answers through a tunnel, and the proxy sees no token', async () => {
    const { transport, proxy, close } = await throughProxy(
      'a',
      (_, response) => {
        response.end('ok');
      },
    );
    const answer = await transport.get(target('/api/whoami'), {
      maxResponseBytes: 64,
    });
    expect(answer.status).toBe(200);
    expect(new TextDecoder().decode(answer.body)).toBe('ok');
    expect(proxy.heads.map((head) => head.split('\r\n')[0])).toEqual([
      'CONNECT demo.example:443 HTTP/1.1',
    ]);
    const seen = Buffer.concat(proxy.bytes).toString('latin1');
    for (const core of canary.cores) expect(seen).not.toContain(core);
    expect(seen.toLowerCase()).not.toContain('authorization');
    await transport.close();
    await close();
  });

  it('refuses a trusted certificate for another name inside the tunnel', async () => {
    const { transport, close } = await throughProxy('b', (_, response) => {
      response.end('never');
    });
    expect(
      await categoryOf(transport.get(target('/api'), { maxResponseBytes: 64 })),
    ).toBe('tls');
    await transport.destroy();
    await close();
  });
});

// The check of a target by ecclium doctor (ADR 0035): a TLS handshake
// inside the tunnel with the name of the target, and no request.
describe('a check of a target through a proxy', () => {
  it('passes the handshake for the name of the target and sends no request', async () => {
    let requests = 0;
    const { url, proxy, close } = await startTunnelProxy('a', (_, response) => {
      requests += 1;
      response.end('never');
    });
    expect(
      await probeEgressTarget({
        proxy: url,
        host: 'demo.example',
        port: 443,
        tls: true,
      }),
    ).toEqual({ ok: true });
    expect(proxy.heads.map((head) => head.split('\r\n')[0])).toEqual([
      'CONNECT demo.example:443 HTTP/1.1',
    ]);
    expect(requests).toBe(0);
    await close();
  });

  it('gives tls for a trusted certificate for another name', async () => {
    const { url, close } = await startTunnelProxy('b', (_, response) => {
      response.end('never');
    });
    expect(
      await probeEgressTarget({
        proxy: url,
        host: 'demo.example',
        port: 443,
        tls: true,
      }),
    ).toEqual({ ok: false, reason: 'tls' });
    await close();
  });
});
