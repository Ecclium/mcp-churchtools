/**
 * The synthetic text the write probes save, and the comparison that tells
 * what changed in it.
 *
 * The text holds the Markdown that the check code of Ecclium will have to
 * keep intact: headings, three kinds of list markers, a table, emphasis,
 * quotation marks «», an HTML comment, two spaces at the end of a line, a
 * bare URL and escaped characters. It contains nothing about a
 * congregation and nothing from an instance, so its line numbers may
 * appear in the output.
 *
 * The comparison aligns the lines of the original and of the text the
 * instance returned, and names each change by kind, with the number of the
 * line in the original. It never shows the text itself.
 *
 * @packageDocumentation
 */
import { createHash } from 'node:crypto';

/** The lines of the synthetic text. */
export const corpus: readonly string[] = [
  '# Ablauf eines Probentags',
  '',
  'Ein synthetischer Text für den Spike, ohne Bezug zu einer Gemeinde.',
  '',
  '## Listen',
  '',
  '- Einsingen um 18 Uhr',
  '- Notenmappe mitbringen',
  '* Stern als Listenzeichen',
  '+ Plus als Listenzeichen',
  '1. Erster Schritt',
  '2. Zweiter Schritt',
  '',
  '## Tabelle',
  '',
  '| Stimme | Anzahl |',
  '|---|---|',
  '| Sopran | 4 |',
  '| Bass | 2 |',
  '',
  '**Fett**, *kursiv*, `Code` und «Anführungszeichen», mit ss statt Eszett.',
  '<!-- Ein HTML-Kommentar, der erhalten bleiben soll. -->',
  'Diese Zeile endet mit zwei Leerzeichen.  ',
  'Eine nackte Adresse: https://example.org/',
  'Maskiert: 5 \\* 3 und \\_kein Unterstrich\\_',
];

/** The synthetic text as the probes send it. */
export const corpusText = corpus.join('\n');

/** The kinds of change the comparison names. */
export const changeKinds = [
  'Listenzeichen',
  'Leerzeichen am Zeilenende',
  'Tabelle neu ausgerichtet',
  'HTML-Kommentar entfernt',
  'Escape geändert',
  'URL in Link umgewandelt',
  'Zeilenumbruch geändert',
  'Zeile entfernt',
  'Zeile hinzugefügt',
  'andere',
] as const;

/** One kind of change. */
export type ChangeKind = (typeof changeKinds)[number];

/** One change, with the number of the line in the original (from 1). */
export interface Change {
  readonly zeile: number;
  readonly art: ChangeKind;
}

/** The most changes the comparison lists, so the output stays readable. */
export const maxChanges = 30;

const listItem = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
const bareUrl = 'https://example.org/';

function kindOf(original: string, changed: string): ChangeKind {
  if (original.trimEnd() === changed.trimEnd()) {
    return 'Leerzeichen am Zeilenende';
  }
  const before = listItem.exec(original);
  const after = listItem.exec(changed);
  if (before !== null && after !== null && before[2] === after[2]) {
    return 'Listenzeichen';
  }
  const tableForm = (line: string): string =>
    line.replace(/\s+/g, '').replace(/:?-+:?/g, '-');
  if (
    original.trimStart().startsWith('|') &&
    changed.trimStart().startsWith('|') &&
    tableForm(original) === tableForm(changed)
  ) {
    return 'Tabelle neu ausgerichtet';
  }
  if (original.includes('<!--') && !changed.includes('<!--')) {
    return 'HTML-Kommentar entfernt';
  }
  if (original.replaceAll('\\', '') === changed.replaceAll('\\', '')) {
    return 'Escape geändert';
  }
  if (
    original.includes(bareUrl) &&
    (changed.includes(`](${bareUrl}`) || changed.includes(`<${bareUrl}>`))
  ) {
    return 'URL in Link umgewandelt';
  }
  return 'andere';
}

/**
 * Pairs the lines of two texts by their longest common subsequence.
 *
 * @param a - Lines of the original.
 * @param b - Lines of the changed text.
 * @returns For each line of `a`, the index of its equal line in `b`, or -1.
 */
function align(a: readonly string[], b: readonly string[]): number[] {
  const columns = b.length + 1;
  const table = new Uint32Array((a.length + 1) * columns);
  const at = (i: number, j: number): number => table[i * columns + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * columns + j] =
        a[i] === b[j]
          ? at(i + 1, j + 1) + 1
          : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const pairs = new Array<number>(a.length).fill(-1);
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pairs[i] = j;
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/**
 * Names every change between the original and a text the instance
 * returned, by kind and line of the original.
 *
 * @param original - The text the probe sent.
 * @param changed - The text the instance returned.
 * @returns The changes in order of the original, at most {@link maxChanges}.
 * @example
 * ```ts
 * classifyChanges('- a\n* b', '- a\n- b');
 * // [{ zeile: 2, art: 'Listenzeichen' }]
 * ```
 */
export function classifyChanges(original: string, changed: string): Change[] {
  const changes: Change[] = [];
  if (changed.includes('\r\n') && !original.includes('\r\n')) {
    changes.push({ zeile: 1, art: 'Zeilenumbruch geändert' });
  }
  const a = original.split('\n');
  const b = changed.replaceAll('\r\n', '\n').split('\n');
  const pairs = align(a, b);
  let next = 0;
  let i = 0;
  while (i < a.length) {
    const target = pairs[i] ?? -1;
    if (target !== -1) {
      for (let j = next; j < target; j++) {
        changes.push({ zeile: Math.max(i, 1), art: 'Zeile hinzugefügt' });
      }
      next = target + 1;
      i++;
      continue;
    }
    // A run of lines of the original without an equal line in the changed
    // text, paired with the lines of the changed text up to the next match.
    let end = i;
    while (end < a.length && (pairs[end] ?? -1) === -1) {
      end++;
    }
    const until = end < a.length ? (pairs[end] ?? b.length) : b.length;
    const replaced = b.slice(next, until);
    for (let k = i; k < end; k++) {
      const counterpart = replaced[k - i];
      const line = a[k] ?? '';
      changes.push({
        zeile: k + 1,
        art:
          counterpart === undefined
            ? line.includes('<!--')
              ? 'HTML-Kommentar entfernt'
              : 'Zeile entfernt'
            : kindOf(line, counterpart),
      });
    }
    for (let extra = end - i; extra < replaced.length; extra++) {
      changes.push({ zeile: Math.max(end, 1), art: 'Zeile hinzugefügt' });
    }
    next = until;
    i = end;
  }
  for (let j = next; j < b.length; j++) {
    changes.push({ zeile: Math.max(a.length, 1), art: 'Zeile hinzugefügt' });
  }
  return changes.slice(0, maxChanges);
}

/**
 * Hashes a text, so a probe can compare it later without keeping it.
 *
 * @param text - Any text.
 * @returns SHA-256 of the UTF-8 bytes, as hexadecimal text.
 */
export function textHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
