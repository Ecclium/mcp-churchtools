import { describe, expect, it } from 'vitest';

import {
  modelRedactionLevels,
  policyJsonSchema,
  policyLimits,
} from './schema.js';

interface JsonSchemaNode {
  readonly type?: string;
  readonly const?: unknown;
  readonly additionalProperties?: boolean;
  readonly required?: readonly string[];
  readonly properties?: Record<string, JsonSchemaNode>;
}

describe('policyJsonSchema', () => {
  const schema = policyJsonSchema() as JsonSchemaNode;

  it('describes a closed object with its version', () => {
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['schema']);
    expect(schema.properties?.schema).toMatchObject({ const: 'policy.v1' });
    expect(Object.keys(schema.properties ?? {})).toEqual([
      'schema',
      'interactive',
      'unattended',
    ]);
  });

  it('makes a new object on each call', () => {
    expect(policyJsonSchema()).not.toBe(policyJsonSchema());
    expect(policyJsonSchema()).toEqual(policyJsonSchema());
  });
});

describe('the limits of a policy', () => {
  it('are frozen and keep the read budget of 200 below its highest value', () => {
    expect(Object.isFrozen(policyLimits)).toBe(true);
    expect(Object.isFrozen(modelRedactionLevels)).toBe(true);
    expect(policyLimits.defaultReadBudgetPerDay).toBe(200);
    expect(policyLimits.readBudgetPerDay).toBe(1000);
    expect(modelRedactionLevels).toEqual(['strict', 'standard']);
  });
});
