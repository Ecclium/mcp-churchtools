/**
 * The writes of appointments and bookings in the write guard (ADR 0029,
 * ADR 0072): what a plan of one rests on, and its one send.
 *
 * Where it stands in the way of a write: the write guard asks this module
 * twice, when a tool plans and right before the commit, and both times it
 * reads ChurchTools anew. It checks the fields as the client would send
 * them, reads the target, gives the hash of what would be written, the
 * text a person confirms and what the snapshot keeps, and the send that
 * the guard runs once the proof fits. The guard keeps everything that is
 * the same for every write: switches, rights, policy, proof, clock,
 * snapshot and audit.
 *
 * - **A new appointment** is a single one, for everyone who sees the
 *   calendar. The appointments of the calendar on the days around it are
 *   read first: one with the same title, start and end means the write is
 *   done already (ADR 0029, decided on 05.11.2026).
 * - **A change** reads the appointment with what is linked to it. One
 *   whose version is not the one the tool read, or that has a series, an
 *   address, a link, an image, a group for sign-ups, a person on whose
 *   behalf it was entered or a linked event, booking or invitation, is
 *   not changed (ADR 0029, F41). Start and end move only for an
 *   appointment the account of the server created, since what is linked
 *   follows a new time and the account sees it only where it may
 *   (ADR 0029, F44).
 * - **The day lists** end at 50 entries. A plan on days with more is
 *   refused, since the entry that makes the write done already could be
 *   one the list leaves out.
 * - **A booking** is always a request (F45). A request with the same
 *   title and time is done already; the person who confirms learns how
 *   many other bookings the resource has at that time and that
 *   ChurchTools mails title and description to its managers (F48).
 * - **An undo** of the operator (ADR 0031) reads the target right before
 *   its one send as well: a change goes back to the fields from before
 *   under the rules of every change, and a new appointment or booking is
 *   deleted only as the write left it. No plan is sealed for it, since no
 *   intent deletes and none empties a description.
 *
 * @packageDocumentation
 */
import {
  type ErrorCode,
  EccliumError,
  isEccliumError,
  type IsoDate,
  maxEventDays,
  type SkipReason,
  type TenantContext,
  type WriteIntent,
} from '@ecclium/mcp-churchtools-plugin-api';

import {
  type AppointmentState,
  type BookingState,
  type CalendarWrites,
  type DatedFields,
  fitsDatedFields,
  type StoredAppointment,
  type StoredBooking,
} from '../churchtools/calendar-writes.js';
import { HttpTransportError } from '../http/index.js';
import type { DatedCreatedSnapshot, SnapshotState } from '../snapshots/seal.js';
import { isMidnightIn, spanTextOf, timeTextOf } from './calendar-time.js';
import {
  type ConfirmationText,
  datedConfirmationTextOf,
} from './confirmation-text.js';
import { contentHashOf } from './plan-hash.js';
import type { WriteTarget } from './rules.js';
import type { CalendarUndoTarget } from './undo.js';

/** The writes of calendars and resources. */
export type CalendarIntent = Extract<
  WriteIntent,
  { kind: 'appointmentCreate' | 'appointmentUpdate' | 'bookingCreate' }
>;

/**
 * Whether an intent writes an appointment or a booking.
 *
 * @param intent - A checked intent.
 * @returns Whether this module plans it.
 * @example
 * ```ts
 * isCalendarIntent({ kind: 'bookingCreate', resourceId: 13, title, startDate, endDate }); // true
 * ```
 */
export const isCalendarIntent = (
  intent: WriteIntent,
): intent is CalendarIntent =>
  intent.kind === 'appointmentCreate' ||
  intent.kind === 'appointmentUpdate' ||
  intent.kind === 'bookingCreate';

/**
 * The most characters of a description a tool gives: a person reads it
 * whole before confirming, and ChurchTools mails that of a booking request
 * to the managers of the resource (F48). Decided on 05.11.2026; a longer
 * description an appointment has already stays as it is.
 */
const maxGivenDescription = 2000;

/**
 * The sentences the model reads when a write of an appointment or a
 * booking does not happen as planned, part of the sentences of the write
 * guard.
 */
export const calendarSentences = Object.freeze({
  calendarRight:
    'The account of the server may not change appointments in this calendar.',
  resourceRight:
    'The account of the server may not request bookings of this resource.',
  datedFields: `A title has 1 to 255 characters on one line, a description at most ${String(maxGivenDescription)} characters and more than spaces, and start and end are existing times in UTC on the full minute as YYYY-MM-DDTHH:MM:00Z with the end after the start.`,
  datedSpan: `An appointment or a booking this server writes lasts at most ${String(maxEventDays - 3)} days.`,
  appointmentChanged:
    'The appointment changed since it was read. Read it again and plan the change on its current version.',
  appointmentParts:
    'This appointment has parts this server does not change, such as a series, an address, a link, an image, a group for sign-ups or a linked event, booking or invitation. Change it in ChurchTools.',
  wholeDays:
    'This server writes no appointment or booking of whole days, nor one that starts and ends at midnight. Write it in ChurchTools.',
  notOwnTime:
    'This server moves only appointments its own account created. Change the time of this one in ChurchTools.',
  dayListFull:
    'The calendar or the resource has too many entries on the days around this time to rule out that the write is done already. Write it in ChurchTools.',
  bookingGone:
    'The booking cannot be read, and the list of its days no longer names it: someone deleted or moved it. Check it in ChurchTools.',
} as const);

/** How the one send of a write of an appointment or a booking ended. */
export type SendOutcome =
  /** Written and read back as planned. */
  | {
      readonly kind: 'verified';
      readonly target: WriteTarget;
      readonly version: number;
    }
  /** The transport refused it before any socket: nothing was sent. */
  | {
      readonly kind: 'notSent';
      readonly code: ErrorCode;
      readonly target: WriteTarget;
    }
  /** ChurchTools answered and refused it: nothing was written. */
  | {
      readonly kind: 'refused';
      readonly error: EccliumError;
      readonly target: WriteTarget;
    }
  /** It may have reached ChurchTools, and no read tells. */
  | {
      readonly kind: 'unknown';
      readonly code: ErrorCode;
      readonly target: WriteTarget;
    }
  /** It reached ChurchTools, but the target does not read back as planned. */
  | { readonly kind: 'notAsPlanned'; readonly target: WriteTarget };

/** What a plan of a write of an appointment or a booking rests on. */
export interface CalendarPlan {
  /** The hash of everything the write sends. */
  readonly contentHash: string;
  /** The time of ChurchTools of the read, null without one. */
  readonly serverTime: number | null;
  /** Why nothing needs to be written, if so. */
  readonly skip?: SkipReason;
  /** What a person sees to confirm the write. */
  readonly text: ConfirmationText;
  /** The fields now and after the write as lines, for the operator. */
  readonly change: { readonly from: string; readonly to: string };
  /** What the snapshot keeps before the send (ADR 0031). */
  readonly before: SnapshotState;
  /**
   * Sends the write once and reads it back.
   *
   * @param saveCreated - Keeps the ID of a new appointment or booking in
   *   the snapshot as soon as ChurchTools named it.
   * @returns How it ended; it never rejects.
   */
  readonly send: (
    saveCreated: (created: DatedCreatedSnapshot) => Promise<void>,
  ) => Promise<SendOutcome>;
}

/** What the plans of appointments and bookings are made from. */
export interface CalendarPlanOptions {
  /** The writes of the client for calendars and resources. */
  readonly writes: CalendarWrites;
  /** Reads the account of the server, for the creator of an appointment. */
  readonly whoami: (ctx: TenantContext) => Promise<{ readonly id: number }>;
  /** The zone the texts show times in, undefined for UTC. */
  readonly timeZone: string | undefined;
}

// Codes with which ChurchTools answered and refused a write: nothing was
// written (ADR 0072).
const definite: readonly ErrorCode[] = Object.freeze([
  'auth',
  'permission',
  'not_found',
  'conflict',
  'validation',
]);

const codeOf = (error: unknown): ErrorCode =>
  isEccliumError(error) ? error.code : 'internal';

// How a failed send ended: only a target the transport refused before any
// socket proves that nothing left, only a refusal of ChurchTools that
// nothing was written.
const failureOf = (error: unknown, target: WriteTarget): SendOutcome => {
  if (error instanceof HttpTransportError && error.category === 'refused') {
    return { kind: 'notSent', code: codeOf(error), target };
  }
  if (isEccliumError(error) && definite.includes(error.code)) {
    return { kind: 'refused', error, target };
  }
  return { kind: 'unknown', code: codeOf(error), target };
};

const targetOf = (
  kind: WriteTarget['kind'],
  ...ids: readonly number[]
): WriteTarget => Object.freeze({ kind, key: ids.map(String).join('/') });

const refuse = (code: ErrorCode, message: string): EccliumError =>
  new EccliumError(code, message);

// The UTC day of a time and the day some days away from it.
const dayOf = (date: string): IsoDate => date.slice(0, 10) as IsoDate;
const shiftDay = (day: IsoDate, days: number): IsoDate =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10) as IsoDate;

// The days the lists are read for: one before the start and one after the
// end, since the lists count days in the zone of the installation. A span
// the lists do not take is refused, for a change as well, so that every
// write this server makes is one it could have checked for a repeat.
const daysAround = (
  fields: Pick<DatedFields, 'startDate' | 'endDate'>,
): { readonly from: IsoDate; readonly to: IsoDate } => {
  const from = shiftDay(dayOf(fields.startDate), -1);
  const to = shiftDay(dayOf(fields.endDate), 1);
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
  if (days > maxEventDays) {
    throw refuse('validation', calendarSentences.datedSpan);
  }
  return { from, to };
};

// A time on the full minute: the texts a person confirms show minutes,
// so a second they do not show is never written.
const onTheMinute = (date: string): boolean => date.endsWith(':00Z');

// The fields as the client sends them, checked before anything is read,
// with the description the tool gave, if any.
const checked = (
  fields: DatedFields,
  given: string | undefined,
): DatedFields => {
  if (
    !fitsDatedFields(fields) ||
    !onTheMinute(fields.startDate) ||
    !onTheMinute(fields.endDate) ||
    (given !== undefined && given.length > maxGivenDescription)
  ) {
    throw refuse('validation', calendarSentences.datedFields);
  }
  return fields;
};

// Start and end both on midnight in the zone the operator names would make
// ChurchTools store whole days, which no probe has shown; such times are
// refused before anything is read. The zone of the installation is not
// known, so without a zone the read back is the only check.
const timed = (
  fields: Pick<DatedFields, 'startDate' | 'endDate'>,
  zone: string | undefined,
): void => {
  if (
    zone !== undefined &&
    isMidnightIn(fields.startDate, zone) &&
    isMidnightIn(fields.endDate, zone)
  ) {
    throw refuse('policy_denied', calendarSentences.wholeDays);
  }
};

// A day list that ends before its last entry cannot show that a write is
// done already.
const complete = (more: boolean): void => {
  if (more) throw refuse('policy_denied', calendarSentences.dayListFull);
};

/** The fields of an appointment as a change writes them. */
interface AppointmentFields extends DatedFields {
  readonly subtitle: string | null;
  readonly isInternal: boolean;
}

// The fields as lines a person reads: title, start, end and description,
// each line of the description on its own line.
const linesOf = (fields: DatedFields, zone: string | undefined): string => {
  const lines = [
    `Titel: ${fields.title}`,
    `Beginn: ${timeTextOf(fields.startDate, zone)}`,
    `Ende: ${timeTextOf(fields.endDate, zone)}`,
  ];
  if (fields.description !== null) {
    lines.push(
      ...fields.description
        .split('\n')
        .map((line, index) =>
          index === 0 ? `Beschreibung: ${line}` : `  ${line}`,
        ),
    );
  }
  return `${lines.join('\n')}\n`;
};

const hashOf = (fields: DatedFields): string =>
  contentHashOf([
    fields.title,
    fields.description ?? '',
    fields.startDate,
    fields.endDate,
  ]);

const sameFields = (
  stored: {
    readonly title: string;
    readonly description: string | null;
    readonly startDate: string;
    readonly endDate: string;
  },
  fields: DatedFields,
): boolean =>
  stored.title === fields.title &&
  stored.description === fields.description &&
  stored.startDate === fields.startDate &&
  stored.endDate === fields.endDate;

// The German names of the fields a change changes.
const changedOf = (
  before: DatedFields,
  after: DatedFields,
): readonly string[] => [
  ...(before.title === after.title ? [] : ['Titel']),
  ...(before.startDate === after.startDate ? [] : ['Beginn']),
  ...(before.endDate === after.endDate ? [] : ['Ende']),
  ...(before.description === after.description ? [] : ['Beschreibung']),
];

const planAppointmentCreate = async (
  options: CalendarPlanOptions,
  ctx: TenantContext,
  intent: Extract<CalendarIntent, { kind: 'appointmentCreate' }>,
  tool: string,
): Promise<CalendarPlan> => {
  const { writes, timeZone } = options;
  const fields = checked(
    {
      title: intent.title,
      description: intent.description ?? null,
      startDate: intent.startDate,
      endDate: intent.endDate,
    },
    intent.description,
  );
  timed(fields, timeZone);
  const { from, to } = daysAround(fields);
  const { appointments, serverTime } = await writes.calendarDayState(
    ctx,
    intent.calendarId,
    from,
    to,
  );
  complete(appointments.more);
  const facts = await writes.calendarFacts(ctx, intent.calendarId);
  const done = appointments.appointments.some(
    (entry) =>
      entry.title === fields.title &&
      entry.startDate === fields.startDate &&
      entry.endDate === fields.endDate,
  );
  const contentHash = hashOf(fields);
  const after = linesOf(fields, timeZone);
  const calendar = targetOf('calendar', intent.calendarId);
  return Object.freeze({
    contentHash,
    serverTime,
    ...(done ? { skip: 'already_written' as const } : {}),
    text: datedConfirmationTextOf({
      kind: 'appointmentCreate',
      place: {
        id: intent.calendarId,
        ...(facts === undefined ? {} : { name: facts.name }),
      },
      title: fields.title,
      span: spanTextOf(fields.startDate, fields.endDate, timeZone),
      before: '',
      after,
      changed: [],
      ...(facts === undefined ? {} : { isPublic: facts.isPublic }),
    }),
    change: Object.freeze({ from: '', to: after }),
    before: Object.freeze({
      kind: 'appointmentCreate',
      tool,
      placeId: intent.calendarId,
      fieldsHash: contentHash,
    }),
    send: async (
      saveCreated: (created: DatedCreatedSnapshot) => Promise<void>,
    ): Promise<SendOutcome> => {
      let created: StoredAppointment;
      try {
        created = await writes.createAppointment(
          ctx,
          intent.calendarId,
          fields,
        );
      } catch (error) {
        return failureOf(error, calendar);
      }
      const target = targetOf('appointment', intent.calendarId, created.id);
      await saveCreated(
        Object.freeze({
          kind: 'appointmentCreated',
          id: created.id,
          version: created.version,
        }),
      );
      // A new appointment has version 0 (F42) and the fields sent, and
      // ChurchTools did not take it as one of whole days.
      const fits = (appointment: StoredAppointment): boolean =>
        appointment.version === 0 &&
        !appointment.allDay &&
        sameFields(appointment, fields);
      if (!fits(created)) return { kind: 'notAsPlanned', target };
      try {
        const { appointment } = await writes.appointmentState(
          ctx,
          intent.calendarId,
          created.id,
        );
        if (fits(appointment)) {
          return { kind: 'verified', target, version: 0 };
        }
      } catch (error) {
        return { kind: 'unknown', code: codeOf(error), target };
      }
      return { kind: 'notAsPlanned', target };
    },
  });
};

const planAppointmentUpdate = async (
  options: CalendarPlanOptions,
  ctx: TenantContext,
  intent: Extract<CalendarIntent, { kind: 'appointmentUpdate' }>,
  tool: string,
): Promise<CalendarPlan> => {
  const { writes, timeZone } = options;
  // Title and times first, before anything is read.
  daysAround(
    checked(
      {
        title: intent.title,
        description: intent.description ?? null,
        startDate: intent.startDate,
        endDate: intent.endDate,
      },
      intent.description,
    ),
  );
  timed(intent, timeZone);
  const { calendarId, appointmentId } = intent;
  const { appointment: now, serverTime } = await writes.appointmentState(
    ctx,
    calendarId,
    appointmentId,
  );
  if (now.version !== intent.baseVersion) {
    throw refuse('conflict', calendarSentences.appointmentChanged);
  }
  if (now.parts.length > 0) {
    throw refuse('policy_denied', calendarSentences.appointmentParts);
  }
  if (now.allDay) throw refuse('policy_denied', calendarSentences.wholeDays);
  // A missing description keeps the one the appointment has.
  const fields: AppointmentFields = Object.freeze({
    title: intent.title,
    description: intent.description ?? now.description,
    startDate: intent.startDate,
    endDate: intent.endDate,
    subtitle: now.subtitle,
    isInternal: now.isInternal,
  });
  checked(fields, undefined);
  const moves =
    fields.startDate !== now.startDate || fields.endDate !== now.endDate;
  if (moves) {
    const account = await options.whoami(ctx);
    if (now.createdBy === null || now.createdBy !== account.id) {
      throw refuse('policy_denied', calendarSentences.notOwnTime);
    }
  }
  const facts = await writes.calendarFacts(ctx, calendarId);
  const contentHash = changeHashOf(fields);
  const before = linesOf(now, timeZone);
  const after = linesOf(fields, timeZone);
  const base = now.version;
  return Object.freeze({
    contentHash,
    serverTime,
    ...(sameFields(now, fields) ? { skip: 'unchanged' as const } : {}),
    text: datedConfirmationTextOf({
      kind: 'appointmentUpdate',
      place: {
        id: calendarId,
        ...(facts === undefined ? {} : { name: facts.name }),
      },
      title: now.title,
      span: spanTextOf(fields.startDate, fields.endDate, timeZone),
      before,
      after,
      changed: changedOf(now, fields),
      // An internal appointment stays one, seen only by those signed in.
      ...(facts === undefined
        ? {}
        : { isPublic: facts.isPublic && !now.isInternal }),
    }),
    change: Object.freeze({ from: before, to: after }),
    before: Object.freeze({
      kind: 'appointmentFields',
      tool,
      calendarId,
      appointmentId,
      before: Object.freeze({
        version: base,
        title: now.title,
        subtitle: now.subtitle,
        description: now.description,
        startDate: now.startDate,
        endDate: now.endDate,
        isInternal: now.isInternal,
      }),
      after: Object.freeze({ version: base + 1, fieldsHash: contentHash }),
    }),
    send: () => sendChange(writes, ctx, intent, base, fields),
  });
};

// The hash of the fields a change of an appointment writes, which the
// snapshot keeps as what the change left.
const changeHashOf = (fields: AppointmentFields): string =>
  contentHashOf([
    fields.title,
    fields.description ?? '',
    fields.startDate,
    fields.endDate,
    fields.subtitle ?? '',
    String(fields.isInternal),
  ]);

// Replaces the fields of an appointment once and reads it back: the
// version rose by exactly one, and the fields are those sent.
const sendChange = async (
  writes: CalendarWrites,
  ctx: TenantContext,
  ids: { readonly calendarId: number; readonly appointmentId: number },
  base: number,
  fields: AppointmentFields,
): Promise<SendOutcome> => {
  const { calendarId, appointmentId } = ids;
  const target = targetOf('appointment', calendarId, appointmentId);
  let failure: unknown;
  try {
    await writes.updateAppointment(ctx, calendarId, appointmentId, fields);
  } catch (error) {
    const failed = failureOf(error, target);
    if (failed.kind === 'notSent') return failed;
    failure = error;
  }
  let after: StoredAppointment;
  try {
    after = (await writes.appointmentState(ctx, calendarId, appointmentId))
      .appointment;
  } catch (error) {
    return { kind: 'unknown', code: codeOf(failure ?? error), target };
  }
  // Each stored PUT raises the version by exactly one (F42), and the
  // fields the plan keeps are kept as well.
  if (
    after.version === base + 1 &&
    !after.allDay &&
    sameFields(after, fields) &&
    after.subtitle === fields.subtitle &&
    after.isInternal === fields.isInternal
  ) {
    return { kind: 'verified', target, version: after.version };
  }
  // Only a refusal of ChurchTools shows that the write did not land.
  if (failure !== undefined && after.version === base) {
    return failureOf(failure, target);
  }
  return { kind: 'notAsPlanned', target };
};

// Whether a booking takes the resource at a time that overlaps the span.
const overlaps = (booking: StoredBookingLike, fields: DatedFields): boolean =>
  Date.parse(booking.startDate) < Date.parse(fields.endDate) &&
  Date.parse(fields.startDate) < Date.parse(booking.endDate);

/** A booking of a list or a read, as far as a plan compares it. */
interface StoredBookingLike {
  readonly title: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly statusId: number;
}

// A request or an approved booking, not a rejected one, which takes no
// place of the resource (OpenAPI document of 3.138).
const holds = (booking: StoredBookingLike): boolean =>
  booking.statusId === 1 || booking.statusId === 2;

const planBookingCreate = async (
  options: CalendarPlanOptions,
  ctx: TenantContext,
  intent: Extract<CalendarIntent, { kind: 'bookingCreate' }>,
  tool: string,
): Promise<CalendarPlan> => {
  const { writes, timeZone } = options;
  const fields = checked(
    {
      title: intent.title,
      description: intent.description ?? null,
      startDate: intent.startDate,
      endDate: intent.endDate,
    },
    intent.description,
  );
  timed(fields, timeZone);
  const { from, to } = daysAround(fields);
  const { bookings, serverTime } = await writes.resourceDayState(
    ctx,
    intent.resourceId,
    from,
    to,
  );
  complete(bookings.more);
  const name = await writes.resourceName(ctx, intent.resourceId);
  const same = (booking: StoredBookingLike): boolean =>
    holds(booking) &&
    booking.title === fields.title &&
    booking.startDate === fields.startDate &&
    booking.endDate === fields.endDate;
  const done = bookings.bookings.some(same);
  const overlapping = bookings.bookings.filter(
    (booking) => holds(booking) && !same(booking) && overlaps(booking, fields),
  ).length;
  const contentHash = hashOf(fields);
  const after = linesOf(fields, timeZone);
  const resource = targetOf('resource', intent.resourceId);
  return Object.freeze({
    contentHash,
    serverTime,
    ...(done ? { skip: 'already_written' as const } : {}),
    text: datedConfirmationTextOf({
      kind: 'bookingCreate',
      place: {
        id: intent.resourceId,
        ...(name === undefined ? {} : { name }),
      },
      title: fields.title,
      span: spanTextOf(fields.startDate, fields.endDate, timeZone),
      before: '',
      after,
      changed: [],
      overlapping,
    }),
    change: Object.freeze({ from: '', to: after }),
    before: Object.freeze({
      kind: 'bookingCreate',
      tool,
      placeId: intent.resourceId,
      fieldsHash: contentHash,
      startDate: fields.startDate,
      endDate: fields.endDate,
    }),
    send: async (
      saveCreated: (created: DatedCreatedSnapshot) => Promise<void>,
    ): Promise<SendOutcome> => {
      let created: StoredBooking;
      try {
        created = await writes.createBooking(ctx, intent.resourceId, fields);
      } catch (error) {
        return failureOf(error, resource);
      }
      const target = targetOf('booking', intent.resourceId, created.id);
      await saveCreated(
        Object.freeze({
          kind: 'bookingCreated',
          id: created.id,
          version: created.version,
          statusId: created.statusId,
        }),
      );
      // A request or one the resource approved by itself; a rejected
      // booking or one of a series or an appointment is not as planned.
      const fits = (booking: StoredBooking): boolean =>
        holds(booking) && !booking.linked && sameFields(booking, fields);
      if (!fits(created)) return { kind: 'notAsPlanned', target };
      try {
        const { booking } = await writes.bookingState(
          ctx,
          intent.resourceId,
          created.id,
        );
        if (fits(booking)) {
          return { kind: 'verified', target, version: booking.version };
        }
      } catch (error) {
        return { kind: 'unknown', code: codeOf(error), target };
      }
      return { kind: 'notAsPlanned', target };
    },
  });
};

/**
 * Plans a write of an appointment or a booking: checks its fields, reads
 * what it rests on and gives hash, text, snapshot and the send.
 *
 * @param options - The writes of the client, the read of the account and
 *   the zone of the texts.
 * @param ctx - The context of the call.
 * @param intent - The intent, its texts as the content policy wrote them.
 * @param tool - The name of the tool, which the snapshot keeps.
 * @returns The plan, frozen.
 * @throws {EccliumError} With a fixed sentence when the write is refused,
 *   and the codes of a failed read.
 * @example
 * ```ts
 * const plan = await planCalendar(options, ctx, intent, 'ct_bookings_create');
 * if (plan.skip === undefined) await plan.send(saveCreated);
 * ```
 */
export function planCalendar(
  options: CalendarPlanOptions,
  ctx: TenantContext,
  intent: CalendarIntent,
  tool: string,
): Promise<CalendarPlan> {
  switch (intent.kind) {
    case 'appointmentCreate':
      return planAppointmentCreate(options, ctx, intent, tool);
    case 'appointmentUpdate':
      return planAppointmentUpdate(options, ctx, intent, tool);
    case 'bookingCreate':
      return planBookingCreate(options, ctx, intent, tool);
  }
}

/** How the one send of an undo of an appointment or a booking ended. */
export type UndoSendOutcome =
  | SendOutcome
  /** Deleted, and a read after shows it gone. */
  | { readonly kind: 'deleted'; readonly target: WriteTarget };

/** What taking back a write of an appointment or a booking rests on. */
export type CalendarUndoPlan =
  /** The target holds what the undo would leave, or is gone already. */
  | { readonly kind: 'unchanged' }
  /**
   * Someone changed the target since the write: the fields now and what
   * the undo would leave, as lines, for the operator.
   */
  | {
      readonly kind: 'changed';
      readonly change: { readonly from: string; readonly to: string };
    }
  /** Ready to send, with what the undo changes. */
  | {
      readonly kind: 'ready';
      readonly change: { readonly from: string; readonly to: string };
      /** The time of ChurchTools of the read, null without one. */
      readonly serverTime: number | null;
      /**
       * What the snapshot of the undo keeps, so that it can be taken back
       * as well; none for a delete, which cannot (ADR 0031).
       */
      readonly before?: SnapshotState;
      /**
       * Sends the undo once and reads it back.
       *
       * @returns How it ended; it never rejects.
       */
      readonly send: () => Promise<UndoSendOutcome>;
    };

// A change goes back to the fields from before: title, description, start
// and end, not the other fields, which the change left as they were.
const planRestore = async (
  options: CalendarPlanOptions,
  ctx: TenantContext,
  target: Extract<CalendarUndoTarget, { kind: 'restore' }>,
  overwrite: boolean,
): Promise<CalendarUndoPlan> => {
  const { writes, timeZone } = options;
  const { calendarId, appointmentId, before, left } = target;
  const { appointment: now, serverTime } = await writes.appointmentState(
    ctx,
    calendarId,
    appointmentId,
  );
  const fields: AppointmentFields = Object.freeze({
    title: before.title,
    description: before.description,
    startDate: before.startDate,
    endDate: before.endDate,
    subtitle: now.subtitle,
    isInternal: now.isInternal,
  });
  if (sameFields(now, fields)) return { kind: 'unchanged' };
  const change = Object.freeze({
    from: linesOf(now, timeZone),
    to: linesOf(fields, timeZone),
  });
  // A later change is shown first; the operator decides with `--overwrite`.
  const asLeft =
    now.version === left.version && changeHashOf(now) === left.fieldsHash;
  if (!asLeft && !overwrite) return { kind: 'changed', change };
  // Then the rules of every change: the fields are the state before
  // Ecclium, so only what the client sends counts, not the limits of a
  // text of a tool.
  if (now.parts.length > 0) {
    throw refuse('policy_denied', calendarSentences.appointmentParts);
  }
  if (now.allDay) throw refuse('policy_denied', calendarSentences.wholeDays);
  if (!fitsDatedFields(fields)) {
    throw refuse('validation', calendarSentences.datedFields);
  }
  if (fields.startDate !== now.startDate || fields.endDate !== now.endDate) {
    const account = await options.whoami(ctx);
    if (now.createdBy === null || now.createdBy !== account.id) {
      throw refuse('policy_denied', calendarSentences.notOwnTime);
    }
  }
  return Object.freeze({
    kind: 'ready',
    change,
    serverTime,
    before: Object.freeze({
      kind: 'appointmentFields',
      tool: target.tool,
      calendarId,
      appointmentId,
      before: Object.freeze({
        version: now.version,
        title: now.title,
        subtitle: now.subtitle,
        description: now.description,
        startDate: now.startDate,
        endDate: now.endDate,
        isInternal: now.isInternal,
      }),
      after: Object.freeze({
        version: now.version + 1,
        fieldsHash: changeHashOf(fields),
      }),
    }),
    send: () => sendChange(writes, ctx, target, now.version, fields),
  });
};

// A new appointment is deleted only while it is as the write left it and
// nothing is linked to it; a read that answers 404 shows it gone (F47).
const planAppointmentDelete = async (
  options: CalendarPlanOptions,
  ctx: TenantContext,
  target: Extract<CalendarUndoTarget, { kind: 'deleteAppointment' }>,
): Promise<CalendarUndoPlan> => {
  const { writes, timeZone } = options;
  const { calendarId, appointmentId, left } = target;
  const gone = (error: unknown): boolean =>
    isEccliumError(error) && error.code === 'not_found';
  let read: AppointmentState;
  try {
    read = await writes.appointmentState(ctx, calendarId, appointmentId);
  } catch (error) {
    if (gone(error)) return { kind: 'unchanged' };
    throw error;
  }
  const { appointment: now, serverTime } = read;
  const change = Object.freeze({ from: linesOf(now, timeZone), to: '' });
  if (now.version !== left.version || hashOf(now) !== left.fieldsHash) {
    return { kind: 'changed', change };
  }
  // Deleting an appointment deletes what hangs on it as well.
  if (now.parts.length > 0) {
    throw refuse('policy_denied', calendarSentences.appointmentParts);
  }
  const deleted = targetOf('appointment', calendarId, appointmentId);
  return Object.freeze({
    kind: 'ready',
    change,
    serverTime,
    send: async (): Promise<UndoSendOutcome> => {
      let failure: unknown;
      try {
        await writes.deleteAppointment(ctx, calendarId, appointmentId);
      } catch (error) {
        const failed = failureOf(error, deleted);
        if (failed.kind === 'notSent') return failed;
        failure = error;
      }
      try {
        await writes.appointmentState(ctx, calendarId, appointmentId);
      } catch (error) {
        if (gone(error)) return { kind: 'deleted', target: deleted };
        return {
          kind: 'unknown',
          code: codeOf(failure ?? error),
          target: deleted,
        };
      }
      // Still there: only a refusal of ChurchTools shows why.
      return failure === undefined
        ? { kind: 'notAsPlanned', target: deleted }
        : failureOf(failure, deleted);
    },
  });
};

// A new booking is deleted only while it is as the write left it. A read of
// a deleted booking answers 500, so only the list of its days shows that it
// is gone (F47); a list that ends before its last entry shows nothing.
const planBookingDelete = async (
  options: CalendarPlanOptions,
  ctx: TenantContext,
  target: Extract<CalendarUndoTarget, { kind: 'deleteBooking' }>,
): Promise<CalendarUndoPlan> => {
  const { writes, timeZone } = options;
  const { resourceId, bookingId, left } = target;
  const listed = async (
    span: Pick<DatedFields, 'startDate' | 'endDate'>,
  ): Promise<boolean | undefined> => {
    const { from, to } = daysAround(span);
    const { bookings } = await writes.resourceDayState(
      ctx,
      resourceId,
      from,
      to,
    );
    if (bookings.bookings.some((entry) => entry.id === bookingId)) return true;
    return bookings.more ? undefined : false;
  };
  let read: BookingState;
  try {
    read = await writes.bookingState(ctx, resourceId, bookingId);
  } catch (error) {
    // A deleted booking reads as 500, as other failures do (F47). Only a
    // 404 with a list that leaves the booking out shows it gone; any other
    // failure with such a list cannot tell a deleted booking from one moved
    // to another resource, so the operator looks.
    const unread =
      isEccliumError(error) &&
      (error.code === 'upstream' || error.code === 'not_found');
    if (!unread || (await listed(target)) !== false) throw error;
    if (error.code === 'not_found') return { kind: 'unchanged' };
    throw refuse('not_found', calendarSentences.bookingGone);
  }
  const { booking, serverTime } = read;
  const change = Object.freeze({ from: linesOf(booking, timeZone), to: '' });
  // An approval need not raise the version, so the status counts as well,
  // and a booking linked to an appointment since is not deleted either.
  if (
    booking.version !== left.version ||
    booking.statusId !== left.statusId ||
    booking.linked ||
    hashOf(booking) !== left.fieldsHash
  ) {
    return { kind: 'changed', change };
  }
  const deleted = targetOf('booking', resourceId, bookingId);
  return Object.freeze({
    kind: 'ready',
    change,
    serverTime,
    send: async (): Promise<UndoSendOutcome> => {
      let failure: unknown;
      try {
        await writes.deleteBooking(ctx, bookingId);
      } catch (error) {
        const failed = failureOf(error, deleted);
        if (failed.kind === 'notSent') return failed;
        failure = error;
      }
      let there: boolean | undefined;
      try {
        there = await listed(booking);
      } catch (error) {
        return {
          kind: 'unknown',
          code: codeOf(failure ?? error),
          target: deleted,
        };
      }
      if (there === false) return { kind: 'deleted', target: deleted };
      if (there === undefined) {
        return { kind: 'unknown', code: codeOf(failure), target: deleted };
      }
      return failure === undefined
        ? { kind: 'notAsPlanned', target: deleted }
        : failureOf(failure, deleted);
    },
  });
};

/**
 * Reads what taking back a write of an appointment or a booking rests on:
 * whether anything is left to do, whether someone changed the target since
 * the write, and the one send. A new appointment or booking is deleted only
 * as the write left it, `overwrite` or not; a changed appointment gets its
 * fields back over a later change only with `overwrite`, and only where a
 * tool could change it (ADR 0031).
 *
 * @param options - The writes of the client, the read of the account and
 *   the zone of the texts.
 * @param ctx - The context of the undo.
 * @param target - What the snapshot names to take back.
 * @param overwrite - Whether to write over a later change of an
 *   appointment.
 * @returns What the undo rests on, frozen.
 * @throws {EccliumError} With a fixed sentence when the undo is refused,
 *   and the codes of a failed read.
 * @example
 * ```ts
 * const plan = await planCalendarUndo(options, ctx, target, false);
 * if (plan.kind === 'ready') await plan.send();
 * ```
 */
export function planCalendarUndo(
  options: CalendarPlanOptions,
  ctx: TenantContext,
  target: CalendarUndoTarget,
  overwrite: boolean,
): Promise<CalendarUndoPlan> {
  switch (target.kind) {
    case 'restore':
      return planRestore(options, ctx, target, overwrite);
    case 'deleteAppointment':
      return planAppointmentDelete(options, ctx, target);
    case 'deleteBooking':
      return planBookingDelete(options, ctx, target);
  }
}
