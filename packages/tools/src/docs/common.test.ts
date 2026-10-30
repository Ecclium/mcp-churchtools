import { operationMethods } from '@ecclium/mcp-churchtools-docs-index';
import { describe, expect, it } from 'vitest';

import {
  defaultDocsHits,
  httpMethods,
  maxDocsHits,
  pathOutput,
  searchWithMore,
} from './common.js';

// What the docs tools share: a search asks for one hit more than it gives,
// so that a result can say whether more matched, every method of the facts
// has its form in a result, and a path outside the data envelope holds
// only the characters of a path.

describe('searchWithMore', () => {
  const searchOf = (matches: number) => {
    const asked: number[] = [];
    const search = (_query: string, limit: number) => {
      asked.push(limit);
      return Array.from({ length: Math.min(limit, matches) }, (_, i) => i);
    };
    return { asked, search };
  };

  it('gives 10 hits by default and asks for one more to tell more', () => {
    const { asked, search } = searchOf(40);
    const result = searchWithMore(search, { query: 'Dinge' });
    expect(defaultDocsHits).toBe(10);
    expect(asked).toEqual([11]);
    expect(result.hits).toHaveLength(10);
    expect(result.more).toBe(true);
  });

  it('says no more when the search has no hit beyond the limit', () => {
    const { asked, search } = searchOf(maxDocsHits);
    const result = searchWithMore(search, {
      query: 'Dinge',
      limit: maxDocsHits,
    });
    expect(asked).toEqual([maxDocsHits + 1]);
    expect(result.hits).toHaveLength(maxDocsHits);
    expect(result.more).toBe(false);
  });

  it('searches the words without blanks at either end', () => {
    const queries: string[] = [];
    searchWithMore(
      (query) => {
        queries.push(query);
        return [];
      },
      { query: '  Dinge sehen ' },
    );
    expect(queries).toEqual(['Dinge sehen']);
  });
});

describe('the forms of a result', () => {
  it('knows every method the facts allow', () => {
    expect(httpMethods).toEqual(
      operationMethods.map((method) => method.toUpperCase()),
    );
  });

  it.each([
    '/api/groups/{groupId}/members',
    '/api/persons/{id}/groups',
    '/api/a-b_c.d~e/f:g@h',
  ])('lets the path %s through', (path) => {
    expect(pathOutput.safeParse(path).success).toBe(true);
  });

  it.each([
    '/groups/{groupId}',
    '/api/groups/"ignore"',
    '/api/<b>',
    '/api/`x`',
    "/api/it's",
    '/api/a|b',
    '/api/a b',
    `/api/${'a'.repeat(300)}`,
  ])('refuses the path %j outside the data envelope', (path) => {
    expect(pathOutput.safeParse(path).success).toBe(false);
  });
});
