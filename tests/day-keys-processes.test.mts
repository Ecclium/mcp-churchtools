import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import type { WrappedKey } from '../packages/plugin-api/src/index.ts';
import { createFileDayKeys } from '../packages/core/src/keys/day-keys.ts';
import { quotaContext } from '../packages/testkit/src/quota/index.ts';

// Two processes wrap keys for the same new days at the same moment (ADR
// 0031). Each day key comes into being once, with link, so whichever
// process writes it first, the other reads it, and every key either of
// them wrapped opens with the day keys in the folder afterwards.

const fixture = fileURLToPath(
  new URL('fixtures/day-keys/wrap.mts', import.meta.url),
);
const hooks = new URL('fixtures/stdio/hooks.mts', import.meta.url).href;
const timeout = 30_000;

const base = mkdtempSync(join(tmpdir(), 'ecclium-day-keys-processes-'));
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

interface Wrapped {
  readonly key: string;
  readonly wrapped: WrappedKey;
}

const wrap = (keysDir: string, days: string, startAt: number, seed: number) =>
  new Promise<Wrapped[]>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--conditions=@ecclium/source',
        `--import=${hooks}`,
        fixture,
        keysDir,
        days,
        String(startAt),
        String(seed),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let failure = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      failure += chunk;
    });
    child.on('close', (code) => {
      if (code === 0) resolve(JSON.parse(out) as Wrapped[]);
      else
        reject(new Error(`the child ended with ${String(code)}: ${failure}`));
    });
  });

describe('two processes that wrap keys for the same new days', () => {
  it(
    'end with one day key per day, which opens every key of both',
    async () => {
      const keysDir = mkdtempSync(join(base, 'keys-'));
      chmodSync(keysDir, 0o700);
      const days = Array.from(
        { length: 20 },
        (_, index) => `2026-11-${String(index + 1).padStart(2, '0')}`,
      );
      // Late enough that both children have started and loaded the keys.
      const startAt = Date.now() + 2000;
      const [first, second] = await Promise.all([
        wrap(keysDir, days.join(','), startAt, 1),
        wrap(keysDir, days.join(','), startAt, 2),
      ]);
      expect(readdirSync(join(keysDir, 'snapshot')).sort()).toEqual(
        days.map((day) => `default.${day}.key`),
      );
      const keys = createFileDayKeys({ keysDir, pid: process.pid });
      const ctx = quotaContext('default', 'user', 'stdio:local-stdio');
      for (const { key, wrapped } of [...first, ...second]) {
        const opened = await keys.unwrap(ctx, 'snapshot', wrapped);
        expect(Buffer.from(opened ?? new Uint8Array()).toString('hex')).toBe(
          key,
        );
      }
    },
    timeout,
  );
});
