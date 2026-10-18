import { classify } from '@ecclium/mcp-churchtools-plugin-api';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  checkInputSchema,
  checkOutputSchema,
  maxArrayLength,
  maxSchemaDepth,
  maxSchemaNodes,
} from './schema.js';

const name = () => classify(z.string().max(100), 'name.last');

describe('checkOutputSchema', () => {
  it('keeps the class of every field, frozen and without prototypes', () => {
    const shape = checkOutputSchema(
      z.object({
        id: classify(z.number().int(), 'personId'),
        last: name().optional(),
        note: classify(z.string(), 'untrusted').nullable(),
        tags: z.array(classify(z.string(), 'none')).max(5),
        pair: z.tuple([z.literal('a'), classify(z.boolean(), 'none')]),
        kind: z.enum(['a', 'b']).default('a'),
        either: z.union([classify(z.string(), 'email'), z.null()]),
        nested: z.strictObject({ count: z.number() }).readonly(),
        fixed: z.array(z.number()).length(3),
        nothing: z.null(),
        template: z.templateLiteral(['id-', z.number()]),
      }),
    );
    expect(shape).toBeDefined();
    if (shape === undefined) return;
    expect(shape.minimumSensitivity).toBe('personal');
    // count, the template, the literal of the tuple, the null field, the
    // elements of fixed and kind carry no class.
    expect(shape.unclassified).toBe(6);
    const { fields } = shape.root;
    expect(fields.id).toEqual({ kind: 'leaf', dataClass: 'personId' });
    expect(fields.last).toEqual({ kind: 'leaf', dataClass: 'name.last' });
    expect(fields.note).toEqual({ kind: 'leaf', dataClass: 'untrusted' });
    expect(fields.tags).toEqual({
      kind: 'array',
      element: { kind: 'leaf', dataClass: 'none' },
    });
    expect(fields.either).toEqual({ kind: 'leaf', dataClass: 'email' });
    expect(fields.pair?.kind).toBe('tuple');
    expect(fields.nested?.kind).toBe('object');
    expect(Object.isFrozen(shape)).toBe(true);
    expect(Object.isFrozen(shape.root.fields)).toBe(true);
    expect(Object.getPrototypeOf(shape.root.fields)).toBeNull();
    expect(Object.getPrototypeOf(fields.id)).toBeNull();
  });

  it('keeps the classes it read, whatever the registry of zod says later', () => {
    const email = classify(z.string(), 'email');
    const shape = checkOutputSchema(z.object({ email }));
    z.globalRegistry.remove(email);
    expect(shape?.root.fields.email).toEqual({
      kind: 'leaf',
      dataClass: 'email',
    });
  });

  it('derives the sensitivity none from classes without personal data', () => {
    const shape = checkOutputSchema(
      z.object({ text: classify(z.string(), 'untrusted'), n: z.number() }),
    );
    expect(shape?.minimumSensitivity).toBe('none');
    for (const dataClass of [
      'name.first',
      'phone',
      'birthdate',
      'address',
    ] as const) {
      expect(
        checkOutputSchema(z.object({ x: classify(z.string(), dataClass) }))
          ?.minimumSensitivity,
      ).toBe('personal');
    }
  });

  it.each([
    ['no schema', { type: 'object' }],
    ['a string', z.string()],
    ['an object wrapped as optional', z.object({}).optional()],
    ['a loose object', z.looseObject({ a: z.string() })],
    ['a catch-all', z.object({}).catchall(z.string())],
    ['a nested loose object', z.object({ a: z.looseObject({}) })],
    ['any', z.object({ a: z.any() })],
    ['unknown', z.object({ a: z.unknown() })],
    ['a record', z.object({ a: z.record(z.string(), z.string()) })],
    ['a custom schema', z.object({ a: z.custom<string>(() => true) })],
    ['a refined leaf', z.object({ a: z.string().refine(() => true) })],
    [
      'a refined wrapper',
      z.object({
        a: z
          .string()
          .optional()
          .refine(() => true),
      }),
    ],
    ['a refined object', z.object({ a: z.string() }).refine(() => true)],
    ['a transform', z.object({ a: z.string().transform((value) => value) })],
    ['a pipe', z.object({ a: z.string().pipe(z.string()) })],
    ['lazy', z.object({ a: z.lazy(() => z.string()) })],
    ['a bigint', z.object({ a: z.bigint() })],
    ['a date', z.object({ a: z.date() })],
    ['catch', z.object({ a: z.string().catch('x') })],
    ['a map', z.object({ a: z.map(z.string(), z.string()) })],
    ['a set', z.object({ a: z.set(z.string()) })],
    [
      'an intersection',
      z.object({ a: z.intersection(z.object({}), z.object({})) }),
    ],
    ['an array without maximum', z.object({ a: z.array(z.string()) })],
    [
      'an array with only a minimum',
      z.object({ a: z.array(z.string()).min(1) }),
    ],
    [
      'an array above the maximum',
      z.object({ a: z.array(z.string()).max(maxArrayLength + 1) }),
    ],
    [
      'a tuple with rest',
      z.object({ a: z.tuple([z.string()]).rest(z.number()) }),
    ],
    [
      'a union of objects',
      z.object({ a: z.union([z.object({}), z.object({ b: z.string() })]) }),
    ],
    [
      'a union with a refined option',
      z.object({
        a: z.union([
          z
            .string()
            .optional()
            .refine(() => true),
          z.null(),
        ]),
      }),
    ],
    [
      'a union of different classes',
      z.object({
        a: z.union([
          classify(z.string(), 'email'),
          classify(z.number(), 'personId'),
        ]),
      }),
    ],
    ['an empty field name', z.object({ '': z.string() })],
    ['a field name with a line break', z.object({ 'a\nb': z.string() })],
  ])('refuses %s', (_, schema) => {
    expect(checkOutputSchema(schema)).toBeUndefined();
  });

  it.each(['email', 'phone', 'birthdate', 'untrusted'] as const)(
    'refuses the class %s on a leaf that is no string',
    (dataClass) => {
      for (const leaf of [
        z.number(),
        z.boolean(),
        z.enum(['a', 'b']),
        z.literal('a'),
        z.templateLiteral(['a-', z.number()]),
        z.null(),
      ]) {
        expect(
          checkOutputSchema(z.object({ a: classify(leaf, dataClass) })),
        ).toBeUndefined();
      }
      expect(
        checkOutputSchema(
          z.object({
            a: z.union([classify(z.string(), dataClass), z.number()]),
          }),
        ),
      ).toBeUndefined();
      // classify takes no union, but the registry of zod does.
      const union = z.union([z.string(), z.literal('a')]);
      z.globalRegistry.add(union, {
        [Symbol.for('ecclium.mcp-churchtools.data-class.v1')]: dataClass,
      });
      expect(checkOutputSchema(z.object({ a: union }))).toBeUndefined();
      expect(
        checkOutputSchema(
          z.object({
            a: classify(z.string().max(5), dataClass).nullable(),
            b: z.union([classify(z.string(), dataClass), z.null()]),
          }),
        )?.root.fields,
      ).toEqual({
        a: { kind: 'leaf', dataClass },
        b: { kind: 'leaf', dataClass },
      });
    },
  );

  it('keeps other classes on leaves that are no string', () => {
    expect(
      checkOutputSchema(
        z.object({
          a: classify(z.number(), 'personId'),
          b: z.union([classify(z.number(), 'amount'), z.boolean()]),
        }),
      )?.root.fields,
    ).toEqual({
      a: { kind: 'leaf', dataClass: 'personId' },
      b: { kind: 'leaf', dataClass: 'amount' },
    });
  });

  it('takes a wrapped option of a union and the smallest maximum of an array', () => {
    const shape = checkOutputSchema(
      z.object({
        a: z.union([classify(z.string(), 'email').optional(), z.null()]),
        b: z.array(z.string()).max(3).max(7),
      }),
    );
    expect(shape?.root.fields.a).toEqual({ kind: 'leaf', dataClass: 'email' });
  });

  it.each([
    ['a type that is no string', { type: 1 }],
    ['checks that are no list', { type: 'string', checks: 'custom' }],
    ['a union without options', { type: 'union', options: [] }],
    ['an object without shape', { type: 'object', shape: null }],
  ])('refuses a field whose definition has %s', (_, def) => {
    const fake = { _zod: { version: { major: 4 }, def } };
    expect(
      checkOutputSchema(z.object({ a: fake as unknown as z.ZodString })),
    ).toBeUndefined();
  });

  it('refuses a tuple with a refused item', () => {
    expect(
      checkOutputSchema(z.object({ a: z.tuple([z.string(), z.any()]) })),
    ).toBeUndefined();
  });

  it('refuses a field named __proto__', () => {
    const shape = Object.create(null) as Record<string, z.ZodType>;
    shape.__proto__ = z.string();
    expect(checkOutputSchema(z.object(shape))).toBeUndefined();
  });

  it('refuses a schema of another major version of zod', () => {
    const schema = z.object({ a: z.string() });
    const fake = { _zod: { ...schema._zod, version: { major: 3 } } };
    expect(checkOutputSchema(fake)).toBeUndefined();
    expect(
      checkOutputSchema(z.object({ a: fake as unknown as z.ZodString })),
    ).toBeUndefined();
  });

  it('refuses a class that conflicts between a copy and its original', () => {
    const email = classify(z.string(), 'email');
    const copy = email.max(10);
    z.globalRegistry.add(copy, {
      ...z.globalRegistry.get(copy),
      [Symbol.for('ecclium.mcp-churchtools.data-class.v1')]: 'phone',
    });
    expect(checkOutputSchema(z.object({ a: copy }))).toBeUndefined();
    expect(
      checkOutputSchema(z.object({ a: z.union([copy, z.null()]) })),
    ).toBeUndefined();
  });

  it(`takes ${String(maxSchemaDepth)} levels and refuses one more`, () => {
    const nest = (levels: number): z.ZodObject => {
      let schema = z.object({ leaf: z.string() });
      for (let level = 1; level < levels; level += 1) {
        schema = z.object({ next: schema }) as unknown as typeof schema;
      }
      return schema;
    };
    expect(checkOutputSchema(nest(maxSchemaDepth))).toBeDefined();
    expect(checkOutputSchema(nest(maxSchemaDepth + 1))).toBeUndefined();
    const arrays = (levels: number): z.ZodType => {
      let schema: z.ZodType = z.string();
      for (let level = 1; level < levels; level += 1) {
        schema = z.array(schema).max(1);
      }
      return z.object({ a: schema });
    };
    expect(checkOutputSchema(arrays(maxSchemaDepth))).toBeDefined();
    expect(checkOutputSchema(arrays(maxSchemaDepth + 1))).toBeUndefined();
  });

  it(`refuses more than ${String(maxSchemaNodes)} schemas`, () => {
    const wide = (count: number) =>
      z.object(
        Object.fromEntries(
          Array.from({ length: count }, (_, i) => [
            `f${String(i)}`,
            z.string(),
          ]),
        ),
      );
    expect(checkOutputSchema(wide(maxSchemaNodes - 1))).toBeDefined();
    expect(checkOutputSchema(wide(maxSchemaNodes))).toBeUndefined();
    const union = z.union(
      Array.from({ length: maxSchemaNodes }, (_, i) => z.literal(i)),
    );
    expect(checkOutputSchema(z.object({ a: union }))).toBeUndefined();
  });
});

describe('checkInputSchema', () => {
  it('takes closed objects with fields of any form', () => {
    expect(checkInputSchema(z.object({}))).toBe(true);
    expect(checkInputSchema(z.strictObject({ a: z.string() }))).toBe(true);
    expect(
      checkInputSchema(z.object({ a: z.string().refine(() => true) })),
    ).toBe(true);
  });

  it.each([
    ['a loose object', z.looseObject({})],
    ['a catch-all', z.object({}).catchall(z.string())],
    ['a string', z.string()],
    ['any', z.any()],
    ['an optional object', z.object({}).optional()],
    ['no schema', null],
  ])('refuses %s', (_, schema) => {
    expect(checkInputSchema(schema)).toBe(false);
  });
});
