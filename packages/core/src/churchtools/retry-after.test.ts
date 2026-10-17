import { makeCanary } from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it } from 'vitest';

import { retryAfterSeconds } from './retry-after.js';

describe('retryAfterSeconds', () => {
  it.each([
    ['120', 120],
    ['1', 1],
    ['3600', 3600],
    ['0120', 120],
  ])('reads %j as %i seconds', (value, seconds) => {
    expect(retryAfterSeconds(value)).toBe(seconds);
  });

  it.each([
    undefined,
    '',
    '0',
    '3601',
    '+5',
    '-5',
    '1e3',
    'abc',
    ' 12',
    '12 ',
    '1.5',
    '99999',
    'Wed, 21 Oct 2026 07:28:00 GMT',
    makeCanary('token').value,
  ])('gives no time for %j', (value) => {
    expect(retryAfterSeconds(value)).toBeUndefined();
  });
});
