/**
 * The port for snapshots (ADR 0031): the store that keeps the state of a
 * target before a write, so that `ecclium undo` can take the write back.
 *
 * A store sees only sealed records. The core encrypts every record before
 * it hands it over, with a key of its own that the day key of the day
 * wraps (`KeyProvider.wrap`), and the store never holds a key. Once the day
 * key is destroyed, no record of its day can be read, whatever copy of the
 * store exists. A store of a plugin may keep the records elsewhere, as
 * long as it keeps the same promises; the checks in testkit show them.
 *
 * @packageDocumentation
 */
import type { TenantContext } from './context.js';
import type { IsoDate } from './quota.js';

/**
 * Which part of a snapshot a record holds: the state before a write, saved
 * before the write is sent, or what the write left, saved after it is read
 * back, such as the GUID of a new page.
 */
export type SnapshotPart = 'before' | 'after';

/** Every {@link SnapshotPart}, frozen, in the order a store gives them. */
export const snapshotParts: readonly SnapshotPart[] = Object.freeze([
  'before',
  'after',
]);

/** The longest sealed record a store has to keep, in characters. */
export const maxSealedSnapshotLength: number = 16 * 1024 * 1024;

/** One sealed record of a snapshot. */
export interface SealedSnapshot {
  /** The ID of the audit event of the write, a UUID in lower case. */
  readonly eventId: string;
  /** Which part of the snapshot the record holds. */
  readonly part: SnapshotPart;
  /** The UTC day it was taken, which also names its day key. */
  readonly day: IsoDate;
  /**
   * The record, encrypted by the core, opaque to the store: letters,
   * digits, `-`, `_` and `.`, at most {@link maxSealedSnapshotLength}
   * characters.
   */
  readonly sealed: string;
}

/**
 * Keeps sealed records of snapshots for a tenant. It takes the tenant from
 * the context and from nothing a tool hands over.
 */
export interface SnapshotStore {
  /**
   * Keeps a record. Each part of the snapshot of a write is kept once: a
   * second record of the same tenant, event, part and day rejects, and the
   * first stays as it was. The ID of an event is new for every call, so a
   * store need not look at other days.
   *
   * @param ctx - The context of the call, for the tenant.
   * @param snapshot - The record.
   * @returns Nothing once the record is kept on the disk or its like.
   */
  put(ctx: TenantContext, snapshot: SealedSnapshot): Promise<void>;

  /**
   * Gives the records of the snapshot of a write of the tenant of the
   * context.
   *
   * @param ctx - The context of the call, for the tenant.
   * @param eventId - The ID of the audit event of the write.
   * @returns Its records, `before` first, or none when there is no
   *   snapshot of that write for the tenant, for example after its
   *   retention.
   */
  get(ctx: TenantContext, eventId: string): Promise<readonly SealedSnapshot[]>;

  /**
   * Removes the records of every day before the one given, for every
   * tenant of the store.
   *
   * @param day - The first UTC day whose records stay.
   * @returns How many records were removed. When one of them stays, the
   *   promise rejects, after every other was removed.
   */
  purgeBefore(day: IsoDate): Promise<number>;
}
