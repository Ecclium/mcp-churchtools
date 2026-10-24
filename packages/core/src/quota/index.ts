/**
 * The store of quotas of the free core and the daily read budget
 * (ADR 0063).
 *
 * @packageDocumentation
 */
export { isoDateOf, quotaTimeoutMs, specialReadBudget } from './budget.js';
export {
  createFileQuotaStore,
  type FileQuotaStoreOptions,
  lockWaitMs,
  maxQuotaActors,
  maxQuotaFileBytes,
  orphanLockMs,
  prepareQuotaFolder,
  type QuotaFolderCode,
  quotaFolderCodes,
  quotaDirMode,
  quotaDirName,
  quotaFileMode,
  type QuotaFileStats,
  type QuotaFileSystem,
} from './file-store.js';
