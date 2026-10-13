/**
 * The audit event, version 1.
 *
 * @packageDocumentation
 */

import type { Actor, Mode } from './context.js';
import type { ErrorCode } from './errors.js';

/** What an audit event records. Grows with the phases that add actions. */
export type AuditType = 'tool_call';

/**
 * How an action ended: done, failed with an error code, or refused before it
 * ran, for example by the read-only switch or a policy.
 */
export type AuditOutcome = 'ok' | 'error' | 'denied';

/** How a write was confirmed: by the client, by echo, by policy or by the operator. */
export type ConfirmationPath = 'elicitation' | 'echo' | 'policy' | 'operator';

/** The language model a run of the runner used, as its configuration names it. */
export interface ProviderInfo {
  /** Vendor of the model. */
  readonly vendor: string;
  /** Name of the model at the vendor. */
  readonly model: string;
  /** Country where the model is hosted. */
  readonly hostingCountry: string;
  /** Host name of the endpoint, never a URL with a path or a key. */
  readonly endpointHost: string;
  /** Legal basis of a transfer outside Switzerland and the EEA. */
  readonly transferBasis?: string;
}

/**
 * One entry of the audit: who did what for which tenant, and how it ended.
 *
 * It never holds content: no response bodies, no personal data except IDs
 * of affected objects, no tokens. Fields are added only as optional ones, so
 * that every reader of version 1 keeps working.
 */
export interface AuditEventV1 {
  /** Version of the event format. */
  readonly v: 1;
  /** Unique ID of the event. */
  readonly eventId: string;
  /** Time of the event in ISO 8601, in UTC. */
  readonly ts: string;
  /** What the event records. */
  readonly type: AuditType;
  /** The tenant. */
  readonly tenantId: string;
  /** Who acted. */
  readonly actor: Actor;
  /** How the request ran. */
  readonly mode: Mode;
  /** The run of the runner, if any. */
  readonly runId?: string;
  /** The routine of the run, if any. */
  readonly routineId?: string;
  /** Name of the tool, if the event concerns one. */
  readonly tool?: string;
  /** How the action ended. */
  readonly outcome: AuditOutcome;
  /** How a write was confirmed, for writes only. */
  readonly confirmation?: ConfirmationPath;
  /** Hash of the policy in force, for runs of the runner. */
  readonly policyHash?: string;
  /** The language model of a run, if it used one. */
  readonly provider?: ProviderInfo;
  /** Hashes of the loaded plugins. */
  readonly pluginHashes?: readonly string[];
  /** Data protection law that applies to the tenant, in hosted operation. */
  readonly dataProtectionRegime?: string;
  /** IDs of the affected objects, never names or content. */
  readonly objectRefs: readonly string[];
  /** Code of the error when the outcome is `error` or `denied`. */
  readonly errorCode?: ErrorCode;
  /** Duration of the action in milliseconds. */
  readonly durationMs: number;
  /** Position in a hash chain, set only by a sink that chains, never by the producer. */
  readonly seq?: number;
  /** Hash of the previous event in the chain, set only by a sink that chains. */
  readonly prevHash?: string;
}
