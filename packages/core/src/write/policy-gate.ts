/**
 * The policy in the write guard (ADR 0032): asks the policy engine about a
 * write and reads what it needs for its answer.
 *
 * Where it stands in the way of a write:
 *
 * - **Planning:** after the guard read the target and before it seals the
 *   plan. It reads the names the policy expects and the counter of the
 *   day without changing it, so that a write at its limit goes to the
 *   queue of approvals before anybody confirms it in vain. A write the
 *   policy sends there is sealed all the same, and the gate gives the
 *   reason, which the pipeline keeps with the entry (ADR 0031).
 * - **Committing:** after the proof, the kill switches and the clock,
 *   right before the send. It reads the names again, since the target may
 *   have been renamed in between, and adds the write to the counter of the
 *   day. Only a write that fits under the limit with it goes on. A write
 *   counted here that fails afterwards stays counted. A write the policy
 *   would send to the queue only now ends with `policy_denied` and a fixed
 *   sentence: the person confirmed a write within the policy, and their
 *   yes is no approval of the operator.
 * - **Approving:** when the operator approves an entry of the queue with
 *   `ecclium queue approve`, right before the send. The approval stands in
 *   for every reason the policy sends a write to the queue for, so no
 *   name is read and no limit stops the write, but a write to a target of
 *   an entry still counts against its limit of the day (ADR 0029). The
 *   wish is judged in its own mode: a write a run queued against the
 *   entries of its routine in the unattended part, any other in the
 *   interactive mode.
 *
 * A write of a run of a routine is judged in the mode `unattended` against
 * the entries of its routine only, with the counter of the writes of the
 * run besides the one of the day (ADR 0032). Each reason for the queue has
 * one log line. Any other write outside the interactive mode is refused.
 *
 * @packageDocumentation
 */
import {
  type Clock,
  EccliumError,
  type QuotaStore,
  type TenantContext,
  type WriteQuotaKey,
} from '@ecclium/mcp-churchtools-plugin-api';

import {
  type ExpectedName,
  judgeMatch,
  matchPolicy,
  type PolicyQueueReason,
} from '../policy/engine.js';
import type { Policy } from '../policy/schema.js';
import { isoDateOf, quotaTimeoutMs } from '../quota/budget.js';
import type { IntentRules } from './rules.js';
import { addRunWrite, runWriteCount, type RunWrites } from './run-writes.js';

/**
 * The sentences the model reads when the policy stops a write. None of
 * them names the policy's entries or a name it expected.
 */
export const policySentences = Object.freeze({
  notInteractive:
    'This server writes only when a person confirms it in a conversation.',
  outside:
    'This write is outside what the policy of this server allows, so nothing was written. Ask the operator.',
  nameChanged:
    'The target in ChurchTools does not have the name the policy of this server expects, so nothing was written. Ask the operator.',
  limitReached:
    'The limit of writes of this tool to this target is reached, for today or for this run of a routine. The limit of a day resets at 00:00 UTC.',
  countUnavailable:
    'The server cannot count this write against the limit of its policy now, so nothing was written. Ask the operator to check the folder of state.',
} as const);

const sentenceOf: Readonly<Record<PolicyQueueReason, string>> = Object.freeze({
  queue_only: policySentences.outside,
  no_entry: policySentences.outside,
  name_changed: policySentences.nameChanged,
  limit_reached: policySentences.limitReached,
  count_unavailable: policySentences.countUnavailable,
});

// One log line per reason, written out so that the catalog of the log
// lines finds each one.
const eventOf = Object.freeze({
  queue_only: 'policy_queue_only',
  no_entry: 'policy_no_entry',
  name_changed: 'policy_name_changed',
  limit_reached: 'policy_limit_reached',
  count_unavailable: 'policy_count_unavailable',
} as const);

/** What the policy needs to know of a write besides its rules. */
export interface WriteFacts {
  /** The title of the page the write changes, as read right before. */
  readonly pageTitle?: string;
}

/** What the gate of the policy is built from. */
export interface PolicyGateOptions {
  /** The checked policy of the server. */
  readonly policy: Policy;
  /**
   * The store of the counters of the day, or undefined without a folder
   * of state: then a write that an entry limits cannot be counted.
   */
  readonly quota: QuotaStore | undefined;
  /** The clock of the process, for the UTC day of a counter. */
  readonly clock: Clock;
  /** Reads the name of a category of the wiki. */
  readonly categoryName: (
    ctx: TenantContext,
    categoryId: number,
  ) => Promise<string | undefined>;
  /** Reads the name of a calendar. */
  readonly calendarName: (
    ctx: TenantContext,
    calendarId: number,
  ) => Promise<string | undefined>;
  /** Reads the name of a resource. */
  readonly resourceName: (
    ctx: TenantContext,
    resourceId: number,
  ) => Promise<string | undefined>;
}

/** The policy in the write guard. */
export interface PolicyGate {
  /**
   * Asks the policy about a write.
   *
   * @param ctx - The context of the call.
   * @param tool - The name of the tool that planned the write.
   * @param rules - The rules the core derived for the write.
   * @param facts - What the guard read of the target.
   * @param phase - Whether the guard plans, commits, or commits an
   *   approval of the operator.
   * @returns Nothing when the write may go on, and when planning the
   *   reason why it goes to the queue of approvals.
   * @throws {EccliumError} `policy_denied` with a fixed sentence when the
   *   policy refuses the write, or when committing sends it to the queue,
   *   and any error of a read of a name.
   */
  check(
    ctx: TenantContext,
    tool: string,
    rules: IntentRules,
    facts: WriteFacts,
    phase: 'plan' | 'commit' | 'approve',
    run?: GateRun,
  ): Promise<PolicyQueueReason | undefined>;
}

/**
 * The run of a routine a write comes from: its routine, whose entries of
 * the unattended part decide, and the counter of its writes, which an
 * approval of an entry of the queue does not have.
 */
export interface GateRun {
  readonly routine: string;
  readonly runWrites?: RunWrites;
}

/**
 * Makes the gate of the policy for one write guard.
 *
 * @param options - Policy, store of quotas, clock and the read of a name.
 * @returns The gate, frozen.
 * @example
 * ```ts
 * const gate = createPolicyGate({ policy, quota, clock, categoryName });
 * await gate.check(ctx, 'ct_wiki_page_create', rules, {}, 'plan');
 * ```
 */
export function createPolicyGate(options: PolicyGateOptions): PolicyGate {
  const { policy, quota, clock } = options;

  // The name of a target as ChurchTools has it now. Groups and services
  // come with the writes of the Pro module, and until then no name means no
  // write.
  const nameOf = (
    ctx: TenantContext,
    expected: ExpectedName,
    facts: WriteFacts,
  ): Promise<string | undefined> => {
    switch (expected.of.kind) {
      case 'wiki_category':
        return options.categoryName(ctx, expected.of.id);
      case 'wiki_page':
        return Promise.resolve(facts.pageTitle);
      case 'calendar':
        return options.calendarName(ctx, expected.of.id);
      case 'resource':
        return options.resourceName(ctx, expected.of.id);
      default:
        return Promise.resolve(undefined);
    }
  };

  // The counter of the day: read when planning, raised when committing. A
  // store that is missing, fails or takes too long gives no count.
  const countOf = async (
    ctx: TenantContext,
    key: WriteQuotaKey,
    phase: 'plan' | 'commit',
  ): Promise<number | undefined> => {
    const day = isoDateOf(clock.now());
    if (quota === undefined || day === undefined) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const counting = Promise.resolve().then(() =>
      phase === 'plan'
        ? quota.read(ctx, key, day)
        : quota.increment(ctx, key, day),
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
      return typeof counted === 'number' ? counted : undefined;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };

  const check = async (
    ctx: TenantContext,
    tool: string,
    rules: IntentRules,
    facts: WriteFacts,
    phase: 'plan' | 'commit' | 'approve',
    run?: GateRun,
  ): Promise<PolicyQueueReason | undefined> => {
    const match = matchPolicy(policy, {
      // An approval judges the wish, not the command of the operator: a
      // write a run queued against the entries of its routine, any other
      // in the interactive mode, the only one that queues besides a run.
      mode:
        phase === 'approve'
          ? run === undefined
            ? 'interactive'
            : 'unattended'
          : ctx.mode,
      tool,
      target: rules.target,
      alwaysQueue: rules.alwaysQueue,
      ...(run === undefined ? {} : { routine: run.routine }),
    });
    if (match.kind === 'allow') return undefined;
    if (match.kind === 'deny') {
      ctx.log.warn('policy_not_interactive');
      throw new EccliumError('policy_denied', policySentences.notInteractive);
    }
    // The approval of the operator stands in for the queue; a write to a
    // target of an entry takes its place in the counter all the same, and
    // a count that fails is said, not held against the write (ADR 0029).
    if (phase === 'approve') {
      if (
        match.kind === 'entry' &&
        (await countOf(ctx, match.counter, 'commit')) === undefined
      ) {
        ctx.log.warn(eventOf.count_unavailable);
      }
      return undefined;
    }
    // When planning, the write goes to the queue with its reason; when
    // committing, the reason ends it (ADR 0031).
    const refuse = (reason: PolicyQueueReason): PolicyQueueReason => {
      ctx.log.warn(eventOf[reason]);
      if (phase === 'plan') return reason;
      throw new EccliumError('policy_denied', sentenceOf[reason]);
    };
    if (match.kind === 'queue') return refuse(match.reason);
    const names = await Promise.all(
      match.names.map((expected) => nameOf(ctx, expected, facts)),
    );
    // The names first, with counts that cannot reach a limit, so that a
    // write to a renamed target costs no place of the day or of the run.
    let verdict = judgeMatch(match, {
      names,
      count: 0,
      counted: true,
      runCount: 0,
    });
    // Then the writes of the run, which only the counter in memory of the
    // run holds, before the counter of the day, so that a write beyond the
    // limit of its run costs no place of the day (ADR 0032).
    let runCount: number | undefined;
    if (verdict.kind === 'allow' && match.maxPerRun !== undefined) {
      runCount =
        phase === 'commit'
          ? addRunWrite(run?.runWrites, match.counter)
          : runWriteCount(run?.runWrites, match.counter);
      verdict = judgeMatch(match, {
        names,
        count: 0,
        counted: phase === 'commit',
        ...(runCount === undefined ? {} : { runCount }),
      });
    }
    if (verdict.kind === 'allow') {
      verdict = judgeMatch(match, {
        names,
        count: await countOf(ctx, match.counter, phase),
        counted: phase === 'commit',
        ...(runCount === undefined ? {} : { runCount }),
      });
    }
    if (verdict.kind === 'allow') return undefined;
    // A verdict on an entry is allow or queue; deny ended above.
    return refuse((verdict as { readonly reason: PolicyQueueReason }).reason);
  };

  return Object.freeze({ check });
}
