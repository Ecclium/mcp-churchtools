import { randomBytes } from 'node:crypto';
import { format, inspect } from 'node:util';
import { serialize } from 'node:v8';

import { describe, expect, it } from 'vitest';

import * as keys from './index.js';
import {
  KeyMaterial,
  keyMaterialLength,
  revealKeyMaterial,
} from './key-material.js';

// Every test makes a fresh random key and proves its hex absent from what
// the key turns into. revealKeyMaterial is the positive control: it is the
// one way back to the bytes.

const fresh = (): { hex: string; key: KeyMaterial } => {
  const hex = randomBytes(keyMaterialLength).toString('hex');
  return { hex, key: new KeyMaterial(hex) };
};

const fullInspect = (value: unknown): string =>
  inspect(value, {
    customInspect: false,
    showHidden: true,
    getters: true,
    depth: Infinity,
    showProxy: true,
  });

describe('KeyMaterial prints as the placeholder', () => {
  it('in toString, toJSON, JSON, inspect and format', () => {
    const { hex, key } = fresh();
    const outputs = [
      String(key),
      key.toJSON(),
      JSON.stringify({ key }),
      inspect(key),
      inspect({ key }),
      format('%s %o %O %j', key, key, key, key),
      fullInspect(key),
    ];
    expect(outputs.slice(0, 3)).toEqual([
      '[REDACTED]',
      '[REDACTED]',
      '{"key":"[REDACTED]"}',
    ]);
    for (const output of outputs) expect(output).not.toContain(hex);
  });

  it('with no property, under any key', () => {
    const { key } = fresh();
    expect(Reflect.ownKeys(key)).toEqual([]);
    expect(Object.getOwnPropertyNames(KeyMaterial.prototype).sort()).toEqual([
      'constructor',
      'sameAs',
      'toJSON',
      'toString',
    ]);
    expect(Reflect.ownKeys(KeyMaterial).map(String).sort()).toEqual([
      'length',
      'name',
      'prototype',
    ]);
  });

  it('and is frozen, as are its prototype and class', () => {
    const { key } = fresh();
    expect(Object.isFrozen(key)).toBe(true);
    expect(Object.isFrozen(KeyMaterial.prototype)).toBe(true);
    expect(Object.isFrozen(KeyMaterial)).toBe(true);
  });

  it('and no structured clone or serialisation carries the bytes', () => {
    const { hex, key } = fresh();
    const clone: unknown = structuredClone(key);
    expect(clone).toEqual({});
    expect(() => revealKeyMaterial(clone as KeyMaterial)).toThrow(TypeError);
    expect(serialize(key).toString('hex')).not.toContain(hex);
  });
});

describe('revealKeyMaterial', () => {
  it('gives a fresh copy of the bytes each time', () => {
    const { hex, key } = fresh();
    const first = revealKeyMaterial(key);
    expect(Buffer.from(first).toString('hex')).toBe(hex);
    first.fill(0);
    expect(Buffer.from(revealKeyMaterial(key)).toString('hex')).toBe(hex);
  });

  it.each([
    ['an object of the same shape', Object.create(KeyMaterial.prototype)],
    ['a proxy of a key', new Proxy(fresh().key, {})],
    ['null', null],
    ['a string', 'key'],
  ])('refuses %s', (_name, value) => {
    expect(() => revealKeyMaterial(value as KeyMaterial)).toThrow(TypeError);
  });

  it('is not given out by the entry of the keys', () => {
    expect(Object.keys(keys).sort()).toEqual(
      ['KeyMaterial', 'keyMaterialLength'].sort(),
    );
  });
});

describe('KeyMaterial reads a key', () => {
  it('from 64 hex digits in lower case', () => {
    const hex = '0123456789abcdef'.repeat(4);
    expect(
      Buffer.from(revealKeyMaterial(new KeyMaterial(hex))).toString('hex'),
    ).toBe(hex);
  });

  it.each([
    ['63 digits', 'a'.repeat(31) + 'b'.repeat(32)],
    ['65 digits', 'a'.repeat(32) + 'b'.repeat(33)],
    ['capitals', 'A'.repeat(32) + 'b'.repeat(32)],
    ['a blank', 'a'.repeat(31) + ' ' + 'b'.repeat(32)],
    ['a sign after f', 'g'.repeat(2) + 'b'.repeat(62)],
    ['a sign before 0', '/'.repeat(2) + 'b'.repeat(62)],
    ['a line ending', 'a'.repeat(31) + 'b'.repeat(32) + '\n'],
    ['digits beyond ASCII', '٠'.repeat(2) + 'b'.repeat(62)],
    ['only zeros', '0'.repeat(64)],
    ['one byte value', 'ab'.repeat(32)],
    ['nothing', ''],
  ])('refuses %s with a RangeError that shows no value', (_name, hex) => {
    let error: unknown;
    try {
      new KeyMaterial(hex);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(RangeError);
    // The fixed message only, so no part of the value can be in it.
    expect((error as Error).message).toBe(
      'A key is 64 hex digits in lower case, and not all of its bytes are the same.',
    );
  });

  it('refuses a value that is no string', () => {
    expect(() => new KeyMaterial(42 as unknown as string)).toThrow(TypeError);
  });

  it('cannot be subclassed', () => {
    const hex = fresh().hex;
    // A subclass is the one way to reach the constructor with another
    // new.target.
    expect(() =>
      Reflect.construct(
        KeyMaterial,
        [hex],
        class Other {
          readonly kind = 'other';
        },
      ),
    ).toThrow(TypeError);
  });
});

describe('KeyMaterial.sameAs', () => {
  it('tells two keys with the same bytes from two with different ones', () => {
    const { hex, key } = fresh();
    expect(key.sameAs(new KeyMaterial(hex))).toBe(true);
    expect(key.sameAs(fresh().key)).toBe(false);
  });

  it('refuses anything but a key', () => {
    const { key } = fresh();
    expect(() => key.sameAs({} as KeyMaterial)).toThrow(TypeError);
    expect(() => key.sameAs(null as unknown as KeyMaterial)).toThrow(TypeError);
  });
});
