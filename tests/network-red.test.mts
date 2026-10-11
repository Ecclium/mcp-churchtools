import { spawnSync } from 'node:child_process';
import net from 'node:net';
import process from 'node:process';
import { expect, it } from 'vitest';

import { withoutNetworkGuard } from './support/no-network.mts';

// Throwaway: this file lives only on a branch that is never merged. It shows
// that CI fails on a real connection, at both layers of ADR 0052. The first
// test connects from the test process and must fail at the guard, locally
// and in CI. The second connects from a child process without the guard; it
// passes on a machine with network and must fail in CI at the network
// namespace.

const host = 'github.com';

const child = `
import net from 'node:net';
const socket = net.connect({ host: '${host}', port: 443 });
socket.once('connect', () => {
  socket.destroy();
  console.log('verbunden');
});
socket.once('error', (error) => {
  console.error('gescheitert: ' + String(error.code));
  process.exitCode = 1;
});
`;

it('reaches github.com from the test process', async () => {
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host, port: 443 });
    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
    socket.once('error', reject);
  });
});

it('reaches github.com from a child process without the guard', () => {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', child],
    {
      encoding: 'utf8',
      env: withoutNetworkGuard(process.env),
      timeout: 20_000,
    },
  );
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
