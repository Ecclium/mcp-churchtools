import * as testkit from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it } from 'vitest';

import * as entry from './index.js';

// Shows that the tests of the package run from source and reach the testkit
// through its package name (ADR 0022).
describe('@ecclium/mcp-churchtools-plugin-api', () => {
  it('loads its entry point and the testkit', () => {
    expect(entry).toBeTypeOf('object');
    expect(testkit).toBeTypeOf('object');
  });
});
