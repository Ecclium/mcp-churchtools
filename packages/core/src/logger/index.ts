/**
 * Logger: writes JSON Lines with allowlisted fields to stderr. Apart from the
 * messages and start notices of the command line and the start of the
 * elicitation spike in testkit, it is the only code in the packages that
 * writes to stderr. It does not use `console` (ADR 0053).
 * Which events and fields a line may carry, and who may set them, is
 * decided in ADR 0054; the catalog lists every event.
 *
 * @packageDocumentation
 */
export {
  type AuditSinkEvent,
  type ChurchToolsMissingEvent,
  type ChurchToolsRefusedEvent,
  type ChurchToolsStatusEvent,
  type ChurchToolsTermEvent,
  type HttpFailureEvent,
  isLogEvent,
  type LogCallField,
  type LogEventEntry,
  logEvents,
  type LogEventName,
} from './catalog.js';
export {
  auditFileNamePattern,
  hostPattern,
  isAuditFileName,
  isBoolean,
  isErrorCode,
  isEventName,
  isIntegerIn,
  isMode,
  isRedactionLevel,
  isSha256,
  isTenantId,
  isToolName,
  isUuid,
  modes,
  redactionLevels,
  sha256Pattern,
  tenantIdPattern,
  timestampPattern,
  toolNamePattern,
  toTimestamp,
  uuidPattern,
} from './fields.js';
export {
  createStderrWriter,
  defaultMaxAttempts,
  isWritableLine,
  type LineWriter,
  type LineWriterStats,
  maxLineLength,
  type StderrLineWriter,
  type StderrWriterOptions,
  type WriteSyncFn,
} from './line-writer.js';
export {
  type BoundLogFields,
  createLogger,
  fallbackTimestamp,
  logFieldNames,
  type LoggerOptions,
  type LogLevel,
  logLevels,
  maxDropped,
  replacedEventName,
} from './logger.js';
