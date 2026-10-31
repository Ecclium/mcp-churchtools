/**
 * Reads the secret for pseudonyms from a file (ADR 0069). The file gets the
 * same checks as the token file, by the same reader: absolute path, no
 * link, a regular file of the user without rights for the group or
 * others, no byte order mark, visible ASCII and one line ending at most.
 * Its content must then be a key of 64 hex digits in lower case, as
 * `openssl rand -hex 32` writes it. Every refusal keeps its reason under a
 * name of its own, so that a message can name the key file, not the token
 * file.
 *
 * @packageDocumentation
 */
import { KeyMaterial } from '../keys/index.js';
import {
  readTokenFile,
  type TokenFileCode,
  type TokenFileSystem,
} from './token-file.js';

// Each reason of the reader of the token file under the name it has for a
// key file. Written out, not built from the names, so that a new reason of
// the reader fails the type check here instead of passing unnamed. The
// codes come from a closed list, so no lookup reaches the prototype.
const fromTokenFile: Readonly<Record<TokenFileCode, PseudonymKeyFileCode>> =
  Object.freeze({
    token_file_relative: 'pseudonym_key_file_relative',
    token_file_platform: 'pseudonym_key_file_platform',
    token_file_missing: 'pseudonym_key_file_missing',
    token_file_symlink: 'pseudonym_key_file_symlink',
    token_file_unreadable: 'pseudonym_key_file_unreadable',
    token_file_not_regular: 'pseudonym_key_file_not_regular',
    token_file_owner: 'pseudonym_key_file_owner',
    token_file_mode: 'pseudonym_key_file_mode',
    token_file_too_large: 'pseudonym_key_file_too_large',
    token_file_empty: 'pseudonym_key_file_empty',
    token_file_bom: 'pseudonym_key_file_bom',
    token_file_characters: 'pseudonym_key_file_characters',
    token_file_unsafe: 'pseudonym_key_file_unsafe',
    token_invalid: 'pseudonym_key_invalid',
  });

/**
 * The reasons to refuse a key file, frozen, in the order of the reasons of
 * the token file. A code never carries the path or the content of the
 * file.
 */
export const pseudonymKeyFileCodes = Object.freeze([
  'pseudonym_key_file_relative',
  'pseudonym_key_file_platform',
  'pseudonym_key_file_missing',
  'pseudonym_key_file_symlink',
  'pseudonym_key_file_unreadable',
  'pseudonym_key_file_not_regular',
  'pseudonym_key_file_owner',
  'pseudonym_key_file_mode',
  'pseudonym_key_file_too_large',
  'pseudonym_key_file_empty',
  'pseudonym_key_file_bom',
  'pseudonym_key_file_characters',
  'pseudonym_key_file_unsafe',
  'pseudonym_key_invalid',
] as const);

/** The reason to refuse a key file. */
export type PseudonymKeyFileCode = (typeof pseudonymKeyFileCodes)[number];

/** The key, or the reason to refuse the file. */
export type PseudonymKeyFileResult =
  | { readonly ok: true; readonly value: KeyMaterial }
  | { readonly ok: false; readonly code: PseudonymKeyFileCode };

/**
 * Reads a key for pseudonyms from a file. The checks of the file are those
 * of the token file; the content must be 64 hex digits in lower case, not
 * all of one byte value, with one line ending at most.
 *
 * Folders above the file are trusted: no flag of open checks them.
 *
 * @param path - The absolute path of the file.
 * @param fs - The file functions, only for tests.
 * @returns The key, or the code of the first check that failed.
 * @throws {TypeError} When the path is not a string.
 * @example
 * ```ts
 * const key = readPseudonymKeyFile('/path/to/key-file');
 * if (!key.ok) report(key.code);
 * ```
 */
export function readPseudonymKeyFile(
  path: string,
  fs?: TokenFileSystem,
): PseudonymKeyFileResult {
  const read = readTokenFile(path, (value) => new KeyMaterial(value), fs);
  if (read.ok) {
    return Object.freeze({ __proto__: null, ok: true, value: read.value });
  }
  return Object.freeze({
    __proto__: null,
    ok: false,
    code: fromTokenFile[read.code],
  });
}
