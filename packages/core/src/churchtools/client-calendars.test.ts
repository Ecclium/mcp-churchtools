import { loadConfig } from '@ecclium/mcp-churchtools-core';
import {
  isEccliumError,
  type LogFields,
  type TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  appointmentAnswer,
  type AppointmentDetailsFixture,
  type AppointmentFixture,
  appointmentsAnswer,
  assertNoCanary,
  assertPlanted,
  type BookingFixture,
  bookingsAnswer,
  calendarsAnswer,
  createChurchToolsDouble,
  doubleOrigin,
  makeCanary,
  resourcesAnswer,
  resourceTypesAnswer,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { createChurchToolsClient } from './client.js';

// The reads of calendars, appointments, resources and bookings (ADR 0064).
// Every request goes through the real transport on the ChurchTools double,
// which answers from interceptors and connects nowhere. Each answer holds
// a canary in every field the client does not pass on.

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

// An interceptor path that matches a pathname and keeps each path it sees
// with its query, so that a test reads a name that comes more than once,
// such as calendar_ids[]; the history of calls keeps only its last value.
const recording = (pathname: string, seen: string[]) => (path: string) => {
  seen.push(path);
  return path.split('?')[0] === pathname;
};

const queryOf = (seen: readonly string[]) => {
  const last = seen.at(-1);
  return last === undefined
    ? []
    : [...new URL(last, doubleOrigin).searchParams];
};

describe('the calendars', () => {
  const calendar = (id: number) => ({
    id,
    name: `Kalender ${String(id)}`,
    isPublic: id % 2 === 0,
    isPrivate: false,
  });

  it('reads ID, name and whether public or private, sorted by ID, never randomUrl', async () => {
    const { double, client, ctx } = setup();
    const answer = calendarsAnswer([calendar(9), calendar(8)]);
    assertPlanted(JSON.parse(answer.body), answer.canaries, 'answer');
    double
      .intercept({ path: '/api/calendars', method: 'GET' })
      .reply(200, answer.body, json);
    const result = await client.calendars(ctx());
    expect(result).toEqual([calendar(8), calendar(9)]);
    assertNoCanary(result, answer.canaries, 'calendars');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.getPrototypeOf(result[0])).toBeNull();
    expect(double.calls()[0]?.searchParams).toEqual({});
  });

  it('gives an empty list as it comes', async () => {
    const { double, client, ctx } = setup();
    double
      .intercept({ path: '/api/calendars', method: 'GET' })
      .reply(200, calendarsAnswer([]).body, json);
    expect(await client.calendars(ctx())).toEqual([]);
  });

  it.each([
    ['a name of 256 characters', { name: 'x'.repeat(256) }],
    ['isPrivate as text', { isPrivate: 'nein' }],
    ['an ID of 0', { id: 0 }],
  ])('gives upstream for a calendar with %s', async (_, change) => {
    const { double, client, ctx, lines } = setup();
    double.intercept({ path: '/api/calendars', method: 'GET' }).reply(
      200,
      changed(calendarsAnswer([calendar(8)]).body, (data: object[]) => {
        Object.assign(data[0] ?? {}, change);
      }),
      json,
    );
    expect(await codeOf(client.calendars(ctx()))).toBe('upstream');
    expect(lines.map((line) => line.event)).toEqual([
      'churchtools_calendars_refused',
    ]);
  });

  it('gives upstream for more than 1000 calendars', async () => {
    const { double, client, ctx } = setup();
    double
      .intercept({ path: '/api/calendars', method: 'GET' })
      .reply(
        200,
        calendarsAnswer(
          Array.from({ length: 1001 }, (_, index) => calendar(index + 1)),
        ).body,
        json,
      );
    expect(await codeOf(client.calendars(ctx()))).toBe('upstream');
  });
});

const appointment = (
  id: number,
  day = 25,
  extra: Partial<AppointmentFixture> = {},
): AppointmentFixture => ({
  id,
  calendarId: 8,
  title: `Termin ${String(id)}`,
  subtitle: null,
  allDay: false,
  locationName: null,
  startDate: `2026-10-${String(day).padStart(2, '0')}T18:00:00Z`,
  endDate: `2026-10-${String(day).padStart(2, '0')}T19:00:00Z`,
  ...extra,
});

describe('the appointments of a span of days', () => {
  it('asks with exactly calendar_ids[], from and to and keeps only the fields of the list', async () => {
    const { double, client, ctx } = setup();
    const entries = [
      appointment(5, 25, { subtitle: 'Untertitel', locationName: 'Saal' }),
      appointment(6, 26, { calendarId: 9, allDay: true }),
    ];
    const answer = appointmentsAnswer(entries);
    assertPlanted(JSON.parse(answer.body), answer.canaries, 'answer');
    const seen: string[] = [];
    double
      .intercept({
        path: recording('/api/calendars/appointments', seen),
        method: 'GET',
      })
      .reply(200, answer.body, json);
    const result = await client.appointments(
      ctx(),
      [8, 9],
      '2026-10-25',
      '2026-10-31',
    );
    expect(result).toEqual({ appointments: entries, more: false });
    assertNoCanary(result, answer.canaries, 'appointments');
    expect(Object.isFrozen(result.appointments[0])).toBe(true);
    expect(Object.getPrototypeOf(result)).toBeNull();
    const [call] = double.calls();
    expect(call?.path).toBe('/api/calendars/appointments');
    expect(queryOf(seen)).toEqual([
      ['calendar_ids[]', '8'],
      ['calendar_ids[]', '9'],
      ['from', '2026-10-25'],
      ['to', '2026-10-31'],
    ]);
  });

  it('reads a missing subtitle, place or name of a place as none', async () => {
    const { double, client, ctx } = setup();
    double
      .intercept({ path: at('/api/calendars/appointments'), method: 'GET' })
      .reply(
        200,
        changed(
          appointmentsAnswer([
            appointment(5, 25, {
              subtitle: 'Untertitel',
              locationName: 'Saal',
            }),
            appointment(6, 26, { locationName: 'Saal' }),
            appointment(7, 27),
          ]).body,
          (data: { appointment: { base: Record<string, unknown> } }[]) => {
            const [first, second, third] = data.map(
              (entry) => entry.appointment.base,
            );
            delete first?.['subtitle'];
            delete first?.['address'];
            delete (second?.['address'] as Record<string, unknown>)['name'];
            if (third !== undefined) third['subtitle'] = null;
          },
        ),
        json,
      );
    const result = await client.appointments(
      ctx(),
      [8],
      '2026-10-25',
      '2026-10-31',
    );
    expect(
      result.appointments.map((entry) => [entry.subtitle, entry.locationName]),
    ).toEqual([
      [null, null],
      [null, null],
      [null, null],
    ]);
  });

  it('takes a day alone as start and end, as an entry for whole days may have', async () => {
    const { double, client, ctx } = setup();
    const whole = appointment(5, 25, {
      allDay: true,
      startDate: '2026-10-25',
      endDate: '2026-10-26',
    });
    double
      .intercept({ path: at('/api/calendars/appointments'), method: 'GET' })
      .reply(200, appointmentsAnswer([appointment(4, 25), whole]).body, json);
    const result = await client.appointments(
      ctx(),
      [8],
      '2026-10-25',
      '2026-10-31',
    );
    // A day alone sorts before the times of that day.
    expect(result.appointments).toEqual([whole, appointment(4, 25)]);
  });

  it('sorts by start and ID and gives 50 with more for 51, also from a longer answer', async () => {
    const { double, client, ctx } = setup();
    // In reverse order, spread over the days of the month; the dates of a
    // series share their ID.
    const many = (count: number) =>
      appointmentsAnswer(
        Array.from({ length: count }, (_, index) =>
          appointment(1 + ((count - index) % 7), 1 + ((count - index) % 28)),
        ),
      ).body;
    for (const count of [50, 51, 1000, 1001]) {
      double
        .intercept({ path: at('/api/calendars/appointments'), method: 'GET' })
        .reply(200, many(count), json);
    }
    const read = () =>
      client.appointments(ctx(), [8], '2026-10-01', '2026-10-31');
    const fifty = await read();
    expect([fifty.appointments.length, fifty.more]).toEqual([50, false]);
    const sorted = [...fifty.appointments].sort(
      (a, b) => a.startDate.localeCompare(b.startDate) || a.id - b.id,
    );
    expect(fifty.appointments).toEqual(sorted);
    const more = await read();
    expect([more.appointments.length, more.more]).toEqual([50, true]);
    const thousand = await read();
    expect([thousand.appointments.length, thousand.more]).toEqual([50, true]);
    expect(thousand.appointments[0]?.startDate).toBe('2026-10-01T18:00:00Z');
    expect(await codeOf(read())).toBe('upstream');
  });

  it.each([
    ['a start without Z', { startDate: '2026-10-25T18:00:00' }],
    ['an end with fractions', { endDate: '2026-10-25T19:00:00.000Z' }],
    ['a start as a date of another form', { startDate: '25.10.2026' }],
  ])('gives upstream for a date with %s', async (_, change) => {
    const { double, client, ctx, lines } = setup();
    double
      .intercept({ path: at('/api/calendars/appointments'), method: 'GET' })
      .reply(
        200,
        changed(
          appointmentsAnswer([appointment(5)]).body,
          (data: { appointment: { calculated: object } }[]) => {
            Object.assign(data[0]?.appointment.calculated ?? {}, change);
          },
        ),
        json,
      );
    expect(
      await codeOf(client.appointments(ctx(), [8], '2026-10-25', '2026-10-31')),
    ).toBe('upstream');
    expect(lines.map((line) => line.event)).toEqual([
      'churchtools_appointments_refused',
    ]);
  });

  it.each([
    ['a calendar ID of 0', { calendarId: 0 }],
    ['a calendar ID as text', { calendarId: '8' }],
    ['a title of 256 characters', { title: 'x'.repeat(256) }],
    ['a place of 256 characters', { locationName: 'x'.repeat(256) }],
  ])('gives upstream for an appointment with %s', async (_, change) => {
    const { double, client, ctx } = setup();
    double
      .intercept({ path: at('/api/calendars/appointments'), method: 'GET' })
      .reply(200, appointmentsAnswer([appointment(5, 25, change)]).body, json);
    expect(
      await codeOf(client.appointments(ctx(), [8], '2026-10-25', '2026-10-31')),
    ).toBe('upstream');
  });

  it('maps 403 to permission and every other status to its code', async () => {
    const { double, client, ctx, lines } = setup();
    for (const status of [403, 401, 404, 500]) {
      double
        .intercept({ path: at('/api/calendars/appointments'), method: 'GET' })
        .reply(status, '{}', json);
    }
    const read = () =>
      client.appointments(ctx(), [8], '2026-10-25', '2026-10-31');
    expect(await codeOf(read())).toBe('permission');
    expect(await codeOf(read())).toBe('auth');
    // The path of the list is fixed and exists: a 404 is no missing object.
    expect(await codeOf(read())).toBe('upstream');
    expect(await codeOf(read())).toBe('upstream');
    expect(lines.map((line) => line.event)).toEqual(
      Array.from({ length: 4 }, () => 'churchtools_appointments_status'),
    );
  });
});

// The types forbid most of these; a plugin built without them can still
// pass them. Only checked IDs and a checked span fill a query or a path.
describe('the checks before any request', () => {
  const span = ['2026-10-25', '2026-10-31'] as const;

  it.each([
    ['no calendar', [], ...span],
    ['11 calendars', Array.from({ length: 11 }, (_, i) => i + 1), ...span],
    ['the same calendar twice', [8, 8], ...span],
    ['an ID of 0', [0], ...span],
    ['an ID as text', ['8'], ...span],
    ['an ID with more of a query', ['8&from=2000-01-01'], ...span],
    ['no list', 8, ...span],
    ['32 days', [8], '2026-10-01', '2026-11-01'],
    ['a last day before the first', [8], '2026-10-25', '2026-10-24'],
    ['a day that does not exist', [8], '2026-02-30', '2026-03-01'],
    ['a date with time', [8], '2026-10-25T00:00:00Z', '2026-10-26'],
  ] as const)(
    'refuses %s for appointments and bookings',
    async (_, ids, from, to) => {
      const { double, client, ctx, lines } = setup();
      const list = ids as unknown as readonly number[];
      expect(await codeOf(client.appointments(ctx(), list, from, to))).toBe(
        'validation',
      );
      expect(await codeOf(client.bookings(ctx(), list, from, to))).toBe(
        'validation',
      );
      expect(double.calls()).toHaveLength(0);
      expect(lines.map((line) => line.event)).toEqual([
        'churchtools_calendar_input_refused',
        'churchtools_calendar_input_refused',
      ]);
    },
  );

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.MAX_SAFE_INTEGER + 1,
    '5' as unknown as number,
    '5/../../whoami' as unknown as number,
  ])('refuses the ID %j of one appointment', async (value) => {
    const { double, client, ctx } = setup();
    expect(await codeOf(client.appointment(ctx(), value, 5))).toBe(
      'validation',
    );
    expect(await codeOf(client.appointment(ctx(), 8, value))).toBe(
      'validation',
    );
    expect(double.calls()).toHaveLength(0);
  });
});

describe('one appointment', () => {
  const details = (
    extra: Partial<AppointmentDetailsFixture> = {},
  ): AppointmentDetailsFixture => ({
    id: 5,
    calendarId: 8,
    title: 'Termin',
    subtitle: 'Untertitel',
    allDay: false,
    locationName: 'Saal',
    description: 'Beschreibung des Termins',
    link: 'https://example.org/termin',
    dates: [
      {
        key: 'k1',
        startDate: '2026-11-01T18:00:00Z',
        endDate: '2026-11-01T19:00:00Z',
      },
      {
        key: 'k0',
        startDate: '2026-10-25T18:00:00Z',
        endDate: '2026-10-25T19:00:00Z',
      },
    ],
    ...extra,
  });

  it('reads the fields of the list with description, link and the dates sorted by start, never the keys', async () => {
    const { double, client, ctx } = setup();
    const answer = appointmentAnswer(details());
    assertPlanted(JSON.parse(answer.body), answer.canaries, 'answer');
    double
      .intercept({ path: '/api/calendars/8/appointments/5', method: 'GET' })
      .reply(200, answer.body, json);
    const result = await client.appointment(ctx(), 8, 5);
    expect(result).toEqual({
      id: 5,
      calendarId: 8,
      title: 'Termin',
      subtitle: 'Untertitel',
      allDay: false,
      locationName: 'Saal',
      description: 'Beschreibung des Termins',
      link: 'https://example.org/termin',
      dates: [
        { startDate: '2026-10-25T18:00:00Z', endDate: '2026-10-25T19:00:00Z' },
        { startDate: '2026-11-01T18:00:00Z', endDate: '2026-11-01T19:00:00Z' },
      ],
    });
    assertNoCanary(result, answer.canaries, 'appointment');
    expect(JSON.stringify(result)).not.toContain('k0');
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(Object.isFrozen(result.dates)).toBe(true);
    expect(double.calls()[0]?.searchParams).toEqual({});
  });

  it('reads a missing description and link as none and an empty list of dates as no dates', async () => {
    const { double, client, ctx } = setup();
    double
      .intercept({ path: '/api/calendars/8/appointments/5', method: 'GET' })
      .reply(
        200,
        changed(
          appointmentAnswer(details({ link: null })).body,
          (data: {
            appointment: Record<string, unknown>;
            calculatedDates: unknown;
          }) => {
            delete data.appointment['description'];
            data.calculatedDates = [];
          },
        ),
        json,
      );
    const result = await client.appointment(ctx(), 8, 5);
    expect([result.description, result.link, result.dates]).toEqual([
      null,
      null,
      [],
    ]);
  });

  it('takes 500 dates and gives upstream for 501', async () => {
    const { double, client, ctx } = setup();
    const dates = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        key: `k${String(index)}`,
        startDate: '2026-10-25',
        endDate: '2026-10-25',
      }));
    for (const count of [500, 501]) {
      double
        .intercept({ path: '/api/calendars/8/appointments/5', method: 'GET' })
        .reply(
          200,
          appointmentAnswer(details({ dates: dates(count) })).body,
          json,
        );
    }
    expect((await client.appointment(ctx(), 8, 5)).dates).toHaveLength(500);
    expect(await codeOf(client.appointment(ctx(), 8, 5))).toBe('upstream');
  });

  it.each([
    ['a description of 7001 code units', { description: 'x'.repeat(7001) }],
    ['a link of 1001 code units', { link: 'x'.repeat(1001) }],
    ['a calendar ID of 0', { calendarId: 0 }],
  ])('gives upstream for an appointment with %s', async (_, change) => {
    const { double, client, ctx, lines } = setup();
    double
      .intercept({ path: '/api/calendars/8/appointments/5', method: 'GET' })
      .reply(200, appointmentAnswer(details(change)).body, json);
    expect(await codeOf(client.appointment(ctx(), 8, 5))).toBe('upstream');
    expect(lines.map((line) => line.event)).toEqual([
      'churchtools_appointment_refused',
    ]);
  });

  it('maps 404 to not_found and 403 to permission', async () => {
    const { double, client, ctx, lines } = setup();
    for (const status of [404, 403]) {
      double
        .intercept({ path: '/api/calendars/8/appointments/7', method: 'GET' })
        .reply(status, '{}', json);
    }
    expect(await codeOf(client.appointment(ctx(), 8, 7))).toBe('not_found');
    expect(await codeOf(client.appointment(ctx(), 8, 7))).toBe('permission');
    expect(lines).toEqual([
      {
        event: 'churchtools_appointment_missing',
        fields: { status: 404, code: 'not_found' },
      },
      {
        event: 'churchtools_appointment_status',
        fields: { status: 403, code: 'permission' },
      },
    ]);
  });
});

describe('the resources', () => {
  it('reads resources and types, each sorted by ID, never randomString or adminIds', async () => {
    const { double, client, ctx } = setup();
    const resources = resourcesAnswer([
      { id: 9, name: 'Raum B', resourceTypeId: 5 },
      { id: 8, name: 'Raum A', resourceTypeId: 5 },
    ]);
    const types = resourceTypesAnswer([
      { id: 6, name: 'Geräte' },
      { id: 5, name: 'Räume' },
    ]);
    assertPlanted(JSON.parse(resources.body), resources.canaries, 'resources');
    assertPlanted(JSON.parse(types.body), types.canaries, 'types');
    double
      .intercept({ path: '/api/resources', method: 'GET' })
      .reply(200, resources.body, json);
    double
      .intercept({ path: '/api/resourcetypes', method: 'GET' })
      .reply(200, types.body, json);
    const result = await client.resources(ctx());
    expect(result).toEqual({
      resources: [
        { id: 8, name: 'Raum A', resourceTypeId: 5 },
        { id: 9, name: 'Raum B', resourceTypeId: 5 },
      ],
      resourceTypes: [
        { id: 5, name: 'Räume' },
        { id: 6, name: 'Geräte' },
      ],
    });
    assertNoCanary(
      result,
      [...resources.canaries, ...types.canaries],
      'resources',
    );
    expect(Object.getPrototypeOf(result.resources[0])).toBeNull();
    expect(double.calls().map((call) => call.path)).toEqual([
      '/api/resources',
      '/api/resourcetypes',
    ]);
  });

  it('gives upstream for resources that do not fit, without asking for the types', async () => {
    const { double, client, ctx, lines } = setup();
    double.intercept({ path: '/api/resources', method: 'GET' }).reply(
      200,
      resourcesAnswer(
        Array.from({ length: 1001 }, (_, index) => ({
          id: index + 1,
          name: 'Raum',
          resourceTypeId: 5,
        })),
      ).body,
      json,
    );
    expect(await codeOf(client.resources(ctx()))).toBe('upstream');
    expect(lines.map((line) => line.event)).toEqual([
      'churchtools_resources_refused',
    ]);
    expect(double.calls()).toHaveLength(1);
  });

  it('gives upstream for a type that does not fit', async () => {
    const { double, client, ctx, lines } = setup();
    double
      .intercept({ path: '/api/resources', method: 'GET' })
      .reply(200, resourcesAnswer([]).body, json);
    double
      .intercept({ path: '/api/resourcetypes', method: 'GET' })
      .reply(
        200,
        resourceTypesAnswer([{ id: 5, name: 'x'.repeat(256) }]).body,
        json,
      );
    expect(await codeOf(client.resources(ctx()))).toBe('upstream');
    expect(lines.map((line) => line.event)).toEqual([
      'churchtools_resource_types_refused',
    ]);
  });
});

describe('the bookings of a span of days', () => {
  const booking = (
    id: number,
    day = 25,
    extra: Partial<BookingFixture> = {},
  ): BookingFixture => ({
    id,
    title: `Buchung ${String(id)}`,
    resourceId: 8,
    statusId: 2,
    appointmentId: 5,
    startDate: `2026-10-${String(day).padStart(2, '0')}T18:00:00Z`,
    endDate: `2026-10-${String(day).padStart(2, '0')}T19:00:00Z`,
    ...extra,
  });

  it('asks with exactly resource_ids[], from and to and keeps only the fields of the list', async () => {
    const { double, client, ctx } = setup();
    const answer = bookingsAnswer([booking(3, 26), booking(2, 25)]);
    assertPlanted(JSON.parse(answer.body), answer.canaries, 'answer');
    const seen: string[] = [];
    double
      .intercept({ path: recording('/api/bookings', seen), method: 'GET' })
      .reply(200, answer.body, json);
    const result = await client.bookings(
      ctx(),
      [8],
      '2026-10-25',
      '2026-10-31',
    );
    expect(result).toEqual({
      bookings: [booking(2), booking(3, 26)],
      more: false,
    });
    assertNoCanary(result, answer.canaries, 'bookings');
    expect(Object.getPrototypeOf(result.bookings[0])).toBeNull();
    const [call] = double.calls();
    expect(call?.path).toBe('/api/bookings');
    expect(queryOf(seen)).toEqual([
      ['resource_ids[]', '8'],
      ['from', '2026-10-25'],
      ['to', '2026-10-31'],
    ]);
  });

  it('gives no appointment for none, null or an ID below 1, and takes a day alone', async () => {
    const { double, client, ctx } = setup();
    const whole = { startDate: '2026-10-27', endDate: '2026-10-27' };
    double
      .intercept({ path: at('/api/bookings'), method: 'GET' })
      .reply(
        200,
        bookingsAnswer([
          booking(2, 25, { appointmentId: undefined }),
          booking(3, 25, { appointmentId: null }),
          booking(4, 25, { appointmentId: 0 }),
          booking(5, 25, whole),
        ]).body,
        json,
      );
    const result = await client.bookings(
      ctx(),
      [8],
      '2026-10-25',
      '2026-10-31',
    );
    expect(result.bookings.map((entry) => entry.appointmentId)).toEqual([
      null,
      null,
      null,
      5,
    ]);
    expect(result.bookings[3]).toMatchObject(whole);
  });

  it('sorts by start and ID and gives 50 with more for 51, and upstream for 1001', async () => {
    const { double, client, ctx } = setup();
    const many = (count: number) =>
      bookingsAnswer(
        Array.from({ length: count }, (_, index) =>
          booking(count - index, 1 + ((count - index) % 28)),
        ),
      ).body;
    for (const count of [51, 1001]) {
      double
        .intercept({ path: at('/api/bookings'), method: 'GET' })
        .reply(200, many(count), json);
    }
    const read = () => client.bookings(ctx(), [8], '2026-10-01', '2026-10-31');
    const more = await read();
    expect([more.bookings.length, more.more]).toEqual([50, true]);
    const sorted = [...more.bookings].sort(
      (a, b) => a.startDate.localeCompare(b.startDate) || a.id - b.id,
    );
    expect(more.bookings).toEqual(sorted);
    expect(await codeOf(read())).toBe('upstream');
  });

  it.each([
    ['a state below 0', { statusId: -1 }],
    ['a title of 256 characters', { title: 'x'.repeat(256) }],
    ['a resource ID of 0', { resourceId: 0 }],
    ['a start without Z', { startDate: '2026-10-25T18:00:00' }],
  ])('gives upstream for a booking with %s', async (_, change) => {
    const { double, client, ctx, lines } = setup();
    double
      .intercept({ path: at('/api/bookings'), method: 'GET' })
      .reply(200, bookingsAnswer([booking(2, 25, change)]).body, json);
    expect(
      await codeOf(client.bookings(ctx(), [8], '2026-10-25', '2026-10-31')),
    ).toBe('upstream');
    expect(lines.map((line) => line.event)).toEqual([
      'churchtools_bookings_refused',
    ]);
  });

  it('maps 403 to permission', async () => {
    const { double, client, ctx, lines } = setup();
    double
      .intercept({ path: at('/api/bookings'), method: 'GET' })
      .reply(403, '{}', json);
    expect(
      await codeOf(client.bookings(ctx(), [8], '2026-10-25', '2026-10-31')),
    ).toBe('permission');
    expect(lines).toEqual([
      {
        event: 'churchtools_bookings_status',
        fields: { status: 403, code: 'permission' },
      },
    ]);
  });
});
