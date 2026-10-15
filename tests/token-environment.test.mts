import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { tokenVariableName } from '@ecclium/mcp-churchtools-core';
import { makeCanary } from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it } from 'vitest';

// The command line takes the token out of process.env before anything
// else, so that a child process it starts never sees it (ADR 0055). Only a
// real process shows that deleting a key of process.env reaches the
// environment of a child, and package tests cannot start child processes,
// so this test lives here.

const fixture = fileURLToPath(
  new URL('fixtures/config/take-environment.mts', import.meta.url),
);

const kept = 'ECCLIUM_READ_ONLY';

const start = (mode: 'take' | 'keep') => {
  const canary = makeCanary('token').value;
  const result = spawnSync(
    process.execPath,
    [fixture, mode, tokenVariableName, kept],
    {
      encoding: 'utf8',
      // Only these variables: the shell that runs the tests may hold its
      // own with the same prefix.
      env: {
        [tokenVariableName]: canary,
        [tokenVariableName.toLowerCase()]: canary,
        [kept]: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );
  return { result, canary };
};

const timeout = 60_000;

describe('the token in the environment of a child process', () => {
  it(
    'is gone in every spelling once the command line took the environment over',
    () => {
      const { result, canary } = start('take');
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('0 1\n');
      expect(result.stdout).not.toContain(canary);
    },
    timeout,
  );

  it(
    'reaches the child without the takeover, so the check can fail',
    () => {
      const { result, canary } = start('keep');
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('2 1\n');
      expect(result.stdout).not.toContain(canary);
    },
    timeout,
  );
});
