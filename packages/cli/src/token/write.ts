/**
 * Writes the file of the bearer tokens for `ecclium token` (ADR 0074).
 *
 * The file decides who may use the server over HTTP, so a reader must
 * never see half of it. It is written whole under a temporary name in its
 * own folder, flushed with `fsync`, given its name with `rename`, which
 * puts it in the place of the old file whole, and the folder is flushed
 * after it. The new file has the mode 0600.
 *
 * Two commands at once must not lose a change of the other, least of all a
 * revocation. A command that changes the file holds a lock file beside it,
 * made with `O_EXCL`, from before its read until after the rename; a second
 * command finds it and stops. A lock older than a minute, left by a command
 * that died, is taken over: no command holds it longer than a few
 * milliseconds. A person who edits the file by hand takes no lock, so the
 * command also notes what the file was when it read it, its device, inode,
 * size and time of change, and the writer gives it its name only if the
 * file is still that one, or still missing when it was missing.
 *
 * The folder must be a folder of the user that group and others cannot
 * write, as the reader of the files of the configuration demands of the
 * folders it lists, so that nobody else can swap the file.
 *
 * Nothing here names the path or a message of the system.
 *
 * @packageDocumentation
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** What a file was when the command read it, or `missing`. */
export type FileIdentity =
  | 'missing'
  | {
      readonly dev: number;
      readonly ino: number;
      readonly size: number;
      readonly mtimeMs: number;
    };

/** What the writer learns about a file or folder. */
export interface WriterStats {
  isFile(): boolean;
  isDirectory(): boolean;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly uid: number;
  readonly mode: number;
}

/** The file functions the writer uses; a test passes its own. */
export interface WriterFileSystem {
  readonly openSync: (path: string, flags: number, mode?: number) => number;
  readonly fstatSync: (fd: number) => WriterStats;
  readonly lstatSync: (path: string) => WriterStats;
  readonly writeSync: (
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
  ) => number;
  readonly fsyncSync: (fd: number) => void;
  readonly closeSync: (fd: number) => void;
  readonly renameSync: (from: string, to: string) => void;
  readonly unlinkSync: (path: string) => void;
  /** The ID of the user, or undefined on a platform without one. */
  readonly getuid: () => number | undefined;
  /** The ID of the process, part of the temporary name. */
  readonly pid: number;
}

/** The file functions of Node.js. */
export const nodeWriterFileSystem: WriterFileSystem = Object.freeze({
  openSync: (path: string, flags: number, mode?: number) =>
    openSync(path, flags, mode),
  fstatSync: (fd: number) => fstatSync(fd),
  lstatSync: (path: string) => lstatSync(path),
  writeSync: (fd: number, buffer: Uint8Array, offset: number, length: number) =>
    writeSync(fd, buffer, offset, length),
  fsyncSync: (fd: number) => {
    fsyncSync(fd);
  },
  closeSync: (fd: number) => {
    closeSync(fd);
  },
  renameSync: (from: string, to: string) => {
    renameSync(from, to);
  },
  unlinkSync: (path: string) => {
    unlinkSync(path);
  },
  getuid: () => process.getuid?.(),
  pid: process.pid,
});

/**
 * How a write ended: written, the file changed since it was read, the
 * folder or the file at the name is not safe, or the system refused.
 */
export type WriteOutcome = 'written' | 'changed' | 'unsafe' | 'unavailable';

/** The mode of the file of the tokens. */
export const tokensFileMode = 0o600;

const errorCode = (error: unknown): unknown =>
  typeof error === 'object' && error !== null
    ? Object.getOwnPropertyDescriptor(error, 'code')?.value
    : undefined;

/**
 * What the file at a path is now.
 *
 * @param path - The absolute path of the file.
 * @param fs - The file functions, only for tests.
 * @returns Its identity, `missing`, or undefined when the system refused
 *   or something other than a file lies there.
 * @example
 * ```ts
 * const before = identityOf('/config/http-tokens.yaml');
 * ```
 */
export function identityOf(
  path: string,
  fs: WriterFileSystem = nodeWriterFileSystem,
): FileIdentity | undefined {
  let stats: WriterStats;
  try {
    stats = fs.lstatSync(path);
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? 'missing' : undefined;
  }
  if (!stats.isFile()) return undefined;
  return Object.freeze({
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  });
}

/**
 * Whether two identities name the same file in the same state.
 *
 * @param left - One identity.
 * @param right - The other.
 * @returns Whether they agree.
 * @example
 * ```ts
 * sameIdentity('missing', 'missing'); // true
 * ```
 */
export function sameIdentity(
  left: FileIdentity | undefined,
  right: FileIdentity | undefined,
): boolean {
  if (left === undefined || right === undefined) return false;
  if (left === 'missing' || right === 'missing') return left === right;
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

// The folder of the file: a folder of the user that group and others
// cannot write. It is opened without following a link and checked on the
// open descriptor.
const folderSafe = (
  fs: WriterFileSystem,
  folder: string,
  uid: number,
): WriteOutcome | undefined => {
  const { O_RDONLY, O_NOFOLLOW, O_DIRECTORY } = constants;
  let fd: number;
  try {
    fd = fs.openSync(folder, O_RDONLY | O_NOFOLLOW | O_DIRECTORY);
  } catch (error) {
    const code = errorCode(error);
    return code === 'ELOOP' || code === 'ENOTDIR' ? 'unsafe' : 'unavailable';
  }
  try {
    const stats = fs.fstatSync(fd);
    return stats.isDirectory() &&
      stats.uid === uid &&
      (stats.mode & 0o022) === 0
      ? undefined
      : 'unsafe';
  } catch {
    return 'unavailable';
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Nothing is left to close.
    }
  }
};

const flushFolder = (fs: WriterFileSystem, folder: string): void => {
  const { O_RDONLY, O_NOFOLLOW, O_DIRECTORY } = constants;
  const fd = fs.openSync(folder, O_RDONLY | O_NOFOLLOW | O_DIRECTORY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
};

/**
 * Writes the text of the file of the tokens whole, in the place of the
 * file that was read.
 *
 * @param path - The absolute path of the file, as the loader checked it.
 * @param text - The text, as `serializeBearerTokens` made it.
 * @param before - What the file was when the command read it.
 * @param fs - The file functions, only for tests.
 * @returns How the write ended. It never throws for a file.
 * @example
 * ```ts
 * writeTokensFile(path, serializeBearerTokens(entries), before);
 * ```
 */
export function writeTokensFile(
  path: string,
  text: string,
  before: FileIdentity,
  fs: WriterFileSystem = nodeWriterFileSystem,
): WriteOutcome {
  const uid = fs.getuid();
  if (uid === undefined) return 'unavailable';
  const folder = dirname(path);
  const unsafeFolder = folderSafe(fs, folder, uid);
  if (unsafeFolder !== undefined) return unsafeFolder;

  const temporary = join(
    folder,
    `.${basename(path)}.${String(fs.pid)}.${randomBytes(6).toString('hex')}.tmp`,
  );
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = constants;
  let fd: number;
  try {
    fd = fs.openSync(
      temporary,
      O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW,
      tokensFileMode,
    );
  } catch {
    return 'unavailable';
  }
  let renamed = false;
  try {
    try {
      const stats = fs.fstatSync(fd);
      if (!stats.isFile() || stats.uid !== uid) return 'unsafe';
      const bytes = new TextEncoder().encode(text);
      let offset = 0;
      while (offset < bytes.length) {
        const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
        if (written <= 0) return 'unavailable';
        offset += written;
      }
      fs.fsyncSync(fd);
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // The bytes are flushed or the write failed already.
      }
    }
    // The last look before the name: another command or a person may have
    // changed the file since this command read it.
    if (!sameIdentity(identityOf(path, fs), before)) return 'changed';
    try {
      fs.renameSync(temporary, path);
    } catch (error) {
      return errorCode(error) === 'EISDIR' ? 'unsafe' : 'unavailable';
    }
    renamed = true;
    flushFolder(fs, folder);
    return 'written';
  } catch {
    // Only the flush of the folder can fail here: the file has its name,
    // and only a crash of the machine could still lose it.
    return renamed ? 'written' : 'unavailable';
  } finally {
    if (!renamed) {
      try {
        fs.unlinkSync(temporary);
      } catch {
        // A temporary name left behind holds hashes only.
      }
    }
  }
}

/** How long a lock may stand before a command takes it over: one minute. */
export const staleLockMilliseconds = 60_000;

/** The lock of a command that changes the file, or why there is none. */
export type TokensLock =
  | { readonly ok: true; readonly release: () => void }
  | { readonly ok: false; readonly reason: 'busy' | 'unsafe' | 'unavailable' };

const lockPathOf = (path: string): string =>
  join(dirname(path), `.${basename(path)}.lock`);

/**
 * Takes the lock of the file of the tokens for one command that changes
 * it. The lock is an empty file beside it, made with `O_EXCL`, so that of
 * two commands only one gets it.
 *
 * @param path - The absolute path of the file of the tokens.
 * @param now - The current time in milliseconds, to tell a stale lock.
 * @param fs - The file functions, only for tests.
 * @returns The lock with its release, or why there is none: `busy` while
 *   another command holds it, `unsafe` when the folder is not safe.
 * @example
 * ```ts
 * const lock = lockTokensFile(path, Date.now());
 * if (lock.ok) try { change() } finally { lock.release() }
 * ```
 */
export function lockTokensFile(
  path: string,
  now: number,
  fs: WriterFileSystem = nodeWriterFileSystem,
): TokensLock {
  const uid = fs.getuid();
  if (uid === undefined) {
    return Object.freeze({ ok: false, reason: 'unavailable' });
  }
  const unsafeFolder = folderSafe(fs, dirname(path), uid);
  if (unsafeFolder !== undefined) {
    return Object.freeze({
      ok: false,
      reason: unsafeFolder === 'unsafe' ? 'unsafe' : 'unavailable',
    });
  }
  const lock = lockPathOf(path);
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = constants;
  const take = (): 'taken' | 'exists' | 'failed' => {
    try {
      fs.closeSync(
        fs.openSync(
          lock,
          O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW,
          tokensFileMode,
        ),
      );
      return 'taken';
    } catch (error) {
      return errorCode(error) === 'EEXIST' ? 'exists' : 'failed';
    }
  };
  let taken = take();
  if (taken === 'exists') {
    // A lock of a command that died stays; after a minute it is taken
    // over. Only a regular file counts as a lock.
    let stale: boolean;
    try {
      const stats = fs.lstatSync(lock);
      stale = stats.isFile() && now - stats.mtimeMs > staleLockMilliseconds;
    } catch {
      stale = false;
    }
    if (!stale) return Object.freeze({ ok: false, reason: 'busy' });
    try {
      fs.unlinkSync(lock);
    } catch {
      return Object.freeze({ ok: false, reason: 'busy' });
    }
    taken = take();
  }
  if (taken !== 'taken') {
    return Object.freeze({
      ok: false,
      reason: taken === 'exists' ? 'busy' : 'unavailable',
    });
  }
  let released = false;
  return Object.freeze({
    ok: true,
    release: (): void => {
      if (released) return;
      released = true;
      try {
        fs.unlinkSync(lock);
      } catch {
        // A lock left behind is taken over after a minute.
      }
    },
  });
}
