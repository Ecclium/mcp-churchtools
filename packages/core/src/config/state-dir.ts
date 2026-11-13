/**
 * Checks the folder of state that `ECCLIUM_STATE_DIR` names (ADR 0028,
 * ADR 0055), and the folder of the day keys that `ECCLIUM_KEYS_DIR` names
 * (ADR 0031), with the same rules and codes of their own, and the folder
 * of the token files of the runner that `ECCLIUM_RUNNER_TOKENS_DIR` names
 * (ADR 0033), in which only the user may write. The loader only
 * looks: it creates nothing and opens nothing, so that `ecclium config
 * check` changes nothing on disk. The start creates the folders `audit`
 * and `snapshot` and opens the audit file, and checks them again.
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
  'quota_dir_symlink',
  'quota_dir_not_directory',
  'quota_dir_owner',
  'quota_dir_mode',
  'quota_dir_unsafe',
] as const);

/** The reason to refuse a folder of state. */
export type StateDirCode = (typeof stateDirCodes)[number];

/**
 * The reasons to refuse a folder of keys, frozen (ADR 0031). A code never
 * carries the path.
 */
export const keysDirCodes = Object.freeze([
  'keys_dir_platform',
  'keys_dir_relative',
  'keys_dir_not_normalized',
  'keys_dir_too_long',
  'keys_dir_missing',
  'keys_dir_symlink',
  'keys_dir_not_directory',
  'keys_dir_owner',
  'keys_dir_mode',
  'keys_dir_unsafe',
  'snapshot_keys_dir_symlink',
  'snapshot_keys_dir_not_directory',
  'snapshot_keys_dir_owner',
  'snapshot_keys_dir_mode',
  'snapshot_keys_dir_unsafe',
  'queue_keys_dir_symlink',
  'queue_keys_dir_not_directory',
  'queue_keys_dir_owner',
  'queue_keys_dir_mode',
  'queue_keys_dir_unsafe',
] as const);

/** The reason to refuse a folder of keys. */
export type KeysDirCode = (typeof keysDirCodes)[number];

/**
 * The reasons to refuse the folder of the token files of the runner,
 * frozen (ADR 0033). A path that is not absolute or not in its one form
 * has the code `runner_tokens_dir_invalid` of the loader. A code never
 * carries the path.
 */
export const runnerTokensDirCodes = Object.freeze([
  'runner_tokens_dir_platform',
  'runner_tokens_dir_too_long',
  'runner_tokens_dir_missing',
  'runner_tokens_dir_symlink',
  'runner_tokens_dir_not_directory',
  'runner_tokens_dir_owner',
  'runner_tokens_dir_mode',
  'runner_tokens_dir_unsafe',
] as const);

/**
 * The reason to refuse the folder of the token files of the runner, with
 * the code of the loader for a path in another form.
 */
export type RunnerTokensDirCode =
  (typeof runnerTokensDirCodes)[number] | 'runner_tokens_dir_invalid';

/**
 * The folders that Ecclium keeps inside the folder of state, frozen, by
 * purpose: the audit files (ADR 0028), the counters of the read budget, the
 * limits of a day and the memory of runs (ADR 0063), the snapshots and the
 * queue (ADR 0031), the locks of the routines (ADR 0034) and, over stdio
 * without `ECCLIUM_KILL_SWITCH_DIR`, the kill switches (ADR 0029). They are
 * named once here, so that the loader, the stores and the runner container
 * contract (ADR 0036) name the same.
 */
export const stateFolders = Object.freeze({
  audit: 'audit',
  quota: 'quota',
  snapshots: 'snapshots',
  queue: 'queue',
  runner: 'runner',
  stop: 'stop',
} as const);

/** The name of the folder for the audit files inside the folder of state. */
export const auditDirName = stateFolders.audit;

/**
 * The name of the folder for the counters of the read budget inside the
 * folder of state (ADR 0063).
 */
export const quotaDirName = stateFolders.quota;

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

/** Whether the folder of keys passed, or the reason it did not. */
export type KeysDirResult =
  { readonly ok: true } | { readonly ok: false; readonly code: KeysDirCode };

/** Whether the folder of the token files passed, or the reason it did not. */
export type RunnerTokensDirResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: RunnerTokensDirCode };

/**
 * The longest path of the folder, in characters and in bytes of UTF-8:
 * with `/audit/` and the name of an audit file it stays below PATH_MAX of
 * macOS, 1024 bytes.
 */
export const maxStateDirLength = 960;

/**
 * The longest path of the folder of keys, in characters and in bytes of
 * UTF-8 (ADR 0031). The longest name in it is the temporary name of a day
 * key that is being written: `/snapshot/`, a dot, a tenant of 63
 * characters, the day, `.key`, a process ID of 10 digits and 16 hex
 * digits, 121 bytes in all. With them the path stays below PATH_MAX of
 * macOS, 1024 bytes, which the bound of the folder of state would not
 * leave room for.
 */
export const maxKeysDirLength = 896;

/**
 * The longest path of the folder of the token files of the runner, in
 * characters and in bytes of UTF-8 (ADR 0033). The name of a file in it is
 * `/ct_token_` and an alias of up to 63 characters, so the path of a file
 * stays below PATH_MAX of macOS, 1024 bytes, as for the folder of keys.
 */
export const maxRunnerTokensDirLength = 896;

const encoder = new TextEncoder();

const nodeFileSystem: StateDirFileSystem = Object.freeze({
  lstatSync,
  getuid: () => process.getuid?.(),
  constants,
});

const passed = Object.freeze({ __proto__: null, ok: true as const });

const refuse = <Code extends string>(code: Code) =>
  Object.freeze({ __proto__: null, ok: false as const, code });

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

interface Checks<Code extends string> {
  readonly symlink: Code;
  readonly notDirectory: Code;
  readonly owner: Code;
  readonly mode: Code;
}

// A folder inside the folder that is checked, with its own codes.
interface Inside<Code extends string> {
  readonly name: string;
  readonly checks: Checks<Code>;
  readonly unsafe: Code;
}

// What a kind of folder is refused with: the folder of state or the folder
// of keys. Both get the same checks, so that neither is weaker.
interface Kind<Code extends string> {
  readonly notString: string;
  readonly platform: Code;
  readonly relative: Code;
  readonly notNormalized: Code;
  readonly tooLong: Code;
  readonly maxLength: number;
  readonly missing: Code;
  readonly unsafe: Code;
  /** The bits of the mode the group and others must not have. */
  readonly forbidden: number;
  readonly checks: Checks<Code>;
  readonly inside: readonly Inside<Code>[];
}

const stateDirKind: Kind<StateDirCode> = Object.freeze({
  notString: 'The path of the folder of state must be a string.',
  platform: 'state_dir_platform',
  relative: 'state_dir_relative',
  notNormalized: 'state_dir_not_normalized',
  tooLong: 'state_dir_too_long',
  maxLength: maxStateDirLength,
  missing: 'state_dir_missing',
  unsafe: 'state_dir_unsafe',
  // No right at all for the group or others: the folder holds the audit.
  forbidden: 0o077,
  checks: Object.freeze({
    symlink: 'state_dir_symlink',
    notDirectory: 'state_dir_not_directory',
    owner: 'state_dir_owner',
    mode: 'state_dir_mode',
  }),
  inside: Object.freeze([
    Object.freeze({
      name: auditDirName,
      checks: Object.freeze({
        symlink: 'audit_dir_symlink',
        notDirectory: 'audit_dir_not_directory',
        owner: 'audit_dir_owner',
        mode: 'audit_dir_mode',
      }),
      unsafe: 'audit_dir_unsafe',
    }),
    Object.freeze({
      name: quotaDirName,
      checks: Object.freeze({
        symlink: 'quota_dir_symlink',
        notDirectory: 'quota_dir_not_directory',
        owner: 'quota_dir_owner',
        mode: 'quota_dir_mode',
      }),
      unsafe: 'quota_dir_unsafe',
    }),
  ] as const),
});

const keysDirKind: Kind<KeysDirCode> = Object.freeze({
  notString: 'The path of the folder of keys must be a string.',
  platform: 'keys_dir_platform',
  relative: 'keys_dir_relative',
  notNormalized: 'keys_dir_not_normalized',
  tooLong: 'keys_dir_too_long',
  maxLength: maxKeysDirLength,
  missing: 'keys_dir_missing',
  unsafe: 'keys_dir_unsafe',
  forbidden: 0o077,
  checks: Object.freeze({
    symlink: 'keys_dir_symlink',
    notDirectory: 'keys_dir_not_directory',
    owner: 'keys_dir_owner',
    mode: 'keys_dir_mode',
  }),
  inside: Object.freeze([
    Object.freeze({
      name: 'snapshot',
      checks: Object.freeze({
        symlink: 'snapshot_keys_dir_symlink',
        notDirectory: 'snapshot_keys_dir_not_directory',
        owner: 'snapshot_keys_dir_owner',
        mode: 'snapshot_keys_dir_mode',
      }),
      unsafe: 'snapshot_keys_dir_unsafe',
    }),
    Object.freeze({
      name: 'queue',
      checks: Object.freeze({
        symlink: 'queue_keys_dir_symlink',
        notDirectory: 'queue_keys_dir_not_directory',
        owner: 'queue_keys_dir_owner',
        mode: 'queue_keys_dir_mode',
      }),
      unsafe: 'queue_keys_dir_unsafe',
    }),
  ] as const),
});

// The folder of the token files of the runner. Each file in it has the
// checks of the token file, no right for the group or others. The folder
// itself may be read and searched by them, as a folder of secrets that a
// container mounts often is, but nobody else may write in it: whoever can,
// could put the file of a wider account in place of a narrow one.
const runnerTokensDirKind: Kind<RunnerTokensDirCode> = Object.freeze({
  notString: 'The path of the folder of the tokens must be a string.',
  platform: 'runner_tokens_dir_platform',
  relative: 'runner_tokens_dir_invalid',
  notNormalized: 'runner_tokens_dir_invalid',
  tooLong: 'runner_tokens_dir_too_long',
  maxLength: maxRunnerTokensDirLength,
  missing: 'runner_tokens_dir_missing',
  unsafe: 'runner_tokens_dir_unsafe',
  forbidden: 0o022,
  checks: Object.freeze({
    symlink: 'runner_tokens_dir_symlink',
    notDirectory: 'runner_tokens_dir_not_directory',
    owner: 'runner_tokens_dir_owner',
    mode: 'runner_tokens_dir_mode',
  }),
  inside: Object.freeze([]),
});

// A folder of the user without the forbidden rights for the group or
// others, never reached through a link at its last part.
const checkFolder = <Code extends string>(
  stats: StateDirStats,
  uid: number,
  checks: Checks<Code>,
  forbidden: number,
): Code | undefined => {
  if (stats.isSymbolicLink()) return checks.symlink;
  if (!stats.isDirectory()) return checks.notDirectory;
  if (stats.uid !== uid) return checks.owner;
  if ((stats.mode & forbidden) !== 0) return checks.mode;
  return undefined;
};

// The checks of both kinds of folder, with the codes of the kind.
const checkDir = <Code extends string>(
  path: string,
  fs: StateDirFileSystem,
  kind: Kind<Code>,
): { readonly ok: true } | { readonly ok: false; readonly code: Code } => {
  if (typeof path !== 'string') throw new TypeError(kind.notString);
  // Without these flags or the ID of the user, the start could not open
  // the files in the folder safely. First, so that Windows gets this code
  // and not one about the form of a path it writes differently.
  const { O_NOFOLLOW, O_DIRECTORY, O_NOCTTY } = fs.constants;
  const uid = fs.getuid();
  if (
    O_NOFOLLOW === undefined ||
    O_DIRECTORY === undefined ||
    O_NOCTTY === undefined ||
    uid === undefined
  ) {
    return refuse(kind.platform);
  }
  if (!isAbsolute(path)) return refuse(kind.relative);
  if (!isNormalizedAbsolutePath(path)) return refuse(kind.notNormalized);
  // The loader bounds the characters; a character outside ASCII takes more
  // than one byte in a path.
  if (encoder.encode(path).length > kind.maxLength) {
    return refuse(kind.tooLong);
  }

  let folder: StateDirStats;
  try {
    folder = fs.lstatSync(path);
  } catch (error) {
    return refuse(errorCode(error) === 'ENOENT' ? kind.missing : kind.unsafe);
  }
  try {
    const code = checkFolder(folder, uid, kind.checks, kind.forbidden);
    if (code !== undefined) return refuse(code);
  } catch {
    return refuse(kind.unsafe);
  }

  // A folder inside, if it is there: the same checks, with its own codes.
  for (const { name, checks, unsafe } of kind.inside) {
    let inside: StateDirStats;
    try {
      inside = fs.lstatSync(`${path === '/' ? '' : path}/${name}`);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue;
      return refuse(unsafe);
    }
    try {
      const code = checkFolder(inside, uid, checks, kind.forbidden);
      if (code !== undefined) return refuse(code);
    } catch {
      return refuse(unsafe);
    }
  }
  return passed;
};

/**
 * Checks the folder of state and, if they exist, its folders `audit` and
 * `quota`. The path must be absolute and normalised. The folder must be a
 * folder of the user, not a link, without rights for the group or others.
 * A missing folder `audit` or `quota` is fine, the start creates it; one
 * that is there must pass the same checks. Without the ID of the user or
 * the flags the audit file needs, as on Windows, the platform is refused
 * first. A path of more
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
  return checkDir(path, fs, stateDirKind);
}

/**
 * The longest path of the folder of the kill switches, in characters and
 * in bytes of UTF-8 (ADR 0029). The longest name in it is the kill switch
 * of a routine, `writes-off-routine-` and an ID of up to 63 characters, so
 * the path of a switch stays below PATH_MAX of macOS, 1024 bytes, as for
 * the folder of the token files.
 */
export const maxKillSwitchDirLength = 896;

/**
 * What the start finds at the folder of the kill switches: a folder it can
 * use, one that is missing or that the core could not check, or one in
 * which the group or others may write.
 */
export type KillSwitchDirState = 'ready' | 'missing' | 'writable';

/**
 * Checks the folder of the kill switches (ADR 0029): a real folder, not a
 * link, in which neither the group nor others may write, and in which the
 * core can look for a switch. The core looks into it before each plan and
 * right before each write, and a folder it cannot check stops writing.
 * With writing switched on, the loader checks it at the start already, so
 * that a server that could never write does not offer its write tools, and
 * the runner checks it for a routine with a draft.
 *
 * Its owner is not checked: the operator makes a switch on the host
 * without root, also in a folder that a container mounts read-only
 * (ADR 0036). Whoever may write in the folder, though, could take
 * a switch away again, so the group and others may not.
 *
 * Folders above it are trusted: `lstat` follows links there.
 *
 * @param dir - The folder of the switches, an absolute normalised path.
 * @param fs - The file functions, only for tests.
 * @returns `ready`, `missing` or `writable`.
 * @example
 * ```ts
 * if (checkKillSwitchDir('/config/stop') !== 'ready') report('writes_without_stop_dir');
 * ```
 */
export function checkKillSwitchDir(
  dir: string,
  fs: StateDirFileSystem = nodeFileSystem,
): KillSwitchDirState {
  try {
    const stats = fs.lstatSync(dir);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return 'missing';
    if ((stats.mode & 0o022) !== 0) return 'writable';
  } catch {
    return 'missing';
  }
  // The switch in it must be checkable as well, as the core checks it
  // before each write: a folder it cannot search stops every write.
  try {
    fs.lstatSync(`${dir === '/' ? '' : dir}/writes-off`);
    return 'ready';
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? 'ready' : 'missing';
  }
}

/**
 * Checks the folder of keys and, if they exist, its folders `snapshot` and
 * `queue` (ADR 0031), with the same rules as the folder of state and codes
 * of their own: absolute and normalised, a folder of the user, not a link,
 * without rights for the group or others, and at most
 * {@link maxKeysDirLength} bytes in UTF-8. A missing folder of a purpose is
 * fine, the start or the first day key creates it. Whether the folder lies
 * in the folder of state is a rule of the loader, which knows both.
 *
 * Folders above the folder of keys are trusted: `lstat` follows links
 * there.
 *
 * @param path - The value of `ECCLIUM_KEYS_DIR`.
 * @param fs - The file functions, only for tests.
 * @returns Whether the folder passed, or the code of the first check that
 *   failed.
 * @throws {TypeError} When the path is not a string.
 * @example
 * ```ts
 * const checked = checkKeysDir('/srv/ecclium-keys');
 * if (!checked.ok) report(checked.code);
 * ```
 */
export function checkKeysDir(
  path: string,
  fs: StateDirFileSystem = nodeFileSystem,
): KeysDirResult {
  return checkDir(path, fs, keysDirKind);
}

/**
 * Checks the folder of the token files of the runner that
 * `ECCLIUM_RUNNER_TOKENS_DIR` names (ADR 0033): absolute and normalised, a
 * folder of the user, not a link, in which neither the group nor others
 * may write, and at most {@link maxRunnerTokensDirLength} bytes in UTF-8.
 * Unlike the folders of state and of keys, the group and others may read
 * and search it: each file in it is checked on its own, with no right for
 * them. Without the ID of the user or the flags of the token file, as on
 * Windows, the platform is refused first. The check only looks and opens
 * no file.
 *
 * Folders above it are trusted: `lstat` follows links there.
 *
 * @param path - The value of `ECCLIUM_RUNNER_TOKENS_DIR`.
 * @param fs - The file functions, only for tests.
 * @returns Whether the folder passed, or the code of the first check that
 *   failed.
 * @throws {TypeError} When the path is not a string.
 * @example
 * ```ts
 * const checked = checkRunnerTokensDir('/run/secrets');
 * if (!checked.ok) report(checked.code);
 * ```
 */
export function checkRunnerTokensDir(
  path: string,
  fs: StateDirFileSystem = nodeFileSystem,
): RunnerTokensDirResult {
  return checkDir(path, fs, runnerTokensDirKind);
}
