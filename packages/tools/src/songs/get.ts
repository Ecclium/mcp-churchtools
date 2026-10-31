/**
 * The tool `ct_songs_get`: reads one song by its ID, with its category,
 * author, copyright, CCLI number and up to 20 arrangements (ADR 0064).
 *
 * Like a plugin of a third party, it imports only the plugin API and zod
 * (ADR 0022).
 *
 * @packageDocumentation
 */
import {
  defineTool,
  refersTo,
  type ToolCall,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

import { readFailed } from '../persons/rights.js';
import {
  songCategoryRight,
  songNotFound,
  songOutput,
  songRefused,
  songResult,
} from './rights.js';

/**
 * The most arrangements one read of a song gives, the default first. One
 * song with 20 arrangements and every text of 255 quotes fits into one
 * result.
 */
export const arrangementsPerSong = 20;

// Strict, so that an argument the model made up ends as a validation error.
const input = z.strictObject({
  songId: refersTo(
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    'song',
  ),
});

const output = songOutput(arrangementsPerSong);

type Input = z.output<typeof input>;
type Output = z.input<typeof output>;

const execute = async ({
  input: { songId },
  read,
}: ToolCall<Input>): Promise<Output> => {
  const song = await read
    .song(songId)
    .catch((error: unknown) =>
      readFailed(error, [songCategoryRight], songRefused, songNotFound),
    );
  return songResult(song, arrangementsPerSong);
};

/**
 * Reads one song by its ID, with the name of its category, author,
 * copyright, CCLI number and up to {@link arrangementsPerSong}
 * arrangements.
 *
 * @example
 * ```ts
 * register(host: PluginHost): undefined {
 *   host.addTool(songsGetTool);
 *   return undefined;
 * }
 * ```
 */
export const songsGetTool = defineTool({
  name: 'ct_songs_get',
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
      'Reads one song of ChurchTools by its ID, with name, category, author, copyright, CCLI number and up to 20 arrangements with ID, name, key and whether it is the default.',
    useWhen:
      'You know the ID of a song, for example from a search or an agenda, and need all its arrangements.',
    avoidWhen:
      'You look for a song by name, or want lyrics, chords, sheet music, files or links, which this tool never returns.',
    limits:
      'Up to 20 arrangements, the default first; moreArrangements is true when the song has more. A song of a category the service account may not see is refused.',
  },
  input,
  output,
  execute,
});
