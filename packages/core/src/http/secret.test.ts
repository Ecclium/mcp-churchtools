import assert from 'node:assert';
import { format, inspect } from 'node:util';
import { serialize } from 'node:v8';

import {
  assertNoCanary,
  assertPlanted,
  makeCanary,
} from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it, vi } from 'vitest';

import * as core from '../index.js';
import * as http from './index.js';
import { revealSecret, Secret } from './secret.js';

// Every test plants a fresh canary as the value and proves it absent from
// what the secret turns into. revealSecret is the positive control: it is
// the one way back to the value.

const fresh = (): { value: string; secret: Secret } => {
  const canary = makeCanary('token');
  return { value: canary.value, secret: new Secret(canary.value) };
};

const fullInspect = (value: unknown): string =>
  inspect(value, {
    customInspect: false,
    showHidden: true,
    getters: true,
    depth: Infinity,
    showProxy: true,
  });

describe('Secret prints as the placeholder', () => {
  it('in toString, toJSON, JSON and inspect', () => {
    const { secret } = fresh();
    expect(String(secret)).toBe('[REDACTED]');
    expect(secret.toJSON()).toBe('[REDACTED]');
    expect(JSON.stringify(secret)).toBe('"[REDACTED]"');
    expect(inspect(secret)).toBe('[REDACTED]');
    expect(inspect({ secret })).toBe('{ secret: [REDACTED] }');
  });

  it('through every format of util.format', () => {
    const canary = makeCanary('token');
    const secret = new Secret(canary.value);
    const outputs = ['%s', '%o', '%O', '%j', '%d', '%i'].map((f) =>
      format(f, secret),
    );
    outputs.push(format(secret), format('x', secret), format('%s', { secret }));
    expect(format('%s', secret)).toBe('[REDACTED]');
    assertNoCanary(outputs, [canary], 'util.format');
  });

  it('through JSON with nesting, replacers and indentation', () => {
    const canary = makeCanary('token');
    const secret = new Secret(canary.value);
    const seen: unknown[] = [];
    const outputs = [
      JSON.stringify({ a: [{ b: secret }] }),
      JSON.stringify({ a: secret }, ['a']),
      JSON.stringify({ a: secret }, null, 2),
      JSON.stringify({ a: secret }, (_key, value: unknown) => {
        seen.push(value);
        return value;
      }),
      // A replacer that returns the holder's property gets the secret
      // object, which serialises as an empty object.
      JSON.stringify(
        { a: secret },
        function (this: Record<string, unknown>, key, value: unknown) {
          return key === 'a' ? this[key] : value;
        },
      ),
    ];
    expect(outputs[0]).toBe('{"a":[{"b":"[REDACTED]"}]}');
    expect(outputs[4]).toBe('{"a":{}}');
    assertNoCanary([outputs, seen], [canary], 'JSON');
  });

  it('through string coercion and web APIs', () => {
    const canary = makeCanary('token');
    const secret = new Secret(canary.value);
    const value = secret as never;
    const outputs = [
      String(secret),
      ''.concat(value),
      [secret].join(),
      String.raw({ raw: ['', ''] }, secret),
      new Error(value).message,
      encodeURIComponent(value),
      new URLSearchParams({ t: value }).toString(),
      new Headers({ authorization: value }).get('authorization'),
    ];
    expect(outputs[6]).toBe('t=%5BREDACTED%5D');
    assertNoCanary(outputs, [canary], 'coercion');
  });

  it('without valueOf or Symbol.toPrimitive that would give the value', () => {
    const canary = makeCanary('token');
    const secret = new Secret(canary.value);
    expect(secret.valueOf()).toBe(secret);
    expect(Number(secret)).toBeNaN();
    let bigintError: unknown;
    try {
      BigInt(secret as never);
    } catch (error) {
      bigintError = error;
    }
    expect(bigintError).toBeInstanceOf(SyntaxError);
    assertNoCanary(fullInspect(bigintError), [canary], 'BigInt error');
    expect(Object.getOwnPropertyNames(Secret.prototype).sort()).toEqual([
      'constructor',
      'toJSON',
      'toString',
    ]);
    expect(Object.getOwnPropertySymbols(Secret.prototype)).toEqual([
      inspect.custom,
    ]);
  });

  it('refusing Buffer.from instead of encoding anything', () => {
    const canary = makeCanary('token');
    const secret = new Secret(canary.value);
    let error: unknown;
    try {
      Buffer.from(secret as never);
    } catch (thrown) {
      error = thrown;
    }
    expect((error as { code?: string }).code).toBe('ERR_INVALID_ARG_TYPE');
    assertNoCanary(fullInspect(error), [canary], 'Buffer.from');
  });

  it('as no String wrapper', () => {
    const { secret } = fresh();
    expect(Object.getPrototypeOf(Secret.prototype)).toBe(Object.prototype);
    expect((secret as never as string)[0]).toBeUndefined();
    expect((secret as never as string).length).toBeUndefined();
  });
});

describe('Secret holds its value where no copy reaches it', () => {
  it('in no own property, under any key', () => {
    const canary = makeCanary('token');
    const secret = new Secret(canary.value);
    const keys: string[] = [];
    for (const key in secret) keys.push(key);
    expect(Reflect.ownKeys(secret)).toEqual([]);
    expect(Object.getOwnPropertyDescriptors(secret)).toEqual({});
    expect(keys).toEqual([]);
    assertNoCanary(
      // The spread is the point: it must not carry the value.
      [
        { ...(secret as object) },
        Object.assign({}, secret),
        Object.entries(secret),
      ],
      [canary],
      'copies',
    );
  });

  it('hidden from util.inspect without the custom hook', () => {
    const canary = makeCanary('token');
    const secret = new Secret(canary.value);
    assertNoCanary(
      [
        fullInspect(secret),
        fullInspect({ a: [secret] }),
        inspect({ a: { b: secret } }, { depth: 0 }),
      ],
      [canary],
      'inspect',
    );
  });

  it('out of the messages of node:assert', () => {
    const canary = makeCanary('token');
    const secret = new Secret(canary.value);
    const errors: unknown[] = [];
    for (const check of [
      () => {
        assert.strictEqual(secret, 'x');
      },
      () => {
        assert.notStrictEqual(secret, secret);
      },
      () => {
        assert.deepStrictEqual({ secret }, { secret: 'x' });
      },
    ]) {
      try {
        check();
      } catch (error) {
        errors.push(fullInspect(error));
      }
    }
    expect(errors).toHaveLength(3);
    assertNoCanary(errors, [canary], 'assert');
  });

  it('out of structured clones, messages and v8 serialisation', async () => {
    const canary = makeCanary('token');
    const secret = new Secret(canary.value);
    const clone = structuredClone(secret);
    const nested = structuredClone({
      a: secret,
      e: new Error('x', { cause: secret }),
    });
    const { port1, port2 } = new MessageChannel();
    const received = new Promise<unknown>((resolve) => {
      port2.once('message', resolve);
    });
    port1.postMessage({ secret });
    const message = await received;
    port1.close();
    port2.close();
    assertNoCanary(
      [
        fullInspect(clone),
        fullInspect(nested),
        fullInspect(message),
        serialize(secret),
        serialize({ secret }),
      ],
      [canary],
      'clones',
    );
    expect(() => revealSecret(clone)).toThrow('Not a secret.');
  });

  it('out of error causes and aggregate errors', () => {
    const canary = makeCanary('token');
    const secret = new Secret(canary.value);
    const withCause = new Error('failed', { cause: secret });
    const aggregate = new AggregateError([secret], 'failed');
    expect(inspect(withCause)).toContain('[cause]: [REDACTED]');
    assertNoCanary(
      [
        inspect(withCause),
        inspect(aggregate),
        fullInspect(withCause),
        fullInspect(aggregate),
      ],
      [canary],
      'errors',
    );
  });

  it('out of a proxy, which still prints the placeholder', () => {
    const canary = makeCanary('token');
    const proxy = new Proxy(new Secret(canary.value), {});
    expect(String(proxy)).toBe('[REDACTED]');
    assertNoCanary([inspect(proxy), fullInspect(proxy)], [canary], 'proxy');
  });
});

describe('revealSecret', () => {
  it('gives the value back, the positive control', () => {
    const canary = makeCanary('token');
    const secret = new Secret(canary.value);
    assertPlanted(revealSecret(secret), [canary], 'revealed value');
    expect(revealSecret(secret)).toBe(canary.value);
  });

  it('refuses anything that is not a secret of this module', () => {
    const { secret } = fresh();
    const fakes: unknown[] = [
      Object.create(Secret.prototype),
      structuredClone(secret),
      { ...(secret as object) },
      {},
      null,
      undefined,
      '[REDACTED]',
    ];
    for (const fake of fakes) {
      expect(() => revealSecret(fake as Secret)).toThrow(
        new TypeError('Not a secret.'),
      );
    }
  });

  it('gives a proxy no chance to see the key', () => {
    const { secret } = fresh();
    const seen: PropertyKey[] = [];
    const proxy = new Proxy(secret, {
      get: (target, key, receiver) => {
        seen.push(key);
        return Reflect.get(target, key, receiver) as unknown;
      },
      has: (target, key) => {
        seen.push(key);
        return Reflect.has(target, key);
      },
    });
    expect(() => revealSecret(proxy)).toThrow('Not a secret.');
    expect(seen.filter((key) => typeof key === 'symbol')).toEqual([]);
  });

  it('leaves no key on the class or reachable through an instance', () => {
    const { secret } = fresh();
    expect(Object.getOwnPropertySymbols(Secret)).toEqual([]);
    expect(Reflect.ownKeys(Secret).sort()).toEqual([
      'length',
      'name',
      'prototype',
    ]);
    const ctor = (secret as unknown as { constructor: object }).constructor;
    expect(Object.getOwnPropertySymbols(ctor)).toEqual([]);
  });

  it('refuses a secret of a second copy of the module', async () => {
    vi.resetModules();
    const second = await import('./secret.js');
    const { secret } = fresh();
    expect(() => second.revealSecret(secret)).toThrow('Not a secret.');
    expect(secret).not.toBeInstanceOf(second.Secret);
  });

  it('is not passed on by an entry point', () => {
    for (const entry of [core, http] as Record<string, unknown>[]) {
      expect(Object.values(entry)).not.toContain(revealSecret);
    }
    expect(Object.keys(http)).toEqual([
      'originCodes',
      'parseChurchToolsOrigin',
      'Secret',
    ]);
  });
});

describe('Secret takes only visible ASCII', () => {
  const visible = Array.from({ length: 94 }, (_v, i) =>
    String.fromCharCode(0x21 + i),
  ).join('');

  it('of 1 to 4096 characters, unchanged', () => {
    expect(revealSecret(new Secret('a'))).toBe('a');
    expect(revealSecret(new Secret('a'.repeat(4096)))).toHaveLength(4096);
    expect(revealSecret(new Secret(visible))).toBe(visible);
  });

  it.each([
    ['nothing', ''],
    ['4097 characters', 'a'.repeat(4097)],
    ['a space', 'ab cd'],
    ['a leading space', ' abcd'],
    ['a line feed', 'abcd\n'],
    ['a carriage return', 'ab\rcd'],
    ['a tab', 'ab\tcd'],
    ['NUL', 'ab\u0000cd'],
    ['DEL', 'ab\u007Fcd'],
    ['a non-breaking space', 'ab cd'],
    ['a soft hyphen', 'ab­cd'],
    ['a zero-width space', 'ab​cd'],
    ['a byte order mark', '﻿abcd'],
    ['NEL', 'ab\u0085cd'],
    ['an e with acute', 'abécd'],
    ['a Cyrillic a', 'аbcd'],
    ['a lone surrogate', 'ab\uD800cd'],
    ['an emoji', 'ab\u{1F600}cd'],
    ['the placeholder', '[REDACTED]'],
    ['the placeholder in JSON', '"[REDACTED]"'],
    ['the placeholder in a URL', '%5BREDACTED%5D'],
    ['the placeholder with a prefix', 'Login[REDACTED]'],
  ])('and refuses %s with one fixed message', (_what, value) => {
    expect(() => new Secret(value)).toThrow(
      new RangeError(
        'A secret must be 1 to 4096 visible ASCII characters and no placeholder.',
      ),
    );
  });

  it.each([
    ['a number', 123],
    ['null', null],
    ['undefined', undefined],
    ['a string object', new String('abcd')],
    ['an array', ['abcd']],
    ['another secret', new Secret('abcd')],
  ])('and refuses %s without converting it', (_what, value) => {
    expect(() => new Secret(value as never)).toThrow(
      new TypeError('A secret must be a string.'),
    );
  });

  it('and never shows the input when it refuses it', () => {
    const canary = makeCanary('token');
    const errors: unknown[] = [];
    for (const value of [
      `${canary.value} `,
      `\n${canary.value}`,
      `${canary.value}REDACTED`,
    ]) {
      try {
        new Secret(value);
      } catch (error) {
        errors.push(error);
      }
    }
    expect(errors).toHaveLength(3);
    for (const error of errors) {
      expect(Object.getOwnPropertyNames(error).sort()).toEqual([
        'message',
        'stack',
      ]);
      expect((error as Error).cause).toBeUndefined();
    }
    assertNoCanary(errors.map(fullInspect), [canary], 'refusals');
  });

  it('and leaves no legacy RegExp static holding the value', () => {
    const canary = makeCanary('token');
    new Secret(canary.value);
    const statics = RegExp as unknown as Record<string, unknown>;
    const values = [
      '$_',
      'input',
      'lastMatch',
      '$&',
      'leftContext',
      'rightContext',
    ].map((key) => statics[key]);
    assertNoCanary(values, [canary], 'RegExp statics');
  });

  it('and refuses a huge input', () => {
    expect(() => new Secret('a'.repeat(100_000_000))).toThrow(RangeError);
  });
});

describe('Secret is final and frozen', () => {
  it('cannot be subclassed', () => {
    class Copying extends Secret {
      readonly #copy: string;
      constructor(value: string) {
        super(value);
        this.#copy = value;
      }
      leak(): string {
        return this.#copy;
      }
    }
    expect(() => new Copying('abcd')).toThrow(
      new TypeError('A secret cannot be subclassed.'),
    );
  });

  it('freezes instance, prototype and class', () => {
    const { secret } = fresh();
    expect(Object.isFrozen(secret)).toBe(true);
    expect(Object.isFrozen(Secret.prototype)).toBe(true);
    expect(Object.isFrozen(Secret)).toBe(true);
    expect(() => {
      Object.setPrototypeOf(secret, null);
    }).toThrow(TypeError);
  });

  it('looks equal to any other secret to deep equality', () => {
    // Pinned so that no test relies on deep equality to compare values:
    // compare revealSecret(a) with the expected value inside this folder.
    expect(new Secret('abcd')).toEqual(new Secret('efgh'));
  });
});
