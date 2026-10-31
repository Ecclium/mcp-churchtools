import { describe, expect, it } from 'vitest';

import type { ReadableOperation } from './catalog.js';
import {
  buildOperationUrl,
  isCalendarDay,
  isQueryText,
  isSafePathText,
  isUtcMoment,
  keepsTemplate,
  maxQueryListLength,
  maxQueryTextLength,
} from './parameters.js';

// Building the URL of a read from checked values only (ADR 0067). Values
// come as the tool would pass them; every refusal names a parameter only
// from the catalog and never a value.

const origin = 'https://example.church.tools';
const guid = '00000000-0000-4000-8000-000000000001';
const zeroWidth = String.fromCodePoint(0x200b);
const fullWidthDot = String.fromCodePoint(0xff0e);

const operation = (
  extra: Partial<ReadableOperation> = {},
): ReadableOperation => ({
  operationId: 'get-things',
  path: '/api/things/{thingId}/pages/{identifier}/{kind}/{day}',
  sensitivity: 'none',
  pathParameters: [
    { name: 'thingId', kind: 'integer' },
    { name: 'identifier', kind: 'guid' },
    { name: 'kind', kind: 'enum', values: ['group', 'person'] },
    { name: 'day', kind: 'date' },
  ],
  queryParameters: [
    { name: 'limit', required: false, kind: 'integer' },
    { name: 'ratio', required: false, kind: 'number' },
    { name: 'archived', required: false, kind: 'boolean' },
    { name: 'query', required: false, kind: 'string' },
    { name: 'from', required: false, kind: 'date' },
    { name: 'after', required: false, kind: 'date-time' },
    { name: 'start', required: false, kind: 'date-or-date-time' },
    {
      name: 'order',
      required: false,
      kind: 'enum',
      values: ['asc', 'desc'],
    },
    { name: 'ids[]', required: false, kind: 'integer', list: true },
    { name: 'filter', required: false, kind: 'unsupported' },
  ],
  ...extra,
});

const pathValues = {
  thingId: 12,
  identifier: guid,
  kind: 'group',
  day: '2026-10-30',
};

const build = (
  input: { path?: unknown; query?: unknown },
  op: ReadableOperation = operation(),
) => buildOperationUrl(origin, op, input);

const urlOf = (
  input: { path?: unknown; query?: unknown },
  op?: ReadableOperation,
) => {
  const built = build(input, op);
  if (!built.ok) throw new Error(built.message);
  return built.url;
};

const messageOf = (
  input: { path?: unknown; query?: unknown },
  op?: ReadableOperation,
) => {
  const built = build(input, op);
  if (built.ok) throw new Error('expected a refusal');
  return built.message;
};

describe('buildOperationUrl, path', () => {
  it('fills the template with each value in its kind', () => {
    const url = urlOf({ path: pathValues });
    expect(url.origin).toBe(origin);
    expect(url.pathname).toBe(`/api/things/12/pages/${guid}/group/2026-10-30`);
    expect(url.search).toBe('');
  });

  it('takes a whole number also as decimal digits', () => {
    expect(urlOf({ path: { ...pathValues, thingId: '7' } }).pathname).toContain(
      '/things/7/',
    );
  });

  it('builds an operation without parameters with neither part given', () => {
    const op = operation({
      path: '/api/things',
      pathParameters: [],
      queryParameters: [],
    });
    expect(urlOf({}, op).href).toBe(`${origin}/api/things`);
    expect(urlOf({ path: {}, query: Object.create(null) }, op).href).toBe(
      `${origin}/api/things`,
    );
  });

  it.each([
    ['0', 0],
    ['a negative number', -1],
    ['a fraction', 1.5],
    ['a number beyond the safe range', 2 ** 53],
    ['digits with a leading zero', '012'],
    ['digits with a sign', '+12'],
    ['digits beyond the safe range', '9007199254740993'],
    ['too many digits', '12345678901234567'],
    ['empty text', ''],
    ['a dot segment', '..'],
    ['a value with a slash', '1/2'],
    ['a value with an encoded dot segment', '%2e%2e'],
    ['a boolean', true],
    ['null', null],
  ])('refuses %s as a whole number', (_name, value) => {
    expect(messageOf({ path: { ...pathValues, thingId: value } })).toBe(
      'The parameter thingId has a value of the wrong form.',
    );
  });

  it.each([
    ['another form', 'not-a-guid'],
    ['a dot segment', '../whoami'],
    ['a GUID with a slash in front', `/${guid}`],
    ['a number', 1],
  ])('refuses %s as a GUID', (_name, value) => {
    expect(messageOf({ path: { ...pathValues, identifier: value } })).toBe(
      'The parameter identifier has a value of the wrong form.',
    );
  });

  it.each([
    ['a value outside the list', 'persons'],
    ['a value in capitals', 'Group'],
    ['a number', 1],
  ])('refuses %s as a fixed value', (_name, value) => {
    expect(messageOf({ path: { ...pathValues, kind: value } })).toBe(
      'The parameter kind has a value of the wrong form.',
    );
  });

  it.each([
    ['a day that does not exist', '2026-02-30'],
    ['a moment', '2026-10-30T00:00:00Z'],
    ['another order', '30.10.2026'],
  ])('refuses %s as a day', (_name, value) => {
    expect(messageOf({ path: { ...pathValues, day: value } })).toBe(
      'The parameter day has a value of the wrong form.',
    );
  });

  it('refuses a value of a fixed list that is no safe path text', () => {
    const op = operation({
      path: '/api/things/{kind}',
      pathParameters: [{ name: 'kind', kind: 'enum', values: ['..'] }],
    });
    expect(messageOf({ path: { kind: '..' } }, op)).toBe(
      'The parameter kind has a value of the wrong form.',
    );
    const noValues = operation({
      path: '/api/things/{kind}',
      pathParameters: [{ name: 'kind', kind: 'enum' }],
    });
    expect(messageOf({ path: { kind: 'group' } }, noValues)).toBe(
      'The parameter kind has a value of the wrong form.',
    );
  });

  it('names a missing path parameter', () => {
    expect(
      messageOf({
        path: { thingId: 12, identifier: guid, kind: 'group' },
      }),
    ).toBe('The parameter day is missing.');
    expect(messageOf({})).toBe('The parameter thingId is missing.');
  });

  it('refuses a name the path does not declare without naming it', () => {
    expect(messageOf({ path: { ...pathValues, 'max.mustermann': 1 } })).toBe(
      'The request names a parameter in the path that the operation does not declare.',
    );
  });

  it.each([
    ['an array', [1]],
    ['null', null],
    ['text', 'thingId=1'],
    ['an instance of a class', new Map([['thingId', 1]])],
    ['an object with a symbol key', { ...pathValues, [Symbol('x')]: 1 }],
    [
      'an object with a getter',
      Object.defineProperty({ ...pathValues }, 'thingId', {
        enumerable: true,
        get: () => 12,
      }),
    ],
  ])('refuses %s as the path part', (_name, value) => {
    expect(messageOf({ path: value })).toBe(
      'The request names a parameter in the path that the operation does not declare.',
    );
  });

  it('refuses a template that the URL would change and one outside /api', () => {
    const dot = operation({
      path: '/api/things/./{thingId}',
      pathParameters: [{ name: 'thingId', kind: 'integer' }],
    });
    expect(messageOf({ path: { thingId: 1 } }, dot)).toBe(
      'The values do not give a path of this operation.',
    );
    const outside = operation({
      path: '/other/{thingId}',
      pathParameters: [{ name: 'thingId', kind: 'integer' }],
    });
    expect(messageOf({ path: { thingId: 1 } }, outside)).toBe(
      'The values do not give a path of this operation.',
    );
  });
});

describe('buildOperationUrl, query', () => {
  it('appends each value in its kind and in the order given', () => {
    const url = urlOf({
      path: pathValues,
      query: {
        limit: 25,
        ratio: 0.5,
        archived: false,
        query: 'Müller & Söhne?',
        from: '2026-10-01',
        after: '2026-10-30T12:00:00Z',
        start: '2026-10-30',
        order: 'desc',
        'ids[]': [3, '4'],
      },
    });
    expect([...url.searchParams]).toEqual([
      ['limit', '25'],
      ['ratio', '0.5'],
      ['archived', 'false'],
      ['query', 'Müller & Söhne?'],
      ['from', '2026-10-01'],
      ['after', '2026-10-30T12:00:00Z'],
      ['start', '2026-10-30'],
      ['order', 'desc'],
      ['ids[]', '3'],
      ['ids[]', '4'],
    ]);
    expect(url.pathname).not.toContain('?');
  });

  it.each([
    ['limit', -3, '-3'],
    ['limit', '-3', '-3'],
    ['limit', '40', '40'],
    ['archived', true, 'true'],
    ['archived', 'true', 'true'],
    ['archived', 'false', 'false'],
    ['start', '2026-10-30T08:00:00Z', '2026-10-30T08:00:00Z'],
  ])('sends %s %j as %s', (name, value, text) => {
    expect(
      urlOf({ path: pathValues, query: { [name]: value } }).searchParams.get(
        name,
      ),
    ).toBe(text);
  });

  it.each([
    ['limit', 1.5],
    ['limit', 2 ** 53],
    ['limit', '-'],
    ['limit', '1e3'],
    ['limit', ''],
    ['limit', '123456789012345678'],
    ['limit', true],
    ['ratio', Number.NaN],
    ['ratio', Number.POSITIVE_INFINITY],
    ['ratio', 1e16],
    ['ratio', '0.5'],
    ['archived', 'yes'],
    ['archived', 1],
    ['query', ''],
    ['query', 'x'.repeat(maxQueryTextLength + 1)],
    ['query', 'a\nb'],
    ['query', `a${zeroWidth}b`],
    ['query', `a${fullWidthDot}b`],
    ['query', '\ud800'],
    ['query', 5],
    ['from', '2026-13-01'],
    ['after', '2026-10-30T12:00:00'],
    ['after', '2026-10-30T12:00:00+01:00'],
    ['after', '2026-10-30T25:00:00Z'],
    ['start', '30.10.2026'],
    ['order', 'up'],
    ['ids[]', []],
    ['ids[]', 3],
    ['ids[]', [1.5]],
    ['ids[]', Array.from({ length: maxQueryListLength + 1 }, (_, i) => i + 1)],
    ['limit', [1]],
  ])('refuses %s %j', (name, value) => {
    expect(messageOf({ path: pathValues, query: { [name]: value } })).toBe(
      `The parameter ${name} has a value of the wrong form.`,
    );
  });

  it('takes a list of the most values', () => {
    const ids = Array.from({ length: maxQueryListLength }, (_, i) => i + 1);
    expect(
      urlOf({ path: pathValues, query: { 'ids[]': ids } }).searchParams.getAll(
        'ids[]',
      ),
    ).toHaveLength(maxQueryListLength);
  });

  it('refuses a declared parameter of a form the core does not send', () => {
    expect(messageOf({ path: pathValues, query: { filter: 'a' } })).toBe(
      'The parameter filter has a form that Ecclium does not send.',
    );
  });

  it('refuses a name the query does not declare without naming it', () => {
    for (const name of ['login_token', 'with_session', 'limit ', 'Limit']) {
      expect(messageOf({ path: pathValues, query: { [name]: 1 } })).toBe(
        'The request names a parameter in the query that the operation does not declare.',
      );
    }
    expect(messageOf({ path: pathValues, query: [] })).toBe(
      'The request names a parameter in the query that the operation does not declare.',
    );
  });

  it('names a missing required parameter', () => {
    const op = operation({
      queryParameters: [{ name: 'from', required: true, kind: 'date' }],
    });
    expect(messageOf({ path: pathValues }, op)).toBe(
      'The parameter from is missing.',
    );
    expect(
      urlOf({ path: pathValues, query: { from: '2026-10-01' } }, op).search,
    ).toBe('?from=2026-10-01');
  });

  it('refuses a fixed value of an unsupported list without values', () => {
    const op = operation({
      queryParameters: [{ name: 'order', required: false, kind: 'enum' }],
    });
    expect(messageOf({ path: pathValues, query: { order: 'asc' } }, op)).toBe(
      'The parameter order has a value of the wrong form.',
    );
  });
});

describe('buildOperationUrl, IDs for the audit', () => {
  const named = operation({
    pathParameters: [
      { name: 'thingId', kind: 'integer', object: 'event' },
      { name: 'identifier', kind: 'guid', object: 'wiki_page' },
      { name: 'kind', kind: 'enum', values: ['group', 'person'] },
      { name: 'day', kind: 'date' },
    ],
    queryParameters: [
      {
        name: 'ids[]',
        required: false,
        kind: 'integer',
        list: true,
        object: 'person',
      },
      { name: 'limit', required: false, kind: 'integer' },
    ],
  });

  it('gives the checked values of the parameters that name objects, in order', () => {
    const built = build(
      { path: pathValues, query: { limit: 5, 'ids[]': [3, 1] } },
      named,
    );
    expect(built.ok && built.objectRefs).toEqual([
      ['event', '12'],
      ['wiki_page', guid],
      ['person', '3'],
      ['person', '1'],
    ]);
    expect(built.ok && Object.isFrozen(built.objectRefs)).toBe(true);
  });

  it('takes an ID in the query only in the form of one', () => {
    for (const value of ['0012', '-12', '00000000000000012', 0, -3]) {
      expect(
        build({ path: pathValues, query: { 'ids[]': [value] } }, named).ok,
        String(value),
      ).toBe(false);
    }
    const built = build(
      { path: pathValues, query: { 'ids[]': [12, '13'] } },
      named,
    );
    expect(built.ok && built.objectRefs.slice(2)).toEqual([
      ['person', '12'],
      ['person', '13'],
    ]);
    // A whole number in the query that names no object keeps its form.
    expect(build({ path: pathValues, query: { 'ids[]': ['0012'] } }).ok).toBe(
      true,
    );
  });

  it('gives none for an operation without such parameters', () => {
    const built = build({ path: pathValues, query: { 'ids[]': [3] } });
    expect(built.ok && built.objectRefs).toEqual([]);
  });

  it('gives nothing for a request it refuses', () => {
    expect(build({ path: { ...pathValues, thingId: 'Max' } }, named)).toEqual({
      ok: false,
      message: expect.any(String) as string,
    });
  });
});

describe('the checks of single values', () => {
  it('isSafePathText refuses what ends or changes a path', () => {
    expect(isSafePathText('2026-10-30')).toBe(true);
    for (const text of [
      '',
      '..',
      'a/b',
      'a\\b',
      'a%2fb',
      'a?b',
      'a#b',
      'a\u0000b',
      'a\u007fb',
      'a\u0085b',
      `${fullWidthDot}${fullWidthDot}`,
      '\udc00',
    ]) {
      expect(isSafePathText(text)).toBe(false);
    }
  });

  it('isCalendarDay and isUtcMoment take only real days and moments', () => {
    expect(isCalendarDay('2028-02-29')).toBe(true);
    expect(isCalendarDay('2026-02-29')).toBe(false);
    expect(isCalendarDay('2026-1-01')).toBe(false);
    expect(isCalendarDay(20261030)).toBe(false);
    expect(isUtcMoment('2026-10-30T23:59:59Z')).toBe(true);
    expect(isUtcMoment('2026-10-30T23:60:00Z')).toBe(false);
    expect(isUtcMoment('2026-10-30 23:59:59Z')).toBe(false);
    expect(isUtcMoment('2026-10-30T23:59:59z')).toBe(false);
    expect(isUtcMoment('2026-10-30T23-59-59Z')).toBe(false);
    expect(isUtcMoment('2026-10-30T23:59-59Z')).toBe(false);
    expect(isUtcMoment('2026-02-30T23:59:59Z')).toBe(false);
    expect(isUtcMoment(null)).toBe(false);
  });

  it('isQueryText takes text up to its limit', () => {
    expect(isQueryText('x'.repeat(maxQueryTextLength))).toBe(true);
    expect(isQueryText('a\tb')).toBe(false);
  });

  it('keepsTemplate holds origin, /api and the fixed part', () => {
    const template = '/api/groups/{groupId}';
    const keeps = (href: string) =>
      keepsTemplate(new URL(href), origin, template);
    expect(keeps(`${origin}/api/groups/1`)).toBe(true);
    expect(keeps('https://other.example/api/groups/1')).toBe(false);
    expect(keeps(`${origin}/api/groupsx/1`)).toBe(false);
    expect(keeps(`${origin}/api/groups/1#x`)).toBe(false);
    expect(
      keepsTemplate(new URL(`${origin}/api/whoami`), origin, '/api/whoami'),
    ).toBe(true);
    expect(keepsTemplate(new URL(`${origin}/x/1`), origin, '/x/{id}')).toBe(
      false,
    );
  });
});
