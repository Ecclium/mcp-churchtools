/**
 * The lock of a routine (ADR 0034): a file `<routine>.lock` in the folder
 * `runner` of the folder of state, so that no two processes run the same
 * routine at once, such as the daemon and a run by hand, or two single
 * runs a cron container started close together.
 *
 * Where it stands in a run: right after the first check whether the
 * routine is due. Whoever holds the lock checks once more under it, then
 * begins a try, runs and releases the lock at the end, also after a
 * failure or a signal. A process that finds the lock of another skips the
 * routine and says so; that is no try.
 *
 * Why it can be left behind: a run takes minutes, so a lock does not age
 * out after seconds like the lock of the store of quotas. It counts as
 * left behind only some minutes after the longest a run may take, after
 * which the runner aborts a run, so that the end of an aborted run is not
 * overtaken, or at once when the process that wrote it no longer runs in
 * the same space of processes: the same host and, on Linux, the same
 * namespace of process IDs, since two containers can share a host name
 * and even an ID of a process. A lock of this space with the ID of this
 * very process counts as left behind unless this process holds it: its
 * writer ended, and the ID came back to this process, as it can where the
 * space has no namespace of its own. A container that restarts gets a new
 * namespace, so the lock of its former process counts as left behind only
 * after its time.
 *
 * The file is made with O_EXCL, holds the ID of the process, the host,
 * the namespace, the start and a random ID, and is opened without
 * following a link, as every file of the folder of state. A lock left
 * behind is moved aside under a name of this process before it goes, and
 * a lock another process made in between, told apart by its inode, its
 * last change and its bytes, is put back. Only when a third process takes
 * the place while the lock is aside can the moved one not go back; then
 * two processes may hold the routine, which ADR 0034 names as a risk. A
 * file system that fails halfway can leave a lock under its name aside,
 * which holds nothing but who made it and is never read again. Releasing
 * removes the lock only while it is still this one. Nothing here names a
 * path or a message of the system in what it returns.
 *
 * Only the composition root reaches it, through the subpath
 * `./composition` of core.
 *
 * @packageDocumentation
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { isProxy } from 'node:util/types';

import type { Clock } from '@ecclium/mcp-churchtools-plugin-api';

import { isNormalizedAbsolutePath, stateFolders } from '../config/state-dir.js';

/** The limits of the lock of a routine, frozen. */
export const routineLockLimits = Object.freeze({
  /**
   * The longest a run may take, in milliseconds: up to 400 reads at the
   * default of 300 requests a minute, the model up to 600 seconds and the
   * write. With fewer requests a minute a large run can reach it. The
   * runner aborts a run after it, and a lock older than it counts as left
   * behind.
   */
  maxRunMs: 30 * 60_000,
  /**
   * How long after the longest run a lock still counts as held, for the
   * end of a run the runner aborted, such as a write that is not cut off.
   */
  graceMs: 5 * 60_000,
  /** The largest lock file that is read. */
  maxLockBytes: 1024,
});

/** The name of the folder of the locks in the folder of state. */
export const runnerDirName = stateFolders.runner;

const folderMode = 0o700;
const fileMode = 0o600;

/** What the lock learns about an open descriptor or a path. */
export interface RoutineLockStats {
  isFile(): boolean;
  isDirectory(): boolean;
  readonly uid: number;
  readonly mode: number;
  readonly size: number;
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
}

/**
 * The file functions the lock uses. A test passes its own for what it
 * cannot build on disk, such as a lock of another host.
 */
export interface RoutineLockFileSystem {
  readonly mkdirSync: (path: string, mode: number) => void;
  readonly openSync: (path: string, flags: number, mode?: number) => number;
  readonly fstatSync: (fd: number) => RoutineLockStats;
  readonly lstatSync: (path: string) => RoutineLockStats;
  readonly readSync: (
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ) => number;
  readonly writeSync: (
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
  ) => number;
  readonly closeSync: (fd: number) => void;
  readonly renameSync: (from: string, to: string) => void;
  readonly linkSync: (existing: string, path: string) => void;
  readonly unlinkSync: (path: string) => void;
  /** Reads a link, here the namespace of the process IDs on Linux. */
  readonly readlinkSync: (path: string) => string;
  /** The ID of the user, or undefined on a platform without one. */
  readonly getuid: () => number | undefined;
  readonly constants: Readonly<Record<string, number | undefined>>;
}

const nodeFileSystem: RoutineLockFileSystem = Object.freeze({
  // Never recursive: a recursive mkdir succeeds silently when the path is
  // a link to a folder.
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
  readlinkSync: (path: string) => readlinkSync(path),
  getuid: () => process.getuid?.(),
  constants,
});

// Whether a process of this host runs: signal 0 checks without sending.
// EPERM means it runs under another user.
const processRuns = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
};

/** What {@link createRoutineLocks} needs. */
export interface RoutineLockOptions {
  /** The checked folder of state, an absolute normalised path. */
  readonly stateDir: string;
  /** The clock for the start of a lock and its age. */
  readonly clock: Clock;
  /** The ID of this process, written into each lock. */
  readonly pid: number;
  /** The name of this host, written into each lock. */
  readonly host: string;
  /** The file functions, only for tests. */
  readonly fs?: RoutineLockFileSystem;
  /** Whether a process of this host runs, only for tests. */
  readonly processRuns?: (pid: number) => boolean;
}

/**
 * The answer of {@link RoutineLocks.acquire}: held, with the function that
 * releases it; busy, because another run holds it; or failed, because the
 * folder or a file in it cannot be used.
 */
export type RoutineLock =
  | {
      readonly kind: 'held';
      /** Removes the lock while it is still this one. Never throws. */
      release(): void;
    }
  | { readonly kind: 'busy' }
  | { readonly kind: 'failed' };

/** The locks of the routines of one process. */
export interface RoutineLocks {
  /**
   * Takes the lock of a routine, at once or not at all: it never waits.
   *
   * @param routineId - The ID of the routine.
   * @returns Held, busy or failed.
   */
  acquire(routineId: string): RoutineLock;
}

// The ID of a routine, as the policy and the routines write it.
const routinePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;

// A host as the lock records it: printable ASCII only, at most 255 signs.
const safeHost = (host: unknown): string =>
  typeof host === 'string' && /^[\x21-\x7e]{1,255}$/.test(host)
    ? host
    : 'unknown';

function errorCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || isProxy(error)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(error, 'code')?.value;
}

// An own data property of a parsed lock; nothing else of it is read.
const ownData = (target: unknown, key: string): unknown => {
  if (typeof target !== 'object' || target === null) return undefined;
  const property = Object.getOwnPropertyDescriptor(target, key);
  return property !== undefined && Object.hasOwn(property, 'value')
    ? property.value
    : undefined;
};

// The same bytes, such as of the lock this process wrote.
const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length &&
  left.every((byte, index) => byte === right[index]);

// The namespace of the process IDs of this process on Linux, such as
// pid:[4026531836], or empty where there is none or it cannot be read.
const spaceOf = (fs: RoutineLockFileSystem): string => {
  try {
    const space = fs.readlinkSync('/proc/self/ns/pid');
    return /^[\x21-\x7e]{1,64}$/.test(space) ? space : '';
  } catch {
    return '';
  }
};

const close = (fs: RoutineLockFileSystem, fd: number): void => {
  try {
    fs.closeSync(fd);
  } catch {
    // The descriptor is given up either way.
  }
};

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

const busy = Object.freeze({ kind: 'busy' } as const);
const failed = Object.freeze({ kind: 'failed' } as const);

/** Device and inode of a file and what this process wrote into it. */
interface Mine {
  readonly dev: number;
  readonly ino: number;
  readonly bytes: Uint8Array;
}

/**
 * Creates the locks of the routines of one process, over the folder
 * `runner` of the folder of state, which the first lock creates with 0700
 * and every lock checks: a folder of the user without rights for others.
 *
 * @param options - Folder of state, clock, process, host and, for tests,
 *   the file functions and the check whether a process runs.
 * @returns The locks, frozen.
 * @throws {TypeError} When the folder of state, the clock or the process
 *   ID does not fit.
 * @example
 * ```ts
 * const locks = createRoutineLocks({ stateDir, clock: systemClock, pid: process.pid, host: hostname() });
 * const lock = locks.acquire('dienstplan-report');
 * if (lock.kind === 'held') try { await run(); } finally { lock.release(); }
 * ```
 */
export function createRoutineLocks(options: RoutineLockOptions): RoutineLocks {
  const { stateDir, clock, pid } = options;
  const fs = options.fs ?? nodeFileSystem;
  const runs = options.processRuns ?? processRuns;
  if (
    typeof stateDir !== 'string' ||
    !isNormalizedAbsolutePath(stateDir) ||
    typeof (clock as Partial<Clock> | null)?.now !== 'function' ||
    !Number.isSafeInteger(pid) ||
    pid < 0
  ) {
    throw new TypeError(
      'The locks of the routines need a folder of state, a clock and a process ID.',
    );
  }
  const host = safeHost(options.host);
  const space = spaceOf(fs);
  const folder = `${stateDir === '/' ? '' : stateDir}/${runnerDirName}`;
  // The lock this process holds now for each routine: a lock of this space
  // and process ID that is not among them is one a former process with
  // the same ID left behind.
  const mine = new Map<string, Mine>();

  const flagsOf = ():
    | { readonly read: number; readonly create: number; readonly uid: number }
    | undefined => {
    const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK } =
      fs.constants;
    const uid = fs.getuid();
    if (
      O_RDONLY === undefined ||
      O_WRONLY === undefined ||
      O_CREAT === undefined ||
      O_EXCL === undefined ||
      O_NOFOLLOW === undefined ||
      O_NONBLOCK === undefined ||
      uid === undefined
    ) {
      return undefined;
    }
    return {
      // O_NONBLOCK, so that a FIFO in place of a lock never holds the open.
      read: O_RDONLY | O_NOFOLLOW | O_NONBLOCK,
      create: O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW,
      uid,
    };
  };

  // The folder, made with 0700 if it is missing and checked without
  // following a link: lstat sees a link as no folder.
  const folderReady = (uid: number): boolean => {
    try {
      fs.mkdirSync(folder, folderMode);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') return false;
    }
    try {
      const stats = fs.lstatSync(folder);
      return (
        stats.isDirectory() && stats.uid === uid && (stats.mode & 0o077) === 0
      );
    } catch {
      return false;
    }
  };

  // Makes the lock, or says that one is there. Undefined for any other
  // failure, after which no half lock stays.
  const create = (path: string, flag: number): Mine | 'exists' | undefined => {
    let fd: number;
    try {
      fd = fs.openSync(path, flag, fileMode);
    } catch (error) {
      return errorCode(error) === 'EEXIST' ? 'exists' : undefined;
    }
    try {
      // The random ID makes the content of every lock its own, so that a
      // release can tell it from a later lock on the same inode.
      const bytes = encoder.encode(
        `${JSON.stringify({ v: 1, pid, host, space, ts: new Date(clock.now()).toISOString(), id: randomBytes(8).toString('hex') })}\n`,
      );
      let offset = 0;
      while (offset < bytes.length) {
        const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
        if (written <= 0) throw new Error('The lock was not written.');
        offset += written;
      }
      const stats = fs.fstatSync(fd);
      return { dev: stats.dev, ino: stats.ino, bytes };
    } catch {
      try {
        fs.unlinkSync(path);
      } catch {
        // A half lock ages out.
      }
      return undefined;
    } finally {
      close(fs, fd);
    }
  };

  // The bytes of an open lock of this user, or undefined for a file that
  // is no regular file of this user. Of a larger file only the bound of a
  // lock is read, which then does not parse, so its last change decides.
  const readLock = (
    fd: number,
    uid: number,
  ):
    | { readonly stats: RoutineLockStats; readonly bytes: Uint8Array }
    | undefined => {
    const stats = fs.fstatSync(fd);
    if (!stats.isFile() || stats.uid !== uid) return undefined;
    const size = Math.min(stats.size, routineLockLimits.maxLockBytes);
    const bytes = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      const read = fs.readSync(fd, bytes, offset, size - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    return { stats, bytes: bytes.subarray(0, offset) };
  };

  // Whether a lock someone holds is left behind: older than the longest
  // run and its grace, by its start or else by its last change, or
  // written in the space of this process by a process that no longer
  // runs, or by this process ID while this process does not hold it. A
  // host whose name could not be read shares no space with any other.
  const leftBehind = (
    routineId: string,
    stats: RoutineLockStats,
    bytes: Uint8Array,
  ): boolean => {
    let data: unknown;
    try {
      data = JSON.parse(decoder.decode(bytes));
    } catch {
      data = undefined;
    }
    const ts = ownData(data, 'ts');
    const start = typeof ts === 'string' ? Date.parse(ts) : Number.NaN;
    const since = Number.isFinite(start) ? start : stats.mtimeMs;
    const { maxRunMs, graceMs } = routineLockLimits;
    if (clock.now() - since > maxRunMs + graceMs) return true;
    const owner = ownData(data, 'pid');
    if (
      host === 'unknown' ||
      ownData(data, 'host') !== host ||
      (ownData(data, 'space') ?? '') !== space ||
      !Number.isSafeInteger(owner)
    ) {
      return false;
    }
    return owner === pid ? !mine.has(routineId) : !runs(owner as number);
  };

  // Whether the file at a path is the lock judged: the same device, inode
  // and last change, and the same bytes. Linux often gives a new file the
  // inode of one just removed, and a time may be coarse, so the bytes with
  // their random ID decide. Anything that cannot be read is another lock.
  const isJudged = (
    path: string,
    judged: { readonly stats: RoutineLockStats; readonly bytes: Uint8Array },
    flags: { readonly read: number; readonly uid: number },
  ): boolean => {
    let fd: number;
    try {
      fd = fs.openSync(path, flags.read);
    } catch {
      return false;
    }
    try {
      const read = readLock(fd, flags.uid);
      return (
        read !== undefined &&
        read.stats.dev === judged.stats.dev &&
        read.stats.ino === judged.stats.ino &&
        read.stats.mtimeMs === judged.stats.mtimeMs &&
        sameBytes(read.bytes, judged.bytes)
      );
    } catch {
      return false;
    } finally {
      close(fs, fd);
    }
  };

  // Moves a lock left behind aside and removes it. A lock that another
  // process made in place of the one judged is put back. False when the
  // file system fails.
  const clear = (
    path: string,
    judged: { readonly stats: RoutineLockStats; readonly bytes: Uint8Array },
    flags: { readonly read: number; readonly uid: number },
  ): boolean => {
    const aside = `${path}.${String(pid)}.${randomBytes(8).toString('hex')}.stale`;
    try {
      fs.renameSync(path, aside);
    } catch (error) {
      // Another process cleared it first.
      return errorCode(error) === 'ENOENT';
    }
    try {
      if (!isJudged(aside, judged, flags)) {
        // A link, not a rename: a lock a third process made in the
        // meantime stays, and only this copy goes.
        try {
          fs.linkSync(aside, path);
        } catch (error) {
          if (errorCode(error) !== 'EEXIST') return false;
        }
      }
      fs.unlinkSync(aside);
      return true;
    } catch {
      return false;
    }
  };

  // Removes the lock only while it is still this one: the same device and
  // inode, and the same bytes. Never throws. The routine counts as no
  // longer held only when this was the lock the process holds for it.
  const release = (path: string, routineId: string, lock: Mine): void => {
    if (mine.get(routineId) === lock) mine.delete(routineId);
    const flags = flagsOf();
    if (flags === undefined) return;
    let fd: number;
    try {
      fd = fs.openSync(path, flags.read);
    } catch {
      return;
    }
    let same = false;
    try {
      const read = readLock(fd, flags.uid);
      same =
        read !== undefined &&
        read.stats.dev === lock.dev &&
        read.stats.ino === lock.ino &&
        sameBytes(read.bytes, lock.bytes);
    } catch {
      // Not readable as this lock: it stays and ages out.
    } finally {
      close(fs, fd);
    }
    if (!same) return;
    try {
      fs.unlinkSync(path);
    } catch {
      // Gone already.
    }
  };

  const acquire = (routineId: string): RoutineLock => {
    if (typeof routineId !== 'string' || !routinePattern.test(routineId)) {
      throw new TypeError('The ID of the routine is invalid.');
    }
    const flags = flagsOf();
    if (flags === undefined || !folderReady(flags.uid)) return failed;
    const path = `${folder}/${routineId}.lock`;
    // Three tries at most: a lock gone in between, or cleared, is tried
    // again, and a place that two others keep taking is busy.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const made = create(path, flags.create);
      if (made === undefined) return failed;
      if (made !== 'exists') {
        mine.set(routineId, made);
        // A second call of release does nothing: it would otherwise forget
        // a later lock of the same routine that this process holds.
        let released = false;
        return Object.freeze({
          kind: 'held',
          release: () => {
            if (released) return;
            released = true;
            release(path, routineId, made);
          },
        });
      }
      let fd: number;
      try {
        fd = fs.openSync(path, flags.read);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') continue;
        return failed;
      }
      let judged: {
        readonly stats: RoutineLockStats;
        readonly bytes: Uint8Array;
        readonly left: boolean;
      };
      try {
        const read = readLock(fd, flags.uid);
        if (read === undefined) return failed;
        judged = {
          stats: read.stats,
          bytes: read.bytes,
          left: leftBehind(routineId, read.stats, read.bytes),
        };
      } catch {
        return failed;
      } finally {
        close(fs, fd);
      }
      if (!judged.left) return busy;
      if (!clear(path, judged, flags)) return failed;
    }
    return busy;
  };

  return Object.freeze({ acquire });
}
