/**
 * The store of quotas of the free core and the daily read budget
 * (ADR 0063).
 *
 * @packageDocumentation
 */
export {
  createFileQuotaStore,
  type FileQuotaStoreOptions,
  lockWaitMs,
  maxQuotaActors,
  maxQuotaFileBytes,
  orphanLockMs,
  prepareQuotaDir,
  type QuotaDirCode,
  quotaDirCodes,
  quotaDirMode,
  quotaDirName,
  quotaFileMode,
  type QuotaFileStats,
  type QuotaFileSystem,
} from './file-store.js';
