/**
 * The queue of approvals as the composition root hands it to the pipeline
 * and the command line (ADR 0031): the provider of keys, a store and the
 * clock, joined.
 *
 * Where it stands in the way of a write: the pipeline queues a write
 * through `enqueue` when no person can confirm it in the client or the
 * policy sends it here; `ecclium queue list` and `show` read the entries
 * through `list` and `load`; `reject` keeps a decision through `decide`,
 * which destroys the entry; the start and the day timer remove what is
 * past its retention through `purgeBefore`, entries and day keys alike.
 *
 * The retention of 14 days is checked here by the day of an entry, not by
 * whether its day key still exists: an entry older than that counts as
 * expired also while the day timer has not yet destroyed its day key, and
 * a store of a plugin that keeps an entry longer changes nothing (ADR
 * 0029, ADR 0031).
 *
 * It holds no state of its own beyond the two ports and the clock it was
 * given.
 *
 * @packageDocumentation
 */
import {
  type ApprovalQueue,
  type Clock,
  type QueueItem,
  isIsoDate,
  type IsoDate,
  type KeyProvider,
  type QueueDecision,
  type TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';

import {
  openQueueEntry,
  type QueueEntryContent,
  type QueueEntryToSeal,
  sealQueueEntry,
} from './seal.js';

/**
 * How many days after its own an entry of the queue stays: an entry of a
 * day D can be approved through D+14, and from D+15 on it is expired, its
 * day key destroyed at the next look of the start or the day timer.
 */
export const queueRetentionDays = 14;

const dayMs = 86_400_000;

/**
 * The first UTC day whose entries of the queue are still valid at a time:
 * the day of the time less {@link queueRetentionDays}.
 *
 * @param now - The time, in milliseconds since the Unix epoch.
 * @returns The day, or undefined for a time that gives none.
 * @example
 * ```ts
 * firstKeptQueueDay(Date.UTC(2026, 10, 15, 12)); // '2026-11-01'
 * ```
 */
export const firstKeptQueueDay = (now: number): IsoDate | undefined => {
  if (!Number.isFinite(now)) return undefined;
  // A day in UTC has no change of the clock, so 14 times its length back
  // is the same time of the day 14 days before.
  const cut = new Date(now - queueRetentionDays * dayMs);
  if (Number.isNaN(cut.getTime())) return undefined;
  const day = cut.toISOString().slice(0, 10);
  return isIsoDate(day) ? day : undefined;
};

/**
 * What {@link QueueKeeper.load} finds for an ID: `missing` when the queue
 * holds neither an entry nor a decision of it; `expired` when its retention
 * is over, by its day or because its day key is gone; `decided` with the
 * decision, once there is one; `found` with what the entry holds.
 */
export type LoadedQueueEntry =
  | { readonly kind: 'missing' }
  | { readonly kind: 'expired'; readonly day: IsoDate }
  | { readonly kind: 'decided'; readonly decision: QueueDecision }
  | {
      readonly kind: 'found';
      readonly day: IsoDate;
      readonly content: QueueEntryContent;
    };

/**
 * One entry as `ecclium queue list` shows it: waiting, with what it holds;
 * expired; damaged, because it does not open; or decided, with when.
 */
export type QueueListing =
  | {
      readonly state: 'open';
      readonly id: string;
      readonly day: IsoDate;
      readonly content: QueueEntryContent;
    }
  | {
      readonly state: 'expired' | 'damaged';
      readonly id: string;
      readonly day: IsoDate;
    }
  | {
      readonly state: 'approved' | 'rejected';
      readonly id: string;
      readonly day: IsoDate;
      readonly decidedAt: string;
    };

/** What {@link QueueKeeper.purgeBefore} removed. */
export interface QueuePurge {
  /** How many entries and decisions went, as far as they were counted. */
  readonly records: number;
  /** How many day keys of the queue went, as far as they were counted. */
  readonly dayKeys: number;
  /**
   * Whether the store and the provider of keys both removed everything
   * before the day. When not, the start tries again later, and a count of
   * the half that failed is 0, because a refusal carries none.
   */
  readonly complete: boolean;
}

/** The queue of approvals over a provider of keys, a store and a clock. */
export interface QueueKeeper {
  /**
   * Seals an entry and keeps it.
   *
   * @param ctx - The context of the call that queues.
   * @param entry - ID, day and content.
   * @returns Nothing once the entry is kept.
   */
  enqueue(ctx: TenantContext, entry: QueueEntryToSeal): Promise<void>;
  /**
   * Counts the entries of the tenant of the context that wait for a
   * decision and are not past their retention, without opening one.
   *
   * @param ctx - The context, for the tenant.
   * @returns The count, or undefined without a clock that gives a day.
   */
  waiting(ctx: TenantContext): Promise<number | undefined>;
  /**
   * Gives every entry of the tenant of the context, the oldest first,
   * each opened where it waits.
   *
   * @param ctx - The context, for tenant and instance.
   * @returns The entries as the command line lists them.
   */
  list(ctx: TenantContext): Promise<readonly QueueListing[]>;
  /**
   * Finds and opens one entry of the tenant of the context.
   *
   * @param ctx - The context, for tenant and instance.
   * @param id - The ID of the entry.
   * @returns What there is, see {@link LoadedQueueEntry}.
   */
  load(ctx: TenantContext, id: string): Promise<LoadedQueueEntry>;
  /**
   * Keeps a decision about an entry and destroys the entry.
   *
   * @param ctx - The context, for the tenant.
   * @param decision - The decision.
   * @returns Nothing once the decision is kept and the entry gone.
   */
  decide(ctx: TenantContext, decision: QueueDecision): Promise<void>;
  /**
   * Removes the entries and decisions and destroys the day keys of the
   * days before one. It never rejects: what could not go is in the result.
   *
   * @param day - The first UTC day that stays.
   * @returns How many entries and day keys went, and whether all did.
   */
  purgeBefore(day: IsoDate): Promise<QueuePurge>;
}

const missing: LoadedQueueEntry = Object.freeze({ kind: 'missing' });

// Whether a store gives the sealed entry under the ID and day it was asked
// about: the sealing binds the entry to the ID and day it names itself, so
// a store of a plugin must not label it otherwise (ADR 0029).
const named = (item: QueueItem, id: string): boolean =>
  item.id === id && item.entry?.id === id && item.entry.day === item.day;

/**
 * Joins a provider of keys, a store and a clock into the queue of
 * approvals.
 *
 * @param ports - The provider of keys, the store and the clock.
 * @param ports.keys - The provider of keys with the day keys.
 * @param ports.store - The store of sealed entries.
 * @param ports.clock - The clock, for the retention.
 * @returns The queue, frozen.
 * @example
 * ```ts
 * const queue = createQueueKeeper({ keys, store, clock });
 * await queue.enqueue(ctx, { id: eventId, day, content });
 * ```
 */
export function createQueueKeeper(ports: {
  readonly keys: KeyProvider;
  readonly store: ApprovalQueue;
  readonly clock: Clock;
}): QueueKeeper {
  const { keys, store, clock } = ports;
  // The first day that is still valid; a clock that fails gives none, and
  // then every entry counts as expired, so that none is approved past its
  // time.
  const cut = (): IsoDate | undefined => {
    try {
      return firstKeptQueueDay(clock.now());
    } catch {
      return undefined;
    }
  };
  const valid = (day: IsoDate, from: IsoDate | undefined): boolean =>
    from !== undefined && day >= from;

  return Object.freeze({
    enqueue: async (ctx: TenantContext, entry: QueueEntryToSeal) => {
      await store.put(ctx, await sealQueueEntry(keys, ctx, entry));
    },
    waiting: async (ctx: TenantContext): Promise<number | undefined> => {
      const from = cut();
      if (from === undefined) return undefined;
      const items = await store.list(ctx);
      return items.filter(
        (item) => item.decision === undefined && item.day >= from,
      ).length;
    },
    list: async (ctx: TenantContext): Promise<readonly QueueListing[]> => {
      const from = cut();
      const listed: QueueListing[] = [];
      for (const item of await store.list(ctx)) {
        const { id, day } = item;
        if (item.decision !== undefined) {
          listed.push(
            Object.freeze({
              state: item.decision.decision,
              id,
              day,
              decidedAt: item.decision.decidedAt,
            }),
          );
          continue;
        }
        // A store gives an item with an entry or a decision.
        const entry = item.entry as NonNullable<typeof item.entry>;
        let content: QueueEntryContent | undefined;
        let damaged = !named(item, id);
        try {
          content =
            valid(day, from) && !damaged
              ? await openQueueEntry(keys, ctx, entry)
              : undefined;
        } catch {
          damaged = true;
        }
        listed.push(
          content === undefined
            ? Object.freeze({ state: damaged ? 'damaged' : 'expired', id, day })
            : Object.freeze({ state: 'open', id, day, content }),
        );
      }
      // In the order of the store: the oldest day first.
      return Object.freeze(listed);
    },
    load: async (ctx: TenantContext, id: string): Promise<LoadedQueueEntry> => {
      const item = await store.get(ctx, id);
      if (item === undefined) return missing;
      if (item.decision !== undefined) {
        // An entry next to its decision is what a stop between the two
        // left; deciding again destroys it, and the store refuses the
        // second decision as expected (ADR 0031).
        if (item.entry !== undefined) {
          await store.decide(ctx, item.decision).catch(() => undefined);
        }
        return Object.freeze({ kind: 'decided', decision: item.decision });
      }
      const { day } = item;
      const expired = Object.freeze({ kind: 'expired', day } as const);
      if (!valid(day, cut())) return expired;
      if (!named(item, id)) throw new Error('The entry does not open.');
      // A store gives an item with an entry or a decision.
      const content = await openQueueEntry(
        keys,
        ctx,
        item.entry as NonNullable<typeof item.entry>,
      );
      if (content === undefined) return expired;
      return Object.freeze({ kind: 'found', day, content });
    },
    decide: async (ctx: TenantContext, decision: QueueDecision) => {
      await store.decide(ctx, decision);
    },
    // Entries first, then the keys, also when the entries could not all
    // go: an entry whose file stays is still unreadable once its day key
    // is gone. Both counts are kept, so that a day key without an entry is
    // reported too.
    purgeBefore: async (day: IsoDate): Promise<QueuePurge> => {
      const records = await store.purgeBefore(day).then(
        (count) => count,
        () => undefined,
      );
      const dayKeys = await keys.destroyBefore('queue', day).then(
        (count) => count,
        () => undefined,
      );
      return Object.freeze({
        records: records ?? 0,
        dayKeys: dayKeys ?? 0,
        complete: records !== undefined && dayKeys !== undefined,
      });
    },
  });
}
