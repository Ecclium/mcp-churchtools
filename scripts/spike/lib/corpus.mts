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

import type { Guard, Json } from './guard.mts';
import { countClass } from './structure.mts';

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

/** The most changes a probe prints, so the output stays readable. */
export const maxChanges = 30;

const listItem = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
const bareUrl = 'https://example.org/';

/**
 * The target of the first Markdown link in a line, `[text](target)` or
 * `<target>`.
 *
 * The kind «URL in Link umgewandelt» compares this target with the bare
 * URL of the synthetic text as a whole, not as a part of the line.
 *
 * @param line - One line.
 * @returns The target, if the line holds a link.
 */
function linkTarget(line: string): string | undefined {
  return /\]\(([^()\s]+)\)/.exec(line)?.[1] ?? /<([^<>\s]+)>/.exec(line)?.[1];
}
const commentLine = corpus.find((line) => line.startsWith('<!--')) ?? '<!--';

function tableForm(line: string): string {
  return line.replace(/\s+/g, '').replace(/:?-+:?/g, '-');
}

function kindOf(original: string, changed: string): ChangeKind {
  if (original.trimEnd() === changed.trimEnd()) {
    return 'Leerzeichen am Zeilenende';
  }
  const before = listItem.exec(original);
  const after = listItem.exec(changed);
  if (before !== null && after !== null && before[2] === after[2]) {
    return 'Listenzeichen';
  }
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
    original.split(/\s+/).some((word) => word === bareUrl) &&
    linkTarget(changed) === bareUrl
  ) {
    return 'URL in Link umgewandelt';
  }
  return 'andere';
}

/**
 * The form of a line without the changes a Markdown serialiser typically
 * makes, so that a line keeps its counterpart when such a change meets a
 * removed or added line.
 *
 * @param line - One line.
 * @returns The line without trailing spaces, escapes, list marker and table spacing.
 */
function normalized(line: string): string {
  const text = line.trimEnd().replaceAll('\\', '');
  const item = listItem.exec(text);
  if (item !== null) {
    return `• ${item[2] ?? ''}`;
  }
  return text.trimStart().startsWith('|') ? tableForm(text) : text;
}

/**
 * Pairs the lines of two lists by their longest common subsequence.
 *
 * @param a - Keys of the lines of the original.
 * @param b - Keys of the lines of the changed text.
 * @returns For each line of `a`, the index of its counterpart in `b`, or -1.
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
 * Pairs what is left by position: changed, removed or added lines.
 *
 * @param a - Lines of the original that found no counterpart.
 * @param b - Lines of the changed text that found no counterpart.
 * @param start - Index of the first line of `a` in the original.
 * @param changes - The list the changes are added to.
 */
function pairByPosition(
  a: readonly string[],
  b: readonly string[],
  start: number,
  changes: Change[],
): void {
  for (let k = 0; k < Math.max(a.length, b.length); k++) {
    const line = a[k];
    const counterpart = b[k];
    if (line !== undefined && counterpart !== undefined) {
      changes.push({ zeile: start + k + 1, art: kindOf(line, counterpart) });
    } else if (line !== undefined) {
      changes.push({
        zeile: start + k + 1,
        art: line.includes('<!--')
          ? 'HTML-Kommentar entfernt'
          : 'Zeile entfernt',
      });
    } else {
      changes.push({
        zeile: Math.max(start + a.length, 1),
        art: 'Zeile hinzugefügt',
      });
    }
  }
}

/**
 * Compares two lists of lines in three steps: equal lines first, then, in
 * the gaps between them, lines that are equal after {@link normalized},
 * then what is left by position.
 *
 * @param a - Lines of the original.
 * @param b - Lines of the changed text.
 * @param start - Index of the first line of `a` in the original.
 * @param exact - Whether this is the first step, with equal lines.
 * @param changes - The list the changes are added to.
 */
function compareLines(
  a: readonly string[],
  b: readonly string[],
  start: number,
  exact: boolean,
  changes: Change[],
): void {
  const pairs = align(
    exact ? a : a.map(normalized),
    exact ? b : b.map(normalized),
  );
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    let k = i;
    while (k < a.length && (pairs[k] ?? -1) === -1) {
      k++;
    }
    const until = k < a.length ? (pairs[k] ?? b.length) : b.length;
    const gapA = a.slice(i, k);
    const gapB = b.slice(j, until);
    if (gapA.length > 0 || gapB.length > 0) {
      if (exact) {
        compareLines(gapA, gapB, start + i, false, changes);
      } else {
        pairByPosition(gapA, gapB, start + i, changes);
      }
    }
    if (k >= a.length) {
      break;
    }
    const line = a[k] ?? '';
    const counterpart = b[until] ?? '';
    if (line !== counterpart) {
      changes.push({ zeile: start + k + 1, art: kindOf(line, counterpart) });
    }
    i = k + 1;
    j = until + 1;
  }
}

/**
 * Names every change between the original and a text the instance
 * returned, by kind and line of the original.
 *
 * @param original - The text the probe sent.
 * @param changed - The text the instance returned.
 * @returns All changes, in order of the original.
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
  compareLines(
    original.split('\n'),
    changed.replaceAll('\r\n', '\n').split('\n'),
    0,
    true,
    changes,
  );
  return changes;
}

/**
 * Splits a list of changes into what a probe prints and how many are left.
 *
 * @param changes - All changes.
 * @returns At most {@link maxChanges} changes, and the number of the others.
 */
export function limitChanges(changes: readonly Change[]): {
  readonly shown: readonly Change[];
  readonly more: number;
} {
  return {
    shown: changes.slice(0, maxChanges),
    more: Math.max(changes.length - maxChanges, 0),
  };
}

/**
 * The changes as a probe prints them: at most {@link maxChanges}, with the
 * class of the number left out. Only line numbers of the synthetic text and
 * fixed kinds reach the output.
 *
 * @param guard - The guard of the run, which must let the line numbers pass.
 * @param changes - All changes.
 * @returns `aenderungen` and, if some are left out, `weitereAenderungen`.
 */
export function changeReport(
  guard: Guard,
  changes: readonly Change[],
): Record<string, Json> {
  const { shown, more } = limitChanges(changes);
  guard.allowFixed(...shown.map((change) => change.zeile));
  return {
    aenderungen: shown.map((change) => ({
      zeile: change.zeile,
      art: change.art,
    })),
    ...(more > 0 ? { weitereAenderungen: countClass(more) } : {}),
  };
}

/**
 * Tells whether the HTML comment of the synthetic text is still there, as
 * a line of its own. A comment that an editor escapes or changes no longer
 * works as a comment.
 *
 * @param text - A text the instance returned.
 * @returns Whether the comment line is unchanged.
 */
export function commentKept(text: string): boolean {
  return text.replaceAll('\r\n', '\n').split('\n').includes(commentLine);
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
