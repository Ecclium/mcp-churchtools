/**
 * Checks the folder of state that `ECCLIUM_STATE_DIR` names (ADR 0028,
 * ADR 0055). The loader only looks: it creates nothing and opens nothing,
 * so that `ecclium config check` changes nothing on disk. The start creates
 * the folder `audit` and opens the audit file, and checks both again.
 *
 * Its only runtime imports are built-in modules, so a test can run it from
 * source in a child process.
 *
 * @packageDocumentation
 */
import { constants, lstatSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';
import { isProxy } from 'node:util/types';

/**
 * The reasons to refuse a folder of state, frozen. A code never carries the
 * path.
 */
export const stateDirCodes = Object.freeze([
  'state_dir_platform',
  'state_dir_relative',
  'state_dir_not_normalized',
  'state_dir_too_long',
  'state_dir_missing',
  'state_dir_symlink',
  'state_dir_not_directory',
  'state_dir_owner',
  'state_dir_mode',
  'state_dir_unsafe',
  'audit_dir_symlink',
  'audit_dir_not_directory',
  'audit_dir_owner',
  'audit_dir_mode',
  'audit_dir_unsafe',
] as const);

/** The reason to refuse a folder of state. */
export type StateDirCode = (typeof stateDirCodes)[number];

/** The name of the folder for the audit files inside the folder of state. */
export const auditDirName = 'audit';

/** What the check learns about a path, without following a link. */
export interface StateDirStats {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  readonly uid: number;
  readonly mode: number;
}

/**
 * The file functions the check uses. A test passes its own for what it
 * cannot build on disk, such as a folder of another owner.
 */
export interface StateDirFileSystem {
  readonly lstatSync: (path: string) => StateDirStats;
  /** The ID of the user, or undefined on a platform without one. */
  readonly getuid: () => number | undefined;
  /**
   * The flags the audit file needs. Without one of them the start could
   * not open the file safely, so the check refuses the platform up front.
   */
  readonly constants: {
    readonly O_NOFOLLOW?: number | undefined;
    readonly O_DIRECTORY?: number | undefined;
    readonly O_NOCTTY?: number | undefined;
  };
}

/** Whether the folder passed, or the reason it did not. */
export type StateDirResult =
  { readonly ok: true } | { readonly ok: false; readonly code: StateDirCode };

/**
 * The longest path of the folder, in characters and in bytes of UTF-8:
 * with `/audit/` and the name of an audit file it stays below PATH_MAX of
 * macOS, 1024 bytes.
 */
export const maxStateDirLength = 960;

const encoder = new TextEncoder();

const nodeFileSystem: StateDirFileSystem = Object.freeze({
  lstatSync,
  getuid: () => process.getuid?.(),
  constants,
});

const passed: StateDirResult = Object.freeze({ __proto__: null, ok: true });

const refuse = (code: StateDirCode): StateDirResult =>
  Object.freeze({ __proto__: null, ok: false, code });

/**
 * Tells whether a value is an absolute path in its one written form: no
 * separator at the end, no `.` or `..` and no `//`. The check compares
 * instead of normalising, so that the folder it checks is the one the
 * operator wrote. With a separator at the end, `lstat` follows a link.
 *
 * @param value - The value as given.
 * @returns Whether it is such a path.
 * @example
 * ```ts
 * isNormalizedAbsolutePath('/srv/ecclium'); // true
 * isNormalizedAbsolutePath('/srv/ecclium/'); // false
 * ```
 */
export function isNormalizedAbsolutePath(value: string): boolean {
  return (
    typeof value === 'string' &&
    isAbsolute(value) &&
    normalize(value) === value &&
    !(value.length > 1 && value.endsWith('/'))
  );
}

// The code of a failed system call, read as an own data property, so that
// no getter runs and the message, which holds the path, never leaves.
const errorCode = (error: unknown): unknown => {
  if (typeof error !== 'object' || error === null || isProxy(error)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(error, 'code')?.value;
};

interface Checks {
  readonly symlink: StateDirCode;
  readonly notDirectory: StateDirCode;
  readonly owner: StateDirCode;
  readonly mode: StateDirCode;
}

const stateDirChecks: Checks = Object.freeze({
  symlink: 'state_dir_symlink',
  notDirectory: 'state_dir_not_directory',
  owner: 'state_dir_owner',
  mode: 'state_dir_mode',
});

const auditDirChecks: Checks = Object.freeze({
  symlink: 'audit_dir_symlink',
  notDirectory: 'audit_dir_not_directory',
  owner: 'audit_dir_owner',
  mode: 'audit_dir_mode',
});

// A folder of the user without rights for the group or others, never
// reached through a link at its last part.
const checkFolder = (
  stats: StateDirStats,
  uid: number,
  checks: Checks,
): StateDirCode | undefined => {
  if (stats.isSymbolicLink()) return checks.symlink;
  if (!stats.isDirectory()) return checks.notDirectory;
  if (stats.uid !== uid) return checks.owner;
  if ((stats.mode & 0o077) !== 0) return checks.mode;
  return undefined;
};

/**
 * Checks the folder of state and, if there is one, its folder `audit`.
 * The path must be absolute and normalised. The folder must be a folder of
 * the user, not a link, without rights for the group or others. A missing
 * folder `audit` is fine, the start creates it; one that is there must
 * pass the same checks. Without the ID of the user or the flags the audit
 * file needs, as on Windows, the platform is refused first. A path of more
 * than {@link maxStateDirLength} bytes in UTF-8 is refused as too long.
 *
 * Folders above the folder of state are trusted: `lstat` follows links
 * there.
 *
 * @param path - The value of `ECCLIUM_STATE_DIR`.
 * @param fs - The file functions, only for tests.
 * @returns Whether the folder passed, or the code of the first check that
 *   failed.
 * @throws {TypeError} When the path is not a string.
 * @example
 * ```ts
 * const checked = checkStateDir('/srv/ecclium');
 * if (!checked.ok) report(checked.code);
 * ```
 */
export function checkStateDir(
  path: string,
  fs: StateDirFileSystem = nodeFileSystem,
): StateDirResult {
  if (typeof path !== 'string') {
    throw new TypeError('The path of the folder of state must be a string.');
  }
  // Without these flags or the ID of the user, the start could not open
  // the audit file safely. First, so that Windows gets this code and not
  // one about the form of a path it writes differently.
  const { O_NOFOLLOW, O_DIRECTORY, O_NOCTTY } = fs.constants;
  const uid = fs.getuid();
  if (
    O_NOFOLLOW === undefined ||
    O_DIRECTORY === undefined ||
    O_NOCTTY === undefined ||
    uid === undefined
  ) {
    return refuse('state_dir_platform');
  }
  if (!isAbsolute(path)) return refuse('state_dir_relative');
  if (!isNormalizedAbsolutePath(path)) {
    return refuse('state_dir_not_normalized');
  }
  // The loader bounds the characters; a character outside ASCII takes more
  // than one byte in a path.
  if (encoder.encode(path).length > maxStateDirLength) {
    return refuse('state_dir_too_long');
  }

  let folder: StateDirStats;
  try {
    folder = fs.lstatSync(path);
  } catch (error) {
    return refuse(
      errorCode(error) === 'ENOENT' ? 'state_dir_missing' : 'state_dir_unsafe',
    );
  }
  try {
    const code = checkFolder(folder, uid, stateDirChecks);
    if (code !== undefined) return refuse(code);
  } catch {
    return refuse('state_dir_unsafe');
  }

  let audit: StateDirStats;
  try {
    audit = fs.lstatSync(`${path === '/' ? '' : path}/${auditDirName}`);
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? passed : refuse('audit_dir_unsafe');
  }
  try {
    const code = checkFolder(audit, uid, auditDirChecks);
    return code === undefined ? passed : refuse(code);
  } catch {
    return refuse('audit_dir_unsafe');
  }
}
