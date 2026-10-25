/**
 * Contract between the core and its plugins: tenant context, tool contract,
 * audit event and the port for quotas.
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
export {
  EccliumError,
  errorCodes,
  isEccliumError,
  type EccliumErrorOptions,
  type ErrorCode,
} from './errors.js';
export {
  classify,
  dataClasses,
  dataClassOf,
  type DataClass,
} from './data-class.js';
export {
  defineTool,
  type Exposure,
  type ObjectSchema,
  type ReadToolMeta,
  type ReplayGuard,
  type Reversible,
  type RightRef,
  type Sensitivity,
  type Tier,
  type ToolCall,
  type ToolDefinition,
  type ToolDescription,
  type ToolDomain,
  type ToolMeta,
  type ToolMetaCommon,
  type ToolName,
  type ToolSpec,
  type UnattendedRule,
  type WriteToolMeta,
} from './tool.js';
export {
  calendarDatePattern,
  groupMembersPageLimit,
  groupMemberStatusPattern,
  isWikiPageGuid,
  maxGroupMeetingTimeLength,
  maxGroupMembersPage,
  maxGroupNoteLength,
  maxNameLength,
  maxPersonGroups,
  maxSearchHits,
  maxSearchTermLength,
  maxWikiCategories,
  maxWikiListPage,
  maxWikiTitleLength,
  normalizeSearchTerm,
  wikiPageGuidPattern,
  wikiPageListLimit,
  type GrantedRights,
  type Group,
  type GroupDetails,
  type GroupHit,
  type GroupMember,
  type GroupMemberList,
  type Me,
  type Permissions,
  type Person,
  type PersonGroup,
  type PersonGroupList,
  type PersonHit,
  type ReadApi,
  type RightValue,
  type SearchHits,
  type WikiCategory,
  type WikiPage,
  type WikiPageEntry,
  type WikiPageList,
} from './read-api.js';
export type { Plugin, PluginHost } from './plugin.js';
export {
  isIsoDate,
  quotaKeys,
  type IsoDate,
  type QuotaKey,
  type QuotaStore,
} from './quota.js';
export type {
  AuditEventV1,
  AuditOutcome,
  AuditType,
  ConfirmationPath,
  ProviderInfo,
} from './audit.js';
