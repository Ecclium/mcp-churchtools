/**
 * What `ecclium audit verify` and `ecclium audit show` read the audit files
 * with, reached through the subpath `./audit` of core (ADR 0028): the
 * loader of their configuration, the reader of the folder `audit`, the
 * check of chains and anchors, the summary by day and tool, the form of an
 * ID typed by a person and the clock of the system.
 *
 * Only the commands of the command line may import this subpath, which a
 * rule of dependency-cruiser holds. The audit files name the IDs of the
 * persons whose data was read; through the entry point of core the reader
 * would reach tools, plugins and workflows, which import core. The tests of
 * core import the modules themselves.
 *
 * @packageDocumentation
 */
export {
  type AuditFileRead,
  type AuditFolder,
  type AuditFolderCode,
  auditFolderCodes,
  type AuditFolderResult,
  type AuditLine,
  openAuditFolder,
} from './audit/reader.js';
export {
  type AuditAnchor,
  type AuditAnchorCollector,
  type AuditAnchorSet,
  type AuditFinding,
  type AuditFindingKind,
  auditFindingKinds,
  type AuditVerifyReport,
  createAnchorCollector,
  maxAnchors,
  maxFindings,
  maxLogLineLength,
  verifyAuditFiles,
} from './audit/verify.js';
export {
  type AuditDayToolCounts,
  type AuditObjectHit,
  type AuditSummary,
  isUtcDay,
  maxShownHits,
  summarizeAuditFiles,
} from './audit/summary.js';
export { objectRefFromText } from './audit/object-ref.js';
export {
  type AuditConfig,
  type AuditConfigResult,
  loadAuditConfig,
} from './config/load.js';
export { systemClock } from './clock.js';
