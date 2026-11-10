/**
 * Private files of the server outside the audit (ADR 0031): the day keys
 * in the folder of keys and the snapshots in the folder of state, and the
 * drafts and notices of the runner (ADR 0033). Where it stands in the way
 * of a write: below the stores and the runner that keep such files, never
 * reached by a tool.
 *
 * Most files here are written once and never changed. Such a file is
 * written whole under a temporary name of its own, flushed with `fsync`
 * and only then given its name with `link`, which fails when the name is
 * taken. A reader therefore never sees half a file, and two processes that
 * race for the same name end with one file, the first: the second learns
 * that it exists and reads it. A lock file is not needed for that, because
 * no such file is ever written twice. After the link the folder is flushed
 * as well, since the `fsync` of a file keeps its bytes but not its name.
 *
 * Two kinds of file change. A draft, which a second run of the same period
 * replaces (ADR 0033), is written the same way and then given its name with
 * `rename`, which puts it in the place of a file of that name whole: a
 * reader sees the old file or the new one, never a mix. A file of notices
 * grows by one line at a time at its end and is never written over; it
 * lies where the operator chose, so only the file itself is checked.
 *
 * Folders are made with 0700, never recursively, files with 0600. Every
 * open follows no link and is checked on its descriptor: a regular file or
 * folder of the user without rights for others. A file is destroyed by
 * writing zeros over it, flushing that and removing its name, so that a
 * second name of the same file, such as the temporary one of a writer that
 * stopped halfway, keeps nothing either.
 *
 * Nothing here names a path or a message of the system in what it throws.
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
  rmdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { isProxy } from 'node:util/types';

import { isNormalizedAbsolutePath } from '../config/state-dir.js';

/** The mode of a private folder. */
export const privateFolderMode = 0o700;

/** The mode of a private file. */
export const privateFileMode = 0o600;

/** What the files here learn about an open descriptor or a path. */
export interface PrivateFileStats {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  readonly uid: number;
  readonly mode: number;
  readonly nlink: number;
  readonly size: number;
}

/**
 * The file functions used here. A test passes its own for what it cannot
 * build on disk, such as a file of another owner.
 */
export interface PrivateFileSystem {
  readonly mkdirSync: (path: string, mode: number) => void;
  readonly openSync: (path: string, flags: number, mode?: number) => number;
  readonly fstatSync: (fd: number) => PrivateFileStats;
  readonly lstatSync: (path: string) => PrivateFileStats;
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
    position: number,
  ) => number;
  /**
   * Writes at the end of a descriptor opened with `O_APPEND`. It takes no
   * position: with one, a system that follows POSIX writes at that
   * position even on such a descriptor, over what the file holds.
   */
  readonly appendSync: (
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
  ) => number;
  readonly fsyncSync: (fd: number) => void;
  readonly closeSync: (fd: number) => void;
  readonly linkSync: (existing: string, path: string) => void;
  /**
   * Gives a file a new name in place of whatever had it; a link at the new
   * name is replaced, never followed.
   */
  readonly renameSync: (from: string, to: string) => void;
  readonly unlinkSync: (path: string) => void;
  /** Removes an empty folder; it follows no link at the end of the path. */
  readonly rmdirSync: (path: string) => void;
  readonly readdirSync: (path: string) => string[];
  /** The ID of the user, or undefined on a platform without one. */
  readonly getuid: () => number | undefined;
  readonly constants: Readonly<Record<string, number | undefined>>;
}

/** The file functions of Node.js. */
export const nodePrivateFileSystem: PrivateFileSystem = Object.freeze({
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
  // Exactly four arguments, so that Node.js calls write(2) and not
  // pwrite(2), which writes at the position it is given on macOS even with
  // O_APPEND.
  appendSync: (
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
  ) => writeSync(fd, buffer, offset, length),
  fsyncSync,
  closeSync,
  linkSync,
  renameSync,
  unlinkSync,
  // Without options: rmdir(2) itself, which removes only an empty folder.
  rmdirSync: (path: string) => {
    rmdirSync(path);
  },
  readdirSync: (path: string) => readdirSync(path),
  getuid: () => process.getuid?.(),
  constants,
});

/**
 * Why a private file or folder could not be used, frozen: the platform
 * lacks what the checks need, the system refused, or what lies at the path
 * is not a private file or folder of the user.
 */
export const privateFileCodes = Object.freeze([
  'platform',
  'unavailable',
  'unsafe',
] as const);

/** Why a private file or folder could not be used. */
export type PrivateFileCode = (typeof privateFileCodes)[number];

/**
 * The one error of this module, with a fixed message and a code, never a
 * path or a message of the system.
 *
 * @example
 * ```ts
 * new PrivateFileError('unsafe').message; // 'A private file failed.'
 * ```
 */
export class PrivateFileError extends Error {
  /** Why the file or folder could not be used. */
  readonly code: PrivateFileCode;

  /**
   * Builds the error.
   *
   * @param code - Why the file or folder could not be used.
   */
  constructor(code: PrivateFileCode) {
    super('A private file failed.');
    this.name = 'PrivateFileError';
    this.code = code;
    Object.freeze(this);
  }
}

const fail = (code: PrivateFileCode): never => {
  throw new PrivateFileError(code);
};

const errorCode = (error: unknown): unknown => {
  if (typeof error !== 'object' || error === null || isProxy(error)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(error, 'code')?.value;
};

// A folder or a file of the user, without rights for the group or others.
const isPrivate = (stats: PrivateFileStats, uid: number): boolean =>
  stats.uid === uid && (stats.mode & 0o077) === 0;

interface Flags {
  readonly read: number;
  readonly write: number;
  readonly create: number;
  readonly append: number;
  readonly folder: number;
  readonly uid: number;
}

const flagsOf = (fs: PrivateFileSystem): Flags => {
  const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_NOCTTY } =
    fs.constants;
  const { O_APPEND, O_DIRECTORY, O_NONBLOCK } = fs.constants;
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
    O_NONBLOCK === undefined ||
    uid === undefined
  ) {
    return fail('platform');
  }
  return {
    // O_NONBLOCK, so that a FIFO in place of a file never holds the open.
    read: O_RDONLY | O_NOFOLLOW | O_NOCTTY | O_NONBLOCK,
    write: O_WRONLY | O_NOFOLLOW | O_NOCTTY | O_NONBLOCK,
    create: O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_NOCTTY,
    // Every write at the end, a missing file made; O_NONBLOCK as for
    // reading, since the path of a file of notices is the operator's.
    append: O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_NOCTTY | O_NONBLOCK,
    folder: O_RDONLY | O_DIRECTORY | O_NOFOLLOW,
    uid,
  };
};

// A name of a file inside a folder: no separator, no dot at its start, so
// that it can never be a temporary name, a link to the folder above or a
// path.
const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// The folder as the start of a path of a file in it.
const prefixOf = (folder: string): string => (folder === '/' ? '' : folder);

const pathOf = (folder: string, name: string): string => {
  if (typeof name !== 'string' || !namePattern.test(name)) {
    throw new TypeError('The name of a private file is invalid.');
  }
  return `${prefixOf(folder)}/${name}`;
};

// A temporary name no other writer uses: a dot, the plain name, the ID of
// the process, 16 hex digits and `.tmp`, as temporaryPattern below knows
// it, so that destroyPrivateFile can remove one a writer left behind.
const temporaryOf = (folder: string, name: string, pid: number): string =>
  `${prefixOf(folder)}/.${name}.${String(pid)}.${randomBytes(8).toString('hex')}.tmp`;

const close = (fs: PrivateFileSystem, fd: number): void => {
  try {
    fs.closeSync(fd);
  } catch {
    // The descriptor is given up either way.
  }
};

/**
 * Creates a private folder with 0700 if it is missing, never recursively,
 * and checks it through a descriptor opened without following a link: a
 * folder of the user without rights for others. A folder it creates is
 * flushed into the folder above with `fsync`, so that a crash right after
 * does not lose the new folder with a file that was already flushed in it
 * (ADR 0031), such as the folder of a new day of snapshots.
 *
 * @param folder - An absolute path.
 * @param fs - The file functions, only for tests.
 * @returns Nothing; the folder can be used.
 * @throws {PrivateFileError} With `platform`, `unavailable` or `unsafe`.
 * @example
 * ```ts
 * preparePrivateFolder('/srv/ecclium-keys/snapshot');
 * ```
 */
export function preparePrivateFolder(
  folder: string,
  fs: PrivateFileSystem = nodePrivateFileSystem,
): void {
  const flags = flagsOf(fs);
  let made = false;
  try {
    fs.mkdirSync(folder, privateFolderMode);
    made = true;
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') fail('unavailable');
  }
  let fd: number;
  try {
    fd = fs.openSync(folder, flags.folder);
  } catch (error) {
    const code = errorCode(error);
    return fail(
      code === 'ELOOP' || code === 'ENOTDIR' || code === 'EMLINK'
        ? 'unsafe'
        : 'unavailable',
    );
  }
  try {
    let stats: PrivateFileStats;
    try {
      stats = fs.fstatSync(fd);
    } catch {
      return fail('unavailable');
    }
    if (!stats.isDirectory() || !isPrivate(stats, flags.uid)) fail('unsafe');
  } finally {
    close(fs, fd);
  }
  // The name of a new folder stands in the folder above, which a `fsync`
  // of the folder itself does not flush. A second call after a failure
  // finds the folder and does not flush again, like a second try after a
  // failed flush of a file.
  if (made) {
    flushFolder(fs, folder.slice(0, folder.lastIndexOf('/')) || '/', flags);
  }
}

// The folder is still a folder of the user and no link, checked before
// every operation in it.
const checkFolder = (
  fs: PrivateFileSystem,
  folder: string,
  uid: number,
): void => {
  let stats: PrivateFileStats;
  try {
    stats = fs.lstatSync(folder);
  } catch (error) {
    return fail(errorCode(error) === 'ENOENT' ? 'unavailable' : 'unsafe');
  }
  if (
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    !isPrivate(stats, uid)
  ) {
    fail('unsafe');
  }
};

const writeAll = (fs: PrivateFileSystem, fd: number, bytes: Uint8Array) => {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(
      fd,
      bytes,
      offset,
      bytes.length - offset,
      offset,
    );
    if (written <= 0) fail('unavailable');
    offset += written;
  }
};

// Like writeAll, at the end of a descriptor opened with O_APPEND: each part
// lands at the end, wherever the file ends by then.
const appendAll = (fs: PrivateFileSystem, fd: number, bytes: Uint8Array) => {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.appendSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) fail('unavailable');
    offset += written;
  }
};

// Flushes a folder, so that a name given in it outlasts a crash of the
// system (ADR 0031). A file system that cannot flush a folder answers
// EINVAL or ENOTSUP; there the name stands as far as that system keeps
// names. Any other failure is reported as one, although the name is
// already in place: a second try finds the file.
const flushFolder = (
  fs: PrivateFileSystem,
  folder: string,
  flags: Flags,
): void => {
  let fd: number;
  try {
    fd = fs.openSync(folder, flags.folder);
  } catch {
    return fail('unavailable');
  }
  try {
    fs.fsyncSync(fd);
  } catch (error) {
    const code = errorCode(error);
    if (code !== 'EINVAL' && code !== 'ENOTSUP') fail('unavailable');
  } finally {
    close(fs, fd);
  }
};

/** What {@link writePrivateFileOnce} needs besides the file functions. */
export interface WriteOnceOptions {
  /** The ID of the process, part of the temporary name. */
  readonly pid: number;
  /** The file functions, only for tests. */
  readonly fs?: PrivateFileSystem;
}

/**
 * Writes a private file once: whole under a temporary name, flushed, and
 * then given its name, unless the name is taken, and the folder flushed
 * after it. A file of that name is never changed.
 *
 * @param folder - A private folder, as {@link preparePrivateFolder} made it.
 * @param name - The name of the file in the folder.
 * @param bytes - What the file holds.
 * @param options - The ID of the process and, for tests, the file
 *   functions.
 * @returns `written` when the file is new, `exists` when a file of the name
 *   was there already; that file is left as it is.
 * @throws {PrivateFileError} When the folder or the system refuses, also
 *   when the folder does not flush after the link: the file then has its
 *   name, and a second call finds it.
 * @throws {TypeError} For a name that is not a plain name of a file.
 * @example
 * ```ts
 * writePrivateFileOnce(folder, 'default.2026-11-03.key', bytes, { pid: process.pid });
 * ```
 */
export function writePrivateFileOnce(
  folder: string,
  name: string,
  bytes: Uint8Array,
  options: WriteOnceOptions,
): 'written' | 'exists' {
  const fs = options.fs ?? nodePrivateFileSystem;
  const path = pathOf(folder, name);
  const flags = flagsOf(fs);
  checkFolder(fs, folder, flags.uid);
  const temporary = temporaryOf(folder, name, options.pid);
  let fd: number;
  try {
    fd = fs.openSync(temporary, flags.create, privateFileMode);
  } catch {
    return fail('unavailable');
  }
  try {
    try {
      const stats = fs.fstatSync(fd);
      if (!stats.isFile() || !isPrivate(stats, flags.uid)) fail('unsafe');
      writeAll(fs, fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      close(fs, fd);
    }
    try {
      fs.linkSync(temporary, path);
    } catch (error) {
      if (errorCode(error) === 'EEXIST') return 'exists';
      return fail('unavailable');
    }
    flushFolder(fs, folder, flags);
    return 'written';
  } catch (error) {
    throw error instanceof PrivateFileError
      ? error
      : new PrivateFileError('unavailable');
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // A temporary name left behind is destroyed with its file.
    }
  }
}

/** What {@link replacePrivateFile} needs besides the file functions. */
export interface ReplaceOptions {
  /** The ID of the process, part of the temporary name. */
  readonly pid: number;
  /** The file functions, only for tests. */
  readonly fs?: PrivateFileSystem;
}

/**
 * Writes a private file whole and puts it in the place of any file of that
 * name, such as a draft that a second run of the same period replaces (ADR
 * 0033): written under a temporary name, flushed, then given its name with
 * `rename` and the folder flushed after it. A reader sees the old file or
 * the new one, never half of one. `rename` replaces a link at the name and
 * never follows it, so the target of such a link keeps its bytes. The
 * temporary name is removed when anything fails before the rename.
 *
 * @param folder - A private folder, as {@link preparePrivateFolder} made it.
 * @param name - The name of the file in the folder.
 * @param bytes - What the file holds.
 * @param options - The ID of the process and, for tests, the file
 *   functions.
 * @returns Nothing; the file of that name holds the bytes.
 * @throws {PrivateFileError} With `unsafe` when the folder is not private
 *   or a folder has the name, otherwise when the folder or the system
 *   refuses, also when the folder does not flush after the rename: the new
 *   file then has its name already.
 * @throws {TypeError} For a name that is not a plain name of a file.
 * @example
 * ```ts
 * replacePrivateFile(folder, 'weekly-2026-W45.md', bytes, { pid: process.pid });
 * ```
 */
export function replacePrivateFile(
  folder: string,
  name: string,
  bytes: Uint8Array,
  options: ReplaceOptions,
): void {
  const fs = options.fs ?? nodePrivateFileSystem;
  const path = pathOf(folder, name);
  const flags = flagsOf(fs);
  checkFolder(fs, folder, flags.uid);
  const temporary = temporaryOf(folder, name, options.pid);
  let fd: number;
  try {
    fd = fs.openSync(temporary, flags.create, privateFileMode);
  } catch {
    return fail('unavailable');
  }
  // After the rename the file no longer has the temporary name, and
  // removing that name would remove nothing or, at worst, another file.
  let renamed = false;
  try {
    try {
      const stats = fs.fstatSync(fd);
      if (!stats.isFile() || !isPrivate(stats, flags.uid)) fail('unsafe');
      writeAll(fs, fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      close(fs, fd);
    }
    try {
      fs.renameSync(temporary, path);
    } catch (error) {
      return fail(errorCode(error) === 'EISDIR' ? 'unsafe' : 'unavailable');
    }
    renamed = true;
    flushFolder(fs, folder, flags);
  } catch (error) {
    throw error instanceof PrivateFileError
      ? error
      : new PrivateFileError('unavailable');
  } finally {
    if (!renamed) {
      try {
        fs.unlinkSync(temporary);
      } catch {
        // A temporary name left behind is destroyed with its file.
      }
    }
  }
}

/** What {@link appendPrivateLine} takes besides the path and the line. */
export interface AppendLineOptions {
  /** The file functions, only for tests. */
  readonly fs?: PrivateFileSystem;
}

// Every end of a line a reader may split at, so that one call adds exactly
// one line.
const lineBreakPattern = /[\n\r\u2028\u2029]/u;

const encoder = new TextEncoder();

/**
 * Adds one line and its `\n` at the end of a private file, such as the
 * notice of a run, which names routine, period and outcome, never content
 * (ADR 0033). A missing file is made with 0600. The file is opened for
 * appending without following a link and checked on its descriptor: a
 * regular file of the user without rights for others. Every byte is
 * written at the end, then flushed with `fsync`. The folder is the
 * operator's choice and is not checked; only the file is.
 *
 * @param path - An absolute, normalised path of the file.
 * @param line - The line, not empty, without an end of a line.
 * @param options - For tests, the file functions.
 * @returns Nothing; the line is at the end of the file.
 * @throws {PrivateFileError} With `platform`; with `unsafe` for a link, a
 *   folder or a file that is not a private file of the user; with
 *   `unavailable` when the system refuses. A write that fails halfway may
 *   leave the start of the line in the file, a failed `fsync` the whole
 *   line.
 * @throws {TypeError} For a path that is not absolute and normalised, and
 *   for a line that is empty or holds an end of a line.
 * @example
 * ```ts
 * appendPrivateLine('/srv/ecclium/notices.jsonl', '{"routine":"weekly"}');
 * ```
 */
export function appendPrivateLine(
  path: string,
  line: string,
  options: AppendLineOptions = {},
): void {
  if (!isNormalizedAbsolutePath(path)) {
    throw new TypeError('The path of a private file is invalid.');
  }
  if (typeof line !== 'string' || line === '' || lineBreakPattern.test(line)) {
    throw new TypeError('The line for a private file is invalid.');
  }
  const fs = options.fs ?? nodePrivateFileSystem;
  const flags = flagsOf(fs);
  let fd: number;
  try {
    fd = fs.openSync(path, flags.append, privateFileMode);
  } catch (error) {
    // A link at the path (ELOOP, EMLINK on some systems) or a folder.
    const code = errorCode(error);
    return fail(
      code === 'ELOOP' || code === 'EMLINK' || code === 'EISDIR'
        ? 'unsafe'
        : 'unavailable',
    );
  }
  try {
    const stats = fs.fstatSync(fd);
    // One name only: a second hard link at the path would make the line
    // land in a file the user keeps for something else.
    if (!stats.isFile() || !isPrivate(stats, flags.uid) || stats.nlink !== 1) {
      fail('unsafe');
    }
    appendAll(fs, fd, encoder.encode(`${line}\n`));
    fs.fsyncSync(fd);
  } catch (error) {
    throw error instanceof PrivateFileError
      ? error
      : new PrivateFileError('unavailable');
  } finally {
    close(fs, fd);
  }
}

/**
 * Reads a private file whole.
 *
 * @param folder - A private folder.
 * @param name - The name of the file in the folder.
 * @param maxBytes - The largest file read; a larger one is refused.
 * @param fs - The file functions, only for tests.
 * @returns The bytes, or undefined when there is no file of that name.
 * @throws {PrivateFileError} When the folder or the file is not private,
 *   too large or does not read whole.
 * @throws {TypeError} For a name that is not a plain name of a file.
 * @example
 * ```ts
 * const bytes = readPrivateFile(folder, 'default.2026-11-03.key', 64);
 * ```
 */
export function readPrivateFile(
  folder: string,
  name: string,
  maxBytes: number,
  fs: PrivateFileSystem = nodePrivateFileSystem,
): Uint8Array | undefined {
  const path = pathOf(folder, name);
  const flags = flagsOf(fs);
  checkFolder(fs, folder, flags.uid);
  let fd: number;
  try {
    fd = fs.openSync(path, flags.read);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') return undefined;
    return fail(code === 'ELOOP' ? 'unsafe' : 'unavailable');
  }
  try {
    let stats: PrivateFileStats;
    try {
      stats = fs.fstatSync(fd);
    } catch {
      return fail('unavailable');
    }
    // Two names only for the moment between the link of a writer and the
    // removal of its temporary name.
    if (
      !stats.isFile() ||
      !isPrivate(stats, flags.uid) ||
      stats.nlink < 1 ||
      stats.nlink > 2 ||
      stats.size > maxBytes
    ) {
      fail('unsafe');
    }
    // One byte more than the size, so that a file that grew is noticed.
    // What was read is erased before a refusal, since a file may hold a key.
    const buffer = new Uint8Array(stats.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      let read: number;
      try {
        read = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      } catch {
        buffer.fill(0);
        return fail('unavailable');
      }
      if (read === 0) break;
      offset += read;
    }
    if (offset !== stats.size) {
      buffer.fill(0);
      fail('unavailable');
    }
    return buffer.subarray(0, stats.size);
  } finally {
    close(fs, fd);
  }
}

/**
 * Lists the names in a private folder.
 *
 * @param folder - A private folder.
 * @param fs - The file functions, only for tests.
 * @returns The names, sorted; none when the folder does not exist.
 * @throws {PrivateFileError} When the folder is not private or does not
 *   list.
 * @example
 * ```ts
 * const names = listPrivateFolder(folder);
 * ```
 */
export function listPrivateFolder(
  folder: string,
  fs: PrivateFileSystem = nodePrivateFileSystem,
): readonly string[] {
  const flags = flagsOf(fs);
  try {
    fs.lstatSync(folder);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return Object.freeze([]);
  }
  checkFolder(fs, folder, flags.uid);
  try {
    return Object.freeze([...fs.readdirSync(folder)].sort());
  } catch {
    return fail('unavailable');
  }
}

// The temporary name writePrivateFileOnce and replacePrivateFile give a
// file (temporaryOf): a dot, the plain name, the ID of the process, 16 hex
// digits and `.tmp`.
const temporaryPattern =
  /^\.[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.\d{1,10}\.[0-9a-f]{16}\.tmp$/;

// Writes zeros over a regular file of the user and flushes them, as far as
// it opens for writing and is no larger than the bound. A file that does
// not, or that changed between the look at its name and the open, keeps
// its bytes: its name goes all the same.
const zeroFile = (
  fs: PrivateFileSystem,
  target: string,
  maxBytes: number,
  flags: Flags,
): void => {
  let fd: number;
  try {
    fd = fs.openSync(target, flags.write);
  } catch {
    return;
  }
  try {
    const stats = fs.fstatSync(fd);
    if (!stats.isFile() || stats.uid !== flags.uid || stats.size > maxBytes) {
      return;
    }
    writeAll(fs, fd, new Uint8Array(stats.size));
    fs.fsyncSync(fd);
  } catch {
    // The name goes below; zeros are only the second line of defence.
  } finally {
    close(fs, fd);
  }
};

/**
 * Destroys an entry of a private folder, so that nothing of it can be read
 * there any more. A regular file of the user first gets zeros over all of
 * it, flushed, where it opens for writing and is no larger than the bound,
 * so that a second name of the same file keeps only zeros, and then loses
 * its name, also when it could not be zeroed: rights for others or a mode
 * without writing make no exception, since such a file needs destroying
 * most. A link, a FIFO or a socket holds no bytes and only loses its name.
 * A folder and an entry of another user stay and make it throw, so that a
 * caller can go on with its other entries and report the one that stayed.
 *
 * @param folder - A private folder.
 * @param name - The name of the entry, a plain one or a temporary one that
 *   {@link writePrivateFileOnce} or {@link replacePrivateFile} left behind.
 * @param maxBytes - The largest file zeroed; a larger one only loses its
 *   name.
 * @param fs - The file functions, only for tests.
 * @returns Whether an entry was there and is gone.
 * @throws {PrivateFileError} When the folder is not private, the entry is a
 *   folder or belongs to another user, or its name cannot be removed.
 * @throws {TypeError} For a name that is neither a plain nor a temporary
 *   name of a file.
 * @example
 * ```ts
 * destroyPrivateFile(folder, 'default.2026-10-01.key', 64);
 * ```
 */
export function destroyPrivateFile(
  folder: string,
  name: string,
  maxBytes: number,
  fs: PrivateFileSystem = nodePrivateFileSystem,
): boolean {
  const temporary = typeof name === 'string' && temporaryPattern.test(name);
  const target = temporary
    ? `${prefixOf(folder)}/${name}`
    : pathOf(folder, name);
  const flags = flagsOf(fs);
  checkFolder(fs, folder, flags.uid);
  let entry: PrivateFileStats;
  try {
    entry = fs.lstatSync(target);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    return fail('unavailable');
  }
  if (entry.uid !== flags.uid || entry.isDirectory()) fail('unsafe');
  if (entry.isFile()) zeroFile(fs, target, maxBytes, flags);
  try {
    fs.unlinkSync(target);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') fail('unavailable');
  }
  return true;
}

/**
 * Removes an empty private folder, such as the folder of a day of
 * snapshots after its records were destroyed (ADR 0031). It follows no
 * link: an entry that is a link or no folder stays and makes it throw, and
 * `rmdir` removes only a folder that is empty, so nothing in it is ever
 * lost here. A folder that is not there counts as removed, since another
 * process may have removed it first.
 *
 * @param folder - The folder to remove, inside a private folder.
 * @param fs - The file functions, only for tests.
 * @returns Nothing; the folder is gone.
 * @throws {PrivateFileError} With `unsafe` for a link or an entry that is
 *   no folder, with `unavailable` for a folder that is not empty or that
 *   the system does not remove.
 * @example
 * ```ts
 * removePrivateFolder('/srv/ecclium/snapshots/2026-10-01');
 * ```
 */
export function removePrivateFolder(
  folder: string,
  fs: PrivateFileSystem = nodePrivateFileSystem,
): void {
  let stats: PrivateFileStats;
  try {
    stats = fs.lstatSync(folder);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    return fail('unavailable');
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) fail('unsafe');
  try {
    fs.rmdirSync(folder);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') fail('unavailable');
  }
}
