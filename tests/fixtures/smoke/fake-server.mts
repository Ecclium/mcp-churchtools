// A stand-in for `ecclium stdio` in the tests of the smoke test. It speaks
// JSON-RPC over stdio in both eras, answers the twenty-four tools with synthetic
// canary values and writes log, audit lines on stderr and an audit file in
// the form of the real server. FAKE_SCENARIO breaks one thing at a time,
// so that each check of the smoke test can be seen to fail. FAKE_RECORD
// names a folder that receives, per process, the environment it got and
// the tools it was asked to call. The real server stands in the other
// tests of the smoke test.
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const env = process.env;
const scenario = env['FAKE_SCENARIO'] ?? 'normal';
const canary = env['FAKE_CANARY'] ?? 'canary';
const toolsets = (env['ECCLIUM_TOOLSETS'] ?? '').split(',');
const personsToolset = toolsets.includes('persons');
const eventsToolset = toolsets.includes('events');
const calendarsToolset = toolsets.includes('calendars');
const wikiToolset = toolsets.includes('wiki');
const songsToolset = toolsets.includes('songs');
const pageGuid = '00000000-0000-4000-8000-000000000001';
const calls: string[] = [];

const record = (): void => {
  const target = env['FAKE_RECORD'];
  if (target === undefined) return;
  const variables = Object.fromEntries(
    Object.keys(env)
      .sort()
      .map((name) => [name, name.startsWith('ECCLIUM_') ? env[name] : '']),
  );
  writeFileSync(
    join(target, `${String(process.pid)}.json`),
    JSON.stringify({ variables, calls }),
  );
};
record();

const stateDir = env['ECCLIUM_STATE_DIR'] ?? '';
const auditFolder = join(stateDir, 'audit');
mkdirSync(auditFolder, { recursive: true, mode: 0o700 });
const auditFile = join(
  auditFolder,
  `audit-2026-10-23-120000-${String(process.pid)}-1.jsonl`,
);

const log = (line: Record<string, unknown>): void => {
  process.stderr.write(`${JSON.stringify(line)}\n`);
};
const event = (name: string, fields: Record<string, unknown> = {}): void => {
  log({ ts: new Date().toISOString(), level: 'info', event: name, ...fields });
};
const audit = (tool: string, errorCode?: string): void => {
  const line = {
    v: 1,
    eventId: randomUUID(),
    ts: new Date().toISOString(),
    type: 'tool_call',
    tenantId: 'default',
    actor: { kind: 'service', id: 'stdio:local-stdio' },
    mode: 'interactive',
    tool,
    outcome: errorCode === undefined ? 'ok' : 'error',
    objectRefs: [],
    ...(errorCode === undefined ? {} : { errorCode }),
    durationMs: 1,
  };
  appendFileSync(auditFile, `${JSON.stringify(line)}\n`);
  log(line);
};
const send = (message: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

process.stderr.write('Hinweis: Das Toolset persons ist eingeschaltet.\n');
if (scenario === 'foreign-stdout') process.stdout.write('hallo\n');
if (scenario === 'token-stderr') {
  process.stderr.write(
    readFileSync(env['ECCLIUM_CHURCHTOOLS_TOKEN_FILE'] ?? '', 'utf8'),
  );
}

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
const toolNames = [
  ...(calendarsToolset
    ? [
        'ct_appointments_get',
        'ct_appointments_list',
        'ct_bookings_list',
        'ct_calendars_list',
      ]
    : []),
  ...(eventsToolset
    ? ['ct_events_get', 'ct_events_get_agenda', 'ct_events_list']
    : []),
  ...(personsToolset
    ? [
        'ct_groups_get',
        'ct_groups_get_members',
        'ct_groups_search',
        'ct_persons_get',
        'ct_persons_get_groups',
        'ct_persons_search',
      ]
    : []),
  ...(calendarsToolset ? ['ct_resources_list'] : []),
  ...(personsToolset ? ['ct_search'] : []),
  ...(eventsToolset ? ['ct_services_get_assignments', 'ct_services_list'] : []),
  ...(songsToolset ? ['ct_songs_get', 'ct_songs_search'] : []),
  'ct_whoami',
  ...(wikiToolset
    ? [
        'ct_wiki_categories_list',
        'ct_wiki_page_get',
        'ct_wiki_pages_list',
        'ct_wiki_search',
      ]
    : []),
  ...(scenario === 'write-tool' ? ['ct_wiki_page_create'] : []),
];

const result = (data: Record<string, unknown>): Record<string, unknown> => ({
  content: [
    {
      type: 'text',
      text: scenario === 'text-mismatch' ? '{}' : JSON.stringify(data),
    },
  ],
  structuredContent: data,
});

// The masked forms the pipeline gives an address, or none.
const emails: Readonly<Record<string, string>> = {
  'masked-letter': `m***@example.org`,
  'masked-star': `****@example.org`,
  'masked-literal': '[masked]',
};

const callTool = (name: string, args: Record<string, unknown>): unknown => {
  calls.push(name);
  record();
  if (name === 'ct_whoami') {
    event('http_response', { status: 200 });
    event('http_response', { status: 200 });
    audit(name);
    if (scenario === 'text-stderr') {
      process.stderr.write(`Warnung ${canary}Konto\n`);
    }
    const rights =
      scenario === 'security-level'
        ? [{ right: 'security level person', ids: [1], idCount: 1 }]
        : scenario === 'group-level'
          ? [{ right: 'security level group', ids: [1], idCount: 1 }]
          : [{ right: 'view' }];
    return result({
      id: 4711,
      firstName:
        scenario === 'lone-surrogate' ? `${canary}\uD800` : `${canary}Konto`,
      lastName: `${canary}Dienst`,
      email: emails[scenario] ?? null,
      rights: {
        status: 'known',
        modules: [{ module: 'churchwiki', rights }],
      },
    });
  }
  const wrap = (text: string): string =>
    `<<data-a1b2c3d4e5f6a7b8>>${text}<</data-a1b2c3d4e5f6a7b8>>`;
  if (name === 'ct_persons_get') {
    event('http_response', { status: 200 });
    audit(name);
    return result({
      id: args['personId'],
      firstName: `${canary}Erika`,
      lastName: `${canary}Muster`,
      isArchived: false,
      ...(scenario === 'person-extra' ? { email: 'x@example.org' } : {}),
    });
  }
  if (name === 'ct_persons_get_groups') {
    event('http_response', { status: 200 });
    audit(name);
    const groupName = `${canary}Gruppe`;
    return result({
      personId: args['personId'],
      groups: [
        {
          groupId: 921,
          groupName:
            scenario === 'membership-no-envelope' ? groupName : wrap(groupName),
          groupTypeRoleId: 8,
          groupMemberStatus: 'active',
        },
      ],
      more: false,
      notice: null,
    });
  }
  if (name === 'ct_groups_get') {
    event('http_response', { status: 200 });
    audit(name);
    const note = `${canary}Notiz`;
    if (scenario === 'group-no-details') {
      return result({
        id: args['groupId'],
        name: wrap(`${canary}Gruppe`),
        details: null,
        notice: 'ChurchTools sent no details of this group.',
      });
    }
    return result({
      id: args['groupId'],
      name: wrap(`${canary}Gruppe`),
      details: {
        meetingTime: wrap(`${canary}Dienstag`),
        note: scenario === 'group-bare-note' ? note : wrap(note),
        maxMembers: 12,
        targetGroupId: null,
        dateOfFoundation: '2020-01-01',
        endDate: null,
      },
      notice: null,
    });
  }
  if (name === 'ct_groups_get_members') {
    event('http_response', { status: 200 });
    audit(name);
    return result({
      groupId: args['groupId'],
      page: 1,
      members: [
        {
          personId: 811,
          firstName: `${canary}Erika`,
          lastName: `${canary}Muster`,
          groupTypeRoleId: 8,
          groupMemberStatus: scenario === 'member-status' ? 'Aktiv' : 'active',
        },
      ],
      more: false,
      notice: null,
    });
  }
  if (name === 'ct_events_list') {
    event('http_response', { status: 200 });
    audit(name);
    const day = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
    const spanFits =
      typeof args['from'] === 'string' &&
      day.test(args['from']) &&
      typeof args['to'] === 'string' &&
      day.test(args['to']);
    if (scenario === 'no-events' || !spanFits) {
      return result({
        from: args['from'],
        to: args['to'],
        page: 1,
        events: [],
        more: false,
        notice: 'No event is listed for these days.',
      });
    }
    return result({
      from: args['from'],
      to: args['to'],
      page: 1,
      events: [
        {
          id: 31,
          name: wrap(`${canary}Gottesdienst`),
          startDate:
            scenario === 'events-bad-date'
              ? '2026-10-25 09:00'
              : '2026-10-25T09:00:00Z',
          endDate: '2026-10-25T10:30:00Z',
          isCanceled: false,
          calendarId: 8,
          calendarName: wrap(`${canary}Kalender`),
        },
      ],
      more: false,
      notice: null,
    });
  }
  if (name === 'ct_events_get') {
    event('http_response', { status: 200 });
    audit(name);
    const note = `${canary}Notiz`;
    return result({
      id: args['eventId'],
      name: wrap(`${canary}Gottesdienst`),
      startDate: '2026-10-25T09:00:00Z',
      endDate: '2026-10-25T10:30:00Z',
      isCanceled: false,
      calendarId: 8,
      calendarName: wrap(`${canary}Kalender`),
      note: scenario === 'event-bare-note' ? note : wrap(note),
      description: null,
    });
  }
  if (name === 'ct_events_get_agenda') {
    if (scenario === 'agenda-refused') {
      event('http_response', { status: 403 });
      audit(name, 'permission');
      return {
        content: [{ type: 'text', text: 'ChurchTools refused this agenda.' }],
        isError: true,
      };
    }
    if (scenario === 'event-no-agenda') {
      event('http_response', { status: 404 });
      audit(name, 'not_found');
      return {
        content: [{ type: 'text', text: 'There is no agenda for this ID.' }],
        isError: true,
      };
    }
    event('http_response', { status: 200 });
    audit(name);
    return result({
      eventId: args['eventId'],
      page: 1,
      name: wrap(`${canary}Ablauf`),
      isFinal: false,
      items: [
        {
          position: 1,
          type: scenario === 'agenda-bad-type' ? 'Lied Eins' : 'song',
          title: wrap(`${canary}Punkt`),
          start: '2026-10-25T09:00:00Z',
          duration: 300,
          isBeforeEvent: false,
          note: null,
          song: {
            songId: 2,
            arrangementId: 3,
            title: wrap(`${canary}Lied`),
            arrangement: null,
          },
        },
      ],
      more: false,
      notice: null,
    });
  }
  if (name === 'ct_services_get_assignments') {
    event('http_response', { status: 200 });
    event('http_response', { status: 200 });
    audit(name);
    return result({
      eventId: args['eventId'],
      page: 1,
      assignments: [
        {
          serviceId: 11,
          serviceName: wrap(`${canary}Dienst`),
          isAccepted: true,
          agreed: true,
          person: {
            personId: 811,
            firstName: `${canary}Erika`,
            lastName: `${canary}Muster`,
            ...(scenario === 'assignment-extra'
              ? { email: 'x@example.org' }
              : {}),
          },
        },
        {
          serviceId: 14,
          serviceName: wrap(`${canary}Dienst`),
          isAccepted: false,
          agreed: false,
          person: null,
        },
      ],
      more: false,
      notice: 'Some assignments name no person.',
    });
  }
  if (name === 'ct_services_list') {
    event('http_response', { status: 200 });
    event('http_response', { status: 200 });
    audit(name);
    const serviceName = `${canary}Dienst`;
    return result({
      page: 1,
      services: [
        {
          id: 11,
          name:
            scenario === 'services-bare-name' ? serviceName : wrap(serviceName),
          serviceGroupId: 5,
          serviceGroupName: wrap(`${canary}Dienstgruppe`),
          hidesNames: false,
        },
      ],
      more: false,
      notice: null,
    });
  }
  if (name === 'ct_calendars_list') {
    event('http_response', { status: 200 });
    audit(name);
    const calendarName = `${canary}Kalender`;
    return result({
      page: 1,
      calendars:
        scenario === 'no-calendars'
          ? []
          : [
              {
                id: 8,
                name:
                  scenario === 'calendars-bare-name'
                    ? calendarName
                    : wrap(calendarName),
                isPublic: false,
                isPrivate: false,
              },
            ],
      more: false,
      notice: scenario === 'no-calendars' ? 'No calendar is listed.' : null,
    });
  }
  if (name === 'ct_appointments_list') {
    event('http_response', { status: 200 });
    audit(name);
    if (scenario === 'no-appointments') {
      return result({
        from: args['from'],
        to: args['to'],
        page: 1,
        appointments: [],
        more: false,
        notice: 'No appointment is listed.',
      });
    }
    return result({
      from: args['from'],
      to: args['to'],
      page: 1,
      appointments: [
        {
          id: 5,
          calendarId: 8,
          title:
            scenario === 'appointments-bare-title'
              ? `${canary}Termin`
              : wrap(`${canary}Termin`),
          subtitle: null,
          allDay: false,
          locationName: wrap(`${canary}Saal`),
          startDate:
            scenario === 'appointments-bad-date'
              ? '2026-10-25 18:00'
              : '2026-10-25T18:00:00Z',
          endDate: '2026-10-25T19:00:00Z',
        },
        {
          id: 6,
          calendarId: 8,
          title: wrap(`${canary}Tag`),
          subtitle: null,
          allDay: true,
          locationName: null,
          startDate: '2026-10-26',
          endDate: '2026-10-26',
        },
      ],
      more: false,
      notice: null,
    });
  }
  if (name === 'ct_appointments_get') {
    event('http_response', { status: 200 });
    audit(name);
    return result({
      id: args['appointmentId'],
      calendarId: args['calendarId'],
      title: wrap(`${canary}Termin`),
      subtitle: null,
      allDay: false,
      locationName: wrap(`${canary}Saal`),
      description: wrap(`${canary}Beschreibung`),
      link:
        scenario === 'appointment-bare-link'
          ? `${canary}Verweis`
          : wrap(`${canary}Verweis`),
      dates: [
        { startDate: '2026-10-25T18:00:00Z', endDate: '2026-10-25T19:00:00Z' },
      ],
      moreDates: false,
      ...(scenario === 'appointment-extra' ? { street: 'Hauptstrasse' } : {}),
    });
  }
  if (name === 'ct_resources_list') {
    event('http_response', { status: 200 });
    event('http_response', { status: 200 });
    audit(name);
    const typeName = `${canary}Raeume`;
    return result({
      page: 1,
      resources:
        scenario === 'no-resources'
          ? []
          : [
              {
                id: 8,
                name: wrap(`${canary}Raum`),
                resourceTypeId: 5,
                resourceTypeName:
                  scenario === 'resources-bare-type'
                    ? typeName
                    : wrap(typeName),
              },
            ],
      more: false,
      notice: scenario === 'no-resources' ? 'No resource is listed.' : null,
    });
  }
  if (name === 'ct_bookings_list') {
    event('http_response', { status: 200 });
    audit(name);
    return result({
      from: args['from'],
      to: args['to'],
      page: 1,
      bookings:
        scenario === 'no-bookings'
          ? []
          : [
              {
                id: 2,
                title:
                  scenario === 'bookings-bare-title'
                    ? `${canary}Buchung`
                    : wrap(`${canary}Buchung`),
                resourceId: 8,
                statusId: scenario === 'bookings-bad-status' ? -1 : 2,
                appointmentId: 5,
                startDate: '2026-10-25T18:00:00Z',
                endDate: '2026-10-25T19:00:00Z',
              },
            ],
      more: false,
      notice: scenario === 'no-bookings' ? 'No booking is listed.' : null,
    });
  }
  if (name === 'ct_songs_search' || name === 'ct_songs_get') {
    event('http_response', { status: 200 });
    audit(name);
    const songName = `${canary}Lied`;
    const song = {
      id: name === 'ct_songs_get' ? args['songId'] : 2,
      name:
        scenario === 'songs-bare-name' && name === 'ct_songs_search'
          ? songName
          : wrap(songName),
      category: wrap(`${canary}Kategorie`),
      author: wrap(`${canary}Autor`),
      copyright: null,
      ccli: null,
      arrangements: [
        { id: 3, name: wrap(`${canary}Standard`), key: null, isDefault: true },
      ],
      moreArrangements: false,
      ...(scenario === 'song-extra' && name === 'ct_songs_get'
        ? { lyrics: 'Strophe' }
        : {}),
    };
    if (name === 'ct_songs_get') return result(song);
    const none = scenario === 'no-songs';
    return result({
      page: 1,
      songs: none ? [] : [song],
      more: false,
      notice: none ? 'No song matched.' : null,
    });
  }
  if (name === 'ct_wiki_search') {
    event('http_response', { status: 200 });
    audit(name);
    const title = `${canary}Seite`;
    const hits =
      scenario === 'no-pages'
        ? []
        : [
            {
              guid:
                scenario === 'page-no-guid'
                  ? null
                  : scenario === 'wiki-bad-guid'
                    ? '42'
                    : pageGuid,
              categoryId: 12,
              title: scenario === 'wiki-bare-title' ? title : wrap(title),
              preview: wrap(`${canary}Vorschau`),
            },
          ];
    return result({
      hits,
      more: false,
      notice: hits.length === 0 ? 'No page matched.' : null,
    });
  }
  if (name === 'ct_wiki_page_get') {
    event('http_response', { status: 200 });
    audit(name);
    const text = `${canary}Text`;
    return result({
      categoryId: args['categoryId'],
      guid: args['guid'],
      title: wrap(`${canary}Seite`),
      isMarkdown: true,
      version: 2,
      part: 1,
      parts: 1,
      text: scenario === 'page-bare-text' ? text : wrap(text),
    });
  }
  if (name === 'ct_search') {
    const type = String(args['type']);
    event('http_response', { status: 200 });
    // A hit of another type: the real client ends with upstream and logs
    // the event the smoke test reports.
    if (scenario === 'search-foreign' && type === 'song') {
      log({
        ts: new Date().toISOString(),
        level: 'warn',
        event: 'churchtools_search_foreign',
        code: 'upstream',
      });
      audit(name, 'upstream');
      return {
        content: [
          { type: 'text', text: 'ChurchTools gave an unknown answer.' },
        ],
        isError: true,
      };
    }
    audit(name);
    const groupName = `${canary}Gruppe`;
    const filled: Readonly<Record<string, Record<string, unknown>>> = {
      person: { persons: [{ personId: 811, name: `${canary}Muster` }] },
      group: {
        groups: [
          {
            id: 921,
            name:
              scenario === 'search-bare-title' ? groupName : wrap(groupName),
          },
        ],
      },
      song: { songs: [{ id: 2, name: wrap(`${canary}Lied`) }] },
      wiki_page: {
        wikiPages: [{ guid: pageGuid, title: wrap(`${canary}Seite`) }],
      },
    };
    const none = scenario === 'search-empty';
    return result({
      type,
      persons: [],
      groups: [],
      songs: [],
      wikiPages: [],
      ...(none ? {} : filled[type]),
      ...(scenario === 'search-other-list' && type === 'group'
        ? { songs: [{ id: 2, name: wrap(`${canary}Lied`) }] }
        : {}),
      more: false,
      notice: none ? 'No hit matched.' : null,
    });
  }
  const query = typeof args['query'] === 'string' ? args['query'] : '';
  if (query.trim() === '') {
    if (scenario === 'blank-request') event('http_response', { status: 200 });
    audit(name, 'validation');
    return {
      content: [{ type: 'text', text: 'The search term is invalid.' }],
      isError: true,
    };
  }
  event('http_response', { status: 200 });
  if (name === 'ct_persons_search') {
    audit(name);
    if (query.startsWith('zq') || scenario === 'no-hits') {
      return result({ persons: [], more: false, notice: 'No person matched.' });
    }
    if (scenario === 'leak-log') event('debug', { value: `${canary}Erika` });
    return result({
      persons: [
        {
          id: 811,
          firstName: `${canary}Erika`,
          lastName: `${canary}Muster`,
          ...(scenario === 'extra-field' ? { email: 'x@example.org' } : {}),
        },
      ],
      more: false,
      notice: null,
    });
  }
  if (scenario !== 'audit-gap') audit(name);
  const groupName = `${canary}Gruppe`;
  return result({
    groups: [
      {
        id: 921,
        name:
          scenario === 'no-envelope'
            ? groupName
            : `<<data-a1b2c3d4e5f6a7b8>>${groupName}<</data-a1b2c3d4e5f6a7b8>>`,
      },
    ],
    more: false,
    notice: null,
  });
};

const reader = createInterface({ input: process.stdin });
reader.on('line', (line) => {
  const message = JSON.parse(line) as Record<string, unknown>;
  const id = message['id'];
  const params = (message['params'] ?? {}) as Record<string, unknown>;
  if (typeof id !== 'number') return;
  switch (message['method']) {
    case 'server/discover':
    case 'initialize':
      send({ jsonrpc: '2.0', id, result: { serverInfo: { name: 'fake' } } });
      return;
    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          tools: toolNames.map((name) => ({ name, annotations })),
        },
      });
      return;
    case 'tools/call':
      send({
        jsonrpc: '2.0',
        id,
        result: callTool(
          String(params['name']),
          (params['arguments'] ?? {}) as Record<string, unknown>,
        ),
      });
      return;
    default:
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'none' } });
  }
});
reader.on('close', () => {
  event('audit_file_closed', { count: 0 });
  event('stdio_closed', { count: 0 });
  process.exitCode = scenario === 'exit-1' ? 1 : 0;
});
