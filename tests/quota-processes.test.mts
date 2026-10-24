import { spawn } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { prepareQuotaFolder } from '../packages/core/src/quota/index.ts';

// Two processes share one file of quotas (ADR 0063): each child counts
// against the store of core, run from source, from the same moment, and
// together they get every count exactly once.

const fixture = fileURLToPath(
  new URL('fixtures/quota/count.mts', import.meta.url),
);
const hooks = new URL('fixtures/stdio/hooks.mts', import.meta.url).href;
const timeout = 30_000;

const base = mkdtempSync(join(tmpdir(), 'ecclium-quota-processes-'));
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

const count = (stateDir: string, times: number, startAt: number) =>
  new Promise<number[]>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--conditions=@ecclium/source',
        `--import=${hooks}`,
        fixture,
        stateDir,
        String(times),
        String(startAt),
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
      if (code === 0) resolve(JSON.parse(out) as number[]);
      else
        reject(new Error(`the child ended with ${String(code)}: ${failure}`));
    });
  });

describe('two processes that count against one file of quotas', () => {
  it(
    'count together and lose no call',
    async () => {
      const stateDir = mkdtempSync(join(base, 'state-'));
      chmodSync(stateDir, 0o700);
      expect(prepareQuotaFolder(stateDir)).toEqual({ ok: true });
      const times = 40;
      // Late enough that both children have started and loaded the store.
      const startAt = Date.now() + 2000;
      const [first, second] = await Promise.all([
        count(stateDir, times, startAt),
        count(stateDir, times, startAt),
      ]);
      expect(
        [...(first ?? []), ...(second ?? [])].sort((a, b) => a - b),
      ).toEqual(Array.from({ length: 2 * times }, (_, index) => index + 1));
      for (const counts of [first ?? [], second ?? []]) {
        expect(counts).toEqual([...counts].sort((a, b) => a - b));
      }
      const quota = join(stateDir, 'quota');
      expect(readdirSync(quota)).toEqual(['default-2026-10-24.json']);
      expect(
        JSON.parse(
          readFileSync(join(quota, 'default-2026-10-24.json'), 'utf8'),
        ),
      ).toMatchObject({
        counts: { 'user:stdio:local-stdio': { special_reads: 2 * times } },
      });
    },
    timeout,
  );
});
