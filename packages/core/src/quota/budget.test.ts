import { describe, expect, it } from 'vitest';

import {
  isoDateOf,
  lockWaitMs,
  quotaTimeoutMs,
  specialReadBudget,
} from './index.js';

describe('the read budget', () => {
  it('allows 200 calls per day and waits longer for the store than for a lock', () => {
    expect(specialReadBudget).toBe(200);
    expect(quotaTimeoutMs).toBeGreaterThan(lockWaitMs);
  });

  it.each([
    [Date.UTC(2026, 9, 24, 0, 0, 0), '2026-10-24'],
    [Date.UTC(2026, 9, 24, 23, 59, 59, 999), '2026-10-24'],
    [Date.UTC(2026, 9, 25), '2026-10-25'],
    [0, '1970-01-01'],
  ])('gives the UTC day of %d', (ms, day) => {
    expect(isoDateOf(ms)).toBe(day);
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    8.64e15 + 1,
    '1' as never,
  ])('gives no day for %s', (ms) => {
    expect(isoDateOf(ms)).toBeUndefined();
  });
});
