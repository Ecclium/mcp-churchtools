/**
 * Logger: writes JSON Lines with allowlisted fields to stderr. Apart from the
 * messages of the command line for operators, it is the only code in the
 * packages that writes to stderr. It does not use `console` (ADR 0053).
 * Which fields a line may carry, and who may set them, is decided in
 * ADR 0054.
 *
 * @packageDocumentation
 */
export {
  hostPattern,
  isBoolean,
  isErrorCode,
  isEventName,
  isIntegerIn,
  isMode,
  isRedactionLevel,
  isTenantId,
  isToolName,
  isUuid,
  modes,
  redactionLevels,
  tenantIdPattern,
  timestampPattern,
  toolNamePattern,
  toTimestamp,
  uuidPattern,
} from './fields.js';
export {
  createStderrWriter,
  defaultMaxAttempts,
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
  type LoggerOptions,
  type LogLevel,
  logLevels,
  maxDropped,
  replacedEventName,
} from './logger.js';
