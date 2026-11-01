import type { Clock } from '@ecclium/mcp-churchtools-plugin-api';
import {
  createTestClock,
  nonceStoreChecks,
  planStoreChecks,
  quotaContext,
  stubPlan,
} from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it } from 'vitest';

import {
  createMemoryNonceStore,
  maxNonces,
  nonceTtlMs,
} from './nonce-store.js';
import {
  createMemoryPlanStore,
  maxOpenPlans,
  planTtlMs,
} from './plan-store.js';

const ctx = quotaContext('demo-tenant', 'service', 'stdio:local-stdio');
const start = Date.UTC(2026, 10, 1, 8, 0, 0);
const hashOf = (index: number): string => index.toString(16).padStart(64, '0');
const nonceOf = (index: number): string => `nonce-${String(index)}`;

const failingClock: Clock = Object.freeze({
  now: (): number => {
    throw new Error('clock');
  },
});
const brokenClock: Clock = Object.freeze({ now: (): number => Number.NaN });

describe('the store of plans in memory', () => {
  it.each(planStoreChecks)('$name', async ({ run }) => {
    await run((clock, capacity) => createMemoryPlanStore(clock, capacity));
  });

  it('keeps plans for 600 seconds and at most 100 of them (ADR 0029)', () => {
    expect(planTtlMs).toBe(600_000);
    expect(maxOpenPlans).toBe(100);
  });

  it('answers full beyond its capacity and stores again once plans expire', async () => {
    const clock = createTestClock(start);
    const store = createMemoryPlanStore(clock, 3);
    for (const index of [0, 1, 2]) {
      expect(await store.put(ctx, hashOf(index), stubPlan('x'), 1_000)).toBe(
        'stored',
      );
    }
    expect(await store.put(ctx, hashOf(3), stubPlan('x'), 1_000)).toBe('full');
    expect(await store.take(ctx, hashOf(3))).toBeUndefined();
    // The same hash again takes the place of its plan and counts once.
    const again = stubPlan('again');
    expect(await store.put(ctx, hashOf(2), again, 1_000)).toBe('stored');
    expect(await store.take(ctx, hashOf(2))).toBe(again);
    expect(await store.put(ctx, hashOf(2), again, 1_000)).toBe('stored');
    clock.advance(1_000);
    expect(await store.put(ctx, hashOf(3), stubPlan('x'), 1_000)).toBe(
      'stored',
    );
    expect(await store.take(ctx, hashOf(2))).toBeUndefined();
  });

  it('holds 100 plans by default and refuses the 101st', async () => {
    const store = createMemoryPlanStore(createTestClock(start));
    for (let index = 0; index < maxOpenPlans; index += 1) {
      await store.put(ctx, hashOf(index), stubPlan('x'), planTtlMs);
    }
    expect(
      await store.put(ctx, hashOf(maxOpenPlans), stubPlan('x'), planTtlMs),
    ).toBe('full');
  });

  it('refuses a hash of another form and a time beyond 600 seconds', async () => {
    const store = createMemoryPlanStore(createTestClock(start));
    for (const hash of ['A'.repeat(64), 'a'.repeat(63), '', 42]) {
      await expect(
        store.put(ctx, hash as string, stubPlan('x'), planTtlMs),
      ).rejects.toThrow(TypeError);
      await expect(store.take(ctx, hash as string)).rejects.toThrow(TypeError);
    }
    await expect(
      store.put(ctx, hashOf(1), stubPlan('x'), planTtlMs + 1),
    ).rejects.toThrow(TypeError);
  });

  it('lets no plan in or out when the clock fails', async () => {
    for (const clock of [failingClock, brokenClock]) {
      const store = createMemoryPlanStore(clock);
      await expect(
        store.put(ctx, hashOf(1), stubPlan('x'), planTtlMs),
      ).rejects.toThrow();
    }
    const clock = createTestClock(start);
    let fails = false;
    const store = createMemoryPlanStore({
      now: () => (fails ? Number.NaN : clock.now()),
    });
    await store.put(ctx, hashOf(1), stubPlan('x'), planTtlMs);
    fails = true;
    await expect(store.take(ctx, hashOf(1))).rejects.toThrow(TypeError);
    // Taken once, also when the clock failed.
    fails = false;
    expect(await store.take(ctx, hashOf(1))).toBeUndefined();
  });

  it('refuses a capacity that is no whole number from 1', () => {
    for (const capacity of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        createMemoryPlanStore(createTestClock(start), capacity),
      ).toThrow(TypeError);
    }
  });

  it('is frozen', () => {
    expect(Object.isFrozen(createMemoryPlanStore(createTestClock(start)))).toBe(
      true,
    );
  });
});

describe('the store of nonces in memory', () => {
  it.each(nonceStoreChecks)('$name', async ({ run }) => {
    await run((clock, capacity) => createMemoryNonceStore(clock, capacity));
  });

  it('remembers nonces for 660 seconds and at most 10,000 of them (ADR 0029)', () => {
    expect(nonceTtlMs).toBe(660_000);
    expect(maxNonces).toBe(10_000);
  });

  it('forgets a nonce after its time', async () => {
    const clock = createTestClock(start);
    const store = createMemoryNonceStore(clock);
    await store.consume(ctx, nonceOf(1), 1_000);
    clock.advance(1_000);
    expect(await store.consume(ctx, nonceOf(1), 1_000)).toBe('fresh');
  });

  it('calls every new nonce used when full, until older ones expire', async () => {
    const clock = createTestClock(start);
    const store = createMemoryNonceStore(clock, 2);
    expect(await store.consume(ctx, nonceOf(1), 1_000)).toBe('fresh');
    expect(await store.consume(ctx, nonceOf(2), 2_000)).toBe('fresh');
    expect(await store.consume(ctx, nonceOf(3), 1_000)).toBe('replayed');
    // A used nonce stays used while the store is full.
    expect(await store.consume(ctx, nonceOf(2), 1_000)).toBe('replayed');
    clock.advance(1_000);
    expect(await store.consume(ctx, nonceOf(3), 1_000)).toBe('fresh');
    expect(await store.consume(ctx, nonceOf(2), 1_000)).toBe('replayed');
  });

  it('holds 10,000 nonces by default and calls the next one used', async () => {
    const store = createMemoryNonceStore(createTestClock(start));
    for (let index = 0; index < maxNonces; index += 1) {
      await store.consume(ctx, nonceOf(index), nonceTtlMs);
    }
    expect(await store.consume(ctx, nonceOf(maxNonces), nonceTtlMs)).toBe(
      'replayed',
    );
  });

  it('refuses a nonce longer than 128 characters, one that is no text and a time beyond 660 seconds', async () => {
    const store = createMemoryNonceStore(createTestClock(start));
    await expect(store.consume(ctx, 'n'.repeat(129), 1_000)).rejects.toThrow(
      TypeError,
    );
    await expect(
      store.consume(ctx, 42 as unknown as string, 1_000),
    ).rejects.toThrow(TypeError);
    await expect(
      store.consume(ctx, nonceOf(1), nonceTtlMs + 1),
    ).rejects.toThrow(TypeError);
    expect(await store.consume(ctx, 'n'.repeat(128), 1_000)).toBe('fresh');
  });

  it('calls no nonce fresh when the clock fails', async () => {
    for (const clock of [failingClock, brokenClock]) {
      await expect(
        createMemoryNonceStore(clock).consume(ctx, nonceOf(1), 1_000),
      ).rejects.toThrow();
    }
  });

  it('refuses a capacity that is no whole number from 1', () => {
    for (const capacity of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        createMemoryNonceStore(createTestClock(start), capacity),
      ).toThrow(TypeError);
    }
  });

  it('is frozen', () => {
    expect(
      Object.isFrozen(createMemoryNonceStore(createTestClock(start))),
    ).toBe(true);
  });
});
