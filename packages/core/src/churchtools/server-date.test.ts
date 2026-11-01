import { describe, expect, it } from 'vitest';

import { serverTimeOf } from './server-date.js';

// The time of ChurchTools that a plan compares with the own clock
// (ADR 0029, ADR 0072). Only the form RFC 9110 asks a server to send
// counts; each other form is refused, though Date.parse reads most of them.

describe('serverTimeOf', () => {
  it.each([
    ['Sun, 01 Nov 2026 20:00:00 GMT', Date.UTC(2026, 10, 1, 20, 0, 0)],
    ['Thu, 01 Jan 1970 00:00:00 GMT', 0],
    ['Fri, 31 Dec 9999 23:59:59 GMT', Date.UTC(9999, 11, 31, 23, 59, 59)],
    ['Tue, 29 Feb 2028 12:34:56 GMT', Date.UTC(2028, 1, 29, 12, 34, 56)],
  ])('reads %s', (value, time) => {
    expect(serverTimeOf(value)).toBe(time);
  });

  // Each of these gives a finite number with Date.parse, so the check
  // against the exact form is what refuses it.
  it.each([
    'Mon, 01 Nov 2026 20:00:00 GMT',
    'Sun, 31 Feb 2026 20:00:00 GMT',
    'Sunday, 01-Nov-26 20:00:00 GMT',
    'Sun, 01 Nov 2026 20:00:00 UTC',
    'Sun, 01 Nov 2026 20:00:00 +0000',
    'sun, 01 Nov 2026 20:00:00 GMT',
    'Sun, 1 Nov 2026 20:00:00 GMT',
    'Sun, 01 Nov 2026 20:00:60 GMT',
    'Sun, 01 Nov 2026 24:00:00 GMT',
    ' Sun, 01 Nov 2026 20:00:00 GMT',
    'Sat, 01 Jan 0000 00:00:00 GMT',
    '2026-11-01T20:00:00Z',
  ])('refuses %s, which Date.parse would read', (value) => {
    expect(Number.isFinite(Date.parse(value))).toBe(true);
    expect(serverTimeOf(value)).toBeNull();
  });

  it.each([undefined, '', 'gestern', 'Sun, 01 Nov 2026'])(
    'gives null for %j',
    (value) => {
      expect(serverTimeOf(value)).toBeNull();
    },
  );
});
