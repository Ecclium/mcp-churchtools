import { describe, expect, it } from 'vitest';

import {
  modelRedactionLevels,
  policyJsonSchema,
  policyLimits,
  runnerOwnAlias,
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

  it('forbids the own account of the runner as the credential of an entry, and nowhere else', () => {
    const entry = (
      schema.properties?.unattended as {
        items: { properties: Record<string, Record<string, unknown>> };
      }
    ).items.properties;
    expect(entry.credential).toEqual({
      type: 'string',
      maxLength: 63,
      pattern: '^[a-z0-9][a-z0-9-]{0,62}$',
      not: { const: runnerOwnAlias },
    });
    expect(runnerOwnAlias).toBe('runner');
    expect(entry.routine).not.toHaveProperty('not');
    expect(JSON.stringify(schema).match(/"not":/gu)).toHaveLength(1);
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
