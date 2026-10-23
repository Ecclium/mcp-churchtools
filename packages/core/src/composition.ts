/**
 * What the composition root builds the process from besides the entry
 * point of core, reached through the subpath `./composition` (ADR 0054):
 * the one stderr writer of the process, the logger and the audit sink that
 * write through it, the writer of the audit file over stdio (ADR 0028),
 * the clock of the system, the description of an error for the handlers
 * of the process, and a logger bound to the tenant `default` for the
 * transport over stdio.
 *
 * Only the composition root may import this subpath, which a rule of
 * dependency-cruiser holds. Through the entry point of core the writer
 * would reach tools and workflows, which import core, and they could write
 * any text to stderr. The tests of core import the modules themselves.
 *
 * @packageDocumentation
 */
export {
  type AuditFileResult,
  type AuditFileWriter,
  openAuditFile,
} from './audit/file-writer.js';
export { createAuditSink } from './audit/index.js';
export { systemClock } from './clock.js';
export { describeError } from './errors/index.js';
export {
  createLogger,
  createStderrWriter,
  type StderrLineWriter,
} from './logger/index.js';
export { createDefaultTenantLogger } from './tenant/default-logger.js';
