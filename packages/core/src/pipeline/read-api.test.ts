import {
  type Agenda,
  type AssignmentList,
  type EventDetails,
  type EventList,
  type Group,
  type GroupHit,
  type GroupMemberList,
  isEccliumError,
  type Me,
  type Person,
  type PersonGroupList,
  type PersonHit,
  type SearchHits,
  type ServiceList,
  type TenantContext,
  type WikiCategory,
  type WikiPage,
  type WikiPageList,
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

const fakeClient = () => {
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
    'refuses both searches and the four reads by ID to a tool of the sensitivity %s, without reading',
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
      ]) {
        const error: unknown = await call.catch((thrown: unknown) => thrown);
        expect(isEccliumError(error) && error.code).toBe('policy_denied');
      }
      await expect(read.whoami()).resolves.toBe(me);
      expect(seen).toEqual([ctx]);
      expect(lines).toEqual(
        Array.from({ length: 6 }, () => 'read_search_refused'),
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
