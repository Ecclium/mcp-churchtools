import {
  createToolCatalog,
  createToolPipeline,
  loadConfig,
  type ToolCatalog,
  type ToolPipelineOptions,
  type ToolRequest,
} from '@ecclium/mcp-churchtools-core';
import {
  type Plugin,
  type ReadApi,
  type TenantAssignment,
  type TenantContext,
  type ToolDefinition,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  assertNoCanary,
  assertPlanted,
  createChurchToolsDouble,
  createMemoryQuotaStore,
  doubleOrigin,
  globalSearchAnswer,
  makeCanaries,
  type SearchHitFixture,
  songAnswer,
  type SongFixture,
  songsAnswer,
  type WikiSearchHitFixture,
  wikiSearchAnswer,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { createCorePlugin } from './core-plugin.js';
import { moreHitsMatched, noHitMatched, searchTool } from './search/global.js';
import { songsGetTool } from './songs/get.js';
import { songNotFound, songRefused } from './songs/rights.js';
import {
  emptySongPageMoreFollow,
  noSongMatched,
  noSongOnFirstPage,
  pastLastSongPage,
  songsSearchTool,
} from './songs/search.js';
import {
  morePagesMatched,
  noPageMatched,
  wikiSearchRefused,
  wikiSearchTool,
} from './wiki/search.js';

// The reads of songs, the search in the wiki and the global search of
// ADR 0064 run through the pipeline of the core on the double of
// ChurchTools, as the server runs them, with the toolsets persons, wiki
// and songs and an audit file. The three layers are the client, which
// reads only the fields of its schema, the tool, which declares and copies
// only them, and the pipeline, which lets nothing through that the output
// schema does not declare.

type AuditSink = ToolPipelineOptions['audit'];
type AuditDraft = Parameters<AuditSink['record']>[0];
type LineWriter = ToolPipelineOptions['logging']['writer'];

const canary = makeCanaries();
const loaded = loadConfig({
  environment: {
    ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
    ECCLIUM_CHURCHTOOLS_TOKEN: canary.token.value,
  },
  transport: 'stdio',
});
if (!loaded.ok) throw new Error('the configuration of the test is invalid');

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
});

const json = { headers: { 'content-type': 'application/json' } };
const at = (pathname: string) => (path: string) =>
  path.split('?')[0] === pathname;

const request = (): ToolRequest => ({
  assignment: {
    tenantId: 'default',
    actor: { kind: 'user', id: 'stdio:local-stdio' },
  } as unknown as TenantAssignment,
  mode: 'interactive',
  redaction: 'standard',
  readOnly: true,
  features: [],
  signal: new AbortController().signal,
});

const coreCatalog = (): ToolCatalog =>
  createToolCatalog({
    core: createCorePlugin(),
    toolsets: new Set(['persons', 'wiki', 'songs'] as const),
    plugins: [],
    readOnly: true,
  });

const setup = (catalog: ToolCatalog = coreCatalog(), ready = true) => {
  const double = createChurchToolsDouble({
    token: loaded.config.churchtoolsToken,
  });
  open.push(double);
  const lines: string[] = [];
  const drafts: AuditDraft[] = [];
  const quota = new Map<string, number>();
  const writer: LineWriter = Object.freeze({
    write: (line: string) => {
      lines.push(line);
      return true;
    },
  });
  const audit: AuditSink = Object.freeze({
    record: (draft: AuditDraft) => {
      drafts.push(draft);
      return true;
    },
    hasFile: true,
    ready: () => ready,
    failures: () => 0,
  });
  const pipeline = createToolPipeline({
    quota: createMemoryQuotaStore(quota),
    catalog,
    audit,
    transport: double.transport,
    origin: doubleOrigin,
    requestsPerMinute: 300,
    clock: Object.freeze({ now: Object.freeze(() => 0) }),
    logging: { writer, minLevel: 'debug' },
  });
  const call = (name: string, input: unknown) =>
    pipeline.call(name, input, request());
  return { double, lines, drafts, quota, call };
};

// A text in the data envelope: the markers with the boundary of the call
// around it.
const enveloped = (text: string): unknown =>
  expect.stringMatching(
    new RegExp(
      `^<<data-[^>]+>>${text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}<</data-[^>]+>>$`,
      'u',
    ),
  ) as unknown;

const guid = '00000000-0000-4000-8000-000000000001';

const song = (id: number, extra: Partial<SongFixture> = {}): SongFixture => ({
  id,
  name: `Lied ${String(id)}`,
  categoryName: 'Lieder',
  author: 'Autor A',
  copyright: null,
  ccli: '1234567',
  arrangements: [
    { id: id * 10, name: 'Band', key: 'G', isDefault: false },
    { id: id * 10 + 1, name: 'Standard', key: null, isDefault: true },
  ],
  ...extra,
});

// The song as a result gives it: texts in the envelope, the default
// arrangement first.
const songResult = (id: number) => ({
  id,
  name: enveloped(`Lied ${String(id)}`),
  category: enveloped('Lieder'),
  author: enveloped('Autor A'),
  copyright: null,
  ccli: enveloped('1234567'),
  arrangements: [
    {
      id: id * 10 + 1,
      name: enveloped('Standard'),
      key: null,
      isDefault: true,
    },
    {
      id: id * 10,
      name: enveloped('Band'),
      key: enveloped('G'),
      isDefault: false,
    },
  ],
  moreArrangements: false,
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

const hit = (
  domainType: string,
  domainIdentifier: string,
  title: string,
): SearchHitFixture => ({ domainType, domainIdentifier, title });

const empty = { persons: [], groups: [], songs: [], wikiPages: [] };

describe('the three layers together', () => {
  it('let no field of the songs of a search but the declared ones reach result, log or audit', async () => {
    const { double, lines, drafts, call } = setup();
    const answer = songsAnswer([song(2), song(5)], 1);
    assertPlanted(JSON.parse(answer.body), answer.canaries, 'answer');
    double
      .intercept({ path: at('/api/songs'), method: 'GET' })
      .reply(200, answer.body, json);
    const outcome = await call('ct_songs_search', { query: 'Lied' });
    expect(outcome.ok && outcome.data).toEqual({
      page: 1,
      songs: [songResult(2), songResult(5)],
      more: false,
      notice: null,
    });
    assertNoCanary(
      [outcome, lines, drafts],
      answer.canaries,
      'result, log, audit',
    );
    expect(drafts).toEqual([
      expect.objectContaining({ tool: 'ct_songs_search', outcome: 'ok' }),
    ]);
  });

  it('let no field of one song but the declared ones reach result, log or audit', async () => {
    const { double, lines, drafts, call } = setup();
    const answer = songAnswer(song(7));
    assertPlanted(JSON.parse(answer.body), answer.canaries, 'answer');
    double
      .intercept({ path: '/api/songs/7', method: 'GET' })
      .reply(200, answer.body, json);
    const outcome = await call('ct_songs_get', { songId: 7 });
    expect(outcome.ok && outcome.data).toEqual(songResult(7));
    assertNoCanary(
      [outcome, lines, drafts],
      answer.canaries,
      'result, log, audit',
    );
  });

  it('let no field of the hits of the wiki but the four reach result, log or audit', async () => {
    const { double, lines, drafts, call } = setup();
    const answer = wikiSearchAnswer([
      page('Seite A'),
      page('Seite B', { domainIdentifier: '42', preview: null }),
    ]);
    assertPlanted(JSON.parse(answer.body), answer.canaries, 'answer');
    double
      .intercept({ path: at('/api/wiki/search'), method: 'GET' })
      .reply(200, answer.body, json);
    const outcome = await call('ct_wiki_search', {
      query: 'Seite',
      categoryId: 12,
    });
    expect(outcome.ok && outcome.data).toEqual({
      hits: [
        {
          guid,
          categoryId: 12,
          title: enveloped('Seite A'),
          preview: enveloped('Ein Teil von Seite A'),
        },
        {
          guid: null,
          categoryId: 12,
          title: enveloped('Seite B'),
          preview: null,
        },
      ],
      more: false,
      notice: null,
    });
    assertNoCanary(
      [outcome, lines, drafts],
      answer.canaries,
      'result, log, audit',
    );
  });

  it.each([
    [
      'person',
      [hit('person', '2', 'Person A')],
      { persons: [{ personId: 2, name: 'Person A' }] },
    ],
    [
      'group',
      [hit('group', '4', 'Gruppe A')],
      { groups: [{ id: 4, name: enveloped('Gruppe A') }] },
    ],
    [
      'song',
      [hit('song', '5', 'Lied A')],
      { songs: [{ id: 5, name: enveloped('Lied A') }] },
    ],
    [
      'wiki_page',
      [hit('wiki_page', guid, 'Seite A')],
      { wikiPages: [{ guid, title: enveloped('Seite A') }] },
    ],
  ] as const)(
    'let no field of a hit of the type %s but ID or GUID and title reach result, log or audit',
    async (type, hits, filled) => {
      const { double, lines, drafts, call } = setup();
      const answer = globalSearchAnswer(type, hits);
      assertPlanted(JSON.parse(answer.body), answer.canaries, 'answer');
      double
        .intercept({ path: at('/api/search'), method: 'GET' })
        .reply(200, answer.body, json);
      const outcome = await call('ct_search', { type, query: 'Suche' });
      expect(outcome.ok && outcome.data).toEqual({
        type,
        ...empty,
        ...filled,
        more: false,
        notice: null,
      });
      assertNoCanary(
        [outcome, lines, drafts],
        answer.canaries,
        'result, log, audit',
      );
    },
  );
});

describe('the four tools in the catalog', () => {
  it('count only the global search against the read budget', async () => {
    const { double, quota, call } = setup();
    double
      .intercept({ path: at('/api/songs'), method: 'GET' })
      .reply(200, songsAnswer([song(2)], 1).body, json);
    double
      .intercept({ path: at('/api/wiki/search'), method: 'GET' })
      .reply(200, wikiSearchAnswer([page('A')]).body, json);
    expect((await call('ct_songs_search', { query: 'Lied' })).ok).toBe(true);
    expect((await call('ct_wiki_search', { query: 'A' })).ok).toBe(true);
    expect([...quota.values()]).toEqual([]);
    double
      .intercept({ path: at('/api/search'), method: 'GET' })
      .reply(200, globalSearchAnswer('song', []).body, json);
    expect((await call('ct_search', { type: 'song', query: 'A' })).ok).toBe(
      true,
    );
    expect([...quota.values()]).toEqual([1]);
  });

  // The global search waits for its line in the audit file like every
  // search of persons; the gate refuses it before a request when the file
  // is not ready (ADR 0028).
  it('refuses the global search without a ready audit file, before any request, and runs the others', async () => {
    const { double, call } = setup(coreCatalog(), false);
    double
      .intercept({ path: at('/api/wiki/search'), method: 'GET' })
      .reply(200, wikiSearchAnswer([page('A')]).body, json);
    const refused = await call('ct_search', { type: 'song', query: 'A' });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error.code).toBe('policy_denied');
    expect((await call('ct_wiki_search', { query: 'A' })).ok).toBe(true);
    expect(double.calls().map((entry) => entry.path)).toEqual([
      '/api/wiki/search',
    ]);
  });
});

describe('ct_songs_search', () => {
  it('names the right for an empty first page and says what an empty later page means', async () => {
    const { double, call } = setup();
    for (const [lastPage, count] of [
      [0, 0],
      [3, 0],
      [3, 0],
      [2, 0],
    ] as const) {
      double.intercept({ path: at('/api/songs'), method: 'GET' }).reply(
        200,
        songsAnswer(
          Array.from({ length: count }, (_, index) => song(index + 1)),
          lastPage,
        ).body,
        json,
      );
    }
    const first = await call('ct_songs_search', { query: 'Lied' });
    expect(first.ok && first.data.notice).toBe(noSongMatched);
    expect(noSongMatched).toContain('"view songcategory" in churchservice');
    // An empty first page names the right also when further pages follow.
    const firstOfMany = await call('ct_songs_search', { query: 'Lied' });
    expect(
      firstOfMany.ok && [firstOfMany.data.notice, firstOfMany.data.more],
    ).toEqual([noSongOnFirstPage, true]);
    expect(noSongOnFirstPage).toContain('"view songcategory" in churchservice');
    const between = await call('ct_songs_search', { query: 'Lied', page: 2 });
    expect(between.ok && [between.data.notice, between.data.more]).toEqual([
      emptySongPageMoreFollow,
      true,
    ]);
    const past = await call('ct_songs_search', { query: 'Lied', page: 4 });
    expect(past.ok && past.data.notice).toBe(pastLastSongPage);
  });

  it('gives the first three arrangements, the default first, and says when a song has more', async () => {
    const { double, call } = setup();
    double.intercept({ path: at('/api/songs'), method: 'GET' }).reply(
      200,
      songsAnswer(
        [
          song(2, {
            arrangements: Array.from({ length: 5 }, (_, index) => ({
              id: index + 1,
              name: `A${String(index + 1)}`,
              key: null,
              isDefault: index === 4,
            })),
          }),
        ],
        1,
      ).body,
      json,
    );
    const outcome = await call('ct_songs_search', { query: 'Lied' });
    const found = outcome.ok
      ? (outcome.data['songs'] as readonly Record<string, unknown>[])[0]
      : undefined;
    expect(
      (found?.['arrangements'] as readonly { id: number }[]).map(
        (entry) => entry.id,
      ),
    ).toEqual([5, 1, 2]);
    expect(found?.['moreArrangements']).toBe(true);
  });

  it('refuses an empty term and a term of spaces without a request', async () => {
    const { double, call } = setup();
    for (const query of ['', '   ']) {
      const outcome = await call('ct_songs_search', { query });
      expect(!outcome.ok && outcome.error.code).toBe('validation');
    }
    expect(double.calls()).toHaveLength(0);
  });
});

describe('ct_songs_get', () => {
  it('names the right for 403 and the search for 404', async () => {
    const { double, call } = setup();
    for (const status of [403, 404]) {
      double
        .intercept({ path: '/api/songs/7', method: 'GET' })
        .reply(status, '{}', json);
    }
    const refused = await call('ct_songs_get', { songId: 7 });
    expect(!refused.ok && [refused.error.code, refused.error.message]).toEqual([
      'permission',
      songRefused,
    ]);
    const missing = await call('ct_songs_get', { songId: 7 });
    expect(!missing.ok && [missing.error.code, missing.error.message]).toEqual([
      'not_found',
      songNotFound,
    ]);
  });

  it('gives 20 arrangements and says when the song has more', async () => {
    const { double, call } = setup();
    double.intercept({ path: '/api/songs/7', method: 'GET' }).reply(
      200,
      songAnswer(
        song(7, {
          arrangements: Array.from({ length: 21 }, (_, index) => ({
            id: index + 1,
            name: 'A',
            key: null,
            isDefault: index === 0,
          })),
        }),
      ).body,
      json,
    );
    const outcome = await call('ct_songs_get', { songId: 7 });
    expect(outcome.ok && outcome.data['arrangements']).toHaveLength(20);
    expect(outcome.ok && outcome.data['moreArrangements']).toBe(true);
  });
});

describe('ct_wiki_search', () => {
  it('says that a missing right may hide pages, and when more matched', async () => {
    const { double, call } = setup();
    double
      .intercept({ path: at('/api/wiki/search'), method: 'GET' })
      .reply(200, wikiSearchAnswer([]).body, json);
    double
      .intercept({ path: at('/api/wiki/search'), method: 'GET' })
      .reply(
        200,
        wikiSearchAnswer(
          Array.from({ length: 21 }, (_, index) => page(`S${String(index)}`)),
        ).body,
        json,
      );
    const none = await call('ct_wiki_search', { query: 'Seite' });
    expect(none.ok && none.data.notice).toBe(noPageMatched);
    expect(noPageMatched).toContain('"view category" in churchwiki');
    const many = await call('ct_wiki_search', { query: 'Seite' });
    expect(many.ok && [many.data.notice, many.data.more]).toEqual([
      morePagesMatched,
      true,
    ]);
    expect(many.ok && many.data['hits']).toHaveLength(20);
  });

  it('names both rights of the wiki for 403', async () => {
    const { double, call } = setup();
    double
      .intercept({ path: at('/api/wiki/search'), method: 'GET' })
      .reply(403, '{}', json);
    const refused = await call('ct_wiki_search', {
      query: 'Seite',
      categoryId: 12,
    });
    expect(!refused.ok && [refused.error.code, refused.error.message]).toEqual([
      'permission',
      wikiSearchRefused,
    ]);
  });
});

describe('ct_search', () => {
  it.each(['person', 'group', 'song', 'wiki_page'] as const)(
    'names the rights of the type %s for an empty result',
    async (type) => {
      const { double, call } = setup();
      double
        .intercept({ path: at('/api/search'), method: 'GET' })
        .reply(200, globalSearchAnswer(type, []).body, json);
      const outcome = await call('ct_search', { type, query: 'A' });
      expect(outcome.ok && outcome.data.notice).toBe(noHitMatched[type]);
    },
  );

  it('names the right of each type in its note', () => {
    expect(noHitMatched.person).toContain('"view alldata" in churchdb');
    expect(noHitMatched.group).toContain(
      '"view groups of grouptype" in churchgroup',
    );
    expect(noHitMatched.song).toContain('"view songcategory" in churchservice');
    expect(noHitMatched.wiki_page).toContain(
      '"view" in churchwiki and "view category" in churchwiki',
    );
  });

  it('gives 50 hits and says when more matched', async () => {
    const { double, call } = setup();
    double.intercept({ path: at('/api/search'), method: 'GET' }).reply(
      200,
      globalSearchAnswer(
        'group',
        Array.from({ length: 51 }, (_, index) =>
          hit('group', String(index + 1), 'Gruppe'),
        ),
      ).body,
      json,
    );
    const outcome = await call('ct_search', { type: 'group', query: 'A' });
    expect(outcome.ok && outcome.data['groups']).toHaveLength(50);
    expect(outcome.ok && [outcome.data.more, outcome.data.notice]).toEqual([
      true,
      moreHitsMatched,
    ]);
  });

  it('names the rights of the type asked for when ChurchTools refuses', async () => {
    const { double, call } = setup();
    double
      .intercept({ path: at('/api/search'), method: 'GET' })
      .reply(403, '{}', json);
    const refused = await call('ct_search', { type: 'song', query: 'A' });
    expect(!refused.ok && refused.error.code).toBe('permission');
    expect(!refused.ok && refused.error.message).toContain(
      '"view songcategory" in churchservice',
    );
  });

  it('refuses action and an unknown type without a request', async () => {
    const { double, call } = setup();
    for (const type of ['action', 'persons', 'Person']) {
      const outcome = await call('ct_search', { type, query: 'A' });
      expect(!outcome.ok && outcome.error.code).toBe('validation');
    }
    expect(double.calls()).toHaveLength(0);
  });
});

describe('the layer of the tools', () => {
  const leak = makeCanaries();
  const ctx = {} as TenantContext;
  const bare = {
    id: 2,
    name: 'Lied 2',
    categoryName: 'Lieder',
    author: null,
    copyright: null,
    ccli: null,
  };
  const leakySong = {
    ...bare,
    note: leak.name.value,
    arrangements: [
      {
        id: 3,
        name: 'Standard',
        key: null,
        isDefault: true,
        files: [leak.token.value],
      },
    ],
  };
  const kept = {
    id: 2,
    name: 'Lied 2',
    category: 'Lieder',
    author: null,
    copyright: null,
    ccli: null,
    arrangements: [{ id: 3, name: 'Standard', key: null, isDefault: true }],
    moreArrangements: false,
  };

  it('copies only the declared fields of a song of a search', async () => {
    const read = {
      searchSongs: () => Promise.resolve({ songs: [leakySong], more: false }),
    } as unknown as ReadApi;
    const result = await songsSearchTool.execute({
      ctx,
      input: { query: 'Lied' },
      read,
    });
    expect(result.songs).toEqual([kept]);
    assertNoCanary(result, leak.all, 'result of the tool');
  });

  it('copies only the declared fields of one song', async () => {
    const read = {
      song: () => Promise.resolve(leakySong),
    } as unknown as ReadApi;
    const result = await songsGetTool.execute({
      ctx,
      input: { songId: 2 },
      read,
    });
    expect(result).toEqual(kept);
    assertNoCanary(result, leak.all, 'result of the tool');
  });

  it('copies only the four fields of a hit of the wiki', async () => {
    const read = {
      searchWiki: () =>
        Promise.resolve({
          hits: [
            {
              guid,
              categoryId: 12,
              title: 'Seite A',
              preview: null,
              frontendUrl: leak.token.value,
            },
          ],
          more: false,
        }),
    } as unknown as ReadApi;
    const result = await wikiSearchTool.execute({
      ctx,
      input: { query: 'Seite' },
      read,
    });
    expect(result.hits).toEqual([
      { guid, categoryId: 12, title: 'Seite A', preview: null },
    ]);
    assertNoCanary(result, leak.all, 'result of the tool');
  });

  it('copies only ID and title of a hit, and only into the list of its type', async () => {
    const read = {
      search: () =>
        Promise.resolve({
          type: 'person',
          hits: [
            {
              id: 2,
              guid: null,
              title: 'Person A',
              email: leak.email.value,
            },
          ],
          more: false,
        }),
    } as unknown as ReadApi;
    const result = await searchTool.execute({
      ctx,
      input: { type: 'person', query: 'Person' },
      read,
    });
    expect(result).toEqual({
      type: 'person',
      ...empty,
      persons: [{ personId: 2, name: 'Person A' }],
      more: false,
      notice: null,
    });
    assertNoCanary(result, leak.all, 'result of the tool');
  });

  it('refuses a person without an ID and hits of another type than the one asked for', async () => {
    for (const result of [
      { type: 'person', hits: [{ id: null, guid: null, title: 'P' }] },
      { type: 'song', hits: [{ id: 2, guid: null, title: 'P' }] },
    ]) {
      const read = {
        search: () => Promise.resolve({ ...result, more: false }),
      } as unknown as ReadApi;
      const error: unknown = await searchTool
        .execute({ ctx, input: { type: 'person', query: 'P' }, read })
        .catch((thrown: unknown) => thrown);
      expect(error).toMatchObject({ code: 'upstream' });
    }
  });
});

// The layer of the pipeline alone: a tool with the schemas of a read whose
// execute returns more than they declare, as a broken client and a broken
// tool together would. The pipeline drops every field the output schema
// does not declare.
describe('the layer of the pipeline', () => {
  const leak = makeCanaries();
  const leaky = (tool: ToolDefinition, result: unknown): ToolCatalog =>
    createToolCatalog({
      core: {
        name: '@ecclium/test-songs-search',
        version: '0.0.0',
        register(host): undefined {
          host.addTool({ ...tool, execute: () => Promise.resolve(result) });
          return undefined;
        },
      } satisfies Plugin,
      plugins: [],
      readOnly: true,
      toolsets: new Set(['persons', 'wiki', 'songs'] as const),
    });

  it.each([
    [
      'ct_songs_get',
      songsGetTool,
      { songId: 2 },
      {
        id: 2,
        name: 'Lied 2',
        category: 'Lieder',
        author: null,
        copyright: null,
        ccli: null,
        arrangements: [
          {
            id: 3,
            name: 'Standard',
            key: null,
            isDefault: true,
            links: [leak.token.value],
          },
        ],
        moreArrangements: false,
        note: leak.name.value,
      },
      {
        id: 2,
        name: enveloped('Lied 2'),
        category: enveloped('Lieder'),
        author: null,
        copyright: null,
        ccli: null,
        arrangements: [
          { id: 3, name: enveloped('Standard'), key: null, isDefault: true },
        ],
        moreArrangements: false,
      },
    ],
    [
      'ct_search',
      searchTool,
      { type: 'person', query: 'P' },
      {
        type: 'person',
        ...empty,
        persons: [{ personId: 2, name: 'Person A', email: leak.email.value }],
        more: false,
        notice: null,
        infos: [leak.phone.value],
      },
      {
        type: 'person',
        ...empty,
        persons: [{ personId: 2, name: 'Person A' }],
        more: false,
        notice: null,
      },
    ],
  ] as const)(
    'drops every field %s does not declare',
    async (name, tool, input, result, keptFields) => {
      const { lines, drafts, call } = setup(leaky(tool, result));
      const outcome = await call(name, input);
      expect(outcome.ok && outcome.data).toEqual(keptFields);
      assertNoCanary([outcome, lines, drafts], leak.all, 'result, log, audit');
    },
  );

  // The output schemas take a GUID only in its form, so no other
  // identifier passes outside the data envelope (ADR 0064).
  it.each([
    [
      'ct_wiki_search',
      wikiSearchTool,
      { query: 'Seite' },
      {
        hits: [{ guid: '42', categoryId: 12, title: 'A', preview: null }],
        more: false,
        notice: null,
      },
    ],
    [
      'ct_search',
      searchTool,
      { type: 'wiki_page', query: 'Seite' },
      {
        type: 'wiki_page',
        ...empty,
        wikiPages: [{ guid: leak.name.value, title: 'A' }],
        more: false,
        notice: null,
      },
    ],
  ] as const)(
    'refuses a GUID of another form from %s',
    async (name, tool, input, result) => {
      const { lines, drafts, call } = setup(leaky(tool, result));
      const outcome = await call(name, input);
      expect(outcome.ok).toBe(false);
      assertNoCanary([outcome, lines, drafts], leak.all, 'result, log, audit');
    },
  );
});

// A refusal and a missing object end with a fixed message: the body of
// such an answer, which ChurchTools fills with its own texts, reaches
// neither the result nor the log nor the audit.
describe('the body of a refusal', () => {
  const leak = makeCanaries();
  const body = JSON.stringify({
    message: leak.name.value,
    translatedMessage: leak.email.value,
    messageKey: leak.phone.value,
    args: { first: leak.token.value, second: leak.name.value },
    errors: [],
  });

  it.each([
    ['ct_songs_search', '/api/songs', { query: 'Lied' }],
    ['ct_songs_get', '/api/songs/7', { songId: 7 }],
    ['ct_wiki_search', '/api/wiki/search', { query: 'Seite' }],
    ['ct_search', '/api/search', { type: 'person', query: 'Person' }],
  ] as const)(
    'stays out of %s for 400, 403 and 404',
    async (name, pathname, input) => {
      for (const status of [400, 403, 404]) {
        const { double, lines, drafts, call } = setup();
        double
          .intercept({ path: at(pathname), method: 'GET' })
          .reply(status, body, json);
        const outcome = await call(name, input);
        expect(outcome.ok).toBe(false);
        assertNoCanary(
          [outcome, lines, drafts],
          leak.all,
          'result, log, audit',
        );
      }
    },
  );
});

// The largest results the limits allow still fit into one result of 64
// KiB (ADR 0024): one song with every text and 20 arrangements of quotes,
// which the two copies of the result each escape, and the lists with texts
// of letters. Longer texts beyond ASCII in a full page of a list can
// exceed it; the call then ends with an error, as for the search tools
// (ADR 0060, ADR 0064).
describe('the largest results', () => {
  const quotes = (count: number) => '"'.repeat(count);
  const letters = (count: number) => 'a'.repeat(count);
  const full = (text: (count: number) => string, id: number, count: number) =>
    song(id, {
      name: text(255),
      categoryName: text(255),
      author: text(255),
      copyright: text(255),
      ccli: text(255),
      arrangements: Array.from({ length: count }, (_, index) => ({
        id: index + 1,
        name: text(255),
        key: text(32),
        isDefault: index === 0,
      })),
    });

  it('passes a song with texts of quotes and 20 arrangements', async () => {
    const { double, call } = setup();
    double
      .intercept({ path: '/api/songs/7', method: 'GET' })
      .reply(200, songAnswer(full(quotes, 7, 21)).body, json);
    const outcome = await call('ct_songs_get', { songId: 7 });
    expect(outcome.ok && outcome.data['arrangements']).toHaveLength(20);
  });

  it('passes a page of 10 songs with every text of 255 letters and 3 arrangements each', async () => {
    const { double, call } = setup();
    double.intercept({ path: at('/api/songs'), method: 'GET' }).reply(
      200,
      songsAnswer(
        Array.from({ length: 10 }, (_, index) => full(letters, index + 1, 4)),
        2,
      ).body,
      json,
    );
    const outcome = await call('ct_songs_search', { query: 'Lied' });
    expect(outcome.ok && outcome.data['songs']).toHaveLength(10);
  });

  it('passes 20 hits of the wiki with titles of 255 and previews of 1000 letters', async () => {
    const { double, call } = setup();
    double
      .intercept({ path: at('/api/wiki/search'), method: 'GET' })
      .reply(
        200,
        wikiSearchAnswer(
          Array.from({ length: 21 }, () =>
            page(letters(255), { preview: letters(1000) }),
          ),
        ).body,
        json,
      );
    const outcome = await call('ct_wiki_search', { query: 'Seite' });
    expect(outcome.ok && outcome.data['hits']).toHaveLength(20);
  });

  it.each([
    ['person', '2', 511],
    ['group', '2', 255],
    ['song', '2', 255],
    ['wiki_page', guid, 255],
  ] as const)(
    'passes 50 hits of the type %s with the longest titles of letters',
    async (type, identifier, length) => {
      const { double, call } = setup();
      double.intercept({ path: at('/api/search'), method: 'GET' }).reply(
        200,
        globalSearchAnswer(
          type,
          Array.from({ length: 51 }, () =>
            hit(type, identifier, letters(length)),
          ),
        ).body,
        json,
      );
      const outcome = await call('ct_search', { type, query: 'a' });
      expect(outcome.ok).toBe(true);
      expect(outcome.ok && [outcome.data.more]).toEqual([true]);
    },
  );
});
