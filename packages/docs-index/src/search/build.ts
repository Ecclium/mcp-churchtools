/**
 * Builds the search index of one source of the docs index (ADR 0066): an
 * inverted index from each word to the documents and fields it stands in,
 * with how often. It holds only strings and whole numbers, sorted, so
 * that the same documents always give the same bytes, whatever the
 * machine. The averages BM25 needs are computed when the index is loaded,
 * not stored, because a stored fraction could differ in its last digit.
 *
 * @packageDocumentation
 */
import { words } from './words.js';

/** A field of the documents and its weight in the score, 1 to 10. */
export interface SearchField {
  /** The name of the field, such as `title`. */
  readonly name: string;
  /** How much a match in this field counts against other fields. */
  readonly weight: number;
}

/** A document to index: its key and the text of each field. */
export interface SearchDocument {
  /** The key, unique and in the order of the documents. */
  readonly key: string;
  /** The text of each field, in the order of the fields. */
  readonly texts: readonly string[];
}

/** The search index of one source, as it is stored. */
export interface SerializedSearchIndex {
  /** The names of the fields. */
  readonly fields: readonly string[];
  /** The weight of each field. */
  readonly weights: readonly number[];
  /** The key of each document, sorted. */
  readonly keys: readonly string[];
  /** For each document, the number of words in each field. */
  readonly lengths: readonly (readonly number[])[];
  /** Every word, sorted by code units. */
  readonly terms: readonly string[];
  /**
   * For each word, a flat list of triples: document, field and how often
   * the word stands there, sorted by document and field.
   */
  readonly postings: readonly (readonly number[])[];
}

/**
 * Builds the search index of a list of documents.
 *
 * @param fields - The fields, at least one, each with a whole weight from
 *   1 to 10.
 * @param documents - The documents, sorted by their key, each key once,
 *   each with one text per field.
 * @returns The index, ready to be stored as JSON.
 * @throws {RangeError} If a weight, the order of the keys or the number of
 *   texts is wrong.
 * @example
 * ```ts
 * const index = buildSearchIndex(
 *   [{ name: 'title', weight: 3 }],
 *   [{ key: '/de/help/a/', texts: ['Gruppen sehen'] }],
 * );
 * index.terms; // ['gruppen', 'sehen']
 * ```
 */
export function buildSearchIndex(
  fields: readonly SearchField[],
  documents: readonly SearchDocument[],
): SerializedSearchIndex {
  if (
    fields.length === 0 ||
    fields.some(
      ({ weight }) => !Number.isInteger(weight) || weight < 1 || weight > 10,
    )
  ) {
    throw new RangeError('Every field needs a whole weight from 1 to 10.');
  }
  const postings = new Map<string, number[]>();
  const lengths: number[][] = [];
  documents.forEach((document, index) => {
    const previous = documents[index - 1];
    if (previous !== undefined && !(previous.key < document.key)) {
      throw new RangeError(
        'The keys of the documents must be sorted and unique.',
      );
    }
    if (document.texts.length !== fields.length) {
      throw new RangeError('Every document needs one text per field.');
    }
    lengths.push(
      document.texts.map((text, field) => {
        const found = words(text);
        const counts = new Map<string, number>();
        for (const word of found) {
          counts.set(word, (counts.get(word) ?? 0) + 1);
        }
        // Documents and fields come in order, so each list stays sorted.
        for (const [word, count] of counts) {
          const list = postings.get(word) ?? [];
          list.push(index, field, count);
          postings.set(word, list);
        }
        return found.length;
      }),
    );
  });
  const terms = [...postings.keys()].sort((a, b) => (a < b ? -1 : 1));
  return {
    fields: fields.map(({ name }) => name),
    weights: fields.map(({ weight }) => weight),
    keys: documents.map(({ key }) => key),
    lengths,
    terms,
    postings: terms.map((term) => postings.get(term) ?? []),
  };
}
