/**
 * The deletion past the retention of the day keys of the snapshots and of
 * the queue of approvals, with their records and entries (ADR 0031): the
 * server over stdio, `ecclium run-once` and the daemon of the runner all
 * call it, at their start and, while they run, once on each new UTC day,
 * so that a runner on its own keeps the retention as the server does.
 *
 * Where it stands: in the composition root, beside the audit file, whose
 * writer deletes its own files past their retention. It touches the files
 * only through the keepers of core.
 *
 * @packageDocumentation
 */
import type { EccliumConfig } from '@ecclium/mcp-churchtools-core';
import {
  createFileApprovalQueue,
  createFileDayKeys,
  createFileKeyProvider,
  createFileSnapshotStore,
  createQueueKeeper,
  createSnapshotKeeper,
  type DayKeys,
  firstKeptQueueDay,
  type QueueKeeper,
  type SnapshotKeeper,
  type SnapshotPurge,
} from '@ecclium/mcp-churchtools-core/composition';
import {
  type Clock,
  type IsoDate,
  isIsoDate,
  type Logger,
} from '@ecclium/mcp-churchtools-plugin-api';

// Fixed events of the deletion. They carry a count only, never a path or
// the message of an error.
const dayKeysDestroyedEvent = 'day_keys_destroyed';
const dayKeysKeptEvent = 'day_keys_not_destroyed';
const snapshotsDeletedEvent = 'snapshots_deleted';
const snapshotsKeptEvent = 'snapshots_not_deleted';
const queueDeletedEvent = 'queue_entries_deleted';
const queueKeysDestroyedEvent = 'queue_day_keys_destroyed';
const queueKeptEvent = 'queue_not_purged';

// The highest count a log line takes.
const maxCount = 1_000_000;

const dayMs = 86_400_000;

/**
 * How many days after its own a snapshot stays readable: the day key of
 * the snapshots of a day is destroyed once 30 more days are over, so a
 * snapshot of a day D opens through D+30 and in no copy from D+31 on
 * (ADR 0031).
 */
export const snapshotRetentionDays = 30;

/**
 * The first UTC day whose day keys of snapshots stay at a time: the day of
 * the time less {@link snapshotRetentionDays}. Every day key of an earlier
 * day is past its retention.
 *
 * @param now - Milliseconds since the Unix epoch, from the clock.
 * @returns The day, or undefined when the time gives no day from 1970 to
 *   9999.
 * @example
 * ```ts
 * firstKeptSnapshotDay(Date.UTC(2026, 10, 3, 12)); // '2026-10-04'
 * ```
 */
export const firstKeptSnapshotDay = (now: number): IsoDate | undefined => {
  if (!Number.isFinite(now)) return undefined;
  // A day in UTC has no change of the clock, so 30 times its length back
  // is the same time of the day 30 days before.
  const cut = new Date(now - snapshotRetentionDays * dayMs);
  if (Number.isNaN(cut.getTime())) return undefined;
  const day = cut.toISOString().slice(0, 10);
  return isIsoDate(day) ? day : undefined;
};

/** The keepers whose files go past their retention. */
export interface RetentionKeepers {
  /** The day keys in the folder of keys. */
  readonly dayKeys: DayKeys | undefined;
  /** The snapshots of writes, over the folders of keys and of state. */
  readonly snapshots: SnapshotKeeper | undefined;
  /** The queue of approvals, over the folders of keys and of state. */
  readonly queue: QueueKeeper | undefined;
}

/**
 * Builds the keepers of the runner for the deletion alone: the day keys in
 * the folder of keys, and with the folder of state the snapshots and the
 * queue, without the keys of the pseudonyms. Each run builds its own for
 * its writes; these only delete.
 *
 * @param config - The configuration, with its folders.
 * @param clock - The clock of the core.
 * @returns The keepers; none without a folder of keys.
 * @example
 * ```ts
 * const sweep = createRetentionSweep({ ...composeRetentionKeepers(config, clock), clock, logger });
 * ```
 */
export function composeRetentionKeepers(
  config: Pick<EccliumConfig, 'keysDir' | 'stateDir'>,
  clock: Clock,
): RetentionKeepers {
  const { keysDir, stateDir } = config;
  if (keysDir === undefined) {
    return Object.freeze({
      dayKeys: undefined,
      snapshots: undefined,
      queue: undefined,
    });
  }
  const dayKeys = createFileDayKeys({ keysDir, pid: process.pid });
  if (stateDir === undefined) {
    return Object.freeze({ dayKeys, snapshots: undefined, queue: undefined });
  }
  const keys = createFileKeyProvider({ dayKeys });
  return Object.freeze({
    dayKeys,
    snapshots: createSnapshotKeeper({
      keys,
      store: createFileSnapshotStore({ stateDir, pid: process.pid }),
    }),
    queue: createQueueKeeper({
      keys,
      store: createFileApprovalQueue({ stateDir, pid: process.pid }),
      clock,
    }),
  });
}

/** What the deletion is built from. */
export interface RetentionSweepOptions extends RetentionKeepers {
  readonly clock: Clock;
  /** The logger of the process, at the level info at least. */
  readonly logger: Logger;
}

/**
 * Builds the deletion past the retention. With the folder of state, the
 * keeper of the snapshots removes the records of the days past 30 days
 * and destroys their day keys, also while the process only reads or keeps
 * no snapshots; without that folder the day keys alone go, so that keys
 * of an earlier run that wrote still go in time. The entries of the queue
 * past 14 days go the same way, with their day keys `queue` (ADR 0031).
 * One line counts the records, another the day keys, and a day whose
 * records or keys could not all go is tried again at the next call.
 *
 * @param options - The keepers, the clock and the logger.
 * @returns A function that deletes, at most once per day and never twice
 *   at once, and never throws; undefined without a folder of keys.
 * @example
 * ```ts
 * const sweep = createRetentionSweep({ dayKeys, snapshots, queue, clock, logger });
 * sweep?.();
 * ```
 */
export function createRetentionSweep(
  options: RetentionSweepOptions,
): (() => void) | undefined {
  const { dayKeys, snapshots, queue, clock, logger } = options;
  if (dayKeys === undefined) return undefined;
  const keysAlone =
    (purpose: 'snapshot' | 'queue') =>
    (cut: IsoDate): Promise<SnapshotPurge> =>
      dayKeys.destroyBefore(purpose, cut).then(
        (count) => ({ records: 0, dayKeys: count, complete: true }),
        () => ({ records: 0, dayKeys: 0, complete: false }),
      );
  const purge: (cut: IsoDate) => Promise<SnapshotPurge> =
    snapshots === undefined
      ? keysAlone('snapshot')
      : (cut) => snapshots.purgeBefore(cut);
  const purgeQueue: (cut: IsoDate) => Promise<SnapshotPurge> =
    queue === undefined ? keysAlone('queue') : (cut) => queue.purgeBefore(cut);
  // Only a count the logger takes, and never more than it takes.
  const countOf = (count: number): number | undefined =>
    Number.isSafeInteger(count) && count > 0
      ? Math.min(count, maxCount)
      : undefined;
  // One sweep of what is past its retention, at most once per cut and
  // again at the next call after a failure. The lines name a count only,
  // never a path or the message of an error.
  const sweeper = (sweep: {
    readonly purge: (cut: IsoDate) => Promise<SnapshotPurge>;
    readonly cutOf: (now: number) => IsoDate | undefined;
    readonly deleted: typeof snapshotsDeletedEvent | typeof queueDeletedEvent;
    readonly destroyed:
      typeof dayKeysDestroyedEvent | typeof queueKeysDestroyedEvent;
    readonly kept:
      | typeof dayKeysKeptEvent
      | typeof snapshotsKeptEvent
      | typeof queueKeptEvent;
  }): (() => void) => {
    let sweptFor: IsoDate | undefined;
    let sweeping = false;
    return (): void => {
      let now = Number.NaN;
      try {
        now = clock.now();
      } catch {
        // No day without the clock, which the line below says.
      }
      const cut = sweep.cutOf(now);
      if (cut === undefined) {
        logger.warn(sweep.kept);
        return;
      }
      if (sweeping || cut === sweptFor) return;
      sweeping = true;
      // A promise that rejected is caught here: unhandled, it would end
      // the process through its handler.
      void Promise.resolve()
        .then(() => sweep.purge(cut))
        .then(
          (result) => {
            const records = countOf(result.records);
            if (records !== undefined) {
              logger.info(sweep.deleted, { count: records });
            }
            const keys = countOf(result.dayKeys);
            if (keys !== undefined) {
              logger.info(sweep.destroyed, { count: keys });
            }
            if (result.complete) {
              sweptFor = cut;
            } else {
              logger.warn(sweep.kept);
            }
          },
          () => {
            logger.warn(sweep.kept);
          },
        )
        .catch(() => undefined)
        .finally(() => {
          sweeping = false;
        });
    };
  };
  const sweepSnapshots = sweeper({
    purge,
    cutOf: firstKeptSnapshotDay,
    deleted: snapshotsDeletedEvent,
    destroyed: dayKeysDestroyedEvent,
    kept: snapshots === undefined ? dayKeysKeptEvent : snapshotsKeptEvent,
  });
  const sweepQueue = sweeper({
    purge: purgeQueue,
    cutOf: firstKeptQueueDay,
    deleted: queueDeletedEvent,
    destroyed: queueKeysDestroyedEvent,
    kept: queueKeptEvent,
  });
  return (): void => {
    sweepSnapshots();
    sweepQueue();
  };
}
