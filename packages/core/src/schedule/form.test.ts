import { describe, expect, it } from 'vitest';

import { checkSchedule } from './form.js';

describe('checkSchedule', () => {
  it.each([
    '0 6 * * MON',
    '0 6 * * mon',
    '0 6 * * 1',
    '30 5 1 * *',
    '0 7 1 JAN,JUL *',
    '0 */2 * * *',
    '0 8-18/2 * * MON-FRI',
    '0 6,18 * * SUN,SAT',
    '59 23 31 DEC *',
    '0 0 * * 0-6',
    '05 06 * * *',
    '0 6 1-7 * *',
  ])('takes %s', (schedule) => {
    expect(checkSchedule(schedule)).toEqual({ ok: true });
  });

  it.each([
    ['', undefined],
    ['0 6 * *', undefined],
    ['0 0 6 * * MON', undefined],
    ['0 6 * * MON 2026', undefined],
    ['0  6 * * MON', undefined],
    [' 0 6 * * MON', undefined],
    ['0\t6 * * MON *', 'minute'],
    ['60 6 * * *', 'minute'],
    ['0 24 * * *', 'hour'],
    ['0 6 0 * *', 'dayOfMonth'],
    ['0 6 32 * *', 'dayOfMonth'],
    ['0 6 * 13 *', 'month'],
    ['0 6 * * 7', 'dayOfWeek'],
    ['0 6 * * MON-SUN', 'dayOfWeek'],
    ['0 6 * * FRI-MON', 'dayOfWeek'],
    ['0 6 * * MONDAY', 'dayOfWeek'],
    ['0 6 * JANUARY *', 'month'],
    ['MON 6 * * *', 'minute'],
    ['5/15 * * * *', 'minute'],
    ['*/0 * * * *', 'minute'],
    ['*/61 * * * *', 'minute'],
    ['0 6 L * *', 'dayOfMonth'],
    ['0 6 * * 5L', 'dayOfWeek'],
    ['0 6 * * MON#2', 'dayOfWeek'],
    ['0 6 15W * *', 'dayOfMonth'],
    ['0 6 ? * MON', 'dayOfMonth'],
    ['0 6 1--3 * *', 'dayOfMonth'],
    ['0 6 1-3-5 * *', 'dayOfMonth'],
    ['0 6 */2/3 * *', 'dayOfMonth'],
    ['0 6 1, * *', 'dayOfMonth'],
    ['0 6 +1 * *', 'dayOfMonth'],
    ['0 6 100 * *', 'dayOfMonth'],
    [`${Array.from({ length: 61 }, () => '1').join(',')} * * * *`, 'minute'],
  ])('refuses %j in the field %s', (schedule, field) => {
    expect(checkSchedule(schedule)).toEqual(
      field === undefined
        ? { ok: false, reason: 'invalid' }
        : { ok: false, reason: 'invalid', field },
    );
  });

  it.each(['0 6 1 * MON', '0 6 */2 * 1', '0 6 1-7 * 1-5'])(
    'refuses %s, which restricts both days',
    (schedule) => {
      expect(checkSchedule(schedule)).toEqual({ ok: false, reason: 'days' });
    },
  );

  it.each([
    '* * * * *',
    '*/15 * * * *',
    '0,30 6 * * *',
    '0-5 6 * * *',
    '0-59/30 6 * * MON',
  ])('refuses %s, which may fire more than once an hour', (schedule) => {
    expect(checkSchedule(schedule)).toEqual({ ok: false, reason: 'frequent' });
  });

  it.each(['0 6 31 2 *', '0 6 30 2 *', '0 6 31 4,6,9,11 *', '0 6 30-31 FEB *'])(
    'refuses %s, which never fires',
    (schedule) => {
      expect(checkSchedule(schedule)).toEqual({ ok: false, reason: 'never' });
    },
  );

  it.each(['0 6 29 2 *', '0 6 31 2,3 *', '0 6 31 * *'])(
    'takes %s, which fires on some days only',
    (schedule) => {
      expect(checkSchedule(schedule)).toEqual({ ok: true });
    },
  );

  it('checks the form before the days, the minute and whether it fires', () => {
    expect(checkSchedule('* 6 31 2 MON')).toEqual({
      ok: false,
      reason: 'days',
    });
    expect(checkSchedule('* 6 31 2 *')).toEqual({
      ok: false,
      reason: 'frequent',
    });
    expect(checkSchedule('* 6 31 2 7')).toEqual({
      ok: false,
      reason: 'invalid',
      field: 'dayOfWeek',
    });
  });

  it('returns frozen results', () => {
    expect(Object.isFrozen(checkSchedule('0 6 * * MON'))).toBe(true);
    expect(Object.isFrozen(checkSchedule('0 6 1 * MON'))).toBe(true);
  });

  it('refuses a schedule that is not a string', () => {
    expect(() => checkSchedule(6 as unknown as string)).toThrow(TypeError);
  });
});
