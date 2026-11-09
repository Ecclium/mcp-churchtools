/**
 * Reads the file of the policy (ADR 0032).
 *
 * Where it stands: at the start, when the loader of the configuration
 * finds `ECCLIUM_POLICY_FILE`. The file is opened like the token file,
 * without following a link at the last part of the path, without blocking
 * on a FIFO and without becoming the controlling terminal, and every check
 * runs on the open descriptor. It must be a regular file of the user. It
 * is no secret and may be readable, but group and others must not write
 * it, because it decides which targets a write may reach. The read stops
 * after 256 KiB, the text must be UTF-8 without a byte order mark, and
 * then the reader of YAML and the check of `policy.v1` take over.
 *
 * Nothing here returns or throws the path, the message of the file system
 * or a value of the file: a refusal is a code, with the path of a field or
 * a line where the problem lies.
 *
 * @packageDocumentation
 */
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isProxy } from 'node:util/types';

import type { TokenFileSystem } from '../config/token-file.js';
import { checkPolicy, policyCheckCodes } from './check.js';
import type { Policy } from './schema.js';
import { readConfigYaml } from '../config/yaml.js';

/** The reasons to refuse the file itself, frozen. */
export const policyFileCodes = Object.freeze([
  'policy_file_relative',
  'policy_file_platform',
  'policy_file_missing',
  'policy_file_symlink',
  'policy_file_unreadable',
  'policy_file_not_regular',
  'policy_file_owner',
  'policy_file_mode',
  'policy_file_too_large',
  'policy_file_bom',
  'policy_file_encoding',
  'policy_file_unsafe',
] as const);

/**
 * Why the text of the file is no YAML the policy takes, frozen: the codes
 * of the reader of YAML, named for the policy.
 */
export const policyYamlCodes = Object.freeze([
  'policy_yaml_syntax',
  'policy_yaml_unsupported',
] as const);

/**
 * Every reason to refuse a policy, frozen: of the file, of its YAML and of
 * the check of `policy.v1`.
 */
export const policyCodes = Object.freeze([
  ...policyFileCodes,
  ...policyYamlCodes,
  ...policyCheckCodes,
] as const);

/** A reason to refuse a policy. */
export type PolicyCode = (typeof policyCodes)[number];

/** The file functions the reader uses; a test passes its own. */
export type PolicyFileSystem = TokenFileSystem;

/** The checked policy, or why the file holds none. */
export type PolicyFileResult =
  | { readonly ok: true; readonly policy: Policy }
  | {
      readonly ok: false;
      readonly code: PolicyCode;
      /** The path of a field, such as `interactive.targets[2].maxPerDay`. */
      readonly field?: string;
      /** The line of a problem of YAML, from 1. */
      readonly line?: number;
    };

/** The most bytes the file of the policy may hold: 256 KiB. */
export const maxPolicyFileBytes = 262_144;

const nodeFileSystem: PolicyFileSystem = Object.freeze({
  openSync,
  fstatSync,
  readSync,
  closeSync,
  getuid: () => process.getuid?.(),
  constants,
});

const refuse = (code: PolicyCode): PolicyFileResult =>
  Object.freeze({ __proto__: null, ok: false, code });

// The code of an error of open. Its own data property code is read, so that
// no getter runs, and the message, which holds the path, never leaves.
// EMLINK is how some systems refuse a link under O_NOFOLLOW.
const openCode = (error: unknown): PolicyCode => {
  if (typeof error !== 'object' || error === null || isProxy(error)) {
    return 'policy_file_unsafe';
  }
  switch (Object.getOwnPropertyDescriptor(error, 'code')?.value) {
    case 'ENOENT':
      return 'policy_file_missing';
    case 'ELOOP':
    case 'EMLINK':
      return 'policy_file_symlink';
    case 'EACCES':
    case 'EPERM':
      return 'policy_file_unreadable';
    default:
      return 'policy_file_unsafe';
  }
};

// The text of the open file, or the code of the first check that failed.
const textOf = (
  fs: PolicyFileSystem,
  fd: number,
  uid: number,
): { readonly text: string } | { readonly code: PolicyCode } => {
  const stats = fs.fstatSync(fd);
  if (!stats.isFile()) return { code: 'policy_file_not_regular' };
  if (stats.uid !== uid) return { code: 'policy_file_owner' };
  if ((stats.mode & 0o022) !== 0) return { code: 'policy_file_mode' };
  // Only a quick answer: the file can still grow, so the read below keeps
  // its own bound.
  if (stats.size > maxPolicyFileBytes) return { code: 'policy_file_too_large' };

  const buffer = new Uint8Array(maxPolicyFileBytes + 1);
  let length = 0;
  while (length < buffer.length) {
    const free = buffer.length - length;
    const read = fs.readSync(fd, buffer, length, free, null);
    if (!Number.isInteger(read) || read < 0 || read > free) {
      return { code: 'policy_file_unsafe' };
    }
    if (read === 0) break;
    length += read;
  }
  if (length > maxPolicyFileBytes) return { code: 'policy_file_too_large' };
  const [first, second, third] = buffer;
  if (
    (first === 0xef && second === 0xbb && third === 0xbf) ||
    (first === 0xff && second === 0xfe) ||
    (first === 0xfe && second === 0xff)
  ) {
    return { code: 'policy_file_bom' };
  }
  try {
    return {
      text: new TextDecoder('utf-8', { fatal: true }).decode(
        buffer.subarray(0, length),
      ),
    };
  } catch {
    return { code: 'policy_file_encoding' };
  }
};

/**
 * Reads, parses and checks the file of the policy. The path must be
 * absolute. Folders above the file are trusted: no flag of open checks
 * them.
 *
 * @param path - The absolute path of the file.
 * @param fs - The file functions, only for tests.
 * @returns The checked policy, or the code of the first check that failed
 *   with the path of the field or the line. It never throws for a file.
 * @throws {TypeError} When the path is not a string.
 * @example
 * ```ts
 * const read = readPolicyFile('/path/to/policy.yaml');
 * if (!read.ok) report(read.code, read.field, read.line);
 * ```
 */
export function readPolicyFile(
  path: string,
  fs: PolicyFileSystem = nodeFileSystem,
): PolicyFileResult {
  if (typeof path !== 'string') {
    throw new TypeError('The path of the policy file must be a string.');
  }
  if (!isAbsolute(path)) return refuse('policy_file_relative');
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
    return refuse('policy_file_platform');
  }

  let fd: number;
  try {
    fd = fs.openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY);
  } catch (error) {
    return refuse(openCode(error));
  }
  let read: ReturnType<typeof textOf>;
  try {
    read = textOf(fs, fd, uid);
  } catch {
    read = { code: 'policy_file_unsafe' };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // The file is read or refused already; a failed close changes
      // neither.
    }
  }
  if ('code' in read) return refuse(read.code);

  const yaml = readConfigYaml(read.text);
  if (!yaml.ok) {
    return Object.freeze({
      __proto__: null,
      ok: false,
      code: `policy_${yaml.code}` as const,
      ...(yaml.line === undefined ? {} : { line: yaml.line }),
    });
  }
  return checkPolicy(yaml.value);
}
