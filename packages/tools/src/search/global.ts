/**
 * The tool `ct_search`: the global search of ChurchTools for one type at a
 * time, persons, groups, songs or pages of the wiki, with only the ID or
 * GUID and the title of each hit, at most 50 (ADR 0064). It finds persons,
 * so it holds special data like the searches of persons and groups.
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
  type GlobalSearchHit,
  isEccliumError,
  maxNameLength,
  maxPersonTitleLength,
  maxSearchHits,
  maxSearchTermLength,
  normalizeSearchTerm,
  type RightRef,
  type SearchDomainType,
  type ToolCall,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

import { groupTypeRight, personAreaRight } from '../persons/rights.js';
import { songCategoryRight } from '../songs/rights.js';
import { wikiCategoryRight, wikiViewRight } from '../wiki/rights.js';

/**
 * The rights that open each type to the global search: the same as for the
 * lists of that type (`docs/research/churchtools-api.md`, F29, F36, F40).
 */
export const searchRights: Readonly<
  Record<SearchDomainType, readonly RightRef[]>
> = Object.freeze({
  person: Object.freeze([personAreaRight]),
  group: Object.freeze([groupTypeRight]),
  song: Object.freeze([songCategoryRight]),
  wiki_page: Object.freeze([wikiViewRight, wikiCategoryRight]),
});

const rightsText = (type: SearchDomainType): string =>
  searchRights[type]
    .map((right) => `"${right.right}" in ${right.module}`)
    .join(' and ');

const words: Readonly<Record<SearchDomainType, string>> = Object.freeze({
  person: 'person',
  group: 'group',
  song: 'song',
  wiki_page: 'page of the wiki',
});

/**
 * The note of an empty result of each type. ChurchTools answers the global
 * search without the right with no hit, not with an error, so the tool
 * cannot tell no match from a missing right and says so (F29, F40).
 */
export const noHitMatched: Readonly<Record<SearchDomainType, string>> =
  Object.freeze({
    person: `No ${words.person} matched. ChurchTools also returns no ${words.person} without the right ${rightsText('person')} for its area, so no match and a missing right look the same. ct_whoami shows the rights of the account.`,
    group: `No ${words.group} matched. ChurchTools also returns no ${words.group} without the right ${rightsText('group')} for its type, so no match and a missing right look the same. ct_whoami shows the rights of the account.`,
    song: `No ${words.song} matched. ChurchTools also returns no ${words.song} without the right ${rightsText('song')} for its category, so no match and a missing right look the same. ct_whoami shows the rights of the account.`,
    wiki_page: `No ${words.wiki_page} matched. ChurchTools also returns no ${words.wiki_page} without the rights ${rightsText('wiki_page')} for its category, so no match and a missing right look the same. ct_whoami shows the rights of the account.`,
  });

/** The note of a result with more hits than it lists. */
export const moreHitsMatched = `More than ${String(maxSearchHits)} hits matched; this list holds the first ${String(maxSearchHits)} in the order of ChurchTools. Search again with a longer or more specific term.`;

const invalidTerm = `The search term needs 1 to ${String(maxSearchTermLength)} characters after removing spaces at both ends, and no control characters.`;

// Strict, so that an argument the model made up ends as a validation error.
// The enum leaves out action, which ChurchTools refuses alone (F40).
const input = z.strictObject({
  type: z.enum(['person', 'group', 'song', 'wiki_page']),
  query: z.string().min(1).max(maxSearchTermLength).regex(/\S/),
});

// One list for each type, because the classes depend on it: the name of a
// person keeps the class of a last name outside the data envelope, so that
// the strict redaction can shorten it (ADR 0026, ADR 0064), and every other
// title is text in the envelope. Only the list of the type asked for holds
// hits.
const output = z.object({
  type: classify(z.enum(['person', 'group', 'song', 'wiki_page']), 'none'),
  persons: z
    .array(
      z.object({
        personId: classify(z.number().int().positive(), 'personId'),
        name: classify(z.string().max(maxPersonTitleLength), 'name.last'),
      }),
    )
    .max(maxSearchHits),
  groups: z
    .array(
      z.object({
        id: classify(z.number().int().positive(), 'none').nullable(),
        name: classify(z.string().max(maxNameLength), 'untrusted'),
      }),
    )
    .max(maxSearchHits),
  songs: z
    .array(
      z.object({
        id: classify(z.number().int().positive(), 'none').nullable(),
        name: classify(z.string().max(maxNameLength), 'untrusted'),
      }),
    )
    .max(maxSearchHits),
  wikiPages: z
    .array(
      z.object({
        guid: classify(z.string(), 'none').nullable(),
        title: classify(z.string().max(maxNameLength), 'untrusted'),
      }),
    )
    .max(maxSearchHits),
  more: classify(z.boolean(), 'none'),
  notice: classify(
    z.enum([
      noHitMatched.person,
      noHitMatched.group,
      noHitMatched.song,
      noHitMatched.wiki_page,
      moreHitsMatched,
    ]),
    'none',
  ).nullable(),
});

type Input = z.output<typeof input>;
type Output = z.input<typeof output>;

// A person always comes with its ID from the core; without one, the tool
// would pass on a name without the person.
const personOf = (hit: GlobalSearchHit) => {
  if (hit.id === null) throw new EccliumError('upstream');
  return { personId: hit.id, name: hit.title };
};

const execute = async ({
  input: { type, query },
  read,
}: ToolCall<Input>): Promise<Output> => {
  const term = normalizeSearchTerm(query);
  if (term === undefined) throw new EccliumError('validation', invalidTerm);
  const result = await read.search(type, term).catch((error: unknown) => {
    if (isEccliumError(error) && error.code === 'permission') {
      throw new EccliumError(
        'permission',
        `ChurchTools refused the search. The service account needs ${rightsText(type)}; ct_whoami shows the rights of the account.`,
        { missingRights: searchRights[type] },
      );
    }
    throw error;
  });
  // Only the type asked for: the core checked that every hit has it.
  if (result.type !== type) throw new EccliumError('upstream');
  const { hits, more } = result;
  return {
    type,
    // Copied field by field, so nothing but the fields of each list can
    // follow.
    persons: type === 'person' ? hits.map(personOf) : [],
    groups:
      type === 'group'
        ? hits.map(({ id, title }) => ({ id, name: title }))
        : [],
    songs:
      type === 'song' ? hits.map(({ id, title }) => ({ id, name: title })) : [],
    wikiPages:
      type === 'wiki_page'
        ? hits.map(({ guid, title }) => ({ guid, title }))
        : [],
    more,
    notice:
      hits.length === 0 ? noHitMatched[type] : more ? moreHitsMatched : null,
  };
};

/**
 * Searches one type with the global search of ChurchTools and gives at
 * most {@link maxSearchHits} hits with ID or GUID and title. It holds
 * special data, because it finds persons, and never runs unattended.
 *
 * @example
 * ```ts
 * register(host: PluginHost): undefined {
 *   host.addTool(searchTool);
 *   return undefined;
 * }
 * ```
 */
export const searchTool = defineTool({
  name: 'ct_search',
  meta: {
    capability: 'read',
    domain: 'persons',
    requiredRights: [
      personAreaRight,
      groupTypeRight,
      songCategoryRight,
      wikiViewRight,
      wikiCategoryRight,
    ],
    tier: 'free',
    // It finds persons of the congregation, which reveal religious
    // affiliation, whatever type a call asks for.
    sensitivity: 'special',
    unattended: 'never',
    routineStable: false,
  },
  description: {
    purpose:
      'Searches ChurchTools with its global search for one type at a time, person, group, song or wiki_page, and returns at most 50 hits, each with only its ID, or GUID for a page, and its title or name.',
    useWhen:
      'A search of persons with the last name before the first name, or one quick search across a type when you only need IDs and titles.',
    avoidWhen:
      'You need more than ID and title, such as the category of a page, the arrangements of a song or the members of a group, or want contact details, which this search never returns. An empty term is refused.',
    limits:
      'At most 50 hits per call and no further pages: more is true when more matched, then search with a more specific term. Only the list of the type asked for holds hits. An ID or GUID can be null when ChurchTools names a hit in another form. It finds only what the service account may see; an empty result can also mean a missing right.',
  },
  input,
  output,
  execute,
});
