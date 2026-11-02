/**
 * Checks every store of plans and every store of nonces must pass
 * (ADR 0029): the stores in memory of the core as well as a later
 * replacement, for example one that several instances share. The checks
 * use `node:assert`, so that a test runner of any kind can run them.
 *
 * Where they stand in the way of a write: between planning and committing
 * a sealed plan waits in the store of plans, and a token of a confirmation
 * counts once because its nonce is used up in the store of nonces. A store
 * that gives a plan twice, keeps it too long or mixes two tenants would
 * let a write happen that nobody confirmed.
 *
 * @packageDocumentation
 */
import assert from 'node:assert/strict';

import type {
  Clock,
  NonceStore,
  PlannedWrite,
  PlanStore,
} from '@ecclium/mcp-churchtools-plugin-api';

import { quotaContext } from '../quota/index.js';

/** A clock for tests that moves only when told. */
export interface TestClock extends Clock {
  /**
   * Moves the clock forward.
   *
   * @param ms - Milliseconds, 0 or more.
   */
  advance(ms: number): void;
}

/**
 * Makes a clock that starts at a given time and moves only with
 * `advance`.
 *
 * @param start - Milliseconds since the Unix epoch.
 * @returns The clock, frozen.
 * @example
 * ```ts
 * const clock = createTestClock(Date.UTC(2026, 10, 1));
 * clock.advance(600_000);
 * ```
 */
export function createTestClock(start: number): TestClock {
  let now = start;
  return Object.freeze({
    now: () => now,
    advance: (ms: number): void => {
      if (!Number.isSafeInteger(ms) || ms < 0) {
        throw new TypeError('A clock moves forward by whole milliseconds.');
      }
      now += ms;
    },
  });
}

/**
 * A stand-in for a sealed plan. A store keeps a plan as it is and never
 * reads it, so any frozen object does for its checks.
 *
 * @param label - Tells two stand-ins apart in a failed assertion.
 * @returns The stand-in, frozen.
 * @example
 * ```ts
 * await store.put(ctx, hash, stubPlan('a'), 600_000);
 * ```
 */
export function stubPlan(label: string): PlannedWrite {
  return Object.freeze({ label }) as unknown as PlannedWrite;
}

/**
 * Opens a store over storage of its own for one check, with the clock the
 * check moves and the most entries it may hold. A store for several
 * instances takes the capacity for its tests as well, so that the checks
 * can show what it does when it is full.
 */
export type OpenPlanStore = (clock: Clock, capacity: number) => PlanStore;

/** As {@link OpenPlanStore}, for a store of nonces. */
export type OpenNonceStore = (clock: Clock, capacity: number) => NonceStore;

/** One check of {@link planStoreChecks} or {@link nonceStoreChecks}. */
export interface WriteStoreCheck<Open> {
  /** What the check shows, as a sentence for the name of a test. */
  readonly name: string;
  /**
   * Runs the check against fresh storage.
   *
   * @param open - Opens a store over storage of its own for this check.
   * @returns Nothing; it rejects with an assertion error on a failure.
   */
  readonly run: (open: Open) => Promise<void>;
}

const start = Date.UTC(2026, 10, 1, 8, 0, 0);
// The times of ADR 0029: a plan lives as long as the requestState, a nonce
// one minute longer. No store may keep one longer than that.
const planTtl = 600_000;
const nonceTtl = 660_000;
// Room for every check but the ones about a full store, and the capacity
// those use.
const roomy = 1_000;
const small = 3;
const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);
const hashOf = (index: number): string => index.toString(16).padStart(64, '0');
const nonceA = 'nonce-aaaaaaaaaaaaaaaaaaaaaa';
const nonceB = 'nonce-bbbbbbbbbbbbbbbbbbbbbb';
const nonceOf = (index: number): string => `nonce-${String(index)}`;
const one = quotaContext('demo-tenant', 'service', 'stdio:local-stdio');
const others = [
  quotaContext('other-tenant', 'service', 'stdio:local-stdio'),
  quotaContext('demo-tenant', 'user', 'stdio:local-stdio'),
  quotaContext('demo-tenant', 'service', 'stdio:local-other'),
];
const badTtls = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY];

const check = <Open>(
  name: string,
  run: (open: Open) => Promise<void>,
): WriteStoreCheck<Open> => Object.freeze({ name, run });

/**
 * The checks every store of plans passes, frozen. A test runs each one
 * with a function that opens a store over storage of its own.
 *
 * @example
 * ```ts
 * it.each(planStoreChecks)('$name', ({ run }) =>
 *   run((clock, capacity) => createStore(clock, capacity)));
 * ```
 */
export const planStoreChecks: readonly WriteStoreCheck<OpenPlanStore>[] =
  Object.freeze([
    check<OpenPlanStore>('gives a plan back once', async (open) => {
      const store = open(createTestClock(start), roomy);
      const plan = stubPlan('a');
      assert.equal(await store.put(one, hashA, plan, planTtl), 'stored');
      assert.equal(await store.take(one, hashA), plan);
      assert.equal(await store.take(one, hashA), undefined);
    }),
    check<OpenPlanStore>('keeps tenants and actors apart', async (open) => {
      const store = open(createTestClock(start), roomy);
      const plan = stubPlan('a');
      await store.put(one, hashA, plan, planTtl);
      for (const other of others) {
        assert.equal(await store.take(other, hashA), undefined);
      }
      assert.equal(await store.take(one, hashA), plan);
    }),
    check<OpenPlanStore>('keeps plans apart by their hash', async (open) => {
      const store = open(createTestClock(start), roomy);
      const a = stubPlan('a');
      const b = stubPlan('b');
      await store.put(one, hashA, a, planTtl);
      await store.put(one, hashB, b, planTtl);
      assert.equal(await store.take(one, hashB), b);
      assert.equal(await store.take(one, hashA), a);
    }),
    check<OpenPlanStore>(
      'gives a plan until its time is over and never after',
      async (open) => {
        const clock = createTestClock(start);
        const store = open(clock, roomy);
        const plan = stubPlan('a');
        await store.put(one, hashA, plan, planTtl);
        await store.put(one, hashB, stubPlan('b'), planTtl);
        clock.advance(planTtl - 1);
        assert.equal(await store.take(one, hashA), plan);
        clock.advance(1);
        assert.equal(await store.take(one, hashB), undefined);
      },
    ),
    check<OpenPlanStore>(
      'keeps a plan only for the time it was given',
      async (open) => {
        const clock = createTestClock(start);
        const store = open(clock, roomy);
        const plan = stubPlan('a');
        await store.put(one, hashA, plan, 1_000);
        await store.put(one, hashB, stubPlan('b'), 1_000);
        clock.advance(999);
        assert.equal(await store.take(one, hashA), plan);
        clock.advance(1);
        assert.equal(await store.take(one, hashB), undefined);
      },
    ),
    check<OpenPlanStore>(
      'gives a plan to only one of many takes at the same time',
      async (open) => {
        const store = open(createTestClock(start), roomy);
        const plan = stubPlan('a');
        await store.put(one, hashA, plan, planTtl);
        const taken = await Promise.all(
          Array.from({ length: 10 }, () => store.take(one, hashA)),
        );
        assert.deepEqual(
          taken.filter((value) => value !== undefined),
          [plan],
        );
      },
    ),
    check<OpenPlanStore>(
      'answers full beyond its capacity and keeps every plan it took',
      async (open) => {
        const store = open(createTestClock(start), small);
        const plans = Array.from({ length: small }, (_, index) =>
          stubPlan(String(index)),
        );
        for (const [index, plan] of plans.entries()) {
          assert.equal(
            await store.put(one, hashOf(index), plan, planTtl),
            'stored',
          );
        }
        assert.equal(
          await store.put(one, hashOf(small), stubPlan('x'), planTtl),
          'full',
        );
        for (const [index, plan] of plans.entries()) {
          assert.equal(await store.take(one, hashOf(index)), plan);
        }
        assert.equal(await store.take(one, hashOf(small)), undefined);
      },
    ),
    check<OpenPlanStore>(
      'refuses a time that is no whole number from 1 or beyond 600 seconds',
      async (open) => {
        const store = open(createTestClock(start), roomy);
        for (const ttl of [...badTtls, planTtl + 1]) {
          await assert.rejects(store.put(one, hashA, stubPlan('a'), ttl));
        }
        assert.equal(await store.take(one, hashA), undefined);
      },
    ),
  ]);

/**
 * The checks every store of nonces passes, frozen. A test runs each one
 * with a function that opens a store over storage of its own.
 *
 * @example
 * ```ts
 * it.each(nonceStoreChecks)('$name', ({ run }) =>
 *   run((clock, capacity) => createStore(clock, capacity)));
 * ```
 */
export const nonceStoreChecks: readonly WriteStoreCheck<OpenNonceStore>[] =
  Object.freeze([
    check<OpenNonceStore>(
      'takes a nonce once and refuses it after',
      async (open) => {
        const store = open(createTestClock(start), roomy);
        assert.equal(await store.consume(one, nonceA, nonceTtl), 'fresh');
        assert.equal(await store.consume(one, nonceA, nonceTtl), 'replayed');
        assert.equal(await store.consume(one, nonceB, nonceTtl), 'fresh');
      },
    ),
    check<OpenNonceStore>('keeps tenants and actors apart', async (open) => {
      const store = open(createTestClock(start), roomy);
      await store.consume(one, nonceA, nonceTtl);
      for (const other of others) {
        assert.equal(await store.consume(other, nonceA, nonceTtl), 'fresh');
      }
      assert.equal(await store.consume(one, nonceA, nonceTtl), 'replayed');
    }),
    check<OpenNonceStore>(
      'remembers a nonce for its whole time',
      async (open) => {
        const clock = createTestClock(start);
        const store = open(clock, roomy);
        await store.consume(one, nonceA, nonceTtl);
        clock.advance(nonceTtl - 1);
        assert.equal(await store.consume(one, nonceA, nonceTtl), 'replayed');
      },
    ),
    check<OpenNonceStore>(
      'gives fresh to only one of many uses at the same time',
      async (open) => {
        const store = open(createTestClock(start), roomy);
        const answers = await Promise.all(
          Array.from({ length: 10 }, () =>
            store.consume(one, nonceA, nonceTtl),
          ),
        );
        assert.deepEqual(
          answers.filter((answer) => answer === 'fresh'),
          ['fresh'],
        );
      },
    ),
    check<OpenNonceStore>(
      'calls every new nonce used when full and forgets none early',
      async (open) => {
        const store = open(createTestClock(start), small);
        for (let index = 0; index < small; index += 1) {
          assert.equal(
            await store.consume(one, nonceOf(index), nonceTtl),
            'fresh',
          );
        }
        assert.equal(
          await store.consume(one, nonceOf(small), nonceTtl),
          'replayed',
        );
        for (let index = 0; index < small; index += 1) {
          assert.equal(
            await store.consume(one, nonceOf(index), nonceTtl),
            'replayed',
          );
        }
      },
    ),
    check<OpenNonceStore>(
      'refuses an empty nonce and a time that is no whole number from 1 or beyond 660 seconds',
      async (open) => {
        const store = open(createTestClock(start), roomy);
        await assert.rejects(store.consume(one, '', nonceTtl));
        for (const ttl of [...badTtls, nonceTtl + 1]) {
          await assert.rejects(store.consume(one, nonceA, ttl));
        }
        assert.equal(await store.consume(one, nonceA, nonceTtl), 'fresh');
      },
    ),
  ]);
