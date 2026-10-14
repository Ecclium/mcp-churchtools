import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  assertNoCanary,
  findCanaries,
  makeCanary,
} from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it } from 'vitest';

// The output paths of Node.js itself print a value without the custom
// inspect hook of a Secret: the printer for an uncaught error, an unhandled
// 'error' event and console.dir with customInspect off. Only because the
// value lives in a private field does it stay out of them (ADR 0054). Each
// path runs twice, each time in its own child process: with a careless
// secret, which must leak there, so that the path is shown to print a
// secret at all, and with a Secret, which must not. An unhandled rejection
// is not among them: Node.js prints an object given as its reason only as
// #<Object>, so it shows nothing about a secret. The processes start from
// source, with the network guard inherited through NODE_OPTIONS. Package
// tests cannot start child processes, so this test lives here.

const fixture = fileURLToPath(
  new URL('fixtures/secret/output.mts', import.meta.url),
);

const run = (mode: string, value: string, form = '') =>
  spawnSync(process.execPath, [fixture, mode, value, form], {
    encoding: 'utf8',
    timeout: 30_000,
  });

describe('a secret in the output of Node.js itself', () => {
  it.each([
    'throw',
    'throw-cause',
    'throw-object',
    'aggregate',
    'timer',
    'emitter',
  ])('stays hidden when the process ends with %s', (mode) => {
    const canary = makeCanary('token');
    const naive = run(mode, canary.value, 'naive');
    expect(naive.status).not.toBe(0);
    expect(
      findCanaries(`${naive.stdout}${naive.stderr}`, [canary]).length,
    ).toBeGreaterThan(0);
    const child = run(mode, canary.value);
    expect(child.error).toBeUndefined();
    expect(child.status).not.toBe(0);
    // Node.js prints the secret itself, without its inspect hook. Seeing it
    // shows that the process got to the point where it fails.
    expect(child.stderr).toContain('Secret {}');
    assertNoCanary(`${child.stdout}${child.stderr}`, [canary], mode);
  });

  it.each(['console', 'warning'])('stays hidden in %s', (mode) => {
    const canary = makeCanary('token');
    const naive = run(mode, canary.value, 'naive');
    expect(
      findCanaries(`${naive.stdout}${naive.stderr}`, [canary]).length,
    ).toBeGreaterThan(0);
    const child = run(mode, canary.value);
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(`${child.stdout}${child.stderr}`).toContain('[REDACTED]');
    assertNoCanary(`${child.stdout}${child.stderr}`, [canary], mode);
  });
});
