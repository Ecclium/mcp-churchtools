/**
 * The writes of the ChurchTools client for calendars and resources
 * (ADR 0072): create, change and delete a single appointment, request and
 * delete a booking, and the reads a plan needs: an appointment, a booking
 * and the days of a calendar or a resource, each with the time of
 * ChurchTools from the `date` header, and the names the policy compares.
 *
 * Where they stand in the way of a write: a tool only plans; the write
 * guard of the core seals the plan, gets it confirmed and commits it
 * (ADR 0029). On the commit it reads the appointment or the day right
 * before writing, compares version and time, writes once and reads again
 * right after. Nothing here decides whether a write may happen, and
 * nothing here retries: after any failure that follows the transport,
 * ChurchTools may have written, and only the read afterwards tells.
 *
 * ChurchTools replaces a whole appointment with `PUT` and empties every
 * field left out (F41). The client therefore sends the fields the probe
 * sent, a new appointment without a subtitle, and tells the write guard,
 * in `parts`, what else an appointment holds that a change would lose or
 * move, as far as the account sees it (ADR 0072). It sends every booking
 * as a request (`statusId` 1), never as approved, though a resource may
 * approve it by itself (F45), and deletes only the one appointment or
 * booking the write guard names to take back what Ecclium created. A
 * deleted booking cannot be read (F47); only the bookings of its day show
 * that it is gone.
 *
 * @packageDocumentation
 */
import {
  type AppointmentList,
  type BookingList,
  dateTimePattern,
  EccliumError,
  maxAppointmentDescriptionLength,
  maxNameLength,
  type TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';
import type { z } from 'zod';

import { urlOfPath } from './query.js';
import {
  fetchRead,
  type RequestPath,
  sendDelete,
  sendWrite,
} from './request.js';
import {
  appointmentCreatedSchema,
  appointmentStateSchema,
  bookingCreatedSchema,
  bookingStateSchema,
  type storedAppointmentSchema,
  type storedBookingSchema,
  wellFormed,
} from './schemas.js';
import { serverTimeOf } from './server-date.js';

/**
 * What an appointment holds that the client does not send back when it
 * changes it: a series, an address, a link, an image, a group for sign-ups
 * and a person on whose behalf it was entered, which `PUT` may empty
 * (F41), and an event, a booking or an invitation linked to it, which
 * ChurchTools moves or detaches with a change by the OpenAPI document and
 * no probe shows (ADR 0072).
 */
export type AppointmentPart =
  'series' | 'address' | 'link' | 'image' | 'signup' | 'onBehalfOf' | 'linked';

/** An appointment as ChurchTools stores it, for a plan (F42). */
export interface StoredAppointment {
  /** The ID of the appointment. */
  readonly id: number;
  /** The calendar of the appointment, the one of the request. */
  readonly calendarId: number;
  /**
   * The version, 0 for a new appointment and one more for each `PUT`
   * ChurchTools takes, even one that changes nothing (F42).
   */
  readonly version: number;
  readonly title: string;
  /** The subtitle, or null for none. */
  readonly subtitle: string | null;
  /** The description, or null for none. */
  readonly description: string | null;
  /** The start, a time in UTC or a day alone for whole days. */
  readonly startDate: string;
  /** The end, in the form of the start. */
  readonly endDate: string;
  /** Whether the appointment lasts whole days. */
  readonly allDay: boolean;
  /** Whether only signed-in persons see the appointment. */
  readonly isInternal: boolean;
  /**
   * What the appointment holds that a change by the client would lose, in
   * the order of {@link AppointmentPart}; empty for a single appointment
   * like the one of the probe. Linked events, bookings and invitations are
   * known only from a read with `appointmentState`, and only those the
   * account may see: ChurchTools gives what is linked as far as it is
   * visible to the account (OpenAPI document of 3.138, ADR 0072).
   */
  readonly parts: readonly AppointmentPart[];
}

/** An appointment as a plan reads it right before and right after a write. */
export interface AppointmentState {
  readonly appointment: StoredAppointment;
  /**
   * The time of ChurchTools from the `date` header of the answer, in
   * milliseconds since the Unix epoch, or null when the header is missing
   * or has another form. The write guard does not write without it.
   */
  readonly serverTime: number | null;
}

/** A booking as ChurchTools stores it, for a plan (F42). */
export interface StoredBooking {
  /** The ID of the booking. */
  readonly id: number;
  /** The resource of the booking, the one of the request. */
  readonly resourceId: number;
  /** The version, 0 for a new booking, higher after a change or an answer. */
  readonly version: number;
  readonly title: string;
  /** The description, or null for none. */
  readonly description: string | null;
  /** The start, a time in UTC or a day alone for whole days. */
  readonly startDate: string;
  /** The end, in the form of the start. */
  readonly endDate: string;
  /** 1 requested, 2 approved, 3 rejected (F45). */
  readonly statusId: number;
  /** Whether the booking is part of a series or of an appointment. */
  readonly linked: boolean;
}

/** A booking as a plan reads it, with the time of ChurchTools. */
export interface BookingState {
  readonly booking: StoredBooking;
  /** As {@link AppointmentState.serverTime}. */
  readonly serverTime: number | null;
}

/** The appointments of a calendar in a span of days, with the time. */
export interface CalendarDayState {
  readonly appointments: AppointmentList;
  /** As {@link AppointmentState.serverTime}. */
  readonly serverTime: number | null;
}

/** The bookings of a resource in a span of days, with the time. */
export interface ResourceDayState {
  readonly bookings: BookingList;
  /** As {@link AppointmentState.serverTime}. */
  readonly serverTime: number | null;
}

/** The fields the client writes to a new appointment or booking. */
export interface DatedFields {
  /** One line, 1 to 255 characters, no spaces at either end. */
  readonly title: string;
  /** The description, or null for none. */
  readonly description: string | null;
  /** A time in UTC, `YYYY-MM-DDTHH:MM:SSZ`. */
  readonly startDate: string;
  /** A time in UTC, after the start. */
  readonly endDate: string;
}

/**
 * The fields of a changed appointment: those of a new one, and subtitle
 * and visibility as the write guard read them, because `PUT` empties what
 * it does not get (F41).
 */
export interface AppointmentChange extends DatedFields {
  /** The subtitle as read, or null for none. */
  readonly subtitle: string | null;
  /** Whether only signed-in persons see the appointment, as read. */
  readonly isInternal: boolean;
}

/** A calendar for the policy and the confirmation: its name and whether it is public. */
export interface CalendarFacts {
  readonly name: string;
  readonly isPublic: boolean;
}

/**
 * The writes of the client for calendars and resources and the reads a
 * plan needs (ADR 0072). Only the write guard of the core is to call them.
 */
export interface CalendarWrites {
  /**
   * Reads one appointment with `include[]` for events, bookings and
   * invitations, with the time of ChurchTools, for the read right before
   * and right after a write.
   *
   * @throws {EccliumError} As the read of an appointment.
   */
  appointmentState(
    ctx: TenantContext,
    calendarId: number,
    appointmentId: number,
  ): Promise<AppointmentState>;
  /**
   * Reads the appointments of a calendar from one day to another, with the
   * time of ChurchTools, for the read before creating an appointment.
   *
   * @throws {EccliumError} As the list of appointments.
   */
  calendarDayState(
    ctx: TenantContext,
    calendarId: number,
    from: string,
    to: string,
  ): Promise<CalendarDayState>;
  /**
   * Creates a single appointment with `POST /api/calendars/{id}/appointments`,
   * for everyone who sees the calendar and without a series.
   *
   * @throws {EccliumError} `validation` for a value it may not send,
   *   `not_found` for a calendar that does not exist, and the codes of
   *   every other failure.
   */
  createAppointment(
    ctx: TenantContext,
    calendarId: number,
    fields: DatedFields,
  ): Promise<StoredAppointment>;
  /**
   * Replaces an appointment with `PUT …/appointments/{id}`. The answer is
   * not read; read the appointment again to see that the version rose.
   *
   * @throws {EccliumError} `validation` for a value it may not send,
   *   `not_found` for an appointment that does not exist, and the codes of
   *   every other failure.
   */
  updateAppointment(
    ctx: TenantContext,
    calendarId: number,
    appointmentId: number,
    change: AppointmentChange,
  ): Promise<void>;
  /**
   * Deletes an appointment with `DELETE …/appointments/{id}`, only to take
   * back one that Ecclium created (ADR 0029).
   *
   * @throws {EccliumError} `not_found` for an appointment that does not
   *   exist, and the codes of every other failure.
   */
  deleteAppointment(
    ctx: TenantContext,
    calendarId: number,
    appointmentId: number,
  ): Promise<void>;
  /**
   * Reads one booking with the time of ChurchTools. A deleted booking
   * answers 500, not 404 (F47): read the bookings of its day instead.
   *
   * @throws {EccliumError} As every read of one object.
   */
  bookingState(
    ctx: TenantContext,
    resourceId: number,
    bookingId: number,
  ): Promise<BookingState>;
  /**
   * Reads the bookings of a resource from one day to another, with the
   * time of ChurchTools, for the read before requesting a booking and
   * after deleting one.
   *
   * @throws {EccliumError} As the list of bookings.
   */
  resourceDayState(
    ctx: TenantContext,
    resourceId: number,
    from: string,
    to: string,
  ): Promise<ResourceDayState>;
  /**
   * Requests a booking with `POST /api/bookings`, sent as requested
   * (`statusId` 1), never as approved, and not shown in the calendar. A
   * resource may approve it by itself, and ChurchTools tells its managers
   * by mail (F48).
   *
   * @throws {EccliumError} `validation` for a value it may not send or a
   *   resource that ChurchTools books only with an appointment,
   *   `not_found` for a resource that does not exist, and the codes of
   *   every other failure.
   */
  createBooking(
    ctx: TenantContext,
    resourceId: number,
    fields: DatedFields,
  ): Promise<StoredBooking>;
  /**
   * Deletes a booking with `DELETE /api/bookings/{id}`, only to take back
   * one that Ecclium requested (ADR 0029).
   *
   * @throws {EccliumError} `not_found` for a booking that does not exist,
   *   and the codes of every other failure.
   */
  deleteBooking(ctx: TenantContext, bookingId: number): Promise<void>;
  /**
   * Reads name and visibility of a calendar from `GET /api/calendars`, for
   * the policy and the confirmation.
   *
   * @returns The facts, or undefined when the list holds no calendar with
   *   this ID, such as one the account cannot see.
   * @throws {EccliumError} As the read of the calendars.
   */
  calendarFacts(
    ctx: TenantContext,
    calendarId: number,
  ): Promise<CalendarFacts | undefined>;
  /**
   * Reads the name of a resource from `GET /api/resources`, for the policy.
   *
   * @returns The name, or undefined when the list holds no resource with
   *   this ID.
   * @throws {EccliumError} As the read of the resources.
   */
  resourceName(
    ctx: TenantContext,
    resourceId: number,
  ): Promise<string | undefined>;
}

/** How the client reads a span of appointments or bookings, with its `date`. */
export type ReadSpan<List> = (
  ctx: TenantContext,
  ids: readonly number[],
  from: string,
  to: string,
) => Promise<{ readonly list: List; readonly date: string | undefined }>;

/** What the writes for calendars are built from. */
export interface CalendarWritesOptions {
  /** Origin, transport and throttle, the same as for every read. */
  readonly path: RequestPath;
  /** The canonical origin of the client. */
  readonly origin: string;
  /** The read of the appointments of a span that the client uses itself. */
  readonly readAppointments: ReadSpan<AppointmentList>;
  /** The read of the bookings of a span that the client uses itself. */
  readonly readBookings: ReadSpan<BookingList>;
  /** The read of the calendars that the client uses itself. */
  readonly readCalendars: (
    ctx: TenantContext,
  ) => Promise<readonly ({ readonly id: number } & CalendarFacts)[]>;
  /** The read of the resources that the client uses itself. */
  readonly readResources: (ctx: TenantContext) => Promise<{
    readonly resources: readonly {
      readonly id: number;
      readonly name: string;
    }[];
  }>;
}

// One appointment or booking with every date of a series of 500, as for a
// read of one appointment.
const objectLimits = Object.freeze({
  maxResponseBytes: 1024 * 1024,
  maxElements: 20_000,
});

// In English for the model; printable ASCII, like every message (ADR 0054).
const invalidCalendarWriteInput = `A calendar, appointment, resource and booking ID is a whole number from 1. A title has 1 to ${String(maxNameLength)} characters on one line, no control characters and no spaces at either end, a description 1 to ${String(maxAppointmentDescriptionLength)} characters and more than spaces, and start and end are times in UTC as YYYY-MM-DDTHH:MM:SSZ with the end after the start.`;

// ChurchTools answers 422 for a resource that it books only together with
// an appointment (OpenAPI document of 3.138); Ecclium requests no such
// booking.
const needsAppointment =
  'ChurchTools books this resource only together with an appointment. Ecclium does not request such a booking: ask the managers of the resource.';

const isWholeFromOne = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
};

// A title or subtitle as ChurchTools keeps it: one line of 1 to 255 UTF-16
// code units, as the schema of a read counts, without control characters,
// spaces at either end, which ChurchTools may trim, or a lone surrogate.
const isLine = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length >= 1 &&
  value.length <= maxNameLength &&
  value.trim() === value &&
  wellFormed(value) &&
  !hasControlCharacter(value);

// A description of 1 code unit up to the length a read takes back, more
// than spaces, without a lone surrogate or U+0000. Line breaks are allowed;
// what a description may say is the business of the content policy.
const isDescription = (value: unknown): value is string | null =>
  value === null ||
  (typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= maxAppointmentDescriptionLength &&
    value.trim() !== '' &&
    wellFormed(value) &&
    !value.includes('\u0000'));

// A time in UTC that exists: the pattern takes 30 February, which the
// round trip through Date turns into 2 March.
const isTime = (value: unknown): value is string => {
  if (typeof value !== 'string' || !dateTimePattern.test(value)) return false;
  const time = Date.parse(value);
  return (
    Number.isFinite(time) &&
    new Date(time).toISOString() === value.replace('Z', '.000Z')
  );
};

// A start and an end in UTC with a time, the end after the start. Whole
// days are not sent: no probe shows how ChurchTools takes them (ADR 0072).
const isSpan = (startDate: unknown, endDate: unknown): boolean =>
  isTime(startDate) &&
  isTime(endDate) &&
  Date.parse(endDate) > Date.parse(startDate);

const isDated = (fields: DatedFields): boolean =>
  isLine(fields.title) &&
  isDescription(fields.description) &&
  isSpan(fields.startDate, fields.endDate);

/**
 * Whether a value of ChurchTools holds anything: text that is not blank, a
 * number, `true`, or a list or object that holds such a value at any depth.
 * Read without recursion, so that the depth of an answer cannot exhaust the
 * stack.
 *
 * @param value - A value of an answer.
 * @returns Whether it holds a value.
 * @example
 * ```ts
 * holdsValue({ name: null, street: '' }); // false
 * holdsValue([{ id: 3 }]); // true
 * ```
 */
export function holdsValue(value: unknown): boolean {
  const open: unknown[] = [value];
  while (open.length > 0) {
    const next = open.pop();
    if (typeof next === 'string') {
      if (next.trim() !== '') return true;
    } else if (typeof next === 'number' || next === true) {
      return true;
    } else if (typeof next === 'object' && next !== null) {
      // One by one, since a spread of a long list could exceed the most
      // arguments of a call.
      for (const inner of Object.values(next as Record<string, unknown>)) {
        open.push(inner);
      }
    }
  }
  return false;
}

// Whether a value is a list or an object that holds a value: the form in
// which a linked event, booking or invitation comes. Text, numbers and
// booleans of a date, such as its iCalUid, are no links.
const isLink = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && holdsValue(value);

// Whether a key of a date is the date itself.
const isDateKey = (key: string): boolean =>
  key === 'startDate' || key === 'endDate';

// The keys of `data` in the answer of a read of an appointment, and of the
// appointment in it, that the OpenAPI document of 3.138 describes.
const stateKeys: readonly string[] = Object.freeze([
  'appointment',
  'additionalInfos',
  'calculatedDates',
]);
const appointmentKeys: readonly string[] = Object.freeze([
  'additionals',
  'additions',
  'address',
  'allDay',
  'calendar',
  'caption',
  'description',
  'endDate',
  'exceptions',
  'id',
  'image',
  'information',
  'isInternal',
  'link',
  'meta',
  'note',
  'onBehalfOfPid',
  'repeatFrequency',
  'repeatId',
  'repeatOption',
  'repeatUntil',
  'signup',
  'startDate',
  'subtitle',
  'title',
  'version',
]);

// Whether an object of an answer has a key the document does not describe
// whose value is a link: the document does not say where invitations go
// for one appointment, and on the reads of one date they stand beside the
// appointment, which the schema of the client drops (ADR 0072).
const hasUnknownLink = (value: unknown, known: readonly string[]): boolean =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.entries(value).some(
    ([key, inner]) => !known.includes(key) && isLink(inner),
  );

// Text without a value counts as none, so that a description or subtitle
// ChurchTools keeps as empty can be sent back as missing.
const textOrNull = (value: string | null | undefined): string | null =>
  value === undefined || value === null || value.trim() === '' ? null : value;

type StoredAppointmentData = z.infer<typeof storedAppointmentSchema>;

// What an appointment holds that a change would lose, in a fixed order.
const partsOf = (
  data: StoredAppointmentData,
  linked: boolean,
): readonly AppointmentPart[] => {
  const parts: AppointmentPart[] = [];
  if (
    data.repeatId !== 0 ||
    (data.additionals?.length ?? 0) > 0 ||
    (data.exceptions?.length ?? 0) > 0
  ) {
    parts.push('series');
  }
  if (holdsValue(data.address)) parts.push('address');
  if (holdsValue(data.link)) parts.push('link');
  if (holdsValue(data.image)) parts.push('image');
  if (holdsValue(data.signup)) parts.push('signup');
  if (typeof data.onBehalfOfPid === 'number') parts.push('onBehalfOf');
  if (linked) parts.push('linked');
  return Object.freeze(parts);
};

const toAppointment = (
  data: StoredAppointmentData,
  linked: boolean,
): StoredAppointment =>
  Object.freeze({
    __proto__: null,
    id: data.id,
    calendarId: data.calendar.id,
    version: data.version,
    title: data.title,
    subtitle: textOrNull(data.subtitle),
    description: textOrNull(data.description),
    startDate: data.startDate,
    endDate: data.endDate,
    allDay: data.allDay,
    isInternal: data.isInternal,
    parts: partsOf(data, linked),
  });

const toBooking = (data: z.infer<typeof storedBookingSchema>): StoredBooking =>
  Object.freeze({
    __proto__: null,
    id: data.id,
    resourceId: data.resourceId,
    version: data.version,
    title: data.title,
    description: textOrNull(data.description),
    startDate: data.startDate,
    endDate: data.endDate,
    statusId: data.statusId,
    linked: data.repeatId !== 0 || isWholeFromOne(data.appointmentId),
  });

// The body of a write, as JSON in UTF-8. A field without a value is left
// out, as the probe left it out to empty it (F41).
const jsonBody = (value: Readonly<Record<string, unknown>>): Uint8Array =>
  new TextEncoder().encode(
    JSON.stringify(value, (_key, field: unknown) =>
      field === null ? undefined : field,
    ),
  );

/**
 * Builds the writes for calendars and resources of one client, on its
 * path and under its throttle.
 *
 * @param options - Path, origin and the reads of the client.
 * @returns The writes, frozen.
 * @example
 * ```ts
 * const writes = createCalendarWrites({ path, origin, readAppointments, readBookings, readCalendars, readResources });
 * const created = await writes.createAppointment(ctx, 4, fields);
 * ```
 */
export function createCalendarWrites(
  options: CalendarWritesOptions,
): CalendarWrites {
  const { path, origin } = options;

  // Refuses what may not be sent before the tenant is checked and the
  // throttle gives a place, so that an invalid value costs no request.
  const checkInput = (ctx: TenantContext, valid: boolean): void => {
    if (valid) return;
    ctx.log.warn('churchtools_calendar_write_refused', {
      code: 'validation',
    });
    throw new EccliumError('validation', invalidCalendarWriteInput);
  };

  const appointmentUrl = (calendarId: number, appointmentId?: number) =>
    urlOfPath(
      origin,
      appointmentId === undefined
        ? `/api/calendars/${String(calendarId)}/appointments`
        : `/api/calendars/${String(calendarId)}/appointments/${String(appointmentId)}`,
    );

  const appointmentState = async (
    ctx: TenantContext,
    calendarId: number,
    appointmentId: number,
  ): Promise<AppointmentState> => {
    checkInput(
      ctx,
      isWholeFromOne(calendarId) && isWholeFromOne(appointmentId),
    );
    const url = appointmentUrl(calendarId, appointmentId);
    // Linked parts are separate objects of ChurchTools; only these
    // enrichments show them. Event and bookings enrich the dates (OpenAPI
    // document of 3.138); where invitations go, the document does not say.
    for (const part of ['event', 'bookings', 'meetingRequests']) {
      url.searchParams.append('include[]', part);
    }
    const { root, date } = await fetchRead(ctx, path, url, objectLimits, {
      status: 'churchtools_appointment_status',
      refused: 'churchtools_appointment_refused',
      missing: 'churchtools_appointment_missing',
    });
    const parsed = appointmentStateSchema.safeParse(root);
    if (!parsed.success) {
      ctx.log.warn('churchtools_appointment_refused', { code: 'upstream' });
      throw new EccliumError('upstream');
    }
    const data = parsed.data.data;
    // Only the appointment and the calendar asked for, whose right
    // ChurchTools checked.
    if (
      data.appointment.id !== appointmentId ||
      data.appointment.calendar.id !== calendarId
    ) {
      ctx.log.warn('churchtools_appointment_foreign', { code: 'upstream' });
      throw new EccliumError('upstream');
    }
    // A link in any date, in the series-level additions, or under a key
    // the document does not describe beside or in the appointment: what a
    // probe has not shown counts as linked, so that a change does not lose
    // it unnoticed. What the account cannot see, no read shows.
    const dates = Array.isArray(data.calculatedDates)
      ? data.calculatedDates
      : Object.values(data.calculatedDates);
    const raw = root['data'] as Readonly<Record<string, unknown>>;
    const linked =
      isLink(data.additionalInfos) ||
      dates.some((entry) =>
        Object.entries(entry).some(
          ([key, value]) => !isDateKey(key) && isLink(value),
        ),
      ) ||
      hasUnknownLink(raw, stateKeys) ||
      hasUnknownLink(raw['appointment'], appointmentKeys);
    return Object.freeze({
      __proto__: null,
      appointment: toAppointment(data.appointment, linked),
      serverTime: serverTimeOf(date),
    });
  };

  const calendarDayState = async (
    ctx: TenantContext,
    calendarId: number,
    from: string,
    to: string,
  ): Promise<CalendarDayState> => {
    const { list, date } = await options.readAppointments(
      ctx,
      [calendarId],
      from,
      to,
    );
    return Object.freeze({
      __proto__: null,
      appointments: list,
      serverTime: serverTimeOf(date),
    });
  };

  const createAppointment = async (
    ctx: TenantContext,
    calendarId: number,
    fields: DatedFields,
  ): Promise<StoredAppointment> => {
    // Read once, so that what is checked is what is sent.
    const { title, description, startDate, endDate } = fields;
    checkInput(
      ctx,
      isWholeFromOne(calendarId) &&
        isDated({ title, description, startDate, endDate }),
    );
    const root = await sendWrite(
      ctx,
      path,
      {
        method: 'POST',
        url: appointmentUrl(calendarId),
        // The fields of the probe without the subtitle (F41, F42).
        body: jsonBody({
          title,
          description,
          startDate,
          endDate,
          isInternal: false,
          repeatId: 0,
        }),
        success: 201,
        refused: 'churchtools_appointment_create_refused',
      },
      objectLimits,
      {
        status: 'churchtools_appointment_create_status',
        missing: 'churchtools_appointment_create_missing',
      },
    );
    // The appointment exists once ChurchTools answered 201. An answer
    // without its ID, or in another calendar, leaves it unaddressed.
    const parsed = appointmentCreatedSchema.safeParse(root);
    if (!parsed.success || parsed.data.data.calendar.id !== calendarId) {
      ctx.log.warn('churchtools_appointment_create_refused', {
        code: 'upstream',
      });
      throw new EccliumError('upstream');
    }
    return toAppointment(parsed.data.data, false);
  };

  const updateAppointment = async (
    ctx: TenantContext,
    calendarId: number,
    appointmentId: number,
    change: AppointmentChange,
  ): Promise<void> => {
    // Read once, so that what is checked is what is sent.
    const { title, subtitle, description, startDate, endDate, isInternal } =
      change;
    checkInput(
      ctx,
      isWholeFromOne(calendarId) &&
        isWholeFromOne(appointmentId) &&
        isDated({ title, description, startDate, endDate }) &&
        (subtitle === null ||
          (typeof subtitle === 'string' &&
            subtitle.length <= maxNameLength &&
            wellFormed(subtitle) &&
            !subtitle.includes('\u0000'))) &&
        typeof isInternal === 'boolean',
    );
    await sendWrite(
      ctx,
      path,
      {
        method: 'PUT',
        url: appointmentUrl(calendarId, appointmentId),
        // Every field the probe sent, so that none is emptied (F41).
        body: jsonBody({
          title,
          subtitle: subtitle === '' ? null : subtitle,
          description,
          startDate,
          endDate,
          isInternal,
          repeatId: 0,
        }),
        success: 200,
      },
      objectLimits,
      {
        status: 'churchtools_appointment_update_status',
        missing: 'churchtools_appointment_update_missing',
      },
    );
  };

  const deleteAppointment = async (
    ctx: TenantContext,
    calendarId: number,
    appointmentId: number,
  ): Promise<void> => {
    checkInput(
      ctx,
      isWholeFromOne(calendarId) && isWholeFromOne(appointmentId),
    );
    await sendDelete(ctx, path, appointmentUrl(calendarId, appointmentId), {
      status: 'churchtools_appointment_delete_status',
      missing: 'churchtools_appointment_delete_missing',
    });
  };

  const bookingUrl = (bookingId?: number) =>
    urlOfPath(
      origin,
      bookingId === undefined
        ? '/api/bookings'
        : `/api/bookings/${String(bookingId)}`,
    );

  const bookingState = async (
    ctx: TenantContext,
    resourceId: number,
    bookingId: number,
  ): Promise<BookingState> => {
    checkInput(ctx, isWholeFromOne(resourceId) && isWholeFromOne(bookingId));
    const { root, date } = await fetchRead(
      ctx,
      path,
      bookingUrl(bookingId),
      objectLimits,
      {
        status: 'churchtools_booking_status',
        refused: 'churchtools_booking_refused',
        missing: 'churchtools_booking_missing',
      },
    );
    const parsed = bookingStateSchema.safeParse(root);
    if (!parsed.success) {
      ctx.log.warn('churchtools_booking_refused', { code: 'upstream' });
      throw new EccliumError('upstream');
    }
    // The path names no resource, so the answer must name the one asked
    // for, whose right ChurchTools checked, and the booking asked for.
    if (
      parsed.data.data.booking.id !== bookingId ||
      parsed.data.data.booking.resourceId !== resourceId
    ) {
      ctx.log.warn('churchtools_booking_foreign', { code: 'upstream' });
      throw new EccliumError('upstream');
    }
    return Object.freeze({
      __proto__: null,
      booking: toBooking(parsed.data.data.booking),
      serverTime: serverTimeOf(date),
    });
  };

  const resourceDayState = async (
    ctx: TenantContext,
    resourceId: number,
    from: string,
    to: string,
  ): Promise<ResourceDayState> => {
    const { list, date } = await options.readBookings(
      ctx,
      [resourceId],
      from,
      to,
    );
    return Object.freeze({
      __proto__: null,
      bookings: list,
      serverTime: serverTimeOf(date),
    });
  };

  const createBooking = async (
    ctx: TenantContext,
    resourceId: number,
    fields: DatedFields,
  ): Promise<StoredBooking> => {
    // Read once, so that what is checked is what is sent.
    const { title, description, startDate, endDate } = fields;
    checkInput(
      ctx,
      isWholeFromOne(resourceId) &&
        isDated({ title, description, startDate, endDate }),
    );
    const root = await sendWrite(
      ctx,
      path,
      {
        method: 'POST',
        url: bookingUrl(),
        // Always sent as a request (F45), never in the calendar.
        body: jsonBody({
          resourceId,
          title,
          description,
          startDate,
          endDate,
          statusId: 1,
          showInCal: false,
        }),
        success: 201,
        refused: 'churchtools_booking_create_refused',
        unprocessable: { code: 'validation', message: needsAppointment },
      },
      objectLimits,
      {
        status: 'churchtools_booking_create_status',
        missing: 'churchtools_booking_create_missing',
      },
    );
    const parsed = bookingCreatedSchema.safeParse(root);
    if (!parsed.success || parsed.data.data.resourceId !== resourceId) {
      ctx.log.warn('churchtools_booking_create_refused', { code: 'upstream' });
      throw new EccliumError('upstream');
    }
    return toBooking(parsed.data.data);
  };

  const deleteBooking = async (
    ctx: TenantContext,
    bookingId: number,
  ): Promise<void> => {
    checkInput(ctx, isWholeFromOne(bookingId));
    await sendDelete(ctx, path, bookingUrl(bookingId), {
      status: 'churchtools_booking_delete_status',
      missing: 'churchtools_booking_delete_missing',
    });
  };

  // Name and visibility of one calendar from the list of all; ChurchTools
  // has no read of one calendar by its ID that the client knows.
  const calendarFacts = async (
    ctx: TenantContext,
    calendarId: number,
  ): Promise<CalendarFacts | undefined> => {
    checkInput(ctx, isWholeFromOne(calendarId));
    const found = (await options.readCalendars(ctx)).find(
      (calendar) => calendar.id === calendarId,
    );
    return found === undefined
      ? undefined
      : Object.freeze({
          __proto__: null,
          name: found.name,
          isPublic: found.isPublic,
        });
  };

  const resourceName = async (
    ctx: TenantContext,
    resourceId: number,
  ): Promise<string | undefined> => {
    checkInput(ctx, isWholeFromOne(resourceId));
    const { resources } = await options.readResources(ctx);
    return resources.find((resource) => resource.id === resourceId)?.name;
  };

  return Object.freeze({
    appointmentState,
    calendarDayState,
    createAppointment,
    updateAppointment,
    deleteAppointment,
    bookingState,
    resourceDayState,
    createBooking,
    deleteBooking,
    calendarFacts,
    resourceName,
  });
}
