// The comparison that names what the instance changed in the synthetic
// text, by kind and line, without showing the text.
import { describe, expect, it } from 'vitest';

import {
  classifyChanges,
  commentKept,
  corpus,
  corpusText,
  limitChanges,
  maxChanges,
  textHash,
  type ChangeKind,
} from '../../scripts/spike/lib/corpus.mts';

const lineOf = (start: string): number =>
  corpus.findIndex((line) => line.startsWith(start)) + 1;

function edit(start: string, replace: (line: string) => string): string {
  return corpus
    .map((line) => (line.startsWith(start) ? replace(line) : line))
    .join('\n');
}

describe('the synthetic text', () => {
  it('holds every construct the comparison names, and nothing from an instance', () => {
    expect(corpusText).toContain('<!--');
    expect(corpusText).toContain('«');
    expect(corpusText).toContain('https://example.org/');
    expect(corpus.some((line) => line.endsWith('  '))).toBe(true);
    expect(corpus.some((line) => line.startsWith('|'))).toBe(true);
    expect(corpus.some((line) => line.startsWith('* '))).toBe(true);
    expect(corpusText).not.toMatch(/ß/);
  });
});

describe('classifyChanges', () => {
  it('finds nothing in an unchanged text', () => {
    expect(classifyChanges(corpusText, corpusText)).toEqual([]);
  });

  it.each<[string, string, ChangeKind]>([
    [
      'a list marker',
      edit('* Stern', (line) => line.replace('* ', '- ')),
      'Listenzeichen',
    ],
    [
      'spaces at the end of a line',
      edit('Diese Zeile endet', (line) => line.trimEnd()),
      'Leerzeichen am Zeilenende',
    ],
    [
      'a realigned table',
      edit('|---|', () => '| --- | --- |'),
      'Tabelle neu ausgerichtet',
    ],
    [
      'an escape',
      edit('Maskiert:', (line) => line.replace('\\*', '*')),
      'Escape geändert',
    ],
    [
      'a bare URL turned into a link',
      edit(
        'Eine nackte Adresse',
        () =>
          'Eine nackte Adresse: [https://example.org/](https://example.org/)',
      ),
      'URL in Link umgewandelt',
    ],
    [
      'a changed comment',
      edit('<!--', () => 'Ein HTML-Kommentar'),
      'HTML-Kommentar entfernt',
    ],
    ['another change', edit('# Ablauf', () => '# Anderer Titel'), 'andere'],
  ])('names %s with its line', (_, changed, kind) => {
    const changes = classifyChanges(corpusText, changed);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.art).toBe(kind);
    expect(changes[0]?.zeile).toBeGreaterThan(0);
    expect(changes[0]?.zeile).toBeLessThanOrEqual(corpus.length);
  });

  it('names a removed comment line and a removed line by their line', () => {
    const withoutComment = corpus
      .filter((line) => !line.startsWith('<!--'))
      .join('\n');
    expect(classifyChanges(corpusText, withoutComment)).toEqual([
      { zeile: lineOf('<!--'), art: 'HTML-Kommentar entfernt' },
    ]);
    const withoutHeading = corpus
      .filter((line) => !line.startsWith('## Tabelle'))
      .join('\n');
    expect(classifyChanges(corpusText, withoutHeading)).toEqual([
      { zeile: lineOf('## Tabelle'), art: 'Zeile entfernt' },
    ]);
  });

  it('names added lines and changed line breaks', () => {
    expect(classifyChanges(corpusText, `${corpusText}\n`)).toEqual([
      { zeile: corpus.length, art: 'Zeile hinzugefügt' },
    ]);
    expect(classifyChanges(corpusText, `Neu\n${corpusText}`)).toEqual([
      { zeile: 1, art: 'Zeile hinzugefügt' },
    ]);
    expect(
      classifyChanges(corpusText, corpusText.replaceAll('\n', '\r\n')),
    ).toEqual([{ zeile: 1, art: 'Zeilenumbruch geändert' }]);
  });

  it('keeps the counterpart of a line when changes meet a removed or added line', () => {
    // The comment line goes, and the next line loses its trailing spaces.
    const trimmedAfterComment = corpus
      .filter((line) => !line.startsWith('<!--'))
      .map((line) => line.trimEnd())
      .join('\n');
    expect(classifyChanges(corpusText, trimmedAfterComment)).toEqual([
      { zeile: lineOf('<!--'), art: 'HTML-Kommentar entfernt' },
      { zeile: lineOf('Diese Zeile endet'), art: 'Leerzeichen am Zeilenende' },
    ]);
    // Blank lines between the list items, and every marker becomes «-».
    const spaced = corpus
      .flatMap((line) =>
        line.startsWith('* ') || line.startsWith('+ ')
          ? ['', `- ${line.slice(2)}`]
          : [line],
      )
      .join('\n');
    expect(classifyChanges(corpusText, spaced)).toEqual([
      { zeile: lineOf('* Stern') - 1, art: 'Zeile hinzugefügt' },
      { zeile: lineOf('* Stern'), art: 'Listenzeichen' },
      { zeile: lineOf('* Stern'), art: 'Zeile hinzugefügt' },
      { zeile: lineOf('+ Plus'), art: 'Listenzeichen' },
    ]);
  });

  it('returns every change, and limitChanges keeps a fixed number', () => {
    const everything = corpus.map((line) => `x${line}x`).join('\n');
    const changes = classifyChanges(corpusText, everything);
    expect(changes).toHaveLength(corpus.length);
    const doubled = [...changes, ...changes];
    const { shown, more } = limitChanges(doubled);
    expect(shown).toHaveLength(maxChanges);
    expect(more).toBe(doubled.length - maxChanges);
    expect(limitChanges(changes.slice(0, 3)).more).toBe(0);
  });
});

describe('commentKept', () => {
  it('needs the comment as an unchanged line of its own', () => {
    expect(commentKept(corpusText)).toBe(true);
    expect(commentKept(corpusText.replaceAll('\n', '\r\n'))).toBe(true);
    expect(commentKept(corpusText.replace('<!--', '\\<!--'))).toBe(false);
    expect(commentKept(corpusText.replace('<!--', '<!-- '))).toBe(false);
  });
});

describe('textHash', () => {
  it('is the SHA-256 of the text', () => {
    expect(textHash('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(textHash(corpusText)).not.toBe(textHash(`${corpusText} `));
  });
});
