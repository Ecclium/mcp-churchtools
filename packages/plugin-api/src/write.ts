/**
 * The contract of a write (ADR 0029): what a tool may plan, what it gets
 * back, and the two ports that keep plans and nonces between the rounds of
 * a confirmation.
 *
 * Where it stands in the way of a write: a tool that writes never writes
 * itself. It describes an intent, one of the kinds of writes the core
 * knows and runs itself, and hands it to `plan`. The core checks it, reads
 * the target and seals a plan, which it then gets confirmed and commits
 * with a proof that only the core makes. A plugin plans the same intents
 * as the tools of the core and nothing else; target, rights, whether the
 * write can be undone and what keeps it from taking effect twice follow
 * from the intent, never from what the tool says (ADR 0071).
 *
 * @packageDocumentation
 */
import type { TenantContext } from './context.js';

/** Creates a Markdown page in a category of the wiki. */
export interface WikiPageCreateIntent {
  readonly kind: 'wikiPageCreate';
  /** The category, a whole number from 1. */
  readonly categoryId: number;
  /** The title, unique in the category. */
  readonly title: string;
  /** The text of the page in Markdown. */
  readonly text: string;
}

/** Replaces the text of a Markdown page of the wiki. */
export interface WikiPageUpdateIntent {
  readonly kind: 'wikiPageUpdate';
  /** The category of the page. */
  readonly categoryId: number;
  /** The GUID of the page. */
  readonly guid: string;
  /** The new text of the page in Markdown. */
  readonly text: string;
  /**
   * The version of the page the new text is based on, as a read returned
   * it. A page with another version ends the write in a conflict.
   */
  readonly baseVersion: number;
}

/** Adds a section at the end of a Markdown page of the wiki. */
export interface WikiSectionAppendIntent {
  readonly kind: 'wikiSectionAppend';
  /** The category of the page. */
  readonly categoryId: number;
  /** The GUID of the page. */
  readonly guid: string;
  /** The section in Markdown, added after the text of the page. */
  readonly section: string;
  /** The version of the page the section is based on. */
  readonly baseVersion: number;
}

/**
 * Creates a single appointment in a calendar, without an event and without
 * a series. The core does not run it yet; it comes with the tools for
 * appointments.
 */
export interface AppointmentCreateIntent {
  readonly kind: 'appointmentCreate';
  /** The calendar. */
  readonly calendarId: number;
  /** The title of the appointment. */
  readonly title: string;
  /** The start, as a date or a date and time. */
  readonly startDate: string;
  /** The end, as a date or a date and time. */
  readonly endDate: string;
  /** A description, if any. */
  readonly description?: string;
}

/**
 * Changes a single appointment. ChurchTools replaces an appointment as a
 * whole (F41), so the core sends every field it read and the ones given
 * here. Not run yet, like {@link AppointmentCreateIntent}.
 */
export interface AppointmentUpdateIntent {
  readonly kind: 'appointmentUpdate';
  /** The calendar of the appointment. */
  readonly calendarId: number;
  /** The appointment. */
  readonly appointmentId: number;
  /** The version of the appointment the change is based on (F42). */
  readonly baseVersion: number;
  /** The new title. */
  readonly title: string;
  /** The new start. */
  readonly startDate: string;
  /** The new end. */
  readonly endDate: string;
  /** The new description, if any. */
  readonly description?: string;
}

/**
 * Requests a booking of a resource. A booking is only ever requested; the
 * managers of the resource approve it in ChurchTools (F45). Not run yet,
 * like {@link AppointmentCreateIntent}.
 */
export interface BookingCreateIntent {
  readonly kind: 'bookingCreate';
  /** The resource. */
  readonly resourceId: number;
  /** The title of the booking. */
  readonly title: string;
  /** The start, as a date and time. */
  readonly startDate: string;
  /** The end, as a date and time. */
  readonly endDate: string;
  /** A description, if any. It reaches the managers by mail (F48). */
  readonly description?: string;
}

/**
 * Adds a person to a group. An intent of the Pro module: always special,
 * never unattended, never by echo. The core runs it from phase 9 on at the
 * earliest; until then every plan of it is refused.
 */
export interface GroupMemberAddIntent {
  readonly kind: 'groupMemberAdd';
  /** The group. */
  readonly groupId: number;
  /** The person. */
  readonly personId: number;
}

/** Removes a person from a group. As {@link GroupMemberAddIntent}. */
export interface GroupMemberRemoveIntent {
  readonly kind: 'groupMemberRemove';
  /** The group. */
  readonly groupId: number;
  /** The person. */
  readonly personId: number;
}

/**
 * Asks a person to take a service of an event. As
 * {@link GroupMemberAddIntent}.
 */
export interface ServiceRequestIntent {
  readonly kind: 'serviceRequest';
  /** The event. */
  readonly eventId: number;
  /** The service of the event. */
  readonly serviceId: number;
  /** The person asked. */
  readonly personId: number;
}

/**
 * A write of the escape hatch by the ID of an operation. As
 * {@link GroupMemberAddIntent}, and it always goes to the operator's queue
 * of approvals.
 */
export interface ApiOperationIntent {
  readonly kind: 'apiOperation';
  /** The ID of the operation. */
  readonly operationId: string;
  /** The values of the parameters of the path, by name. */
  readonly path?: Readonly<Record<string, number | string>>;
  /** The body as JSON text, if the operation takes one. */
  readonly body?: string;
}

/**
 * Every kind of write the core knows. The first six are the writes of the
 * core, the last four those of the Pro module, whose rules live in the
 * core as well (ADR 0071).
 */
export type WriteIntent =
  | WikiPageCreateIntent
  | WikiPageUpdateIntent
  | WikiSectionAppendIntent
  | AppointmentCreateIntent
  | AppointmentUpdateIntent
  | BookingCreateIntent
  | GroupMemberAddIntent
  | GroupMemberRemoveIntent
  | ServiceRequestIntent
  | ApiOperationIntent;

/** The kind of a {@link WriteIntent}. */
export type WriteIntentKind = WriteIntent['kind'];

/** Every {@link WriteIntentKind}, frozen, for checks at run time. */
export const writeIntentKinds: readonly WriteIntentKind[] = Object.freeze([
  'wikiPageCreate',
  'wikiPageUpdate',
  'wikiSectionAppend',
  'appointmentCreate',
  'appointmentUpdate',
  'bookingCreate',
  'groupMemberAdd',
  'groupMemberRemove',
  'serviceRequest',
  'apiOperation',
]);

/**
 * A plan the core sealed. A tool can hand it on but cannot read, change or
 * make one: the core checks at run time that it made the value itself.
 * The brand exists in the types only, so that every copy of this package
 * agrees on it.
 */
export interface PlannedWrite {
  readonly __ecclium: 'PlannedWrite';
}

/**
 * Why a plan changes nothing: the target already holds what the intent
 * would write, or an earlier write with the same marker exists.
 */
export type SkipReason = 'unchanged' | 'already_written';

/**
 * What `plan` gives back. A refused plan does not come back as a value:
 * `plan` rejects with an `EccliumError` and a fixed sentence.
 */
export type PlanOutcome =
  | { readonly kind: 'planned'; readonly plan: PlannedWrite }
  | { readonly kind: 'skipped'; readonly reason: SkipReason };

/**
 * How a tool that writes plans. Only a tool with `capability: 'write'`
 * gets one, and only for the call it was given for.
 */
export interface WritePort {
  /**
   * Checks an intent and seals a plan for it: rights, policy, idempotency,
   * and a read of the target. It never writes. A tool calls it once per
   * call and returns what it gives back; the core then gets the plan
   * confirmed and commits it.
   *
   * @param intent - What to write.
   * @returns The sealed plan, or why nothing needs to be written.
   * @throws {EccliumError} `policy_denied` when writing is off or the
   *   intent is not allowed, `permission` with the missing rights,
   *   `conflict` when the target changed since the tool read it,
   *   `validation` for an intent of the wrong form, and the codes of a
   *   failed read.
   */
  plan(intent: WriteIntent): Promise<PlanOutcome>;
}

/**
 * Keeps sealed plans between planning and committing, for the second round
 * of a confirmation (ADR 0029). Plans carry content, so the store of the
 * free core keeps them in memory only. Each plan is bound to the tenant
 * and the actor of the context and can be taken once.
 */
export interface PlanStore {
  /**
   * Keeps a plan for a time.
   *
   * @param ctx - The context of the call, for tenant and actor.
   * @param planHash - The hash of the plan, the key to take it by.
   * @param plan - The sealed plan, which the store keeps as it is.
   * @param ttlMs - How long the plan may be taken, in milliseconds.
   * @returns `stored`, or `full` when the store holds as many plans as it
   *   may; the plan is then not kept, and no older plan is dropped for it.
   * @throws {TypeError} For a time that is no whole number from 1 or longer
   *   than a plan may live, and when the store cannot tell the time. A
   *   caller treats a rejection as a plan that was not kept.
   */
  put(
    ctx: TenantContext,
    planHash: string,
    plan: PlannedWrite,
    ttlMs: number,
  ): Promise<'stored' | 'full'>;
  /**
   * Takes a plan out of the store, once.
   *
   * @param ctx - The context of the call, for tenant and actor.
   * @param planHash - The hash of the plan.
   * @returns The plan, or undefined when there is none for this tenant
   *   and actor, it expired or it was taken before.
   * @throws {TypeError} When the store cannot tell the time. A caller
   *   treats a rejection as no plan.
   */
  take(ctx: TenantContext, planHash: string): Promise<PlannedWrite | undefined>;
}

/**
 * Remembers the nonces that were used, so that a token of a confirmation
 * counts only once (ADR 0029). Only random values, no content. Each nonce
 * is bound to the tenant and the actor of the context.
 */
export interface NonceStore {
  /**
   * Uses a nonce.
   *
   * @param ctx - The context of the call, for tenant and actor.
   * @param nonce - The nonce.
   * @param ttlMs - How long the store must remember it, in milliseconds.
   * @returns `fresh` the first time, `replayed` every later time and when
   *   the store is full; a full store forgets no nonce before its time.
   * @throws {TypeError} For an empty nonce, a time that is no whole number
   *   from 1 or longer than a token lives, and when the store cannot tell
   *   the time. A caller treats a rejection as a nonce that was used.
   */
  consume(
    ctx: TenantContext,
    nonce: string,
    ttlMs: number,
  ): Promise<'fresh' | 'replayed'>;
}
