/**
 * The port for the queue of approvals (ADR 0029, ADR 0031): the store that
 * keeps a write the operator approves or rejects on the command line,
 * with what it would write and its diff.
 *
 * Where it stands in the way of a write: when no person can confirm a
 * plan in the client, or the policy sends it there, the core seals what
 * the plan would write and hands it to this store, under the ID of the
 * audit line of the call that queued it. `ecclium queue list` and `show`
 * read it back, `reject` and later `approve` keep the decision and destroy
 * the entry, so that its content is gone once the operator decided.
 *
 * A store sees only sealed entries. The core encrypts every entry with a
 * key of its own that the day key `queue` of its day wraps
 * (`KeyProvider.wrap`), and the store never holds a key. Once the day key
 * is destroyed, after 14 days, no entry of its day can be read in any
 * copy of the store. A decision holds no content: the ID, what was
 * decided and when.
 *
 * A store only keeps and shows. It never decides whether an approval
 * counts: the core checks the identity of the operator, the hash of the
 * plan and whether the approval was used, and a store of a plugin cannot
 * change that. A store of a plugin may keep the entries elsewhere, as
 * long as it keeps the same promises; the checks in testkit show them.
 *
 * @packageDocumentation
 */
import type { TenantContext } from './context.js';
import type { IsoDate } from './quota.js';

/** What the operator decided about an entry of the queue. */
export type QueueDecisionKind = 'approved' | 'rejected';

/** Every {@link QueueDecisionKind}, frozen, for checks at run time. */
export const queueDecisionKinds: readonly QueueDecisionKind[] = Object.freeze([
  'approved',
  'rejected',
]);

/** The longest sealed entry a store has to keep, in characters. */
export const maxSealedQueueEntryLength: number = 16 * 1024 * 1024;

/** One sealed entry of the queue: a write that waits for the operator. */
export interface SealedQueueEntry {
  /**
   * The ID of the entry: the ID of the audit event of the call that queued
   * the write, a UUID in lower case.
   */
  readonly id: string;
  /** The UTC day it was queued, which also names its day key. */
  readonly day: IsoDate;
  /**
   * The entry, encrypted by the core, opaque to the store: letters,
   * digits, `-`, `_` and `.`, at most {@link maxSealedQueueEntryLength}
   * characters.
   */
  readonly sealed: string;
}

/** The decision about an entry, without any of its content. */
export interface QueueDecision {
  /** The ID of the entry. */
  readonly id: string;
  /** The UTC day of the entry, not of the decision. */
  readonly day: IsoDate;
  /** What the operator decided. */
  readonly decision: QueueDecisionKind;
  /**
   * When, in ISO 8601 with milliseconds in UTC, such as
   * `2026-11-03T18:00:00.000Z`.
   */
  readonly decidedAt: string;
}

/**
 * An entry as a store gives it back: the sealed entry while it waits, the
 * decision once there is one. After a decision the entry is destroyed, so
 * as a rule only one of the two is there; both are there only when a
 * store stopped between keeping the decision and destroying the entry.
 */
export interface QueueItem {
  /** The ID of the entry. */
  readonly id: string;
  /** The UTC day of the entry. */
  readonly day: IsoDate;
  /** The sealed entry, while it is kept. */
  readonly entry?: SealedQueueEntry;
  /** The decision, once there is one. */
  readonly decision?: QueueDecision;
}

/**
 * Keeps sealed entries of the queue and the decisions about them, for a
 * tenant. It takes the tenant from the context and from nothing a tool or
 * the operator hands over.
 */
export interface ApprovalQueue {
  /**
   * Keeps an entry. Each entry is kept once: a second entry with the same
   * ID on the same day rejects and the first stays as it was, and so does
   * an entry whose ID was decided on that day. The ID is new for every
   * call that queues, so a store need not look at other days.
   *
   * @param ctx - The context of the call, for the tenant.
   * @param entry - The sealed entry.
   * @returns Nothing once the entry is kept on the disk or its like.
   */
  put(ctx: TenantContext, entry: SealedQueueEntry): Promise<void>;

  /**
   * Gives every entry and every decision of the tenant of the context.
   *
   * @param ctx - The context of the call, for the tenant.
   * @returns The items, the oldest day first and by ID within a day.
   */
  list(ctx: TenantContext): Promise<readonly QueueItem[]>;

  /**
   * Gives one entry of the tenant of the context, with its decision.
   *
   * @param ctx - The context of the call, for the tenant.
   * @param id - The ID of the entry.
   * @returns The item, or undefined when there is neither an entry nor a
   *   decision of this ID, for example after its retention.
   */
  get(ctx: TenantContext, id: string): Promise<QueueItem | undefined>;

  /**
   * Keeps the decision about an entry once, and then destroys the entry,
   * so that its content is gone. A second decision about the same entry
   * rejects, after it destroyed what was left of the entry, and the first
   * decision stays as it was. A decision about an ID without an entry on
   * that day rejects as well.
   *
   * @param ctx - The context of the call, for the tenant.
   * @param decision - The decision.
   * @returns Nothing once the decision is kept and the entry destroyed.
   */
  decide(ctx: TenantContext, decision: QueueDecision): Promise<void>;

  /**
   * Removes the entries and decisions of every day before the one given,
   * for every tenant of the store.
   *
   * @param day - The first UTC day whose items stay.
   * @returns How many entries and decisions were removed. When one of them
   *   stays, the promise rejects, after every other was removed.
   */
  purgeBefore(day: IsoDate): Promise<number>;
}
