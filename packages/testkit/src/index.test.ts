import { describe, expect, it } from 'vitest';

import * as entry from './index.js';

// Placeholder until the package has code: shows that its tests run from
// source (ADR 0022).
describe('@ecclium/mcp-churchtools-testkit', () => {
  it('loads its entry point', () => {
    expect(entry).toBeTypeOf('object');
  });
});
