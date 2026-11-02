import { describe, expect, it, vi } from 'vitest';

import { readPolicyYaml } from './yaml.js';

// A parser that throws, as it could for a text that exhausts the stack. In
// a file of its own, because the mock holds for the whole file.
vi.mock('yaml', async (original) => {
  const real: Record<string, unknown> = await original();
  return {
    ...real,
    parseDocument: (): never => {
      throw new RangeError('Maximum call stack size exceeded');
    },
  };
});

describe('readPolicyYaml with a parser that throws', () => {
  it('refuses the text as a syntax error without a line', () => {
    expect(readPolicyYaml('a: 1\n')).toEqual({
      ok: false,
      code: 'policy_yaml_syntax',
    });
  });
});
