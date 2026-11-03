import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  IsoDate,
  QueueDecision,
  SealedQueueEntry,
  TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  approvalQueueChecks,
  quotaContext,
} from '@ecclium/mcp-churchtools-testkit';
import { afterAll, describe, expect, it } from 'vitest';

import {
  nodePrivateFileSystem,
  PrivateFileError,
  type PrivateFileSystem,
} from '../files/index.js';
import {
  createFileApprovalQueue,
  prepareQueueFolder,
  queueFolderName,
} from './index.js';

// The queue runs on disk, each test in a folder of state of its own, which
// the start prepares as it does for the server.

const base = mkdtempSync(join(tmpdir(), 'ecclium-queue-'));
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

let count = 0;
const freshDir = (prepare = true): string => {
  count += 1;
  const dir = join(base, `q${String(count)}`);
  mkdirSync(dir, { mode: 0o700 });
  if (prepare) prepareQueueFolder(dir);
  return dir;
};

const pid = process.pid;
const ctx = quotaContext('demo-tenant', 'service', 'stdio:local-stdio');
const other = quotaContext('zeta', 'service', 'stdio:local-stdio');
const day = '2026-11-03' as IsoDate;
const id = '0f1e2d3c-4b5a-4978-8a6b-5c4d3e2f1a0b';
const entry = (
  entryDay: IsoDate = day,
  sealed = 'v1.sealed-entry_A',
  entryId = id,
): SealedQueueEntry => ({ id: entryId, day: entryDay, sealed });
const decision = (
  kind: QueueDecision['decision'] = 'rejected',
  decisionDay: IsoDate = day,
): QueueDecision => ({
  id,
  day: decisionDay,
  decision: kind,
  decidedAt: '2026-11-03T18:00:00.000Z',
});
const fileOf = (
  dir: string,
  itemDay: string,
  kind: 'entry' | 'decision' = 'entry',
  tenant = 'demo-tenant',
): string => join(dir, queueFolderName, itemDay, `${tenant}.${id}.${kind}`);

// No error names a path: the messages are fixed.
const expectNoPath = (error: unknown): void => {
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).not.toContain(base);
  expect((error as Error).message).not.toContain('/');
};

describe('the queue of approvals in files', () => {
  it.each(approvalQueueChecks)('$name', async ({ run }) => {
    const stateDir = freshDir();
    await run(() => createFileApprovalQueue({ stateDir, pid }));
  });

  it('keeps an entry as a file with 0600 in a folder of its day with 0700, holding the sealed entry and nothing else', async () => {
    const stateDir = freshDir();
    const queue = createFileApprovalQueue({ stateDir, pid });
    await queue.put(ctx, entry());
    const folder = join(stateDir, queueFolderName);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(readdirSync(folder)).toEqual([day]);
    expect(statSync(join(folder, day)).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(folder, day))).toEqual([`demo-tenant.${id}.entry`]);
    expect(statSync(fileOf(stateDir, day)).mode & 0o777).toBe(0o600);
    expect(readFileSync(fileOf(stateDir, day), 'utf8')).toBe(
      'v1.sealed-entry_A',
    );
  });

  it('keeps a decision as a small file with 0600 and destroys the entry, also its second name', async () => {
    const stateDir = freshDir();
    const queue = createFileApprovalQueue({ stateDir, pid });
    await queue.put(ctx, entry());
    const copy = join(base, `copy${String(count)}`);
    linkSync(fileOf(stateDir, day), copy);
    await queue.decide(ctx, decision());
    expect(readdirSync(join(stateDir, queueFolderName, day))).toEqual([
      `demo-tenant.${id}.decision`,
    ]);
    const file = fileOf(stateDir, day, 'decision');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      v: 1,
      decision: 'rejected',
      decidedAt: '2026-11-03T18:00:00.000Z',
    });
    expect(readFileSync(copy)).toEqual(
      Buffer.alloc('v1.sealed-entry_A'.length),
    );
    const item = await queue.get(ctx, id);
    expect(item).toEqual({ id, day, decision: decision() });
    expect(Object.isFrozen(item)).toBe(true);
    expect(Object.isFrozen(item?.decision)).toBe(true);
  });

  it('destroys the entry left by a stop between the decision and the destruction when it is decided again, and rejects', async () => {
    const stateDir = freshDir();
    const queue = createFileApprovalQueue({ stateDir, pid });
    await queue.put(ctx, entry());
    writeFileSync(
      fileOf(stateDir, day, 'decision'),
      JSON.stringify({
        v: 1,
        decision: 'approved',
        decidedAt: '2026-11-03T17:00:00.000Z',
      }),
      { mode: 0o600 },
    );
    const both = await queue.get(ctx, id);
    expect(both?.entry).toEqual(entry());
    expect(both?.decision?.decision).toBe('approved');
    await expect(queue.decide(ctx, decision())).rejects.toThrow(
      'The entry is decided already.',
    );
    expect(readdirSync(join(stateDir, queueFolderName, day))).toEqual([
      `demo-tenant.${id}.decision`,
    ]);
    expect((await queue.get(ctx, id))?.decision?.decision).toBe('approved');
  });

  it('refuses a decision on a day without its folder and makes none', async () => {
    const stateDir = freshDir();
    const queue = createFileApprovalQueue({ stateDir, pid });
    await expect(queue.decide(ctx, decision())).rejects.toThrow(
      'There is no entry to decide.',
    );
    expect(readdirSync(join(stateDir, queueFolderName))).toEqual([]);
  });

  it('lists the entries of one tenant only and passes over names of other forms', async () => {
    const stateDir = freshDir();
    const queue = createFileApprovalQueue({ stateDir, pid });
    await queue.put(ctx, entry());
    await queue.put(other, entry());
    const dayFolder = join(stateDir, queueFolderName, day);
    // A tenant whose name starts the same, and names of no item.
    for (const name of [
      `demo-tenant-b.${id}.entry`,
      `demo-tenant.${id}.snapshot`,
      'demo-tenant.notes',
    ]) {
      writeFileSync(join(dayFolder, name), 'x', { mode: 0o600 });
    }
    expect(await queue.list(ctx)).toEqual([{ id, day, entry: entry() }]);
    expect(await queue.list(other)).toEqual([{ id, day, entry: entry() }]);
  });

  it('gives nothing and removes nothing without a folder of the queue, and writes nothing there', async () => {
    const stateDir = freshDir(false);
    const queue = createFileApprovalQueue({ stateDir, pid });
    expect(await queue.get(ctx, id)).toBeUndefined();
    expect(await queue.list(ctx)).toEqual([]);
    expect(await queue.purgeBefore(day)).toBe(0);
    const refusal = await queue
      .put(ctx, entry())
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(PrivateFileError);
    expectNoPath(refusal);
    expect(readdirSync(stateDir)).toEqual([]);
    expect(
      await createFileApprovalQueue({ stateDir: '/', pid }).get(ctx, id),
    ).toBeUndefined();
  });

  it('passes over names in the folder of the queue that are no day', async () => {
    const stateDir = freshDir();
    const queue = createFileApprovalQueue({ stateDir, pid });
    const folder = join(stateDir, queueFolderName);
    for (const name of ['2026-02-30', 'notes', '2026-1-01']) {
      mkdirSync(join(folder, name), { mode: 0o700 });
      writeFileSync(fileOf(stateDir, name), 'v1.x', { mode: 0o600 });
    }
    writeFileSync(join(folder, 'readme'), 'x', { mode: 0o600 });
    expect(await queue.get(ctx, id)).toBeUndefined();
    expect(await queue.list(ctx)).toEqual([]);
    expect(await queue.purgeBefore('2999-01-01' as IsoDate)).toBe(0);
    expect(readdirSync(folder).sort()).toEqual([
      '2026-02-30',
      '2026-1-01',
      'notes',
      'readme',
    ]);
  });

  it('refuses a file that holds no sealed entry', async () => {
    const stateDir = freshDir();
    const queue = createFileApprovalQueue({ stateDir, pid });
    await queue.put(ctx, entry());
    const file = fileOf(stateDir, day);
    for (const damaged of ['', 'a+b', 'ä', 'v1\n']) {
      rmSync(file);
      writeFileSync(file, damaged, { mode: 0o600 });
      const refusal = await queue.get(ctx, id).catch((error: unknown) => error);
      expect(refusal).toEqual(new Error('An entry of the queue is damaged.'));
      expectNoPath(refusal);
      await expect(queue.list(ctx)).rejects.toThrow(
        'An entry of the queue is damaged.',
      );
    }
    // A byte that is no sign of a sealed entry in any reading.
    rmSync(file);
    writeFileSync(file, Uint8Array.of(0x61, 0xad, 0x62), { mode: 0o600 });
    await expect(queue.get(ctx, id)).rejects.toThrow(
      'An entry of the queue is damaged.',
    );
  });

  it('refuses a file that holds no decision', async () => {
    const stateDir = freshDir();
    const queue = createFileApprovalQueue({ stateDir, pid });
    await queue.put(ctx, entry());
    await queue.decide(ctx, decision());
    const file = fileOf(stateDir, day, 'decision');
    const good = {
      v: 1,
      decision: 'rejected',
      decidedAt: decision().decidedAt,
    };
    for (const damaged of [
      '',
      'null',
      '5',
      '{',
      JSON.stringify({ ...good, v: 2 }),
      JSON.stringify({ ...good, decision: 'maybe' }),
      JSON.stringify({ ...good, decidedAt: 'now' }),
      JSON.stringify({ ...good, extra: true }),
      JSON.stringify({ decision: 'rejected', decidedAt: good.decidedAt }),
    ]) {
      rmSync(file);
      writeFileSync(file, damaged, { mode: 0o600 });
      const refusal = await queue.get(ctx, id).catch((error: unknown) => error);
      expect(refusal).toEqual(new Error('A decision of the queue is damaged.'));
      expectNoPath(refusal);
    }
    // A decision too large to be one is no private file of this queue.
    rmSync(file);
    writeFileSync(file, JSON.stringify({ ...good, pad: 'x'.repeat(300) }), {
      mode: 0o600,
    });
    await expect(queue.get(ctx, id)).rejects.toBeInstanceOf(PrivateFileError);
  });

  it('refuses a second entry under an ID that was decided', async () => {
    const stateDir = freshDir();
    const queue = createFileApprovalQueue({ stateDir, pid });
    await queue.put(ctx, entry());
    await queue.decide(ctx, decision());
    await expect(queue.put(ctx, entry())).rejects.toThrow(
      'The entry is decided already.',
    );
    expect(readdirSync(join(stateDir, queueFolderName, day))).toEqual([
      `demo-tenant.${id}.decision`,
    ]);
  });

  it('refuses a folder of a day that is a file or a link', async () => {
    const stateDir = freshDir();
    const queue = createFileApprovalQueue({ stateDir, pid });
    const folder = join(stateDir, queueFolderName);
    writeFileSync(join(folder, day), 'x', { mode: 0o600 });
    await expect(queue.get(ctx, id)).rejects.toBeInstanceOf(PrivateFileError);
    await expect(queue.put(ctx, entry())).rejects.toBeInstanceOf(
      PrivateFileError,
    );
    rmSync(join(folder, day));
    const elsewhere = join(base, `elsewhere${String(count)}`);
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, join(folder, day));
    await expect(queue.put(ctx, entry())).rejects.toBeInstanceOf(
      PrivateFileError,
    );
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('destroys every file of the days before the cut, counts the entries and decisions, removes their folders and keeps the day itself and later', async () => {
    const stateDir = freshDir();
    const queue = createFileApprovalQueue({ stateDir, pid });
    const old = '2026-10-01' as IsoDate;
    await queue.put(ctx, entry(old));
    await queue.put(other, entry(old));
    await queue.decide(other, decision('rejected', old));
    await queue.put(ctx, entry(day));
    await queue.put(other, entry('2026-11-05' as IsoDate));
    const folder = join(stateDir, queueFolderName);
    // A temporary name of a writer that stopped halfway, and a name that
    // is no item, both in a folder that goes.
    for (const name of [
      `.demo-tenant.${id}.entry.12.0123456789abcdef.tmp`,
      'notes.txt',
    ]) {
      writeFileSync(join(folder, old, name), 'x', { mode: 0o600 });
    }
    expect(await queue.purgeBefore(day)).toBe(2);
    expect(readdirSync(folder).sort()).toEqual([day, '2026-11-05']);
    expect(await queue.list(ctx)).toEqual([{ id, day, entry: entry(day) }]);
    expect(await queue.purgeBefore(day)).toBe(0);
  });

  it('destroys every other old file when one entry stays, and then reports it', async () => {
    const stateDir = freshDir();
    const queue = createFileApprovalQueue({ stateDir, pid });
    const folder = join(stateDir, queueFolderName);
    // Sorted first: a day that is a file, then a day with a folder and a
    // name that no private file may have.
    writeFileSync(join(folder, '2026-09-01'), 'x', { mode: 0o600 });
    await queue.put(ctx, entry('2026-09-02' as IsoDate));
    mkdirSync(join(folder, '2026-09-02', 'aaa'), { mode: 0o700 });
    writeFileSync(join(folder, '2026-09-02', '.DS_Store'), 'x', {
      mode: 0o600,
    });
    await queue.put(ctx, entry('2026-09-03' as IsoDate));
    await queue.put(ctx, entry(day));
    const refusal = await queue
      .purgeBefore(day)
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(PrivateFileError);
    expectNoPath(refusal);
    expect(readdirSync(folder).sort()).toEqual([
      '2026-09-01',
      '2026-09-02',
      day,
    ]);
    expect(readdirSync(join(folder, '2026-09-02')).sort()).toEqual([
      '.DS_Store',
      'aaa',
    ]);
  });

  it('leaves a name no private file may have, with its folder, and still purges the rest', async () => {
    const stateDir = freshDir();
    const queue = createFileApprovalQueue({ stateDir, pid });
    const folder = join(stateDir, queueFolderName);
    const old = '2026-09-02' as IsoDate;
    await queue.put(ctx, entry(old));
    writeFileSync(join(folder, old, '.DS_Store'), 'x', { mode: 0o600 });
    expect(await queue.purgeBefore(day)).toBe(1);
    expect(readdirSync(join(folder, old))).toEqual(['.DS_Store']);
    expect(await queue.purgeBefore(day)).toBe(0);
  });

  it('rejects with a code of its own when the system refuses a folder of a day', async () => {
    const refusing: PrivateFileSystem = Object.freeze({
      ...nodePrivateFileSystem,
      mkdirSync: () => {
        throw Object.assign(new Error('no'), { code: 'EACCES' });
      },
    });
    const queue = createFileApprovalQueue({
      stateDir: freshDir(),
      pid,
      fs: refusing,
    });
    await expect(queue.put(ctx, entry())).rejects.toBeInstanceOf(
      PrivateFileError,
    );
  });

  it('refuses a tenant that does not fit, for every call', async () => {
    const queue = createFileApprovalQueue({ stateDir: freshDir(), pid });
    for (const bad of [
      quotaContext('Demo', 'service', 'stdio:local-stdio'),
      new Proxy(ctx, {}),
      {
        get tenantId() {
          return 'demo-tenant';
        },
      } as unknown as TenantContext,
    ]) {
      for (const run of [
        () => queue.put(bad, entry()),
        () => queue.get(bad, id),
        () => queue.list(bad),
        () => queue.decide(bad, decision()),
      ]) {
        await expect(run()).rejects.toThrow('The tenant is invalid.');
      }
    }
  });

  it('reads every field of an entry and a decision once, as an own data property', async () => {
    const stateDir = freshDir();
    const queue = createFileApprovalQueue({ stateDir, pid });
    const plain = entry();
    for (const form of [
      new Proxy(plain, {}),
      {
        id,
        day,
        get sealed() {
          return plain.sealed;
        },
      },
      undefined,
      { ...plain, sealed: 5 },
    ]) {
      await expect(
        queue.put(ctx, form as unknown as SealedQueueEntry),
      ).rejects.toThrow(TypeError);
    }
    expect(readdirSync(join(stateDir, queueFolderName))).toEqual([]);
    await queue.put(ctx, plain);
    const kept = decision();
    for (const form of [
      new Proxy(kept, {}),
      {
        id,
        day,
        decidedAt: kept.decidedAt,
        get decision() {
          return 'rejected';
        },
      },
      { ...kept, decision: 'maybe' },
      { ...kept, decidedAt: 5 },
      { ...kept, id: 'x' },
    ]) {
      await expect(
        queue.decide(ctx, form as unknown as QueueDecision),
      ).rejects.toThrow(TypeError);
    }
    expect((await queue.get(ctx, id))?.entry).toEqual(plain);
  });

  it('needs a normalised absolute folder of state and the ID of a process', () => {
    for (const options of [
      { stateDir: 'state', pid },
      { stateDir: '/state/', pid },
      { stateDir: '/state/../x', pid },
      { stateDir: 5, pid },
      { stateDir: '/state', pid: 0 },
      { stateDir: '/state', pid: 1.5 },
      { stateDir: '/state', pid: '1' },
      new Proxy({ stateDir: '/state', pid }, {}),
    ]) {
      expect(() =>
        createFileApprovalQueue(
          options as unknown as Parameters<typeof createFileApprovalQueue>[0],
        ),
      ).toThrow(TypeError);
    }
    expect(
      Object.isFrozen(createFileApprovalQueue({ stateDir: '/state', pid })),
    ).toBe(true);
  });
});

describe('prepareQueueFolder', () => {
  it('creates the folder of the queue with 0700 and accepts it again', () => {
    const stateDir = freshDir(false);
    prepareQueueFolder(stateDir);
    prepareQueueFolder(stateDir);
    expect(readdirSync(stateDir)).toEqual([queueFolderName]);
    expect(statSync(join(stateDir, queueFolderName)).mode & 0o777).toBe(0o700);
  });

  it('refuses a link in its place and a folder of state of another form', () => {
    const stateDir = freshDir(false);
    const elsewhere = join(base, `target${String(count)}`);
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, join(stateDir, queueFolderName));
    expect(() => {
      prepareQueueFolder(stateDir);
    }).toThrow(PrivateFileError);
    for (const bad of ['state', '/state/', 5]) {
      expect(() => {
        prepareQueueFolder(bad as string);
      }).toThrow(TypeError);
    }
  });
});
