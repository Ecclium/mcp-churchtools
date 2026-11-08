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
// against the store of core, run from source, and together they get every
// count exactly once. The test starts the children together once both
// have loaded the source, so that they count at the same time also when
// one of them took long to start, and every child counts on 24.10.2026 by
// a clock that runs from noon of that day, so that no midnight falls
// between them (tests/fixtures/quota/together.mts). A FIFO in place of the
// file, made with mkfifo, never holds the store.

const counter = fileURLToPath(
  new URL('fixtures/quota/count.mts', import.meta.url),
);
const writeLimit = fileURLToPath(
  new URL('fixtures/quota/write-limit.mts', import.meta.url),
);
const hooks = new URL('fixtures/stdio/hooks.mts', import.meta.url).href;
const timeout = 30_000;
const day = '2026-10-24';

const base = mkdtempSync(join(tmpdir(), 'ecclium-quota-processes-'));
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

interface Child {
  /** Resolves once the child has loaded the source and waits to start. */
  readonly ready: Promise<void>;
  /** Starts the child, or lets it end when it does not wait to start. */
  readonly start: () => void;
  /** Ends the child, for a test that gives up on it. */
  readonly stop: () => void;
  /** The last line the child printed, as JSON. */
  readonly result: Promise<unknown>;
}

const spawnChild = (fixture: string, args: readonly string[]): Child => {
  const child = spawn(
    process.execPath,
    ['--conditions=@ecclium/source', `--import=${hooks}`, fixture, ...args],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let out = '';
  let failure = '';
  let markReady = (): void => undefined;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    out += chunk;
    if (out.startsWith('ready\n')) markReady();
  });
  child.stderr.on('data', (chunk: string) => {
    failure += chunk;
  });
  // A child that ended before its start closes the pipe; its result tells
  // why, so the error of the write is not one of the test.
  child.stdin.on('error', () => undefined);
  const result = new Promise<unknown>((resolve, reject) => {
    child.on('close', (code) => {
      const last = out.trimEnd().split('\n').at(-1) ?? '';
      if (code === 0) resolve(JSON.parse(last));
      else
        reject(new Error(`the child ended with ${String(code)}: ${failure}`));
    });
  });
  return {
    ready,
    start: () => {
      child.stdin.end('go\n');
    },
    stop: () => {
      child.kill();
    },
    result,
  };
};

// Starts every child once all of them wait, and gives their results. A
// child that ends before it is ready ends the wait with its error, and
// the others are ended then, so that none counts after the test.
const together = async (children: readonly Child[]): Promise<unknown[]> => {
  const results = Promise.all(children.map((child) => child.result));
  try {
    await Promise.race([
      Promise.all(children.map((child) => child.ready)),
      results,
    ]);
    for (const child of children) child.start();
    return await results;
  } catch (error) {
    for (const child of children) child.stop();
    throw error;
  }
};

describe('two processes that count against one file of quotas', () => {
  it(
    'count together and lose no call',
    async () => {
      const stateDir = mkdtempSync(join(base, 'state-'));
      chmodSync(stateDir, 0o700);
      expect(prepareQuotaFolder(stateDir)).toEqual({ ok: true });
      const times = 40;
      // A pause after each count gives the other child the lock in
      // between, so that both really wait for each other.
      const args = [stateDir, String(times), '10'];
      const [first, second] = (await together([
        spawnChild(counter, args),
        spawnChild(counter, args),
      ])) as [number[], number[]];
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
      expect(readdirSync(quota)).toEqual([`default-${day}.json`]);
      expect(
        JSON.parse(readFileSync(join(quota, `default-${day}.json`), 'utf8')),
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
      // The day of the clock of the children, so that the store keeps the
      // file of decisions (ADR 0029).
      const key = approvalQuotaKey('5e'.repeat(32));
      const times = 20;
      const args = [stateDir, String(times), '10', key];
      const [first, second] = (await together([
        spawnChild(counter, args),
        spawnChild(counter, args),
      ])) as [number[], number[]];
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

// One child that plans a write with a limit of the day, against the store
// in the folder of state, and does not wait to start.
const plan = (stateDir: string, maxPerDay: number): Promise<unknown> => {
  const child = spawnChild(writeLimit, [stateDir, 'plan', String(maxPerDay)]);
  child.start();
  return child.result;
};

// The limit of an entry of the policy counts in the file of quotas (ADR
// 0032, ADR 0063): two processes that commit at the same time get no more
// writes together than the limit allows, and a process started after them
// plans with the count they left. Without the limit, the same children get
// every write, and a new folder of state lets a new process plan again.
describe('two processes that write against one limit of the policy', () => {
  const commitTogether = async (stateDir: string, maxPerDay: number) => {
    const args = [stateDir, 'commit', String(maxPerDay), '8', '10'];
    const [first, second] = (await together([
      spawnChild(writeLimit, args),
      spawnChild(writeLimit, args),
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
      expect(await plan(stateDir, 5)).toBe('limit_reached');
      // The one file of the day the children counted on, by their clock.
      expect(readdirSync(join(stateDir, 'quota'))).toEqual([
        `default-${day}.json`,
      ]);
      const counts = (
        JSON.parse(
          readFileSync(join(stateDir, 'quota', `default-${day}.json`), 'utf8'),
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
      expect(await plan(fresh, 5)).toBe('go');
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
