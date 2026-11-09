import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import {
  isModelOutputName,
  modelLimits,
  type ModelOutputSpec,
  type StandardSchemaV1,
} from './index.js';

describe('the port to a language model', () => {
  it('has frozen limits that fit a routine', () => {
    expect(Object.isFrozen(modelLimits)).toBe(true);
    expect(modelLimits.maxOutputTokens).toBe(8000);
    expect(modelLimits.parts).toBe(11);
  });

  it.each(['a', 'dienstplan_report', `a${'b'.repeat(63)}`])(
    'takes %s as the name of an output',
    (name) => {
      expect(isModelOutputName(name)).toBe(true);
    },
  );

  it.each([
    '',
    'Dienstplan',
    '1report',
    '_report',
    'report-1',
    'report.1',
    `a${'b'.repeat(64)}`,
    'report\n',
    42,
    undefined,
  ])('refuses %j as the name of an output', (name) => {
    expect(isModelOutputName(name)).toBe(false);
  });

  it('takes a schema of zod as the check of an answer', async () => {
    const schema = z.strictObject({ text: z.string().max(10) });
    const check: StandardSchemaV1<unknown, { text: string }> = schema;
    const output: ModelOutputSpec<{ text: string }> = {
      name: 'answer',
      jsonSchema: z.toJSONSchema(schema),
      validate: schema,
    };
    expectTypeOf(output.validate).toEqualTypeOf<
      StandardSchemaV1<unknown, { text: string }>
    >();
    expect(check['~standard'].version).toBe(1);
    expect(check['~standard'].vendor).toBe('zod');
    await expect(
      Promise.resolve(check['~standard'].validate({ text: 'ok' })),
    ).resolves.toEqual({ value: { text: 'ok' } });
    const refused = await Promise.resolve(
      check['~standard'].validate({ text: 'far too long a text' }),
    );
    expect(refused.issues?.length).toBe(1);
  });
});
