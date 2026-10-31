/**
 * Reads the audit files of the folder of state for `ecclium audit verify`
 * and `ecclium audit show` (ADR 0028). It only reads: it creates, changes
 * and deletes nothing. It opens the folder `audit` and each file without
 * following a link and checks them on the open descriptor as the writer
 * does, a folder or a regular file of the user without rights for others,
 * a file with one link and the same inode as at its path. Only names of
 * exactly the form of the writer count, other entries only as a number.
 *
 * A file is read in pieces of a fixed size and split at the byte of a line
 * break alone. Each line keeps the SHA-256 of its exact bytes, so that a
 * carriage return, a byte order mark or a byte outside ASCII breaks the
 * chain instead of being normalised away. What stands after the last line
 * break is no line: the file of a running server is read as far as it is
 * written. Nothing here names a path in what it returns.
 *
 * @packageDocumentation
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from 'node:fs';
import { isProxy } from 'node:util/types';

import { auditDirName, isNormalizedAbsolutePath } from '../config/state-dir.js';
import { maxLineLength } from '../logger/index.js';
import { dayOfAuditFile } from './retention.js';

/** What the reader learns about an open descriptor or a path. */
export interface AuditReadStats {
  isFile(): boolean;
  isDirectory(): boolean;
  readonly uid: number;
  readonly mode: number;
  readonly nlink: number;
  readonly dev: number;
  readonly ino: number;
}

/**
 * The file functions the reader uses. A test passes its own for what it
 * cannot build on disk, such as a file of another owner or a failed read.
 */
export interface AuditReadFileSystem {
  readonly openSync: (path: string, flags: number) => number;
  readonly fstatSync: (fd: number) => AuditReadStats;
  readonly lstatSync: (path: string) => AuditReadStats;
  readonly readSync: (
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: null,
  ) => number;
  readonly closeSync: (fd: number) => void;
  /** The names in a folder. */
  readonly readdirSync: (path: string) => string[];
  /** The ID of the user, or undefined on a platform without one. */
  readonly getuid: () => number | undefined;
  readonly constants: {
    readonly O_RDONLY?: number | undefined;
    readonly O_NOFOLLOW?: number | undefined;
    readonly O_NOCTTY?: number | undefined;
    readonly O_DIRECTORY?: number | undefined;
    readonly O_NONBLOCK?: number | undefined;
  };
}

/**
 * Why the folder `audit` cannot be read, frozen. A code never carries a
 * path or the message of the file system.
 */
export const auditFolderCodes = Object.freeze([
  'audit_read_platform',
  'audit_folder_missing',
  'audit_folder_unsafe',
  'audit_folder_unavailable',
] as const);

/** Why the folder `audit` cannot be read. */
export type AuditFolderCode = (typeof auditFolderCodes)[number];

/** One line of a file that ended with a line break, without it. */
export interface AuditLine {
  /** The number of the line in the file, from 1, counting every break. */
  readonly number: number;
  /** The SHA-256 of the bytes of the line, in lower-case hex. */
  readonly hash: string;
  /**
   * The text of the line when it is at most `maxLineLength` bytes of
   * printable ASCII, otherwise undefined.
   */
  readonly text: string | undefined;
  /** Whether the line is longer than `maxLineLength` bytes. */
  readonly tooLong: boolean;
  /**
   * Whether the line ends with `~`: the piece of a line the file did not
   * take whole, which is no part of the chain (ADR 0028).
   */
  readonly piece: boolean;
}

/**
 * How the reading of one file ended: `read` whole, `gone` when it
 * vanished before it was opened, `unsafe` when it failed a check, `moved`
 * when the folder `audit` is no longer the one opened, and `unreadable`
 * when opening or reading failed otherwise.
 */
export type AuditFileRead = 'read' | 'gone' | 'unsafe' | 'moved' | 'unreadable';

/** The folder `audit`, opened and listed. */
export interface AuditFolder {
  /** The names of the audit files, sorted, without a path. */
  readonly names: readonly string[];
  /** How many other entries the folder holds. */
  readonly others: number;
  /**
   * Reads one file of {@link names} line by line. For any other name it
   * reads nothing and gives `gone`. It never throws: a callback that
   * throws ends the reading as `unreadable`.
   *
   * @param name - One of the names.
   * @param onLine - Gets each line that ended with a line break, in order.
   * @returns How the reading ended.
   */
  read(name: string, onLine: (line: AuditLine) => void): AuditFileRead;
}

/** The opened folder, or the reason it could not be opened. */
export type AuditFolderResult =
  | { readonly ok: true; readonly folder: AuditFolder }
  | { readonly ok: false; readonly code: AuditFolderCode };

/** Options of {@link openAuditFolder}. */
export interface AuditFolderOptions {
  /** The checked folder of state, an absolute normalised path. */
  readonly stateDir: string;
  /** The file functions, only for tests. */
  readonly fs?: AuditReadFileSystem;
}

/** The bytes the reader asks for in one call. */
export const readChunkSize = 65_536;

const nodeFileSystem: AuditReadFileSystem = Object.freeze({
  openSync: (path: string, flags: number) => openSync(path, flags),
  fstatSync,
  lstatSync,
  readSync,
  closeSync,
  readdirSync: (path: string) => readdirSync(path),
  getuid: () => process.getuid?.(),
  constants,
});

const lineBreak = 0x0a;
const tilde = 0x7e;

const refuse = (code: AuditFolderCode): AuditFolderResult =>
  Object.freeze({ __proto__: null, ok: false, code });

// The code of a failed system call, read as an own data property, so that
// no getter runs and the message, which holds the path, never leaves.
const errorCode = (error: unknown): unknown => {
  if (typeof error !== 'object' || error === null || isProxy(error)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(error, 'code')?.value;
};

// A folder or a file of the user, without rights for the group or others.
const isPrivate = (stats: AuditReadStats, uid: number): boolean =>
  stats.uid === uid && (stats.mode & 0o077) === 0;

const decoder = new TextDecoder();

/**
 * Opens the folder `audit` of a checked folder of state for reading. It
 * opens the folder without following a link, checks it on the descriptor,
 * reads its names and checks that the path still leads to the same
 * folder. It creates nothing: a missing folder is `audit_folder_missing`.
 *
 * @param options - Folder of state and, for tests, the file functions.
 * @returns The folder, or the code of the first check that failed.
 * @throws {TypeError} When the folder of state is no absolute normalised
 *   path.
 * @example
 * ```ts
 * const opened = openAuditFolder({ stateDir });
 * if (opened.ok) for (const name of opened.folder.names) opened.folder.read(name, onLine);
 * ```
 */
export function openAuditFolder(
  options: AuditFolderOptions,
): AuditFolderResult {
  const { stateDir, fs = nodeFileSystem } = options;
  if (typeof stateDir !== 'string' || !isNormalizedAbsolutePath(stateDir)) {
    throw new TypeError('The audit files need a folder of state.');
  }
  const { O_RDONLY, O_NOFOLLOW, O_NOCTTY, O_DIRECTORY, O_NONBLOCK } =
    fs.constants;
  const uid = fs.getuid();
  if (
    O_RDONLY === undefined ||
    O_NOFOLLOW === undefined ||
    O_NOCTTY === undefined ||
    O_DIRECTORY === undefined ||
    O_NONBLOCK === undefined ||
    uid === undefined
  ) {
    return refuse('audit_read_platform');
  }
  const folderPath = `${stateDir === '/' ? '' : stateDir}/${auditDirName}`;
  // O_NONBLOCK: a FIFO put in place of a file between lstat and open must
  // not stop the reader; the check on the descriptor then refuses it.
  const fileFlags = O_RDONLY | O_NOFOLLOW | O_NOCTTY | O_NONBLOCK;

  let folderFd: number;
  try {
    folderFd = fs.openSync(folderPath, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') return refuse('audit_folder_missing');
    // A link or a file in place of the folder.
    return refuse(
      code === 'ELOOP' || code === 'ENOTDIR' || code === 'EMLINK'
        ? 'audit_folder_unsafe'
        : 'audit_folder_unavailable',
    );
  }
  let folder: AuditReadStats;
  let entries: string[];
  try {
    folder = fs.fstatSync(folderFd);
    if (!folder.isDirectory() || !isPrivate(folder, uid)) {
      return refuse('audit_folder_unsafe');
    }
    entries = fs.readdirSync(folderPath);
  } catch {
    return refuse('audit_folder_unavailable');
  } finally {
    try {
      fs.closeSync(folderFd);
    } catch {
      // Only the folder was open, and its check is done.
    }
  }
  const { dev, ino } = folder;

  // The folder audit is still the one opened, and no link.
  const sameFolder = (): boolean => {
    try {
      const now = fs.lstatSync(folderPath);
      return now.isDirectory() && now.dev === dev && now.ino === ino;
    } catch {
      return false;
    }
  };
  if (!sameFolder()) return refuse('audit_folder_unsafe');

  const names = Object.freeze(
    entries.filter((name) => dayOfAuditFile(name) !== undefined).sort(),
  );
  const known = new Set(names);

  const readLines = (
    fd: number,
    onLine: (line: AuditLine) => void,
  ): boolean => {
    const buffer = new Uint8Array(readChunkSize);
    // The first bytes of the current line, enough for its text.
    const head = new Uint8Array(maxLineLength);
    let hash = createHash('sha256');
    let length = 0;
    let ascii = true;
    let last = -1;
    let number = 0;
    for (;;) {
      let count: number;
      try {
        count = fs.readSync(fd, buffer, 0, buffer.length, null);
      } catch {
        return false;
      }
      if (!Number.isInteger(count) || count < 0 || count > buffer.length) {
        return false;
      }
      if (count === 0) return true;
      let start = 0;
      for (let index = 0; index < count; index += 1) {
        const byte = buffer[index] as number;
        if (byte !== lineBreak) {
          if (byte < 0x20 || byte > tilde) ascii = false;
          if (length < head.length) head[length] = byte;
          length += 1;
          last = byte;
          continue;
        }
        hash.update(buffer.subarray(start, index));
        number += 1;
        const tooLong = length > maxLineLength;
        onLine(
          Object.freeze({
            number,
            hash: hash.digest('hex'),
            text:
              ascii && !tooLong
                ? decoder.decode(head.subarray(0, length))
                : undefined,
            tooLong,
            piece: last === tilde,
          }),
        );
        hash = createHash('sha256');
        length = 0;
        ascii = true;
        last = -1;
        start = index + 1;
      }
      hash.update(buffer.subarray(start, count));
    }
  };

  const read = (
    name: string,
    onLine: (line: AuditLine) => void,
  ): AuditFileRead => {
    if (!known.has(name)) return 'gone';
    if (!sameFolder()) return 'moved';
    const path = `${folderPath}/${name}`;
    let atPath: AuditReadStats;
    try {
      atPath = fs.lstatSync(path);
    } catch (error) {
      return errorCode(error) === 'ENOENT' ? 'gone' : 'unreadable';
    }
    if (!atPath.isFile()) return 'unsafe';
    let fd: number;
    try {
      fd = fs.openSync(path, fileFlags);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT') return 'gone';
      return code === 'ELOOP' || code === 'EMLINK' ? 'unsafe' : 'unreadable';
    }
    try {
      const stats = fs.fstatSync(fd);
      if (
        !stats.isFile() ||
        !isPrivate(stats, uid) ||
        stats.nlink !== 1 ||
        stats.dev !== atPath.dev ||
        stats.ino !== atPath.ino
      ) {
        return 'unsafe';
      }
      return readLines(fd, onLine) ? 'read' : 'unreadable';
    } catch {
      return 'unreadable';
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // The file was only read.
      }
    }
  };

  return Object.freeze({
    __proto__: null,
    ok: true,
    folder: Object.freeze({
      names,
      others: entries.length - names.length,
      read,
    }),
  });
}
