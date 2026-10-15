import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Opening a FIFO without O_NONBLOCK waits until a writer appears, so a FIFO
// at the path of the token file would stop the start for good (ADR 0055).
// Only a child process can hang without stopping the run, and package
// tests cannot start child processes, so this test lives here. It makes a
// real FIFO with mkfifo and lets a child, started from source, read it
// within a time limit.

const fixture = fileURLToPath(
  new URL('fixtures/config/read-token-file.mts', import.meta.url),
);

const read = (path: string) =>
  spawnSync(process.execPath, [fixture, path], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5_000,
  });

const timeout = 20_000;

describe('the reader of the token file in a child process', () => {
  let directory = '';

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'ecclium-token-fifo-'));
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it(
    'refuse a FIFO without a writer at once instead of waiting',
    () => {
      const fifo = join(directory, 'token-fifo');
      const made = spawnSync('mkfifo', ['-m', '600', fifo], {
        encoding: 'utf8',
      });
      expect(made.status, made.stderr).toBe(0);

      const child = read(fifo);
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout).toBe('token_file_not_regular\n');
    },
    timeout,
  );

  it(
    'read a regular file the same way',
    () => {
      const file = join(directory, 'token');
      writeFileSync(file, `${randomBytes(16).toString('hex')}\n`);
      chmodSync(file, 0o600);

      const child = read(file);
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout).toBe('ok\n');
    },
    timeout,
  );
});
