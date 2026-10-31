import { describe, expect, it } from 'vitest';

import {
  dayOfAuditFile,
  dayOfTime,
  isPastRetention,
  lastDayKept,
} from './retention.js';

describe('dayOfAuditFile', () => {
  it('reads the UTC day of a name the writer makes', () => {
    expect(dayOfAuditFile('audit-2026-10-31-055230-4242-1.jsonl')).toBe(
      '2026-10-31',
    );
    expect(
      dayOfAuditFile(
        `audit-2028-02-29-235959-${'9'.repeat(16)}-${'9'.repeat(16)}.jsonl`,
      ),
    ).toBe('2028-02-29');
  });

  it.each([
    ['another name', 'notes.jsonl'],
    ['a path', 'audit/audit-2026-10-31-055230-4242-1.jsonl'],
    ['another ending', 'audit-2026-10-31-055230-4242-1.json'],
    ['a copy', 'audit-2026-10-31-055230-4242-1.jsonl.bak'],
    ['a hidden copy', '.audit-2026-10-31-055230-4242-1.jsonl'],
    ['capitals', 'AUDIT-2026-10-31-055230-4242-1.jsonl'],
    ['a process ID of 0', 'audit-2026-10-31-055230-0-1.jsonl'],
    ['a leading zero', 'audit-2026-10-31-055230-04242-1.jsonl'],
    ['a number of 0', 'audit-2026-10-31-055230-4242-0.jsonl'],
    ['a short time', 'audit-2026-10-31-0552-4242-1.jsonl'],
    ['a month 13', 'audit-2026-13-01-055230-4242-1.jsonl'],
    ['a month 0', 'audit-2026-00-01-055230-4242-1.jsonl'],
    ['a day 0', 'audit-2026-10-00-055230-4242-1.jsonl'],
    ['the 31st of November', 'audit-2026-11-31-055230-4242-1.jsonl'],
    ['the 29th of February 2026', 'audit-2026-02-29-055230-4242-1.jsonl'],
    ['an hour 24', 'audit-2026-10-31-245230-4242-1.jsonl'],
    ['a minute 60', 'audit-2026-10-31-056030-4242-1.jsonl'],
    ['a second 60', 'audit-2026-10-31-055260-4242-1.jsonl'],
    ['a digit of another script', 'audit-2026-10-31-05523٠-4242-1.jsonl'],
  ])('refuses %s', (_name, name) => {
    expect(dayOfAuditFile(name)).toBeUndefined();
  });
});

describe('dayOfTime', () => {
  it('gives the UTC day of a time', () => {
    expect(dayOfTime(Date.UTC(2026, 9, 31, 23, 59, 59, 999))).toBe(
      '2026-10-31',
    );
    expect(dayOfTime(Date.UTC(2026, 10, 1))).toBe('2026-11-01');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 8.65e15])(
    'gives no day for %s',
    (time) => {
      expect(dayOfTime(time)).toBeUndefined();
    },
  );
});

describe('lastDayKept', () => {
  it.each([
    ['2026-10-31', 12, '2027-10-31'],
    ['2028-02-29', 12, '2029-02-28'],
    ['2026-01-31', 1, '2026-02-28'],
    ['2028-01-31', 1, '2028-02-29'],
    ['2026-03-31', 1, '2026-04-30'],
    ['2026-12-15', 1, '2027-01-15'],
    ['2026-11-30', 3, '2027-02-28'],
    ['2026-10-31', 120, '2036-10-31'],
    ['2026-06-30', 6, '2026-12-30'],
    ['9995-01-01', 120, '9999-12-31'],
  ])(
    'keeps a file of %s with %i months until the end of %s',
    (day, months, last) => {
      expect(lastDayKept(day, months)).toBe(last);
    },
  );
});

describe('isPastRetention', () => {
  it('lets a file go only on the day after its last day', () => {
    expect(isPastRetention('2026-10-31', 12, '2027-10-31')).toBe(false);
    expect(isPastRetention('2026-10-31', 12, '2027-11-01')).toBe(true);
    expect(isPastRetention('2028-02-29', 12, '2029-02-28')).toBe(false);
    expect(isPastRetention('2028-02-29', 12, '2029-03-01')).toBe(true);
  });

  it('never lets a file of today or of a later day go', () => {
    expect(isPastRetention('2026-10-31', 1, '2026-10-31')).toBe(false);
    expect(isPastRetention('2027-01-01', 1, '2026-10-31')).toBe(false);
  });
});
