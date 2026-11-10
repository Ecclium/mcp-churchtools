/**
 * The write guard (ADR 0029): plans a write and commits it, the only code
 * that writes to ChurchTools.
 *
 * Where it stands in the way of a write:
 *
 * 1. **plan** runs while the tool runs, through the write port of its call.
 *    It reads the intent, derives its rules, checks the kill switches, the
 *    rights as advice and the target, and seals a plan. It never writes. A
 *    plan that would change nothing ends as `skipped`.
 * 2. The pipeline gets the plan confirmed. The proof that it was comes only
 *    from the core.
 * 3. **commit** derives the plan again from the state of the target, read
 *    right before writing, and writes only when the hash is the same and
 *    the proof fits. It sends exactly one write, never twice, and reads the
 *    target again to see that the change is there as planned.
 *
 * After a failed send, only a target the transport refused before any
 * socket proves that nothing reached ChurchTools. After any other failure
 * the core reads again and decides between `verified`, `conflict` and
 * `failed`, and its sentence never invites to try again blindly.
 *
 * Right before the one send, the guard saves a snapshot of what the write
 * changes, sealed with a day key (ADR 0031), and a write whose snapshot
 * cannot be saved is not sent. Without snapshots, every plan is sealed as
 * not reversible, so that the echo allows none.
 *
 * **undo** takes a write back from its snapshot, for `ecclium undo` of the
 * operator (ADR 0031, `undo.ts`). It plans the update itself, as a write of
 * the core that no tool can plan, confirms it with a proof of the operator
 * and commits it on the same way as every write, with the kill switches,
 * the rights as advice, the read right before, the clock, a snapshot of
 * its own and the read after. The policy and the content policy do not
 * apply: the operator asked for it, and the text it writes back was on the
 * page before Ecclium wrote. An undo of an appointment or a booking seals
 * no plan, since no intent deletes and none empties a description, but runs
 * the same steps; a delete keeps no snapshot and cannot be taken back.
 *
 * **approve** writes what waits in the queue of approvals, for `ecclium
 * queue approve` of the operator (ADR 0029, ADR 0031). It plans the write
 * of the entry again, with the actor who asked for it, from the state of
 * the target now, and goes on only when the hash is the one of the entry:
 * a target that changed since gives another hash, and nothing is written
 * or decided. Then the pipeline counts and keeps the decision, and only
 * after that does the guard issue a proof of the operator and commit on
 * the way of every write. The approval stands in for what the policy sent
 * to the queue for, an entry missing, a name that changed or the limit of
 * the day, and the write still counts against that limit. Everything else
 * applies again: the kill switches, `ECCLIUM_READ_ONLY`, the rights as
 * advice, the content policy, the version of the target and the clock.
 *
 * The policy of ADR 0032 checks the plan after the read of the target and
 * again on the commit right before the send, where it adds the write to
 * its counter of the day (`policy-gate.ts`). A plan the policy sends to
 * the queue of approvals is sealed all the same, and its result names the
 * reason, so that the pipeline queues it instead of asking (ADR 0031). The content policy of ADR 0030
 * checks every text of the intent first, before the rights and before any
 * read, and the plan is sealed with the texts in their written form
 * (`content-gate.ts`).
 *
 * A new page and a section to add end with a line of the marking, whose
 * check code comes from the key of the check codes over the tenant, the
 * UTC day of the plan and the canonical form of the text (ADR 0032). The
 * day is kept in the sealed plan and in the entry of the queue, so that
 * the commit after midnight and an approval days later write the text that
 * was confirmed. Without the key or whom to ask, nothing is added. Before a
 * section is added, the page is judged for one with the same marking: the
 * same section as Ecclium's own ends the plan as `skipped`, one a person
 * changed sends the plan to the queue. A change of the text of a page gets
 * no line.
 *
 * **A write of a run of a routine** (ADR 0032) plans in the mode
 * `unattended` with the run the pipeline names: only a section of the
 * wiki, with a tool of the core that may run unattended. The kill switch
 * of its routine counts besides the others. Its text may hold the contact
 * values of the data the run read. Its marking names routine and period
 * where an interactive one says «interaktiv», and its own section is the
 * one of the same routine and period, whatever its day: the same text is
 * a repeat, another text takes the place of the old one, and one a person
 * changed sends the plan to the queue. An
 * account with rights its routines do not need sends the plan to the
 * queue as well, unless the exception of the policy holds today. The
 * entries of the routine in the unattended part judge it, with a limit
 * per run besides the one per day. Only then does `commitForRun` issue the
 * proof of the policy and commit on the way of every write.
 *
 * @packageDocumentation
 */
import {
  type Clock,
  type ConfirmationPath,
  type ContentViolationKind,
  type IsoDate,
  EccliumError,
  type ErrorCode,
  isEccliumError,
  type Permissions,
  type PlanOutcome,
  type PlannedWrite,
  type QuotaStore,
  type Reversible,
  type RightRef,
  type SkipReason,
  type Sensitivity,
  type TenantContext,
  type UnattendedRule,
  type WikiPage,
  type WriteIntent,
} from '@ecclium/mcp-churchtools-plugin-api';

import { maxWikiWriteBytes } from '../churchtools/schemas.js';
import { isWikiTitle, storedWikiText } from '../churchtools/wiki-writes.js';
import type { ChurchToolsWrites } from '../churchtools/writes.js';
import { canonicalOfWritten, contactKeysOf } from '../content/index.js';
import { contactKeysInSection } from '../run/content.js';
import { HttpTransportError } from '../http/index.js';
import type { KeyMaterial } from '../keys/index.js';
import {
  checkCodeOf,
  findMarkings,
  judgeSections,
  type Marking,
  markingLineOf,
  markingTextsOf,
  sameCheckCode,
  type SectionJudgement,
} from '../marker/index.js';
import type { PolicyQueueReason } from '../policy/engine.js';
import type { Policy } from '../policy/schema.js';
import {
  type CalendarIntent,
  calendarSentences,
  isCalendarIntent,
  planCalendar,
  planCalendarUndo,
  type SendOutcome,
} from './calendar-plan.js';
import { readIntent } from './intent.js';
import { checkIntentContent, ContentRefusal } from './content-gate.js';
import {
  type ConfirmationText,
  confirmationTextOf,
} from './confirmation-text.js';
import { checkKillSwitches, checkRunKillSwitches } from './kill-switch.js';
import { contentHashOf } from './plan-hash.js';
import { isoDateOf } from '../quota/budget.js';
import type { LoadedSnapshot } from '../snapshots/keeper.js';
import type {
  DatedCreatedSnapshot,
  SnapshotState,
  SnapshotToSeal,
} from '../snapshots/seal.js';
import {
  createPolicyGate,
  type GateRun,
  type WriteFacts,
} from './policy-gate.js';
import { issueProof, useProof } from './proof.js';
import {
  type IntentRules,
  rulesOf,
  type ToolOrigin,
  withToolMeta,
  type WriteTarget,
} from './rules.js';
import {
  type PlanRun,
  type PlanView,
  readPlan,
  sealPlan,
} from './sealed-plan.js';
import {
  rightsBeyond,
  rightsDriftAccepted,
  type RunAccountNeeds,
} from './rights-drift.js';
import type { RunWrites } from './run-writes.js';
import { serverTimeFits } from './server-clock.js';
import {
  type CalendarUndoTarget,
  isAsLeft,
  type SnapshotToUndo,
  undoOf,
  undoTargetOf,
  type WikiSnapshotToUndo,
} from './undo.js';
import {
  createWriteHalt,
  haltWrites,
  isWriteHalt,
  type WriteHalt,
  writesHalted,
} from './write-halt.js';

/**
 * The sentences the model reads when a write does not happen as planned.
 * None of them says to try again later: after a failure the target may
 * have changed, and the model is to look before it plans anew.
 */
export const writeSentences = Object.freeze({
  blocked:
    'Writing is off until the server restarts, because a write could not be recorded in the audit file. Ask the operator.',
  readOnly: 'This server only reads. Writing is off.',
  switchedOff: 'Writing is switched off on this server. Ask the operator.',
  switchUnknown:
    'The server cannot check whether writing is switched off, so it does not write. Ask the operator.',
  notRun: 'This server does not carry out this kind of write.',
  intent:
    'The write does not fit its kind: check the IDs, the version and the texts.',
  blank: 'The text has to hold more than spaces.',
  title:
    'A title has 1 to 255 characters, no control characters and no spaces at either end.',
  rightsUnknown:
    'The server cannot read the rights of its account, so it does not write. Ask the operator.',
  missingRight:
    'The account of the server may not change pages in this category of the wiki.',
  notMarkdown:
    'The page is no Markdown page. This server changes only Markdown pages.',
  changedBefore:
    'The page changed since it was read. Read it again and plan the change on its current version.',
  changedSincePlan:
    'The target changed after the plan, so nothing was written. Read it again and plan anew.',
  clock:
    'The clock of the server differs from the time of ChurchTools by more than five minutes, so it does not write. Ask the operator.',
  notSent: 'The write did not reach ChurchTools. Nothing changed.',
  unknown:
    'It is unknown whether the write reached ChurchTools. Check the target before you try again.',
  notAsPlanned:
    'The write reached ChurchTools, but the target does not read back as planned. Check it before you change it again.',
  notConfirmed: 'The write was not confirmed, so nothing was written.',
  changedSinceQueued:
    'The target changed after the write was queued, so nothing was written. Plan the write anew on its current version.',
  noSnapshot:
    'The server could not save the state before the write, so nothing was written. Ask the operator.',
  noMarking:
    'This server cannot mark what it adds to the wiki, so it adds no page and no section. Ask the operator.',
  noDay:
    'The clock of the server gives no day for the marking, so it does not write. Ask the operator.',
  tooLong:
    'With the line that marks it, the text of the page would be longer than ChurchTools takes. Shorten it.',
  pageOpen:
    'The page ends in a block that would take in the section and its marking, such as an open block of code or an open comment. Ask a person to close it in ChurchTools.',
  notForRun:
    'A run of a routine writes only a section of a page of the wiki with a tool of the core that may run unattended.',
  ...calendarSentences,
} as const);

/** What the client gives the write guard: the rights and the writes. */
export interface WriteClient {
  /** The rights of the account, for the advice before planning. */
  readonly permissions: (ctx: TenantContext) => Promise<Permissions>;
  /**
   * The account of the server, whose ID tells whether it created an
   * appointment (F44).
   */
  readonly whoami: (ctx: TenantContext) => Promise<{ readonly id: number }>;
  /** The writes of the client and the reads a plan needs (ADR 0072). */
  readonly writes: ChurchToolsWrites;
}

/** What the write guard is built from. */
export interface WriteGuardOptions {
  /** The client of the pipeline. */
  readonly client: WriteClient;
  /** The clock of the process. */
  readonly clock: Clock;
  /**
   * The folder of the kill switches, or undefined when the configuration
   * names none: then writing stays off.
   */
  readonly killSwitchDir: string | undefined;
  /** The checked policy of the server (ADR 0032). */
  readonly policy: Policy;
  /**
   * The store of the counters of the day, or undefined without a folder of
   * state: then a write that an entry of the policy limits does not run.
   */
  readonly quota: QuotaStore | undefined;
  /**
   * The snapshots of writes, or undefined when they are off: then no write
   * can be taken back (ADR 0031).
   */
  readonly snapshots?: WriteSnapshots | undefined;
  /**
   * The key of the check codes of the marking (ADR 0032), or undefined
   * without one: then the guard adds no page and no section to the wiki.
   */
  readonly markerKey?: KeyMaterial | undefined;
  /**
   * The zone in which the texts of a confirmation show the times of
   * appointments and bookings, an IANA name, or undefined for UTC.
   */
  readonly timeZone?: string | undefined;
  /**
   * The halt of writes of the process, which every pipeline of the runner
   * shares, or undefined: then the guard makes its own, which lives as
   * long as the guard (ADR 0029).
   */
  readonly writeHalt?: WriteHalt | undefined;
}

/**
 * How the core keeps snapshots (ADR 0031): the write guard seals a part of
 * the snapshot of a write and keeps it, or rejects, and the undo of the
 * pipeline loads one.
 */
export interface WriteSnapshots {
  /**
   * Seals and keeps a part of the snapshot of a write.
   *
   * @param ctx - The context of the write.
   * @param snapshot - Event, part, day and content.
   * @returns Nothing once the part is kept.
   */
  readonly save: (
    ctx: TenantContext,
    snapshot: SnapshotToSeal,
  ) => Promise<void>;
  /**
   * Finds and opens the snapshot of a write of the tenant of the context.
   *
   * @param ctx - The context, for tenant and instance.
   * @param eventId - The ID of the audit event of the write.
   * @returns The parts, or why there are none.
   */
  readonly load: (
    ctx: TenantContext,
    eventId: string,
  ) => Promise<LoadedSnapshot>;
}

/** What the operator asks the write guard to take back (ADR 0031). */
export interface UndoRequest {
  /** The context of the undo, in the mode of the operator. */
  readonly ctx: TenantContext;
  /**
   * The ID of the audit event of the undo, under which its own snapshot is
   * kept, so that an undo can be taken back as well.
   */
  readonly eventId: string;
  /** The snapshot of the write to take back, as it was found. */
  readonly snapshot: SnapshotToUndo;
  /** Whether to write also over a page someone changed since the write. */
  readonly overwrite: boolean;
}

/**
 * The text of the page now and the text a write of the operator writes,
 * an undo or an approval, for a diff. A new page has no text now.
 */
export interface UndoChange {
  readonly from: string;
  readonly to: string;
}

/** How an undo ended. */
export type UndoResult =
  /**
   * The target holds what the undo would write already, or a new
   * appointment or booking is gone already.
   */
  | { readonly kind: 'unchanged'; readonly target: WriteTarget }
  /** Someone changed the target since the write; nothing was written. */
  | {
      readonly kind: 'changed';
      readonly target: WriteTarget;
      readonly change: UndoChange;
    }
  /**
   * A new page, appointment or booking whose ID was never kept: only its
   * category, calendar or resource is known.
   */
  | { readonly kind: 'incomplete'; readonly target: WriteTarget }
  /** Refused or failed before a plan: nothing was written. */
  | { readonly kind: 'refused'; readonly error: EccliumError }
  /**
   * A new appointment or booking deleted, and read as gone. A delete keeps
   * no snapshot and cannot be taken back (ADR 0031).
   */
  | {
      readonly kind: 'deleted';
      readonly target: WriteTarget;
      readonly change: UndoChange;
    }
  /** Planned and committed, with how the commit ended. */
  | {
      readonly kind: 'committed';
      readonly target: WriteTarget;
      readonly result: CommitResult;
      readonly change: UndoChange;
    };

/**
 * What an approval of the operator writes (ADR 0029): what the entry of the
 * queue holds of its plan, as the queue opened it. The guard checks all of
 * it again, the intent as an intent.
 */
export interface ApprovedEntry {
  /** The tool that planned the write. */
  readonly tool: string;
  /** Who brings the tool, as the catalog recorded it. */
  readonly origin: ToolOrigin;
  /** The metadata the plan was sealed with. */
  readonly toolMeta: {
    readonly sensitivity: Sensitivity;
    readonly unattended: UnattendedRule;
    readonly reversible?: Reversible;
  };
  /** The intent as the guard checked it when the write was queued. */
  readonly intent: unknown;
  /** The hash of the plan, which the plan derived now must have. */
  readonly planHash: string;
  /**
   * The UTC day the write was planned, which its line of the marking
   * names (ADR 0032); for an entry of an earlier version, its own day.
   */
  readonly plannedOn: IsoDate;
  /**
   * For a write a run of a routine queued, the run: the approval judges it
   * against the entries of the routine and writes the same marking.
   */
  readonly run?: PlanRun;
}

/** What the operator asks the write guard to write from the queue. */
export interface ApproveRequest {
  /**
   * The context of the approval: the tenant of the operator, the actor who
   * asked for the write, whose plan it was and whose limits it counts on.
   */
  readonly ctx: TenantContext;
  /**
   * The ID of the audit event of the approval, under which the snapshot of
   * the write is kept, so that it can be taken back.
   */
  readonly eventId: string;
  /** The entry of the queue. */
  readonly entry: ApprovedEntry;
  /**
   * Counts and keeps the decision, once the plan fits the entry and right
   * before the proof. Only `true` lets the write go on; anything else, a
   * rejection included, ends it without a write.
   */
  readonly decide: () => Promise<boolean>;
}

/** How an approval ended. */
export type ApproveResult =
  /**
   * Refused or failed before the decision: nothing was decided or
   * written, and the entry still waits. A text the content policy refuses
   * names its reasons.
   */
  | {
      readonly kind: 'refused';
      readonly error: EccliumError;
      readonly contentViolations?: readonly ContentViolationKind[];
    }
  /** The decision was not kept, so nothing was written. */
  | { readonly kind: 'undecided'; readonly target: WriteTarget }
  /** Decided and committed, with how the commit ended. */
  | {
      readonly kind: 'committed';
      readonly target: WriteTarget;
      readonly result: CommitResult;
      readonly change: UndoChange;
    };

/**
 * Why a sealed plan goes to the queue of approvals instead of a question:
 * a reason of the policy (ADR 0032), an own section on the page with the
 * marking of this write that a person changed since (`marker_changed`), or
 * an account of a run with rights its routines do not need
 * (`rights_drift`).
 */
export type PlanQueueReason =
  PolicyQueueReason | 'marker_changed' | 'rights_drift';

/**
 * What a write of a run of a routine brings to its plan (ADR 0032), set by
 * the pipeline from what the composition root bound, never by a tool.
 */
export interface RunPlanRequest {
  /** The ID of the routine. */
  readonly routine: string;
  /** The period of the run, such as `2026-W46`. */
  readonly period: string;
  /**
   * The keys of the contact values in the data the run read, which its
   * text may hold besides those of the policy (ADR 0030).
   */
  readonly contacts: ReadonlySet<string>;
  /** What the rights of the account of the run are judged against. */
  readonly needs: RunAccountNeeds;
  /** The counter of the writes of the run. */
  readonly runWrites: RunWrites;
}

/** Who plans: the call of a tool. */
export interface PlanRequest {
  /** The context of the call. */
  readonly ctx: TenantContext;
  /** The name of the tool. */
  readonly tool: string;
  /** Who brings the tool, as the catalog records it. */
  readonly origin: ToolOrigin;
  /** Sensitivity and unattended rule of the tool. */
  readonly meta: {
    readonly sensitivity: Sensitivity;
    readonly unattended: UnattendedRule;
    /** Whether the tool declares its write can be taken back. */
    readonly reversible?: Reversible;
  };
  /**
   * For a write of a run of a routine in the mode `unattended`, the run;
   * without it no write in that mode reaches an entry of the policy.
   */
  readonly run?: RunPlanRequest;
}

/** What planning gives the pipeline: the outcome for the tool and the target. */
export interface PlanResult {
  /** What the tool gets back from `plan`. */
  readonly outcome: PlanOutcome;
  /** What the write would change, for the result and the audit. */
  readonly target: WriteTarget;
  /**
   * For a sealed plan, what a person sees to confirm it: summary and diff,
   * made from what the guard read and would write, never from the tool.
   */
  readonly text?: ConfirmationText;
  /**
   * For a sealed plan that goes to the queue of approvals, why (ADR 0031,
   * ADR 0032).
   */
  readonly queue?: PlanQueueReason;
  /**
   * For a write of a run whose account has rights its routines do not
   * need, that the exception of the policy let it go on (ADR 0032).
   */
  readonly rightsDriftAccepted?: true;
}

/** How a commit ended. */
export type CommitResult =
  | {
      readonly ok: true;
      readonly state: 'verified';
      /** The way the write was confirmed. */
      readonly path: ConfirmationPath;
      /** What the write changed; a new page names itself. */
      readonly target: WriteTarget;
      /** The version of the target after the write. */
      readonly version: number;
      /** The ID to take the write back with, when a snapshot was saved. */
      readonly undoId?: string;
    }
  | {
      readonly ok: false;
      readonly state: 'conflict' | 'failed' | 'denied';
      /** The error with a fixed sentence for the model. */
      readonly error: EccliumError;
      /** Whether a write may have reached ChurchTools. */
      readonly sent: boolean;
      /** The way of the confirmation, once the proof was used. */
      readonly path?: ConfirmationPath;
      /** What the write was to change. */
      readonly target?: WriteTarget;
    };

/** The write guard of one pipeline. */
export interface WriteGuard {
  /**
   * Plans a write for a call of a tool.
   *
   * @param request - The call that plans.
   * @param intent - The intent as the tool handed it over.
   * @returns The sealed plan, or why nothing needs to be written, with the
   *   target derived from the checked copy of the intent.
   * @throws {EccliumError} With a fixed sentence when the plan is refused.
   * @throws {ContentRefusal} When the content policy refuses a text, with
   *   the error for the tool and the reasons for the audit.
   */
  plan(request: PlanRequest, intent: unknown): Promise<PlanResult>;
  /**
   * Commits a sealed plan with a proof.
   *
   * @param ctx - The context of the call that commits.
   * @param plan - The plan the tool returned.
   * @param proof - The proof of the confirmation.
   * @param eventId - The ID of the audit event of the call, under which the
   *   snapshot of the write is kept; without it no write runs while
   *   snapshots are on.
   * @returns How the commit ended; it never rejects.
   */
  commit(
    ctx: TenantContext,
    plan: unknown,
    proof: unknown,
    eventId?: string,
  ): Promise<CommitResult>;
  /**
   * Commits a plan of a run of a routine that the policy covers, with a
   * proof of the policy the guard issues itself, only in the mode
   * `unattended` and only for a plan sealed for a run (ADR 0029, ADR 0032).
   *
   * @param ctx - The context of the write of the run.
   * @param plan - The plan of the run.
   * @param runWrites - The counter of the writes of the run.
   * @param eventId - The ID of the audit event, for the snapshot.
   * @returns How the commit ended; it never rejects.
   */
  commitForRun(
    ctx: TenantContext,
    plan: unknown,
    runWrites: RunWrites,
    eventId?: string,
  ): Promise<CommitResult>;
  /**
   * Takes back a write from its snapshot, for the operator (ADR 0031).
   *
   * @param request - Context, ID of the undo, snapshot and whether to
   *   write over a changed page.
   * @returns How the undo ended; it never rejects.
   */
  undo(request: UndoRequest): Promise<UndoResult>;
  /**
   * Writes an entry of the queue of approvals, for the operator (ADR 0029).
   *
   * @param request - Context, ID of the approval, entry and the decision.
   * @returns How the approval ended; it never rejects.
   */
  approve(request: ApproveRequest): Promise<ApproveResult>;
  /**
   * Stops every later plan until the process ends, after a write whose
   * line could not be recorded in the audit file (ADR 0029).
   */
  block(): void;
}

const refuse = (
  code: ErrorCode,
  message: string,
  missingRights?: readonly RightRef[],
): EccliumError =>
  new EccliumError(
    code,
    message,
    missingRights === undefined ? undefined : { missingRights },
  );

/**
 * Builds the new text of a page from its text and a section: the text, an
 * empty line and the section, each in the form ChurchTools stores, without
 * the white space it removes at both ends (F51). ChurchTools keeps
 * everything else as sent (F17), so the read after the write compares
 * byte by byte.
 *
 * @param text - The text of the page.
 * @param section - The section to add.
 * @returns The new text.
 * @example
 * ```ts
 * appendSection('# Plan\n', '## Nachtrag\n'); // '# Plan\n\n## Nachtrag'
 * ```
 */
export function appendSection(text: string, section: string): string {
  const head = storedWikiText(text);
  const tail = storedWikiText(section);
  return head === '' ? tail : `${head}\n\n${tail}`;
}

/**
 * Builds the new text of a page whose own section of a run is replaced:
 * the lines before the section, the new section with its line of the
 * marking, and the lines after the old line of the marking, in the form
 * ChurchTools stores (F51).
 *
 * @param text - The text of the page.
 * @param own - Where the own section stands.
 * @param own.start - The number of its first line, from 0.
 * @param own.end - The number of the line of its marking.
 * @param section - The new section with its line of the marking.
 * @returns The new text.
 * @example
 * ```ts
 * replaceSection('# Plan\n\n## W45\nalt\n', { kind: 'own', start: 2, end: 3 }, '## W45\nneu');
 * ```
 */
export function replaceSection(
  text: string,
  own: { readonly start: number; readonly end: number },
  section: string,
): string {
  const lines = text.split('\n');
  const before = lines.slice(0, own.start);
  // The old section may have begun with a block that ends a paragraph
  // without an empty line, such as a heading; the new one may begin with a
  // paragraph, which would run on from the text before it.
  const gap =
    before.length > 0 && !isBlank(before[before.length - 1] as string)
      ? ['']
      : [];
  return storedWikiText(
    [
      ...before,
      ...gap,
      storedWikiText(section),
      ...lines.slice(own.end + 1),
    ].join('\n'),
  );
}

const isBlank = (text: string): boolean => text.trim() === '';

/** What a plan of a write of the wiki rests on, read now. */
type Derived =
  | {
      readonly kind: 'create';
      readonly contentHash: string;
      /** The time of ChurchTools of the read, null without one. */
      readonly serverTime: number | null;
      /** The title and the text of the new page. */
      readonly title: string;
      readonly text: string;
    }
  | {
      readonly kind: 'change';
      readonly contentHash: string;
      readonly serverTime: number | null;
      /** The page as it is. */
      readonly before: WikiPage;
      /** The new text of the page. */
      readonly text: string;
      /**
       * For a section to add, what the page holds with its marking
       * (ADR 0032): none, the same section as Ecclium's own, one a person
       * changed, or for a run its own section of the period with another
       * text, which the new one replaces where it stands.
       */
      readonly marking?: SectionJudgement['kind'] | 'replaced';
    };

/** Where the snapshot of a write was kept: its event and its day. */
interface Undo {
  readonly eventId: string;
  readonly day: IsoDate;
}

/** What a commit rests on, read right before the send. */
interface Prepared {
  readonly contentHash: string;
  /** The time of ChurchTools of the read, null without one. */
  readonly serverTime: number | null;
  /** What the policy needs of the target beyond the rules. */
  readonly facts: WriteFacts;
  /** Why nothing is left to write, if so. */
  readonly skip?: SkipReason;
  /** What the snapshot keeps before the send. */
  readonly before: SnapshotState;
  /** Sends the write once and reads it back. */
  readonly send: (
    path: ConfirmationPath,
    undo: Undo | undefined,
  ) => Promise<CommitResult>;
}

/** The writes of the wiki, which plan from a page. */
type WikiIntent = Extract<WriteIntent, { categoryId: number }>;

/** The writes that change a page that exists. */
type PageIntent = Extract<WriteIntent, { guid: string }>;

/** The write that adds a section, the only one of a run. */
type SectionIntent = Extract<WriteIntent, { kind: 'wikiSectionAppend' }>;

// What a person sees to confirm a write of the wiki: the page as read
// and the text it would get, or for a new page its title and text.
const textOf = (intent: WikiIntent, derived: Derived): ConfirmationText =>
  confirmationTextOf({
    kind: intent.kind,
    categoryId: intent.categoryId,
    ...(derived.kind === 'change'
      ? {
          title: derived.before.title,
          before: derived.before.text,
          after: derived.text,
        }
      : { title: derived.title, before: '', after: derived.text }),
  });

/**
 * Makes the write guard of one pipeline. It holds one piece of state, the
 * halt after a failed line of the audit: the halt of the process the
 * composition root gives, or else one that lives as long as the pipeline.
 * Neither is state at module level.
 *
 * @param options - Client, clock, folder of the kill switches, policy,
 *   store of quotas and the halt of writes of the process.
 * @returns The write guard, frozen.
 * @throws {TypeError} When the halt of writes is not one of the core.
 * @example
 * ```ts
 * const guard = createWriteGuard({ client, clock, killSwitchDir, policy, quota });
 * const outcome = await guard.plan({ ctx, tool, origin, meta }, intent);
 * ```
 */
export function createWriteGuard(options: WriteGuardOptions): WriteGuard {
  const { client, clock, killSwitchDir, snapshots, markerKey } = options;
  // Whether a plan can be taken back from a snapshot (ADR 0031).
  const reversible = snapshots !== undefined;
  // The contact values a text may hold, from the interactive part of the
  // policy (ADR 0030).
  const contacts = contactKeysOf(options.policy.interactive.contacts ?? []);
  // The halt after a failed line of the audit: the one of the process when
  // the composition root gives one, else one of this guard (ADR 0029). A
  // value the core did not make would read as halted for good, so it is
  // refused here rather than met at the first write.
  if (options.writeHalt !== undefined && !isWriteHalt(options.writeHalt)) {
    throw new TypeError('The halt of writes is not one of the core.');
  }
  const halt = options.writeHalt ?? createWriteHalt();
  const policy = createPolicyGate({
    policy: options.policy,
    quota: options.quota,
    clock,
    categoryName: (ctx, categoryId) =>
      client.writes.wikiCategoryName(ctx, categoryId),
    calendarName: async (ctx, calendarId) =>
      (await client.writes.calendarFacts(ctx, calendarId))?.name,
    resourceName: (ctx, resourceId) =>
      client.writes.resourceName(ctx, resourceId),
  });
  // What the plans of appointments and bookings are made from.
  const calendars = Object.freeze({
    writes: client.writes,
    whoami: (ctx: TenantContext) => client.whoami(ctx),
    timeZone: options.timeZone,
  });
  // What the policy needs of a write beyond its rules: the title of a page
  // it changes, as read right before.
  const factsOf = (derived: Derived): WriteFacts =>
    derived.kind === 'change' ? { pageTitle: derived.before.title } : {};

  // Writing off for this tenant, for the routine of a run, read-only, or
  // blocked after a failed line of the audit: checked before every plan
  // and right before every commit.
  const stopped = (
    ctx: TenantContext,
    routine?: string,
  ): EccliumError | undefined => {
    if (writesHalted(halt)) {
      return refuse('policy_denied', writeSentences.blocked);
    }
    if (ctx.readOnly) return refuse('policy_denied', writeSentences.readOnly);
    const state =
      killSwitchDir === undefined
        ? 'unknown'
        : routine === undefined
          ? checkKillSwitches(killSwitchDir, ctx.tenantId)
          : checkRunKillSwitches(killSwitchDir, ctx.tenantId, routine);
    if (state === 'on') return undefined;
    ctx.log.warn('write_refused', { code: 'policy_denied' });
    return refuse(
      'policy_denied',
      state === 'off'
        ? writeSentences.switchedOff
        : writeSentences.switchUnknown,
    );
  };

  // The rights as advice: ChurchTools enforces them, the core only names a
  // missing one early. A structure the client does not know stops writing.
  const checkRights = async (
    ctx: TenantContext,
    intent: WikiIntent | CalendarIntent,
    rules: IntentRules,
  ): Promise<Extract<Permissions, { kind: 'known' }>> => {
    const permissions = await client.permissions(ctx);
    if (permissions.kind === 'unknown') {
      ctx.log.warn('write_refused', { code: 'policy_denied' });
      throw refuse('policy_denied', writeSentences.rightsUnknown);
    }
    // Each right is granted for the category, calendar or resource the
    // write reaches, or for all of them.
    const { scope, sentence } =
      intent.kind === 'bookingCreate'
        ? { scope: intent.resourceId, sentence: writeSentences.resourceRight }
        : intent.kind === 'appointmentCreate' ||
            intent.kind === 'appointmentUpdate'
          ? { scope: intent.calendarId, sentence: writeSentences.calendarRight }
          : { scope: intent.categoryId, sentence: writeSentences.missingRight };
    const missing = rules.requiredRights.filter(({ module, right }) => {
      const value = permissions.granted[module]?.[right];
      return !(
        value === true ||
        (Array.isArray(value) && value.includes(scope))
      );
    });
    if (missing.length > 0) {
      throw refuse('permission', sentence, missing);
    }
    return permissions;
  };

  // A text Ecclium adds as a whole, a new page or a section, ended with its
  // line of the marking (ADR 0032), and how to judge a page for a section
  // of it: the same text on the same day in the same tenant has the same
  // check code. Without the key or whom to ask, nothing is added.
  const markingOf = (
    ctx: TenantContext,
    day: IsoDate | undefined,
  ): {
    readonly key: KeyMaterial;
    readonly inquiriesTo: string;
    readonly day: IsoDate;
  } => {
    const inquiriesTo = options.policy.interactive.inquiriesTo;
    if (markerKey === undefined || inquiriesTo === undefined) {
      ctx.log.warn('write_refused', { code: 'policy_denied' });
      throw refuse('policy_denied', writeSentences.noMarking);
    }
    // Like a clock that differs from ChurchTools: no day, no write.
    if (day === undefined) {
      ctx.log.warn('write_refused', { code: 'policy_denied' });
      throw refuse('policy_denied', writeSentences.noDay);
    }
    return { key: markerKey, inquiriesTo, day };
  };

  // What a new page or a section needs for its marking, checked before the
  // rights and before any read.
  const checkMarking = (
    ctx: TenantContext,
    intent: WikiIntent,
    day: IsoDate | undefined,
  ): void => {
    if (intent.kind !== 'wikiPageUpdate') markingOf(ctx, day);
  };

  // A run of a routine marks with its routine and period, and its own
  // section is the one of the same routine and period, whatever its text
  // and its day; an interactive write marks with its day, and only the
  // same text on the same day is the same section (ADR 0032).
  const marked = (
    ctx: TenantContext,
    written: string,
    given: IsoDate | undefined,
    run?: { readonly routine: string; readonly period: string },
  ): {
    readonly text: string;
    readonly judge: (page: string) => SectionJudgement;
    readonly isThis: (marking: Marking) => boolean;
    readonly isLast: (page: string) => boolean;
  } => {
    const { key, inquiriesTo, day } = markingOf(ctx, given);
    const origin =
      run === undefined
        ? Object.freeze({ kind: 'interactive' as const, day })
        : Object.freeze({
            kind: 'routine' as const,
            routine: run.routine,
            run: run.period,
          });
    const code = checkCodeOf(
      key,
      ctx.tenantId,
      origin,
      canonicalOfWritten(written),
    );
    const line = markingLineOf({ date: day, origin, code }, inquiriesTo);
    const matches = (marking: Marking): boolean =>
      run === undefined
        ? marking.origin.kind === 'interactive' &&
          marking.date === day &&
          sameCheckCode(marking.code, code)
        : marking.origin.kind === 'routine' &&
          marking.origin.routine === run.routine &&
          marking.origin.run === run.period;
    const isThis = (marking: Marking): boolean =>
      matches(marking) && sameCheckCode(marking.code, code);
    return {
      // The text, an empty line and the line of the marking, in the form
      // ChurchTools stores: the written text ends with a line break, the
      // whole text without one (F51).
      text: storedWikiText(`${written}\n${line}`),
      judge: (page) =>
        judgeSections({ key, tenantId: ctx.tenantId, text: page, matches }),
      isThis,
      // The line comes back as the last marking of the page, a paragraph of
      // the top level on its last line: else the page ends in a block that
      // swallows the section, such as an open block of code or comment.
      isLast: (page) => {
        const last = findMarkings(page).at(-1);
        return (
          last !== undefined &&
          isThis(last.marking) &&
          last.line === page.trimEnd().split('\n').length - 1
        );
      },
    };
  };

  // A change of a page may keep the lines of the marking the page has, and
  // drop some, but add none and change none: a line a person did not see
  // Ecclium write would pass for one of Ecclium (ADR 0032).
  const keepsMarkings = (
    ctx: TenantContext,
    before: string,
    after: string,
  ): void => {
    const left = new Map<string, number>();
    for (const key of markingTextsOf(before)) {
      left.set(key, (left.get(key) ?? 0) + 1);
    }
    for (const key of markingTextsOf(after)) {
      const count = left.get(key) ?? 0;
      if (count === 0) {
        ctx.log.warn('content_marking');
        throw new ContentRefusal(['marking']);
      }
      left.set(key, count - 1);
    }
  };

  // ChurchTools takes at most 64 KiB of text for a page; the line of the
  // marking and the text of the page around a section can pass it, which
  // is refused here, before anything is confirmed.
  const fits = (text: string): void => {
    if (new TextEncoder().encode(text).byteLength > maxWikiWriteBytes) {
      throw refuse('validation', writeSentences.tooLong);
    }
  };

  // Reads what a plan of a write of the wiki rests on. The day is that of
  // the marking of a new page or a section, the run that of a section a
  // run of a routine adds.
  const derive = async (
    ctx: TenantContext,
    intent: WikiIntent,
    day: IsoDate | undefined,
    restoring = false,
    run?: { readonly routine: string; readonly period: string },
  ): Promise<Derived> => {
    if (intent.kind === 'wikiPageCreate') {
      if (isBlank(intent.text)) {
        throw refuse('validation', writeSentences.blank);
      }
      // The title as the content policy wrote it, which the client would
      // refuse only at the commit, after the confirmation was used up.
      if (!isWikiTitle(intent.title)) {
        throw refuse('validation', writeSentences.title);
      }
      const { text } = marked(ctx, intent.text, day);
      fits(text);
      const { serverTime } = await client.writes.wikiCategoryState(
        ctx,
        intent.categoryId,
      );
      return {
        kind: 'create',
        contentHash: contentHashOf([intent.title, text]),
        serverTime,
        title: intent.title,
        text,
      };
    }
    const added =
      intent.kind === 'wikiPageUpdate' ? intent.text : intent.section;
    if (isBlank(added)) throw refuse('validation', writeSentences.blank);
    const section =
      intent.kind === 'wikiSectionAppend'
        ? marked(ctx, intent.section, day, run)
        : undefined;
    const { page, serverTime } = await client.writes.wikiPageState(
      ctx,
      intent.categoryId,
      intent.guid,
    );
    if (!page.isMarkdown) {
      throw refuse('policy_denied', writeSentences.notMarkdown);
    }
    if (page.version !== intent.baseVersion) {
      throw refuse('conflict', writeSentences.changedBefore);
    }
    // An undo writes back what the page held before, which is no text of a
    // tool and may hold lines a change dropped since (ADR 0031).
    if (section === undefined && !restoring) {
      keepsMarkings(ctx, page.text, added);
    }
    const judged = section?.judge(page.text);
    // A run finds its own section of the period with another text: the new
    // text takes its place, so that a second run never adds it twice. The
    // same text, whose check code is the one of the line, is a repeat
    // (ADR 0032).
    const replacing =
      run !== undefined &&
      section !== undefined &&
      judged?.kind === 'own' &&
      !findMarkings(page.text).some(
        (found) => found.line === judged.end && section.isThis(found.marking),
      );
    const marking: Extract<Derived, { kind: 'change' }>['marking'] = replacing
      ? 'replaced'
      : judged?.kind;
    // A text without the white space ChurchTools removes at its ends, so
    // that the read after the write finds what was sent (F51).
    const text =
      section === undefined
        ? storedWikiText(added)
        : replacing
          ? replaceSection(page.text, judged, section.text)
          : appendSection(page.text, section.text);
    // A repeat is skipped whatever its size; a page that would swallow the
    // new section cannot be marked.
    if (marking !== 'own') fits(text);
    // A replaced section needs no such check: it takes exactly the lines of
    // a section the page showed as top-level blocks that end with its line
    // of the marking, after an empty line and before the same lines as
    // before, and the content policy lets no block into it that could open,
    // so it stands as the own one of the period again (ADR 0032).
    if (
      section !== undefined &&
      !replacing &&
      marking !== 'own' &&
      !section.isLast(text)
    ) {
      throw refuse('validation', writeSentences.pageOpen);
    }
    return {
      kind: 'change',
      contentHash: contentHashOf([text]),
      serverTime,
      before: page,
      text,
      ...(marking === undefined ? {} : { marking }),
    };
  };

  // Rejects only with an EccliumError or a refusal of the content policy:
  // any other error of a read becomes internal, so that the pipeline
  // passes on a fixed sentence.
  const plan = async (
    request: PlanRequest,
    value: unknown,
  ): Promise<PlanResult> => {
    try {
      return await planOnce(request, value);
    } catch (error) {
      throw error instanceof ContentRefusal ? error : asError(error);
    }
  };

  const planOnce = async (
    request: PlanRequest,
    value: unknown,
  ): Promise<PlanResult> => {
    const { ctx, run } = request;
    // The day of the marking of a new page or a section: the day of this
    // plan, kept in the sealed plan for the commit and the queue.
    const day = isoDateOf(clock.now());
    const stop = stopped(ctx, run?.routine);
    if (stop !== undefined) throw stop;
    const intent = readIntent(value);
    if (intent === undefined) throw refuse('validation', writeSentences.intent);
    const rules = withToolMeta(rulesOf(intent), request.meta);
    if (!rules.runs) {
      ctx.log.warn('write_refused', { code: 'policy_denied' });
      throw refuse('policy_denied', writeSentences.notRun);
    }
    // A run writes nothing but a section of the wiki, with a tool of the
    // core that may run unattended, and only in the mode of a run: the
    // proof of the policy exists for nothing else (ADR 0029, ADR 0071).
    if (
      run !== undefined &&
      (ctx.mode !== 'unattended' ||
        intent.kind !== 'wikiSectionAppend' ||
        rules.module !== 'core' ||
        rules.unattended !== 'policy' ||
        request.origin !== 'core')
    ) {
      ctx.log.warn('write_refused', { code: 'policy_denied' });
      throw refuse('policy_denied', writeSentences.notForRun);
    }
    // A write runs only when the core runs its kind (rules.ts): one of the
    // wiki or one of calendars and resources. Its texts go through the
    // content policy before anything else, and from here on the intent
    // holds them in their written form (ADR 0030). A text of a run may
    // also hold the contact values of the data the run read.
    if (isCalendarIntent(intent)) {
      return planCalendarOnce(request, intent, rules, day);
    }
    const wiki = checkIntentContent(
      ctx,
      intent as WikiIntent,
      run === undefined ? contacts : new Set([...contacts, ...run.contacts]),
    );
    checkMarking(ctx, wiki, day);
    const permissions = await checkRights(ctx, wiki, rules);
    const origin =
      run === undefined
        ? undefined
        : { routine: run.routine, period: run.period };
    const derived = await derive(ctx, wiki, day, false, origin);
    // The policy, with the counters of the day and of the run only read
    // (ADR 0032). A plan it sends to the queue is sealed all the same
    // (ADR 0031).
    const policyQueue = await policy.check(
      ctx,
      request.tool,
      rules,
      factsOf(derived),
      'plan',
      run === undefined
        ? undefined
        : { routine: run.routine, runWrites: run.runWrites },
    );
    // An account of a run with rights its routines do not need: the write
    // goes to the queue, the run goes on, unless the exception of the
    // policy holds today (ADR 0032).
    const drift =
      run === undefined
        ? 'none'
        : rightsDriftOf(ctx, run, permissions.granted, day);
    // The same section, marked on the same day, already stands on the page
    // as Ecclium's own: a repeat, which adds nothing (ADR 0032).
    if (derived.kind === 'change' && derived.marking === 'own') {
      ctx.log.info('marking_repeated', {});
      return Object.freeze({
        outcome: Object.freeze({ kind: 'skipped', reason: 'already_written' }),
        target: rules.target,
      });
    }
    if (derived.kind === 'change' && derived.text === derived.before.text) {
      return Object.freeze({
        outcome: Object.freeze({ kind: 'skipped', reason: 'unchanged' }),
        target: rules.target,
      });
    }
    // A section with the marking of this one that a person changed: the
    // operator decides whether it is a repeat, Ecclium never does.
    // A reason of the policy stays the one the operator reads; the log
    // names the changed section either way.
    // Rights the account should not have come first: an approval does not
    // check them again, so the operator has to read them as the reason.
    let queue: PlanQueueReason | undefined =
      (drift === 'queue' ? 'rights_drift' : undefined) ?? policyQueue;
    if (derived.kind === 'change' && derived.marking === 'changed') {
      ctx.log.warn('marking_changed', {});
      queue ??= 'marker_changed';
    }
    const sealed = sealPlan({
      tenantId: ctx.tenantId,
      actor: ctx.actor,
      tool: request.tool,
      origin: request.origin,
      intent: wiki,
      toolMeta: request.meta,
      contentHash: derived.contentHash,
      sealedAt: clock.now(),
      ...(day === undefined ? {} : { day }),
      snapshots: reversible,
      ...(run === undefined
        ? {}
        : { run: planRunOf(run, wiki as SectionIntent) }),
    });
    return Object.freeze({
      outcome: Object.freeze({ kind: 'planned', plan: sealed }),
      target: rules.target,
      text: textOf(wiki, derived),
      ...(queue === undefined ? {} : { queue }),
      ...(drift === 'accepted' ? { rightsDriftAccepted: true as const } : {}),
    });
  };

  // Whether the account of a run has rights its routines do not need, and
  // if so whether the exception of the entries of its routine holds today.
  // The log names how many, never which.
  const rightsDriftOf = (
    ctx: TenantContext,
    run: RunPlanRequest,
    granted: Extract<Permissions, { kind: 'known' }>['granted'],
    day: IsoDate | undefined,
  ): 'none' | 'queue' | 'accepted' => {
    const beyond = rightsBeyond(granted, run.needs);
    if (beyond.length === 0) return 'none';
    const entries = options.policy.unattended.filter(
      (entry) => entry.routine === run.routine,
    );
    if (rightsDriftAccepted(entries, day)) {
      ctx.log.warn('run_rights_drift_accepted', { count: beyond.length });
      return 'accepted';
    }
    ctx.log.warn('run_rights_drift', { count: beyond.length });
    return 'queue';
  };

  // The run a plan of a section comes from, with the keys of the contact
  // values from the data of the run that the section holds, so that an
  // approval checks it as the run did (ADR 0030).
  const planRunOf = (run: RunPlanRequest, intent: SectionIntent): PlanRun => {
    const held = contactKeysInSection(intent.section);
    return {
      routine: run.routine,
      period: run.period,
      // An entry of the queue keeps at most 100; an approval of a section
      // with more contact values from the data refuses it rather than
      // trusting more.
      contacts: [...held]
        .filter((key) => run.contacts.has(key))
        .sort()
        .slice(0, 100),
    };
  };

  // Plans a write of an appointment or a booking: texts, rights, the read
  // of the target, the policy, and a plan sealed on what was read. It adds
  // no marking (ADR 0032).
  const planCalendarOnce = async (
    request: PlanRequest,
    value: CalendarIntent,
    rules: IntentRules,
    day: IsoDate | undefined,
  ): Promise<PlanResult> => {
    const { ctx } = request;
    const intent = checkIntentContent(ctx, value, contacts);
    await checkRights(ctx, intent, rules);
    const plan = await planCalendar(calendars, ctx, intent, request.tool);
    const queue = await policy.check(ctx, request.tool, rules, {}, 'plan');
    if (plan.skip !== undefined) {
      return Object.freeze({
        outcome: Object.freeze({ kind: 'skipped', reason: plan.skip }),
        target: rules.target,
      });
    }
    const sealed = sealPlan({
      tenantId: ctx.tenantId,
      actor: ctx.actor,
      tool: request.tool,
      origin: request.origin,
      intent,
      toolMeta: request.meta,
      contentHash: plan.contentHash,
      sealedAt: clock.now(),
      ...(day === undefined ? {} : { day }),
      snapshots: reversible,
    });
    return Object.freeze({
      outcome: Object.freeze({ kind: 'planned', plan: sealed }),
      target: rules.target,
      text: plan.text,
      ...(queue === undefined ? {} : { queue }),
    });
  };

  const denied = (
    error: EccliumError,
    target?: WriteTarget,
    path?: ConfirmationPath,
  ): CommitResult =>
    Object.freeze({
      ok: false,
      state: 'denied',
      error,
      sent: false,
      ...(target === undefined ? {} : { target }),
      ...(path === undefined ? {} : { path }),
    });

  // A commit that ended after the proof was used. A conflict and an
  // outcome that is not known are logged, a refusal of ChurchTools is not.
  const ended = (
    ctx: TenantContext,
    state: 'conflict' | 'failed',
    error: EccliumError,
    sent: boolean,
    target: WriteTarget,
    path: ConfirmationPath,
  ): CommitResult => {
    if (state === 'conflict') {
      ctx.log.warn('write_conflict', { code: error.code });
    } else if (sent) {
      ctx.log.warn('write_outcome_unknown', { code: error.code });
    }
    return Object.freeze({ ok: false, state, error, sent, target, path });
  };

  const commit = async (
    ctx: TenantContext,
    value: unknown,
    proof: unknown,
    eventId?: string,
  ): Promise<CommitResult> => {
    const view = readPlan(value);
    if (
      view === undefined ||
      view.tenantId !== ctx.tenantId ||
      view.actor.kind !== ctx.actor.kind ||
      view.actor.id !== ctx.actor.id
    ) {
      return denied(refuse('internal', writeSentences.notConfirmed));
    }
    const target = view.rules.target;
    // A plan of a run commits only through the way of a run.
    if (view.run !== undefined) {
      useProof(proof, view, clock.now());
      return denied(refuse('internal', writeSentences.notConfirmed), target);
    }
    const stop = stopped(ctx);
    if (stop !== undefined) return denied(stop, target);
    return commitPlan(ctx, view, proof, eventId, 'tool');
  };

  // The commit of a write of a run of a routine (ADR 0029, ADR 0032): the
  // guard issues the proof of the policy itself, only in the mode of a run
  // and only for a plan sealed for a run, which the policy checked when it
  // was planned and checks again right before the send, with the counters
  // of the day and of the run. The proof holds only where the plan allows
  // the way of the policy (proof.ts): never for an intent of the Pro module
  // or one that may never run unattended.
  const commitForRun = async (
    ctx: TenantContext,
    value: unknown,
    runWrites: RunWrites,
    eventId?: string,
  ): Promise<CommitResult> => {
    const view = readPlan(value);
    if (
      view?.run === undefined ||
      ctx.mode !== 'unattended' ||
      view.tenantId !== ctx.tenantId ||
      view.actor.kind !== ctx.actor.kind ||
      view.actor.id !== ctx.actor.id
    ) {
      return denied(refuse('internal', writeSentences.notConfirmed));
    }
    const target = view.rules.target;
    const stop = stopped(ctx, view.run.routine);
    if (stop !== undefined) return denied(stop, target);
    let proof: unknown;
    try {
      proof = issueProof(value as PlannedWrite, 'policy', clock.now());
    } catch {
      ctx.log.warn('write_refused', { code: 'policy_denied' });
      return denied(refuse('policy_denied', writeSentences.notForRun), target);
    }
    return commitPlan(ctx, view, proof, eventId, 'tool', runWrites);
  };

  // An undo of the operator skips the policy, which judges what the model
  // asks for, and adds nothing to its counters (ADR 0031). An approval runs
  // it in a phase of its own, which only counts (ADR 0029).
  const commitPlan = async (
    ctx: TenantContext,
    view: PlanView,
    proof: unknown,
    eventId: string | undefined,
    by: 'tool' | 'undo' | 'approve',
    runWrites?: RunWrites,
  ): Promise<CommitResult> => {
    // The routine of a run, whose kill switch and entries count as well.
    const routine = view.run?.routine;
    // A plan is sealed only for an intent the core runs (sealed-plan.ts).
    const { intent } = view;
    const target = view.rules.target;
    // The read right before the write: the plan derived again from the
    // state of the target, with the time of ChurchTools.
    let derived: Prepared;
    try {
      derived = await prepare(ctx, view, by);
    } catch (error) {
      useProof(proof, view, clock.now());
      return denied(
        isEccliumError(error) && error.code === 'conflict'
          ? refuse('conflict', writeSentences.changedSincePlan)
          : asError(error),
        target,
      );
    }
    // What the write would add stands there since the plan, written by
    // someone else: nothing is left to write.
    if (derived.skip !== undefined) {
      useProof(proof, view, clock.now());
      ctx.log.warn('write_conflict', { code: 'conflict' });
      return denied(
        refuse('conflict', writeSentences.changedSincePlan),
        target,
      );
    }
    const again = readPlan(
      sealPlan({
        tenantId: view.tenantId,
        actor: view.actor,
        tool: view.tool,
        origin: view.origin,
        intent,
        toolMeta: {
          sensitivity: view.rules.sensitivity,
          unattended: view.rules.unattended,
          reversible: view.rules.reversible,
        },
        contentHash: derived.contentHash,
        sealedAt: clock.now(),
        ...(view.day === undefined ? {} : { day: view.day }),
        snapshots: reversible,
        ...(view.run === undefined ? {} : { run: view.run }),
      }),
    ) as PlanView;
    const now = clock.now();
    if (again.planHash !== view.planHash) {
      // The proof was offered, so it is used up all the same.
      useProof(proof, view, now);
      ctx.log.warn('write_conflict', { code: 'conflict' });
      return denied(
        refuse('conflict', writeSentences.changedSincePlan),
        target,
      );
    }
    const path = useProof(proof, again, now);
    if (path === undefined) {
      return denied(
        refuse('confirmation_required', writeSentences.notConfirmed),
        target,
      );
    }
    // Writing may have been switched off during the read.
    const stopNow = stopped(ctx, routine);
    if (stopNow !== undefined) return denied(stopNow, target, path);
    if (!serverTimeFits(now, derived.serverTime)) {
      ctx.log.warn('write_refused', { code: 'policy_denied' });
      return denied(
        refuse('policy_denied', writeSentences.clock),
        target,
        path,
      );
    }
    // The policy once more, right before the send: the names may have
    // changed since the plan, and the write takes its place in the counter
    // of the day. A refusal here has used up the proof (ADR 0032). A read
    // of a name that fails is no refusal of the policy: the write failed
    // before it was sent.
    try {
      if (by !== 'undo') {
        await policy.check(
          ctx,
          view.tool,
          view.rules,
          derived.facts,
          by === 'approve' ? 'approve' : 'commit',
          routine === undefined
            ? undefined
            : ({
                routine,
                ...(runWrites === undefined ? {} : { runWrites }),
              } satisfies GateRun),
        );
      }
    } catch (error) {
      const failure = asError(error);
      return failure.code === 'policy_denied'
        ? denied(failure, target, path)
        : ended(ctx, 'failed', failure, false, target, path);
    }
    // The policy may have read ChurchTools and waited for its counter, so
    // the switches once more: a write counted and then stopped stays
    // counted, as one that fails after its count (ADR 0029, ADR 0032).
    const stopLate = stopped(ctx, routine);
    if (stopLate !== undefined) return denied(stopLate, target, path);
    // The state before the write, kept before the one send: a snapshot
    // that cannot be kept stops the write, so that every write the core
    // sends with snapshots on can be taken back (ADR 0031).
    const undo = await saveBefore(ctx, eventId, now, derived.before);
    if (undo === 'failed') return noSnapshot(ctx, target, path);
    return derived.send(path, undo);
  };

  // Keeps the part before of the snapshot of a write: where it was kept,
  // undefined with snapshots off, or failed, which stops the write.
  const saveBefore = async (
    ctx: TenantContext,
    eventId: string | undefined,
    now: number,
    content: SnapshotState,
  ): Promise<Undo | undefined | 'failed'> => {
    if (snapshots === undefined) return undefined;
    const day = isoDateOf(now);
    try {
      if (eventId === undefined || day === undefined) {
        throw new TypeError('No event or no day.');
      }
      await snapshots.save(ctx, { eventId, part: 'before', day, content });
      return { eventId, day };
    } catch {
      ctx.log.warn('snapshot_failed', { code: 'internal' });
      return 'failed';
    }
  };

  const noSnapshot = (
    ctx: TenantContext,
    target: WriteTarget,
    path: ConfirmationPath,
  ): CommitResult =>
    ended(
      ctx,
      'failed',
      refuse('internal', writeSentences.noSnapshot),
      false,
      target,
      path,
    );

  // What a commit rests on, read right before the send: the hash, the time
  // of ChurchTools, the facts the policy names, what the snapshot keeps and
  // the one send. A write of the wiki derives it from its page, one of an
  // appointment or a booking from the plan of `calendar-plan.ts`.
  const prepare = async (
    ctx: TenantContext,
    view: PlanView,
    by: 'tool' | 'undo' | 'approve',
  ): Promise<Prepared> => {
    const { intent } = view;
    if (isCalendarIntent(intent)) {
      const plan = await planCalendar(calendars, ctx, intent, view.tool);
      return {
        contentHash: plan.contentHash,
        serverTime: plan.serverTime,
        facts: {},
        ...(plan.skip === undefined ? {} : { skip: plan.skip }),
        before: plan.before,
        send: async (path, undo) =>
          commitOf(
            ctx,
            await plan.send((created) => completeCreated(ctx, undo, created)),
            path,
            undo,
          ),
      };
    }
    const wiki = intent as WikiIntent;
    const derived = await derive(
      ctx,
      wiki,
      view.day,
      by === 'undo',
      view.run === undefined
        ? undefined
        : { routine: view.run.routine, period: view.run.period },
    );
    return {
      contentHash: derived.contentHash,
      serverTime: derived.serverTime,
      facts: factsOf(derived),
      before:
        derived.kind === 'create'
          ? {
              kind: 'wikiPageCreate',
              tool: view.tool,
              categoryId: wiki.categoryId,
              title: derived.title,
              textHash: contentHashOf([derived.text]),
            }
          : {
              kind: 'wikiPageText',
              tool: view.tool,
              categoryId: wiki.categoryId,
              guid: (wiki as PageIntent).guid,
              before: {
                version: derived.before.version,
                text: derived.before.text,
              },
              after: {
                version: derived.before.version + 1,
                textHash: contentHashOf([derived.text]),
              },
            },
      send: (path, undo) =>
        derived.kind === 'create'
          ? create(
              ctx,
              wiki as Extract<WikiIntent, { kind: 'wikiPageCreate' }>,
              derived.text,
              path,
              undo,
            )
          : change(
              ctx,
              wiki as PageIntent,
              derived,
              view.rules.target,
              path,
              undo,
            ),
    };
  };

  // The commit of a send of an appointment or a booking, as for a page.
  const commitOf = (
    ctx: TenantContext,
    outcome: SendOutcome,
    path: ConfirmationPath,
    undo: Undo | undefined,
  ): CommitResult => {
    const { target } = outcome;
    switch (outcome.kind) {
      case 'verified':
        return verified(ctx, path, target, outcome.version, undo);
      case 'notSent':
        return ended(
          ctx,
          'failed',
          refuse(outcome.code, writeSentences.notSent),
          false,
          target,
          path,
        );
      case 'refused':
        return ended(ctx, 'failed', outcome.error, false, target, path);
      case 'unknown':
        return ended(
          ctx,
          'failed',
          refuse(outcome.code, writeSentences.unknown),
          true,
          target,
          path,
        );
      case 'notAsPlanned':
        return ended(
          ctx,
          'conflict',
          refuse('conflict', writeSentences.notAsPlanned),
          true,
          target,
          path,
        );
    }
  };

  // Once ChurchTools names a new appointment or booking, the second part
  // of its snapshot, as for a new page; a part that cannot be kept leaves
  // the write as it is, and the log says so.
  const completeCreated = async (
    ctx: TenantContext,
    undo: Undo | undefined,
    created: DatedCreatedSnapshot,
  ): Promise<void> => {
    if (snapshots === undefined || undo === undefined) return;
    try {
      await snapshots.save(ctx, {
        eventId: undo.eventId,
        part: 'after',
        day: undo.day,
        content: created,
      });
    } catch {
      ctx.log.warn('snapshot_incomplete', { code: 'internal' });
    }
  };

  // Once ChurchTools names a new page, the second part of its snapshot:
  // its GUID and version, without which `ecclium undo` cannot find it. It
  // is kept before the checks of the answer and the read back, so that a
  // page that exists but does not read back as planned can be found too.
  // A part that cannot be kept leaves the write as it is, and the log says
  // so.
  const completeCreate = async (
    ctx: TenantContext,
    undo: Undo | undefined,
    created: { readonly guid: string; readonly version: number },
  ): Promise<void> => {
    if (snapshots === undefined || undo === undefined) return;
    try {
      await snapshots.save(ctx, {
        eventId: undo.eventId,
        part: 'after',
        day: undo.day,
        content: {
          kind: 'wikiPageCreated',
          guid: created.guid,
          version: created.version,
        },
      });
    } catch {
      ctx.log.warn('snapshot_incomplete', { code: 'internal' });
    }
  };

  // Creates a page with its text and its line of the marking. Without its
  // GUID the core cannot read it back after a failure, so an answer it did
  // not get leaves the outcome unknown.
  const create = async (
    ctx: TenantContext,
    intent: Extract<WriteIntent, { kind: 'wikiPageCreate' }>,
    text: string,
    path: ConfirmationPath,
    undo: Undo | undefined,
  ): Promise<CommitResult> => {
    const category: WriteTarget = Object.freeze({
      kind: 'wiki_category',
      key: String(intent.categoryId),
    });
    let created: Awaited<ReturnType<ChurchToolsWrites['createWikiPage']>>;
    try {
      created = await client.writes.createWikiPage(
        ctx,
        intent.categoryId,
        intent.title,
        text,
      );
    } catch (error) {
      if (notSent(error)) {
        return ended(
          ctx,
          'failed',
          refuse(asError(error).code, writeSentences.notSent),
          false,
          category,
          path,
        );
      }
      // ChurchTools answered and refused: nothing was created.
      if (isEccliumError(error) && definite.includes(error.code)) {
        return ended(ctx, 'failed', error, false, category, path);
      }
      return ended(
        ctx,
        'failed',
        refuse(asError(error).code, writeSentences.unknown),
        true,
        category,
        path,
      );
    }
    const page: WriteTarget = Object.freeze({
      kind: 'wiki_page',
      key: `${String(intent.categoryId)}/${created.guid.toLowerCase()}`,
    });
    await completeCreate(ctx, undo, created);
    if (
      created.version !== 1 ||
      created.title !== intent.title ||
      !created.isMarkdown
    ) {
      return ended(
        ctx,
        'conflict',
        refuse('conflict', writeSentences.notAsPlanned),
        true,
        page,
        path,
      );
    }
    try {
      const after = await client.writes.wikiPageState(
        ctx,
        intent.categoryId,
        created.guid,
      );
      if (after.page.version === 1 && after.page.text === text) {
        return verified(ctx, path, page, 1, undo);
      }
    } catch (error) {
      return ended(
        ctx,
        'failed',
        refuse(asError(error).code, writeSentences.unknown),
        true,
        page,
        path,
      );
    }
    return ended(
      ctx,
      'conflict',
      refuse('conflict', writeSentences.notAsPlanned),
      true,
      page,
      path,
    );
  };

  // Changes the text of a page and reads it back. After any failure but a
  // refused target, the read decides what happened.
  const change = async (
    ctx: TenantContext,
    intent: PageIntent,
    derived: Extract<Derived, { kind: 'change' }>,
    target: WriteTarget,
    path: ConfirmationPath,
    undo: Undo | undefined,
  ): Promise<CommitResult> => {
    const base = derived.before.version;
    const { text } = derived;
    let failure: unknown;
    try {
      await client.writes.updateWikiPage(
        ctx,
        intent.categoryId,
        intent.guid,
        text,
      );
    } catch (error) {
      if (notSent(error)) {
        return ended(
          ctx,
          'failed',
          refuse(asError(error).code, writeSentences.notSent),
          false,
          target,
          path,
        );
      }
      failure = error;
    }
    let after: WikiPage;
    try {
      after = (
        await client.writes.wikiPageState(ctx, intent.categoryId, intent.guid)
      ).page;
    } catch (error) {
      return ended(
        ctx,
        'failed',
        refuse(asError(failure ?? error).code, writeSentences.unknown),
        true,
        target,
        path,
      );
    }
    if (after.version === base + 1 && after.text === text) {
      return verified(ctx, path, target, after.version, undo);
    }
    // Only a refusal of ChurchTools shows that the write did not land; after
    // any other failure it may still land later (ADR 0072).
    if (failure !== undefined && after.version === base) {
      const refused =
        isEccliumError(failure) && definite.includes(failure.code);
      return ended(
        ctx,
        'failed',
        refuse(
          asError(failure).code,
          refused ? writeSentences.notSent : writeSentences.unknown,
        ),
        !refused,
        target,
        path,
      );
    }
    return ended(
      ctx,
      'conflict',
      refuse('conflict', writeSentences.notAsPlanned),
      true,
      target,
      path,
    );
  };

  const verified = (
    ctx: TenantContext,
    path: ConfirmationPath,
    target: WriteTarget,
    version: number,
    undo: Undo | undefined,
  ): CommitResult => {
    ctx.log.info('write_committed');
    return Object.freeze({
      ok: true,
      state: 'verified',
      path,
      target,
      version,
      ...(undo === undefined ? {} : { undoId: undo.eventId }),
    });
  };

  // Takes a write back: the page of the snapshot read now, the text from
  // before written back or a new page withdrawn, as an update the core
  // plans and confirms itself for the operator (ADR 0031). Rejects nothing:
  // a refusal or a failed read before the plan is a result of its own.
  const undo = async (request: UndoRequest): Promise<UndoResult> => {
    try {
      return await undoOnce(request);
    } catch (error) {
      return Object.freeze({ kind: 'refused', error: asError(error) });
    }
  };

  const undoOnce = async (request: UndoRequest): Promise<UndoResult> => {
    const stop = stopped(request.ctx);
    if (stop !== undefined) throw stop;
    const found = undoOf(request.snapshot);
    switch (found.area) {
      case 'wiki':
        return undoPage(request, found.snapshot);
      case 'calendar':
        return undoCalendar(request, found.target);
      case 'incomplete':
        return Object.freeze({ kind: 'incomplete', target: found.place });
    }
  };

  const undoPage = async (
    request: UndoRequest,
    wiki: WikiSnapshotToUndo,
  ): Promise<UndoResult> => {
    const { ctx, eventId, overwrite } = request;
    const found = undoTargetOf(wiki);
    if (!found.ok) {
      return Object.freeze({
        kind: 'incomplete',
        target: Object.freeze({
          kind: 'wiki_category',
          key: String(found.categoryId),
        }),
      });
    }
    const undoing = found.target;
    const today = isoDateOf(clock.now());
    if (today === undefined)
      throw refuse('policy_denied', writeSentences.clock);
    // The rights as advice for the update the undo writes, as for every
    // write of a page; the text is not known before the read.
    const asked: PageIntent = Object.freeze({
      kind: 'wikiPageUpdate',
      categoryId: undoing.categoryId,
      guid: undoing.guid,
      text: '-',
      baseVersion: 0,
    });
    const rules = withToolMeta(rulesOf(asked), undoMeta);
    await checkRights(ctx, asked, rules);
    const { target } = rules;
    const { page } = await client.writes.wikiPageState(
      ctx,
      undoing.categoryId,
      undoing.guid,
    );
    if (!page.isMarkdown) {
      throw refuse('policy_denied', writeSentences.notMarkdown);
    }
    const text = undoing.textOn(today);
    if (undoing.done(page.text)) {
      return Object.freeze({ kind: 'unchanged', target });
    }
    const change: UndoChange = Object.freeze({ from: page.text, to: text });
    if (!overwrite && !isAsLeft(undoing, page)) {
      return Object.freeze({ kind: 'changed', target, change });
    }
    // The plan of the update, sealed on the version read now, so that the
    // commit writes nothing when the page changes in between.
    const intent: PageIntent = Object.freeze({
      kind: 'wikiPageUpdate',
      categoryId: undoing.categoryId,
      guid: undoing.guid,
      text,
      baseVersion: page.version,
    });
    const sealed = sealPlan({
      tenantId: ctx.tenantId,
      actor: ctx.actor,
      tool: undoing.tool,
      origin: 'core',
      intent,
      toolMeta: undoMeta,
      contentHash: contentHashOf([text]),
      sealedAt: clock.now(),
      snapshots: reversible,
    });
    // The operator asked for this undo on the command line, so the core
    // confirms it itself, on the way of the operator, and for this plan
    // only (proof.ts).
    const proof = issueProof(sealed, 'operator', clock.now());
    const result = await commitPlan(
      ctx,
      readPlan(sealed) as PlanView,
      proof,
      eventId,
      'undo',
    );
    return Object.freeze({ kind: 'committed', target, result, change });
  };

  // Takes back a write of an appointment or a booking for the operator
  // (ADR 0031). No plan is sealed, since no intent deletes and none empties
  // a description, but the steps of every commit run: the switches, the
  // rights as advice, the read right before, the clock, the snapshot of a
  // change, the one send and the read after. The policy does not apply.
  const undoCalendar = async (
    request: UndoRequest,
    undoing: CalendarUndoTarget,
  ): Promise<UndoResult> => {
    const { ctx, eventId, overwrite } = request;
    // The rights of the write taken back, from an intent of its kind; only
    // the place of the intent counts for them.
    const asked: CalendarIntent =
      undoing.kind === 'deleteBooking'
        ? {
            kind: 'bookingCreate',
            resourceId: undoing.resourceId,
            title: '-',
            startDate: undoing.startDate,
            endDate: undoing.endDate,
          }
        : {
            kind: 'appointmentUpdate',
            calendarId: undoing.calendarId,
            appointmentId: undoing.appointmentId,
            baseVersion: 0,
            title: '-',
            startDate: '-',
            endDate: '-',
          };
    await checkRights(ctx, asked, withToolMeta(rulesOf(asked), undoMeta));
    const target: WriteTarget = Object.freeze(
      undoing.kind === 'deleteBooking'
        ? {
            kind: 'booking',
            key: `${String(undoing.resourceId)}/${String(undoing.bookingId)}`,
          }
        : {
            kind: 'appointment',
            key: `${String(undoing.calendarId)}/${String(undoing.appointmentId)}`,
          },
    );
    const planned = await planCalendarUndo(calendars, ctx, undoing, overwrite);
    if (planned.kind === 'unchanged') {
      return Object.freeze({ kind: 'unchanged', target });
    }
    const { change } = planned;
    if (planned.kind === 'changed') {
      return Object.freeze({ kind: 'changed', target, change });
    }
    // The operator asked for this undo on the command line.
    const path: ConfirmationPath = 'operator';
    const committed = (result: CommitResult): UndoResult =>
      Object.freeze({ kind: 'committed', target, result, change });
    const now = clock.now();
    // Writing may have been switched off during the read.
    const stopNow = stopped(ctx);
    if (stopNow !== undefined) return committed(denied(stopNow, target, path));
    if (!serverTimeFits(now, planned.serverTime)) {
      ctx.log.warn('write_refused', { code: 'policy_denied' });
      return committed(
        denied(refuse('policy_denied', writeSentences.clock), target, path),
      );
    }
    // A change keeps a snapshot of its own, a delete none (ADR 0031).
    let undo: Undo | undefined;
    if (planned.before !== undefined) {
      const saved = await saveBefore(ctx, eventId, now, planned.before);
      if (saved === 'failed') return committed(noSnapshot(ctx, target, path));
      undo = saved;
    }
    const outcome = await planned.send();
    if (outcome.kind === 'deleted') {
      ctx.log.info('write_committed');
      return Object.freeze({ kind: 'deleted', target, change });
    }
    return committed(commitOf(ctx, outcome, path, undo));
  };

  // Writes an entry of the queue for the operator: planned again from the
  // state now, decided only when the hash is the one of the entry, and
  // committed with a proof of the operator (ADR 0029). Rejects nothing: a
  // refusal before the decision is a result of its own.
  const approve = async (request: ApproveRequest): Promise<ApproveResult> => {
    try {
      return await approveOnce(request);
    } catch (error) {
      return Object.freeze(
        error instanceof ContentRefusal
          ? {
              kind: 'refused',
              error: error.error,
              contentViolations: error.violations,
            }
          : { kind: 'refused', error: asError(error) },
      );
    }
  };

  const approveOnce = async (
    request: ApproveRequest,
  ): Promise<ApproveResult> => {
    const { ctx, eventId, entry } = request;
    // A write a run queued: the kill switch of its routine as well.
    const stop = stopped(ctx, entry.run?.routine);
    if (stop !== undefined) throw stop;
    // The intent as an intent again, and the rules from it and from the
    // metadata the plan was sealed with, as when the tool planned.
    const read = readIntent(entry.intent);
    if (read === undefined) throw refuse('validation', writeSentences.intent);
    const rules = withToolMeta(rulesOf(read), entry.toolMeta);
    if (!rules.runs) {
      ctx.log.warn('write_refused', { code: 'policy_denied' });
      throw refuse('policy_denied', writeSentences.notRun);
    }
    // The content policy again, since the contact values of the policy
    // may have changed in the meantime (ADR 0030). A write of a run may
    // also hold the contact values of its data that the entry kept.
    const intent = checkIntentContent(
      ctx,
      read as WikiIntent | CalendarIntent,
      entry.run === undefined
        ? contacts
        : new Set([...contacts, ...entry.run.contacts]),
    );
    if (!isCalendarIntent(intent)) checkMarking(ctx, intent, entry.plannedOn);
    await checkRights(ctx, intent, rules);
    let derived: {
      readonly contentHash: string;
      readonly serverTime: number | null;
      readonly change: UndoChange;
    };
    try {
      derived = await approvedBasis(ctx, intent, entry);
    } catch (error) {
      // A target of another version than the one queued is a change since.
      throw isEccliumError(error) && error.code === 'conflict'
        ? refuse('conflict', writeSentences.changedSinceQueued)
        : error;
    }
    // The clock before the decision as well, so that a server with a
    // wrong clock decides nothing it cannot write.
    if (!serverTimeFits(clock.now(), derived.serverTime)) {
      ctx.log.warn('write_refused', { code: 'policy_denied' });
      throw refuse('policy_denied', writeSentences.clock);
    }
    const sealed = sealPlan({
      tenantId: ctx.tenantId,
      actor: ctx.actor,
      tool: entry.tool,
      origin: entry.origin,
      intent,
      toolMeta: entry.toolMeta,
      contentHash: derived.contentHash,
      sealedAt: clock.now(),
      day: entry.plannedOn,
      snapshots: reversible,
      ...(entry.run === undefined ? {} : { run: entry.run }),
    });
    const view = readPlan(sealed) as PlanView;
    if (view.planHash !== entry.planHash) {
      ctx.log.warn('write_conflict', { code: 'conflict' });
      throw refuse('conflict', writeSentences.changedSinceQueued);
    }
    const { target } = rules;
    const { change } = derived;
    // Only a decision that was counted and kept lets the write go on; a
    // second approval, a rejection in between and a store that fails end
    // here (ADR 0029).
    let decided: boolean;
    try {
      decided = await request.decide();
    } catch {
      decided = false;
    }
    if (!decided) return Object.freeze({ kind: 'undecided', target });
    // The operator approved this plan on the command line, so the core
    // confirms it itself, on the way of the operator (proof.ts).
    const proof = issueProof(sealed, 'operator', clock.now());
    const result = await commitPlan(ctx, view, proof, eventId, 'approve');
    return Object.freeze({ kind: 'committed', target, result, change });
  };

  // What an approval rests on, read now: hash, time and the change the
  // operator sees. An appointment or a booking that stands there already
  // is a change since the entry was queued.
  const approvedBasis = async (
    ctx: TenantContext,
    intent: WikiIntent | CalendarIntent,
    entry: ApprovedEntry,
  ): Promise<{
    readonly contentHash: string;
    readonly serverTime: number | null;
    readonly change: UndoChange;
  }> => {
    if (isCalendarIntent(intent)) {
      const plan = await planCalendar(calendars, ctx, intent, entry.tool);
      if (plan.skip !== undefined) {
        throw refuse('conflict', writeSentences.changedSinceQueued);
      }
      return plan;
    }
    const derived = await derive(
      ctx,
      intent,
      entry.plannedOn,
      false,
      entry.run === undefined
        ? undefined
        : { routine: entry.run.routine, period: entry.run.period },
    );
    return {
      contentHash: derived.contentHash,
      serverTime: derived.serverTime,
      change: Object.freeze(
        derived.kind === 'change'
          ? { from: derived.before.text, to: derived.text }
          : { from: '', to: derived.text },
      ),
    };
  };

  return Object.freeze({
    plan,
    commit,
    commitForRun,
    undo,
    approve,
    block: (): void => {
      haltWrites(halt);
    },
  });
}

// What the plan of an undo says of itself: the text of a page may hold
// personal data, and an undo never runs unattended.
const undoMeta = Object.freeze({
  sensitivity: 'personal',
  unattended: 'never',
} as const);

// Codes with which ChurchTools answered and refused a new page: it was not
// created (ADR 0072).
const definite: readonly ErrorCode[] = Object.freeze([
  'auth',
  'permission',
  'not_found',
  'conflict',
  'validation',
]);

// Only a target the transport refused before any socket proves that the
// write never left (ADR 0072).
const notSent = (error: unknown): boolean =>
  error instanceof HttpTransportError && error.category === 'refused';

const asError = (error: unknown): EccliumError =>
  isEccliumError(error) ? error : new EccliumError('internal');
