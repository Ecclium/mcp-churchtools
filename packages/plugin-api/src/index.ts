/**
 * Contract between the core and its plugins: tenant context, tool contract
 * and audit event.
 *
 * Published separately, with its own semantic version, so that a plugin can
 * be built against this package alone. It imports no other workspace package
 * and keeps no module-level state: every plugin brings its own copy, and all
 * copies must still agree on brands and registries.
 * Exports carry explicit types (isolatedDeclarations), so the published API
 * is visible in the source and cannot change through inference elsewhere
 * (ADR 0022).
 *
 * @packageDocumentation
 */
export type {
  Actor,
  ActorKind,
  FeatureKey,
  Identity,
  IdentitySource,
  Mode,
  RedactionLevel,
  RunId,
  Scope,
  TenantAssignment,
  TenantContext,
  TenantId,
  TenantResolver,
} from './context.js';
export type { Clock, LogFields, Logger, LogValue } from './logger.js';
export { errorCodes, type ErrorCode } from './errors.js';
export {
  classify,
  dataClasses,
  dataClassOf,
  type DataClass,
} from './data-class.js';
export type {
  AuditEventV1,
  AuditOutcome,
  AuditType,
  ConfirmationPath,
  ProviderInfo,
} from './audit.js';
