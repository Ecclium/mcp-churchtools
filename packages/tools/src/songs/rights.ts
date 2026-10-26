/**
 * The right the tools that read songs need, the messages that name it, and
 * the form of a song in their results (ADR 0064). Like a plugin of a third
 * party, it imports only the plugin API and zod (ADR 0022).
 *
 * @packageDocumentation
 */
import {
  classify,
  maxNameLength,
  maxSongKeyLength,
  type RightRef,
  type Song,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

/**
 * The right that opens the songs of the categories it names
 * (`docs/research/churchtools-api.md`, F36). Without it, ChurchTools leaves
 * the songs of a category out of a list and refuses one of them with 403.
 */
export const songCategoryRight: RightRef = Object.freeze({
  module: 'churchservice',
  right: 'view songcategory',
});

/** The message of a refused song. */
export const songRefused = `ChurchTools refused this song. The service account needs the right "${songCategoryRight.right}" in ${songCategoryRight.module} for the category of the song; ct_whoami shows the rights of the account.`;

/** The message of a song that does not exist. */
export const songNotFound =
  'There is no song with this ID. ct_songs_search finds the ID of a song by name.';

/**
 * The output of one song with at most `arrangements` arrangements. Names,
 * author, copyright, CCLI number and key are text people of the
 * congregation write, so they stand in the data envelope. A song names no
 * person of ChurchTools, and its author is text like its title.
 *
 * @param arrangements - The most arrangements the tool passes on.
 * @returns The schema of one song.
 * @example
 * ```ts
 * const output = z.object({ songs: z.array(songOutput(3)) });
 * ```
 */
export const songOutput = (arrangements: number) =>
  z.object({
    id: classify(z.number().int().positive(), 'none'),
    name: classify(z.string().max(maxNameLength), 'untrusted'),
    category: classify(z.string().max(maxNameLength), 'untrusted'),
    author: classify(z.string().max(maxNameLength), 'untrusted').nullable(),
    copyright: classify(z.string().max(maxNameLength), 'untrusted').nullable(),
    ccli: classify(z.string().max(maxNameLength), 'untrusted').nullable(),
    arrangements: z
      .array(
        z.object({
          id: classify(z.number().int().positive(), 'none'),
          name: classify(z.string().max(maxNameLength), 'untrusted'),
          key: classify(
            z.string().max(maxSongKeyLength),
            'untrusted',
          ).nullable(),
          isDefault: classify(z.boolean(), 'none'),
        }),
      )
      .max(arrangements),
    moreArrangements: classify(z.boolean(), 'none'),
  });

/**
 * A song as a result passes it on: copied field by field, so nothing but
 * the fields of the output can follow, with the first arrangements, the
 * default one first, and whether more follow.
 *
 * @param song - The song as the core read it.
 * @param arrangements - The most arrangements to pass on.
 * @returns The song for the output.
 * @example
 * ```ts
 * const shown = songResult(await read.song(2), 20);
 * ```
 */
export const songResult = (song: Song, arrangements: number) => ({
  id: song.id,
  name: song.name,
  category: song.categoryName,
  author: song.author,
  copyright: song.copyright,
  ccli: song.ccli,
  arrangements: song.arrangements
    .slice(0, arrangements)
    .map(({ id, name, key, isDefault }) => ({ id, name, key, isDefault })),
  moreArrangements: song.arrangements.length > arrangements,
});
