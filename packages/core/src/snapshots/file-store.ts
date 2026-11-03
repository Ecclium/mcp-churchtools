/**
 * The store of snapshots of the free core (ADR 0031): one file per tenant,
 * event and part in a folder per UTC day under the folder `snapshots` of
 * the folder of state, at
 * `<state>/snapshots/<day>/<tenant>.<event>.<part>.snapshot`, folders with
 * 0700, files with 0600. A file holds the sealed record and nothing else,
 * as the core encrypted it with the key of its snapshot, which the day key
 * of the day wraps. The store never holds a key, so a backup of the folder
 * of state holds nothing that can be read once the day key is destroyed.
 *
 * Where it stands in the way of a write: the write guard saves the part
 * `before` here just before the one request that writes, and the part
 * `after` once the write is read back; `ecclium undo` reads both by the ID
 * of the audit event of the write. A folder per day lets the retention
 * remove whole days.
 *
 * Every record is written once (files/): whole under a temporary name,
 * flushed, then given its name with `link`, which fails when the name is
 * taken, so that a second record of the same part never replaces the
 * first. Records of a day before the retention are destroyed with zeros
 * over the file and the removal of its name, then the empty folder of the
 * day goes. Nothing here names a path in what it throws.
 *
 * Only the composition root builds it, through the subpath `./composition`
 * of core.
 *
 * @packageDocumentation
 */
import { isProxy } from 'node:util/types';

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

import { isNormalizedAbsolutePath } from '../config/state-dir.js';
import {
  destroyPrivateFile,
  listPrivateFolder,
  nodePrivateFileSystem,
  preparePrivateFolder,
  PrivateFileError,
  type PrivateFileSystem,
  readPrivateFile,
  removePrivateFolder,
  writePrivateFileOnce,
} from '../files/index.js';
import { isTenantId, uuidPattern } from '../logger/index.js';

/** The name of the folder of snapshots in the folder of state. */
export const snapshotFolderName = 'snapshots';

/** What {@link createFileSnapshotStore} needs. */
export interface FileSnapshotStoreOptions {
  /** The checked folder of state, an absolute normalised path. */
  readonly stateDir: string;
  /** The ID of the process, part of the temporary names. */
  readonly pid: number;
  /** The file functions, only for tests. */
  readonly fs?: PrivateFileSystem;
}

// A record as a file: the tenant, the ID of the event and the part. Only
// such a name counts as a removed record.
const recordName =
  /^[a-z0-9][a-z0-9-]{0,62}\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:before|after)\.snapshot$/;

// Letters, digits, `-`, `_` and `.`, as the port asks. The length is
// checked first, so that the pattern never runs over a huge string.
const sealedPattern = /^[A-Za-z0-9_.-]+$/;

const isSealed = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= maxSealedSnapshotLength &&
  sealedPattern.test(value);

// An own data property of a plain object, never through a getter or a
// proxy, which could give another value on every read.
const ownData = (target: unknown, key: string): unknown => {
  if (typeof target !== 'object' || target === null || isProxy(target)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor !== undefined && 'value' in descriptor
    ? (descriptor.value as unknown)
    : undefined;
};

const tenantOf = (ctx: TenantContext): string => {
  const tenantId = ownData(ctx, 'tenantId');
  if (!isTenantId(tenantId)) throw new TypeError('The tenant is invalid.');
  return tenantId;
};

const checkEventId = (eventId: unknown): string => {
  if (
    typeof eventId !== 'string' ||
    eventId.length !== 36 ||
    !uuidPattern.test(eventId)
  ) {
    throw new TypeError('The ID of the event is invalid.');
  }
  return eventId;
};

const checkDay = (day: unknown): IsoDate => {
  if (!isIsoDate(day)) throw new TypeError('The day is invalid.');
  return day;
};

// Every field is read once, as an own data property, and checked before a
// name is built from it.
const checkSnapshot = (snapshot: unknown): SealedSnapshot => {
  const eventId = checkEventId(ownData(snapshot, 'eventId'));
  const part = ownData(snapshot, 'part');
  if (!(snapshotParts as readonly unknown[]).includes(part)) {
    throw new TypeError('The part is no part of a snapshot.');
  }
  const day = checkDay(ownData(snapshot, 'day'));
  const sealed = ownData(snapshot, 'sealed');
  if (!isSealed(sealed)) throw new TypeError('The sealed record is invalid.');
  return { eventId, part: part as SnapshotPart, day, sealed };
};

const folderOf = (stateDir: string): string =>
  `${stateDir === '/' ? '' : stateDir}/${snapshotFolderName}`;

const nameOf = (tenant: string, eventId: string, part: SnapshotPart) =>
  `${tenant}.${eventId}.${part}.snapshot`;

const checkStateDir = (stateDir: unknown): string => {
  if (typeof stateDir !== 'string' || !isNormalizedAbsolutePath(stateDir)) {
    throw new TypeError('The store of snapshots needs a folder of state.');
  }
  return stateDir;
};

/**
 * Prepares the folder of snapshots in the folder of state, for the start:
 * creates it with 0700 if it is missing and checks it. The folders of the
 * days come inside on demand.
 *
 * @param stateDir - The checked folder of state.
 * @param fs - The file functions, only for tests.
 * @throws {PrivateFileError} When the folder cannot be used.
 * @throws {TypeError} When the folder of state is no absolute normalised
 *   path.
 * @example
 * ```ts
 * prepareSnapshotFolder('/srv/ecclium');
 * ```
 */
export function prepareSnapshotFolder(
  stateDir: string,
  fs: PrivateFileSystem = nodePrivateFileSystem,
): void {
  preparePrivateFolder(folderOf(checkStateDir(stateDir)), fs);
}

/**
 * Makes the store of snapshots of the free core over the folder of state.
 * Every promise rejects with a `TypeError` for a tenant, event, part, day
 * or sealed record that does not fit, with a `PrivateFileError` when a
 * folder or a file cannot be used, `put` with an `Error` for a part that
 * is kept already, and `get` with an `Error` for a file that holds no
 * sealed record.
 *
 * @param options - The folder of state, the ID of the process and, for
 *   tests, the file functions.
 * @returns The store, frozen. It holds no record, only the folder.
 * @throws {TypeError} When the folder of state or the ID of the process is
 *   invalid.
 * @example
 * ```ts
 * const store = createFileSnapshotStore({ stateDir, pid: process.pid });
 * await store.put(ctx, { eventId, part: 'before', day, sealed });
 * ```
 */
export function createFileSnapshotStore(
  options: FileSnapshotStoreOptions,
): SnapshotStore {
  const stateDir = ownData(options, 'stateDir');
  const pid = ownData(options, 'pid');
  const fs = (ownData(options, 'fs') ??
    nodePrivateFileSystem) as PrivateFileSystem;
  checkStateDir(stateDir);
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1) {
    throw new TypeError('The store of snapshots needs a process.');
  }
  const folder = folderOf(stateDir as string);
  const dayFolderOf = (day: IsoDate): string => `${folder}/${day}`;

  // The folders of the days, oldest first. A name that is no day is no
  // folder of this store and stays as it is.
  const days = (): IsoDate[] => listPrivateFolder(folder, fs).filter(isIsoDate);

  const put = (ctx: TenantContext, snapshot: SealedSnapshot): void => {
    const tenant = tenantOf(ctx);
    const record = checkSnapshot(snapshot);
    const name = nameOf(tenant, record.eventId, record.part);
    // Only the folder of its day is looked at: an entry that stays in an
    // older folder must never stop a write, and the ID of an event is new
    // for every call, so the same part on another day does not come up.
    const dayFolder = dayFolderOf(record.day);
    // Only the folder of the day: the folder of snapshots is the start's,
    // and without it nothing is written.
    preparePrivateFolder(dayFolder, fs);
    const written = writePrivateFileOnce(
      dayFolder,
      name,
      Buffer.from(record.sealed, 'utf8'),
      { pid, fs },
    );
    // The first record stays; whatever the second holds is not compared.
    if (written === 'exists') {
      throw new Error('The part of the snapshot is kept already.');
    }
  };

  const get = (
    ctx: TenantContext,
    eventId: string,
  ): readonly SealedSnapshot[] => {
    const tenant = tenantOf(ctx);
    const checked = checkEventId(eventId);
    const found = days();
    const records: SealedSnapshot[] = [];
    // The parts outside, so that `before` comes first even when the part
    // `after` was saved on the next day.
    for (const part of snapshotParts) {
      for (const day of found) {
        const bytes = readPrivateFile(
          dayFolderOf(day),
          nameOf(tenant, checked, part),
          maxSealedSnapshotLength,
          fs,
        );
        if (bytes === undefined) continue;
        // One sign per byte, so that a byte outside the signs of a sealed
        // record never turns into one of them.
        const sealed = Buffer.from(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength,
        ).toString('latin1');
        if (!isSealed(sealed)) throw new Error('A snapshot is damaged.');
        records.push(Object.freeze({ eventId: checked, part, day, sealed }));
      }
    }
    return Object.freeze(records);
  };

  // Destroys every file in the folders of the days before the cut and then
  // the empty folders. An entry that stays does not stop the others: the
  // loop goes on and only afterwards reports that one stayed, so that a
  // single bad entry never keeps every later record (ADR 0031).
  const purgeBefore = (day: IsoDate): number => {
    const cut = checkDay(day);
    let removed = 0;
    let stayed = false;
    for (const name of days()) {
      if (name >= cut) continue;
      const dayFolder = dayFolderOf(name);
      try {
        // A name no private file may have, such as `.DS_Store` that a file
        // manager leaves, is refused by its form and stays, as a name of
        // another form does in the folder of the day keys. Its folder stays
        // with it, without failing the purge.
        let foreign = false;
        for (const entry of listPrivateFolder(dayFolder, fs)) {
          try {
            if (
              destroyPrivateFile(
                dayFolder,
                entry,
                maxSealedSnapshotLength,
                fs,
              ) &&
              recordName.test(entry)
            ) {
              removed += 1;
            }
          } catch (error) {
            if (error instanceof TypeError) foreign = true;
            else stayed = true;
          }
        }
        if (!foreign) removePrivateFolder(dayFolder, fs);
      } catch {
        stayed = true;
      }
    }
    if (stayed) throw new PrivateFileError('unsafe');
    return removed;
  };

  // Every refusal is a rejected promise, as for a store that keeps its
  // records elsewhere: what the executor throws rejects the promise.
  return Object.freeze({
    __proto__: null,
    put: (ctx: TenantContext, snapshot: SealedSnapshot): Promise<void> =>
      new Promise((resolve) => {
        put(ctx, snapshot);
        resolve();
      }),
    get: (
      ctx: TenantContext,
      eventId: string,
    ): Promise<readonly SealedSnapshot[]> =>
      new Promise((resolve) => {
        resolve(get(ctx, eventId));
      }),
    purgeBefore: (day: IsoDate): Promise<number> =>
      new Promise((resolve) => {
        resolve(purgeBefore(day));
      }),
  });
}
