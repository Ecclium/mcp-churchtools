import { describe, expect, it } from 'vitest';

import { createCron } from './cron.js';

const at = (iso: string): number => Date.parse(iso);
const iso = (ms: number | undefined): string | undefined =>
  ms === undefined ? undefined : new Date(ms).toISOString();

describe('createCron', () => {
  it('names the instants of a schedule in its time zone', () => {
    const cron = createCron('0 6 * * MON', 'Europe/Zurich');
    expect(iso(cron.next(at('2026-11-09T04:00:00Z')))).toBe(
      '2026-11-09T05:00:00.000Z',
    );
    expect(iso(cron.previous(at('2026-11-12T00:00:00Z')))).toBe(
      '2026-11-09T05:00:00.000Z',
    );
    // In summer, 06:00 in Zurich is 04:00 UTC.
    expect(iso(cron.next(at('2026-07-01T00:00:00Z')))).toBe(
      '2026-07-06T04:00:00.000Z',
    );
  });

  it('looks strictly after and strictly before a time', () => {
    const cron = createCron('0 6 * * MON', 'UTC');
    const trigger = at('2026-11-09T06:00:00Z');
    expect(iso(cron.next(trigger))).toBe('2026-11-16T06:00:00.000Z');
    expect(iso(cron.previous(trigger))).toBe('2026-11-02T06:00:00.000Z');
  });

  it('counts a trigger in the same second, before the time, as before it', () => {
    const cron = createCron('0 6 * * MON', 'UTC');
    const trigger = at('2026-11-09T06:00:00Z');
    expect(cron.previous(trigger + 1)).toBe(trigger);
    expect(cron.previous(trigger + 999)).toBe(trigger);
    expect(iso(cron.previous(trigger - 1))).toBe('2026-11-02T06:00:00.000Z');
    expect(cron.next(trigger - 1)).toBe(trigger);
    expect(iso(cron.next(trigger + 1))).toBe('2026-11-16T06:00:00.000Z');
  });

  it('names nothing for a schedule that never fires', () => {
    for (const schedule of ['0 0 31 2 *', '0 0 30 2 *', '0 0 31 4 *']) {
      const cron = createCron(schedule, 'UTC');
      expect(cron.next(0)).toBeUndefined();
      expect(cron.previous(at('2026-11-09T00:00:00Z'))).toBeUndefined();
    }
    // The 29th of February fires every leap year.
    expect(iso(createCron('0 0 29 2 *', 'UTC').next(0))).toBe(
      '1972-02-29T00:00:00.000Z',
    );
  });

  it('refuses what croner cannot read and forms beyond five fields', () => {
    for (const schedule of [
      '',
      '0 6 * *',
      '0 0 6 * * MON',
      '0 0 6 * * MON 2026',
      '5/15 * * * *',
      '0 0 0 0 0',
    ]) {
      expect(() => createCron(schedule, 'UTC')).toThrow(TypeError);
    }
  });

  it('takes only a zone the configuration takes', () => {
    for (const zone of [
      'Mars/Olympus',
      'europe/zurich',
      '+01:00',
      'CET',
      'Etc/GMT-1',
      '',
    ]) {
      expect(() => createCron('0 6 * * MON', zone)).toThrow(TypeError);
    }
  });

  it('reads the weekdays from 0 for Sunday, not as Quartz does', () => {
    const cron = createCron('0 6 * * 0', 'UTC');
    // 08.11.2026 is a Sunday.
    expect(iso(cron.next(at('2026-11-06T00:00:00Z')))).toBe(
      '2026-11-08T06:00:00.000Z',
    );
  });

  // The rules croner applies at a change of summer time, which the module
  // of the triggers evens out (ADR 0034). Should a later version of croner
  // change them, this test shows it first.
  describe('at a change of summer time in Europe/Zurich', () => {
    it('runs a fixed time in the gap at the end of the gap and a doubled one once', () => {
      const cron = createCron('30 2 * * *', 'Europe/Zurich');
      expect(iso(cron.next(at('2026-03-28T12:00:00Z')))).toBe(
        '2026-03-29T01:00:00.000Z',
      );
      expect(iso(cron.next(at('2026-10-24T12:00:00Z')))).toBe(
        '2026-10-25T00:30:00.000Z',
      );
      expect(iso(cron.next(at('2026-10-25T00:30:00Z')))).toBe(
        '2026-10-26T01:30:00.000Z',
      );
    });

    it('skips a time in the gap and runs a doubled time twice for other schedules', () => {
      const cron = createCron('30 2,14 * * *', 'Europe/Zurich');
      expect(iso(cron.next(at('2026-03-28T12:00:00Z')))).toBe(
        '2026-03-28T13:30:00.000Z',
      );
      expect(iso(cron.next(at('2026-03-28T13:30:00Z')))).toBe(
        '2026-03-29T12:30:00.000Z',
      );
      expect(iso(cron.next(at('2026-10-24T12:30:00Z')))).toBe(
        '2026-10-25T00:30:00.000Z',
      );
      expect(iso(cron.next(at('2026-10-25T00:30:00Z')))).toBe(
        '2026-10-25T01:30:00.000Z',
      );
    });
  });
});
