import { describe, expect, it } from 'vitest';

import { spanTextOf, timeTextOf } from './calendar-time.js';

// The times of appointments and bookings as a person reads them before a
// write: in UTC unless the operator names a zone (ADR 0072).
describe('the times of a confirmation', () => {
  it('shows a span of one day in UTC', () => {
    expect(
      spanTextOf('2026-11-08T09:00:00Z', '2026-11-08T10:30:00Z', undefined),
    ).toBe('Sonntag, 08.11.2026, 09:00 bis 10:30 (UTC)');
  });

  it('shows the whole end of a span over two days', () => {
    expect(
      spanTextOf('2026-11-07T22:00:00Z', '2026-11-08T01:00:00Z', undefined),
    ).toBe('Samstag, 07.11.2026, 22:00 bis Sonntag, 08.11.2026, 01:00 (UTC)');
  });

  // Winter and summer time of the zone; the day may change with it.
  it('shows a span in the zone the operator names', () => {
    expect(
      spanTextOf(
        '2026-11-07T23:30:00Z',
        '2026-11-08T00:30:00Z',
        'Europe/Zurich',
      ),
    ).toBe('Sonntag, 08.11.2026, 00:30 bis 01:30 (Europe/Zurich)');
    expect(timeTextOf('2026-07-05T08:00:00Z', 'Europe/Zurich')).toBe(
      'Sonntag, 05.07.2026, 10:00 (Europe/Zurich)',
    );
  });

  it('shows one time with its zone', () => {
    expect(timeTextOf('2026-12-31T23:59:00Z', undefined)).toBe(
      'Donnerstag, 31.12.2026, 23:59 (UTC)',
    );
  });
});
