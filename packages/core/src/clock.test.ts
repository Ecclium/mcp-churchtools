import { describe, expect, it } from 'vitest';

import { systemClock } from './clock.js';

describe('systemClock', () => {
  it('gives the time of the system in milliseconds', () => {
    const before = Date.now();
    const now = systemClock.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  // Every tenant context shares this clock, so a value hung on it or on its
  // method would pass from one call to the next.
  it('is frozen, method and all, and keeps no value hung on it', () => {
    const method: unknown = Object.getOwnPropertyDescriptor(
      systemClock,
      'now',
    )?.value;
    expect(Object.isFrozen(systemClock)).toBe(true);
    expect(Object.isFrozen(method)).toBe(true);
    expect(() => {
      (method as Record<string, unknown>)['stash'] = 'value';
    }).toThrow(TypeError);
    expect(() => {
      systemClock.now = () => 0;
    }).toThrow(TypeError);
    expect(systemClock.now()).toBeGreaterThan(0);
  });
});
