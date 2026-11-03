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
  SealedSnapshot,
  SnapshotPart,
  TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  quotaContext,
  snapshotStoreChecks,
} from '@ecclium/mcp-churchtools-testkit';
import { afterAll, describe, expect, it } from 'vitest';

import {
  nodePrivateFileSystem,
  PrivateFileError,
  type PrivateFileSystem,
} from '../files/index.js';
import {
  createFileSnapshotStore,
  prepareSnapshotFolder,
  snapshotFolderName,
} from './index.js';

// The store runs on disk, each test in a folder of state of its own, which
// the start prepares as it does for the server.

const base = mkdtempSync(join(tmpdir(), 'ecclium-snapshots-'));
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

let count = 0;
const freshDir = (prepare = true): string => {
  count += 1;
  const dir = join(base, `s${String(count)}`);
  mkdirSync(dir, { mode: 0o700 });
  if (prepare) prepareSnapshotFolder(dir);
  return dir;
};

const pid = process.pid;
const ctx = quotaContext('demo-tenant', 'service', 'stdio:local-stdio');
const other = quotaContext('zeta', 'service', 'stdio:local-stdio');
const day = '2026-11-03' as IsoDate;
const eventId = '0f1e2d3c-4b5a-4978-8a6b-5c4d3e2f1a0b';
const record = (
  part: SnapshotPart = 'before',
  recordDay: IsoDate = day,
  sealed = `v1.${part}.sealed-record_A`,
  id = eventId,
): SealedSnapshot => ({ eventId: id, part, day: recordDay, sealed });
const fileOf = (
  dir: string,
  recordDay: string,
  part: SnapshotPart = 'before',
  tenant = 'demo-tenant',
  id = eventId,
): string =>
  join(dir, snapshotFolderName, recordDay, `${tenant}.${id}.${part}.snapshot`);

// No error names a path: the messages are fixed.
const expectNoPath = (error: unknown): void => {
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).not.toContain(base);
  expect((error as Error).message).not.toContain('/');
};

describe('the store of snapshots in files', () => {
  it.each(snapshotStoreChecks)('$name', async ({ run }) => {
    const stateDir = freshDir();
    await run(() => createFileSnapshotStore({ stateDir, pid }));
  });

  it('keeps each part as a file with 0600 in a folder of its day with 0700, holding the sealed record and nothing else', async () => {
    const stateDir = freshDir();
    const store = createFileSnapshotStore({ stateDir, pid });
    await store.put(ctx, record());
    const folder = join(stateDir, snapshotFolderName);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(readdirSync(folder)).toEqual([day]);
    expect(statSync(join(folder, day)).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(folder, day))).toEqual([
      `demo-tenant.${eventId}.before.snapshot`,
    ]);
    expect(statSync(fileOf(stateDir, day)).mode & 0o777).toBe(0o600);
    expect(readFileSync(fileOf(stateDir, day), 'utf8')).toBe(
      'v1.before.sealed-record_A',
    );
  });

  it('gives the parts of an event from every day, before first, with the day of their folder, frozen', async () => {
    const stateDir = freshDir();
    const store = createFileSnapshotStore({ stateDir, pid });
    const next = '2026-11-04' as IsoDate;
    await store.put(ctx, record('after', next));
    await store.put(ctx, record('before', day));
    const records = await store.get(ctx, eventId);
    expect(records).toEqual([record('before', day), record('after', next)]);
    expect(Object.isFrozen(records)).toBe(true);
    expect(records.every((entry) => Object.isFrozen(entry))).toBe(true);
  });

  it('gives nothing and removes nothing without a folder of snapshots, and writes nothing there', async () => {
    const stateDir = freshDir(false);
    const store = createFileSnapshotStore({ stateDir, pid });
    expect(await store.get(ctx, eventId)).toEqual([]);
    expect(await store.purgeBefore(day)).toBe(0);
    const refusal = await store.put(ctx, record()).catch((error: unknown) => {
      return error;
    });
    expect(refusal).toBeInstanceOf(PrivateFileError);
    expectNoPath(refusal);
    expect(readdirSync(stateDir)).toEqual([]);
    expect(
      await createFileSnapshotStore({ stateDir: '/', pid }).get(ctx, eventId),
    ).toEqual([]);
  });

  it('passes over names in the folder of snapshots that are no day', async () => {
    const stateDir = freshDir();
    const store = createFileSnapshotStore({ stateDir, pid });
    const folder = join(stateDir, snapshotFolderName);
    for (const name of ['2026-02-30', 'notes', '2026-1-01']) {
      mkdirSync(join(folder, name), { mode: 0o700 });
      writeFileSync(fileOf(stateDir, name), 'v1.x', { mode: 0o600 });
    }
    writeFileSync(join(folder, 'readme'), 'x', { mode: 0o600 });
    expect(await store.get(ctx, eventId)).toEqual([]);
    expect(await store.purgeBefore('2999-01-01' as IsoDate)).toBe(0);
    expect(readdirSync(folder).sort()).toEqual([
      '2026-02-30',
      '2026-1-01',
      'notes',
      'readme',
    ]);
  });

  it('refuses a file that holds no sealed record', async () => {
    const stateDir = freshDir();
    const store = createFileSnapshotStore({ stateDir, pid });
    await store.put(ctx, record());
    const file = fileOf(stateDir, day);
    for (const damaged of ['', 'a+b', 'ä', 'v1\n']) {
      rmSync(file);
      writeFileSync(file, damaged, { mode: 0o600 });
      const refusal = await store
        .get(ctx, eventId)
        .catch((error: unknown) => error);
      expect(refusal).toEqual(new Error('A snapshot is damaged.'));
      expectNoPath(refusal);
    }
    // A byte that is no sign of a sealed record in any reading.
    rmSync(file);
    writeFileSync(file, Uint8Array.of(0x61, 0xad, 0x62), { mode: 0o600 });
    await expect(store.get(ctx, eventId)).rejects.toThrow(
      'A snapshot is damaged.',
    );
  });

  it('refuses a folder of a day that is a file or a link', async () => {
    const stateDir = freshDir();
    const store = createFileSnapshotStore({ stateDir, pid });
    const folder = join(stateDir, snapshotFolderName);
    writeFileSync(join(folder, day), 'x', { mode: 0o600 });
    await expect(store.get(ctx, eventId)).rejects.toBeInstanceOf(
      PrivateFileError,
    );
    await expect(store.put(ctx, record())).rejects.toBeInstanceOf(
      PrivateFileError,
    );
    rmSync(join(folder, day));
    const elsewhere = join(base, `elsewhere${String(count)}`);
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, join(folder, day));
    await expect(store.put(ctx, record())).rejects.toBeInstanceOf(
      PrivateFileError,
    );
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('destroys every file of the days before the cut, counts the records, removes their folders and keeps the day itself and later', async () => {
    const stateDir = freshDir();
    const store = createFileSnapshotStore({ stateDir, pid });
    const old = '2026-10-01' as IsoDate;
    const older = '2026-09-30' as IsoDate;
    await store.put(ctx, record('before', old));
    await store.put(ctx, record('after', old));
    await store.put(other, record('before', older));
    await store.put(ctx, record('before', day));
    await store.put(other, record('after', '2026-11-05' as IsoDate));
    const folder = join(stateDir, snapshotFolderName);
    // A temporary name of a writer that stopped halfway, and a name that
    // is no record, both in a folder that goes.
    for (const name of [
      `.demo-tenant.${eventId}.before.snapshot.12.0123456789abcdef.tmp`,
      'notes.txt',
    ]) {
      writeFileSync(join(folder, old, name), 'x', { mode: 0o600 });
    }
    // A second name of a record outside the folder keeps only zeros.
    const copy = join(base, `copy${String(count)}`);
    linkSync(fileOf(stateDir, old), copy);
    expect(await store.purgeBefore('2026-11-03' as IsoDate)).toBe(3);
    expect(readdirSync(folder).sort()).toEqual([day, '2026-11-05']);
    expect(readFileSync(copy)).toEqual(
      Buffer.alloc('v1.before.sealed-record_A'.length),
    );
    expect(await store.get(ctx, eventId)).toEqual([record('before', day)]);
    expect(await store.get(other, eventId)).toEqual([
      record('after', '2026-11-05' as IsoDate),
    ]);
    expect(await store.purgeBefore('2026-11-03' as IsoDate)).toBe(0);
  });

  it('destroys every other old file when one entry stays, and then reports it', async () => {
    const stateDir = freshDir();
    const store = createFileSnapshotStore({ stateDir, pid });
    const folder = join(stateDir, snapshotFolderName);
    // Sorted first: a day that is a file, then a day with a folder and a
    // name that no private file may have.
    writeFileSync(join(folder, '2026-09-01'), 'x', { mode: 0o600 });
    await store.put(ctx, record('before', '2026-09-02' as IsoDate));
    mkdirSync(join(folder, '2026-09-02', 'aaa'), { mode: 0o700 });
    writeFileSync(join(folder, '2026-09-02', '.DS_Store'), 'x', {
      mode: 0o600,
    });
    await store.put(ctx, record('before', '2026-09-03' as IsoDate));
    await store.put(ctx, record('before', day));
    const refusal = await store
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
    // The day that is a file refuses every read until it is gone.
    await expect(store.get(ctx, eventId)).rejects.toBeInstanceOf(
      PrivateFileError,
    );
    rmSync(join(folder, '2026-09-01'));
    expect(await store.get(ctx, eventId)).toEqual([record('before', day)]);
  });

  it('rejects with a code of its own when the system refuses a folder of a day', async () => {
    const refusing: PrivateFileSystem = Object.freeze({
      ...nodePrivateFileSystem,
      mkdirSync: () => {
        throw Object.assign(new Error('no'), { code: 'EACCES' });
      },
    });
    const store = createFileSnapshotStore({
      stateDir: freshDir(),
      pid,
      fs: refusing,
    });
    await expect(store.put(ctx, record())).rejects.toBeInstanceOf(
      PrivateFileError,
    );
  });

  it('refuses a tenant that does not fit, for every call', async () => {
    const store = createFileSnapshotStore({ stateDir: freshDir(), pid });
    for (const bad of [
      quotaContext('Demo', 'service', 'stdio:local-stdio'),
      new Proxy(ctx, {}),
      {
        get tenantId() {
          return 'demo-tenant';
        },
      } as unknown as TenantContext,
    ]) {
      await expect(store.put(bad, record())).rejects.toThrow(
        'The tenant is invalid.',
      );
      await expect(store.get(bad, eventId)).rejects.toThrow(
        'The tenant is invalid.',
      );
    }
  });

  it('reads every field of a record once, as an own data property', async () => {
    const stateDir = freshDir();
    const store = createFileSnapshotStore({ stateDir, pid });
    const plain = record();
    for (const form of [
      new Proxy(plain, {}),
      {
        eventId,
        part: 'before',
        day,
        get sealed() {
          return plain.sealed;
        },
      },
      undefined,
      { ...plain, sealed: 5 },
    ]) {
      await expect(
        store.put(ctx, form as unknown as SealedSnapshot),
      ).rejects.toThrow(TypeError);
    }
    expect(readdirSync(join(stateDir, snapshotFolderName))).toEqual([]);
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
        createFileSnapshotStore(
          options as unknown as Parameters<typeof createFileSnapshotStore>[0],
        ),
      ).toThrow(TypeError);
    }
    expect(
      Object.isFrozen(createFileSnapshotStore({ stateDir: '/state', pid })),
    ).toBe(true);
  });
});

describe('prepareSnapshotFolder', () => {
  it('creates the folder of snapshots with 0700 and accepts it again', () => {
    const stateDir = freshDir(false);
    prepareSnapshotFolder(stateDir);
    prepareSnapshotFolder(stateDir);
    expect(readdirSync(stateDir)).toEqual([snapshotFolderName]);
    expect(statSync(join(stateDir, snapshotFolderName)).mode & 0o777).toBe(
      0o700,
    );
  });

  it('refuses a link in its place and a folder of state of another form', () => {
    const stateDir = freshDir(false);
    const elsewhere = join(base, `target${String(count)}`);
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, join(stateDir, snapshotFolderName));
    expect(() => {
      prepareSnapshotFolder(stateDir);
    }).toThrow(PrivateFileError);
    for (const bad of ['state', '/state/', 5]) {
      expect(() => {
        prepareSnapshotFolder(bad as string);
      }).toThrow(TypeError);
    }
  });
});
