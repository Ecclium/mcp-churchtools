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
 * The note of an empty list. ChurchTools lists only the categories the
 * account may see, so an empty list names the right that adds them.
 */
export const noCategoryVisible = `No category of the wiki is visible. ChurchTools lists only the categories for which the service account has the right "${wikiCategoryRight.right}" in ${wikiCategoryRight.module}; ct_whoami shows the rights of the account.`;

/** The note of a list with more categories than it holds. */
export const moreCategoriesVisible = `ChurchTools listed more than ${String(maxWikiCategories)} categories; this list holds the first ${String(maxWikiCategories)}.`;

// Strict, so that an argument the model made up ends as a validation error.
const input = z.strictObject({});

// People of the congregation name the categories, so the name is untrusted
// and stands in the data envelope. A category is no person, so its ID
// carries no class of personal data.
const output = z.object({
  categories: z
    .array(
      z.object({
        id: classify(z.number().int().positive(), 'none'),
        name: classify(z.string().max(maxWikiTitleLength), 'untrusted'),
      }),
    )
    .max(maxWikiCategories),
  more: classify(z.boolean(), 'none'),
  notice: classify(
    z.enum([noCategoryVisible, moreCategoriesVisible]),
    'none',
  ).nullable(),
});

type Input = z.output<typeof input>;
type Output = z.input<typeof output>;

const execute = async ({ read }: ToolCall<Input>): Promise<Output> => {
  const { categories, more } = await read
    .wikiCategories()
    .catch((error: unknown) => refusedFor(error, wikiViewRight, wikiRefused));
  return {
    // Copied field by field, so nothing but the two fields can follow.
    categories: categories.map(({ id, name }) => ({ id, name })),
    more,
    notice:
      categories.length === 0
        ? noCategoryVisible
        : more
          ? moreCategoriesVisible
          : null,
  };
};

/**
 * Lists the categories of the wiki the service account may see, at most
 * {@link maxWikiCategories}, each with ID and name.
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
      'Lists the categories of the ChurchTools wiki that the service account may see, at most 100, each with its ID and name.',
    useWhen:
      'You need the ID of a wiki category, to list its pages or to read one of them.',
    avoidWhen:
      'You want the pages or the text of the wiki, which this tool never returns.',
    limits:
      'At most 100 categories and no further pages: more is true when ChurchTools listed more. Only the categories the service account may see appear, so a category can be missing because of a right.',
  },
  input,
  output,
  execute,
});
