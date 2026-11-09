import { describe, expect, it, vi } from 'vitest';

import { readConfigYaml } from './yaml.js';

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

describe('readConfigYaml with a parser that throws', () => {
  it('refuses the text as a syntax error without a line', () => {
    expect(readConfigYaml('a: 1\n')).toEqual({
      ok: false,
      code: 'yaml_syntax',
    });
  });
});
