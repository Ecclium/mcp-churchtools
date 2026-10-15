import { describe, expect, it } from 'vitest';

import { auditPlaceholders } from '../audit/index.js';
import { isTenantId } from '../logger/index.js';
import { defaultTenantId, toTenantId } from './tenant-id.js';

describe('toTenantId', () => {
  it.each([defaultTenantId, 'demo-tenant'])('takes %j', (value) => {
    expect(toTenantId(value)).toBe(value);
  });

  // The placeholder fits the pattern, so only this check refuses it.
  it('refuses the placeholder of the audit, which fits the pattern', () => {
    expect(isTenantId(auditPlaceholders.tenantId)).toBe(true);
    expect(toTenantId(auditPlaceholders.tenantId)).toBeUndefined();
  });

  it.each([
    'Default',
    ' default',
    'default\n',
    'a'.repeat(64),
    '',
    new String('default'),
    42,
    undefined,
  ])('refuses %j', (value) => {
    expect(toTenantId(value)).toBeUndefined();
  });
});
