/**
 * The one pipeline every call of a tool runs through (ADR 0024). Its
 * stages are fixed in this code; no plugin adds or removes one:
 *
 * 1. find the tool in the catalog,
 * 2. make the context of the call, with a signal of its own, or end with
 *    `auth` when the call has no tenant or none the pipeline can read,
 * 3. `gate`,
 * 4. `validateInput`, and for a tool with sensitivity special, or one the
 *    catalog treats as such because it names persons, the count against
 *    the daily read budget,
 * 5. `execute` with read access that is revoked afterwards,
 * 6. `validateOutput`, which drops every field the schema does not declare,
 * 7. `redact` and 8. `markUntrusted` with a boundary drawn for the call,
 * 9. the limit on the size of the result as the client receives it, and
 *    the mark of a redacted result, the only kind the mount sends (ADR
 *    0026),
 * 10. `audit`, in `finally`, also when a stage fails, with the IDs the
 *     call asks for and the IDs of the persons and groups its result
 *     names, derived from the schemas of the tool and the checked request
 *     of the escape hatch, never from its code (ADR 0028).
 *
 * In the level `strict`, a tool whose input or output holds an ID of a
 * person gets the pseudonyms of its principal right after the context:
 * every pseudonym in the input turns into its ID before `validateInput`,
 * and a raw ID ends the call with `validation`; `redact` turns every ID in
 * the result into its pseudonym. The code of the tool sees IDs only, the
 * audit records IDs only, and the keys are erased in `finally` (ADR 0069).
 *
 * Tenant and actor are copied once, before the first stage, through own
 * data properties only. The context and the audit use that copy, so no
 * getter and no trap of the resolver's answer can cost the audit line.
 *
 * The message of a failed call is masked like a result before it leaves.
 *
 * `serialize`, the only stage that knows MCP, lives in the mount.
 *
 * @packageDocumentation
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { isProxy } from 'node:util/types';

import {
  type AuditOutcome,
  type AuditRunResult,
  type AuditRunStep,
  type Clock,
  type ConfirmationPath,
  type ContentViolationKind,
  EccliumError,
  isEccliumError,
  type ErrorCode,
  type FeatureKey,
  type IsoDate,
  type KeyProvider,
  type Mode,
  type NonceStore,
  type PlannedWrite,
  type PlanOutcome,
  type PlanStore,
  type ProviderInfo,
  type QueueDecisionKind,
  type QuotaStore,
  type RedactionLevel,
  type RunId,
  type TenantAssignment,
  type TenantContext,
  type ToolCall,
  type WritePort,
  type WriteState,
  type WriteToolCall,
} from '@ecclium/mcp-churchtools-plugin-api';

import {
  type AuditSink,
  auditPlaceholders,
  createObjectRefCollector,
  type ObjectDomain,
  type ObjectRefCollector,
  type ObjectRefList,
  auditFieldSchemas,
  writeStateOutcomes,
} from '../audit/index.js';
import { createChurchToolsClient } from '../churchtools/index.js';
import type { WriteConfirmation } from '../config/index.js';
import {
  describeError,
  type ErrorDescription,
  fixedSentences,
} from '../errors/index.js';
import type { HttpTransport } from '../http/index.js';
import { diffLines, type LineDiff } from '../diff/index.js';
import {
  isUuid,
  type LineWriter,
  type LogLevel,
  toTimestamp,
} from '../logger/index.js';
import {
  chooseBoundary,
  isStrictLevel,
  maskErrorDescription,
  type RandomBytes,
} from '../redaction/index.js';
import {
  type CatalogEntry,
  collectInputRefs,
  echoToolName,
  type ToolCatalog,
} from '../registry/index.js';
import { policyHashOf } from '../policy/hash.js';
import type { Policy } from '../policy/schema.js';
import { isoDateOf, quotaTimeoutMs } from '../quota/budget.js';
import type {
  QueueEntryContent,
  QueueKeeper,
  QueueListing,
  QueueReason,
} from '../queue/index.js';
import { openPseudonyms, type Pseudonyms } from '../redaction/pseudonym.js';
import {
  isRedacted,
  type Redacted,
  sealRedacted,
} from '../redaction/redacted.js';
import { createTenantContext } from '../tenant/context.js';
import {
  approvalKeyOf,
  type ConfirmationAnswer,
  type ConfirmationQuestion,
  confirmationRouteOf,
  confirmationSentence,
  confirmationSentences,
  type ConfirmationText,
  createConfirmations,
  queueEntryOf,
  questionSentence,
  writeSentences,
  ContentRefusal,
  createWriteGuard,
  objectRefsOfTarget,
  type PlanQueueReason,
  isRunWrites,
  type RunPlanRequest,
  type RunWrites,
  type AdoptionShown,
  type AdoptionUnclear,
  type SnapshotToUndo,
  type UndoSubject,
  undoSubjectOf,
  type WriteGuard,
  type WriteHalt,
  type WriteSnapshots,
  type WriteTarget,
} from '../write/index.js';
import type { KeyMaterial } from '../keys/index.js';
import { createReadAccess, type ReadAccess } from './read-api.js';
import { runAssignmentOf } from '../run/id.js';
import { isTransientRunCode } from '../run/model.js';
import { cutEntries, personNamesOf } from './run-read.js';
import { contactKeysIn } from '../run/content.js';
import { resolveRunPage, type RunPageRef, runNeedsOf } from './run-write.js';
import {
  collectOutputRefs,
  fitsInput,
  maskFreeTextAt,
  outputIdsFit,
  markUntrusted,
  maxResultBytes,
  redact,
  resultBytes,
  type RevealedInput,
  revealInput,
} from './stages.js';

// The question to the client and its answer travel between the pipeline
// and the mount; the mount reaches the write guard only through here.
export type { ConfirmationAnswer, ConfirmationQuestion };

/** What the mount knows about one call, besides name and input. */
export interface ToolRequest {
  /**
   * Tenant and actor, from the resolver of the checked identity, or
   * `undefined` when the resolver assigns no tenant. A call without a
   * tenant ends with `auth` before any code of the tool runs, and is
   * audited all the same. The pipeline reads it once, through own data
   * properties only, and runs no getter and no trap of a proxy; an
   * assignment it cannot read that way counts as none.
   */
  readonly assignment: TenantAssignment | undefined;
  /** How the call runs, set by the composition root only. */
  readonly mode: Mode;
  /** The level of redaction. */
  readonly redaction: RedactionLevel;
  /** Whether the server only reads. */
  readonly readOnly: boolean;
  /** Licensed features, empty in the free core. */
  readonly features: readonly FeatureKey[];
  /** The signal of the request, aborted when the client cancels it. */
  readonly signal: AbortSignal;
  /**
   * Whether the client declared elicitation in form mode, as the mount read
   * it, so that a write can ask the person (ADR 0029). Unset counts as no.
   */
  readonly elicitation?: boolean;
  /**
   * The answer of the second round of a call, with the `requestState` the
   * mount verified. A call with an answer runs no tool: it commits the plan
   * its first round kept, or nothing (ADR 0029).
   */
  readonly answer?: ConfirmationAnswer;
}

/**
 * What a call returns, before the mount turns it into MCP. The data of a
 * success carry the mark of a redacted result, which only the pipeline
 * gives and the mount checks at run time as well (ADR 0026).
 */
export type ToolOutcome =
  | { readonly ok: true; readonly data: Redacted }
  | {
      readonly ok: false;
      readonly error: ErrorDescription;
      /**
       * A write that waits for the person (ADR 0029): the mount asks the
       * client this question and signs its state instead of sending the
       * error. Whoever does not know questions sees a write that was not
       * confirmed. The call is audited as planned, without an error.
       */
      readonly question?: ConfirmationQuestion;
    };

/**
 * The run a read belongs to (ADR 0033): every audit line of the read names
 * it, so that the audit shows which data a run read and for which model.
 */
export interface RunTag {
  /** The ID of the run, a UUID the core drew. */
  readonly runId: string;
  /** The ID of the routine, as the policy names it. */
  readonly routineId: string;
  /** The model the run gives its data to, when it has one. */
  readonly provider?: ProviderInfo;
}

/**
 * One read of a run of a routine (ADR 0033), built by the composition root
 * only. It runs unattended and only reads: the pipeline sets the mode and
 * refuses a write tool and a tool that is not stable for routines.
 */
export interface RunCallRequest {
  /** Tenant and actor, the actor of the routine such as `runner:<ID>`. */
  readonly assignment: TenantAssignment | undefined;
  /** The level of the call of the model, which the data come in. */
  readonly redaction: 'strict' | 'standard';
  /** Licensed features, empty in the free core. */
  readonly features: readonly FeatureKey[];
  /** The signal of the run. */
  readonly signal: AbortSignal;
  /** The run the read belongs to. */
  readonly run: RunTag;
  /** The most entries the result passes on, from 1. */
  readonly maxEntries: number;
}

/**
 * What a read of a run gives: the data with the mark of a redacted result,
 * in the level of the model, how many entries they hold, whether more
 * follow, and the name of each person by what the model sees of it. Or the
 * code of the failure, and whether a later try may succeed (ADR 0034).
 */
export type RunCallOutcome =
  | {
      readonly ok: true;
      readonly data: Redacted;
      readonly entries: number;
      readonly more: boolean;
      /**
       * Pseudonym, or in `standard` the ID as text, to the name in the
       * level `standard`; empty for a person without a name in the data.
       * The run holds it for its duration only (ADR 0033).
       */
      readonly persons: Readonly<Record<string, string>>;
    }
  | {
      readonly ok: false;
      readonly code: ErrorCode;
      /**
       * Whether the failure may pass (ADR 0034): the codes `network`,
       * `rate_limited` and `upstream`, or a store of quotas or an audit
       * file that cannot take the call now. `upstream` stands for 5xx and
       * also for an answer of ChurchTools the core refuses, such as one
       * that is too large or of an unknown form, which the code does not
       * tell apart, so such a run is tried again at most twice. A result
       * the pipeline finds too large is final.
       */
      readonly transient: boolean;
    };

/**
 * One write of a run of a routine (ADR 0032, ADR 0033), built by the
 * composition root only. It runs unattended with the write tool of the
 * output of the routine, which must be a tool of the core stable for
 * routines; the core finds the page, plans the section with the marking
 * of the run and commits it with the proof of the policy, or queues it.
 */
export interface RunWriteRequest {
  /** Tenant and actor, the actor of the routine such as `runner:<ID>`. */
  readonly assignment: TenantAssignment | undefined;
  /** Licensed features, empty in the free core. */
  readonly features: readonly FeatureKey[];
  /** The signal of the run. */
  readonly signal: AbortSignal;
  /** The run the write belongs to. */
  readonly run: RunTag;
  /** Whether the configuration of the runner only reads. */
  readonly readOnly: boolean;
  /** The write tool of the output of the routine. */
  readonly tool: string;
  /** The period of the run, which the line of the marking names. */
  readonly period: string;
  /** The section, without the line of the marking. */
  readonly section: string;
  /** The page: by its GUID, or by its title in a category. */
  readonly page: RunPageRef;
  /**
   * The data the reads of the run gave, each with the mark of a redacted
   * result: the contact values in them may stand in the section.
   */
  readonly data: readonly unknown[];
  /**
   * The tools of the routines of the account of the run, whose required
   * rights are the rights the account may have.
   */
  readonly accountTools: readonly string[];
  /** The counter of the writes of the run, made by the core. */
  readonly runWrites: RunWrites;
}

/**
 * How a write of a run ended: written, skipped as written already, queued
 * for the operator, or failed with its code, whether it may have reached
 * ChurchTools and whether a later try may pass (ADR 0034).
 */
export type RunWriteOutcome =
  | {
      readonly ok: true;
      readonly state: 'verified';
      readonly target: WriteTarget;
      readonly version: number;
      readonly undoId?: string;
    }
  | {
      readonly ok: true;
      readonly state: 'skipped';
      readonly target: WriteTarget;
    }
  | {
      readonly ok: true;
      readonly state: 'queued';
      readonly target: WriteTarget;
      readonly queueId: string;
    }
  | {
      readonly ok: false;
      readonly code: ErrorCode;
      /** Why the core found no page, when it found none. */
      readonly page?: 'missing' | 'ambiguous';
      readonly sent: boolean;
      readonly transient: boolean;
    };

/** What `ecclium undo` asks the pipeline to take back (ADR 0031). */
export interface UndoCall {
  /** The ID of the audit line of the write, a UUID. */
  readonly eventId: unknown;
  /** Whether to write also over a page someone changed since the write. */
  readonly overwrite: boolean;
  /**
   * The run of a routine the write belongs to, as the audit names it, so
   * that the line of the undo names it as well and `ecclium audit show
   * --run` shows the undo with the run (ADR 0028). The caller found it in
   * the audit; the pipeline only checks its form.
   */
  readonly run?: {
    readonly runId: unknown;
    readonly routineId: unknown;
  };
}

// The run of an undo in the form the audit writes it.
interface UndoRun {
  readonly runId: string;
  readonly routineId: string;
}

// The run of an undo, checked: undefined without one, null for one of
// another form, which refuses the undo as a call built wrong.
const undoRunOf = (run: UndoCall['run']): UndoRun | null | undefined => {
  if (run === undefined) return undefined;
  const { runId, routineId } = run;
  if (typeof runId !== 'string' || !isUuid(runId)) return null;
  try {
    // Throws for anything but the ID of a routine.
    runAssignmentOf(routineId as string);
  } catch {
    return null;
  }
  return Object.freeze({ runId, routineId: routineId as string });
};

export type { UndoSubject } from '../write/index.js';

/**
 * How an undo ended, for the command line (ADR 0031). A diff holds texts
 * of the page, the appointment or the booking; it goes to the operator
 * only, never into a log or the audit. `subject` tells what the undo takes
 * back, once its snapshot is found.
 */
export type UndoOutcome =
  /**
   * Taken back: the version of the target after it, and the ID to take
   * the undo back with, since an undo that writes keeps a snapshot of its
   * own. `unrecorded` when its line did not reach the audit file.
   */
  | {
      readonly kind: 'done';
      readonly subject: UndoSubject;
      readonly version: number;
      readonly undoId: string | undefined;
      readonly diff: LineDiff;
      readonly unrecorded?: true;
    }
  /**
   * A new appointment or booking deleted; a delete cannot be taken back.
   */
  | {
      readonly kind: 'deleted';
      readonly subject: UndoSubject;
      readonly diff: LineDiff;
      readonly unrecorded?: true;
    }
  /**
   * The target holds what the undo would write already, or a new
   * appointment or booking is gone already.
   */
  | { readonly kind: 'unchanged'; readonly subject: UndoSubject }
  /** Someone changed the target since the write; nothing was written. */
  | {
      readonly kind: 'changed';
      readonly subject: UndoSubject;
      readonly diff: LineDiff;
    }
  /**
   * No snapshot: none under this ID, or removed after its retention;
   * still there but its day key is gone; or the server keeps none.
   */
  | { readonly kind: 'missing' | 'expired' | 'off' }
  /**
   * A new page, appointment or booking whose ID was never kept: look in
   * its category, calendar or resource by hand.
   */
  | {
      readonly kind: 'incomplete';
      readonly subject: UndoSubject;
      readonly placeId: number;
    }
  /**
   * Refused or failed, with whether it may have reached ChurchTools and,
   * where the core knows it, the reason, for a text of the command line.
   */
  | {
      readonly kind: 'failed';
      readonly subject?: UndoSubject;
      readonly code: ErrorCode;
      readonly reason?: UndoReason;
      readonly state: WriteState;
      readonly sent: boolean;
      readonly diff?: LineDiff;
      readonly unrecorded?: true;
    };

/**
 * Why an undo was refused or failed: a fixed sentence of the write guard
 * by its name, or the audit file that cannot take the line.
 */
export type UndoReason = keyof typeof writeSentences | 'auditNotReady';

/**
 * What `ecclium marker adopt` asks the pipeline to sign anew (ADR 0032).
 * The command line found the run, its period, the page in the entry of
 * the routine and the writes of the routine in the audit; the pipeline
 * checks their form, and the write guard judges the page itself.
 */
export interface AdoptCall {
  /** The run the operator named, as the audit names it. */
  readonly run: { readonly runId: unknown; readonly routineId: unknown };
  /** The period of the run, such as `2026-W46`. */
  readonly period: unknown;
  /** The page of the entry of the routine, with its expected name. */
  readonly page: {
    readonly categoryId: unknown;
    readonly guid: unknown;
    readonly name: unknown;
  };
  /**
   * The IDs of the audit lines of the writes of the routine, the newest
   * first, whose snapshots may prove the section; at most
   * {@link maxAdoptionWrites}.
   */
  readonly writeIds: readonly unknown[];
  /** The check value of the preview; without it, nothing is written. */
  readonly confirm?: unknown;
}

/** The most writes whose snapshots an adoption opens. */
export const maxAdoptionWrites = 1000;

/**
 * How an adoption ended, for the command line (ADR 0032). The section and
 * the lines are text of the page; they go to the operator only, never into
 * a log or the audit.
 */
export type AdoptOutcome =
  /** A line of the period whose code fits already: nothing to do. */
  | { readonly kind: 'own' }
  /** No line of the marking of the period on the page. */
  | { readonly kind: 'none' }
  /** The page has another name than the entry of the routine expects. */
  | { readonly kind: 'renamed' }
  /** The core cannot tell which section to sign. */
  | { readonly kind: 'unclear'; readonly reason: AdoptionUnclear }
  /**
   * No snapshot proves the section: `snapshots` counts those of writes of
   * the page that were found and checked, and `range` holds the lines from
   * the line of the marking before to the line of the period.
   */
  | {
      readonly kind: 'unproven';
      readonly range: string;
      readonly snapshots: number;
    }
  /** Proven, but the line or the section cannot be signed. */
  | { readonly kind: 'unsignable'; readonly range: string }
  /** Shown without a check value; nothing written. */
  | { readonly kind: 'preview'; readonly shown: AdoptionShown }
  /** The check value does not fit the page now; nothing written. */
  | { readonly kind: 'mismatch'; readonly shown: AdoptionShown }
  /**
   * Signed anew: the version of the page after it, and the ID to take the
   * adoption back with. `unrecorded` when its line did not reach the
   * audit file.
   */
  | {
      readonly kind: 'done';
      readonly shown: AdoptionShown;
      readonly version: number;
      readonly undoId: string | undefined;
      readonly unrecorded?: true;
    }
  /** The server keeps no snapshots, so nothing can be proven. */
  | { readonly kind: 'off' }
  /**
   * Refused or failed, with whether it may have reached ChurchTools and,
   * where the core knows it, the reason, for a text of the command line.
   */
  | {
      readonly kind: 'failed';
      readonly code: ErrorCode;
      readonly reason?: UndoReason;
      readonly state: WriteState;
      readonly sent: boolean;
      readonly shown?: AdoptionShown;
      readonly unrecorded?: true;
    };

/**
 * What `ecclium queue list` finds (ADR 0031): every entry of the tenant,
 * the oldest first, those that wait with what they hold. Their texts come
 * from ChurchTools and the model; they go to the operator only.
 */
export type QueueListOutcome =
  | { readonly kind: 'listed'; readonly entries: readonly QueueListing[] }
  /** The server keeps no queue. */
  | { readonly kind: 'off' }
  /** Refused or failed, with the code. */
  | { readonly kind: 'failed'; readonly code: ErrorCode };

/**
 * What `ecclium queue show` finds for one ID (ADR 0031). Its texts go to
 * the operator only.
 */
export type QueueShowOutcome =
  | {
      readonly kind: 'found';
      readonly day: IsoDate;
      readonly content: QueueEntryContent;
    }
  /**
   * No entry: none under this ID, past its retention, or no queue. Used:
   * a decision about it was counted, but none was kept, so that only the
   * audit tells its outcome (ADR 0029).
   */
  | { readonly kind: 'missing' | 'expired' | 'off' | 'used' }
  /** The operator decided about this entry already, and when. */
  | {
      readonly kind: 'decided';
      readonly decision: QueueDecisionKind;
      readonly decidedAt: string;
    }
  /** Refused or failed, with the code. */
  | { readonly kind: 'failed'; readonly code: ErrorCode };

/** What `ecclium queue` asks the pipeline to decide (ADR 0031). */
export interface QueueCall {
  /** The ID of the entry, a UUID. */
  readonly queueId: unknown;
}

/**
 * How a rejection of the operator ended, for the command line (ADR 0031).
 * A summary holds text of ChurchTools; it goes to the operator only, never
 * into a log or the audit.
 */
export type RejectOutcome =
  /** Rejected: the entry is destroyed, its decision kept. */
  | {
      readonly kind: 'rejected';
      readonly summary: string;
      readonly target: WriteTarget;
      readonly unrecorded?: true;
    }
  /**
   * No entry: none under this ID, past its retention, or the server keeps
   * no queue. Used: a decision about it was counted already, whose outcome
   * only the audit tells.
   */
  | { readonly kind: 'missing' | 'expired' | 'off' | 'used' }
  /** The operator decided about this entry already. */
  | { readonly kind: 'decided'; readonly decision: QueueDecisionKind }
  /**
   * Refused or failed, with the code and why: the audit file that cannot
   * take the line, or a store of quotas that did not answer in time, so
   * that it is unknown whether the decision was counted. `used` when the
   * decision was counted but could not be kept: then the entry can no
   * longer be decided.
   */
  | {
      readonly kind: 'failed';
      readonly code: ErrorCode;
      readonly reason?: 'auditNotReady' | 'countUnknown';
      readonly used?: true;
    };

/**
 * Why an approval was refused or failed: a fixed sentence of the write
 * guard by its name, the audit file that cannot take the line, the
 * content policy, which refused a text of the entry, or a store of quotas
 * that did not answer in time, so that it is unknown whether the decision
 * was counted.
 */
export type ApproveReason =
  keyof typeof writeSentences | 'auditNotReady' | 'content' | 'countUnknown';

/**
 * How an approval of the operator ended, for the command line (ADR 0029).
 * Summary and diff hold text of ChurchTools and of the model; they go to
 * the operator only, never into a log or the audit.
 */
export type ApproveOutcome =
  /**
   * Written: the summary of the entry, what changed, the version after it,
   * the ID to take it back with, and the diff of the state it wrote over.
   * `unrecorded` when its line did not reach the audit file.
   */
  | {
      readonly kind: 'approved';
      readonly summary: string;
      readonly target: WriteTarget;
      readonly version: number;
      readonly undoId: string | undefined;
      readonly diff: LineDiff;
      readonly unrecorded?: true;
    }
  /** No entry, or a decision counted before without its outcome. */
  | { readonly kind: 'missing' | 'expired' | 'off' | 'used' }
  /** The operator decided about this entry already. */
  | { readonly kind: 'decided'; readonly decision: QueueDecisionKind }
  /**
   * Refused or failed, with the code, the reason where the core knows it,
   * whether the approval is used up, and once it was, the state of the
   * write, whether it may have reached ChurchTools and its diff. An
   * approval that is not used up leaves the entry waiting.
   */
  | {
      readonly kind: 'failed';
      readonly code: ErrorCode;
      readonly reason?: ApproveReason;
      readonly used: boolean;
      readonly state?: WriteState;
      readonly sent: boolean;
      readonly diff?: LineDiff;
      readonly unrecorded?: true;
    };

/**
 * The end of a run of a routine (ADR 0028, ADR 0033), which the runner
 * reports once per run, after its reads and its write. Tenant and actor
 * are those of the routine, `runner:<ID>`, and the mode is `unattended`:
 * the pipeline sets them itself, never the caller.
 */
export interface RunEndRequest {
  /** The run that ended. */
  readonly run: RunTag;
  /**
   * How it ended: written, unchanged, queued, drafted, a preview, or
   * failed.
   */
  readonly result: AuditRunResult;
  /** The step a failed run ended in. */
  readonly step?: AuditRunStep;
  /** The code of a failed run; `internal` when it has none. */
  readonly code?: ErrorCode;
  /**
   * Whether a failed run was refused, by the policy, a kill switch or the
   * content policy, rather than failed: its line then says `denied`.
   */
  readonly refused?: boolean;
  /** Why the content policy refused, only with `refused`. */
  readonly contentViolations?: readonly ContentViolationKind[];
  /** Which try of its trigger the run was, from 1 to 3; none by hand. */
  readonly attempt?: number;
  /** The period of the run, such as `2026-W46`. */
  readonly period?: string;
  /** How long the run took, in milliseconds. */
  readonly durationMs: number;
}

/** The pipeline of one ChurchTools instance. */
export interface ToolPipeline {
  /**
   * Runs one call of a tool through every stage.
   *
   * @param name - The name the client asked for.
   * @param input - The input as the client sent it.
   * @param request - What the mount knows about the call.
   * @returns The outcome. It never rejects.
   */
  call(
    name: string,
    input: unknown,
    request: ToolRequest,
  ): Promise<ToolOutcome>;
  /**
   * Runs one read of a run of a routine through every stage, as `call`
   * does, in the mode `unattended` (ADR 0033). It keeps at most
   * `maxEntries` entries and gives the names of the persons for the
   * report. Its audit line names the run, the routine, the policy and the
   * model.
   *
   * @param name - The name of a read tool stable for routines.
   * @param input - The input the engine built.
   * @param request - What the composition root set for the run.
   * @returns The outcome. It never rejects.
   */
  callForRun(
    name: string,
    input: unknown,
    request: RunCallRequest,
  ): Promise<RunCallOutcome>;
  /**
   * Runs one write of a run of a routine through every stage, as `call`
   * does, in the mode `unattended` (ADR 0032): the core finds the page,
   * the write tool plans the section with the marking of the run, and the
   * plan is committed with the proof of the policy or queued for the
   * operator. Its audit line names the run, the routine, the policy and
   * the model.
   *
   * @param request - What the composition root set for the write.
   * @returns The outcome. It never rejects.
   */
  writeForRun(request: RunWriteRequest): Promise<RunWriteOutcome>;
  /**
   * Writes the line of the type `run` that ends a run of a routine
   * (ADR 0028, ADR 0033): how it ended, with the step and the code of a
   * failure, the reasons of the content policy, the try, the period, the
   * policy and the model. It reads nothing and writes nothing to
   * ChurchTools.
   *
   * @param request - What the runner knows about the end of the run.
   * @returns Whether the whole line reached the audit file, or without a
   *   file the stream of the logger. It never throws.
   */
  endRun(request: RunEndRequest): boolean;
  /**
   * Takes back a write of the core from its snapshot, for the operator
   * only: a request in another mode is refused (ADR 0031). It writes one
   * audit line of the type `undo` that names the write.
   *
   * @param undo - The ID of the write and whether to write over a change.
   * @param request - Tenant, actor and mode of the operator.
   * @returns How the undo ended. It never rejects.
   */
  undo(undo: UndoCall, request: ToolRequest): Promise<UndoOutcome>;
  /**
   * Signs the section of a run anew after the key of the check codes was
   * lost, for the operator only: a request in another mode is refused
   * (ADR 0032). It writes one audit line of the type `adoption` that names
   * the run, also for a preview.
   *
   * @param call - Run, period, page, writes and the check value.
   * @param request - Tenant, actor and mode of the operator.
   * @returns How the adoption ended. It never rejects.
   */
  adopt(call: AdoptCall, request: ToolRequest): Promise<AdoptOutcome>;
  /**
   * Rejects an entry of the queue of approvals, for the operator only: a
   * request in another mode is refused (ADR 0031). It keeps the decision,
   * destroys the entry and writes one audit line of the type `approval`
   * that names the entry. It writes nothing to ChurchTools.
   *
   * @param call - The ID of the entry.
   * @param request - Tenant, actor and mode of the operator.
   * @returns How the rejection ended. It never rejects.
   */
  reject(call: QueueCall, request: ToolRequest): Promise<RejectOutcome>;
  /**
   * Approves an entry of the queue of approvals, for the operator only: a
   * request in another mode is refused (ADR 0029). It plans the write of
   * the entry again with the actor who asked for it, counts and keeps the
   * decision, which destroys the entry, writes to ChurchTools with a proof
   * of the operator and writes one audit line of the type `approval` that
   * names the entry, the target and the state of the write.
   *
   * @param call - The ID of the entry.
   * @param request - Tenant, actor and mode of the operator.
   * @returns How the approval ended. It never rejects.
   */
  approve(call: QueueCall, request: ToolRequest): Promise<ApproveOutcome>;
  /**
   * Lists the entries of the queue of approvals of the tenant, for the
   * operator only (ADR 0031). Reading writes no audit line: it changes
   * nothing, and what it shows was queued by a call with a line of its own.
   *
   * @param request - Tenant, actor and mode of the operator.
   * @returns The entries, or why there are none. It never rejects.
   */
  listQueue(request: ToolRequest): Promise<QueueListOutcome>;
  /**
   * Opens one entry of the queue of approvals, for the operator only
   * (ADR 0031), without an audit line, like {@link ToolPipeline.listQueue}.
   *
   * @param call - The ID of the entry.
   * @param request - Tenant, actor and mode of the operator.
   * @returns What the entry holds, or why there is nothing. It never
   *   rejects.
   */
  showQueue(call: QueueCall, request: ToolRequest): Promise<QueueShowOutcome>;
}

/** What the composition root builds the pipeline from. */
export interface ToolPipelineOptions {
  /** The frozen catalog of tools. */
  readonly catalog: ToolCatalog;
  /** The audit sink, built with `catalog.has` as its `isKnownTool`. */
  readonly audit: AuditSink;
  /** The transport of the instance, built by the composition root. */
  readonly transport: HttpTransport;
  /** The canonical origin of the instance, the same as the transport's. */
  readonly origin: string;
  /** Requests per minute to ChurchTools, from the configuration. */
  readonly requestsPerMinute: number;
  /** A frozen clock whose own method is frozen as well. */
  readonly clock: Clock;
  /** Where the log lines of each call go. */
  readonly logging: {
    readonly writer: LineWriter;
    readonly minLevel: LogLevel;
  };
  /**
   * The source of random bytes for the boundary of the data envelope,
   * `randomBytes` of `node:crypto` unless a test fixes the boundary.
   */
  readonly random?: RandomBytes;
  /**
   * The store of the daily read budget (ADR 0063) and of the counters of
   * writes (ADR 0032). Without it, a tool with sensitivity special, or one
   * the catalog treats as such, does not run, and neither does a write
   * that an entry of the policy limits.
   */
  readonly quota?: QuotaStore;
  /**
   * The snapshots of writes (ADR 0031), or undefined when they are off:
   * then every write is sealed as not reversible and the echo allows none.
   */
  readonly snapshots?: WriteSnapshots;
  /**
   * The key of the check codes of the marking (ADR 0032), from the
   * configuration. Without it, no write adds a page or a section to the
   * wiki.
   */
  readonly markerKey?: KeyMaterial;
  /**
   * The zone in which the texts of a confirmation show the times of
   * appointments and bookings, from `ECCLIUM_TIME_ZONE`, or undefined for
   * UTC. The tools take UTC either way.
   */
  readonly timeZone?: string | undefined;
  /**
   * The provider of the keys for pseudonyms, built by the composition root
   * from the key files (ADR 0069). Without it, a call in the level
   * `strict` of a tool with an ID of a person ends with `internal`.
   */
  readonly keys?: KeyProvider;
  /**
   * The folder of the kill switches of writing, from the configuration
   * (ADR 0029). Without it, every write tool is refused, because no switch
   * can be checked.
   */
  readonly killSwitchDir?: string;
  /**
   * The checked policy from the configuration (ADR 0032): the daily read
   * budget and the limits of writes. Required, so that no composition root
   * can leave the policy of the operator out by accident; one without a
   * file passes the default policy.
   */
  readonly policy: Policy;
  /**
   * How a write is confirmed, from `ECCLIUM_WRITE_CONFIRMATION` (ADR 0029);
   * `echo-allowed`, the setting over stdio, unless given.
   */
  readonly confirmation?: WriteConfirmation;
  /**
   * The stores of the plans and nonces of questions (ADR 0029), built by
   * the composition root. Without both, no write asks the person, and a
   * write that would ask ends with `confirmation_required`.
   */
  readonly plans?: PlanStore;
  readonly nonces?: NonceStore;
  /**
   * The queue of approvals (ADR 0031), built by the composition root.
   * Without it, a write that would go there ends with
   * `confirmation_required`, and `ecclium queue` finds nothing.
   */
  readonly queue?: QueueKeeper;
  /**
   * The halt of writes of the process (ADR 0029), made by the composition
   * root with `createWriteHalt` and shared by every pipeline it builds for
   * the runs of the runner. Without it, the write guard of this pipeline
   * halts only its own writes after a failed line of the audit.
   */
  readonly writeHalt?: WriteHalt;
}

// The longest duration the audit accepts.
const maxDurationMs = 86_400_000;

const internalOutcome: ToolOutcome = Object.freeze({
  __proto__: null,
  ok: false,
  error: Object.freeze({
    __proto__: null,
    code: 'internal',
    message: fixedSentences.internal,
  }),
});

// A tool with sensitivity special, and one the catalog treats as such
// because it names persons, runs only with an audit file that can take its
// line, and its result goes out only once the line is in the file
// (ADR 0028, ADR 0064). Two fixed sentences, so that the model can tell a call
// that never ran from one whose result was held back.
const auditNotReady =
  'The audit file of the server cannot record this call now, so the tool did not run. Ask the operator to check the audit file.';
const auditWithheld =
  'The call could not be recorded in the audit file, so its result is held back. Ask the operator to check the audit file.';

const withheldOutcome: ToolOutcome = Object.freeze({
  __proto__: null,
  ok: false,
  error: Object.freeze({
    __proto__: null,
    code: 'policy_denied',
    message: auditWithheld,
  }),
});

// A call above the daily read budget of the policy, and one the store could
// not count (ADR 0032, ADR 0063). A budget of 0 lets no such tool run.
const budgetExhausted = (budget: number): string =>
  budget === 0
    ? 'The daily budget of calls of tools with special personal data is 0 on this server, so they do not run. Ask the operator.'
    : `The daily budget of ${String(budget)} calls of tools with special personal data is used up. It resets at 00:00 UTC.`;
const budgetUnavailable =
  'The server cannot count this call against the daily read budget now, so the tool did not run. Ask the operator to check the folder of state.';

const tooLarge =
  'The result is larger than 64 KiB. Narrow the request, for example with a more specific search.';

// A raw ID, a changed pseudonym or one of another principal at a field of
// a person in the level strict (ADR 0069).
const pseudonymExpected =
  'IDs of persons on this server are pseudonyms that start with p1_. Pass them on as a tool returned them.';

// The getter of AbortSignal itself: an own property `aborted` of a signal
// could hide it (ADR 0055).
const abortedGetter = Reflect.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  'aborted',
)?.get;
// The methods of EventTarget itself, for the same reason.
const addListener: unknown = Reflect.getOwnPropertyDescriptor(
  EventTarget.prototype,
  'addEventListener',
)?.value;
const removeListener: unknown = Reflect.getOwnPropertyDescriptor(
  EventTarget.prototype,
  'removeEventListener',
)?.value;

// A fixed reason, so no text of a client travels with an abort.
const abortReason = 'ecclium_call_aborted';

const isAborted = (signal: AbortSignal): boolean =>
  Reflect.apply(abortedGetter as () => boolean, signal, []);

// An object whose own properties can be read without running its code.
// isProxy runs no trap, also not for a revoked proxy.
const isPlainTarget = (value: unknown): value is object =>
  typeof value === 'object' && value !== null && !isProxy(value);

// An own data property, never inherited and never through a getter. An
// accessor reads as a missing key.
const ownData = (target: object, key: string): unknown => {
  const property = Object.getOwnPropertyDescriptor(target, key);
  return property !== undefined && Object.hasOwn(property, 'value')
    ? property.value
    : undefined;
};

// Tenant and actor of the resolver's answer, copied into a frozen record
// (ADR 0024). An answer that is a proxy or holds one as its actor, or whose
// tenant, actor, kind or id is missing or an accessor, cannot be read
// without running its code and counts as no assignment. A value that can be
// read is copied as it is: the context refuses one that is not valid.
const copyAssignment = (value: unknown): TenantAssignment | undefined => {
  if (!isPlainTarget(value)) return undefined;
  const tenantId = ownData(value, 'tenantId');
  const actor = ownData(value, 'actor');
  if (tenantId === undefined || !isPlainTarget(actor)) return undefined;
  const kind = ownData(actor, 'kind');
  const id = ownData(actor, 'id');
  if (kind === undefined || id === undefined) return undefined;
  return Object.freeze({
    __proto__: null,
    tenantId,
    actor: Object.freeze({ __proto__: null, kind, id }),
  }) as unknown as TenantAssignment;
};

const failed = (
  code: ErrorCode,
  message?: string,
): { readonly outcome: ToolOutcome; readonly audit: AuditOutcome } => ({
  outcome: Object.freeze({
    __proto__: null,
    ok: false,
    error: describeError(new EccliumError(code, message)),
  }),
  audit:
    code === 'policy_denied' || code === 'license_required'
      ? 'denied'
      : 'error',
});

/** The state of one call, for its `finally`. */
interface Run {
  /** The ID of the call, bound to its log lines and given to the audit. */
  eventId?: string;
  /** The copy of tenant and actor, the only one stages and audit read. */
  assignment?: TenantAssignment;
  entry?: CatalogEntry;
  redaction?: RedactionLevel;
  ctx?: TenantContext;
  access?: ReadAccess;
  detach?: () => void;
  /**
   * The IDs of the call, made once its input fits the schema: those of the
   * input first, then those a read of the escape hatch asks for.
   */
  refs?: ObjectRefCollector;
  /** The result as the output schema parsed it, before `redact`. */
  output?: Readonly<Record<string, unknown>>;
  /**
   * The pseudonyms of the call in the level `strict`, for a tool with an
   * ID of a person, erased in `finally` (ADR 0069).
   */
  pseudonyms?: Pseudonyms;
  /** The input with the IDs its pseudonyms stand for, or the refusal. */
  revealed?: RevealedInput;
  /** What a call of a write tool leaves for its audit line (ADR 0029). */
  write?: WriteRecord;
  /** For a read of a run: its tag and the most entries it passes on. */
  forRun?: { readonly tag: RunTag; readonly maxEntries: number };
  /** For a write of a run: its tag and what the write of the run needs. */
  forWrite?: RunWrite;
  /** For a write of a run, why the core found no page. */
  page?: 'missing' | 'ambiguous';
  /** What a read of a run passes on beside its data. */
  runResult?: {
    readonly entries: number;
    readonly more: boolean;
    readonly persons: Readonly<Record<string, string>>;
  };
  /**
   * Whether a failure may pass on a later try: a store of quotas or an
   * audit file that cannot take the call now (ADR 0034).
   */
  transient?: boolean;
}

// The ID of a routine, as the policy names it.
const routineIdPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
// The period of a run, as the line of the marking names it.
const periodPattern = /^[0-9A-Za-z][0-9A-Za-z-]{0,31}$/;

// Why a write of a run found no page (ADR 0032). A run never creates one.
const runPageMissing =
  'The page of the routine is not in its category, its account cannot see it, or the category has more pages than a run searches. A run creates no page. Ask the operator.';
const runPageAmbiguous =
  'Two pages of the category of the routine have its title, so the run does not write. Ask the operator.';

/** A write of a run as the pipeline copied it from its request. */
interface RunWrite {
  readonly tag: RunTag;
  readonly period: string;
  readonly section: string;
  readonly page: RunPageRef;
  readonly data: readonly unknown[];
  readonly accountTools: readonly string[];
  readonly runWrites: RunWrites;
}

/** The state of a write at the end of its call, for the audit. */
interface WriteRecord {
  readonly writeState: WriteState;
  readonly confirmation?: ConfirmationPath;
  /** Whether a write may have reached ChurchTools. */
  readonly sent: boolean;
  /** For a write of a run, that the exception for rights let it go on. */
  readonly rightsDriftAccepted?: true;
  /** For a write that waits in the queue, the ID of its entry. */
  readonly queueId?: string;
  /** The target and version of a verified write, for a run. */
  readonly target?: WriteTarget;
  readonly version?: number;
  readonly undoId?: string;
  /** Why the content policy refused a text of the write (ADR 0030). */
  readonly contentViolations?: readonly ContentViolationKind[];
}

/** What a write tool used during its call, kept by the pipeline. */
interface WriteAccess {
  /** The port the tool gets in its call. */
  readonly port: WritePort;
  /** Ends the port: a later plan is refused. */
  readonly revoke: () => void;
  /** The outcome of the one plan of the call, if the tool planned. */
  readonly outcome: () => PlanOutcome | undefined;
  /** The target of that plan. */
  readonly target: () => WriteTarget | undefined;
  /** What a person sees to confirm that plan. */
  readonly text: () => ConfirmationText | undefined;
  /** Why that plan goes to the queue, if it does. */
  readonly queue: () => PlanQueueReason | undefined;
  /** Whether the exception for rights let that plan of a run go on. */
  readonly rightsDriftAccepted: () => true | undefined;
  /** The refusal of the plan, if the guard refused it. */
  readonly refusal: () => EccliumError | undefined;
  /** Why the content policy refused a text, if it did. */
  readonly contentViolations: () => readonly ContentViolationKind[] | undefined;
}

// Codes of a write that count as refused in the audit, not as an error
// (ADR 0029): the policy, a missing licence, a missing confirmation and a
// missing right. A text the content policy refuses counts as refused by
// its state, though its code is validation (ADR 0030).
const writeDenials: readonly ErrorCode[] = Object.freeze([
  'policy_denied',
  'license_required',
  'confirmation_required',
  'permission',
]);

// The state of a write that ended with an error before it was sent, by
// its code. A write that was sent carries the state the guard gives it.
// A conflict found before anything was sent counts as refused, so that
// denied always means that nothing reached ChurchTools, and the state
// conflict only follows a write that was sent (ADR 0029).
const writeStateOf = (code: ErrorCode): WriteState =>
  writeDenials.includes(code) || code === 'conflict' ? 'denied' : 'failed';

// The state of a write for the audit line of its call: the one the write
// left, or for a write tool that ended before its write, refused or failed
// as its outcome says, so that whoever counts writes sees every call.
const writeStateOfCall = (
  run: Run,
  outcome: AuditOutcome,
  ok: boolean,
): WriteState | undefined => {
  if (run.write !== undefined) return run.write.writeState;
  if (ok || run.entry?.meta.capability !== 'write') return undefined;
  return outcome === 'denied' ? 'denied' : 'failed';
};

// The result of a write as the model gets it: state, target and version,
// built by the core (ADR 0029).
const writeResult = (
  state: 'verified' | 'skipped',
  target: WriteTarget,
  version?: number,
  undoId?: string,
): Readonly<Record<string, unknown>> =>
  Object.freeze({
    state,
    target: Object.freeze({ kind: target.kind, key: target.key }),
    ...(version === undefined ? {} : { version }),
    ...(undoId === undefined ? {} : { undoId }),
  });

// The result of a write that waits for its confirmation by echo: the token
// and the text the person confirms, built by the core (ADR 0029).
const plannedResult = (
  target: WriteTarget,
  token: string,
  text: ConfirmationText,
): Readonly<Record<string, unknown>> =>
  Object.freeze({
    state: 'planned',
    target: Object.freeze({ kind: target.kind, key: target.key }),
    confirm: Object.freeze({
      token,
      summary: text.summary,
      diff: text.diff,
      ...(text.title === undefined ? {} : { title: text.title }),
    }),
  });

// The result of a write that waits in the queue of approvals: its entry is
// named by the ID of the audit line of the call (ADR 0031).
const queuedResult = (
  target: WriteTarget,
  queueId: string,
): Readonly<Record<string, unknown>> =>
  Object.freeze({
    state: 'queued',
    target: Object.freeze({ kind: target.kind, key: target.key }),
    queueId,
  });

// The most entries of the queue that wait for the operator per tenant; a
// write beyond them is refused, so that the queue cannot fill the disk
// (ADR 0031).
const maxWaiting = 100;

// The IDs of a target for the audit (rules.ts). A write that ended before
// it had a target adds none.
const addTarget = (
  refs: ObjectRefCollector,
  target: WriteTarget | undefined,
): void => {
  if (target === undefined) return;
  for (const [kind, id] of objectRefsOfTarget(target)) refs.add(kind, id);
};

// A call without a tool to name or without an input that fits its schema
// has no IDs.
const noRefs: ObjectRefList = Object.freeze({
  refs: Object.freeze([]),
  omitted: 0,
});

// Adds IDs to a collector, as the walks of input and output hand them on.
const adder =
  (refs: ObjectRefCollector) =>
  (domain: ObjectDomain, value: unknown): void => {
    refs.add(domain, value);
  };

// The IDs of an input that fits the schema of the tool, and whether each
// value at a field of an ID has the form of one.
const inputRefsOf = (
  entry: CatalogEntry,
  input: unknown,
): { readonly refs: ObjectRefCollector; readonly fits: boolean } => {
  const refs = createObjectRefCollector();
  let fits = true;
  if (entry.inputRefs !== undefined) {
    collectInputRefs(input, entry.inputRefs, (domain, value) => {
      if (!refs.add(domain, value)) fits = false;
    });
  }
  return { refs, fits };
};

/**
 * Builds the pipeline of one ChurchTools instance. It builds the raw client
 * of the instance itself, so the composition root never imports it.
 *
 * @param options - Catalog, audit sink, transport, origin, rate, clock and
 *   where log lines go.
 * @returns The pipeline, frozen.
 * @throws {TypeError} When the client cannot be built from transport,
 *   origin and rate.
 * @example
 * ```ts
 * const pipeline = createToolPipeline({ policy, catalog, audit, transport,
 *   origin, requestsPerMinute: 300, clock, logging: { writer, minLevel: 'info' } });
 * const outcome = await pipeline.call('ct_whoami', {}, request);
 * ```
 */
export function createToolPipeline(options: ToolPipelineOptions): ToolPipeline {
  const { catalog, audit, clock, logging, origin } = options;
  const random = options.random ?? randomBytes;
  // The read budget of the policy, fixed for the life of the pipeline, as
  // the policy is read once at the start (ADR 0032).
  const readBudget = options.policy.interactive.readBudgetPerDay;
  const exhausted = budgetExhausted(readBudget);
  // The hash of the policy, once: the audit line of every call of a write
  // tool names the policy that judged it (ADR 0032).
  const policyHash = policyHashOf(options.policy);
  const client = createChurchToolsClient({
    transport: options.transport,
    origin,
    requestsPerMinute: options.requestsPerMinute,
    clock,
  });
  // The write guard of this pipeline, the only code that writes, built
  // here like the client, so that the composition root never sees either
  // (ADR 0029).
  const guard: WriteGuard = createWriteGuard({
    client,
    clock,
    killSwitchDir: options.killSwitchDir,
    policy: options.policy,
    quota: options.quota,
    snapshots: options.snapshots,
    markerKey: options.markerKey,
    timeZone: options.timeZone,
    writeHalt: options.writeHalt,
  });
  // How writes are confirmed, and the questions to the client over the
  // stores the composition root built (ADR 0029). Without the stores no
  // write asks.
  const setting = options.confirmation ?? 'echo-allowed';
  const { plans, nonces } = options;
  const confirmations =
    plans !== undefined && nonces !== undefined
      ? createConfirmations({ plans, nonces, clock, random })
      : undefined;

  // 6. to 9. for a result: validate, redact, mark and measure it. A write
  // tool comes here with the result the core built, never with its own.
  const finish = (
    run: Run,
    entry: CatalogEntry,
    ctx: TenantContext,
    redaction: RedactionLevel,
    result: unknown,
  ): { readonly outcome: ToolOutcome; readonly audit: AuditOutcome } => {
    // 6. validateOutput.
    const parsedOutput = entry.output.safeParse(result);
    if (!parsedOutput.success) {
      ctx.log.warn('tool_output_invalid');
      return failed('internal');
    }
    // A result with an ID the audit could not name does not go out
    // (ADR 0028).
    if (!outputIdsFit(parsedOutput.data, entry.shape.root)) {
      ctx.log.warn('tool_output_invalid');
      return failed('internal');
    }
    const root = entry.shape.root;
    // A read of a run passes on at most the entries its input may, cut
    // before redact, so that the audit names and the model sees the same
    // entries (ADR 0033).
    const forRun = run.forRun;
    const cut =
      forRun === undefined
        ? undefined
        : cutEntries(
            parsedOutput.data as Readonly<Record<string, unknown>>,
            root,
            forRun.maxEntries,
          );
    const output =
      cut?.data ?? (parsedOutput.data as Readonly<Record<string, unknown>>);
    run.output = output;

    // 7. redact and 8. markUntrusted, along the shape kept at registration.
    // The boundary is drawn after redact, so it is checked against the
    // cleaned text that the envelope will hold.
    let redacted: unknown;
    let persons: Readonly<Record<string, string>> | undefined;
    try {
      redacted = redact(output, root, redaction, run.pseudonyms?.hide);
      // The names of the persons for the report of a run, by what the
      // model sees: in strict the pseudonym, which redact has just made
      // for every such ID, so the pseudonyms are open here (ADR 0069).
      if (cut !== undefined) {
        const pseudonyms = run.pseudonyms;
        persons = personNamesOf(
          output,
          root,
          isStrictLevel(redaction)
            ? (id) => (pseudonyms as Pseudonyms).hide(id)
            : String,
        );
      }
    } catch {
      // In strict an ID of a person without its pseudonym never goes out
      // (ADR 0069).
      ctx.log.warn('tool_pseudonym_failed');
      return failed('internal');
    }
    let boundary: string;
    try {
      boundary = chooseBoundary(JSON.stringify(redacted), random);
    } catch {
      ctx.log.warn('tool_boundary_failed');
      return failed('internal');
    }
    const data = markUntrusted(redacted, root, boundary) as Readonly<
      Record<string, unknown>
    >;

    // 9. The size of the result as the client receives it: both copies
    // the mount sends and the reserve for the rest of the message (ADR
    // 0024).
    if (resultBytes(data) > maxResultBytes) {
      ctx.log.warn('tool_result_too_large');
      // The same read gives the same size: no later try of a run passes.
      run.transient = false;
      return failed('upstream', tooLarge);
    }
    if (cut !== undefined) {
      run.runResult = {
        entries: cut.entries,
        more: cut.more,
        persons: persons as Readonly<Record<string, string>>,
      };
    }
    // The mark of a redacted result, the only kind the mount sends (ADR
    // 0026).
    return {
      outcome: Object.freeze({
        __proto__: null,
        ok: true,
        data: sealRedacted(data),
      }),
      audit: 'ok',
    };
  };

  const stages = async (
    run: Run,
    name: string,
    input: unknown,
    request: ToolRequest,
  ): Promise<{
    readonly outcome: ToolOutcome;
    readonly audit: AuditOutcome;
  }> => {
    // 1. Find the tool.
    const entry = catalog.get(name);
    if (entry === undefined) return failed('not_found');
    run.entry = entry;
    // A read of a run that the composition root built wrong ends before
    // anything runs: a level other than those of a model, a limit of
    // entries out of range, or a routine without the form of the policy.
    const forRun = run.forRun;
    if (
      forRun !== undefined &&
      ((request.redaction !== 'strict' && request.redaction !== 'standard') ||
        !Number.isSafeInteger(forRun.maxEntries) ||
        forRun.maxEntries < 1 ||
        typeof forRun.tag.routineId !== 'string' ||
        !routineIdPattern.test(forRun.tag.routineId))
    ) {
      return failed('internal');
    }
    // A write of a run likewise: a routine without the form of the policy,
    // a period without the form of the marking, or a counter of its writes
    // the core did not make.
    const forWrite = run.forWrite;
    if (
      forWrite !== undefined &&
      (typeof forWrite.tag.routineId !== 'string' ||
        !routineIdPattern.test(forWrite.tag.routineId) ||
        typeof forWrite.period !== 'string' ||
        !periodPattern.test(forWrite.period) ||
        typeof forWrite.section !== 'string' ||
        !isRunWrites(forWrite.runWrites))
    ) {
      return failed('internal');
    }

    // 2. Copies of what the gate, the stages and the audit rely on, taken
    // before any code of the tool runs, and a signal of the call's own.
    // Tenant and actor were copied before the first stage.
    const assignment = run.assignment;
    const mode = request.mode;
    const redaction = request.redaction;
    run.redaction = redaction;
    const readOnly = request.readOnly;
    const features = [...request.features];
    const requestSignal = request.signal;
    // What the mount knows of the confirmation: whether the client can be
    // asked, and the answer of a second round (ADR 0029).
    const elicitation = request.elicitation === true;
    const answer = request.answer;
    // A request the client has already cancelled ends as network, like
    // every aborted call, also without a tenant: the mount stops waiting
    // for the resolver on an abort and passes no tenant (ADR 0024).
    if (isAborted(requestSignal)) return failed('network');
    // Without a tenant, or with an answer the copy could not read, there is
    // no context to run the tool in. The call ends before a listener or a
    // context exists, with one audit line that holds the placeholders and
    // without a log line, since only a context writes one (ADR 0024).
    if (assignment === undefined) return failed('auth');
    const controller = new AbortController();
    const forward = (): void => {
      controller.abort(abortReason);
    };
    Reflect.apply(addListener as () => void, requestSignal, ['abort', forward]);
    run.detach = (): void => {
      Reflect.apply(removeListener as () => void, requestSignal, [
        'abort',
        forward,
      ]);
    };
    const ctx = createTenantContext({
      assignment,
      instance: origin,
      mode,
      redaction,
      readOnly,
      features,
      clock,
      signal: controller.signal,
      logging,
      tool: entry.name,
      eventId: run.eventId,
      // The log lines of a read of a run name the run (ADR 0033). The
      // context refuses an ID that is no UUID.
      ...(forRun === undefined && forWrite === undefined
        ? {}
        : { runId: (forRun ?? forWrite)?.tag.runId as RunId }),
    });
    run.ctx = ctx;

    // In strict, the pseudonyms of the call and the input with the IDs
    // they stand for, before the gate, so that a call the gate refuses
    // names the IDs of its input in the audit as well (ADR 0028, ADR
    // 0069). Opening derives keys and asks nothing outside the process. A
    // failure ends the call after the gate.
    let keysFailed = false;
    if (isStrictLevel(redaction) && entry.personIds) {
      try {
        if (options.keys === undefined) throw new TypeError('no keys');
        run.pseudonyms = await openPseudonyms(options.keys, ctx);
      } catch {
        keysFailed = true;
      }
      const pseudonyms = run.pseudonyms;
      if (
        pseudonyms !== undefined &&
        entry.inputRefs !== undefined &&
        fitsInput(input)
      ) {
        run.revealed = revealInput(input, entry.inputRefs, pseudonyms.reveal);
      }
    }

    // 3. gate: the rule for running unattended, the licence and, for a tool
    // treated as special and for every write tool, the audit file (ADR
    // 0028, ADR 0029).
    const { meta } = entry;
    const writes = meta.capability === 'write';
    if (meta.unattended === 'never' && mode !== 'interactive') {
      return failed('policy_denied');
    }
    // A run reads only with tools that are stable for routines, and never
    // writes through this way (ADR 0033); the engine checks the same before
    // the run, this holds also for an engine that forgot.
    if (forRun !== undefined && (writes || !meta.routineStable)) {
      return failed('policy_denied');
    }
    // A run writes only with a write tool of the core that is stable for
    // routines and may run unattended (ADR 0032, ADR 0071).
    if (
      forWrite !== undefined &&
      (!writes ||
        !meta.routineStable ||
        meta.unattended !== 'policy' ||
        entry.origin !== 'core')
    ) {
      return failed('policy_denied');
    }
    if (meta.tier === 'pro' && features.length === 0) {
      return failed('license_required');
    }
    // Before the input is checked and ChurchTools is asked, so that a
    // broken audit file costs no read and no quota (ADR 0028). A tool that
    // names persons counts here like a special one (ADR 0064). A run may
    // try again later, when the operator has fixed the file (ADR 0034).
    if ((entry.asSpecial || writes) && !auditReady()) {
      run.transient = true;
      return failed('policy_denied', auditNotReady);
    }

    // Without its keys, a call in strict cannot turn IDs into pseudonyms.
    if (keysFailed) {
      ctx.log.warn('pseudonym_keys_unavailable');
      return failed('internal');
    }

    // A write of a run: the core finds the page and its version itself
    // and builds the input of the write tool from it (run-write.ts).
    let given = input;
    let runPlan: RunPlanRequest | undefined;
    if (forWrite !== undefined) {
      const prepared = await prepareRunWrite(run, ctx, forWrite);
      if (!prepared.ok) return prepared.failure;
      given = prepared.input;
      runPlan = prepared.plan;
    }

    // 4. validateInput. The message of zod could repeat the input, so the
    // error carries the fixed sentence only. In strict the schema checks
    // the input with the IDs its pseudonyms stand for.
    if (!fitsInput(given)) return failed('validation');
    if (run.revealed?.ok === false) {
      return failed('validation', pseudonymExpected);
    }
    const parsedInput = entry.input.safeParse(
      run.revealed === undefined ? given : run.revealed.value,
    );
    if (!parsedInput.success) return failed('validation');
    // An ID the audit could not name does not reach ChurchTools (ADR 0028).
    const { refs, fits } = inputRefsOf(entry, parsedInput.data);
    if (!fits) return failed('validation');
    run.refs = refs;

    // The tool of the echo runs no code of its own: the core checks token
    // and summary and commits the plan they name (ADR 0029). Only the core
    // offers a tool of this name.
    if (entry.origin === 'core' && entry.name === echoToolName) {
      const confirmed = await echoed(
        run,
        ctx,
        parsedInput.data,
        () => isAborted(controller.signal),
        refs,
      );
      if (!confirmed.ok) return confirmed.failure;
      return finish(run, entry, ctx, redaction, confirmed.result);
    }

    // The second round of a question runs no tool: it commits the plan its
    // first round kept, or nothing (ADR 0029). Only a write tool asks.
    if (answer !== undefined) {
      if (!writes) return failed('validation');
      const written = await answered(
        run,
        ctx,
        entry.name,
        parsedInput.data,
        answer,
        () => isAborted(controller.signal),
        refs,
      );
      if (!written.ok) return written.failure;
      return finish(run, entry, ctx, redaction, written.result);
    }

    // The daily read budget, counted once the input is valid and before
    // ChurchTools is asked, so that a call that fails before costs nothing.
    // A call above the budget counts as well, which changes nothing (ADR
    // 0063).
    if (entry.asSpecial) {
      const counted = await countRead(ctx);
      if (counted !== 'ok') {
        // A store that cannot count may answer on a later try of a run; a
        // budget that is used up stays so for the day (ADR 0034).
        if (counted === 'unavailable') run.transient = true;
        ctx.log.warn(
          counted === 'exhausted'
            ? 'read_budget_exhausted'
            : 'read_budget_unavailable',
        );
        return failed(
          'policy_denied',
          counted === 'exhausted' ? exhausted : budgetUnavailable,
        );
      }
      // An abort while the store counted would pass unseen below.
      if (controller.signal.aborted) return failed('network');
    }

    // 5. execute, raced against the signal of the call.
    const access = createReadAccess(
      client,
      ctx,
      entry.meta.sensitivity,
      entry.asSpecial,
      entry.meta.domain,
      adder(refs),
    );
    run.access = access;
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => {
          reject(new EccliumError('network'));
        },
        { once: true },
      );
    });
    // Only a write tool gets a write port, valid for this call (ADR 0029).
    const writing = writes ? writeAccess(entry, ctx, runPlan) : undefined;
    const readCall: ToolCall<unknown> = {
      ctx,
      input: parsedInput.data,
      read: access.read,
    };
    let call = readCall;
    if (writing !== undefined) {
      const writeCall: WriteToolCall<unknown> = {
        ...readCall,
        write: writing.port,
      };
      call = writeCall;
    }
    const executed = Promise.resolve().then(() => entry.execute(call));
    // Whichever loses must not end as an unhandled rejection.
    aborted.catch(() => undefined);
    executed.catch(() => undefined);
    let result: unknown;
    try {
      result = await Promise.race([executed, aborted]);
    } catch (error) {
      // A refused plan ends the call with its own error, whatever the
      // tool made of it.
      if (writing !== undefined) {
        const refusal = writing.refusal();
        if (refusal !== undefined) return refused(run, writing, refusal);
      }
      return {
        outcome: Object.freeze({
          __proto__: null,
          ok: false,
          error: describeError(error),
        }),
        audit: 'error',
      };
    } finally {
      access.revoke();
      writing?.revoke();
    }

    // The way of a write after its plan: confirm, commit, and build the
    // result in the fixed form, never from what the tool returned.
    if (writing !== undefined) {
      const refusal = writing.refusal();
      if (refusal !== undefined) return refused(run, writing, refusal);
      if (forWrite !== undefined) {
        const end = await completeRunWrite(
          run,
          ctx,
          writing,
          result,
          forWrite.runWrites,
          refs,
        );
        if (!end.ok) return end.failure;
        return finish(run, entry, ctx, redaction, end.result);
      }
      const written = await completeWrite(
        run,
        ctx,
        writing,
        result,
        { input: parsedInput.data, elicitation, redaction },
        refs,
      );
      if (written.ok === 'input') {
        return {
          outcome: Object.freeze({
            __proto__: null,
            ok: false,
            error: describeError(
              new EccliumError('confirmation_required', questionSentence),
            ),
            question: written.question,
          }),
          audit: 'ok',
        };
      }
      if (!written.ok) return written.failure;
      result = written.result;
    }

    return finish(run, entry, ctx, redaction, result);
  };

  // The write port of one call: one plan, and none after the call ended.
  const writeAccess = (
    entry: CatalogEntry,
    ctx: TenantContext,
    runPlan?: RunPlanRequest,
  ): WriteAccess => {
    let open = true;
    let planned = false;
    let outcome: PlanOutcome | undefined;
    let target: WriteTarget | undefined;
    let text: ConfirmationText | undefined;
    let queue: PlanQueueReason | undefined;
    let drift: true | undefined;
    let refusal: EccliumError | undefined;
    let contentViolations: readonly ContentViolationKind[] | undefined;
    const port: WritePort = Object.freeze({
      plan: async (intent: unknown): Promise<PlanOutcome> => {
        if (!open || planned) throw new EccliumError('internal');
        planned = true;
        try {
          const result = await guard.plan(
            {
              ctx,
              tool: entry.name,
              origin: entry.origin,
              meta: {
                sensitivity: entry.meta.sensitivity,
                unattended: entry.meta.unattended,
                // Only a write tool gets a port, and every one declares it.
                reversible: entry.meta.reversible,
              },
              ...(runPlan === undefined ? {} : { run: runPlan }),
            },
            intent,
          );
          outcome = result.outcome;
          target = result.target;
          text = result.text;
          queue = result.queue;
          drift = result.rightsDriftAccepted;
          return result.outcome;
        } catch (error) {
          // The guard rejects only with an EccliumError or a refusal of
          // the content policy, whose reasons stay here for the audit and
          // never reach the tool (write/guard.ts).
          if (error instanceof ContentRefusal) {
            contentViolations = error.violations;
            refusal = error.error;
          } else {
            refusal = error as EccliumError;
          }
          throw refusal;
        }
      },
    });
    return Object.freeze({
      port,
      revoke: (): void => {
        open = false;
      },
      outcome: () => outcome,
      target: () => target,
      text: () => text,
      queue: () => queue,
      rightsDriftAccepted: () => drift,
      refusal: () => refusal,
      contentViolations: () => contentViolations,
    });
  };

  // A refused plan: a text the content policy refused is a refusal in the
  // audit, with its reasons, though its code says the model can change the
  // text (ADR 0030).
  const refused = (
    run: Run,
    writing: WriteAccess,
    refusal: EccliumError,
  ): { readonly outcome: ToolOutcome; readonly audit: AuditOutcome } => {
    const violations = writing.contentViolations();
    return violations === undefined
      ? writeFailure(run, refusal, false)
      : writeFailure(run, refusal, false, undefined, 'denied', violations);
  };

  // A write that ended with an error: its state and outcome for the audit.
  const writeFailure = (
    run: Run,
    error: EccliumError,
    sent: boolean,
    confirmation?: ConfirmationPath,
    state?: 'conflict' | 'failed' | 'denied',
    contentViolations?: readonly ContentViolationKind[],
  ): { readonly outcome: ToolOutcome; readonly audit: AuditOutcome } => {
    // The state the guard gives counts over the code: a write that may
    // have landed is never denied.
    const writeState = state ?? writeStateOf(error.code);
    run.write = Object.freeze({
      writeState,
      sent,
      ...(confirmation === undefined ? {} : { confirmation }),
      ...(contentViolations === undefined ? {} : { contentViolations }),
    });
    return {
      outcome: Object.freeze({
        __proto__: null,
        ok: false,
        error: describeError(error),
      }),
      audit: writeState === 'denied' ? 'denied' : 'error',
    };
  };

  // What a write ends with: the result the core built, or the failure.
  type WriteEnd =
    | { readonly ok: true; readonly result: Readonly<Record<string, unknown>> }
    | {
        readonly ok: false;
        readonly failure: {
          readonly outcome: ToolOutcome;
          readonly audit: AuditOutcome;
        };
      };

  // Confirms the plan the tool returned, in the order of ADR 0029: a
  // question to the client, then the echo, then the queue. A plan the
  // policy sends to the queue goes there, whatever the client can. The
  // tool must return exactly the outcome its plan gave; anything else is a
  // fault of the tool.
  const completeWrite = async (
    run: Run,
    ctx: TenantContext,
    writing: WriteAccess,
    returned: unknown,
    call: {
      readonly input: unknown;
      readonly elicitation: boolean;
      readonly redaction: RedactionLevel;
    },
    refs: ObjectRefCollector,
  ): Promise<
    WriteEnd | { readonly ok: 'input'; readonly question: ConfirmationQuestion }
  > => {
    const outcome = writing.outcome();
    const target = writing.target();
    if (outcome === undefined || target === undefined || returned !== outcome) {
      ctx.log.warn('tool_output_invalid');
      return { ok: false, failure: failed('internal') };
    }
    addTarget(refs, target);
    if (outcome.kind === 'skipped') {
      run.write = Object.freeze({ writeState: 'skipped', sent: false });
      return { ok: true, result: writeResult('skipped', target) };
    }
    // The guard gives every sealed plan its text; without one nobody could
    // see what to confirm.
    const text = writing.text();
    if (text === undefined) return { ok: false, failure: failed('internal') };
    const policyReason = writing.queue();
    const route =
      policyReason === undefined
        ? confirmationRouteOf(
            { setting, elicitation: call.elicitation, fits: text.fits },
            outcome.plan,
          )
        : ({ way: 'queue', reason: policyReason } as const);
    if (route.way === 'queue') {
      return enqueue(run, ctx, outcome.plan, text, route.reason, target);
    }
    if (route.way === 'echo' && confirmations !== undefined) {
      // The model reads the summary masked at the level of the call and
      // sends it back so; the token names the summary as it reads it.
      const shown = Object.freeze({
        ...text,
        summary: maskFreeTextAt(text.summary, call.redaction),
      });
      const echo = await confirmations.echo(ctx, outcome.plan, shown);
      if (echo.kind === 'refused') {
        return { ok: false, failure: writeFailure(run, echo.error, false) };
      }
      run.write = Object.freeze({ writeState: 'planned', sent: false });
      return { ok: true, result: plannedResult(target, echo.token, shown) };
    }
    if (route.way !== 'question' || confirmations === undefined) {
      return {
        ok: false,
        failure: writeFailure(
          run,
          new EccliumError('confirmation_required', confirmationSentence),
          false,
        ),
      };
    }
    const asked = await confirmations.ask(ctx, outcome.plan, call.input, text);
    if (asked.kind === 'refused') {
      return { ok: false, failure: writeFailure(run, asked.error, false) };
    }
    run.write = Object.freeze({ writeState: 'planned', sent: false });
    return { ok: 'input', question: asked.question };
  };

  // Keeps a plan as a sealed entry of the queue of approvals, under the ID
  // of the audit line of the call, so that the line of the request and the
  // line of the decision name the same entry (ADR 0031). A tenant with as
  // many waiting entries as it may have gets no further one.
  const enqueue = async (
    run: Run,
    ctx: TenantContext,
    plan: PlannedWrite,
    text: ConfirmationText,
    reason: QueueReason,
    target: WriteTarget,
  ): Promise<WriteEnd> => {
    const queue = options.queue;
    if (queue === undefined) {
      return {
        ok: false,
        failure: writeFailure(
          run,
          new EccliumError('confirmation_required', confirmationSentence),
          false,
        ),
      };
    }
    // An internal error reaches the model with its fixed sentence; the log
    // line tells the operator.
    const failedToQueue = (): WriteEnd => {
      ctx.log.warn('write_queue_failed', { code: 'internal' });
      return {
        ok: false,
        failure: writeFailure(run, new EccliumError('internal'), false),
      };
    };
    const queuedAt = now();
    const day = isoDateOf(queuedAt);
    // The pipeline draws an ID for every call before its first stage.
    const id = run.eventId as string;
    if (day === undefined) return failedToQueue();
    let waiting: number | undefined;
    try {
      waiting = await queue.waiting(ctx);
    } catch {
      waiting = undefined;
    }
    if (waiting === undefined) return failedToQueue();
    if (waiting >= maxWaiting) {
      ctx.log.warn('write_queue_full', { code: 'policy_denied' });
      return {
        ok: false,
        failure: writeFailure(
          run,
          new EccliumError('policy_denied', confirmationSentences.queueFull),
          false,
        ),
      };
    }
    try {
      await queue.enqueue(ctx, {
        id,
        day,
        content: queueEntryOf(plan, text, reason, queuedAt),
      });
    } catch {
      return failedToQueue();
    }
    ctx.log.info('write_queued');
    run.write = Object.freeze({ writeState: 'queued', sent: false });
    return { ok: true, result: queuedResult(target, id) };
  };

  // The second round of a question: the answer decides, the plan of the
  // first round is committed with the proof of a yes, and nothing else
  // runs, the tool included (ADR 0029).
  const answered = async (
    run: Run,
    ctx: TenantContext,
    tool: string,
    input: unknown,
    answer: ConfirmationAnswer,
    aborted: () => boolean,
    refs: ObjectRefCollector,
  ): Promise<WriteEnd> => {
    if (confirmations === undefined) {
      return {
        ok: false,
        failure: writeFailure(
          run,
          new EccliumError('confirmation_required', confirmationSentence),
          false,
        ),
      };
    }
    const confirmed = await confirmations.answer(ctx, tool, input, answer);
    if (confirmed.kind === 'refused') {
      return { ok: false, failure: writeFailure(run, confirmed.error, false) };
    }
    if (aborted()) return { ok: false, failure: failed('network') };
    return commitWrite(run, ctx, confirmed.plan, confirmed.proof, refs);
  };

  // The call of the tool of the echo: token and summary decide, the plan
  // they name is committed with the proof of the echo (ADR 0029).
  const echoed = async (
    run: Run,
    ctx: TenantContext,
    input: unknown,
    aborted: () => boolean,
    refs: ObjectRefCollector,
  ): Promise<WriteEnd> => {
    const { token, summary } = input as {
      readonly token: unknown;
      readonly summary: unknown;
    };
    const confirmed =
      confirmations === undefined
        ? undefined
        : await confirmations.confirmEcho(ctx, token, summary);
    if (confirmed?.kind !== 'confirmed') {
      const error =
        confirmed?.error ??
        new EccliumError('confirmation_required', confirmationSentence);
      return { ok: false, failure: writeFailure(run, error, false) };
    }
    if (aborted()) return { ok: false, failure: failed('network') };
    return commitWrite(run, ctx, confirmed.plan, confirmed.proof, refs);
  };

  // Commits a confirmed plan and builds the result in the fixed form.
  const commitWrite = async (
    run: Run,
    ctx: TenantContext,
    plan: PlannedWrite,
    proof: unknown,
    refs: ObjectRefCollector,
  ): Promise<WriteEnd> => {
    // The ID of the audit event names the snapshot of the write, so that
    // `ecclium undo` finds it from the line of the audit (ADR 0031).
    const committed = await guard.commit(ctx, plan, proof, run.eventId);
    if (!committed.ok) {
      addTarget(refs, committed.target);
      return {
        ok: false,
        failure: writeFailure(
          run,
          committed.error,
          committed.sent,
          committed.path,
          committed.state,
        ),
      };
    }
    // A new page names itself only now.
    addTarget(refs, committed.target);
    run.write = Object.freeze({
      writeState: 'verified',
      confirmation: committed.path,
      sent: true,
    });
    return {
      ok: true,
      result: writeResult(
        'verified',
        committed.target,
        committed.version,
        committed.undoId,
      ),
    };
  };

  // What a write of a run needs before its tool plans: the page and its
  // version, the contact values of the data the run read and the rights
  // its account may have (ADR 0030, ADR 0032). The data must carry the
  // mark of a redacted result, so that only what the pipeline read counts.
  const prepareRunWrite = async (
    run: Run,
    ctx: TenantContext,
    forWrite: RunWrite,
  ): Promise<
    | {
        readonly ok: true;
        readonly input: unknown;
        readonly plan: RunPlanRequest;
      }
    | {
        readonly ok: false;
        readonly failure: {
          readonly outcome: ToolOutcome;
          readonly audit: AuditOutcome;
        };
      }
  > => {
    const routine = forWrite.tag.routineId;
    const needs = runNeedsOf(
      catalog,
      options.policy,
      routine,
      forWrite.accountTools,
    );
    if (needs === undefined || !forWrite.data.every(isRedacted)) {
      return { ok: false, failure: failed('internal') };
    }
    let found: Awaited<ReturnType<typeof resolveRunPage>>;
    try {
      found = await resolveRunPage(client, ctx, forWrite.page);
    } catch (error) {
      return {
        ok: false,
        failure: failed(isEccliumError(error) ? error.code : 'internal'),
      };
    }
    if (!found.ok) {
      run.page = found.reason;
      ctx.log.warn(
        found.reason === 'missing' ? 'run_page_missing' : 'run_page_ambiguous',
      );
      return {
        ok: false,
        failure: failed(
          found.reason === 'missing' ? 'not_found' : 'conflict',
          found.reason === 'missing' ? runPageMissing : runPageAmbiguous,
        ),
      };
    }
    return {
      ok: true,
      input: {
        categoryId: found.categoryId,
        guid: found.guid,
        section: forWrite.section,
        baseVersion: found.version,
      },
      plan: Object.freeze({
        routine,
        period: forWrite.period,
        contacts: contactKeysIn(forWrite.data),
        needs,
        runWrites: forWrite.runWrites,
      }),
    };
  };

  // Ends the write of a run after its plan: skipped as written already, to
  // the queue for the reason the plan names, or committed with the proof of
  // the policy, which the write guard issues itself (ADR 0032). The result
  // has the fixed form of every write.
  const completeRunWrite = async (
    run: Run,
    ctx: TenantContext,
    writing: WriteAccess,
    returned: unknown,
    runWrites: RunWrites,
    refs: ObjectRefCollector,
  ): Promise<WriteEnd> => {
    const outcome = writing.outcome();
    const target = writing.target();
    if (outcome === undefined || target === undefined || returned !== outcome) {
      ctx.log.warn('tool_output_invalid');
      return { ok: false, failure: failed('internal') };
    }
    addTarget(refs, target);
    const drift = writing.rightsDriftAccepted();
    const noted = (record: WriteRecord): WriteRecord =>
      Object.freeze(
        drift === undefined
          ? record
          : { ...record, rightsDriftAccepted: drift },
      );
    if (outcome.kind === 'skipped') {
      run.write = noted({ writeState: 'skipped', sent: false, target });
      return { ok: true, result: writeResult('skipped', target) };
    }
    const text = writing.text();
    if (text === undefined) return { ok: false, failure: failed('internal') };
    const reason = writing.queue();
    if (reason !== undefined) {
      const queued = await enqueue(
        run,
        ctx,
        outcome.plan,
        text,
        reason,
        target,
      );
      if (queued.ok && run.write !== undefined) {
        run.write = noted({
          ...run.write,
          queueId: run.eventId,
          target,
        });
      }
      return queued;
    }
    const committed = await guard.commitForRun(
      ctx,
      outcome.plan,
      runWrites,
      run.eventId,
    );
    addTarget(refs, committed.target);
    if (!committed.ok) {
      const failure = writeFailure(
        run,
        committed.error,
        committed.sent,
        committed.path,
        committed.state,
      );
      // writeFailure has just set the state of the write.
      run.write = noted(run.write as WriteRecord);
      return { ok: false, failure };
    }
    run.write = noted({
      writeState: 'verified',
      confirmation: committed.path,
      sent: true,
      target: committed.target,
      version: committed.version,
      ...(committed.undoId === undefined ? {} : { undoId: committed.undoId }),
    });
    return {
      ok: true,
      result: writeResult(
        'verified',
        committed.target,
        committed.version,
        committed.undoId,
      ),
    };
  };

  // Counts one call against the daily read budget. A store that is
  // missing, throws, takes too long or answers with no count of 1 or more
  // counts as unavailable.
  const countRead = async (
    ctx: TenantContext,
  ): Promise<'ok' | 'exhausted' | 'unavailable'> => {
    // A budget of 0 refuses every call without the store, so that a store
    // that fails cannot give its sentence instead (ADR 0032).
    if (readBudget === 0) return 'exhausted';
    const store = options.quota;
    const day = isoDateOf(now());
    if (store === undefined || day === undefined) return 'unavailable';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const counting = Promise.resolve().then(() =>
      store.increment(ctx, 'special_reads', day),
    );
    // Whichever loses must not end as an unhandled rejection.
    counting.catch(() => undefined);
    const late = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        resolve(undefined);
      }, quotaTimeoutMs);
    });
    try {
      const counted: unknown = await Promise.race([counting, late]);
      if (
        typeof counted !== 'number' ||
        !Number.isSafeInteger(counted) ||
        counted < 1
      ) {
        return 'unavailable';
      }
      return counted > readBudget ? 'exhausted' : 'ok';
    } catch {
      return 'unavailable';
    } finally {
      clearTimeout(timer);
    }
  };

  // Only true counts, and a sink that throws is not ready.
  const auditReady = (): boolean => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- see above
      return audit.ready() === true;
    } catch {
      return false;
    }
  };

  // The IDs of a call for its audit line (ADR 0028). A call that ended
  // before its input was checked, such as one the gate refused, names the
  // IDs of its input if the input fits the schema. Only a call whose stages
  // ended with a result adds the IDs of the persons and groups it names,
  // also when the sink then holds that result back; a result over the
  // limit of size or a failed stage adds none.
  const objectRefsOf = (
    run: Run,
    input: unknown,
    ok: boolean,
  ): ObjectRefList => {
    const entry = run.entry;
    if (entry === undefined) return noRefs;
    let refs = run.refs;
    if (refs === undefined) {
      // In strict the IDs the pseudonyms of the input stand for. An input
      // whose pseudonyms do not open is read as it came, so that a raw ID
      // a model tried is named as well (ADR 0069).
      const source = run.revealed?.ok === true ? run.revealed.value : input;
      const parsed = fitsInput(source)
        ? entry.input.safeParse(source)
        : undefined;
      if (parsed?.success !== true) return noRefs;
      refs = inputRefsOf(entry, parsed.data).refs;
    }
    if (ok && run.output !== undefined) {
      // Walked whole first, so that a walk that fails leaves the IDs of
      // the request as they are.
      const found: [ObjectDomain, unknown][] = [];
      collectOutputRefs(run.output, entry.shape.root, (domain, value) => {
        found.push([domain, value]);
      });
      for (const [domain, value] of found) refs.add(domain, value);
    }
    return refs.list();
  };

  // A clock that throws must not cost the audit of the call.
  const now = (): number => {
    try {
      return clock.now();
    } catch {
      return Number.NaN;
    }
  };

  // The duration of a call or an undo for its audit line, 0 without a
  // clock that answers, at most the longest the audit accepts.
  const durationSince = (start: number): number => {
    const elapsed = Math.round(now() - start);
    return Number.isFinite(elapsed)
      ? Math.min(Math.max(elapsed, 0), maxDurationMs)
      : 0;
  };

  // One call through every stage, for a client or for a read of a run,
  // with its state for the caller.
  const callWith = async (
    name: string,
    input: unknown,
    request: ToolRequest,
    forRun?: Run['forRun'],
    forWrite?: RunWrite,
  ): Promise<{ readonly outcome: ToolOutcome; readonly run: Run }> => {
    const run: Run = {
      ...(forRun === undefined ? {} : { forRun }),
      ...(forWrite === undefined ? {} : { forWrite }),
    };
    // The run a read or a write of a run belongs to, for its audit line.
    const tag = forRun?.tag ?? forWrite?.tag;
    let outcome = internalOutcome;
    let auditOutcome: AuditOutcome = 'error';
    const start = now();
    let mode: Mode | undefined;
    try {
      // Before the first stage, so that the call of an unknown tool is
      // audited with its tenant as well.
      run.assignment = copyAssignment(request.assignment);
      mode = request.mode;
      // One ID per call, drawn after these copies, so that an ID source
      // that throws still leaves tenant, actor and mode to the audit line,
      // and before the first stage and the first log line. The context
      // binds it to the log lines of the call and the sink writes it into
      // the audit line, so both can be joined (ADR 0054). It travels as an
      // argument of record, never as a field a tool or plugin could set.
      // Without it the sink draws an ID of its own.
      run.eventId = randomUUID();
      ({ outcome, audit: auditOutcome } = await stages(
        run,
        name,
        input,
        request,
      ));
      // A call that fails before the level is copied is masked as standard.
      // A question carries a fixed sentence, which no level changes; were it
      // ever changed, the question would go and the client get the error,
      // which writes nothing.
      if (!outcome.ok) {
        const error = maskErrorDescription(
          outcome.error,
          run.redaction ?? 'standard',
        );
        if (error !== outcome.error) {
          outcome = Object.freeze({ __proto__: null, ok: false, error });
        }
      }
    } catch {
      // The outermost catch calls nothing, describeError included.
      outcome = internalOutcome;
      auditOutcome = 'error';
    } finally {
      // Whether the result needs its line in the audit file, read before
      // anything here can throw (ADR 0028, ADR 0064). The result of a write
      // goes out also without its line: it holds no data of ChurchTools,
      // and held back it would make the model write again (ADR 0029).
      const special =
        run.entry?.asSpecial === true && run.entry.meta.capability !== 'write';
      let recorded = false;
      let durationMs = 0;
      try {
        run.access?.revoke();
        run.detach?.();
        durationMs = durationSince(start);
        // Deriving the IDs never costs the line of the call, and a result
        // whose IDs cannot be derived does not go out (ADR 0028).
        let refs = noRefs;
        try {
          refs = objectRefsOf(run, input, outcome.ok);
        } catch {
          // The IDs of the request, as a call without a result names them.
          refs = run.refs?.list() ?? noRefs;
          if (outcome.ok) {
            outcome = internalOutcome;
            auditOutcome = 'error';
          }
        }
        // A question is no error: the write waits as planned (ADR 0029).
        const errorCode =
          outcome.ok || outcome.question !== undefined
            ? undefined
            : outcome.error.code;
        const writeState = writeStateOfCall(run, auditOutcome, outcome.ok);
        // Tenant and actor come from the frozen copy only, which runs no
        // code of the resolver's answer. Without one the audit takes its
        // placeholders, which no context accepts as real values, so a call
        // without a tenant is no invalid field for the sink to report.
        // Only true counts, also from a sink without types.
        recorded =
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- see above
          audit.record(
            {
              type: 'tool_call',
              tenantId: run.assignment?.tenantId ?? auditPlaceholders.tenantId,
              actor: run.assignment?.actor ?? auditPlaceholders.actor,
              // An invalid value becomes a placeholder in the sink.
              mode: mode as Mode,
              tool: run.entry?.name ?? 'ct_unknown',
              outcome: auditOutcome,
              ...(run.write?.confirmation === undefined
                ? {}
                : { confirmation: run.write.confirmation }),
              ...(writeState === undefined ? {} : { writeState }),
              ...(run.entry?.meta.capability === 'write' ? { policyHash } : {}),
              // A read of a run names its run, routine, policy and model,
              // so that the audit shows which data went to which model
              // (ADR 0033).
              ...(tag === undefined
                ? {}
                : {
                    runId: tag.runId,
                    routineId: tag.routineId,
                    policyHash,
                    ...(tag.provider === undefined
                      ? {}
                      : { provider: tag.provider }),
                  }),
              // A write of a run under the exception of the policy for
              // rights its account should not have (ADR 0032).
              ...(run.write?.rightsDriftAccepted === true
                ? { rightsDriftAccepted: true as const }
                : {}),
              ...(errorCode === undefined ? {} : { errorCode }),
              ...(run.write?.contentViolations === undefined
                ? {}
                : { contentViolations: run.write.contentViolations }),
              objectRefs: refs.refs,
              ...(refs.omitted > 0 ? { objectRefsOmitted: refs.omitted } : {}),
              durationMs,
            },
            run.eventId,
            { required: special && outcome.ok },
          ) === true;
      } catch {
        // The audit never decides the outcome of a reading call, except
        // for the result of a tool treated as special below.
      }
      // After a call that may have written: an anchor of the chain on the
      // log, and when its line did not reach the audit file, no further
      // write until the process ends (ADR 0029).
      if (run.write?.sent === true) {
        if (!recorded) {
          guard.block();
          try {
            run.ctx?.log.error('write_audit_failed');
          } catch {
            // The block holds without its log line.
          }
        }
        try {
          audit.anchor?.();
        } catch {
          // The anchor is lost; the line is in the file or reported.
        }
      }
      // The keys of the call go once its line is written, also after a
      // failure (ADR 0069).
      try {
        run.pseudonyms?.erase();
      } catch {
        // Erasing only fills bytes with zeros; nothing is left to undo.
      }
      // Whatever threw above: the result of a tool treated as special goes
      // out only with its line in the audit file (ADR 0028).
      const withheld = outcome.ok && special && !recorded;
      if (withheld) {
        outcome = withheldOutcome;
        // The file may take the line on a later try of a run (ADR 0034).
        run.transient = true;
      }
      try {
        const errorCode =
          outcome.ok || outcome.question !== undefined
            ? undefined
            : outcome.error.code;
        if (withheld) {
          run.ctx?.log.warn('audit_withheld', { code: 'policy_denied' });
        }
        run.ctx?.log.info('tool_call', {
          durationMs,
          ...(errorCode === undefined ? {} : { code: errorCode }),
        });
      } catch {
        // The log never decides the outcome.
      }
    }
    return { outcome, run };
  };

  const call = async (
    name: string,
    input: unknown,
    request: ToolRequest,
  ): Promise<ToolOutcome> => (await callWith(name, input, request)).outcome;

  // A read of a run (ADR 0033): the stages of every call, in the mode
  // unattended and without writing, and what the run needs besides the
  // data. The request is copied through own data properties, so that no
  // getter of the composition root's object answers twice.
  const callForRun = async (
    name: string,
    input: unknown,
    request: RunCallRequest,
  ): Promise<RunCallOutcome> => {
    try {
      const tag = ownData(request, 'run') as RunTag;
      const provider = ownData(tag, 'provider') as ProviderInfo | undefined;
      const forRun = Object.freeze({
        tag: Object.freeze({
          runId: ownData(tag, 'runId') as string,
          routineId: ownData(tag, 'routineId') as string,
          ...(provider === undefined ? {} : { provider }),
        }),
        maxEntries: ownData(request, 'maxEntries') as number,
      });
      const { outcome, run } = await callWith(
        name,
        input,
        {
          assignment: ownData(request, 'assignment') as TenantAssignment,
          mode: 'unattended',
          redaction: ownData(request, 'redaction') as RedactionLevel,
          readOnly: true,
          features: ownData(request, 'features') as readonly FeatureKey[],
          signal: ownData(request, 'signal') as AbortSignal,
        },
        forRun,
      );
      if (outcome.ok) {
        // A read of a run that ends with a result went through finish,
        // which leaves what the run needs besides the data.
        return Object.freeze({
          ok: true,
          data: outcome.data,
          ...(run.runResult as NonNullable<Run['runResult']>),
        });
      }
      const code = outcome.error.code;
      return Object.freeze({
        ok: false,
        code,
        transient: run.transient ?? isTransientRunCode(code),
      });
    } catch {
      // A request that cannot be read is a fault of the caller.
      return Object.freeze({ ok: false, code: 'internal', transient: false });
    }
  };

  // A write of a run (ADR 0032): the stages of every call, in the mode
  // unattended, with the write tool of the routine and an input the core
  // builds itself from the page it finds. The request is copied through
  // own data properties, so that no getter of the composition root's
  // object answers twice.
  const writeForRun = async (
    request: RunWriteRequest,
  ): Promise<RunWriteOutcome> => {
    const fault = Object.freeze({
      ok: false,
      code: 'internal',
      sent: false,
      transient: false,
    } as const);
    try {
      const tag = ownData(request, 'run') as RunTag;
      const provider = ownData(tag, 'provider') as ProviderInfo | undefined;
      const page = ownData(request, 'page');
      const data = ownData(request, 'data');
      const accountTools = ownData(request, 'accountTools');
      if (
        !isPlainTarget(page) ||
        !Array.isArray(data) ||
        !Array.isArray(accountTools)
      ) {
        return fault;
      }
      const guid = ownData(page, 'guid');
      const title = ownData(page, 'title');
      const categoryId = ownData(page, 'categoryId') as number;
      const forWrite: RunWrite = Object.freeze({
        tag: Object.freeze({
          runId: ownData(tag, 'runId') as string,
          routineId: ownData(tag, 'routineId') as string,
          ...(provider === undefined ? {} : { provider }),
        }),
        period: ownData(request, 'period') as string,
        section: ownData(request, 'section') as string,
        page: Object.freeze(
          typeof guid === 'string'
            ? { categoryId, guid }
            : { categoryId, title: title as string },
        ),
        data: Object.freeze([...(data as readonly unknown[])]),
        accountTools: Object.freeze([...(accountTools as string[])]),
        runWrites: ownData(request, 'runWrites') as RunWrites,
      });
      const { outcome, run } = await callWith(
        ownData(request, 'tool') as string,
        {},
        {
          assignment: ownData(request, 'assignment') as TenantAssignment,
          mode: 'unattended',
          // The result of a write names a target and a version, no data of
          // a person, so the level of the call keys nothing.
          redaction: 'standard',
          // Anything but false only reads, so that a request built wrong
          // never writes.
          readOnly: ownData(request, 'readOnly') !== false,
          features: ownData(request, 'features') as readonly FeatureKey[],
          signal: ownData(request, 'signal') as AbortSignal,
        },
        undefined,
        forWrite,
      );
      const write = run.write;
      if (outcome.ok) {
        // A write with a result went through completeRunWrite, which left
        // its state, verified, queued or skipped, and its target.
        const done = write as WriteRecord;
        const target = done.target as WriteTarget;
        if (done.writeState === 'verified') {
          return Object.freeze({
            ok: true,
            state: 'verified',
            target,
            version: done.version as number,
            ...(done.undoId === undefined ? {} : { undoId: done.undoId }),
          });
        }
        if (done.writeState === 'queued') {
          return Object.freeze({
            ok: true,
            state: 'queued',
            target,
            queueId: done.queueId as string,
          });
        }
        return Object.freeze({ ok: true, state: 'skipped', target });
      }
      const code = outcome.error.code;
      // Writes halted after a lost line of the audit write again after a
      // restart, like an audit file that cannot take a line now, so a later
      // run may pass (ADR 0029, ADR 0034). The halt is the first check of
      // every plan and commit, so a refusal while it holds is its own.
      const halted = code === 'policy_denied' && guard.halted();
      // A page that is missing or twice ends the trigger; a write that may
      // have landed may try again, since its marking keeps a second run
      // from adding it twice (ADR 0032, ADR 0034).
      return Object.freeze({
        ok: false,
        code,
        ...(run.page === undefined ? {} : { page: run.page }),
        sent: write?.sent === true,
        transient:
          run.page === undefined &&
          (run.transient ??
            (halted || isTransientRunCode(code) || code === 'conflict')),
      });
    } catch {
      // A request that cannot be read is a fault of the caller.
      return fault;
    }
  };

  // The end of a run (ADR 0033): one line of the type run. Tenant, actor
  // and mode follow from the routine of the run, as for its reads and its
  // write, so that no caller ends a run in the name of another actor. The
  // request is copied through own data properties, so that no getter of
  // the composition root's object answers twice; the sink checks every
  // value it gets.
  const endRun = (request: RunEndRequest): boolean => {
    try {
      // A proxy would run its traps on every read.
      if (!isPlainTarget(request)) return false;
      const tag = ownData(request, 'run');
      if (!isPlainTarget(tag)) return false;
      const runId = ownData(tag, 'runId');
      const routineId = ownData(tag, 'routineId');
      const provider = ownData(tag, 'provider');
      let assignment: TenantAssignment | undefined;
      try {
        assignment = runAssignmentOf(routineId as string);
      } catch {
        // An ID that is no routine: the line takes the placeholders, names
        // no routine and claims nothing, whatever the caller said.
      }
      const named = assignment !== undefined;
      const result = named ? ownData(request, 'result') : 'failed';
      const failedRun = result === 'failed';
      const refused =
        named && failedRun && ownData(request, 'refused') === true;
      const code = named
        ? (ownData(request, 'code') ?? 'internal')
        : 'internal';
      const step = ownData(request, 'step');
      const reasons = ownData(request, 'contentViolations');
      const attempt = ownData(request, 'attempt');
      const period = ownData(request, 'period');
      const recorded =
        // Only true counts, also from a sink without types.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- see above
        audit.record({
          type: 'run',
          tenantId: assignment?.tenantId ?? auditPlaceholders.tenantId,
          actor: assignment?.actor ?? auditPlaceholders.actor,
          mode: 'unattended',
          runId: runId as string,
          ...(assignment === undefined
            ? {}
            : { routineId: routineId as string }),
          outcome: !failedRun ? 'ok' : refused ? 'denied' : 'error',
          policyHash,
          ...(provider === undefined
            ? {}
            : { provider: provider as ProviderInfo }),
          objectRefs: [],
          ...(failedRun ? { errorCode: code as ErrorCode } : {}),
          ...(refused && reasons !== undefined
            ? { contentViolations: reasons as readonly ContentViolationKind[] }
            : {}),
          runResult: result as AuditRunResult,
          ...(failedRun && step !== undefined
            ? { runStep: step as AuditRunStep }
            : {}),
          ...(attempt === undefined ? {} : { attempt: attempt as number }),
          ...(period === undefined ? {} : { period: period as string }),
          durationMs: ownData(request, 'durationMs') as number,
        }) === true;
      // A line without its routine is whole, but it is not the end of
      // this run, so the caller hears of the fault.
      return recorded && named;
    } catch {
      // The end of a run never throws; a line it cannot write is lost.
      return false;
    }
  };

  // One undo of the operator (ADR 0031): from the ID of the audit line of a
  // write to the snapshot, through the write guard, to an audit line of
  // its own of the type undo that names the write. What the guard read of
  // the page leaves only as the diff for the operator.
  const undoStages = async (
    undo: UndoCall,
    request: ToolRequest,
    assignment: TenantAssignment | undefined,
    eventId: string,
    refs: ObjectRefCollector,
  ): Promise<UndoEnd> => {
    // Only the command line of the operator takes a write back, never a
    // client of the model, whatever mode its mount passes (ADR 0024).
    if (request.mode !== 'operator') return undoRefused('policy_denied');
    if (isAborted(request.signal)) return undoRefused('network');
    if (assignment === undefined) return undoRefused('auth');
    const ctx = createTenantContext({
      assignment,
      instance: origin,
      mode: request.mode,
      redaction: request.redaction,
      readOnly: request.readOnly,
      features: [...request.features],
      clock,
      signal: request.signal,
      logging,
      eventId,
    });
    const end = await undoWith(ctx, undo, eventId, refs);
    return { ...end, ctx };
  };

  const undoWith = async (
    ctx: TenantContext,
    undo: UndoCall,
    eventId: string,
    refs: ObjectRefCollector,
  ): Promise<UndoEnd> => {
    // As for every write, nothing runs while the audit file cannot take
    // its line (ADR 0028, ADR 0029).
    if (!auditReady()) return undoRefused('policy_denied', 'auditNotReady');
    const snapshots = options.snapshots;
    if (snapshots === undefined) {
      return undoEnd({ kind: 'off' }, 'denied', 'policy_denied');
    }
    // A record that does not open, or a store that fails, ends the undo
    // with its log line, as an internal error.
    let loaded: Awaited<ReturnType<WriteSnapshots['load']>>;
    try {
      loaded = await snapshots.load(ctx, undo.eventId as string);
    } catch {
      return undoRefused('internal');
    }
    if (loaded.kind !== 'found') {
      return undoEnd({ kind: loaded.kind }, 'failed', 'not_found');
    }
    // What the undo takes back, for the texts of the command line.
    const subject = undoSubjectOf(loaded.before);
    const result = await guard.undo({
      ctx,
      eventId,
      snapshot: {
        before: loaded.before,
        ...(loaded.after === undefined ? {} : { after: loaded.after }),
        day: loaded.day,
      },
      overwrite: undo.overwrite,
    });
    switch (result.kind) {
      case 'unchanged':
        addTarget(refs, result.target);
        return undoEnd({ kind: 'unchanged', subject }, 'skipped');
      case 'changed':
        addTarget(refs, result.target);
        return undoEnd(
          {
            kind: 'changed',
            subject,
            diff: diffLines(result.change.from, result.change.to),
          },
          // Nothing was sent over the change of a person (ADR 0029).
          'denied',
          'conflict',
        );
      case 'incomplete':
        addTarget(refs, result.target);
        return undoEnd(
          { kind: 'incomplete', subject, placeId: Number(result.target.key) },
          'failed',
          'not_found',
        );
      case 'refused':
        return undoRefused(result.error.code, reasonOf(result.error), subject);
      case 'deleted':
        addTarget(refs, result.target);
        return undoEnd(
          {
            kind: 'deleted',
            subject,
            diff: diffLines(result.change.from, result.change.to),
          },
          'verified',
          undefined,
          'operator',
          true,
        );
      case 'committed':
        break;
    }
    const committed = result.result;
    const diff = diffLines(result.change.from, result.change.to);
    addTarget(refs, result.target);
    if (committed.ok) {
      return undoEnd(
        {
          kind: 'done',
          subject,
          version: committed.version,
          undoId: committed.undoId,
          diff,
        },
        'verified',
        undefined,
        committed.path,
        true,
      );
    }
    const reason = reasonOf(committed.error);
    return undoEnd(
      {
        kind: 'failed',
        subject,
        code: committed.error.code,
        ...(reason === undefined ? {} : { reason }),
        state: committed.state,
        sent: committed.sent,
        diff,
      },
      committed.state,
      committed.error.code,
      committed.path,
      committed.sent,
    );
  };

  const undo = async (
    undoCall: UndoCall,
    request: ToolRequest,
  ): Promise<UndoOutcome> => {
    // The ID of the undo itself: its audit line and its own snapshot, so
    // that an undo can be taken back as well.
    const eventId = randomUUID();
    const start = now();
    const refs = createObjectRefCollector();
    let assignment: TenantAssignment | undefined;
    let mode: Mode | undefined;
    // The ID of the write is named only in the form of an ID, checked
    // before anything else reads it.
    const undoes =
      typeof undoCall.eventId === 'string' && isUuid(undoCall.eventId)
        ? undoCall.eventId
        : undefined;
    let run: UndoRun | null | undefined;
    let end: UndoEnd = undoRefused('internal');
    let recorded = false;
    try {
      run = undoRunOf(undoCall.run);
      assignment = copyAssignment(request.assignment);
      mode = request.mode;
      end =
        undoes === undefined || run === null
          ? undoRefused('validation')
          : await undoStages(
              { eventId: undoes, overwrite: undoCall.overwrite },
              request,
              assignment,
              eventId,
              refs,
            );
    } catch {
      end = undoRefused('internal');
    } finally {
      const durationMs = durationSince(start);
      try {
        recorded =
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- only true counts, also from a sink without types
          audit.record(
            {
              type: 'undo',
              tenantId: assignment?.tenantId ?? auditPlaceholders.tenantId,
              actor: assignment?.actor ?? auditPlaceholders.actor,
              mode: mode as Mode,
              // The run whose write the undo takes back, so that the run
              // shows it (ADR 0028).
              ...(run === undefined || run === null
                ? {}
                : { runId: run.runId, routineId: run.routineId }),
              outcome: end.audit,
              undoes: undoes ?? auditPlaceholders.eventId,
              ...(end.confirmation === undefined
                ? {}
                : { confirmation: end.confirmation }),
              writeState: end.writeState,
              ...(end.errorCode === undefined
                ? {}
                : { errorCode: end.errorCode }),
              // At most a category and a page, never over the limit.
              objectRefs: refs.list().refs,
              durationMs,
            },
            eventId,
            { required: false },
          ) === true;
      } catch {
        // A line that does not reach the file is handled below.
      }
      // An undo that may have written and whose line is not in the audit
      // file stops every later write, as for a write of a tool (ADR 0029).
      if (end.sent) {
        if (!recorded) {
          guard.block();
          try {
            end.ctx?.log.error('write_audit_failed');
          } catch {
            // The block holds without its log line.
          }
        }
        try {
          audit.anchor?.();
        } catch {
          // The anchor is lost; the line is in the file or reported.
        }
      }
      try {
        end.ctx?.log.info('undo_call', {
          durationMs,
          ...(end.errorCode === undefined ? {} : { code: end.errorCode }),
        });
      } catch {
        // The log never decides the outcome.
      }
    }
    // An undo that may have written without its line in the audit file
    // says so, for the operator to check the audit (ADR 0028, ADR 0029).
    return end.sent && !recorded
      ? Object.freeze({ ...end.outcome, unrecorded: true })
      : end.outcome;
  };

  // An adoption of the operator (ADR 0032): from the run, its period, the
  // page and the writes of its routine, through the snapshots of those
  // writes and the write guard, to an audit line of its own of the type
  // adoption that names the run. What the guard read of the page leaves
  // only for the operator.
  const adopt = async (
    adoptCall: AdoptCall,
    request: ToolRequest,
  ): Promise<AdoptOutcome> => {
    // The ID of the adoption itself: its audit line and its own snapshot,
    // so that `ecclium undo` can take it back.
    const eventId = randomUUID();
    const start = now();
    const refs = createObjectRefCollector();
    let assignment: TenantAssignment | undefined;
    let mode: Mode | undefined;
    let run: UndoRun | null | undefined;
    let end: AdoptEnd = adoptRefused('internal');
    let recorded = false;
    try {
      // The run first: it names the line of the audit even when the rest
      // of the call is built wrong.
      run = undoRunOf(adoptCall.run);
      assignment = copyAssignment(request.assignment);
      mode = request.mode;
      const checked = adoptCallOf(adoptCall);
      end =
        run === null || run === undefined || checked === undefined
          ? adoptRefused('validation')
          : await adoptStages(run, checked, request, assignment, eventId, refs);
    } catch {
      end = adoptRefused('internal');
    } finally {
      const durationMs = durationSince(start);
      try {
        recorded =
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- only true counts, also from a sink without types
          audit.record(
            {
              type: 'adoption',
              tenantId: assignment?.tenantId ?? auditPlaceholders.tenantId,
              actor: assignment?.actor ?? auditPlaceholders.actor,
              mode: mode as Mode,
              // The run whose section it signs, so that the run shows the
              // adoption (ADR 0028); the zero UUID for one built wrong.
              ...(run === undefined || run === null
                ? { runId: auditPlaceholders.runId }
                : { runId: run.runId, routineId: run.routineId }),
              outcome: writeStateOutcomes[end.writeState],
              ...(end.confirmation === undefined
                ? {}
                : { confirmation: end.confirmation }),
              writeState: end.writeState,
              ...(end.errorCode === undefined
                ? {}
                : { errorCode: end.errorCode }),
              // At most a category and a page, never over the limit.
              objectRefs: refs.list().refs,
              durationMs,
            },
            eventId,
            { required: false },
          ) === true;
      } catch {
        // A line that does not reach the file is handled below.
      }
      // An adoption that may have written and whose line is not in the
      // audit file stops every later write, as for a write of a tool
      // (ADR 0029).
      if (end.sent) {
        if (!recorded) {
          guard.block();
          try {
            end.ctx?.log.error('write_audit_failed');
          } catch {
            // The block holds without its log line.
          }
        }
        try {
          audit.anchor?.();
        } catch {
          // The anchor is lost; the line is in the file or reported.
        }
      }
      try {
        end.ctx?.log.info('adoption_call', {
          durationMs,
          ...(end.errorCode === undefined ? {} : { code: end.errorCode }),
        });
      } catch {
        // The log never decides the outcome.
      }
    }
    return end.sent && !recorded
      ? Object.freeze({ ...end.outcome, unrecorded: true })
      : end.outcome;
  };

  const adoptStages = async (
    run: UndoRun,
    call: CheckedAdoptCall,
    request: ToolRequest,
    assignment: TenantAssignment | undefined,
    eventId: string,
    refs: ObjectRefCollector,
  ): Promise<AdoptEnd> => {
    // Only the command line of the operator signs anew, never a client of
    // the model, whatever mode its mount passes (ADR 0024).
    if (request.mode !== 'operator') return adoptRefused('policy_denied');
    if (isAborted(request.signal)) return adoptRefused('network');
    if (assignment === undefined) return adoptRefused('auth');
    const ctx = createTenantContext({
      assignment,
      instance: origin,
      mode: request.mode,
      redaction: request.redaction,
      readOnly: request.readOnly,
      features: [...request.features],
      clock,
      signal: request.signal,
      logging,
      eventId,
    });
    const end = await adoptWith(ctx, run, call, eventId, refs);
    return { ...end, ctx };
  };

  const adoptWith = async (
    ctx: TenantContext,
    run: UndoRun,
    call: CheckedAdoptCall,
    eventId: string,
    refs: ObjectRefCollector,
  ): Promise<AdoptEnd> => {
    // As for every write, nothing runs while the audit file cannot take
    // its line (ADR 0028, ADR 0029).
    if (!auditReady()) return adoptRefused('policy_denied', 'auditNotReady');
    const snapshots = options.snapshots;
    if (snapshots === undefined) {
      return adoptEnd({ kind: 'off' }, 'denied', 'policy_denied');
    }
    // The snapshots of the writes, the newest first; one gone after its
    // retention or whose day key is gone proves nothing.
    const found: SnapshotToUndo[] = [];
    for (const write of call.writeIds) {
      let loaded: Awaited<ReturnType<WriteSnapshots['load']>>;
      try {
        loaded = await snapshots.load(ctx, write);
      } catch {
        return adoptRefused('internal');
      }
      if (loaded.kind !== 'found') continue;
      found.push({
        before: loaded.before,
        ...(loaded.after === undefined ? {} : { after: loaded.after }),
        day: loaded.day,
      });
    }
    const result = await guard.adopt({
      ctx,
      eventId,
      routine: run.routineId,
      period: call.period,
      page: call.page,
      snapshots: found,
      confirm: call.confirm,
    });
    if (result.kind === 'refused') {
      return adoptRefused(result.error.code, reasonOf(result.error));
    }
    addTarget(refs, result.target);
    switch (result.kind) {
      case 'own':
        return adoptEnd({ kind: 'own' }, 'skipped');
      case 'none':
        return adoptEnd({ kind: 'none' }, 'denied', 'not_found');
      case 'renamed':
        return adoptEnd({ kind: 'renamed' }, 'denied', 'conflict');
      case 'unclear':
        return adoptEnd(
          { kind: 'unclear', reason: result.reason },
          'denied',
          'conflict',
        );
      case 'unproven':
        return adoptEnd(
          {
            kind: 'unproven',
            range: result.range,
            snapshots: result.snapshots,
          },
          'denied',
          'conflict',
        );
      case 'unsignable':
        return adoptEnd(
          { kind: 'unsignable', range: result.range },
          'denied',
          'conflict',
        );
      case 'preview':
        return adoptEnd({ kind: 'preview', shown: result.shown }, 'planned');
      case 'mismatch':
        return adoptEnd(
          { kind: 'mismatch', shown: result.shown },
          'denied',
          'conflict',
        );
      case 'committed':
        break;
    }
    const { shown } = result;
    const committed = result.result;
    if (committed.ok) {
      return adoptEnd(
        {
          kind: 'done',
          shown,
          version: committed.version,
          undoId: committed.undoId,
        },
        'verified',
        undefined,
        committed.path,
        true,
      );
    }
    const reason = reasonOf(committed.error);
    return adoptEnd(
      {
        kind: 'failed',
        code: committed.error.code,
        ...(reason === undefined ? {} : { reason }),
        state: committed.state,
        sent: committed.sent,
        shown,
      },
      committed.state,
      committed.error.code,
      committed.path,
      committed.sent,
    );
  };

  // The context of a call of the operator on the queue: only the command
  // line of the operator reaches the queue, never a client of the model,
  // whatever mode its mount passes (ADR 0024, ADR 0031).
  const operatorContext = (
    request: ToolRequest,
    assignment: TenantAssignment | undefined,
    eventId: string,
  ): TenantContext | ErrorCode => {
    if (request.mode !== 'operator') return 'policy_denied';
    if (isAborted(request.signal)) return 'network';
    if (assignment === undefined) return 'auth';
    return createTenantContext({
      assignment,
      instance: origin,
      mode: request.mode,
      redaction: request.redaction,
      readOnly: request.readOnly,
      features: [...request.features],
      clock,
      signal: request.signal,
      logging,
      eventId,
    });
  };

  const listQueue = async (request: ToolRequest): Promise<QueueListOutcome> => {
    try {
      const ctx = operatorContext(
        request,
        copyAssignment(request.assignment),
        randomUUID(),
      );
      if (typeof ctx === 'string')
        return Object.freeze({ kind: 'failed', code: ctx });
      const queue = options.queue;
      if (queue === undefined) return Object.freeze({ kind: 'off' });
      // An entry that waits but whose decision was counted is used: its
      // outcome stands in the audit, and it can no longer be decided.
      const entries: QueueListing[] = [];
      for (const entry of await queue.list(ctx)) {
        entries.push(
          entry.state === 'open' &&
            (await decisionCounted(ctx, entry.id, entry.content, entry.day))
            ? Object.freeze({ state: 'used', id: entry.id, day: entry.day })
            : entry,
        );
      }
      return Object.freeze({ kind: 'listed', entries: Object.freeze(entries) });
    } catch {
      return Object.freeze({ kind: 'failed', code: 'internal' });
    }
  };

  const showQueue = async (
    call: QueueCall,
    request: ToolRequest,
  ): Promise<QueueShowOutcome> => {
    try {
      // The ID is checked before anything else reads it.
      if (typeof call.queueId !== 'string' || !isUuid(call.queueId)) {
        return Object.freeze({ kind: 'failed', code: 'validation' });
      }
      const ctx = operatorContext(
        request,
        copyAssignment(request.assignment),
        randomUUID(),
      );
      if (typeof ctx === 'string')
        return Object.freeze({ kind: 'failed', code: ctx });
      const queue = options.queue;
      if (queue === undefined) return Object.freeze({ kind: 'off' });
      const loaded = await queue.load(ctx, call.queueId);
      switch (loaded.kind) {
        case 'missing':
          return Object.freeze({ kind: 'missing' });
        case 'expired':
          return Object.freeze({ kind: 'expired' });
        case 'decided':
          return Object.freeze({
            kind: 'decided',
            decision: loaded.decision.decision,
            decidedAt: loaded.decision.decidedAt,
          });
        case 'found':
          return (await decisionCounted(
            ctx,
            call.queueId,
            loaded.content,
            loaded.day,
          ))
            ? Object.freeze({ kind: 'used' })
            : Object.freeze({
                kind: 'found',
                day: loaded.day,
                content: loaded.content,
              });
      }
    } catch {
      return Object.freeze({ kind: 'failed', code: 'internal' });
    }
  };

  // A call of the store of quotas within its time: what it gave, `late`
  // when it took too long and may still land, or `failed` when it threw.
  const inQuotaTime = async <T>(
    run: () => Promise<T>,
  ): Promise<{ readonly value: T } | 'late' | 'failed'> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const counting = Promise.resolve()
      .then(run)
      .then((value) => Object.freeze({ value }));
    // Whichever loses must not end as an unhandled rejection.
    counting.catch(() => undefined);
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => {
        resolve('late');
      }, quotaTimeoutMs);
    });
    try {
      return await Promise.race([counting, late]);
    } catch {
      return 'failed';
    } finally {
      clearTimeout(timer);
    }
  };

  // Whether a decision about an entry was counted already (ADR 0029). A
  // store that is missing or fails counts as none: this only shows, and a
  // decision counts again before it is kept.
  const decisionCounted = async (
    ctx: TenantContext,
    queueId: string,
    content: QueueEntryContent,
    day: IsoDate,
  ): Promise<boolean> => {
    const store = options.quota;
    if (store === undefined) return false;
    const read = await inQuotaTime(() =>
      store.read(ctx, approvalKeyOf(queueId, content.planHash), day),
    );
    const counted: unknown = typeof read === 'object' ? read.value : undefined;
    return typeof counted === 'number' && counted > 0;
  };

  // Decides about an entry for the operator (ADR 0029, ADR 0031): first it
  // counts the decision for the tenant, under the hash of the ID and the
  // plan, on the day of the entry, and only the call that counts 1 keeps
  // its decision, which destroys the entry. An approval and a rejection
  // count under the same key, so that only one decision ever counts, in
  // any process and whatever the store of the queue offers again. A store
  // of quotas that is missing, fails or takes too long decides nothing; one
  // that takes too long may still count, so that its count is unknown.
  const decideEntry = async (
    ctx: TenantContext,
    queue: QueueKeeper,
    queueId: string,
    content: QueueEntryContent,
    day: IsoDate,
    decision: QueueDecisionKind,
  ): Promise<Decided> => {
    const unavailable = (counted: Counted): Decided => {
      ctx.log.warn('write_queue_failed', { code: 'internal' });
      return Object.freeze({ kind: 'failed', counted });
    };
    // The time of the decision before the count, so that a clock that
    // fails uses up no decision.
    const decidedAt = toTimestamp(now());
    const store = options.quota;
    if (decidedAt === undefined || store === undefined) {
      return unavailable('no');
    }
    const increment = await inQuotaTime(() =>
      store.increment(ctx, approvalKeyOf(queueId, content.planHash), day),
    );
    if (increment === 'late') return unavailable('unknown');
    const counted: unknown =
      typeof increment === 'object' ? increment.value : undefined;
    if (
      typeof counted !== 'number' ||
      !Number.isSafeInteger(counted) ||
      counted < 1
    ) {
      return unavailable('no');
    }
    if (counted > 1) return Object.freeze({ kind: 'used' });
    try {
      await queue.decide(ctx, { id: queueId, day, decision, decidedAt });
      return Object.freeze({ kind: 'kept' });
    } catch {
      // The store refused or failed: this decision was kept and only the
      // destruction of the entry failed, or a store of a plugin holds
      // another one. What the queue holds now tells which (ADR 0031).
      const again = await queue.load(ctx, queueId).catch(() => undefined);
      if (again?.kind !== 'decided') return unavailable('yes');
      return again.decision.decision === decision &&
        again.decision.decidedAt === decidedAt
        ? Object.freeze({ kind: 'kept' })
        : Object.freeze({ kind: 'decided', decision: again.decision.decision });
    }
  };

  // One rejection of the operator (ADR 0031): from the ID of an entry of
  // the queue to its decision, which destroys the entry, and an audit line
  // of its own of the type approval that names the entry and its target.
  // Nothing goes to ChurchTools. What the entry holds leaves only as its
  // summary for the operator.
  const rejectStages = async (
    queueId: string,
    request: ToolRequest,
    assignment: TenantAssignment | undefined,
    eventId: string,
    refs: ObjectRefCollector,
  ): Promise<DecisionEnd> => {
    const ctx = operatorContext(request, assignment, eventId);
    if (typeof ctx === 'string') return decisionFailed(ctx);
    const ended = (end: DecisionEnd): DecisionEnd => ({ ...end, ctx });
    // A decision is recorded like a write: not while the audit file cannot
    // take its line (ADR 0028).
    if (!auditReady()) {
      return ended(decisionFailed('policy_denied', 'auditNotReady'));
    }
    const queue = options.queue;
    if (queue === undefined) {
      return ended(decisionEnd({ kind: 'off' }, 'denied', 'policy_denied'));
    }
    let loaded: Awaited<ReturnType<QueueKeeper['load']>>;
    try {
      loaded = await queue.load(ctx, queueId);
    } catch {
      return ended(decisionFailed('internal'));
    }
    switch (loaded.kind) {
      case 'missing':
      case 'expired':
        return ended(decisionEnd({ kind: loaded.kind }, 'error', 'not_found'));
      case 'decided':
        return ended(
          decisionEnd(
            { kind: 'decided', decision: loaded.decision.decision },
            'error',
            'conflict',
          ),
        );
      case 'found':
        break;
    }
    const { content, day } = loaded;
    const { target } = content;
    addTarget(refs, target);
    const decided = await decideEntry(
      ctx,
      queue,
      queueId,
      content,
      day,
      'rejected',
    );
    switch (decided.kind) {
      case 'failed':
        return ended(decisionUncounted(decided.counted));
      case 'used':
        return ended(decisionEnd({ kind: 'used' }, 'error', 'conflict'));
      case 'decided':
        return ended(
          decisionEnd(
            { kind: 'decided', decision: decided.decision },
            'error',
            'conflict',
          ),
        );
      case 'kept':
        break;
    }
    return ended(
      decisionEnd(
        {
          kind: 'rejected',
          summary: content.summary,
          target: Object.freeze({ kind: target.kind, key: target.key }),
        },
        'ok',
      ),
    );
  };

  const reject = async (
    call: QueueCall,
    request: ToolRequest,
  ): Promise<RejectOutcome> => {
    const eventId = randomUUID();
    const start = now();
    const refs = createObjectRefCollector();
    let assignment: TenantAssignment | undefined;
    let mode: Mode | undefined;
    // The ID of the entry is named only in the form of an ID, checked
    // before anything else reads it.
    const queueId =
      typeof call.queueId === 'string' && isUuid(call.queueId)
        ? call.queueId
        : undefined;
    let end: DecisionEnd = decisionFailed('internal');
    let recorded = false;
    try {
      assignment = copyAssignment(request.assignment);
      mode = request.mode;
      end =
        queueId === undefined
          ? decisionFailed('validation')
          : await rejectStages(queueId, request, assignment, eventId, refs);
    } catch {
      end = decisionFailed('internal');
    } finally {
      const durationMs = durationSince(start);
      try {
        recorded =
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- only true counts, also from a sink without types
          audit.record(
            {
              type: 'approval',
              tenantId: assignment?.tenantId ?? auditPlaceholders.tenantId,
              actor: assignment?.actor ?? auditPlaceholders.actor,
              mode: mode as Mode,
              outcome: end.audit,
              queueId: queueId ?? auditPlaceholders.queueId,
              decision: 'rejected',
              ...(end.errorCode === undefined
                ? {}
                : { errorCode: end.errorCode }),
              // At most a category and a page, never over the limit.
              objectRefs: refs.list().refs,
              durationMs,
            },
            eventId,
            { required: false },
          ) === true;
      } catch {
        // A line that does not reach the file is said below.
      }
      try {
        end.ctx?.log.info('queue_reject_call', {
          durationMs,
          ...(end.errorCode === undefined ? {} : { code: end.errorCode }),
        });
      } catch {
        // The log never decides the outcome.
      }
    }
    // A rejection whose line is not in the audit file says so, for the
    // operator to check the audit (ADR 0028).
    return end.outcome.kind === 'rejected' && !recorded
      ? Object.freeze({ ...end.outcome, unrecorded: true })
      : end.outcome;
  };

  // One approval of the operator (ADR 0029): from the ID of an entry of the
  // queue through the write guard, which plans the write again with the
  // actor who asked for it and lets the pipeline count and keep the
  // decision before it writes, to an audit line of its own of the type
  // approval that names the entry, the target and the state of the write.
  // What the entry and the page hold leaves only as the summary and the
  // diff for the operator.
  const approveStages = async (
    queueId: string,
    request: ToolRequest,
    assignment: TenantAssignment | undefined,
    eventId: string,
    refs: ObjectRefCollector,
  ): Promise<ApproveEnd> => {
    const ctx = operatorContext(request, assignment, eventId);
    if (typeof ctx === 'string') return approveFailed(ctx);
    const ended = (end: ApproveEnd): ApproveEnd => ({ ...end, ctx });
    // As for every write, nothing runs while the audit file cannot take
    // its line (ADR 0028, ADR 0029).
    if (!auditReady()) {
      return ended(approveFailed('policy_denied', 'auditNotReady'));
    }
    const queue = options.queue;
    if (queue === undefined) {
      return ended(approveEnd({ kind: 'off' }, 'denied', 'policy_denied'));
    }
    let loaded: Awaited<ReturnType<QueueKeeper['load']>>;
    try {
      loaded = await queue.load(ctx, queueId);
    } catch {
      return ended(approveFailed('internal'));
    }
    switch (loaded.kind) {
      case 'missing':
      case 'expired':
        return ended(approveEnd({ kind: loaded.kind }, 'error', 'not_found'));
      case 'decided':
        return ended(
          approveEnd(
            { kind: 'decided', decision: loaded.decision.decision },
            'error',
            'conflict',
          ),
        );
      case 'found':
        break;
    }
    const { content, day } = loaded;
    addTarget(refs, content.target);
    // A decision counted before without its record ends here, before any
    // read of ChurchTools: the entry can no longer be decided (ADR 0029).
    if (await decisionCounted(ctx, queueId, content, day)) {
      return ended(approveEnd({ kind: 'used' }, 'error', 'conflict'));
    }
    // The write of the entry is the write of the actor who asked for it,
    // in the tenant of the operator: its plan names that actor, and its
    // limits are the ones of that actor (ADR 0029).
    const wish = createTenantContext({
      assignment: Object.freeze({
        tenantId: ctx.tenantId,
        actor: content.actor,
      }),
      instance: origin,
      mode: request.mode,
      redaction: request.redaction,
      readOnly: request.readOnly,
      features: [...request.features],
      clock,
      signal: request.signal,
      logging,
      eventId,
    });
    let decided: Decided | undefined;
    const result = await guard.approve({
      ctx: wish,
      eventId,
      entry: {
        tool: content.tool,
        origin: content.origin,
        toolMeta: content.toolMeta,
        intent: content.intent,
        planHash: content.planHash,
        plannedOn: content.plannedOn ?? day,
        ...(content.run === undefined ? {} : { run: content.run }),
      },
      decide: async () => {
        decided = await decideEntry(
          ctx,
          queue,
          queueId,
          content,
          day,
          'approved',
        );
        return decided.kind === 'kept';
      },
    });
    switch (result.kind) {
      case 'refused': {
        const { error, contentViolations } = result;
        const reason =
          contentViolations === undefined ? reasonOf(error) : 'content';
        return ended(
          approveEnd(
            {
              kind: 'failed',
              code: error.code,
              ...(reason === undefined ? {} : { reason }),
              used: false,
              sent: false,
            },
            // A text the content policy refuses counts as refused, though
            // its code is validation (ADR 0030).
            contentViolations !== undefined || writeDenials.includes(error.code)
              ? 'denied'
              : 'error',
            error.code,
            contentViolations,
          ),
        );
      }
      case 'undecided': {
        // The guard asked for the decision, so it is known.
        const why = decided as Decided;
        switch (why.kind) {
          case 'used':
            return ended(approveEnd({ kind: 'used' }, 'error', 'conflict'));
          case 'decided':
            return ended(
              approveEnd(
                { kind: 'decided', decision: why.decision },
                'error',
                'conflict',
              ),
            );
          default:
            return ended(
              approveEnd(
                {
                  kind: 'failed',
                  code: 'internal',
                  ...(why.kind === 'failed' && why.counted === 'unknown'
                    ? { reason: 'countUnknown' as const }
                    : {}),
                  used: why.kind === 'failed' && why.counted === 'yes',
                  sent: false,
                },
                'error',
                'internal',
              ),
            );
        }
      }
      case 'committed':
        break;
    }
    const committed = result.result;
    const diff = diffLines(result.change.from, result.change.to);
    // A new page names itself only once it is written.
    addTarget(refs, committed.target);
    // The decision is kept from here on, whatever the write does.
    const written = {
      writeState: committed.state,
      ...(committed.path === undefined ? {} : { confirmation: committed.path }),
      sent: committed.ok || committed.sent,
      kept: true,
    };
    if (committed.ok) {
      return ended({
        ...approveEnd(
          {
            kind: 'approved',
            summary: content.summary,
            target: Object.freeze({
              kind: committed.target.kind,
              key: committed.target.key,
            }),
            version: committed.version,
            undoId: committed.undoId,
            diff,
          },
          'ok',
        ),
        ...written,
      });
    }
    const reason = reasonOf(committed.error);
    return ended({
      ...approveEnd(
        {
          kind: 'failed',
          code: committed.error.code,
          ...(reason === undefined ? {} : { reason }),
          used: true,
          state: committed.state,
          sent: committed.sent,
          diff,
        },
        writeStateOutcomes[committed.state],
        committed.error.code,
      ),
      ...written,
    });
  };

  const approve = async (
    call: QueueCall,
    request: ToolRequest,
  ): Promise<ApproveOutcome> => {
    // The ID of the approval: its audit line and the snapshot of its
    // write, so that the write can be taken back.
    const eventId = randomUUID();
    const start = now();
    const refs = createObjectRefCollector();
    let assignment: TenantAssignment | undefined;
    let mode: Mode | undefined;
    // The ID of the entry is named only in the form of an ID, checked
    // before anything else reads it.
    const queueId =
      typeof call.queueId === 'string' && isUuid(call.queueId)
        ? call.queueId
        : undefined;
    let end: ApproveEnd = approveFailed('internal');
    let recorded = false;
    try {
      assignment = copyAssignment(request.assignment);
      mode = request.mode;
      end =
        queueId === undefined
          ? approveFailed('validation')
          : await approveStages(queueId, request, assignment, eventId, refs);
    } catch {
      end = approveFailed('internal');
    } finally {
      const durationMs = durationSince(start);
      try {
        recorded =
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- only true counts, also from a sink without types
          audit.record(
            {
              type: 'approval',
              tenantId: assignment?.tenantId ?? auditPlaceholders.tenantId,
              actor: assignment?.actor ?? auditPlaceholders.actor,
              mode: mode as Mode,
              outcome: end.audit,
              queueId: queueId ?? auditPlaceholders.queueId,
              decision: 'approved',
              // Once decided, the line names the policy that judged the
              // write, as the line of every write does (ADR 0032).
              ...(end.writeState === undefined
                ? {}
                : { writeState: end.writeState, policyHash }),
              ...(end.confirmation === undefined
                ? {}
                : { confirmation: end.confirmation }),
              ...(end.errorCode === undefined
                ? {}
                : { errorCode: end.errorCode }),
              ...(end.contentViolations === undefined
                ? {}
                : { contentViolations: end.contentViolations }),
              // At most a category and a page, never over the limit.
              objectRefs: refs.list().refs,
              durationMs,
            },
            eventId,
            { required: false },
          ) === true;
      } catch {
        // A line that does not reach the file is handled below.
      }
      // An approval that may have written and whose line is not in the
      // audit file stops every later write, as for a write of a tool (ADR
      // 0029).
      if (end.sent) {
        if (!recorded) {
          guard.block();
          try {
            end.ctx?.log.error('write_audit_failed');
          } catch {
            // The block holds without its log line.
          }
        }
        try {
          audit.anchor?.();
        } catch {
          // The anchor is lost; the line is in the file or reported.
        }
      }
      try {
        end.ctx?.log.info('queue_approve_call', {
          durationMs,
          ...(end.errorCode === undefined ? {} : { code: end.errorCode }),
        });
      } catch {
        // The log never decides the outcome.
      }
    }
    // An approval that kept its decision or may have written, without its
    // line in the audit file, says so, for the operator to check the audit
    // (ADR 0028, ADR 0029).
    return (end.sent || end.kept) && !recorded
      ? Object.freeze({ ...end.outcome, unrecorded: true })
      : end.outcome;
  };

  return Object.freeze({
    __proto__: null,
    call,
    callForRun,
    writeForRun,
    endRun,
    undo,
    adopt,
    reject,
    approve,
    listQueue,
    showQueue,
  });
}

/**
 * How the count and the keeping of a decision ended (ADR 0029): kept; used,
 * when it was counted before; decided, when a store of a plugin holds
 * another decision; or failed, with whether it was counted.
 */
type Decided =
  | { readonly kind: 'kept' }
  | { readonly kind: 'used' }
  | { readonly kind: 'decided'; readonly decision: QueueDecisionKind }
  | { readonly kind: 'failed'; readonly counted: Counted };

/**
 * Whether a decision that failed was counted: not, yes, or unknown, when
 * the store of quotas did not answer in time and may still count it.
 */
type Counted = 'no' | 'yes' | 'unknown';

/** How an approval ended, with what its audit line needs. */
interface ApproveEnd {
  readonly outcome: ApproveOutcome;
  readonly audit: AuditOutcome;
  readonly errorCode?: ErrorCode;
  readonly contentViolations?: readonly ContentViolationKind[];
  /** The state of the write, once the approval was decided. */
  readonly writeState?: WriteState;
  readonly confirmation?: ConfirmationPath;
  /** Whether the write may have reached ChurchTools. */
  readonly sent: boolean;
  /** Whether the decision was kept, which destroyed the entry. */
  readonly kept: boolean;
  /** The context of the approval, once there is one, for its log lines. */
  readonly ctx?: TenantContext;
}

// An approval that ended, frozen.
const approveEnd = (
  outcome: ApproveOutcome,
  audit: AuditOutcome,
  errorCode?: ErrorCode,
  contentViolations?: readonly ContentViolationKind[],
): ApproveEnd =>
  Object.freeze({
    outcome: Object.freeze(outcome),
    audit,
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(contentViolations === undefined ? {} : { contentViolations }),
    sent: false,
    kept: false,
  });

// An approval refused or failed before the entry was opened.
const approveFailed = (code: ErrorCode, reason?: 'auditNotReady'): ApproveEnd =>
  approveEnd(
    {
      kind: 'failed',
      code,
      ...(reason === undefined ? {} : { reason }),
      used: false,
      sent: false,
    },
    code === 'policy_denied' ? 'denied' : 'error',
    code,
  );

/** How a decision of the operator ended, with what its audit line needs. */
interface DecisionEnd {
  readonly outcome: RejectOutcome;
  readonly audit: AuditOutcome;
  readonly errorCode?: ErrorCode;
  /** The context of the decision, once there is one, for its log lines. */
  readonly ctx?: TenantContext;
}

// A decision that ended, frozen.
const decisionEnd = (
  outcome: RejectOutcome,
  audit: AuditOutcome,
  errorCode?: ErrorCode,
): DecisionEnd =>
  Object.freeze({
    outcome: Object.freeze(outcome),
    audit,
    ...(errorCode === undefined ? {} : { errorCode }),
  });

// A rejection whose count failed after the entry was found: counted but
// not kept, when the entry can no longer be decided, or with a count that
// is unknown.
const decisionUncounted = (counted: Counted): DecisionEnd =>
  decisionEnd(
    {
      kind: 'failed',
      code: 'internal',
      ...(counted === 'unknown' ? { reason: 'countUnknown' as const } : {}),
      ...(counted === 'yes' ? { used: true as const } : {}),
    },
    'error',
    'internal',
  );

// A decision refused or failed before the entry was decided.
const decisionFailed = (
  code: ErrorCode,
  reason?: 'auditNotReady',
): DecisionEnd =>
  decisionEnd(
    {
      kind: 'failed',
      code,
      ...(reason === undefined ? {} : { reason }),
    },
    code === 'policy_denied' ? 'denied' : 'error',
    code,
  );

/** How an undo ended, with what its audit line needs. */
interface UndoEnd {
  readonly outcome: UndoOutcome;
  readonly audit: AuditOutcome;
  readonly writeState: WriteState;
  readonly errorCode?: ErrorCode;
  readonly confirmation?: ConfirmationPath;
  /** Whether the undo may have reached ChurchTools. */
  readonly sent: boolean;
  /** The context of the undo, once there is one, for its log lines. */
  readonly ctx?: TenantContext;
}

// An undo that ended, frozen, with the outcome of its audit line derived
// from its state as for a write.
const undoEnd = (
  outcome: UndoOutcome,
  writeState: WriteState,
  errorCode?: ErrorCode,
  confirmation?: ConfirmationPath,
  sent = false,
): UndoEnd =>
  Object.freeze({
    outcome: Object.freeze(outcome),
    audit:
      writeState === 'verified' || writeState === 'skipped'
        ? 'ok'
        : writeState === 'denied'
          ? 'denied'
          : 'error',
    writeState,
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(confirmation === undefined ? {} : { confirmation }),
    sent,
  });

// An undo refused or failed before any plan: nothing was sent.
const undoRefused = (
  code: ErrorCode,
  reason?: UndoReason,
  subject?: UndoSubject,
): UndoEnd => {
  const state = writeStateOf(code);
  return undoEnd(
    {
      kind: 'failed',
      ...(subject === undefined ? {} : { subject }),
      code,
      ...(reason === undefined ? {} : { reason }),
      state,
      sent: false,
    },
    state,
    code,
  );
};

// The name of the fixed sentence of the write guard an error carries, if
// it carries one: the command line has a German text for each.
const sentenceNames = Object.keys(
  writeSentences,
) as (keyof typeof writeSentences)[];
const reasonOf = (error: EccliumError): UndoReason | undefined =>
  sentenceNames.find((name) => writeSentences[name] === error.message);

/** How an adoption ended, with what its audit line needs. */
interface AdoptEnd {
  readonly outcome: AdoptOutcome;
  readonly writeState: WriteState;
  readonly errorCode?: ErrorCode;
  readonly confirmation?: ConfirmationPath;
  /** Whether the adoption may have reached ChurchTools. */
  readonly sent: boolean;
  /** The context of the adoption, once there is one, for its log lines. */
  readonly ctx?: TenantContext;
}

// An adoption that ended, frozen; the outcome of its line follows from
// its state as for a write.
const adoptEnd = (
  outcome: AdoptOutcome,
  writeState: WriteState,
  errorCode?: ErrorCode,
  confirmation?: ConfirmationPath,
  sent = false,
): AdoptEnd =>
  Object.freeze({
    outcome: Object.freeze(outcome),
    writeState,
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(confirmation === undefined ? {} : { confirmation }),
    sent,
  });

// An adoption refused or failed before the page was judged: nothing sent.
const adoptRefused = (code: ErrorCode, reason?: UndoReason): AdoptEnd => {
  const state = writeStateOf(code);
  return adoptEnd(
    {
      kind: 'failed',
      code,
      ...(reason === undefined ? {} : { reason }),
      state,
      sent: false,
    },
    state,
    code,
  );
};

/** An adoption call whose fields have the form they must have. */
interface CheckedAdoptCall {
  readonly period: string;
  readonly page: {
    readonly categoryId: number;
    readonly guid: string;
    readonly name: string;
  };
  readonly writeIds: readonly string[];
  readonly confirm: string | undefined;
}

// The GUID of a page of the wiki, as the policy names it.
const pageGuidPattern =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// The check value of a preview: 16 hex digits in lower case.
const checkValuePattern = /^[0-9a-f]{16}$/;

// The fields of an adoption call, checked, or undefined for one built
// wrong: no field of the command line reaches the write guard unchecked.
const adoptCallOf = (call: AdoptCall): CheckedAdoptCall | undefined => {
  const { period, page, writeIds, confirm } = call;
  const { categoryId, guid, name } = page;
  if (
    !auditFieldSchemas.period.safeParse(period).success ||
    !Number.isSafeInteger(categoryId) ||
    (categoryId as number) < 1 ||
    typeof guid !== 'string' ||
    !pageGuidPattern.test(guid) ||
    typeof name !== 'string' ||
    name.trim() === '' ||
    !Array.isArray(writeIds) ||
    writeIds.length > maxAdoptionWrites ||
    !writeIds.every((id) => typeof id === 'string' && isUuid(id)) ||
    (confirm !== undefined &&
      (typeof confirm !== 'string' || !checkValuePattern.test(confirm)))
  ) {
    return undefined;
  }
  return Object.freeze({
    period: period as string,
    page: Object.freeze({
      categoryId: categoryId as number,
      guid,
      name,
    }),
    writeIds: Object.freeze([...(writeIds as readonly string[])]),
    confirm,
  });
};
