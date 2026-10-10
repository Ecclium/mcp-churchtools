import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import dns from 'node:dns';
import net from 'node:net';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

import {
  blockedMarker,
  guardPreload,
  installNetworkGuard,
  loopbackProxyActive,
  withoutNetworkGuard,
} from './no-network.mts';

// The network guard of the tests (ADR 0052). Attempts that the guard must
// refuse never run in this process, where each one would fail the test.
// They run in Node.js child processes with the guard loaded.

const workspace = fileURLToPath(new URL('../../', import.meta.url));
const fixtures = 'tests/fixtures/network';
// Set for the Vitest runs of the fixtures, which never include this file;
// the check stops a run from starting itself should the fixtures change.
const proofChild = 'ECCLIUM_NETWORK_PROOF_CHILD';
// A child that catches the error of the guard and ends normally.
const catchingChild = [
  '-e',
  "try { require('node:net').connect(443, '192.0.2.1'); } catch {}",
];

describe('the network guard in the test process', () => {
  it('keeps its patches in place', () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      net.Socket.prototype,
      'connect',
    );
    expect(descriptor?.writable).toBe(false);
    expect(descriptor?.configurable).toBe(false);
    expect(() => vi.spyOn(net.Socket.prototype, 'connect')).toThrow();
    expect(() => {
      Object.defineProperty(net.Socket.prototype, 'connect', {
        value: () => undefined,
      });
    }).toThrow(TypeError);
  });

  it('is installed once per process', () => {
    expect(installNetworkGuard()).toBe(installNetworkGuard());
    expect(installNetworkGuard().patches.length).toBeGreaterThan(20);
  });

  it('keeps the result fields that util.promisify uses for dns.lookup', async () => {
    expect(await promisify(dns.lookup)('127.0.0.1')).toEqual({
      address: '127.0.0.1',
      family: 4,
    });
  });

  it.each([
    [{}, '', false],
    [
      { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:3128' },
      '',
      true,
    ],
    [{ NODE_USE_ENV_PROXY: '1', https_proxy: 'http://[::1]:3128' }, '', true],
    [{ NODE_USE_ENV_PROXY: '1', HTTP_PROXY: '127.0.0.1:3128' }, '', true],
    [{ HTTPS_PROXY: 'http://127.0.0.1:3128' }, '--use-env-proxy', true],
    [{ HTTPS_PROXY: 'http://127.0.0.1:3128' }, '', false],
    [
      { NODE_USE_ENV_PROXY: '0', HTTPS_PROXY: 'http://127.0.0.1:3128' },
      '',
      false,
    ],
    [
      { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://proxy.example.org:3128' },
      '',
      false,
    ],
    [
      {
        NODE_USE_ENV_PROXY: '1',
        HTTPS_PROXY: 'http://proxy.example.org:3128',
        NO_PROXY: '127.0.0.1',
        no_proxy: '[::1]',
      },
      '',
      false,
    ],
  ])('tells a proxy on loopback from %j with %j', (env, flags, expected) => {
    expect(loopbackProxyActive(env, flags)).toBe(expected);
  });

  it('gives a child process an environment without the guard on request', () => {
    expect(
      withoutNetworkGuard({ NODE_OPTIONS: `--trace-warnings ${guardPreload}` }),
    ).toEqual({ NODE_OPTIONS: '--trace-warnings' });
    expect(withoutNetworkGuard({ NODE_OPTIONS: guardPreload, A: '1' })).toEqual(
      {
        A: '1',
      },
    );
  });
});

describe.skipIf(process.env[proofChild] === '1')('the proof', () => {
  it('loads the guard into a Node.js child process through NODE_OPTIONS', () => {
    const child = spawnSync(process.execPath, catchingChild, {
      encoding: 'utf8',
      env: { ...withoutNetworkGuard(process.env), NODE_OPTIONS: guardPreload },
      timeout: 30_000,
    });
    expect(child.status, child.stderr).toBe(70);
    expect(child.stderr).toContain(blockedMarker);
  });

  it('refuses and blocks every way out of a Node.js process and lets loopback through', () => {
    const canary = `canary-${randomBytes(12).toString('hex')}`;
    const result = spawnSync(
      process.execPath,
      [guardPreload, join(workspace, fixtures, 'attempts.mts'), canary],
      {
        cwd: workspace,
        encoding: 'utf8',
        env: withoutNetworkGuard(process.env),
        timeout: 60_000,
      },
    );
    // Code 70: the process caught every error, the guard still reports it.
    // Checked first, so that a crash or a timeout shows its own cause.
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(70);
    expect(result.stderr).toContain(blockedMarker);
    expect(result.stdout + result.stderr).not.toContain(canary);

    const cases = result.stdout
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            name: string;
            expected: 'refused' | 'allowed';
            refused: boolean;
            blocked: boolean;
            message: string | null;
          },
      );
    const names = cases.map((item) => item.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(40);
    for (const item of cases) {
      expect(item.refused, item.name).toBe(item.expected === 'refused');
      // Recorded is not enough: the operation must fail with the error of
      // the guard. A WebSocket reports an error event without its cause.
      if (item.expected === 'refused' && item.name !== 'WebSocket to a name') {
        expect(item.blocked, item.name).toBe(true);
      }
    }
    // Branches that another branch could hide.
    const messages = new Map(cases.map((item) => [item.name, item.message]));
    expect(messages.get('net.connect to a local socket')).toMatch(
      /lokalen Socket/,
    );
    expect(messages.get('net.connect without a host')).toMatch(/localhost:443/);
    expect(messages.get('a server from options with an empty path')).toMatch(
      /allen Schnittstellen/,
    );
    expect(messages.get('dns.reverse of an address')).toMatch(/reverse/);
  });
});
