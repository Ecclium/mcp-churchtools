import { describe, expect, it } from 'vitest';

import { maxPartBytes, splitIntoParts } from './parts.js';

// The bytes of a part the way JSON writes it inside a string.
const jsonBytes = (part: string): number =>
  Buffer.byteLength(JSON.stringify(part), 'utf8') - 2;

// A text of every kind of code point the counting treats apart, in an
// order that changes with the seed, so that cuts land on each of them.
const mixed = (seed: number, length: number): string => {
  const pieces = [
    'a',
    'Z',
    ' ',
    '\n',
    '\t',
    '"',
    '\\',
    '\u0001',
    'ä',
    '€',
    '😀',
    '<p class="x">',
    'Zeile mit Text\n',
  ];
  let state = seed;
  let text = '';
  while (text.length < length) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    text += pieces[state % pieces.length] ?? '';
  }
  return text;
};

describe('splitIntoParts', () => {
  it('cuts parts of at most 16000 bytes by default', () => {
    expect(maxPartBytes).toBe(16_000);
    const parts = splitIntoParts('x'.repeat(40_000));
    expect(parts.map((part) => part.length)).toEqual([16_000, 16_000, 8_000]);
  });

  it('gives one empty part for an empty text, and a short text whole', () => {
    expect(splitIntoParts('')).toEqual(['']);
    expect(splitIntoParts('# Titel\n\nText')).toEqual(['# Titel\n\nText']);
  });

  it('ends a part after the last line break that fits', () => {
    expect(splitIntoParts('aaaa\nbbbb\ncccc\n', 10)).toEqual([
      'aaaa\n',
      'bbbb\n',
      'cccc\n',
    ]);
    expect(splitIntoParts('aa\nbb\ncccccc', 10)).toEqual([
      'aa\nbb\n',
      'cccccc',
    ]);
  });

  it('cuts a line longer than a part between two code points', () => {
    expect(splitIntoParts('x'.repeat(25), 10)).toEqual([
      'x'.repeat(10),
      'x'.repeat(10),
      'x'.repeat(5),
    ]);
  });

  it('keeps an umlaut and an emoji whole at the boundary', () => {
    expect(splitIntoParts(`${'a'.repeat(9)}ä`, 10)).toEqual([
      'a'.repeat(9),
      'ä',
    ]);
    expect(splitIntoParts(`${'a'.repeat(8)}😀b`, 10)).toEqual([
      'a'.repeat(8),
      '😀b',
    ]);
  });

  it('counts quotes, backslashes and controls as JSON writes them', () => {
    expect(splitIntoParts('"""""""', 6).map(jsonBytes)).toEqual([6, 6, 2]);
    expect(splitIntoParts('\u0001\u0001', 6)).toEqual(['\u0001', '\u0001']);
    expect(splitIntoParts('a\ud800', 6)).toEqual(['a', '\ud800']);
  });

  // The bytes of each kind of character as JSON writes it: six per part of
  // six bytes for one byte, three for two and one for six.
  it.each([
    ['\b', 2],
    ['\f', 2],
    ['\r', 2],
    ['\t', 2],
    ['\u000b', 6],
    ['\u0000', 6],
    ['\u007f', 1],
    ['ä', 2],
    ['€', 3],
  ])('counts %j as %i bytes', (sign, bytes) => {
    const parts = splitIntoParts(sign.repeat(12), 6);
    expect(parts.every((part) => part.length === 6 / bytes)).toBe(true);
  });

  it('keeps a carriage return with its line feed when a line is cut', () => {
    const parts = splitIntoParts(`${'a'.repeat(15_998)}\r\nb`);
    expect(parts).toEqual(['a'.repeat(15_998), '\r\nb']);
  });

  it.each([1, 2, 3, 4, 5])(
    'gives parts that join to the text and each fit, for mixed text %i',
    (seed) => {
      const text = mixed(seed, 5_000);
      for (const limit of [6, 7, 64, 500]) {
        const parts = splitIntoParts(text, limit);
        expect(parts.join('')).toBe(text);
        for (const part of parts) {
          expect(jsonBytes(part)).toBeLessThanOrEqual(limit);
          expect(part.length).toBeGreaterThan(0);
        }
      }
    },
  );

  it('gives the same parts for the same text', () => {
    const text = mixed(7, 3_000);
    expect(splitIntoParts(text, 100)).toEqual(splitIntoParts(text, 100));
  });

  it('refuses a limit too small for every code point', () => {
    expect(() => splitIntoParts('a', 5)).toThrow(RangeError);
    expect(() => splitIntoParts('a', 6.5)).toThrow(RangeError);
  });
});
