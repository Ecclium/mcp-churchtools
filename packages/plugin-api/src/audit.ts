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

/**
 * The state of a write at the end of a call (ADR 0029): planned and
 * waiting for a confirmation, queued for the operator, written and read
 * back, not needed, refused, ended in a conflict, failed, or taken back
 * after a failure in a run. The outcome of the line follows from it:
 * `ok` for the first four, `denied` for `denied`, `error` for the rest.
 */
export type WriteState =
  | 'planned'
  | 'queued'
  | 'verified'
  | 'skipped'
  | 'denied'
  | 'conflict'
  | 'failed'
  | 'rolledBack';

/** One reason why the content policy of the core refuses a text (ADR 0030). */
export type ContentViolationKind =
  | 'tooLong'
  | 'unparsable'
  | 'html'
  | 'image'
  | 'link'
  | 'mention'
  | 'reference'
  | 'webAddress'
  | 'contact'
  | 'masked'
  | 'unsupported'
  | 'tooDeep';

/**
 * Every {@link ContentViolationKind}, in a fixed order. Readers of the
 * audit see these names, never the text.
 */
export const contentViolationKinds: readonly ContentViolationKind[] =
  Object.freeze([
    'tooLong',
    'unparsable',
    'html',
    'image',
    'link',
    'mention',
    'reference',
    'webAddress',
    'contact',
    'masked',
    'unsupported',
    'tooDeep',
  ]);

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
  /** The state of a write at the end of the call, for writes only. */
  readonly writeState?: WriteState;
  /**
   * Hash of the policy in force, for every call of a write tool and later
   * for runs of the runner.
   */
  readonly policyHash?: string;
  /** The language model of a run, if it used one. */
  readonly provider?: ProviderInfo;
  /** Hashes of the loaded plugins. */
  readonly pluginHashes?: readonly string[];
  /** Data protection law that applies to the tenant, in hosted operation. */
  readonly dataProtectionRegime?: string;
  /**
   * IDs of the objects a call asks for and of the persons and groups its
   * result names, as `<domain>:<ID>`, never names or content. Only the
   * audit file holds them; the copy on the stream of the logger has an
   * empty list (ADR 0028).
   */
  readonly objectRefs: readonly string[];
  /**
   * How many further IDs the call named beyond the 100 in `objectRefs`,
   * only in the audit file.
   */
  readonly objectRefsOmitted?: number;
  /** Code of the error when the outcome is `error` or `denied`. */
  readonly errorCode?: ErrorCode;
  /**
   * Why the content policy refused the text of a write, in the order of
   * {@link contentViolationKinds}, only on a line with the outcome
   * `denied` (ADR 0030).
   */
  readonly contentViolations?: readonly ContentViolationKind[];
  /**
   * Set only by the sink, only in the audit file: the server read the
   * result but held it back, because its line could not be recorded as it
   * was. The line then says `denied` with `policy_denied`.
   */
  readonly withheldAfterRead?: true;
  /** Duration of the action in milliseconds. */
  readonly durationMs: number;
  /** Position in a hash chain, set only by a sink that chains, never by the producer. */
  readonly seq?: number;
  /** Hash of the previous event in the chain, set only by a sink that chains. */
  readonly prevHash?: string;
}
