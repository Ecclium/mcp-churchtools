import { describe, expect, it } from 'vitest';

import {
  cleanText,
  hiddenCharactersNote,
  removeHiddenCharacters,
} from './unicode.js';

// Hidden characters are written by code point, so that none of them stands
// in this file, where a reader would not see it.
const u = (...codes: number[]): string => String.fromCodePoint(...codes);

// Every hidden character the cleaning removes, by code point.
const hidden: readonly number[] = [
  ...Array.from({ length: 0x20 }, (_, index) => index).filter(
    (code) => code !== 0x09 && code !== 0x0a && code !== 0x0d,
  ),
  ...Array.from({ length: 0x21 }, (_, index) => 0x7f + index),
  0x061c,
  0x200b,
  0x200c,
  0x200d,
  0x200e,
  0x200f,
  0x202a,
  0x202b,
  0x202c,
  0x202d,
  0x202e,
  0x2060,
  0x2061,
  0x2062,
  0x2063,
  0x2064,
  0x2066,
  0x2067,
  0x2068,
  0x2069,
  0xfeff,
  0xe0000,
  0xe0001,
  0xe0041,
  0xe007f,
];

// Neighbours of the ranges and characters that text needs.
const visible: readonly number[] = [
  0x09, 0x0a, 0x20, 0x7e, 0xa0, 0xe4, 0x061b, 0x061d, 0x200a, 0x2010, 0x2029,
  0x202f, 0x205f, 0x2065, 0x206a, 0xfe0f, 0xfefe, 0xff10, 0xdffff, 0xe0080,
  0x1f600,
];

describe('removeHiddenCharacters', () => {
  it.each(hidden.map((code) => [code.toString(16), code]))(
    'removes U+%s',
    (_, code) => {
      const text = `a${String.fromCodePoint(code)}b`;
      expect(removeHiddenCharacters(text)).toEqual({ text: 'ab', removed: 1 });
    },
  );

  it.each(visible.map((code) => [code.toString(16), code]))(
    'keeps U+%s',
    (_, code) => {
      const text = `a${String.fromCodePoint(code)}b`;
      const cleaned = removeHiddenCharacters(text);
      expect(cleaned).toEqual({ text, removed: 0 });
      // The text itself comes back, not a copy.
      expect(cleaned.text).toBe(text);
    },
  );

  it('keeps the carriage return of a line break and removes a lone one', () => {
    expect(removeHiddenCharacters('a\r\nb\rc\r')).toEqual({
      text: 'a\r\nbc',
      removed: 2,
    });
  });

  it('counts code points, removes runs and keeps what lies between', () => {
    const tags = u(0xe0049, 0xe0067, 0xe006e);
    expect(
      removeHiddenCharacters(
        `${u(0x202e)}Start${tags}Mitte${u(0x200b, 0x200c, 0x200d)}Ende${u(0xfeff)}`,
      ),
    ).toEqual({ text: 'StartMitteEnde', removed: 8 });
  });

  it('keeps emoji with variation selectors and joiners of other scripts', () => {
    const text = u(
      0x2764,
      0xfe0f,
      0x20,
      0x1f44d,
      0x1f3fd,
      0x20,
      0x939,
      0x93f,
      0x928,
    );
    expect(removeHiddenCharacters(text)).toEqual({ text, removed: 0 });
  });

  it('keeps a lone surrogate and an empty text', () => {
    expect(removeHiddenCharacters('a\uD800b')).toEqual({
      text: 'a\uD800b',
      removed: 0,
    });
    expect(removeHiddenCharacters('')).toEqual({ text: '', removed: 0 });
  });
});

describe('cleanText', () => {
  it('ends a changed text with the note and leaves others as they are', () => {
    expect(cleanText(`Hallo${u(0x202e)}welt${u(0x200b)}`)).toBe(
      `Hallowelt${hiddenCharactersNote(2)}`,
    );
    expect(hiddenCharactersNote(2)).toBe(
      ' [ecclium: 2 hidden characters removed]',
    );
    expect(cleanText('Gemeinde')).toBe('Gemeinde');
  });

  it('is idempotent', () => {
    const once = cleanText(`a${String.fromCodePoint(0xe0041)}b`);
    expect(cleanText(once)).toBe(once);
  });

  it('removes a text made only of hidden characters', () => {
    expect(cleanText(u(0x200b, 0x200b))).toBe(hiddenCharactersNote(2));
  });
});
