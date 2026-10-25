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
 * Without it for a category, ChurchTools refuses a page of it with 403 and
 * lists its pages as an empty list (F8, F29).
 */
export const wikiCategoryRight: RightRef = Object.freeze({
  module: 'churchwiki',
  right: 'view category',
});

/** The message of a refused list of categories. */
export const wikiRefused = `ChurchTools refused the wiki. The service account needs the right "${wikiViewRight.right}" in ${wikiViewRight.module}; ct_whoami shows the rights of the account.`;

/** The message of a refused category. */
export const categoryRefused = `ChurchTools refused this category of the wiki. The service account needs the right "${wikiCategoryRight.right}" in ${wikiCategoryRight.module} for it; ct_whoami shows the rights of the account.`;

/**
 * Ends a call whose read ChurchTools refused with an error that names the
 * missing right; every other error goes on as it is.
 *
 * @param error - What the read threw.
 * @param right - The right the read needs.
 * @param message - The message that names it.
 * @throws {EccliumError} `permission` with the right, or the error as it was.
 * @example
 * ```ts
 * const categories = await read.wikiCategories().catch((error: unknown) =>
 *   refusedFor(error, wikiViewRight, wikiRefused));
 * ```
 */
export function refusedFor(
  error: unknown,
  right: RightRef,
  message: string,
): never {
  if (isEccliumError(error) && error.code === 'permission') {
    throw new EccliumError('permission', message, { missingRights: [right] });
  }
  throw error;
}
