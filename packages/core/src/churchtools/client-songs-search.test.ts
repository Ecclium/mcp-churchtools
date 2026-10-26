import { loadConfig } from '@ecclium/mcp-churchtools-core';
import {
  isEccliumError,
  type LogFields,
  type TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  assertNoCanary,
  assertPlanted,
  createChurchToolsDouble,
  doubleOrigin,
  globalSearchAnswer,
  makeCanary,
  type SearchHitFixture,
  songAnswer,
  type SongFixture,
  songsAnswer,
  type WikiSearchHitFixture,
  wikiSearchAnswer,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { createChurchToolsClient } from './client.js';

// The reads of songs, the search in the wiki and the global search
// (ADR 0064). Every request goes through the real transport on the
// ChurchTools double, which answers from interceptors and connects
// nowhere. Each answer holds a canary in every field the client does not
// pass on.

const loaded = loadConfig({
  environment: {
    ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
    ECCLIUM_CHURCHTOOLS_TOKEN: makeCanary('token').value,
  },
  transport: 'stdio',
});
if (!loaded.ok) throw new Error('the configuration of the test is invalid');
const token = loaded.config.churchtoolsToken;

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
});

interface Line {
  readonly event: string;
  readonly fields: LogFields | undefined;
}

// A clock that runs one second per reading.
const runningClock = () => {
  let now = 0;
  return Object.freeze({
    now: (): number => {
      now += 1_000;
      return now;
    },
  });
};

const setup = () => {
  const double = createChurchToolsDouble({ token });
  open.push(double);
  const client = createChurchToolsClient({
    transport: double.transport,
    origin: doubleOrigin,
    requestsPerMinute: 300,
    clock: runningClock(),
  });
  const lines: Line[] = [];
  const record = (event: string, fields?: LogFields): void => {
    lines.push({ event, fields });
  };
  const ctx = (): TenantContext =>
    Object.freeze({
      instance: doubleOrigin,
      signal: new AbortController().signal,
      log: Object.freeze({
        debug: record,
        info: record,
        warn: record,
        error: record,
      }),
      clock: runningClock(),
    }) as unknown as TenantContext;
  return { double, client, ctx, lines };
};

const json = { headers: { 'content-type': 'application/json' } };

const codeOf = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call;
  } catch (error) {
    if (isEccliumError(error)) return error.code;
    throw error;
  }
  throw new Error('expected the call to fail');
};

// The code and message of a call that fails.
const errorOf = async (
  call: Promise<unknown>,
): Promise<{ code: string; message: string }> => {
  try {
    await call;
  } catch (error) {
    if (isEccliumError(error)) {
      return { code: error.code, message: error.message };
    }
    throw error;
  }
  throw new Error('expected the call to fail');
};

const at = (pathname: string) => (path: string) =>
  path.split('?')[0] === pathname;

// An interceptor path that matches a pathname and keeps each path it sees
// with its query, so that a test reads every name of the query in order.
const recording = (pathname: string, seen: string[]) => (path: string) => {
  seen.push(path);
  return path.split('?')[0] === pathname;
};

const queryOf = (seen: readonly string[]) => {
  const last = seen.at(-1);
  return last === undefined
    ? []
    : [...new URL(last, doubleOrigin).searchParams];
};

const guid = '00000000-0000-4000-8000-000000000001';

const song = (id: number, extra: Partial<SongFixture> = {}): SongFixture => ({
  id,
  name: `Lied ${String(id)}`,
  categoryName: 'Lieder',
  author: 'Autor A',
  copyright: 'Verlag A',
  ccli: '1234567',
  arrangements: [
    { id: id * 10, name: 'Band', key: 'G', isDefault: false },
    { id: id * 10 + 1, name: 'Standard', key: null, isDefault: true },
  ],
  ...extra,
});

// The song as the client passes it on: the default arrangement first.
const read = (fixture: SongFixture) => ({
  id: fixture.id,
  name: fixture.name,
  categoryName: fixture.categoryName,
  author: fixture.author ?? null,
  copyright: fixture.copyright ?? null,
  ccli: fixture.ccli ?? null,
  arrangements: [
    ...fixture.arrangements.filter((entry) => entry.isDefault),
    ...fixture.arrangements.filter((entry) => !entry.isDefault),
  ].map((entry) => ({ ...entry, key: entry.key ?? null })),
});

describe('the search of songs', () => {
  it('asks with exactly query, page and limit and keeps only the fields of a song', async () => {
    const { double, client, ctx } = setup();
    const answer = songsAnswer([song(2), song(5)], 3);
    assertPlanted(JSON.parse(answer.body), answer.canaries, 'answer');
    const seen: string[] = [];
    double
      .intercept({ path: recording('/api/songs', seen), method: 'GET' })
      .reply(200, answer.body, json);
    const result = await client.searchSongs(ctx(), '  Lied ', 2);
    expect(result).toEqual({
      songs: [read(song(2)), read(song(5))],
      more: true,
    });
    assertNoCanary(result, answer.canaries, 'songs');
    expect(Object.isFrozen(result.songs[0]?.arrangements)).toBe(true);
    expect(Object.getPrototypeOf(result.songs[0])).toBeNull();
    expect(Object.getPrototypeOf(result.songs[0]?.arrangements[0])).toBeNull();
    expect(queryOf(seen)).toEqual([
      ['query', 'Lied'],
      ['page', '2'],
      ['limit', '10'],
    ]);
  });

  it('reads a missing author, copyright, CCLI number and key as none and keeps the default first', async () => {
    const { double, client, ctx } = setup();
    const bare = song(2, {
      author: undefined,
      copyright: null,
      ccli: undefined,
      arrangements: [
        { id: 3, name: 'A', isDefault: false },
        { id: 4, name: 'B', key: 'C', isDefault: false },
        { id: 5, name: 'C', key: null, isDefault: true },
      ],
    });
    double
      .intercept({ path: at('/api/songs'), method: 'GET' })
      .reply(200, songsAnswer([bare], 1).body, json);
    const result = await client.searchSongs(ctx(), 'Lied', 1);
    expect(result.songs[0]).toMatchObject({
      author: null,
      copyright: null,
      ccli: null,
    });
    expect(result.songs[0]?.arrangements.map((entry) => entry.id)).toEqual([
      5, 3, 4,
    ]);
    expect(result.songs[0]?.arrangements[1]?.key).toBeNull();
    expect(result.more).toBe(false);
  });

  it('reads more from the last page only, and takes an empty page without pagination as the last', async () => {
    const { double, client, ctx } = setup();
    double
      .intercept({ path: at('/api/songs'), method: 'GET' })
      .reply(200, songsAnswer([song(2)], 4).body, json);
    double
      .intercept({ path: at('/api/songs'), method: 'GET' })
      .reply(200, JSON.stringify({ data: [] }), json);
    double
      .intercept({ path: at('/api/songs'), method: 'GET' })
      .reply(200, JSON.stringify({ data: songsAnswer([song(2)], 1) }), json);
    expect((await client.searchSongs(ctx(), 'Lied', 4)).more).toBe(false);
    expect(await client.searchSongs(ctx(), 'Lied', 9)).toEqual({
      songs: [],
      more: false,
    });
    expect(await codeOf(client.searchSongs(ctx(), 'Lied', 1))).toBe('upstream');
  });

  it.each([
    ['a name of 256 characters', { name: 'x'.repeat(256) }],
    ['an author of 256 characters', { author: 'x'.repeat(256) }],
    ['a copyright of 256 characters', { copyright: 'x'.repeat(256) }],
    ['a CCLI number as a number', { ccli: 1234567 as unknown as string }],
    ['an ID of 0', { id: 0 }],
    [
      'a key of 33 characters',
      {
        arrangements: [
          { id: 3, name: 'A', key: 'x'.repeat(33), isDefault: true },
        ],
      },
    ],
    [
      '101 arrangements',
      {
        arrangements: Array.from({ length: 101 }, (_, index) => ({
          id: index + 1,
          name: 'A',
          isDefault: index === 0,
        })),
      },
    ],
  ])('gives upstream for a song with %s', async (_, change) => {
    const { double, client, ctx, lines } = setup();
    double
      .intercept({ path: at('/api/songs'), method: 'GET' })
      .reply(200, songsAnswer([song(2, change)], 1).body, json);
    expect(await codeOf(client.searchSongs(ctx(), 'Lied', 1))).toBe('upstream');
    expect(lines.map((line) => line.event)).toEqual([
      'churchtools_songs_refused',
    ]);
  });

  it('gives upstream for more songs than the limit asked for', async () => {
    const { double, client, ctx } = setup();
    double.intercept({ path: at('/api/songs'), method: 'GET' }).reply(
      200,
      songsAnswer(
        Array.from({ length: 11 }, (_, index) => song(index + 1)),
        2,
      ).body,
      json,
    );
    expect(await codeOf(client.searchSongs(ctx(), 'Lied', 1))).toBe('upstream');
  });

  it('maps 403 to permission', async () => {
    const { double, client, ctx } = setup();
    double
      .intercept({ path: at('/api/songs'), method: 'GET' })
      .reply(403, '{}', json);
    expect(await codeOf(client.searchSongs(ctx(), 'Lied', 1))).toBe(
      'permission',
    );
  });
});

describe('one song', () => {
  it('reads the fields of a search, the default arrangement first', async () => {
    const { double, client, ctx } = setup();
    const answer = songAnswer(song(7));
    assertPlanted(JSON.parse(answer.body), answer.canaries, 'answer');
    double
      .intercept({ path: '/api/songs/7', method: 'GET' })
      .reply(200, answer.body, json);
    const result = await client.song(ctx(), 7);
    expect(result).toEqual(read(song(7)));
    assertNoCanary(result, answer.canaries, 'song');
    expect(Object.isFrozen(result)).toBe(true);
    expect(double.calls()[0]?.searchParams).toEqual({});
  });

  it('gives upstream for another song than the one asked for', async () => {
    const { double, client, ctx, lines } = setup();
    double
      .intercept({ path: '/api/songs/7', method: 'GET' })
      .reply(200, songAnswer(song(8)).body, json);
    expect(await codeOf(client.song(ctx(), 7))).toBe('upstream');
    expect(lines.map((line) => line.event)).toEqual([
      'churchtools_song_refused',
    ]);
  });

  it('maps 404 to not_found and 403 to permission', async () => {
    const { double, client, ctx, lines } = setup();
    for (const status of [404, 403]) {
      double
        .intercept({ path: '/api/songs/7', method: 'GET' })
        .reply(status, '{}', json);
    }
    expect(await codeOf(client.song(ctx(), 7))).toBe('not_found');
    expect(await codeOf(client.song(ctx(), 7))).toBe('permission');
    expect(lines.map((line) => line.event)).toEqual([
      'churchtools_song_missing',
      'churchtools_song_status',
    ]);
  });
});

const page = (
  title: string,
  extra: Partial<WikiSearchHitFixture> = {},
): WikiSearchHitFixture => ({
  domainType: 'wiki_page',
  domainIdentifier: guid,
  wikiCategoryId: 12,
  title,
  preview: `Ein Teil von ${title}`,
  ...extra,
});

describe('the search in the wiki', () => {
  it('asks with exactly query and keeps GUID, category, title and preview', async () => {
    const { double, client, ctx } = setup();
    const answer = wikiSearchAnswer([page('Seite A'), page('Seite B')]);
    assertPlanted(JSON.parse(answer.body), answer.canaries, 'answer');
    const seen: string[] = [];
    double
      .intercept({ path: recording('/api/wiki/search', seen), method: 'GET' })
      .reply(200, answer.body, json);
    const result = await client.searchWiki(ctx(), 'Seite');
    expect(result).toEqual({
      hits: [
        {
          guid,
          categoryId: 12,
          title: 'Seite A',
          preview: 'Ein Teil von Seite A',
        },
        {
          guid,
          categoryId: 12,
          title: 'Seite B',
          preview: 'Ein Teil von Seite B',
        },
      ],
      more: false,
    });
    assertNoCanary(result, answer.canaries, 'wiki search');
    expect(Object.getPrototypeOf(result.hits[0])).toBeNull();
    expect(queryOf(seen)).toEqual([['query', 'Seite']]);
  });

  it('asks with one category in wiki_category_ids[] when given', async () => {
    const { double, client, ctx } = setup();
    const seen: string[] = [];
    double
      .intercept({ path: recording('/api/wiki/search', seen), method: 'GET' })
      .reply(200, wikiSearchAnswer([page('Seite A')]).body, json);
    await client.searchWiki(ctx(), 'Seite', 12);
    expect(queryOf(seen)).toEqual([
      ['query', 'Seite'],
      ['wiki_category_ids[]', '12'],
    ]);
  });

  it('gives no GUID for another form of identifier and no category for none, null, a list or a number below 1', async () => {
    const { double, client, ctx } = setup();
    double
      .intercept({ path: at('/api/wiki/search'), method: 'GET' })
      .reply(
        200,
        wikiSearchAnswer([
          page('A', { domainIdentifier: '42' }),
          page('B', { domainIdentifier: 'Seite B' }),
          page('C', { wikiCategoryId: undefined, preview: undefined }),
          page('D', { wikiCategoryId: null, preview: null }),
          page('E', { wikiCategoryId: 0 }),
        ]).body.replace('"title":"C"', '"title":"C","domainAttributes":[]'),
        json,
      );
    const result = await client.searchWiki(ctx(), 'Seite');
    expect(result.hits.map((hit) => [hit.guid, hit.categoryId])).toEqual([
      [null, 12],
      [null, 12],
      [guid, null],
      [guid, null],
      [guid, null],
    ]);
    expect(result.hits.map((hit) => hit.preview)).toEqual([
      'Ein Teil von A',
      'Ein Teil von B',
      null,
      null,
      'Ein Teil von E',
    ]);
  });

  it('gives 20 with more for 21 in the order of ChurchTools, and says what to do for 1001', async () => {
    const { double, client, ctx } = setup();
    double
      .intercept({ path: at('/api/wiki/search'), method: 'GET' })
      .reply(
        200,
        wikiSearchAnswer(
          Array.from({ length: 21 }, (_, index) =>
            page(`S${String(21 - index)}`),
          ),
        ).body,
        json,
      );
    double
      .intercept({ path: at('/api/wiki/search'), method: 'GET' })
      .reply(
        200,
        JSON.stringify({ data: Array.from({ length: 1001 }, () => ({})) }),
        json,
      );
    const more = await client.searchWiki(ctx(), 'Seite');
    expect([more.hits.length, more.more]).toEqual([20, true]);
    expect(more.hits[0]?.title).toBe('S21');
    const error = await errorOf(client.searchWiki(ctx(), 'Seite'));
    expect(error.code).toBe('upstream');
    expect(error.message).toContain('or in one category.');
  });

  it.each([
    ['a hit of another type', { domainType: 'person' }],
    [
      'a hit of another category than the one asked for',
      { wikiCategoryId: 13 },
    ],
  ])('gives upstream for %s', async (_, change) => {
    const { double, client, ctx, lines } = setup();
    double
      .intercept({ path: at('/api/wiki/search'), method: 'GET' })
      .reply(200, wikiSearchAnswer([page('A'), page('B', change)]).body, json);
    expect(await codeOf(client.searchWiki(ctx(), 'Seite', 12))).toBe(
      'upstream',
    );
    expect(lines.map((line) => line.event)).toEqual([
      'churchtools_wiki_search_foreign',
    ]);
  });

  it.each([
    ['a title of 256 characters', { title: 'x'.repeat(256) }],
    ['a preview of 1001 characters', { preview: 'x'.repeat(1001) }],
    ['an identifier as a number', { domainIdentifier: 42 }],
    ['a category as text', { wikiCategoryId: '12' }],
  ])('gives upstream for a hit with %s', async (_, change) => {
    const { double, client, ctx, lines } = setup();
    double
      .intercept({ path: at('/api/wiki/search'), method: 'GET' })
      .reply(200, wikiSearchAnswer([page('A', change)]).body, json);
    expect(await codeOf(client.searchWiki(ctx(), 'Seite'))).toBe('upstream');
    expect(lines.map((line) => line.event)).toEqual([
      'churchtools_wiki_search_refused',
    ]);
  });

  it('maps 403 to permission', async () => {
    const { double, client, ctx } = setup();
    double
      .intercept({ path: at('/api/wiki/search'), method: 'GET' })
      .reply(403, '{}', json);
    expect(await codeOf(client.searchWiki(ctx(), 'Seite', 12))).toBe(
      'permission',
    );
  });
});

const hit = (
  domainType: string,
  domainIdentifier: string | number,
  title: string,
): SearchHitFixture => ({ domainType, domainIdentifier, title });

describe('the global search', () => {
  it.each([
    [
      'person',
      [hit('person', '2', 'Person A'), hit('person', '3', 'Person B')],
      [
        { id: 2, guid: null, title: 'Person A' },
        { id: 3, guid: null, title: 'Person B' },
      ],
    ],
    [
      'group',
      [hit('group', '4', 'Gruppe A'), hit('group', 'x4', 'Gruppe B')],
      [
        { id: 4, guid: null, title: 'Gruppe A' },
        { id: null, guid: null, title: 'Gruppe B' },
      ],
    ],
    [
      'song',
      [hit('song', '5', 'Lied A'), hit('song', '05', 'Lied B')],
      [
        { id: 5, guid: null, title: 'Lied A' },
        { id: null, guid: null, title: 'Lied B' },
      ],
    ],
    [
      'wiki_page',
      [hit('wiki_page', guid, 'Seite A'), hit('wiki_page', '6', 'Seite B')],
      [
        { id: null, guid, title: 'Seite A' },
        { id: null, guid: null, title: 'Seite B' },
      ],
    ],
  ] as const)(
    'asks for exactly one type %s and keeps only ID or GUID and title',
    async (type, hits, expected) => {
      const { double, client, ctx } = setup();
      const answer = globalSearchAnswer(type, hits);
      assertPlanted(JSON.parse(answer.body), answer.canaries, 'answer');
      const seen: string[] = [];
      double
        .intercept({ path: recording('/api/search', seen), method: 'GET' })
        .reply(200, answer.body, json);
      const result = await client.search(ctx(), type, ' Suche ');
      expect(result).toEqual({ type, hits: expected, more: false });
      assertNoCanary(result, answer.canaries, 'global search');
      expect(Object.getPrototypeOf(result.hits[0])).toBeNull();
      expect(queryOf(seen)).toEqual([
        ['query', 'Suche'],
        ['domain_types[]', type],
      ]);
    },
  );

  it('takes the title of a person up to 511 characters, of every other type up to 255', async () => {
    const { double, client, ctx } = setup();
    const long = 'x'.repeat(511);
    double
      .intercept({ path: at('/api/search'), method: 'GET' })
      .reply(
        200,
        globalSearchAnswer('person', [hit('person', '2', long)]).body,
        json,
      );
    double
      .intercept({ path: at('/api/search'), method: 'GET' })
      .reply(
        200,
        globalSearchAnswer('group', [hit('group', '2', 'x'.repeat(256))]).body,
        json,
      );
    double
      .intercept({ path: at('/api/search'), method: 'GET' })
      .reply(
        200,
        globalSearchAnswer('person', [hit('person', '2', `${long}x`)]).body,
        json,
      );
    expect((await client.search(ctx(), 'person', 'x')).hits[0]?.title).toBe(
      long,
    );
    expect(await codeOf(client.search(ctx(), 'group', 'x'))).toBe('upstream');
    expect(await codeOf(client.search(ctx(), 'person', 'x'))).toBe('upstream');
  });

  it.each([
    ['without a whole number from 1', '0'],
    ['with a number of 17 digits', '12345678901234567'],
    ['with a GUID', guid],
  ])('gives upstream for a person %s', async (_, identifier) => {
    const { double, client, ctx, lines } = setup();
    double
      .intercept({ path: at('/api/search'), method: 'GET' })
      .reply(
        200,
        globalSearchAnswer('person', [hit('person', identifier, 'Person A')])
          .body,
        json,
      );
    expect(await codeOf(client.search(ctx(), 'person', 'Person'))).toBe(
      'upstream',
    );
    expect(lines.map((line) => line.event)).toEqual([
      'churchtools_search_refused',
    ]);
  });

  it.each([
    ['a person in a search of songs', 'song', 'person'],
    ['a song in a search of persons', 'person', 'song'],
    ['an action in a search of groups', 'group', 'action'],
  ] as const)('gives upstream for %s', async (_, type, other) => {
    const { double, client, ctx, lines } = setup();
    double
      .intercept({ path: at('/api/search'), method: 'GET' })
      .reply(
        200,
        globalSearchAnswer(type, [
          hit(type, '2', 'A'),
          hit(other, '3', 'Person B'),
        ]).body,
        json,
      );
    expect(await codeOf(client.search(ctx(), type, 'A'))).toBe('upstream');
    expect(lines.map((line) => line.event)).toEqual([
      'churchtools_search_foreign',
    ]);
  });

  it('gives 50 with more for 51 in the order of ChurchTools, and says what to do for 1001', async () => {
    const { double, client, ctx } = setup();
    double.intercept({ path: at('/api/search'), method: 'GET' }).reply(
      200,
      globalSearchAnswer(
        'song',
        Array.from({ length: 51 }, (_, index) =>
          hit('song', String(51 - index), 'Lied'),
        ),
      ).body,
      json,
    );
    double
      .intercept({ path: at('/api/search'), method: 'GET' })
      .reply(
        200,
        JSON.stringify({ data: Array.from({ length: 1001 }, () => ({})) }),
        json,
      );
    const more = await client.search(ctx(), 'song', 'Lied');
    expect([more.hits.length, more.more, more.hits[0]?.id]).toEqual([
      50,
      true,
      51,
    ]);
    const error = await errorOf(client.search(ctx(), 'song', 'Lied'));
    expect(error.code).toBe('upstream');
    expect(error.message).toContain('more specific term.');
  });

  // A 400 means a request the client built wrongly, as for action alone
  // (F39): an error of Ecclium, not of ChurchTools.
  it('maps 403 to permission and 400 to internal', async () => {
    const { double, client, ctx } = setup();
    for (const status of [403, 400]) {
      double
        .intercept({ path: at('/api/search'), method: 'GET' })
        .reply(status, '{}', json);
    }
    expect(await codeOf(client.search(ctx(), 'group', 'A'))).toBe('permission');
    expect(await codeOf(client.search(ctx(), 'group', 'A'))).toBe('internal');
  });
});

// The types forbid most of these; a plugin built without them can still
// pass them. Only a checked term, page, ID, category and type fill a query
// or a path.
describe('the checks before any request', () => {
  it.each([
    '',
    '   ',
    'x'.repeat(101),
    'a\nb',
    '\uD800',
    7 as unknown as string,
  ])('refuses the term %j for every search', async (term) => {
    const { double, client, ctx, lines } = setup();
    expect(await codeOf(client.searchSongs(ctx(), term, 1))).toBe('validation');
    expect(await codeOf(client.searchWiki(ctx(), term))).toBe('validation');
    expect(await codeOf(client.search(ctx(), 'song', term))).toBe('validation');
    expect(double.calls()).toHaveLength(0);
    expect(lines.map((line) => line.event)).toEqual([
      'churchtools_search_term_refused',
      'churchtools_search_term_refused',
      'churchtools_search_term_refused',
    ]);
  });

  it.each([0, -1, 1.5, 1001, Number.NaN, '2' as unknown as number])(
    'refuses the page %j of a search of songs',
    async (value) => {
      const { double, client, ctx } = setup();
      expect(await codeOf(client.searchSongs(ctx(), 'Lied', value))).toBe(
        'validation',
      );
      expect(double.calls()).toHaveLength(0);
    },
  );

  it.each([
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    '7' as unknown as number,
    '7/../../whoami' as unknown as number,
  ])(
    'refuses the ID %j of a song and the category %j of the wiki',
    async (value) => {
      const { double, client, ctx, lines } = setup();
      expect(await codeOf(client.song(ctx(), value))).toBe('validation');
      expect(await codeOf(client.searchWiki(ctx(), 'Seite', value))).toBe(
        'validation',
      );
      expect(double.calls()).toHaveLength(0);
      expect(lines.map((line) => line.event)).toEqual([
        'churchtools_song_input_refused',
        'churchtools_search_input_refused',
      ]);
    },
  );

  it.each(['action', 'Person', 'persons', '', 'person&domain_types[]=action'])(
    'refuses the type %j of the global search',
    async (type) => {
      const { double, client, ctx } = setup();
      expect(
        await codeOf(client.search(ctx(), type as 'person', 'Person')),
      ).toBe('validation');
      expect(double.calls()).toHaveLength(0);
    },
  );
});
