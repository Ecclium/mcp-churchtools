import { isIsoDate } from '@ecclium/mcp-churchtools-plugin-api';
import { describe, expect, it } from 'vitest';

import { KeyMaterial } from '../keys/index.js';
import {
  base32,
  checkCodeOf,
  checkCodePrefix,
  checkCodeSigns,
  type MarkingOrigin,
  sameCheckCode,
} from './code.js';

const key = new KeyMaterial('0123456789abcdef'.repeat(4));
const otherKey = new KeyMaterial('fedcba9876543210'.repeat(4));

const day = '2026-11-05';
if (!isIsoDate(day)) throw new TypeError('No day.');
const nextDay = '2026-11-06';
if (!isIsoDate(nextDay)) throw new TypeError('No day.');

const interactive: MarkingOrigin = { kind: 'interactive', day };
const routine: MarkingOrigin = {
  kind: 'routine',
  routine: 'dienstplan-report',
  run: '2026-W40',
};

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('base32', () => {
  // RFC 4648, section 10, without the padding.
  it.each([
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ])('writes %j as %j', (input, output) => {
    expect(base32(bytes(input))).toBe(output);
  });

  it('writes 64 bits as 13 signs, the last one with a zero bit', () => {
    expect(base32(new Uint8Array(8).fill(0xff))).toBe('7777777777776');
    expect(base32(new Uint8Array(8))).toBe('AAAAAAAAAAAAA');
  });
});

describe('checkCodeOf', () => {
  const code = (
    origin: MarkingOrigin = interactive,
    canonical = '## Nachtrag\n',
    tenantId = 'default',
    k = key,
  ): string => checkCodeOf(k, tenantId, origin, canonical);

  it('gives k1: and 13 signs of Base32', () => {
    expect(code()).toMatch(/^k1:[A-Z2-7]{13}$/);
    expect(checkCodePrefix).toBe('k1:');
    expect(code()).toHaveLength(checkCodePrefix.length + checkCodeSigns);
    // The last sign carries four bits and a zero bit.
    expect('ACEGIKMOQSUWY246').toContain(code().at(-1));
  });

  // Held by hand, computed apart with the HMAC and Base32 of Python: a
  // change of the input or of the encoding would make every check code
  // written so far invalid and needs the prefix k2:.
  it('keeps its form', () => {
    expect(code()).toBe('k1:22SJITO5CUIDG');
    expect(code(routine)).toBe('k1:R4OBBDWCW56RC');
  });

  it('is the same for the same input', () => {
    expect(code()).toBe(code());
  });

  it('changes with the tenant, the day, the routine, the run, the content and the key', () => {
    const base = code();
    expect(code(interactive, '## Nachtrag\n', 'demo-tenant')).not.toBe(base);
    expect(code({ kind: 'interactive', day: nextDay })).not.toBe(base);
    expect(code(interactive, '## Nachtrag 2\n')).not.toBe(base);
    expect(code(interactive, '## Nachtrag\n', 'default', otherKey)).not.toBe(
      base,
    );
    const ofRoutine = code(routine);
    expect(ofRoutine).not.toBe(base);
    expect(code({ ...routine, routine: 'andere-routine' })).not.toBe(ofRoutine);
    expect(code({ ...routine, run: '2026-W41' })).not.toBe(ofRoutine);
  });

  // The word of the origin keeps an interactive input from reading as one
  // of a routine with the same texts.
  it('tells an interactive marking from one of a routine with the same texts', () => {
    expect(
      checkCodeOf(
        key,
        'default',
        { kind: 'routine', routine: day, run: 'x' },
        'x',
      ),
    ).not.toBe(checkCodeOf(key, 'default', { kind: 'interactive', day }, 'x'));
  });
});

describe('sameCheckCode', () => {
  it('compares two codes', () => {
    expect(sameCheckCode('k1:ABCDEFGHIJKLM', 'k1:ABCDEFGHIJKLM')).toBe(true);
    expect(sameCheckCode('k1:ABCDEFGHIJKLM', 'k1:ABCDEFGHIJKLN')).toBe(false);
    expect(sameCheckCode('k1:ABCDEFGHIJKLM', 'k1:ABCDEFGHIJKL')).toBe(false);
    expect(sameCheckCode('', '')).toBe(true);
  });
});
