/**
 * The tool `ct_songs_search`: finds songs by a term, 10 per page, each with
 * its category, author, copyright, CCLI number and first arrangements
 * (ADR 0064).
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
  maxSongsPage,
  normalizeSearchTerm,
  songsPageLimit,
  type ToolCall,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

import { songCategoryRight, songOutput, songResult } from './rights.js';

/**
 * The most arrangements of each song a search gives, the default first. Ten
 * songs with three arrangements and every text of 255 letters fit into one
 * result.
 */
export const arrangementsPerFoundSong = 3;

/**
 * The note of an empty first page. ChurchTools leaves out the songs of
 * categories the account may not see, without an error, so the tool cannot
 * tell no match from a missing right and says so (F36).
 */
export const noSongMatched = `No song matched. ChurchTools also leaves out every song of a category for which the service account lacks the right "${songCategoryRight.right}" in ${songCategoryRight.module}, so no match and a missing right look the same. ct_whoami shows the rights of the account.`;

/** The note of an empty later page when ChurchTools reports no further one. */
export const pastLastSongPage =
  'This page of the songs is empty: the search has no further pages.';

/**
 * The note of an empty page when ChurchTools still reports further ones.
 * Its pagination may count songs the account cannot see.
 */
export const emptySongPageMoreFollow =
  'This page of the songs is empty, but ChurchTools reports further pages, which may hold songs the service account can see. Ask for the next page.';

const invalidTerm = `The search term needs 1 to ${String(maxSearchTermLength)} characters after removing spaces at both ends, and no control characters.`;

// Strict, so that an argument the model made up ends as a validation error.
const input = z.strictObject({
  query: z.string().min(1).max(maxSearchTermLength).regex(/\S/),
  page: z.number().int().min(1).max(maxSongsPage).optional(),
});

const output = z.object({
  page: classify(z.number().int().min(1).max(maxSongsPage), 'none'),
  songs: z.array(songOutput(arrangementsPerFoundSong)).max(songsPageLimit),
  more: classify(z.boolean(), 'none'),
  notice: classify(
    z.enum([noSongMatched, pastLastSongPage, emptySongPageMoreFollow]),
    'none',
  ).nullable(),
});

type Input = z.output<typeof input>;
type Output = z.input<typeof output>;

const execute = async ({
  input: { query, page = 1 },
  read,
}: ToolCall<Input>): Promise<Output> => {
  const term = normalizeSearchTerm(query);
  if (term === undefined) throw new EccliumError('validation', invalidTerm);
  const { songs, more } = await read.searchSongs(term, page);
  return {
    page,
    songs: songs.map((song) => songResult(song, arrangementsPerFoundSong)),
    more,
    notice:
      songs.length > 0
        ? null
        : more
          ? emptySongPageMoreFollow
          : page === 1
            ? noSongMatched
            : pastLastSongPage,
  };
};

/**
 * Searches songs by a term, {@link songsPageLimit} per page, each with the
 * name of its category, author, copyright, CCLI number and its first
 * {@link arrangementsPerFoundSong} arrangements.
 *
 * @example
 * ```ts
 * register(host: PluginHost): undefined {
 *   host.addTool(songsSearchTool);
 *   return undefined;
 * }
 * ```
 */
export const songsSearchTool = defineTool({
  name: 'ct_songs_search',
  meta: {
    capability: 'read',
    domain: 'songs',
    requiredRights: [songCategoryRight],
    tier: 'free',
    sensitivity: 'none',
    unattended: 'policy',
    routineStable: false,
  },
  description: {
    purpose:
      'Searches the songs of ChurchTools by a term and returns 10 per call, each with ID, name, category, author, copyright, CCLI number and up to 3 arrangements with ID, name, key and whether it is the default.',
    useWhen:
      'You look for a song by part of its name, for example to plan an agenda or to find its ID and arrangements.',
    avoidWhen:
      'You want lyrics, chords, sheet music, files or links of a song, which this tool never returns. An empty term is refused.',
    limits:
      'At most 10 songs per call: more is true when ChurchTools reports a further page, then ask again with the next page number. Up to 3 arrangements per song, the default first; moreArrangements is true when a song has more. Songs of categories the service account may not see are left out without a trace.',
  },
  input,
  output,
  execute,
});
