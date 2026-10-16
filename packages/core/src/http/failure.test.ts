import { isEccliumError } from '@ecclium/mcp-churchtools-plugin-api';
import { describe, expect, it } from 'vitest';

import { isEventName } from '../logger/index.js';
import {
  categoriseFailure,
  categoryCodes,
  type FailureCategory,
  failureCategories,
  type FailureContext,
  HttpTransportError,
} from './failure.js';

// The thrown values here are built by hand with the codes undici and
// Node.js use. Tests with the real errors follow with the transport.

const deadline = Object.freeze({ reason: 'deadline' });
const inRequest: FailureContext = {
  phase: 'request',
  deadline,
  callerAborted: false,
};
const inBody: FailureContext = { ...inRequest, phase: 'body' };

const withCode = (code: string): Error =>
  Object.assign(new Error('a message with https://demo.example/api'), {
    code,
  });

describe('categoriseFailure', () => {
  it.each([
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'CERT_HAS_EXPIRED',
    'CERT_NOT_YET_VALID',
    'HOSTNAME_MISMATCH',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'ERR_TLS_HANDSHAKE_TIMEOUT',
    'ERR_SSL_WRONG_VERSION_NUMBER',
    'EPROTO',
  ])('give tls for %s in both phases', (code) => {
    expect(categoriseFailure(withCode(code), inRequest)).toBe('tls');
    expect(categoriseFailure(withCode(code), inBody)).toBe('tls');
  });

  it.each(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'])(
    'give timeout for %s',
    (code) => {
      expect(categoriseFailure(withCode(code), inRequest)).toBe('timeout');
      expect(categoriseFailure(withCode(code), inBody)).toBe('timeout');
    },
  );

  it('give too_large when the pool refuses a large answer', () => {
    expect(
      categoriseFailure(withCode('UND_ERR_RES_EXCEEDED_MAX_SIZE'), inBody),
    ).toBe('too_large');
  });

  it.each([
    'ECONNREFUSED',
    'ECONNRESET',
    'ECONNABORTED',
    'EPIPE',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENETDOWN',
    'EADDRNOTAVAIL',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EAI_FAIL',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
    'UND_ERR_CLOSED',
  ])(
    'give connect before the answer and interrupted after it for %s',
    (code) => {
      expect(categoriseFailure(withCode(code), inRequest)).toBe('connect');
      expect(categoriseFailure(withCode(code), inBody)).toBe('interrupted');
    },
  );

  it.each([
    ['an unknown code', withCode('UND_ERR_NOT_SUPPORTED')],
    ['no code', new Error('no code')],
    ['a code that is a number', Object.assign(new Error(), { code: 20 })],
    [
      'a code that only prints as one',
      Object.assign(new Error(), {
        code: { toString: () => 'CERT_HAS_EXPIRED' },
      }),
    ],
    ['a string', 'thrown text'],
    ['undefined', undefined],
    ['null', null],
  ])(
    'give failed before the answer and interrupted after it for %s',
    (_, error) => {
      expect(categoriseFailure(error, inRequest)).toBe('failed');
      expect(categoriseFailure(error, inBody)).toBe('interrupted');
    },
  );

  it('take the code of the first error of an AggregateError', () => {
    const error = new AggregateError([
      withCode('ECONNREFUSED'),
      withCode('ENETUNREACH'),
    ]);
    expect(categoriseFailure(error, inRequest)).toBe('connect');
    expect(categoriseFailure(new AggregateError([]), inRequest)).toBe('failed');
    expect(
      categoriseFailure(new AggregateError([new Error()]), inRequest),
    ).toBe('failed');
  });

  it('give timeout for the own deadline, before anything else', () => {
    expect(categoriseFailure(deadline, inRequest)).toBe('timeout');
    expect(
      categoriseFailure(deadline, { ...inBody, callerAborted: true }),
    ).toBe('timeout');
    // Only the very reason counts, not one that looks the same.
    expect(categoriseFailure({ reason: 'deadline' }, inRequest)).toBe('failed');
  });

  it('give aborted once the caller aborted, whatever was thrown', () => {
    const caller = { ...inRequest, callerAborted: true };
    expect(
      categoriseFailure(new DOMException('gone', 'AbortError'), caller),
    ).toBe('aborted');
    expect(categoriseFailure(withCode('CERT_HAS_EXPIRED'), caller)).toBe(
      'aborted',
    );
    expect(
      categoriseFailure(new DOMException('gone', 'AbortError'), inRequest),
    ).toBe('failed');
  });

  it('read only code and errors, never message, stack, headers or cause', () => {
    const read: PropertyKey[] = [];
    const spy = <T extends object>(target: T): T =>
      new Proxy(target, {
        get(inner, key, receiver) {
          read.push(key);
          return Reflect.get(inner, key, receiver) as unknown;
        },
      });
    expect(categoriseFailure(spy(withCode('ECONNRESET')), inRequest)).toBe(
      'connect',
    );
    expect(categoriseFailure(spy(new Error()), inRequest)).toBe('failed');
    expect(new Set(read)).toEqual(new Set(['code', 'errors']));
  });

  it('give failed when reading the code throws', () => {
    const error = Object.defineProperty(new Error(), 'code', {
      get() {
        throw new Error('no');
      },
    });
    expect(categoriseFailure(error, inRequest)).toBe('failed');
    const proxy = new Proxy(
      {},
      {
        get() {
          throw new Error('no');
        },
      },
    );
    expect(categoriseFailure(proxy, inBody)).toBe('interrupted');
  });
});

describe('failureCategories and categoryCodes', () => {
  it('are frozen and name each category once', () => {
    expect(Object.isFrozen(failureCategories)).toBe(true);
    expect(new Set(failureCategories).size).toBe(failureCategories.length);
    expect(Object.isFrozen(categoryCodes)).toBe(true);
    expect(Object.getPrototypeOf(categoryCodes)).toBeNull();
    expect(Object.keys(categoryCodes)).toEqual([...failureCategories]);
  });

  it('give each category its code', () => {
    expect({ ...categoryCodes }).toEqual({
      refused: 'internal',
      connect: 'network',
      tls: 'network',
      timeout: 'network',
      aborted: 'network',
      interrupted: 'network',
      too_large: 'upstream',
      redirect: 'upstream',
      encoding: 'upstream',
      status: 'upstream',
      failed: 'network',
    });
  });

  // The transport logs a failure as the event http_<category>.
  it('fit the name of a log event behind a prefix', () => {
    for (const category of failureCategories) {
      expect(isEventName(`http_${category}`), category).toBe(true);
    }
  });
});

describe('HttpTransportError', () => {
  it.each(failureCategories.map((category) => [category]))(
    'carry the category %s and its code, nothing else',
    (category: FailureCategory) => {
      const error = new HttpTransportError(category);
      expect(isEccliumError(error)).toBe(true);
      expect(error.code).toBe(categoryCodes[category]);
      expect(error.category).toBe(category);
      expect(error.message).toBe('');
      expect(error.name).toBe('HttpTransportError');
      expect('cause' in error).toBe(false);
      expect(Object.keys(error)).toEqual(['code', 'category']);
      expect(JSON.parse(JSON.stringify(error))).toEqual({
        code: categoryCodes[category],
        category,
      });
    },
  );

  it('keep its category', () => {
    const error = new HttpTransportError('tls');
    expect(() => {
      (error as unknown as { category: string }).category = 'failed';
    }).toThrow(TypeError);
    expect(Reflect.deleteProperty(error, 'category')).toBe(false);
    expect(error.category).toBe('tls');
  });
});
