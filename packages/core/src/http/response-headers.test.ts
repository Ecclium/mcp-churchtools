import { describe, expect, it } from 'vitest';

import { keepKnownHeaders, keptHeaders } from './response-headers.js';

const kept = (headers: unknown) => {
  const result = keepKnownHeaders(headers);
  if (!result.ok) throw new Error('expected the headers to be kept');
  return result.headers;
};

describe('keepKnownHeaders', () => {
  it('keep content-type, retry-after and date and drop every other header', () => {
    const headers = kept({
      'content-type': 'application/json; charset=utf-8',
      'retry-after': '120',
      date: 'Fri, 16 Oct 2026 16:00:00 GMT',
      'set-cookie': ['session=1; Path=/', 'other=2'],
      server: 'nginx',
      'x-powered-by': 'PHP',
      location: 'https://other.example/',
    });
    expect({ ...headers }).toEqual({
      'content-type': 'application/json; charset=utf-8',
      'retry-after': '120',
      date: 'Fri, 16 Oct 2026 16:00:00 GMT',
    });
    expect(Object.getPrototypeOf(headers)).toBeNull();
    expect(Object.isFrozen(headers)).toBe(true);
  });

  it('drop set-cookie also as a single value', () => {
    expect({ ...kept({ 'set-cookie': 'session=1' }) }).toEqual({});
  });

  it.each([
    ['a repeated header', ['application/json', 'text/html']],
    ['a value with a line break', 'application/json\r\nset-cookie: a=b'],
    ['a value with another control character', 'application/json\u0000'],
    ['a value with DEL', 'application/json\u007f'],
    ['a value beyond ASCII', 'application/json; charset=\u00fc'],
    ['a value of 257 characters', `text/${'a'.repeat(252)}`],
    ['a number', 120],
  ])('drop %s', (_, value) => {
    expect({ ...kept({ 'content-type': value }) }).toEqual({});
  });

  it('keep a value of 256 characters and values with a tab or a space', () => {
    const longest = `text/${'a'.repeat(251)}`;
    expect(kept({ 'content-type': longest })['content-type']).toBe(longest);
    expect(kept({ date: 'Fri,\t16 Oct 2026' }).date).toBe('Fri,\t16 Oct 2026');
    expect(kept({ 'retry-after': ' ~' })['retry-after']).toBe(' ~');
  });

  it('read only own data properties, never a getter or the prototype', () => {
    let read = false;
    const headers = Object.create({ date: 'inherited' }) as object;
    Object.defineProperty(headers, 'content-type', {
      get() {
        read = true;
        return 'application/json';
      },
      enumerable: true,
    });
    expect({ ...kept(headers) }).toEqual({});
    expect(read).toBe(false);
  });

  it.each([null, undefined, 'content-type: application/json', 42])(
    'give no headers for %j',
    (headers) => {
      expect({ ...kept(headers) }).toEqual({});
    },
  );

  it.each(['gzip', 'br', 'deflate', 'zstd', 'gzip, identity', '', ['gzip']])(
    'refuse an answer with content-encoding %j',
    (encoding) => {
      const result = keepKnownHeaders({
        'content-type': 'application/json',
        'content-encoding': encoding,
      });
      expect(result).toEqual({ ok: false, category: 'encoding' });
      expect(Object.getPrototypeOf(result)).toBeNull();
      expect(Object.isFrozen(result)).toBe(true);
    },
  );

  it.each(['identity', ' Identity '])(
    'accept the content-encoding %j',
    (encoding) => {
      expect({
        ...kept({
          'content-type': 'application/json',
          'content-encoding': encoding,
        }),
      }).toEqual({ 'content-type': 'application/json' });
    },
  );

  it('refuse a content-encoding behind a getter, without calling it', () => {
    let read = false;
    const headers = Object.defineProperty({}, 'content-encoding', {
      get() {
        read = true;
        return 'identity';
      },
      enumerable: true,
    });
    expect(keepKnownHeaders(headers)).toEqual({
      ok: false,
      category: 'encoding',
    });
    expect(read).toBe(false);
  });

  it('give a frozen result without prototype', () => {
    const result = keepKnownHeaders({});
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.keys(result)).toEqual(['ok', 'headers']);
  });
});

describe('keptHeaders', () => {
  it('is frozen and names the three headers', () => {
    expect(Object.isFrozen(keptHeaders)).toBe(true);
    expect([...keptHeaders]).toEqual(['content-type', 'retry-after', 'date']);
  });
});
