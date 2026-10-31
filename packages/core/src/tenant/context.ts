/**
 * The tenant context of one call (ADR 0003, ADR 0055). The core makes a new
 * one for every call of a tool and checks every part on the way in, so that
 * whatever the context carries also passes the audit and is never one of
 * its placeholders. No entry of core exports this module: only the mount
 * and the pipeline make a context.
 *
 * @packageDocumentation
 */
import { isProxy } from 'node:util/types';

import type {
  Actor,
  ActorKind,
  Clock,
  FeatureKey,
  Mode,
  RedactionLevel,
  RunId,
  TenantAssignment,
  TenantContext,
  ToolName,
} from '@ecclium/mcp-churchtools-plugin-api';

import {
  actorKinds,
  auditFieldSchemas,
  auditPlaceholders,
} from '../audit/index.js';
import { parseChurchToolsOrigin } from '../http/index.js';
import {
  createLogger,
  isMode,
  isRedactionLevel,
  isToolName,
  isUuid,
  type LineWriter,
  type LogLevel,
} from '../logger/index.js';
import { toTenantId } from './tenant-id.js';

/** What the core passes to {@link createTenantContext}. */
export interface TenantContextOptions {
  /** Tenant and actor, from a `TenantResolver`. */
  readonly assignment: TenantAssignment;
  /** The checked origin of the instance, without a slash at the end. */
  readonly instance: string;
  /** How the call runs, set by the composition root only. */
  readonly mode: Mode;
  readonly redaction: RedactionLevel;
  readonly readOnly: boolean;
  /** Licensed features, empty in the free core. */
  readonly features: readonly FeatureKey[];
  /** A frozen clock whose own method is frozen as well. */
  readonly clock: Clock;
  /** The one part of the context that is not frozen. */
  readonly signal: AbortSignal;
  /** Where the log lines of the call go. It never reaches the context. */
  readonly logging: {
    readonly writer: LineWriter;
    readonly minLevel: LogLevel;
  };
  readonly runId?: RunId;
  /** The tool of the call, bound to its log lines only. */
  readonly tool?: ToolName;
  /** The audit event of the call, bound to its log lines only. */
  readonly eventId?: string;
}

/** The most features a context holds. */
export const maxFeatures = 64;

const maxFeatureLength = 64;

function fail(message: string): never {
  throw new TypeError(message);
}

// A plain object whose own properties can be read without running its
// code: no proxy, and Object.prototype or no prototype.
const isPlain = (value: unknown): value is object => {
  if (typeof value !== 'object' || value === null || isProxy(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

// An own data property, never through a getter. An accessor counts as
// absent, so the check of the field refuses it unread.
const ownData = (object: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor !== undefined && 'value' in descriptor
    ? (descriptor.value as unknown)
    : undefined;
};

// The actor as the audit takes it, copied, and never its placeholder.
const toActor = (value: unknown): Actor | undefined => {
  if (!isPlain(value)) return undefined;
  const kind = ownData(value, 'kind');
  const id = ownData(value, 'id');
  if (
    !(actorKinds as readonly unknown[]).includes(kind) ||
    typeof id !== 'string' ||
    id === auditPlaceholders.actor.id ||
    !auditFieldSchemas.actorId.safeParse(id).success
  ) {
    return undefined;
  }
  return Object.freeze({ __proto__: null, kind: kind as ActorKind, id });
};

const isFeature = (value: unknown): value is FeatureKey => {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maxFeatureLength
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
};

// A copy of a plain array of features. Each entry is read through its
// descriptor, so a hole or a getter refuses the list without running code,
// and a subclass or a proxy is refused whole.
const copyFeatures = (value: unknown): readonly FeatureKey[] | undefined => {
  if (
    typeof value !== 'object' ||
    value === null ||
    isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    return undefined;
  }
  const length = ownData(value, 'length');
  if (typeof length !== 'number' || length > maxFeatures) return undefined;
  const copy: FeatureKey[] = [];
  for (let index = 0; index < length; index += 1) {
    const entry = ownData(value, String(index));
    if (!isFeature(entry)) return undefined;
    copy.push(entry);
  }
  return Object.freeze(copy);
};

// Every context shares the clock, so the clock and its own method must be
// frozen: a value hung on either would pass from one call to the next, and
// a method on a prototype could still be swapped.
const isFrozenClock = (value: unknown): value is Clock => {
  if (!isPlain(value) || !Object.isFrozen(value)) return false;
  const now = ownData(value, 'now');
  return typeof now === 'function' && Object.isFrozen(now);
};

// A real AbortSignal, told by the getter on its prototype, which refuses
// any other object. instanceof alone passes an object made from the
// prototype.
const isAbortSignal = (value: unknown): value is AbortSignal => {
  if (
    typeof value !== 'object' ||
    value === null ||
    isProxy(value) ||
    !(value instanceof AbortSignal)
  ) {
    return false;
  }
  try {
    return (
      typeof Reflect.get(AbortSignal.prototype, 'aborted', value) === 'boolean'
    );
  } catch {
    return false;
  }
};

// An optional UUID, never the placeholder of the audit.
const isOptionalUuid = (value: unknown): boolean =>
  value === undefined || (isUuid(value) && value !== auditPlaceholders.eventId);

/**
 * Makes the context of one call. It checks every option and copies what a
 * caller could still change. The context, its actor, its features and its
 * logger are frozen and have no prototype where they are records. The
 * signal is not frozen: a frozen signal can no longer abort. The writer of
 * the log lines stays out of the context; its logger binds tenant, run,
 * mode, redaction, read-only, tool and event to every line.
 *
 * @param options - The parts of the context.
 * @returns The context.
 * @throws {TypeError} With a fixed message that never holds a value, when
 *   an option is not valid: a tenant or an actor that the audit refuses or
 *   that is its placeholder, an instance that is no checked origin, an
 *   unknown mode, an unknown redaction, a read-only flag that is
 *   no boolean, features that are no plain list of short visible names, a
 *   clock that is not frozen, a signal that is no AbortSignal, or a run,
 *   tool or event that does not fit.
 * @example
 * ```ts
 * const context = createTenantContext({
 *   assignment, instance: 'https://example.church.tools', mode: 'interactive',
 *   redaction: 'standard', readOnly: true, features: [], clock: systemClock,
 *   signal, logging: { writer, minLevel: 'info' },
 * });
 * ```
 */
export function createTenantContext(
  options: TenantContextOptions,
): TenantContext {
  if (!isPlain(options)) fail('The context options are invalid.');
  const assignment = ownData(options, 'assignment');
  if (!isPlain(assignment)) fail('The tenant is invalid.');
  const tenantId = toTenantId(ownData(assignment, 'tenantId'));
  if (tenantId === undefined) fail('The tenant is invalid.');
  const actor = toActor(ownData(assignment, 'actor'));
  if (actor === undefined) fail('The actor is invalid.');

  const instance = ownData(options, 'instance');
  const parsed =
    typeof instance === 'string' ? parseChurchToolsOrigin(instance) : undefined;
  if (parsed?.ok !== true || parsed.origin !== instance) {
    fail('The instance is not a checked origin.');
  }
  const mode = ownData(options, 'mode');
  if (!isMode(mode)) fail('The mode is unknown.');
  const redaction = ownData(options, 'redaction');
  if (!isRedactionLevel(redaction)) fail('The redaction level is unknown.');
  const readOnly = ownData(options, 'readOnly');
  if (typeof readOnly !== 'boolean') {
    fail('The read-only flag is not a boolean.');
  }
  const features = copyFeatures(ownData(options, 'features'));
  if (features === undefined) fail('The features are invalid.');
  const clock = ownData(options, 'clock');
  if (!isFrozenClock(clock)) fail('The clock and its method must be frozen.');
  const signal = ownData(options, 'signal');
  if (!isAbortSignal(signal)) fail('The signal is not an AbortSignal.');

  const runId = ownData(options, 'runId');
  if (!isOptionalUuid(runId)) fail('The run is invalid.');
  const tool = ownData(options, 'tool');
  if (
    tool !== undefined &&
    (!isToolName(tool) || tool === auditPlaceholders.tool)
  ) {
    fail('The tool is invalid.');
  }
  const eventId = ownData(options, 'eventId');
  if (!isOptionalUuid(eventId)) fail('The event is invalid.');

  const logging = ownData(options, 'logging');
  if (!isPlain(logging)) fail('The logging options are invalid.');
  const log = createLogger({
    writer: ownData(logging, 'writer') as LineWriter,
    clock,
    minLevel: ownData(logging, 'minLevel') as LogLevel,
    bound: {
      tenantId,
      runId: runId as RunId | undefined,
      eventId: eventId as string | undefined,
      tool,
      mode,
      redaction,
      readOnly,
    },
  });

  return Object.freeze({
    __proto__: null,
    tenantId,
    instance: parsed.origin,
    actor,
    mode,
    ...(runId === undefined ? {} : { runId: runId as RunId }),
    redaction,
    readOnly,
    features,
    clock,
    signal,
    log,
  });
}
