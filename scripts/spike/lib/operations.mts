/**
 * The operations of the ChurchTools API that the spike looks at.
 *
 * The paths follow the public OpenAPI document of ChurchTools. Before a
 * probe calls one, it looks it up by method and path in the document of
 * the instance itself. If the instance does not document it, a reading
 * probe reports that and calls nothing, and a probe of the write account
 * stops. Only the write probes call the write operations, through the
 * client the guard of the test environment hands out (ADR 0049).
 *
 * The operations on persons, groups and search are marked `personal`:
 * their answers carry personal data. So are those on events, agendas,
 * services, appointments, bookings, songs and the search of the wiki: an
 * event names who serves, an appointment or a booking who made it, a song
 * who changed it. The general client refuses every path below
 * {@link personalPrefixes}. Only the guard for personal data hands out a
 * client that reaches them, and only to the probes that read persons and
 * the domains on the test instance (ADR 0049).
 *
 * @packageDocumentation
 */
import type { Method } from './spec.mts';

/** One operation: method and path template with `{}` for parameters. */
export interface OperationTemplate {
  readonly method: Method;
  readonly template: string;
  /** Set for operations whose answers carry personal data. */
  readonly personal?: true;
}

/** Where every ChurchTools instance publishes its OpenAPI document. */
export const specificationPath = '/system/runtime/swagger/openapi.json';

/** The operations the spike needs, by the name the output uses. */
export const operations = {
  info: { method: 'get', template: '/api/info' },
  whoami: { method: 'get', template: '/api/whoami' },
  permissionsGlobal: { method: 'get', template: '/api/permissions/global' },
  wikiPages: { method: 'get', template: '/api/wiki/pages' },
  wikiCategories: { method: 'get', template: '/api/wiki/categories' },
  wikiCategoryPages: {
    method: 'get',
    template: '/api/wiki/categories/{}/pages',
  },
  wikiPage: { method: 'get', template: '/api/wiki/categories/{}/pages/{}' },
  wikiPageVersions: {
    method: 'get',
    template: '/api/wiki/categories/{}/pages/{}/versions',
  },
  wikiPageVersion: {
    method: 'get',
    template: '/api/wiki/categories/{}/pages/{}/versions/{}',
  },
  wikiPageCreate: {
    method: 'post',
    template: '/api/wiki/categories/{}/pages',
  },
  wikiPageUpdate: {
    method: 'patch',
    template: '/api/wiki/categories/{}/pages/{}',
  },
  wikiPageDelete: {
    method: 'delete',
    template: '/api/wiki/categories/{}/pages/{}',
  },
  persons: { method: 'get', template: '/api/persons', personal: true },
  person: { method: 'get', template: '/api/persons/{}', personal: true },
  personGroups: {
    method: 'get',
    template: '/api/persons/{}/groups',
    personal: true,
  },
  groups: { method: 'get', template: '/api/groups', personal: true },
  group: { method: 'get', template: '/api/groups/{}', personal: true },
  groupMembers: {
    method: 'get',
    template: '/api/groups/{}/members',
    personal: true,
  },
  search: { method: 'get', template: '/api/search', personal: true },
  calendars: { method: 'get', template: '/api/calendars' },
  calendarAppointments: {
    method: 'get',
    template: '/api/calendars/appointments',
    personal: true,
  },
  calendarAppointment: {
    method: 'get',
    template: '/api/calendars/{}/appointments/{}',
    personal: true,
  },
  events: { method: 'get', template: '/api/events', personal: true },
  event: { method: 'get', template: '/api/events/{}', personal: true },
  eventAgenda: {
    method: 'get',
    template: '/api/events/{}/agenda',
    personal: true,
  },
  eventAgendaSongs: {
    method: 'get',
    template: '/api/events/{}/agenda/songs',
    personal: true,
  },
  services: { method: 'get', template: '/api/services', personal: true },
  serviceGroups: { method: 'get', template: '/api/servicegroups' },
  resourceTypes: { method: 'get', template: '/api/resourcetypes' },
  resources: { method: 'get', template: '/api/resources' },
  bookings: { method: 'get', template: '/api/bookings', personal: true },
  songs: { method: 'get', template: '/api/songs', personal: true },
  song: { method: 'get', template: '/api/songs/{}', personal: true },
  songArrangements: {
    method: 'get',
    template: '/api/songs/{}/arrangements',
    personal: true,
  },
  wikiSearch: { method: 'get', template: '/api/wiki/search', personal: true },
} as const satisfies Readonly<Record<string, OperationTemplate>>;

/** The name of one operation. */
export type OperationName = keyof typeof operations;

/**
 * The paths below which answers carry personal data. Every operation
 * marked `personal` lies below one of them. As in the templates, `{}`
 * stands for one segment of the path: the appointments lie below each
 * calendar, while the list of calendars itself names no person.
 */
export const personalPrefixes = [
  '/api/persons',
  '/api/groups',
  '/api/search',
  '/api/events',
  '/api/services',
  '/api/bookings',
  '/api/songs',
  '/api/wiki/search',
  '/api/calendars/appointments',
  '/api/calendars/{}/appointments',
] as const;

/** One operation of the seed, with the query parameters it always sends. */
export interface SeedOperationTemplate extends OperationTemplate {
  /**
   * Fixed query parameters. The client sends exactly these and no others,
   * and the guard first checks that the instance declares each of them.
   */
  readonly query?: readonly (readonly [string, string])[];
}

/**
 * The operations of the seed of the test instance beyond {@link operations}
 * (ADR 0061). The seed reads the lists below to find the objects it made,
 * and writes only with the operations in {@link seedWriteOperations}, through
 * the client its guard hands out. `operations` stays as it is, so
 * 00-inventory reports the same as before.
 *
 * Deleting an event takes `sendMail=false`, so that a reset of the
 * synthetic data sends no mail to anybody.
 */
export const seedOperations = {
  groupTypes: { method: 'get', template: '/api/group/grouptypes' },
  songCategories: { method: 'get', template: '/api/song/categories' },
  calendarAppointmentList: {
    method: 'get',
    template: '/api/calendars/{}/appointments',
    personal: true,
  },
  groupTypeCreate: { method: 'post', template: '/api/group/grouptypes' },
  calendarCreate: { method: 'post', template: '/api/calendars' },
  resourceTypeCreate: { method: 'post', template: '/api/resourcetypes' },
  resourceCreate: { method: 'post', template: '/api/resources' },
  serviceGroupCreate: { method: 'post', template: '/api/servicegroups' },
  serviceCreate: { method: 'post', template: '/api/services' },
  songCategoryCreate: { method: 'post', template: '/api/song/categories' },
  wikiCategoryCreate: { method: 'post', template: '/api/wiki/categories' },
  personCreate: { method: 'post', template: '/api/persons', personal: true },
  groupCreate: { method: 'post', template: '/api/groups', personal: true },
  groupMemberAdd: {
    method: 'put',
    template: '/api/groups/{}/members/{}',
    personal: true,
  },
  groupMemberRemove: {
    method: 'delete',
    template: '/api/groups/{}/members/{}',
    personal: true,
  },
  appointmentCreate: {
    method: 'post',
    template: '/api/calendars/{}/appointments',
    personal: true,
  },
  appointmentDelete: {
    method: 'delete',
    template: '/api/calendars/{}/appointments/{}',
    personal: true,
  },
  bookingCreate: { method: 'post', template: '/api/bookings', personal: true },
  bookingDelete: {
    method: 'delete',
    template: '/api/bookings/{}',
    personal: true,
  },
  serviceRequestAssign: {
    method: 'put',
    template: '/api/events/{}/servicerequests/{}',
    personal: true,
  },
  serviceRequestAccept: {
    method: 'post',
    template: '/api/events/{}/servicerequests/{}/accept',
    personal: true,
  },
  agendaCreate: {
    method: 'put',
    template: '/api/events/{}/agenda',
    personal: true,
  },
  agendaItemCreate: {
    method: 'post',
    template: '/api/events/{}/agenda/items',
    personal: true,
  },
  eventDelete: {
    method: 'delete',
    template: '/api/events/{}',
    personal: true,
    query: [['sendMail', 'false']],
  },
  songCreate: { method: 'post', template: '/api/songs', personal: true },
  songDelete: { method: 'delete', template: '/api/songs/{}', personal: true },
  arrangementCreate: {
    method: 'post',
    template: '/api/songs/{}/arrangements',
    personal: true,
  },
  wikiPageCreate: operations.wikiPageCreate,
  wikiPageDelete: operations.wikiPageDelete,
} as const satisfies Readonly<Record<string, SeedOperationTemplate>>;

/** The name of one operation of the seed. */
export type SeedOperationName = keyof typeof seedOperations;

/** The operations of the seed that write: every one that is not a GET. */
export const seedWriteOperations = [
  'groupTypeCreate',
  'calendarCreate',
  'resourceTypeCreate',
  'resourceCreate',
  'serviceGroupCreate',
  'serviceCreate',
  'songCategoryCreate',
  'wikiCategoryCreate',
  'personCreate',
  'groupCreate',
  'groupMemberAdd',
  'groupMemberRemove',
  'appointmentCreate',
  'appointmentDelete',
  'bookingCreate',
  'bookingDelete',
  'serviceRequestAssign',
  'serviceRequestAccept',
  'agendaCreate',
  'agendaItemCreate',
  'eventDelete',
  'songCreate',
  'songDelete',
  'arrangementCreate',
  'wikiPageCreate',
  'wikiPageDelete',
] as const satisfies readonly SeedOperationName[];

/** One write operation of the seed. */
export type SeedWriteOperation = (typeof seedWriteOperations)[number];
