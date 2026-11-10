/**
 * Reads the login token of an account of the runner (ADR 0033): the file
 * `ct_token_<alias>` in the folder of `ECCLIUM_RUNNER_TOKENS_DIR`, one per
 * alias that the entries of the policy name as `credential`. The checks
 * are those of the token file of ChurchTools: opened without following a
 * link, a regular file of the user without rights for group and others,
 * visible ASCII only. The token stays a `Secret`, which only the outbound
 * path opens.
 *
 * The loader of the runner reads the file of its own account,
 * `ct_token_runner`, and checks the file of every other alias at its
 * start (ADR 0023). The composition root reads a file for each run anew
 * and for the approval of an entry of a run, so that a new token takes
 * effect with the next run and the server over stdio never holds the
 * token of an account of the runner.
 *
 * @packageDocumentation
 */
import { Secret } from '../http/index.js';
import { tenantIdPattern } from '../logger/index.js';
import { isNormalizedAbsolutePath } from './state-dir.js';
import {
  readTokenFile,
  type TokenFileCode,
  tokenFileCodes,
  type TokenFileResult,
  type TokenFileSystem,
} from './token-file.js';

/** The start of the name of the token file of an alias. */
export const runnerTokenPrefix = 'ct_token_';

/**
 * The alias of the account of the runner itself (ADR 0023, ADR 0033): a
 * routine without an entry in the policy reads with the file
 * `ct_token_runner`, never with the token of the server. A policy may
 * name the same alias; then it is the same account.
 */
export const runnerOwnAlias = 'runner';

// A token file in the folder of the tokens is never relative, and on a
// platform without the checks of a token file the loader refuses the
// folder first, so these two codes never reach the loader for a file.
type FolderTokenFileCode = Exclude<
  TokenFileCode,
  'token_file_relative' | 'token_file_platform'
>;

/** Why the loader refuses the token file of an account of the runner. */
export type RunnerTokenCode = `runner_${FolderTokenFileCode}`;

/**
 * The codes the loader of the runner reports for a token file of an
 * account in the folder of the tokens, frozen: the code of the token file
 * with the prefix `runner_`, so that a message names the file of an
 * account and not `ECCLIUM_CHURCHTOOLS_TOKEN_FILE`.
 */
export const runnerTokenCodes: readonly RunnerTokenCode[] = Object.freeze(
  tokenFileCodes
    .filter(
      (code): code is FolderTokenFileCode =>
        code !== 'token_file_relative' && code !== 'token_file_platform',
    )
    .map((code): RunnerTokenCode => `runner_${code}`),
);

/**
 * The code the loader reports for a token file of an account of the
 * runner that the reader refused.
 *
 * @param code - The code of the reader of the token file.
 * @returns The code with the prefix `runner_`, or the code of the folder
 *   for the two codes a file in the checked folder cannot have.
 * @example
 * ```ts
 * runnerTokenCodeOf('token_file_missing'); // 'runner_token_file_missing'
 * ```
 */
export function runnerTokenCodeOf(
  code: TokenFileCode,
):
  RunnerTokenCode | 'runner_tokens_dir_invalid' | 'runner_tokens_dir_platform' {
  switch (code) {
    case 'token_file_relative':
      return 'runner_tokens_dir_invalid';
    case 'token_file_platform':
      return 'runner_tokens_dir_platform';
    default:
      return `runner_${code}`;
  }
}

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
