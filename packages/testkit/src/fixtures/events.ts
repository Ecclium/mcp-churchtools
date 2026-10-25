/**
 * Answers of events, agendas and services in the form ChurchTools gives
 * them, for the tests of the reads of events, agendas, services and
 * assignments (ADR 0064). Every field a read does not pass on holds a
 * canary, so a test can show that no layer lets one of them through. The
 * fields kept take the values the test gives.
 *
 * The names of the fields are those of the answers of ChurchTools 3.137, as
 * `09-domains-read` described them (`docs/research/churchtools-api.md`,
 * F37): 17 fields of an event, an assignment with the person assigned and
 * the person who requested it, 11 fields of an agenda, 23 fields of a
 * service and 9 of a group of services. The values are not those types:
 * every value outside the kept ones is a canary text. The client drops the
 * other fields by their names, not by their types. Where the probe could
 * not name a key, `unnamed` stands in for it.
 *
 * @packageDocumentation
 */
import type {
  AgendaItem,
  EventDetails,
  EventEntry,
  ServiceGroup,
} from '@ecclium/mcp-churchtools-plugin-api';

import { type Canary, type CanaryKind } from '../canary.js';
import {
  answer,
  drop,
  type HighestLevelAnswer,
  meta,
  over,
  personAttributes,
  personReference,
  plant,
  type Shape,
} from './highest-level.js';

const text: CanaryKind = 'name';

// A calendar as an event names it, a reference of a domain (F37).
const calendarReference: Readonly<Record<string, Shape>> = {
  title: text,
  domainType: text,
  domainIdentifier: text,
  apiUrl: 'token',
  frontendUrl: 'token',
  icon: text,
  domainAttributes: { campusName: text },
};

// One assignment to a service, with the person assigned and the person who
// requested it, both with names (F37).
const assignmentShape: Readonly<Record<string, Shape>> = {
  id: text,
  personId: text,
  person: personReference,
  name: text,
  serviceId: text,
  isAccepted: text,
  isValid: text,
  requestedDate: 'phone',
  requesterPersonId: text,
  requesterPerson: personReference,
  event: text,
  comment: text,
  index: text,
  allowChat: text,
  permissions: { edit: text },
  agreed: text,
  counter: text,
  unnamed: { first: text, second: text },
};

// Every field of an event (F37).
const eventShape: Readonly<Record<string, Shape>> = {
  id: text,
  guid: 'token',
  name: text,
  note: text,
  appointmentId: text,
  startDate: 'phone',
  endDate: 'phone',
  chatStatus: text,
  isCanceled: text,
  adminIds: [text],
  description: text,
  eventAdminIds: [text],
  permissions: { write: text },
  calendar: calendarReference,
  eventFiles: [{ title: text, url: 'token' }],
  eventServices: [assignmentShape],
  unnamed: text,
};

// The fields an event keeps in a list and in a single read, so that the
// values of the test hide no canary.
const keptEventFields = [
  'id',
  'name',
  'startDate',
  'endDate',
  'isCanceled',
] as const;

// The calendar of an event without the two fields an event keeps.
const keptCalendarShape: Readonly<Record<string, Shape>> = drop(
  calendarReference,
  'domainIdentifier',
  'title',
);

// An event in the list: the list carries no assignments without `include`.
const listEventShape: Readonly<Record<string, Shape>> = {
  ...drop(eventShape, 'eventServices', 'calendar', ...keptEventFields),
  calendar: keptCalendarShape,
};

/** An event as a test gives it to {@link eventsAnswer}. */
export interface EventFixture extends Omit<EventEntry, 'calendarId'> {
  /** The ID of the calendar, or the text ChurchTools sends in its place. */
  readonly calendarId: number | string;
}

const keptEvent = (event: EventFixture): Record<string, unknown> => ({
  id: event.id,
  name: event.name,
  startDate: event.startDate,
  endDate: event.endDate,
  isCanceled: event.isCanceled,
  calendar: {
    domainIdentifier:
      typeof event.calendarId === 'number'
        ? String(event.calendarId)
        : event.calendarId,
    title: event.calendarName,
  },
});

/**
 * Builds an answer of `GET /api/events`: each entry with every field of an
 * event but the assignments, ID, name, start, end, whether it is canceled
 * and the ID and name of its calendar from the events given, every other
 * field a canary, also note, description and the count in `meta`.
 *
 * @param events - The events, in the order of the answer.
 * @returns The body and the canaries planted in it.
 * @example
 * ```ts
 * const answer = eventsAnswer([{ id: 2, name: 'Gottesdienst', startDate: '2026-10-25T09:00:00Z',
 *   endDate: '2026-10-25T10:30:00Z', isCanceled: false, calendarId: 8, calendarName: 'Kalender A' }]);
 * ```
 */
export function eventsAnswer(
  events: readonly EventFixture[],
): HighestLevelAnswer {
  const made = new Map<string, Canary>();
  const data = events.map((event) =>
    over(plant(listEventShape, 'entry', made), keptEvent(event)),
  );
  return answer(data, made, plant({ count: 'phone' }, 'meta', made));
}

/** An event with note and description, as a test gives it. */
export interface EventDetailsFixture extends Omit<EventDetails, 'calendarId'> {
  /** The ID of the calendar, or the text ChurchTools sends in its place. */
  readonly calendarId: number | string;
}

const singleEventShape: Readonly<Record<string, Shape>> = {
  ...drop(eventShape, ...keptEventFields, 'calendar', 'note', 'description'),
  calendar: keptCalendarShape,
};

/**
 * Builds an answer of `GET /api/events/{eventId}` for the read of one event:
 * every field of an event, ID, name, start, end, whether it is canceled,
 * the calendar, note and description from the event given, every other
 * field a canary, also each field of its one assignment.
 *
 * @param event - The fields the read passes on. A note or description of
 *   `null` is sent as `null`.
 * @returns The body and the canaries planted in it.
 * @example
 * ```ts
 * const answer = eventAnswer({ ...entry, note: null, description: 'Text' });
 * ```
 */
export function eventAnswer(event: EventDetailsFixture): HighestLevelAnswer {
  const made = new Map<string, Canary>();
  return answer(
    over(plant(singleEventShape, 'event', made), {
      ...keptEvent(event),
      note: event.note,
      description: event.description,
    }),
    made,
  );
}

/** An assignment to a service, as a test gives it. */
export interface AssignmentFixture {
  /** The ID of the service. */
  readonly serviceId: number;
  /** Whether the person accepted. */
  readonly isAccepted: boolean;
  /** Whether the assignment is agreed. */
  readonly agreed: boolean;
  /** The ID of the person, as ChurchTools sends it. */
  readonly personId: number | null;
  /** The first name, empty when ChurchTools hides it. */
  readonly firstName: string;
  /** The last name, or the placeholder ChurchTools sends in its place. */
  readonly lastName: string;
}

// The event around assignments: every field but the assignments holds a
// canary, so that nothing of the event reaches the assignments.
const assignmentsEventShape: Readonly<Record<string, Shape>> = drop(
  eventShape,
  'eventServices',
);

const keptAssignmentShape: Readonly<Record<string, Shape>> = {
  ...drop(
    assignmentShape,
    'personId',
    'person',
    'serviceId',
    'isAccepted',
    'agreed',
  ),
  person: {
    ...drop(personReference, 'domainAttributes'),
    domainAttributes: drop(personAttributes, 'firstName', 'lastName'),
  },
};

/**
 * Builds an answer of `GET /api/events/{eventId}` for the assignments: each
 * assignment with every field, the service, both states, the ID of the
 * person and its names in `person.domainAttributes` from the assignments
 * given, every other field a canary, also the person who requested it and
 * every field of the event.
 *
 * @param assignments - The assignments, in the order of the answer.
 * @returns The body and the canaries planted in it.
 * @example
 * ```ts
 * const answer = eventAssignmentsAnswer([{ serviceId: 11, isAccepted: true, agreed: true,
 *   personId: 1, firstName: 'Person', lastName: 'A' }]);
 * ```
 */
export function eventAssignmentsAnswer(
  assignments: readonly AssignmentFixture[],
): HighestLevelAnswer {
  const made = new Map<string, Canary>();
  const event = plant(assignmentsEventShape, 'event', made) as Record<
    string,
    unknown
  >;
  const eventServices = assignments.map((assignment) =>
    over(plant(keptAssignmentShape, 'assignment', made), {
      serviceId: assignment.serviceId,
      isAccepted: assignment.isAccepted,
      agreed: assignment.agreed,
      personId: assignment.personId,
      person: {
        domainAttributes: {
          firstName: assignment.firstName,
          lastName: assignment.lastName,
        },
      },
    }),
  );
  return answer({ ...event, eventServices }, made);
}

// An item of an agenda (F37). The probe saw only empty lists of persons
// responsible for an item, so their shape is that of other references.
const itemShape: Readonly<Record<string, Shape>> = {
  id: text,
  title: text,
  type: text,
  duration: text,
  start: 'phone',
  startTimes: ['phone'],
  isBeforeEvent: text,
  position: text,
  note: text,
  responsible: { text, persons: [personReference] },
  serviceGroupNotes: [{ serviceGroupId: text, note: text }],
  unnamed: { first: text },
};

const songShape: Readonly<Record<string, Shape>> = {
  songId: text,
  arrangementId: text,
  title: text,
  arrangement: text,
  category: text,
  key: text,
  bpm: text,
  isDefault: text,
};

const keptItemFields = [
  'position',
  'type',
  'title',
  'start',
  'duration',
  'isBeforeEvent',
  'note',
] as const;

// Every field of an agenda (F37).
const agendaShape: Readonly<Record<string, Shape>> = {
  id: text,
  name: text,
  series: text,
  isLocked: text,
  eventStartPosition: text,
  calendarId: text,
  total: text,
  meta,
  isFinal: text,
  items: [itemShape],
  unnamed: { first: text },
};

/**
 * Builds an answer of `GET /api/events/{eventId}/agenda`: every field of an
 * agenda, name and whether it is final from the values given, each item
 * with every field, the fields an item keeps and its song from the items
 * given, every other field a canary, also the persons responsible for an
 * item, the notes of the groups of services and the key and tempo of a
 * song. An item without a song carries none.
 *
 * @param agenda - Name, whether final, and the items, in order.
 * @param agenda.name - Name of the agenda.
 * @param agenda.isFinal - Whether it is final.
 * @param agenda.items - The items.
 * @returns The body and the canaries planted in it.
 * @example
 * ```ts
 * const answer = agendaAnswer({ name: 'Ablauf', isFinal: false, items: [] });
 * ```
 */
export function agendaAnswer(agenda: {
  readonly name: string;
  readonly isFinal: boolean;
  readonly items: readonly AgendaItem[];
}): HighestLevelAnswer {
  const made = new Map<string, Canary>();
  const planted = plant(
    drop(agendaShape, 'name', 'isFinal', 'items'),
    'agenda',
    made,
  ) as Record<string, unknown>;
  const items = agenda.items.map((item) => {
    const kept: Record<string, unknown> = Object.fromEntries(
      keptItemFields.map((field) => [field, item[field]]),
    );
    const base = plant(drop(itemShape, ...keptItemFields), 'item', made);
    if (item.song === null) return over(base, kept);
    return over(base, {
      ...kept,
      song: over(
        plant(
          drop(songShape, 'songId', 'arrangementId', 'title', 'arrangement'),
          'song',
          made,
        ),
        item.song,
      ),
    });
  });
  return answer(
    { ...planted, name: agenda.name, isFinal: agenda.isFinal, items },
    made,
  );
}

/** A service as a test gives it to {@link servicesAnswer}. */
export interface ServiceFixture {
  /** The ID of the service. */
  readonly id: number;
  /** Name of the service. */
  readonly name: string;
  /** The ID of its group of services. */
  readonly serviceGroupId: number;
  /** Whether it hides the names of the persons assigned to it. */
  readonly hidePersonName: boolean;
}

// Every field of a service (F37).
const serviceShape: Readonly<Record<string, Shape>> = {
  id: text,
  name: text,
  nameTranslated: text,
  sortKey: text,
  description: text,
  serviceGroupId: text,
  standard: text,
  hidePersonName: text,
  calTextTemplate: text,
  allowDecline: text,
  allowExchange: text,
  allowCommentOnConfirmation: text,
  allowControlLiveAgenda: text,
  allowChat: text,
  sendReminderMails: text,
  sendServiceRequestEmails: text,
  onlyAssignFromGroups: text,
  groupIds: [text],
  tagIds: [text],
  meta,
  commentOnConfirmation: text,
  comment: text,
  unnamed: { first: text, second: text },
};

// Every field of a group of services (F37).
const serviceGroupShape: Readonly<Record<string, Shape>> = {
  id: text,
  name: text,
  sortKey: text,
  description: text,
  campusId: text,
  viewAll: text,
  onlyVisibleInCampusFilter: text,
  meta,
  unnamed: text,
};

/**
 * Builds an answer of `GET /api/services`: each entry with every field of a
 * service, ID, name, group and `hidePersonName` from the services given,
 * every other field a canary, also the count in `meta`.
 *
 * @param services - The services, in the order of the answer.
 * @returns The body and the canaries planted in it.
 * @example
 * ```ts
 * const answer = servicesAnswer([{ id: 11, name: 'Dienst A', serviceGroupId: 5, hidePersonName: false }]);
 * ```
 */
export function servicesAnswer(
  services: readonly ServiceFixture[],
): HighestLevelAnswer {
  const made = new Map<string, Canary>();
  const shape = drop(
    serviceShape,
    'id',
    'name',
    'serviceGroupId',
    'hidePersonName',
  );
  const data = services.map((service) => ({
    ...(plant(shape, 'entry', made) as Record<string, unknown>),
    id: service.id,
    name: service.name,
    serviceGroupId: service.serviceGroupId,
    hidePersonName: service.hidePersonName,
  }));
  return answer(data, made, plant({ count: 'phone' }, 'meta', made));
}

/**
 * Builds an answer of `GET /api/servicegroups`: each entry with every field
 * of a group of services, ID and name from the groups given, every other
 * field a canary, also the count in `meta`.
 *
 * @param groups - The groups, in the order of the answer.
 * @returns The body and the canaries planted in it.
 * @example
 * ```ts
 * const answer = serviceGroupsAnswer([{ id: 5, name: 'Dienstgruppe A' }]);
 * ```
 */
export function serviceGroupsAnswer(
  groups: readonly ServiceGroup[],
): HighestLevelAnswer {
  const made = new Map<string, Canary>();
  const shape = drop(serviceGroupShape, 'id', 'name');
  const data = groups.map((group) => ({
    ...(plant(shape, 'entry', made) as Record<string, unknown>),
    id: group.id,
    name: group.name,
  }));
  return answer(data, made, plant({ count: 'phone' }, 'meta', made));
}
