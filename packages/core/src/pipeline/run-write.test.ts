import {
  EccliumError,
  type RightRef,
  type TenantContext,
  type WikiPage,
  type WikiPageEntry,
  type WikiPageList,
} from '@ecclium/mcp-churchtools-plugin-api';
import { describe, expect, it } from 'vitest';

import { checkPolicy } from '../policy/check.js';
import type { CatalogEntry, ToolCatalog } from '../registry/index.js';
import {
  maxRunPageListPages,
  resolveRunPage,
  runNeedsOf,
} from './run-write.js';

// The client as resolveRunPage takes it; the raw client stays out of the
// tests of the pipeline, as of every module outside core's own list.
type RunPageClient = Parameters<typeof resolveRunPage>[0];

// The page a run writes its section to and the rights its account may
// have (ADR 0032, ADR 0033), with a client and a catalog built by hand.

const ctx = { tenantId: 'demo-tenant' } as unknown as TenantContext;
const guid = '0000000a-0000-4000-8000-000000000001';
const upperGuid = '0000000A-0000-4000-8000-00000000000B';
const otherGuid = '0000000c-0000-4000-8000-000000000003';

const entryOf = (title: string, id = guid, version = 3): WikiPageEntry => ({
  guid: id,
  title,
  isMarkdown: true,
  version,
});

const listOf = (
  pages: readonly WikiPageEntry[],
  more = false,
): WikiPageList => ({ pages, more });

// A client that answers a read of a page as told, and the pages of the
// list of a category one after the other; it notes every call.
const clientOf = (
  options: {
    page?: () => Promise<WikiPage>;
    lists?: readonly WikiPageList[];
  } = {},
) => {
  const calls: (readonly unknown[])[] = [];
  const client: RunPageClient = {
    wikiPage: (_ctx, categoryId, id) => {
      calls.push(['wikiPage', categoryId, id]);
      return options.page === undefined
        ? Promise.reject(new Error('no page in this test'))
        : options.page();
    },
    wikiPages: (_ctx, categoryId, page) => {
      calls.push(['wikiPages', categoryId, page]);
      return Promise.resolve(options.lists?.[page - 1] ?? listOf([]));
    },
  };
  return { client, calls };
};

const pageOf = (version: number): WikiPage => ({
  ...entryOf('Dienstplan', guid, version),
  text: '# Dienstplan',
});

describe('the page of a write of a run, by its GUID', () => {
  it('is read with its version now, its GUID in lower case', async () => {
    const { client, calls } = clientOf({
      page: () => Promise.resolve(pageOf(7)),
    });
    const found = await resolveRunPage(client, ctx, {
      categoryId: 12,
      guid: upperGuid,
    });
    expect(found).toEqual({
      ok: true,
      categoryId: 12,
      guid: upperGuid.toLowerCase(),
      version: 7,
    });
    expect(Object.isFrozen(found)).toBe(true);
    expect(calls).toEqual([['wikiPage', 12, upperGuid]]);
  });

  it('is missing when the client finds no such page', async () => {
    const { client } = clientOf({
      page: () => Promise.reject(new EccliumError('not_found')),
    });
    const found = await resolveRunPage(client, ctx, { categoryId: 12, guid });
    expect(found).toEqual({ ok: false, reason: 'missing' });
    expect(Object.isFrozen(found)).toBe(true);
    // A plain value with the code as its own data counts the same.
    const plain = clientOf({
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a client that rejects with no error
      page: () => Promise.reject({ code: 'not_found' }),
    });
    expect(
      await resolveRunPage(plain.client, ctx, { categoryId: 12, guid }),
    ).toEqual({ ok: false, reason: 'missing' });
  });

  it('passes on every other error of the read', async () => {
    const network = new EccliumError('network');
    const { client } = clientOf({ page: () => Promise.reject(network) });
    await expect(
      resolveRunPage(client, ctx, { categoryId: 12, guid }),
    ).rejects.toBe(network);
    const plain = new Error('socket');
    await expect(
      resolveRunPage(
        clientOf({ page: () => Promise.reject(plain) }).client,
        ctx,
        { categoryId: 12, guid },
      ),
    ).rejects.toBe(plain);
  });

  it.each([
    ['a text', 'not_found'],
    ['null', null],
    ['undefined', undefined],
  ])(
    'passes on %s that a client rejects with, without reading it as not_found',
    async (_name, thrown) => {
      const { client } = clientOf({
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a client that rejects with no error
        page: () => Promise.reject(thrown),
      });
      await expect(
        resolveRunPage(client, ctx, { categoryId: 12, guid }),
      ).rejects.toBe(thrown);
    },
  );

  it('passes on an error whose code is a getter, without running it', async () => {
    let read = false;
    const error = new Error('with a getter');
    Object.defineProperty(error, 'code', {
      get: () => {
        read = true;
        return 'not_found';
      },
    });
    const { client } = clientOf({ page: () => Promise.reject(error) });
    await expect(
      resolveRunPage(client, ctx, { categoryId: 12, guid }),
    ).rejects.toBe(error);
    expect(read).toBe(false);
  });
});

describe('the page of a write of a run, by its title', () => {
  const byTitle = { categoryId: 12, title: 'Dienstplan' };

  it('is the one page of the category with that title', async () => {
    const { client, calls } = clientOf({
      lists: [
        listOf([
          entryOf('Archiv', otherGuid),
          entryOf('Dienstplan', upperGuid, 9),
        ]),
      ],
    });
    const found = await resolveRunPage(client, ctx, byTitle);
    expect(found).toEqual({
      ok: true,
      categoryId: 12,
      guid: upperGuid.toLowerCase(),
      version: 9,
    });
    expect(Object.isFrozen(found)).toBe(true);
    expect(calls).toEqual([['wikiPages', 12, 1]]);
  });

  it('compares titles in the normal form NFC, both ways', async () => {
    const composed = 'Präsenzliste';
    const decomposed = composed.normalize('NFD');
    expect(decomposed).not.toBe(composed);
    const nfdList = clientOf({ lists: [listOf([entryOf(decomposed)])] });
    expect(
      await resolveRunPage(nfdList.client, ctx, {
        categoryId: 12,
        title: composed,
      }),
    ).toMatchObject({ ok: true, guid });
    const nfcList = clientOf({ lists: [listOf([entryOf(composed)])] });
    expect(
      await resolveRunPage(nfcList.client, ctx, {
        categoryId: 12,
        title: decomposed,
      }),
    ).toMatchObject({ ok: true, guid });
  });

  it.each([
    ['in other case', 'dienstplan'],
    ['with a space at its end', 'Dienstplan '],
    ['that only starts the same', 'Dienstplan 2026'],
  ])('is missing when the only page has the title %s', async (_name, title) => {
    const { client } = clientOf({ lists: [listOf([entryOf(title)])] });
    expect(await resolveRunPage(client, ctx, byTitle)).toEqual({
      ok: false,
      reason: 'missing',
    });
  });

  it('is missing in an empty category', async () => {
    const { client, calls } = clientOf();
    expect(await resolveRunPage(client, ctx, byTitle)).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(calls).toEqual([['wikiPages', 12, 1]]);
  });

  it('reads every page of the list, an empty one included, to find it once', async () => {
    const { client, calls } = clientOf({
      lists: [
        listOf([entryOf('Archiv', otherGuid)], true),
        listOf([], true),
        listOf([entryOf('Dienstplan')], false),
      ],
    });
    expect(await resolveRunPage(client, ctx, byTitle)).toMatchObject({
      ok: true,
      guid,
    });
    expect(calls).toEqual([
      ['wikiPages', 12, 1],
      ['wikiPages', 12, 2],
      ['wikiPages', 12, 3],
    ]);
  });

  it('is ambiguous when two pages share the title, on one page of the list or on two', async () => {
    const onOne = clientOf({
      lists: [
        listOf([entryOf('Dienstplan'), entryOf('Dienstplan', otherGuid)]),
      ],
    });
    expect(await resolveRunPage(onOne.client, ctx, byTitle)).toEqual({
      ok: false,
      reason: 'ambiguous',
    });
    const onTwo = clientOf({
      lists: [
        listOf([entryOf('Dienstplan')], true),
        listOf([entryOf('Dienstplan'.normalize('NFD'), otherGuid)], false),
      ],
    });
    expect(await resolveRunPage(onTwo.client, ctx, byTitle)).toEqual({
      ok: false,
      reason: 'ambiguous',
    });
  });

  it(`is missing in a category longer than ${String(maxRunPageListPages)} pages of the list, found or not`, async () => {
    expect(maxRunPageListPages).toBe(40);
    const { client, calls } = clientOf({
      lists: Array.from({ length: maxRunPageListPages + 1 }, (_, index) =>
        listOf(index === 0 ? [entryOf('Dienstplan')] : [], true),
      ),
    });
    expect(await resolveRunPage(client, ctx, byTitle)).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(calls).toHaveLength(maxRunPageListPages);
    expect(calls.at(-1)).toEqual(['wikiPages', 12, maxRunPageListPages]);
  });

  it(`finds the page on the last of ${String(maxRunPageListPages)} pages of the list`, async () => {
    const { client, calls } = clientOf({
      lists: Array.from({ length: maxRunPageListPages }, (_, index) =>
        index === maxRunPageListPages - 1
          ? listOf([entryOf('Dienstplan')], false)
          : listOf([], true),
      ),
    });
    expect(await resolveRunPage(client, ctx, byTitle)).toMatchObject({
      ok: true,
      guid,
    });
    expect(calls).toHaveLength(maxRunPageListPages);
  });

  it('passes on an error of the list', async () => {
    const error = new EccliumError('network');
    const client: RunPageClient = {
      wikiPage: () => Promise.reject(new Error('not read in this test')),
      wikiPages: () => Promise.reject(error),
    };
    await expect(resolveRunPage(client, ctx, byTitle)).rejects.toBe(error);
  });
});

describe('the needs of the account of a run', () => {
  const wikiView: RightRef = { module: 'churchwiki', right: 'view' };
  const wikiEdit: RightRef = { module: 'churchwiki', right: 'edit category' };
  const eventsView: RightRef = { module: 'churchservice', right: 'view' };

  // A catalog of the tools of the test, each with its required rights.
  const catalogOf = (
    tools: Readonly<Record<string, readonly RightRef[]>>,
  ): Pick<ToolCatalog, 'get'> => ({
    get: (name) => {
      const requiredRights = tools[name];
      return requiredRights === undefined
        ? undefined
        : ({ name, meta: { requiredRights } } as unknown as CatalogEntry);
    },
  });
  const catalog = catalogOf({
    ct_events_list: [eventsView],
    ct_wiki_page_append_section: [wikiView, wikiEdit],
    ct_wiki_categories_list: [],
  });

  const policy = (() => {
    const result = checkPolicy({
      schema: 'policy.v1',
      unattended: [
        {
          routine: 'dienstplan-report',
          credential: 'bericht',
          target: { kind: 'wiki_category', id: 12, name: 'Berichte' },
          tools: ['ct_wiki_page_append_section'],
          maxPerRun: 1,
          maxPerDay: 2,
        },
        {
          routine: 'wiki-hygiene',
          credential: 'bericht',
          target: {
            kind: 'wiki_page',
            categoryId: 13,
            guid,
            name: 'Dienstplan',
          },
          tools: ['ct_wiki_page_append_section'],
          maxPerRun: 1,
          maxPerDay: 2,
        },
        {
          routine: 'kalender-report',
          credential: 'kalender',
          target: { kind: 'wiki_category', id: 14, name: 'Kalender' },
          tools: ['ct_wiki_page_append_section'],
          maxPerRun: 1,
          maxPerDay: 2,
        },
      ],
    });
    if (!result.ok) throw new Error(result.code);
    return result.policy;
  })();

  it('are the rights of its tools and the categories of every entry with its alias', () => {
    const needs = runNeedsOf(catalog, policy, 'dienstplan-report', [
      'ct_events_list',
      'ct_wiki_categories_list',
      'ct_wiki_page_append_section',
    ]);
    expect(needs?.rights).toEqual([eventsView, wikiView, wikiEdit]);
    // Category 13 of another routine with the same account, not 14 of
    // another account.
    expect([...(needs?.editCategories ?? [])]).toEqual([12, 13]);
    expect(Object.isFrozen(needs)).toBe(true);
    expect(Object.isFrozen(needs?.rights)).toBe(true);
  });

  it('take the categories of the entries of another account by its own alias', () => {
    const needs = runNeedsOf(catalog, policy, 'kalender-report', [
      'ct_wiki_page_append_section',
    ]);
    expect([...(needs?.editCategories ?? [])]).toEqual([14]);
  });

  it('have no categories for a routine without entries', () => {
    const needs = runNeedsOf(catalog, policy, 'unbekannt', ['ct_events_list']);
    expect(needs?.rights).toEqual([eventsView]);
    expect(needs?.editCategories.size).toBe(0);
  });

  it('have no rights without tools', () => {
    expect(
      runNeedsOf(catalog, policy, 'dienstplan-report', [])?.rights,
    ).toEqual([]);
  });

  it('are none when a tool is not in the catalog', () => {
    expect(
      runNeedsOf(catalog, policy, 'dienstplan-report', [
        'ct_events_list',
        'ct_unknown_tool',
      ]),
    ).toBeUndefined();
  });
});
