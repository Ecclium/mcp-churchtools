import { inspect } from 'node:util';
import { runInNewContext, runInThisContext } from 'node:vm';

import {
  EccliumError,
  errorCodes,
  type RightRef,
} from '@ecclium/mcp-churchtools-plugin-api';
import { assertNoCanary, makeCanaries } from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it, vi } from 'vitest';

import { Secret } from '../http/index.js';
import {
  describeError,
  type ErrorDescription,
  fixedSentences,
  maxMessageLength,
  maxMissingRights,
} from './index.js';

const brandKey = Symbol.for('ecclium.mcp-churchtools.error.v1');
const right: RightRef = { module: 'churchdb', right: 'view alldata' };
const internal: ErrorDescription = {
  code: 'internal',
  message: fixedSentences.internal,
};

/** A plain object with a fixed brand and the given own data properties. */
const forge = (
  fields: Record<string, unknown>,
  brand: PropertyDescriptor = { value: true },
): object =>
  Object.defineProperties(
    {},
    {
      [brandKey]: brand,
      ...Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [
          key,
          { value, enumerable: true },
        ]),
      ),
    },
  );

/** A plain object with a fixed brand and the given property descriptors. */
const forgeWith = (
  fields: PropertyDescriptorMap,
  brand: PropertyDescriptor = { value: true },
): object => Object.defineProperties({}, { [brandKey]: brand, ...fields });

/** A forged error with code permission and the given list of rights. */
const withRights = (missingRights: unknown): object =>
  forge({ code: 'permission', message: 'Ask the operator.', missingRights });

const permissionWithout: ErrorDescription = {
  code: 'permission',
  message: 'Ask the operator.',
};

interface Case {
  readonly what: string;
  readonly value: unknown;
  readonly expected: ErrorDescription;
}

/**
 * Thrown values that try to run code, leak text or slip past a check. Every
 * getter, trap and coercion hook counts a call, and the canaries sit where a
 * careless reader would pick them up.
 */
function hostileCases(canaries: ReturnType<typeof makeCanaries>): {
  readonly cases: readonly Case[];
  readonly calls: () => number;
} {
  const token = canaries.token.value;
  const email = canaries.email.value;
  const name = canaries.name.value;
  let calls = 0;
  const hook = (): string => {
    calls += 1;
    return token;
  };
  const trapAll: ProxyHandler<object> = {
    get: hook,
    getOwnPropertyDescriptor: () => {
      calls += 1;
      return { value: true, configurable: true };
    },
    getPrototypeOf: () => {
      calls += 1;
      return null;
    },
    has: () => {
      calls += 1;
      return true;
    },
    ownKeys: () => {
      calls += 1;
      return [];
    },
  };
  const coercing = {
    toString: hook,
    valueOf: hook,
    [Symbol.toPrimitive]: hook,
    toJSON: hook,
  };
  const getter = { get: hook, enumerable: true };
  const throwing = {
    get: () => {
      calls += 1;
      throw new Error(token);
    },
  };
  const revoked = Proxy.revocable({}, trapAll);
  revoked.revoke();
  const cyclic = new Error(token);
  const outer = new Error(email, { cause: cyclic });
  cyclic.cause = outer;
  const Suppressed = runInThisContext('SuppressedError') as new (
    error: unknown,
    suppressed: unknown,
    message?: string,
  ) => Error;
  const genuine = new EccliumError('not_found', 'No group has this ID.');
  const iterated = [right];
  Object.defineProperty(iterated, Symbol.iterator, {
    value: () => {
      calls += 1;
      return [{ module: 'churchdb', right: token }][Symbol.iterator]();
    },
  });
  const protoMessage = Object.create(
    new Proxy({ message: token }, trapAll),
  ) as object;
  Object.defineProperties(protoMessage, {
    [brandKey]: { value: true },
    code: { value: 'auth' },
  });
  const unknownCodes: readonly unknown[] = [
    'teapot',
    'Internal',
    'NOT_FOUND',
    'toString',
    '__proto__',
    'constructor',
    'hasOwnProperty',
    '',
    42,
    Symbol('auth'),
    null,
    coercing,
  ];
  const badMessages: readonly (readonly [string, string])[] = [
    ['a name with an umlaut', name],
    ['a line feed', `Sign-in failed.\n${token}`],
    ['a carriage return', `Sign-in failed.\r${token}`],
    ['a line separator', `Sign-in failed.\u2028${token}`],
    ['a paragraph separator', `Sign-in failed.\u2029${token}`],
    ['a next line', `Sign-in failed.\u0085${token}`],
    ['a tab', `Sign-in failed.\t${token}`],
    ['a NUL', `Sign-in failed.\u0000${token}`],
    ['a terminal escape', `\u001b[2J${token}`],
    ['a DEL', `Sign-in failed.\u007f${token}`],
    ['a zero-width space', `Sign\u200bin ${token}`],
    ['a bidi override', `\u202e${token}`],
    ['a variation selector', `ok\ufe0f${token}`],
    ['a no-break space', `Sign-in\u00a0${token}`],
  ];

  const cases: Case[] = [
    // The brand: own, exactly true, fixed.
    {
      what: 'a brand that is 1',
      value: forge({ code: 'auth', message: token }, { value: 1 }),
      expected: internal,
    },
    {
      what: 'a brand that is the string true',
      value: forge({ code: 'auth', message: token }, { value: 'true' }),
      expected: internal,
    },
    {
      what: 'a writable brand',
      value: forge(
        { code: 'auth', message: token },
        { value: true, writable: true },
      ),
      expected: internal,
    },
    {
      what: 'a brand that can be removed',
      value: forge(
        { code: 'auth', message: token },
        { value: true, configurable: true },
      ),
      expected: internal,
    },
    {
      what: 'a brand set by assignment on a foreign error',
      value: Object.assign(new Error(token), {
        [brandKey]: true,
        code: 'auth',
      }),
      expected: internal,
    },
    {
      what: 'a brand under a local symbol of the same name',
      value: Object.defineProperties(
        {},
        {
          [Symbol('ecclium.mcp-churchtools.error.v1')]: { value: true },
          code: { value: 'auth' },
          message: { value: token },
        },
      ),
      expected: internal,
    },
    {
      what: 'a brand only on the prototype',
      value: Object.defineProperties(Object.create(genuine) as object, {
        code: { value: 'auth' },
        message: { value: token },
      }),
      expected: internal,
    },
    {
      what: 'a brand as a getter',
      value: forgeWith(
        { code: { value: 'auth' } },
        {
          get: () => {
            calls += 1;
            return true;
          },
        },
      ),
      expected: internal,
    },
    // Proxies, refused before a trap runs.
    {
      what: 'a proxy over a genuine error',
      value: new Proxy(genuine, trapAll),
      expected: internal,
    },
    {
      what: 'a forging proxy',
      value: new Proxy({}, trapAll),
      expected: internal,
    },
    { what: 'a revoked proxy', value: revoked.proxy, expected: internal },
    {
      what: 'a proxy of another realm',
      value: runInNewContext(
        'new Proxy({}, { get: hook, getOwnPropertyDescriptor: hook })',
        { hook },
      ) as unknown,
      expected: internal,
    },
    // Getters on the fields are treated as absent.
    {
      what: 'a code getter',
      value: forgeWith({ code: getter }),
      expected: internal,
    },
    {
      what: 'a throwing code getter',
      value: forgeWith({ code: throwing }),
      expected: internal,
    },
    {
      what: 'a message getter',
      value: forgeWith({ code: { value: 'auth' }, message: getter }),
      expected: { code: 'auth', message: fixedSentences.auth },
    },
    {
      what: 'a throwing message getter',
      value: forgeWith({ code: { value: 'auth' }, message: throwing }),
      expected: { code: 'auth', message: fixedSentences.auth },
    },
    {
      what: 'a message only on a proxy in the prototype chain',
      value: protoMessage,
      expected: { code: 'auth', message: fixedSentences.auth },
    },
    {
      what: 'a getter for the missing rights',
      value: forgeWith({
        code: { value: 'permission' },
        message: { value: 'Ask the operator.' },
        missingRights: getter,
      }),
      expected: permissionWithout,
    },
    {
      what: 'a throwing getter for the missing rights',
      value: forgeWith({
        code: { value: 'permission' },
        message: { value: 'Ask the operator.' },
        missingRights: throwing,
      }),
      expected: permissionWithout,
    },
    {
      what: 'a list of rights with a length getter',
      value: withRights({
        get length() {
          return hook();
        },
      }),
      expected: permissionWithout,
    },
    {
      what: 'a getter on a right entry',
      value: withRights([
        {
          module: 'churchdb',
          get right() {
            return hook();
          },
        },
      ]),
      expected: permissionWithout,
    },
    {
      what: 'a custom iterator on the rights',
      value: withRights(iterated),
      expected: { ...permissionWithout, missingRights: [right] },
    },
    {
      what: 'a proxy as right entry',
      value: withRights([new Proxy(right, trapAll)]),
      expected: permissionWithout,
    },
    {
      what: 'a proxy as list of rights',
      value: withRights(new Proxy([right], trapAll)),
      expected: permissionWithout,
    },
    {
      what: 'a revoked proxy as list of rights',
      value: withRights(revoked.proxy),
      expected: permissionWithout,
    },
    // Unknown codes drop message and rights.
    ...unknownCodes.map((code, index): Case => ({
      what: `unknown code number ${String(index + 1)}`,
      value: forge({ code, message: token, missingRights: [right] }),
      expected: internal,
    })),
    {
      what: 'a message with hostile coercion',
      value: forge({ code: 'auth', message: coercing }),
      expected: { code: 'auth', message: fixedSentences.auth },
    },
    // Not an object.
    {
      what: 'a branded function',
      value: Object.defineProperties(() => token, {
        [brandKey]: { value: true },
        code: { value: 'auth' },
        message: { value: 'Sign-in failed.' },
      }),
      expected: internal,
    },
    ...[undefined, null, token, 42, 42n, true, Symbol(token)].map(
      (value): Case => ({
        what: `a primitive of type ${typeof value}`,
        value,
        expected: internal,
      }),
    ),
    // Values that a careless reader would turn into text.
    {
      what: 'an object with hostile coercion',
      value: coercing,
      expected: internal,
    },
    {
      what: 'an object without prototype',
      value: Object.create(null) as object,
      expected: internal,
    },
    { what: 'a secret', value: new Secret(token), expected: internal },
    // Foreign errors give a fixed sentence, never their text.
    { what: 'an error', value: new Error(token), expected: internal },
    {
      what: 'an error with a code of Node.js',
      value: Object.assign(new TypeError(email), { code: 'ECONNRESET' }),
      expected: internal,
    },
    {
      what: 'an error named like ours',
      value: Object.assign(new Error(token), {
        name: 'EccliumError',
        code: 'auth',
      }),
      expected: internal,
    },
    {
      what: 'an error with a cyclic cause',
      value: outer,
      expected: internal,
    },
    {
      what: 'an error caused by an EccliumError',
      value: new Error(token, { cause: genuine }),
      expected: internal,
    },
    {
      what: 'an AggregateError',
      value: new AggregateError([genuine, new Error(token)], email),
      expected: internal,
    },
    {
      what: 'a SuppressedError',
      value: new Suppressed(genuine, new Error(token), email),
      expected: internal,
    },
    {
      what: 'a DOMException',
      value: new DOMException(token, 'AbortError'),
      expected: internal,
    },
    {
      what: 'a timeout',
      value: new DOMException(token, 'TimeoutError'),
      expected: internal,
    },
    {
      what: 'an error of another realm',
      value: runInNewContext('new Error(text)', { text: token }) as unknown,
      expected: internal,
    },
    {
      what: 'a clone of an EccliumError',
      value: structuredClone(new EccliumError('auth', token)),
      expected: internal,
    },
    {
      what: 'a description',
      value: describeError(genuine),
      expected: internal,
    },
    // Messages that break the rules fall back to the fixed sentence.
    ...badMessages.map(([what, message]): Case => ({
      what: `a message with ${what}`,
      value: new EccliumError('auth', message),
      expected: { code: 'auth', message: fixedSentences.auth },
    })),
  ];
  return { cases, calls: () => calls };
}

describe('describeError', () => {
  it('keeps code and message of an EccliumError', () => {
    const result = describeError(
      new EccliumError('not_found', 'No group has this ID.'),
    );
    expect(result).toStrictEqual({
      code: 'not_found',
      message: 'No group has this ID.',
    });
  });

  it('describes an error of a second copy of plugin-api', async () => {
    vi.resetModules();
    const second = await import('@ecclium/mcp-churchtools-plugin-api');
    const error = new second.EccliumError('not_found', 'No such group.');
    expect(error).not.toBeInstanceOf(EccliumError);
    expect(describeError(error)).toStrictEqual({
      code: 'not_found',
      message: 'No such group.',
    });
  });

  it('describes a subclass with its own name and fields', () => {
    class GroupNotFound extends EccliumError {
      override readonly name = 'GroupNotFound';
      readonly groupId = 7;
    }
    expect(
      describeError(new GroupNotFound('not_found', 'No such group.')),
    ).toStrictEqual({ code: 'not_found', message: 'No such group.' });
  });

  it('lets a forged brand select a value whose fields it then checks', () => {
    // Any code in the process can forge the brand, also in another realm. It
    // gains nothing that a genuine EccliumError with the same content would
    // not give.
    const plain = forge({ code: 'auth', message: 'Sign-in failed.' });
    const foreignRealm = runInNewContext(
      `Object.defineProperties({}, {
        [Symbol.for('ecclium.mcp-churchtools.error.v1')]: { value: true },
        code: { value: 'auth' },
        message: { value: 'Sign-in failed.' },
      })`,
    ) as unknown;
    for (const value of [plain, foreignRealm]) {
      expect(describeError(value)).toStrictEqual({
        code: 'auth',
        message: 'Sign-in failed.',
      });
    }
  });

  it('gives the fixed sentence for the code internal, whatever its message', () => {
    expect(
      describeError(new EccliumError('internal', 'Failed at line 7.')),
    ).toStrictEqual(internal);
  });

  it('keeps the code with its fixed sentence for an empty, blank, missing or wrong message', () => {
    for (const message of ['', ' ', '   ', undefined, 7, null, ['x']]) {
      expect(describeError(forge({ code: 'conflict', message }))).toStrictEqual(
        { code: 'conflict', message: fixedSentences.conflict },
      );
    }
    expect(describeError(new EccliumError('conflict'))).toStrictEqual({
      code: 'conflict',
      message: fixedSentences.conflict,
    });
  });

  it('keeps a message of the longest length and replaces a longer one, never cutting it', () => {
    const longest = 'a'.repeat(maxMessageLength);
    expect(describeError(new EccliumError('validation', longest)).message).toBe(
      longest,
    );
    expect(
      describeError(new EccliumError('validation', `${longest}b`)).message,
    ).toBe(fixedSentences.validation);
    expect(
      describeError(new EccliumError('validation', 'a'.repeat(10_000_000)))
        .message,
    ).toBe(fixedSentences.validation);
  });

  it('keeps printable ASCII with padding and punctuation', () => {
    const message = ' Use ct_group_search first; IDs are numbers (1, 2, 3). ';
    expect(describeError(new EccliumError('not_found', message)).message).toBe(
      message,
    );
  });
});

describe('describeError with missing rights', () => {
  it('keeps a frozen copy for the code permission', () => {
    const rights = [right, { module: 'churchgroup', right: 'view' }];
    const error = new EccliumError('permission', 'Ask the operator.', {
      missingRights: rights,
    });
    const result = describeError(error);
    expect(result).toStrictEqual({
      code: 'permission',
      message: 'Ask the operator.',
      missingRights: rights,
    });
    expect(result.missingRights).not.toBe(error.missingRights);
    expect(Object.isFrozen(result.missingRights)).toBe(true);
    expect(Object.isFrozen(result.missingRights?.[0])).toBe(true);
  });

  it('keeps right names that are not lowercase words', () => {
    const rights = [
      { module: 'churchdb', right: 'view alldata(-1)' },
      { module: 'churchcal', right: 'Edit Category' },
    ];
    expect(describeError(withRights(rights)).missingRights).toStrictEqual(
      rights,
    );
  });

  it('drops extra fields of an entry', () => {
    const canary = makeCanaries().email;
    const result = describeError(
      withRights([{ ...right, note: canary.value }]),
    );
    expect(Object.keys(result.missingRights?.[0] ?? {})).toEqual([
      'module',
      'right',
    ]);
    assertNoCanary(result, [canary], 'description');
  });

  it('drops them for every other code', () => {
    const result = describeError(
      forge({ code: 'not_found', message: 'x', missingRights: [right] }),
    );
    expect(Object.hasOwn(result, 'missingRights')).toBe(false);
  });

  it('drops a list longer than the bound, also a huge sparse one', () => {
    // A copy that walks every index, such as Array.from, would run out of
    // memory on the sparse list.
    const sparse: RightRef[] = [];
    sparse.length = 2 ** 32 - 1;
    const started = performance.now();
    expect(
      describeError(
        withRights(Array.from({ length: maxMissingRights + 1 }, () => right)),
      ),
    ).toStrictEqual(permissionWithout);
    expect(describeError(withRights(sparse))).toStrictEqual(permissionWithout);
    expect(performance.now() - started).toBeLessThan(500);
    expect(
      describeError(
        withRights(Array.from({ length: maxMissingRights }, () => right)),
      ).missingRights,
    ).toHaveLength(maxMissingRights);
  });

  it.each([
    ['an empty list', []],
    ['a list that is no array', { length: 1, 0: right }],
    ['a list with a hole', Object.assign([], { 1: right })],
    ['a blank module', [{ module: ' ', right: 'view' }]],
    ['a padded right', [{ module: 'churchdb', right: ' view' }]],
    ['a line break', [{ module: 'churchdb', right: 'view\nall' }]],
    ['an umlaut', [{ module: 'churchdb', right: 'sehen ü' }]],
    ['101 characters', [{ module: 'churchdb', right: 'v'.repeat(101) }]],
    ['an empty right', [{ module: 'churchdb', right: '' }]],
    ['a number', [{ module: 'churchdb', right: 7 }]],
    ['a missing right', [{ module: 'churchdb' }]],
    ['an inherited right', [Object.create(right) as object]],
    ['null as entry', [null]],
    ['a string as entry', ['churchdb view']],
    ['a good and a bad entry', [right, { module: 'churchdb', right: '' }]],
    ['a string as list', 'churchdb view'],
  ])('drops the whole list for %s', (_what, list) => {
    expect(describeError(withRights(list))).toStrictEqual(permissionWithout);
  });
});

describe('describeError over hostile values', () => {
  it.each(
    hostileCases(makeCanaries()).cases.map((entry) => [entry.what, entry]),
  )('handles %s', (_what, entry) => {
    expect(describeError(entry.value)).toStrictEqual(entry.expected);
  });

  it('never throws, runs no code of the value, leaks no canary and gives the same result twice', () => {
    const canaries = makeCanaries();
    const { cases, calls } = hostileCases(canaries);
    const results = cases.map((entry) => describeError(entry.value));
    const again = cases.map((entry) => describeError(entry.value));
    expect(calls()).toBe(0);
    expect(again).toStrictEqual(results);
    assertNoCanary(results, canaries.all, 'descriptions');
    assertNoCanary(
      results.map((result) => JSON.stringify(result) + inspect(result)),
      canaries.all,
      'printed descriptions',
    );
  });
});

describe('the result of describeError', () => {
  it('is a frozen plain object with its keys in a fixed order', () => {
    const inputs = [
      new EccliumError('auth', 'Sign-in failed.'),
      new EccliumError('permission', 'x', { missingRights: [right] }),
      new Error('x'),
    ];
    for (const input of inputs) {
      const result = describeError(input);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
      expect(Object.getOwnPropertySymbols(result)).toEqual([]);
      expect(Object.keys(result)).toEqual(
        Object.hasOwn(result, 'missingRights')
          ? ['code', 'message', 'missingRights']
          : ['code', 'message'],
      );
      expect(JSON.parse(JSON.stringify(result))).toStrictEqual({ ...result });
    }
  });
});

describe('fixedSentences', () => {
  it('has one sentence per code and nothing more', () => {
    expect(Object.keys(fixedSentences).toSorted()).toEqual(
      [...errorCodes].toSorted(),
    );
  });

  it('holds sentences that pass the rule for messages', () => {
    for (const code of errorCodes) {
      const sentence = fixedSentences[code];
      expect(sentence, code).toMatch(/^[\x20-\x7e]+$/);
      expect(sentence.length, code).toBeLessThanOrEqual(maxMessageLength);
      expect(sentence.trim(), code).toBe(sentence);
      if (code !== 'internal') {
        expect(describeError(new EccliumError(code, sentence)).message).toBe(
          sentence,
        );
      }
    }
  });

  it('is frozen and has no prototype', () => {
    expect(Object.isFrozen(fixedSentences)).toBe(true);
    expect(Object.getPrototypeOf(fixedSentences)).toBeNull();
    expect('toString' in fixedSentences).toBe(false);
  });
});
