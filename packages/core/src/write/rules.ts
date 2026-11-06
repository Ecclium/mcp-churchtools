/**
 * The rules of each kind of write, derived by the core (ADR 0029,
 * ADR 0071).
 *
 * Where it stands in the way of a write: right after the intent is read,
 * planning takes from here what the intent targets, which rights it needs,
 * how sensitive it is, whether it may run without a person, whether it can
 * be undone, what keeps it from taking effect twice and which ways of
 * confirmation it allows. The metadata of a tool do not decide any of
 * this. They can only make sensitivity and the rule for running unattended
 * stricter, so that a plugin can tighten the rules of the core but never
 * loosen them.
 *
 * The four writes of the Pro module have their rules here as well: always
 * special, never unattended, never by echo, guarded by a nonce, and an
 * operation of the escape hatch always goes to the queue. The core does
 * not run them yet; their plans are refused until the tools that need
 * them exist. A booking request runs, but never by echo, because
 * ChurchTools mails it to the managers of the resource at once (F48).
 *
 * @packageDocumentation
 */
import type {
  ObjectKind,
  ReplayGuard,
  Reversible,
  RightRef,
  Sensitivity,
  UnattendedRule,
  WriteIntent,
  WriteTargetKind,
} from '@ecclium/mcp-churchtools-plugin-api';

/** What a write changes, as the policy and the audit name it. */
export type TargetKind = WriteTargetKind;

/**
 * The target of a write: its kind and a key from the IDs of the intent,
 * such as `12` for a category or `12/<GUID>` for a page in it. A GUID
 * stands in lower case in the key, so that one page has one key however
 * the intent writes it; the request keeps the GUID as given.
 */
export interface WriteTarget {
  readonly kind: TargetKind;
  readonly key: string;
}

/** Who brings the tool that plans: the core or a plugin (ADR 0024). */
export type ToolOrigin = 'core' | 'plugin';

/** The rules the core derives from an intent. */
export interface IntentRules {
  /** What the write changes. */
  readonly target: WriteTarget;
  /**
   * Rights the account needs, checked before planning as advice; the
   * scope of each is the target. Named for the writes the core runs;
   * the others get theirs with their tools.
   */
  readonly requiredRights: readonly RightRef[];
  /** How sensitive the write is. */
  readonly sensitivity: Sensitivity;
  /** Whether it may run without a person. */
  readonly unattended: UnattendedRule;
  /** Whether and how it can be undone. */
  readonly reversible: Reversible;
  /** What keeps it from taking effect twice. */
  readonly replayGuard: ReplayGuard;
  /** Whether it is a write of the core or of the Pro module. */
  readonly module: 'core' | 'pro';
  /** Whether it always goes to the queue of approvals. */
  readonly alwaysQueue: boolean;
  /**
   * Whether ChurchTools tells people outside the client of it at once,
   * such as the managers of a resource by mail (F48), or may do so. Taking
   * the write back does not take that back, so it is never confirmed by
   * echo (ADR 0029).
   */
  readonly notifies: boolean;
  /** Whether this version of the core runs it. */
  readonly runs: boolean;
}

const editWikiCategory: readonly RightRef[] = Object.freeze([
  Object.freeze({ module: 'churchwiki', right: 'edit category' }),
]);
// The rights the write account had for appointments and bookings (F45,
// the finding on the rights for writing appointments and bookings).
const editCalendar: readonly RightRef[] = Object.freeze([
  Object.freeze({ module: 'churchcal', right: 'edit category' }),
  Object.freeze({ module: 'churchcal', right: 'view category' }),
]);
const createBookings: readonly RightRef[] = Object.freeze([
  Object.freeze({ module: 'churchresource', right: 'create bookings' }),
  Object.freeze({ module: 'churchresource', right: 'view resource' }),
]);
const noRights: readonly RightRef[] = Object.freeze([]);

// The rules every write of the core shares: personal like the tools that
// read wiki and bookings, allowed unattended by a policy, undone from a
// snapshot (ADR 0029, Rücknahme).
const core = {
  sensitivity: 'personal',
  unattended: 'policy',
  reversible: 'snapshot',
  module: 'core',
  alwaysQueue: false,
  notifies: false,
} as const;

// The rules of the writes of the Pro module (ADR 0071).
const pro = {
  requiredRights: noRights,
  sensitivity: 'special',
  unattended: 'never',
  reversible: 'no',
  replayGuard: 'nonce',
  module: 'pro',
  notifies: false,
  runs: false,
} as const;

const target = (kind: TargetKind, ...ids: readonly (number | string)[]) =>
  Object.freeze({ kind, key: ids.map(String).join('/') });

/**
 * Derives the rules of an intent that `readIntent` checked.
 *
 * @param intent - The checked copy of the intent.
 * @returns The rules, frozen.
 * @example
 * ```ts
 * rulesOf({ kind: 'wikiPageUpdate', categoryId: 12, guid, text, baseVersion: 3 });
 * // { target: { kind: 'wiki_page', key: '12/<guid>' }, replayGuard: 'baseVersion', … }
 * ```
 */
export function rulesOf(intent: WriteIntent): IntentRules {
  switch (intent.kind) {
    case 'wikiPageCreate':
      return Object.freeze({
        ...core,
        target: target('wiki_category', intent.categoryId),
        requiredRights: editWikiCategory,
        replayGuard: 'marker',
        runs: true,
      });
    case 'wikiPageUpdate':
      return Object.freeze({
        ...core,
        target: target(
          'wiki_page',
          intent.categoryId,
          intent.guid.toLowerCase(),
        ),
        requiredRights: editWikiCategory,
        replayGuard: 'baseVersion',
        runs: true,
      });
    case 'wikiSectionAppend':
      return Object.freeze({
        ...core,
        target: target(
          'wiki_page',
          intent.categoryId,
          intent.guid.toLowerCase(),
        ),
        requiredRights: editWikiCategory,
        replayGuard: 'marker',
        runs: true,
      });
    case 'appointmentCreate':
      return Object.freeze({
        ...core,
        target: target('calendar', intent.calendarId),
        requiredRights: editCalendar,
        replayGuard: 'nonce',
        runs: true,
      });
    case 'appointmentUpdate':
      return Object.freeze({
        ...core,
        target: target('appointment', intent.calendarId, intent.appointmentId),
        requiredRights: editCalendar,
        replayGuard: 'baseVersion',
        // ChurchTools can mail the person who created an appointment of a
        // change; whether it does without being asked is not probed
        // (ADR 0029).
        notifies: true,
        runs: true,
      });
    case 'bookingCreate':
      return Object.freeze({
        ...core,
        target: target('resource', intent.resourceId),
        requiredRights: createBookings,
        replayGuard: 'nonce',
        notifies: true,
        runs: true,
      });
    case 'groupMemberAdd':
    case 'groupMemberRemove':
      return Object.freeze({
        ...pro,
        target: target('group', intent.groupId),
        alwaysQueue: false,
      });
    case 'serviceRequest':
      return Object.freeze({
        ...pro,
        target: target('service', intent.eventId, intent.serviceId),
        alwaysQueue: false,
      });
    case 'apiOperation':
      return Object.freeze({
        ...pro,
        target: target('operation', intent.operationId),
        alwaysQueue: true,
      });
  }
}

/**
 * The IDs a target names for the audit (ADR 0028): a category, and a page
 * of it by its GUID; a calendar, and an appointment in it; a resource, and
 * a booking of it. Groups, services and operations come with the writes of
 * the Pro module and name none yet.
 *
 * @param target - The target of a write.
 * @returns The kinds and IDs, in the order of the key.
 * @example
 * ```ts
 * objectRefsOfTarget({ kind: 'booking', key: '13/51' });
 * // [['resource', '13'], ['booking', '51']]
 * ```
 */
export function objectRefsOfTarget(
  target: WriteTarget,
): readonly (readonly [ObjectKind, string])[] {
  const [first = '', second = ''] = target.key.split('/');
  switch (target.kind) {
    case 'wiki_category':
    case 'calendar':
    case 'resource':
      return [[target.kind, first]];
    case 'wiki_page':
      return [
        ['wiki_category', first],
        ['wiki_page', second],
      ];
    case 'appointment':
      return [
        ['calendar', first],
        ['appointment', second],
      ];
    case 'booking':
      return [
        ['resource', first],
        ['booking', second],
      ];
    default:
      return [];
  }
}

const sensitivityRank: Readonly<Record<Sensitivity, number>> = Object.freeze({
  none: 0,
  personal: 1,
  special: 2,
});

/**
 * Applies the metadata of the tool that plans: of sensitivity and of the
 * rule for running unattended the stricter one counts, and special always
 * means never unattended. A tool that says its write cannot be taken back
 * makes it so, which takes the echo away; one cannot make a write
 * reversible that the intent does not (ADR 0029). Nothing else of the
 * metadata counts.
 *
 * @param rules - The rules derived from the intent.
 * @param meta - Sensitivity and unattended rule of the tool.
 * @param meta.sensitivity - The sensitivity the tool declares.
 * @param meta.unattended - The rule for running unattended it declares.
 * @param meta.reversible - Whether it declares its write can be taken back.
 * @returns The rules with the stricter values, frozen.
 * @example
 * ```ts
 * withToolMeta(rulesOf(intent), { sensitivity: 'special', unattended: 'policy' });
 * // sensitivity 'special', unattended 'never'
 * ```
 */
export function withToolMeta(
  rules: IntentRules,
  meta: {
    readonly sensitivity: Sensitivity;
    readonly unattended: UnattendedRule;
    readonly reversible?: Reversible;
  },
): IntentRules {
  const sensitivity =
    sensitivityRank[meta.sensitivity] > sensitivityRank[rules.sensitivity]
      ? meta.sensitivity
      : rules.sensitivity;
  const unattended =
    sensitivity === 'special' ||
    rules.unattended === 'never' ||
    meta.unattended === 'never'
      ? 'never'
      : 'policy';
  const reversible: Reversible =
    meta.reversible === 'no' ? 'no' : rules.reversible;
  return Object.freeze({ ...rules, sensitivity, unattended, reversible });
}

/**
 * Tells whether a plan may be confirmed by echo: only for a tool of the
 * core, only for a write of the core that is undone from a snapshot, is
 * not special, does not have to go to the queue and tells no one outside
 * the client of it (ADR 0029). A tool cannot switch it on.
 *
 * @param rules - The rules after {@link withToolMeta}.
 * @param origin - Who brings the tool, as the catalog records it.
 * @returns Whether the echo is allowed.
 * @example
 * ```ts
 * echoAllowed(rulesOf(intent), 'plugin'); // false
 * ```
 */
export function echoAllowed(rules: IntentRules, origin: ToolOrigin): boolean {
  return (
    origin === 'core' &&
    rules.module === 'core' &&
    rules.reversible === 'snapshot' &&
    rules.sensitivity !== 'special' &&
    !rules.alwaysQueue &&
    !rules.notifies
  );
}
