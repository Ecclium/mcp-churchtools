/**
 * What the composition root builds the process from besides the entry
 * point of core, reached through the subpath `./composition` (ADR 0054):
 * the one stderr writer of the process, the logger and the audit sink that
 * write through it, the writer of the audit file over stdio (ADR 0028),
 * the clock of the system, the description of an error for the handlers
 * of the process, a logger bound to the tenant `default` for the
 * transport over stdio, and the provider of the keys for the pseudonyms
 * of the level `strict` (ADR 0069) and of the day keys for snapshots and
 * the queue, the store of the sealed records of snapshots and the keeper
 * that joins both into the snapshots of writes, the same for the queue of
 * approvals (ADR 0031), and the stores
 * of plans and nonces of the questions before a write, in memory (ADR
 * 0029).
 *
 * Only the composition root may import this subpath, which a rule of
 * dependency-cruiser holds. Through the entry point of core the writer
 * would reach tools and workflows, which import core, and they could write
 * any text to stderr. The tests of core import the modules themselves.
 *
 * @packageDocumentation
 */
export {
  type AuditChainAnchor,
  type AuditFileListener,
  type AuditFileResult,
  type AuditFileWriter,
  anchorEventOf,
  openAuditFile,
} from './audit/file-writer.js';
export { createAuditSink } from './audit/index.js';
export { systemClock } from './clock.js';
export { describeError } from './errors/index.js';
export {
  createFileDayKeys,
  type DayKeys,
  type FileDayKeysOptions,
  prepareDayKeyFolder,
} from './keys/day-keys.js';
export { createFileKeyProvider, type FileKeys } from './keys/file-provider.js';
// The private files the runner writes its drafts and notices to (ADR 0033).
export {
  type AppendLineOptions,
  appendPrivateLine,
  preparePrivateFolder,
  PrivateFileError,
  replacePrivateFile,
  type ReplaceOptions,
} from './files/index.js';
export {
  createLogger,
  createStderrWriter,
  type StderrLineWriter,
} from './logger/index.js';
export {
  createFileQuotaStore,
  type FileQuotaStoreOptions,
  prepareQuotaFolder,
} from './quota/index.js';
export {
  createFileApprovalQueue,
  createQueueKeeper,
  type FileApprovalQueueOptions,
  firstKeptQueueDay,
  prepareQueueFolder,
  type QueueKeeper,
  type QueuePurge,
} from './queue/index.js';
export {
  createFileSnapshotStore,
  createSnapshotKeeper,
  type FileSnapshotStoreOptions,
  prepareSnapshotFolder,
  type SnapshotKeeper,
  type SnapshotPurge,
} from './snapshots/index.js';
// The locks of the routines, which the composition root of the runner
// makes once per process and asks before each run (ADR 0034).
export {
  createRoutineLocks,
  type RoutineLock,
  type RoutineLockOptions,
  type RoutineLocks,
  routineLockLimits,
} from './schedule/lock.js';
export { createDefaultTenantLogger } from './tenant/default-logger.js';
export { createMemoryNonceStore } from './write/nonce-store.js';
export { createMemoryPlanStore } from './write/plan-store.js';
// The counter of the writes of a run, which the composition root makes
// once per run and hands on, like the stores (ADR 0032).
export { createRunWrites, type RunWrites } from './write/run-writes.js';
// The halt of writes of a process, which the composition root makes once
// and hands to every pipeline of the runner (ADR 0029). The runner reads it
// before a run that would write, so that a halted process neither reads
// for nor asks a model about a write it would refuse (ADR 0033). Reading
// it lifts nothing.
export {
  createWriteHalt,
  type WriteHalt,
  writesHalted,
} from './write/write-halt.js';
