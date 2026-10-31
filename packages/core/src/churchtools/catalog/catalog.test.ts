import { describe, expect, it } from 'vitest';

import {
  fixedExclusionParts,
  isFixedExclusion,
  lookupOperation,
} from './catalog.js';
import {
  allowed,
  type CatalogParameter,
  type Classification,
  excluded,
  frozenOperations,
  type GeneratedOperation,
  type ObjectParameters,
} from './types.js';

// The lookup over a synthetic catalog (ADR 0067): each check that makes an
// allowed operation unreadable has a case of its own, next to one that
// passes.

const path = (name: string, kind: CatalogParameter['kind'] = 'integer') =>
  ({ name, in: 'path', required: true, kind }) as const;

const operation = (
  extra: Partial<GeneratedOperation> = {},
): GeneratedOperation => ({
  operationId: 'get-things-thingId',
  method: 'get',
  path: '/api/things/{thingId}',
  deprecated: false,
  json: true,
  parameters: [path('thingId')],
  ...extra,
});

const lookup = (
  op: GeneratedOperation,
  entry: Classification = allowed('none'),
  objects?: ObjectParameters,
) =>
  lookupOperation(
    op.operationId,
    frozenOperations([op]),
    { [op.operationId]: entry },
    objects === undefined ? undefined : { [op.operationId]: objects },
  );

describe('lookupOperation', () => {
  it('gives a readable operation with its path and parameters', () => {
    const found = lookup(
      operation({
        parameters: [
          path('thingId'),
          { name: 'limit', in: 'query', required: false, kind: 'integer' },
          {
            name: 'ids[]',
            in: 'query',
            required: false,
            kind: 'integer',
            list: true,
          },
          {
            name: 'order',
            in: 'query',
            required: true,
            kind: 'enum',
            values: ['asc', 'desc'],
          },
          {
            name: 'Accept',
            in: 'header',
            required: false,
            kind: 'unsupported',
          },
        ],
      }),
      allowed('special'),
    );
    expect(found).toEqual({
      ok: true,
      operation: {
        operationId: 'get-things-thingId',
        path: '/api/things/{thingId}',
        sensitivity: 'special',
        pathParameters: [{ name: 'thingId', kind: 'integer' }],
        queryParameters: [
          { name: 'limit', required: false, kind: 'integer' },
          { name: 'ids[]', required: false, kind: 'integer', list: true },
          {
            name: 'order',
            required: true,
            kind: 'enum',
            values: ['asc', 'desc'],
          },
        ],
      },
    });
    expect(found.ok && Object.isFrozen(found.operation)).toBe(true);
  });

  it('knows no operation outside the generated part and no other value', () => {
    const ops = frozenOperations([operation()]);
    const classes = { 'get-things-thingId': allowed('none') };
    for (const id of ['get-other', 'toString', '__proto__', 7, undefined]) {
      expect(lookupOperation(id, ops, classes)).toEqual({
        ok: false,
        reason: 'unknown',
      });
    }
  });

  it('refuses an operation without classification, also one named like a key of Object', () => {
    for (const id of ['get-things-thingId', 'constructor']) {
      const op = operation({ operationId: id });
      expect(lookupOperation(id, frozenOperations([op]), {})).toEqual({
        ok: false,
        reason: 'unclassified',
      });
    }
  });

  it('refuses an excluded operation with its reason', () => {
    expect(lookup(operation(), excluded('care'))).toEqual({
      ok: false,
      reason: 'care',
    });
  });

  it.each([
    ['method', { method: 'post' }],
    ['deprecated', { deprecated: true }],
    ['media', { json: false }],
    ['fixed', { path: '/api/things/{thingId}/logintoken' }],
  ] as const)('refuses an allowed operation for %s', (reason, extra) => {
    expect(lookup(operation(extra))).toEqual({ ok: false, reason });
  });

  it.each([
    ['a path without /api', { path: '/things/{thingId}' }],
    ['an unclosed brace', { path: '/api/things/{thingId' }],
    ['an empty brace', { path: '/api/things/{}/{thingId}' }],
    ['a brace inside a brace', { path: '/api/things/{a{thingId}' }],
    ['a closing brace alone', { path: '/api/things/{thingId}}' }],
    ['a path parameter that is not declared', { parameters: [] }],
    [
      'a path parameter declared twice',
      { parameters: [path('thingId'), path('thingId')] },
    ],
    [
      'a declared path parameter outside the path',
      { parameters: [path('thingId'), path('other')] },
    ],
    [
      'an optional path parameter',
      { parameters: [{ ...path('thingId'), required: false }] },
    ],
    [
      'a path parameter as a list',
      { parameters: [{ ...path('thingId'), list: true as const }] },
    ],
    ['a path parameter as text', { parameters: [path('thingId', 'string')] }],
    [
      'a path parameter as unsupported',
      { parameters: [path('thingId', 'unsupported')] },
    ],
    ['an enum without values', { parameters: [path('thingId', 'enum')] }],
    [
      'an enum with an empty list',
      { parameters: [{ ...path('thingId', 'enum'), values: [] }] },
    ],
    [
      'an enum with a value that is no segment',
      { parameters: [{ ...path('thingId', 'enum'), values: ['a', '../b'] }] },
    ],
    [
      'an enum with a value in capitals',
      { parameters: [{ ...path('thingId', 'enum'), values: ['Group'] }] },
    ],
    [
      'an enum with a value too long',
      {
        parameters: [{ ...path('thingId', 'enum'), values: ['a'.repeat(65)] }],
      },
    ],
    [
      'a header the operation needs',
      {
        parameters: [
          path('thingId'),
          { name: 'Accept', in: 'header', required: true, kind: 'unsupported' },
        ],
      },
    ],
    [
      'a query parameter it needs that the core cannot send',
      {
        parameters: [
          path('thingId'),
          { name: 'filter', in: 'query', required: true, kind: 'unsupported' },
        ],
      },
    ],
  ] as const)('refuses an allowed operation with %s', (_name, extra) => {
    expect(lookup(operation(extra as Partial<GeneratedOperation>))).toEqual({
      ok: false,
      reason: 'kind',
    });
  });

  it('takes the kinds of the classification over those of the document', () => {
    const op = operation({
      path: '/api/things/{thingId}/pages/{identifier}',
      parameters: [path('thingId', 'string'), path('identifier', 'string')],
    });
    const found = lookup(
      op,
      allowed('none', { thingId: 'integer', identifier: 'guid' }),
    );
    expect(found.ok && found.operation.pathParameters).toEqual([
      { name: 'thingId', kind: 'integer' },
      { name: 'identifier', kind: 'guid' },
    ]);
  });

  it('keeps the kinds date and enum of the document', () => {
    const op = operation({
      path: '/api/things/{kind}/{day}',
      parameters: [
        { ...path('kind', 'enum'), values: ['group', 'person_2'] },
        path('day', 'date'),
      ],
    });
    expect(lookup(op)).toMatchObject({
      ok: true,
      operation: {
        pathParameters: [
          { name: 'kind', kind: 'enum', values: ['group', 'person_2'] },
          { name: 'day', kind: 'date' },
        ],
      },
    });
  });

  it('refuses a kind of the classification for a name outside the path or of another form', () => {
    expect(lookup(operation(), allowed('none', { other: 'integer' }))).toEqual({
      ok: false,
      reason: 'kind',
    });
    expect(
      lookup(
        operation(),
        allowed('none', { thingId: 'text' as unknown as 'integer' }),
      ),
    ).toEqual({ ok: false, reason: 'kind' });
  });

  it('keeps a withheld parameter of the query declared but unsendable', () => {
    const op = operation({
      parameters: [
        path('thingId'),
        { name: 'born_after', in: 'query', required: false, kind: 'date' },
        { name: 'limit', in: 'query', required: false, kind: 'integer' },
      ],
    });
    expect(
      lookup(op, allowed('special', undefined, ['born_after'])),
    ).toMatchObject({
      ok: true,
      operation: {
        queryParameters: [
          { name: 'born_after', kind: 'unsupported' },
          { name: 'limit', kind: 'integer' },
        ],
      },
    });
  });

  it('refuses to withhold a parameter the query does not declare or one it needs', () => {
    expect(
      lookup(operation(), allowed('none', undefined, ['thingId'])),
    ).toEqual({
      ok: false,
      reason: 'kind',
    });
    const needed = operation({
      parameters: [
        path('thingId'),
        { name: 'from', in: 'query', required: true, kind: 'date' },
      ],
    });
    expect(lookup(needed, allowed('none', undefined, ['from']))).toEqual({
      ok: false,
      reason: 'kind',
    });
  });

  it('gives parameters with IDs the kind of object the table names', () => {
    const op = operation({
      parameters: [
        path('thingId'),
        {
          name: 'person_ids[]',
          in: 'query',
          required: false,
          kind: 'integer',
          list: true,
        },
        { name: 'type_id', in: 'query', required: false, kind: 'integer' },
      ],
    });
    expect(
      lookup(op, allowed('special'), {
        thingId: 'event',
        'person_ids[]': 'person',
        type_id: null,
      }),
    ).toMatchObject({
      ok: true,
      operation: {
        pathParameters: [{ name: 'thingId', kind: 'integer', object: 'event' }],
        queryParameters: [
          { name: 'person_ids[]', object: 'person' },
          { name: 'type_id', kind: 'integer' },
        ],
      },
    });
    const found = lookup(op, allowed('special'), { type_id: null });
    expect(found.ok && found.operation.queryParameters[1]).not.toHaveProperty(
      'object',
    );
  });

  it('gives kinds of object to the path parameters of every safe kind', () => {
    const op = operation({
      path: '/api/things/{thingId}/{day}/{kind}/{guid}',
      parameters: [
        path('thingId'),
        path('day', 'date'),
        {
          name: 'kind',
          in: 'path',
          required: true,
          kind: 'enum',
          values: ['a'],
        },
        path('guid', 'string'),
      ],
    });
    const found = lookup(op, allowed('none', { guid: 'guid' }), {
      thingId: 'event',
      day: 'calendar',
      kind: 'song',
      guid: 'wiki_page',
    });
    expect(
      found.ok && found.operation.pathParameters.map((entry) => entry.object),
    ).toEqual(['event', 'calendar', 'song', 'wiki_page']);
  });

  it('refuses a table of IDs with an unknown parameter or kind', () => {
    for (const objects of [
      { other: 'event' },
      { Accept: 'event' },
      { thingId: 'mustermann' },
    ] as unknown as ObjectParameters[]) {
      const op = operation({
        parameters: [
          path('thingId'),
          { name: 'Accept', in: 'header', required: false, kind: 'string' },
        ],
      });
      expect(lookup(op, allowed('none'), objects)).toEqual({
        ok: false,
        reason: 'kind',
      });
    }
  });

  it('reads no kind of object from the prototype of the table', () => {
    const op = operation({
      path: '/api/things/{toString}',
      parameters: [path('toString')],
    });
    expect(lookup(op, allowed('none'), {})).toMatchObject({
      ok: true,
      operation: { pathParameters: [{ name: 'toString', kind: 'integer' }] },
    });
    const found = lookupOperation(op.operationId, frozenOperations([op]), {
      [op.operationId]: allowed('none'),
    });
    expect(found.ok && found.operation.pathParameters[0]).not.toHaveProperty(
      'object',
    );
    const empty = lookupOperation(
      op.operationId,
      frozenOperations([op]),
      { [op.operationId]: allowed('none') },
      { [op.operationId]: undefined as unknown as ObjectParameters },
    );
    expect(empty).toMatchObject({ ok: true });
  });

  it('reads an operation without path parameters', () => {
    expect(
      lookup(operation({ path: '/api/things', parameters: [] })),
    ).toMatchObject({ ok: true, operation: { pathParameters: [] } });
  });
});

describe('isFixedExclusion', () => {
  it.each([
    '/api/csrftoken',
    '/api/persons/{personId}/logintoken',
    '/api/persons/{personId}/loginstring',
    '/api/persons/{personId}/settings/twofactor',
    '/api/finance/accounts',
    '/api/files/{domainType}',
    '/api/images/{fileId}/{hash}',
    '/api/logs',
    '/api/joblog',
    '/api/groups/{groupId}/members/history',
    '/api/groups/{groupId}/members/export',
    '/api/finance/transactions/csv',
    '/api/events/ical',
    '/api/config',
    '/api/sync/adapters',
    '/api/oauthclients',
    '/api/saml/metadata',
    '/api/sso-logins',
    '/api/captcha',
    '/api/license/fetch',
    '/api/queues/{queue}/jobgroups/{jobGroup}',
    '/api/Persons/{personId}/LoginToken',
  ])('excludes %s', (value) => {
    expect(isFixedExclusion(value)).toBe(true);
  });

  it.each([
    '/api/persons/{personId}',
    '/api/groups/{groupId}/members',
    '/api/wiki/categories/{wikiCategoryId}/pages/{identifier}',
    '/api/events/{eventId}/agenda',
    '/api/publicgroups/signup/confirm/{confirmationToken}',
  ])('lets %s pass, also with a word of the rule only in braces', (value) => {
    expect(isFixedExclusion(value)).toBe(false);
  });

  it('holds every part in lower case and frozen', () => {
    expect(Object.isFrozen(fixedExclusionParts)).toBe(true);
    for (const part of fixedExclusionParts) {
      expect(part).toBe(part.toLowerCase());
    }
  });
});

describe('frozenOperations, allowed and excluded', () => {
  it('freezes every level', () => {
    const ops = frozenOperations([
      operation({
        parameters: [
          path('thingId'),
          {
            name: 'order',
            in: 'query',
            required: false,
            kind: 'enum',
            values: ['a'],
          },
        ],
      }),
    ]);
    const op = ops[0];
    expect(Object.isFrozen(ops)).toBe(true);
    expect(Object.isFrozen(op)).toBe(true);
    expect(Object.isFrozen(op?.parameters)).toBe(true);
    expect(Object.isFrozen(op?.parameters[0])).toBe(true);
    expect(Object.isFrozen(op?.parameters[1]?.values)).toBe(true);
  });

  it('builds frozen classifications', () => {
    const kinds = { thingId: 'integer' } as const;
    const entry = allowed('personal', kinds);
    expect(entry).toEqual({
      allowed: true,
      sensitivity: 'personal',
      pathKinds: { thingId: 'integer' },
    });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.pathKinds)).toBe(true);
    expect(entry.pathKinds).not.toBe(kinds);
    expect(allowed('none')).toEqual({ allowed: true, sensitivity: 'none' });
    const withheld = ['born_after'];
    const quiet = allowed('special', undefined, withheld);
    expect(quiet).toEqual({
      allowed: true,
      sensitivity: 'special',
      withoutQuery: ['born_after'],
    });
    expect(Object.isFrozen(quiet.withoutQuery)).toBe(true);
    expect(quiet.withoutQuery).not.toBe(withheld);
    expect(excluded('secret')).toEqual({ allowed: false, reason: 'secret' });
    expect(Object.isFrozen(excluded('secret'))).toBe(true);
  });
});
