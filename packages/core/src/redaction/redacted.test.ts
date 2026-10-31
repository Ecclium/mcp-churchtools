import { describe, expect, it } from 'vitest';

import { isRedacted, sealRedacted } from './redacted.js';

// The mark of a redacted result (ADR 0026): only sealRedacted gives it,
// nothing a copy or a proxy can make carries it, and it shows nowhere a
// client could see it.

describe('sealRedacted', () => {
  it('gives a frozen copy without a prototype that carries the mark', () => {
    const nested = Object.freeze({ id: 2 });
    const data = { id: 1, nested };
    const sealed = sealRedacted(data);
    expect(sealed).not.toBe(data);
    expect(Object.isFrozen(sealed)).toBe(true);
    expect(Object.getPrototypeOf(sealed)).toBeNull();
    expect(sealed['nested']).toBe(nested);
    expect(isRedacted(sealed)).toBe(true);
    expect(isRedacted(data)).toBe(false);
  });

  it('hides the mark from JSON, the keys and a copy', () => {
    const sealed = sealRedacted({ id: 1 });
    expect(JSON.stringify(sealed)).toBe('{"id":1}');
    expect(Object.keys(sealed)).toEqual(['id']);
    expect(Object.getOwnPropertySymbols({ ...sealed })).toEqual([]);
    expect(isRedacted({ ...sealed })).toBe(false);
    expect(isRedacted(Object.assign({}, sealed))).toBe(false);
    expect(isRedacted(structuredClone({ ...sealed }))).toBe(false);
  });

  it('cannot lose its mark', () => {
    const sealed = sealRedacted({ id: 1 });
    const [symbol] = Object.getOwnPropertySymbols(sealed);
    expect(symbol).toBeDefined();
    expect(() =>
      Object.defineProperty(sealed, symbol as symbol, { value: false }),
    ).toThrow(TypeError);
    expect(isRedacted(sealed)).toBe(true);
  });
});

describe('isRedacted', () => {
  it.each([undefined, null, 1, 'text', true, [], {}])(
    'is false for %j',
    (value) => {
      expect(isRedacted(value)).toBe(false);
    },
  );

  it('is false for a proxy, also one around a marked result', () => {
    expect(isRedacted(new Proxy(sealRedacted({ id: 1 }), {}))).toBe(false);
    const reporting = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => ({
          value: true,
          writable: false,
          enumerable: false,
          configurable: false,
        }),
      },
    );
    const throwing = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          throw new Error('trap');
        },
      },
    );
    expect(isRedacted(reporting)).toBe(false);
    expect(isRedacted(throwing)).toBe(false);
  });

  it('is false for an object that copied the symbol with a value that can change', () => {
    const sealed = sealRedacted({ id: 1 });
    const [symbol] = Object.getOwnPropertySymbols(sealed);
    const copied = Object.defineProperty({}, symbol as symbol, {
      value: true,
      writable: true,
      configurable: true,
    });
    expect(isRedacted(copied)).toBe(false);
    const getter = Object.defineProperty({}, symbol as symbol, {
      get: () => true,
    });
    expect(isRedacted(getter)).toBe(false);
    for (const descriptor of [
      { value: 1, writable: false, configurable: false },
      { value: true, writable: false, configurable: true },
    ]) {
      const object = Object.defineProperty({}, symbol as symbol, descriptor);
      expect(isRedacted(object)).toBe(false);
    }
  });

  it('is true for an object that holds the symbol as the mark does', () => {
    // Who holds the symbol can make the mark, which is why only the
    // pipeline and the serialisation import this module.
    const sealed = sealRedacted({ id: 1 });
    const [symbol] = Object.getOwnPropertySymbols(sealed);
    const copied = Object.defineProperty({}, symbol as symbol, {
      value: true,
      writable: false,
      configurable: false,
    });
    expect(isRedacted(copied)).toBe(true);
  });
});
