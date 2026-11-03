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
 * page before Ecclium wrote.
 *
 * The policy of ADR 0032 checks the plan after the read of the target and
 * again on the commit right before the send, where it adds the write to
 * its counter of the day (`policy-gate.ts`). The content policy of ADR 0030
 * checks every text of the intent first, before the rights and before any
 * read, and the plan is sealed with the texts in their written form
 * (`content-gate.ts`).
 *
 * @packageDocumentation
 */
import {
  type Clock,
  type ConfirmationPath,
  type IsoDate,
  EccliumError,
  type ErrorCode,
  isEccliumError,
  type Permissions,
  type PlanOutcome,
  type QuotaStore,
  type RightRef,
  type Sensitivity,
  type TenantContext,
  type UnattendedRule,
  type WikiPage,
  type WriteIntent,
} from '@ecclium/mcp-churchtools-plugin-api';

import type { ChurchToolsWrites } from '../churchtools/wiki-writes.js';
import { contactKeysOf } from '../content/index.js';
import { HttpTransportError } from '../http/index.js';
import type { Policy } from '../policy/schema.js';
import { readIntent } from './intent.js';
import { checkIntentContent, ContentRefusal } from './content-gate.js';
import {
  type ConfirmationText,
  confirmationTextOf,
} from './confirmation-text.js';
import { checkKillSwitches } from './kill-switch.js';
import { contentHashOf } from './plan-hash.js';
import { isoDateOf } from '../quota/budget.js';
import type { LoadedSnapshot } from '../snapshots/keeper.js';
import type { SnapshotToSeal } from '../snapshots/seal.js';
import { createPolicyGate, type WriteFacts } from './policy-gate.js';
import { issueProof, useProof } from './proof.js';
import {
  type IntentRules,
  rulesOf,
  type ToolOrigin,
  withToolMeta,
  type WriteTarget,
} from './rules.js';
import { type PlanView, readPlan, sealPlan } from './sealed-plan.js';
import { serverTimeFits } from './server-clock.js';
import { isAsLeft, type SnapshotToUndo, undoTargetOf } from './undo.js';

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
  noSnapshot:
    'The server could not save the state before the write, so nothing was written. Ask the operator.',
} as const);

/** What the client gives the write guard: the rights and the writes. */
export interface WriteClient {
  /** The rights of the account, for the advice before planning. */
  readonly permissions: (ctx: TenantContext) => Promise<Permissions>;
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

/** The text of the page now and the text the undo writes, for a diff. */
export interface UndoChange {
  readonly from: string;
  readonly to: string;
}

/** How an undo ended. */
export type UndoResult =
  /** The page holds what the undo would write already. */
  | { readonly kind: 'unchanged'; readonly target: WriteTarget }
  /** Someone changed the page since the write; nothing was written. */
  | {
      readonly kind: 'changed';
      readonly target: WriteTarget;
      readonly change: UndoChange;
    }
  /** A new page whose GUID was never kept: only its category is known. */
  | { readonly kind: 'incomplete'; readonly target: WriteTarget }
  /** Refused or failed before a plan: nothing was written. */
  | { readonly kind: 'refused'; readonly error: EccliumError }
  /** Planned and committed, with how the commit ended. */
  | {
      readonly kind: 'committed';
      readonly target: WriteTarget;
      readonly result: CommitResult;
      readonly change: UndoChange;
    };

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
  };
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
   * Takes back a write from its snapshot, for the operator (ADR 0031).
   *
   * @param request - Context, ID of the undo, snapshot and whether to
   *   write over a changed page.
   * @returns How the undo ended; it never rejects.
   */
  undo(request: UndoRequest): Promise<UndoResult>;
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
 * Builds the new text of a page from its text and a section: the text
 * without spaces at its end, an empty line, the section without spaces at
 * its end and one line break. ChurchTools stores the text exactly (F17),
 * so the read after the write compares byte by byte.
 *
 * @param text - The text of the page.
 * @param section - The section to add.
 * @returns The new text.
 * @example
 * ```ts
 * appendSection('# Plan\n', '## Nachtrag'); // '# Plan\n\n## Nachtrag\n'
 * ```
 */
export function appendSection(text: string, section: string): string {
  const head = text.trimEnd();
  const tail = `${section.trimEnd()}\n`;
  return head === '' ? tail : `${head}\n\n${tail}`;
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
    };

/** Where the snapshot of a write was kept: its event and its day. */
interface Undo {
  readonly eventId: string;
  readonly day: IsoDate;
}

/** The writes this version of the core runs: those of the wiki. */
type WikiIntent = Extract<WriteIntent, { categoryId: number }>;

/** The writes that change a page that exists. */
type PageIntent = Extract<WriteIntent, { guid: string }>;

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
 * block after a failed line of the audit, which lives as long as the
 * pipeline and is no state at module level.
 *
 * @param options - Client, clock, folder of the kill switches, policy and
 *   store of quotas.
 * @returns The write guard, frozen.
 * @example
 * ```ts
 * const guard = createWriteGuard({ client, clock, killSwitchDir, policy, quota });
 * const outcome = await guard.plan({ ctx, tool, origin, meta }, intent);
 * ```
 */
export function createWriteGuard(options: WriteGuardOptions): WriteGuard {
  const { client, clock, killSwitchDir, snapshots } = options;
  // Whether a plan can be taken back from a snapshot (ADR 0031).
  const reversible = snapshots !== undefined;
  // The contact values a text may hold, from the interactive part of the
  // policy (ADR 0030).
  const contacts = contactKeysOf(options.policy.interactive.contacts ?? []);
  let blocked = false;
  const policy = createPolicyGate({
    policy: options.policy,
    quota: options.quota,
    clock,
    categoryName: (ctx, categoryId) =>
      client.writes.wikiCategoryName(ctx, categoryId),
  });
  // What the policy needs of a write beyond its rules: the title of a page
  // it changes, as read right before.
  const factsOf = (derived: Derived): WriteFacts =>
    derived.kind === 'change' ? { pageTitle: derived.before.title } : {};

  // Writing off for this tenant, read-only, or blocked after a failed line
  // of the audit: checked before every plan and right before every commit.
  const stopped = (ctx: TenantContext): EccliumError | undefined => {
    if (blocked) return refuse('policy_denied', writeSentences.blocked);
    if (ctx.readOnly) return refuse('policy_denied', writeSentences.readOnly);
    const state =
      killSwitchDir === undefined
        ? 'unknown'
        : checkKillSwitches(killSwitchDir, ctx.tenantId);
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
    intent: WikiIntent,
    rules: IntentRules,
  ): Promise<void> => {
    const permissions = await client.permissions(ctx);
    if (permissions.kind === 'unknown') {
      ctx.log.warn('write_refused', { code: 'policy_denied' });
      throw refuse('policy_denied', writeSentences.rightsUnknown);
    }
    const missing = rules.requiredRights.filter(({ module, right }) => {
      const value = permissions.granted[module]?.[right];
      return !(
        value === true ||
        (Array.isArray(value) && value.includes(intent.categoryId))
      );
    });
    if (missing.length > 0) {
      throw refuse('permission', writeSentences.missingRight, missing);
    }
  };

  // Reads what a plan of a write of the wiki rests on.
  const derive = async (
    ctx: TenantContext,
    intent: WikiIntent,
  ): Promise<Derived> => {
    if (intent.kind === 'wikiPageCreate') {
      if (isBlank(intent.text)) {
        throw refuse('validation', writeSentences.blank);
      }
      const { serverTime } = await client.writes.wikiCategoryState(
        ctx,
        intent.categoryId,
      );
      return {
        kind: 'create',
        contentHash: contentHashOf([intent.title, intent.text]),
        serverTime,
        title: intent.title,
        text: intent.text,
      };
    }
    const added =
      intent.kind === 'wikiPageUpdate' ? intent.text : intent.section;
    if (isBlank(added)) throw refuse('validation', writeSentences.blank);
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
    const text =
      intent.kind === 'wikiPageUpdate'
        ? intent.text
        : appendSection(page.text, intent.section);
    return {
      kind: 'change',
      contentHash: contentHashOf([text]),
      serverTime,
      before: page,
      text,
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
    const { ctx } = request;
    const stop = stopped(ctx);
    if (stop !== undefined) throw stop;
    const intent = readIntent(value);
    if (intent === undefined) throw refuse('validation', writeSentences.intent);
    const rules = withToolMeta(rulesOf(intent), request.meta);
    if (!rules.runs) {
      ctx.log.warn('write_refused', { code: 'policy_denied' });
      throw refuse('policy_denied', writeSentences.notRun);
    }
    // Only the writes of the wiki run in this version (rules.ts). Their
    // texts go through the content policy before anything else, and from
    // here on the intent holds them in their written form (ADR 0030).
    const wiki = checkIntentContent(ctx, intent as WikiIntent, contacts);
    await checkRights(ctx, wiki, rules);
    const derived = await derive(ctx, wiki);
    // The policy, with the counter of the day only read (ADR 0032).
    await policy.check(ctx, request.tool, rules, factsOf(derived), 'plan');
    if (derived.kind === 'change' && derived.text === derived.before.text) {
      return Object.freeze({
        outcome: Object.freeze({ kind: 'skipped', reason: 'unchanged' }),
        target: rules.target,
      });
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
      snapshots: reversible,
    });
    return Object.freeze({
      outcome: Object.freeze({ kind: 'planned', plan: sealed }),
      target: rules.target,
      text: textOf(wiki, derived),
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
    const stop = stopped(ctx);
    if (stop !== undefined) return denied(stop, target);
    return commitPlan(ctx, view, proof, eventId, false);
  };

  // An undo of the operator skips the policy, which judges what the model
  // asks for, and adds nothing to its counters (ADR 0031).
  const commitPlan = async (
    ctx: TenantContext,
    view: PlanView,
    proof: unknown,
    eventId: string | undefined,
    operator: boolean,
  ): Promise<CommitResult> => {
    // A plan is sealed only for an intent the core runs (sealed-plan.ts).
    const intent = view.intent as WikiIntent;
    const target = view.rules.target;
    // The read right before the write: the plan derived again from the
    // state of the target, with the time of ChurchTools.
    let derived: Derived;
    try {
      derived = await derive(ctx, intent);
    } catch (error) {
      useProof(proof, view, clock.now());
      return denied(
        isEccliumError(error) && error.code === 'conflict'
          ? refuse('conflict', writeSentences.changedSincePlan)
          : asError(error),
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
        },
        contentHash: derived.contentHash,
        sealedAt: clock.now(),
        snapshots: reversible,
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
    const stopNow = stopped(ctx);
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
      if (!operator) {
        await policy.check(
          ctx,
          view.tool,
          view.rules,
          factsOf(derived),
          'commit',
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
    const stopLate = stopped(ctx);
    if (stopLate !== undefined) return denied(stopLate, target, path);
    // The state before the write, kept before the one send: a snapshot
    // that cannot be kept stops the write, so that every write the core
    // sends with snapshots on can be taken back (ADR 0031).
    let undo: Undo | undefined;
    if (snapshots !== undefined) {
      const day = isoDateOf(now);
      const content: SnapshotToSeal['content'] =
        derived.kind === 'create'
          ? {
              kind: 'wikiPageCreate',
              tool: view.tool,
              categoryId: intent.categoryId,
              title: (intent as Extract<WikiIntent, { kind: 'wikiPageCreate' }>)
                .title,
              textHash: contentHashOf([
                (intent as Extract<WikiIntent, { kind: 'wikiPageCreate' }>)
                  .text,
              ]),
            }
          : {
              kind: 'wikiPageText',
              tool: view.tool,
              categoryId: intent.categoryId,
              guid: (intent as PageIntent).guid,
              before: {
                version: derived.before.version,
                text: derived.before.text,
              },
              after: {
                version: derived.before.version + 1,
                textHash: contentHashOf([derived.text]),
              },
            };
      try {
        if (eventId === undefined || day === undefined) {
          throw new TypeError('No event or no day.');
        }
        await snapshots.save(ctx, { eventId, part: 'before', day, content });
        undo = { eventId, day };
      } catch {
        ctx.log.warn('snapshot_failed', { code: 'internal' });
        return ended(
          ctx,
          'failed',
          refuse('internal', writeSentences.noSnapshot),
          false,
          target,
          path,
        );
      }
    }
    return derived.kind === 'create'
      ? create(
          ctx,
          intent as Extract<WikiIntent, { kind: 'wikiPageCreate' }>,
          path,
          undo,
        )
      : change(ctx, intent as PageIntent, derived, target, path, undo);
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

  // Creates a page. Without its GUID the core cannot read it back after a
  // failure, so an answer it did not get leaves the outcome unknown.
  const create = async (
    ctx: TenantContext,
    intent: Extract<WriteIntent, { kind: 'wikiPageCreate' }>,
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
        intent.text,
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
      if (after.page.version === 1 && after.page.text === intent.text) {
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
    const { ctx, eventId, snapshot, overwrite } = request;
    const stop = stopped(ctx);
    if (stop !== undefined) throw stop;
    const found = undoTargetOf(snapshot);
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
      true,
    );
    return Object.freeze({ kind: 'committed', target, result, change });
  };

  return Object.freeze({
    plan,
    commit,
    undo,
    block: (): void => {
      blocked = true;
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
