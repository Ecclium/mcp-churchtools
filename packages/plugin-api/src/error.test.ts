import { assertNoCanary, makeCanary } from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it, vi } from 'vitest';

import {
  EccliumError,
  type EccliumErrorOptions,
  errorCodes,
  isEccliumError,
  type RightRef,
} from './index.js';

const brand = Symbol.for('ecclium.mcp-churchtools.error.v1');
const right: RightRef = { module: 'churchdb', right: 'view alldata' };

describe('EccliumError', () => {
  it('keeps code and message as own properties that cannot change', () => {
    const error = new EccliumError('not_found', 'No group has this ID.');
    expect(error.code).toBe('not_found');
    expect(error.message).toBe('No group has this ID.');
    expect(error.name).toBe('EccliumError');
    for (const key of ['code', 'message']) {
      const property = Object.getOwnPropertyDescriptor(error, key);
      expect(property?.writable, key).toBe(false);
      expect(property?.configurable, key).toBe(false);
    }
    expect(() => {
      (error as { code: string }).code = 'auth';
    }).toThrow(TypeError);
  });

  it('carries the brand as a hidden, fixed own property', () => {
    const error = new EccliumError('auth', 'Sign-in failed.');
    const property = Object.getOwnPropertyDescriptor(error, brand);
    expect(property).toEqual({
      value: true,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    expect(JSON.stringify(error)).toBe('{"code":"auth"}');
  });

  it('never has a cause, also when untyped options carry one', () => {
    const canary = makeCanary('token');
    const options = {
      cause: new Error(canary.value),
    } as unknown as EccliumErrorOptions;
    const error = new EccliumError('upstream', 'Try again later.', options);
    expect(Object.hasOwn(error, 'cause')).toBe(false);
    assertNoCanary(error, [canary], 'error');
  });

  it('turns an unknown code from an untyped caller into internal', () => {
    for (const code of ['teapot', 'Internal', '', Symbol('x'), 42, undefined]) {
      const error = new EccliumError(code as never, 'hi', {
        missingRights: [right],
      });
      expect(error.code).toBe('internal');
      expect(error.message).toBe('');
      expect(Object.hasOwn(error, 'missingRights')).toBe(false);
    }
  });

  it('takes a message only if it is a string', () => {
    const canary = makeCanary('token');
    const hostile = {
      toString: () => canary.value,
    };
    const error = new EccliumError('validation', hostile as never);
    expect(error.message).toBe('');
    assertNoCanary(error, [canary], 'error');
  });

  it('rejects a code that is not a stable one in its types', () => {
    // @ts-expect-error: only the stable codes
    const error = new EccliumError('teapot');
    expect(error.code).toBe('internal');
  });
});

describe('EccliumError with missing rights', () => {
  it('keeps a frozen copy for the code permission', () => {
    const input = [right, { module: 'churchgroup', right: 'view' }];
    const error = new EccliumError('permission', 'Ask the operator.', {
      missingRights: input,
    });
    expect(error.missingRights).toEqual(input);
    expect(error.missingRights).not.toBe(input);
    expect(Object.isFrozen(error.missingRights)).toBe(true);
    expect(Object.isFrozen(error.missingRights?.[0])).toBe(true);
    input.push({ module: 'x', right: 'y' });
    expect(error.missingRights).toHaveLength(2);
  });

  it('drops them for every other code', () => {
    const error = new EccliumError('not_found', 'x', {
      missingRights: [right],
    });
    expect(Object.hasOwn(error, 'missingRights')).toBe(false);
  });

  it('drops extra fields of an entry', () => {
    const canary = makeCanary('email');
    const error = new EccliumError('permission', 'x', {
      missingRights: [{ ...right, note: canary.value } as RightRef],
    });
    expect(Object.keys(error.missingRights?.[0] ?? {})).toEqual([
      'module',
      'right',
    ]);
    assertNoCanary(error, [canary], 'error');
  });

  it.each([
    ['an empty list', []],
    ['33 entries', Array.from({ length: 33 }, () => right)],
    ['a blank module', [{ module: ' ', right: 'view' }]],
    ['a padded right', [{ module: 'churchdb', right: 'view ' }]],
    ['a line break', [{ module: 'churchdb', right: 'view\nall' }]],
    ['an umlaut', [{ module: 'churchdb', right: 'sehen ü' }]],
    ['101 characters', [{ module: 'churchdb', right: 'v'.repeat(101) }]],
    ['a number', [{ module: 'churchdb', right: 7 }]],
    ['null as entry', [null]],
    ['a string as entry', ['churchdb view']],
    ['a list that is no array', { length: 1, 0: right }],
  ])('drop the whole list for %s', (_what, list) => {
    const error = new EccliumError('permission', 'x', {
      missingRights: list as never,
    });
    expect(Object.hasOwn(error, 'missingRights')).toBe(false);
    expect(error.code).toBe('permission');
  });

  it('read no getter, iterator or huge sparse list of the caller', () => {
    const canary = makeCanary('token');
    let calls = 0;
    const count = (): string => {
      calls += 1;
      return canary.value;
    };
    const withGetterEntry = [
      {
        module: 'churchdb',
        get right() {
          return count();
        },
      },
    ];
    const withIterator = [right];
    Object.defineProperty(withIterator, Symbol.iterator, {
      value: () => {
        calls += 1;
        return [][Symbol.iterator]();
      },
    });
    const sparse: RightRef[] = [];
    sparse.length = 2 ** 32 - 1;
    const optionsWithGetter = {
      get missingRights(): readonly RightRef[] {
        calls += 1;
        throw new Error(canary.value);
      },
    };
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const started = performance.now();
    const errors = [
      new EccliumError('permission', 'x', {
        missingRights: withGetterEntry,
      }),
      new EccliumError('permission', 'x', { missingRights: withIterator }),
      new EccliumError('permission', 'x', { missingRights: sparse }),
      new EccliumError('permission', 'x', optionsWithGetter),
      new EccliumError('permission', 'x', revoked.proxy),
    ];
    expect(performance.now() - started).toBeLessThan(1000);
    expect(calls).toBe(0);
    expect(errors[1]?.missingRights).toEqual([right]);
    for (const error of [errors[0], errors[2], errors[3], errors[4]]) {
      expect(Object.hasOwn(error ?? {}, 'missingRights')).toBe(false);
    }
    assertNoCanary(errors, [canary], 'errors');
  });
});

describe('isEccliumError', () => {
  it('recognises an EccliumError and a subclass with its own name', () => {
    class GroupNotFound extends EccliumError {
      override readonly name = 'GroupNotFound';
    }
    expect(isEccliumError(new EccliumError('auth', 'x'))).toBe(true);
    const sub = new GroupNotFound('not_found', 'No group has this ID.');
    expect(isEccliumError(sub)).toBe(true);
    expect(sub.name).toBe('GroupNotFound');
  });

  it('makes a subclass with its own code or message field fail loudly', () => {
    class Coded extends EccliumError {
      override readonly code = 'auth' as const;
    }
    class Worded extends EccliumError {
      override readonly message = 'Another text.';
    }
    expect(() => new Coded('not_found', 'x')).toThrow(TypeError);
    expect(() => new Worded('not_found', 'x')).toThrow(TypeError);
  });

  it('locks the missing rights only where it sets them', () => {
    class Rights extends EccliumError {
      override readonly missingRights = [right];
    }
    expect(
      () => new Rights('permission', 'x', { missingRights: [right] }),
    ).toThrow(TypeError);
    const added = new Rights('not_found', 'x');
    expect(
      Object.getOwnPropertyDescriptor(added, 'missingRights'),
    ).toMatchObject({ writable: true, configurable: true });
  });

  it('recognises an error of a second copy of this package, where instanceof fails', async () => {
    vi.resetModules();
    const second = await import('./errors.js');
    const error = new second.EccliumError('not_found', 'x');
    expect(error).not.toBeInstanceOf(EccliumError);
    expect(isEccliumError(error)).toBe(true);
  });

  it.each([
    [
      'a plain object with a writable brand',
      { [brand]: true, code: 'auth', message: 'x' },
    ],
    [
      'a writable brand that cannot be removed',
      Object.defineProperties(
        {},
        {
          [brand]: { value: true, writable: true, configurable: false },
          code: { value: 'auth' },
          message: { value: 'x' },
        },
      ),
    ],
    [
      'a fixed brand that can be removed',
      Object.defineProperties(
        {},
        {
          [brand]: { value: true, writable: false, configurable: true },
          code: { value: 'auth' },
          message: { value: 'x' },
        },
      ),
    ],
    [
      'a brand on the prototype',
      Object.create(new EccliumError('auth', 'x')) as object,
    ],
    [
      'an unknown code',
      Object.defineProperties(
        {},
        {
          [brand]: { value: true },
          code: { value: 'teapot' },
          message: { value: 'x' },
        },
      ),
    ],
    [
      'a message that is no string',
      Object.defineProperties(
        {},
        {
          [brand]: { value: true },
          code: { value: 'auth' },
          message: { value: 7 },
        },
      ),
    ],
    [
      'a branded function',
      Object.defineProperties(() => undefined, {
        [brand]: { value: true },
        code: { value: 'auth' },
        message: { value: 'x' },
      }),
    ],
    ['null', null],
    ['a string', 'EccliumError'],
    ['a number', 7],
    ['a symbol', Symbol('x')],
  ])('refuses %s', (_what, value) => {
    expect(isEccliumError(value)).toBe(false);
  });

  it('runs no getter and never throws', () => {
    let calls = 0;
    const withAccessorBrand = Object.defineProperty({}, brand, {
      get: () => {
        calls += 1;
        return true;
      },
    });
    const throwing = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          throw new Error('trap');
        },
      },
    );
    expect(isEccliumError(withAccessorBrand)).toBe(false);
    expect(isEccliumError(throwing)).toBe(false);
    expect(calls).toBe(0);
  });

  it('is in line with the list of codes', () => {
    for (const code of errorCodes) {
      expect(isEccliumError(new EccliumError(code, 'x'))).toBe(true);
    }
  });
});
