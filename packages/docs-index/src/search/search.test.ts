import { describe, expect, it } from 'vitest';

import { buildSearchIndex, type SerializedSearchIndex } from './build.js';
import {
  matchWeights,
  maxQueryLength,
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

  it('finds a word of four letters with one typo only from five', () => {
    expect(keysFor(index('Recht'), 'Rcht')).toEqual([]);
    expect(keysFor(index('Recht'), 'Rechz')).toEqual(['doc-0']);
  });

  it('ranks a whole word over a rarer word that starts with it', () => {
    const texts = [
      ...Array.from({ length: 10 }, () => 'Gruppe Termine'),
      'Gruppenleiter Termine',
    ];
    const stored = buildSearchIndex(
      title,
      texts.map((text, at) => ({
        key: `d${String(at).padStart(2, '0')}`,
        texts: [text],
      })),
    );
    const [first] = prepareSearch(stored).search('Gruppe', 11);
    expect(first?.key).toBe('d00');
  });

  it('ranks a short field over a long one with the same word', () => {
    expect(
      keysFor(
        index('Gruppen viele weitere Wörter dabei', 'Gruppen'),
        'Gruppen',
      ),
    ).toEqual(['doc-1', 'doc-0']);
  });

  it('weighs a field most documents lack like any other', () => {
    const stored = buildSearchIndex(
      [
        { name: 'name', weight: 4 },
        { name: 'label', weight: 4 },
      ],
      [
        ...Array.from({ length: 30 }, (_v, at) => ({
          key: `k${String(at).padStart(2, '0')}`,
          texts: [`wort${String(at)}`, ''],
        })),
        { key: 'm-label', texts: ['anders', 'Mitglieder'] },
        { key: 'm-name', texts: ['Mitglieder', ''] },
      ],
    );
    const hits = prepareSearch(stored).search('Mitglieder', 2);
    const label = hits.find(({ key }) => key === 'm-label')?.score ?? 0;
    const name = hits.find(({ key }) => key === 'm-name')?.score ?? 0;
    expect(label / name).toBeGreaterThan(0.5);
    expect(label / name).toBeLessThan(2);
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

  it('scores by the share of query words a document matches', () => {
    const searcher = prepareSearch(index('Gruppen', 'Rechte'));
    const [whole] = searcher.search('Gruppen', 1);
    const [half] = searcher.search('Gruppen Kalender', 1);
    expect(half?.key).toBe('doc-0');
    expect(half?.score).toBeCloseTo((whole?.score ?? 0) / 2, 10);
  });

  it('counts only the best match of each query word', () => {
    const stored = index('grup gruppe gruppen gruppenleiter', 'grup');
    const hits = prepareSearch(stored).search('grup', 10);
    const many = hits.find(({ key }) => key === 'doc-0')?.score ?? 0;
    const one = hits.find(({ key }) => key === 'doc-1')?.score ?? 0;
    // Four matching words in a longer text do not add up past one word.
    expect(many / one).toBeLessThan(1.5);
  });

  it('orders equal scores by key, whichever word found them first', () => {
    expect(keysFor(index('alpha', 'beta'), 'beta alpha')).toEqual([
      'doc-0',
      'doc-1',
    ]);
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

  it(`looks at no more than ${String(maxQueryLength)} characters`, () => {
    const stored = index('Rechte');
    const filler = 'x'.repeat(maxQueryLength);
    expect(keysFor(stored, `${filler} Rechte`)).toEqual([]);
    expect(keysFor(stored, `Rechte ${filler}`)).toEqual(['doc-0']);
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

  // The escape hatch searches only the operations it reads (ADR 0067). The
  // others drop out before the limit, so a better one elsewhere does not
  // push them out.
  it('ranks only the documents asked for, before the limit', () => {
    const searcher = prepareSearch(
      index('Gruppen Gruppen Mitglieder', 'Gruppen Mitglieder', 'Gruppen'),
    );
    expect(searcher.search('Gruppen Mitglieder', 1)[0]?.key).not.toBe('doc-2');
    expect(
      searcher
        .search('Gruppen Mitglieder', 1, new Set(['doc-2']))
        .map(({ key }) => key),
    ).toEqual(['doc-2']);
    expect(searcher.search('Gruppen', 10, new Set())).toEqual([]);
    expect(
      searcher.search('Gruppen', 10, new Set(['doc-1', 'doc-9'])),
    ).toHaveLength(1);
  });

  it.each<[string, (stored: SerializedSearchIndex) => SerializedSearchIndex]>([
    ['no fields', (s) => ({ ...s, fields: [], weights: [] })],
    ['a weight too high', (s) => ({ ...s, weights: [11] })],
    ['more weights than fields', (s) => ({ ...s, weights: [1, 1] })],
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
