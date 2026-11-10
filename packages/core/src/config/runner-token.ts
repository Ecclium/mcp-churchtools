/**
 * Reads the login token of an account of the runner (ADR 0033): the file
 * `ct_token_<alias>` in the folder of `ECCLIUM_RUNNER_TOKENS_DIR`, one per
 * alias that the entries of the policy name as `credential`. The checks
 * are those of the token file of ChurchTools: opened without following a
 * link, a regular file of the user without rights for group and others,
 * visible ASCII only. The token stays a `Secret`, which only the outbound
 * path opens.
 *
 * Only the composition root of the runner reads it, for each run anew, so
 * that a new token takes effect with the next run and the server over
 * stdio never holds the token of an account of the runner.
 *
 * @packageDocumentation
 */
import { Secret } from '../http/index.js';
import { tenantIdPattern } from '../logger/index.js';
import { isNormalizedAbsolutePath } from './state-dir.js';
import {
  readTokenFile,
  type TokenFileResult,
  type TokenFileSystem,
} from './token-file.js';

/** The start of the name of the token file of an alias. */
export const runnerTokenPrefix = 'ct_token_';

/**
 * Reads the token file of an alias of the runner.
 *
 * @param dir - The folder from `ECCLIUM_RUNNER_TOKENS_DIR`, an absolute
 *   path in its unique form.
 * @param alias - The alias of the account, as the policy names it.
 * @param fs - The file functions, only for tests.
 * @returns The token as a `Secret`, or the code of the first check of the
 *   token file that failed, such as `token_file_missing`.
 * @throws {TypeError} When the folder is no absolute path in unique form
 *   or the alias has another form than the policy allows: the path is
 *   built from both, so neither may climb out of the folder.
 * @example
 * ```ts
 * const token = readRunnerToken(config.runnerTokensDir, 'berichte');
 * if (!token.ok) report(token.code);
 * ```
 */
export function readRunnerToken(
  dir: string,
  alias: string,
  fs?: TokenFileSystem,
): TokenFileResult<Secret> {
  if (typeof dir !== 'string' || !isNormalizedAbsolutePath(dir)) {
    throw new TypeError('The folder of the tokens must be an absolute path.');
  }
  // The same form as an alias of the policy: lower case letters, digits
  // and hyphens, so no part of a path.
  if (typeof alias !== 'string' || !tenantIdPattern.test(alias)) {
    throw new TypeError('The alias of an account has another form.');
  }
  return readTokenFile(
    `${dir}/${runnerTokenPrefix}${alias}`,
    (value) => new Secret(value),
    fs,
  );
}
