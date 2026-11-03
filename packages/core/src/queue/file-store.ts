/**
 * The queue of approvals of the free core as files (ADR 0031): per tenant
 * and entry one file for the sealed entry and, once the operator decided,
 * one for the decision, in a folder per UTC day under the folder `queue`
 * of the folder of state, at `<state>/queue/<day>/<tenant>.<id>.entry` and
 * `<tenant>.<id>.decision`, folders with 0700, files with 0600. An entry
 * holds the sealed record and nothing else, as the core encrypted it with
 * a key of its own that the day key `queue` of its day wraps, and the
 * store never holds a key. A decision holds no content: what was decided
 * and when, as JSON.
 *
 * Where it stands in the way of a write: the pipeline queues a write here
 * that no person can confirm in the client or that the policy sends here;
 * `ecclium queue` lists and shows the entries and keeps a decision, after
 * which the entry is destroyed. A folder per day lets the retention remove
 * whole days.
 *
 * Every file is written once (files/): whole under a temporary name,
 * flushed, then given its name with `link`, which fails when the name is
 * taken. No file ever changes, so no lock file is needed: an entry is put
 * once and destroyed once, and of two decisions about the same entry only
 * the first gets its name, also in two processes (ADR 0031). Entries and
 * decisions of a day before the retention are destroyed with zeros over
 * the file and the removal of its name, then the empty folder of the day
 * goes. Nothing here names a path in what it throws.
 *
 * Only the composition root builds it, through the subpath `./composition`
 * of core.
 *
 * @packageDocumentation
 */
import { isProxy } from 'node:util/types';

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
import { isTenantId, timestampPattern, uuidPattern } from '../logger/index.js';

/** The name of the folder of the queue in the folder of state. */
export const queueFolderName = 'queue';

/** What {@link createFileApprovalQueue} needs. */
export interface FileApprovalQueueOptions {
  /** The checked folder of state, an absolute normalised path. */
  readonly stateDir: string;
  /** The ID of the process, part of the temporary names. */
  readonly pid: number;
  /** The file functions, only for tests. */
  readonly fs?: PrivateFileSystem;
}

// An item as a file: the tenant, the ID of the entry and what it holds.
// Only such a name counts as a removed item.
const itemName =
  /^[a-z0-9][a-z0-9-]{0,62}\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:entry|decision)$/;

// The largest file of a decision: a small JSON object.
const maxDecisionBytes = 256;

// Letters, digits, `-`, `_` and `.`, as the port asks. The length is
// checked first, so that the pattern never runs over a huge string.
const sealedPattern = /^[A-Za-z0-9_.-]+$/;

const isSealed = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= maxSealedQueueEntryLength &&
  sealedPattern.test(value);

// A time as the audit writes it: ISO 8601 with milliseconds in UTC.
const isTime = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length === 24 &&
  timestampPattern.test(value);

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

const checkId = (id: unknown): string => {
  if (typeof id !== 'string' || id.length !== 36 || !uuidPattern.test(id)) {
    throw new TypeError('The ID of the entry is invalid.');
  }
  return id;
};

const checkDay = (day: unknown): IsoDate => {
  if (!isIsoDate(day)) throw new TypeError('The day is invalid.');
  return day;
};

// Every field is read once, as an own data property, and checked before a
// name is built from it.
const checkEntry = (entry: unknown): SealedQueueEntry => {
  const id = checkId(ownData(entry, 'id'));
  const day = checkDay(ownData(entry, 'day'));
  const sealed = ownData(entry, 'sealed');
  if (!isSealed(sealed)) throw new TypeError('The sealed entry is invalid.');
  return { id, day, sealed };
};

const checkDecision = (decision: unknown): QueueDecision => {
  const id = checkId(ownData(decision, 'id'));
  const day = checkDay(ownData(decision, 'day'));
  const kind = ownData(decision, 'decision');
  const decidedAt = ownData(decision, 'decidedAt');
  if (!(queueDecisionKinds as readonly unknown[]).includes(kind)) {
    throw new TypeError('The decision is invalid.');
  }
  if (!isTime(decidedAt)) throw new TypeError('The time is invalid.');
  return { id, day, decision: kind as QueueDecisionKind, decidedAt };
};

const folderOf = (stateDir: string): string =>
  `${stateDir === '/' ? '' : stateDir}/${queueFolderName}`;

const entryName = (tenant: string, id: string) => `${tenant}.${id}.entry`;
const decisionName = (tenant: string, id: string) => `${tenant}.${id}.decision`;

const checkStateDir = (stateDir: unknown): string => {
  if (typeof stateDir !== 'string' || !isNormalizedAbsolutePath(stateDir)) {
    throw new TypeError('The queue needs a folder of state.');
  }
  return stateDir;
};

// One sign per byte, so that a byte outside the signs of a sealed entry
// never turns into one of them.
const latin1 = (bytes: Uint8Array): string =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    'latin1',
  );

/**
 * Prepares the folder of the queue in the folder of state, for the start:
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
 * prepareQueueFolder('/srv/ecclium');
 * ```
 */
export function prepareQueueFolder(
  stateDir: string,
  fs: PrivateFileSystem = nodePrivateFileSystem,
): void {
  preparePrivateFolder(folderOf(checkStateDir(stateDir)), fs);
}

/**
 * Makes the queue of approvals of the free core over the folder of state.
 * Every promise rejects with a `TypeError` for a tenant, ID, day, sealed
 * entry or decision that does not fit, with a `PrivateFileError` when a
 * folder or a file cannot be used, `put` with an `Error` for an entry that
 * is kept or decided already, `decide` with an `Error` for an entry that
 * is decided already or not there, and `list` and `get` with an `Error`
 * for a file that holds no sealed entry or no decision.
 *
 * @param options - The folder of state, the ID of the process and, for
 *   tests, the file functions.
 * @returns The queue, frozen. It holds no entry, only the folder.
 * @throws {TypeError} When the folder of state or the ID of the process is
 *   invalid.
 * @example
 * ```ts
 * const queue = createFileApprovalQueue({ stateDir, pid: process.pid });
 * await queue.put(ctx, { id, day, sealed });
 * ```
 */
export function createFileApprovalQueue(
  options: FileApprovalQueueOptions,
): ApprovalQueue {
  const stateDir = ownData(options, 'stateDir');
  const pid = ownData(options, 'pid');
  const fs = (ownData(options, 'fs') ??
    nodePrivateFileSystem) as PrivateFileSystem;
  checkStateDir(stateDir);
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1) {
    throw new TypeError('The queue needs a process.');
  }
  const folder = folderOf(stateDir as string);
  const dayFolderOf = (day: IsoDate): string => `${folder}/${day}`;

  // The folders of the days, oldest first. A name that is no day is no
  // folder of this store and stays as it is.
  const days = (): IsoDate[] => listPrivateFolder(folder, fs).filter(isIsoDate);

  const readEntry = (
    tenant: string,
    id: string,
    day: IsoDate,
  ): SealedQueueEntry | undefined => {
    const bytes = readPrivateFile(
      dayFolderOf(day),
      entryName(tenant, id),
      maxSealedQueueEntryLength,
      fs,
    );
    if (bytes === undefined) return undefined;
    const sealed = latin1(bytes);
    if (!isSealed(sealed)) throw new Error('An entry of the queue is damaged.');
    return Object.freeze({ id, day, sealed });
  };

  const readDecision = (
    tenant: string,
    id: string,
    day: IsoDate,
  ): QueueDecision | undefined => {
    const bytes = readPrivateFile(
      dayFolderOf(day),
      decisionName(tenant, id),
      maxDecisionBytes,
      fs,
    );
    if (bytes === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(latin1(bytes));
    } catch {
      throw new Error('A decision of the queue is damaged.');
    }
    const keys =
      typeof parsed === 'object' && parsed !== null
        ? Object.keys(parsed).sort().join(',')
        : '';
    const kind = ownData(parsed, 'decision');
    const decidedAt = ownData(parsed, 'decidedAt');
    if (
      keys !== 'decidedAt,decision,v' ||
      ownData(parsed, 'v') !== 1 ||
      !(queueDecisionKinds as readonly unknown[]).includes(kind) ||
      !isTime(decidedAt)
    ) {
      throw new Error('A decision of the queue is damaged.');
    }
    return Object.freeze({
      id,
      day,
      decision: kind as QueueDecisionKind,
      decidedAt,
    });
  };

  const itemOf = (
    tenant: string,
    id: string,
    day: IsoDate,
  ): QueueItem | undefined => {
    const entry = readEntry(tenant, id, day);
    const decision = readDecision(tenant, id, day);
    if (entry === undefined && decision === undefined) return undefined;
    return Object.freeze({
      id,
      day,
      ...(entry === undefined ? {} : { entry }),
      ...(decision === undefined ? {} : { decision }),
    });
  };

  const put = (ctx: TenantContext, value: SealedQueueEntry): void => {
    const tenant = tenantOf(ctx);
    const entry = checkEntry(value);
    const dayFolder = dayFolderOf(entry.day);
    // Only the folder of the day: the folder of the queue is the start's,
    // and without it nothing is queued.
    preparePrivateFolder(dayFolder, fs);
    // An ID that was decided stays decided: its entry is not put again.
    if (readDecision(tenant, entry.id, entry.day) !== undefined) {
      throw new Error('The entry is decided already.');
    }
    const written = writePrivateFileOnce(
      dayFolder,
      entryName(tenant, entry.id),
      Buffer.from(entry.sealed, 'utf8'),
      { pid, fs },
    );
    // The first entry stays; whatever the second holds is not compared.
    if (written === 'exists') throw new Error('The entry is kept already.');
  };

  const list = (ctx: TenantContext): readonly QueueItem[] => {
    const tenant = tenantOf(ctx);
    const prefix = `${tenant}.`;
    const items: QueueItem[] = [];
    for (const day of days()) {
      const ids = new Set<string>();
      for (const name of listPrivateFolder(dayFolderOf(day), fs)) {
        // Only names of this store and of this tenant: a tenant holds no
        // dot, so the first dot of a name ends its tenant.
        if (!name.startsWith(prefix) || !itemName.test(name)) continue;
        ids.add(name.slice(prefix.length, prefix.length + 36));
      }
      for (const id of [...ids].sort()) {
        const item = itemOf(tenant, id, day);
        if (item !== undefined) items.push(item);
      }
    }
    return Object.freeze(items);
  };

  const get = (ctx: TenantContext, id: string): QueueItem | undefined => {
    const tenant = tenantOf(ctx);
    const checked = checkId(id);
    for (const day of days()) {
      const item = itemOf(tenant, checked, day);
      if (item !== undefined) return item;
    }
    return undefined;
  };

  const decide = (ctx: TenantContext, value: QueueDecision): void => {
    const tenant = tenantOf(ctx);
    const decision = checkDecision(value);
    // A day without its folder holds no entry; the folder is not made.
    if (!days().includes(decision.day)) {
      throw new Error('There is no entry to decide.');
    }
    const dayFolder = dayFolderOf(decision.day);
    const name = entryName(tenant, decision.id);
    const entry = readEntry(tenant, decision.id, decision.day);
    if (entry === undefined) {
      throw new Error(
        readDecision(tenant, decision.id, decision.day) === undefined
          ? 'There is no entry to decide.'
          : 'The entry is decided already.',
      );
    }
    const written = writePrivateFileOnce(
      dayFolder,
      decisionName(tenant, decision.id),
      Buffer.from(
        JSON.stringify({
          v: 1,
          decision: decision.decision,
          decidedAt: decision.decidedAt,
        }),
        'utf8',
      ),
      { pid, fs },
    );
    // The content goes once the decision has its name, and also after a
    // second decision, so that whatever a stop between the two left is
    // gone now (ADR 0031).
    destroyPrivateFile(dayFolder, name, maxSealedQueueEntryLength, fs);
    if (written === 'exists') throw new Error('The entry is decided already.');
  };

  // Destroys every file in the folders of the days before the cut and then
  // the empty folders. An entry that stays does not stop the others: the
  // loop goes on and only afterwards reports that one stayed, so that a
  // single bad entry never keeps every later one (ADR 0031).
  const purgeBefore = (day: IsoDate): number => {
    const cut = checkDay(day);
    let removed = 0;
    let stayed = false;
    for (const name of days()) {
      if (name >= cut) continue;
      const dayFolder = dayFolderOf(name);
      try {
        // A name no private file may have, such as `.DS_Store` that a file
        // manager leaves, is refused by its form and stays with its folder,
        // without failing the purge.
        let foreign = false;
        for (const entry of listPrivateFolder(dayFolder, fs)) {
          try {
            if (
              destroyPrivateFile(
                dayFolder,
                entry,
                maxSealedQueueEntryLength,
                fs,
              ) &&
              itemName.test(entry)
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
  // entries elsewhere: what the executor throws rejects the promise.
  return Object.freeze({
    __proto__: null,
    put: (ctx: TenantContext, entry: SealedQueueEntry): Promise<void> =>
      new Promise((resolve) => {
        put(ctx, entry);
        resolve();
      }),
    list: (ctx: TenantContext): Promise<readonly QueueItem[]> =>
      new Promise((resolve) => {
        resolve(list(ctx));
      }),
    get: (ctx: TenantContext, id: string): Promise<QueueItem | undefined> =>
      new Promise((resolve) => {
        resolve(get(ctx, id));
      }),
    decide: (ctx: TenantContext, decision: QueueDecision): Promise<void> =>
      new Promise((resolve) => {
        decide(ctx, decision);
        resolve();
      }),
    purgeBefore: (day: IsoDate): Promise<number> =>
      new Promise((resolve) => {
        resolve(purgeBefore(day));
      }),
  });
}
