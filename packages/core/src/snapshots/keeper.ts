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

/** What {@link SnapshotKeeper.load} finds for the ID of a write. */
export type LoadedSnapshot =
  | { readonly kind: 'missing' }
  | { readonly kind: 'expired' }
  | {
      readonly kind: 'found';
      readonly before: SnapshotState;
      readonly after?: PageCreatedSnapshot;
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
   * @returns The parts, or why there are none: never kept, or past its
   *   retention.
   */
  load(ctx: TenantContext, eventId: string): Promise<LoadedSnapshot>;
  /**
   * Removes the records and destroys the day keys of the days before one.
   *
   * @param day - The first UTC day that stays.
   * @returns How many records went.
   */
  purgeBefore(day: IsoDate): Promise<number>;
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
      });
    },
    // Records first, then the keys: a record whose file stays is still
    // unreadable once its day key is gone.
    purgeBefore: async (day: IsoDate): Promise<number> => {
      let removed: number | undefined;
      try {
        removed = await store.purgeBefore(day);
      } finally {
        await keys.destroyBefore('snapshot', day);
      }
      return removed;
    },
  });
}
