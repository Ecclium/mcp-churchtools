/**
 * Writes the audit file over stdio (ADR 0028): one file per process and
 * UTC day in the folder `audit` of the folder of state, the folder with
 * 0700, the file with 0600. Every check runs on the open descriptor and is
 * then matched against the path. That keeps links out and makes a swap
 * between check and open unlikely, but without `openat` in Node.js it
 * cannot rule one out (ADR 0028). Nothing here names a path in what it returns,
 * and nothing throws once the file is open.
 *
 * Each whole line of a file carries `seq` and `prevHash`, the chain of that
 * file, which only this writer fills: the SHA-256 of the line before, as it
 * stands in the file, or of the name of the file for the first line. The
 * writer never parses a line; it puts the two fields before the last brace
 * of the object it is given (ADR 0028).
 *
 * The writer also deletes: its own file, when it gives the file up without
 * a line, and at the start and on each new UTC day the files of the folder
 * `audit` past their retention and the empty ones of earlier days. Only
 * names of exactly its own form count, never a link (ADR 0028).
 *
 * Only the composition root reaches it, through the subpath
 * `./composition` of core. Besides the rule for a line and the timestamp of
 * the logger it loads only `node:crypto`, `node:fs`, `node:path` and
 * `node:util/types`, which leave fd 2 blocking, so that the first stage of
 * the start can open the file before the startup notices are written
 * (ADR 0054).
 *
 * @packageDocumentation
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { isProxy } from 'node:util/types';

import type { Clock } from '@ecclium/mcp-churchtools-plugin-api';

import { auditDirName, isNormalizedAbsolutePath } from '../config/state-dir.js';
import {
  isWritableLine,
  type LineWriter,
  maxLineLength,
  toTimestamp,
} from '../logger/index.js';
import { dayOfAuditFile, dayOfTime, isPastRetention } from './retention.js';

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
  /** The size in bytes. */
  readonly size: number;
  /** The time of the last change, in milliseconds since the epoch. */
  readonly mtimeMs: number;
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
  /** Flushes a file to the disk. */
  readonly fsyncSync: (fd: number) => void;
  /** The names in a folder. */
  readonly readdirSync: (path: string) => string[];
  /** Removes a name; never follows a link. */
  readonly unlinkSync: (path: string) => void;
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
  /**
   * How many months the files stay before the writer deletes them, a whole
   * number from 1 to 120 (ADR 0028).
   */
  readonly retentionMonths: number;
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

/**
 * The head of the chain of a file the writer gave up, for the anchor on
 * the log (ADR 0028).
 */
export interface AuditChainAnchor {
  /** The name of the file, without the folder. */
  readonly file: string;
  /** The seq of its last whole line. */
  readonly seq: number;
  /** The SHA-256 of its last whole line, in hex. */
  readonly hash: string;
}

/**
 * What the writer reports for the log. The first stage of the start opens
 * the file before there is a logger, so the second stage attaches it.
 */
export interface AuditFileListener {
  /**
   * Gets the anchor of each file the writer gives up that has a whole
   * line: when it closes, on a new UTC day and before a new file for a
   * lost one. A file without a line has no anchor.
   */
  readonly anchor: (anchor: AuditChainAnchor) => void;
  /**
   * Gets the counts of each sweep of the folder `audit`, at the start and
   * on each new UTC day.
   */
  readonly swept: (sweep: AuditSweep) => void;
}

/** What one sweep of the folder `audit` did, without a name or a path. */
export interface AuditSweep {
  /** Files it deleted. */
  readonly deleted: number;
  /**
   * Files past their retention, or empty ones of an earlier day, that it
   * left: a link, a folder, a file of another owner, with rights for
   * others or more than one link, or one whose deletion failed.
   */
  readonly kept: number;
  /**
   * Whether it saw the whole folder: false when the folder could not be
   * read or was no longer the one opened.
   */
  readonly complete: boolean;
}

/** The open audit file. */
export interface AuditFileWriter extends LineWriter {
  /**
   * Appends the line with the next link of the chain of the file and a
   * line break. It never throws.
   *
   * @param line - One JSON object on one line of printable ASCII, without
   *   `seq` and `prevHash` and at most {@link maxAuditLineLength}
   *   characters long.
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
   * Attaches the listener for the log, once. What the writer reports
   * before goes nowhere. It never throws, and a listener that throws
   * changes nothing.
   *
   * @param listener - Gets the anchors and the sweeps.
   * @returns Whether it was attached: false for a second listener or one
   *   without both functions.
   */
  attach(listener: AuditFileListener): boolean;
  /**
   * Deletes the files of the folder `audit` past their retention and the
   * empty files of earlier days, as at the start. It never throws.
   */
  sweep(): void;
  /**
   * Starts the file of a new UTC day when the clock shows one, also
   * without a line, for a timer in a long run. It never throws.
   */
  tick(): void;
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

// The longest link of the chain: the largest safe integer as seq and a
// SHA-256 in hex.
const longestLink = `,"seq":${String(Number.MAX_SAFE_INTEGER)},"prevHash":"${'0'.repeat(64)}"`;

/**
 * The longest line the writer takes, so that the line with its link of the
 * chain still fits the rule for a line of the logger.
 */
export const maxAuditLineLength = maxLineLength - longestLink.length;

const encoder = new TextEncoder();

// The SHA-256 of a text of printable ASCII, whose characters are its bytes.
const sha256 = (text: string): string =>
  createHash('sha256').update(encoder.encode(text)).digest('hex');

// A line the chain can go into: one object on one line, not empty, so that
// the link before its last brace leaves valid JSON. The writer checks the
// shape only and never parses the line.
const isChainable = (line: unknown): line is string =>
  isWritableLine(line) &&
  line.length <= maxAuditLineLength &&
  line.startsWith('{') &&
  line.endsWith('}') &&
  line.charAt(line.length - 2) !== '{';

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
  fsyncSync,
  readdirSync: (path: string) => readdirSync(path),
  unlinkSync,
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
  /** The name of the file, without the folder. */
  readonly name: string;
  readonly dev: number;
  readonly ino: number;
}

/** The open file of the writer with the head of its chain. */
interface Current extends Opened {
  /** The seq of the last whole line, 0 before the first one. */
  seq: number;
  /**
   * The SHA-256 of the last whole line, or of the name of the file before
   * the first one.
   */
  hash: string;
  /** Whether the file ends in a piece of a line without its repair. */
  torn: boolean;
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
  const {
    stateDir,
    clock,
    pid,
    retentionMonths,
    fs = nodeFileSystem,
  } = options;
  if (
    typeof stateDir !== 'string' ||
    !isNormalizedAbsolutePath(stateDir) ||
    typeof (clock as Partial<Clock> | null)?.now !== 'function' ||
    !Number.isSafeInteger(pid) ||
    pid < 1 ||
    !Number.isInteger(retentionMonths) ||
    retentionMonths < 1 ||
    retentionMonths > 120
  ) {
    throw new TypeError(
      'The audit file needs a folder of state, a clock, a process ID and a retention.',
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
    let name = '';
    let path = '';
    for (let attempt = 0; attempt < maxNameAttempts; attempt += 1) {
      sequence += 1;
      name = `audit-${stamp.date}-${stamp.time}-${String(pid)}-${String(sequence)}.jsonl`;
      path = `${folderPath}/${name}`;
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
        opened = { fd, date: stamp.date, name, dev: file.dev, ino: file.ino };
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
  const begin = (next: Opened): Current => ({
    ...next,
    seq: 0,
    hash: sha256(next.name),
    torn: false,
  });
  let file: Current | undefined = begin(opened);
  // The day of the last file opened, also after that file is given up.
  let date = opened.date;
  // The folder audit as last checked, which a sweep must still find.
  let folderOf = { dev: folder.dev, ino: folder.ino };
  let closed = false;
  let opensLeft = maxReopens;
  let written = 0;
  let failed = 0;
  let partial = 0;
  let rejected = 0;
  let reopened = 0;
  // Whether the last line reached the file whole.
  let lastOk = true;
  // The functions of the listener, read once as own data properties.
  let onAnchor: ((anchor: AuditChainAnchor) => void) | undefined;
  let onSwept: ((sweep: AuditSweep) => void) | undefined;
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

  // The anchor of a file with a whole line, for the log. A listener that
  // throws changes nothing here.
  const anchor = (old: Current): void => {
    if (old.seq === 0) return;
    try {
      onAnchor?.(
        Object.freeze({ file: old.name, seq: old.seq, hash: old.hash }),
      );
    } catch {
      // The anchor is lost; the file and its chain stay as they are.
    }
  };

  // Removes an own file without a byte once it is closed, if its name
  // still leads to it. Whatever fails, the file stays for the sweep of a
  // later day.
  const removeEmpty = (old: Current): void => {
    const path = `${folderPath}/${old.name}`;
    try {
      const atPath = fs.lstatSync(path);
      if (
        atPath.isFile() &&
        atPath.size === 0 &&
        atPath.dev === old.dev &&
        atPath.ino === old.ino
      ) {
        fs.unlinkSync(path);
      }
    } catch {
      // Gone already, or left for the sweep.
    }
  };

  // Gives up a file and reports its anchor. A descriptor that may now
  // belong to someone else, because fstat failed or names another file,
  // is never closed, flushed or removed: that would act on their file. An
  // own file with a piece at its end gets its repair first: without a
  // later line, a piece that lacks only its line break would otherwise
  // stay a valid line at the end of the file. Then it goes to the disk, at
  // the anchor and not with each line: under macOS, where Node.js flushes
  // with F_FULLFSYNC, that cost about 3 ms per line, and the rule of
  // ADR 0028 allows it per line only below 1 ms. A failed flush changes
  // nothing. A file without a byte goes instead: every start opens a file,
  // also when no tool runs (ADR 0028).
  const retire = (old: Current, own: boolean): void => {
    if (own) {
      if (old.torn) send(old.fd, repairBytes);
      let empty: boolean;
      try {
        empty = fs.fstatSync(old.fd).size === 0;
      } catch {
        empty = false;
      }
      if (!empty) {
        try {
          fs.fsyncSync(old.fd);
        } catch {
          // The lines stay written; only a crash of the system could lose
          // them.
        }
      }
      closeQuietly(old.fd);
      if (empty) removeEmpty(old);
    }
    anchor(old);
  };

  // Gives up the open file.
  const drop = (own: boolean): void => {
    const old = file;
    file = undefined;
    if (old !== undefined) retire(old, own);
  };

  // Gives up a file that was deleted or is no longer the one opened.
  const verify = (): void => {
    if (file === undefined) return;
    let stats: AuditFileStats;
    try {
      stats = fs.fstatSync(file.fd);
    } catch {
      drop(false);
      return;
    }
    if (stats.dev !== file.dev || stats.ino !== file.ino) drop(false);
    else if (stats.nlink === 0) drop(true);
  };

  // A new file with every check of the first one, and a new chain. The
  // caller gives up a file that is still open.
  const openNext = (stamp: Stamp): boolean => {
    const folder = openFolder();
    if (typeof folder === 'string') return false;
    folderOf = { dev: folder.dev, ino: folder.ino };
    const next = openFile(stamp, folder);
    if (typeof next === 'string') return false;
    file = begin(next);
    date = next.date;
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

  // The folder audit is still the one last checked, and no link.
  const sameFolder = (): boolean => {
    try {
      const now = fs.lstatSync(folderPath);
      return (
        now.isDirectory() &&
        now.dev === folderOf.dev &&
        now.ino === folderOf.ino
      );
    } catch {
      return false;
    }
  };

  // Deletes the files past their retention and the empty files of earlier
  // days in the folder audit, as the start and each new UTC day ask
  // (ADR 0028). Only names of exactly the form of this writer count, with
  // a day before today: a file of today or of a day still to come never
  // goes. A file past its retention goes only when its last change is as
  // old, so that every line stays the whole retention, also in a file
  // written on after a failed change of day. An empty file goes once its
  // day and its last change lie before today: the empty files of today
  // mostly belong to running processes. Each one must be a regular file of
  // the user without rights for others and with one link, as at the open,
  // never the own file, and the folder must still be the one opened before
  // it is read and before each file goes. unlink never follows a link.
  const sweep = (): void => {
    if (closed) return;
    const today = stampOf(clock)?.date;
    let deleted = 0;
    let kept = 0;
    let complete = today !== undefined && sameFolder();
    let names: readonly string[] = [];
    if (complete) {
      try {
        names = fs.readdirSync(folderPath);
      } catch {
        complete = false;
      }
    }
    for (const name of names) {
      const day = dayOfAuditFile(name);
      if (today === undefined || day === undefined || day >= today) continue;
      const path = `${folderPath}/${name}`;
      let stats: AuditFileStats;
      try {
        stats = fs.lstatSync(path);
      } catch (error) {
        // Gone already counts as deleted, by whoever it was.
        if (errorCode(error) !== 'ENOENT') kept += 1;
        continue;
      }
      if (
        name === file?.name ||
        (stats.dev === file?.dev && stats.ino === file.ino)
      ) {
        continue;
      }
      const changed = dayOfTime(stats.mtimeMs);
      if (changed === undefined) continue;
      const due =
        (isPastRetention(day, retentionMonths, today) &&
          isPastRetention(changed, retentionMonths, today)) ||
        (stats.isFile() && stats.size === 0 && changed < today);
      if (!due) continue;
      if (!stats.isFile() || !isPrivate(stats, uid) || stats.nlink !== 1) {
        kept += 1;
        continue;
      }
      if (!sameFolder()) {
        complete = false;
        break;
      }
      try {
        fs.unlinkSync(path);
        deleted += 1;
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') kept += 1;
      }
    }
    try {
      onSwept?.(Object.freeze({ deleted, kept, complete }));
    } catch {
      // The counts are lost; the files are gone or stay either way.
    }
  };

  // Starts the file of a new UTC day, never of an earlier one, and tries
  // each day once. The old file goes with its anchor, and the sweep runs.
  // Without an open file the day counts only while the bound for lost
  // files is not used up: a file another process removed, such as an
  // empty one of an earlier day, is then replaced as a change of day and
  // not as a lost file (ADR 0028). Returns whether it tried.
  const turnDay = (stamp: Stamp | undefined): boolean => {
    if (stamp === undefined || stamp.date <= date || stamp.date === dayTried) {
      return false;
    }
    if (file === undefined && opensLeft === 0) return false;
    dayTried = stamp.date;
    const old = file;
    if (openNext(stamp) && old !== undefined) retire(old, true);
    sweep();
    return true;
  };

  // One try of the line in the given file, with the next link of its
  // chain. Returns the code that stopped it, or true when the whole line
  // is in the file. Only a whole line moves the head of the chain: a piece
  // and its repair are no part of it.
  const attempt = (target: Current, line: string): true | Sent => {
    const seq = target.seq + 1;
    const chained = `${line.slice(0, -1)},"seq":${String(seq)},"prevHash":"${target.hash}"}`;
    const prefix = target.torn ? repair : '';
    const bytes = encoder.encode(`${prefix}${chained}\n`);
    const result = send(target.fd, bytes);
    if (result.sent === bytes.length) {
      target.torn = false;
      target.seq = seq;
      target.hash = sha256(chained);
      return true;
    }
    if (result.sent > prefix.length) {
      // A piece of the line is in the file: close it at once.
      partial += 1;
      target.torn = send(target.fd, repairBytes).sent !== repairBytes.length;
    } else if (result.sent === prefix.length) {
      // At most the repair went out, nothing of the line itself.
      target.torn = false;
    }
    return result;
  };

  const lose = (): false => {
    failed += 1;
    lastOk = false;
    return false;
  };

  const write = (line: string): boolean => {
    if (!isChainable(line)) {
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
    // First, so that only the own file is given up below: verify gives up
    // a descriptor that is no longer the file opened.
    verify();
    // A new UTC day starts a new file. If it cannot be opened, the line
    // goes into the old one.
    if (turnDay(stamp)) tried = true;
    if (file === undefined) tryReopen();
    const target = file;
    if (target === undefined) return lose();
    let result = attempt(target, line);
    if (
      result !== true &&
      (result.code === 'EBADF' ||
        result.code === 'ESTALE' ||
        result.code === 'EFBIG')
    ) {
      // The file is gone or full for good. A piece stays at its end, and
      // the line goes into a new file with a new chain. After EBADF the
      // descriptor may already belong to someone else.
      drop(result.code !== 'EBADF');
      tryReopen();
      const next = file;
      if (next !== undefined) result = attempt(next, line);
    }
    if (result !== true) return lose();
    // A file deleted while the line was written lost the line with it.
    verify();
    if (file === undefined) return lose();
    written += 1;
    lastOk = true;
    return true;
  };

  // The gate asks before the line is written, so a new day and a deleted
  // file are handled here as in write, with at most one new file.
  const ready = (): boolean => {
    if (closed) return false;
    const stamp = stampOf(clock);
    verify();
    const tried = turnDay(stamp);
    if (file !== undefined) return lastOk;
    return !tried && stamp !== undefined && reopen(stamp);
  };

  const tick = (): void => {
    if (closed) return;
    verify();
    turnDay(stampOf(clock));
  };

  const close = (): void => {
    closed = true;
    // A descriptor that is no longer the file opened is never closed.
    verify();
    drop(true);
  };

  const attach = (given: AuditFileListener): boolean => {
    if (
      onAnchor !== undefined ||
      typeof given !== 'object' ||
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a caller without types
      given === null ||
      isProxy(given)
    ) {
      return false;
    }
    const anchorOf: unknown = Object.getOwnPropertyDescriptor(
      given,
      'anchor',
    )?.value;
    const sweptOf: unknown = Object.getOwnPropertyDescriptor(
      given,
      'swept',
    )?.value;
    if (typeof anchorOf !== 'function' || typeof sweptOf !== 'function') {
      return false;
    }
    onAnchor = anchorOf as (anchor: AuditChainAnchor) => void;
    onSwept = sweptOf as (sweep: AuditSweep) => void;
    return true;
  };

  const counts = (): AuditFileCounts =>
    Object.freeze({ written, failed, partial, rejected, reopened, closed });

  return Object.freeze({
    __proto__: null,
    ok: true,
    writer: Object.freeze({
      write,
      ready,
      close,
      attach,
      sweep,
      tick,
      counts,
    }),
  });
}
