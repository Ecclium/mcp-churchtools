import { describe, expect, it } from 'vitest';

import { splitLines } from './lines.js';

describe('splitLines', () => {
  it('gives no line for an empty text', () => {
    expect(splitLines('')).toEqual([]);
  });

  it('keeps the ending of every line, and none after the last break', () => {
    expect(splitLines('a')).toEqual(['a']);
    expect(splitLines('a\n')).toEqual(['a\n']);
    expect(splitLines('\n')).toEqual(['\n']);
    expect(splitLines('a\n\n')).toEqual(['a\n', '\n']);
    expect(splitLines('a\r\nb\n\nc')).toEqual(['a\r\n', 'b\n', '\n', 'c']);
  });

  it('keeps a lone carriage return inside its line', () => {
    expect(splitLines('a\rb\nc\r')).toEqual(['a\rb\n', 'c\r']);
  });

  it('gives the lines frozen', () => {
    expect(Object.isFrozen(splitLines('a\nb'))).toBe(true);
  });
});
