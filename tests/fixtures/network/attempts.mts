// Tries every way out of a Node.js process and every allowed way, with the
// network guard loaded through --import or NODE_OPTIONS (ADR 0052). Only the
// test of the guard starts this script, never Vitest itself:
//
//   node --import <no-network.mts> attempts.mts <canary>
//
// The script does not install the guard itself, so it ends with code 3 when
// the preload did not install it. Each case catches its error. The script
// prints one JSON line per case: { name, expected, refused, blocked,
// message }. refused tells whether the guard recorded an attempt, blocked
// whether the operation failed with the error of the guard, message is the
// last message of the guard. The canary goes into an Authorization header
// and into the path of a socket, and must never appear in any message.
// Hosts are placeholders only: example.org, 192.0.2.1 and 2001:db8::1 are
// for documentation (RFC 2606, RFC 5737, RFC 3849).
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import process from 'node:process';
import tls from 'node:tls';
import { Worker } from 'node:worker_threads';

import { blockedCode, currentNetworkGuard } from '../../support/no-network.mts';

const canary = process.argv[2] ?? 'no-canary';
const headers = { authorization: `Bearer ${canary}` };
const found = currentNetworkGuard();
if (found === undefined) {
  process.stderr.write('The network guard is not installed in this process.\n');
  process.exit(3);
}
const guard = found;

interface Case {
  readonly name: string;
  readonly expected: 'refused' | 'allowed';
  readonly run: () => unknown;
}

/**
 * Waits until the socket or request ends, fails or closes, at most 2 s, and
 * returns the error it failed with.
 */
function settled(emitter: NodeJS.EventEmitter): Promise<unknown> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    const done = (error?: unknown): void => {
      clearTimeout(timer);
      resolve(error instanceof Error ? error : undefined);
    };
    for (const event of [
      'error',
      'close',
      'connect',
      'response',
      'listening',
    ]) {
      emitter.once(event, done);
    }
  });
}

/** Closes what a case opened, if it opened anything. */
function closed(thing: { close?: () => void; destroy?: () => void }): void {
  thing.destroy?.();
  thing.close?.();
}

/** Calls a method with arguments its types do not allow. */
function callLoosely(
  target: object,
  key: string,
  args: readonly unknown[],
): unknown {
  return Reflect.apply(
    Reflect.get(target, key) as () => unknown,
    target,
    args,
  ) as unknown;
}

/** A server that listens with the given arguments, closed afterwards. */
function listening(...args: readonly unknown[]): Promise<unknown> {
  const server = net.createServer();
  try {
    callLoosely(server, 'listen', args);
  } catch (error) {
    closed(server);
    throw error;
  }
  return settled(server).finally(() => {
    closed(server);
  });
}

const cases: readonly Case[] = [
  {
    name: 'fetch to a name',
    expected: 'refused',
    run: () => fetch('https://example.org/', { headers }),
  },
  {
    name: 'https.get to a name',
    expected: 'refused',
    run: () => settled(https.get('https://example.org/', { headers })),
  },
  {
    name: 'https.get with a lookup that answers an address',
    expected: 'refused',
    run: () =>
      settled(
        https.get('https://example.org/', {
          headers,
          lookup: (_host, _options, callback) => {
            callback(null, '192.0.2.1', 4);
          },
        }),
      ),
  },
  {
    name: 'http2.connect to a name',
    expected: 'refused',
    run: () => {
      const session = http2.connect('https://example.org');
      return settled(session).finally(() => {
        closed(session);
      });
    },
  },
  {
    name: 'tls.connect to a name',
    expected: 'refused',
    run: () => settled(tls.connect(443, 'example.org')),
  },
  {
    name: 'net.connect to an IPv4 address',
    expected: 'refused',
    run: () => settled(net.connect(443, '192.0.2.1')),
  },
  {
    name: 'net.connect to an IPv6 address',
    expected: 'refused',
    run: () => settled(net.connect({ host: '2001:db8::1', port: 443 })),
  },
  {
    name: 'net.connect to 127.0.0.2',
    expected: 'refused',
    run: () => settled(net.connect(443, '127.0.0.2')),
  },
  {
    name: 'net.connect to an IPv4-mapped loopback address',
    expected: 'refused',
    run: () => settled(net.connect(443, '::ffff:127.0.0.1')),
  },
  {
    name: 'net.connect to localhost',
    expected: 'refused',
    run: () => settled(net.connect(443, 'localhost')),
  },
  {
    name: 'net.connect without a host',
    expected: 'refused',
    run: () => settled(net.connect(443)),
  },
  {
    name: 'net.connect to a local socket',
    expected: 'refused',
    run: () =>
      settled(
        net.connect({ host: '127.0.0.1', path: `/nonexistent/${canary}.sock` }),
      ),
  },
  {
    name: 'WebSocket to a name',
    expected: 'refused',
    run: () =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000);
        const done = (): void => {
          clearTimeout(timer);
          resolve();
        };
        const socket = new WebSocket('wss://example.org/');
        socket.addEventListener('error', done);
        socket.addEventListener('close', done);
      }),
  },
  {
    name: 'dns.lookup of a name',
    expected: 'refused',
    run: () => {
      dns.lookup('example.org', () => undefined);
    },
  },
  {
    name: 'dns.promises.lookup of a name',
    expected: 'refused',
    run: () => dns.promises.lookup('example.org'),
  },
  {
    name: 'dns.resolve4 of a name',
    expected: 'refused',
    run: () => {
      dns.resolve4('example.org', () => undefined);
    },
  },
  {
    name: 'dns.reverse of an address',
    expected: 'refused',
    run: () => {
      dns.reverse('192.0.2.1', () => undefined);
    },
  },
  {
    name: 'a Resolver of dns',
    expected: 'refused',
    run: () => {
      new dns.Resolver().resolve4('example.org', () => undefined);
    },
  },
  {
    name: 'a Resolver of dns.promises',
    expected: 'refused',
    run: () => new dns.promises.Resolver().resolve4('example.org'),
  },
  {
    name: 'a UDP packet to an address',
    expected: 'refused',
    run: () => {
      const socket = dgram.createSocket('udp4');
      try {
        socket.send('x', 53, '192.0.2.1');
      } finally {
        socket.close();
      }
    },
  },
  {
    name: 'a UDP packet with offset and length',
    expected: 'refused',
    run: () => {
      const socket = dgram.createSocket('udp4');
      try {
        socket.send(Buffer.from('x'), 0, 1, 53, '192.0.2.1');
      } finally {
        socket.close();
      }
    },
  },
  {
    name: 'a UDP packet with an offset as a string',
    expected: 'refused',
    run: () => {
      const socket = dgram.createSocket('udp4');
      try {
        callLoosely(socket, 'send', [
          Buffer.from('x'),
          '0',
          1,
          53,
          '192.0.2.1',
        ]);
      } finally {
        socket.close();
      }
    },
  },
  {
    name: 'a UDP connection to an address',
    expected: 'refused',
    run: () => {
      const socket = dgram.createSocket('udp4');
      try {
        socket.connect(53, '192.0.2.1');
      } finally {
        socket.close();
      }
    },
  },
  {
    name: 'process.binding for TCP',
    expected: 'refused',
    run: () => callLoosely(process, 'binding', ['tcp_wrap']),
  },
  {
    name: 'process.binding for DNS',
    expected: 'refused',
    run: () => callLoosely(process, 'binding', ['cares_wrap']),
  },
  {
    name: 'a worker thread',
    expected: 'refused',
    run: () => new Worker('process.exit(0)', { eval: true }),
  },
  {
    name: 'the proxy from the environment',
    expected: 'refused',
    run: () => {
      http.setGlobalProxyFromEnv();
    },
  },
  {
    name: 'a server on every interface',
    expected: 'refused',
    run: () => listening(0),
  },
  {
    name: 'a server on 0.0.0.0',
    expected: 'refused',
    run: () => listening(0, '0.0.0.0'),
  },
  {
    name: 'a server from options without a host',
    expected: 'refused',
    run: () => listening({ port: 0 }),
  },
  {
    name: 'a server from options with an empty path',
    expected: 'refused',
    run: () => listening({ port: 0, path: null }),
  },
  {
    name: 'a server on the port "+0"',
    expected: 'refused',
    run: () => listening('+0'),
  },
  {
    name: 'net.connect to a closed port on 127.0.0.1',
    expected: 'allowed',
    run: () => settled(net.connect(1, '127.0.0.1')),
  },
  {
    name: 'net.connect to a closed port on ::1',
    expected: 'allowed',
    run: () => settled(net.connect(1, '::1')),
  },
  {
    name: 'net.connect with an empty path to 127.0.0.1',
    expected: 'allowed',
    run: () => settled(net.connect({ host: '127.0.0.1', port: 1, path: '' })),
  },
  {
    name: 'net.connect with a port in hexadecimal to 127.0.0.1',
    expected: 'allowed',
    run: () =>
      settled(
        callLoosely(new net.Socket(), 'connect', [
          '0x1',
          '127.0.0.1',
        ]) as net.Socket,
      ),
  },
  {
    name: 'dns.lookup of an address literal',
    expected: 'allowed',
    run: () => dns.promises.lookup('127.0.0.1'),
  },
  {
    name: 'a UDP packet to 127.0.0.1',
    expected: 'allowed',
    run: () =>
      new Promise<void>((resolve) => {
        // Bound to loopback, not implicitly to every interface. A sandbox
        // that forbids binding answers with an error event.
        const socket = dgram.createSocket('udp4');
        const done = (): void => {
          socket.close();
          resolve();
        };
        socket.once('error', done);
        socket.bind(0, '127.0.0.1', () => {
          socket.send('x', 9, '127.0.0.1', done);
        });
      }),
  },
  {
    name: 'a server on 127.0.0.1',
    expected: 'allowed',
    run: () => listening(0, '127.0.0.1'),
  },
  {
    name: 'a server from options on ::1',
    expected: 'allowed',
    run: () => listening({ port: 0, host: '::1' }),
  },
];

/** Whether an error, or its cause, is the error of the guard. */
function isBlocked(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if (Reflect.get(current, 'code') === blockedCode) {
      return true;
    }
  }
  return false;
}

for (const item of cases) {
  const before = guard.log.length;
  let error: unknown;
  try {
    const result = await item.run();
    if (result instanceof Error) {
      error = result;
    }
  } catch (caught) {
    error = caught;
  }
  // A failure that ends in an event, such as an error of fetch or a closed
  // WebSocket, may land a moment later.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const refused = guard.log.length > before;
  process.stdout.write(
    `${JSON.stringify({
      name: item.name,
      expected: item.expected,
      refused,
      blocked: isBlocked(error),
      message: refused ? guard.log.at(-1) : null,
    })}\n`,
  );
}
