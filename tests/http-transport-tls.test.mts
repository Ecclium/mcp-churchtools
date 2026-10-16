import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { makeCanary } from '@ecclium/mcp-churchtools-testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withoutNetworkGuard } from './support/no-network.mts';

// The HTTP transport against a TLS server in memory (ADR 0056). Node.js
// reads NODE_EXTRA_CA_CERTS and NODE_TLS_REJECT_UNAUTHORIZED only when a
// process starts, so each case of trust runs in its own Vitest process
// over the fixtures in tests/fixtures/http/, with the network guard of the
// workspace. openssl makes the certificates here, in a temporary folder,
// before any child starts; no certificate lies in the repository.

const workspace = fileURLToPath(new URL('../', import.meta.url));
const fixtures = 'tests/fixtures/http';
const canary = makeCanary('token');

interface Report {
  readonly numPassedTests: number;
  readonly numFailedTests: number;
  readonly numPendingTests: number;
  readonly numTodoTests: number;
}

// An openssl that can add a subjectAltName. macOS brings LibreSSL under
// /usr/bin, Homebrew a current OpenSSL.
const findOpenssl = (): string => {
  for (const candidate of [
    'openssl',
    '/opt/homebrew/bin/openssl',
    '/usr/local/bin/openssl',
    '/usr/bin/openssl',
  ]) {
    const help = spawnSync(candidate, ['req', '-help'], { encoding: 'utf8' });
    if (`${help.stdout}${help.stderr}`.includes('-addext')) return candidate;
  }
  throw new Error(
    'No openssl with -addext found; install OpenSSL 1.1.1 or newer.',
  );
};

let folder = '';
const runs = new Map<
  string,
  { status: number | null; report: Report; text: string }
>();

const runFixture = (
  name: string,
  file: string,
  extra: Readonly<Record<string, string>>,
): void => {
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
      `${fixtures}/${file}`,
    ],
    {
      cwd: workspace,
      encoding: 'utf8',
      env: {
        ...withoutNetworkGuard(process.env),
        NO_COLOR: '1',
        FORCE_COLOR: undefined,
        HTTP_FIXTURE_DIR: folder,
        HTTP_FIXTURE_TOKEN: canary.value,
        HTTP_FIXTURE_CORES: canary.cores.join(','),
        ...extra,
      },
      timeout: 90_000,
    },
  );
  const text = `${result.stdout}\n${result.stderr}`;
  if (!existsSync(output)) {
    throw new Error(`The run ${name} wrote no report:\n${text.slice(-3000)}`);
  }
  runs.set(name, {
    status: result.status,
    report: JSON.parse(readFileSync(output, 'utf8')) as Report,
    text,
  });
};

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), 'ecclium-tls-'));
  const openssl = findOpenssl();
  for (const [name, host] of [
    ['a', 'demo.example'],
    ['b', 'other.example'],
  ] as const) {
    const made = spawnSync(
      openssl,
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-days',
        '1',
        '-subj',
        `/CN=${host}`,
        '-addext',
        `subjectAltName=DNS:${host}`,
        '-keyout',
        join(folder, `${name}.key`),
        '-out',
        join(folder, `${name}.crt`),
      ],
      { encoding: 'utf8' },
    );
    if (made.status !== 0) throw new Error(`openssl failed: ${made.stderr}`);
  }
  writeFileSync(
    join(folder, 'trusted.pem'),
    readFileSync(join(folder, 'a.crt'), 'utf8') +
      readFileSync(join(folder, 'b.crt'), 'utf8'),
  );
  runFixture('untrusted', 'untrusted.mts', {});
  runFixture('untrusted with the check switched off', 'untrusted.mts', {
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
  });
  runFixture('trusted', 'trusted.mts', {
    NODE_EXTRA_CA_CERTS: join(folder, 'trusted.pem'),
  });
}, 300_000);

afterAll(() => {
  if (folder !== '') rmSync(folder, { recursive: true, force: true });
});

describe('the HTTP transport over TLS', () => {
  it.each([
    ['untrusted', 1],
    ['untrusted with the check switched off', 1],
    ['trusted', 13],
  ] as const)('passes every case of the run %s', (name, count) => {
    const run = runs.get(name);
    expect(run, name).toBeDefined();
    if (run === undefined) return;
    expect(run.report.numFailedTests, run.text.slice(-3000)).toBe(0);
    expect(run.report.numPassedTests).toBe(count);
    expect(run.report.numPendingTests + run.report.numTodoTests).toBe(0);
    expect(run.status).toBe(0);
  });
});
