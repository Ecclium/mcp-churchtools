/**
 * The snapshots of writes as the composition root hands them to the
 * pipeline (ADR 0031): the provider of keys and a store, joined. Where it
 * stands in the way of a write: the write guard saves a part through
 * `save` right before the send; `ecclium undo` loads a snapshot through
 * `load`; the start and the day timer remove what is past its retention
 * through `purgeBefore`, records and day keys alike.
 *
 * It holds no state of its own beyond the two ports it was given.
 *
 * @packageDocumentation
 */
import type {
  IsoDate,
  KeyProvider,
  SnapshotStore,
  TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';

import {
  openSnapshot,
  type PageCreatedSnapshot,
  sealSnapshot,
  type SnapshotState,
  type SnapshotToSeal,
} from './seal.js';

/**
 * What {@link SnapshotKeeper.load} finds for the ID of a write: `missing`
 * when no part `before` is kept, because the write kept none or its
 * records went after their retention; `expired` when the record is still
 * there but its day key is gone, so that it opens no more; `found` with
 * the parts that open.
 */
export type LoadedSnapshot =
  | { readonly kind: 'missing' }
  | { readonly kind: 'expired' }
  | {
      readonly kind: 'found';
      readonly before: SnapshotState;
      readonly after?: PageCreatedSnapshot;
      /** The UTC day of the part before, the day of the write. */
      readonly day: IsoDate;
    };

/** The snapshots of writes over a provider of keys and a store. */
export interface SnapshotKeeper {
  /**
   * Seals a part of a snapshot and keeps it.
   *
   * @param ctx - The context of the write.
   * @param snapshot - Event, part, day and content.
   * @returns Nothing once the part is kept.
   */
  save(ctx: TenantContext, snapshot: SnapshotToSeal): Promise<void>;
  /**
   * Finds and opens the snapshot of a write of the tenant of the context.
   *
   * @param ctx - The context, for tenant and instance.
   * @param eventId - The ID of the audit event of the write.
   * @returns The parts, or why there are none, see {@link LoadedSnapshot}.
   */
  load(ctx: TenantContext, eventId: string): Promise<LoadedSnapshot>;
  /**
   * Removes the records and destroys the day keys of the days before one.
   * It never rejects: what could not go is in the result.
   *
   * @param day - The first UTC day that stays.
   * @returns How many records and day keys went, and whether all did.
   */
  purgeBefore(day: IsoDate): Promise<SnapshotPurge>;
}

/** What {@link SnapshotKeeper.purgeBefore} removed. */
export interface SnapshotPurge {
  /** How many records went, as far as the store could count them. */
  readonly records: number;
  /** How many day keys of snapshots went, as far as they were counted. */
  readonly dayKeys: number;
  /**
   * Whether the store and the provider of keys both removed everything
   * before the day. When not, the start tries again later, and a count
   * of the half that failed is 0, because a refusal carries none.
   */
  readonly complete: boolean;
}

const missing: LoadedSnapshot = Object.freeze({ kind: 'missing' });
const expired: LoadedSnapshot = Object.freeze({ kind: 'expired' });

/**
 * Joins a provider of keys and a store into the snapshots of writes.
 *
 * @param ports - The provider of keys with the day keys, and the store.
 * @param ports.keys - The provider of keys.
 * @param ports.store - The store of sealed records.
 * @returns The snapshots, frozen.
 * @example
 * ```ts
 * const snapshots = createSnapshotKeeper({ keys, store });
 * await snapshots.save(ctx, { eventId, part: 'before', day, content });
 * ```
 */
export function createSnapshotKeeper(ports: {
  readonly keys: KeyProvider;
  readonly store: SnapshotStore;
}): SnapshotKeeper {
  const { keys, store } = ports;
  return Object.freeze({
    save: async (ctx: TenantContext, snapshot: SnapshotToSeal) => {
      await store.put(ctx, await sealSnapshot(keys, ctx, snapshot));
    },
    load: async (
      ctx: TenantContext,
      eventId: string,
    ): Promise<LoadedSnapshot> => {
      const records = await store.get(ctx, eventId);
      const first = records.find((record) => record.part === 'before');
      if (first === undefined) return missing;
      const before = await openSnapshot(keys, ctx, first);
      if (before === undefined) return expired;
      const second = records.find((record) => record.part === 'after');
      const after =
        second === undefined
          ? undefined
          : await openSnapshot(keys, ctx, second);
      return Object.freeze({
        kind: 'found',
        // openSnapshot gives a part before only as a state (seal.ts).
        before: before as SnapshotState,
        ...(after?.kind === 'wikiPageCreated' ? { after } : {}),
        day: first.day,
      });
    },
    // Records first, then the keys, also when the records could not all
    // go: a record whose file stays is still unreadable once its day key
    // is gone. Both counts are kept, so that a day key without a record
    // is reported too.
    purgeBefore: async (day: IsoDate): Promise<SnapshotPurge> => {
      const records = await store.purgeBefore(day).then(
        (count) => count,
        () => undefined,
      );
      const dayKeys = await keys.destroyBefore('snapshot', day).then(
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
