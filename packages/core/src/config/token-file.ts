/**
 * Reads the login token of ChurchTools from a file (ADR 0055). The checks
 * run on the open descriptor, never on the path again, and the read stops
 * after a fixed number of bytes, so neither a file swapped after the open
 * nor one that grows after the check gets past them.
 *
 * Its only runtime imports are built-in modules, so a test can run it from
 * source in a child process. The caller passes the function that wraps the
 * value, in the product the constructor of `Secret`.
 *
 * @packageDocumentation
 */
import { Buffer } from 'node:buffer';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isProxy } from 'node:util/types';

/**
 * The reasons to refuse a token file, frozen. A code never carries the path
 * or the content of the file.
 */
export const tokenFileCodes = Object.freeze([
  'token_file_relative',
  'token_file_platform',
  'token_file_missing',
  'token_file_symlink',
  'token_file_unreadable',
  'token_file_not_regular',
  'token_file_owner',
  'token_file_mode',
  'token_file_too_large',
  'token_file_empty',
  'token_file_bom',
  'token_file_characters',
  'token_file_unsafe',
  'token_invalid',
] as const);

/** The reason to refuse a token file. */
export type TokenFileCode = (typeof tokenFileCodes)[number];

/** What the reader learns about the open file. */
export interface TokenFileStats {
  isFile(): boolean;
  readonly uid: number;
  readonly mode: number;
  readonly size: number;
}

/**
 * The file functions the reader uses. A test passes its own for what it
 * cannot build on disk, such as a file of another owner.
 */
export interface TokenFileSystem {
  readonly openSync: (path: string, flags: number) => number;
  readonly fstatSync: (fd: number) => TokenFileStats;
  readonly readSync: (
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: null,
  ) => number;
  readonly closeSync: (fd: number) => void;
  /** The ID of the user, or undefined on a platform without one. */
  readonly getuid: () => number | undefined;
  readonly constants: {
    readonly O_RDONLY?: number | undefined;
    readonly O_NOFOLLOW?: number | undefined;
    readonly O_NONBLOCK?: number | undefined;
    readonly O_NOCTTY?: number | undefined;
  };
}

/** The wrapped token, or the reason to refuse the file. */
export type TokenFileResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: TokenFileCode };

/**
 * The most bytes a token file may hold: the longest token a `Secret` takes,
 * 4096 characters (ADR 0054), and CR LF.
 */
export const maxTokenFileBytes = 4096 + 2;

const nodeFileSystem: TokenFileSystem = Object.freeze({
  openSync,
  fstatSync,
  readSync,
  closeSync,
  getuid: () => process.getuid?.(),
  constants,
});

const refuse = <T>(code: TokenFileCode): TokenFileResult<T> =>
  Object.freeze({ __proto__: null, ok: false, code });

// The code of an error of open. Its own data property code is read, so that
// no getter runs, and the message, which holds the path, never leaves. Any
// error not named here, such as ENOTDIR, is unsafe. EMLINK is how some
// systems refuse a link under O_NOFOLLOW.
const openCode = (error: unknown): TokenFileCode => {
  if (typeof error !== 'object' || error === null || isProxy(error)) {
    return 'token_file_unsafe';
  }
  switch (Object.getOwnPropertyDescriptor(error, 'code')?.value) {
    case 'ENOENT':
      return 'token_file_missing';
    case 'ELOOP':
    case 'EMLINK':
      return 'token_file_symlink';
    case 'EACCES':
    case 'EPERM':
      return 'token_file_unreadable';
    default:
      return 'token_file_unsafe';
  }
};

const readOpen = <T>(
  fs: TokenFileSystem,
  fd: number,
  uid: number,
  buffer: Buffer,
  wrap: (value: string) => T,
): TokenFileResult<T> => {
  const stats = fs.fstatSync(fd);
  if (!stats.isFile()) return refuse('token_file_not_regular');
  if (stats.uid !== uid) return refuse('token_file_owner');
  if ((stats.mode & 0o077) !== 0) return refuse('token_file_mode');
  // Only a quick answer: the file can still grow, so the read below keeps
  // its own bound.
  if (stats.size > maxTokenFileBytes) return refuse('token_file_too_large');

  let length = 0;
  while (length < buffer.length) {
    const free = buffer.length - length;
    const read = fs.readSync(fd, buffer, length, free, null);
    if (!Number.isInteger(read) || read < 0 || read > free) {
      return refuse('token_file_unsafe');
    }
    if (read === 0) break;
    length += read;
  }
  if (length > maxTokenFileBytes) return refuse('token_file_too_large');

  // Exactly one line ending, LF or CR LF. Anything else that is left, such
  // as a lone CR or a second LF, fails the check of the bytes.
  let end = length;
  if (buffer[end - 1] === 0x0a) {
    end -= 1;
    if (buffer[end - 1] === 0x0d) end -= 1;
  }
  if (end === 0) return refuse('token_file_empty');
  // The marks of UTF-8 and UTF-16 get their own code, so the hint can name
  // the editor setting. Their bytes are no visible ASCII, so any other start
  // falls to the check of the bytes below. Past the end lie only the
  // dropped line ending and zeros, never a byte of a mark.
  const [first, second, third] = buffer;
  if (
    (first === 0xef && second === 0xbb && third === 0xbf) ||
    (first === 0xff && second === 0xfe) ||
    (first === 0xfe && second === 0xff)
  ) {
    return refuse('token_file_bom');
  }
  // Byte by byte and never with a regular expression, whose statics would
  // keep the token for every module in the process.
  for (let index = 0; index < end; index += 1) {
    const byte = buffer[index] ?? 0;
    if (byte < 0x21 || byte > 0x7e) return refuse('token_file_characters');
  }

  const value = buffer.toString('latin1', 0, end);
  try {
    return Object.freeze({ __proto__: null, ok: true, value: wrap(value) });
  } catch (error) {
    return refuse(
      error instanceof RangeError ? 'token_invalid' : 'token_file_unsafe',
    );
  }
};

/**
 * Reads a token from a file and wraps it. The path must be absolute. The
 * file is opened without following a link at the last part of the path,
 * without blocking on a FIFO and without becoming the controlling
 * terminal. It must be a regular file of the user, without rights for the
 * group or others, and hold at most {@link maxTokenFileBytes} bytes. One
 * line ending at the end is dropped, and every other byte must be visible
 * ASCII. A byte order mark of UTF-8 or UTF-16 is refused with its own
 * code, never dropped.
 *
 * Folders above the file are trusted: no flag of open checks them.
 *
 * @param path - The absolute path of the file.
 * @param wrap - Wraps the value. A RangeError from it refuses the token.
 * @param fs - The file functions, only for tests.
 * @returns The wrapped token, or the code of the first check that failed.
 * @throws {TypeError} When the path is not a string or wrap no function.
 * @example
 * ```ts
 * const token = readTokenFile('/path/to/token-file', (value) => new Secret(value));
 * if (!token.ok) report(token.code);
 * ```
 */
export function readTokenFile<T>(
  path: string,
  wrap: (value: string) => T,
  fs: TokenFileSystem = nodeFileSystem,
): TokenFileResult<T> {
  if (typeof path !== 'string') {
    throw new TypeError('The path of a token file must be a string.');
  }
  if (typeof wrap !== 'function') {
    throw new TypeError('A token file needs a function that wraps the value.');
  }
  if (!isAbsolute(path)) return refuse('token_file_relative');
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
    return refuse('token_file_platform');
  }

  let fd: number;
  try {
    fd = fs.openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY);
  } catch (error) {
    return refuse(openCode(error));
  }
  const buffer = Buffer.alloc(maxTokenFileBytes + 1);
  try {
    return readOpen(fs, fd, uid, buffer, wrap);
  } catch {
    return refuse('token_file_unsafe');
  } finally {
    buffer.fill(0);
    try {
      fs.closeSync(fd);
    } catch {
      // The token is read or refused already; a failed close changes
      // neither.
    }
  }
}
