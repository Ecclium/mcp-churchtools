/**
 * The tool `ct_wiki_pages_list`: lists the pages of one category of the
 * wiki, 50 per page of the list, without their text (ADR 0057).
 *
 * Like a plugin of a third party, it imports only the plugin API and zod
 * (ADR 0022).
 *
 * @packageDocumentation
 */
import {
  classify,
  defineTool,
  maxWikiTitleLength,
  type ToolCall,
  wikiPageListLimit,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

import {
  categoryRefused,
  refusedFor,
  wikiCategoryRight,
  wikiViewRight,
} from './rights.js';

/** The last page of the list a call may ask for. */
export const maxListPage = 1000;

/**
 * The note of an empty first page. ChurchTools answers a category the
 * account may not see with an empty list, not with an error, so the tool
 * cannot tell the two apart and says so (F29).
 */
export const noPageListed = `No page is listed. ChurchTools also returns no page when the service account lacks the right "${wikiCategoryRight.right}" in ${wikiCategoryRight.module} for the category, so an empty category and a missing right look the same. ct_whoami shows the rights of the account.`;

/** The note of an empty later page. */
export const pastLastPage =
  'This page of the list is empty: the list has no further pages.';

// Strict, so that an argument the model made up ends as a validation error.
const input = z.strictObject({
  categoryId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  page: z.number().int().min(1).max(maxListPage).optional(),
});

// Titles are text people of the congregation write, so they stand in the
// data envelope. GUID, format and version describe a page, not a person.
const output = z.object({
  categoryId: classify(z.number().int().positive(), 'none'),
  page: classify(z.number().int().min(1).max(maxListPage), 'none'),
  pages: z
    .array(
      z.object({
        guid: classify(z.string(), 'none'),
        title: classify(z.string().max(maxWikiTitleLength), 'untrusted'),
        isMarkdown: classify(z.boolean(), 'none'),
        version: classify(z.number().int().positive(), 'none'),
      }),
    )
    .max(wikiPageListLimit),
  more: classify(z.boolean(), 'none'),
  notice: classify(z.enum([noPageListed, pastLastPage]), 'none').nullable(),
});

type Input = z.output<typeof input>;
type Output = z.input<typeof output>;

const execute = async ({
  input: { categoryId, page = 1 },
  read,
}: ToolCall<Input>): Promise<Output> => {
  const { pages, more } = await read
    .wikiPages(categoryId, page)
    .catch((error: unknown) =>
      refusedFor(error, wikiCategoryRight, categoryRefused),
    );
  return {
    categoryId,
    page,
    // Copied field by field, so nothing but the four fields can follow.
    pages: pages.map(({ guid, title, isMarkdown, version }) => ({
      guid,
      title,
      isMarkdown,
      version,
    })),
    more,
    notice: pages.length > 0 ? null : page === 1 ? noPageListed : pastLastPage,
  };
};

/**
 * Lists the pages of one category of the wiki, {@link wikiPageListLimit}
 * per page of the list, with GUID, title, format and version, never the
 * text.
 *
 * @example
 * ```ts
 * register(host: PluginHost): undefined {
 *   host.addTool(wikiPagesListTool);
 *   return undefined;
 * }
 * ```
 */
export const wikiPagesListTool = defineTool({
  name: 'ct_wiki_pages_list',
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
      'Lists the pages of one category of the ChurchTools wiki, 50 per call, each with its GUID, title, version and whether it is written in Markdown, but without its text.',
    useWhen:
      'You need the GUID of a page to read it, or an overview of the pages of a category. Take the category ID from the list of categories.',
    avoidWhen:
      'You want the text of a page, or look for a word across the wiki: this tool lists one category and never searches.',
    limits:
      'At most 50 pages per call: more is true when ChurchTools reports a further page of the list, then ask again with the next page number. A later page can still be empty. An empty list can also mean that the service account lacks the right to see the category, because ChurchTools then returns no page instead of an error.',
  },
  input,
  output,
  execute,
});
