import {
  createToolCatalog,
  createToolPipeline,
  loadConfig,
  type ToolCatalog,
  type ToolPipelineOptions,
  type ToolRequest,
} from '@ecclium/mcp-churchtools-core';
import {
  type Plugin,
  type ReadApi,
  type TenantAssignment,
  type TenantContext,
  type ToolDefinition,
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
  createMemoryQuotaStore,
  doubleOrigin,
  makeCanaries,
  resourcesAnswer,
  resourceTypesAnswer,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { appointmentsGetTool, datesPerCall } from './appointments/get.js';
import {
  appointmentsListTool,
  fewerAppointmentsNeeded,
  noAppointmentListed,
  pastLastAppointmentPage,
} from './appointments/list.js';
import {
  bookingsListTool,
  fewerBookingsNeeded,
  noBookingListed,
  pastLastBookingPage,
} from './bookings/list.js';
import {
  calendarsListTool,
  noCalendarListed,
  pastLastCalendarPage,
} from './calendars/list.js';
import {
  appointmentNotFound,
  appointmentRefused,
  appointmentsRefused,
  invalidIds,
} from './calendars/rights.js';
import { createCorePlugin } from './core-plugin.js';
import { invalidSpan } from './events/list.js';
import {
  noResourceListed,
  pastLastResourcePage,
  resourcesListTool,
} from './resources/list.js';
import { bookingsRefused } from './resources/rights.js';

// The five reads of calendars, appointments, resources and bookings of
// ADR 0064 run through the pipeline of the core on the double of
// ChurchTools, as the server runs them, with the toolset calendars and an
// audit file. The three layers are the client, which reads only the fields
// of its schema, the tool, which declares and copies only them, and the
// pipeline, which lets nothing through that the output schema does not
// declare.

type AuditSink = ToolPipelineOptions['audit'];
type AuditDraft = Parameters<AuditSink['record']>[0];
type LineWriter = ToolPipelineOptions['logging']['writer'];

const canary = makeCanaries();
const loaded = loadConfig({
  environment: {
    ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
    ECCLIUM_CHURCHTOOLS_TOKEN: canary.token.value,
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

const request = (): ToolRequest => ({
  assignment: {
    tenantId: 'default',
    actor: { kind: 'user', id: 'stdio:local-stdio' },
  } as unknown as TenantAssignment,
  mode: 'interactive',
  redaction: 'standard',
  readOnly: true,
  features: [],
  signal: new AbortController().signal,
});

const coreCatalog = (): ToolCatalog =>
  createToolCatalog({
    core: createCorePlugin(),
    toolsets: new Set(['calendars'] as const),
    plugins: [],
    readOnly: true,
  });

const setup = (catalog: ToolCatalog = coreCatalog()) => {
  const double = createChurchToolsDouble({
    token: loaded.config.churchtoolsToken,
  });
  open.push(double);
  const lines: string[] = [];
  const drafts: AuditDraft[] = [];
  const quota = new Map<string, number>();
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
    quota: createMemoryQuotaStore(quota),
    catalog,
    audit,
    transport: double.transport,
    origin: doubleOrigin,
    requestsPerMinute: 300,
    clock: Object.freeze({ now: Object.freeze(() => 0) }),
    logging: { writer, minLevel: 'debug' },
  });
  const call = (name: string, input: unknown) =>
    pipeline.call(name, input, request());
  return { double, lines, drafts, quota, call };
};

// A text in the data envelope: the markers with the boundary of the call
// around it.
const enveloped = (text: string): unknown =>
  expect.stringMatching(
    new RegExp(
      `^<<data-[^>]+>>${text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}<</data-[^>]+>>$`,
      'u',
    ),
  ) as unknown;

const calendar = (id: number) => ({
  id,
  name: `Kalender ${String(id)}`,
  isPublic: false,
  isPrivate: false,
});
const appointment = (
  id: number,
  extra: Partial<AppointmentFixture> = {},
): AppointmentFixture => ({
  id,
  calendarId: 8,
  title: `Termin ${String(id)}`,
  subtitle: null,
  allDay: false,
  locationName: null,
  startDate: '2026-10-25T18:00:00Z',
  endDate: '2026-10-25T19:00:00Z',
  ...extra,
});
const details = (
  extra: Partial<AppointmentDetailsFixture> = {},
): AppointmentDetailsFixture => ({
  id: 5,
  calendarId: 8,
  title: 'Termin 5',
  subtitle: 'Untertitel',
  allDay: false,
  locationName: 'Saal',
  description: 'Beschreibung des Termins',
  link: 'https://example.org/termin',
  dates: [
    {
      key: 'k0',
      startDate: '2026-10-25T18:00:00Z',
      endDate: '2026-10-25T19:00:00Z',
    },
  ],
  ...extra,
});
const booking = (
  id: number,
  extra: Partial<BookingFixture> = {},
): BookingFixture => ({
  id,
  title: `Buchung ${String(id)}`,
  resourceId: 8,
  statusId: 2,
  appointmentId: 5,
  startDate: '2026-10-25T18:00:00Z',
  endDate: '2026-10-25T19:00:00Z',
  ...extra,
});
const days = { from: '2026-10-25', to: '2026-10-31' } as const;

// The resources and their types, as the list reads them.
const replyResources = (
  double: ReturnType<typeof setup>['double'],
  resources: readonly {
    readonly id: number;
    readonly name: string;
    readonly resourceTypeId: number;
  }[],
  typeName = 'Räume',
) => {
  const list = resourcesAnswer(resources);
  const types = resourceTypesAnswer([{ id: 5, name: typeName }]);
  assertPlanted(JSON.parse(list.body), list.canaries, 'resources');
  assertPlanted(JSON.parse(types.body), types.canaries, 'types');
  double
    .intercept({ path: '/api/resources', method: 'GET' })
    .reply(200, list.body, json);
  double
    .intercept({ path: '/api/resourcetypes', method: 'GET' })
    .reply(200, types.body, json);
  return [...list.canaries, ...types.canaries];
};

// One page of a list in a result: its entries, more and the notice, or
// false for a failed call.
const pageOf = (
  outcome: Awaited<ReturnType<ReturnType<typeof setup>['call']>>,
  key: string,
) => {
  if (!outcome.ok) return false;
  const data = outcome.data;
  return {
    entries: data[key] as readonly Readonly<Record<string, unknown>>[],
    more: data['more'],
    notice: data['notice'],
  };
};

const viewCategory = { module: 'churchcal', right: 'view category' };
const viewResource = { module: 'churchresource', right: 'view resource' };

describe('the three layers together', () => {
  it('let no field of the calendars but the four reach result, log or audit', async () => {
    const { double, lines, drafts, call } = setup();
    const answer = calendarsAnswer([calendar(9), calendar(8)]);
    assertPlanted(JSON.parse(answer.body), answer.canaries, 'answer');
    double
      .intercept({ path: '/api/calendars', method: 'GET' })
      .reply(200, answer.body, json);
    const outcome = await call('ct_calendars_list', {});
    expect(outcome.ok && outcome.data).toEqual({
      page: 1,
      calendars: [8, 9].map((id) => ({
        ...calendar(id),
        name: enveloped(`Kalender ${String(id)}`),
      })),
      more: false,
      notice: null,
    });
    assertNoCanary(
      [outcome, lines, drafts],
      answer.canaries,
      'result, log, audit',
    );
    expect(drafts).toEqual([
      expect.objectContaining({ tool: 'ct_calendars_list', outcome: 'ok' }),
    ]);
  });

  it('let no field of the appointments but the eight reach result, log or audit', async () => {
    const { double, lines, drafts, call } = setup();
    const answer = appointmentsAnswer([
      appointment(5, { subtitle: 'Untertitel', locationName: 'Saal' }),
      appointment(6, {
        allDay: true,
        startDate: '2026-10-26',
        endDate: '2026-10-26',
      }),
    ]);
    assertPlanted(JSON.parse(answer.body), answer.canaries, 'answer');
    double
      .intercept({ path: at('/api/calendars/appointments'), method: 'GET' })
      .reply(200, answer.body, json);
    const outcome = await call('ct_appointments_list', {
      calendarIds: [8],
      ...days,
    });
    expect(outcome.ok && outcome.data).toEqual({
      ...days,
      page: 1,
      appointments: [
        {
          ...appointment(5),
          title: enveloped('Termin 5'),
          subtitle: enveloped('Untertitel'),
          locationName: enveloped('Saal'),
        },
        {
          ...appointment(6),
          title: enveloped('Termin 6'),
          allDay: true,
          startDate: '2026-10-26',
          endDate: '2026-10-26',
        },
      ],
      more: false,
      notice: null,
    });
    assertNoCanary(
      [outcome, lines, drafts],
      answer.canaries,
      'result, log, audit',
    );
  });

  it('let no field of an appointment but the declared ones reach result, log or audit', async () => {
    const { double, lines, drafts, call } = setup();
    const answer = appointmentAnswer(details());
    assertPlanted(JSON.parse(answer.body), answer.canaries, 'answer');
    double
      .intercept({ path: '/api/calendars/8/appointments/5', method: 'GET' })
      .reply(200, answer.body, json);
    const outcome = await call('ct_appointments_get', {
      calendarId: 8,
      appointmentId: 5,
    });
    expect(outcome.ok && outcome.data).toEqual({
      id: 5,
      calendarId: 8,
      title: enveloped('Termin 5'),
      subtitle: enveloped('Untertitel'),
      allDay: false,
      locationName: enveloped('Saal'),
      description: enveloped('Beschreibung des Termins'),
      link: enveloped('https://example.org/termin'),
      dates: [
        { startDate: '2026-10-25T18:00:00Z', endDate: '2026-10-25T19:00:00Z' },
      ],
      moreDates: false,
    });
    assertNoCanary(
      [outcome, lines, drafts],
      answer.canaries,
      'result, log, audit',
    );
  });

  it('let no field of the resources but the declared ones reach result, log or audit', async () => {
    const { double, lines, drafts, call } = setup();
    const canaries = replyResources(double, [
      { id: 9, name: 'Raum B', resourceTypeId: 6 },
      { id: 8, name: 'Raum A', resourceTypeId: 5 },
    ]);
    const outcome = await call('ct_resources_list', {});
    expect(outcome.ok && outcome.data).toEqual({
      page: 1,
      resources: [
        {
          id: 8,
          name: enveloped('Raum A'),
          resourceTypeId: 5,
          resourceTypeName: enveloped('Räume'),
        },
        {
          id: 9,
          name: enveloped('Raum B'),
          resourceTypeId: 6,
          resourceTypeName: null,
        },
      ],
      more: false,
      notice: null,
    });
    assertNoCanary([outcome, lines, drafts], canaries, 'result, log, audit');
  });

  it('let no field of the bookings but the seven reach result, log or audit', async () => {
    const { double, lines, drafts, call } = setup();
    const answer = bookingsAnswer([
      booking(2),
      booking(3, { appointmentId: null }),
    ]);
    assertPlanted(JSON.parse(answer.body), answer.canaries, 'answer');
    double
      .intercept({ path: at('/api/bookings'), method: 'GET' })
      .reply(200, answer.body, json);
    const outcome = await call('ct_bookings_list', {
      resourceIds: [8],
      ...days,
    });
    expect(outcome.ok && outcome.data).toEqual({
      ...days,
      page: 1,
      bookings: [
        { ...booking(2), title: enveloped('Buchung 2') },
        { ...booking(3), title: enveloped('Buchung 3'), appointmentId: null },
      ],
      more: false,
      notice: null,
    });
    assertNoCanary(
      [outcome, lines, drafts],
      answer.canaries,
      'result, log, audit',
    );
  });
});

describe('the five tools in the catalog', () => {
  it('name the right that opens their read, may run unattended by policy and are not treated as special', () => {
    const catalog = coreCatalog();
    for (const [name, right, routineStable] of [
      ['ct_calendars_list', viewCategory, false],
      ['ct_appointments_list', viewCategory, true],
      ['ct_appointments_get', viewCategory, false],
      ['ct_resources_list', viewResource, false],
      ['ct_bookings_list', viewResource, false],
    ] as const) {
      const listed = catalog.get(name);
      expect(listed?.meta.requiredRights, name).toEqual([right]);
      expect(listed?.meta.unattended, name).toBe('policy');
      expect(listed?.meta.routineStable, name).toBe(routineStable);
      expect(listed?.asSpecial, name).toBe(false);
    }
  });

  it('count no call against the read budget', async () => {
    const { double, quota, call } = setup();
    double
      .intercept({ path: '/api/calendars', method: 'GET' })
      .reply(200, calendarsAnswer([calendar(8)]).body, json);
    double
      .intercept({ path: at('/api/bookings'), method: 'GET' })
      .reply(200, bookingsAnswer([booking(2)]).body, json);
    expect((await call('ct_calendars_list', {})).ok).toBe(true);
    expect(
      (await call('ct_bookings_list', { resourceIds: [8], ...days })).ok,
    ).toBe(true);
    expect([...quota.values()]).toEqual([]);
  });
});

describe('ct_calendars_list', () => {
  it('names the right when no calendar is listed, and says so for an empty later page', async () => {
    const { double, call } = setup();
    for (const count of [0, 3]) {
      double
        .intercept({ path: '/api/calendars', method: 'GET' })
        .reply(
          200,
          calendarsAnswer(
            Array.from({ length: count }, (_, index) => calendar(index + 1)),
          ).body,
          json,
        );
    }
    const empty = await call('ct_calendars_list', {});
    expect(empty.ok && empty.data.notice).toBe(noCalendarListed);
    expect(noCalendarListed).toContain('"view category" in churchcal');
    const later = await call('ct_calendars_list', { page: 2 });
    expect(later.ok && later.data.notice).toBe(pastLastCalendarPage);
  });

  it('pages through 30 calendars, 25 per call', async () => {
    const { double, call } = setup();
    const answer = calendarsAnswer(
      Array.from({ length: 30 }, (_, index) => calendar(index + 1)),
    ).body;
    for (let count = 0; count < 2; count += 1) {
      double
        .intercept({ path: '/api/calendars', method: 'GET' })
        .reply(200, answer, json);
    }
    const summary = [];
    for (const page of [1, 2]) {
      const shown = pageOf(
        await call('ct_calendars_list', { page }),
        'calendars',
      );
      summary.push(
        shown && [shown.entries.length, shown.entries[0]?.['id'], shown.more],
      );
    }
    expect(summary).toEqual([
      [25, 1, true],
      [5, 26, false],
    ]);
  });
});

describe('ct_appointments_list and ct_bookings_list', () => {
  it.each([
    ['ct_appointments_list', 'calendarIds'],
    ['ct_bookings_list', 'resourceIds'],
  ] as const)(
    '%s refuses IDs and days that do not fit with a sentence that names the rule, before any request',
    async (name, key) => {
      const { double, call } = setup();
      const twice = await call(name, { [key]: [8, 8], ...days });
      expect(!twice.ok && twice.error).toEqual({
        code: 'validation',
        message: invalidIds,
      });
      const long = await call(name, {
        [key]: [8],
        from: '2026-10-01',
        to: '2026-11-01',
      });
      expect(!long.ok && long.error).toEqual({
        code: 'validation',
        message: invalidSpan,
      });
      for (const ids of [
        [],
        Array.from({ length: 11 }, (_, i) => i + 1),
        [0],
      ]) {
        const outcome = await call(name, { [key]: ids, ...days });
        expect(!outcome.ok && outcome.error.code).toBe('validation');
      }
      expect(double.calls()).toEqual([]);
    },
  );

  it.each([
    [
      'ct_appointments_list',
      { calendarIds: [8], ...days },
      '/api/calendars/appointments',
      appointmentsRefused,
      viewCategory,
    ],
    [
      'ct_bookings_list',
      { resourceIds: [8], ...days },
      '/api/bookings',
      bookingsRefused,
      viewResource,
    ],
  ] as const)(
    '%s ends 403 with permission and the right',
    async (name, input, pathname, message, right) => {
      const { double, call } = setup();
      double
        .intercept({ path: at(pathname), method: 'GET' })
        .reply(403, '{}', json);
      const outcome = await call(name, input);
      expect(!outcome.ok && outcome.error).toEqual({
        code: 'permission',
        message,
        missingRights: [right],
      });
    },
  );

  it('say so for days without appointments or bookings, and that a mixed list is not verified', async () => {
    const { double, call } = setup();
    double
      .intercept({ path: at('/api/calendars/appointments'), method: 'GET' })
      .reply(200, appointmentsAnswer([]).body, json);
    double
      .intercept({ path: at('/api/bookings'), method: 'GET' })
      .reply(200, bookingsAnswer([]).body, json);
    const appointments = await call('ct_appointments_list', {
      calendarIds: [8],
      ...days,
    });
    expect(appointments.ok && appointments.data.notice).toBe(
      noAppointmentListed,
    );
    const bookings = await call('ct_bookings_list', {
      resourceIds: [8],
      ...days,
    });
    expect(bookings.ok && bookings.data.notice).toBe(noBookingListed);
    // Refused for one calendar or resource (F36); a mixed list is open.
    expect(noAppointmentListed).toContain('not verified');
    expect(noBookingListed).toContain('not verified');
  });

  it.each([
    [
      'ct_appointments_list',
      'appointments',
      { calendarIds: [8, 9] },
      '/api/calendars/appointments',
      (count: number) =>
        appointmentsAnswer(
          Array.from({ length: count }, (_, index) => appointment(index + 1)),
        ).body,
      fewerAppointmentsNeeded,
      pastLastAppointmentPage,
    ],
    [
      'ct_bookings_list',
      'bookings',
      { resourceIds: [8, 9] },
      '/api/bookings',
      (count: number) =>
        bookingsAnswer(
          Array.from({ length: count }, (_, index) => booking(index + 1)),
        ).body,
      fewerBookingsNeeded,
      pastLastBookingPage,
    ],
  ] as const)(
    '%s pages through 50, 25 per call, and asks for fewer days when more follow',
    async (name, key, ids, pathname, answer, fewer, pastLast) => {
      const { double, call } = setup();
      for (const count of [50, 50, 51, 51, 30, 10]) {
        double
          .intercept({ path: at(pathname), method: 'GET' })
          .reply(200, answer(count), json);
      }
      const summary = [];
      for (const page of [1, 2, 1, 2, 2, 2]) {
        const shown = pageOf(await call(name, { ...ids, ...days, page }), key);
        summary.push(
          shown && [
            shown.entries.length,
            shown.entries[0]?.['id'],
            shown.more,
            shown.notice,
          ],
        );
      }
      expect(summary).toEqual([
        [25, 1, true, null],
        [25, 26, false, null],
        [25, 1, true, null],
        [25, 26, false, fewer],
        [5, 26, false, null],
        [0, undefined, false, pastLast],
      ]);
      const third = await call(name, { ...ids, ...days, page: 3 });
      expect(!third.ok && third.error.code).toBe('validation');
    },
  );
});

describe('an answer longer than the core reads', () => {
  it.each([
    [
      'ct_appointments_list',
      { calendarIds: [8], ...days },
      '/api/calendars/appointments',
      'Ask for fewer days or fewer calendars.',
    ],
    [
      'ct_bookings_list',
      { resourceIds: [8], ...days },
      '/api/bookings',
      'Ask for fewer days or fewer resources.',
    ],
  ] as const)(
    '%s ends with upstream and says what to do',
    async (name, input, pathname, hint) => {
      const { double, call } = setup();
      double
        .intercept({ path: at(pathname), method: 'GET' })
        .reply(
          200,
          JSON.stringify({ data: Array.from({ length: 1001 }, () => ({})) }),
          json,
        );
      const outcome = await call(name, input);
      expect(!outcome.ok && outcome.error.code).toBe('upstream');
      expect(!outcome.ok && outcome.error.message).toContain(hint);
    },
  );
});

describe('ct_appointments_get', () => {
  it.each([
    [403, 'permission', appointmentRefused, [viewCategory]],
    [404, 'not_found', appointmentNotFound, undefined],
  ] as const)(
    'ends %i with %s and names the next step',
    async (status, code, message, missingRights) => {
      const { double, call } = setup();
      double
        .intercept({ path: '/api/calendars/8/appointments/5', method: 'GET' })
        .reply(status, '{}', json);
      const outcome = await call('ct_appointments_get', {
        calendarId: 8,
        appointmentId: 5,
      });
      expect(!outcome.ok && outcome.error).toEqual({
        code,
        message,
        ...(missingRights === undefined ? {} : { missingRights }),
      });
    },
  );

  it('gives the 25 earliest dates and says when more follow', async () => {
    const { double, call } = setup();
    const dates = Array.from({ length: 30 }, (_, index) => ({
      key: `k${String(index)}`,
      startDate: `2026-${String(1 + (index % 12)).padStart(2, '0')}-${String(10 + Math.floor(index / 12)).padStart(2, '0')}`,
      endDate: '2026-12-31',
    }));
    double
      .intercept({ path: '/api/calendars/8/appointments/5', method: 'GET' })
      .reply(200, appointmentAnswer(details({ dates })).body, json);
    const outcome = await call('ct_appointments_get', {
      calendarId: 8,
      appointmentId: 5,
    });
    const shown = outcome.ok ? outcome.data : undefined;
    expect(shown?.['moreDates']).toBe(true);
    const starts = (shown?.['dates'] as { startDate: string }[]).map(
      (date) => date.startDate,
    );
    expect(starts).toHaveLength(datesPerCall);
    expect(starts).toEqual(
      dates
        .map((date) => date.startDate)
        .sort()
        .slice(0, datesPerCall),
    );
  });
});

describe('ct_resources_list', () => {
  it('names the right when no resource is listed, and says so for an empty later page', async () => {
    const { double, call } = setup();
    replyResources(double, []);
    const empty = await call('ct_resources_list', {});
    expect(empty.ok && empty.data.notice).toBe(noResourceListed);
    expect(noResourceListed).toContain('"view resource" in churchresource');
    replyResources(double, [{ id: 8, name: 'Raum A', resourceTypeId: 5 }]);
    const later = await call('ct_resources_list', { page: 2 });
    expect(later.ok && later.data.notice).toBe(pastLastResourcePage);
  });
});

describe('the layer of the tools', () => {
  const leak = makeCanaries();
  const ctx = {} as TenantContext;

  it('copies only the four fields of a calendar', async () => {
    const read = {
      calendars: () =>
        Promise.resolve([{ ...calendar(8), randomUrl: leak.token.value }]),
    } as unknown as ReadApi;
    const result = await calendarsListTool.execute({ ctx, input: {}, read });
    expect(result.calendars).toEqual([calendar(8)]);
    assertNoCanary(result, leak.all, 'result of the tool');
  });

  it('copies only the eight fields of an appointment in the list', async () => {
    const read = {
      appointments: () =>
        Promise.resolve({
          appointments: [{ ...appointment(5), street: leak.name.value }],
          more: false,
        }),
    } as unknown as ReadApi;
    const result = await appointmentsListTool.execute({
      ctx,
      input: { calendarIds: [8], ...days },
      read,
    });
    expect(result.appointments).toEqual([appointment(5)]);
    assertNoCanary(result, leak.all, 'result of the tool');
  });

  it('copies only the declared fields of an appointment and its dates', async () => {
    const { dates, ...fields } = details();
    const read = {
      appointment: () =>
        Promise.resolve({
          ...fields,
          onBehalfOfPid: leak.phone.value,
          dates: dates.map(({ startDate, endDate }) => ({
            startDate,
            endDate,
            iCalUid: leak.token.value,
          })),
        }),
    } as unknown as ReadApi;
    const result = await appointmentsGetTool.execute({
      ctx,
      input: { calendarId: 8, appointmentId: 5 },
      read,
    });
    expect(result).toEqual({
      ...fields,
      dates: dates.map(({ startDate, endDate }) => ({ startDate, endDate })),
      moreDates: false,
    });
    assertNoCanary(result, leak.all, 'result of the tool');
  });

  it('copies only the declared fields of a resource', async () => {
    const read = {
      resources: () =>
        Promise.resolve({
          resources: [
            {
              id: 8,
              name: 'Raum A',
              resourceTypeId: 5,
              adminIds: [leak.phone.value],
            },
          ],
          resourceTypes: [
            { id: 5, name: 'Räume', namePlural: leak.name.value },
          ],
        }),
    } as unknown as ReadApi;
    const result = await resourcesListTool.execute({ ctx, input: {}, read });
    expect(result.resources).toEqual([
      { id: 8, name: 'Raum A', resourceTypeId: 5, resourceTypeName: 'Räume' },
    ]);
    assertNoCanary(result, leak.all, 'result of the tool');
  });

  it('copies only the seven fields of a booking', async () => {
    const read = {
      bookings: () =>
        Promise.resolve({
          bookings: [{ ...booking(2), answeredPid: leak.phone.value }],
          more: false,
        }),
    } as unknown as ReadApi;
    const result = await bookingsListTool.execute({
      ctx,
      input: { resourceIds: [8], ...days },
      read,
    });
    expect(result.bookings).toEqual([booking(2)]);
    assertNoCanary(result, leak.all, 'result of the tool');
  });
});

// The layer of the pipeline alone: a tool with the schemas of a read whose
// execute returns more than they declare, as a broken client and a broken
// tool together would. The pipeline drops every field the output schema
// does not declare.
describe('the layer of the pipeline', () => {
  const leak = makeCanaries();
  const leaky = (tool: ToolDefinition, result: unknown): ToolCatalog =>
    createToolCatalog({
      core: {
        name: '@ecclium/test-calendars-resources',
        version: '0.0.0',
        register(host): undefined {
          host.addTool({ ...tool, execute: () => Promise.resolve(result) });
          return undefined;
        },
      } satisfies Plugin,
      plugins: [],
      readOnly: true,
      toolsets: new Set(['calendars'] as const),
    });
  const { dates, ...fields } = details({ link: null });

  it.each([
    [
      'ct_appointments_get',
      appointmentsGetTool,
      { calendarId: 8, appointmentId: 5 },
      {
        ...fields,
        address: { street: leak.name.value },
        dates: [{ ...dates[0], iCalUid: leak.token.value }],
        moreDates: false,
        calendar: { randomUrl: leak.token.value },
      },
      {
        ...fields,
        title: enveloped('Termin 5'),
        subtitle: enveloped('Untertitel'),
        locationName: enveloped('Saal'),
        description: enveloped('Beschreibung des Termins'),
        dates: [
          {
            startDate: '2026-10-25T18:00:00Z',
            endDate: '2026-10-25T19:00:00Z',
          },
        ],
        moreDates: false,
      },
    ],
    [
      'ct_bookings_list',
      bookingsListTool,
      { resourceIds: [8], ...days },
      {
        ...days,
        page: 1,
        bookings: [
          {
            ...booking(2),
            answeredPid: leak.phone.value,
            resource: { randomString: leak.token.value },
          },
        ],
        more: false,
        notice: null,
        caption: leak.name.value,
      },
      {
        ...days,
        page: 1,
        bookings: [{ ...booking(2), title: enveloped('Buchung 2') }],
        more: false,
        notice: null,
      },
    ],
  ] as const)(
    'drops every field %s does not declare',
    async (name, tool, input, result, kept) => {
      const { lines, drafts, call } = setup(leaky(tool, result));
      const outcome = await call(name, input);
      expect(outcome.ok && outcome.data).toEqual(kept);
      assertNoCanary([outcome, lines, drafts], leak.all, 'result, log, audit');
    },
  );
});

// A refusal and a missing object end with a fixed message: the body of
// such an answer, which ChurchTools fills with its own texts, reaches
// neither the result nor the log nor the audit.
describe('the body of a refusal', () => {
  const leak = makeCanaries();
  const body = JSON.stringify({
    message: leak.name.value,
    translatedMessage: leak.email.value,
    messageKey: leak.phone.value,
    args: { first: leak.token.value, second: leak.name.value },
    errors: [],
  });

  it.each([
    [
      'ct_appointments_list',
      '/api/calendars/appointments',
      { calendarIds: [8], ...days },
    ],
    [
      'ct_appointments_get',
      '/api/calendars/8/appointments/5',
      { calendarId: 8, appointmentId: 5 },
    ],
    ['ct_bookings_list', '/api/bookings', { resourceIds: [8], ...days }],
  ] as const)(
    'stays out of %s for 403 and 404',
    async (name, pathname, input) => {
      for (const status of [403, 404]) {
        const { double, lines, drafts, call } = setup();
        double
          .intercept({ path: at(pathname), method: 'GET' })
          .reply(status, body, json);
        const outcome = await call(name, input);
        expect(outcome.ok).toBe(false);
        assertNoCanary(
          [outcome, lines, drafts],
          leak.all,
          'result, log, audit',
        );
      }
    },
  );
});

// The largest results the limits allow still fit into one result of 64
// KiB (ADR 0024): one appointment with title, subtitle, place,
// description, link and 25 dates of quotes, which the two copies of the
// result each escape, and the lists with names and titles of letters.
// Longer texts beyond ASCII in a full page of a list can exceed it; the
// call then ends with an error, as for the search tools (ADR 0060,
// ADR 0064).
describe('the largest results', () => {
  const quotes = (count: number) => '"'.repeat(count);
  const letters = (count: number) => 'a'.repeat(count);

  it('passes an appointment with texts of quotes and 25 dates', async () => {
    const { double, call } = setup();
    double
      .intercept({ path: '/api/calendars/8/appointments/5', method: 'GET' })
      .reply(
        200,
        appointmentAnswer(
          details({
            title: quotes(255),
            subtitle: quotes(255),
            locationName: quotes(255),
            description: quotes(7000),
            link: quotes(1000),
            dates: Array.from({ length: 26 }, (_, index) => ({
              key: `k${String(index)}`,
              startDate: '2026-10-25T18:00:00Z',
              endDate: '2026-10-25T19:00:00Z',
            })),
          }),
        ).body,
        json,
      );
    const outcome = await call('ct_appointments_get', {
      calendarId: 8,
      appointmentId: 5,
    });
    expect(outcome.ok && outcome.data['dates']).toHaveLength(25);
  });

  it('passes a page of 25 appointments with title, subtitle and place of 255 letters', async () => {
    const { double, call } = setup();
    double
      .intercept({ path: at('/api/calendars/appointments'), method: 'GET' })
      .reply(
        200,
        appointmentsAnswer(
          Array.from({ length: 25 }, (_, index) =>
            appointment(index + 1, {
              title: letters(255),
              subtitle: letters(255),
              locationName: letters(255),
            }),
          ),
        ).body,
        json,
      );
    const outcome = await call('ct_appointments_list', {
      calendarIds: [8],
      ...days,
    });
    expect(outcome.ok && outcome.data['appointments']).toHaveLength(25);
  });

  it('passes a page of 25 calendars with names of 255 letters', async () => {
    const { double, call } = setup();
    double.intercept({ path: '/api/calendars', method: 'GET' }).reply(
      200,
      calendarsAnswer(
        Array.from({ length: 25 }, (_, index) => ({
          ...calendar(index + 1),
          name: letters(255),
        })),
      ).body,
      json,
    );
    const outcome = await call('ct_calendars_list', {});
    expect(outcome.ok && outcome.data['calendars']).toHaveLength(25);
  });

  it('passes a page of 25 resources with names of 255 letters', async () => {
    const { double, call } = setup();
    replyResources(
      double,
      Array.from({ length: 25 }, (_, index) => ({
        id: index + 1,
        name: letters(255),
        resourceTypeId: 5,
      })),
      letters(255),
    );
    const outcome = await call('ct_resources_list', {});
    expect(outcome.ok && outcome.data['resources']).toHaveLength(25);
  });

  it('passes a page of 25 bookings with titles of 255 letters', async () => {
    const { double, call } = setup();
    double
      .intercept({ path: at('/api/bookings'), method: 'GET' })
      .reply(
        200,
        bookingsAnswer(
          Array.from({ length: 25 }, (_, index) =>
            booking(index + 1, { title: letters(255) }),
          ),
        ).body,
        json,
      );
    const outcome = await call('ct_bookings_list', {
      resourceIds: [8],
      ...days,
    });
    expect(outcome.ok && outcome.data['bookings']).toHaveLength(25);
  });
});
