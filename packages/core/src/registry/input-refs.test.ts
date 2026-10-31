import { classify, refersTo } from '@ecclium/mcp-churchtools-plugin-api';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createObjectRefCollector, type ObjectDomain } from '../audit/index.js';
import {
  checkInputRefs,
  collectInputRefs,
  holdsPersons,
  type InputRefNode,
} from './input-refs.js';

const none = <T extends z.core.$ZodType>(schema: T): T =>
  classify(schema, 'none');
const person = () => classify(z.number().int(), 'personId');
const group = () => classify(z.number().int(), 'groupId');

// The refs of a parsed input along the kept shape, as the pipeline reads
// them.
const refsOf = (schema: z.ZodType, value: unknown): readonly string[] => {
  const shape = checkInputRefs(schema);
  if (shape?.refs === undefined) return [];
  const refs = createObjectRefCollector();
  collectInputRefs(schema.parse(value), shape.refs, (domain, item) => {
    refs.add(domain, item);
  });
  return refs.list().refs;
};

describe('checkInputRefs', () => {
  it('keeps nothing for an input without IDs, and counts no field', () => {
    expect(checkInputRefs(z.strictObject({}))).toEqual({
      refs: undefined,
      undeclared: 0,
    });
    expect(
      checkInputRefs(z.strictObject({ page: none(z.number()).optional() })),
    ).toEqual({ refs: undefined, undeclared: 0 });
  });

  it('names persons and groups by their classes, the rest by their kind', () => {
    const shape = checkInputRefs(
      z.strictObject({
        personId: person(),
        groupId: group().optional(),
        eventId: refersTo(z.number().int(), 'event').nullable(),
        page: none(z.number()),
      }),
    );
    expect(shape).toEqual({
      refs: {
        kind: 'object',
        fields: {
          personId: { kind: 'leaf', domain: 'person' },
          groupId: { kind: 'leaf', domain: 'group' },
          eventId: { kind: 'leaf', domain: 'event' },
        },
      },
      undeclared: 0,
    });
    expect(Object.isFrozen(shape)).toBe(true);
    expect(Object.isFrozen(shape?.refs)).toBe(true);
  });

  it('accepts a kind next to the class none', () => {
    const shape = checkInputRefs(
      z.strictObject({ id: none(refersTo(z.number(), 'song')) }),
    );
    expect(shape?.refs).toEqual({
      kind: 'object',
      fields: { id: { kind: 'leaf', domain: 'song' } },
    });
  });

  it('counts every leaf without class or kind, also in containers', () => {
    expect(
      checkInputRefs(
        z.strictObject({
          query: z.string(),
          list: z.array(z.number()).max(5),
          deep: z.object({ any: z.unknown() }),
          ok: none(z.string()),
        }),
      )?.undeclared,
    ).toBe(3);
  });

  it('reads arrays, records, tuples, catch-alls, unions and intersections', () => {
    const shape = checkInputRefs(
      z.strictObject({
        list: z.array(refersTo(z.number(), 'calendar')).max(5),
        map: z.record(none(z.string()), group()),
        pair: z.tuple([none(z.string()), person()], song()),
        open: z.object({ note: none(z.string()) }).catchall(person()),
        either: z.union([
          z.object({ eventId: refersTo(z.number(), 'event') }),
          z.object({ songId: song() }),
          none(z.string()),
        ]),
        both: z.intersection(
          z.object({ a: person() }),
          z.object({ b: group() }),
        ),
      }),
    );
    expect(shape?.undeclared).toBe(0);
    expect(shape?.refs).toEqual({
      kind: 'object',
      fields: {
        list: { kind: 'list', element: { kind: 'leaf', domain: 'calendar' } },
        map: { kind: 'record', value: { kind: 'leaf', domain: 'group' } },
        pair: {
          kind: 'tuple',
          items: [null, { kind: 'leaf', domain: 'person' }],
          rest: { kind: 'leaf', domain: 'song' },
        },
        open: {
          kind: 'object',
          fields: {},
          rest: { kind: 'leaf', domain: 'person' },
        },
        either: {
          kind: 'choice',
          options: [
            {
              kind: 'object',
              fields: { eventId: { kind: 'leaf', domain: 'event' } },
            },
            {
              kind: 'object',
              fields: { songId: { kind: 'leaf', domain: 'song' } },
            },
          ],
        },
        both: {
          kind: 'choice',
          options: [
            {
              kind: 'object',
              fields: { a: { kind: 'leaf', domain: 'person' } },
            },
            {
              kind: 'object',
              fields: { b: { kind: 'leaf', domain: 'group' } },
            },
          ],
        },
      },
    });
  });

  it('keeps a single form of a union as it is', () => {
    expect(
      checkInputRefs(
        z.strictObject({ id: z.union([person(), none(z.null())]) }),
      )?.refs,
    ).toEqual({
      kind: 'object',
      fields: { id: { kind: 'leaf', domain: 'person' } },
    });
  });

  it('keeps nothing of containers and tuples without IDs', () => {
    expect(
      checkInputRefs(
        z.strictObject({
          list: z.array(none(z.number())).max(5),
          map: z.record(none(z.string()), none(z.number())),
          pair: z.tuple([none(z.string())]),
          either: z.union([none(z.string()), none(z.number())]),
        }),
      )?.refs,
    ).toBeUndefined();
  });

  it('accepts a pipe without IDs, read on its input side', () => {
    expect(
      checkInputRefs(
        z.strictObject({ text: none(z.string()).transform((v) => v.length) }),
      ),
    ).toEqual({ refs: undefined, undeclared: 0 });
  });

  it.each([
    ['an ID inside a pipe', z.strictObject({ id: person().transform(String) })],
    ['a lazy field', z.strictObject({ value: z.lazy(() => none(z.string())) })],
    [
      'leaves of a union with two kinds',
      z.strictObject({ id: z.union([person(), group()]) }),
    ],
  ])('refuses %s', (_what, schema) => {
    expect(checkInputRefs(schema)).toBeUndefined();
  });

  it.each([
    ['a bigint', classify(z.bigint(), 'personId')],
    ['a text for a person', classify(z.string().max(10), 'personId')],
    ['a date', refersTo(z.date(), 'event')],
    ['a boolean', classify(z.boolean(), 'groupId')],
  ])('refuses an ID that is %s, which has no form of an ID', (_what, leaf) => {
    expect(checkInputRefs(z.strictObject({ id: leaf }))).toBeUndefined();
  });

  // Its keys are never read for IDs (ADR 0028, ADR 0069).
  it.each([
    ['a person', classify(z.string(), 'personId')],
    ['a group', classify(z.string(), 'groupId')],
    ['an event', refersTo(z.string(), 'event')],
  ])('refuses a record keyed by %s', (_what, key) => {
    expect(
      checkInputRefs(
        z.strictObject({ byKey: z.record(key, none(z.string())) }),
      ),
    ).toBeUndefined();
  });

  it('refuses a record keyed by a class it cannot read', () => {
    const key = z.string();
    z.globalRegistry.add(key, {
      [Symbol.for('ecclium.mcp-churchtools.data-class.v1')]: 'secret',
    });
    expect(
      checkInputRefs(
        z.strictObject({ byKey: z.record(key, none(z.string())) }),
      ),
    ).toBeUndefined();
  });

  it('refuses a field that is no schema of zod 4', () => {
    const broken = z.strictObject({ a: none(z.string()) });
    Object.defineProperty(broken._zod.def.shape, 'a', { value: {} });
    expect(checkInputRefs(broken)).toBeUndefined();
  });

  it('refuses a kind next to another class, as another copy might write', () => {
    const leaf = z.number();
    z.globalRegistry.add(leaf, {
      [Symbol.for('ecclium.mcp-churchtools.data-class.v1')]: 'personId',
      [Symbol.for('ecclium.mcp-churchtools.object-kind.v1')]: 'event',
    });
    expect(checkInputRefs(z.strictObject({ id: leaf }))).toBeUndefined();
  });

  it('refuses a class it cannot read', () => {
    const leaf = z.number();
    z.globalRegistry.add(leaf, {
      [Symbol.for('ecclium.mcp-churchtools.data-class.v1')]: 'secret',
    });
    expect(checkInputRefs(z.strictObject({ id: leaf }))).toBeUndefined();
  });

  it('refuses an input deeper than an output may be', () => {
    let schema: z.ZodType = person();
    for (let level = 0; level < 17; level += 1) {
      schema = z.object({ next: schema });
    }
    expect(checkInputRefs(z.strictObject({ deep: schema }))).toBeUndefined();
  });

  it('refuses an input with more schemas than an output may have', () => {
    const fields: Record<string, z.ZodType> = {};
    for (let index = 0; index < 2001; index += 1) {
      fields[`f${String(index)}`] = none(z.string());
    }
    expect(checkInputRefs(z.strictObject(fields))).toBeUndefined();
    const wrapped: Record<string, z.ZodType> = {};
    for (let index = 0; index < 700; index += 1) {
      wrapped[`f${String(index)}`] = none(z.string()).optional().nullable();
    }
    expect(checkInputRefs(z.strictObject(wrapped))).toBeUndefined();
  });

  it('passes on an error that is no refusal of the walk', () => {
    const schema = z.strictObject({ a: none(z.string()) });
    Object.defineProperty(schema._zod.def, 'shape', {
      get: () => {
        throw new RangeError('broken');
      },
    });
    expect(() => checkInputRefs(schema)).toThrow(RangeError);
  });
});

function song(): z.ZodNumber {
  return refersTo(z.number().int(), 'song');
}

describe('collectInputRefs', () => {
  it('reads the IDs of a parsed input in the order of the input', () => {
    const schema = z.strictObject({
      calendarIds: z.array(refersTo(z.number(), 'calendar')).max(5),
      personId: person(),
      guid: refersTo(z.string(), 'wiki_page'),
    });
    expect(
      refsOf(schema, {
        calendarIds: [3, 1, 3],
        personId: 12,
        guid: 'A1B2C3D4-0000-4000-8000-000000000001',
      }),
    ).toEqual([
      'calendar:3',
      'calendar:1',
      'person:12',
      'wiki_page:a1b2c3d4-0000-4000-8000-000000000001',
    ]);
  });

  it('reads records, tuples with their rest, catch-alls and every form of a choice', () => {
    const schema = z.strictObject({
      map: z.record(none(z.string()), group()),
      pair: z.tuple([none(z.string()), person()], song()),
      open: z.object({ note: none(z.string()) }).catchall(person()),
      either: z.union([
        z.object({ eventId: refersTo(z.number(), 'event') }),
        z.object({ songId: song() }),
      ]),
    });
    expect(
      refsOf(schema, {
        map: { a: 4, b: 5 },
        pair: ['x', 6, 7, 8],
        open: { note: 'n', extra: 9 },
        either: { songId: 10 },
      }),
    ).toEqual([
      'group:4',
      'group:5',
      'person:6',
      'song:7',
      'song:8',
      'person:9',
      'song:10',
    ]);
  });

  it('hands on no missing or null ID', () => {
    expect(
      refsOf(
        z.strictObject({
          a: person().nullable(),
          b: person().optional(),
          c: person(),
        }),
        { a: null, c: 3 },
      ),
    ).toEqual(['person:3']);
  });

  it('gives nothing for values of another form, a proxy or a getter', () => {
    const node: InputRefNode = {
      kind: 'object',
      fields: {
        list: { kind: 'list', element: { kind: 'leaf', domain: 'person' } },
        map: { kind: 'record', value: { kind: 'leaf', domain: 'group' } },
        pair: { kind: 'tuple', items: [{ kind: 'leaf', domain: 'song' }] },
      },
    };
    const found: string[] = [];
    const add = (domain: ObjectDomain, value: unknown): void => {
      found.push(`${domain}:${String(value)}`);
    };
    let calls = 0;
    const withGetter = {};
    Object.defineProperty(withGetter, 'list', {
      enumerable: true,
      get: () => {
        calls += 1;
        return [1];
      },
    });
    for (const value of [
      null,
      [1],
      new Proxy({ list: [1] }, {}),
      withGetter,
      { list: 'x', map: [1], pair: { 0: 1 } },
      { list: new Proxy([1], {}), map: new Proxy({ a: 1 }, {}) },
    ]) {
      collectInputRefs(value, node, add);
    }
    collectInputRefs(['x'], { kind: 'tuple', items: [null] }, add);
    expect(found).toEqual([]);
    expect(calls).toBe(0);
  });
});

describe('holdsPersons', () => {
  const person: InputRefNode = { kind: 'leaf', domain: 'person' };
  const group: InputRefNode = { kind: 'leaf', domain: 'group' };

  it('finds a person at any depth', () => {
    const nodes: InputRefNode[] = [
      person,
      { kind: 'object', fields: { a: group, b: person } },
      { kind: 'object', fields: {}, rest: person },
      { kind: 'list', element: person },
      { kind: 'record', value: person },
      { kind: 'tuple', items: [null, person] },
      { kind: 'tuple', items: [group], rest: person },
      { kind: 'choice', options: [group, person] },
    ];
    for (const node of nodes) {
      expect(holdsPersons(node), JSON.stringify(node)).toBe(true);
    }
  });

  it('finds none where only other objects stand', () => {
    const nodes: InputRefNode[] = [
      group,
      { kind: 'object', fields: { a: group } },
      { kind: 'object', fields: {}, rest: group },
      { kind: 'list', element: group },
      { kind: 'record', value: group },
      { kind: 'tuple', items: [null, group] },
      { kind: 'choice', options: [group] },
    ];
    for (const node of nodes) {
      expect(holdsPersons(node), JSON.stringify(node)).toBe(false);
    }
  });
});
