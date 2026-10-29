import { describe, expect, it } from 'vitest';

import { buildSearchIndex, type SerializedSearchIndex } from './build.js';
import {
  matchWeights,
  maxQueryWords,
  maxSearchHits,
  prepareSearch,
} from './query.js';
import { maxWordLength, words } from './words.js';

// The search of the docs index (ADR 0066): words, the stored index and the
// ranking, each with a case that shows the rule at work.

const title = [{ name: 'title', weight: 1 }] as const;

function index(...texts: readonly string[]): SerializedSearchIndex {
  return buildSearchIndex(
    title,
    texts.map((text, at) => ({ key: `doc-${String(at)}`, texts: [text] })),
  );
}

function keysFor(stored: SerializedSearchIndex, query: string): string[] {
  return prepareSearch(stored)
    .search(query, 10)
    .map(({ key }) => key);
}

describe('words', () => {
  it.each([
    [
      'an operationId',
      'getGroupsGroupIdMembers',
      ['get', 'groups', 'group', 'id', 'members'],
    ],
    ['capitals before a word', 'HTMLPage', ['html', 'page']],
    ['umlauts', 'Übersicht für Gruppen', ['ubersicht', 'gruppen']],
    ['sharp s', 'Straße STRASSE', ['strasse', 'strasse']],
    ['full-width letters', 'Ｇｒｕｐｐｅ', ['gruppe']],
    [
      'a path',
      '/api/groups/{groupId}/members',
      ['api', 'groups', 'group', 'id', 'members'],
    ],
    ['a right', 'churchdb: view alldata', ['churchdb', 'view', 'alldata']],
    ['digits', 'Version 3.138', ['version', '138']],
    [
      'stop words and single letters',
      'Die Liste der Gruppen und a b',
      ['liste', 'gruppen'],
    ],
  ])('splits %s', (_name, text, expected) => {
    expect(words(text)).toEqual(expected);
  });

  it(`cuts a word to ${String(maxWordLength)} letters without splitting one`, () => {
    expect(words('x'.repeat(100))).toEqual(['x'.repeat(maxWordLength)]);
    const astral = '𝐀'.repeat(50);
    const [cut] = words(astral);
    expect(Array.from(cut ?? '')).toHaveLength(maxWordLength);
  });
});

describe('buildSearchIndex', () => {
  it('stores sorted words with document, field and count', () => {
    const stored = buildSearchIndex(
      [
        { name: 'title', weight: 3 },
        { name: 'text', weight: 1 },
      ],
      [
        { key: 'a', texts: ['Gruppen', 'Gruppen sehen Gruppen'] },
        { key: 'b', texts: ['Rechte', 'sehen'] },
      ],
    );
    expect(stored).toEqual({
      fields: ['title', 'text'],
      weights: [3, 1],
      keys: ['a', 'b'],
      lengths: [
        [1, 3],
        [1, 1],
      ],
      terms: ['gruppen', 'rechte', 'sehen'],
      postings: [
        [0, 0, 1, 0, 1, 2],
        [1, 0, 1],
        [0, 1, 1, 1, 1, 1],
      ],
    });
  });

  it('gives the same bytes for the same documents', () => {
    const texts = ['Mitglieder einer Gruppe', 'Gruppen sehen', 'Rechte'];
    expect(JSON.stringify(index(...texts))).toBe(
      JSON.stringify(index(...texts)),
    );
  });

  it.each([
    [
      'unsorted keys',
      [
        { key: 'b', texts: ['x'] },
        { key: 'a', texts: ['y'] },
      ],
    ],
    [
      'a key twice',
      [
        { key: 'a', texts: ['x'] },
        { key: 'a', texts: ['y'] },
      ],
    ],
    ['a missing text', [{ key: 'a', texts: [] }]],
  ])('rejects %s', (_name, documents) => {
    expect(() => buildSearchIndex(title, documents)).toThrow(RangeError);
  });

  it.each([[0], [11], [1.5]])('rejects the weight %s', (weight) => {
    expect(() => buildSearchIndex([{ name: 'title', weight }], [])).toThrow(
      RangeError,
    );
  });

  it('rejects no fields', () => {
    expect(() => buildSearchIndex([], [])).toThrow(RangeError);
  });
});

describe('prepareSearch', () => {
  it('ranks a whole word over a start, a part and a typo', () => {
    const stored = index(
      'Gruppenmitglieder',
      'Mitgliederliste',
      'Mitglieder',
      'Mitgleider',
    );
    expect(keysFor(stored, 'Mitglieder')).toEqual([
      'doc-2',
      'doc-1',
      'doc-0',
      'doc-3',
    ]);
    expect(matchWeights.exact).toBeGreaterThan(matchWeights.prefix);
    expect(matchWeights.prefix).toBeGreaterThan(matchWeights.part);
  });

  it('finds a part only from four letters and a typo only from five', () => {
    const stored = index('Gruppenmitglieder', 'Rechte');
    expect(keysFor(stored, 'itgl')).toEqual(['doc-0']);
    expect(keysFor(stored, 'itg')).toEqual([]);
    expect(keysFor(stored, 'Rechet')).toEqual(['doc-1']);
    expect(keysFor(stored, 'Rcht')).toEqual([]);
  });

  it.each([
    ['a letter added', 'Rechtse'],
    ['a letter removed', 'Recte'],
    ['a letter replaced', 'Rechta'],
    ['two neighbours swapped', 'Rehcte'],
  ])('finds a word with %s', (_name, query) => {
    expect(keysFor(index('Rechte', 'Gruppen'), query)).toEqual(['doc-0']);
  });

  it('finds no word with two typos', () => {
    expect(keysFor(index('Rechte'), 'Rehcta')).toEqual([]);
  });

  it('weighs the fields', () => {
    const stored = buildSearchIndex(
      [
        { name: 'title', weight: 4 },
        { name: 'text', weight: 1 },
      ],
      [
        { key: 'a', texts: ['Anderes', 'Gruppen'] },
        { key: 'b', texts: ['Gruppen', 'Anderes'] },
      ],
    );
    expect(keysFor(stored, 'Gruppen')).toEqual(['b', 'a']);
  });

  it('ranks a document with more of the words higher', () => {
    const stored = index('Gruppen Gruppen Gruppen', 'Gruppen Mitglieder');
    expect(keysFor(stored, 'Gruppen Mitglieder')).toEqual(['doc-1', 'doc-0']);
  });

  it('counts only the best match of each query word', () => {
    const stored = index('grup gruppe gruppen gruppenleiter', 'grup');
    const [first, second] = prepareSearch(stored).search('grup', 10);
    expect(first?.score).toBeCloseTo(second?.score ?? 0, 0);
  });

  it('orders equal scores by key', () => {
    expect(keysFor(index('Rechte', 'Rechte', 'Rechte'), 'Rechte')).toEqual([
      'doc-0',
      'doc-1',
      'doc-2',
    ]);
  });

  it('returns nothing for a query without words or without matches', () => {
    const stored = index('Rechte');
    expect(keysFor(stored, 'der die das')).toEqual([]);
    expect(keysFor(stored, 'Kalender')).toEqual([]);
    expect(prepareSearch(index()).search('Rechte', 1)).toEqual([]);
  });

  it(`looks at no more than ${String(maxQueryWords)} words`, () => {
    const filler = Array.from(
      { length: maxQueryWords },
      (_v, at) => `wort${String(at)}`,
    );
    const stored = index('Rechte');
    expect(keysFor(stored, [...filler, 'Rechte'].join(' '))).toEqual([]);
    expect(keysFor(stored, ['Rechte', ...filler].join(' '))).toEqual(['doc-0']);
  });

  it.each([[0], [maxSearchHits + 1], [1.5]])(
    'rejects the limit %s',
    (limit) => {
      expect(() => prepareSearch(index('a')).search('a', limit)).toThrow(
        RangeError,
      );
    },
  );

  it('keeps to the limit', () => {
    expect(
      prepareSearch(index('Rechte', 'Rechte', 'Rechte')).search('Rechte', 2),
    ).toHaveLength(2);
  });

  it.each<[string, (stored: SerializedSearchIndex) => SerializedSearchIndex]>([
    ['no fields', (s) => ({ ...s, fields: [], weights: [] })],
    ['a weight too high', (s) => ({ ...s, weights: [11] })],
    ['lengths of another count', (s) => ({ ...s, lengths: [] })],
    ['a row of lengths too short', (s) => ({ ...s, lengths: [[], [1]] })],
    ['unsorted keys', (s) => ({ ...s, keys: [...s.keys].reverse() })],
    ['unsorted words', (s) => ({ ...s, terms: [...s.terms].reverse() })],
    ['postings of another count', (s) => ({ ...s, postings: [] })],
    ['an empty posting', (s) => ({ ...s, postings: s.postings.map(() => []) })],
    [
      'a document out of range',
      (s) => ({ ...s, postings: s.postings.map(() => [9, 0, 1]) }),
    ],
    [
      'a field out of range',
      (s) => ({ ...s, postings: s.postings.map(() => [0, 9, 1]) }),
    ],
    [
      'a count of zero',
      (s) => ({ ...s, postings: s.postings.map(() => [0, 0, 0]) }),
    ],
    [
      'postings out of order',
      (s) => ({ ...s, postings: s.postings.map(() => [1, 0, 1, 0, 0, 1]) }),
    ],
  ])('rejects an index with %s', (_name, change) => {
    const stored = index('Gruppen sehen', 'Rechte sehen');
    expect(() => prepareSearch(stored)).not.toThrow();
    expect(() => prepareSearch(change(stored))).toThrow(RangeError);
  });
});
