import { describe, expect, it } from 'vitest';

import { readTriggers, triggerTimeRange } from './triggers.js';

const at = (iso: string): number => Date.parse(iso);
const iso = (ms: number): string => new Date(ms).toISOString();

describe('readTriggers', () => {
  it('gives the last trigger at or before a time and the next after it', () => {
    const triggers = readTriggers('0 6 * * MON', 'Europe/Zurich');
    const monday = at('2026-11-09T05:00:00Z');
    expect(triggers.last(at('2026-11-11T12:00:00Z'))).toBe(monday);
    expect(triggers.last(monday)).toBe(monday);
    expect(triggers.last(monday + 999)).toBe(monday);
    expect(iso(triggers.last(monday - 1))).toBe('2026-11-02T05:00:00.000Z');
    expect(triggers.next(monday - 1)).toBe(monday);
    expect(iso(triggers.next(monday))).toBe('2026-11-16T05:00:00.000Z');
  });

  describe('at the change to summer time on 29.03.2026 in Europe/Zurich', () => {
    it('runs a fixed time in the gap at the end of the gap', () => {
      const triggers = readTriggers('30 2 * * *', 'Europe/Zurich');
      const end = at('2026-03-29T01:00:00Z');
      expect(triggers.next(at('2026-03-28T12:00:00Z'))).toBe(end);
      expect(triggers.last(end)).toBe(end);
      expect(iso(triggers.last(end - 1))).toBe('2026-03-28T01:30:00.000Z');
      expect(iso(triggers.next(end))).toBe('2026-03-30T00:30:00.000Z');
    });

    it('runs a time of a list in the gap at the end of the gap, where croner skips it', () => {
      const triggers = readTriggers('30 2,14 * * *', 'Europe/Zurich');
      const end = at('2026-03-29T01:00:00Z');
      expect(triggers.next(at('2026-03-28T13:30:00Z'))).toBe(end);
      expect(triggers.last(at('2026-03-29T05:00:00Z'))).toBe(end);
      expect(triggers.last(end)).toBe(end);
      expect(iso(triggers.last(end - 1))).toBe('2026-03-28T13:30:00.000Z');
      expect(iso(triggers.next(end))).toBe('2026-03-29T12:30:00.000Z');
      expect(iso(triggers.last(at('2026-03-29T12:30:00Z')))).toBe(
        '2026-03-29T12:30:00.000Z',
      );
    });

    it('runs an hourly schedule every hour the clock shows', () => {
      // 02:00 does not exist and falls together with 03:00.
      const triggers = readTriggers('0 * * * *', 'Europe/Zurich');
      const end = at('2026-03-29T01:00:00Z');
      expect(triggers.next(at('2026-03-29T00:00:00Z'))).toBe(end);
      expect(iso(triggers.next(end))).toBe('2026-03-29T02:00:00.000Z');
      expect(triggers.last(at('2026-03-29T01:30:00Z'))).toBe(end);
    });

    it('counts a time in the gap and a trigger at the end of the gap once', () => {
      // 02:00 does not exist and moves to 03:00, which the schedule names.
      const triggers = readTriggers('0 2,3 * * *', 'Europe/Zurich');
      const end = at('2026-03-29T01:00:00Z');
      expect(triggers.next(at('2026-03-29T00:00:00Z'))).toBe(end);
      expect(triggers.last(at('2026-03-29T01:30:00Z'))).toBe(end);
      expect(iso(triggers.next(end))).toBe('2026-03-30T00:00:00.000Z');
    });
  });

  describe('at the change back to winter time on 25.10.2026 in Europe/Zurich', () => {
    it('runs a fixed time that the clock shows twice once, the first time', () => {
      const triggers = readTriggers('30 2 * * *', 'Europe/Zurich');
      const first = at('2026-10-25T00:30:00Z');
      expect(triggers.next(at('2026-10-24T12:00:00Z'))).toBe(first);
      expect(triggers.last(at('2026-10-25T01:45:00Z'))).toBe(first);
      expect(iso(triggers.next(first))).toBe('2026-10-26T01:30:00.000Z');
    });

    it('runs a time of a list that the clock shows twice once, where croner runs it twice', () => {
      const triggers = readTriggers('30 2,14 * * *', 'Europe/Zurich');
      const first = at('2026-10-25T00:30:00Z');
      expect(triggers.next(at('2026-10-24T12:30:00Z'))).toBe(first);
      expect(iso(triggers.next(first))).toBe('2026-10-25T13:30:00.000Z');
      // croner names 01:30 UTC, the second 02:30; it is no trigger.
      expect(triggers.last(at('2026-10-25T01:30:00Z'))).toBe(first);
      expect(triggers.last(at('2026-10-25T01:45:00Z'))).toBe(first);
      expect(iso(triggers.last(at('2026-10-25T13:30:00Z')))).toBe(
        '2026-10-25T13:30:00.000Z',
      );
    });

    it('drops every repeated hour of a schedule that runs hourly', () => {
      const triggers = readTriggers('0 * * * *', 'Europe/Zurich');
      // 02:00 summer time, 02:00 winter time, 03:00 winter time.
      expect(iso(triggers.next(at('2026-10-24T23:30:00Z')))).toBe(
        '2026-10-25T00:00:00.000Z',
      );
      expect(iso(triggers.next(at('2026-10-25T00:00:00Z')))).toBe(
        '2026-10-25T02:00:00.000Z',
      );
      expect(iso(triggers.last(at('2026-10-25T01:59:00Z')))).toBe(
        '2026-10-25T00:00:00.000Z',
      );
    });

    it('does not count a time the clock showed before, from the second pass on', () => {
      // At 02:10 winter time, 02:40 has passed once already.
      const triggers = readTriggers('40 2 * * *', 'Europe/Zurich');
      expect(iso(triggers.next(at('2026-10-25T01:10:00Z')))).toBe(
        '2026-10-26T01:40:00.000Z',
      );
    });
  });

  it('keeps the rule on the southern half of the earth', () => {
    // Sydney moves to summer time on 04.10.2026 at 02:00, to 03:00.
    const triggers = readTriggers('30 2,14 * * *', 'Australia/Sydney');
    expect(iso(triggers.next(at('2026-10-03T05:00:00Z')))).toBe(
      '2026-10-03T16:00:00.000Z',
    );
    // And back on 05.04.2026 at 03:00, to 02:00: 02:30 runs once.
    expect(iso(triggers.next(at('2026-04-04T04:00:00Z')))).toBe(
      '2026-04-04T15:30:00.000Z',
    );
    expect(iso(triggers.next(at('2026-04-04T15:30:00Z')))).toBe(
      '2026-04-05T04:30:00.000Z',
    );
  });

  describe('at a change to summer time across midnight in America/Nuuk', () => {
    // On 28.03.2026 the clock jumps from 22:59 at -02 to 00:00 at -01,
    // at 01:00 UTC; croner skips even a fixed time in that gap.
    const end = at('2026-03-29T01:00:00Z');

    it('runs a fixed time in the gap at the end of the gap', () => {
      const triggers = readTriggers('30 23 * * *', 'America/Nuuk');
      expect(triggers.next(at('2026-03-28T12:00:00Z'))).toBe(end);
      expect(triggers.last(at('2026-03-29T03:00:00Z'))).toBe(end);
      expect(iso(triggers.next(end))).toBe('2026-03-30T00:30:00.000Z');
    });

    it('runs a time of one day of the week in the gap on that day, not a week later', () => {
      const triggers = readTriggers('30 23 * * SAT', 'America/Nuuk');
      expect(triggers.next(at('2026-03-28T12:00:00Z'))).toBe(end);
    });

    it('keeps the last hour of a range and of an hourly schedule', () => {
      const range = readTriggers('0 22-23 * * *', 'America/Nuuk');
      expect(iso(range.next(at('2026-03-29T00:00:00Z')))).toBe(
        '2026-03-29T01:00:00.000Z',
      );
      const hourly = readTriggers('30 * * * *', 'America/Nuuk');
      expect(iso(hourly.next(at('2026-03-29T00:30:00Z')))).toBe(
        '2026-03-29T01:00:00.000Z',
      );
      expect(iso(hourly.next(end))).toBe('2026-03-29T01:30:00.000Z');
    });

    it('runs a time the change back repeats once, the first time', () => {
      // On 25.10.2026 the clock goes back from 00:00 at -01 to 23:00 at
      // -02, at 01:00 UTC.
      const triggers = readTriggers('30 22,23 * * *', 'America/Nuuk');
      expect(iso(triggers.next(at('2026-10-24T23:30:00Z')))).toBe(
        '2026-10-25T00:30:00.000Z',
      );
      expect(iso(triggers.next(at('2026-10-25T00:30:00Z')))).toBe(
        '2026-10-26T00:30:00.000Z',
      );
    });
  });

  it('runs the times of a day that a zone skipped whole at the end of the gap', () => {
    // Samoa skipped 30.12.2011 to change sides of the date line: after
    // 29.12. at 23:59 came 31.12. at 00:00, at 10:00 UTC.
    const triggers = readTriggers('0 10,22 * * *', 'Pacific/Apia');
    expect(iso(triggers.last(at('2011-12-30T15:00:00Z')))).toBe(
      '2011-12-30T10:00:00.000Z',
    );
    expect(iso(triggers.next(at('2011-12-30T10:00:00Z')))).toBe(
      '2011-12-30T20:00:00.000Z',
    );
  });

  it('refuses a schedule that is not allowed and a zone the configuration does not take', () => {
    for (const schedule of ['*/15 * * * *', '0 6 31 2 *', '0 6 1 * MON', '']) {
      expect(() => readTriggers(schedule, 'UTC')).toThrow(TypeError);
    }
    expect(() => readTriggers('0 6 * * MON', 'CET')).toThrow(TypeError);
  });

  it('takes times from 2000 to 2099 only', () => {
    const triggers = readTriggers('0 6 * * MON', 'UTC');
    for (const time of [
      triggerTimeRange.from - 1,
      triggerTimeRange.to,
      Number.NaN,
      1.5 + triggerTimeRange.from,
    ]) {
      expect(() => triggers.last(time)).toThrow(TypeError);
      expect(() => triggers.next(time)).toThrow(TypeError);
    }
    expect(iso(triggers.last(triggerTimeRange.from))).toBe(
      '1999-12-27T06:00:00.000Z',
    );
    expect(iso(triggers.next(triggerTimeRange.to - 1))).toBe(
      '2100-01-04T06:00:00.000Z',
    );
  });

  it('returns a frozen reader', () => {
    expect(Object.isFrozen(readTriggers('0 6 * * MON', 'UTC'))).toBe(true);
  });
});
