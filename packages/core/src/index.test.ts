import * as testkit from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it } from 'vitest';

import * as entry from './index.js';

// The tests run from source and reach the testkit through its package name
// (ADR 0022).
describe('@ecclium/mcp-churchtools-core', () => {
  it('loads its entry point and the testkit', () => {
    expect(entry).toBeTypeOf('object');
    expect(testkit).toBeTypeOf('object');
  });

  it('passes on the loader of the configuration and its tables', () => {
    expect(entry.loadConfig).toBeTypeOf('function');
    expect(entry.variableNames).toContain('ECCLIUM_CHURCHTOOLS_URL');
    expect(entry.configProblemCodes).toContain('token_missing');
  });

  // A zod schema can be widened after it is made, and a pattern recompiled
  // in place, so neither leaves the core; nor does the reader of the token
  // file, whose file functions are only for tests (ADR 0055).
  it('passes on no schema, no pattern and not the reader of the token file', () => {
    for (const [name, value] of Object.entries(entry) as [string, unknown][]) {
      expect(value, name).not.toBeInstanceOf(RegExp);
      expect(
        typeof value === 'object' && value !== null && 'safeParse' in value,
        name,
      ).toBe(false);
    }
    expect(Object.keys(entry)).not.toContain('readTokenFile');
    expect(Object.keys(entry)).not.toContain('fitsVariable');
    expect(Object.keys(entry)).not.toContain('environmentSchema');
  });

  // Only the core makes a tenant, through the resolver and the factory of
  // the context (ADR 0003).
  it('passes on the identity over stdio but no way to make a tenant', () => {
    expect(entry.createStdioIdentity).toBeTypeOf('function');
    expect(entry.createStdioTenantResolver).toBeTypeOf('function');
    expect(Object.keys(entry)).not.toContain('toTenantId');
    expect(Object.keys(entry)).not.toContain('defaultTenantId');
    expect(Object.keys(entry)).not.toContain('createTenantContext');
  });
});
