import { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { checkCodeBytes, checkCodeLabel, checkCodeMac } from './check-code.js';
import { KeyMaterial } from './key-material.js';

const hex = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const key = new KeyMaterial(hex);

// The input written out by hand, without infoOf: each part after its
// length in two bytes, big-endian.
const byHand = (parts: readonly string[]): Buffer =>
  Buffer.concat(
    parts.flatMap((part) => {
      const bytes = Buffer.from(part, 'utf8');
      return [Buffer.from([bytes.length >> 8, bytes.length & 0xff]), bytes];
    }),
  );

describe('checkCodeMac', () => {
  it('takes the first 64 bits of an HMAC-SHA256 over the label and the parts', () => {
    const parts = ['interactive', 'default', '2026-11-05', 'a'.repeat(64)];
    const expected = createHmac('sha256', Buffer.from(hex, 'hex'))
      .update(byHand([checkCodeLabel, ...parts]))
      .digest()
      .subarray(0, 8);
    const mac = checkCodeMac(key, parts);
    expect(mac).toBeInstanceOf(Uint8Array);
    expect(mac).toHaveLength(checkCodeBytes);
    expect(Buffer.from(mac).equals(expected)).toBe(true);
  });

  // Held by hand, so that a change of the label or of the encoding shows:
  // every check code written so far would turn invalid.
  it('keeps its form', () => {
    expect(
      Buffer.from(
        checkCodeMac(key, ['interactive', 'default', '2026-11-05', 'x']),
      ).toString('hex'),
    ).toBe('2539c9b209b92381');
  });

  it('gives another code for another part, another order or another key', () => {
    const of = (k: KeyMaterial, parts: readonly string[]): string =>
      Buffer.from(checkCodeMac(k, parts)).toString('hex');
    const base = of(key, ['a', 'b']);
    expect(of(key, ['a', 'c'])).not.toBe(base);
    expect(of(key, ['b', 'a'])).not.toBe(base);
    expect(of(key, ['ab'])).not.toBe(base);
    expect(of(key, ['a', 'b', ''])).not.toBe(base);
    expect(of(new KeyMaterial('1'.repeat(63) + '2'), ['a', 'b'])).not.toBe(
      base,
    );
  });

  it('gives a fresh copy each time', () => {
    const first = checkCodeMac(key, ['a']);
    first.fill(0);
    expect(checkCodeMac(key, ['a']).some((byte) => byte !== 0)).toBe(true);
  });

  it('refuses what is no key and a part that is too long', () => {
    expect(() => checkCodeMac({} as KeyMaterial, ['a'])).toThrow(TypeError);
    expect(() => checkCodeMac(key, ['a'.repeat(65_536)])).toThrow(TypeError);
  });
});
