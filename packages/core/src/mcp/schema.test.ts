import { classify } from '@ecclium/mcp-churchtools-plugin-api';
import { examplePlugin } from '@ecclium/mcp-churchtools-testkit';
import {
  Ajv,
  AjvJsonSchemaValidator,
} from '@modelcontextprotocol/server/validators/ajv';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createToolCatalog, type OutputShape } from '../registry/index.js';
import { checkOutputSchema } from '../registry/schema.js';
import { deriveOutputSchema } from './schema.js';

const shapeOf = (schema: z.ZodObject): OutputShape => {
  const shape = checkOutputSchema(schema);
  if (shape === undefined) throw new Error('the registry refused the schema');
  return shape;
};

// Every object and array of a schema, to check that all are frozen and
// that no object has a prototype.
const containers = (value: unknown): object[] => {
  if (typeof value !== 'object' || value === null) return [];
  return [value, ...Object.values(value).flatMap(containers)];
};

const expectFrozen = (schema: unknown): void => {
  for (const container of containers(schema)) {
    expect(Object.isFrozen(container)).toBe(true);
    if (!Array.isArray(container)) {
      expect(Object.getPrototypeOf(container)).toBeNull();
    }
  }
};

describe('deriveOutputSchema', () => {
  it('advertises types, null and required fields, and no form of a string (golden)', () => {
    const schema = deriveOutputSchema(
      shapeOf(
        z.object({
          id: classify(z.number().int().min(1), 'personId'),
          email: classify(z.email().max(100), 'email').optional(),
          note: classify(z.string().max(10), 'untrusted').nullable(),
          kind: z.enum(['a', 'b']).default('a'),
          code: z.string().regex(/^[a-z]+$/u),
          tags: z.array(classify(z.string(), 'untrusted')).min(1).max(5),
          gaps: z.array(z.string().optional()).max(3),
          pair: z.tuple([z.literal('x'), z.number().optional()]),
          nested: z.strictObject({ flag: z.boolean() }).nullish(),
          either: z.union([z.literal('x'), z.number(), z.null()]),
        }),
      ),
    );
    expect(schema).toEqual({
      type: 'object',
      properties: {
        id: { type: 'number' },
        email: { type: 'string' },
        note: { type: ['string', 'null'] },
        kind: { type: 'string' },
        code: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        gaps: { type: 'array', items: { type: ['string', 'null'] } },
        pair: {
          type: 'array',
          prefixItems: [{ type: 'string' }, { type: ['number', 'null'] }],
          minItems: 2,
          maxItems: 2,
        },
        nested: {
          type: ['object', 'null'],
          properties: { flag: { type: 'boolean' } },
          required: ['flag'],
          additionalProperties: false,
        },
        either: { type: ['string', 'number', 'null'] },
      },
      required: [
        'id',
        'note',
        'kind',
        'code',
        'tags',
        'gaps',
        'pair',
        'either',
      ],
      additionalProperties: false,
    });
    expectFrozen(schema);
  });

  it('leaves out an empty list of required fields', () => {
    expect(
      deriveOutputSchema(shapeOf(z.object({ a: z.string().optional() }))),
    ).toEqual({
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: false,
    });
  });

  it('derives a schema for every tool of the example plugin', () => {
    const catalog = createToolCatalog({
      core: examplePlugin,
      plugins: [],
      readOnly: false,
      toolsets: new Set(['wiki'] as const),
    });
    for (const entry of catalog.list()) {
      const schema = deriveOutputSchema(entry.shape);
      expect(schema.type).toBe('object');
      expect(schema.additionalProperties).toBe(false);
    }
  });

  describe('a tuple, checked as a client checks a result', () => {
    // The engine of a client of the 2025 era built on version 1 of the
    // TypeScript SDK: draft-07, with the options the SDK names as the
    // equivalent of its default there. The formats it also adds are left
    // out, because the output schema has no format.
    const draft07 = (): AjvJsonSchemaValidator =>
      new AjvJsonSchemaValidator(
        new Ajv({
          strict: false,
          validateFormats: true,
          validateSchema: false,
          allErrors: true,
        }),
      );
    const engines = [
      ['2020-12', () => new AjvJsonSchemaValidator()],
      ['draft-07', draft07],
    ] as const;
    // The schema as the client receives it, after JSON.
    const schema = JSON.parse(
      JSON.stringify(
        deriveOutputSchema(
          shapeOf(
            z.object({
              pair: z.tuple([z.string().max(10), z.number().optional()]),
            }),
          ),
        ),
      ),
    ) as Readonly<Record<string, unknown>>;

    it.each(engines)(
      'takes a tuple of its length under %s',
      (_name, engine) => {
        const check = engine().getValidator(schema);
        expect(check({ pair: ['a', 1] }).valid).toBe(true);
        // The copy of the pipeline writes a missing item as null.
        expect(check({ pair: ['a', null] }).valid).toBe(true);
      },
    );

    it.each(engines)(
      'refuses a tuple of another length under %s',
      (_name, engine) => {
        const check = engine().getValidator(schema);
        for (const pair of [[], ['a'], ['a', 1, 2]]) {
          expect(check({ pair }).valid).toBe(false);
        }
      },
    );

    it('checks the type of each item under 2020-12 only', () => {
      // The price of serving draft-07: there a tuple is a check of its
      // length alone.
      const swapped = { pair: [1, 'a'] };
      expect(
        new AjvJsonSchemaValidator().getValidator(schema)(swapped).valid,
      ).toBe(false);
      expect(draft07().getValidator(schema)(swapped).valid).toBe(true);
    });
  });
});
