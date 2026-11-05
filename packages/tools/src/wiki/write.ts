/**
 * The three tools that write to the wiki: `ct_wiki_page_create`,
 * `ct_wiki_page_update` and `ct_wiki_page_append_section`.
 *
 * Where they stand in the way of a write: they only plan. Each turns its
 * input into an intent of the core and hands it to the write port; the
 * core checks rights, policy and content, reads the page, seals the plan,
 * gets it confirmed and commits it, and builds the result (ADR 0029). A
 * tool never writes, never shapes the result and never sees the text the
 * core writes, with the line of the marking the core adds to a new page
 * and to a section (ADR 0032). The write guard refuses anything else.
 *
 * They exist apart because the risks differ: adding a section changes no
 * word of a page, a change of the text replaces the whole page, so a
 * routine that only adds gets only the tool that adds.
 *
 * Like a plugin of a third party, they import only the plugin API and zod
 * (ADR 0022).
 *
 * @packageDocumentation
 */
import {
  classify,
  defineWriteTool,
  EccliumError,
  isEccliumError,
  maxWikiTitleLength,
  type PlanOutcome,
  refersTo,
  type ToolDescription,
  type WriteToolMeta,
  wikiPageGuidPattern,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

import { pageNotFound } from './page.js';
import { wikiCategoryRight, wikiEditRight, wikiViewRight } from './rights.js';

/**
 * The longest text a tool takes, in UTF-16 code units. It only bounds the
 * input; the content policy and the client hold a text to 64 KiB of UTF-8,
 * the marking included.
 */
export const maxWriteTextLength = 65_536;

/** The message of a category that does not exist. */
export const categoryNotFound =
  'There is no category with this ID. The list of the categories of the wiki gives each ID.';

// The metadata of all three: what the core derives for an intent of the
// wiki anyway (ADR 0029), here so that the registry and the description
// name it. Not for routines yet: phase 6 decides which tool a routine of
// the core relies on.
const meta = (replayGuard: WriteToolMeta['replayGuard']): WriteToolMeta => ({
  capability: 'write',
  domain: 'wiki',
  requiredRights: [wikiViewRight, wikiCategoryRight, wikiEditRight],
  tier: 'free',
  sensitivity: 'personal',
  unattended: 'policy',
  routineStable: false,
  reversible: 'snapshot',
  replayGuard,
});

const categoryId = refersTo(
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  'wiki_category',
);
const guid = refersTo(z.string().regex(wikiPageGuidPattern), 'wiki_page');
// The number of a version of the page, no object of its own.
const baseVersion = classify(
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  'none',
);
// Text from the model, which the content policy checks before anything is
// planned; it never reaches the audit or a log line.
const text = classify(z.string().min(1).max(maxWriteTextLength), 'untrusted');

// A read the write guard made for the plan found no page, or no category:
// the model gets a sentence it can act on. Every other error stays as the
// core made it, with its fixed sentence.
const mapMissing =
  (message: string) =>
  (error: unknown): never => {
    if (isEccliumError(error) && error.code === 'not_found') {
      throw new EccliumError('not_found', message);
    }
    throw error;
  };

// What every description says about the way of a write and its text, so
// that the model knows before its first call.
const confirmed =
  'Writes only after a confirmation by the person or the operator; the result says whether it was written, skipped, or waits.';
const allowedMarkdown =
  'Markdown with headings, paragraphs, lists, tables and emphasis only: no links, web addresses, images, HTML, code or quotes.';
const markingAdded =
  'The server adds a line at the end that marks the text as written by Ecclium; a text must not bring such a line of its own.';
const markingKept =
  'Keep each line of the page that marks a text as written by Ecclium unchanged, and add none.';

const createDescription: ToolDescription = {
  purpose:
    'Creates a Markdown page in a category of the ChurchTools wiki, with a title and a text.',
  useWhen:
    'A person asked for a new page and agreed on its category, its title and its text.',
  avoidWhen:
    'A page on the topic exists: change it or add a section to it. A draft goes to the chat first.',
  limits: `${confirmed} ${allowedMarkdown} ${markingAdded} Text up to 64 KiB. A title exists only once in a category.`,
};

const updateDescription: ToolDescription = {
  purpose:
    'Replaces the text of a Markdown page of the ChurchTools wiki with a whole new text; the confirmation shows what changes.',
  useWhen:
    'A person asked to change a page you read. Send the whole new text and the version you read.',
  avoidWhen:
    'You only add text at the end: add a section instead. The page is no Markdown page, or holds links, images or HTML: only a section can be added then.',
  limits: `${confirmed} If the page changed since the version you read, nothing is written. The whole new text: ${allowedMarkdown} ${markingKept} Text up to 64 KiB.`,
};

const appendDescription: ToolDescription = {
  purpose:
    'Adds a section at the end of a Markdown page of the ChurchTools wiki, without changing its text.',
  useWhen:
    'A person asked to add something to a page you read, such as a report or notes. Send the version you read.',
  avoidWhen: 'Text already on the page has to change: change the page instead.',
  limits: `${confirmed} If the page changed since the version you read, nothing is written. ${allowedMarkdown} ${markingAdded} Up to 64 KiB. The same section on the same page on the same day is skipped.`,
};

/**
 * Creates a Markdown page in a category of the wiki. The core adds the
 * line of the marking, which also keeps the page from being created twice
 * (`replayGuard: marker`); ChurchTools takes a title only once per
 * category.
 *
 * @example
 * ```ts
 * register(host: PluginHost): undefined {
 *   host.addTool(wikiPageCreateTool);
 *   return undefined;
 * }
 * ```
 */
export const wikiPageCreateTool = defineWriteTool({
  name: 'ct_wiki_page_create',
  meta: meta('marker'),
  description: createDescription,
  input: z.strictObject({
    categoryId,
    title: classify(z.string().min(1).max(maxWikiTitleLength), 'untrusted'),
    text,
  }),
  execute: ({ input, write }): Promise<PlanOutcome> =>
    write
      .plan({
        kind: 'wikiPageCreate',
        categoryId: input.categoryId,
        title: input.title,
        text: input.text,
      })
      .catch(mapMissing(categoryNotFound)),
});

/**
 * Replaces the text of a Markdown page, planned on the version the model
 * read. A page of another version ends in a conflict, and a version once
 * written is used up (`replayGuard: baseVersion`).
 *
 * @example
 * ```ts
 * host.addTool(wikiPageUpdateTool);
 * ```
 */
export const wikiPageUpdateTool = defineWriteTool({
  name: 'ct_wiki_page_update',
  meta: meta('baseVersion'),
  description: updateDescription,
  input: z.strictObject({ categoryId, guid, text, baseVersion }),
  execute: ({ input, write }): Promise<PlanOutcome> =>
    write
      .plan({
        kind: 'wikiPageUpdate',
        categoryId: input.categoryId,
        guid: input.guid,
        text: input.text,
        baseVersion: input.baseVersion,
      })
      .catch(mapMissing(pageNotFound)),
});

/**
 * Adds a section at the end of a Markdown page, planned on the version the
 * model read. The core adds the line of the marking after it, and a
 * section with a valid marking of the same day is skipped
 * (`replayGuard: marker`).
 *
 * @example
 * ```ts
 * host.addTool(wikiSectionAppendTool);
 * ```
 */
export const wikiSectionAppendTool = defineWriteTool({
  name: 'ct_wiki_page_append_section',
  meta: meta('marker'),
  description: appendDescription,
  input: z.strictObject({ categoryId, guid, section: text, baseVersion }),
  execute: ({ input, write }): Promise<PlanOutcome> =>
    write
      .plan({
        kind: 'wikiSectionAppend',
        categoryId: input.categoryId,
        guid: input.guid,
        section: input.section,
        baseVersion: input.baseVersion,
      })
      .catch(mapMissing(pageNotFound)),
});
