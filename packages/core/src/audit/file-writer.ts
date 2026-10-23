/**
 * Opens the audit file over stdio (ADR 0028): one file per process and UTC
 * day in the folder `audit` of the folder of state, the folder with 0700,
 * the file with 0600. Every check runs on the open descriptor and is then
 * matched against the path, so neither a link nor a file swapped in
 * between gets past them. Nothing here names a path in what it returns.
 *
 * Only the composition root reaches it, through the subpath
 * `./composition` of core. Its runtime imports are built-in modules and the
 * pattern of a timestamp, so that the first stage of the start can load it
 * while fd 2 still blocks.
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
import { toTimestamp } from '../logger/index.js';

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
  /** Whether the writer is closed for good. */
  readonly closed: boolean;
}

/** The open audit file. */
export interface AuditFileWriter {
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

/** Names tried per open before the writer gives up, 1 to 16. */
export const maxNameAttempts = 16;

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
  let closed = false;

  const close = (): void => {
    closed = true;
    const current = fd;
    fd = undefined;
    if (current === undefined) return;
    try {
      fs.closeSync(current);
    } catch {
      // Closed for good either way.
    }
  };

  const counts = (): AuditFileCounts => Object.freeze({ closed });

  return Object.freeze({
    __proto__: null,
    ok: true,
    writer: Object.freeze({ close, counts }),
  });
}
