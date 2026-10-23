import { describe, expect, it } from 'vitest';

import {
  maxSearchHits,
  maxSearchTermLength,
  normalizeSearchTerm,
} from './index.js';

describe('the limits of a search', () => {
  it('returns at most 50 hits and takes terms of up to 100 code units', () => {
    expect(maxSearchHits).toBe(50);
    expect(maxSearchTermLength).toBe(100);
  });
});

describe('normalizeSearchTerm', () => {
  it('removes white space at both ends and keeps the inside', () => {
    expect(normalizeSearchTerm('  Person  A \t')).toBe('Person  A');
    expect(normalizeSearchTerm(' Muster ')).toBe('Muster');
    expect(normalizeSearchTerm('a')).toBe('a');
  });

  it('refuses an empty term, also one of white space only', () => {
    expect(normalizeSearchTerm('')).toBeUndefined();
    expect(normalizeSearchTerm('   ')).toBeUndefined();
    expect(normalizeSearchTerm('\n\t ')).toBeUndefined();
  });

  it('takes 100 code units after trimming and refuses 101', () => {
    expect(normalizeSearchTerm('x'.repeat(100))).toBe('x'.repeat(100));
    expect(normalizeSearchTerm(` ${'x'.repeat(100)} `)).toBe('x'.repeat(100));
    expect(normalizeSearchTerm('x'.repeat(101))).toBeUndefined();
  });

  it('refuses control characters inside the term', () => {
    for (const control of ['\u0000', '\u0009', '\u000a', '\u001f', '\u007f']) {
      expect(normalizeSearchTerm(`Per${control}son`)).toBeUndefined();
    }
    for (const control of ['\u0080', '\u0085', '\u009f']) {
      expect(normalizeSearchTerm(`Per${control}son`)).toBeUndefined();
    }
  });

  it('takes letters beyond ASCII and a pair of surrogates', () => {
    expect(normalizeSearchTerm('Ölberg Süd')).toBe('Ölberg Süd');
    expect(normalizeSearchTerm('Gruppe 🎵')).toBe('Gruppe 🎵');
  });

  it('refuses a lone surrogate', () => {
    expect(normalizeSearchTerm('a\ud800')).toBeUndefined();
    expect(normalizeSearchTerm('\ud800b')).toBeUndefined();
    expect(normalizeSearchTerm('a\udc00b')).toBeUndefined();
  });

  it('refuses every value that is no string', () => {
    for (const value of [undefined, null, 1, true, ['a'], { query: 'a' }]) {
      expect(normalizeSearchTerm(value)).toBeUndefined();
    }
  });
});
