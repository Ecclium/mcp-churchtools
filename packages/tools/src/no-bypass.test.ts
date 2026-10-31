import { createHash } from 'node:crypto';

import {
  createToolCatalog,
  createToolPipeline,
  loadConfig,
  type ToolOutcome,
  type ToolPipelineOptions,
  type ToolRequest,
  toolsetNames,
} from '@ecclium/mcp-churchtools-core';
import type { Facts } from '@ecclium/mcp-churchtools-docs-index';
import type {
  AgendaItem,
  KeyProvider,
  RedactionLevel,
  TenantAssignment,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  agendaAnswer,
  ahvOf,
  appointmentAnswer,
  appointmentsAnswer,
  assertNoCanary,
  assertPlanted,
  bookingsAnswer,
  calendarsAnswer,
  type Canary,
  coreToolCatalog,
  createChurchToolsDouble,
  createMemoryQuotaStore,
  doubleOrigin,
  eventAnswer,
  eventAssignmentsAnswer,
  type EventFixture,
  eventsAnswer,
  globalSearchAnswer,
  groupAtHighestLevel,
  groupedAhv,
  groupMembersAtHighestLevel,
  groupsAtHighestLevel,
  ibanOf,
  type InterceptOptions,
  makeCanary,
  type MockedHttpTransport,
  personAtHighestLevel,
  personGroupsAtHighestLevel,
  personsAtHighestLevel,
  printedIban,
  resourcesAnswer,
  resourceTypesAnswer,
  serviceGroupsAnswer,
  servicesAnswer,
  songAnswer,
  type SongFixture,
  songsAnswer,
  syntheticDocsIndex,
  syntheticFacts,
  syntheticThingsPage,
  wikiSearchAnswer,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { createCorePlugin } from './core-plugin.js';

// The third part of the proof that no tool bypasses the redaction (ADR
// 0026, ADR 0069): every tool of the catalog of the core runs through the
// pipeline on the double of ChurchTools with a fixture answer, at the
// levels off, standard and strict, and its whole outcome is searched for
// raw values. The fixtures plant canaries in every field a tool does not
// pass on and distinctive values in the fields it does; the level off is
// the positive control that shows the search sees them. A tool that comes
// into the catalog fails here until it has a case of its own.

type AuditSink = ToolPipelineOptions['audit'];
type AuditDraft = Parameters<AuditSink['record']>[0];
type LineWriter = ToolPipelineOptions['logging']['writer'];

const token = makeCanary('token');
const loaded = loadConfig({
  environment: {
    ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
    ECCLIUM_CHURCHTOOLS_TOKEN: token.value,
  },
  transport: 'stdio',
});
if (!loaded.ok) throw new Error('the configuration of the test is invalid');

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
});

const json = { headers: { 'content-type': 'application/json' } };
const at = (pathname: string) => (path: string) =>
  path.split('?')[0] === pathname;

const levels: readonly RedactionLevel[] = ['off', 'standard', 'strict'];

// The markers strict puts in place of what it finds in free text.
const markers = [
  '[email masked]',
  '[phone masked]',
  '[IBAN masked]',
  '[AHV number masked]',
];

// Contact data in free text, which only strict finds, by their form
// (ADR 0069). A case that sets `contact` puts this text into a field of
// the class untrusted that its tool passes on.
const contact = { email: makeCanary('email'), phone: makeCanary('phone') };
const iban = ibanOf('CH', '00000000000000012');
const ahv = ahvOf('000000001');
const contactText = `Kontakt ${contact.email.value}, Telefon ${contact.phone.value}, IBAN ${printedIban(iban)}, AHV ${groupedAhv(ahv, '.')} bis bald`;

// The synthetic facts of the docs index with the contact text in every
// summary of an operation, every title and text of the academy and the
// label of a right that a finding shows, and with one operation the
// escape hatch reads, as in its own tests, so that its search has a hit.
// A label from a page must stand on that page, so those stay as they are.
const facts = (): Facts => {
  const base = syntheticFacts();
  const withContact = (text: string | undefined) =>
    `${text ?? ''} ${contactText}`;
  return {
    ...base,
    operations: {
      ...base.operations,
      entries: [
        ...base.operations.entries.map((entry) => ({
          ...entry,
          summary: withContact(entry.summary),
        })),
        {
          operationId: 'get-groups-groupId',
          method: 'get',
          path: '/groups/{groupId}',
          tags: ['Groups'],
          summary: withContact('Get one group with its synthetic details'),
          deprecated: false,
          parameters: [
            {
              name: 'groupId',
              in: 'path',
              required: true,
              schema: { type: ['integer'] },
            },
          ],
          responses: [{ status: '200', content: [] }],
        },
      ].sort((a, b) => (a.operationId < b.operationId ? -1 : 1)),
    },
    rights: {
      ...base.rights,
      entries: base.rights.entries.map((entry) =>
        entry.label !== undefined && 'finding' in entry.label
          ? {
              ...entry,
              label: { ...entry.label, text: withContact(entry.label.text) },
            }
          : entry,
      ),
    },
    academy: {
      ...base.academy,
      entries: base.academy.entries.map((entry) => ({
        ...entry,
        title: withContact(entry.title),
        text: `${entry.text}\n\n${contactText}`,
      })),
    },
  } as unknown as Facts;
};

// Every toolset, as coreToolCatalog builds it, with the docs index above.
const catalog = createToolCatalog({
  core: createCorePlugin({ docs: syntheticDocsIndex(facts()) }),
  plugins: [],
  readOnly: true,
  toolsets: new Set(toolsetNames),
});

// One test key from a seed, never written out. Each call gets a fresh
// copy, since the pipeline erases the keys of a call when it ends.
const keys: KeyProvider = Object.freeze({
  dataKeys: () =>
    Promise.resolve([
      Uint8Array.from(createHash('sha256').update('no-bypass').digest()),
    ]),
});

const clock = Object.freeze({
  now: Object.freeze(() => Date.UTC(2026, 9, 31, 12)),
});

const request = (redaction: RedactionLevel): ToolRequest => ({
  assignment: {
    tenantId: 'default',
    actor: { kind: 'user', id: 'stdio:local-stdio' },
  } as unknown as TenantAssignment,
  mode: 'interactive',
  redaction,
  readOnly: true,
  features: [],
  signal: new AbortController().signal,
});

const setup = (level: RedactionLevel) => {
  const double = createChurchToolsDouble({
    token: loaded.config.churchtoolsToken,
  });
  open.push(double);
  const lines: string[] = [];
  const drafts: AuditDraft[] = [];
  const writer: LineWriter = Object.freeze({
    write: (line: string) => {
      lines.push(line);
      return true;
    },
  });
  const audit: AuditSink = Object.freeze({
    record: (draft: AuditDraft) => {
      drafts.push(draft);
      return true;
    },
    hasFile: true,
    ready: () => true,
    failures: () => 0,
  });
  const pipeline = createToolPipeline({
    quota: createMemoryQuotaStore(),
    catalog,
    audit,
    transport: double.transport,
    origin: doubleOrigin,
    requestsPerMinute: 300,
    clock,
    logging: { writer, minLevel: 'debug' },
    keys,
  });
  const call = (name: string, input: unknown) =>
    pipeline.call(name, input, request(level));
  return { double, lines, drafts, call };
};

/** A person with an ID and names the tool passes on. */
interface Person {
  readonly id: number;
  readonly firstName: string;
  readonly lastName: string;
}

// The IDs have ten digits of 0, 1, 8 and 9 only. A pseudonym holds none
// of 0, 1, 8 and 9, so the digits of an ID in a result of strict can only
// be the ID itself. The names are random, with an umlaut in the last.
const person = (id: number): Person => {
  const [firstName = '', lastName = ''] = makeCanary('name').cores;
  return { id, firstName, lastName };
};

/** An answer of the double and the canaries planted in it. */
interface Answer {
  readonly path: InterceptOptions['path'];
  readonly body: string;
  readonly canaries: readonly Canary[];
}

const answerAt = (
  path: InterceptOptions['path'],
  fixture: { readonly body: string; readonly canaries: readonly Canary[] },
): Answer => ({ path, body: fixture.body, canaries: fixture.canaries });

// An answer written out here, for the tools without a fixture in testkit.
const plain = (
  path: InterceptOptions['path'],
  body: unknown,
  canaries: readonly Canary[] = [],
): Answer => ({ path, body: JSON.stringify(body), canaries });

/** The value of a last name as a tool passes it on. */
interface Names {
  /** The first name, or null when the tool gives it inside `last`. */
  readonly first: string | null;
  /** The value of the field of the class name.last. */
  readonly last: string;
}

const namesOf = (of: Person): Names => ({
  first: of.firstName,
  last: of.lastName,
});

/** How a tool is called and what its answers plant. */
interface Case {
  readonly input: Readonly<Record<string, unknown>>;
  /** The answers, each planted with canaries in the fields left out. */
  readonly answers: readonly Answer[];
  /** The IDs of persons the tool passes on. */
  readonly ids?: readonly number[];
  /** The names of persons the tool passes on. */
  readonly names?: readonly Names[];
  /** Values of fields that standard and strict mask: e-mail, phone. */
  readonly masked?: readonly Canary[];
  /** A date of birth the tool passes on, which standard cuts to its year. */
  readonly birthday?: string;
  /** Whether a field of the class untrusted carries the contact text. */
  readonly contact?: boolean;
  /** The person the input names, by pseudonym in strict. */
  readonly asks?: Person;
}

const guid = '00000000-0000-4000-8000-000000000001';
const days = { from: '2026-10-25', to: '2026-10-31' } as const;

const event = (extra: Partial<EventFixture> = {}): EventFixture => ({
  id: 2,
  name: 'Event 2',
  startDate: '2026-10-25T09:00:00Z',
  endDate: '2026-10-25T10:30:00Z',
  isCanceled: false,
  calendarId: 8,
  calendarName: 'Kalender A',
  ...extra,
});

const item = (extra: Partial<AgendaItem> = {}): AgendaItem => ({
  position: 1,
  type: 'normal',
  title: 'Punkt 1',
  start: '2026-10-25T09:00:00Z',
  duration: 300,
  isBeforeEvent: false,
  note: null,
  song: null,
  ...extra,
});

const song = (id: number, extra: Partial<SongFixture> = {}): SongFixture => ({
  id,
  name: `Lied ${String(id)}`,
  categoryName: 'Lieder',
  author: 'Autor A',
  copyright: null,
  ccli: '1234567',
  arrangements: [{ id: id * 10, name: 'Band', key: 'G', isDefault: true }],
  ...extra,
});

const groupDetails = {
  meetingTime: 'Dienstag, 19 Uhr',
  note: contactText,
  maxMembers: 12,
  targetGroupId: 2,
  dateOfFoundation: '1950-03-01',
  endDate: null,
};

// The account of the token, with its e-mail address and a mobile number
// ct_whoami leaves out, and the person who last changed a page of the
// wiki, whom the tools of the wiki leave out.
const account = {
  ...person(1_089_100_981),
  email: makeCanary('email'),
  mobile: makeCanary('phone'),
};
const modifier = makeCanary('name');

const found = person(1_800_918_091);
const read = person(1_901_080_819);
const member = person(1_118_090_809);
const member2 = person(1_980_009_181);
const hit = person(1_009_181_890);
const assigned = person(1_890_091_018);

// The escape hatch passes on the whole answer and masks contact data by
// the name of a field (ADR 0067).
const hatch = { email: makeCanary('email'), phone: makeCanary('phone') };
const birthday = '1957-08-23';

const cases: Readonly<Record<string, Case>> = {
  ct_whoami: {
    input: {},
    answers: [
      plain(
        '/api/whoami?only_allow_authenticated=true',
        {
          data: {
            id: account.id,
            guid: '00000000-0000-0000-0000-000000000007',
            firstName: account.firstName,
            lastName: account.lastName,
            email: account.email.value,
            mobile: account.mobile.value,
          },
        },
        [account.mobile],
      ),
      plain('/api/permissions/global', {
        data: { churchwiki: { view: true } },
      }),
    ],
    ids: [account.id],
    names: [namesOf(account)],
    masked: [account.email],
  },
  ct_persons_search: {
    input: { query: 'Person' },
    answers: [answerAt(at('/api/persons'), personsAtHighestLevel([found]))],
    ids: [found.id],
    names: [namesOf(found)],
  },
  ct_persons_get: {
    input: { personId: read.id },
    answers: [
      answerAt(
        `/api/persons/${String(read.id)}`,
        personAtHighestLevel({ ...read, isArchived: false }),
      ),
    ],
    ids: [read.id],
    names: [namesOf(read)],
    asks: read,
  },
  ct_persons_get_groups: {
    input: { personId: read.id },
    answers: [
      answerAt(
        `/api/persons/${String(read.id)}/groups`,
        personGroupsAtHighestLevel([
          {
            groupId: 3,
            groupName: contactText,
            groupTypeRoleId: 8,
            groupMemberStatus: 'active',
          },
        ]),
      ),
    ],
    ids: [read.id],
    contact: true,
    asks: read,
  },
  ct_groups_search: {
    input: { query: 'Gruppe' },
    answers: [
      answerAt(
        at('/api/groups'),
        groupsAtHighestLevel([{ id: 3, name: contactText }]),
      ),
    ],
    contact: true,
  },
  ct_groups_get: {
    input: { groupId: 3 },
    answers: [
      answerAt(
        '/api/groups/3',
        groupAtHighestLevel({ id: 3, name: 'Gruppe A', details: groupDetails }),
      ),
    ],
    contact: true,
  },
  ct_groups_get_members: {
    input: { groupId: 3 },
    answers: [
      answerAt(
        at('/api/groups/3/members'),
        groupMembersAtHighestLevel(
          [member, member2].map((each) => ({
            personId: each.id,
            firstName: each.firstName,
            lastName: each.lastName,
            groupTypeRoleId: 8,
            groupMemberStatus: 'active',
          })),
          1,
        ),
      ),
    ],
    ids: [member.id, member2.id],
    names: [namesOf(member), namesOf(member2)],
  },
  // The global search gives the whole name of a person in one field of
  // the class name.last, so strict shortens it to its first letter.
  ct_search: {
    input: { type: 'person', query: 'Suche' },
    answers: [
      answerAt(
        at('/api/search'),
        globalSearchAnswer('person', [
          {
            domainType: 'person',
            domainIdentifier: String(hit.id),
            title: `${hit.firstName} ${hit.lastName}`,
          },
        ]),
      ),
    ],
    ids: [hit.id],
    names: [{ first: null, last: `${hit.firstName} ${hit.lastName}` }],
  },
  ct_wiki_categories_list: {
    input: {},
    answers: [
      plain('/api/wiki/categories', {
        data: [
          {
            id: 1,
            name: contactText,
            permissions: { canEdit: false, canDelete: false },
          },
        ],
        meta: { count: 1 },
        permissions: { editMasterData: false },
      }),
    ],
    contact: true,
  },
  ct_wiki_pages_list: {
    input: { categoryId: 4 },
    answers: [
      plain(
        at('/api/wiki/pages'),
        {
          data: [
            {
              guid,
              title: contactText,
              version: 1,
              isMarkdown: true,
              meta: { modifiedPerson: { title: modifier.value } },
            },
          ],
          meta: {
            count: 1,
            pagination: { total: 1, limit: 50, current: 1, lastPage: 1 },
          },
        },
        [modifier],
      ),
    ],
    contact: true,
  },
  ct_wiki_page_get: {
    input: { categoryId: 4, guid },
    answers: [
      plain(
        `/api/wiki/categories/4/pages/${guid}`,
        {
          data: {
            guid,
            title: 'Seite A',
            version: 3,
            isMarkdown: true,
            text: `# Seite A\n\n${contactText}`,
            meta: { modifiedPerson: { title: modifier.value } },
          },
        },
        [modifier],
      ),
    ],
    contact: true,
  },
  ct_wiki_search: {
    input: { query: 'Seite', categoryId: 12 },
    answers: [
      answerAt(
        at('/api/wiki/search'),
        wikiSearchAnswer([
          {
            domainType: 'wiki_page',
            domainIdentifier: guid,
            wikiCategoryId: 12,
            title: 'Seite A',
            preview: contactText,
          },
        ]),
      ),
    ],
    contact: true,
  },
  ct_events_list: {
    input: days,
    answers: [
      answerAt(at('/api/events'), eventsAnswer([event({ name: contactText })])),
    ],
    contact: true,
  },
  ct_events_get: {
    input: { eventId: 2 },
    answers: [
      answerAt(
        '/api/events/2',
        eventAnswer({
          ...event(),
          note: contactText,
          description: 'Beschreibung des Events',
        }),
      ),
    ],
    contact: true,
  },
  ct_events_get_agenda: {
    input: { eventId: 2 },
    answers: [
      answerAt(
        '/api/events/2/agenda',
        agendaAnswer({
          name: 'Ablauf',
          isFinal: true,
          items: [item({ note: contactText })],
        }),
      ),
    ],
    contact: true,
  },
  ct_services_list: {
    input: {},
    answers: [
      answerAt(
        '/api/services',
        servicesAnswer([
          {
            id: 11,
            name: 'Dienst 11',
            serviceGroupId: 5,
            hidePersonName: false,
          },
        ]),
      ),
      answerAt(
        '/api/servicegroups',
        serviceGroupsAnswer([{ id: 5, name: contactText }]),
      ),
    ],
    contact: true,
  },
  ct_services_get_assignments: {
    input: { eventId: 2 },
    answers: [
      answerAt(
        '/api/events/2',
        eventAssignmentsAnswer([
          {
            serviceId: 11,
            isAccepted: true,
            agreed: true,
            personId: assigned.id,
            firstName: assigned.firstName,
            lastName: assigned.lastName,
          },
        ]),
      ),
      answerAt(
        '/api/services',
        servicesAnswer([
          {
            id: 11,
            name: contactText,
            serviceGroupId: 5,
            hidePersonName: false,
          },
        ]),
      ),
    ],
    ids: [assigned.id],
    names: [namesOf(assigned)],
    contact: true,
  },
  ct_calendars_list: {
    input: {},
    answers: [
      answerAt(
        '/api/calendars',
        calendarsAnswer([
          { id: 8, name: contactText, isPublic: false, isPrivate: false },
        ]),
      ),
    ],
    contact: true,
  },
  ct_appointments_list: {
    input: { calendarIds: [8], ...days },
    answers: [
      answerAt(
        at('/api/calendars/appointments'),
        appointmentsAnswer([
          {
            id: 5,
            calendarId: 8,
            title: 'Termin 5',
            subtitle: contactText,
            allDay: false,
            locationName: null,
            startDate: '2026-10-25T18:00:00Z',
            endDate: '2026-10-25T19:00:00Z',
          },
        ]),
      ),
    ],
    contact: true,
  },
  ct_appointments_get: {
    input: { calendarId: 8, appointmentId: 5 },
    answers: [
      answerAt(
        '/api/calendars/8/appointments/5',
        appointmentAnswer({
          id: 5,
          calendarId: 8,
          title: 'Termin 5',
          subtitle: 'Untertitel',
          allDay: false,
          locationName: 'Saal',
          description: contactText,
          link: 'https://example.org/termin',
          dates: [
            {
              key: 'k0',
              startDate: '2026-10-25T18:00:00Z',
              endDate: '2026-10-25T19:00:00Z',
            },
          ],
        }),
      ),
    ],
    contact: true,
  },
  ct_resources_list: {
    input: {},
    answers: [
      answerAt(
        '/api/resources',
        resourcesAnswer([{ id: 8, name: contactText, resourceTypeId: 5 }]),
      ),
      answerAt(
        '/api/resourcetypes',
        resourceTypesAnswer([{ id: 5, name: 'Räume' }]),
      ),
    ],
    contact: true,
  },
  ct_bookings_list: {
    input: { resourceIds: [8], ...days },
    answers: [
      answerAt(
        at('/api/bookings'),
        bookingsAnswer([
          {
            id: 2,
            title: contactText,
            resourceId: 8,
            statusId: 2,
            appointmentId: 5,
            startDate: '2026-10-25T18:00:00Z',
            endDate: '2026-10-25T19:00:00Z',
          },
        ]),
      ),
    ],
    contact: true,
  },
  ct_songs_search: {
    input: { query: 'Lied' },
    answers: [
      answerAt(
        at('/api/songs'),
        songsAnswer([song(2, { copyright: contactText })], 1),
      ),
    ],
    contact: true,
  },
  ct_songs_get: {
    input: { songId: 7 },
    answers: [
      answerAt('/api/songs/7', songAnswer(song(7, { author: contactText }))),
    ],
    contact: true,
  },
  // The docs tools read only the docs index, never ChurchTools.
  ct_docs_search_api: {
    input: { query: 'members of a thing', limit: 1 },
    answers: [],
    contact: true,
  },
  ct_docs_get_operation: {
    input: { operationId: 'getSyntheticThingMembers' },
    answers: [],
    contact: true,
  },
  ct_docs_search_rights: {
    input: { query: 'Dinge bearbeiten', limit: 1 },
    answers: [],
    contact: true,
  },
  ct_docs_get_right: {
    input: { module: 'synthetic', name: 'edit things' },
    answers: [],
    contact: true,
  },
  ct_docs_search_academy: {
    input: { query: 'Dinge verwalten', limit: 1 },
    answers: [],
    contact: true,
  },
  ct_docs_read_academy: {
    input: { path: syntheticThingsPage },
    answers: [],
    contact: true,
  },
  ct_api_search_actions: {
    input: { query: 'wiki groups things' },
    answers: [],
    contact: true,
  },
  ct_api_execute_read: {
    input: { operationId: 'get-groups-groupId', path: { groupId: 12 } },
    answers: [
      plain('/api/groups/12', {
        data: {
          id: 12,
          name: 'Gruppe A',
          email: hatch.email.value,
          mobile: hatch.phone.value,
          birthday,
        },
      }),
    ],
    masked: [hatch.email, hatch.phone],
    birthday,
  },
};

// The configuration refuses strict together with the toolset api: the
// escape hatch passes on whole answers of an unknown schema, for which
// strict could not keep its promise (ADR 0067, ADR 0069).
const escapeHatch: readonly string[] = [
  'ct_api_execute_read',
  'ct_api_search_actions',
];

const toolsAt = (level: RedactionLevel): readonly string[] =>
  Object.keys(cases)
    .sort()
    .filter((name) => level !== 'strict' || !escapeHatch.includes(name));

const caseOf = (name: string): Case => {
  const found = cases[name];
  if (found === undefined) throw new Error(`no case for ${name}`);
  return found;
};

const pseudonymForm = /^p1_[a-z2-7]{39}$/u;

// In strict a tool takes a person by the pseudonym another tool gave,
// never by the ID, so the run asks the search first, as a model would.
const pseudonymOf = async (
  of: Person,
  double: MockedHttpTransport,
  call: (name: string, input: unknown) => Promise<ToolOutcome>,
): Promise<string> => {
  double
    .intercept({ path: at('/api/persons'), method: 'GET' })
    .reply(200, personsAtHighestLevel([of]).body, json);
  const outcome = await call('ct_persons_search', { query: 'Person' });
  const persons = outcome.ok
    ? (outcome.data['persons'] as readonly { readonly id: unknown }[])
    : [];
  const id = persons[0]?.id;
  if (typeof id !== 'string' || !pseudonymForm.test(id)) {
    throw new Error('the search gave no pseudonym');
  }
  return id;
};

const run = async (name: string, level: RedactionLevel) => {
  const testCase = caseOf(name);
  const { double, lines, drafts, call } = setup(level);
  let input = testCase.input;
  let asked = 0;
  if (level === 'strict' && testCase.asks !== undefined) {
    input = {
      ...input,
      personId: await pseudonymOf(testCase.asks, double, call),
    };
    asked = 1;
  }
  for (const answer of testCase.answers) {
    // A canary that never reached the answer could pass as a clean result.
    assertPlanted(
      JSON.parse(answer.body),
      answer.canaries,
      `answer of ${name}`,
    );
    double
      .intercept({ path: answer.path, method: 'GET' })
      .reply(200, answer.body, json);
  }
  const outcome = await call(name, input);
  // Every answer was read, so every planted value reached the tool.
  expect(double.calls()).toHaveLength(testCase.answers.length + asked);
  return { outcome, lines, drafts };
};

describe('the cases', () => {
  it('name every tool of the catalog and no other', () => {
    const listed = catalog.list().map((entry) => entry.name);
    expect(Object.keys(cases).sort()).toEqual([...listed].sort());
    // The catalog here holds the tools of the one every other test walks.
    expect(listed).toEqual(
      coreToolCatalog()
        .list()
        .map((entry) => entry.name),
    );
  });

  it('leave out of strict only the escape hatch, which the configuration refuses there', () => {
    const refused = loadConfig({
      environment: {
        ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
        ECCLIUM_CHURCHTOOLS_TOKEN: token.value,
        ECCLIUM_REDACTION: 'strict',
        ECCLIUM_TOOLSETS: 'api',
      },
      transport: 'stdio',
    });
    expect(refused.report.problems.map((problem) => problem.code)).toContain(
      'redaction_strict_with_api',
    );
    expect(
      catalog
        .list()
        .filter((entry) => entry.meta.domain === 'api')
        .map((entry) => entry.name)
        .sort(),
    ).toEqual([...escapeHatch].sort());
  });
});

describe.each(levels)('every tool at the level %s', (level) => {
  it.each(toolsAt(level))('%s lets no raw value out', async (name) => {
    const testCase = caseOf(name);
    const { outcome, lines, drafts } = await run(name, level);
    expect(outcome.ok ? 'ok' : outcome.error.code).toBe('ok');
    const text = JSON.stringify(outcome);
    const ids = testCase.ids ?? [];
    const names = testCase.names ?? [];
    const masked = testCase.masked ?? [];

    // Every level: nothing of a field the tool does not pass on, and
    // never the token.
    assertNoCanary(
      [outcome, lines, drafts],
      [token, ...testCase.answers.flatMap((answer) => answer.canaries)],
      'result, log, audit',
    );

    if (level === 'off') {
      // The positive control: every value the tool passes on is there as
      // it was planted.
      for (const id of ids) expect(text).toContain(String(id));
      for (const { first, last } of names) {
        expect(text).toContain(last);
        if (first !== null) expect(text).toContain(first);
      }
      assertPlanted(outcome, masked, 'result');
      if (testCase.birthday !== undefined) {
        expect(text).toContain(testCase.birthday);
      }
      if (testCase.contact === true) {
        assertPlanted(outcome, [contact.email, contact.phone], 'free text');
        expect(text).toContain(printedIban(iban));
        expect(text).toContain(groupedAhv(ahv, '.'));
      }
      return;
    }

    // Standard and strict: e-mail addresses and phone numbers masked, the
    // date of birth cut to its year. Free text stays as it is in
    // standard; only strict checks it.
    assertNoCanary(outcome, masked, 'result');
    for (const email of masked.filter((each) => each.kind === 'email')) {
      expect(text).toContain(`${email.value.charAt(0)}***@example.org`);
    }
    if (testCase.birthday !== undefined) {
      expect(text).not.toContain(testCase.birthday);
    }
    if (level !== 'strict') return;

    // Strict: pseudonyms in place of the IDs, last names shortened to
    // their first letter and a dot, and the contact data in free text
    // replaced by markers.
    for (const id of ids) expect(text).not.toContain(String(id));
    expect(text.match(/"p1_[a-z2-7]{39}"/gu) ?? []).toHaveLength(ids.length);
    for (const { first, last } of names) {
      expect(text).not.toContain(last.slice(1));
      expect(text).toContain(JSON.stringify(`${last.charAt(0)}.`));
      if (first !== null) expect(text).toContain(first);
    }
    if (testCase.contact === true) {
      assertNoCanary(outcome, [contact.email, contact.phone], 'free text');
      for (const raw of [iban, printedIban(iban), ahv, groupedAhv(ahv, '.')]) {
        expect(text).not.toContain(raw);
      }
      for (const marker of markers) expect(text).toContain(marker);
    }
  });
});
