import { classify, type DataClass } from '@ecclium/mcp-churchtools-plugin-api';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  checkInputSchema,
  checkOutputSchema,
  type LeafType,
  maxArrayLength,
  maxSchemaDepth,
  maxSchemaNodes,
  type ShapeNode,
  type ShapePresence,
} from './schema.js';

const name = () => classify(z.string().max(100), 'name.last');

// A kept leaf, present and not null unless the test says otherwise.
const leaf = (
  dataClass: DataClass | undefined,
  types: readonly LeafType[],
  presence: Partial<ShapePresence> = {},
): ShapeNode => ({
  kind: 'leaf',
  dataClass,
  types,
  optional: false,
  nullable: false,
  ...presence,
});

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
    expect(fields.id).toEqual(leaf('personId', ['number']));
    expect(fields.last).toEqual(
      leaf('name.last', ['string'], { optional: true }),
    );
    expect(fields.note).toEqual(
      leaf('untrusted', ['string'], { nullable: true }),
    );
    expect(fields.tags).toEqual({
      kind: 'array',
      element: leaf('none', ['string']),
      optional: false,
      nullable: false,
    });
    expect(fields.either).toEqual(leaf('email', ['string', 'null']));
    expect(fields.kind).toEqual(leaf(undefined, ['string']));
    expect(fields.nothing).toEqual(leaf(undefined, ['null']));
    expect(fields.pair).toEqual({
      kind: 'tuple',
      items: [leaf(undefined, ['string']), leaf('none', ['boolean'])],
      optional: false,
      nullable: false,
    });
    expect(fields.nested).toEqual({
      kind: 'object',
      fields: { count: leaf(undefined, ['number']) },
      optional: false,
      nullable: false,
    });
    expect(Object.isFrozen(shape)).toBe(true);
    expect(Object.isFrozen(shape.root.fields)).toBe(true);
    expect(Object.getPrototypeOf(shape.root.fields)).toBeNull();
    expect(Object.getPrototypeOf(fields.id)).toBeNull();
  });

  it('keeps the classes it read, whatever the registry of zod says later', () => {
    const email = classify(z.string(), 'email');
    const shape = checkOutputSchema(z.object({ email }));
    z.globalRegistry.remove(email);
    expect(shape?.root.fields.email).toEqual(leaf('email', ['string']));
  });

  it('keeps the types of JSON of every leaf', () => {
    const shape = checkOutputSchema(
      z.object({
        text: z.string(),
        count: z.number().int(),
        flag: z.boolean(),
        nothing: z.null(),
        literal: z.literal(['a', 1, true, null]),
        names: z.enum(['a', 'b']),
        numbers: z.enum({ one: 1, two: 2 }),
        mixed: z.enum({ one: 1, two: 'two' }),
        template: z.templateLiteral(['id-', z.number()]),
        union: z.union([z.literal('x'), z.boolean(), z.number()]),
      }),
    );
    const types = Object.fromEntries(
      Object.entries(shape?.root.fields ?? {}).map(([key, node]) => [
        key,
        node.kind === 'leaf' ? node.types : node.kind,
      ]),
    );
    expect(types).toEqual({
      text: ['string'],
      count: ['number'],
      flag: ['boolean'],
      nothing: ['null'],
      literal: ['string', 'number', 'boolean', 'null'],
      names: ['string'],
      numbers: ['number'],
      mixed: ['string', 'number'],
      template: ['string'],
      union: ['string', 'number', 'boolean'],
    });
    for (const node of Object.values(shape?.root.fields ?? {})) {
      expect(node.kind === 'leaf' && Object.isFrozen(node.types)).toBe(true);
    }
  });

  it('keeps whether a value may be missing, as zod decides it for the output', () => {
    const schema = z.object({
      plain: z.string(),
      optional: z.string().optional(),
      defaulted: z.string().default('x'),
      defaultOverOptional: z.string().optional().default('x'),
      optionalOverDefault: z.string().default('x').optional(),
      nullable: z.string().nullable(),
      nullish: z.string().nullish(),
      nullableOverDefault: z.string().default('x').nullable(),
      readonlyOptional: z.string().optional().readonly(),
      unionWithOptional: z.union([z.string().optional(), z.null()]),
      unionWithDefault: z.union([z.string().default('x'), z.null()]),
      defaultedUnion: z.union([z.string().optional(), z.null()]).default(null),
      unionWithNullable: z.union([z.string().nullable(), z.number()]),
      list: z.array(z.string()).max(2).optional(),
      pair: z.tuple([z.string()]).nullable(),
      nested: z.object({ a: z.string() }).nullish(),
    });
    const fields = Object.entries(checkOutputSchema(schema)?.root.fields ?? {});
    expect(
      fields.filter(([, node]) => !node.optional).map(([key]) => key),
    ).toEqual(z.toJSONSchema(schema, { io: 'output' }).required);
    expect(
      fields.filter(([, node]) => node.nullable).map(([key]) => key),
    ).toEqual([
      'nullable',
      'nullish',
      'nullableOverDefault',
      'unionWithNullable',
      'pair',
      'nested',
    ]);
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
        a: leaf(dataClass, ['string'], { nullable: true }),
        b: leaf(dataClass, ['string', 'null']),
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
      a: leaf('personId', ['number']),
      b: leaf('amount', ['number', 'boolean']),
    });
  });

  it('takes a wrapped option of a union and the smallest maximum of an array', () => {
    const shape = checkOutputSchema(
      z.object({
        a: z.union([classify(z.string(), 'email').optional(), z.null()]),
        b: z.array(z.string()).max(3).max(7),
      }),
    );
    expect(shape?.root.fields.a).toEqual(
      leaf('email', ['string', 'null'], { optional: true }),
    );
  });

  it.each([
    ['a type that is no string', { type: 1 }],
    ['checks that are no list', { type: 'string', checks: 'custom' }],
    ['a union without options', { type: 'union', options: [] }],
    ['an object without shape', { type: 'object', shape: null }],
    ['a literal without values', { type: 'literal', values: [] }],
    ['a literal whose values are no list', { type: 'literal', values: 'a' }],
    ['an enum without entries', { type: 'enum', entries: null }],
    [
      'an enum with a number that is not finite',
      { type: 'enum', entries: { a: Number.NaN } },
    ],
  ])('refuses a field whose definition has %s', (_, def) => {
    const fake = { _zod: { version: { major: 4 }, def } };
    expect(
      checkOutputSchema(z.object({ a: fake as unknown as z.ZodString })),
    ).toBeUndefined();
  });

  it.each([
    ['a bigint', z.literal(1n)],
    ['undefined', z.literal(undefined)],
    ['a bigint next to a string', z.literal(['a', 1n])],
    ['a bigint in a union', z.union([z.literal(1n), z.null()])],
  ])(
    'refuses a literal of %s, which JSON does not carry as it is',
    (_, literal) => {
      expect(checkOutputSchema(z.object({ a: literal }))).toBeUndefined();
    },
  );

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
