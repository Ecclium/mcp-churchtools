import { describe, expect, it } from 'vitest';

import { mostTriggersPerUtcDay, triggersPerDaySpanDays } from './per-day.js';

const at = (iso: string): number => Date.parse(iso);

describe('mostTriggersPerUtcDay', () => {
  it('counts one trigger a week as one a day', () => {
    expect(
      mostTriggersPerUtcDay(
        '0 6 * * MON',
        'Europe/Zurich',
        at('2026-11-12T00:00:00Z'),
      ),
    ).toBe(1);
  });

  it('counts every time a day of a list', () => {
    expect(
      mostTriggersPerUtcDay('0 6,18 * * *', 'UTC', at('2026-11-12T00:00:00Z')),
    ).toBe(2);
  });

  it('counts the time the change to summer time skips on its UTC day', () => {
    // On 29.03.2026, 02:30 runs at 03:00 in Zurich, and the UTC day holds
    // 01:30, 03:00 and 03:30 of the clock and 00:30 and 01:30 of the next
    // day: five, where every other day holds four.
    const from = at('2026-03-01T00:00:00Z');
    expect(mostTriggersPerUtcDay('30 0-3 * * *', 'Europe/Zurich', from)).toBe(
      5,
    );
    expect(mostTriggersPerUtcDay('30 0-3 * * *', 'UTC', from)).toBe(4);
  });

  it('counts by the UTC day, not by the day on the clock of the zone', () => {
    // 23:00 and 00:00 in Zurich in winter are 22:00 and 23:00 UTC of the
    // same UTC day, which a day of the zone splits.
    expect(
      mostTriggersPerUtcDay(
        '0 0,23 * * *',
        'Europe/Zurich',
        at('2026-11-12T00:00:00Z'),
      ),
    ).toBe(2);
    expect(
      mostTriggersPerUtcDay(
        '0 0,23 * * MON',
        'Europe/Zurich',
        at('2026-11-12T00:00:00Z'),
      ),
    ).toBe(1);
  });

  it('starts at the first trigger, also years ahead', () => {
    expect(
      mostTriggersPerUtcDay('0 6 29 2 *', 'UTC', at('2026-11-12T00:00:00Z')),
    ).toBe(1);
    expect(triggersPerDaySpanDays).toBe(373);
  });

  it('counts the day of the first trigger whole', () => {
    // Started at noon on 1 March: the morning of that day counts, and the
    // next 1 March lies more than a year later in a leap year.
    expect(
      mostTriggersPerUtcDay(
        '0 0-23/2 1 3 *',
        'UTC',
        at('2027-03-01T11:30:00Z'),
      ),
    ).toBe(12);
  });

  it('sees the change to summer time a year and a week ahead', () => {
    // 25.03.2029 and 31.03.2030 lie 371 days apart. Started on the day of
    // the change after its gap, and on the day after it.
    for (const from of ['2029-03-25T00:45:00Z', '2029-03-26T00:00:00Z']) {
      expect(
        mostTriggersPerUtcDay('30 0-3 * * *', 'Europe/Zurich', at(from)),
      ).toBe(5);
    }
  });

  it('counts nothing from 2100 on', () => {
    expect(
      mostTriggersPerUtcDay('0 6 * * MON', 'UTC', at('2099-12-31T12:00:00Z')),
    ).toBe(0);
  });

  it('refuses a schedule, a zone or a time the core does not take', () => {
    const from = at('2026-11-12T00:00:00Z');
    expect(() => mostTriggersPerUtcDay('* * * * *', 'UTC', from)).toThrow(
      TypeError,
    );
    expect(() => mostTriggersPerUtcDay('0 6 * * *', 'CET', from)).toThrow(
      TypeError,
    );
    expect(() =>
      mostTriggersPerUtcDay('0 6 * * *', 'UTC', at('1999-12-31T00:00:00Z')),
    ).toThrow(TypeError);
  });
});
