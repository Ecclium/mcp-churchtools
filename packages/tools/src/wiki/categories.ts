/**
 * The tool `ct_wiki_categories_list`: lists the categories of the wiki the
 * service account may see, with ID and name only (ADR 0057).
 *
 * Like a plugin of a third party, it imports only the plugin API and zod
 * (ADR 0022).
 *
 * @packageDocumentation
 */
import {
  classify,
  defineTool,
  maxWikiCategories,
  maxWikiTitleLength,
  type ToolCall,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

import {
  refusedFor,
  wikiCategoryRight,
  wikiRefused,
  wikiViewRight,
} from './rights.js';

/**
 * The most categories one call gives. 25 names of 255 characters fit into
 * one result even when every character doubles in length when it is
 * written as JSON.
 */
export const categoriesPerCall = 25;

/** The last page of the list a call may ask for. */
export const maxCategoryPage = Math.ceil(maxWikiCategories / categoriesPerCall);

/**
 * The note of an empty list. ChurchTools lists only the categories the
 * account may see, so an empty list names the right that adds them.
 */
export const noCategoryVisible = `No category of the wiki is visible. ChurchTools lists only the categories for which the service account has the right "${wikiCategoryRight.right}" in ${wikiCategoryRight.module}; ct_whoami shows the rights of the account.`;

/** The note of an empty later page. */
export const pastLastCategory =
  'This page of the list is empty: the list has no further pages.';

// Strict, so that an argument the model made up ends as a validation error.
const input = z.strictObject({
  page: z.number().int().min(1).max(maxCategoryPage).optional(),
});

// People of the congregation name the categories, so the name is untrusted
// and stands in the data envelope. A category is no person, so its ID
// carries no class of personal data.
const output = z.object({
  page: classify(z.number().int().min(1).max(maxCategoryPage), 'none'),
  categories: z
    .array(
      z.object({
        id: classify(z.number().int().positive(), 'none'),
        name: classify(z.string().max(maxWikiTitleLength), 'untrusted'),
      }),
    )
    .max(categoriesPerCall),
  more: classify(z.boolean(), 'none'),
  notice: classify(
    z.enum([noCategoryVisible, pastLastCategory]),
    'none',
  ).nullable(),
});

type Input = z.output<typeof input>;
type Output = z.input<typeof output>;

const execute = async ({
  input: { page = 1 },
  read,
}: ToolCall<Input>): Promise<Output> => {
  const all = await read
    .wikiCategories()
    .catch((error: unknown) => refusedFor(error, [wikiViewRight], wikiRefused));
  // ChurchTools gives every category in one answer; the tool pages through
  // it, so that no result outgrows its limit.
  const first = (page - 1) * categoriesPerCall;
  const categories = all.slice(first, first + categoriesPerCall);
  return {
    page,
    // Copied field by field, so nothing but the two fields can follow.
    categories: categories.map(({ id, name }) => ({ id, name })),
    more: all.length > first + categoriesPerCall,
    notice:
      categories.length > 0
        ? null
        : page === 1
          ? noCategoryVisible
          : pastLastCategory,
  };
};

/**
 * Lists the categories of the wiki the service account may see,
 * {@link categoriesPerCall} per call, each with ID and name.
 *
 * @example
 * ```ts
 * register(host: PluginHost): undefined {
 *   host.addTool(wikiCategoriesListTool);
 *   return undefined;
 * }
 * ```
 */
export const wikiCategoriesListTool = defineTool({
  name: 'ct_wiki_categories_list',
  meta: {
    capability: 'read',
    domain: 'wiki',
    requiredRights: [wikiViewRight],
    tier: 'free',
    sensitivity: 'personal',
    unattended: 'policy',
    routineStable: false,
  },
  description: {
    purpose:
      'Lists the categories of the ChurchTools wiki that the service account may see, 25 per call, each with its ID and name.',
    useWhen:
      'You need the ID of a wiki category, to list its pages or to read one of them.',
    avoidWhen:
      'You want the pages or the text of the wiki, which this tool never returns.',
    limits:
      'At most 25 categories per call: more is true when further categories follow, then ask again with the next page number. Only the categories the service account may see appear, so a category can be missing because of a right.',
  },
  input,
  output,
  execute,
});
