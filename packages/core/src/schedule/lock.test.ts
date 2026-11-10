import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
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

import type { Clock } from '@ecclium/mcp-churchtools-plugin-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRoutineLocks,
  type RoutineLock,
  type RoutineLockFileSystem,
  routineLockLimits,
  type RoutineLockOptions,
  type RoutineLocks,
  type RoutineLockStats,
  runnerDirName,
} from './lock.js';

// The locks of the routines against real folders in the temporary folder,
// where two lock objects with other process IDs or hosts stand for two
// processes, and against a file system in memory for what the disk cannot
// show, such as a lock of another user, the root as the folder of state or
// a system that refuses at one given step (ADR 0034).

const routine = 'dienstplan-report';
const { maxRunMs, graceMs, maxLockBytes } = routineLockLimits;
// A lock counts as left behind by its age only after the longest run and
// its grace.
const stale = maxRunMs + graceMs;
// Every time is relative to the start of this file, so that no test
// depends on the day it runs on.
const start = Date.now();
const fixed = (time: number): Clock => Object.freeze({ now: () => time });
const oldStart = new Date(start - stale - 1).toISOString();
// Namespaces of process IDs as Linux names them.
const spaceA = 'pid:[4026531836]';
const spaceB = 'pid:[4026532001]';

const systemError = (code: string): Error =>
  Object.assign(new Error('from the system'), { code });

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const parse = (text: string): unknown => JSON.parse(text);

// The content of a lock another process wrote: young, of this host and of
// process 5151, without a namespace as before there was one, unless the
// fields say otherwise.
const lockText = (fields: Readonly<Record<string, unknown>> = {}): string =>
  `${JSON.stringify({
    v: 1,
    pid: 5151,
    host: 'example-host',
    ts: new Date(start).toISOString(),
    id: '0123456789abcdef',
    ...fields,
  })}\n`;

const busy = { kind: 'busy' };
const failed = { kind: 'failed' };

type Held = Extract<RoutineLock, { kind: 'held' }>;
const held = (lock: RoutineLock): Held => {
  if (lock.kind !== 'held') throw new Error(`The lock is ${lock.kind}.`);
  return lock;
};

// An entry of the file system in memory. A test changes it in place for a
// change under the same inode, or puts a new one for a new inode.
interface Entry {
  readonly kind: 'file' | 'folder';
  readonly ino: number;
  uid: number;
  mode: number;
  mtimeMs: number;
  bytes: Uint8Array;
}

interface Memory {
  readonly fs: RoutineLockFileSystem;
  readonly entries: Map<string, Entry>;
  /** Puts a file at a path, on a new inode, with the changes given. */
  readonly put: (
    path: string,
    content: string | Uint8Array,
    changes?: Partial<Entry>,
  ) => Entry;
  readonly entry: (path: string) => Entry;
  readonly text: (path: string) => string;
  /** The paths there are, sorted. */
  readonly names: () => string[];
  /** How many descriptors are open. */
  readonly open: () => number;
  /** The links read, in order. */
  readonly links: string[];
}

const fakeUid = 1000;
const fakeState = '/srv/ecclium-state';
const fakeRunner = `${fakeState}/${runnerDirName}`;
const fakeLock = `${fakeRunner}/${routine}.lock`;

// The file functions over two maps, of paths and of descriptors, with the
// answers of the system where a lock needs them: EEXIST, ENOENT, EBADF.
// The namespace of the process IDs is the one given, or none, as on macOS,
// where the link cannot be read.
const memory = (space?: string): Memory => {
  const entries = new Map<string, Entry>();
  const descriptors = new Map<number, Entry>();
  const links: string[] = [];
  let lastFd = 99;
  let lastIno = 0;
  const make = (
    kind: Entry['kind'],
    mode: number,
    bytes: Uint8Array = new Uint8Array(),
  ): Entry => {
    lastIno += 1;
    return { kind, ino: lastIno, uid: fakeUid, mode, mtimeMs: start, bytes };
  };
  const at = (path: string): Entry => {
    const entry = entries.get(path);
    if (entry === undefined) throw systemError('ENOENT');
    return entry;
  };
  const opened = (fd: number): Entry => {
    const entry = descriptors.get(fd);
    if (entry === undefined) throw systemError('EBADF');
    return entry;
  };
  const statsOf = (entry: Entry): RoutineLockStats => ({
    isFile: () => entry.kind === 'file',
    isDirectory: () => entry.kind === 'folder',
    uid: entry.uid,
    mode: entry.mode,
    size: entry.bytes.length,
    dev: 7,
    ino: entry.ino,
    mtimeMs: entry.mtimeMs,
  });
  const fs: RoutineLockFileSystem = Object.freeze({
    mkdirSync: (path: string, mode: number) => {
      if (entries.has(path)) throw systemError('EEXIST');
      entries.set(path, make('folder', mode));
    },
    openSync: (path: string, flags: number, mode?: number) => {
      let entry = entries.get(path);
      if ((flags & constants.O_CREAT) !== 0) {
        if (entry !== undefined) throw systemError('EEXIST');
        entry = make('file', mode ?? 0o600);
        entries.set(path, entry);
      } else if (entry === undefined) {
        throw systemError('ENOENT');
      }
      lastFd += 1;
      descriptors.set(lastFd, entry);
      return lastFd;
    },
    fstatSync: (fd: number) => statsOf(opened(fd)),
    lstatSync: (path: string) => statsOf(at(path)),
    readSync: (
      fd: number,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number,
    ) => {
      const chunk = opened(fd).bytes.subarray(position, position + length);
      buffer.set(chunk, offset);
      return chunk.length;
    },
    writeSync: (
      fd: number,
      buffer: Uint8Array,
      offset: number,
      length: number,
    ) => {
      const entry = opened(fd);
      const bytes = new Uint8Array(entry.bytes.length + length);
      bytes.set(entry.bytes);
      bytes.set(buffer.subarray(offset, offset + length), entry.bytes.length);
      entry.bytes = bytes;
      return length;
    },
    closeSync: (fd: number) => {
      if (!descriptors.delete(fd)) throw systemError('EBADF');
    },
    renameSync: (from: string, to: string) => {
      const entry = at(from);
      entries.delete(from);
      entries.set(to, entry);
    },
    linkSync: (existing: string, path: string) => {
      const entry = at(existing);
      if (entries.has(path)) throw systemError('EEXIST');
      entries.set(path, entry);
    },
    unlinkSync: (path: string) => {
      at(path);
      entries.delete(path);
    },
    readlinkSync: (path: string) => {
      links.push(path);
      if (space === undefined) throw systemError('ENOENT');
      return space;
    },
    getuid: () => fakeUid,
    constants,
  });
  return {
    fs,
    entries,
    put: (path, content, changes = {}) => {
      const entry: Entry = {
        ...make(
          'file',
          0o600,
          typeof content === 'string' ? encoder.encode(content) : content,
        ),
        ...changes,
      };
      entries.set(path, entry);
      return entry;
    },
    entry: at,
    text: (path) => decoder.decode(at(path).bytes),
    names: () => [...entries.keys()].sort(),
    open: () => descriptors.size,
    links,
  };
};

// The file functions of Node.js with the namespace given, or none, so that
// a test on disk runs alike on Linux, which has one, and on macOS, which
// has none.
const diskFs = (space?: string): RoutineLockFileSystem =>
  Object.freeze({
    mkdirSync: (path: string, mode: number) => {
      mkdirSync(path, { mode });
    },
    openSync,
    fstatSync,
    lstatSync,
    readSync,
    writeSync,
    closeSync,
    renameSync,
    linkSync,
    unlinkSync,
    readlinkSync: () => {
      if (space === undefined) throw systemError('ENOENT');
      return space;
    },
    getuid: () => process.getuid?.(),
    constants,
  });

// Changes what fstat says of every descriptor opened for a path other than
// the lock itself, which in clearing is the name the lock was moved to.
const asideStats = (
  m: Memory,
  change: (stats: RoutineLockStats) => RoutineLockStats,
): RoutineLockFileSystem => {
  const aside = new Set<number>();
  return {
    ...m.fs,
    openSync: (path, flags, mode) => {
      const fd = m.fs.openSync(path, flags, mode);
      if (path !== fakeLock) aside.add(fd);
      return fd;
    },
    fstatSync: (fd) => {
      const stats = m.fs.fstatSync(fd);
      return aside.has(fd) ? change(stats) : stats;
    },
  };
};

// The locks of process 4242 on the host example-host over the file system
// in memory. Every other process of this host counts as running, unless a
// test says otherwise.
const fakeLocks = (
  fs: RoutineLockFileSystem,
  extra: Partial<RoutineLockOptions> = {},
): RoutineLocks =>
  createRoutineLocks({
    stateDir: fakeState,
    clock: fixed(start),
    pid: 4242,
    host: 'example-host',
    fs,
    processRuns: () => true,
    ...extra,
  });

// Steps a test makes fail once a lock is held, to reach its release with a
// system that refuses or a lock that changed.
interface Faults {
  uid?: boolean;
  open?: boolean;
  fstat?: boolean;
  read?: boolean;
  unlink?: boolean;
  dev?: boolean;
}

const faulty = (m: Memory, faults: Faults): RoutineLockFileSystem => ({
  ...m.fs,
  getuid: () => (faults.uid === true ? undefined : fakeUid),
  openSync: (path, flags, mode) => {
    if (faults.open === true) throw systemError('EACCES');
    return m.fs.openSync(path, flags, mode);
  },
  fstatSync: (fd) => {
    if (faults.fstat === true) throw systemError('EIO');
    const stats = m.fs.fstatSync(fd);
    return faults.dev === true ? { ...stats, dev: stats.dev + 1 } : stats;
  },
  readSync: (fd, buffer, offset, length, position) => {
    if (faults.read === true) throw systemError('EIO');
    return m.fs.readSync(fd, buffer, offset, length, position);
  },
  unlinkSync: (path) => {
    if (faults.unlink === true) throw systemError('EPERM');
    m.fs.unlinkSync(path);
  },
});

describe('createRoutineLocks', () => {
  const valid = (): RoutineLockOptions => ({
    stateDir: fakeState,
    clock: fixed(start),
    pid: 4242,
    host: 'example-host',
    fs: memory().fs,
  });

  it('names its limits and its folder, frozen', () => {
    expect(routineLockLimits).toEqual({
      maxRunMs: 30 * 60_000,
      graceMs: 5 * 60_000,
      maxLockBytes: 1024,
    });
    expect(Object.isFrozen(routineLockLimits)).toBe(true);
    expect(runnerDirName).toBe('runner');
  });

  it.each<[string, Readonly<Record<string, unknown>>]>([
    ['a folder of state that is no string', { stateDir: 5 }],
    ['a relative folder of state', { stateDir: 'srv/ecclium-state' }],
    [
      'a folder of state with a slash at its end',
      { stateDir: `${fakeState}/` },
    ],
    [
      'a folder of state that is not normalised',
      { stateDir: '/srv/../srv/ecclium-state' },
    ],
    ['no clock', { clock: undefined }],
    ['a clock of null', { clock: null }],
    ['a clock without a function now', { clock: { now: 5 } }],
    ['a negative process ID', { pid: -1 }],
    ['a process ID that is no integer', { pid: 1.5 }],
    ['a process ID beyond the safe integers', { pid: 2 ** 53 }],
    ['a process ID that is a string', { pid: '4242' }],
  ])('throws a TypeError for %s', (_, changes) => {
    expect(() => createRoutineLocks(Object.assign(valid(), changes))).toThrow(
      TypeError,
    );
  });

  it('takes the process ID 0 and gives frozen locks', () => {
    const locks = createRoutineLocks({ ...valid(), pid: 0 });
    expect(Object.isFrozen(locks)).toBe(true);
    expect(locks.acquire(routine).kind).toBe('held');
  });

  it('throws a TypeError for an ID of a routine that does not fit, before it touches a file', () => {
    const m = memory();
    const locks = fakeLocks(m.fs);
    for (const id of [
      '',
      'Dienstplan',
      '-report',
      'a_b',
      'a/b',
      '../a',
      'a.lock',
      'a'.repeat(64),
      5,
      undefined,
    ]) {
      expect(() => locks.acquire(id as string)).toThrow(TypeError);
    }
    expect(m.names()).toEqual([]);
    held(locks.acquire('a'.repeat(63))).release();
    held(locks.acquire('0')).release();
  });
});

describe('the locks on disk', () => {
  let state = '';
  beforeEach(() => {
    state = mkdtempSync(join(tmpdir(), 'ecclium-routine-lock-'));
  });
  afterEach(() => {
    rmSync(state, { recursive: true, force: true });
  });

  const runnerPath = (): string => join(state, runnerDirName);
  const lockPath = (): string => join(runnerPath(), `${routine}.lock`);
  const lockFile = (): Record<string, unknown> =>
    parse(readFileSync(lockPath(), 'utf8')) as Record<string, unknown>;

  // A process with its own ID and host, and no namespace on any platform.
  // Every other process of this host counts as running, so that no test
  // asks the real table of processes about a made-up ID.
  const onDisk = (extra: Partial<RoutineLockOptions> = {}): RoutineLocks =>
    createRoutineLocks({
      stateDir: state,
      clock: fixed(start),
      pid: 4242,
      host: 'example-host',
      fs: diskFs(),
      processRuns: () => true,
      ...extra,
    });

  // A lock another process left, with its last change set from the clock
  // of the test rather than from the time it is written.
  const plant = (content: string | Uint8Array, mtimeMs = start): void => {
    mkdirSync(runnerPath(), { recursive: true, mode: 0o700 });
    writeFileSync(lockPath(), content, { mode: 0o600 });
    utimesSync(lockPath(), mtimeMs / 1000, mtimeMs / 1000);
  };

  it('makes the folder runner with 0700 and a lock with 0600 that names the process, the host and the start', () => {
    const lock = held(onDisk().acquire(routine));
    expect(Object.isFrozen(lock)).toBe(true);
    expect(statSync(runnerPath()).mode & 0o777).toBe(0o700);
    expect(statSync(lockPath()).mode & 0o777).toBe(0o600);
    expect(readFileSync(lockPath(), 'utf8').endsWith('\n')).toBe(true);
    const { id, ...rest } = lockFile();
    expect(rest).toEqual({
      v: 1,
      pid: 4242,
      host: 'example-host',
      space: '',
      ts: new Date(start).toISOString(),
    });
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    lock.release();
    expect(readdirSync(runnerPath())).toEqual([]);
  });

  it('lets one of two processes hold a routine, and the other after the release', () => {
    const first = onDisk();
    const second = onDisk({ pid: 5151 });
    const lock = held(first.acquire(routine));
    const { id } = lockFile();
    expect(second.acquire(routine)).toEqual(busy);
    expect(onDisk({ host: 'other-host' }).acquire(routine)).toEqual(busy);
    // The process that holds it does not take it twice, and holds others.
    expect(first.acquire(routine)).toEqual(busy);
    const other = held(first.acquire('other-routine'));
    lock.release();
    const taken = held(second.acquire(routine));
    expect(lockFile()).toMatchObject({ pid: 5151 });
    // Every lock has an ID of its own, so that a release can tell it from a
    // later lock on the same inode.
    expect(lockFile()['id']).not.toBe(id);
    taken.release();
    other.release();
    expect(readdirSync(runnerPath())).toEqual([]);
  });

  // A second call of release must not forget a later lock of the same
  // routine, which the process would otherwise take as left behind.
  it('does nothing on a second release, also after a new lock', () => {
    const locks = onDisk();
    const first = held(locks.acquire(routine));
    first.release();
    const second = held(locks.acquire(routine));
    first.release();
    expect(locks.acquire(routine)).toEqual(busy);
    expect(lockFile()).toMatchObject({ pid: 4242 });
    second.release();
    expect(readdirSync(runnerPath())).toEqual([]);
  });

  it('keeps the lock of a process of this host that runs, and takes it over once that process is gone', () => {
    held(onDisk().acquire(routine));
    const asked: number[] = [];
    let running = true;
    const second = onDisk({
      pid: 5151,
      processRuns: (pid) => {
        asked.push(pid);
        return running;
      },
    });
    expect(second.acquire(routine)).toEqual(busy);
    running = false;
    const lock = held(second.acquire(routine));
    expect(asked).toEqual([4242, 4242]);
    expect(lockFile()).toMatchObject({ pid: 5151 });
    // The lock left behind is gone, and nothing moved aside stays.
    expect(readdirSync(runnerPath())).toEqual([`${routine}.lock`]);
    lock.release();
  });

  it('takes over a lock older than the longest run and its grace by its start, also of another host, and not a moment earlier', () => {
    held(onDisk({ pid: 5151, host: 'other-host' }).acquire(routine));
    expect(onDisk({ clock: fixed(start + maxRunMs) }).acquire(routine)).toEqual(
      busy,
    );
    expect(onDisk({ clock: fixed(start + stale) }).acquire(routine)).toEqual(
      busy,
    );
    const later = start + stale + 1;
    const lock = held(onDisk({ clock: fixed(later) }).acquire(routine));
    expect(lockFile()).toMatchObject({
      pid: 4242,
      host: 'example-host',
      ts: new Date(later).toISOString(),
    });
    expect(readdirSync(runnerPath())).toEqual([`${routine}.lock`]);
    lock.release();
  });

  it.each<[string, string | Uint8Array]>([
    ['nothing in it', ''],
    ['no JSON', '{"v":1,'],
    ['bytes that are no UTF-8', new Uint8Array([0x7b, 0xff, 0x7d])],
    ['null', 'null'],
    ['a number', '5'],
    ['no start', lockText({ ts: undefined })],
    ['a start that is no time', lockText({ ts: 'yesterday' })],
    ['a start that is no string', lockText({ ts: start })],
  ])('judges a lock with %s by its last change', (_, content) => {
    plant(content, start - stale - 1000);
    held(onDisk().acquire(routine)).release();
    plant(content, start);
    expect(onDisk().acquire(routine)).toEqual(busy);
  });

  it('takes over a lock of its own process ID that it does not hold, as after a restart in a container', () => {
    plant(lockText({ pid: 4242 }));
    const runs = vi.fn(() => true);
    const locks = onDisk({ processRuns: runs });
    const lock = held(locks.acquire(routine));
    expect(runs).not.toHaveBeenCalled();
    // Now it holds it, and the same ID keeps it.
    expect(locks.acquire(routine)).toEqual(busy);
    lock.release();
    expect(readdirSync(runnerPath())).toEqual([]);
  });

  it('asks the system whether the process of a lock of its own space runs', () => {
    // Neither file functions nor a check of processes of its own: the
    // defaults, as the runner makes the locks. The namespace is the one of
    // the platform, none on macOS and pid:[...] on Linux, so the locks
    // planted here take it from a lock of this process.
    const locks = createRoutineLocks({
      stateDir: state,
      clock: fixed(start),
      pid: process.pid + 1,
      host: 'example-host',
    });
    const probe = held(locks.acquire('probe'));
    const { space } = parse(
      readFileSync(join(runnerPath(), 'probe.lock'), 'utf8'),
    ) as Record<string, unknown>;
    probe.release();
    expect(typeof space).toBe('string');
    plant(lockText({ pid: process.pid, space }));
    expect(locks.acquire(routine)).toEqual(busy);
    // Process 1 runs, under another user unless the test runs as root; it
    // counts as running either way.
    plant(lockText({ pid: 1, space }));
    expect(locks.acquire(routine)).toEqual(busy);
    // No process has this ID, and the system answers ESRCH.
    plant(lockText({ pid: 2 ** 31 - 2, space }));
    held(locks.acquire(routine)).release();
    expect(readdirSync(runnerPath())).toEqual([]);
  });

  it('counts a process the system does not let it signal as running, and one the system does not know as gone', () => {
    // The system answers EPERM, as for a process of another user, also
    // when the test runs as root, and then ESRCH. The function is set and
    // put back as a property, since process is never passed on (ADR 0054).
    // eslint-disable-next-line @typescript-eslint/unbound-method -- only put back below, never called
    const kill = process.kill;
    const asked: [number, unknown][] = [];
    let answer = 'EPERM';
    process.kill = (pid: number, signal?: string | number): true => {
      asked.push([pid, signal]);
      throw systemError(answer);
    };
    try {
      const locks = createRoutineLocks({
        stateDir: state,
        clock: fixed(start),
        pid: 4242,
        host: 'example-host',
        fs: diskFs(),
      });
      plant(lockText());
      expect(locks.acquire(routine)).toEqual(busy);
      answer = 'ESRCH';
      held(locks.acquire(routine)).release();
      expect(asked).toEqual([
        [5151, 0],
        [5151, 0],
      ]);
    } finally {
      process.kill = kill;
    }
  });

  // Two containers can share a host name and even a process ID; only the
  // namespace of the process IDs tells them apart.
  it('keeps the lock of a process with the same host and ID in another namespace, until it is old', () => {
    const runs = vi.fn(() => false);
    const first = onDisk({ fs: diskFs(spaceA), processRuns: runs });
    const second = onDisk({ fs: diskFs(spaceB), processRuns: runs });
    const lock = held(first.acquire(routine));
    expect(lockFile()).toMatchObject({
      pid: 4242,
      host: 'example-host',
      space: spaceA,
    });
    expect(second.acquire(routine)).toEqual(busy);
    lock.release();
    const other = held(second.acquire(routine));
    expect(first.acquire(routine)).toEqual(busy);
    expect(runs).not.toHaveBeenCalled();
    // Only its age clears the lock of another namespace.
    held(
      onDisk({ fs: diskFs(spaceA), clock: fixed(start + stale + 1) }).acquire(
        routine,
      ),
    ).release();
    other.release();
    expect(readdirSync(runnerPath())).toEqual([]);
  });

  it('judges a lock without a namespace, as written before there was one, as of no namespace', () => {
    plant(lockText());
    expect(onDisk().acquire(routine)).toEqual(busy);
    // Its process is gone, and this process has no namespace either.
    held(onDisk({ processRuns: () => false }).acquire(routine)).release();
    // A process with a namespace judges such a lock by its age only.
    const runs = vi.fn(() => false);
    const spaced = onDisk({ fs: diskFs(spaceA), processRuns: runs });
    plant(lockText());
    expect(spaced.acquire(routine)).toEqual(busy);
    expect(runs).not.toHaveBeenCalled();
    plant(lockText({ ts: oldStart }));
    held(spaced.acquire(routine)).release();
    expect(readdirSync(runnerPath())).toEqual([]);
  });

  it('refuses a folder runner that is open for others, a link or no folder, and a folder of state that is gone', () => {
    mkdirSync(runnerPath(), { mode: 0o700 });
    chmodSync(runnerPath(), 0o750);
    expect(onDisk().acquire(routine)).toEqual(failed);
    expect(readdirSync(runnerPath())).toEqual([]);
    rmSync(runnerPath(), { recursive: true });
    const elsewhere = join(state, 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, runnerPath());
    expect(onDisk().acquire(routine)).toEqual(failed);
    expect(readdirSync(elsewhere)).toEqual([]);
    unlinkSync(runnerPath());
    writeFileSync(runnerPath(), '', { mode: 0o600 });
    expect(onDisk().acquire(routine)).toEqual(failed);
    expect(onDisk({ stateDir: join(state, 'gone') }).acquire(routine)).toEqual(
      failed,
    );
  });

  it('refuses a lock that is a link or a folder, also an old one, and leaves it', () => {
    mkdirSync(runnerPath(), { mode: 0o700 });
    const target = join(state, 'target.lock');
    const old = lockText({ ts: oldStart });
    writeFileSync(target, old, { mode: 0o600 });
    symlinkSync(target, lockPath());
    expect(onDisk().acquire(routine)).toEqual(failed);
    expect(lstatSync(lockPath()).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe(old);
    unlinkSync(lockPath());
    mkdirSync(lockPath(), { mode: 0o700 });
    expect(onDisk().acquire(routine)).toEqual(failed);
    expect(statSync(lockPath()).isDirectory()).toBe(true);
  });

  it('releases only its own lock, and never throws', () => {
    const lock = held(onDisk().acquire(routine));
    // Another process judged it left behind and took the place.
    unlinkSync(lockPath());
    const taken = held(onDisk({ pid: 5151 }).acquire(routine));
    lock.release();
    expect(lockFile()).toMatchObject({ pid: 5151 });
    taken.release();
    expect(readdirSync(runnerPath())).toEqual([]);
    // A second release finds nothing and does nothing.
    expect(() => {
      taken.release();
    }).not.toThrow();
  });
});

describe('the locks in memory', () => {
  it('makes the folder runner and its locks at the root when the root is the folder of state', () => {
    const m = memory();
    const lock = held(fakeLocks(m.fs, { stateDir: '/' }).acquire(routine));
    expect(m.names()).toEqual(['/runner', `/runner/${routine}.lock`]);
    lock.release();
    expect(m.names()).toEqual(['/runner']);
    expect(m.open()).toBe(0);
  });

  it('writes the namespace of the process IDs into each lock, read once, and none for a link it cannot read or that is not plain', () => {
    for (const [link, written] of [
      [spaceA, spaceA],
      ['p'.repeat(64), 'p'.repeat(64)],
      ['p'.repeat(65), ''],
      ['pid: [1]', ''],
      ['', ''],
      [undefined, ''],
    ] as const) {
      const m = memory(link);
      const locks = fakeLocks(m.fs);
      held(locks.acquire(routine)).release();
      held(locks.acquire('other-routine'));
      expect(parse(m.text(`${fakeRunner}/other-routine.lock`))).toMatchObject({
        space: written,
      });
      expect(m.links).toEqual(['/proc/self/ns/pid']);
    }
  });

  it('judges the locks of a host whose name it could not read by their age only', () => {
    const m = memory();
    const runs = vi.fn(() => false);
    const locks = fakeLocks(m.fs, {
      host: 'max mustermann',
      processRuns: runs,
    });
    m.put(fakeLock, lockText({ host: 'unknown' }));
    expect(locks.acquire(routine)).toEqual(busy);
    // Not even a lock with its own process ID counts as left behind.
    m.put(fakeLock, lockText({ host: 'unknown', pid: 4242 }));
    expect(locks.acquire(routine)).toEqual(busy);
    expect(runs).not.toHaveBeenCalled();
    m.put(fakeLock, lockText({ host: 'unknown', ts: oldStart }));
    held(locks.acquire(routine)).release();
    expect(m.names()).toEqual([fakeRunner]);
  });

  it('writes a host that is no printable ASCII or longer than 255 signs as unknown', () => {
    for (const [host, written] of [
      ['h'.repeat(255), 'h'.repeat(255)],
      ['max mustermann', 'unknown'],
      ['', 'unknown'],
      ['hôst', 'unknown'],
      ['h'.repeat(256), 'unknown'],
      [5, 'unknown'],
    ] as const) {
      const m = memory();
      held(fakeLocks(m.fs, { host: host as string }).acquire(routine));
      expect(parse(m.text(fakeLock))).toMatchObject({ host: written });
    }
  });

  it('fails on a platform without the flags or the ID of the user, and makes nothing', () => {
    const cases: Partial<RoutineLockFileSystem>[] = [
      { constants: { ...constants, O_NOFOLLOW: undefined } },
      { constants: { ...constants, O_NONBLOCK: undefined } },
      { constants: { ...constants, O_EXCL: undefined } },
      { getuid: () => undefined },
    ];
    for (const changes of cases) {
      const m = memory();
      expect(fakeLocks({ ...m.fs, ...changes }).acquire(routine)).toEqual(
        failed,
      );
      expect(m.names()).toEqual([]);
    }
  });

  it('fails when the folder runner cannot be made or is no private folder, and makes no lock', () => {
    const cases: ((m: Memory) => Partial<RoutineLockFileSystem>)[] = [
      () => ({
        mkdirSync: () => {
          throw systemError('EACCES');
        },
      }),
      () => ({
        mkdirSync: () => {
          throw new Error('without a code');
        },
      }),
      // A value of any kind, as a system may throw, and a proxy, whose code
      // is never read: neither counts as a folder that is there.
      () => ({
        mkdirSync: () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- a value of any kind, as a system may throw
          throw 'refused';
        },
      }),
      () => ({
        mkdirSync: () => {
          throw new Proxy(systemError('EEXIST'), {});
        },
      }),
      () => ({
        lstatSync: () => {
          throw systemError('EIO');
        },
      }),
      (m) => ({
        lstatSync: (path) => ({ ...m.fs.lstatSync(path), uid: fakeUid + 1 }),
      }),
      (m) => ({
        lstatSync: (path) => ({ ...m.fs.lstatSync(path), mode: 0o750 }),
      }),
      (m) => ({
        lstatSync: (path) => ({
          ...m.fs.lstatSync(path),
          isDirectory: () => false,
        }),
      }),
    ];
    for (const changes of cases) {
      const m = memory();
      expect(fakeLocks({ ...m.fs, ...changes(m) }).acquire(routine)).toEqual(
        failed,
      );
      expect(m.entries.has(fakeLock)).toBe(false);
    }
  });

  it('fails when the lock cannot be made, and leaves no half lock', () => {
    const cases: Partial<RoutineLockFileSystem>[] = [
      {
        openSync: () => {
          throw systemError('EACCES');
        },
      },
      { writeSync: () => 0 },
      {
        writeSync: () => {
          throw systemError('ENOSPC');
        },
      },
      {
        fstatSync: () => {
          throw systemError('EIO');
        },
      },
    ];
    for (const changes of cases) {
      const m = memory();
      expect(fakeLocks({ ...m.fs, ...changes }).acquire(routine)).toEqual(
        failed,
      );
      expect(m.names()).toEqual([fakeRunner]);
      expect(m.open()).toBe(0);
    }
    // A clock without a valid time gives no start to write.
    const m = memory();
    expect(
      fakeLocks(m.fs, { clock: fixed(Number.NaN) }).acquire(routine),
    ).toEqual(failed);
    expect(m.names()).toEqual([fakeRunner]);
  });

  it('leaves a half lock it cannot remove to age out', () => {
    let writes = 0;
    const cases: ((m: Memory) => Partial<RoutineLockFileSystem>)[] = [
      // Ten bytes, then nothing more.
      (m) => ({
        writeSync: (fd, buffer, offset, length) => {
          writes += 1;
          return writes === 1
            ? m.fs.writeSync(fd, buffer, offset, Math.min(length, 10))
            : 0;
        },
      }),
      () => ({
        fstatSync: () => {
          throw systemError('EIO');
        },
      }),
    ];
    for (const changes of cases) {
      const m = memory();
      expect(
        fakeLocks({
          ...m.fs,
          ...changes(m),
          unlinkSync: () => {
            throw systemError('EPERM');
          },
        }).acquire(routine),
      ).toEqual(failed);
      expect(m.names()).toEqual([fakeRunner, fakeLock]);
      expect(fakeLocks(m.fs, { pid: 5151 }).acquire(routine)).toEqual(busy);
      expect(
        fakeLocks(m.fs, {
          pid: 5151,
          clock: fixed(start + stale + 1),
        }).acquire(routine).kind,
      ).toBe('held');
    }
  });

  it('writes the lock in parts when the system takes fewer bytes at once', () => {
    const m = memory();
    const lock = held(
      fakeLocks({
        ...m.fs,
        writeSync: (fd, buffer, offset) =>
          m.fs.writeSync(fd, buffer, offset, 1),
      }).acquire(routine),
    );
    expect(parse(m.text(fakeLock))).toMatchObject({
      v: 1,
      pid: 4242,
      host: 'example-host',
    });
    lock.release();
    expect(m.names()).toEqual([fakeRunner]);
  });

  it('gives up a descriptor even when closing it fails', () => {
    const m = memory();
    let closes = 0;
    const fs: RoutineLockFileSystem = {
      ...m.fs,
      closeSync: (fd) => {
        closes += 1;
        m.fs.closeSync(fd);
        throw systemError('EIO');
      },
    };
    const lock = held(fakeLocks(fs).acquire(routine));
    expect(fakeLocks(fs, { pid: 5151 }).acquire(routine)).toEqual(busy);
    lock.release();
    expect(m.names()).toEqual([fakeRunner]);
    expect(closes).toBe(3);
    expect(m.open()).toBe(0);
  });

  it('tries again when the lock goes between the try to make it and the read', () => {
    const m = memory();
    m.put(fakeLock, lockText());
    let gone = 0;
    const fs: RoutineLockFileSystem = {
      ...m.fs,
      openSync: (path, flags, mode) => {
        if ((flags & constants.O_CREAT) === 0 && gone === 0) {
          gone += 1;
          // The process that held it released it just now.
          m.entries.delete(path);
        }
        return m.fs.openSync(path, flags, mode);
      },
    };
    const lock = held(fakeLocks(fs).acquire(routine));
    expect(gone).toBe(1);
    expect(parse(m.text(fakeLock))).toMatchObject({ pid: 4242 });
    lock.release();
    expect(m.names()).toEqual([fakeRunner]);
  });

  it('fails when a lock there does not open, stat or read as a regular file of the user, and leaves it', () => {
    // Old, so that only the refusal keeps it.
    const old = lockText({ ts: oldStart });
    const refusingRead =
      (code: string) =>
      (m: Memory): Partial<RoutineLockFileSystem> => ({
        openSync: (path, flags, mode) => {
          if ((flags & constants.O_CREAT) === 0) throw systemError(code);
          return m.fs.openSync(path, flags, mode);
        },
      });
    const cases: [
      Partial<Entry>,
      (m: Memory) => Partial<RoutineLockFileSystem>,
    ][] = [
      [{}, refusingRead('ELOOP')],
      [{}, refusingRead('EACCES')],
      [{ uid: fakeUid + 1 }, () => ({})],
      [{ kind: 'folder' }, () => ({})],
      [
        {},
        () => ({
          fstatSync: () => {
            throw systemError('EIO');
          },
        }),
      ],
      [
        {},
        () => ({
          readSync: () => {
            throw systemError('EIO');
          },
        }),
      ],
    ];
    for (const [entry, changes] of cases) {
      const m = memory();
      m.put(fakeLock, old, entry);
      expect(fakeLocks({ ...m.fs, ...changes(m) }).acquire(routine)).toEqual(
        failed,
      );
      expect(m.text(fakeLock)).toBe(old);
      expect(m.open()).toBe(0);
    }
  });

  it('judges a lock that stops short by what it read', () => {
    // Ten bytes, then nothing, as of a lock that shrank while it was read:
    // no JSON, so its last change decides and not the start in it.
    const short = (m: Memory): RoutineLockFileSystem => ({
      ...m.fs,
      readSync: (fd, buffer, offset, length, position) =>
        position === 0
          ? m.fs.readSync(fd, buffer, offset, Math.min(length, 10), position)
          : 0,
    });
    const young = memory();
    young.put(fakeLock, lockText({ ts: oldStart }));
    expect(fakeLocks(short(young)).acquire(routine)).toEqual(busy);
    const old = memory();
    old.put(fakeLock, lockText(), { mtimeMs: start - stale - 1 });
    expect(fakeLocks(short(old)).acquire(routine).kind).toBe('held');
  });

  it('reads no more than the bound of a lock, and judges a larger one by its last change', () => {
    const sizes: number[] = [];
    const counting = (m: Memory): RoutineLockFileSystem => ({
      ...m.fs,
      readSync: (fd, buffer, offset, length, position) => {
        sizes.push(buffer.length);
        return m.fs.readSync(fd, buffer, offset, length, position);
      },
    });
    const large = lockText({ pad: 'x'.repeat(2 * maxLockBytes) });
    const young = memory();
    young.put(fakeLock, large);
    expect(fakeLocks(counting(young)).acquire(routine)).toEqual(busy);
    expect(sizes).toEqual([maxLockBytes]);
    const old = memory();
    old.put(fakeLock, large, { mtimeMs: start - stale - 1 });
    expect(fakeLocks(old.fs).acquire(routine).kind).toBe('held');
  });

  it.each<[string, Readonly<Record<string, unknown>>]>([
    ['of another host', { host: 'other-host' }],
    ['without a host', { host: undefined }],
    ['of this host with a process ID that is a string', { pid: '5151' }],
    ['of this host with a process ID that is no integer', { pid: 51.5 }],
    ['of this host without a process ID', { pid: undefined }],
  ])(
    'keeps a young lock %s without asking whether a process runs',
    (_, fields) => {
      const m = memory();
      m.put(fakeLock, lockText(fields));
      const runs = vi.fn(() => false);
      expect(fakeLocks(m.fs, { processRuns: runs }).acquire(routine)).toEqual(
        busy,
      );
      expect(runs).not.toHaveBeenCalled();
    },
  );
});

describe('clearing a lock left behind, in memory', () => {
  const old = lockText({ ts: oldStart });
  // A lock a third process made in the place: young, of a process that
  // runs.
  const third = lockText({ pid: 6161 });

  // Between the read of the old lock and its move, a third process cleared
  // it and made its own, on a new inode, which the move then takes.
  const swapOnce = (
    m: Memory,
    after: (from: string) => void = () => undefined,
  ) => {
    let swapped = false;
    return (from: string, to: string): void => {
      if (!swapped) {
        swapped = true;
        m.put(from, third);
        m.fs.renameSync(from, to);
        after(from);
        return;
      }
      m.fs.renameSync(from, to);
    };
  };

  it('moves the lock aside under another name and removes it there', () => {
    const m = memory();
    m.put(fakeLock, old);
    const moved: string[] = [];
    const lock = held(
      fakeLocks({
        ...m.fs,
        renameSync: (from, to) => {
          moved.push(to);
          m.fs.renameSync(from, to);
        },
      }).acquire(routine),
    );
    expect(moved).toHaveLength(1);
    expect(moved[0]?.startsWith(`${fakeRunner}/`)).toBe(true);
    expect(moved[0]).not.toBe(fakeLock);
    expect(m.names()).toEqual([fakeRunner, fakeLock]);
    expect(parse(m.text(fakeLock))).toMatchObject({ pid: 4242 });
    lock.release();
  });

  it('tries again when another process cleared the lock first', () => {
    const m = memory();
    m.put(fakeLock, old);
    const lock = held(
      fakeLocks({
        ...m.fs,
        renameSync: (from) => {
          m.entries.delete(from);
          throw systemError('ENOENT');
        },
      }).acquire(routine),
    );
    expect(parse(m.text(fakeLock))).toMatchObject({ pid: 4242 });
    lock.release();
  });

  it('fails, and leaves the lock, when it cannot move it aside', () => {
    for (const error of [systemError('EACCES'), new Error('without a code')]) {
      const m = memory();
      m.put(fakeLock, old);
      expect(
        fakeLocks({
          ...m.fs,
          renameSync: () => {
            throw error;
          },
        }).acquire(routine),
      ).toEqual(failed);
      expect(m.text(fakeLock)).toBe(old);
    }
  });

  it('puts back the lock of a third process that the move took, and is busy', () => {
    const m = memory();
    m.put(fakeLock, old);
    expect(
      fakeLocks({ ...m.fs, renameSync: swapOnce(m) }).acquire(routine),
    ).toEqual(busy);
    expect(m.text(fakeLock)).toBe(third);
    expect(m.names()).toEqual([fakeRunner, fakeLock]);
  });

  // Linux often gives a new file the inode of one just removed: a lock a
  // third process made on the same inode still differs in its last change,
  // and goes back.
  it('puts back a lock of a third process on the same inode, and is busy', () => {
    const m = memory();
    m.put(fakeLock, old);
    let swapped = false;
    expect(
      fakeLocks({
        ...m.fs,
        renameSync: (from, to) => {
          if (!swapped) {
            swapped = true;
            const entry = m.entry(from);
            entry.bytes = new TextEncoder().encode(third);
            entry.mtimeMs = start + 1;
          }
          m.fs.renameSync(from, to);
        },
      }).acquire(routine),
    ).toEqual(busy);
    expect(m.text(fakeLock)).toBe(third);
    expect(m.names()).toEqual([fakeRunner, fakeLock]);
  });

  it('keeps a fourth lock that took the place before the third could go back, and is busy', () => {
    const m = memory();
    m.put(fakeLock, old);
    const fourth = lockText({ pid: 7171 });
    expect(
      fakeLocks({
        ...m.fs,
        renameSync: swapOnce(m, (from) => {
          m.put(from, fourth);
        }),
      }).acquire(routine),
    ).toEqual(busy);
    expect(m.text(fakeLock)).toBe(fourth);
    expect(m.names()).toEqual([fakeRunner, fakeLock]);
  });

  // A file system with coarse times can give the lock of a third process
  // the inode and the last change of the one just removed: its bytes, with
  // their random ID, still tell it apart.
  it('puts back a lock of a third process with the same inode and last change, and is busy', () => {
    const m = memory();
    m.put(fakeLock, old);
    let swapped = false;
    expect(
      fakeLocks({
        ...m.fs,
        renameSync: (from, to) => {
          if (!swapped) {
            swapped = true;
            m.entry(from).bytes = encoder.encode(third);
          }
          m.fs.renameSync(from, to);
        },
      }).acquire(routine),
    ).toEqual(busy);
    expect(m.text(fakeLock)).toBe(third);
    expect(m.names()).toEqual([fakeRunner, fakeLock]);
  });

  // What it moved aside and cannot read as the lock it judged counts as
  // another lock and goes back. The place then keeps a lock left behind,
  // so it is busy after three tries.
  it('puts back what it moved aside when it cannot tell it for the lock it judged', () => {
    const cases: ((m: Memory) => RoutineLockFileSystem)[] = [
      (m) => ({
        ...m.fs,
        openSync: (path, flags, mode) => {
          if (path !== fakeLock) throw systemError('EACCES');
          return m.fs.openSync(path, flags, mode);
        },
      }),
      (m) =>
        asideStats(m, () => {
          throw systemError('EIO');
        }),
      (m) => asideStats(m, (stats) => ({ ...stats, uid: stats.uid + 1 })),
      (m) => asideStats(m, (stats) => ({ ...stats, isFile: () => false })),
      (m) => asideStats(m, (stats) => ({ ...stats, dev: stats.dev + 1 })),
      (m) => asideStats(m, (stats) => ({ ...stats, ino: stats.ino + 1 })),
      (m) =>
        asideStats(m, (stats) => ({ ...stats, mtimeMs: stats.mtimeMs + 1 })),
    ];
    for (const fs of cases) {
      const m = memory();
      m.put(fakeLock, old);
      expect(fakeLocks(fs(m)).acquire(routine)).toEqual(busy);
      expect(m.text(fakeLock)).toBe(old);
      expect(m.names()).toEqual([fakeRunner, fakeLock]);
      expect(m.open()).toBe(0);
    }
  });

  it('fails when what it moved aside does not go back or go', () => {
    const cases: ((m: Memory) => Partial<RoutineLockFileSystem>)[] = [
      (m) => ({
        renameSync: swapOnce(m),
        linkSync: () => {
          throw systemError('EACCES');
        },
      }),
      () => ({
        unlinkSync: () => {
          throw systemError('EPERM');
        },
      }),
    ];
    for (const changes of cases) {
      const m = memory();
      m.put(fakeLock, old);
      expect(fakeLocks({ ...m.fs, ...changes(m) }).acquire(routine)).toEqual(
        failed,
      );
    }
  });

  it('is busy after three tries when the lock keeps going between the tries', () => {
    let makes = 0;
    const m = memory();
    expect(
      fakeLocks({
        ...m.fs,
        openSync: (_path, flags) => {
          if ((flags & constants.O_CREAT) === 0) throw systemError('ENOENT');
          makes += 1;
          throw systemError('EEXIST');
        },
      }).acquire(routine),
    ).toEqual(busy);
    expect(makes).toBe(3);
    expect(m.names()).toEqual([fakeRunner]);
  });

  it('is busy after three tries when the place keeps being taken by locks left behind', () => {
    const m = memory();
    m.put(fakeLock, old);
    let moves = 0;
    expect(
      fakeLocks({
        ...m.fs,
        renameSync: (from, to) => {
          moves += 1;
          m.fs.renameSync(from, to);
          m.put(from, old);
        },
      }).acquire(routine),
    ).toEqual(busy);
    expect(moves).toBe(3);
    expect(m.names()).toEqual([fakeRunner, fakeLock]);
  });
});

describe('the release, in memory', () => {
  it('removes the lock and closes every descriptor', () => {
    const m = memory();
    const lock = held(fakeLocks(m.fs).acquire(routine));
    expect(m.open()).toBe(0);
    lock.release();
    expect(m.names()).toEqual([fakeRunner]);
    expect(m.open()).toBe(0);
  });

  it.each<[string, (m: Memory, faults: Faults) => void]>([
    [
      'on another device',
      (_m, faults) => {
        faults.dev = true;
      },
    ],
    [
      'on another inode with the same bytes',
      (m) => {
        m.put(fakeLock, m.entry(fakeLock).bytes);
      },
    ],
    [
      'longer',
      (m) => {
        const entry = m.entry(fakeLock);
        entry.bytes = new Uint8Array([...entry.bytes, 0x0a]);
      },
    ],
    [
      'of the same length with other bytes',
      (m) => {
        const entry = m.entry(fakeLock);
        entry.bytes = entry.bytes.map((byte, index) =>
          index === 3 ? byte ^ 1 : byte,
        );
      },
    ],
    [
      'of another user',
      (m) => {
        m.entry(fakeLock).uid = fakeUid + 1;
      },
    ],
    [
      'a folder now',
      (m) => {
        m.put(fakeLock, '', { kind: 'folder' });
      },
    ],
  ])('leaves a lock that is %s', (_, change) => {
    const m = memory();
    const faults: Faults = {};
    const lock = held(fakeLocks(faulty(m, faults)).acquire(routine));
    change(m, faults);
    lock.release();
    expect(m.entries.has(fakeLock)).toBe(true);
    expect(m.open()).toBe(0);
  });

  it('never throws when the system refuses, and leaves the lock', () => {
    const steps: (keyof Faults)[] = ['uid', 'open', 'fstat', 'read', 'unlink'];
    for (const step of steps) {
      const m = memory();
      const faults: Faults = {};
      const lock = held(fakeLocks(faulty(m, faults)).acquire(routine));
      faults[step] = true;
      expect(() => {
        lock.release();
      }).not.toThrow();
      expect(m.entries.has(fakeLock)).toBe(true);
      expect(m.open()).toBe(0);
    }
  });

  it('keeps holding a newer lock of the routine when an older one is released', () => {
    const m = memory();
    const locks = fakeLocks(m.fs);
    const older = held(locks.acquire(routine));
    // The lock of the older run went, and a newer run of this process took
    // the place.
    m.entries.delete(fakeLock);
    const newer = held(locks.acquire(routine));
    older.release();
    expect(m.entries.has(fakeLock)).toBe(true);
    expect(locks.acquire(routine)).toEqual(busy);
    newer.release();
    expect(m.names()).toEqual([fakeRunner]);
  });

  it('takes over its own lock after a release that could not remove it, and not while it holds it', () => {
    const m = memory();
    const faults: Faults = {};
    const locks = fakeLocks(faulty(m, faults));
    const lock = held(locks.acquire(routine));
    expect(locks.acquire(routine)).toEqual(busy);
    faults.unlink = true;
    lock.release();
    expect(m.entries.has(fakeLock)).toBe(true);
    faults.unlink = false;
    held(locks.acquire(routine)).release();
    expect(m.names()).toEqual([fakeRunner]);
  });
});
