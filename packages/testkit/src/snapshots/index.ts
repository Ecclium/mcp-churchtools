/**
 * Checks every store of snapshots must pass (ADR 0031): the files of the
 * free core as well as a later replacement from a plugin, and a store in
 * memory for the tests of the write guard and of `ecclium undo`. A store
 * keeps each part of the snapshot of a write once, per tenant, gives the
 * records of an event back, `before` first, only to its tenant, keeps them
 * over a restart and removes the days before a given one for every tenant.
 * The checks use `node:assert`, so that a test runner of any kind can run
 * them.
 *
 * @packageDocumentation
 */
import assert from 'node:assert/strict';

import {
  type IsoDate,
  isIsoDate,
  maxSealedSnapshotLength,
  type SealedSnapshot,
  type SnapshotPart,
  snapshotParts,
  type SnapshotStore,
  type TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';

import { quotaContext } from '../quota/index.js';

/**
 * The records of {@link createMemorySnapshotStore}, to share between
 * stores, by tenant, event and part as JSON.
 */
export type SnapshotMemory = Map<string, SealedSnapshot>;

// A UUID in lower case, the form of the ID of an audit event.
const eventIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Letters, digits, `-`, `_` and `.`; the length is checked first, so that
// the pattern never runs over a huge string.
const sealedPattern = /^[A-Za-z0-9_.-]+$/;

const checkEventId = (eventId: unknown): string => {
  if (typeof eventId !== 'string' || !eventIdPattern.test(eventId)) {
    throw new TypeError('The ID of the event is invalid.');
  }
  return eventId;
};

const checkSnapshot = (snapshot: SealedSnapshot): SealedSnapshot => {
  const { eventId, part, day, sealed } = snapshot;
  checkEventId(eventId);
  if (!(snapshotParts as readonly unknown[]).includes(part)) {
    throw new TypeError('The part is no part of a snapshot.');
  }
  if (!isIsoDate(day)) throw new TypeError('The day is invalid.');
  if (
    typeof sealed !== 'string' ||
    sealed.length > maxSealedSnapshotLength ||
    !sealedPattern.test(sealed)
  ) {
    throw new TypeError('The sealed record is invalid.');
  }
  return Object.freeze({ eventId, part, day, sealed });
};

const keyOf = (tenant: string, eventId: string, part: SnapshotPart) =>
  JSON.stringify([tenant, eventId, part]);

/**
 * A store of snapshots in memory, only for tests. Two stores over the same
 * memory stand for one store before and after a restart.
 *
 * @param memory - The records, new by default.
 * @returns The store, frozen.
 * @example
 * ```ts
 * const store = createMemorySnapshotStore();
 * await store.put(ctx, { eventId, part: 'before', day, sealed });
 * ```
 */
export function createMemorySnapshotStore(
  memory: SnapshotMemory = new Map(),
): SnapshotStore {
  return Object.freeze({
    put: (ctx: TenantContext, snapshot: SealedSnapshot): Promise<void> =>
      Promise.resolve().then(() => {
        const record = checkSnapshot(snapshot);
        const key = keyOf(ctx.tenantId, record.eventId, record.part);
        if (memory.has(key)) {
          throw new Error('The part of the snapshot is kept already.');
        }
        memory.set(key, record);
      }),
    get: (
      ctx: TenantContext,
      eventId: string,
    ): Promise<readonly SealedSnapshot[]> =>
      Promise.resolve().then(() => {
        const checked = checkEventId(eventId);
        const records: SealedSnapshot[] = [];
        for (const part of snapshotParts) {
          const record = memory.get(keyOf(ctx.tenantId, checked, part));
          if (record !== undefined) records.push(record);
        }
        return Object.freeze(records);
      }),
    purgeBefore: (day: IsoDate): Promise<number> =>
      Promise.resolve().then(() => {
        if (!isIsoDate(day)) throw new TypeError('The day is invalid.');
        let removed = 0;
        for (const [key, record] of memory) {
          if (record.day < day) {
            memory.delete(key);
            removed += 1;
          }
        }
        return removed;
      }),
  });
}

/**
 * Opens a store of snapshots. Every call over the same storage stands for
 * the store after a restart of the process.
 */
export type OpenSnapshotStore = () => SnapshotStore;

/** One check of {@link snapshotStoreChecks}. */
export interface SnapshotStoreCheck {
  /** What the check shows, as a sentence for the name of a test. */
  readonly name: string;
  /**
   * Runs the check against fresh storage.
   *
   * @param open - Opens a store over storage of its own for this check.
   * @returns Nothing; it rejects with an assertion error on a failure.
   */
  readonly run: (open: OpenSnapshotStore) => Promise<void>;
}

const day = '2026-11-03' as IsoDate;
const before = '2026-11-02' as IsoDate;
const after = '2026-11-04' as IsoDate;
const one = quotaContext('demo-tenant', 'service', 'stdio:local-stdio');
const other = quotaContext('other-tenant', 'service', 'stdio:local-stdio');

// IDs of events of their own for every use, so that no check depends on
// another.
const eventOf = (seed: number): string =>
  `00000000-0000-4000-8000-${seed.toString(16).padStart(12, '0')}`;

const record = (
  seed: number,
  part: SnapshotPart,
  recordDay: IsoDate = day,
  sealed = `sealed.${String(seed)}-${part}_v1`,
): SealedSnapshot => ({ eventId: eventOf(seed), part, day: recordDay, sealed });

// The fields of a record, without its prototype or its freezing.
const fieldsOf = (records: readonly SealedSnapshot[]) =>
  records.map(({ eventId, part, day: recordDay, sealed }) => ({
    eventId,
    part,
    day: recordDay,
    sealed,
  }));

const check = (
  name: string,
  run: (open: OpenSnapshotStore) => Promise<void>,
): SnapshotStoreCheck => Object.freeze({ name, run });

/**
 * The checks every store of snapshots passes, frozen. A test runs each one
 * with a function that opens a store over storage of its own.
 *
 * @example
 * ```ts
 * it.each(snapshotStoreChecks)('$name', ({ run }) => run(() => openStore(dir)));
 * ```
 */
export const snapshotStoreChecks: readonly SnapshotStoreCheck[] = Object.freeze(
  [
    check('gives back the records it keeps, before first', async (open) => {
      const store = open();
      // The part after first, so that the order comes from the store.
      const kept = [record(1, 'before'), record(1, 'after')] as const;
      await store.put(one, kept[1]);
      await store.put(one, kept[0]);
      assert.deepEqual(fieldsOf(await store.get(one, eventOf(1))), [...kept]);
      await store.put(one, record(2, 'before'));
      assert.deepEqual(fieldsOf(await store.get(one, eventOf(2))), [
        record(2, 'before'),
      ]);
    }),
    check('gives nothing for another event or another tenant', async (open) => {
      const store = open();
      await store.put(one, record(3, 'before'));
      assert.deepEqual(await store.get(one, eventOf(4)), []);
      assert.deepEqual(await store.get(other, eventOf(3)), []);
    }),
    check(
      'refuses a second record of the same part and keeps the first',
      async (open) => {
        const store = open();
        await store.put(one, record(5, 'before'));
        await assert.rejects(store.put(one, record(5, 'before')));
        await assert.rejects(
          store.put(one, record(5, 'before', day, 'replaced')),
        );
        await assert.rejects(
          open().put(one, record(5, 'before', day, 'replaced')),
        );
        assert.deepEqual(fieldsOf(await store.get(one, eventOf(5))), [
          record(5, 'before'),
        ]);
      },
    ),
    check('keeps the same event of another tenant apart', async (open) => {
      const store = open();
      await store.put(one, record(6, 'before', day, 'mine'));
      await store.put(other, record(6, 'before', day, 'theirs'));
      assert.deepEqual(fieldsOf(await store.get(one, eventOf(6))), [
        record(6, 'before', day, 'mine'),
      ]);
      assert.deepEqual(fieldsOf(await store.get(other, eventOf(6))), [
        record(6, 'before', day, 'theirs'),
      ]);
    }),
    check('keeps its records over a restart', async (open) => {
      await open().put(one, record(7, 'before'));
      await open().put(one, record(7, 'after', after));
      assert.deepEqual(fieldsOf(await open().get(one, eventOf(7))), [
        record(7, 'before'),
        record(7, 'after', after),
      ]);
    }),
    check(
      'removes the records of every tenant before the day and keeps the day and later',
      async (open) => {
        const store = open();
        await store.put(one, record(8, 'before', before));
        await store.put(one, record(8, 'after', before));
        await store.put(other, record(9, 'before', before));
        await store.put(one, record(10, 'before', day));
        await store.put(other, record(11, 'before', after));
        assert.equal(await store.purgeBefore(day), 3);
        assert.deepEqual(await store.get(one, eventOf(8)), []);
        assert.deepEqual(await open().get(other, eventOf(9)), []);
        assert.deepEqual(fieldsOf(await open().get(one, eventOf(10))), [
          record(10, 'before', day),
        ]);
        assert.deepEqual(fieldsOf(await store.get(other, eventOf(11))), [
          record(11, 'before', after),
        ]);
        assert.equal(await open().purgeBefore(day), 0);
      },
    ),
    check(
      'refuses an event that is no UUID in lower case, an unknown part, a day that is no day and a sealed record of another form',
      async (open) => {
        const store = open();
        const refused: SealedSnapshot[] = [
          { ...record(12, 'before'), eventId: eventOf(12).toUpperCase() },
          { ...record(12, 'before'), eventId: `${eventOf(12)}0` },
          { ...record(12, 'before'), eventId: 'event-12' },
          { ...record(12, 'before'), part: 'during' as SnapshotPart },
          { ...record(12, 'before'), day: '2026-02-30' as IsoDate },
          { ...record(12, 'before'), day: 'today' as IsoDate },
          ...['a+b', 'a/b', 'a=', 'a b', 'ä', 'a\n'].map((sealed) =>
            record(12, 'before', day, sealed),
          ),
          // One character over the bound, made only now.
          record(12, 'before', day, 'A'.repeat(maxSealedSnapshotLength + 1)),
        ];
        for (const snapshot of refused) {
          await assert.rejects(store.put(one, snapshot));
        }
        assert.deepEqual(await store.get(one, eventOf(12)), []);
        await assert.rejects(store.get(one, eventOf(12).toUpperCase()));
        await assert.rejects(store.get(one, '../12'));
        await assert.rejects(store.purgeBefore('2026-02-30' as IsoDate));
        await assert.rejects(store.purgeBefore('today' as IsoDate));
      },
    ),
  ],
);
