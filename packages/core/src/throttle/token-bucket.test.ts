import { describe, expect, it } from 'vitest';

import { createRequestThrottle } from './token-bucket.js';

// A clock the test moves by hand.
const handClock = (start = 0) => {
  let now = start;
  let next: (() => number) | undefined;
  return {
    clock: Object.freeze({
      now: (): number => (next === undefined ? now : next()),
    }),
    set: (value: number): void => {
      now = value;
      next = undefined;
    },
    once: (value: () => number): void => {
      next = () => {
        next = undefined;
        return value();
      };
    },
  };
};

const drain = (take: () => { ok: boolean }): number => {
  let taken = 0;
  while (take().ok) taken += 1;
  return taken;
};

describe('createRequestThrottle', () => {
  it('gives a sixth of the rate at once, then a wait in whole seconds', () => {
    const { clock } = handClock();
    const throttle = createRequestThrottle({ requestsPerMinute: 300, clock });
    expect(drain(() => throttle.take())).toBe(50);
    expect(throttle.take()).toEqual({ ok: false, waitSeconds: 1 });
    const slow = createRequestThrottle({ requestsPerMinute: 1, clock });
    expect(slow.take()).toEqual({ ok: true });
    expect(slow.take()).toEqual({ ok: false, waitSeconds: 60 });
  });

  it('refills over time, also in fractions of a millisecond', () => {
    const time = handClock(1_000);
    const throttle = createRequestThrottle({
      requestsPerMinute: 60,
      clock: time.clock,
    });
    expect(drain(() => throttle.take())).toBe(10);
    time.set(1_999.5);
    expect(throttle.take().ok).toBe(false);
    time.set(2_000);
    expect(throttle.take()).toEqual({ ok: true });
    time.set(2_500.25);
    time.set(3_000);
    expect(throttle.take()).toEqual({ ok: true });
  });

  it('refills nothing while the clock runs back, and at most to the capacity after a jump', () => {
    const time = handClock(10_000);
    const throttle = createRequestThrottle({
      requestsPerMinute: 60,
      clock: time.clock,
    });
    drain(() => throttle.take());
    time.set(5_000);
    expect(throttle.take().ok).toBe(false);
    time.set(10_999);
    expect(throttle.take().ok).toBe(false);
    time.set(11_000);
    expect(throttle.take().ok).toBe(true);
    time.set(10_000_000_000);
    expect(drain(() => throttle.take())).toBe(10);
  });

  it.each([
    ['NaN', () => Number.NaN],
    ['-Infinity', () => Number.NEGATIVE_INFINITY],
    [
      'a clock that throws',
      () => {
        throw new Error('clock');
      },
    ],
  ])('refills nothing for %s and works again afterwards', (_, value) => {
    const time = handClock(0);
    const throttle = createRequestThrottle({
      requestsPerMinute: 60,
      clock: time.clock,
    });
    drain(() => throttle.take());
    time.set(500);
    expect(throttle.take().ok).toBe(false);
    time.once(value);
    expect(throttle.take().ok).toBe(false);
    time.set(1_500);
    expect(throttle.take().ok).toBe(true);
  });

  it('does not freeze after +Infinity', () => {
    const time = handClock(0);
    const throttle = createRequestThrottle({
      requestsPerMinute: 60,
      clock: time.clock,
    });
    drain(() => throttle.take());
    time.once(() => Number.POSITIVE_INFINITY);
    expect(throttle.take().ok).toBe(false);
    time.set(1_000);
    expect(throttle.take().ok).toBe(true);
  });

  it('starts full when the first reading of the clock fails', () => {
    const time = handClock(0);
    time.once(() => Number.NaN);
    const throttle = createRequestThrottle({
      requestsPerMinute: 6,
      clock: time.clock,
    });
    expect(throttle.take().ok).toBe(true);
    expect(throttle.take().ok).toBe(false);
  });

  it('shares nothing between two throttles', () => {
    const { clock } = handClock();
    const a = createRequestThrottle({ requestsPerMinute: 6, clock });
    const b = createRequestThrottle({ requestsPerMinute: 6, clock });
    expect(a.take().ok).toBe(true);
    expect(a.take().ok).toBe(false);
    expect(b.take().ok).toBe(true);
  });

  it('shows no counter and reads no argument', () => {
    const { clock } = handClock();
    const throttle = createRequestThrottle({ requestsPerMinute: 300, clock });
    expect(Object.keys(throttle)).toEqual(['take']);
    expect(Object.isFrozen(throttle)).toBe(true);
    expect(JSON.stringify(throttle)).toBe('{}');
    expect(throttle.take.length).toBe(0);
  });

  it.each([0, -1, 1.5, Number.NaN, '300' as unknown as number])(
    'refuses the rate %j',
    (rate) => {
      expect(() =>
        createRequestThrottle({
          requestsPerMinute: rate,
          clock: handClock().clock,
        }),
      ).toThrow(TypeError);
    },
  );
});
