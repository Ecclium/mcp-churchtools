import {
  type GroupHit,
  isEccliumError,
  type Me,
  type PersonHit,
  type SearchHits,
  type TenantContext,
  type WikiCategory,
  type WikiPage,
  type WikiPageList,
} from '@ecclium/mcp-churchtools-plugin-api';
import { describe, expect, it } from 'vitest';

import { createReadAccess } from './read-api.js';

type Client = Parameters<typeof createReadAccess>[0];

const me: Me = { id: 1, firstName: 'Person', lastName: 'A', email: null };
const persons: SearchHits<PersonHit> = {
  hits: [{ id: 2, firstName: 'Person', lastName: 'B' }],
  more: false,
};
const groups: SearchHits<GroupHit> = {
  hits: [{ id: 3, name: 'Gruppe A' }],
  more: true,
};
const guid = '00000000-0000-4000-8000-000000000001';
const categories: readonly WikiCategory[] = [{ id: 4, name: 'Kategorie A' }];
const pages: WikiPageList = {
  pages: [{ guid, title: 'Seite A', isMarkdown: true, version: 2 }],
  more: false,
};
const page: WikiPage = {
  guid,
  title: 'Seite A',
  isMarkdown: true,
  version: 2,
  text: 'Text',
};
const lines: string[] = [];
const ctx = Object.freeze({
  instance: 'https://example.church.tools',
  log: Object.freeze({
    debug: (event: string) => lines.push(event),
    info: (event: string) => lines.push(event),
    warn: (event: string) => lines.push(event),
    error: (event: string) => lines.push(event),
  }),
}) as unknown as TenantContext;

const fakeClient = () => {
  const seen: TenantContext[] = [];
  const queries: string[] = [];
  const wiki: unknown[][] = [];
  const client: Client = {
    whoami: (context) => {
      seen.push(context);
      return Promise.resolve(me);
    },
    permissions: (context) => {
      seen.push(context);
      return Promise.resolve({ kind: 'unknown' });
    },
    searchPersons: (context, query) => {
      seen.push(context);
      queries.push(query);
      return Promise.resolve(persons);
    },
    searchGroups: (context, query) => {
      seen.push(context);
      queries.push(query);
      return Promise.resolve(groups);
    },
    wikiCategories: (context) => {
      seen.push(context);
      return Promise.resolve(categories);
    },
    wikiPages: (context, categoryId, number) => {
      seen.push(context);
      wiki.push([categoryId, number]);
      return Promise.resolve(pages);
    },
    wikiPage: (context, categoryId, id, version) => {
      seen.push(context);
      wiki.push([categoryId, id, version]);
      return Promise.resolve(page);
    },
  };
  return { client, seen, queries, wiki };
};

describe('createReadAccess', () => {
  it('reads with the context of the call', async () => {
    const { client, seen, queries } = fakeClient();
    const access = createReadAccess(client, ctx, 'special');
    await expect(access.read.whoami()).resolves.toBe(me);
    await expect(access.read.permissions()).resolves.toEqual({
      kind: 'unknown',
    });
    await expect(access.read.searchPersons('Person')).resolves.toBe(persons);
    await expect(access.read.searchGroups('Gruppe')).resolves.toBe(groups);
    expect(seen).toEqual([ctx, ctx, ctx, ctx]);
    expect(queries).toEqual(['Person', 'Gruppe']);
  });

  it('is frozen and without prototype', () => {
    const access = createReadAccess(fakeClient().client, ctx, 'special');
    expect(Object.isFrozen(access)).toBe(true);
    expect(Object.isFrozen(access.read)).toBe(true);
    expect(Object.getPrototypeOf(access.read)).toBeNull();
  });

  it.each(['special', 'none'] as const)(
    'rejects every method with internal after revoke, without reading, for %s',
    async (sensitivity) => {
      const { client, seen } = fakeClient();
      const access = createReadAccess(client, ctx, sensitivity);
      const { read } = access;
      access.revoke();
      for (const call of [
        read.whoami(),
        read.permissions(),
        read.searchPersons('Person'),
        read.searchGroups('Gruppe'),
        read.wikiCategories(),
        read.wikiPages(4, 1),
        read.wikiPage(4, guid),
      ]) {
        const error: unknown = await call.catch((thrown: unknown) => thrown);
        expect(isEccliumError(error) && error.code).toBe('internal');
      }
      expect(seen).toEqual([]);
    },
  );

  // Persons and groups only for a tool of the sensitivity special, whose
  // result waits for its audit line and which never runs unattended
  // (ADR 0028, ADR 0060).
  it.each(['none', 'personal'] as const)(
    'refuses both searches to a tool of the sensitivity %s, without reading',
    async (sensitivity) => {
      lines.length = 0;
      const { client, seen } = fakeClient();
      const { read } = createReadAccess(client, ctx, sensitivity);
      for (const call of [
        read.searchPersons('Person'),
        read.searchGroups('Gruppe'),
      ]) {
        const error: unknown = await call.catch((thrown: unknown) => thrown);
        expect(isEccliumError(error) && error.code).toBe('policy_denied');
      }
      await expect(read.whoami()).resolves.toBe(me);
      expect(seen).toEqual([ctx]);
      expect(lines).toEqual(['read_search_refused', 'read_search_refused']);
    },
  );

  // The wiki is no special data: a tool of every sensitivity reads it,
  // with the context of the call and the arguments as given.
  it.each(['none', 'personal', 'special'] as const)(
    'reads the wiki for a tool of the sensitivity %s',
    async (sensitivity) => {
      const { client, seen, wiki } = fakeClient();
      const { read } = createReadAccess(client, ctx, sensitivity);
      await expect(read.wikiCategories()).resolves.toBe(categories);
      await expect(read.wikiPages(4, 2)).resolves.toBe(pages);
      await expect(read.wikiPage(4, guid)).resolves.toBe(page);
      await expect(read.wikiPage(4, guid, 3)).resolves.toBe(page);
      expect(seen).toEqual([ctx, ctx, ctx, ctx]);
      expect(wiki).toEqual([
        [4, 2],
        [4, guid, undefined],
        [4, guid, 3],
      ]);
    },
  );
});
