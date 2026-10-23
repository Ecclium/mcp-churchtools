/**
 * Writes the audit file over stdio (ADR 0028): one file per process and
 * UTC day in the folder `audit` of the folder of state, the folder with
 * 0700, the file with 0600. Every check runs on the open descriptor and is
 * then matched against the path. That keeps links out and makes a swap
 * between check and open unlikely, but without `openat` in Node.js it
 * cannot rule one out (ADR 0028). Nothing here names a path in what it returns,
 * and nothing throws once the file is open.
 *
 * Only the composition root reaches it, through the subpath
 * `./composition` of core. Besides the rule for a line and the timestamp of
 * the logger it loads only `node:fs`, `node:path` and `node:util/types`,
 * which leave fd 2 blocking, so that the first stage of the start can open
 * the file before the startup notices are written (ADR 0054).
 *
 * @packageDocumentation
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeSync,
} from 'node:fs';
import { isProxy } from 'node:util/types';

import type { Clock } from '@ecclium/mcp-churchtools-plugin-api';

import { auditDirName, isNormalizedAbsolutePath } from '../config/state-dir.js';
import {
  isWritableLine,
  type LineWriter,
  toTimestamp,
} from '../logger/index.js';

/**
 * Why the audit file could not be opened, frozen. A code never carries a
 * path or the message of the file system.
 */
export const auditFileCodes = Object.freeze([
  'audit_file_platform',
  'audit_file_folder_unavailable',
  'audit_file_folder_unsafe',
  'audit_file_unavailable',
  'audit_file_unsafe',
] as const);

/** Why the audit file could not be opened. */
export type AuditFileCode = (typeof auditFileCodes)[number];

/** What the writer learns about an open descriptor or a path. */
export interface AuditFileStats {
  isFile(): boolean;
  isDirectory(): boolean;
  readonly uid: number;
  readonly mode: number;
  readonly nlink: number;
  readonly dev: number;
  readonly ino: number;
}

/**
 * The file functions the writer uses. A test passes its own for what it
 * cannot build on disk, such as a full disk or a descriptor below 3.
 */
export interface AuditFileSystem {
  readonly mkdirSync: (path: string, mode: number) => void;
  readonly openSync: (path: string, flags: number, mode?: number) => number;
  readonly fstatSync: (fd: number) => AuditFileStats;
  readonly lstatSync: (path: string) => AuditFileStats;
  readonly writeSync: (
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
  ) => number;
  readonly closeSync: (fd: number) => void;
  /** The ID of the user, or undefined on a platform without one. */
  readonly getuid: () => number | undefined;
  readonly constants: {
    readonly O_RDONLY?: number | undefined;
    readonly O_WRONLY?: number | undefined;
    readonly O_APPEND?: number | undefined;
    readonly O_CREAT?: number | undefined;
    readonly O_EXCL?: number | undefined;
    readonly O_NOFOLLOW?: number | undefined;
    readonly O_NOCTTY?: number | undefined;
    readonly O_DIRECTORY?: number | undefined;
  };
}

/** Options of {@link openAuditFile}. */
export interface AuditFileOptions {
  /** The checked folder of state, an absolute normalised path. */
  readonly stateDir: string;
  /** The time that names the file. */
  readonly clock: Clock;
  /** The ID of the process, part of the name of the file. */
  readonly pid: number;
  /** The file functions, only for tests. */
  readonly fs?: AuditFileSystem;
}

/** Counts of the writer, as a frozen snapshot. */
export interface AuditFileCounts {
  /** Lines written whole. */
  readonly written: number;
  /** Lines lost, in whole or in part. */
  readonly failed: number;
  /** Lines of which a piece was left behind in a file. */
  readonly partial: number;
  /** Lines refused because they were no line of printable ASCII. */
  readonly rejected: number;
  /** New files after the first one. */
  readonly reopened: number;
  /** Whether the writer is closed for good. */
  readonly closed: boolean;
}

/** The open audit file. */
export interface AuditFileWriter extends LineWriter {
  /**
   * Appends the line and a line break to the file. It never throws.
   *
   * @param line - One line of printable ASCII, without a line break.
   * @returns Whether the whole line is in the file.
   */
  write(line: string): boolean;
  /**
   * Tells whether the file can take a line now: open, still linked, and the
   * last line reached it whole. A deleted or lost file gets one try of a
   * new one, within the bound per process. After a failed line only the
   * next line shows whether the file takes lines again. It never throws.
   *
   * @returns Whether the file is ready.
   */
  ready(): boolean;
  /**
   * Closes the file for good. Later lines count as lost and open nothing.
   * It never throws.
   */
  close(): void;
  /**
   * Returns the counts.
   *
   * @returns A frozen snapshot.
   */
  counts(): AuditFileCounts;
}

/** The open writer, or the reason the file could not be opened. */
export type AuditFileResult =
  | { readonly ok: true; readonly writer: AuditFileWriter }
  | { readonly ok: false; readonly code: AuditFileCode };

/** The mode of the folder `audit`. */
export const auditDirMode = 0o700;

/** The mode of an audit file. */
export const auditFileMode = 0o600;

/** Names tried per open before the writer gives up. */
export const maxNameAttempts = 16;

/**
 * System calls per run of bytes at most, as for the stderr writer: for a
 * line, for the repair of a piece, and again in a new file.
 */
export const maxWriteAttempts = 4;

/**
 * New files per process at most, after the first one, for a deleted file
 * or a lost descriptor. A new UTC day is tried once per day and does not
 * count, so that a long run keeps one file per day.
 */
export const maxReopens = 64;

const encoder = new TextEncoder();

// Closes a piece of a line that lost its end. A line break alone could
// turn a piece that lacks only its break into a valid line; with the
// tilde before it, the piece is never valid JSON.
const repair = '~\n';
const repairBytes = encoder.encode(repair);

const nodeFileSystem: AuditFileSystem = Object.freeze({
  mkdirSync: (path: string, mode: number) => {
    // Never recursive: a recursive mkdir succeeds silently when the path
    // is a link to a folder.
    mkdirSync(path, { mode });
  },
  openSync,
  fstatSync,
  lstatSync,
  writeSync,
  closeSync,
  getuid: () => process.getuid?.(),
  constants,
});

const refuse = (code: AuditFileCode): AuditFileResult =>
  Object.freeze({ __proto__: null, ok: false, code });

// The code of a failed system call, read as an own data property, so that
// no getter runs and the message, which holds the path, never leaves.
const errorCode = (error: unknown): unknown => {
  if (typeof error !== 'object' || error === null || isProxy(error)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(error, 'code')?.value;
};

// What a name already in use looks like: EEXIST for a file or a link,
// ELOOP or EMLINK where a system refuses a link under O_NOFOLLOW first.
const nameTaken = (error: unknown): boolean => {
  const code = errorCode(error);
  return code === 'EEXIST' || code === 'ELOOP' || code === 'EMLINK';
};

/** Date and time of the clock in UTC, for the name of a file. */
interface Stamp {
  /** YYYY-MM-DD. */
  readonly date: string;
  /** hhmmss. */
  readonly time: string;
}

const stampOf = (clock: Clock): Stamp | undefined => {
  let now: unknown;
  try {
    now = clock.now();
  } catch {
    return undefined;
  }
  // 2026-10-23T05:52:30.123Z, checked against the pattern of the log.
  const text = toTimestamp(now);
  if (text === undefined) return undefined;
  return {
    date: text.slice(0, 10),
    time: `${text.slice(11, 13)}${text.slice(14, 16)}${text.slice(17, 19)}`,
  };
};

/** An open file and what identifies it. */
interface Opened {
  readonly fd: number;
  readonly date: string;
  readonly dev: number;
  readonly ino: number;
}

interface Flags {
  readonly folder: number;
  readonly file: number;
}

// A folder or a file of the user, without rights for the group or others.
const isPrivate = (stats: AuditFileStats, uid: number): boolean =>
  stats.uid === uid && (stats.mode & 0o077) === 0;

/**
 * Opens the audit file. It creates the folder `audit` with 0700 if it is
 * missing, never recursively, and checks it through a descriptor opened
 * without following a link. The file is opened with O_EXCL and O_NOFOLLOW
 * and the mode 0600, so it is always a new file and never reached through
 * a link; a name in use takes the next number. The open descriptor must be
 * a regular file of the user with one link and no rights for others, the
 * path must still lead to it, and the folder must still be the one
 * checked. A descriptor below 3 is closed and refused, since a line would
 * otherwise go to stdin, stdout or stderr.
 *
 * @param options - Folder of state, clock, ID of the process and, for
 *   tests, the file functions.
 * @returns The writer, or the code of the first check that failed.
 * @throws {TypeError} When the folder is no absolute normalised path, the
 *   clock has no `now` or the ID of the process is no positive integer.
 * @example
 * ```ts
 * const opened = openAuditFile({ stateDir, clock: systemClock, pid: process.pid });
 * if (!opened.ok) report(opened.code);
 * ```
 */
export function openAuditFile(options: AuditFileOptions): AuditFileResult {
  const { stateDir, clock, pid, fs = nodeFileSystem } = options;
  if (
    typeof stateDir !== 'string' ||
    !isNormalizedAbsolutePath(stateDir) ||
    typeof (clock as Partial<Clock> | null)?.now !== 'function' ||
    !Number.isSafeInteger(pid) ||
    pid < 1
  ) {
    throw new TypeError(
      'The audit file needs a folder of state, a clock and a process ID.',
    );
  }
  const {
    O_RDONLY,
    O_WRONLY,
    O_APPEND,
    O_CREAT,
    O_EXCL,
    O_NOFOLLOW,
    O_NOCTTY,
    O_DIRECTORY,
  } = fs.constants;
  const uid = fs.getuid();
  if (
    O_RDONLY === undefined ||
    O_WRONLY === undefined ||
    O_APPEND === undefined ||
    O_CREAT === undefined ||
    O_EXCL === undefined ||
    O_NOFOLLOW === undefined ||
    O_NOCTTY === undefined ||
    O_DIRECTORY === undefined ||
    uid === undefined
  ) {
    return refuse('audit_file_platform');
  }
  const flags: Flags = {
    folder: O_RDONLY | O_DIRECTORY | O_NOFOLLOW,
    file: O_WRONLY | O_APPEND | O_CREAT | O_EXCL | O_NOFOLLOW | O_NOCTTY,
  };
  const folderPath = `${stateDir === '/' ? '' : stateDir}/${auditDirName}`;
  // The number in the name only counts up, so that a name is never tried
  // twice in a process.
  let sequence = 0;

  const openFolder = (): AuditFileStats | AuditFileCode => {
    try {
      fs.mkdirSync(folderPath, auditDirMode);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') return 'audit_file_folder_unavailable';
    }
    let folder: number;
    try {
      folder = fs.openSync(folderPath, flags.folder);
    } catch (error) {
      const code = errorCode(error);
      // A link or a file in place of the folder.
      return code === 'ELOOP' || code === 'ENOTDIR' || code === 'EMLINK'
        ? 'audit_file_folder_unsafe'
        : 'audit_file_folder_unavailable';
    }
    try {
      if (folder < 3) return 'audit_file_folder_unsafe';
      const stats = fs.fstatSync(folder);
      return stats.isDirectory() && isPrivate(stats, uid)
        ? stats
        : 'audit_file_folder_unsafe';
    } catch {
      return 'audit_file_folder_unsafe';
    } finally {
      try {
        fs.closeSync(folder);
      } catch {
        // Only the folder was open, and its check is done.
      }
    }
  };

  const openFile = (
    stamp: Stamp,
    folder: AuditFileStats,
  ): Opened | AuditFileCode => {
    let fd: number | undefined;
    let path = '';
    for (let attempt = 0; attempt < maxNameAttempts; attempt += 1) {
      sequence += 1;
      path = `${folderPath}/audit-${stamp.date}-${stamp.time}-${String(pid)}-${String(sequence)}.jsonl`;
      try {
        fd = fs.openSync(path, flags.file, auditFileMode);
        break;
      } catch (error) {
        if (!nameTaken(error)) return 'audit_file_unavailable';
      }
    }
    if (fd === undefined) return 'audit_file_unavailable';
    let opened: Opened | undefined;
    try {
      const file = fs.fstatSync(fd);
      const atPath = fs.lstatSync(path);
      const folderNow = fs.lstatSync(folderPath);
      if (
        fd >= 3 &&
        file.isFile() &&
        isPrivate(file, uid) &&
        file.nlink === 1 &&
        atPath.dev === file.dev &&
        atPath.ino === file.ino &&
        folderNow.dev === folder.dev &&
        folderNow.ino === folder.ino
      ) {
        opened = { fd, date: stamp.date, dev: file.dev, ino: file.ino };
      }
    } catch {
      opened = undefined;
    }
    if (opened !== undefined) return opened;
    try {
      fs.closeSync(fd);
    } catch {
      // The file is refused whether or not its descriptor closes.
    }
    return 'audit_file_unsafe';
  };

  const stamp = stampOf(clock);
  if (stamp === undefined) return refuse('audit_file_unavailable');
  const folder = openFolder();
  if (typeof folder === 'string') return refuse(folder);
  const opened = openFile(stamp, folder);
  if (typeof opened === 'string') return refuse(opened);

  // Every descriptor the writer keeps is 3 or more: the open refuses any
  // other.
  let fd: number | undefined = opened.fd;
  let date = opened.date;
  let dev = opened.dev;
  let ino = opened.ino;
  let closed = false;
  let opensLeft = maxReopens;
  let written = 0;
  let failed = 0;
  let partial = 0;
  let rejected = 0;
  let reopened = 0;
  // Whether the file ends in a piece of a line without its repair.
  let torn = false;
  // Whether the last line reached the file whole.
  let lastOk = true;
  // The last UTC day a new file was tried for, so that a day that cannot
  // be opened is tried once, not with every line.
  let dayTried: string | undefined;

  const closeQuietly = (target: number): void => {
    try {
      fs.closeSync(target);
    } catch {
      // The descriptor is given up either way.
    }
  };

  // Gives up the file. A descriptor that may now belong to someone else,
  // because fstat failed or names another file, is never closed: closing
  // it would close their file.
  const forget = (own: boolean): void => {
    const current = fd;
    fd = undefined;
    if (!own || current === undefined) return;
    closeOwn(current, torn);
  };

  // Forgets a file that was deleted or is no longer the one opened.
  const verify = (): void => {
    if (fd === undefined) return;
    let stats: AuditFileStats;
    try {
      stats = fs.fstatSync(fd);
    } catch {
      forget(false);
      return;
    }
    if (stats.dev !== dev || stats.ino !== ino) forget(false);
    else if (stats.nlink === 0) forget(true);
  };

  // A new file with every check of the first one. The caller closes a file
  // that is still open.
  const openNext = (stamp: Stamp): boolean => {
    const folder = openFolder();
    if (typeof folder === 'string') return false;
    const next = openFile(stamp, folder);
    if (typeof next === 'string') return false;
    ({ fd, date, dev, ino } = next);
    torn = false;
    lastOk = true;
    reopened += 1;
    return true;
  };

  // A new file for a deleted file or a lost descriptor, within the bound
  // per process.
  const reopen = (stamp: Stamp): boolean => {
    if (opensLeft === 0) return false;
    opensLeft -= 1;
    return openNext(stamp);
  };

  interface Sent {
    readonly sent: number;
    /** The code of the call that stopped the line, if one did. */
    readonly code?: unknown;
  }

  // Bytes sent before the attempts ran out or a call failed. With O_APPEND
  // each call writes at the end, and exactly four arguments keep a
  // position out: one would write over the file instead of after it.
  const send = (target: number, bytes: Uint8Array): Sent => {
    let offset = 0;
    for (
      let attempt = 0;
      attempt < maxWriteAttempts && offset < bytes.length;
      attempt += 1
    ) {
      const rest = bytes.length - offset;
      try {
        const count = fs.writeSync(target, bytes, offset, rest);
        // A count outside its contract counts as no progress.
        if (Number.isInteger(count) && count > 0 && count <= rest) {
          offset += count;
        }
      } catch (error) {
        return { sent: offset, code: errorCode(error) };
      }
    }
    return { sent: offset };
  };

  // One try of the line in the open file. Returns the code that stopped
  // it, or true when the whole line is in the file.
  const attempt = (target: number, line: string): true | Sent => {
    const prefix = torn ? repair : '';
    const bytes = encoder.encode(`${prefix}${line}\n`);
    const result = send(target, bytes);
    if (result.sent === bytes.length) {
      torn = false;
      return true;
    }
    if (result.sent > prefix.length) {
      // A piece of the line is in the file: close it at once.
      partial += 1;
      torn = send(target, repairBytes).sent !== repairBytes.length;
    } else if (result.sent === prefix.length) {
      // At most the repair went out, nothing of the line itself.
      torn = false;
    }
    return result;
  };

  // Closes an own file. A piece at its end gets its repair first: without
  // a later line, a piece that lacks only its line break would otherwise
  // stay a valid line at the end of the file.
  const closeOwn = (target: number, withPiece: boolean): void => {
    if (withPiece) send(target, repairBytes);
    closeQuietly(target);
  };

  const lose = (): false => {
    failed += 1;
    lastOk = false;
    return false;
  };

  const write = (line: string): boolean => {
    if (!isWritableLine(line)) {
      rejected += 1;
      return false;
    }
    if (closed) return lose();
    // At most one new file per line.
    let tried = false;
    const stamp = stampOf(clock);
    const tryReopen = (): boolean => {
      if (tried || stamp === undefined) return false;
      tried = true;
      return reopen(stamp);
    };
    // First, so that only the own file is closed below: verify forgets a
    // descriptor that is no longer the file opened.
    verify();
    // A new UTC day starts a new file, never an earlier day, and is tried
    // once per day. If the new file cannot be opened, the line goes into
    // the old one.
    if (
      fd !== undefined &&
      stamp !== undefined &&
      stamp.date > date &&
      stamp.date !== dayTried
    ) {
      dayTried = stamp.date;
      tried = true;
      const old = fd;
      const oldTorn = torn;
      if (openNext(stamp)) closeOwn(old, oldTorn);
    }
    if (fd === undefined) tryReopen();
    const target = fd;
    if (target === undefined) return lose();
    let result = attempt(target, line);
    if (
      result !== true &&
      (result.code === 'EBADF' ||
        result.code === 'ESTALE' ||
        result.code === 'EFBIG')
    ) {
      // The file is gone or full for good. A piece stays at its end, and
      // the line goes into a new file. After EBADF the descriptor may
      // already belong to someone else.
      forget(result.code !== 'EBADF');
      tryReopen();
      const next = fd;
      if (next !== undefined) result = attempt(next, line);
    }
    if (result !== true) return lose();
    // A file deleted while the line was written lost the line with it.
    verify();
    if (fd === undefined) return lose();
    written += 1;
    lastOk = true;
    return true;
  };

  const ready = (): boolean => {
    if (closed) return false;
    verify();
    if (fd !== undefined) return lastOk;
    const stamp = stampOf(clock);
    return stamp !== undefined && reopen(stamp);
  };

  const close = (): void => {
    closed = true;
    // A descriptor that is no longer the file opened is never closed.
    verify();
    forget(true);
  };

  const counts = (): AuditFileCounts =>
    Object.freeze({ written, failed, partial, rejected, reopened, closed });

  return Object.freeze({
    __proto__: null,
    ok: true,
    writer: Object.freeze({ write, ready, close, counts }),
  });
}
