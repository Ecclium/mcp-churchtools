/**
 * The tools `ct_docs_search_academy` and `ct_docs_read_academy`: search
 * and read the freely accessible German help pages of the ChurchTools
 * Academy that come with Ecclium, each with its title and link (ADR 0027,
 * ADR 0066). They read only the index, never ChurchTools or the Academy.
 *
 * @packageDocumentation
 */
import type { DocsIndex } from '@ecclium/mcp-churchtools-docs-index';
import {
  classify,
  defineTool,
  EccliumError,
  type PluginHost,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

import { maxPartBytes, splitIntoParts } from '../parts.js';
import {
  academyLinkOutput,
  academyPathOutput,
  academySource,
  academySourceOutput,
  maxDocsHits,
  searchInput,
  searchWithMore,
} from './common.js';

/** The highest part of a help page a call may ask for. */
export const maxAcademyPart = 1000;

/** The message of a path the facts do not hold. */
export const academyPageNotFound =
  'The documentation of Ecclium has no help page with this path. Search the help pages to find its path.';

/**
 * The message of a part beyond the last one.
 *
 * @param parts - How many parts the page has.
 * @returns One line for the model.
 * @example
 * ```ts
 * academyPartOutOfRange(1);
 * // 'This help page has 1 parts. Ask for a part from 1 to 1.'
 * ```
 */
export const academyPartOutOfRange = (parts: number): string =>
  `This help page has ${String(parts)} parts. Ask for a part from 1 to ${String(parts)}.`;

const sectionOutput = classify(
  z
    .string()
    .max(200)
    .regex(/^[a-z0-9%][a-z0-9%_-]*$/),
  'none',
);

const searchOutput = z.object({
  hits: z
    .array(
      z.object({
        title: classify(z.string().max(300), 'untrusted'),
        path: academyPathOutput,
        link: academyLinkOutput,
        section: sectionOutput,
      }),
    )
    .max(maxDocsHits),
  more: classify(z.boolean(), 'none'),
  source: academySourceOutput,
});

// Strict, so that an argument the model made up ends as a validation
// error. The path in the form the facts allow.
const readInput = z.strictObject({
  path: classify(
    z
      .string()
      .max(300)
      .regex(/^\/de\/(?:[a-z0-9%_-]+\/)*[a-z0-9%_-]+\/?$/),
    'none',
  ),
  part: classify(
    z.number().int().min(1).max(maxAcademyPart),
    'none',
  ).optional(),
});

const readOutput = z.object({
  title: classify(z.string().max(300), 'untrusted'),
  path: academyPathOutput,
  link: academyLinkOutput,
  section: sectionOutput,
  modified: classify(z.string().regex(/^\d{4}-\d{2}-\d{2}$/), 'none'),
  part: classify(z.number().int().min(1).max(maxAcademyPart), 'none'),
  parts: classify(z.number().int().min(1), 'none'),
  // A part has at most maxPartBytes bytes, so at most as many code units.
  text: classify(z.string().max(maxPartBytes), 'untrusted'),
  source: academySourceOutput,
});

const meta = Object.freeze({
  capability: 'read',
  domain: 'docs',
  requiredRights: [],
  tier: 'free',
  sensitivity: 'none',
  unattended: 'policy',
  routineStable: false,
} as const);

/**
 * Adds `ct_docs_search_academy`, the search over the help pages, and
 * `ct_docs_read_academy`, which gives the text of one page in parts like
 * the text of a wiki page. Both read only the index they get.
 *
 * @param host - The host of the plugin of the core.
 * @param docs - The docs index the composition root loaded.
 * @example
 * ```ts
 * addAcademyTools(host, docs);
 * ```
 */
export function addAcademyTools(host: PluginHost, docs: DocsIndex): void {
  host.addTool(
    defineTool({
      name: 'ct_docs_search_academy',
      meta,
      description: {
        purpose:
          'Searches the German ChurchTools Academy help pages that come with Ecclium; returns title, path and link of each.',
        useWhen:
          'You need to explain how a function of ChurchTools works or how to grant a right in its web interface.',
        avoidWhen:
          'You look for an API operation or the exact name of a right.',
        limits:
          'Only freely accessible pages on the areas of Ecclium, rights and the API, fetched on one day. At most 25 hits.',
      },
      input: searchInput,
      output: searchOutput,
      execute: ({ input }) => {
        const { hits, more } = searchWithMore(
          (query, limit) => docs.searchAcademy(query, limit),
          input,
        );
        return Promise.resolve({
          hits: hits.map((hit) => ({
            title: hit.title,
            path: hit.path,
            link: hit.attribution.link,
            section: hit.section,
          })),
          more,
          source: academySource(docs.sources),
        });
      },
    }),
  );
  host.addTool(
    defineTool({
      name: 'ct_docs_read_academy',
      meta,
      description: {
        purpose:
          'Reads one ChurchTools Academy help page by path: title, link and text in simple Markdown, a long text in parts.',
        useWhen:
          'You found the page by search or as an explanation of a right and need its content.',
        avoidWhen: 'Titles and links are enough, which the search gives.',
        limits:
          'Parts of at most 16000 bytes. Cite the page with title and link; its publisher reserves all rights.',
      },
      input: readInput,
      output: readOutput,
      execute: ({ input: { path, part = 1 } }) => {
        const page = docs.getAcademyPage(path);
        if (page === undefined) {
          throw new EccliumError('not_found', academyPageNotFound);
        }
        const { fact, attribution } = page;
        const parts = splitIntoParts(fact.text);
        const text = parts[part - 1];
        if (text === undefined) {
          throw new EccliumError(
            'validation',
            academyPartOutOfRange(parts.length),
          );
        }
        return Promise.resolve({
          title: fact.title,
          path: fact.path,
          link: attribution.link,
          section: fact.section,
          modified: fact.modified,
          part,
          parts: parts.length,
          text,
          source: academySource(docs.sources),
        });
      },
    }),
  );
}
