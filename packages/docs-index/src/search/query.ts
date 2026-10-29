/**
 * The search over one source of the docs index (ADR 0066). A query word
 * matches a word of the index whole, as its start, from
 * {@link minPartLength} letters on as a part of it, which finds
 * «mitglieder» in «gruppenmitglieder», and from {@link minTypoLength}
 * letters on with one typo. Each kind of match counts less than the one
 * before. Each matching word scores by BM25 in every field it stands in,
 * times the weight of the field; for each query word only its best
 * matching word counts, so that a short prefix with many matches does not
 * outweigh a whole word. A document that matches more of the query words
 * ranks higher, and equal scores go by key.
 *
 * @packageDocumentation
 */
import type { SerializedSearchIndex } from './build.js';
import { words } from './words.js';

/** The weight of each kind of match against a whole word. */
export const matchWeights = Object.freeze({
  exact: 1,
  prefix: 0.6,
  part: 0.4,
  typo: 0.4,
});

/** The shortest query word that also matches inside a word. */
export const minPartLength = 4;

/** The shortest query word that also matches with one typo. */
export const minTypoLength = 5;

/** How many words of a query count; the rest is ignored. */
export const maxQueryWords = 20;

/** The most hits one search returns. */
export const maxSearchHits = 100;

// The usual constants of BM25: how fast repetitions saturate and how much
// the length of a field matters.
const k1 = 1.2;
const b = 0.75;

/** A document the search found. */
export interface SearchHit {
  /** Its position among the documents of the index. */
  readonly index: number;
  /** Its key. */
  readonly key: string;
  /** Its score; only the order matters. */
  readonly score: number;
}

/** The search over one loaded index. */
export interface Searcher {
  /** The number of documents. */
  readonly size: number;
  /**
   * Finds the documents that match a query, best first.
   *
   * @param query - The text to look for.
   * @param limit - The most hits, from 1 to {@link maxSearchHits}.
   * @returns The hits; none for a query without words.
   * @throws {RangeError} If the limit is out of range.
   */
  search(query: string, limit: number): readonly SearchHit[];
}

/**
 * Checks a stored search index and prepares the search over it. Each call
 * computes the averages and frequencies once, so a searcher belongs to
 * the composition root, not to a module.
 *
 * @param index - The stored index of one source.
 * @returns The search, frozen.
 * @throws {RangeError} If the index does not hold together: lists of
 *   different lengths, unsorted keys or words, or postings that point
 *   outside the documents and fields.
 * @example
 * ```ts
 * const searcher = prepareSearch(index);
 * searcher.search('Gruppenmitglieder', 10)[0]?.key;
 * ```
 */
export function prepareSearch(index: SerializedSearchIndex): Searcher {
  checkIndex(index);
  const { fields, weights, keys, lengths, terms, postings } = index;
  const averages = fields.map((_name, field) => {
    let total = 0;
    for (const row of lengths) {
      total += row[field] ?? 0;
    }
    return keys.length === 0 ? 0 : total / keys.length;
  });
  const frequencies = postings.map((list) => {
    let count = 0;
    for (let at = 0; at < list.length; at += 3) {
      if (at === 0 || list[at] !== list[at - 3]) {
        count += 1;
      }
    }
    return count;
  });

  const scoreOf = (term: number, factor: number): Map<number, number> => {
    const df = frequencies[term] ?? 0;
    const idf = Math.log(1 + (keys.length - df + 0.5) / (df + 0.5));
    const scores = new Map<number, number>();
    const list = postings[term] ?? [];
    for (let at = 0; at < list.length; at += 3) {
      const document = list[at] ?? 0;
      const field = list[at + 1] ?? 0;
      const count = list[at + 2] ?? 0;
      const length = lengths[document]?.[field] ?? 0;
      const average = averages[field] ?? 0;
      const norm = average === 0 ? 1 : 1 - b + (b * length) / average;
      const value =
        factor *
        (weights[field] ?? 0) *
        ((idf * count * (k1 + 1)) / (count + k1 * norm));
      scores.set(document, (scores.get(document) ?? 0) + value);
    }
    return scores;
  };

  const search = (query: string, limit: number): readonly SearchHit[] => {
    if (!Number.isInteger(limit) || limit < 1 || limit > maxSearchHits) {
      throw new RangeError(
        `The limit must be a whole number from 1 to ${String(maxSearchHits)}.`,
      );
    }
    const wanted = [...new Set(words(query))].slice(0, maxQueryWords);
    const totals = new Map<number, number>();
    const matched = new Map<number, number>();
    for (const word of wanted) {
      const best = new Map<number, number>();
      for (const [term, factor] of matchingTerms(terms, word)) {
        for (const [document, value] of scoreOf(term, factor)) {
          best.set(document, Math.max(best.get(document) ?? 0, value));
        }
      }
      for (const [document, value] of best) {
        totals.set(document, (totals.get(document) ?? 0) + value);
        matched.set(document, (matched.get(document) ?? 0) + 1);
      }
    }
    const hits = [...totals].map(([document, total]) => ({
      index: document,
      key: keys[document] ?? '',
      score: (total * (matched.get(document) ?? 0)) / wanted.length,
    }));
    hits.sort((x, y) =>
      x.score !== y.score ? y.score - x.score : x.key < y.key ? -1 : 1,
    );
    return Object.freeze(hits.slice(0, limit).map((hit) => Object.freeze(hit)));
  };

  return Object.freeze({ size: keys.length, search });
}

// The words of the index a query word matches, each with the weight of
// its kind of match. Whole word and start come from a binary search over
// the sorted words, parts and typos from one pass over all of them.
function matchingTerms(
  terms: readonly string[],
  word: string,
): Map<number, number> {
  const found = new Map<number, number>();
  let low = 0;
  let high = terms.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((terms[middle] ?? '') < word) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  for (let at = low; at < terms.length; at += 1) {
    const term = terms[at] ?? '';
    if (!term.startsWith(word)) {
      break;
    }
    found.set(at, term === word ? matchWeights.exact : matchWeights.prefix);
  }
  if (word.length >= minPartLength) {
    terms.forEach((term, at) => {
      if (found.has(at)) {
        return;
      }
      if (term.includes(word)) {
        found.set(at, matchWeights.part);
      } else if (word.length >= minTypoLength && withinOneEdit(word, term)) {
        found.set(at, matchWeights.typo);
      }
    });
  }
  return found;
}

// Whether two words differ by one typo at most: a letter added, removed
// or replaced, or two neighbours swapped, as in «Rechet» for «Rechte».
function withinOneEdit(a: string, c: string): boolean {
  if (Math.abs(a.length - c.length) > 1) {
    return false;
  }
  const [short, long] = a.length <= c.length ? [a, c] : [c, a];
  let at = 0;
  while (at < short.length && short[at] === long[at]) {
    at += 1;
  }
  if (at === short.length) {
    return true;
  }
  if (short.length < long.length) {
    return short.slice(at) === long.slice(at + 1);
  }
  return (
    short.slice(at + 1) === long.slice(at + 1) ||
    (short[at] === long[at + 1] &&
      short[at + 1] === long[at] &&
      short.slice(at + 2) === long.slice(at + 2))
  );
}

function checkIndex(index: SerializedSearchIndex): void {
  const { fields, weights, keys, lengths, terms, postings } = index;
  const fail = (): never => {
    throw new RangeError('The search index does not hold together.');
  };
  const isCount = (value: unknown, min: number) =>
    Number.isInteger(value) && (value as number) >= min;
  if (
    fields.length === 0 ||
    weights.length !== fields.length ||
    weights.some((weight) => !isCount(weight, 1) || weight > 10) ||
    lengths.length !== keys.length ||
    postings.length !== terms.length
  ) {
    fail();
  }
  for (let at = 1; at < keys.length; at += 1) {
    if (!((keys[at - 1] ?? '') < (keys[at] ?? ''))) {
      fail();
    }
  }
  for (let at = 1; at < terms.length; at += 1) {
    if (!((terms[at - 1] ?? '') < (terms[at] ?? ''))) {
      fail();
    }
  }
  for (const row of lengths) {
    if (row.length !== fields.length || row.some((n) => !isCount(n, 0))) {
      fail();
    }
  }
  for (const list of postings) {
    if (list.length === 0 || list.length % 3 !== 0) {
      fail();
    }
    for (let at = 0; at < list.length; at += 3) {
      const [document, field, count] = [list[at], list[at + 1], list[at + 2]];
      if (
        !isCount(document, 0) ||
        (document as number) >= keys.length ||
        !isCount(field, 0) ||
        (field as number) >= fields.length ||
        !isCount(count, 1)
      ) {
        fail();
      }
      const before =
        at === 0
          ? -1
          : (list[at - 3] ?? 0) * fields.length + (list[at - 2] ?? 0);
      if ((document as number) * fields.length + (field as number) <= before) {
        fail();
      }
    }
  }
}
