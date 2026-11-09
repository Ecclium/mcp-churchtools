/**
 * Reads the file of the policy (ADR 0032).
 *
 * Where it stands: at the start, when the loader of the configuration
 * finds `ECCLIUM_POLICY_FILE`. The reader of the files of the
 * configuration opens the file like the token file, without following a
 * link at the last part of the path, without blocking on a FIFO and
 * without becoming the controlling terminal, and checks it on the open
 * descriptor. It must be a regular file of the user. It is no secret and
 * may be readable, but group and others must not write it, because it
 * decides which targets a write may reach. The read stops after 256 KiB,
 * the text must be UTF-8 without a byte order mark, and then the reader
 * of YAML and the check of `policy.v1` take over.
 *
 * Nothing here returns or throws the path, the message of the file system
 * or a value of the file: a refusal is a code, with the path of a field or
 * a line where the problem lies.
 *
 * @packageDocumentation
 */
import {
  type ConfigFileSystem,
  readConfigTextFile,
} from '../config/text-file.js';
import { readConfigYaml } from '../config/yaml.js';
import { checkPolicy, policyCheckCodes } from './check.js';
import type { Policy } from './schema.js';

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
export type PolicyFileSystem = ConfigFileSystem;

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
  fs?: PolicyFileSystem,
): PolicyFileResult {
  if (typeof path !== 'string') {
    throw new TypeError('The path of the policy file must be a string.');
  }
  const read = readConfigTextFile(path, maxPolicyFileBytes, fs);
  if (!read.ok) {
    return Object.freeze({
      __proto__: null,
      ok: false,
      code: `policy_file_${read.reason}` as const,
    });
  }

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
