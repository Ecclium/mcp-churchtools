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
  approvalQuotaKey,
  isApprovalQuotaKey,
  type IsoDate,
  isIsoDate,
  isQuotaKey,
  type QuotaKey,
  type QuotaStore,
  type TenantContext,
  type TenantId,
  writeQuotaKey,
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
 * for one store before and after a restart. A counter of a decision about
 * an entry of the queue belongs to the tenant alone, as the port asks.
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
    if (!isQuotaKey(key)) throw new TypeError('The key is unknown.');
    if (!isIsoDate(day)) throw new TypeError('The day is invalid.');
    return isApprovalQuotaKey(key)
      ? JSON.stringify([ctx.tenantId, key, day])
      : JSON.stringify([ctx.tenantId, ctx.actor.kind, ctx.actor.id, key, day]);
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
// The counter of a decision about an entry of the queue (ADR 0029).
const decision = approvalQuotaKey('5e'.repeat(32));

// The days of the checks of decisions, from today in UTC on, as each check
// runs: a store keeps such a counter by its own clock, so a fixed day
// would pass for a store with a real clock only until it is 15 days old.
const daysFromToday = (offset: number): IsoDate =>
  new Date(Date.now() + offset * 86_400_000)
    .toISOString()
    .slice(0, 10) as IsoDate;

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
  // The counters of the policy (ADR 0032): one per tool and target, apart
  // from the read budget and from each other, under the same rules.
  check(
    'keeps the counters of writes apart from the read budget and from each other',
    async (open) => {
      const store = open();
      const create = writeQuotaKey('ct_wiki_page_create', 'wiki_category:12');
      const update = writeQuotaKey(
        'ct_wiki_page_update',
        'wiki_page:12/00000000-0000-4000-8000-000000000001',
      );
      const other = writeQuotaKey('ct_wiki_page_create', 'wiki_category:13');
      assert.deepEqual(
        [
          await store.increment(one, create, day),
          await store.increment(one, create, day),
          await store.increment(one, update, day),
        ],
        [1, 2, 1],
      );
      assert.equal(await store.read(one, key, day), 0);
      assert.equal(await store.read(one, other, day), 0);
      assert.equal(await open().read(one, create, day), 2);
      assert.equal(await store.read(one, create, nextDay), 0);
    },
  ),
  // The counters of decisions about entries of the queue (ADR 0029): one
  // per tenant, whoever counts, so that a second identity cannot decide
  // again about an entry that was decided.
  check(
    'counts a decision for the tenant, whichever actor counts',
    async (open) => {
      const day = daysFromToday(0);
      const nextDay = daysFromToday(1);
      const store = open();
      const operator = quotaContext('demo-tenant', 'user', 'stdio:operator');
      const other = quotaContext(
        'other-tenant',
        'service',
        'stdio:local-stdio',
      );
      assert.deepEqual(
        [
          await store.increment(one, decision, day),
          await store.increment(operator, decision, day),
          await store.increment(other, decision, day),
        ],
        [1, 2, 1],
      );
      assert.equal(await store.read(operator, decision, day), 2);
      assert.equal(await open().read(one, decision, day), 2);
      assert.equal(await store.read(one, decision, nextDay), 0);
    },
  ),
  check(
    'keeps a decision apart from the read budget and the writes',
    async (open) => {
      const day = daysFromToday(0);
      const store = open();
      const create = writeQuotaKey('ct_wiki_page_create', 'wiki_category:12');
      await store.increment(one, decision, day);
      assert.equal(await store.read(one, key, day), 0);
      assert.equal(await store.read(one, create, day), 0);
      await store.increment(one, key, day);
      await store.increment(one, create, day);
      assert.equal(await store.read(one, decision, day), 1);
      assert.equal(
        await store.read(one, approvalQuotaKey('5f'.repeat(32)), day),
        0,
      );
    },
  ),
  // A store may drop the counters of a day once a later day counts; the
  // counter of a decision it must keep, while its entry waits.
  check('keeps a decision while later days count', async (open) => {
    const day = daysFromToday(0);
    await open().increment(one, decision, day);
    // The next day, and the last two days an entry of today matters.
    for (const later of [1, 14, 15].map(daysFromToday)) {
      const store = open();
      await store.increment(one, key, later);
      await store.increment(one, approvalQuotaKey('60'.repeat(32)), later);
    }
    assert.equal(await open().read(one, decision, day), 1);
    assert.equal(await open().increment(one, decision, day), 2);
  }),
  check(
    'gives 1 to one decision only when two stores count at the same time',
    async (open) => {
      const day = daysFromToday(0);
      const first = open();
      const second = open();
      const counts = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          (index % 2 === 0 ? first : second).increment(one, decision, day),
        ),
      );
      assert.deepEqual(
        [...counts].sort((a, b) => a - b),
        Array.from({ length: 10 }, (_, index) => index + 1),
      );
    },
  ),
  check('refuses a key of a decision of another form', async (open) => {
    const store = open();
    for (const bad of [
      'approval:',
      `approval:${'A'.repeat(64)}`,
      `approval:${'a'.repeat(63)}`,
      `approval:../${'a'.repeat(61)}`,
    ]) {
      await assert.rejects(store.increment(one, bad as QuotaKey, day));
      await assert.rejects(store.read(one, bad as QuotaKey, day));
    }
  }),
  check('refuses a key of a write of another form', async (open) => {
    const store = open();
    for (const bad of [
      'write:ct_wiki_page_create:wiki_category:../x',
      'write:ct_wiki_page_create:operation:1',
      'write:',
    ]) {
      await assert.rejects(store.increment(one, bad as QuotaKey, day));
      await assert.rejects(store.read(one, bad as QuotaKey, day));
    }
  }),
]);
