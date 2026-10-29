/**
 * The words of the search in the docs index (ADR 0066). The same steps
 * turn the facts into the words of the index and a query into the words
 * it looks for, so that both meet: «Gruppenmitglieder», «gruppenmitglieder»
 * and «GRUPPENMITGLIEDER» are one word, «Übersicht» and «Ubersicht» too,
 * and `getGroupsGroupIdMembers` gives «get», «groups», «group», «id» and
 * «members».
 *
 * Nothing here depends on the locale or the time zone of the machine: the
 * index must come out the same everywhere.
 *
 * @packageDocumentation
 */

/** The shortest word that counts. Single letters carry no meaning. */
export const minWordLength = 2;

/** The longest word that counts; longer runs of letters are cut. */
export const maxWordLength = 40;

/**
 * Words that appear in almost every text and say nothing about it, in
 * German and English, in their folded form.
 */
export const stopWords: readonly string[] = Object.freeze([
  'an',
  'and',
  'are',
  'as',
  'at',
  'auf',
  'aus',
  'be',
  'bei',
  'by',
  'das',
  'dem',
  'den',
  'der',
  'des',
  'die',
  'ein',
  'eine',
  'einem',
  'einen',
  'einer',
  'eines',
  'for',
  'from',
  'fur',
  'im',
  'in',
  'is',
  'ist',
  'it',
  'mit',
  'of',
  'oder',
  'on',
  'or',
  'sind',
  'the',
  'this',
  'to',
  'und',
  'von',
  'zu',
  'zum',
  'zur',
]);

// A capital after a small letter or a digit, or a capital that starts a
// word after a run of capitals, begins a new word: getGroupsGroupIdMembers,
// HTMLPage. Marks are removed after NFD, which turns «ü» into «u».
const camelBoundary = /(\p{Ll}|\p{Nd})(\p{Lu})|(\p{Lu})(\p{Lu}\p{Ll})/gu;
const marks = /\p{M}/gu;
const separators = /[^\p{L}\p{N}]+/u;

/**
 * Turns a text into its words: split at capitals inside identifiers,
 * NFKC, small letters, «ss» for «ß», without marks, split at everything
 * that is neither a letter nor a digit. Words shorter than
 * {@link minWordLength} and {@link stopWords} fall away, longer words are
 * cut to {@link maxWordLength}.
 *
 * @param text - Any text, from the facts or from a query.
 * @returns The words in their order, with repetitions.
 * @example
 * ```ts
 * words('getGroupsGroupIdMembers'); // ['get', 'groups', 'group', 'id', 'members']
 * words('Die Übersicht der Gruppe'); // ['ubersicht', 'gruppe']
 * ```
 */
export function words(text: string): readonly string[] {
  const folded = text
    .replace(
      camelBoundary,
      (_match: string, a?: string, b?: string, c?: string, d?: string) =>
        a === undefined ? `${c ?? ''} ${d ?? ''}` : `${a} ${b ?? ''}`,
    )
    .normalize('NFKC')
    .toLowerCase()
    .replaceAll('ß', 'ss')
    .normalize('NFD')
    .replace(marks, '');
  const result: string[] = [];
  for (const word of folded.split(separators)) {
    // Code points, not code units, so that a cut never splits a letter.
    const letters = Array.from(word);
    if (letters.length >= minWordLength && !stopWords.includes(word)) {
      result.push(letters.slice(0, maxWordLength).join(''));
    }
  }
  return result;
}
