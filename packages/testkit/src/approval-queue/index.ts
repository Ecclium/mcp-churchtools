/**
 * Checks every queue of approvals must pass (ADR 0031): the files of the
 * free core as well as a later replacement from a plugin, and a queue in
 * memory for the tests of the pipeline and of `ecclium queue`. A queue
 * keeps each entry once, per tenant, gives entries back only to their
 * tenant, keeps them over a restart, keeps one decision per entry and
 * destroys the entry with it, and removes the days before a given one for
 * every tenant. The checks use `node:assert`, so that a test runner of any
 * kind can run them.
 *
 * @packageDocumentation
 */
import assert from 'node:assert/strict';

import {
  type ApprovalQueue,
  type IsoDate,
  isIsoDate,
  maxSealedQueueEntryLength,
  type QueueDecision,
  type QueueDecisionKind,
  queueDecisionKinds,
  type QueueItem,
  type SealedQueueEntry,
  type TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';

import { quotaContext } from '../quota/index.js';

/**
 * What {@link createMemoryApprovalQueue} keeps, to share between queues,
 * by tenant, day and ID as JSON.
 */
export interface ApprovalQueueMemory {
  readonly entries: Map<string, SealedQueueEntry>;
  readonly decisions: Map<string, QueueDecision>;
}

// A UUID in lower case, the form of the ID of an audit event.
const idPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Letters, digits, `-`, `_` and `.`; the length is checked first, so that
// the pattern never runs over a huge string.
const sealedPattern = /^[A-Za-z0-9_.-]+$/;

const timePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const checkId = (id: unknown): string => {
  if (typeof id !== 'string' || !idPattern.test(id)) {
    throw new TypeError('The ID of the entry is invalid.');
  }
  return id;
};

const checkDay = (day: unknown): IsoDate => {
  if (!isIsoDate(day)) throw new TypeError('The day is invalid.');
  return day;
};

const checkEntry = (entry: SealedQueueEntry): SealedQueueEntry => {
  const { id, day, sealed } = entry;
  checkId(id);
  checkDay(day);
  if (
    typeof sealed !== 'string' ||
    sealed.length > maxSealedQueueEntryLength ||
    !sealedPattern.test(sealed)
  ) {
    throw new TypeError('The sealed entry is invalid.');
  }
  return Object.freeze({ id, day, sealed });
};

const checkDecision = (decision: QueueDecision): QueueDecision => {
  const { id, day, decision: kind, decidedAt } = decision;
  checkId(id);
  checkDay(day);
  if (!(queueDecisionKinds as readonly unknown[]).includes(kind)) {
    throw new TypeError('The decision is invalid.');
  }
  if (typeof decidedAt !== 'string' || !timePattern.test(decidedAt)) {
    throw new TypeError('The time is invalid.');
  }
  return Object.freeze({ id, day, decision: kind, decidedAt });
};

const keyOf = (tenant: string, day: IsoDate, id: string) =>
  JSON.stringify([tenant, day, id]);

/**
 * A queue of approvals in memory, only for tests. Two queues over the same
 * memory stand for one queue before and after a restart.
 *
 * @param memory - What it keeps, new by default.
 * @returns The queue, frozen.
 * @example
 * ```ts
 * const queue = createMemoryApprovalQueue();
 * await queue.put(ctx, { id, day, sealed });
 * ```
 */
export function createMemoryApprovalQueue(
  memory: ApprovalQueueMemory = { entries: new Map(), decisions: new Map() },
): ApprovalQueue {
  const { entries, decisions } = memory;
  const itemsOf = (tenant: string): QueueItem[] => {
    const keys = new Set<string>();
    for (const map of [entries, decisions]) {
      for (const key of map.keys()) {
        if ((JSON.parse(key) as string[])[0] === tenant) keys.add(key);
      }
    }
    return [...keys]
      .map((key) => {
        const [, day, id] = JSON.parse(key) as [string, IsoDate, string];
        const entry = entries.get(key);
        const decision = decisions.get(key);
        return Object.freeze({
          id,
          day,
          ...(entry === undefined ? {} : { entry }),
          ...(decision === undefined ? {} : { decision }),
        });
      })
      .sort((a, b) =>
        a.day === b.day ? (a.id < b.id ? -1 : 1) : a.day < b.day ? -1 : 1,
      );
  };
  return Object.freeze({
    put: (ctx: TenantContext, entry: SealedQueueEntry): Promise<void> =>
      Promise.resolve().then(() => {
        const checked = checkEntry(entry);
        const key = keyOf(ctx.tenantId, checked.day, checked.id);
        if (entries.has(key) || decisions.has(key)) {
          throw new Error('The entry is kept or decided already.');
        }
        entries.set(key, checked);
      }),
    list: (ctx: TenantContext): Promise<readonly QueueItem[]> =>
      Promise.resolve().then(() => Object.freeze(itemsOf(ctx.tenantId))),
    get: (ctx: TenantContext, id: string): Promise<QueueItem | undefined> =>
      Promise.resolve().then(() => {
        const checked = checkId(id);
        return itemsOf(ctx.tenantId).find((item) => item.id === checked);
      }),
    decide: (ctx: TenantContext, decision: QueueDecision): Promise<void> =>
      Promise.resolve().then(() => {
        const checked = checkDecision(decision);
        const key = keyOf(ctx.tenantId, checked.day, checked.id);
        const had = entries.delete(key);
        if (decisions.has(key)) throw new Error('Decided already.');
        if (!had) throw new Error('There is no entry to decide.');
        decisions.set(key, checked);
      }),
    purgeBefore: (day: IsoDate): Promise<number> =>
      Promise.resolve().then(() => {
        const cut = checkDay(day);
        let removed = 0;
        for (const map of [entries, decisions] as const) {
          for (const [key, value] of map) {
            if (value.day < cut) {
              map.delete(key);
              removed += 1;
            }
          }
        }
        return removed;
      }),
  });
}

/**
 * Opens a queue of approvals. Every call over the same storage stands for
 * the queue after a restart of the process.
 */
export type OpenApprovalQueue = () => ApprovalQueue;

/** One check of {@link approvalQueueChecks}. */
export interface ApprovalQueueCheck {
  /** What the check shows, as a sentence for the name of a test. */
  readonly name: string;
  /**
   * Runs the check against fresh storage.
   *
   * @param open - Opens a queue over storage of its own for this check.
   * @returns Nothing; it rejects with an assertion error on a failure.
   */
  readonly run: (open: OpenApprovalQueue) => Promise<void>;
}

const day = '2026-11-03' as IsoDate;
const before = '2026-11-02' as IsoDate;
const after = '2026-11-04' as IsoDate;
const one = quotaContext('demo-tenant', 'service', 'stdio:local-stdio');
const other = quotaContext('other-tenant', 'service', 'stdio:local-stdio');

// IDs of their own for every use, so that no check depends on another.
const idOf = (seed: number): string =>
  `00000000-0000-4000-8000-${seed.toString(16).padStart(12, '0')}`;

const entryOf = (
  seed: number,
  entryDay: IsoDate = day,
  sealed = `sealed.${String(seed)}_v1`,
): SealedQueueEntry => ({ id: idOf(seed), day: entryDay, sealed });

const decisionOf = (
  seed: number,
  kind: QueueDecisionKind = 'rejected',
  decisionDay: IsoDate = day,
  decidedAt = '2026-11-03T18:00:00.000Z',
): QueueDecision => ({
  id: idOf(seed),
  day: decisionDay,
  decision: kind,
  decidedAt,
});

// The fields of an item, without its prototype or its freezing.
const fieldsOf = (item: QueueItem | undefined) =>
  item === undefined
    ? undefined
    : {
        id: item.id,
        day: item.day,
        ...(item.entry === undefined
          ? {}
          : {
              entry: {
                id: item.entry.id,
                day: item.entry.day,
                sealed: item.entry.sealed,
              },
            }),
        ...(item.decision === undefined
          ? {}
          : {
              decision: {
                id: item.decision.id,
                day: item.decision.day,
                decision: item.decision.decision,
                decidedAt: item.decision.decidedAt,
              },
            }),
      };

const waiting = (entry: SealedQueueEntry) => ({
  id: entry.id,
  day: entry.day,
  entry,
});

const decided = (decision: QueueDecision) => ({
  id: decision.id,
  day: decision.day,
  decision,
});

const check = (
  name: string,
  run: (open: OpenApprovalQueue) => Promise<void>,
): ApprovalQueueCheck => Object.freeze({ name, run });

/**
 * The checks every queue of approvals passes, frozen. A test runs each one
 * with a function that opens a queue over storage of its own.
 *
 * @example
 * ```ts
 * it.each(approvalQueueChecks)('$name', ({ run }) => run(() => openQueue(dir)));
 * ```
 */
export const approvalQueueChecks: readonly ApprovalQueueCheck[] = Object.freeze(
  [
    check(
      'gives back the entries it keeps, the oldest day first and by ID within a day',
      async (open) => {
        const queue = open();
        // The later ones first, so that the order comes from the queue.
        await queue.put(one, entryOf(3, after));
        await queue.put(one, entryOf(2));
        await queue.put(one, entryOf(1));
        assert.deepEqual((await queue.list(one)).map(fieldsOf), [
          waiting(entryOf(1)),
          waiting(entryOf(2)),
          waiting(entryOf(3, after)),
        ]);
        assert.deepEqual(
          fieldsOf(await queue.get(one, idOf(3))),
          waiting(entryOf(3, after)),
        );
      },
    ),
    check('gives nothing for another ID or another tenant', async (open) => {
      const queue = open();
      await queue.put(one, entryOf(4));
      assert.equal(await queue.get(one, idOf(5)), undefined);
      assert.equal(await queue.get(other, idOf(4)), undefined);
      assert.deepEqual(await queue.list(other), []);
    }),
    check(
      'refuses a second entry of the same ID and keeps the first',
      async (open) => {
        const queue = open();
        await queue.put(one, entryOf(6));
        await assert.rejects(queue.put(one, entryOf(6)));
        await assert.rejects(queue.put(one, entryOf(6, day, 'replaced')));
        await assert.rejects(open().put(one, entryOf(6, day, 'replaced')));
        assert.deepEqual(
          fieldsOf(await queue.get(one, idOf(6))),
          waiting(entryOf(6)),
        );
      },
    ),
    check('keeps the same ID of another tenant apart', async (open) => {
      const queue = open();
      await queue.put(one, entryOf(7, day, 'mine'));
      await queue.put(other, entryOf(7, day, 'theirs'));
      await queue.decide(other, decisionOf(7));
      assert.deepEqual(
        fieldsOf(await queue.get(one, idOf(7))),
        waiting(entryOf(7, day, 'mine')),
      );
      assert.deepEqual(
        fieldsOf(await queue.get(other, idOf(7))),
        decided(decisionOf(7)),
      );
    }),
    check('keeps its entries and decisions over a restart', async (open) => {
      await open().put(one, entryOf(8));
      await open().put(one, entryOf(9, after));
      await open().decide(one, decisionOf(9, 'approved', after));
      assert.deepEqual((await open().list(one)).map(fieldsOf), [
        waiting(entryOf(8)),
        decided(decisionOf(9, 'approved', after)),
      ]);
    }),
    check(
      'keeps one decision per entry and destroys the entry with it',
      async (open) => {
        const queue = open();
        await queue.put(one, entryOf(10));
        await queue.decide(one, decisionOf(10, 'rejected'));
        assert.deepEqual(
          fieldsOf(await queue.get(one, idOf(10))),
          decided(decisionOf(10, 'rejected')),
        );
        await assert.rejects(queue.decide(one, decisionOf(10, 'approved')));
        await assert.rejects(open().decide(one, decisionOf(10, 'approved')));
        await assert.rejects(queue.put(one, entryOf(10)));
        assert.deepEqual((await open().list(one)).map(fieldsOf), [
          decided(decisionOf(10, 'rejected')),
        ]);
      },
    ),
    check(
      'refuses a decision without an entry of its ID, day and tenant',
      async (open) => {
        const queue = open();
        await queue.put(one, entryOf(11));
        await assert.rejects(queue.decide(one, decisionOf(12)));
        await assert.rejects(
          queue.decide(one, decisionOf(11, 'rejected', after)),
        );
        await assert.rejects(queue.decide(other, decisionOf(11)));
        assert.deepEqual(
          fieldsOf(await queue.get(one, idOf(11))),
          waiting(entryOf(11)),
        );
        assert.equal(await queue.get(one, idOf(12)), undefined);
      },
    ),
    check(
      'removes the entries and decisions of every tenant before the day and keeps the day and later',
      async (open) => {
        const queue = open();
        await queue.put(one, entryOf(13, before));
        await queue.put(one, entryOf(14, before));
        await queue.decide(one, decisionOf(14, 'rejected', before));
        await queue.put(other, entryOf(15, before));
        await queue.put(one, entryOf(16, day));
        await queue.put(other, entryOf(17, after));
        assert.equal(await queue.purgeBefore(day), 3);
        assert.equal(await queue.get(one, idOf(13)), undefined);
        assert.equal(await queue.get(one, idOf(14)), undefined);
        assert.equal(await open().get(other, idOf(15)), undefined);
        assert.deepEqual(
          fieldsOf(await open().get(one, idOf(16))),
          waiting(entryOf(16, day)),
        );
        assert.deepEqual(
          fieldsOf(await queue.get(other, idOf(17))),
          waiting(entryOf(17, after)),
        );
        assert.equal(await open().purgeBefore(day), 0);
      },
    ),
    check(
      'refuses an ID that is no UUID in lower case, a day that is no day, a sealed entry of another form and a decision or time that is none',
      async (open) => {
        const queue = open();
        const refused: SealedQueueEntry[] = [
          { ...entryOf(26), id: idOf(26).toUpperCase() },
          { ...entryOf(26), id: `${idOf(26)}0` },
          { ...entryOf(26), id: '../26' },
          { ...entryOf(26), day: '2026-02-30' as IsoDate },
          { ...entryOf(26), day: 'today' as IsoDate },
          ...['a+b', 'a/b', 'a=', 'a b', 'ä', 'a\n', ''].map((sealed) =>
            entryOf(26, day, sealed),
          ),
          // One character over the bound, made only now.
          entryOf(26, day, 'A'.repeat(maxSealedQueueEntryLength + 1)),
        ];
        for (const entry of refused) {
          await assert.rejects(queue.put(one, entry));
        }
        assert.deepEqual(await queue.list(one), []);
        await queue.put(one, entryOf(26));
        for (const decision of [
          { ...decisionOf(26), id: idOf(26).toUpperCase() },
          { ...decisionOf(26), day: 'today' as IsoDate },
          { ...decisionOf(26), decision: 'maybe' as QueueDecisionKind },
          { ...decisionOf(26), decidedAt: '2026-11-03T18:00:00Z' },
          { ...decisionOf(26), decidedAt: 'now' },
        ]) {
          await assert.rejects(queue.decide(one, decision));
        }
        assert.deepEqual(
          fieldsOf(await queue.get(one, idOf(26))),
          waiting(entryOf(26)),
        );
        await assert.rejects(queue.get(one, idOf(26).toUpperCase()));
        await assert.rejects(queue.get(one, '../26'));
        await assert.rejects(queue.purgeBefore('2026-02-30' as IsoDate));
        await assert.rejects(queue.purgeBefore('today' as IsoDate));
      },
    ),
  ],
);
