/**
 * The schemas of the answers of ChurchTools that the client reads
 * (ADR 0025, ADR 0057). `z.object` drops unknown keys; no schema transforms
 * a value. They carry no data classes: what the tools pass on gets its
 * classes in the tool schemas.
 *
 * @packageDocumentation
 */
import {
  isWikiPageGuid,
  maxSearchHits,
  maxWikiTitleLength,
  wikiPageListLimit,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

const count = z.number().int().nonnegative();

/**
 * `meta.pagination` of a list with pages (`docs/research/churchtools-api.md`,
 * F6). `meta.all`, where it appears, is not read.
 */
export const paginationSchema = z.object({
  total: count,
  limit: count,
  current: count,
  lastPage: count,
});

/** `meta` of a list with pages. */
export const pagedMetaSchema = z.object({ pagination: paginationSchema });

/** `meta` of a list without pages, which only counts (F6). */
export const countedMetaSchema = z.object({ count });

// Whether a string has no lone surrogate, without String#isWellFormed,
// which the target of the compiler does not know.
const wellFormed = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
};

const text = (max: number) =>
  z.string().max(max, { abort: true }).refine(wellFormed);

const id = z.number().int().positive();

/**
 * The answer of `GET /api/whoami` (`docs/research/churchtools-api.md`,
 * F18), only the fields the client passes on. `meta.simulatingUserId` must
 * be null or missing; the check for the anonymous person runs before it.
 */
export const whoamiSchema = z.object({
  data: z.object({
    id,
    guid: z.string().min(1).max(64, { abort: true }).refine(wellFormed),
    firstName: text(255),
    lastName: text(255),
    // Missing for an account that may not see persons: ChurchTools then
    // sends 17 fields of the person instead of 40, without the e-mail.
    email: text(254).nullable().optional(),
  }),
  meta: z.object({ simulatingUserId: z.null().optional() }).optional(),
});

/**
 * The most entries a search asks for: one more than it gives, so that a
 * further visible entry says there are more hits (ADR 0060).
 */
export const searchPageLimit = maxSearchHits + 1;

/**
 * The answer of `GET /api/persons` with `query`, only the fields a search
 * passes on (ADR 0060, `docs/research/churchtools-api.md`, F25, F32). The
 * names come without a security level and may be empty; `null` or a
 * missing name is an error, never a hit without a name. `meta` is not
 * read: whether its counts include persons the account may not see is
 * open (F26).
 */
export const personListSchema = z.object({
  data: z
    .array(z.object({ id, firstName: text(255), lastName: text(255) }))
    .max(searchPageLimit),
});

/**
 * The answer of `GET /api/groups` with `query`, only ID and name of each
 * group (ADR 0060, F25, F32). The name is the same top-level field at every
 * security level of groups.
 */
export const groupListSchema = z.object({
  data: z.array(z.object({ id, name: text(255) })).max(searchPageLimit),
});

/**
 * The most categories the client reads from one answer. It gives the first
 * {@link maxWikiCategories}; more than this many is no answer it knows.
 */
export const maxWikiCategoryEntries = 1000;

/**
 * The longest text of a wiki page the client reads, in UTF-16 code units.
 * The limit of the answer bounds it as well; a tool passes the text on in
 * parts.
 */
export const maxWikiTextLength = 2_000_000;

const pageGuid = z.string().refine(isWikiPageGuid);

/**
 * The answer of `GET /api/wiki/categories`, only ID and name of each
 * category. The gate of the probes reads the same fields from it before
 * every run against the test instance and refuses any other form
 * (`docs/research/churchtools-api.md`, «Kategorien des Wikis»).
 */
export const wikiCategoryListSchema = z.object({
  data: z
    .array(z.object({ id, name: text(maxWikiTitleLength) }))
    .max(maxWikiCategoryEntries),
});

/**
 * The answer of `GET /api/wiki/pages` for one category, only the fields a
 * list passes on (F6, F9, «Kennung einer Seite», «Listen ohne Text»).
 * `meta.createdPerson` and `meta.modifiedPerson`, which carry names of
 * persons, are not read (ADR 0057).
 */
export const wikiPageListSchema = z.object({
  data: z
    .array(
      z.object({
        guid: pageGuid,
        title: text(maxWikiTitleLength),
        isMarkdown: z.boolean(),
        version: id,
      }),
    )
    .max(wikiPageListLimit),
  meta: pagedMetaSchema,
});

/**
 * The answer of `GET /api/wiki/categories/{id}/pages/{guid}` and of one
 * version of a page, which has the same form (F19). `text` may be null for
 * a page without text; the client reads it as empty. The GUID comes from
 * the request, so the answer need not repeat it.
 */
export const wikiPageSchema = z.object({
  data: z.object({
    title: text(maxWikiTitleLength),
    isMarkdown: z.boolean(),
    version: id,
    text: text(maxWikiTextLength).nullable(),
  }),
});

/**
 * An ID in the list of a right. ChurchTools 3.137 lists 0 next to other IDs,
 * for categories of the wiki, songs and comments, stations and campus; older
 * tables count from 0. A 0 is an ID like any other and never means «all»
 * (ADR 0057).
 */
const rightId = z.number().int().nonnegative();

/** The value of one right: a boolean or a list of IDs (F5, F30). */
export const rightValueSchema = z.union([
  z.boolean(),
  z.array(rightId).max(10_000),
]);
