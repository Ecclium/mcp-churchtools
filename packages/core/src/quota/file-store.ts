/**
 * The store of quotas of the free core (ADR 0063): one file per tenant and
 * UTC day in the folder `quota` of the folder of state, the folder with
 * 0700, the file with 0600. It holds counters only, one per actor and key.
 *
 * Two processes share the file. Every change runs under a lock file made
 * with O_EXCL, which holds the ID of the process, the host and the time,
 * and goes through a temporary file, `fsync` and a rename, so that a
 * reader always sees a whole file. A lock older than ten seconds counts
 * as left behind and is replaced. Within one process the changes run one
 * after the other. Like the audit file, every file is opened without
 * following a link and checked on its descriptor (ADR 0028). Nothing here
 * names a path in what it throws or returns.
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
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { isProxy } from 'node:util/types';

import {
  type Clock,
  type IsoDate,
  isIsoDate,
  type QuotaKey,
  quotaKeys,
  type QuotaStore,
  type TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';

import { actorKinds, isActorId } from '../audit/schema.js';
import { isNormalizedAbsolutePath, quotaDirName } from '../config/state-dir.js';
import { isTenantId } from '../logger/index.js';

export { quotaDirName };

/** The mode of the folder `quota`. */
export const quotaDirMode = 0o700;

/** The mode of a file of quotas and of a lock file. */
export const quotaFileMode = 0o600;

/** How long a change waits for the lock of another before it fails. */
export const lockWaitMs = 2000;

/** The age from which a lock counts as left behind by a process. */
export const orphanLockMs = 10_000;

/** The largest file of quotas the store reads. */
export const maxQuotaFileBytes = 65_536;

/** The most actors one file of quotas holds. */
export const maxQuotaActors = 1000;

// How long to wait between two attempts at the lock.
const lockRetryMs = 25;

/**
 * Why the folder `quota` cannot be used, frozen. A code never carries the
 * path or the message of the file system.
 */
export const quotaFolderCodes = Object.freeze([
  'quota_folder_platform',
  'quota_folder_unavailable',
  'quota_folder_unsafe',
] as const);

/** Why the folder `quota` cannot be used. */
export type QuotaFolderCode = (typeof quotaFolderCodes)[number];

/** What the store learns about an open descriptor or a path. */
export interface QuotaFileStats {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  readonly uid: number;
  readonly mode: number;
  readonly nlink: number;
  readonly size: number;
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
}

/**
 * The file functions the store uses. A test passes its own for what it
 * cannot build on disk, such as a file of another owner.
 */
export interface QuotaFileSystem {
  readonly mkdirSync: (path: string, mode: number) => void;
  readonly openSync: (path: string, flags: number, mode?: number) => number;
  readonly fstatSync: (fd: number) => QuotaFileStats;
  readonly lstatSync: (path: string) => QuotaFileStats;
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
  readonly fsyncSync: (fd: number) => void;
  readonly closeSync: (fd: number) => void;
  readonly renameSync: (from: string, to: string) => void;
  readonly linkSync: (existing: string, path: string) => void;
  readonly unlinkSync: (path: string) => void;
  readonly readdirSync: (path: string) => string[];
  /** The ID of the user, or undefined on a platform without one. */
  readonly getuid: () => number | undefined;
  readonly constants: Readonly<Record<string, number | undefined>>;
}

const nodeFileSystem: QuotaFileSystem = Object.freeze({
  mkdirSync: (path: string, mode: number) => {
    // Never recursive: a recursive mkdir succeeds silently when the path
    // is a link to a folder.
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

/** What {@link createFileQuotaStore} needs. */
export interface FileQuotaStoreOptions {
  /** The checked folder of state, an absolute normalised path. */
  readonly stateDir: string;
  /** The clock for the age and the wait of a lock. */
  readonly clock: Clock;
  /** The ID of the process, written into the lock. */
  readonly pid: number;
  /** The name of the host, written into the lock. */
  readonly host: string;
  /** The file functions, only for tests. */
  readonly fs?: QuotaFileSystem;
  /** Waits between two attempts at a lock, only for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

// One error for every failure of the file system, so that no path and no
// message of the system leaves the store.
const unavailable = (): Error => new Error('The store of quotas failed.');

const errorCode = (error: unknown): unknown => {
  if (typeof error !== 'object' || error === null || isProxy(error)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(error, 'code')?.value;
};

// An own data property; a getter of a caller never runs.
const ownData = (target: unknown, key: string): unknown => {
  if (typeof target !== 'object' || target === null || isProxy(target)) {
    return undefined;
  }
  const property = Object.getOwnPropertyDescriptor(target, key);
  return property !== undefined && Object.hasOwn(property, 'value')
    ? property.value
    : undefined;
};

// A folder or a file of the user, without rights for the group or others.
const isPrivate = (stats: QuotaFileStats, uid: number): boolean =>
  stats.uid === uid && (stats.mode & 0o077) === 0;

const platformFlags = (
  fs: QuotaFileSystem,
):
  | {
      readonly read: number;
      readonly create: number;
      readonly folder: number;
      readonly uid: number;
    }
  | undefined => {
  const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_NOCTTY } =
    fs.constants;
  const { O_DIRECTORY, O_NONBLOCK } = fs.constants;
  const uid = fs.getuid();
  if (
    O_RDONLY === undefined ||
    O_WRONLY === undefined ||
    O_CREAT === undefined ||
    O_EXCL === undefined ||
    O_NOFOLLOW === undefined ||
    O_NOCTTY === undefined ||
    O_DIRECTORY === undefined ||
    O_NONBLOCK === undefined ||
    uid === undefined
  ) {
    return undefined;
  }
  return {
    // O_NONBLOCK, so that a FIFO in place of the file never holds the
    // open; a regular file reads as before.
    read: O_RDONLY | O_NOFOLLOW | O_NOCTTY | O_NONBLOCK,
    create: O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_NOCTTY,
    folder: O_RDONLY | O_DIRECTORY | O_NOFOLLOW,
    uid,
  };
};

const folderOf = (stateDir: string): string =>
  `${stateDir === '/' ? '' : stateDir}/${quotaDirName}`;

/**
 * Creates the folder `quota` with 0700 if it is missing, never
 * recursively, and checks it through a descriptor opened without following
 * a link: a folder of the user without rights for others. The first stage
 * of the start runs it before the second loads, with nothing but `node:fs`.
 *
 * @param stateDir - The checked folder of state.
 * @param fs - The file functions, only for tests.
 * @returns Whether the folder can be used, or the code of the first check
 *   that failed.
 * @throws {TypeError} When the folder of state is no absolute normalised
 *   path.
 * @example
 * ```ts
 * const prepared = prepareQuotaFolder(stateDir);
 * if (!prepared.ok) report(prepared.code);
 * ```
 */
export function prepareQuotaFolder(
  stateDir: string,
  fs: QuotaFileSystem = nodeFileSystem,
):
  | { readonly ok: true }
  | { readonly ok: false; readonly code: QuotaFolderCode } {
  if (typeof stateDir !== 'string' || !isNormalizedAbsolutePath(stateDir)) {
    throw new TypeError('The store of quotas needs a folder of state.');
  }
  const refuse = (code: QuotaFolderCode) =>
    Object.freeze({ __proto__: null, ok: false as const, code });
  const flags = platformFlags(fs);
  if (flags === undefined) return refuse('quota_folder_platform');
  const folder = folderOf(stateDir);
  try {
    fs.mkdirSync(folder, quotaDirMode);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST')
      return refuse('quota_folder_unavailable');
  }
  let fd: number;
  try {
    fd = fs.openSync(folder, flags.folder);
  } catch (error) {
    const code = errorCode(error);
    return refuse(
      code === 'ELOOP' || code === 'ENOTDIR' || code === 'EMLINK'
        ? 'quota_folder_unsafe'
        : 'quota_folder_unavailable',
    );
  }
  try {
    const stats = fs.fstatSync(fd);
    return stats.isDirectory() && isPrivate(stats, flags.uid)
      ? Object.freeze({ __proto__: null, ok: true as const })
      : refuse('quota_folder_unsafe');
  } catch {
    return refuse('quota_folder_unsafe');
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Only the folder was open, and its check is done.
    }
  }
}

/** Device and inode of a file or folder. */
interface Identity {
  readonly dev: number;
  readonly ino: number;
}

/** A lock this process holds: where it lies and what it wrote into it. */
interface HeldLock extends Identity {
  readonly bytes: Uint8Array;
}

/** The counters of one tenant and day: per actor, per key. */
type Counts = Record<string, Partial<Record<QuotaKey, number>>>;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

// A host as the lock records it: printable ASCII only, at most 255 signs.
const safeHost = (host: unknown): string =>
  typeof host === 'string' && /^[\x21-\x7e]{1,255}$/.test(host)
    ? host
    : 'unknown';

// What follows the day in the name of a lock moved aside and of a
// temporary file: the ID of the process and 16 hexadecimal signs.
const staleSuffix = /^\.json\.lock\.\d{1,10}\.[0-9a-f]{16}\.stale$/;
const temporarySuffix = /^\.\d{1,10}\.[0-9a-f]{16}\.tmp$/;

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

// The counters of a file, or undefined when the file is not one the store
// wrote for this tenant and day.
const parseCounts = (
  text: string,
  tenantId: string,
  day: IsoDate,
): Counts | undefined => {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (
    ownData(data, 'v') !== 1 ||
    ownData(data, 'tenant') !== tenantId ||
    ownData(data, 'day') !== day
  ) {
    return undefined;
  }
  const counts = ownData(data, 'counts');
  if (typeof counts !== 'object' || counts === null || Array.isArray(counts)) {
    return undefined;
  }
  const actors = Object.keys(counts);
  if (actors.length > maxQuotaActors) return undefined;
  const result: Counts = Object.create(null) as Counts;
  for (const actor of actors) {
    const entry = ownData(counts, actor);
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return undefined;
    }
    const kept: Partial<Record<QuotaKey, number>> = Object.create(
      null,
    ) as Partial<Record<QuotaKey, number>>;
    for (const key of Object.keys(entry)) {
      const value = ownData(entry, key);
      if (!(quotaKeys as readonly string[]).includes(key) || !isCount(value)) {
        return undefined;
      }
      kept[key as QuotaKey] = value;
    }
    result[actor] = kept;
  }
  return result;
};

/**
 * Builds the store of quotas over the folder `quota` of the folder of
 * state, which {@link prepareQuotaFolder} made. Each file belongs to one
 * tenant and UTC day; the store takes tenant and actor from the context
 * and checks them, the key and the day before it builds a name. Files of
 * the same tenant for earlier days it removes when it first counts on a
 * new day.
 *
 * @param options - Folder of state, clock, process, host and, for tests,
 *   the file functions and the wait.
 * @returns The store, frozen. Its promises reject with a fixed error when
 *   the file system fails, the file is not one it wrote or the lock of
 *   another process does not clear in time, and with a `TypeError` for a
 *   tenant, actor, key or day that does not fit.
 * @throws {TypeError} When the folder of state, the clock or the process
 *   ID is invalid.
 * @example
 * ```ts
 * const store = createFileQuotaStore({ stateDir, clock: systemClock,
 *   pid: process.pid, host: hostname() });
 * await store.increment(ctx, 'special_reads', day);
 * ```
 */
export function createFileQuotaStore(
  options: FileQuotaStoreOptions,
): QuotaStore {
  const { stateDir, clock, pid, fs = nodeFileSystem } = options;
  if (
    typeof stateDir !== 'string' ||
    !isNormalizedAbsolutePath(stateDir) ||
    typeof (clock as Partial<Clock> | null)?.now !== 'function' ||
    !Number.isSafeInteger(pid) ||
    pid < 1
  ) {
    throw new TypeError(
      'The store of quotas needs a folder of state, a clock and a process ID.',
    );
  }
  const host = safeHost(options.host);
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const folder = folderOf(stateDir);
  // The days already cleaned up, per tenant, so that the folder is listed
  // once a day and not on every call.
  const cleaned = new Map<string, string>();
  // The changes of this process, one after the other.
  let queue: Promise<unknown> = Promise.resolve();

  // Tenant, actor, key and day, checked before any name is built from
  // them, whoever calls the store.
  const subjectOf = (
    ctx: TenantContext,
    key: QuotaKey,
    day: IsoDate,
  ): { readonly tenantId: string; readonly actor: string } => {
    const tenantId = ownData(ctx, 'tenantId');
    const actor = ownData(ctx, 'actor');
    const kind = ownData(actor, 'kind');
    const id = ownData(actor, 'id');
    if (!isTenantId(tenantId)) throw new TypeError('The tenant is invalid.');
    if (!(actorKinds as readonly unknown[]).includes(kind) || !isActorId(id)) {
      throw new TypeError('The actor is invalid.');
    }
    if (!(quotaKeys as readonly unknown[]).includes(key)) {
      throw new TypeError('The key is unknown.');
    }
    if (!isIsoDate(day)) throw new TypeError('The day is invalid.');
    return { tenantId, actor: `${String(kind)}:${id}` };
  };

  const flagsOrFail = () => {
    const flags = platformFlags(fs);
    if (flags === undefined) throw unavailable();
    return flags;
  };

  // The folder must still be a folder of the user and no link. Its device
  // and inode are kept, so that every later step can see whether the
  // folder was swapped in the meantime, as the audit file does (ADR 0028).
  const checkFolder = (uid: number): Identity => {
    let stats: QuotaFileStats;
    try {
      stats = fs.lstatSync(folder);
    } catch {
      throw unavailable();
    }
    if (
      stats.isSymbolicLink() ||
      !stats.isDirectory() ||
      !isPrivate(stats, uid)
    ) {
      throw unavailable();
    }
    return { dev: stats.dev, ino: stats.ino };
  };

  // The folder is still the one checked.
  const sameFolder = (checked: Identity): void => {
    let now: QuotaFileStats;
    try {
      now = fs.lstatSync(folder);
    } catch {
      throw unavailable();
    }
    if (
      now.isSymbolicLink() ||
      now.dev !== checked.dev ||
      now.ino !== checked.ino
    ) {
      throw unavailable();
    }
  };

  // The open descriptor is still what the path leads to, in the folder
  // checked.
  const samePlace = (
    stats: QuotaFileStats,
    path: string,
    checked: Identity,
  ): void => {
    let atPath: QuotaFileStats;
    try {
      atPath = fs.lstatSync(path);
    } catch {
      throw unavailable();
    }
    if (atPath.dev !== stats.dev || atPath.ino !== stats.ino) {
      throw unavailable();
    }
    sameFolder(checked);
  };

  const readAll = (fd: number, size: number): Uint8Array => {
    // One byte more than the size, so that a file that grew is noticed.
    const buffer = new Uint8Array(size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = fs.readSync(
        fd,
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (read === 0) break;
      offset += read;
    }
    if (offset !== size) throw unavailable();
    return buffer.subarray(0, size);
  };

  // The counters in the file, or none when there is no file yet.
  const readCounts = (
    path: string,
    tenantId: string,
    day: IsoDate,
    flags: { readonly read: number; readonly uid: number },
    checked: Identity,
  ): Counts => {
    let fd: number;
    try {
      fd = fs.openSync(path, flags.read);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return Object.create(null) as Counts;
      }
      throw unavailable();
    }
    try {
      const stats = fs.fstatSync(fd);
      if (
        !stats.isFile() ||
        !isPrivate(stats, flags.uid) ||
        stats.nlink !== 1 ||
        stats.size > maxQuotaFileBytes
      ) {
        throw unavailable();
      }
      samePlace(stats, path, checked);
      let text: string;
      try {
        text = decoder.decode(readAll(fd, stats.size));
      } catch {
        throw unavailable();
      }
      const counts = parseCounts(text, tenantId, day);
      if (counts === undefined) throw unavailable();
      return counts;
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // The file was only read.
      }
    }
  };

  const writeAll = (fd: number, bytes: Uint8Array): void => {
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw unavailable();
      offset += written;
    }
  };

  // A new file under a name no other process uses, written whole and
  // flushed before the rename makes it the file.
  const writeCounts = (
    path: string,
    tenantId: string,
    day: IsoDate,
    counts: Counts,
    flags: { readonly create: number },
    checked: Identity,
  ): void => {
    const bytes = encoder.encode(
      `${JSON.stringify({ v: 1, tenant: tenantId, day, counts })}\n`,
    );
    if (bytes.length > maxQuotaFileBytes) throw unavailable();
    const temporary = `${folder}/.${tenantId}-${day}.${String(pid)}.${randomBytes(8).toString('hex')}.tmp`;
    let fd: number;
    try {
      fd = fs.openSync(temporary, flags.create, quotaFileMode);
    } catch {
      throw unavailable();
    }
    let moved = false;
    try {
      samePlace(fs.fstatSync(fd), temporary, checked);
      writeAll(fd, bytes);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = -1;
      sameFolder(checked);
      fs.renameSync(temporary, path);
      moved = true;
    } catch {
      throw unavailable();
    } finally {
      if (fd >= 0) {
        try {
          fs.closeSync(fd);
        } catch {
          // The file is removed below in any case.
        }
      }
      if (!moved) {
        try {
          fs.unlinkSync(temporary);
        } catch {
          // A file left behind holds only counters.
        }
      }
    }
  };

  // Takes the lock of a file, or fails once the wait is over. A lock older
  // than orphanLockMs is moved aside under a name of this process and
  // removed; if what was moved is not the lock that was judged old, another
  // process took the place in between, and it is put back. Every path
  // through the loop either waits, ends, or meets the deadline, so that a
  // lock it cannot clear never holds the process.
  const lock = async (
    path: string,
    flags: { readonly create: number },
    checked: Identity,
  ): Promise<HeldLock> => {
    const deadline = clock.now() + lockWaitMs;
    for (let attempt = 0; ; attempt += 1) {
      if (attempt > 0 && clock.now() >= deadline) throw unavailable();
      let fd: number | undefined;
      try {
        fd = fs.openSync(path, flags.create, quotaFileMode);
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw unavailable();
      }
      if (fd !== undefined) {
        try {
          // The random ID makes the content of every lock its own, so that
          // unlock can tell it from a later lock on the same inode.
          const bytes = encoder.encode(
            `${JSON.stringify({ pid, host, ts: new Date(clock.now()).toISOString(), id: randomBytes(8).toString('hex') })}\n`,
          );
          writeAll(fd, bytes);
          const stats = fs.fstatSync(fd);
          samePlace(stats, path, checked);
          return { dev: stats.dev, ino: stats.ino, bytes };
        } catch {
          try {
            fs.unlinkSync(path);
          } catch {
            // The lock is left behind and ages out.
          }
          throw unavailable();
        } finally {
          try {
            fs.closeSync(fd);
          } catch {
            // The lock is in place whether or not the descriptor closes.
          }
        }
      }
      // Gone in between: try again at once. Any other failure ends here,
      // so that the loop never spins on a lock it cannot see.
      let held: QuotaFileStats | undefined;
      try {
        held = fs.lstatSync(path);
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw unavailable();
        held = undefined;
      }
      if (held !== undefined && clock.now() - held.mtimeMs > orphanLockMs) {
        const aside = `${path}.${String(pid)}.${randomBytes(8).toString('hex')}.stale`;
        try {
          fs.renameSync(path, aside);
        } catch (error) {
          // Only a lock another process cleared first is no failure.
          if (errorCode(error) !== 'ENOENT') throw unavailable();
          continue;
        }
        try {
          const moved = fs.lstatSync(aside);
          if (
            moved.dev !== held.dev ||
            moved.ino !== held.ino ||
            moved.mtimeMs !== held.mtimeMs
          ) {
            // A link, not a rename: a lock a third process made in the
            // meantime stays, and only this copy goes.
            try {
              fs.linkSync(aside, path);
            } catch (error) {
              if (errorCode(error) !== 'EEXIST') throw unavailable();
            }
          }
          fs.unlinkSync(aside);
        } catch {
          throw unavailable();
        }
        continue;
      }
      if (held !== undefined) await sleep(lockRetryMs);
    }
  };

  // Removes the lock only while it is still this one: the same device and
  // inode, and the same bytes. Linux often gives a new file the inode of
  // one just removed, so a lock another process set after taking this one
  // over can sit on the same inode (ADR 0063). Never throws, so that the
  // result of a count stands.
  const unlock = (
    path: string,
    mine: HeldLock,
    flags: { readonly read: number },
  ): void => {
    let fd: number;
    try {
      fd = fs.openSync(path, flags.read);
    } catch {
      // Gone already, or no longer a file this store may open.
      return;
    }
    let same = false;
    try {
      const stats = fs.fstatSync(fd);
      if (
        stats.isFile() &&
        stats.dev === mine.dev &&
        stats.ino === mine.ino &&
        stats.size === mine.bytes.length
      ) {
        const bytes = readAll(fd, stats.size);
        same = bytes.every((byte, index) => byte === mine.bytes[index]);
      }
    } catch {
      // Not readable as this lock: it stays.
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // The lock was only read.
      }
    }
    if (!same) return;
    try {
      fs.unlinkSync(path);
    } catch {
      // Gone already.
    }
  };

  // Removes the files of the tenant for earlier days, once per day: the
  // file, its lock, a lock moved aside and a temporary file a process left
  // behind. Only names of exactly these forms, and unlink never follows a
  // link.
  const cleanUp = (tenantId: string, day: IsoDate, checked: Identity): void => {
    if (cleaned.get(tenantId) === day) return;
    cleaned.set(tenantId, day);
    let names: string[];
    try {
      sameFolder(checked);
      names = fs.readdirSync(folder);
    } catch {
      return;
    }
    for (const name of names) {
      const temporary = name.startsWith(`.${tenantId}-`);
      if (!temporary && !name.startsWith(`${tenantId}-`)) continue;
      const rest = name.slice(tenantId.length + (temporary ? 2 : 1));
      const earlier = rest.slice(0, 10);
      const suffix = rest.slice(10);
      const leftOver = temporary
        ? temporarySuffix.test(suffix)
        : suffix === '.json' ||
          suffix === '.json.lock' ||
          staleSuffix.test(suffix);
      if (isIsoDate(earlier) && earlier < day && leftOver) {
        try {
          fs.unlinkSync(`${folder}/${name}`);
        } catch {
          // Tried again on the next day.
        }
      }
    }
  };

  const increment = async (
    ctx: TenantContext,
    key: QuotaKey,
    day: IsoDate,
  ): Promise<number> => {
    const { tenantId, actor } = subjectOf(ctx, key, day);
    const flags = flagsOrFail();
    const checked = checkFolder(flags.uid);
    const path = `${folder}/${tenantId}-${day}.json`;
    const mine = await lock(`${path}.lock`, flags, checked);
    try {
      const counts = readCounts(path, tenantId, day, flags, checked);
      const entry =
        counts[actor] ??
        (Object.create(null) as Partial<Record<QuotaKey, number>>);
      const value = (entry[key] ?? 0) + 1;
      if (!Number.isSafeInteger(value)) throw unavailable();
      entry[key] = value;
      counts[actor] = entry;
      if (Object.keys(counts).length > maxQuotaActors) throw unavailable();
      writeCounts(path, tenantId, day, counts, flags, checked);
      return value;
    } finally {
      unlock(`${path}.lock`, mine, flags);
      cleanUp(tenantId, day, checked);
    }
  };

  const read = (
    ctx: TenantContext,
    key: QuotaKey,
    day: IsoDate,
  ): Promise<number> => {
    const { tenantId, actor } = subjectOf(ctx, key, day);
    const flags = flagsOrFail();
    const checked = checkFolder(flags.uid);
    // A rename replaces the file whole, so a read needs no lock.
    const counts = readCounts(
      `${folder}/${tenantId}-${day}.json`,
      tenantId,
      day,
      flags,
      checked,
    );
    return Promise.resolve(counts[actor]?.[key] ?? 0);
  };

  // Every call becomes a promise, also one whose check throws, and the
  // changes of this process run one after the other.
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  };

  return Object.freeze({
    __proto__: null,
    increment: (ctx: TenantContext, key: QuotaKey, day: IsoDate) =>
      serial(() => increment(ctx, key, day)),
    read: (ctx: TenantContext, key: QuotaKey, day: IsoDate) =>
      Promise.resolve().then(() => read(ctx, key, day)),
  });
}
