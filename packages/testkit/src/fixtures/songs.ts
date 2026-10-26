/**
 * Answers of songs in the form ChurchTools gives them, for the tests of
 * their reads (ADR 0064). Every field a read does not pass on holds a
 * canary, so a test can show that no layer lets one of them through. The
 * fields kept take the values the test gives.
 *
 * The names of the fields are those of the answers of ChurchTools 3.137, as
 * `09-domains-read` described them (`docs/research/churchtools-api.md`,
 * F37): 11 fields of a song with its whole category, and 19 fields of an
 * arrangement with its files, links and sources. The values are not those
 * types: every value outside the kept ones is a canary text. The client
 * drops the other fields by their names, not by their types. Where the
 * probe could not name a key, `unnamed` stands in for it.
 *
 * @packageDocumentation
 */
import type {
  Song,
  SongArrangement,
} from '@ecclium/mcp-churchtools-plugin-api';

import { type Canary, type CanaryKind } from '../canary.js';
import {
  answer,
  drop,
  type HighestLevelAnswer,
  meta,
  over,
  plant,
  type Shape,
} from './highest-level.js';

const text: CanaryKind = 'name';

// Every field of the category of a song (F37).
const categoryShape: Readonly<Record<string, Shape>> = {
  id: text,
  name: text,
  nameTranslated: text,
  sortKey: text,
  campusId: text,
  meta,
};

// Every field of an arrangement (F37). Links and files were empty in the
// probe; whatever they hold, a read never passes it on.
const arrangementShape: Readonly<Record<string, Shape>> = {
  id: text,
  name: text,
  isDefault: text,
  sourceId: text,
  source: text,
  sourceReference: 'token',
  key: text,
  beat: text,
  tempo: text,
  duration: text,
  description: text,
  links: ['token'],
  files: [{ name: text, fileUrl: 'token' }],
  meta,
  unnamed: { first: text, second: text, third: 'token', fourth: 'token' },
  unnamedSecond: text,
  keyOfArrangement: text,
  note: text,
  unnamedThird: text,
};

// Every field of a song (F37).
const songShape: Readonly<Record<string, Shape>> = {
  id: text,
  name: text,
  category: categoryShape,
  author: text,
  copyright: text,
  ccli: text,
  shouldPractice: text,
  arrangements: [arrangementShape],
  meta,
  unnamed: { first: text, second: text },
  note: text,
};

// A song and an arrangement without the fields a read keeps, so that the
// values of the test hide no canary.
const keptSongShape = drop(
  songShape,
  'id',
  'name',
  'category',
  'author',
  'copyright',
  'ccli',
  'arrangements',
);
const keptCategoryShape = drop(categoryShape, 'name');
const keptArrangementShape = drop(
  arrangementShape,
  'id',
  'name',
  'key',
  'isDefault',
);

/** An arrangement as a test gives it; a key left undefined is not sent. */
export interface ArrangementFixture extends Omit<SongArrangement, 'key'> {
  /** The key as ChurchTools sends it; left out of the answer when undefined. */
  readonly key?: string | null;
}

/**
 * A song as a test gives it to {@link songsAnswer} and {@link songAnswer}.
 * Author, copyright and CCLI number left undefined are not sent.
 */
export interface SongFixture extends Omit<
  Song,
  'author' | 'copyright' | 'ccli' | 'arrangements'
> {
  /** The author; left out of the answer when undefined. */
  readonly author?: string | null;
  /** The copyright; left out of the answer when undefined. */
  readonly copyright?: string | null;
  /** The CCLI number; left out of the answer when undefined. */
  readonly ccli?: string | null;
  /** The arrangements, in the order of the answer. */
  readonly arrangements: readonly ArrangementFixture[];
}

// A field the test gives, or nothing when it is undefined.
const given = (
  field: string,
  value: string | null | undefined,
): Record<string, unknown> => (value === undefined ? {} : { [field]: value });

// The kept fields of a song over its planted ones.
const songOf = (
  song: SongFixture,
  path: string,
  made: Map<string, Canary>,
): Record<string, unknown> => ({
  ...(plant(keptSongShape, path, made) as Record<string, unknown>),
  id: song.id,
  name: song.name,
  category: over(plant(keptCategoryShape, `${path}.category`, made), {
    name: song.categoryName,
  }),
  ...given('author', song.author),
  ...given('copyright', song.copyright),
  ...given('ccli', song.ccli),
  arrangements: song.arrangements.map((arrangement) => ({
    ...(plant(keptArrangementShape, `${path}.arrangements[]`, made) as Record<
      string,
      unknown
    >),
    id: arrangement.id,
    name: arrangement.name,
    isDefault: arrangement.isDefault,
    ...given('key', arrangement.key),
  })),
});

/**
 * Builds an answer of `GET /api/songs`: each entry with every field of a
 * song, ID, name, the name of the category, author, copyright, CCLI number
 * and of each arrangement ID, name, key and whether default from the songs
 * given, every other field a canary: the rest of the category, the files,
 * links, sources and notes of the arrangements, `meta` with the persons who
 * created and changed them, and in `meta` of the answer every count but
 * `pagination.lastPage`.
 *
 * @param songs - The songs of the page, in the order of the answer.
 * @param lastPage - The last page ChurchTools reports.
 * @returns The body and the canaries planted in it.
 * @example
 * ```ts
 * const answer = songsAnswer([{ id: 2, name: 'Lied A', categoryName: 'Lieder', author: null,
 *   copyright: null, ccli: null, arrangements: [{ id: 3, name: 'Standard', key: null, isDefault: true }] }], 1);
 * ```
 */
export function songsAnswer(
  songs: readonly SongFixture[],
  lastPage: number,
): HighestLevelAnswer {
  const made = new Map<string, Canary>();
  const data = songs.map((song) => songOf(song, 'entry', made));
  const listMeta = over(
    plant(
      {
        count: 'phone',
        pagination: { total: 'phone', limit: 'phone', current: 'phone' },
      },
      'meta',
      made,
    ),
    { pagination: { lastPage } },
  );
  return answer(data, made, listMeta);
}

/**
 * Builds an answer of `GET /api/songs/{songId}`: the song with every field,
 * the kept ones from the song given, every other field a canary, as in
 * {@link songsAnswer}.
 *
 * @param song - The fields the read passes on.
 * @returns The body and the canaries planted in it.
 * @example
 * ```ts
 * const answer = songAnswer({ id: 2, name: 'Lied A', categoryName: 'Lieder', author: null,
 *   copyright: null, ccli: null, arrangements: [] });
 * ```
 */
export function songAnswer(song: SongFixture): HighestLevelAnswer {
  const made = new Map<string, Canary>();
  return answer(songOf(song, 'song', made), made);
}
