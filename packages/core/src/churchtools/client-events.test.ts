import { loadConfig } from '@ecclium/mcp-churchtools-core';
import {
  type AgendaItem,
  isEccliumError,
  type LogFields,
  type TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  agendaAnswer,
  assertNoCanary,
  assertPlanted,
  type AssignmentFixture,
  createChurchToolsDouble,
  doubleOrigin,
  eventAnswer,
  eventAssignmentsAnswer,
  type EventFixture,
  eventsAnswer,
  makeCanary,
  type ServiceFixture,
  serviceGroupsAnswer,
  servicesAnswer,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { createChurchToolsClient } from './client.js';

// The reads of events, agendas, services and assignments (ADR 0064). Every
// request goes through the real transport on the ChurchTools double, which
// answers from interceptors and connects nowhere. Each answer holds a
// canary in every field the client does not pass on.

const loaded = loadConfig({
  environment: {
    ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
    ECCLIUM_CHURCHTOOLS_TOKEN: makeCanary('token').value,
  },
  transport: 'stdio',
});
if (!loaded.ok) throw new Error('the configuration of the test is invalid');
const token = loaded.config.churchtoolsToken;

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
});

interface Line {
  readonly event: string;
  readonly fields: LogFields | undefined;
}

// A clock that runs one second per reading.
const runningClock = () => {
  let now = 0;
  return Object.freeze({
    now: (): number => {
      now += 1_000;
      return now;
    },
  });
};

const setup = () => {
  const double = createChurchToolsDouble({ token });
  open.push(double);
  const client = createChurchToolsClient({
    transport: double.transport,
    origin: doubleOrigin,
    requestsPerMinute: 300,
    clock: runningClock(),
  });
  const lines: Line[] = [];
  const record = (event: string, fields?: LogFields): void => {
    lines.push({ event, fields });
  };
  const ctx = (): TenantContext =>
    Object.freeze({
      instance: doubleOrigin,
      signal: new AbortController().signal,
      log: Object.freeze({
        debug: record,
        info: record,
        warn: record,
        error: record,
      }),
      clock: runningClock(),
    }) as unknown as TenantContext;
  return { double, client, ctx, lines };
};

const json = { headers: { 'content-type': 'application/json' } };

const codeOf = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call;
  } catch (error) {
    if (isEccliumError(error)) return error.code;
    throw error;
  }
  throw new Error('expected the call to fail');
};

const at = (pathname: string) => (path: string) =>
  path.split('?')[0] === pathname;

// An answer as JSON with its data changed.
// The callback names the form of the data it changes.
const changed = (body: string, change: (data: never) => void): string => {
  const root = JSON.parse(body) as { data: never };
  change(root.data);
  return JSON.stringify(root);
};

const entry = (index: number, day = 25): EventFixture => ({
  id: index,
  name: `Event ${String(index)}`,
  startDate: `2026-10-${String(day).padStart(2, '0')}T09:00:00Z`,
  endDate: `2026-10-${String(day).padStart(2, '0')}T10:30:00Z`,
  isCanceled: false,
  calendarId: 8,
  calendarName: 'Kalender A',
});

describe('the events of a span of days', () => {
  it('asks with exactly from, to and limit 51 and keeps only the fields of the list', async () => {
    const { double, client, ctx } = setup();
    const answer = eventsAnswer([entry(2), { ...entry(3), isCanceled: true }]);
    assertPlanted(JSON.parse(answer.body), answer.canaries, 'answer');
    double
      .intercept({ path: at('/api/events'), method: 'GET' })
      .reply(200, answer.body, json);
    const result = await client.events(ctx(), '2026-10-25', '2026-10-31');
    expect(result).toEqual({
      events: [entry(2), { ...entry(3), isCanceled: true }],
      more: false,
    });
    assertNoCanary(result, answer.canaries, 'events');
    expect(Object.isFrozen(result.events[0])).toBe(true);
    expect(Object.getPrototypeOf(result)).toBeNull();
    const [call] = double.calls();
    expect(call?.path).toBe('/api/events');
    expect(call?.searchParams).toEqual({
      from: '2026-10-25',
      to: '2026-10-31',
      limit: '51',
    });
  });

  it('sorts by start and ID and gives 50 with more for 51, also from a longer answer', async () => {
    const { double, client, ctx } = setup();
    // In reverse order of ID, spread over the days of the month.
    const many = (count: number) =>
      eventsAnswer(
        Array.from({ length: count }, (_, index) =>
          entry(count - index, 1 + ((count - index) % 28)),
        ),
      ).body;
    for (const count of [50, 51, 1000, 1001]) {
      double
        .intercept({ path: at('/api/events'), method: 'GET' })
        .reply(200, many(count), json);
    }
    const fifty = await client.events(ctx(), '2026-10-01', '2026-10-31');
    expect([fifty.events.length, fifty.more]).toEqual([50, false]);
    const sorted = [...fifty.events].sort(
      (a, b) => a.startDate.localeCompare(b.startDate) || a.id - b.id,
    );
    expect(fifty.events).toEqual(sorted);
    const more = await client.events(ctx(), '2026-10-01', '2026-10-31');
    expect([more.events.length, more.more]).toEqual([50, true]);
    const thousand = await client.events(ctx(), '2026-10-01', '2026-10-31');
    expect([thousand.events.length, thousand.more]).toEqual([50, true]);
    expect(thousand.events[0]?.startDate).toBe('2026-10-01T09:00:00Z');
    expect(await codeOf(client.events(ctx(), '2026-10-01', '2026-10-31'))).toBe(
      'upstream',
    );
  });

  it('gives no calendar ID for an identifier that is no plain whole number from 1', async () => {
    const { double, client, ctx } = setup();
    double.intercept({ path: at('/api/events'), method: 'GET' }).reply(
      200,
      eventsAnswer([
        { ...entry(2), calendarId: 'c-8' },
        { ...entry(3), calendarId: '08' },
        { ...entry(4), calendarId: '0' },
      ]).body,
      json,
    );
    const result = await client.events(ctx(), '2026-10-25', '2026-10-25');
    expect(result.events.map((event) => event.calendarId)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it.each([
    ['a start without Z', { startDate: '2026-10-25T09:00:00' }],
    ['an end with fractions', { endDate: '2026-10-25T10:30:00.000Z' }],
    ['isCanceled as text', { isCanceled: 'nein' }],
    ['a name of 256 characters', { name: 'x'.repeat(256) }],
  ])('gives upstream for an event with %s', async (_, change) => {
    const { double, client, ctx, lines } = setup();
    double.intercept({ path: at('/api/events'), method: 'GET' }).reply(
      200,
      changed(eventsAnswer([entry(2)]).body, (data: object[]) => {
        Object.assign(data[0] ?? {}, change);
      }),
      json,
    );
    expect(await codeOf(client.events(ctx(), '2026-10-25', '2026-10-25'))).toBe(
      'upstream',
    );
    expect(lines.map((line) => line.event)).toEqual([
      'churchtools_events_refused',
    ]);
  });

  it.each([
    ['32 days', '2026-10-01', '2026-11-01'],
    ['a last day before the first', '2026-10-25', '2026-10-24'],
    ['a day that does not exist', '2026-02-30', '2026-03-01'],
    ['a date with time', '2026-10-25T00:00:00Z', '2026-10-26'],
    ['a path in a day', '2026-10-25/../whoami', '2026-10-26'],
    ['a number', 20261025 as unknown as string, '2026-10-26'],
  ])('refuses %s before any request', async (_, from, to) => {
    const { double, client, ctx, lines } = setup();
    expect(await codeOf(client.events(ctx(), from, to))).toBe('validation');
    expect(double.calls()).toHaveLength(0);
    expect(lines.map((line) => line.event)).toEqual([
      'churchtools_event_input_refused',
    ]);
  });
});

describe('one event and its agenda', () => {
  const details = {
    ...entry(2),
    note: 'Notiz des Events',
    description: 'Beschreibung des Events',
  };

  it('reads one event with note and description and never its assignments', async () => {
    const { double, client, ctx } = setup();
    const answer = eventAnswer(details);
    assertPlanted(JSON.parse(answer.body), answer.canaries, 'answer');
    double
      .intercept({ path: '/api/events/2', method: 'GET' })
      .reply(200, answer.body, json);
    const result = await client.event(ctx(), 2);
    expect(result).toEqual(details);
    assertNoCanary(result, answer.canaries, 'event');
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(double.calls()[0]?.searchParams).toEqual({});
  });

  it('reads a missing note or description as none', async () => {
    const { double, client, ctx } = setup();
    double.intercept({ path: '/api/events/2', method: 'GET' }).reply(
      200,
      changed(
        eventAnswer({ ...details, note: null, description: null }).body,
        (data: Record<string, unknown>) => {
          delete data['description'];
        },
      ),
      json,
    );
    const result = await client.event(ctx(), 2);
    expect([result.note, result.description]).toEqual([null, null]);
  });

  it.each([
    ['a note of 2001 code units', { note: 'x'.repeat(2001) }],
    ['a description of 7001 code units', { description: 'x'.repeat(7001) }],
  ])('gives upstream for an event with %s', async (_, change) => {
    const { double, client, ctx } = setup();
    double
      .intercept({ path: '/api/events/2', method: 'GET' })
      .reply(200, eventAnswer({ ...details, ...change }).body, json);
    expect(await codeOf(client.event(ctx(), 2))).toBe('upstream');
  });

  it.each([
    ['event', '/api/events/7', 'churchtools_event'],
    ['eventAgenda', '/api/events/7/agenda', 'churchtools_agenda'],
    ['eventAssignments', '/api/events/7', 'churchtools_event_assignments'],
  ] as const)(
    'maps 404 of %s to not_found and 403 to permission',
    async (operation, pathname, prefix) => {
      const { double, client, ctx, lines } = setup();
      for (const status of [404, 403, 401, 500]) {
        double
          .intercept({ path: at(pathname), method: 'GET' })
          .reply(status, '{}', json);
      }
      expect(await codeOf(client[operation](ctx(), 7))).toBe('not_found');
      expect(await codeOf(client[operation](ctx(), 7))).toBe('permission');
      expect(await codeOf(client[operation](ctx(), 7))).toBe('auth');
      expect(await codeOf(client[operation](ctx(), 7))).toBe('upstream');
      expect(lines).toEqual([
        {
          event: `${prefix}_missing`,
          fields: { status: 404, code: 'not_found' },
        },
        {
          event: `${prefix}_status`,
          fields: { status: 403, code: 'permission' },
        },
        { event: `${prefix}_status`, fields: { status: 401, code: 'auth' } },
        {
          event: `${prefix}_status`,
          fields: { status: 500, code: 'upstream' },
        },
      ]);
      // Without the event, the services are never asked.
      expect(double.calls().every((call) => call.path === pathname)).toBe(true);
    },
  );

  // The types forbid most of these; a plugin built without them can still
  // pass them. Only a checked whole number fills a path.
  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.MAX_SAFE_INTEGER + 1,
    '7' as unknown as number,
    '7/../../whoami' as unknown as number,
  ])('refuses the ID %j before any request', async (value) => {
    const { double, client, ctx, lines } = setup();
    for (const call of [
      client.event(ctx(), value),
      client.eventAgenda(ctx(), value),
      client.eventAssignments(ctx(), value),
    ]) {
      expect(await codeOf(call)).toBe('validation');
    }
    expect(double.calls()).toHaveLength(0);
    expect(new Set(lines.map((line) => line.event))).toEqual(
      new Set(['churchtools_event_input_refused']),
    );
  });

  const item = (
    index: number,
    extra: Partial<AgendaItem> = {},
  ): AgendaItem => ({
    position: index,
    type: 'normal',
    title: `Punkt ${String(index)}`,
    start: '2026-10-25T09:00:00Z',
    duration: 300,
    isBeforeEvent: false,
    note: null,
    song: null,
    ...extra,
  });

  it('reads the agenda without the persons responsible and the notes of the groups of services', async () => {
    const { double, client, ctx } = setup();
    const items = [
      item(1, { type: 'header', note: 'Notiz des Punkts', start: null }),
      item(2, {
        type: 'song',
        song: {
          songId: 2,
          arrangementId: 3,
          title: 'Lied A',
          arrangement: 'Standard',
        },
      }),
      item(3, {
        isBeforeEvent: true,
        duration: null,
        song: {
          songId: 5,
          arrangementId: null,
          title: 'Lied B',
          arrangement: null,
        },
      }),
    ];
    const answer = agendaAnswer({ name: 'Ablauf', isFinal: true, items });
    assertPlanted(JSON.parse(answer.body), answer.canaries, 'answer');
    double
      .intercept({ path: '/api/events/2/agenda', method: 'GET' })
      .reply(200, answer.body, json);
    const result = await client.eventAgenda(ctx(), 2);
    expect(result).toEqual({ name: 'Ablauf', isFinal: true, items });
    assertNoCanary(result, answer.canaries, 'agenda');
    expect(Object.isFrozen(result.items[1]?.song)).toBe(true);
    expect(double.calls()[0]?.searchParams).toEqual({});
  });

  it('reads a name or title of null as empty and a missing start, duration, note or song as none', async () => {
    const { double, client, ctx } = setup();
    double.intercept({ path: '/api/events/2/agenda', method: 'GET' }).reply(
      200,
      changed(
        agendaAnswer({ name: 'Ablauf', isFinal: false, items: [item(1)] }).body,
        (data: { name: unknown; items: Record<string, unknown>[] }) => {
          data.name = null;
          const [first] = data.items;
          if (first === undefined) return;
          first['title'] = null;
          delete first['start'];
          delete first['note'];
          delete first['duration'];
          delete first['song'];
        },
      ),
      json,
    );
    const result = await client.eventAgenda(ctx(), 2);
    expect(result).toEqual({
      name: '',
      isFinal: false,
      items: [{ ...item(1), title: '', start: null, duration: null }],
    });
  });

  it.each([
    ['a type with a space', { type: 'song item' }],
    ['a type that starts with a digit', { type: '1song' }],
    ['a note of 1001 code units', { note: 'x'.repeat(1001) }],
    ['a start without Z', { start: '2026-10-25T09:00:00' }],
    ['a negative duration', { duration: -1 }],
  ] as const)('gives upstream for an item with %s', async (_, change) => {
    const { double, client, ctx } = setup();
    double.intercept({ path: '/api/events/2/agenda', method: 'GET' }).reply(
      200,
      agendaAnswer({
        name: 'Ablauf',
        isFinal: false,
        items: [item(1, change)],
      }).body,
      json,
    );
    expect(await codeOf(client.eventAgenda(ctx(), 2))).toBe('upstream');
  });

  it('gives upstream for more than 500 items', async () => {
    const { double, client, ctx } = setup();
    const of = (count: number) =>
      agendaAnswer({
        name: 'Ablauf',
        isFinal: false,
        items: Array.from({ length: count }, (_, index) => item(index + 1)),
      }).body;
    double
      .intercept({ path: '/api/events/2/agenda', method: 'GET' })
      .reply(200, of(500), json);
    double
      .intercept({ path: '/api/events/2/agenda', method: 'GET' })
      .reply(200, of(501), json);
    expect((await client.eventAgenda(ctx(), 2)).items).toHaveLength(500);
    expect(await codeOf(client.eventAgenda(ctx(), 2))).toBe('upstream');
  });
});

const service = (
  id: number,
  extra: Partial<ServiceFixture> = {},
): ServiceFixture => ({
  id,
  name: `Dienst ${String(id)}`,
  serviceGroupId: 5,
  hidePersonName: false,
  ...extra,
});

describe('the services', () => {
  it('reads services and groups of services, sorted by ID, with only their fields', async () => {
    const { double, client, ctx } = setup();
    const services = servicesAnswer([
      service(14, { hidePersonName: true }),
      service(11),
    ]);
    const groups = serviceGroupsAnswer([
      { id: 6, name: 'Dienstgruppe B' },
      { id: 5, name: 'Dienstgruppe A' },
    ]);
    assertPlanted(JSON.parse(services.body), services.canaries, 'services');
    assertPlanted(JSON.parse(groups.body), groups.canaries, 'groups');
    double
      .intercept({ path: '/api/services', method: 'GET' })
      .reply(200, services.body, json);
    double
      .intercept({ path: '/api/servicegroups', method: 'GET' })
      .reply(200, groups.body, json);
    const result = await client.services(ctx());
    expect(result).toEqual({
      services: [
        { id: 11, name: 'Dienst 11', serviceGroupId: 5, hidesNames: false },
        { id: 14, name: 'Dienst 14', serviceGroupId: 5, hidesNames: true },
      ],
      serviceGroups: [
        { id: 5, name: 'Dienstgruppe A' },
        { id: 6, name: 'Dienstgruppe B' },
      ],
    });
    assertNoCanary(result, services.canaries, 'services');
    assertNoCanary(result, groups.canaries, 'groups');
    expect(
      double.calls().map((call) => [call.path, call.searchParams]),
    ).toEqual([
      ['/api/services', {}],
      ['/api/servicegroups', {}],
    ]);
  });

  it('gives upstream for more than 1000 services and for hidePersonName as text', async () => {
    const { double, client, ctx, lines } = setup();
    double
      .intercept({ path: '/api/services', method: 'GET' })
      .reply(
        200,
        servicesAnswer(
          Array.from({ length: 1001 }, (_, index) => service(index + 1)),
        ).body,
        json,
      );
    double.intercept({ path: '/api/services', method: 'GET' }).reply(
      200,
      changed(servicesAnswer([service(11)]).body, (data: object[]) => {
        Object.assign(data[0] ?? {}, { hidePersonName: 'ja' });
      }),
      json,
    );
    expect(await codeOf(client.services(ctx()))).toBe('upstream');
    expect(await codeOf(client.services(ctx()))).toBe('upstream');
    expect(lines.map((line) => line.event)).toEqual([
      'churchtools_services_refused',
      'churchtools_services_refused',
    ]);
  });

  it('gives upstream for a group of services that does not fit', async () => {
    const { double, client, ctx, lines } = setup();
    double
      .intercept({ path: '/api/services', method: 'GET' })
      .reply(200, servicesAnswer([service(11)]).body, json);
    double
      .intercept({ path: '/api/servicegroups', method: 'GET' })
      .reply(
        200,
        serviceGroupsAnswer([{ id: 5, name: 'x'.repeat(256) }]).body,
        json,
      );
    expect(await codeOf(client.services(ctx()))).toBe('upstream');
    expect(lines.map((line) => line.event)).toEqual([
      'churchtools_service_groups_refused',
    ]);
  });
});

describe('the assignments of an event', () => {
  const assignment = (
    serviceId: number,
    extra: Partial<AssignmentFixture> = {},
  ): AssignmentFixture => ({
    serviceId,
    isAccepted: true,
    agreed: true,
    personId: 1,
    firstName: 'Person',
    lastName: 'A',
    ...extra,
  });

  // The event, then the services and their groups.
  const reply = (
    double: ReturnType<typeof setup>['double'],
    assignments: readonly AssignmentFixture[],
    services: readonly ServiceFixture[],
  ) => {
    const event = eventAssignmentsAnswer(assignments);
    const list = servicesAnswer(services);
    const groups = serviceGroupsAnswer([{ id: 5, name: 'Dienstgruppe A' }]);
    double
      .intercept({ path: '/api/events/2', method: 'GET' })
      .reply(200, event.body, json);
    double
      .intercept({ path: '/api/services', method: 'GET' })
      .reply(200, list.body, json);
    double
      .intercept({ path: '/api/servicegroups', method: 'GET' })
      .reply(200, groups.body, json);
    return [...event.canaries, ...list.canaries, ...groups.canaries];
  };

  it('names the person of a service that shows names, and never the person who requested it', async () => {
    const { double, client, ctx } = setup();
    const canaries = reply(
      double,
      [
        assignment(11),
        assignment(11, {
          isAccepted: false,
          agreed: false,
          personId: 3,
          firstName: '',
          lastName: 'C',
        }),
      ],
      [service(11)],
    );
    const result = await client.eventAssignments(ctx(), 2);
    expect(result).toEqual([
      {
        serviceId: 11,
        serviceName: 'Dienst 11',
        isAccepted: true,
        agreed: true,
        person: { personId: 1, firstName: 'Person', lastName: 'A' },
      },
      {
        serviceId: 11,
        serviceName: 'Dienst 11',
        isAccepted: false,
        agreed: false,
        person: { personId: 3, firstName: '', lastName: 'C' },
      },
    ]);
    assertNoCanary(result, canaries, 'assignments');
    expect(Object.isFrozen(result[0]?.person)).toBe(true);
    expect(double.calls().map((call) => call.path)).toEqual([
      '/api/events/2',
      '/api/services',
      '/api/servicegroups',
    ]);
  });

  it.each([
    [
      'a service that hides the names',
      [service(11, { hidePersonName: true })],
      {},
    ],
    ['a service missing in the list', [service(12)], {}],
    [
      'the placeholder of a hidden name',
      [service(11)],
      { personId: 0, firstName: '', lastName: 'Platzhalter' },
    ],
    ['a negative ID of the person', [service(11)], { personId: -4 }],
    ['no ID of the person', [service(11)], { personId: null }],
  ] as const)(
    'passes on no person for %s, also when ChurchTools sends one',
    async (_, services, extra) => {
      const { double, client, ctx } = setup();
      reply(double, [assignment(11, extra)], services);
      const [result] = await client.eventAssignments(ctx(), 2);
      expect(result?.person).toBeNull();
      expect(JSON.stringify(result)).not.toContain('Person');
      expect(JSON.stringify(result)).not.toContain('Platzhalter');
    },
  );

  it('passes on no person for an assignment without one', async () => {
    const { double, client, ctx } = setup();
    double.intercept({ path: '/api/events/2', method: 'GET' }).reply(
      200,
      changed(
        eventAssignmentsAnswer([assignment(11)]).body,
        (data: { eventServices: Record<string, unknown>[] }) => {
          const [first] = data.eventServices;
          if (first === undefined) return;
          first['person'] = null;
          delete first['personId'];
        },
      ),
      json,
    );
    double
      .intercept({ path: '/api/services', method: 'GET' })
      .reply(200, servicesAnswer([service(11)]).body, json);
    double
      .intercept({ path: '/api/servicegroups', method: 'GET' })
      .reply(200, serviceGroupsAnswer([]).body, json);
    const [result] = await client.eventAssignments(ctx(), 2);
    expect(result).toEqual({
      serviceId: 11,
      serviceName: 'Dienst 11',
      isAccepted: true,
      agreed: true,
      person: null,
    });
  });

  it('gives an empty list for an event without assignments, as without the right on the groups of services', async () => {
    const { double, client, ctx } = setup();
    reply(double, [], [service(11)]);
    expect(await client.eventAssignments(ctx(), 2)).toEqual([]);
  });

  it.each([
    ['isAccepted as text', { isAccepted: 'ja' }],
    ['no agreed', { agreed: undefined }],
    ['a service ID 0', { serviceId: 0 }],
    ['a first name of 256 characters', { firstName: 'x'.repeat(256) }],
  ])('gives upstream for an assignment with %s', async (_, change) => {
    const { double, client, ctx, lines } = setup();
    reply(
      double,
      [{ ...assignment(11), ...change } as AssignmentFixture],
      [service(11)],
    );
    expect(await codeOf(client.eventAssignments(ctx(), 2))).toBe('upstream');
    expect(lines.map((line) => line.event)).toEqual([
      'churchtools_event_assignments_refused',
    ]);
  });

  it('gives upstream for more than 500 assignments', async () => {
    const { double, client, ctx } = setup();
    reply(
      double,
      Array.from({ length: 501 }, () => assignment(11)),
      [service(11)],
    );
    expect(await codeOf(client.eventAssignments(ctx(), 2))).toBe('upstream');
  });
});
