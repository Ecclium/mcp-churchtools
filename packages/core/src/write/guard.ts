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
 * The policy of ADR 0032 and the content policy of ADR 0030 check the plan
 * here once they are built, between the rights and the seal.
 *
 * @packageDocumentation
 */
import {
  type Clock,
  type ConfirmationPath,
  EccliumError,
  type ErrorCode,
  isEccliumError,
  type Permissions,
  type PlanOutcome,
  type RightRef,
  type Sensitivity,
  type TenantContext,
  type UnattendedRule,
  type WikiPage,
  type WriteIntent,
} from '@ecclium/mcp-churchtools-plugin-api';

import type { ChurchToolsWrites } from '../churchtools/wiki-writes.js';
import { HttpTransportError } from '../http/index.js';
import { readIntent } from './intent.js';
import { checkKillSwitches } from './kill-switch.js';
import { contentHashOf } from './plan-hash.js';
import { useProof } from './proof.js';
import {
  type IntentRules,
  rulesOf,
  type ToolOrigin,
  withToolMeta,
  type WriteTarget,
} from './rules.js';
import { type PlanView, readPlan, sealPlan } from './sealed-plan.js';
import { serverTimeFits } from './server-clock.js';

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
  };
}

/** What planning gives the pipeline: the outcome for the tool and the target. */
export interface PlanResult {
  /** What the tool gets back from `plan`. */
  readonly outcome: PlanOutcome;
  /** What the write would change, for the result and the audit. */
  readonly target: WriteTarget;
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
   */
  plan(request: PlanRequest, intent: unknown): Promise<PlanResult>;
  /**
   * Commits a sealed plan with a proof.
   *
   * @param ctx - The context of the call that commits.
   * @param plan - The plan the tool returned.
   * @param proof - The proof of the confirmation.
   * @returns How the commit ended; it never rejects.
   */
  commit(
    ctx: TenantContext,
    plan: unknown,
    proof: unknown,
  ): Promise<CommitResult>;
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

/** The writes this version of the core runs: those of the wiki. */
type WikiIntent = Extract<WriteIntent, { categoryId: number }>;

/** The writes that change a page that exists. */
type PageIntent = Extract<WriteIntent, { guid: string }>;

/**
 * Makes the write guard of one pipeline. It holds one piece of state, the
 * block after a failed line of the audit, which lives as long as the
 * pipeline and is no state at module level.
 *
 * @param options - Client, clock and folder of the kill switches.
 * @returns The write guard, frozen.
 * @example
 * ```ts
 * const guard = createWriteGuard({ client, clock, killSwitchDir });
 * const outcome = await guard.plan({ ctx, tool, origin, meta }, intent);
 * ```
 */
export function createWriteGuard(options: WriteGuardOptions): WriteGuard {
  const { client, clock, killSwitchDir } = options;
  let blocked = false;

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

  // Rejects only with an EccliumError: any other error of a read becomes
  // internal, so that the pipeline passes on a fixed sentence.
  const plan = async (
    request: PlanRequest,
    value: unknown,
  ): Promise<PlanResult> => {
    try {
      return await planOnce(request, value);
    } catch (error) {
      throw asError(error);
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
    // Only the writes of the wiki run in this version (rules.ts).
    const wiki = intent as WikiIntent;
    await checkRights(ctx, wiki, rules);
    const derived = await derive(ctx, wiki);
    // The policy of ADR 0032 and the content policy of ADR 0030 check the
    // plan here once they are built.
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
      intent,
      toolMeta: request.meta,
      contentHash: derived.contentHash,
      sealedAt: clock.now(),
    });
    return Object.freeze({
      outcome: Object.freeze({ kind: 'planned', plan: sealed }),
      target: rules.target,
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
    return commitPlan(ctx, view, proof);
  };

  const commitPlan = async (
    ctx: TenantContext,
    view: PlanView,
    proof: unknown,
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
    if (!serverTimeFits(now, derived.serverTime)) {
      ctx.log.warn('write_refused', { code: 'policy_denied' });
      return denied(
        refuse('policy_denied', writeSentences.clock),
        target,
        path,
      );
    }
    return derived.kind === 'create'
      ? create(
          ctx,
          intent as Extract<WikiIntent, { kind: 'wikiPageCreate' }>,
          path,
        )
      : change(ctx, intent as PageIntent, derived, target, path);
  };

  // Creates a page. Without its GUID the core cannot read it back after a
  // failure, so an answer it did not get leaves the outcome unknown.
  const create = async (
    ctx: TenantContext,
    intent: Extract<WriteIntent, { kind: 'wikiPageCreate' }>,
    path: ConfirmationPath,
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
        return verified(ctx, path, page, 1);
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
      return verified(ctx, path, target, after.version);
    }
    if (failure !== undefined && after.version === base) {
      return ended(
        ctx,
        'failed',
        refuse(asError(failure).code, writeSentences.notSent),
        false,
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
  ): CommitResult => {
    ctx.log.info('write_committed');
    return Object.freeze({
      ok: true,
      state: 'verified',
      path,
      target,
      version,
    });
  };

  return Object.freeze({
    plan,
    commit,
    block: (): void => {
      blocked = true;
    },
  });
}

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
