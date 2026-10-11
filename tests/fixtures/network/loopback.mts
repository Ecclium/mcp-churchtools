// The counterpart of connects.mts: what the network guard must let through
// (ADR 0052). Only the proof in tests/support/no-network.test.mts runs it,
// in the same separate Vitest process, and expects every test to pass. The
// file imports nothing from the guard, so only the setup file of the
// workspace installs it.
//
// A connection to a closed port on loopback must reach the operating system
// and fail there, not at the guard. That needs no server, so it also runs
// in a sandbox that forbids binding. Round trips through a server run only
// where binding is allowed.
import dns from 'node:dns';
import net from 'node:net';
import { beforeAll, expect, it } from 'vitest';

// Errors of the operating system for a closed port or a sandbox.
const systemErrors: readonly string[] = [
  'ECONNREFUSED',
  'EPERM',
  'EACCES',
  'EADDRNOTAVAIL',
  'ENETUNREACH',
];

let canBind = false;

beforeAll(async () => {
  const server = net.createServer();
  canBind = await new Promise<boolean>((resolve) => {
    server.once('error', () => {
      resolve(false);
    });
    server.listen(0, '127.0.0.1', () => {
      resolve(true);
    });
  });
  server.close();
});

/** The code of the error a connection ends with. */
function failure(socket: net.Socket): Promise<unknown> {
  return new Promise((resolve) => {
    socket.once('error', (error) => {
      resolve(Reflect.get(error, 'code'));
    });
    socket.once('connect', () => {
      socket.destroy();
      resolve('connected');
    });
  });
}

/** Sends through a server on the address and reads its answer. */
async function roundTrip(address: string): Promise<string> {
  const server = net.createServer((socket) => {
    socket.end('ok');
  });
  await new Promise<void>((resolve) => {
    server.listen(0, address, resolve);
  });
  const port = (server.address() as net.AddressInfo).port;
  const answer = await new Promise<string>((resolve, reject) => {
    const socket = net.connect(port, address);
    let text = '';
    socket.on('data', (chunk: Buffer) => {
      text += chunk.toString();
    });
    socket.once('end', () => {
      resolve(text);
    });
    socket.once('error', reject);
  });
  server.close();
  return answer;
}

it('a closed port on 127.0.0.1 fails at the operating system', async () => {
  expect(systemErrors).toContain(await failure(net.connect(1, '127.0.0.1')));
});

it('a closed port on ::1 fails at the operating system', async () => {
  expect(systemErrors).toContain(await failure(net.connect(1, '::1')));
});

it('dns.lookup of an address literal', async () => {
  expect((await dns.promises.lookup('127.0.0.1')).address).toBe('127.0.0.1');
});

it('a round trip over 127.0.0.1', async ({ skip }) => {
  if (!canBind) skip();
  expect(await roundTrip('127.0.0.1')).toBe('ok');
});

it('a round trip over ::1', async ({ skip }) => {
  if (!canBind) skip();
  expect(await roundTrip('::1')).toBe('ok');
});
