import * as testkit from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it } from 'vitest';

import * as entry from './index.js';

// The entry of the product package exports only the descriptions of the
// variables, for the generated reference. Its tests run from source and
// reach the testkit through its package name (ADR 0022).
describe('@ecclium/mcp-churchtools', () => {
  it('loads its entry point and the testkit', () => {
    expect(entry).toBeTypeOf('object');
    expect(testkit).toBeTypeOf('object');
  });

  it('exports nothing but the descriptions of the variables', () => {
    expect(Object.keys(entry)).toEqual(['variableDescriptions']);
  });
});
