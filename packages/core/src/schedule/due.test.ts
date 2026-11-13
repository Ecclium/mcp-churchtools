import {
  type Clock,
  type IsoDate,
  type QuotaStore,
  runQuotaKey,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  createMemoryQuotaStore,
  quotaContext,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  checkDue,
  closeTrigger,
  type DueOptions,
  dueLimits,
  lastTrigger,
  startAttempt,
} from './due.js';

const at = (iso: string): number => Date.parse(iso);
const minutes = (count: number): number => count * 60_000;
const days = (count: number): number => count * 86_400_000;

// A clock the test moves.
const movable = (start: number): Clock & { set: (time: number) => void } => {
  let now = start;
  return {
    now: () => now,
    set: (time: number) => {
      now = time;
    },
  };
};

const runner = quotaContext(
  'demo-tenant',
  'runner',
  'runner:dienstplan-report',
);

// Monday, 09.11.2026, 06:00 in Zurich.
const monday = at('2026-11-09T05:00:00Z');
const nextMonday = at('2026-11-16T05:00:00Z');

const optionsFor = (
  clock: Clock,
  store: QuotaStore = createMemoryQuotaStore(),
  extra: Partial<DueOptions> = {},
): DueOptions => ({
  schedule: '0 6 * * MON',
  timeZone: 'Europe/Zurich',
  routineId: 'dienstplan-report',
  clock,
  store,
  ctx: runner,
  ...extra,
});

const period = {
  isoWeek: '2026-W46',
  date: '2026-11-09',
  month: '2026-11',
};

afterEach(() => {
  vi.useRealTimers();
});

describe('checkDue', () => {
  it('finds the last trigger up to now due while no run tried it', async () => {
    const clock = movable(monday + minutes(90));
    const check = await checkDue(optionsFor(clock));
    expect(check).toEqual({
      status: 'due',
      trigger: { at: monday, period },
      next: nextMonday,
    });
    expect(Object.isFrozen(check)).toBe(true);
  });

  it('counts a trigger at the very time it is asked', async () => {
    const check = await checkDue(optionsFor(movable(monday)));
    expect(check.status === 'due' && check.trigger.at).toBe(monday);
  });

  it('serves the period of the trigger also when the run comes days late', async () => {
    const check = await checkDue(optionsFor(movable(monday + days(6))));
    expect(check).toMatchObject({ status: 'due', trigger: { period } });
  });

  it('is closed once a run closed the trigger, for every actor of the tenant', async () => {
    const clock = movable(monday + minutes(5));
    const store = createMemoryQuotaStore();
    const options = optionsFor(clock, store);
    const check = await checkDue(options);
    if (check.status !== 'due') throw new Error(check.status);
    await expect(
      startAttempt({ ...options, trigger: check.trigger }),
    ).resolves.toEqual({ ok: true, attempt: 1 });
    // A run by hand, by an operator, closes the same trigger.
    const byHand = optionsFor(clock, store, {
      ctx: quotaContext('demo-tenant', 'operator', 'stdio:operator'),
    });
    await expect(
      closeTrigger({ ...byHand, trigger: check.trigger }),
    ).resolves.toBe(true);
    clock.set(monday + days(2));
    await expect(checkDue(options)).resolves.toEqual({
      status: 'closed',
      trigger: { at: monday, period },
      next: nextMonday,
    });
    // Another tenant has its own memory.
    await expect(
      checkDue(
        optionsFor(clock, store, {
          ctx: quotaContext('other-tenant', 'runner', 'runner:report'),
        }),
      ),
    ).resolves.toMatchObject({ status: 'due' });
  });

  it('tries a trigger three times at most, each 15 minutes after the one before at least', async () => {
    const clock = movable(monday + minutes(14));
    const options = optionsFor(clock);
    const start = async (): Promise<unknown> => {
      const check = await checkDue(options);
      if (check.status !== 'due') return check;
      return startAttempt({ ...options, trigger: check.trigger });
    };
    await expect(start()).resolves.toEqual({ ok: true, attempt: 1 });
    // The first try began in the first window: the next waits for the
    // third, 16 minutes later.
    await expect(checkDue(options)).resolves.toMatchObject({
      status: 'waiting',
      next: monday + minutes(30),
    });
    clock.set(monday + minutes(29));
    await expect(checkDue(options)).resolves.toMatchObject({
      status: 'waiting',
      next: monday + minutes(30),
    });
    clock.set(monday + minutes(30));
    await expect(start()).resolves.toEqual({ ok: true, attempt: 2 });
    clock.set(monday + minutes(44));
    await expect(checkDue(options)).resolves.toMatchObject({
      status: 'waiting',
      next: monday + minutes(60),
    });
    // A single run called much later tries as well, once.
    clock.set(monday + days(1));
    await expect(start()).resolves.toEqual({ ok: true, attempt: 3 });
    clock.set(monday + days(2));
    await expect(checkDue(options)).resolves.toEqual({
      status: 'exhausted',
      trigger: { at: monday, period },
      next: nextMonday,
    });
    // The next trigger begins anew.
    clock.set(nextMonday);
    await expect(start()).resolves.toEqual({ ok: true, attempt: 1 });
  });

  it('waits no longer than the next trigger', async () => {
    // Hourly: the next trigger comes before the window of the next try.
    const clock = movable(at('2026-11-09T05:50:00Z'));
    const options = optionsFor(clock, createMemoryQuotaStore(), {
      schedule: '0 * * * *',
    });
    const check = await checkDue(options);
    if (check.status !== 'due') throw new Error(check.status);
    await startAttempt({ ...options, trigger: check.trigger });
    await expect(checkDue(options)).resolves.toMatchObject({
      status: 'waiting',
      next: at('2026-11-09T06:00:00Z'),
    });
  });

  // An hourly routine gets two tries per trigger: its third would begin
  // two windows after the second, at the next trigger, which takes over.
  // The ping of the runner relies on this (ADR 0009).
  it('gives an hourly trigger no third try, as its next trigger comes first', async () => {
    const trigger = at('2026-11-09T05:00:00Z');
    const clock = movable(trigger);
    const options = optionsFor(clock, createMemoryQuotaStore(), {
      schedule: '0 * * * *',
    });
    const start = async (): Promise<unknown> => {
      const check = await checkDue(options);
      if (check.status !== 'due') return check;
      return startAttempt({ ...options, trigger: check.trigger });
    };
    await expect(start()).resolves.toEqual({ ok: true, attempt: 1 });
    clock.set(trigger + minutes(30));
    await expect(start()).resolves.toEqual({ ok: true, attempt: 2 });
    clock.set(trigger + minutes(59));
    await expect(checkDue(options)).resolves.toMatchObject({
      status: 'waiting',
      trigger: { at: trigger },
      next: trigger + minutes(60),
    });
    clock.set(trigger + minutes(60));
    await expect(checkDue(options)).resolves.toMatchObject({
      status: 'due',
      trigger: { at: trigger + minutes(60) },
    });
  });

  it('lets a try begin when the memory names tries but no window near now', async () => {
    const clock = movable(monday + minutes(5));
    const store = createMemoryQuotaStore();
    const options = optionsFor(clock, store);
    // A try counted without its window, as after a store that lost one.
    await store.increment(
      runner,
      runQuotaKey('dienstplan-report', monday, 'tries'),
      '2026-11-09' as IsoDate,
    );
    await expect(checkDue(options)).resolves.toMatchObject({ status: 'due' });
    clock.set(monday + minutes(50));
    await expect(checkDue(options)).resolves.toMatchObject({ status: 'due' });
  });

  it('finds nothing due when the last trigger lies more than 31 days back', async () => {
    // Once a year, on 1 January at 06:00 in Zurich.
    const newYear = at('2026-01-01T05:00:00Z');
    const clock = movable(newYear + days(dueLimits.dueDays));
    const options = optionsFor(clock, createMemoryQuotaStore(), {
      schedule: '0 6 1 1 *',
    });
    await expect(checkDue(options)).resolves.toMatchObject({
      status: 'due',
      trigger: { at: newYear },
    });
    clock.set(newYear + days(dueLimits.dueDays) + 1);
    await expect(checkDue(options)).resolves.toEqual({
      status: 'none',
      next: at('2027-01-01T05:00:00Z'),
    });
  });

  it('finds the trigger at the end of the gap of summer time due, with its day', async () => {
    const options = optionsFor(
      movable(at('2026-03-29T05:00:00Z')),
      createMemoryQuotaStore(),
      { schedule: '30 2,14 * * *' },
    );
    await expect(checkDue(options)).resolves.toEqual({
      status: 'due',
      trigger: {
        at: at('2026-03-29T01:00:00Z'),
        period: { isoWeek: '2026-W13', date: '2026-03-29', month: '2026-03' },
      },
      next: at('2026-03-29T12:30:00Z'),
    });
  });

  it.each<[string, () => Promise<number>]>([
    ['rejects', () => Promise.reject(new Error('disk'))],
    [
      'throws',
      () => {
        throw new Error('disk');
      },
    ],
    ['gives a negative count', () => Promise.resolve(-1)],
    ['gives a broken count', () => Promise.resolve(1.5)],
    ['gives no number', () => Promise.resolve(Number.NaN)],
  ])(
    'is unavailable when the store %s, and begins no run',
    async (_name, fail) => {
      const store: QuotaStore = { read: fail, increment: fail };
      const options = optionsFor(movable(monday + minutes(5)), store);
      await expect(checkDue(options)).resolves.toEqual({
        status: 'unavailable',
        next: monday + minutes(20),
      });
      const trigger = { at: monday, period };
      await expect(startAttempt({ ...options, trigger })).resolves.toEqual({
        ok: false,
        reason: 'unavailable',
      });
      await expect(closeTrigger({ ...options, trigger })).resolves.toBe(false);
    },
  );

  it('is unavailable when the store does not answer within 5 seconds', async () => {
    vi.useFakeTimers();
    const store: QuotaStore = {
      read: () => new Promise<number>(() => undefined),
      increment: () => new Promise<number>(() => undefined),
    };
    const options = optionsFor(movable(monday + minutes(5)), store);
    const check = checkDue(options);
    await vi.advanceTimersByTimeAsync(4999);
    let settled = false;
    void check.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(check).resolves.toMatchObject({ status: 'unavailable' });
    const start = startAttempt({ ...options, trigger: { at: monday, period } });
    await vi.advanceTimersByTimeAsync(5000);
    await expect(start).resolves.toEqual({ ok: false, reason: 'unavailable' });
  });

  it('is unavailable when its next window is not until the next trigger', async () => {
    const store: QuotaStore = {
      read: () => Promise.reject(new Error('disk')),
      increment: () => Promise.reject(new Error('disk')),
    };
    await expect(
      checkDue(optionsFor(movable(nextMonday - minutes(5)), store)),
    ).resolves.toEqual({ status: 'unavailable', next: nextMonday });
  });

  it('refuses a routine ID, a schedule and a zone that do not fit, before it asks the store', async () => {
    const read = vi.fn(() => Promise.resolve(0));
    const store: QuotaStore = { read, increment: read };
    const clock = movable(monday);
    for (const extra of [
      { routineId: 'Dienstplan' },
      { schedule: '*/15 * * * *' },
      { timeZone: 'CET' },
    ]) {
      await expect(checkDue(optionsFor(clock, store, extra))).rejects.toThrow(
        TypeError,
      );
    }
    await expect(
      checkDue(optionsFor(movable(Date.UTC(1999, 11, 31)), store)),
    ).rejects.toThrow(TypeError);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('startAttempt', () => {
  it('lets one of two runs that start in the same window begin', async () => {
    const options = optionsFor(movable(monday + minutes(5)));
    const trigger = { at: monday, period };
    const [first, second] = await Promise.all([
      startAttempt({ ...options, trigger }),
      startAttempt({ ...options, trigger }),
    ]);
    expect([first, second]).toEqual([
      { ok: true, attempt: 1 },
      { ok: false, reason: 'waiting' },
    ]);
  });

  it('begins no fourth try, even past the check', async () => {
    const clock = movable(monday);
    const options = optionsFor(clock);
    const trigger = { at: monday, period };
    const starts: unknown[] = [];
    for (const window of [0, 2, 4, 6]) {
      clock.set(monday + window * dueLimits.retryMs);
      starts.push(await startAttempt({ ...options, trigger }));
    }
    expect(starts).toEqual([
      { ok: true, attempt: 1 },
      { ok: true, attempt: 2 },
      { ok: true, attempt: 3 },
      { ok: false, reason: 'exhausted' },
    ]);
  });

  it('refuses a trigger in the future and one that left the 31 days', async () => {
    const trigger = { at: monday, period };
    for (const now of [monday - 1, Number.NaN]) {
      await expect(
        startAttempt({ ...optionsFor(movable(now)), trigger }),
      ).rejects.toThrow(TypeError);
    }
    // The check found it due a moment before its 31 days ended.
    await expect(
      startAttempt({
        ...optionsFor(movable(monday + days(dueLimits.dueDays) + 1)),
        trigger,
      }),
    ).resolves.toEqual({ ok: false, reason: 'expired' });
    await expect(
      startAttempt({
        ...optionsFor(movable(monday + days(dueLimits.dueDays))),
        trigger,
      }),
    ).resolves.toEqual({ ok: true, attempt: 1 });
  });

  it('lets no try begin across the edge of a window next to another', async () => {
    const clock = movable(monday + minutes(15) - 100);
    const options = optionsFor(clock);
    const trigger = { at: monday, period };
    await expect(startAttempt({ ...options, trigger })).resolves.toEqual({
      ok: true,
      attempt: 1,
    });
    clock.set(monday + minutes(15) + 100);
    await expect(startAttempt({ ...options, trigger })).resolves.toEqual({
      ok: false,
      reason: 'waiting',
    });
  });

  it('lets neither of two starts begin that cross the edge at once', async () => {
    const store = createMemoryQuotaStore();
    const trigger = { at: monday, period };
    const first = optionsFor(movable(monday + minutes(15) - 100), store);
    const second = optionsFor(movable(monday + minutes(15) + 100), store);
    await expect(
      Promise.all([
        startAttempt({ ...first, trigger }),
        startAttempt({ ...second, trigger }),
      ]),
    ).resolves.toEqual([
      { ok: false, reason: 'waiting' },
      { ok: false, reason: 'waiting' },
    ]);
    // No try counted, and the windows both hold keep the next one back.
    await expect(checkDue(second)).resolves.toMatchObject({
      status: 'waiting',
      next: monday + minutes(45),
    });
  });

  it('waits after a start that counted its window but not its try', async () => {
    const memory = createMemoryQuotaStore();
    const failTries: QuotaStore = {
      read: (ctx, key, day) => memory.read(ctx, key, day),
      increment: (ctx, key, day) =>
        key.endsWith(':tries')
          ? Promise.reject(new Error('disk'))
          : memory.increment(ctx, key, day),
    };
    const clock = movable(monday + minutes(5));
    const trigger = { at: monday, period };
    await expect(
      startAttempt({ ...optionsFor(clock, failTries), trigger }),
    ).resolves.toEqual({ ok: false, reason: 'unavailable' });
    // The check agrees with the start: not due before the third window.
    const options = optionsFor(clock, memory);
    await expect(checkDue(options)).resolves.toMatchObject({
      status: 'waiting',
      next: monday + minutes(30),
    });
    clock.set(monday + minutes(30));
    await expect(checkDue(options)).resolves.toMatchObject({ status: 'due' });
    await expect(startAttempt({ ...options, trigger })).resolves.toEqual({
      ok: true,
      attempt: 1,
    });
  });

  it('refuses a trigger that is no whole minute', async () => {
    await expect(
      startAttempt({
        ...optionsFor(movable(monday + minutes(5))),
        trigger: { at: monday + 1000, period },
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      closeTrigger({
        ...optionsFor(movable(monday + minutes(5))),
        trigger: { at: monday + 1000, period },
      }),
    ).rejects.toThrow(TypeError);
  });
});

describe('lastTrigger', () => {
  it('gives the last trigger however long ago, for a run by hand', () => {
    const clock = movable(at('2026-11-09T12:00:00Z'));
    expect(
      lastTrigger({ schedule: '0 6 1 1 *', timeZone: 'Europe/Zurich', clock }),
    ).toEqual({
      at: at('2026-01-01T05:00:00Z'),
      period: { isoWeek: '2026-W01', date: '2026-01-01', month: '2026-01' },
    });
    expect(
      Object.isFrozen(
        lastTrigger({ schedule: '0 6 * * MON', timeZone: 'UTC', clock }),
      ),
    ).toBe(true);
  });
});
