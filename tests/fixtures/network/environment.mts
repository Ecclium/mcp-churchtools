// What the setup file does to a test process (ADR 0052). Only the proof in
// tests/support/no-network.test.mts runs this file, in a separate Vitest
// process whose environment names proxies, and expects every test to pass.
// The file imports nothing from the guard, so only the setup file of the
// workspace acts here.
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { expect, it } from 'vitest';

it('sees no proxy variables', () => {
  for (const name of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
    'NODE_USE_ENV_PROXY',
  ]) {
    expect(process.env[name], name).toBeUndefined();
  }
});

it('hands the guard to a Node.js child process', () => {
  // The child catches the error; the guard still ends it with code 70.
  const result = spawnSync(
    process.execPath,
    ['-e', "try { require('node:net').connect(443, '192.0.2.1'); } catch {}"],
    { encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(70);
  expect(result.stderr).toContain('Netzzugriff im Test gesperrt (ADR 0052)');
});
