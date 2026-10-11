// Tests that try a real connection, written as a careless test would be
// (ADR 0052). They lie outside the include pattern of Vitest. Only the proof
// in tests/support/no-network.test.mts runs them, in a separate Vitest
// process, and expects every one of them to fail with the message of the
// network guard. Hosts are placeholders for documentation only.
import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { expect, it } from 'vitest';

/** Resolves when the socket connects, rejects when it fails. */
function opened(socket: net.Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
    socket.once('error', reject);
  });
}

it('fetch', async () => {
  const response = await fetch('https://example.org/');
  expect(response.ok).toBe(true);
});

it('https.get', async () => {
  await new Promise((resolve, reject) => {
    https.get('https://example.org/', resolve).once('error', reject);
  });
});

it('https.get with its own lookup', async () => {
  // A lookup that answers an address on its own, past dns.lookup.
  await new Promise((resolve, reject) => {
    https
      .get(
        'https://example.org/',
        {
          lookup: (_host, _options, callback) => {
            callback(null, '192.0.2.1', 4);
          },
        },
        resolve,
      )
      .once('error', reject);
  });
});

it('tls.connect', async () => {
  await opened(tls.connect(443, 'example.org'));
});

it('net.connect to 192.0.2.1', async () => {
  await opened(net.connect(443, '192.0.2.1'));
});

it('dns.lookup', async () => {
  await new Promise((resolve, reject) => {
    dns.lookup('example.org', (error, address) => {
      if (error) {
        reject(error);
      } else {
        resolve(address);
      }
    });
  });
});

it('dns.promises.lookup', async () => {
  await dns.promises.lookup('example.org');
});

it('a swallowed attempt', async () => {
  try {
    await fetch('https://example.org/');
  } catch {
    // A careless test that hides the failure.
  }
});
