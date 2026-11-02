import { describe, expect, it } from 'vitest';

import {
  hasTooManyEmphasisSigns,
  maxContentBytes,
  maxEmphasisSigns,
  normalizeContent,
} from './normalize.js';

const u = (codePoint: number): string => String.fromCodePoint(codePoint);

describe('normalizeContent', () => {
  it('writes signs of full width and ligatures in their plain form', () => {
    expect(normalizeContent(`${u(0xff37)}oche, Au${u(0xfb00)}ahrt`)).toEqual({
      ok: true,
      text: 'Woche, Auffahrt',
    });
  });

  it('changes signs a person may have chosen, as NFKC does', () => {
    expect(normalizeContent(`m${u(0xb2)} ${u(0x2026)}${u(0xa0)}Ende`)).toEqual({
      ok: true,
      text: 'm2 ... Ende',
    });
  });

  it('removes hidden characters and ends every line with a line feed', () => {
    expect(
      normalizeContent(`Ver${u(0x200b)}steckt${u(0x202e)}\r\nZeile\rzwei\n`),
    ).toEqual({ ok: true, text: 'Versteckt\nZeilezwei\n' });
  });

  it('takes exactly 64 KiB and refuses one byte more', () => {
    expect(normalizeContent('a'.repeat(maxContentBytes)).ok).toBe(true);
    expect(normalizeContent('a'.repeat(maxContentBytes + 1))).toEqual({
      ok: false,
      violation: 'tooLong',
    });
    // Two bytes each in UTF-8: half as many characters reach the limit.
    expect(normalizeContent('ä'.repeat(maxContentBytes / 2 + 1))).toEqual({
      ok: false,
      violation: 'tooLong',
    });
  });

  it('refuses a text that NFKC makes longer than the limit', () => {
    // One sign of three bytes that NFKC writes as eighteen letters.
    const ligature = u(0xfdfa);
    const text = ligature.repeat(Math.floor(maxContentBytes / 3));
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(
      maxContentBytes,
    );
    expect(normalizeContent(text)).toEqual({ ok: false, violation: 'tooLong' });
  });

  it('refuses a lone surrogate, which would change on the way', () => {
    expect(normalizeContent(`a${String.fromCharCode(0xd800)}b`)).toEqual({
      ok: false,
      violation: 'unparsable',
    });
  });
});

describe('hasTooManyEmphasisSigns', () => {
  it(`counts asterisks and underscores together up to ${String(maxEmphasisSigns)}`, () => {
    const half = maxEmphasisSigns / 2;
    expect(
      hasTooManyEmphasisSigns(`${'*'.repeat(half)}${'_'.repeat(half)}`),
    ).toBe(false);
    expect(
      hasTooManyEmphasisSigns(`${'*'.repeat(half)}${'_'.repeat(half + 1)}`),
    ).toBe(true);
    expect(hasTooManyEmphasisSigns('Ein Satz ohne Zeichen')).toBe(false);
  });
});
