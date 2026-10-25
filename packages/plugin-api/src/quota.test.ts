import { describe, expect, it } from 'vitest';

import { isIsoDate, quotaKeys } from './index.js';

describe('the port for quotas', () => {
  it('counts one key today, frozen', () => {
    expect(quotaKeys).toEqual(['special_reads']);
    expect(Object.isFrozen(quotaKeys)).toBe(true);
  });

  it.each(['2026-10-24', '1970-01-01', '2028-02-29', '9999-12-31'])(
    'takes the day %s',
    (value) => {
      expect(isIsoDate(value)).toBe(true);
    },
  );

  it.each([
    '2026-02-30',
    '2027-02-29',
    '2026-13-01',
    '2026-00-10',
    '2026-10-00',
    '1969-12-31',
    '2026-1-24',
    '2026-10-24T00:00:00Z',
    ' 2026-10-24',
    '2026-10-24\n',
    '../2026-10-24',
    '２０２６-10-24',
    '',
    20261024,
    null,
    undefined,
  ])('refuses %j as a day', (value) => {
    expect(isIsoDate(value)).toBe(false);
  });
});
