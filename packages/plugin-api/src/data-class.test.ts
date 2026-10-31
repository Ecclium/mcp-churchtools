import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { type DataClass, classify, dataClasses, dataClassOf } from './index.js';

// The key a second copy of the plugin API computes as well.
const sharedKey = Symbol.for('ecclium.mcp-churchtools.data-class.v1');

// Lists every class once. A class missing here fails the type check, a
// class missing from dataClasses fails the comparison below.
const everyClass: Readonly<Record<DataClass, true>> = {
  none: true,
  personId: true,
  groupId: true,
  'name.first': true,
  'name.last': true,
  email: true,
  phone: true,
  birthdate: true,
  address: true,
  amount: true,
  untrusted: true,
};

describe('dataClasses', () => {
  it('lists every data class exactly once', () => {
    expect([...dataClasses].sort()).toEqual(Object.keys(everyClass).sort());
  });

  it('cannot be changed at run time', () => {
    expect(Object.isFrozen(dataClasses)).toBe(true);
  });
});

describe('classify and dataClassOf', () => {
  it('classify returns the same schema, and dataClassOf reads the class', () => {
    const schema = z.string();
    expect(classify(schema, 'email')).toBe(schema);
    expect(dataClassOf(schema)).toBe('email');
  });

  it('report no class for a schema nobody classified', () => {
    expect(dataClassOf(z.string())).toBeUndefined();
  });

  it.each([
    ['optional', (s: z.ZodString) => s.optional()],
    ['nullable', (s: z.ZodString) => s.nullable()],
    ['default', (s: z.ZodString) => s.default('x')],
    ['prefault', (s: z.ZodString) => s.prefault('x')],
    ['readonly', (s: z.ZodString) => s.readonly()],
    ['catch', (s: z.ZodString) => s.catch('x')],
    ['nonoptional', (s: z.ZodString) => s.optional().nonoptional()],
    ['two wrappers', (s: z.ZodString) => s.nullable().optional()],
  ])('look through %s to the classified schema', (_name, wrap) => {
    const leaf = classify(z.string(), 'phone');
    expect(dataClassOf(wrap(leaf))).toBe('phone');
  });

  it.each([
    ['max', (s: z.ZodString) => s.max(5)],
    ['refine', (s: z.ZodString) => s.refine(() => true)],
    ['describe', (s: z.ZodString) => s.describe('A phone number.')],
    ['meta', (s: z.ZodString) => s.meta({ title: 'Phone' })],
    ['brand', (s: z.ZodString) => s.brand<'Phone'>()],
    ['two copies', (s: z.ZodString) => s.max(5).describe('A phone number.')],
  ])(
    'keep the class through %s, which zod links to the original',
    (_name, change) => {
      const leaf = classify(z.string(), 'phone');
      expect(dataClassOf(change(leaf))).toBe('phone');
    },
  );

  it('read the class of a schema that has a parent itself', () => {
    expect(dataClassOf(classify(z.string().max(5), 'phone'))).toBe('phone');
  });

  // Why dataClassOf does not use get() of the registry: for a schema with a
  // parent, get() drops an entry that has only symbol keys. If a later zod
  // returns the class here, the own reading along the parents can go.
  it('cannot rely on get() of the zod registry', () => {
    const schema = classify(z.string().max(5), 'phone');
    expect(z.globalRegistry.get(schema)).toBeUndefined();
  });

  it('refuse a copy whose class differs from that of its original', () => {
    const original = z.string();
    const copy = original.max(5);
    classify(copy, 'email');
    classify(original, 'phone');
    expect(() => dataClassOf(copy)).toThrow(
      'different data classes: email and phone',
    );
    expect(dataClassOf(original)).toBe('phone');
  });

  it('refuse a class written over that of the original with meta', () => {
    const copy = classify(z.string(), 'untrusted').meta({
      [sharedKey]: 'none',
    });
    expect(() => dataClassOf(copy)).toThrow(
      'different data classes: none and untrusted',
    );
  });

  it('refuse a class for a copy that differs from the inherited one', () => {
    const copy = classify(z.string(), 'email').max(5);
    expect(() => classify(copy, 'phone')).toThrow(
      'already classified as email',
    );
  });

  it('write only the own entry, not what the schema inherits', () => {
    const original = z.string().describe('Contact address.');
    const copy = original.max(5);
    classify(copy, 'email');
    expect(z.globalRegistry._map.get(copy)?.description).toBeUndefined();
    expect(z.globalRegistry.get(copy)?.description).toBe('Contact address.');
  });

  it.each([
    ['a pipe', (s: z.ZodString) => s.transform((value) => value)],
    ['an array', (s: z.ZodString) => s.array()],
  ])('do not look through %s', (_name, wrap) => {
    const leaf = classify(z.string(), 'phone');
    expect(dataClassOf(wrap(leaf))).toBeUndefined();
  });

  it('keep other metadata of the schema', () => {
    const schema = z.string();
    z.globalRegistry.add(schema, { description: 'Contact address.' });
    classify(schema, 'email');
    expect(z.globalRegistry.get(schema)?.description).toBe('Contact address.');
  });

  it('accept the same class twice', () => {
    const schema = classify(z.string(), 'email');
    expect(classify(schema, 'email')).toBe(schema);
    expect(dataClassOf(schema)).toBe('email');
  });

  it('refuse a second, different class', () => {
    const schema = classify(z.string(), 'email');
    expect(() => classify(schema, 'phone')).toThrow(
      'The schema is already classified as email, not phone.',
    );
    expect(dataClassOf(schema)).toBe('email');
  });

  it('refuse to classify a wrapper differently from what it wraps', () => {
    const leaf = classify(z.string(), 'email');
    expect(() => classify(leaf.optional(), 'phone')).toThrow(
      'already classified as email',
    );
  });

  it('refuse a wrapper and a schema with different classes in the registry', () => {
    const leaf = classify(z.string(), 'email');
    const wrapper = leaf.optional();
    z.globalRegistry.add(wrapper, { [sharedKey]: 'phone' });
    expect(() => dataClassOf(wrapper)).toThrow(
      'different data classes: phone and email',
    );
  });

  it('refuse an unknown class when classifying', () => {
    expect(() => classify(z.string(), 'secret' as DataClass)).toThrow(
      TypeError,
    );
  });

  it('refuse an unknown class found in the registry', () => {
    const schema = z.string();
    z.globalRegistry.add(schema, { [sharedKey]: 'secret' });
    expect(() => dataClassOf(schema)).toThrow(TypeError);
  });
});

describe('classify on other kinds of schema', () => {
  it.each([
    ['an object', z.object({ a: z.string() })],
    ['a loose object', z.looseObject({})],
    ['an array', z.array(z.string())],
    ['a record', z.record(z.string(), z.string())],
    ['a union', z.union([z.string(), z.number()])],
    ['any value', z.any()],
    ['an unknown value', z.unknown()],
    ['a lazy schema', z.lazy(() => z.string())],
    ['a pipe', z.string().transform((value) => value.length)],
    ['a custom check', z.custom<string>(() => true)],
    ['an optional object', z.object({ a: z.string() }).optional()],
    ['a nullable array', z.array(z.string()).nullable()],
  ])('refuse %s, which is no leaf', (_name, schema) => {
    expect(() => classify(schema, 'none')).toThrow(TypeError);
    expect(dataClassOf(schema)).toBeUndefined();
  });

  it.each([
    ['a number', z.number()],
    ['a big integer', z.bigint()],
    ['a boolean', z.boolean()],
    ['a date', z.date()],
    ['a literal', z.literal('a')],
    ['an enum', z.enum(['a', 'b'])],
    ['a template literal', z.templateLiteral(['id-', z.number()])],
    ['null', z.null()],
    ['a wrapped string', z.string().optional()],
  ])('accept %s, which is a leaf', (_name, schema) => {
    expect(dataClassOf(classify(schema, 'none'))).toBe('none');
  });
});

describe('reading the registry', () => {
  it('ignores a class that only the prototype of an entry carries', () => {
    const schema = z.string();
    const inherited: Record<symbol, unknown> = { [sharedKey]: 'none' };
    z.globalRegistry.add(
      schema,
      Object.create(inherited) as Record<string, unknown>,
    );
    expect(dataClassOf(schema)).toBeUndefined();
  });

  it('runs no getter of an entry and shows none of its text', () => {
    const schema = z.string();
    const entry = {};
    Object.defineProperty(entry, sharedKey, {
      enumerable: true,
      get: () => {
        throw new Error('text from somewhere else');
      },
    });
    z.globalRegistry.add(schema, entry);
    expect(() => dataClassOf(schema)).toThrow(TypeError);
    expect(() => dataClassOf(schema)).not.toThrow('text from somewhere else');
  });

  it('shows no text of an entry that throws while it is read', () => {
    const schema = z.string();
    const entry = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          throw new Error('text from somewhere else');
        },
      },
    );
    z.globalRegistry.add(schema, entry);
    expect(() => dataClassOf(schema)).toThrow(
      'The zod registry holds an entry the plugin API cannot read.',
    );
  });

  it('shows no text of an entry when classify copies it', () => {
    const withGetter = z.string();
    const entry = {};
    Object.defineProperty(entry, 'title', {
      enumerable: true,
      get: () => {
        throw new Error('text from somewhere else');
      },
    });
    z.globalRegistry.add(withGetter, entry);
    expect(() => classify(withGetter, 'none')).toThrow(
      'The zod registry holds an entry the plugin API cannot read.',
    );
    const withTrap = z.string();
    z.globalRegistry.add(
      withTrap,
      new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error('text from somewhere else');
          },
        },
      ),
    );
    expect(() => classify(withTrap, 'none')).toThrow(
      'The zod registry holds an entry the plugin API cannot read.',
    );
  });

  it('reads a long chain of checks', () => {
    let schema: z.ZodString = classify(z.string(), 'email');
    for (let step = 0; step < 100; step += 1) schema = schema.max(1000);
    expect(dataClassOf(schema)).toBe('email');
  });

  it('stops at a chain of copies that loops', () => {
    const schema = z.string();
    schema._zod.parent = schema;
    expect(() => dataClassOf(schema)).toThrow('longer than 1000 steps');
    expect(() => classify(schema, 'none')).toThrow('longer than 1000 steps');
  });

  it('stops at wrappers that loop', () => {
    const wrapper = z.string().optional();
    const def = wrapper._zod.def as { innerType: unknown };
    def.innerType = wrapper;
    expect(() => dataClassOf(wrapper)).toThrow('longer than 1000 steps');
    expect(() => classify(wrapper, 'none')).toThrow('longer than 1000 steps');
  });

  it('agrees with a second instance of this module', async () => {
    vi.resetModules();
    const second = await import('./data-class.js');
    expect(second.classify).not.toBe(classify);
    const first = classify(z.string(), 'email');
    expect(second.dataClassOf(first)).toBe('email');
    expect(dataClassOf(second.classify(z.string(), 'phone'))).toBe('phone');
  });
});

describe('the global registry', () => {
  it('is the one every copy of zod shares', () => {
    // zod keeps its global registry on globalThis, so a plugin with its own
    // copy of zod writes into the registry the core reads (ADR 0022).
    // @ts-expect-error: zod keeps its registry there but does not declare it
    const shared: unknown = globalThis.__zod_globalRegistry;
    expect(shared).toBe(z.globalRegistry);
  });

  it('holds the class under the key every copy of the plugin API computes', () => {
    const schema = classify(z.string(), 'birthdate');
    const value: unknown = Reflect.get(
      z.globalRegistry.get(schema) ?? {},
      sharedKey,
    );
    expect(value).toBe('birthdate');
  });

  it('keeps the class out of the JSON Schema a client receives', () => {
    const schema = z.object({
      contact: classify(z.string(), 'email'),
      note: z.string().meta({ hint: 'visible' }),
    });
    const wire = JSON.stringify(z.toJSONSchema(schema));
    // Control: metadata under a string key does reach the schema.
    expect(wire).toContain('visible');
    expect(wire).not.toContain('email');
    expect(wire).not.toContain('data-class');
  });
});
