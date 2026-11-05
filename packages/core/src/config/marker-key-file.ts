/**
 * Reads the secret behind the check codes of the marking from a file
 * (ADR 0032). The file gets the same checks as the token file and the key
 * file of the pseudonyms, by the same reader, and its content must be a key
 * of 64 hex digits in lower case, as `openssl rand -hex 32` writes it.
 * Every refusal keeps its reason under a name of its own, so that a message
 * names this file, not the token file or the key of the pseudonyms.
 *
 * Unlike the day keys, this key is backed up and never destroyed: a new one
 * makes every check code written so far invalid.
 *
 * @packageDocumentation
 */
import { KeyMaterial } from '../keys/index.js';
import {
  readTokenFile,
  type TokenFileCode,
  type TokenFileSystem,
} from './token-file.js';

// Each reason of the reader of the token file under the name it has for
// this key file. Written out, not built from the names, so that a new
// reason of the reader fails the type check here instead of passing
// unnamed. The codes come from a closed list, so no lookup reaches the
// prototype.
const fromTokenFile: Readonly<Record<TokenFileCode, MarkerKeyFileCode>> =
  Object.freeze({
    token_file_relative: 'marker_key_file_relative',
    token_file_platform: 'marker_key_file_platform',
    token_file_missing: 'marker_key_file_missing',
    token_file_symlink: 'marker_key_file_symlink',
    token_file_unreadable: 'marker_key_file_unreadable',
    token_file_not_regular: 'marker_key_file_not_regular',
    token_file_owner: 'marker_key_file_owner',
    token_file_mode: 'marker_key_file_mode',
    token_file_too_large: 'marker_key_file_too_large',
    token_file_empty: 'marker_key_file_empty',
    token_file_bom: 'marker_key_file_bom',
    token_file_characters: 'marker_key_file_characters',
    token_file_unsafe: 'marker_key_file_unsafe',
    token_invalid: 'marker_key_invalid',
  });

/**
 * The reasons to refuse the key file of the check codes, frozen, in the
 * order of the reasons of the token file. A code never carries the path or
 * the content of the file.
 */
export const markerKeyFileCodes = Object.freeze([
  'marker_key_file_relative',
  'marker_key_file_platform',
  'marker_key_file_missing',
  'marker_key_file_symlink',
  'marker_key_file_unreadable',
  'marker_key_file_not_regular',
  'marker_key_file_owner',
  'marker_key_file_mode',
  'marker_key_file_too_large',
  'marker_key_file_empty',
  'marker_key_file_bom',
  'marker_key_file_characters',
  'marker_key_file_unsafe',
  'marker_key_invalid',
] as const);

/** The reason to refuse the key file of the check codes. */
export type MarkerKeyFileCode = (typeof markerKeyFileCodes)[number];

/** The key, or the reason to refuse the file. */
export type MarkerKeyFileResult =
  | { readonly ok: true; readonly value: KeyMaterial }
  | { readonly ok: false; readonly code: MarkerKeyFileCode };

/**
 * Reads the key of the check codes from a file. The checks of the file are
 * those of the token file; the content must be 64 hex digits in lower case,
 * not all of one byte value, with one line ending at most.
 *
 * Folders above the file are trusted: no flag of open checks them.
 *
 * @param path - The absolute path of the file.
 * @param fs - The file functions, only for tests.
 * @returns The key, or the code of the first check that failed.
 * @throws {TypeError} When the path is not a string.
 * @example
 * ```ts
 * const key = readMarkerKeyFile('/path/to/marker-key');
 * if (!key.ok) report(key.code);
 * ```
 */
export function readMarkerKeyFile(
  path: string,
  fs?: TokenFileSystem,
): MarkerKeyFileResult {
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
