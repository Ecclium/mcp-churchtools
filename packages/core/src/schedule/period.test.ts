import { describe, expect, it } from 'vitest';

import { periodOf } from './period.js';

const at = (iso: string): number => Date.parse(iso);

describe('periodOf', () => {
  it('gives week, day and month of a trigger on the clock of the zone', () => {
    expect(periodOf(at('2026-11-09T05:00:00Z'), 'Europe/Zurich')).toEqual({
      isoWeek: '2026-W46',
      date: '2026-11-09',
      month: '2026-11',
    });
  });

  it('takes the date of the zone, not of UTC', () => {
    // 00:30 on Monday in Zurich is still Sunday in UTC.
    const trigger = at('2026-11-08T23:30:00Z');
    expect(periodOf(trigger, 'Europe/Zurich')).toEqual({
      isoWeek: '2026-W46',
      date: '2026-11-09',
      month: '2026-11',
    });
    expect(periodOf(trigger, 'UTC')).toEqual({
      isoWeek: '2026-W45',
      date: '2026-11-08',
      month: '2026-11',
    });
    // A new month as well.
    expect(periodOf(at('2026-10-31T23:30:00Z'), 'Europe/Zurich')).toEqual({
      isoWeek: '2026-W44',
      date: '2026-11-01',
      month: '2026-11',
    });
  });

  it.each([
    // 2026 begins on a Thursday and has 53 weeks.
    ['2025-12-29T12:00:00Z', '2026-W01', '2025-12-29', '2025-12'],
    ['2026-01-01T12:00:00Z', '2026-W01', '2026-01-01', '2026-01'],
    ['2026-12-31T12:00:00Z', '2026-W53', '2026-12-31', '2026-12'],
    ['2027-01-01T12:00:00Z', '2026-W53', '2027-01-01', '2027-01'],
    ['2027-01-03T12:00:00Z', '2026-W53', '2027-01-03', '2027-01'],
    ['2027-01-04T12:00:00Z', '2027-W01', '2027-01-04', '2027-01'],
    // 2021 begins on a Friday, its first days belong to the last week of
    // 2020, which has 53 weeks.
    ['2021-01-01T12:00:00Z', '2020-W53', '2021-01-01', '2021-01'],
    ['2021-01-04T12:00:00Z', '2021-W01', '2021-01-04', '2021-01'],
    // 2024 is a leap year beginning on a Monday.
    ['2024-01-01T12:00:00Z', '2024-W01', '2024-01-01', '2024-01'],
    ['2024-12-30T12:00:00Z', '2025-W01', '2024-12-30', '2024-12'],
  ])('gives %s the week %s', (time, isoWeek, date, month) => {
    expect(periodOf(at(time), 'UTC')).toEqual({ isoWeek, date, month });
  });

  it('takes the date after a change of summer time', () => {
    // The end of the gap on 29.03.2026, 03:00 in Zurich.
    expect(periodOf(at('2026-03-29T01:00:00Z'), 'Europe/Zurich')).toEqual({
      isoWeek: '2026-W13',
      date: '2026-03-29',
      month: '2026-03',
    });
    // The second 02:30 on 25.10.2026 in Zurich.
    expect(periodOf(at('2026-10-25T01:30:00Z'), 'Europe/Zurich')).toEqual({
      isoWeek: '2026-W43',
      date: '2026-10-25',
      month: '2026-10',
    });
  });

  it('returns a frozen result', () => {
    expect(Object.isFrozen(periodOf(0, 'UTC'))).toBe(true);
  });

  it('refuses a zone the configuration does not take and a time that is none', () => {
    for (const zone of ['CET', '+01:00', 'europe/zurich', 'Mars/Olympus']) {
      expect(() => periodOf(0, zone)).toThrow(TypeError);
    }
    for (const time of [
      Number.NaN,
      -1,
      1.5,
      Date.UTC(9999, 11, 31),
      Number.MAX_SAFE_INTEGER,
    ]) {
      expect(() => periodOf(time, 'UTC')).toThrow(TypeError);
    }
    expect(periodOf(Date.UTC(9999, 11, 30), 'UTC').date).toBe('9999-12-30');
  });
});
