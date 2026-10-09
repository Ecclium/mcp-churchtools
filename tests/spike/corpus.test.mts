// The comparison that names what the instance changed in the synthetic
// text, by kind and line, without showing the text.
import { describe, expect, it } from 'vitest';

import {
  classifyChanges,
  corpus,
  corpusText,
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

  it('lists at most a fixed number of changes', () => {
    const everything = corpus.map((line) => `x${line}x`).join('\n');
    expect(classifyChanges(corpusText, everything)).toHaveLength(
      Math.min(maxChanges, corpus.length),
    );
    expect(classifyChanges(corpusText, '').length).toBeLessThanOrEqual(
      maxChanges,
    );
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
