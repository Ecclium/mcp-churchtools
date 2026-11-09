/**
 * Reads the files and folders of the configuration that are no secret: the
 * file of the policy (ADR 0032), and the routines with their prompts and
 * templates (ADR 0033).
 *
 * Where it stands: at the start, before the reader of YAML and the check
 * of a schema. A file is opened like the token file, without following a
 * link at the last part of the path, without blocking on a FIFO and
 * without becoming the controlling terminal, and every check runs on the
 * open descriptor. It must be a regular file of the user. It may be
 * readable for others, but group and others must not write it, because
 * these files decide which targets a write may reach and what a run reads
 * and sends to a model. The read stops after a limit the caller gives,
 * and the text must be UTF-8 without a byte order mark. A folder is opened
 * the same way and must be a folder of the user that group and others
 * cannot write, so that nobody else can put a file into it.
 *
 * Nothing here returns or throws the path, the message of the file system
 * or a value of the file: a refusal is a reason, and each caller turns it
 * into a code of its own, such as `policy_file_mode`.
 *
 * @packageDocumentation
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from 'node:fs';
import { isAbsolute } from 'node:path';
import { isProxy } from 'node:util/types';

import type { TokenFileSystem } from './token-file.js';

/** Why a file or a folder of the configuration is refused, frozen. */
export const configFileReasons = Object.freeze([
  'relative',
  'platform',
  'missing',
  'symlink',
  'unreadable',
  'not_regular',
  'not_directory',
  'owner',
  'mode',
  'too_large',
  'bom',
  'encoding',
  'unsafe',
] as const);

/** Why a file or a folder of the configuration is refused. */
export type ConfigFileReason = (typeof configFileReasons)[number];

/** Why a file of the configuration is refused: never `not_directory`. */
export type ConfigTextFileReason = Exclude<ConfigFileReason, 'not_directory'>;

/** The file functions the reader of a file uses; a test passes its own. */
export type ConfigFileSystem = TokenFileSystem;

/** What the reader of a folder learns about the open folder. */
export interface ConfigDirectoryStats {
  isDirectory(): boolean;
  readonly uid: number;
  readonly mode: number;
}

/** The functions the reader of a folder uses; a test passes its own. */
export interface ConfigDirectorySystem {
  readonly openSync: (path: string, flags: number) => number;
  readonly fstatSync: (fd: number) => ConfigDirectoryStats;
  readonly closeSync: (fd: number) => void;
  /** The names of the entries of a folder, without `.` and `..`. */
  readonly readdirSync: (path: string) => readonly string[];
  /** Only to tell a link from a file after an open refused both. */
  readonly lstatSync: (path: string) => { isSymbolicLink(): boolean };
  /** The ID of the user, or undefined on a platform without one. */
  readonly getuid: () => number | undefined;
  readonly constants: {
    readonly O_RDONLY?: number | undefined;
    readonly O_NOFOLLOW?: number | undefined;
    readonly O_NONBLOCK?: number | undefined;
    readonly O_DIRECTORY?: number | undefined;
  };
}

/** The text of a file, or why it is refused. */
export type ConfigTextFileResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: ConfigTextFileReason };

/** The names in a folder, sorted, or why it is refused. */
export type ConfigDirectoryResult =
  | { readonly ok: true; readonly names: readonly string[] }
  | { readonly ok: false; readonly reason: ConfigFileReason };

/** The most entries a folder of the configuration may hold. */
export const maxConfigDirectoryEntries = 1000;

const nodeFileSystem: ConfigFileSystem & ConfigDirectorySystem = Object.freeze({
  openSync,
  fstatSync,
  readSync,
  closeSync,
  readdirSync: (path: string) => readdirSync(path),
  lstatSync: (path: string) => lstatSync(path),
  getuid: () => process.getuid?.(),
  constants,
});

const refuse = <R extends ConfigFileReason>(
  reason: R,
): { readonly ok: false; readonly reason: R } =>
  Object.freeze({ __proto__: null, ok: false, reason });

// The code of an error of the file system, read from its own data
// property, so that no getter runs.
const codeOf = (error: unknown): unknown =>
  typeof error !== 'object' || error === null || isProxy(error)
    ? undefined
    : Object.getOwnPropertyDescriptor(error, 'code')?.value;

// The reason of an error of open. Its own data property code is read, so
// that no getter runs, and the message, which holds the path, never leaves.
// EMLINK is how some systems refuse a link under O_NOFOLLOW. ENOTDIR on a
// file means a part of the path above is no folder, which stays unsafe
// like every error not named here; a folder asks for it on its own.
const openReason = (error: unknown): ConfigTextFileReason => {
  switch (codeOf(error)) {
    case 'ENOENT':
      return 'missing';
    case 'ELOOP':
    case 'EMLINK':
      return 'symlink';
    case 'EACCES':
    case 'EPERM':
      return 'unreadable';
    default:
      return 'unsafe';
  }
};

// The text of the open file, or the reason of the first check that failed.
const textOf = (
  fs: ConfigFileSystem,
  fd: number,
  uid: number,
  maxBytes: number,
): { readonly text: string } | { readonly reason: ConfigTextFileReason } => {
  const stats = fs.fstatSync(fd);
  if (!stats.isFile()) return { reason: 'not_regular' };
  if (stats.uid !== uid) return { reason: 'owner' };
  if ((stats.mode & 0o022) !== 0) return { reason: 'mode' };
  // Only a quick answer: the file can still grow, so the read below keeps
  // its own bound.
  if (stats.size > maxBytes) return { reason: 'too_large' };

  const buffer = new Uint8Array(maxBytes + 1);
  let length = 0;
  while (length < buffer.length) {
    const free = buffer.length - length;
    const read = fs.readSync(fd, buffer, length, free, null);
    if (!Number.isInteger(read) || read < 0 || read > free) {
      return { reason: 'unsafe' };
    }
    if (read === 0) break;
    length += read;
  }
  if (length > maxBytes) return { reason: 'too_large' };
  const [first, second, third] = buffer;
  if (
    (first === 0xef && second === 0xbb && third === 0xbf) ||
    (first === 0xff && second === 0xfe) ||
    (first === 0xfe && second === 0xff)
  ) {
    return { reason: 'bom' };
  }
  try {
    return {
      text: new TextDecoder('utf-8', { fatal: true }).decode(
        buffer.subarray(0, length),
      ),
    };
  } catch {
    return { reason: 'encoding' };
  }
};

const closeQuietly = (fs: { closeSync(fd: number): void }, fd: number) => {
  try {
    fs.closeSync(fd);
  } catch {
    // The file is read or refused already; a failed close changes neither.
  }
};

// Whether a path an open refused as no folder is a link.
const linkOrNot = (
  fs: ConfigDirectorySystem,
  path: string,
): ConfigFileReason => {
  try {
    return fs.lstatSync(path).isSymbolicLink() ? 'symlink' : 'not_directory';
  } catch {
    return 'not_directory';
  }
};

/**
 * Reads a text file of the configuration that is no secret. The path must
 * be absolute. Folders above the file are trusted: no flag of open checks
 * them.
 *
 * @param path - The absolute path of the file.
 * @param maxBytes - The most bytes the file may hold, a positive integer.
 * @param fs - The file functions, only for tests.
 * @returns The text, or the reason of the first check that failed. It
 *   never throws for a file.
 * @throws {TypeError} When the path is not a string or the limit no
 *   positive integer.
 * @example
 * ```ts
 * const read = readConfigTextFile('/path/to/policy.yaml', 262_144);
 * if (!read.ok) report(`policy_file_${read.reason}`);
 * ```
 */
export function readConfigTextFile(
  path: string,
  maxBytes: number,
  fs: ConfigFileSystem = nodeFileSystem,
): ConfigTextFileResult {
  if (typeof path !== 'string') {
    throw new TypeError('The path of the file must be a string.');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError('The limit of the file must be a positive integer.');
  }
  if (!isAbsolute(path)) return refuse('relative');
  // Without these flags or the ID of the user, as on Windows, the checks
  // would be skipped silently, so the read stops instead.
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK, O_NOCTTY } = fs.constants;
  const uid = fs.getuid();
  if (
    O_RDONLY === undefined ||
    O_NOFOLLOW === undefined ||
    O_NONBLOCK === undefined ||
    O_NOCTTY === undefined ||
    uid === undefined
  ) {
    return refuse('platform');
  }

  let fd: number;
  try {
    fd = fs.openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY);
  } catch (error) {
    return refuse(openReason(error));
  }
  let read: ReturnType<typeof textOf>;
  try {
    read = textOf(fs, fd, uid, maxBytes);
  } catch {
    read = { reason: 'unsafe' };
  } finally {
    closeQuietly(fs, fd);
  }
  if ('reason' in read) return refuse(read.reason);
  return Object.freeze({ __proto__: null, ok: true, text: read.text });
}

/**
 * Lists a folder of the configuration, such as the folder of the routines.
 * The folder is opened without following a link and checked on the open
 * descriptor; the names come after the check, from the same path. Folders
 * above it are trusted, as for a file: only someone who may write them
 * could swap the folder in between.
 *
 * @param path - The absolute path of the folder.
 * @param fs - The file functions, only for tests.
 * @returns The names of its entries, sorted by UTF-16 code units, or the reason
 *   of the first check that failed. It never throws for a folder.
 * @throws {TypeError} When the path is not a string.
 * @example
 * ```ts
 * const listed = listConfigDirectory('/path/to/routines');
 * if (listed.ok) listed.names.filter((name) => name.endsWith('.yaml'));
 * ```
 */
export function listConfigDirectory(
  path: string,
  fs: ConfigDirectorySystem = nodeFileSystem,
): ConfigDirectoryResult {
  if (typeof path !== 'string') {
    throw new TypeError('The path of the folder must be a string.');
  }
  if (!isAbsolute(path)) return refuse('relative');
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK, O_DIRECTORY } = fs.constants;
  const uid = fs.getuid();
  if (
    O_RDONLY === undefined ||
    O_NOFOLLOW === undefined ||
    O_NONBLOCK === undefined ||
    O_DIRECTORY === undefined ||
    uid === undefined
  ) {
    return refuse('platform');
  }

  let fd: number;
  try {
    fd = fs.openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_DIRECTORY);
  } catch (error) {
    // Some systems, macOS among them, refuse a link to a folder under
    // O_DIRECTORY as no folder rather than as a link. Asking once more
    // only tells the operator which of the two it is; both are refused.
    return codeOf(error) === 'ENOTDIR'
      ? refuse(linkOrNot(fs, path))
      : refuse(openReason(error));
  }
  let checked: ConfigFileReason | undefined;
  try {
    const stats = fs.fstatSync(fd);
    if (!stats.isDirectory()) checked = 'not_directory';
    else if (stats.uid !== uid) checked = 'owner';
    else if ((stats.mode & 0o022) !== 0) checked = 'mode';
  } catch {
    checked = 'unsafe';
  } finally {
    closeQuietly(fs, fd);
  }
  if (checked !== undefined) return refuse(checked);

  // Read as unknown: the functions of a test, or a changed library, could
  // hand back anything, and a name that is no text is refused.
  let listed: unknown;
  try {
    listed = fs.readdirSync(path);
  } catch (error) {
    return refuse(
      codeOf(error) === 'ENOTDIR' ? 'not_directory' : openReason(error),
    );
  }
  if (!Array.isArray(listed)) return refuse('unsafe');
  const names: unknown[] = [...(listed as unknown[])];
  if (!names.every((name): name is string => typeof name === 'string')) {
    return refuse('unsafe');
  }
  if (names.length > maxConfigDirectoryEntries) return refuse('too_large');
  return Object.freeze({
    __proto__: null,
    ok: true,
    names: Object.freeze(names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))),
  });
}
