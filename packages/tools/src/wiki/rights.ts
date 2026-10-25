/**
 * The rights of the wiki the tools of the wiki need, and the errors that
 * name them. Like a plugin of a third party, it imports only the plugin
 * API (ADR 0022).
 *
 * @packageDocumentation
 */
import {
  EccliumError,
  isEccliumError,
  type RightRef,
} from '@ecclium/mcp-churchtools-plugin-api';

/**
 * The right that opens the wiki at all, in the module `churchwiki`
 * (`docs/research/churchtools-api.md`, F5).
 */
export const wikiViewRight: RightRef = Object.freeze({
  module: 'churchwiki',
  right: 'view',
});

/**
 * The right that names the categories of the wiki the account may see.
 * Without it for a category, ChurchTools lists the pages of the category
 * through `GET /api/wiki/pages` as an empty list and refuses its own list
 * of pages with 403 (`docs/research/churchtools-api.md`, F8, F29).
 */
export const wikiCategoryRight: RightRef = Object.freeze({
  module: 'churchwiki',
  right: 'view category',
});

/** The message of a refused list of categories. */
export const wikiRefused = `ChurchTools refused the wiki. The service account needs the right "${wikiViewRight.right}" in ${wikiViewRight.module}; ct_whoami shows the rights of the account.`;

/**
 * The message of a refused read in a category. Which of the two rights is
 * missing, ChurchTools does not say, so the message names both.
 */
export const categoryRefused = `ChurchTools refused this read in the wiki. The service account needs the right "${wikiViewRight.right}" in ${wikiViewRight.module} and the right "${wikiCategoryRight.right}" for this category; ct_whoami shows the rights of the account.`;

/**
 * Ends a call whose read ChurchTools refused with an error that names the
 * rights the read needs; every other error goes on as it is.
 *
 * @param error - What the read threw.
 * @param rights - The rights the read needs.
 * @param message - The message that names them.
 * @throws {EccliumError} `permission` with the right, or the error as it was.
 * @example
 * ```ts
 * const categories = await read.wikiCategories().catch((error: unknown) =>
 *   refusedFor(error, [wikiViewRight], wikiRefused));
 * ```
 */
export function refusedFor(
  error: unknown,
  rights: readonly RightRef[],
  message: string,
): never {
  if (isEccliumError(error) && error.code === 'permission') {
    throw new EccliumError('permission', message, { missingRights: rights });
  }
  throw error;
}
