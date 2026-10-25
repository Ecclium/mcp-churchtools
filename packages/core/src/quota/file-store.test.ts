import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  Clock,
  IsoDate,
  QuotaKey,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  quotaContext,
  quotaStoreChecks,
} from '@ecclium/mcp-churchtools-testkit';
import { afterAll, describe, expect, it } from 'vitest';

import {
  createFileQuotaStore,
  type FileQuotaStoreOptions,
  maxQuotaActors,
  maxQuotaFileBytes,
  orphanLockMs,
  prepareQuotaFolder,
  type QuotaFileSystem,
} from './index.js';

// The store against real folders in the temporary folder, and with file
// functions of its own where the disk cannot show a case, such as a file
// of another owner (ADR 0063).

const base = mkdtempSync(join(tmpdir(), 'ecclium-quota-'));
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

let folders = 0;
// A folder of state with 0700 and its folder quota, made by the start.
const freshState = (): string => {
  folders += 1;
  const state = join(base, `state-${String(folders)}`);
  mkdirSync(state, { mode: 0o700 });
  const prepared = prepareQuotaFolder(state);
  if (!prepared.ok) throw new Error(prepared.code);
  return state;
};

const clock: Clock = Object.freeze({ now: () => Date.now() });
const day = '2026-10-24' as IsoDate;
const key: QuotaKey = 'special_reads';
const ctx = quotaContext('demo-tenant', 'service', 'stdio:local-stdio');
const failure = 'The store of quotas failed.';

const nodeFs: QuotaFileSystem = Object.freeze({
  mkdirSync: (path: string, mode: number) => {
    mkdirSync(path, { mode });
  },
  openSync,
  fstatSync,
  lstatSync,
  readSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  linkSync,
  unlinkSync,
  readdirSync: (path: string) => readdirSync(path),
  getuid: () => process.getuid?.(),
  constants,
});

const open = (stateDir: string, extra: Partial<FileQuotaStoreOptions> = {}) =>
  createFileQuotaStore({
    stateDir,
    clock,
    pid: 4242,
    host: 'example-host',
    ...extra,
  });

const fileOf = (state: string, name = `demo-tenant-${day}.json`) =>
  join(state, 'quota', name);

const countsOf = (counter: number) =>
  JSON.stringify({
    v: 1,
    tenant: 'demo-tenant',
    day,
    counts: { 'service:stdio:local-stdio': { special_reads: counter } },
  });

describe('the file of quotas', () => {
  it.each(quotaStoreChecks)('$name', async ({ run }) => {
    const state = freshState();
    await run(() => open(state));
  });

  it('writes counters only, in a file of the user with 0600, and leaves no lock', async () => {
    const state = freshState();
    await open(state).increment(ctx, key, day);
    await open(state).increment(
      quotaContext('demo-tenant', 'user', 'stdio:other'),
      key,
      day,
    );
    // Mode and content from one descriptor, so that both are of one file.
    const fd = openSync(fileOf(state), 'r');
    try {
      expect(fstatSync(fd).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(fd, 'utf8'))).toEqual({
        v: 1,
        tenant: 'demo-tenant',
        day,
        counts: {
          'service:stdio:local-stdio': { special_reads: 1 },
          'user:stdio:other': { special_reads: 1 },
        },
      });
    } finally {
      closeSync(fd);
    }
    expect(readdirSync(join(state, 'quota'))).toEqual([
      `demo-tenant-${day}.json`,
    ]);
  });

  it('counts on from a file it wrote before', async () => {
    const state = freshState();
    writeFileSync(fileOf(state), countsOf(199), { mode: 0o600 });
    await expect(open(state).increment(ctx, key, day)).resolves.toBe(200);
    await expect(open(state).read(ctx, key, day)).resolves.toBe(200);
  });

  it('removes the files of the tenant for earlier days, and nothing else', async () => {
    const state = freshState();
    const names = [
      'demo-tenant-2026-10-23.json',
      'demo-tenant-2026-10-23.json.lock',
      'demo-tenant-2026-10-25.json',
      'other-tenant-2026-10-23.json',
      'demo-tenant-2026-10-23.json.bak',
      'demo-tenant-2026-10-23.json.lock.4242.0123456789abcdef.stale',
      'demo-tenant-2026-10-23.json.lock.x.stale',
      '.demo-tenant-2026-10-23.4242.0123456789abcdef.tmp',
      '.demo-tenant-2026-10-24.4242.0123456789abcdef.tmp',
      'notes.txt',
    ];
    for (const name of names) {
      writeFileSync(fileOf(state, name), '{}', { mode: 0o600 });
    }
    await open(state).increment(ctx, key, day);
    expect(readdirSync(join(state, 'quota')).sort()).toEqual(
      [
        `demo-tenant-${day}.json`,
        'demo-tenant-2026-10-23.json.bak',
        'demo-tenant-2026-10-23.json.lock.x.stale',
        '.demo-tenant-2026-10-24.4242.0123456789abcdef.tmp',
        'demo-tenant-2026-10-25.json',
        'notes.txt',
        'other-tenant-2026-10-23.json',
      ].sort(),
    );
  });

  it('writes the process, the host and the time into the lock, and a safe host only', async () => {
    const written: string[] = [];
    const lockFds = new Set<number>();
    const watching: QuotaFileSystem = {
      ...nodeFs,
      openSync: (path, flags, mode) => {
        const fd = openSync(path, flags, mode);
        // Only the lock as it is made; unlock opens it again to read it.
        if (path.endsWith('.lock') && (flags & constants.O_CREAT) !== 0) {
          lockFds.add(fd);
        }
        return fd;
      },
      writeSync: (fd, buffer, offset, length) => {
        if (lockFds.delete(fd)) {
          written.push(
            new TextDecoder().decode(buffer.subarray(offset, offset + length)),
          );
        }
        return writeSync(fd, buffer, offset, length);
      },
    };
    const state = freshState();
    await open(state, { fs: watching }).increment(ctx, key, day);
    await open(state, { fs: watching, host: 'max mustermann' }).increment(
      ctx,
      key,
      day,
    );
    const [first, second] = written.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    expect(first).toMatchObject({ pid: 4242, host: 'example-host' });
    expect(String(first?.['ts'])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(second?.['host']).toBe('unknown');
  });

  it('waits for the lock of another and counts once it is gone', async () => {
    const state = freshState();
    const lock = `${fileOf(state)}.lock`;
    writeFileSync(lock, '{}', { mode: 0o600 });
    let waits = 0;
    const store = open(state, {
      sleep: () => {
        waits += 1;
        if (waits === 3) unlinkSync(lock);
        return Promise.resolve();
      },
    });
    await expect(store.increment(ctx, key, day)).resolves.toBe(1);
    expect(waits).toBe(3);
    expect(existsSync(lock)).toBe(false);
  });

  it('fails when the lock of another does not clear in time', async () => {
    const state = freshState();
    const lock = `${fileOf(state)}.lock`;
    writeFileSync(lock, '{}', { mode: 0o600 });
    let now = Date.now();
    const store = open(state, {
      clock: { now: () => now },
      sleep: () => {
        now += 500;
        return Promise.resolve();
      },
    });
    await expect(store.increment(ctx, key, day)).rejects.toThrow(failure);
    expect(existsSync(lock)).toBe(true);
    expect(existsSync(fileOf(state))).toBe(false);
  });

  it('replaces a lock left behind and removes its own after counting', async () => {
    const state = freshState();
    const lock = `${fileOf(state)}.lock`;
    writeFileSync(lock, '{}', { mode: 0o600 });
    const old = (Date.now() - orphanLockMs - 5000) / 1000;
    utimesSync(lock, old, old);
    await expect(open(state).increment(ctx, key, day)).resolves.toBe(1);
    expect(readdirSync(join(state, 'quota'))).toEqual([
      `demo-tenant-${day}.json`,
    ]);
  });

  it('fails at once, and holds nothing, when it cannot move a lock left behind', async () => {
    const state = freshState();
    const lock = `${fileOf(state)}.lock`;
    writeFileSync(lock, '{}', { mode: 0o600 });
    const old = (Date.now() - orphanLockMs - 5000) / 1000;
    utimesSync(lock, old, old);
    const refusing: QuotaFileSystem = {
      ...nodeFs,
      renameSync: () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      },
    };
    const started = Date.now();
    await expect(
      open(state, { fs: refusing }).increment(ctx, key, day),
    ).rejects.toThrow(failure);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(existsSync(lock)).toBe(true);
  });

  it('meets the deadline also when the lock comes and goes', async () => {
    const state = freshState();
    let now = Date.now();
    const flickering: QuotaFileSystem = {
      ...nodeFs,
      openSync: (path, flags, mode) => {
        if (path.endsWith('.lock')) {
          now += 300;
          throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
        }
        return openSync(path, flags, mode);
      },
    };
    await expect(
      open(state, { fs: flickering, clock: { now: () => now } }).increment(
        ctx,
        key,
        day,
      ),
    ).rejects.toThrow(failure);
  });

  it('leaves a lock that is no longer its own', async () => {
    const state = freshState();
    const lock = `${fileOf(state)}.lock`;
    const taking: QuotaFileSystem = {
      ...nodeFs,
      renameSync: (from, to) => {
        renameSync(from, to);
        if (to === fileOf(state)) {
          // Another process took the lock over in the meantime.
          unlinkSync(lock);
          writeFileSync(lock, 'other', { mode: 0o600 });
        }
      },
    };
    await open(state, { fs: taking }).increment(ctx, key, day);
    expect(readFileSync(lock, 'utf8')).toBe('other');
  });

  // Linux often gives the new lock the inode of the one just removed. The
  // lock written in place stands for that on every platform.
  it('leaves a lock of another on the inode of its own', async () => {
    const state = freshState();
    const lock = `${fileOf(state)}.lock`;
    const taking: QuotaFileSystem = {
      ...nodeFs,
      renameSync: (from, to) => {
        renameSync(from, to);
        if (to === fileOf(state)) writeFileSync(lock, 'other');
      },
    };
    await open(state, { fs: taking }).increment(ctx, key, day);
    expect(readFileSync(lock, 'utf8')).toBe('other');
  });

  it.each<[string, (file: string) => void]>([
    [
      'a file with rights for others',
      (file) => {
        writeFileSync(file, countsOf(1), { mode: 0o644 });
        chmodSync(file, 0o644);
      },
    ],
    [
      'a link in place of the file',
      (file) => {
        const target = `${file}.target`;
        writeFileSync(target, countsOf(1), { mode: 0o600 });
        symlinkSync(target, file);
      },
    ],
    [
      'a file larger than the bound',
      (file) => {
        writeFileSync(file, ' '.repeat(maxQuotaFileBytes + 1), {
          mode: 0o600,
        });
      },
    ],
    [
      'a file that is no JSON',
      (file) => {
        writeFileSync(file, '{', { mode: 0o600 });
      },
    ],
    [
      'a file of another tenant',
      (file) => {
        writeFileSync(
          file,
          JSON.stringify({ v: 1, tenant: 'other', day, counts: {} }),
          { mode: 0o600 },
        );
      },
    ],
    [
      'a file with a negative counter',
      (file) => {
        writeFileSync(file, countsOf(-1), { mode: 0o600 });
      },
    ],
    [
      'a file with a key it does not know',
      (file) => {
        writeFileSync(
          file,
          JSON.stringify({
            v: 1,
            tenant: 'demo-tenant',
            day,
            counts: { 'service:stdio:local-stdio': { reads: 1 } },
          }),
          { mode: 0o600 },
        );
      },
    ],
  ])('refuses %s, also to read, and changes nothing', async (_, plant) => {
    const state = freshState();
    const file = fileOf(state);
    plant(file);
    const before = lstatSync(file);
    await expect(open(state).increment(ctx, key, day)).rejects.toThrow(failure);
    await expect(open(state).read(ctx, key, day)).rejects.toThrow(failure);
    expect(lstatSync(file).ino).toBe(before.ino);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it('refuses a file with more actors than the bound, and the actor beyond it', async () => {
    const state = freshState();
    const actors = (count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `user:stdio:a${String(index)}`,
          { special_reads: 1 },
        ]),
      );
    writeFileSync(
      fileOf(state),
      JSON.stringify({
        v: 1,
        tenant: 'demo-tenant',
        day,
        counts: actors(maxQuotaActors + 1),
      }),
      { mode: 0o600 },
    );
    await expect(open(state).read(ctx, key, day)).rejects.toThrow(failure);
    writeFileSync(
      fileOf(state),
      JSON.stringify({
        v: 1,
        tenant: 'demo-tenant',
        day,
        counts: actors(maxQuotaActors),
      }),
      { mode: 0o600 },
    );
    await expect(open(state).increment(ctx, key, day)).rejects.toThrow(failure);
    await expect(
      open(state).increment(
        quotaContext('demo-tenant', 'user', 'stdio:a7'),
        key,
        day,
      ),
    ).resolves.toBe(2);
  });

  it('refuses to go on when the folder is swapped after its check', async () => {
    const state = freshState();
    const folder = join(state, 'quota');
    let looks = 0;
    const swapping: QuotaFileSystem = {
      ...nodeFs,
      lstatSync: (path) => {
        const stats = lstatSync(path);
        if (path !== folder) return stats;
        looks += 1;
        return looks === 1
          ? stats
          : {
              isFile: () => stats.isFile(),
              isDirectory: () => stats.isDirectory(),
              isSymbolicLink: () => stats.isSymbolicLink(),
              uid: stats.uid,
              mode: stats.mode,
              nlink: stats.nlink,
              size: stats.size,
              dev: stats.dev,
              ino: stats.ino + 1,
              mtimeMs: stats.mtimeMs,
            };
      },
    };
    await expect(
      open(state, { fs: swapping }).increment(ctx, key, day),
    ).rejects.toThrow(failure);
    expect(existsSync(fileOf(state))).toBe(false);
    expect(readdirSync(folder)).toEqual([]);
  });

  it('refuses a folder quota that became a link', async () => {
    const state = freshState();
    const other = join(base, `elsewhere-${String(folders)}`);
    mkdirSync(other, { mode: 0o700 });
    rmSync(join(state, 'quota'), { recursive: true });
    symlinkSync(other, join(state, 'quota'));
    await expect(open(state).increment(ctx, key, day)).rejects.toThrow(failure);
    expect(readdirSync(other)).toEqual([]);
  });

  it('refuses a file of another user in its own folder', async () => {
    const state = freshState();
    await open(state).increment(ctx, key, day);
    // Only the file on its descriptor names another owner.
    const stranger: QuotaFileSystem = {
      ...nodeFs,
      fstatSync: (fd) => {
        const stats = fstatSync(fd);
        return {
          isFile: () => stats.isFile(),
          isDirectory: () => stats.isDirectory(),
          isSymbolicLink: () => stats.isSymbolicLink(),
          uid: stats.uid + 1,
          mode: stats.mode,
          nlink: stats.nlink,
          size: stats.size,
          dev: stats.dev,
          ino: stats.ino,
          mtimeMs: stats.mtimeMs,
        };
      },
    };
    await expect(
      open(state, { fs: stranger }).read(ctx, key, day),
    ).rejects.toThrow(failure);
  });

  it.each([
    [
      'a tenant that does not fit',
      quotaContext('Demo Tenant', 'service', 'stdio:x'),
    ],
    ['a tenant with a path', quotaContext('../x', 'service', 'stdio:x')],
    [
      'an actor of an unknown kind',
      quotaContext('demo-tenant', 'admin' as never, 'stdio:x'),
    ],
    [
      'an actor that is an address',
      quotaContext('demo-tenant', 'user', 'max.mustermann@example.org'),
    ],
  ])('refuses %s before it builds a name', async (_, bad) => {
    const state = freshState();
    await expect(open(state).increment(bad, key, day)).rejects.toThrow(
      TypeError,
    );
    await expect(open(state).read(bad, key, day)).rejects.toThrow(TypeError);
    expect(readdirSync(join(state, 'quota'))).toEqual([]);
  });

  it('refuses a platform without the safe ways to open a file', async () => {
    const state = freshState();
    const windows: QuotaFileSystem = {
      ...nodeFs,
      constants: { ...constants, O_NOFOLLOW: undefined },
    };
    await expect(
      open(state, { fs: windows }).increment(ctx, key, day),
    ).rejects.toThrow(failure);
  });

  it.each<[string, Partial<FileQuotaStoreOptions>]>([
    ['a relative folder', { stateDir: 'state' }],
    ['a clock without now', { clock: {} as Clock }],
    ['a process ID of 0', { pid: 0 }],
  ])('throws for %s', (_, extra) => {
    expect(() => open(freshState(), extra)).toThrow(TypeError);
  });
});

describe('prepareQuotaFolder', () => {
  const freshParent = (): string => {
    folders += 1;
    const state = join(base, `parent-${String(folders)}`);
    mkdirSync(state, { mode: 0o700 });
    return state;
  };

  it('creates the folder quota with 0700 and takes it again', () => {
    const state = freshParent();
    expect(prepareQuotaFolder(state)).toEqual({ ok: true });
    expect(statSync(join(state, 'quota')).mode & 0o777).toBe(0o700);
    expect(prepareQuotaFolder(state)).toEqual({ ok: true });
  });

  it('refuses a folder with rights for others', () => {
    const state = freshParent();
    mkdirSync(join(state, 'quota'), { mode: 0o750 });
    chmodSync(join(state, 'quota'), 0o750);
    expect(prepareQuotaFolder(state)).toEqual({
      ok: false,
      code: 'quota_folder_unsafe',
    });
  });

  it('refuses a link in place of the folder', () => {
    const state = freshParent();
    const other = join(base, `target-${String(folders)}`);
    mkdirSync(other, { mode: 0o700 });
    symlinkSync(other, join(state, 'quota'));
    expect(prepareQuotaFolder(state)).toEqual({
      ok: false,
      code: 'quota_folder_unsafe',
    });
  });

  it('reports a folder of state that is gone', () => {
    expect(prepareQuotaFolder(join(base, 'missing'))).toEqual({
      ok: false,
      code: 'quota_folder_unavailable',
    });
  });

  it('refuses a folder of another user and a platform without the checks', () => {
    const state = freshParent();
    expect(
      prepareQuotaFolder(state, {
        ...nodeFs,
        getuid: () => (process.getuid?.() ?? 0) + 1,
      }),
    ).toEqual({ ok: false, code: 'quota_folder_unsafe' });
    expect(
      prepareQuotaFolder(state, { ...nodeFs, getuid: () => undefined }),
    ).toEqual({ ok: false, code: 'quota_folder_platform' });
  });

  it('throws for a folder of state that is no absolute normalised path', () => {
    expect(() => prepareQuotaFolder('state')).toThrow(TypeError);
    expect(() => prepareQuotaFolder('/a/../b')).toThrow(TypeError);
  });
});
