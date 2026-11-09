/**
 * Reads the key of a provider of a language model from its file (ADR
 * 0033), with the checks of the token file of ChurchTools: an absolute
 * path, opened without following a link, a regular file of the user
 * without rights for group and others, visible ASCII only. The key stays
 * a `Secret`, which only the outbound path opens.
 *
 * Only the composition root reads it, when it builds the transport of the
 * provider, so the server over stdio never holds the key of a model.
 *
 * @packageDocumentation
 */
import { Secret } from '../http/index.js';
import {
  readTokenFile,
  type TokenFileResult,
  type TokenFileSystem,
} from '../config/token-file.js';

/**
 * Reads the file of the key of a provider.
 *
 * @param path - The absolute path of the file, from the file of the
 *   providers.
 * @param fs - The file functions, only for tests.
 * @returns The key as a `Secret`, or the code of the first check of the
 *   token file that failed, such as `token_file_mode`.
 * @throws {TypeError} When the path is not a string.
 * @example
 * ```ts
 * const key = readProviderKey(provider.apiKeyFile);
 * if (!key.ok) report(key.code);
 * ```
 */
export function readProviderKey(
  path: string,
  fs?: TokenFileSystem,
): TokenFileResult<Secret> {
  return readTokenFile(path, (value) => new Secret(value), fs);
}
