/**
 * Answers of calendars, appointments, resources and bookings in the form
 * ChurchTools gives them, for the tests of their reads (ADR 0064). Every
 * field a read does not pass on holds a canary, so a test can show that no
 * layer lets one of them through. The fields kept take the values the test
 * gives.
 *
 * The names of the fields are those of the answers of ChurchTools 3.137, as
 * `09-domains-read` described them (`docs/research/churchtools-api.md`,
 * F37): 16 fields of a calendar, an appointment with its place and its
 * whole calendar in `appointment.base` and again in the copies above it,
 * one appointment with its dates under keys of no known form, 16 fields of
 * a resource, 8 of a type of resources and a booking with its whole
 * resource and a copy of its fields. The values are not those types:
 * every value outside the kept ones is a canary text. The client drops the
 * other fields by their names, not by their types. Where the probe could
 * not name a key, `unnamed` stands in for it.
 *
 * @packageDocumentation
 */
import type {
  AppointmentDetails,
  AppointmentEntry,
  BookingEntry,
  Calendar,
  Resource,
  ResourceType,
} from '@ecclium/mcp-churchtools-plugin-api';

import { type Canary, type CanaryKind } from '../canary.js';
import {
  answer,
  drop,
  type HighestLevelAnswer,
  meta,
  over,
  plant,
  type Shape,
} from './highest-level.js';

const text: CanaryKind = 'name';

// Every field of a calendar (F37). randomUrl may be the secret part of a
// link to subscribe to the calendar.
const calendarShape: Readonly<Record<string, Shape>> = {
  id: text,
  name: text,
  nameTranslated: text,
  sortKey: text,
  type: text,
  color: text,
  randomUrl: 'token',
  iCalSourceUrl: 'token',
  syncToEvTermine: text,
  evTermineEventTypeId: text,
  campusId: text,
  eventTemplateId: text,
  meta,
  unnamed: { first: text, second: text },
  isPublic: text,
  isPrivate: text,
};

// The place of an appointment, a reference of a domain with the fields of
// an address (F37).
const addressShape: Readonly<Record<string, Shape>> = {
  id: text,
  domainType: text,
  domainIdentifier: text,
  name: text,
  icon: text,
  color: text,
  street: text,
  addition: text,
  district: text,
  zip: 'phone',
  city: text,
  country: text,
  latitude: 'phone',
  longitude: 'phone',
  latitudeLoose: 'phone',
  longitudeLoose: 'phone',
  unnamed: {
    first: 'token',
    second: 'token',
    third: text,
    fourth: text,
    fifth: text,
    sixth: text,
    seventh: text,
  },
  meetingAt: text,
  markerIcon: text,
  markerColor: text,
  markerUrl: 'token',
  postalcode: 'phone',
  geoLat: 'phone',
  geoLng: 'phone',
};

// Every field of an appointment in `base` of a list and directly in
// `appointment` of a single read (F37).
const appointmentShape: Readonly<Record<string, Shape>> = {
  id: text,
  title: text,
  subtitle: text,
  address: addressShape,
  version: text,
  calendar: calendarShape,
  description: text,
  image: 'token',
  link: 'token',
  isInternal: text,
  startDate: 'phone',
  endDate: 'phone',
  allDay: text,
  repeatId: text,
  repeatFrequency: text,
  repeatUntil: 'phone',
  repeatOption: text,
  additionals: [text],
  exceptions: [text],
  signup: text,
  onBehalfOfPid: text,
  meta,
  unnamed: { first: text, second: text, third: text, fourth: text },
  caption: text,
  note: text,
  information: text,
  additions: [text],
};

const calculatedShape: Readonly<Record<string, Shape>> = {
  startDate: 'phone',
  endDate: 'phone',
  iCalUid: 'token',
};

// An appointment without the fields it keeps in a list and in a single
// read, so that the values of the test hide no canary. Of the calendar and
// the place it keeps one field each, planted on their own.
const keptAppointmentShape: Readonly<Record<string, Shape>> = drop(
  appointmentShape,
  'id',
  'title',
  'subtitle',
  'allDay',
  'calendar',
  'address',
);

/** An appointment of a list as a test gives it to {@link appointmentsAnswer}. */
export interface AppointmentFixture extends Omit<
  AppointmentEntry,
  'calendarId'
> {
  /** The ID of the calendar, or another value ChurchTools sends instead. */
  readonly calendarId: number | string;
}

// The kept fields of an appointment over its planted ones. A place of null
// is sent as null; a place with a name keeps every other field of it.
const keptAppointment = (
  appointment: Omit<AppointmentFixture, 'startDate' | 'endDate'>,
  shape: Readonly<Record<string, Shape>>,
  path: string,
  made: Map<string, Canary>,
): Record<string, unknown> =>
  over(plant(shape, path, made), {
    id: appointment.id,
    title: appointment.title,
    subtitle: appointment.subtitle,
    allDay: appointment.allDay,
    calendar: over(plant(drop(calendarShape, 'id'), `${path}.calendar`, made), {
      id: appointment.calendarId,
    }),
    address:
      appointment.locationName === null
        ? null
        : over(plant(drop(addressShape, 'name'), `${path}.address`, made), {
            name: appointment.locationName,
          }),
  }) as Record<string, unknown>;

/**
 * Builds an answer of `GET /api/calendars/appointments`: each entry with
 * `appointment.base`, whose ID, title, subtitle, whole days, calendar ID
 * and name of the place come from the appointments given, and
 * `appointment.calculated` with their start and end, every other field a
 * canary: the whole calendar but its ID, the place but its name, and the
 * copies `base` and `calculated` above `appointment`, also the count in
 * `meta`.
 *
 * @param appointments - The appointments, in the order of the answer.
 * @returns The body and the canaries planted in it.
 * @example
 * ```ts
 * const answer = appointmentsAnswer([{ id: 5, calendarId: 8, title: 'Termin', subtitle: null,
 *   allDay: false, locationName: null, startDate: '2026-10-30T18:00:00Z', endDate: '2026-10-30T19:00:00Z' }]);
 * ```
 */
export function appointmentsAnswer(
  appointments: readonly AppointmentFixture[],
): HighestLevelAnswer {
  const made = new Map<string, Canary>();
  const data = appointments.map((appointment) => ({
    appointment: {
      base: keptAppointment(
        appointment,
        keptAppointmentShape,
        'entry.appointment.base',
        made,
      ),
      calculated: over(
        plant(
          drop(calculatedShape, 'startDate', 'endDate'),
          'entry.appointment.calculated',
          made,
        ),
        { startDate: appointment.startDate, endDate: appointment.endDate },
      ),
    },
    unnamed: plant({ first: text, second: text }, 'entry.unnamed', made),
    base: plant(appointmentShape, 'entry.base', made),
    calculated: plant(calculatedShape, 'entry.calculated', made),
  }));
  return answer(data, made, plant({ count: 'phone' }, 'meta', made));
}

/** A date of one appointment as a test gives it. */
export interface AppointmentDateFixture {
  /** The key ChurchTools gives the date, whose form is not known. */
  readonly key: string;
  /** The start. */
  readonly startDate: string;
  /** The end. */
  readonly endDate: string;
}

/** One appointment as a test gives it to {@link appointmentAnswer}. */
export interface AppointmentDetailsFixture extends Omit<
  AppointmentDetails,
  'calendarId' | 'dates'
> {
  /** The ID of the calendar, or another value ChurchTools sends instead. */
  readonly calendarId: number | string;
  /** The dates, in the order of the answer. */
  readonly dates: readonly AppointmentDateFixture[];
}

/**
 * Builds an answer of `GET /api/calendars/{calendarId}/appointments/{appointmentId}`:
 * the fields of `base` directly in `appointment`, ID, title, subtitle,
 * whole days, calendar ID, name of the place, description and link from
 * the appointment given, `calculatedDates` with the dates given under
 * their keys, every other field a canary, also the start and end of the
 * appointment itself, `iCalUid` of each date and `additionalInfos`.
 *
 * @param appointment - The fields the read passes on, and the dates.
 * @returns The body and the canaries planted in it.
 * @example
 * ```ts
 * const answer = appointmentAnswer({ ...entry, description: null, link: null,
 *   dates: [{ key: '0', startDate: '2026-10-30T18:00:00Z', endDate: '2026-10-30T19:00:00Z' }] });
 * ```
 */
export function appointmentAnswer(
  appointment: AppointmentDetailsFixture,
): HighestLevelAnswer {
  const made = new Map<string, Canary>();
  const kept = keptAppointment(
    appointment,
    drop(keptAppointmentShape, 'description', 'link'),
    'appointment',
    made,
  );
  const calculatedDates = Object.fromEntries(
    appointment.dates.map((date) => [
      date.key,
      over(plant(drop(calculatedShape, 'startDate', 'endDate'), 'date', made), {
        startDate: date.startDate,
        endDate: date.endDate,
      }),
    ]),
  );
  return answer(
    {
      appointment: {
        ...kept,
        description: appointment.description,
        link: appointment.link,
      },
      additionalInfos: plant([text], 'additionalInfos', made),
      calculatedDates,
    },
    made,
  );
}

/**
 * Builds an answer of `GET /api/calendars`: each entry with every field of
 * a calendar, ID, name and whether public or private from the calendars
 * given, every other field a canary, also `randomUrl` and the count in
 * `meta`.
 *
 * @param calendars - The calendars, in the order of the answer.
 * @returns The body and the canaries planted in it.
 * @example
 * ```ts
 * const answer = calendarsAnswer([{ id: 8, name: 'Kalender A', isPublic: false, isPrivate: false }]);
 * ```
 */
export function calendarsAnswer(
  calendars: readonly Calendar[],
): HighestLevelAnswer {
  const made = new Map<string, Canary>();
  const shape = drop(calendarShape, 'id', 'name', 'isPublic', 'isPrivate');
  const data = calendars.map((calendar) => ({
    ...(plant(shape, 'entry', made) as Record<string, unknown>),
    id: calendar.id,
    name: calendar.name,
    isPublic: calendar.isPublic,
    isPrivate: calendar.isPrivate,
  }));
  return answer(data, made, plant({ count: 'phone' }, 'meta', made));
}

// The fields of a resource and of a type of resources that the probe could
// not name, with dates and IDs of persons in the forms of `meta` (F37).
const unnamedMeta: Shape = {
  first: 'phone',
  second: { first: text },
  third: 'phone',
  fourth: { first: text },
};

// Every field of a resource (F37).
const resourceShape: Readonly<Record<string, Shape>> = {
  id: text,
  name: text,
  nameTranslated: text,
  sortKey: text,
  resourceTypeId: text,
  location: text,
  iCalLocation: text,
  description: text,
  isAutoAccept: text,
  needsAppointment: text,
  isVirtual: text,
  adminIds: [text],
  randomString: 'token',
  unnamed: unnamedMeta,
  unnamedSecond: { first: text },
  doesRequireCalEntry: text,
};

// Every field of a type of resources (F37).
const resourceTypeShape: Readonly<Record<string, Shape>> = {
  id: text,
  name: text,
  nameTranslated: text,
  sortKey: text,
  namePlural: text,
  namePluralTranslated: text,
  campusId: text,
  unnamed: unnamedMeta,
};

/**
 * Builds an answer of `GET /api/resources`: each entry with every field of
 * a resource, ID, name and type from the resources given, every other
 * field a canary, also `randomString`, `adminIds` and the count in `meta`.
 *
 * @param resources - The resources, in the order of the answer.
 * @returns The body and the canaries planted in it.
 * @example
 * ```ts
 * const answer = resourcesAnswer([{ id: 8, name: 'Raum A', resourceTypeId: 5 }]);
 * ```
 */
export function resourcesAnswer(
  resources: readonly Resource[],
): HighestLevelAnswer {
  const made = new Map<string, Canary>();
  const shape = drop(resourceShape, 'id', 'name', 'resourceTypeId');
  const data = resources.map((resource) => ({
    ...(plant(shape, 'entry', made) as Record<string, unknown>),
    id: resource.id,
    name: resource.name,
    resourceTypeId: resource.resourceTypeId,
  }));
  return answer(data, made, plant({ count: 'phone' }, 'meta', made));
}

/**
 * Builds an answer of `GET /api/resourcetypes`: each entry with every field
 * of a type of resources, ID and name from the types given, every other
 * field a canary, also the count in `meta`.
 *
 * @param types - The types, in the order of the answer.
 * @returns The body and the canaries planted in it.
 * @example
 * ```ts
 * const answer = resourceTypesAnswer([{ id: 5, name: 'Räume' }]);
 * ```
 */
export function resourceTypesAnswer(
  types: readonly ResourceType[],
): HighestLevelAnswer {
  const made = new Map<string, Canary>();
  const shape = drop(resourceTypeShape, 'id', 'name');
  const data = types.map((type) => ({
    ...(plant(shape, 'entry', made) as Record<string, unknown>),
    id: type.id,
    name: type.name,
  }));
  return answer(data, made, plant({ count: 'phone' }, 'meta', made));
}

// Every field of a booking in `base` (F37), with the person who answered
// it and the whole resource booked.
const bookingShape: Readonly<Record<string, Shape>> = {
  id: text,
  title: text,
  subtitle: text,
  resourceId: text,
  statusId: text,
  description: text,
  unnamed: { first: text, second: text, third: text },
  onBehalfOfPid: text,
  answeredPid: text,
  answeredDate: 'phone',
  showInCal: text,
  version: text,
  startDate: 'phone',
  endDate: 'phone',
  allDay: text,
  repeatId: text,
  repeatFrequency: text,
  repeatUntil: 'phone',
  repeatOption: text,
  additionals: [text],
  exceptions: [text],
  meta,
  unnamedSecond: {
    first: text,
    second: text,
    third: text,
    fourth: text,
    fifth: text,
  },
  caption: text,
  location: text,
  resource: resourceShape,
  note: text,
  appointmentId: text,
  isAnonymized: text,
};

/** A booking as a test gives it to {@link bookingsAnswer}. */
export interface BookingFixture extends Omit<BookingEntry, 'appointmentId'> {
  /**
   * The ID of the appointment as ChurchTools sends it; left out of the
   * answer when undefined.
   */
  readonly appointmentId?: number | null;
}

/**
 * Builds an answer of `GET /api/bookings`: each entry with `booking.base`,
 * whose ID, title, resource, state and appointment come from the bookings
 * given, and `booking.calculated` with their start and end, every other
 * field a canary: the person who answered, the whole resource, caption,
 * the start and end in `base` and the three keys above `booking`, one of
 * them a copy of `base`, also the count in `meta`.
 *
 * @param bookings - The bookings, in the order of the answer.
 * @returns The body and the canaries planted in it.
 * @example
 * ```ts
 * const answer = bookingsAnswer([{ id: 2, title: 'Buchung', resourceId: 8, statusId: 2,
 *   appointmentId: 5, startDate: '2026-10-30T18:00:00Z', endDate: '2026-10-30T19:00:00Z' }]);
 * ```
 */
export function bookingsAnswer(
  bookings: readonly BookingFixture[],
): HighestLevelAnswer {
  const made = new Map<string, Canary>();
  const shape = drop(
    bookingShape,
    'id',
    'title',
    'resourceId',
    'statusId',
    'appointmentId',
  );
  const data = bookings.map((booking) => ({
    booking: {
      base: {
        ...(plant(shape, 'entry.booking.base', made) as Record<
          string,
          unknown
        >),
        id: booking.id,
        title: booking.title,
        resourceId: booking.resourceId,
        statusId: booking.statusId,
        ...(booking.appointmentId === undefined
          ? {}
          : { appointmentId: booking.appointmentId }),
      },
      calculated: { startDate: booking.startDate, endDate: booking.endDate },
    },
    unnamed: plant({ first: text, second: text }, 'entry.unnamed', made),
    unnamedBase: plant(bookingShape, 'entry.unnamedBase', made),
    unnamedThird: plant({ first: text, second: text }, 'entry.third', made),
  }));
  return answer(data, made, plant({ count: 'phone' }, 'meta', made));
}
