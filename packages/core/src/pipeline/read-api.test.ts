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
  isEccliumError,
  type Me,
  type Person,
  type PersonGroupList,
  type PersonHit,
  type ResourceList,
  type SearchHits,
  type ServiceList,
  type Song,
  type SongList,
  type TenantContext,
  type WikiCategory,
  type WikiPage,
  type WikiPageList,
  type WikiSearchHits,
} from '@ecclium/mcp-churchtools-plugin-api';
import { describe, expect, it } from 'vitest';

import { createReadAccess } from './read-api.js';

type Client = Parameters<typeof createReadAccess>[0];

const me: Me = { id: 1, firstName: 'Person', lastName: 'A', email: null };
const persons: SearchHits<PersonHit> = {
  hits: [{ id: 2, firstName: 'Person', lastName: 'B' }],
  more: false,
};
const groups: SearchHits<GroupHit> = {
  hits: [{ id: 3, name: 'Gruppe A' }],
  more: true,
};
const person: Person = {
  id: 2,
  firstName: 'Person',
  lastName: 'B',
  isArchived: false,
};
const personGroups: PersonGroupList = {
  groups: [
    {
      groupId: 3,
      groupName: 'Gruppe A',
      groupTypeRoleId: 8,
      groupMemberStatus: 'active',
    },
  ],
  more: false,
};
const group: Group = { id: 3, name: 'Gruppe A', details: null };
const members: GroupMemberList = {
  members: [
    {
      personId: 2,
      firstName: 'Person',
      lastName: 'B',
      groupTypeRoleId: 8,
      groupMemberStatus: 'active',
    },
  ],
  more: true,
};
const guid = '00000000-0000-4000-8000-000000000001';
const categories: readonly WikiCategory[] = [{ id: 4, name: 'Kategorie A' }];
const pages: WikiPageList = {
  pages: [{ guid, title: 'Seite A', isMarkdown: true, version: 2 }],
  more: false,
};
const page: WikiPage = {
  guid,
  title: 'Seite A',
  isMarkdown: true,
  version: 2,
  text: 'Text',
};
const events: EventList = { events: [], more: false };
const event: EventDetails = {
  id: 2,
  name: 'Gottesdienst',
  startDate: '2026-10-25T09:00:00Z',
  endDate: '2026-10-25T10:30:00Z',
  isCanceled: false,
  calendarId: 8,
  calendarName: 'Kalender A',
  note: null,
  description: null,
};
const agenda: Agenda = { name: 'Ablauf', isFinal: false, items: [] };
const services: ServiceList = { services: [], serviceGroups: [] };
const assignments: AssignmentList = {
  assignments: [
    {
      serviceId: 11,
      serviceName: 'Dienst A',
      isAccepted: true,
      agreed: true,
      person: { personId: 2, firstName: 'Person', lastName: 'B' },
    },
  ],
  more: false,
};
const calendars: readonly Calendar[] = [
  { id: 8, name: 'Kalender A', isPublic: false, isPrivate: false },
];
const appointments: AppointmentList = { appointments: [], more: false };
const appointment: AppointmentDetails = {
  id: 5,
  calendarId: 8,
  title: 'Termin A',
  subtitle: null,
  allDay: false,
  locationName: null,
  description: null,
  link: null,
  dates: [],
};
const resources: ResourceList = { resources: [], resourceTypes: [] };
const bookings: BookingList = { bookings: [], more: false };
const song: Song = {
  id: 2,
  name: 'Lied A',
  categoryName: 'Lieder',
  author: null,
  copyright: null,
  ccli: null,
  arrangements: [],
};
const songs: SongList = { songs: [song], more: false };
const wikiHits: WikiSearchHits = {
  hits: [{ guid, categoryId: 4, title: 'Seite A', preview: null }],
  more: false,
};
const globalHits: GlobalSearchHits = {
  type: 'song',
  hits: [{ id: 2, guid: null, title: 'Lied A' }],
  more: false,
};
const lines: string[] = [];
const ctx = Object.freeze({
  instance: 'https://example.church.tools',
  log: Object.freeze({
    debug: (event: string) => lines.push(event),
    info: (event: string) => lines.push(event),
    warn: (event: string) => lines.push(event),
    error: (event: string) => lines.push(event),
  }),
}) as unknown as TenantContext;

// What the fake client answers for an operation of the escape hatch.
type OperationAnswer = () => ReturnType<Client['operation']>;
const groupAnswer: OperationAnswer = () =>
  Promise.resolve({
    operationId: 'get-groups-groupId',
    sensitivity: 'special',
    root: { data: { name: 'Gruppe A', email: 'max.mustermann@example.org' } },
  });

const fakeClient = (operationAnswer: OperationAnswer = groupAnswer) => {
  const seen: TenantContext[] = [];
  const queries: string[] = [];
  const wiki: unknown[][] = [];
  const ids: unknown[][] = [];
  const client: Client = {
    whoami: (context) => {
      seen.push(context);
      return Promise.resolve(me);
    },
    permissions: (context) => {
      seen.push(context);
      return Promise.resolve({ kind: 'unknown' });
    },
    searchPersons: (context, query) => {
      seen.push(context);
      queries.push(query);
      return Promise.resolve(persons);
    },
    searchGroups: (context, query) => {
      seen.push(context);
      queries.push(query);
      return Promise.resolve(groups);
    },
    person: (context, personId) => {
      seen.push(context);
      ids.push(['person', personId]);
      return Promise.resolve(person);
    },
    personGroups: (context, personId) => {
      seen.push(context);
      ids.push(['personGroups', personId]);
      return Promise.resolve(personGroups);
    },
    group: (context, groupId) => {
      seen.push(context);
      ids.push(['group', groupId]);
      return Promise.resolve(group);
    },
    groupMembers: (context, groupId, number) => {
      seen.push(context);
      ids.push(['groupMembers', groupId, number]);
      return Promise.resolve(members);
    },
    wikiCategories: (context) => {
      seen.push(context);
      return Promise.resolve(categories);
    },
    wikiPages: (context, categoryId, number) => {
      seen.push(context);
      wiki.push([categoryId, number]);
      return Promise.resolve(pages);
    },
    wikiPage: (context, categoryId, id, version) => {
      seen.push(context);
      wiki.push([categoryId, id, version]);
      return Promise.resolve(page);
    },
    events: (context, from, to) => {
      seen.push(context);
      ids.push(['events', from, to]);
      return Promise.resolve(events);
    },
    event: (context, eventId) => {
      seen.push(context);
      ids.push(['event', eventId]);
      return Promise.resolve(event);
    },
    eventAgenda: (context, eventId) => {
      seen.push(context);
      ids.push(['eventAgenda', eventId]);
      return Promise.resolve(agenda);
    },
    services: (context) => {
      seen.push(context);
      ids.push(['services']);
      return Promise.resolve(services);
    },
    eventAssignments: (context, eventId, number) => {
      seen.push(context);
      ids.push(['eventAssignments', eventId, number]);
      return Promise.resolve(assignments);
    },
    calendars: (context) => {
      seen.push(context);
      ids.push(['calendars']);
      return Promise.resolve(calendars);
    },
    appointments: (context, calendarIds, from, to) => {
      seen.push(context);
      ids.push(['appointments', calendarIds, from, to]);
      return Promise.resolve(appointments);
    },
    appointment: (context, calendarId, appointmentId) => {
      seen.push(context);
      ids.push(['appointment', calendarId, appointmentId]);
      return Promise.resolve(appointment);
    },
    resources: (context) => {
      seen.push(context);
      ids.push(['resources']);
      return Promise.resolve(resources);
    },
    bookings: (context, resourceIds, from, to) => {
      seen.push(context);
      ids.push(['bookings', resourceIds, from, to]);
      return Promise.resolve(bookings);
    },
    searchSongs: (context, query, number) => {
      seen.push(context);
      ids.push(['searchSongs', query, number]);
      return Promise.resolve(songs);
    },
    song: (context, songId) => {
      seen.push(context);
      ids.push(['song', songId]);
      return Promise.resolve(song);
    },
    searchWiki: (context, query, categoryId) => {
      seen.push(context);
      ids.push(['searchWiki', query, categoryId]);
      return Promise.resolve(wikiHits);
    },
    search: (context, type, query) => {
      seen.push(context);
      ids.push(['search', type, query]);
      return Promise.resolve(globalHits);
    },
    operation: (context, request) => {
      seen.push(context);
      ids.push(['operation', request]);
      return operationAnswer();
    },
  };
  return { client, seen, queries, wiki, ids };
};

describe('createReadAccess', () => {
  it('reads with the context of the call', async () => {
    const { client, seen, queries } = fakeClient();
    const access = createReadAccess(client, ctx, 'special');
    await expect(access.read.whoami()).resolves.toBe(me);
    await expect(access.read.permissions()).resolves.toEqual({
      kind: 'unknown',
    });
    await expect(access.read.searchPersons('Person')).resolves.toBe(persons);
    await expect(access.read.searchGroups('Gruppe')).resolves.toBe(groups);
    expect(seen).toEqual([ctx, ctx, ctx, ctx]);
    expect(queries).toEqual(['Person', 'Gruppe']);
  });

  it('is frozen and without prototype', () => {
    const access = createReadAccess(fakeClient().client, ctx, 'special');
    expect(Object.isFrozen(access)).toBe(true);
    expect(Object.isFrozen(access.read)).toBe(true);
    expect(Object.getPrototypeOf(access.read)).toBeNull();
  });

  it.each(['special', 'none'] as const)(
    'rejects every method with internal after revoke, without reading, for %s',
    async (sensitivity) => {
      const { client, seen } = fakeClient();
      const access = createReadAccess(client, ctx, sensitivity);
      const { read } = access;
      access.revoke();
      for (const call of [
        read.whoami(),
        read.permissions(),
        read.searchPersons('Person'),
        read.searchGroups('Gruppe'),
        read.person(2),
        read.personGroups(2),
        read.group(3),
        read.groupMembers(3, 1),
        read.wikiCategories(),
        read.wikiPages(4, 1),
        read.wikiPage(4, guid),
        read.events('2026-10-25', '2026-10-31'),
        read.event(2),
        read.eventAgenda(2),
        read.services(),
        read.eventAssignments(2, 1),
        read.calendars(),
        read.appointments([8], '2026-10-25', '2026-10-31'),
        read.appointment(8, 5),
        read.resources(),
        read.bookings([8], '2026-10-25', '2026-10-31'),
        read.searchSongs('Lied', 1),
        read.song(2),
        read.searchWiki('Seite'),
        read.search('song', 'Lied'),
        read.operations(),
        read.operation({ operationId: 'get-groups-groupId' }),
      ]) {
        const error: unknown = await call.catch((thrown: unknown) => thrown);
        expect(isEccliumError(error) && error.code).toBe('internal');
      }
      expect(seen).toEqual([]);
    },
  );

  it('reads persons and groups by ID with the context and the arguments of the call', async () => {
    const { client, seen, ids } = fakeClient();
    const { read } = createReadAccess(client, ctx, 'special');
    await expect(read.person(2)).resolves.toBe(person);
    await expect(read.personGroups(2)).resolves.toBe(personGroups);
    await expect(read.group(3)).resolves.toBe(group);
    await expect(read.groupMembers(3, 4)).resolves.toBe(members);
    expect(seen).toEqual([ctx, ctx, ctx, ctx]);
    expect(ids).toEqual([
      ['person', 2],
      ['personGroups', 2],
      ['group', 3],
      ['groupMembers', 3, 4],
    ]);
  });

  // Persons and groups only for a tool of the sensitivity special, whose
  // result waits for its audit line and which never runs unattended
  // (ADR 0028, ADR 0060, ADR 0064).
  it.each(['none', 'personal'] as const)(
    'refuses both searches, the four reads by ID and the global search to a tool of the sensitivity %s, without reading',
    async (sensitivity) => {
      lines.length = 0;
      const { client, seen } = fakeClient();
      const { read } = createReadAccess(client, ctx, sensitivity);
      for (const call of [
        read.searchPersons('Person'),
        read.searchGroups('Gruppe'),
        read.person(2),
        read.personGroups(2),
        read.group(3),
        read.groupMembers(3, 1),
        read.search('song', 'Lied'),
      ]) {
        const error: unknown = await call.catch((thrown: unknown) => thrown);
        expect(isEccliumError(error) && error.code).toBe('policy_denied');
      }
      await expect(read.whoami()).resolves.toBe(me);
      expect(seen).toEqual([ctx]);
      expect(lines).toEqual(
        Array.from({ length: 7 }, () => 'read_search_refused'),
      );
    },
  );

  // The wiki is no special data: a tool of every sensitivity reads it,
  // with the context of the call and the arguments as given.
  it.each(['none', 'personal', 'special'] as const)(
    'reads the wiki for a tool of the sensitivity %s',
    async (sensitivity) => {
      const { client, seen, wiki } = fakeClient();
      const { read } = createReadAccess(client, ctx, sensitivity);
      await expect(read.wikiCategories()).resolves.toBe(categories);
      await expect(read.wikiPages(4, 2)).resolves.toBe(pages);
      await expect(read.wikiPage(4, guid)).resolves.toBe(page);
      await expect(read.wikiPage(4, guid, 3)).resolves.toBe(page);
      expect(seen).toEqual([ctx, ctx, ctx, ctx]);
      expect(wiki).toEqual([
        [4, 2],
        [4, guid, undefined],
        [4, guid, 3],
      ]);
    },
  );

  // Events, agendas and services name no person: a tool of every
  // sensitivity reads them, with the context and the arguments of the call.
  it.each(['none', 'personal', 'special'] as const)(
    'reads events, agendas and services for a tool of the sensitivity %s',
    async (sensitivity) => {
      const { client, seen, ids } = fakeClient();
      const { read } = createReadAccess(client, ctx, sensitivity);
      await expect(read.events('2026-10-25', '2026-10-31')).resolves.toBe(
        events,
      );
      await expect(read.event(2)).resolves.toBe(event);
      await expect(read.eventAgenda(2)).resolves.toBe(agenda);
      await expect(read.services()).resolves.toBe(services);
      expect(seen).toEqual([ctx, ctx, ctx, ctx]);
      expect(ids).toEqual([
        ['events', '2026-10-25', '2026-10-31'],
        ['event', 2],
        ['eventAgenda', 2],
        ['services'],
      ]);
    },
  );

  // Calendars, appointments, resources and bookings name no person: a tool
  // of every sensitivity reads them, with the context and the arguments of
  // the call (ADR 0064).
  it.each(['none', 'personal', 'special'] as const)(
    'reads calendars, appointments, resources and bookings for a tool of the sensitivity %s',
    async (sensitivity) => {
      const { client, seen, ids } = fakeClient();
      const { read } = createReadAccess(client, ctx, sensitivity);
      await expect(read.calendars()).resolves.toBe(calendars);
      await expect(
        read.appointments([8, 9], '2026-10-25', '2026-10-31'),
      ).resolves.toBe(appointments);
      await expect(read.appointment(8, 5)).resolves.toBe(appointment);
      await expect(read.resources()).resolves.toBe(resources);
      await expect(
        read.bookings([8], '2026-10-25', '2026-10-31'),
      ).resolves.toBe(bookings);
      expect(seen).toEqual([ctx, ctx, ctx, ctx, ctx]);
      expect(ids).toEqual([
        ['calendars'],
        ['appointments', [8, 9], '2026-10-25', '2026-10-31'],
        ['appointment', 8, 5],
        ['resources'],
        ['bookings', [8], '2026-10-25', '2026-10-31'],
      ]);
    },
  );

  // Songs and the hits of the wiki name no person in a field of their own:
  // a tool of every sensitivity reads them, with the context and the
  // arguments of the call (ADR 0064).
  it.each(['none', 'personal', 'special'] as const)(
    'reads songs and searches the wiki for a tool of the sensitivity %s',
    async (sensitivity) => {
      const { client, seen, ids } = fakeClient();
      const { read } = createReadAccess(client, ctx, sensitivity);
      await expect(read.searchSongs('Lied', 3)).resolves.toBe(songs);
      await expect(read.song(2)).resolves.toBe(song);
      await expect(read.searchWiki('Seite')).resolves.toBe(wikiHits);
      await expect(read.searchWiki('Seite', 4)).resolves.toBe(wikiHits);
      expect(seen).toEqual([ctx, ctx, ctx, ctx]);
      expect(ids).toEqual([
        ['searchSongs', 'Lied', 3],
        ['song', 2],
        ['searchWiki', 'Seite', undefined],
        ['searchWiki', 'Seite', 4],
      ]);
    },
  );

  it('searches over all for a tool of the sensitivity special', async () => {
    const { client, seen, ids } = fakeClient();
    const { read } = createReadAccess(client, ctx, 'special');
    await expect(read.search('person', 'Person')).resolves.toBe(globalHits);
    expect(seen).toEqual([ctx]);
    expect(ids).toEqual([['search', 'person', 'Person']]);
  });

  // The global search finds persons whatever type a call asks for, so being
  // treated like a special tool is not enough: only the sensitivity counts.
  it.each(['none', 'personal'] as const)(
    'refuses the global search to a tool of the sensitivity %s also when treated as special',
    async (sensitivity) => {
      lines.length = 0;
      const { client, seen } = fakeClient();
      const { read } = createReadAccess(client, ctx, sensitivity, true);
      const error: unknown = await read
        .search('song', 'Lied')
        .catch((thrown: unknown) => thrown);
      expect(isEccliumError(error) && error.code).toBe('policy_denied');
      expect(seen).toEqual([]);
      expect(lines).toEqual(['read_search_refused']);
    },
  );

  // The assignments name persons, so only a tool the pipeline treats like
  // a special one reads them (ADR 0064).
  it.each([
    ['special', false],
    ['personal', true],
    ['none', true],
  ] as const)(
    'reads the assignments for a tool of the sensitivity %s treated as special: %s',
    async (sensitivity, asSpecial) => {
      const { client, seen, ids } = fakeClient();
      const { read } = createReadAccess(client, ctx, sensitivity, asSpecial);
      await expect(read.eventAssignments(2, 3)).resolves.toBe(assignments);
      expect(seen).toEqual([ctx]);
      expect(ids).toEqual([['eventAssignments', 2, 3]]);
    },
  );

  it.each(['none', 'personal'] as const)(
    'refuses the assignments to a tool of the sensitivity %s not treated as special, without reading',
    async (sensitivity) => {
      lines.length = 0;
      const { client, seen } = fakeClient();
      for (const access of [
        createReadAccess(client, ctx, sensitivity),
        createReadAccess(client, ctx, sensitivity, false),
      ]) {
        const error: unknown = await access.read
          .eventAssignments(2, 1)
          .catch((thrown: unknown) => thrown);
        expect(isEccliumError(error) && error.code).toBe('policy_denied');
      }
      expect(seen).toEqual([]);
      expect(lines).toEqual(['read_names_refused', 'read_names_refused']);
    },
  );
});

// The escape hatch (ADR 0067): the list of operations for every tool, the
// read only for a tool of the sensitivity special in the area api, with
// the answer masked by the level of the call.
describe('the escape hatch in the read access', () => {
  const ctxWith = (redaction: 'off' | 'standard'): TenantContext =>
    Object.freeze({ ...ctx, redaction });

  it.each(['none', 'personal', 'special'] as const)(
    'lists the readable operations for a tool of the sensitivity %s, without the client',
    async (sensitivity) => {
      const { client, seen } = fakeClient();
      const { read } = createReadAccess(client, ctx, sensitivity);
      const listed = await read.operations();
      expect(listed.length).toBeGreaterThan(0);
      expect(Object.isFrozen(listed)).toBe(true);
      const ids = listed.map((entry) => entry.operationId);
      expect(ids).toEqual([...ids].sort());
      expect(ids).toContain('get-wiki-categories');
      expect(seen).toEqual([]);
    },
  );

  it('reads an operation for a special tool in the area api and masks the answer', async () => {
    const { client, seen, ids } = fakeClient();
    const context = ctxWith('standard');
    const { read } = createReadAccess(client, context, 'special', true, 'api');
    const request = {
      operationId: 'get-groups-groupId',
      path: { groupId: 3 },
      query: { include: ['tags'] },
    };
    await expect(read.operation(request)).resolves.toEqual({
      operationId: 'get-groups-groupId',
      sensitivity: 'special',
      json: '{"data":{"name":"Gruppe A","email":"m***@example.org"}}',
    });
    expect(seen).toEqual([context]);
    expect(ids).toEqual([['operation', request]]);
  });

  it('passes the answer unmasked with the level off, but cleaned', async () => {
    const zeroWidth = String.fromCodePoint(0x200b);
    const { client } = fakeClient(() =>
      Promise.resolve({
        operationId: 'get-groups-groupId',
        sensitivity: 'special',
        root: { email: `max.mustermann@example.org${zeroWidth}` },
      }),
    );
    const { read } = createReadAccess(
      client,
      ctxWith('off'),
      'special',
      true,
      'api',
    );
    const result = await read.operation({ operationId: 'get-groups-groupId' });
    expect(JSON.parse(result.json)).toEqual({
      email:
        'max.mustermann@example.org [ecclium: 1 hidden characters removed]',
    });
  });

  it.each([
    ['none', 'api'],
    ['personal', 'api'],
    ['special', 'persons'],
    ['special', 'docs'],
    ['special', undefined],
  ] as const)(
    'refuses a read to a tool of the sensitivity %s in the area %s, without reading',
    async (sensitivity, domain) => {
      lines.length = 0;
      const { client, seen } = fakeClient();
      const { read } = createReadAccess(
        client,
        ctxWith('standard'),
        sensitivity,
        true,
        domain,
      );
      const error: unknown = await read
        .operation({ operationId: 'get-groups-groupId' })
        .catch((thrown: unknown) => thrown);
      expect(isEccliumError(error) && error.code).toBe('policy_denied');
      expect(seen).toEqual([]);
      expect(lines).toEqual(['read_operation_refused']);
    },
  );

  it.each([
    ['too large', { data: 'x'.repeat(40_000) }, 'read_operation_too_large'],
    [
      'with keys that are the same once masked',
      { 'max@example.org': 1, 'mia@example.org': 2 },
      'read_operation_collision',
    ],
  ])(
    'ends with upstream and the hint on limit for an answer %s',
    async (_name, root, line) => {
      lines.length = 0;
      const { client } = fakeClient(() =>
        Promise.resolve({
          operationId: 'get-groups',
          sensitivity: 'special',
          root,
        }),
      );
      const { read } = createReadAccess(
        client,
        ctxWith('standard'),
        'special',
        true,
        'api',
      );
      const error: unknown = await read
        .operation({ operationId: 'get-groups' })
        .catch((thrown: unknown) => thrown);
      expect(isEccliumError(error) && error.code).toBe('upstream');
      expect(error instanceof Error && error.message).toContain('limit');
      expect(lines).toEqual([line]);
    },
  );

  it('passes on an error of the client as it is', async () => {
    const { client } = fakeClient(() =>
      Promise.reject(new EccliumError('permission')),
    );
    const { read } = createReadAccess(
      client,
      ctxWith('standard'),
      'special',
      true,
      'api',
    );
    const error: unknown = await read
      .operation({ operationId: 'get-groups' })
      .catch((thrown: unknown) => thrown);
    expect(isEccliumError(error) && error.code).toBe('permission');
  });
});
