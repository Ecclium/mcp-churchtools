import { spawn, spawnSync } from 'node:child_process';
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

import {
  approvalQuotaKey,
  type IsoDate,
} from '../packages/plugin-api/src/index.ts';
import {
  createFileQuotaStore,
  prepareQuotaFolder,
} from '../packages/core/src/quota/index.ts';
import { quotaContext } from '../packages/testkit/src/quota/index.ts';

// Two processes share one file of quotas (ADR 0063): each child counts
// against the store of core, run from source, from the same moment, and
// together they get every count exactly once. A FIFO in place of the file,
// made with mkfifo, never holds the store.

const fixture = fileURLToPath(
  new URL('fixtures/quota/count.mts', import.meta.url),
);
const hooks = new URL('fixtures/stdio/hooks.mts', import.meta.url).href;
const timeout = 30_000;

const base = mkdtempSync(join(tmpdir(), 'ecclium-quota-processes-'));
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

const count = (
  stateDir: string,
  times: number,
  startAt: number,
  pauseMs: number,
  key?: { readonly key: string; readonly day: string },
) =>
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
        String(pauseMs),
        ...(key === undefined ? [] : [key.key, key.day]),
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
      // A pause after each count gives the other child the lock in
      // between, so that both really wait for each other.
      const [first, second] = await Promise.all([
        count(stateDir, times, startAt, 10),
        count(stateDir, times, startAt, 10),
      ]);
      expect([...first, ...second].sort((a, b) => a - b)).toEqual(
        Array.from({ length: 2 * times }, (_, index) => index + 1),
      );
      for (const counts of [first, second]) {
        expect(counts).toEqual([...counts].sort((a, b) => a - b));
        // Interleaved: no child got one block of counts on its own.
        const span = (counts.at(-1) ?? 0) - (counts[0] ?? 0) + 1;
        expect(span).toBeGreaterThan(counts.length);
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

describe('two processes that count one decision about an entry of the queue', () => {
  it(
    'give the count 1 to one of them only, in the file of decisions',
    async () => {
      const stateDir = mkdtempSync(join(base, 'approvals-'));
      chmodSync(stateDir, 0o700);
      expect(prepareQuotaFolder(stateDir)).toEqual({ ok: true });
      // Today, so that the store keeps the file by its clock (ADR 0029).
      const day = new Date().toISOString().slice(0, 10);
      const key = approvalQuotaKey('5e'.repeat(32));
      const times = 20;
      const startAt = Date.now() + 2000;
      const [first, second] = await Promise.all([
        count(stateDir, times, startAt, 10, { key, day }),
        count(stateDir, times, startAt, 10, { key, day }),
      ]);
      const all = [...first, ...second].sort((a, b) => a - b);
      expect(all).toEqual(
        Array.from({ length: 2 * times }, (_, index) => index + 1),
      );
      expect(all.filter((value) => value === 1)).toHaveLength(1);
      const quota = join(stateDir, 'quota');
      expect(readdirSync(quota)).toEqual([`default-${day}.approvals.json`]);
      expect(
        JSON.parse(
          readFileSync(join(quota, `default-${day}.approvals.json`), 'utf8'),
        ),
      ).toEqual({
        v: 1,
        tenant: 'default',
        day,
        approvals: { [key]: 2 * times },
      });
    },
    timeout,
  );
});

const writeLimit = fileURLToPath(
  new URL('fixtures/quota/write-limit.mts', import.meta.url),
);

// One child that asks the gate of the policy about writes with a limit of
// the day, against the store in the folder of state.
const ask = (stateDir: string, args: readonly string[]) =>
  new Promise<unknown>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--conditions=@ecclium/source',
        `--import=${hooks}`,
        writeLimit,
        stateDir,
        ...args,
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
      if (code === 0) resolve(JSON.parse(out));
      else
        reject(new Error(`the child ended with ${String(code)}: ${failure}`));
    });
  });

// The limit of an entry of the policy counts in the file of quotas (ADR
// 0032, ADR 0063): two processes that commit at the same time get no more
// writes together than the limit allows, and a process started after them
// plans with the count they left. Without the limit, the same children get
// every write, and a new folder of state lets a new process plan again.
describe('two processes that write against one limit of the policy', () => {
  const commitTogether = async (stateDir: string, maxPerDay: number) => {
    const startAt = Date.now() + 2000;
    const args = ['commit', String(maxPerDay), '8', String(startAt), '10'];
    const [first, second] = (await Promise.all([
      ask(stateDir, args),
      ask(stateDir, args),
    ])) as [string[], string[]];
    return [...first, ...second];
  };

  it(
    'let only as many writes go as the limit allows, and a later process plans for the queue',
    async () => {
      const stateDir = mkdtempSync(join(base, 'write-limit-'));
      chmodSync(stateDir, 0o700);
      expect(prepareQuotaFolder(stateDir)).toEqual({ ok: true });
      const outcomes = await commitTogether(stateDir, 5);
      expect(outcomes.filter((outcome) => outcome === 'go')).toHaveLength(5);
      expect(outcomes.filter((outcome) => outcome === 'refused')).toHaveLength(
        11,
      );
      // After both ended, as after a restart: the count is in the file.
      expect(await ask(stateDir, ['plan', '5'])).toBe('limit_reached');
      // The file of the day the children counted on, by its name, so that
      // the test does not read the clock again after them.
      const files = readdirSync(join(stateDir, 'quota')).filter((name) =>
        /^default-\d{4}-\d{2}-\d{2}\.json$/.test(name),
      );
      expect(files).toHaveLength(1);
      const counts = (
        JSON.parse(
          readFileSync(join(stateDir, 'quota', files[0] ?? ''), 'utf8'),
        ) as { counts: Record<string, Record<string, number>> }
      ).counts['service:stdio:local-stdio'];
      expect(counts).toEqual({
        'write:ct_wiki_page_create:wiki_category:12': 16,
      });
    },
    timeout,
  );

  it(
    'let every write go without the limit, and a new folder of state plans again',
    async () => {
      const stateDir = mkdtempSync(join(base, 'write-no-limit-'));
      chmodSync(stateDir, 0o700);
      expect(prepareQuotaFolder(stateDir)).toEqual({ ok: true });
      const outcomes = await commitTogether(stateDir, 1000);
      expect(outcomes).toEqual(Array.from({ length: 16 }, () => 'go'));
      const fresh = mkdtempSync(join(base, 'write-fresh-'));
      chmodSync(fresh, 0o700);
      expect(prepareQuotaFolder(fresh)).toEqual({ ok: true });
      expect(await ask(fresh, ['plan', '5'])).toBe('go');
    },
    timeout,
  );
});

describe('a FIFO in place of the file of quotas', () => {
  it('is refused without waiting for a writer', async () => {
    const stateDir = mkdtempSync(join(base, 'fifo-'));
    chmodSync(stateDir, 0o700);
    expect(prepareQuotaFolder(stateDir)).toEqual({ ok: true });
    const made = spawnSync(
      'mkfifo',
      ['-m', '600', join(stateDir, 'quota', 'default-2026-10-24.json')],
      { stdio: 'ignore' },
    );
    expect(made.status).toBe(0);
    const store = createFileQuotaStore({
      stateDir,
      clock: { now: () => Date.now() },
      pid: 4242,
      host: 'test-host',
    });
    const ctx = quotaContext('default', 'user', 'stdio:local-stdio');
    const day = '2026-10-24' as IsoDate;
    const started = Date.now();
    await expect(store.read(ctx, 'special_reads', day)).rejects.toThrow(
      'The store of quotas failed.',
    );
    await expect(store.increment(ctx, 'special_reads', day)).rejects.toThrow(
      'The store of quotas failed.',
    );
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
