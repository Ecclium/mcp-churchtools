/**
 * Audit: one JSON line per event with the fields of AuditEventV1, on the
 * same stream as the log lines and told apart from them by `v` and `type`
 * (ADR 0054).
 *
 * @packageDocumentation
 */
export {
  actorKinds,
  auditEventV1Schema,
  auditFieldSchemas,
  auditLimits,
  auditOutcomes,
  auditPlaceholders,
  confirmationPaths,
  objectDomains,
} from './schema.js';
export { type AuditFileCode, auditFileCodes } from './file-writer.js';
export {
  type AuditDraft,
  type AuditFileTarget,
  type AuditSink,
  type AuditSinkOptions,
  createAuditSink,
  type RecordOptions,
} from './sink.js';
