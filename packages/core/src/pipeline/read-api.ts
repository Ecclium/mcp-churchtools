/**
 * Read access to ChurchTools for one call of a tool (ADR 0024). It reads
 * through the raw client with the context of the call, so a tool never
 * sees a token and cannot choose the host. The pipeline revokes it when the
 * call ends; every method then rejects, also for a tool that kept it.
 *
 * @packageDocumentation
 */
import {
  type Agenda,
  type AppointmentDetails,
  type AppointmentList,
  type AssignmentList,
  type BookingList,
  type Calendar,
  EccliumError,
  type EventDetails,
  type EventList,
  type GlobalSearchHits,
  type Group,
  type GroupHit,
  type GroupMemberList,
  type Me,
  type Permissions,
  type Person,
  type PersonGroupList,
  type PersonHit,
  type ReadApi,
  type ResourceList,
  type SearchDomainType,
  type SearchHits,
  type Sensitivity,
  type ServiceList,
  type Song,
  type SongList,
  type TenantContext,
  type WikiCategory,
  type WikiPage,
  type WikiPageList,
  type WikiSearchHits,
} from '@ecclium/mcp-churchtools-plugin-api';

import type { ChurchToolsClient } from '../churchtools/index.js';

/** Read access of one call and the way to end it. */
export interface ReadAccess {
  /** What the tool receives as `read`. */
  readonly read: ReadApi;
  /** Ends the access. Every later call of a method rejects. */
  revoke(): void;
}

/**
 * Makes the read access of one call.
 *
 * @param client - The raw client of the instance.
 * @param ctx - The context of the call. Its signal aborts every request.
 * @param sensitivity - The sensitivity of the calling tool. Only `special`
 *   may search and read persons and groups and use the global search; any
 *   other gets `policy_denied`.
 * @param asSpecial - Whether the pipeline treats the calling tool like a
 *   special one (ADR 0064). Only such a tool may read the assignments to
 *   services, which name persons; any other gets `policy_denied`.
 * @returns The access, frozen and without prototype.
 * @example
 * ```ts
 * const access = createReadAccess(client, ctx, entry.meta.sensitivity, entry.asSpecial);
 * try { await tool.execute({ ctx, input, read: access.read }); }
 * finally { access.revoke(); }
 * ```
 */
export function createReadAccess(
  client: ChurchToolsClient,
  ctx: TenantContext,
  sensitivity: Sensitivity,
  asSpecial = false,
): ReadAccess {
  let revoked = false;
  const guard = <T>(run: () => Promise<T>): Promise<T> =>
    revoked ? Promise.reject(new EccliumError('internal')) : run();
  // Persons and groups reveal religious affiliation. Only a tool of the
  // sensitivity special may search or read them: only its result waits
  // for its line in the audit file, and only it never runs unattended
  // (ADR 0028, ADR 0060, ADR 0064). A tool that declares less could
  // otherwise pass on names and memberships without either.
  const special = <T>(run: () => Promise<T>): Promise<T> => {
    if (revoked || sensitivity === 'special') return guard(run);
    ctx.log.warn('read_search_refused', { code: 'policy_denied' });
    return Promise.reject(new EccliumError('policy_denied'));
  };
  // The assignments to services name persons. Only a tool whose result
  // waits for its line in the audit file and counts against the read
  // budget may read them; a tool that declares its output as plain text
  // could otherwise pass on names without either (ADR 0064).
  const named = <T>(run: () => Promise<T>): Promise<T> => {
    if (revoked || sensitivity === 'special' || asSpecial) return guard(run);
    ctx.log.warn('read_names_refused', { code: 'policy_denied' });
    return Promise.reject(new EccliumError('policy_denied'));
  };
  const read: ReadApi = Object.freeze({
    __proto__: null,
    whoami: (): Promise<Me> => guard(() => client.whoami(ctx)),
    permissions: (): Promise<Permissions> =>
      guard(() => client.permissions(ctx)),
    searchPersons: (query: string): Promise<SearchHits<PersonHit>> =>
      special(() => client.searchPersons(ctx, query)),
    searchGroups: (query: string): Promise<SearchHits<GroupHit>> =>
      special(() => client.searchGroups(ctx, query)),
    person: (personId: number): Promise<Person> =>
      special(() => client.person(ctx, personId)),
    personGroups: (personId: number): Promise<PersonGroupList> =>
      special(() => client.personGroups(ctx, personId)),
    group: (groupId: number): Promise<Group> =>
      special(() => client.group(ctx, groupId)),
    groupMembers: (groupId: number, page: number): Promise<GroupMemberList> =>
      special(() => client.groupMembers(ctx, groupId, page)),
    wikiCategories: (): Promise<readonly WikiCategory[]> =>
      guard(() => client.wikiCategories(ctx)),
    wikiPages: (categoryId: number, page: number): Promise<WikiPageList> =>
      guard(() => client.wikiPages(ctx, categoryId, page)),
    wikiPage: (
      categoryId: number,
      guid: string,
      version?: number,
    ): Promise<WikiPage> =>
      guard(() => client.wikiPage(ctx, categoryId, guid, version)),
    events: (from: string, to: string): Promise<EventList> =>
      guard(() => client.events(ctx, from, to)),
    event: (eventId: number): Promise<EventDetails> =>
      guard(() => client.event(ctx, eventId)),
    eventAgenda: (eventId: number): Promise<Agenda> =>
      guard(() => client.eventAgenda(ctx, eventId)),
    services: (): Promise<ServiceList> => guard(() => client.services(ctx)),
    eventAssignments: (
      eventId: number,
      page: number,
    ): Promise<AssignmentList> =>
      named(() => client.eventAssignments(ctx, eventId, page)),
    // Calendars, appointments, resources and bookings name no person: no
    // field they pass on is a person or a name of one (ADR 0064).
    calendars: (): Promise<readonly Calendar[]> =>
      guard(() => client.calendars(ctx)),
    appointments: (
      calendarIds: readonly number[],
      from: string,
      to: string,
    ): Promise<AppointmentList> =>
      guard(() => client.appointments(ctx, calendarIds, from, to)),
    appointment: (
      calendarId: number,
      appointmentId: number,
    ): Promise<AppointmentDetails> =>
      guard(() => client.appointment(ctx, calendarId, appointmentId)),
    resources: (): Promise<ResourceList> => guard(() => client.resources(ctx)),
    bookings: (
      resourceIds: readonly number[],
      from: string,
      to: string,
    ): Promise<BookingList> =>
      guard(() => client.bookings(ctx, resourceIds, from, to)),
    // Songs and the hits of the wiki name no person in a field of their
    // own; titles, authors and previews are text in the data envelope.
    searchSongs: (query: string, page: number): Promise<SongList> =>
      guard(() => client.searchSongs(ctx, query, page)),
    song: (songId: number): Promise<Song> =>
      guard(() => client.song(ctx, songId)),
    searchWiki: (query: string, categoryId?: number): Promise<WikiSearchHits> =>
      guard(() => client.searchWiki(ctx, query, categoryId)),
    // The global search finds persons by name, whatever type a call asks
    // for, so it is a search of persons like the two above (ADR 0064).
    search: (
      type: SearchDomainType,
      query: string,
    ): Promise<GlobalSearchHits> =>
      special(() => client.search(ctx, type, query)),
  });
  return Object.freeze({
    __proto__: null,
    read,
    revoke: (): void => {
      revoked = true;
    },
  });
}
