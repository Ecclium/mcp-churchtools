/**
 * The tool `ct_wiki_search`: searches the pages of the wiki by a term, in
 * every category the service account may see or in one, and gives the
 * first 20 hits with GUID, category, title and a preview (ADR 0064).
 *
 * Like a plugin of a third party, it imports only the plugin API and zod
 * (ADR 0022).
 *
 * @packageDocumentation
 */
import {
  classify,
  defineTool,
  EccliumError,
  maxSearchTermLength,
  maxWikiPreviewLength,
  maxWikiSearchHits,
  maxWikiTitleLength,
  normalizeSearchTerm,
  type ToolCall,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

import {
  categoryRefused,
  refusedFor,
  wikiCategoryRight,
  wikiViewRight,
} from './rights.js';

/**
 * The note of an empty result. How ChurchTools answers a search in a
 * category the account may not see is not shown, so the tool says that a
 * missing right may hide pages (F40).
 */
export const noPageMatched = `No page matched. Pages of a category for which the service account lacks the right "${wikiCategoryRight.right}" in ${wikiCategoryRight.module} may be left out as well. ct_whoami shows the rights of the account.`;

/** The note of a result with more hits than it lists. */
export const morePagesMatched = `More than ${String(maxWikiSearchHits)} pages matched; this list holds the first ${String(maxWikiSearchHits)} in the order of ChurchTools. Search again with a more specific term or in one category.`;

const invalidTerm = `The search term needs 1 to ${String(maxSearchTermLength)} characters after removing spaces at both ends, and no control characters.`;

// Strict, so that an argument the model made up ends as a validation error.
const input = z.strictObject({
  query: z.string().min(1).max(maxSearchTermLength).regex(/\S/),
  categoryId: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
});

// Titles and previews are text people of the congregation write, so they
// stand in the data envelope; a preview can name persons. GUID and
// category describe a page, not a person.
const output = z.object({
  hits: z
    .array(
      z.object({
        guid: classify(z.string(), 'none').nullable(),
        categoryId: classify(z.number().int().positive(), 'none').nullable(),
        title: classify(z.string().max(maxWikiTitleLength), 'untrusted'),
        preview: classify(
          z.string().max(maxWikiPreviewLength),
          'untrusted',
        ).nullable(),
      }),
    )
    .max(maxWikiSearchHits),
  more: classify(z.boolean(), 'none'),
  notice: classify(
    z.enum([noPageMatched, morePagesMatched]),
    'none',
  ).nullable(),
});

type Input = z.output<typeof input>;
type Output = z.input<typeof output>;

const execute = async ({
  input: { query, categoryId },
  read,
}: ToolCall<Input>): Promise<Output> => {
  const term = normalizeSearchTerm(query);
  if (term === undefined) throw new EccliumError('validation', invalidTerm);
  const { hits, more } = await read
    .searchWiki(term, categoryId)
    .catch((error: unknown) =>
      refusedFor(error, [wikiViewRight, wikiCategoryRight], categoryRefused),
    );
  return {
    // Copied field by field, so nothing but the four fields can follow.
    hits: hits.map(({ guid, categoryId: category, title, preview }) => ({
      guid,
      categoryId: category,
      title,
      preview,
    })),
    more,
    notice: hits.length === 0 ? noPageMatched : more ? morePagesMatched : null,
  };
};

/**
 * Searches the pages of the wiki by a term and gives the first
 * {@link maxWikiSearchHits} hits with GUID, category, title and preview,
 * never the whole text.
 *
 * @example
 * ```ts
 * register(host: PluginHost): undefined {
 *   host.addTool(wikiSearchTool);
 *   return undefined;
 * }
 * ```
 */
export const wikiSearchTool = defineTool({
  name: 'ct_wiki_search',
  meta: {
    capability: 'read',
    domain: 'wiki',
    requiredRights: [wikiViewRight, wikiCategoryRight],
    tier: 'free',
    sensitivity: 'personal',
    unattended: 'policy',
    routineStable: false,
  },
  description: {
    purpose:
      'Searches the pages of the ChurchTools wiki by a term and returns the first 20 hits, each with the GUID and category of the page, its title and a short preview of its text.',
    useWhen:
      'You look for a page by a word in its title or text, in every category or in one category ID, for example to read it next with its GUID and category.',
    avoidWhen:
      'You want the whole text of a page, or an overview of a category, which this tool does not give. An empty term is refused.',
    limits:
      'At most 20 hits in the order of ChurchTools and no further pages: more is true when more pages matched, then search with a more specific term or in one category. The GUID is null when ChurchTools names the page in another form. Pages of categories the service account may not see can be missing without a trace.',
  },
  input,
  output,
  execute,
});
