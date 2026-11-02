/**
 * The policy engine (ADR 0032): decides from the checked policy whether a
 * write may go ahead, goes to the queue of approvals or is refused.
 *
 * Where it stands in the way of a write: the write guard asks it twice,
 * when it plans, after it read the target, and when it commits, after it
 * read the target again. Each time in two steps, both pure functions
 * without any read or write of their own:
 *
 * 1. {@link matchPolicy} finds the entry of the interactive part that
 *    covers the tool and the target, and says which names the guard has
 *    to read and which counter of the day counts the write.
 * 2. {@link judgeMatch} compares the names the guard read with the ones
 *    the operator expects and the counter with the limit of the entry.
 *
 * Why it is split: everything that reads ChurchTools or the store of
 * quotas stays in the write guard, so that the rules here can be tested
 * on their own, also with generated inputs.
 *
 * What it decides: an operation of the escape hatch always goes to the
 * queue. Without entries, everything the account may goes ahead except
 * writes to groups and services, which go to the queue. With entries the
 * list is final: a target without an entry, a name that changed or a
 * limit reached goes to the queue, not to a refusal, so that the person
 * stays able to act. Until the runner uses the unattended part, the policy
 * refuses every write outside the interactive mode.
 *
 * @packageDocumentation
 */
import {
  type Mode,
  writeQuotaKey,
  type WriteQuotaKey,
  type WriteTargetKind,
} from '@ecclium/mcp-churchtools-plugin-api';

import { targetKeyOf } from './check.js';
import type { InteractiveEntry, InteractiveTarget, Policy } from './schema.js';

/** Why a write goes to the queue instead of ahead. */
export type PolicyQueueReason =
  /** An operation of the escape hatch, or a group or service without entry. */
  | 'queue_only'
  /** The interactive part has entries, but none for this tool and target. */
  | 'no_entry'
  /** A name in ChurchTools is not the one the operator expects. */
  | 'name_changed'
  /** The limit of the entry for the day is reached. */
  | 'limit_reached'
  /** The counter of the day could not be read or written. */
  | 'count_unavailable';

/** Every {@link PolicyQueueReason}, frozen. */
export const policyQueueReasons: readonly PolicyQueueReason[] = Object.freeze([
  'queue_only',
  'no_entry',
  'name_changed',
  'limit_reached',
  'count_unavailable',
]);

/** What a write asks of the policy: who, how, which tool, which target. */
export interface PolicyRequest {
  /** The mode of the call. */
  readonly mode: Mode;
  /** The name of the tool that plans. */
  readonly tool: string;
  /**
   * The target as the core derives it from the intent, such as
   * `{ kind: 'wiki_page', key: '12/<GUID>' }` with the GUID in lower case.
   */
  readonly target: { readonly kind: WriteTargetKind; readonly key: string };
  /** Whether the kind of write always goes to the queue. */
  readonly alwaysQueue: boolean;
}

/**
 * A name the write guard has to read and compare: of which object, and
 * the name the operator expects, in NFC.
 */
export interface ExpectedName {
  /** Whose name: a category or page of the wiki, or another target. */
  readonly of:
    | { readonly kind: 'wiki_category'; readonly id: number }
    | {
        readonly kind: 'wiki_page';
        readonly categoryId: number;
        readonly guid: string;
      }
    | {
        readonly kind: 'calendar' | 'resource' | 'group' | 'event';
        readonly id: number;
      }
    | {
        readonly kind: 'service';
        readonly eventId: number;
        readonly id: number;
      };
  /** The name the operator expects. */
  readonly name: string;
}

/** What {@link matchPolicy} finds. */
export type PolicyMatch =
  /** No entries and a target that needs none: no limit, no counter. */
  | { readonly kind: 'allow' }
  /** An entry covers the write; its names and counter decide. */
  | {
      readonly kind: 'entry';
      readonly entry: InteractiveEntry;
      /** The names to read and compare, in the order of the target. */
      readonly names: readonly ExpectedName[];
      /** The counter of the day of this tool on the target of the entry. */
      readonly counter: WriteQuotaKey;
      readonly maxPerDay: number;
    }
  | { readonly kind: 'queue'; readonly reason: PolicyQueueReason }
  /** Outside the interactive mode, until the runner uses the policy. */
  | { readonly kind: 'deny'; readonly reason: 'not_interactive' };

/** How a write ends with the policy. */
export type PolicyVerdict =
  | { readonly kind: 'allow' }
  | { readonly kind: 'queue'; readonly reason: PolicyQueueReason }
  | { readonly kind: 'deny'; readonly reason: 'not_interactive' };

const allow = Object.freeze({ kind: 'allow' } as const);
const queue = (reason: PolicyQueueReason) =>
  Object.freeze({ kind: 'queue', reason } as const);
const notInteractive = Object.freeze({
  kind: 'deny',
  reason: 'not_interactive',
} as const);

// The parts of the key of a target of the core, as whole numbers, and the
// GUID of a page as it stands.
const idsOf = (key: string): readonly string[] => key.split('/');

// Whether an entry covers a target of a write: the same object, or for a
// page its category, for an appointment its calendar.
const covers = (
  entry: InteractiveTarget,
  target: PolicyRequest['target'],
): 'exact' | 'container' | undefined => {
  const [first = '', second = ''] = idsOf(target.key);
  switch (entry.kind) {
    case 'wiki_category':
      if (target.kind === 'wiki_category' && String(entry.id) === first) {
        return 'exact';
      }
      return target.kind === 'wiki_page' && String(entry.id) === first
        ? 'container'
        : undefined;
    case 'wiki_page':
      return target.kind === 'wiki_page' &&
        String(entry.categoryId) === first &&
        entry.guid === second
        ? 'exact'
        : undefined;
    case 'calendar':
      if (target.kind === 'calendar' && String(entry.id) === first) {
        return 'exact';
      }
      return target.kind === 'appointment' && String(entry.id) === first
        ? 'container'
        : undefined;
    case 'resource':
    case 'group':
      return target.kind === entry.kind && String(entry.id) === first
        ? 'exact'
        : undefined;
    case 'service':
      return target.kind === 'service' &&
        String(entry.event.id) === first &&
        String(entry.service.id) === second
        ? 'exact'
        : undefined;
  }
};

// The names an entry expects, in the order of its target.
const namesOf = (target: InteractiveTarget): readonly ExpectedName[] => {
  switch (target.kind) {
    case 'wiki_category':
      return [
        { of: { kind: 'wiki_category', id: target.id }, name: target.name },
      ];
    case 'wiki_page':
      return [
        {
          of: {
            kind: 'wiki_page',
            categoryId: target.categoryId,
            guid: target.guid,
          },
          name: target.name,
        },
      ];
    case 'service':
      return [
        { of: { kind: 'event', id: target.event.id }, name: target.event.name },
        {
          of: {
            kind: 'service',
            eventId: target.event.id,
            id: target.service.id,
          },
          name: target.service.name,
        },
      ];
    default:
      return [{ of: { kind: target.kind, id: target.id }, name: target.name }];
  }
};

/**
 * Finds what the policy says about a write before any name or counter is
 * read. An entry for a page replaces the entry of its category for that
 * page, so its tools and its limit count, not those of the category.
 *
 * @param policy - The checked policy.
 * @param request - Mode, tool and target of the write.
 * @returns The entry with the names and counter to check, or the end.
 * @example
 * ```ts
 * matchPolicy(defaultPolicy, { mode: 'interactive', tool, target, alwaysQueue: false });
 * // { kind: 'allow' } for a page of the wiki
 * ```
 */
export function matchPolicy(
  policy: Policy,
  request: PolicyRequest,
): PolicyMatch {
  if (request.mode !== 'interactive') return notInteractive;
  if (request.alwaysQueue) return queue('queue_only');
  const { targets } = policy.interactive;
  if (targets.length === 0) {
    // Writes to groups and services concern persons and need an entry
    // (ADR 0071).
    return request.target.kind === 'group' || request.target.kind === 'service'
      ? queue('queue_only')
      : allow;
  }
  const covering = targets.flatMap((entry) => {
    const how = covers(entry.target, request.target);
    return how === undefined ? [] : [{ entry, how }];
  });
  const exact = covering.filter((item) => item.how === 'exact');
  // The most specific entries alone: those of the page, else those of its
  // category.
  const candidates = exact.length > 0 ? exact : covering;
  // The check of the policy allows one entry per target and tool.
  const found = candidates.find((item) =>
    item.entry.tools.includes(request.tool),
  );
  if (found === undefined) return queue('no_entry');
  return Object.freeze({
    kind: 'entry',
    entry: found.entry,
    names: Object.freeze(namesOf(found.entry.target)),
    counter: writeQuotaKey(request.tool, targetKeyOf(found.entry.target)),
    maxPerDay: found.entry.maxPerDay,
  });
}

/** What the write guard read for a match of an entry. */
export interface PolicyFacts {
  /**
   * The names it read, in the order of `names` of the match, undefined
   * for a name it could not find.
   */
  readonly names: readonly (string | undefined)[];
  /**
   * The counter of the day: before the write when planning, after adding
   * this write when committing; undefined when it could not be read.
   */
  readonly count: number | undefined;
  /** Whether the count already holds this write. */
  readonly counted: boolean;
}

/**
 * Judges a match with what the write guard read. The names are compared
 * in the normal form NFC, exactly. When planning, a counter that already
 * stands at the limit sends the write to the queue, so that nobody
 * confirms in vain; when committing, the counter holds this write and may
 * reach the limit but not pass it.
 *
 * @param match - What {@link matchPolicy} found.
 * @param facts - The names and the counter the guard read, for an entry.
 * @returns Whether the write goes ahead, to the queue or is refused.
 * @example
 * ```ts
 * judgeMatch(match, { names: ['Berichte'], count: 3, counted: false });
 * ```
 */
export function judgeMatch(
  match: PolicyMatch,
  facts: PolicyFacts,
): PolicyVerdict {
  if (match.kind !== 'entry') return match;
  const changed = match.names.some(
    (expected, index) =>
      facts.names[index]?.normalize('NFC') !== expected.name.normalize('NFC'),
  );
  if (changed) return queue('name_changed');
  const { count } = facts;
  if (count === undefined || !Number.isSafeInteger(count) || count < 0) {
    return queue('count_unavailable');
  }
  const over = facts.counted
    ? count > match.maxPerDay
    : count >= match.maxPerDay;
  return over ? queue('limit_reached') : allow;
}
