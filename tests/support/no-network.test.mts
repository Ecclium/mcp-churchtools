import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import dns from 'node:dns';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import workspaceConfig from '../../vitest.config.mts';
import fixtureConfig from '../fixtures/network/vitest.config.mts';
import {
  blockedMarker,
  guardPreload,
  installNetworkGuard,
  loopbackProxyActive,
  proxyVariables,
  withoutNetworkGuard,
} from './no-network.mts';

// The network guard of the tests (ADR 0052). Attempts that the guard must
// refuse never run in this process, where each one would fail the test.
// They run in child processes: Node.js processes with the guard loaded, and
// separate Vitest runs over the fixtures in tests/fixtures/network/, which
// must fail with the message of the guard, so that a plain network outage
// cannot pass for the guard.

const workspace = fileURLToPath(new URL('../../', import.meta.url));
const fixtures = 'tests/fixtures/network';
// Set for the Vitest runs of the fixtures, which never include this file;
// the check stops a run from starting itself should the fixtures change.
const proofChild = 'ECCLIUM_NETWORK_PROOF_CHILD';
// Control sequences of a terminal, which a run may print around its errors.
const controlSequence = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`,
  'g',
);
// A child that catches the error of the guard and ends normally.
const catchingChild = [
  '-e',
  "try { require('node:net').connect(443, '192.0.2.1'); } catch {}",
];

describe('the network guard in the test process', () => {
  it('is the setup file of every test process', () => {
    expect(workspaceConfig.test?.setupFiles).toEqual([
      'tests/support/no-network.setup.mts',
    ]);
  });

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

  it('hands itself to Node.js child processes and removes the proxy variables', () => {
    expect((process.env['NODE_OPTIONS'] ?? '').split(/\s+/)).toContain(
      guardPreload,
    );
    const child = spawnSync(process.execPath, catchingChild, {
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(child.status, child.stderr).toBe(70);
    expect(child.stderr).toContain(blockedMarker);
    for (const name of [...proxyVariables, 'NODE_USE_ENV_PROXY']) {
      expect(process.env[name], name).toBeUndefined();
    }
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

  describe('separate Vitest runs of the fixtures', () => {
    interface Report {
      readonly testResults: readonly {
        readonly name: string;
        readonly status: string;
        readonly message: string;
        readonly assertionResults: readonly {
          readonly title: string;
          readonly status: string;
          readonly failureMessages: readonly string[];
        }[];
      }[];
    }

    interface Run {
      readonly status: number | null;
      readonly output: string;
      readonly report: Report;
    }

    let folder = '';
    let main: Run;
    let late: Run;
    let proxied: Run;

    /**
     * Runs the given fixtures in their own Vitest process, without the
     * preload, so that only the setup files of the workspace install the
     * guard. The report goes to a temporary folder, not into the workspace.
     */
    const runFixtures = (
      name: string,
      files: readonly string[],
      extra: Readonly<Record<string, string>>,
    ): Run => {
      const output = join(folder, `${name}.json`);
      const result = spawnSync(
        process.execPath,
        [
          join(workspace, 'node_modules/vitest/vitest.mjs'),
          'run',
          '--config',
          join(workspace, fixtures, 'vitest.config.mts'),
          '--reporter=default',
          '--reporter=json',
          '--outputFile.json',
          output,
          ...files.map((file) => `${fixtures}/${file}`),
        ],
        {
          cwd: workspace,
          encoding: 'utf8',
          // Without colors, as in the other tests that read the output of a
          // child: the proof reads the plain text of the uncaught errors.
          env: {
            ...withoutNetworkGuard(process.env),
            [proofChild]: '1',
            NO_COLOR: '1',
            FORCE_COLOR: undefined,
            ...extra,
          },
          timeout: 60_000,
        },
      );
      const text = `${result.stdout}\n${result.stderr}`.replace(
        controlSequence,
        '',
      );
      if (!existsSync(output)) {
        throw new Error(
          `The Vitest run '${name}' wrote no report (status ${String(result.status)}, signal ${String(result.signal)}, ${String(result.error)}):\n${text.slice(-3000)}`,
        );
      }
      return {
        status: result.status,
        output: text,
        report: JSON.parse(readFileSync(output, 'utf8')) as Report,
      };
    };

    beforeAll(() => {
      folder = mkdtempSync(join(tmpdir(), 'ecclium-network-proof-'));
      // Proxy variables without the switch of Node.js: the setup file must
      // remove them, and the guard must not stop the run for them.
      main = runFixtures(
        'main',
        ['connects.mts', 'environment.mts', 'hidden.mts', 'loopback.mts'],
        {
          HTTP_PROXY: 'http://proxy.example.org:3128',
          https_proxy: 'http://proxy.example.org:3128',
          NO_PROXY: '127.0.0.1',
        },
      );
      late = runFixtures('late', ['late-load.mts'], {});
      proxied = runFixtures('proxied', ['environment.mts'], {
        NODE_USE_ENV_PROXY: '1',
        HTTPS_PROXY: 'http://127.0.0.1:9',
      });
    }, 180_000);

    afterAll(() => {
      if (folder !== '') rmSync(folder, { recursive: true, force: true });
    });

    const file = (run: Run, name: string): Report['testResults'][number] => {
      const found = run.report.testResults.find((entry) =>
        entry.name.endsWith(`${fixtures}/${name}`),
      );
      if (found === undefined) throw new Error(`no result for ${name}`);
      return found;
    };

    it('run exactly the network fixtures with the setup files of the workspace', () => {
      expect(fixtureConfig.test?.include).toEqual(
        [
          'connects.mts',
          'environment.mts',
          'hidden.mts',
          'late-load.mts',
          'loopback.mts',
        ].map((name) => `${fixtures}/${name}`),
      );
      expect(fixtureConfig.test?.setupFiles).toEqual(
        workspaceConfig.test?.setupFiles,
      );
      expect(resolve(fixtureConfig.root ?? '')).toBe(resolve(workspace));
    });

    it('fail every test that tries a connection, with the message of the guard', () => {
      expect(main.status, main.output).toBe(1);
      const tests = file(main, 'connects.mts').assertionResults;
      expect(tests.map((test) => test.title)).toEqual([
        'fetch',
        'https.get',
        'https.get with its own lookup',
        'tls.connect',
        'net.connect to 192.0.2.1',
        'dns.lookup',
        'dns.promises.lookup',
        'a swallowed attempt',
      ]);
      for (const test of tests) {
        expect(test.status, test.title).toBe('failed');
        expect(test.failureMessages.join('\n'), test.title).toContain(
          blockedMarker,
        );
      }
    });

    it('fail the file for attempts that no single test reports', () => {
      const hidden = file(main, 'hidden.mts');
      // Vitest counts the error of the hook as the expected failure of a
      // test marked as failing, and the second attempt comes after the
      // hooks of its test, so both tests pass on their own.
      expect(hidden.assertionResults.map((test) => test.status)).toEqual([
        'passed',
        'passed',
      ]);
      expect(hidden.status).toBe('failed');
      expect(hidden.message).toContain(`${blockedMarker}: 2 Versuche`);
    });

    it('remove the proxy variables and hand the guard to child processes', () => {
      const environment = file(main, 'environment.mts');
      expect(environment.status, environment.message).toBe('passed');
      expect(environment.assertionResults.map((test) => test.status)).toEqual([
        'passed',
        'passed',
      ]);
    });

    it('let every connection to loopback through', () => {
      const loopback = file(main, 'loopback.mts');
      expect(loopback.status).toBe('passed');
      const passed = loopback.assertionResults.filter(
        (test) => test.status === 'passed',
      );
      // The round trips need a server and are skipped where binding is
      // forbidden; the other three run everywhere.
      expect(passed.length).toBeGreaterThanOrEqual(3);
    });

    it('fail the run for an attempt that no hook of a test sees', () => {
      // The attempt comes while the file loads, and the only test of the
      // file is skipped, so no hook of a test or of the file runs. The guard
      // reports it as an uncaught error, and no test fails.
      expect(file(late, 'late-load.mts').status).not.toBe('failed');
      expect(late.status, JSON.stringify(late.output)).toBe(1);
      expect(late.output).toContain(`NetworkBlockedError: ${blockedMarker}`);
      expect(late.output).toContain('late-load.mts');
    });

    it('stop a run that follows a proxy on loopback before the first test', () => {
      expect(proxied.status, proxied.output).toBe(1);
      const environment = file(proxied, 'environment.mts');
      expect(environment.status).toBe('failed');
      expect(environment.message).toContain('Proxy auf Loopback');
    });
  });
});
