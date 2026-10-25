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
