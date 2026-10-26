/**
 * The reading ChurchTools client (ADR 0057): `whoami`, `permissions`, the
 * searches of persons and groups by name (ADR 0060), one person, the
 * groups of a person, one group and its members, the events of a span of
 * days, one event, its agenda and its assignments, and the services
 * (ADR 0064), and the wiki, each with exactly one request through the
 * transport of its origin, the services and the assignments with two, a
 * throttle per client, fixed limits and own schemas.
 *
 * @packageDocumentation
 */
import {
  type Agenda,
  type AppointmentDate,
  type AppointmentDetails,
  type AppointmentEntry,
  type AppointmentList,
  type Assignment,
  type AssignmentList,
  assignmentsPageLimit,
  type BookingEntry,
  type BookingList,
  type Calendar,
  type Clock,
  EccliumError,
  type EventDetails,
  type EventEntry,
  type EventList,
  type Group,
  type GroupHit,
  type GroupMemberList,
  groupMembersPageLimit,
  isEventWindow,
  isListIds,
  isWikiPageGuid,
  maxAppointments,
  maxAssignmentsPage,
  maxBookings,
  maxEventDays,
  maxEvents,
  maxGroupMembersPage,
  maxListIds,
  maxPersonGroups,
  maxSearchHits,
  maxSearchTermLength,
  maxWikiListPage,
  type Me,
  normalizeSearchTerm,
  type Permissions,
  type Person,
  type PersonGroupList,
  type PersonHit,
  type ResourceList,
  type SearchHits,
  type Service,
  type ServiceList,
  type TenantContext,
  type WikiCategory,
  wikiPageListLimit,
  type WikiPage,
  type WikiPageList,
} from '@ecclium/mcp-churchtools-plugin-api';

import { type HttpTransport, parseChurchToolsOrigin } from '../http/index.js';
import { createRequestThrottle } from '../throttle/index.js';
import {
  appendIds,
  appendLimit,
  appendPage,
  appendSpan,
  urlOfPath,
} from './query.js';
import { fetchAnswer, type RequestPath } from './request.js';
import { toPermissions } from './rights.js';
import {
  agendaSchema,
  appointmentListSchema,
  appointmentSchema,
  bookingListSchema,
  calendarListSchema,
  eventAssignmentsSchema,
  eventListSchema,
  eventSchema,
  eventsRequestLimit,
  groupListSchema,
  groupMemberListSchema,
  groupSchema,
  personGroupListSchema,
  personListSchema,
  personSchema,
  resourceListSchema,
  resourceTypeListSchema,
  searchPageLimit,
  serviceGroupListSchema,
  serviceListSchema,
  whoamiSchema,
  wikiCategoryListSchema,
  wikiPageListSchema,
  wikiPageSchema,
} from './schemas.js';

/** What a client is built from. */
export interface ChurchToolsClientOptions {
  /** The transport of the origin, built by the composition root. */
  readonly transport: HttpTransport;
  /** The canonical origin of the instance, the same as the transport's. */
  readonly origin: string;
  /** Requests per minute, from the configuration. */
  readonly requestsPerMinute: number;
  /** The clock of the throttle. */
  readonly clock: Clock;
}

/** The reading client of one ChurchTools instance. */
export interface ChurchToolsClient {
  /**
   * Reads the account of the server, only if ChurchTools accepted the token.
   *
   * @throws {EccliumError} `auth` for an anonymous answer, and every error of
   *   the request.
   */
  whoami(ctx: TenantContext): Promise<Me>;
  /**
   * Reads the rights of the account of the server. It proves no sign-in;
   * only `whoami` does.
   *
   * @throws {EccliumError} Every error of the request.
   */
  permissions(ctx: TenantContext): Promise<Permissions>;
  /**
   * Searches persons by name with `GET /api/persons`, sending only `query`,
   * `page=1` and `limit=51` (ADR 0060).
   *
   * @throws {EccliumError} `validation` for a term that is not a search
   *   term, before the throttle and any request; `upstream` for an entry
   *   without ID or name, or more than 51 entries; every error of the
   *   request.
   */
  searchPersons(
    ctx: TenantContext,
    query: string,
  ): Promise<SearchHits<PersonHit>>;
  /**
   * Searches groups by name with `GET /api/groups`, sending only `query`,
   * `page=1` and `limit=51` (ADR 0060).
   *
   * @throws {EccliumError} As {@link ChurchToolsClient.searchPersons}.
   */
  searchGroups(
    ctx: TenantContext,
    query: string,
  ): Promise<SearchHits<GroupHit>>;
  /**
   * Reads one person with `GET /api/persons/{personId}`, by its numeric ID
   * only (ADR 0064).
   *
   * @throws {EccliumError} `validation` for an ID that is no whole number
   *   from 1, before the throttle and any request; `permission` for 403;
   *   `not_found` for 404; `upstream` for an answer without the four
   *   fields; every error of the request.
   */
  person(ctx: TenantContext, personId: number): Promise<Person>;
  /**
   * Reads the groups of one person with `GET /api/persons/{personId}/groups`,
   * without any parameter (ADR 0064).
   *
   * @throws {EccliumError} As {@link ChurchToolsClient.person}, and
   *   `upstream` for more than 1000 groups.
   */
  personGroups(ctx: TenantContext, personId: number): Promise<PersonGroupList>;
  /**
   * Reads one group with `GET /api/groups/{groupId}`, by its numeric ID
   * only (ADR 0064).
   *
   * @throws {EccliumError} As {@link ChurchToolsClient.person}, and
   *   `upstream` for a part of the details of the lowest level.
   */
  group(ctx: TenantContext, groupId: number): Promise<Group>;
  /**
   * Reads one page of the members of a group with
   * `GET /api/groups/{groupId}/members`, sending only `page` and
   * `limit=50`, never `personFields[]` or `include` (ADR 0064).
   *
   * @throws {EccliumError} `validation` for an ID that is no whole number
   *   from 1 or a page outside 1 to 1000, before the throttle and any
   *   request; otherwise as {@link ChurchToolsClient.person}.
   */
  groupMembers(
    ctx: TenantContext,
    groupId: number,
    page: number,
  ): Promise<GroupMemberList>;
  /**
   * Lists the categories of the wiki with `GET /api/wiki/categories`, all
   * of them from the one answer.
   *
   * @throws {EccliumError} `upstream` for a category without ID or name,
   *   or more than 1000; every error of the request.
   */
  wikiCategories(ctx: TenantContext): Promise<readonly WikiCategory[]>;
  /**
   * Lists one page of the pages of a category with `GET /api/wiki/pages`,
   * sending only the category in `wiki_category_ids[]`, `page` and
   * `limit=25`.
   *
   * @throws {EccliumError} `validation` for an ID or page that is no whole
   *   number from 1, before the throttle and any request; `upstream` for
   *   an entry that does not fit; every error of the request.
   */
  wikiPages(
    ctx: TenantContext,
    categoryId: number,
    page: number,
  ): Promise<WikiPageList>;
  /**
   * Reads one page of the wiki by its GUID, in its newest version or, with
   * `version`, in exactly that one. F19 shows the route of one version for
   * the newest version of a page; an older one is not yet shown.
   *
   * @throws {EccliumError} `validation` for an ID, GUID or version that does
   *   not fit, before the throttle and any request; `not_found` for a page
   *   or version that does not exist; `upstream` for an answer that does
   *   not fit, also another version than asked for; every error of the
   *   request.
   */
  wikiPage(
    ctx: TenantContext,
    categoryId: number,
    guid: string,
    version?: number,
  ): Promise<WikiPage>;
  /**
   * Lists the events of a span of days with `GET /api/events`, sending only
   * `from`, `to` and `limit=51`, never `include`, `direction` or `canceled`
   * (ADR 0064). The events are sorted by start and ID, and at most 50 pass.
   *
   * @throws {EccliumError} `validation` for a span that does not fit, before
   *   the throttle and any request; `upstream` for an entry that does not
   *   fit or more than 1000 entries; every error of the request.
   */
  events(ctx: TenantContext, from: string, to: string): Promise<EventList>;
  /**
   * Reads one event with `GET /api/events/{eventId}`, by its numeric ID
   * only, with note and description and never its assignments (ADR 0064).
   *
   * @throws {EccliumError} `validation` for an ID that is no whole number
   *   from 1, before the throttle and any request; `permission` for 403;
   *   `not_found` for 404; `upstream` for an answer that does not fit;
   *   every error of the request.
   */
  event(ctx: TenantContext, eventId: number): Promise<EventDetails>;
  /**
   * Reads the agenda of one event with `GET /api/events/{eventId}/agenda`,
   * without the persons responsible for its items (ADR 0064).
   *
   * @throws {EccliumError} As {@link ChurchToolsClient.event}.
   */
  eventAgenda(ctx: TenantContext, eventId: number): Promise<Agenda>;
  /**
   * Reads the services with `GET /api/services` and the groups of services
   * with `GET /api/servicegroups`, each sorted by ID (ADR 0064).
   *
   * @throws {EccliumError} `upstream` for an entry that does not fit or more
   *   than 1000 entries; every error of the requests.
   */
  services(ctx: TenantContext): Promise<ServiceList>;
  /**
   * Reads one page of the assignments of one event with
   * `GET /api/events/{eventId}`, only `eventServices`, and the services with
   * `GET /api/services`, and names the person of an assignment only where
   * the service lets it (ADR 0064): without `hidePersonName`, with the
   * service in the list, with a whole number from 1 as ID of the person
   * and with a last name. The groups of services are not read.
   *
   * @throws {EccliumError} `validation` for an ID or page that does not
   *   fit, before the throttle and any request; otherwise as
   *   {@link ChurchToolsClient.event}, and `upstream` for services that do
   *   not fit.
   */
  eventAssignments(
    ctx: TenantContext,
    eventId: number,
    page: number,
  ): Promise<AssignmentList>;
  /**
   * Reads the calendars with `GET /api/calendars`, sorted by ID, never
   * `randomUrl` (ADR 0064).
   *
   * @throws {EccliumError} `upstream` for an entry that does not fit or more
   *   than 1000 entries; every error of the request.
   */
  calendars(ctx: TenantContext): Promise<readonly Calendar[]>;
  /**
   * Lists the appointments of a span of days in up to 10 calendars with
   * `GET /api/calendars/appointments`, sending only `calendar_ids[]`,
   * `from` and `to`, never `include[]` or `query` (ADR 0064). The entries,
   * one for each date, are sorted by start and ID, and at most 50 pass.
   *
   * @throws {EccliumError} `validation` for IDs or a span that do not fit,
   *   before the throttle and any request; `permission` for 403; `upstream`
   *   for an entry that does not fit or more than 1000 entries; every error
   *   of the request.
   */
  appointments(
    ctx: TenantContext,
    calendarIds: readonly number[],
    from: string,
    to: string,
  ): Promise<AppointmentList>;
  /**
   * Reads one appointment with
   * `GET /api/calendars/{calendarId}/appointments/{appointmentId}`, by the
   * numeric IDs only, with description, link and its dates sorted by start
   * (ADR 0064).
   *
   * @throws {EccliumError} `validation` for an ID that is no whole number
   *   from 1, before the throttle and any request; `permission` for 403;
   *   `not_found` for 404; `upstream` for an answer that does not fit;
   *   every error of the request.
   */
  appointment(
    ctx: TenantContext,
    calendarId: number,
    appointmentId: number,
  ): Promise<AppointmentDetails>;
  /**
   * Reads the resources with `GET /api/resources` and the types of
   * resources with `GET /api/resourcetypes`, each sorted by ID (ADR 0064).
   *
   * @throws {EccliumError} `upstream` for an entry that does not fit or more
   *   than 1000 entries; every error of the requests.
   */
  resources(ctx: TenantContext): Promise<ResourceList>;
  /**
   * Lists the bookings of a span of days of up to 10 resources with
   * `GET /api/bookings`, sending only `resource_ids[]`, `from` and `to`,
   * never `include[]`, `query`, `person_id` or `status_ids[]` (ADR 0064).
   * The bookings are sorted by start and ID, and at most 50 pass.
   *
   * @throws {EccliumError} As {@link ChurchToolsClient.appointments}.
   */
  bookings(
    ctx: TenantContext,
    resourceIds: readonly number[],
    from: string,
    to: string,
  ): Promise<BookingList>;
}

const whoamiLimits = Object.freeze({
  maxResponseBytes: 256 * 1024,
  maxElements: 5_000,
});

const permissionsLimits = Object.freeze({
  maxResponseBytes: 1024 * 1024,
  maxElements: 200_000,
});

// A search reads 51 entries. The limits fit them in the form of the highest
// security level, with every field of a person or a group: an account with
// more rights than the search needs still gets its hits, and the client
// drops the other fields (ADR 0060).
const searchLimits = Object.freeze({
  maxResponseBytes: 1024 * 1024,
  maxElements: 100_000,
});

// One person or one group, in the form of the highest security level with
// every field, and a group with many roles: an account with more rights
// than the read needs still gets its answer, and the client drops the
// other fields (ADR 0064).
const objectLimits = Object.freeze({
  maxResponseBytes: 1024 * 1024,
  maxElements: 20_000,
});

// Each membership carries objects of the group and the person with about
// 50 fields; the limits fit 1000 groups of a person with them.
const personGroupsLimits = Object.freeze({
  maxResponseBytes: 4 * 1024 * 1024,
  maxElements: 200_000,
});

// One page of 50 members, each with the objects of its group and person,
// also with fields a request with personFields[] would add.
const groupMembersLimits = Object.freeze({
  maxResponseBytes: 1024 * 1024,
  maxElements: 50_000,
});

// Each entry of the list of pages carries objects of the persons who
// created and last changed the page, which the client drops. The limits
// fit 1000 categories and 25 pages with them.
const wikiListLimits = Object.freeze({
  maxResponseBytes: 1024 * 1024,
  maxElements: 100_000,
});

// A page carries its whole text; a tool passes it on in parts.
const wikiPageLimits = Object.freeze({
  maxResponseBytes: 4 * 1024 * 1024,
  maxElements: 20_000,
});

// The list of events: the answer may hold more entries than asked for,
// because whether limit cuts it is not shown (F38). The limits fit 1000
// events with every field but the assignments.
const eventListLimits = Object.freeze({
  maxResponseBytes: 4 * 1024 * 1024,
  maxElements: 200_000,
});

// One event with all its assignments, which carry the person assigned and
// the person who requested it, and one agenda with all its items: the
// limits fit 500 of them with every field.
const eventLimits = Object.freeze({
  maxResponseBytes: 2 * 1024 * 1024,
  maxElements: 100_000,
});

// The services or the groups of services, each list in one answer with
// every field: the limits fit 1000 entries.
const serviceLimits = Object.freeze({
  maxResponseBytes: 4 * 1024 * 1024,
  maxElements: 200_000,
});

// The calendars, the resources or the types of resources, each list in one
// answer with every field: the limits fit 1000 entries.
const catalogLimits = Object.freeze({
  maxResponseBytes: 4 * 1024 * 1024,
  maxElements: 200_000,
});

// The appointments or bookings of a span, which take no limit (F35): each
// entry carries the whole calendar or resource, the place and a copy of
// its fields, which the client drops. The limits fit 1000 entries with
// them, within the most the transport takes.
const spanListLimits = Object.freeze({
  maxResponseBytes: 8 * 1024 * 1024,
  maxElements: 400_000,
});

// One appointment with its whole calendar and place and up to 500 dates.
const appointmentLimits = Object.freeze({
  maxResponseBytes: 1024 * 1024,
  maxElements: 20_000,
});

// In English for the model; printable ASCII, like every message (ADR 0054).
const invalidCalendarInput = `A calendar ID, an appointment ID and a resource ID are whole numbers from 1, a list names 1 to ${String(maxListIds)} calendars or resources, each once, and a span runs from one day to another as YYYY-MM-DD, at most ${String(maxEventDays)} days with both ends.`;

// In English for the model; printable ASCII, like every message (ADR 0054).
const invalidEventInput = `An event ID is a whole number from 1, a page of the assignments of an event is a whole number from 1 to ${String(maxAssignmentsPage)}, and a span of events runs from one day to another as YYYY-MM-DD, at most ${String(maxEventDays)} days with both ends.`;

// In English for the model; printable ASCII, like every message (ADR 0054).
const invalidWikiInput = `A category ID and a version are whole numbers from 1, a page of the list is a whole number from 1 to ${String(maxWikiListPage)}, and a wiki page is addressed by its GUID.`;

// In English for the model; printable ASCII, like every message (ADR 0054).
const invalidReadInput = `A person ID and a group ID are whole numbers from 1, and a page of the members of a group is a whole number from 1 to ${String(maxGroupMembersPage)}.`;

// The identifier of a group in a membership, a text such as "12". Only a
// whole number from 1 in its plain form counts as the ID of the group.
const groupIdentifier = /^[1-9][0-9]{0,15}$/;

const groupIdOf = (identifier: string): number | null => {
  if (!groupIdentifier.test(identifier)) return null;
  const value = Number(identifier);
  return Number.isSafeInteger(value) ? value : null;
};

// In English for the model; printable ASCII, like every message (ADR 0054).
const invalidTerm = `The search term needs 1 to ${String(maxSearchTermLength)} characters after removing spaces at both ends, and no control characters.`;

/** The fixed events of one search. */
interface SearchEvents {
  /** A term that is not a search term. */
  readonly term: string;
  /** An answer with a status other than 200. */
  readonly status: string;
  /** An answer with status 200 that is not read. */
  readonly refused: string;
}

const personEvents: SearchEvents = Object.freeze({
  term: 'churchtools_persons_term_refused',
  status: 'churchtools_persons_status',
  refused: 'churchtools_persons_refused',
});

const groupEvents: SearchEvents = Object.freeze({
  term: 'churchtools_groups_term_refused',
  status: 'churchtools_groups_status',
  refused: 'churchtools_groups_refused',
});

// The hits of a search: at most maxSearchHits, and whether a further
// visible entry came. Frozen, without prototype, built from the read
// fields only.
const toHits = <Hit>(entries: readonly Hit[]): SearchHits<Hit> =>
  Object.freeze({
    __proto__: null,
    hits: Object.freeze(entries.slice(0, maxSearchHits)),
    more: entries.length > maxSearchHits,
  });

const isWholeFromOne = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

const isPlain = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// An event of a list or a single read, built from the read fields only.
const toEventEntry = (entry: {
  readonly id: number;
  readonly name: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly isCanceled: boolean;
  readonly calendar: {
    readonly domainIdentifier: string;
    readonly title: string;
  };
}): EventEntry =>
  Object.freeze({
    __proto__: null,
    id: entry.id,
    name: entry.name,
    startDate: entry.startDate,
    endDate: entry.endDate,
    isCanceled: entry.isCanceled,
    // The same rule as for the identifier of a group (ADR 0064).
    calendarId: groupIdOf(entry.calendar.domainIdentifier),
    calendarName: entry.calendar.title,
  });

// Sorts entries of a span by their start, then by ID, so that the same
// answer always gives the same list. A day alone sorts before the times of
// that day, as text.
const byStartAndId = <Entry extends { startDate: string; id: number }>(
  a: Entry,
  b: Entry,
): number =>
  (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0) ||
  a.id - b.id;

// The fields an appointment keeps in a list and a single read, built from
// the read fields only.
const appointmentFieldsOf = (base: {
  readonly id: number;
  readonly title: string;
  readonly subtitle?: string | null | undefined;
  readonly allDay: boolean;
  readonly calendar: { readonly id: number };
  readonly address?: { readonly name?: string | null | undefined } | null;
}): Omit<AppointmentEntry, 'startDate' | 'endDate'> => ({
  id: base.id,
  calendarId: base.calendar.id,
  title: base.title,
  subtitle: base.subtitle ?? null,
  allDay: base.allDay,
  locationName: base.address?.name ?? null,
});

/**
 * Builds the client of one origin. Exactly one client exists per origin, so
 * that all its requests share one throttle.
 *
 * @param options - Transport, origin, rate and clock.
 * @returns The client, frozen. Its only state is the throttle.
 * @throws {TypeError} When the origin is not canonical or the rate is not
 *   a whole number from 1.
 * @example
 * ```ts
 * const client = createChurchToolsClient({ transport, origin, requestsPerMinute: 300, clock });
 * const me = await client.whoami(ctx);
 * ```
 */
export function createChurchToolsClient(
  options: ChurchToolsClientOptions,
): ChurchToolsClient {
  const { transport, origin, requestsPerMinute, clock } = options;
  const checked = parseChurchToolsOrigin(origin);
  if (!checked.ok || checked.origin !== origin) {
    throw new TypeError('The origin of a client must be canonical.');
  }
  const path: RequestPath = Object.freeze({
    origin,
    transport,
    throttle: createRequestThrottle({ requestsPerMinute, clock }),
  });

  const whoami = async (ctx: TenantContext): Promise<Me> => {
    const url = new URL('/api/whoami', origin);
    url.searchParams.append('only_allow_authenticated', 'true');
    const root = await fetchAnswer(ctx, path, url, whoamiLimits, {
      status: 'churchtools_whoami_status',
      refused: 'churchtools_whoami_refused',
    });
    // The anonymous person first: its answer is not known beyond guid and
    // firstName, so the full schema would refuse it as upstream.
    const data = root.data;
    if (!isPlain(data)) {
      ctx.log.warn('churchtools_whoami_refused', { code: 'upstream' });
      throw new EccliumError('upstream');
    }
    const meta = root.meta;
    const simulating =
      isPlain(meta) &&
      Object.hasOwn(meta, 'simulatingUserId') &&
      meta.simulatingUserId !== null &&
      meta.simulatingUserId !== undefined;
    if (data.guid === '' || simulating) {
      ctx.log.warn('churchtools_whoami_anonymous', { code: 'auth' });
      throw new EccliumError('auth');
    }
    const parsed = whoamiSchema.safeParse(root);
    if (!parsed.success) {
      ctx.log.warn('churchtools_whoami_refused', { code: 'upstream' });
      throw new EccliumError('upstream');
    }
    const person = parsed.data.data;
    return Object.freeze({
      __proto__: null,
      id: person.id,
      firstName: person.firstName,
      lastName: person.lastName,
      email:
        person.email === undefined ||
        person.email === null ||
        person.email === ''
          ? null
          : person.email,
    });
  };

  const permissions = async (ctx: TenantContext): Promise<Permissions> => {
    const url = new URL('/api/permissions/global', origin);
    const root = await fetchAnswer(ctx, path, url, permissionsLimits, {
      status: 'churchtools_permissions_status',
      refused: 'churchtools_permissions_refused',
    });
    const result = toPermissions(root.data);
    if (result.kind === 'unknown') {
      ctx.log.warn('churchtools_permissions_unknown', {});
    }
    return result;
  };

  // Sends one search and returns the root of its answer. The term is
  // checked before the throttle gives a place: an invalid one costs no
  // request and no place. Exactly query, page and limit go out, nothing a
  // caller chooses beyond the term (ADR 0060).
  const fetchSearch = async (
    ctx: TenantContext,
    pathname: '/api/persons' | '/api/groups',
    query: unknown,
    events: SearchEvents,
  ): Promise<Readonly<Record<string, unknown>>> => {
    const term = normalizeSearchTerm(query);
    if (term === undefined) {
      ctx.log.warn(events.term, { code: 'validation' });
      throw new EccliumError('validation', invalidTerm);
    }
    const url = new URL(pathname, origin);
    url.searchParams.append('query', term);
    appendPage(url.searchParams, 1, searchPageLimit);
    return fetchAnswer(ctx, path, url, searchLimits, events);
  };

  const searchPersons = async (
    ctx: TenantContext,
    query: string,
  ): Promise<SearchHits<PersonHit>> => {
    const root = await fetchSearch(ctx, '/api/persons', query, personEvents);
    const parsed = personListSchema.safeParse(root);
    if (!parsed.success) {
      ctx.log.warn(personEvents.refused, { code: 'upstream' });
      throw new EccliumError('upstream');
    }
    return toHits(
      parsed.data.data.map((entry): PersonHit =>
        Object.freeze({
          __proto__: null,
          id: entry.id,
          firstName: entry.firstName,
          lastName: entry.lastName,
        }),
      ),
    );
  };

  const searchGroups = async (
    ctx: TenantContext,
    query: string,
  ): Promise<SearchHits<GroupHit>> => {
    const root = await fetchSearch(ctx, '/api/groups', query, groupEvents);
    const parsed = groupListSchema.safeParse(root);
    if (!parsed.success) {
      ctx.log.warn(groupEvents.refused, { code: 'upstream' });
      throw new EccliumError('upstream');
    }
    return toHits(
      parsed.data.data.map((entry): GroupHit =>
        Object.freeze({ __proto__: null, id: entry.id, name: entry.name }),
      ),
    );
  };

  // Refuses an ID or page that may not fill a path or a query before the
  // throttle gives a place, so that an invalid value costs no request.
  // Only a checked whole number fills a path, and the built URL must keep
  // exactly that path (ADR 0057).
  const checkReadInput = (ctx: TenantContext, valid: boolean): void => {
    if (valid) return;
    ctx.log.warn('churchtools_read_input_refused', { code: 'validation' });
    throw new EccliumError('validation', invalidReadInput);
  };

  const person = async (
    ctx: TenantContext,
    personId: number,
  ): Promise<Person> => {
    checkReadInput(ctx, isWholeFromOne(personId));
    const url = urlOfPath(origin, `/api/persons/${String(personId)}`);
    const root = await fetchAnswer(ctx, path, url, objectLimits, {
      status: 'churchtools_person_status',
      refused: 'churchtools_person_refused',
      missing: 'churchtools_person_missing',
    });
    const parsed = personSchema.safeParse(root);
    if (!parsed.success) {
      ctx.log.warn('churchtools_person_refused', { code: 'upstream' });
      throw new EccliumError('upstream');
    }
    const data = parsed.data.data;
    return Object.freeze({
      __proto__: null,
      id: data.id,
      firstName: data.firstName,
      lastName: data.lastName,
      isArchived: data.isArchived,
    });
  };

  const personGroups = async (
    ctx: TenantContext,
    personId: number,
  ): Promise<PersonGroupList> => {
    checkReadInput(ctx, isWholeFromOne(personId));
    // Without show_overdue_groups and the other switches, so the list holds
    // what ChurchTools shows without them (ADR 0064).
    const url = urlOfPath(origin, `/api/persons/${String(personId)}/groups`);
    const root = await fetchAnswer(ctx, path, url, personGroupsLimits, {
      status: 'churchtools_person_groups_status',
      refused: 'churchtools_person_groups_refused',
      missing: 'churchtools_person_groups_missing',
    });
    const parsed = personGroupListSchema.safeParse(root);
    if (!parsed.success) {
      ctx.log.warn('churchtools_person_groups_refused', { code: 'upstream' });
      throw new EccliumError('upstream');
    }
    const entries = parsed.data.data;
    return Object.freeze({
      __proto__: null,
      groups: Object.freeze(
        entries.slice(0, maxPersonGroups).map((entry) =>
          Object.freeze({
            __proto__: null,
            groupId: groupIdOf(entry.group.domainIdentifier),
            groupName: entry.group.title,
            groupTypeRoleId: entry.groupTypeRoleId,
            groupMemberStatus: entry.groupMemberStatus,
          }),
        ),
      ),
      more: entries.length > maxPersonGroups,
    });
  };

  const group = async (ctx: TenantContext, groupId: number): Promise<Group> => {
    checkReadInput(ctx, isWholeFromOne(groupId));
    const url = urlOfPath(origin, `/api/groups/${String(groupId)}`);
    const root = await fetchAnswer(ctx, path, url, objectLimits, {
      status: 'churchtools_group_status',
      refused: 'churchtools_group_refused',
      missing: 'churchtools_group_missing',
    });
    const parsed = groupSchema.safeParse(root);
    if (!parsed.success) {
      ctx.log.warn('churchtools_group_refused', { code: 'upstream' });
      throw new EccliumError('upstream');
    }
    const data = parsed.data.data;
    const details = data.information;
    // The schema takes the details all together or not at all, so one
    // missing field means none came.
    return Object.freeze({
      __proto__: null,
      id: data.id,
      name: data.name,
      details:
        details.meetingTime === undefined
          ? null
          : Object.freeze({
              __proto__: null,
              meetingTime: details.meetingTime,
              note: details.note ?? null,
              maxMembers: details.maxMembers ?? null,
              targetGroupId: details.targetGroupId ?? null,
              dateOfFoundation: details.dateOfFoundation ?? null,
              endDate: details.endDate ?? null,
            }),
    });
  };

  const groupMembers = async (
    ctx: TenantContext,
    groupId: number,
    page: number,
  ): Promise<GroupMemberList> => {
    checkReadInput(
      ctx,
      isWholeFromOne(groupId) &&
        isWholeFromOne(page) &&
        page <= maxGroupMembersPage,
    );
    const url = urlOfPath(origin, `/api/groups/${String(groupId)}/members`);
    appendPage(url.searchParams, page, groupMembersPageLimit);
    const root = await fetchAnswer(ctx, path, url, groupMembersLimits, {
      status: 'churchtools_group_members_status',
      refused: 'churchtools_group_members_refused',
      missing: 'churchtools_group_members_missing',
    });
    const parsed = groupMemberListSchema.safeParse(root);
    if (!parsed.success) {
      ctx.log.warn('churchtools_group_members_refused', { code: 'upstream' });
      throw new EccliumError('upstream');
    }
    return Object.freeze({
      __proto__: null,
      members: Object.freeze(
        parsed.data.data.map((entry) =>
          Object.freeze({
            __proto__: null,
            personId: entry.personId,
            firstName: entry.person.domainAttributes.firstName,
            lastName: entry.person.domainAttributes.lastName,
            groupTypeRoleId: entry.groupTypeRoleId,
            groupMemberStatus: entry.groupMemberStatus,
          }),
        ),
      ),
      more: page < (parsed.data.meta?.pagination?.lastPage ?? 0),
    });
  };

  // Refuses what may not fill a path or a query before the throttle gives
  // a place, so that an invalid value costs no request.
  const checkWikiInput = (ctx: TenantContext, valid: boolean): void => {
    if (valid) return;
    ctx.log.warn('churchtools_wiki_input_refused', { code: 'validation' });
    throw new EccliumError('validation', invalidWikiInput);
  };

  const wikiCategories = async (
    ctx: TenantContext,
  ): Promise<readonly WikiCategory[]> => {
    const url = new URL('/api/wiki/categories', origin);
    const root = await fetchAnswer(ctx, path, url, wikiListLimits, {
      status: 'churchtools_wiki_categories_status',
      refused: 'churchtools_wiki_categories_refused',
    });
    const parsed = wikiCategoryListSchema.safeParse(root);
    if (!parsed.success) {
      ctx.log.warn('churchtools_wiki_categories_refused', {
        code: 'upstream',
      });
      throw new EccliumError('upstream');
    }
    return Object.freeze(
      parsed.data.data.map((entry) =>
        Object.freeze({ __proto__: null, id: entry.id, name: entry.name }),
      ),
    );
  };

  const wikiPages = async (
    ctx: TenantContext,
    categoryId: number,
    page: number,
  ): Promise<WikiPageList> => {
    checkWikiInput(
      ctx,
      isWholeFromOne(categoryId) &&
        isWholeFromOne(page) &&
        page <= maxWikiListPage,
    );
    const url = new URL('/api/wiki/pages', origin);
    appendIds(url.searchParams, 'wiki_category_ids[]', [categoryId]);
    appendPage(url.searchParams, page, wikiPageListLimit);
    const root = await fetchAnswer(ctx, path, url, wikiListLimits, {
      status: 'churchtools_wiki_pages_status',
      refused: 'churchtools_wiki_pages_refused',
    });
    const parsed = wikiPageListSchema.safeParse(root);
    if (!parsed.success) {
      ctx.log.warn('churchtools_wiki_pages_refused', { code: 'upstream' });
      throw new EccliumError('upstream');
    }
    return Object.freeze({
      __proto__: null,
      pages: Object.freeze(
        parsed.data.data.map((entry) =>
          Object.freeze({
            __proto__: null,
            guid: entry.guid,
            title: entry.title,
            isMarkdown: entry.isMarkdown,
            version: entry.version,
          }),
        ),
      ),
      more: page < parsed.data.meta.pagination.lastPage,
    });
  };

  const wikiPage = async (
    ctx: TenantContext,
    categoryId: number,
    guid: string,
    version?: number,
  ): Promise<WikiPage> => {
    checkWikiInput(
      ctx,
      isWholeFromOne(categoryId) &&
        isWikiPageGuid(guid) &&
        (version === undefined || isWholeFromOne(version)),
    );
    // Only checked values fill the path: a whole number, a GUID and, for
    // one version, a whole number. The built URL must have exactly that
    // path and no query (ADR 0057).
    const page = `/api/wiki/categories/${String(categoryId)}/pages/${guid}`;
    const pathname =
      version === undefined ? page : `${page}/versions/${String(version)}`;
    const url = urlOfPath(origin, pathname);
    const root = await fetchAnswer(ctx, path, url, wikiPageLimits, {
      status: 'churchtools_wiki_page_status',
      refused: 'churchtools_wiki_page_refused',
      missing: 'churchtools_wiki_page_missing',
    });
    const parsed = wikiPageSchema.safeParse(root);
    if (
      !parsed.success ||
      (version !== undefined && parsed.data.data.version !== version)
    ) {
      ctx.log.warn('churchtools_wiki_page_refused', { code: 'upstream' });
      throw new EccliumError('upstream');
    }
    const data = parsed.data.data;
    return Object.freeze({
      __proto__: null,
      guid,
      title: data.title,
      isMarkdown: data.isMarkdown,
      version: data.version,
      text: data.text ?? '',
    });
  };

  // Refuses a span or an ID that may not fill a query or a path before the
  // throttle gives a place, so that an invalid value costs no request.
  const checkEventInput = (ctx: TenantContext, valid: boolean): void => {
    if (valid) return;
    ctx.log.warn('churchtools_event_input_refused', { code: 'validation' });
    throw new EccliumError('validation', invalidEventInput);
  };

  const events = async (
    ctx: TenantContext,
    from: string,
    to: string,
  ): Promise<EventList> => {
    checkEventInput(ctx, isEventWindow(from, to));
    // Exactly from, to and limit go out (ADR 0064).
    const url = new URL('/api/events', origin);
    appendSpan(url.searchParams, from, to);
    appendLimit(url.searchParams, eventsRequestLimit);
    const root = await fetchAnswer(ctx, path, url, eventListLimits, {
      status: 'churchtools_events_status',
      refused: 'churchtools_events_refused',
    });
    const parsed = eventListSchema.safeParse(root);
    if (!parsed.success) {
      ctx.log.warn('churchtools_events_refused', { code: 'upstream' });
      throw new EccliumError('upstream');
    }
    // Sorted before the cut, so that the same answer always gives the same
    // events, also when ChurchTools sends more or in another order.
    const entries = parsed.data.data
      .map((entry) => toEventEntry(entry))
      .sort(
        (a, b) =>
          (a.startDate < b.startDate
            ? -1
            : a.startDate > b.startDate
              ? 1
              : 0) || a.id - b.id,
      );
    return Object.freeze({
      __proto__: null,
      events: Object.freeze(entries.slice(0, maxEvents)),
      more: entries.length > maxEvents,
    });
  };

  const event = async (
    ctx: TenantContext,
    eventId: number,
  ): Promise<EventDetails> => {
    checkEventInput(ctx, isWholeFromOne(eventId));
    const url = urlOfPath(origin, `/api/events/${String(eventId)}`);
    const root = await fetchAnswer(ctx, path, url, eventLimits, {
      status: 'churchtools_event_status',
      refused: 'churchtools_event_refused',
      missing: 'churchtools_event_missing',
    });
    const parsed = eventSchema.safeParse(root);
    if (!parsed.success) {
      ctx.log.warn('churchtools_event_refused', { code: 'upstream' });
      throw new EccliumError('upstream');
    }
    const data = parsed.data.data;
    return Object.freeze({
      __proto__: null,
      ...toEventEntry(data),
      note: data.note ?? null,
      description: data.description ?? null,
    });
  };

  const eventAgenda = async (
    ctx: TenantContext,
    eventId: number,
  ): Promise<Agenda> => {
    checkEventInput(ctx, isWholeFromOne(eventId));
    const url = urlOfPath(origin, `/api/events/${String(eventId)}/agenda`);
    const root = await fetchAnswer(ctx, path, url, eventLimits, {
      status: 'churchtools_agenda_status',
      refused: 'churchtools_agenda_refused',
      missing: 'churchtools_agenda_missing',
    });
    const parsed = agendaSchema.safeParse(root);
    if (!parsed.success) {
      ctx.log.warn('churchtools_agenda_refused', { code: 'upstream' });
      throw new EccliumError('upstream');
    }
    const data = parsed.data.data;
    return Object.freeze({
      __proto__: null,
      name: data.name ?? '',
      isFinal: data.isFinal,
      items: Object.freeze(
        data.items.map((item) =>
          Object.freeze({
            __proto__: null,
            position: item.position,
            type: item.type,
            title: item.title ?? '',
            start: item.start ?? null,
            duration: item.duration ?? null,
            isBeforeEvent: item.isBeforeEvent,
            note: item.note ?? null,
            song:
              item.song === undefined || item.song === null
                ? null
                : Object.freeze({
                    __proto__: null,
                    songId: item.song.songId,
                    arrangementId: item.song.arrangementId ?? null,
                    title: item.song.title,
                    arrangement: item.song.arrangement ?? null,
                  }),
          }),
        ),
      ),
    });
  };

  // The services alone, sorted by ID: the assignments need only them.
  const serviceList = async (
    ctx: TenantContext,
  ): Promise<readonly Service[]> => {
    const servicesRoot = await fetchAnswer(
      ctx,
      path,
      new URL('/api/services', origin),
      serviceLimits,
      {
        status: 'churchtools_services_status',
        refused: 'churchtools_services_refused',
      },
    );
    const parsedServices = serviceListSchema.safeParse(servicesRoot);
    if (!parsedServices.success) {
      ctx.log.warn('churchtools_services_refused', { code: 'upstream' });
      throw new EccliumError('upstream');
    }
    return Object.freeze(
      [...parsedServices.data.data]
        .sort((a, b) => a.id - b.id)
        .map((entry) =>
          Object.freeze({
            __proto__: null,
            id: entry.id,
            name: entry.name,
            serviceGroupId: entry.serviceGroupId,
            hidesNames: entry.hidePersonName,
          }),
        ),
    );
  };

  const services = async (ctx: TenantContext): Promise<ServiceList> => {
    const listed = await serviceList(ctx);
    const groupsRoot = await fetchAnswer(
      ctx,
      path,
      new URL('/api/servicegroups', origin),
      serviceLimits,
      {
        status: 'churchtools_service_groups_status',
        refused: 'churchtools_service_groups_refused',
      },
    );
    const parsedGroups = serviceGroupListSchema.safeParse(groupsRoot);
    if (!parsedGroups.success) {
      ctx.log.warn('churchtools_service_groups_refused', { code: 'upstream' });
      throw new EccliumError('upstream');
    }
    return Object.freeze({
      __proto__: null,
      services: listed,
      serviceGroups: Object.freeze(
        [...parsedGroups.data.data]
          .sort((a, b) => a.id - b.id)
          .map((entry) =>
            Object.freeze({ __proto__: null, id: entry.id, name: entry.name }),
          ),
      ),
    });
  };

  const eventAssignments = async (
    ctx: TenantContext,
    eventId: number,
    page: number,
  ): Promise<AssignmentList> => {
    checkEventInput(
      ctx,
      isWholeFromOne(eventId) &&
        isWholeFromOne(page) &&
        page <= maxAssignmentsPage,
    );
    const url = urlOfPath(origin, `/api/events/${String(eventId)}`);
    const root = await fetchAnswer(ctx, path, url, eventLimits, {
      status: 'churchtools_event_assignments_status',
      refused: 'churchtools_event_assignments_refused',
      missing: 'churchtools_event_assignments_missing',
    });
    const parsed = eventAssignmentsSchema.safeParse(root);
    if (!parsed.success) {
      ctx.log.warn('churchtools_event_assignments_refused', {
        code: 'upstream',
      });
      throw new EccliumError('upstream');
    }
    // The services say which hide the names of the persons assigned. The
    // core reads them itself, so that no tool ever sees such a name
    // (ADR 0064).
    const byId = new Map(
      (await serviceList(ctx)).map((entry) => [entry.id, entry]),
    );
    // ChurchTools gives every assignment with the event; the core pages
    // through them, so that every page counts against the read budget.
    const all = parsed.data.data.eventServices;
    const first = (page - 1) * assignmentsPageLimit;
    const shown = all.slice(first, first + assignmentsPageLimit);
    const assignments = shown.map((entry): Assignment => {
      const service = byId.get(entry.serviceId);
      const attributes = entry.person?.domainAttributes;
      // Only a service that shows names, an ID from 1 and a last name let
      // the person through; a placeholder of a hidden name has an ID
      // below 1 (F37).
      const named =
        service !== undefined &&
        !service.hidesNames &&
        isWholeFromOne(entry.personId) &&
        typeof attributes?.lastName === 'string';
      return Object.freeze({
        __proto__: null,
        serviceId: entry.serviceId,
        serviceName: service?.name ?? null,
        isAccepted: entry.isAccepted,
        agreed: entry.agreed,
        person: named
          ? Object.freeze({
              __proto__: null,
              personId: entry.personId as number,
              firstName: attributes.firstName ?? '',
              lastName: attributes.lastName as string,
            })
          : null,
      });
    });
    return Object.freeze({
      __proto__: null,
      assignments: Object.freeze(assignments),
      more: all.length > first + assignmentsPageLimit,
    });
  };

  // A value that does not fit ends before the throttle gives a place, so
  // that an invalid value costs no request.
  const checkCalendarInput = (ctx: TenantContext, valid: boolean): void => {
    if (valid) return;
    ctx.log.warn('churchtools_calendar_input_refused', { code: 'validation' });
    throw new EccliumError('validation', invalidCalendarInput);
  };

  const calendars = async (
    ctx: TenantContext,
  ): Promise<readonly Calendar[]> => {
    const root = await fetchAnswer(
      ctx,
      path,
      new URL('/api/calendars', origin),
      catalogLimits,
      {
        status: 'churchtools_calendars_status',
        refused: 'churchtools_calendars_refused',
      },
    );
    const parsed = calendarListSchema.safeParse(root);
    if (!parsed.success) {
      ctx.log.warn('churchtools_calendars_refused', { code: 'upstream' });
      throw new EccliumError('upstream');
    }
    return Object.freeze(
      [...parsed.data.data]
        .sort((a, b) => a.id - b.id)
        .map((entry) =>
          Object.freeze({
            __proto__: null,
            id: entry.id,
            name: entry.name,
            isPublic: entry.isPublic,
            isPrivate: entry.isPrivate,
          }),
        ),
    );
  };

  const appointments = async (
    ctx: TenantContext,
    calendarIds: readonly number[],
    from: string,
    to: string,
  ): Promise<AppointmentList> => {
    checkCalendarInput(ctx, isListIds(calendarIds) && isEventWindow(from, to));
    // Exactly calendar_ids[], from and to go out (ADR 0064).
    const url = new URL('/api/calendars/appointments', origin);
    appendIds(url.searchParams, 'calendar_ids[]', calendarIds);
    appendSpan(url.searchParams, from, to);
    const root = await fetchAnswer(ctx, path, url, spanListLimits, {
      status: 'churchtools_appointments_status',
      refused: 'churchtools_appointments_refused',
    });
    const parsed = appointmentListSchema.safeParse(root);
    if (!parsed.success) {
      ctx.log.warn('churchtools_appointments_refused', { code: 'upstream' });
      throw new EccliumError('upstream');
    }
    // Sorted before the cut, so that the same answer always gives the same
    // appointments, whatever order ChurchTools sends.
    const entries = parsed.data.data
      .map(({ appointment }): AppointmentEntry =>
        Object.freeze({
          __proto__: null,
          ...appointmentFieldsOf(appointment.base),
          startDate: appointment.calculated.startDate,
          endDate: appointment.calculated.endDate,
        }),
      )
      .sort(byStartAndId);
    return Object.freeze({
      __proto__: null,
      appointments: Object.freeze(entries.slice(0, maxAppointments)),
      more: entries.length > maxAppointments,
    });
  };

  const appointment = async (
    ctx: TenantContext,
    calendarId: number,
    appointmentId: number,
  ): Promise<AppointmentDetails> => {
    checkCalendarInput(
      ctx,
      isWholeFromOne(calendarId) && isWholeFromOne(appointmentId),
    );
    const url = urlOfPath(
      origin,
      `/api/calendars/${String(calendarId)}/appointments/${String(appointmentId)}`,
    );
    const root = await fetchAnswer(ctx, path, url, appointmentLimits, {
      status: 'churchtools_appointment_status',
      refused: 'churchtools_appointment_refused',
      missing: 'churchtools_appointment_missing',
    });
    const parsed = appointmentSchema.safeParse(root);
    if (!parsed.success) {
      ctx.log.warn('churchtools_appointment_refused', { code: 'upstream' });
      throw new EccliumError('upstream');
    }
    const data = parsed.data.data;
    // The keys of the dates have no known form; only the values count.
    const dates = Object.values(data.calculatedDates)
      .map((date): AppointmentDate =>
        Object.freeze({
          __proto__: null,
          startDate: date.startDate,
          endDate: date.endDate,
        }),
      )
      .sort(
        (a, b) =>
          (a.startDate < b.startDate
            ? -1
            : a.startDate > b.startDate
              ? 1
              : 0) ||
          (a.endDate < b.endDate ? -1 : a.endDate > b.endDate ? 1 : 0),
      );
    return Object.freeze({
      __proto__: null,
      ...appointmentFieldsOf(data.appointment),
      description: data.appointment.description ?? null,
      link: data.appointment.link ?? null,
      dates: Object.freeze(dates),
    });
  };

  const resources = async (ctx: TenantContext): Promise<ResourceList> => {
    const resourcesRoot = await fetchAnswer(
      ctx,
      path,
      new URL('/api/resources', origin),
      catalogLimits,
      {
        status: 'churchtools_resources_status',
        refused: 'churchtools_resources_refused',
      },
    );
    const parsedResources = resourceListSchema.safeParse(resourcesRoot);
    if (!parsedResources.success) {
      ctx.log.warn('churchtools_resources_refused', { code: 'upstream' });
      throw new EccliumError('upstream');
    }
    const typesRoot = await fetchAnswer(
      ctx,
      path,
      new URL('/api/resourcetypes', origin),
      catalogLimits,
      {
        status: 'churchtools_resource_types_status',
        refused: 'churchtools_resource_types_refused',
      },
    );
    const parsedTypes = resourceTypeListSchema.safeParse(typesRoot);
    if (!parsedTypes.success) {
      ctx.log.warn('churchtools_resource_types_refused', { code: 'upstream' });
      throw new EccliumError('upstream');
    }
    return Object.freeze({
      __proto__: null,
      resources: Object.freeze(
        [...parsedResources.data.data]
          .sort((a, b) => a.id - b.id)
          .map((entry) =>
            Object.freeze({
              __proto__: null,
              id: entry.id,
              name: entry.name,
              resourceTypeId: entry.resourceTypeId,
            }),
          ),
      ),
      resourceTypes: Object.freeze(
        [...parsedTypes.data.data]
          .sort((a, b) => a.id - b.id)
          .map((entry) =>
            Object.freeze({ __proto__: null, id: entry.id, name: entry.name }),
          ),
      ),
    });
  };

  const bookings = async (
    ctx: TenantContext,
    resourceIds: readonly number[],
    from: string,
    to: string,
  ): Promise<BookingList> => {
    checkCalendarInput(ctx, isListIds(resourceIds) && isEventWindow(from, to));
    // Exactly resource_ids[], from and to go out (ADR 0064).
    const url = new URL('/api/bookings', origin);
    appendIds(url.searchParams, 'resource_ids[]', resourceIds);
    appendSpan(url.searchParams, from, to);
    const root = await fetchAnswer(ctx, path, url, spanListLimits, {
      status: 'churchtools_bookings_status',
      refused: 'churchtools_bookings_refused',
    });
    const parsed = bookingListSchema.safeParse(root);
    if (!parsed.success) {
      ctx.log.warn('churchtools_bookings_refused', { code: 'upstream' });
      throw new EccliumError('upstream');
    }
    const entries = parsed.data.data
      .map(({ booking }): BookingEntry =>
        Object.freeze({
          __proto__: null,
          id: booking.base.id,
          title: booking.base.title,
          resourceId: booking.base.resourceId,
          statusId: booking.base.statusId,
          appointmentId: isWholeFromOne(booking.base.appointmentId)
            ? booking.base.appointmentId
            : null,
          startDate: booking.calculated.startDate,
          endDate: booking.calculated.endDate,
        }),
      )
      .sort(byStartAndId);
    return Object.freeze({
      __proto__: null,
      bookings: Object.freeze(entries.slice(0, maxBookings)),
      more: entries.length > maxBookings,
    });
  };

  return Object.freeze({
    whoami,
    permissions,
    searchPersons,
    searchGroups,
    person,
    personGroups,
    group,
    groupMembers,
    wikiCategories,
    wikiPages,
    wikiPage,
    events,
    event,
    eventAgenda,
    services,
    eventAssignments,
    calendars,
    appointments,
    appointment,
    resources,
    bookings,
  });
}
