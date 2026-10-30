/**
 * The tool `ct_wiki_page_get`: reads one page of the wiki by its GUID and
 * gives its text in parts of at most 16000 bytes as JSON writes them, cut
 * at a line break where a line fits and between two characters otherwise
 * (ADR 0057).
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
  isEccliumError,
  maxWikiTitleLength,
  type ToolCall,
  wikiPageGuidPattern,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

import { maxPartBytes, splitIntoParts } from '../parts.js';
import {
  categoryRefused,
  refusedFor,
  wikiCategoryRight,
  wikiViewRight,
} from './rights.js';

/** The highest part a call may ask for. */
export const maxPart = 1000;

/** The message of a page or version that does not exist. */
export const pageNotFound =
  'There is no page with this GUID in this category, or no such version of it. The list of the pages of the category gives each GUID and its newest version.';

/**
 * The message of a part beyond the last one.
 *
 * @param parts - How many parts the page has.
 * @returns One line for the model.
 * @example
 * ```ts
 * partOutOfRange(3); // 'This page has 3 parts. Ask for a part from 1 to 3.'
 * ```
 */
export const partOutOfRange = (parts: number): string =>
  `This page has ${String(parts)} parts. Ask for a part from 1 to ${String(parts)}.`;

// Strict, so that an argument the model made up ends as a validation error.
// The GUID has the form the OpenAPI document of ChurchTools gives; the
// client checks it again before it fills a path.
const input = z.strictObject({
  categoryId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  guid: z.string().regex(wikiPageGuidPattern),
  part: z.number().int().min(1).max(maxPart).optional(),
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});

// Title and text are written by people of the congregation, so both stand
// in the data envelope; a mention of a person in the text is part of it.
// GUID, format, version and the numbers of the parts describe the page.
const output = z.object({
  categoryId: classify(z.number().int().positive(), 'none'),
  guid: classify(z.string(), 'none'),
  title: classify(z.string().max(maxWikiTitleLength), 'untrusted'),
  isMarkdown: classify(z.boolean(), 'none'),
  version: classify(z.number().int().positive(), 'none'),
  part: classify(z.number().int().min(1).max(maxPart), 'none'),
  parts: classify(z.number().int().min(1), 'none'),
  // A part has at most maxPartBytes bytes, so at most as many code units.
  text: classify(z.string().max(maxPartBytes), 'untrusted'),
});

type Input = z.output<typeof input>;
type Output = z.input<typeof output>;

const execute = async ({
  input: { categoryId, guid, part = 1, version },
  read,
}: ToolCall<Input>): Promise<Output> => {
  const page = await read
    .wikiPage(categoryId, guid, version)
    .catch((error: unknown) => {
      if (isEccliumError(error) && error.code === 'not_found') {
        throw new EccliumError('not_found', pageNotFound);
      }
      return refusedFor(
        error,
        [wikiViewRight, wikiCategoryRight],
        categoryRefused,
      );
    });
  // The parts come from the text as ChurchTools stores it, so the same
  // version always gives the same parts.
  const parts = splitIntoParts(page.text);
  const text = parts[part - 1];
  if (text === undefined) {
    throw new EccliumError('validation', partOutOfRange(parts.length));
  }
  return {
    categoryId,
    guid: page.guid,
    title: page.title,
    isMarkdown: page.isMarkdown,
    version: page.version,
    part,
    parts: parts.length,
    text,
  };
};

/**
 * Reads one page of the wiki by category and GUID, in its newest version
 * or in the version asked for, and gives one part of its text.
 *
 * @example
 * ```ts
 * register(host: PluginHost): undefined {
 *   host.addTool(wikiPageGetTool);
 *   return undefined;
 * }
 * ```
 */
export const wikiPageGetTool = defineTool({
  name: 'ct_wiki_page_get',
  meta: {
    capability: 'read',
    domain: 'wiki',
    requiredRights: [wikiViewRight, wikiCategoryRight],
    tier: 'free',
    sensitivity: 'personal',
    unattended: 'policy',
    // A routine of the free core reads with it, so name and input are a
    // public contract from phase 2 on (ADR 0064).
    routineStable: true,
  },
  description: {
    purpose:
      'Reads one page of the ChurchTools wiki by its category ID and GUID and returns its title, version, format and text, a long text in parts.',
    useWhen:
      'You need the content of a page whose GUID you know from the list of pages of its category.',
    avoidWhen:
      'You only need titles or GUIDs, which the list of pages gives without the text.',
    limits:
      'A long text comes in parts of at most 16000 bytes, cut at a line break where a line fits and between two characters otherwise: part and parts say which part this is and how many there are. Ask for every further part with the version of the first, so that all parts come from the same version; without a version the newest is read. The text is Markdown when isMarkdown is true and HTML otherwise.',
  },
  input,
  output,
  execute,
});
