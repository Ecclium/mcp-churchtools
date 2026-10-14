import { describe, expect, it } from 'vitest';

import * as entry from './index.js';

// Shows that the tests of the package run from source (ADR 0022).
describe('@ecclium/mcp-churchtools-testkit', () => {
  it('loads its entry point', () => {
    expect(entry).toBeTypeOf('object');
  });
});
