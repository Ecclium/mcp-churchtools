import type { WriteIntent } from '@ecclium/mcp-churchtools-plugin-api';
import { describe, expect, it } from 'vitest';

import { maxIntentTextLength, readIntent } from './intent.js';

const guid = '00000000-0000-4000-8000-000000000001';

// One valid intent of each kind, with every optional field.
const valid: readonly WriteIntent[] = [
  { kind: 'wikiPageCreate', categoryId: 12, title: 'Plan', text: '# Plan' },
  {
    kind: 'wikiPageUpdate',
    categoryId: 12,
    guid,
    text: '# Plan\n\nNeu',
    baseVersion: 3,
  },
  {
    kind: 'wikiSectionAppend',
    categoryId: 12,
    guid,
    section: '## Nachtrag',
    baseVersion: 0,
  },
  {
    kind: 'appointmentCreate',
    calendarId: 4,
    title: 'Probe',
    startDate: '2026-11-08T09:00:00Z',
    endDate: '2026-11-08T10:00:00Z',
    description: 'Synthetisch',
  },
  {
    kind: 'appointmentUpdate',
    calendarId: 4,
    appointmentId: 13,
    baseVersion: 0,
    title: 'Probe',
    startDate: '2026-11-08',
    endDate: '2026-11-08',
    description: '',
  },
  {
    kind: 'bookingCreate',
    resourceId: 2,
    title: 'Raum',
    startDate: '2026-11-08T09:00:00Z',
    endDate: '2026-11-08T10:00:00Z',
    description: 'Synthetisch',
  },
  { kind: 'groupMemberAdd', groupId: 7, personId: 1 },
  { kind: 'groupMemberRemove', groupId: 7, personId: 1 },
  { kind: 'serviceRequest', eventId: 9, serviceId: 3, personId: 1 },
  {
    kind: 'apiOperation',
    operationId: 'post-groups-id-members',
    path: { id: 7, name: 'x' },
    body: '{}',
  },
];

describe('reading an intent', () => {
  it.each(valid)('copies a valid intent of the kind $kind', (intent) => {
    const read = readIntent(intent);
    expect(read).toEqual(intent);
    expect(read).not.toBe(intent);
    expect(Object.isFrozen(read)).toBe(true);
    // The fields come in the order of the kind, kind first.
    expect(Object.keys(read ?? {})[0]).toBe('kind');
  });

  it('keeps the fields in a fixed order whatever order they came in', () => {
    const read = readIntent({
      text: '# Plan',
      title: 'Plan',
      categoryId: 12,
      kind: 'wikiPageCreate',
    });
    expect(Object.keys(read ?? {})).toEqual([
      'kind',
      'categoryId',
      'title',
      'text',
    ]);
  });

  it('leaves out an optional field that is missing or undefined', () => {
    const base = {
      kind: 'bookingCreate',
      resourceId: 2,
      title: 'Raum',
      startDate: 'a',
      endDate: 'b',
    };
    expect(readIntent(base)).toEqual(base);
    const read = readIntent({ ...base, description: undefined });
    expect(read).toEqual(base);
    expect(Object.hasOwn(read ?? {}, 'description')).toBe(false);
    expect(readIntent({ kind: 'apiOperation', operationId: 'x' })).toEqual({
      kind: 'apiOperation',
      operationId: 'x',
    });
  });

  it('keeps its copy when the original changes after the check', () => {
    const original = {
      kind: 'wikiPageCreate',
      categoryId: 12,
      title: 'Plan',
      text: '# Plan',
    };
    const path = { id: 7 };
    const operation = { kind: 'apiOperation', operationId: 'x', path };
    const read = readIntent(original);
    const readOperation = readIntent(operation) as {
      readonly path: Readonly<Record<string, unknown>>;
    };
    original.text = '# Anders';
    path.id = 8;
    expect(read).toMatchObject({ text: '# Plan' });
    expect(readOperation.path).toEqual({ id: 7 });
    expect(Object.isFrozen(readOperation.path)).toBe(true);
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a text', 'wikiPageCreate'],
    ['an array', [{ kind: 'wikiPageCreate' }]],
    ['an unknown kind', { kind: 'wikiPageDelete', categoryId: 1, guid }],
    ['no kind', { categoryId: 12, title: 'Plan', text: '# Plan' }],
    [
      'an unknown field',
      {
        kind: 'wikiPageCreate',
        categoryId: 12,
        title: 'Plan',
        text: '# Plan',
        isMarkdown: false,
      },
    ],
    ['a missing field', { kind: 'wikiPageCreate', categoryId: 12, title: 'P' }],
    [
      'an ID of 0',
      { kind: 'wikiPageCreate', categoryId: 0, title: 'P', text: 't' },
    ],
    [
      'an ID that is no whole number',
      { kind: 'wikiPageCreate', categoryId: 1.5, title: 'P', text: 't' },
    ],
    [
      'an ID as text',
      { kind: 'wikiPageCreate', categoryId: '12', title: 'P', text: 't' },
    ],
    [
      'a negative version',
      {
        kind: 'wikiPageUpdate',
        categoryId: 1,
        guid,
        text: 't',
        baseVersion: -1,
      },
    ],
    [
      'a GUID of another form',
      {
        kind: 'wikiPageUpdate',
        categoryId: 1,
        guid: '../whoami',
        text: 't',
        baseVersion: 1,
      },
    ],
    [
      'a text that is no text',
      { kind: 'wikiPageCreate', categoryId: 1, title: 'P', text: 42 },
    ],
    [
      'a text that is too long',
      {
        kind: 'wikiPageCreate',
        categoryId: 1,
        title: 'P',
        text: 'x'.repeat(maxIntentTextLength + 1),
      },
    ],
    [
      'a text with a lone surrogate',
      { kind: 'wikiPageCreate', categoryId: 1, title: 'P', text: 'a\uD800' },
    ],
    [
      'an optional text that is no text',
      {
        kind: 'bookingCreate',
        resourceId: 1,
        title: 'R',
        startDate: 'a',
        endDate: 'b',
        description: null,
      },
    ],
    [
      'an operation ID of another form',
      { kind: 'apiOperation', operationId: '../x' },
    ],
    ['an empty operation ID', { kind: 'apiOperation', operationId: '' }],
    [
      'a path that is no object',
      { kind: 'apiOperation', operationId: 'x', path: 'id=7' },
    ],
    [
      'a path with a name of another form',
      { kind: 'apiOperation', operationId: 'x', path: { '../id': 7 } },
    ],
    [
      'a path with a negative number',
      { kind: 'apiOperation', operationId: 'x', path: { id: -1 } },
    ],
    [
      'a path with an object',
      { kind: 'apiOperation', operationId: 'x', path: { id: { a: 1 } } },
    ],
    [
      'a path with a text that is too long',
      {
        kind: 'apiOperation',
        operationId: 'x',
        path: { id: 'x'.repeat(1025) },
      },
    ],
    [
      'a path with too many values',
      {
        kind: 'apiOperation',
        operationId: 'x',
        path: Object.fromEntries(
          Array.from({ length: 21 }, (_, index) => [
            `p${String(index)}`,
            index,
          ]),
        ),
      },
    ],
  ])('refuses %s', (_name, value) => {
    expect(readIntent(value)).toBeUndefined();
  });

  it('refuses a proxy, also as the path, without running its traps', () => {
    let trapped = false;
    const handler: ProxyHandler<object> = {
      get: () => {
        trapped = true;
        return undefined;
      },
      getOwnPropertyDescriptor: () => {
        trapped = true;
        return undefined;
      },
      ownKeys: () => {
        trapped = true;
        return [];
      },
    };
    const intent = { kind: 'groupMemberAdd', groupId: 7, personId: 1 };
    expect(readIntent(new Proxy(intent, handler))).toBeUndefined();
    const { proxy, revoke } = Proxy.revocable(intent, handler);
    revoke();
    expect(readIntent(proxy)).toBeUndefined();
    expect(
      readIntent({
        kind: 'apiOperation',
        operationId: 'x',
        path: new Proxy({ id: 7 }, handler),
      }),
    ).toBeUndefined();
    expect(trapped).toBe(false);
  });

  it('refuses a getter and a symbol, also in the path, without calling the getter', () => {
    let called = false;
    const withGetter = {
      kind: 'groupMemberAdd',
      groupId: 7,
      get personId(): number {
        called = true;
        return 1;
      },
    };
    expect(readIntent(withGetter)).toBeUndefined();
    const path = {
      get id(): number {
        called = true;
        return 7;
      },
    };
    expect(
      readIntent({ kind: 'apiOperation', operationId: 'x', path }),
    ).toBeUndefined();
    expect(called).toBe(false);
    expect(
      readIntent({
        kind: 'groupMemberAdd',
        groupId: 7,
        personId: 1,
        [Symbol('x')]: 1,
      }),
    ).toBeUndefined();
  });

  it('takes an object without prototype, as JSON or a literal would give it', () => {
    const bare = Object.assign(Object.create(null) as object, {
      kind: 'groupMemberAdd',
      groupId: 7,
      personId: 1,
    });
    expect(readIntent(bare)).toEqual({
      kind: 'groupMemberAdd',
      groupId: 7,
      personId: 1,
    });
  });

  it('refuses an instance of a class and an object over another prototype, also as the path', () => {
    class Intent {
      readonly kind = 'groupMemberAdd';
      readonly groupId = 7;
      readonly personId = 1;
    }
    expect(readIntent(new Intent())).toBeUndefined();
    const derived = Object.assign(Object.create({ extra: 1 }) as object, {
      kind: 'groupMemberAdd',
      groupId: 7,
      personId: 1,
    });
    expect(readIntent(derived)).toBeUndefined();
    expect(
      readIntent({
        kind: 'apiOperation',
        operationId: 'x',
        path: Object.assign(Object.create({}) as object, { id: 7 }),
      }),
    ).toBeUndefined();
  });

  it('reads own fields only, never inherited ones', () => {
    const inherited = Object.create({
      kind: 'groupMemberAdd',
      groupId: 7,
      personId: 1,
    }) as object;
    expect(readIntent(inherited)).toBeUndefined();
  });
});
