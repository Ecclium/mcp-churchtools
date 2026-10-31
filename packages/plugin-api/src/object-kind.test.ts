import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  classify,
  dataClassOf,
  type ObjectKind,
  objectKindOf,
  objectKinds,
  refersTo,
} from './index.js';

// The key a second copy of the plugin API computes as well.
const sharedKey = Symbol.for('ecclium.mcp-churchtools.object-kind.v1');

// Lists every kind once. A kind missing here fails the type check, a kind
// missing from objectKinds fails the comparison below.
const everyKind: Readonly<Record<ObjectKind, true>> = {
  event: true,
  appointment: true,
  calendar: true,
  resource: true,
  booking: true,
  service: true,
  song: true,
  wiki_category: true,
  wiki_page: true,
};

describe('objectKinds', () => {
  it('lists every kind of object exactly once', () => {
    expect([...objectKinds].sort()).toEqual(Object.keys(everyKind).sort());
  });

  it('cannot be changed at run time', () => {
    expect(Object.isFrozen(objectKinds)).toBe(true);
  });

  it('leaves persons and groups to their data classes', () => {
    expect(objectKinds).not.toContain('person');
    expect(objectKinds).not.toContain('group');
  });
});

describe('refersTo and objectKindOf', () => {
  it('return the same schema and read its kind', () => {
    const schema = z.number().int();
    expect(refersTo(schema, 'event')).toBe(schema);
    expect(objectKindOf(schema)).toBe('event');
    expect(dataClassOf(schema)).toBeUndefined();
  });

  it('report no kind for a schema nobody marked', () => {
    expect(objectKindOf(z.number())).toBeUndefined();
  });

  it('read the kind through wrappers and copies', () => {
    const schema = refersTo(z.number().int(), 'calendar');
    expect(objectKindOf(schema.positive().optional())).toBe('calendar');
    expect(objectKindOf(schema.nullable().default(null))).toBe('calendar');
  });

  it('mark a leaf inside wrappers', () => {
    const schema = z.string().optional();
    refersTo(schema, 'wiki_page');
    expect(objectKindOf(schema)).toBe('wiki_page');
  });

  it('accept the same kind twice', () => {
    const schema = refersTo(z.number(), 'song');
    expect(() => refersTo(schema, 'song')).not.toThrow();
  });

  it('refuse a second, different kind', () => {
    const schema = refersTo(z.number(), 'song');
    expect(() => refersTo(schema, 'event')).toThrow(/already names song/u);
  });

  it('refuse a copy whose kind differs from that of its original', () => {
    const original = refersTo(z.number(), 'resource');
    const copy = original.positive();
    z.globalRegistry.add(copy, { [sharedKey]: 'booking' });
    expect(() => objectKindOf(copy)).toThrow(/different kinds of object/u);
  });

  it.each([['person'], ['group'], ['secret']])(
    'refuse the kind %s, which no ID of the input may name',
    (kind) => {
      expect(() => refersTo(z.number(), kind as ObjectKind)).toThrow(
        /personId and groupId/u,
      );
    },
  );

  it('refuse an unknown kind found in the registry', () => {
    const schema = z.number();
    z.globalRegistry.add(schema, { [sharedKey]: 'person' });
    expect(() => objectKindOf(schema)).toThrow(TypeError);
  });

  it.each([
    ['an object', z.object({ a: z.number() })],
    ['an array', z.array(z.number())],
    ['a union', z.union([z.string(), z.number()])],
    ['a record', z.record(z.string(), z.number())],
  ])('refuse %s, which is no leaf', (_name, schema) => {
    expect(() => refersTo(schema, 'event')).toThrow(TypeError);
    expect(objectKindOf(schema)).toBeUndefined();
  });
});

describe('a kind of object together with a data class', () => {
  it('allows the class none', () => {
    const schema = classify(refersTo(z.number(), 'event'), 'none');
    expect(objectKindOf(schema)).toBe('event');
    expect(dataClassOf(schema)).toBe('none');
    const other = refersTo(classify(z.number(), 'none'), 'calendar');
    expect(objectKindOf(other)).toBe('calendar');
  });

  it('refuses another class after the kind', () => {
    const schema = refersTo(z.number(), 'event');
    expect(() => classify(schema, 'personId')).toThrow(
      /can only be none, not personId/u,
    );
    expect(dataClassOf(schema)).toBeUndefined();
  });

  it('refuses a kind after another class', () => {
    const schema = classify(z.number(), 'groupId');
    expect(() => refersTo(schema, 'event')).toThrow(/classified as groupId/u);
    expect(objectKindOf(schema)).toBeUndefined();
  });

  it('keeps the class when the kind is added, and the other way round', () => {
    const first = classify(z.string(), 'none');
    refersTo(first, 'wiki_page');
    expect(dataClassOf(first)).toBe('none');
    const second = refersTo(z.string(), 'wiki_page');
    classify(second, 'none');
    expect(objectKindOf(second)).toBe('wiki_page');
  });
});

describe('the global registry', () => {
  it('holds the kind under the key every copy of the plugin API computes', () => {
    const schema = refersTo(z.number(), 'appointment');
    expect(
      (z.globalRegistry._map.get(schema) as Record<symbol, unknown>)[sharedKey],
    ).toBe('appointment');
  });

  it('keeps the kind out of the JSON Schema a client receives', () => {
    const schema = z.object({ id: refersTo(z.number(), 'wiki_category') });
    const wire = JSON.stringify(z.toJSONSchema(schema));
    expect(wire).not.toContain('wiki_category');
    expect(wire).not.toContain('object-kind');
  });
});
