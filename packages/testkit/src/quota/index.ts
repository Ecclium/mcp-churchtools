/**
 * Checks every store of quotas must pass (ADR 0063), the file of the core
 * as well as a later replacement, and a store in memory for the tests of
 * the pipeline. The checks use `node:assert`, so that a test runner of any
 * kind can run them.
 *
 * @packageDocumentation
 */
import assert from 'node:assert/strict';

import {
  type ActorKind,
  type IsoDate,
  isIsoDate,
  type QuotaKey,
  quotaKeys,
  type QuotaStore,
  type TenantContext,
  type TenantId,
} from '@ecclium/mcp-churchtools-plugin-api';

/**
 * A context with only what a store reads: tenant and actor. A store must
 * take nothing else from it.
 *
 * @param tenantId - The tenant.
 * @param kind - The kind of the actor.
 * @param id - The ID of the actor.
 * @returns The context, frozen.
 * @example
 * ```ts
 * const ctx = quotaContext('demo-tenant', 'service', 'stdio:local-stdio');
 * ```
 */
export function quotaContext(
  tenantId: string,
  kind: ActorKind,
  id: string,
): TenantContext {
  return Object.freeze({
    tenantId: tenantId as TenantId,
    actor: Object.freeze({ kind, id }),
  }) as unknown as TenantContext;
}

/** The counters of {@link createMemoryQuotaStore}, to share between stores. */
export type QuotaMemory = Map<string, number>;

/**
 * A store in memory, only for tests. Two stores over the same memory stand
 * for one store before and after a restart.
 *
 * @param memory - The counters, new by default.
 * @returns The store, frozen.
 * @example
 * ```ts
 * const store = createMemoryQuotaStore();
 * await store.increment(ctx, 'special_reads', day); // 1
 * ```
 */
export function createMemoryQuotaStore(
  memory: QuotaMemory = new Map(),
): QuotaStore {
  const keyOf = (ctx: TenantContext, key: QuotaKey, day: IsoDate): string => {
    if (!quotaKeys.includes(key)) throw new TypeError('The key is unknown.');
    if (!isIsoDate(day)) throw new TypeError('The day is invalid.');
    return JSON.stringify([
      ctx.tenantId,
      ctx.actor.kind,
      ctx.actor.id,
      key,
      day,
    ]);
  };
  return Object.freeze({
    increment: (ctx: TenantContext, key: QuotaKey, day: IsoDate) =>
      Promise.resolve().then(() => {
        const entry = keyOf(ctx, key, day);
        const value = (memory.get(entry) ?? 0) + 1;
        memory.set(entry, value);
        return value;
      }),
    read: (ctx: TenantContext, key: QuotaKey, day: IsoDate) =>
      Promise.resolve().then(() => memory.get(keyOf(ctx, key, day)) ?? 0),
  });
}

/**
 * Opens a store. Every call over the same storage stands for the store
 * after a restart of the process.
 */
export type OpenQuotaStore = () => QuotaStore;

/** One check of {@link quotaStoreChecks}. */
export interface QuotaStoreCheck {
  /** What the check shows, as a sentence for the name of a test. */
  readonly name: string;
  /**
   * Runs the check against fresh storage.
   *
   * @param open - Opens a store over storage of its own for this check.
   * @returns Nothing; it rejects with an assertion error on a failure.
   */
  readonly run: (open: OpenQuotaStore) => Promise<void>;
}

const day = '2026-10-24' as IsoDate;
const nextDay = '2026-10-25' as IsoDate;
const key: QuotaKey = 'special_reads';
const one = quotaContext('demo-tenant', 'service', 'stdio:local-stdio');

const check = (
  name: string,
  run: (open: OpenQuotaStore) => Promise<void>,
): QuotaStoreCheck => Object.freeze({ name, run });

/**
 * The checks every store of quotas passes, frozen. A test runs each one
 * with a function that opens a store over storage of its own.
 *
 * @example
 * ```ts
 * it.each(quotaStoreChecks)('$name', ({ run }) => run(() => openStore(dir)));
 * ```
 */
export const quotaStoreChecks: readonly QuotaStoreCheck[] = Object.freeze([
  check('reads 0 for a counter that never counted', async (open) => {
    assert.equal(await open().read(one, key, day), 0);
  }),
  check('counts up by one and returns the new value', async (open) => {
    const store = open();
    assert.deepEqual(
      [
        await store.increment(one, key, day),
        await store.increment(one, key, day),
        await store.increment(one, key, day),
      ],
      [1, 2, 3],
    );
    assert.equal(await store.read(one, key, day), 3);
  }),
  check('keeps tenants, actors and days apart', async (open) => {
    const store = open();
    const others = [
      quotaContext('other-tenant', 'service', 'stdio:local-stdio'),
      quotaContext('demo-tenant', 'user', 'stdio:local-stdio'),
      quotaContext('demo-tenant', 'service', 'stdio:local-other'),
    ];
    await store.increment(one, key, day);
    await store.increment(one, key, day);
    for (const other of others) {
      assert.equal(await store.read(other, key, day), 0);
      assert.equal(await store.increment(other, key, day), 1);
    }
    assert.equal(await store.read(one, key, nextDay), 0);
    assert.equal(await store.read(one, key, day), 2);
  }),
  check('loses no call that counts at the same time', async (open) => {
    const store = open();
    const counts = await Promise.all(
      Array.from({ length: 20 }, () => store.increment(one, key, day)),
    );
    assert.deepEqual(
      [...counts].sort((a, b) => a - b),
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    assert.equal(await store.read(one, key, day), 20);
  }),
  check(
    'keeps its counters for the next store over the same storage',
    async (open) => {
      await open().increment(one, key, day);
      await open().increment(one, key, day);
      assert.equal(await open().read(one, key, day), 2);
    },
  ),
  check(
    'refuses a day that is no day and a key it does not know',
    async (open) => {
      const store = open();
      for (const bad of ['2026-02-30', '../2026-10-24', '', '2026-10-24\n']) {
        await assert.rejects(store.increment(one, key, bad as IsoDate));
        await assert.rejects(store.read(one, key, bad as IsoDate));
      }
      await assert.rejects(store.increment(one, 'reads' as QuotaKey, day));
      assert.equal(await store.read(one, key, day), 0);
    },
  ),
]);
