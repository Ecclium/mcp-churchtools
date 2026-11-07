import { loadConfig } from '@ecclium/mcp-churchtools-core';
import {
  isEccliumError,
  type LogFields,
  type TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  assertNoCanary,
  assertOnlyReads,
  createChurchToolsDouble,
  doubleOrigin,
  makeCanary,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { holdsValue } from './calendar-writes.js';
import { createChurchToolsClient } from './client.js';
import {
  appointmentCreateBodySchema,
  appointmentUpdateBodySchema,
  bookingCreateBodySchema,
} from './schemas.js';

// The writes of the client for calendars and resources and the reads a
// plan needs (ADR 0072). Every request goes through the real transport on
// the ChurchTools double, which answers from interceptors and connects
// nowhere. Answers hold canaries in every field the client does not pass
// on, also in bodies it never reads.

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

const setup = (requestsPerMinute = 300) => {
  const double = createChurchToolsDouble({ token });
  open.push(double);
  const client = createChurchToolsClient({
    transport: double.transport,
    origin: doubleOrigin,
    requestsPerMinute,
    clock: runningClock(),
  });
  const lines: Line[] = [];
  const record = (event: string, fields?: LogFields): void => {
    lines.push({ event, fields });
  };
  const ctx = (instance = doubleOrigin): TenantContext =>
    Object.freeze({
      instance,
      signal: new AbortController().signal,
      log: Object.freeze({
        debug: record,
        info: record,
        warn: record,
        error: record,
      }),
      clock: runningClock(),
    }) as unknown as TenantContext;
  return { double, client, writes: client.writes, ctx, lines };
};

const json = { headers: { 'content-type': 'application/json' } };
const dated = (date: string) => ({
  headers: { 'content-type': 'application/json', date },
});

// The code and message of a call that fails.
const errorOf = async (
  call: Promise<unknown>,
): Promise<{ code: string; message: string }> => {
  try {
    await call;
  } catch (error) {
    if (isEccliumError(error)) {
      return { code: error.code, message: error.message };
    }
    throw error;
  }
  throw new Error('expected the call to fail');
};

const at = (pathname: string) => (path: string) =>
  path.split('?')[0] === pathname;

// An interceptor path that matches a pathname and keeps each path it sees
// with its query, since the history of calls keeps only the last value of
// a name that comes more than once.
const recording = (pathname: string, seen: string[]) => (path: string) => {
  seen.push(path);
  return path.split('?')[0] === pathname;
};

const name = makeCanary('name');
const email = makeCanary('email');
const phone = makeCanary('phone');
const canaries = [name, email, phone];

const calendarPath = '/api/calendars/8/appointments';
const appointmentPath = `${calendarPath}/21`;
const start = '2026-11-08T09:00:00Z';
const end = '2026-11-08T10:00:00Z';

// A stored appointment in the form F42 shows, with a canary in every field
// the client does not read and no part a change would lose.
const storedAppointment = (data: Readonly<Record<string, unknown>> = {}) => ({
  id: 21,
  version: 0,
  calendar: {
    id: 8,
    name: name.value,
    randomUrl: email.value,
    meta: { createdPerson: { title: name.value } },
  },
  title: 'Gottesdienst',
  caption: 'Gottesdienst',
  subtitle: 'Abendmahl',
  note: 'Abendmahl',
  description: 'Mit Taufe',
  information: 'Mit Taufe',
  startDate: start,
  endDate: end,
  allDay: false,
  isInternal: false,
  repeatId: 0,
  repeatFrequency: null,
  repeatOption: null,
  repeatUntil: null,
  additionals: [],
  additions: [],
  exceptions: [],
  address: null,
  link: null,
  image: null,
  signup: null,
  onBehalfOfPid: null,
  meta: {
    createdPerson: {
      id: 41,
      title: name.value,
      domainAttributes: { email: email.value },
    },
    createdDate: start,
    modifiedDate: start,
  },
  ...data,
});

const plainParts = {
  id: 21,
  calendarId: 8,
  version: 0,
  title: 'Gottesdienst',
  subtitle: 'Abendmahl',
  description: 'Mit Taufe',
  startDate: start,
  endDate: end,
  allDay: false,
  isInternal: false,
  createdBy: 41,
  parts: [],
};

// The answer of a read for a plan: the appointment, its dates with the
// iCalUid of F37, and the additions, which a read without tags gives as an
// empty list.
const stateAnswer = (
  appointment: Readonly<Record<string, unknown>> = {},
  date: Readonly<Record<string, unknown>> = {},
  additionalInfos: unknown = [],
) => ({
  data: {
    appointment: storedAppointment(appointment),
    additionalInfos,
    calculatedDates: {
      '2026-11-08': {
        startDate: start,
        endDate: end,
        iCalUid: email.value,
        ...date,
      },
    },
  },
});

const storedBooking = (data: Readonly<Record<string, unknown>> = {}) => ({
  id: 31,
  version: 0,
  resourceId: 13,
  resource: { id: 13, name: name.value, adminIds: [7] },
  title: 'Probe',
  caption: 'Probe',
  description: 'Chor',
  note: 'Chor',
  location: null,
  subtitle: null,
  startDate: start,
  endDate: end,
  allDay: false,
  statusId: 1,
  quantity: 1,
  showInCal: false,
  repeatId: 0,
  additionals: [],
  exceptions: [],
  appointment: null,
  appointmentId: null,
  answeredPid: null,
  answeredDate: null,
  isAnonymized: false,
  meta: { createdPerson: { title: name.value } },
  ...data,
});

const bookingParts = {
  id: 31,
  resourceId: 13,
  version: 0,
  title: 'Probe',
  description: 'Chor',
  startDate: start,
  endDate: end,
  statusId: 1,
  linked: false,
};

const fields = {
  title: 'Gottesdienst',
  description: 'Mit Taufe',
  startDate: start,
  endDate: end,
};

describe('creating an appointment', () => {
  it('sends POST with exactly the fields of the probe and gives the stored appointment', async () => {
    const { double, writes, ctx, lines } = setup();
    double
      .intercept({ path: calendarPath, method: 'POST' })
      .reply(201, JSON.stringify({ data: storedAppointment() }), json);
    const created = await writes.createAppointment(ctx(), 8, fields);
    expect(created).toEqual(plainParts);
    expect(Object.getPrototypeOf(created)).toBeNull();
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.parts)).toBe(true);
    const [call] = double.calls();
    expect(call?.method).toBe('POST');
    expect(call?.path).toBe(calendarPath);
    expect(call?.searchParams).toEqual({});
    expect(call?.headers['content-type']).toBe('application/json');
    expect(call?.body).toBe(
      `{"title":"Gottesdienst","description":"Mit Taufe","startDate":"${start}","endDate":"${end}","isInternal":false,"repeatId":0}`,
    );
    const sent = JSON.parse(call?.body ?? '') as Record<string, unknown>;
    expect(appointmentCreateBodySchema.strict().safeParse(sent).success).toBe(
      true,
    );
    assertNoCanary([created, lines], canaries, 'result and log');
    expect(lines).toEqual([]);
  });

  // The probe emptied a field by leaving it out (F41).
  it('leaves a missing description out of the body', async () => {
    const { double, writes, ctx } = setup();
    double
      .intercept({ path: calendarPath, method: 'POST' })
      .reply(
        201,
        JSON.stringify({ data: storedAppointment({ description: null }) }),
        json,
      );
    const created = await writes.createAppointment(ctx(), 8, {
      ...fields,
      description: null,
    });
    expect(created.description).toBeNull();
    expect(double.calls()[0]?.body).toBe(
      `{"title":"Gottesdienst","startDate":"${start}","endDate":"${end}","isInternal":false,"repeatId":0}`,
    );
  });

  it.each([
    ['no ID', { id: undefined }],
    ['another calendar', { calendar: { id: 9 } }],
    ['no version', { version: undefined }],
    ['a negative version', { version: -1 }],
    ['a start of another form', { startDate: '08.11.2026 09:00' }],
    ['a title of 256 characters', { title: 'T'.repeat(256) }],
  ])('ends with upstream for an answer 201 with %s', async (_, data) => {
    const { double, writes, ctx, lines } = setup();
    double
      .intercept({ path: calendarPath, method: 'POST' })
      .reply(201, JSON.stringify({ data: storedAppointment(data) }), json);
    expect(
      (await errorOf(writes.createAppointment(ctx(), 8, fields))).code,
    ).toBe('upstream');
    expect(lines).toEqual([
      {
        event: 'churchtools_appointment_create_refused',
        fields: { code: 'upstream' },
      },
    ]);
  });

  it.each([
    [200, 'churchtools_appointment_create_status', 'upstream'],
    [400, 'churchtools_appointment_create_status', 'internal'],
    [401, 'churchtools_appointment_create_status', 'auth'],
    [403, 'churchtools_appointment_create_status', 'permission'],
    [404, 'churchtools_appointment_create_missing', 'not_found'],
    [422, 'churchtools_appointment_create_status', 'upstream'],
    [500, 'churchtools_appointment_create_status', 'upstream'],
  ])(
    'ends with the code of status %i and never reads its body',
    async (status, event, code) => {
      const { double, writes, ctx, lines } = setup();
      double
        .intercept({ path: calendarPath, method: 'POST' })
        .reply(status, JSON.stringify({ message: email.value }), json);
      const error = await errorOf(writes.createAppointment(ctx(), 8, fields));
      expect(error.code).toBe(code);
      expect(lines).toEqual([{ event, fields: { status, code } }]);
      assertNoCanary([error, lines], canaries, 'error and log');
    },
  );

  it.each([
    ['calendar 0', 0, fields],
    ['a calendar as text', '8', fields],
    ['an empty title', 8, { ...fields, title: '' }],
    ['a title of 256 characters', 8, { ...fields, title: 'T'.repeat(256) }],
    [
      'a title with a space at the end',
      8,
      { ...fields, title: 'Gottesdienst ' },
    ],
    ['a title with a line break', 8, { ...fields, title: 'Gottes\ndienst' }],
    ['a title with DEL', 8, { ...fields, title: 'Gottes\u007fdienst' }],
    ['a title with a lone surrogate', 8, { ...fields, title: 'Gott\ud800' }],
    ['an empty description', 8, { ...fields, description: '' }],
    ['a description of spaces only', 8, { ...fields, description: ' \n ' }],
    [
      'a description of 7001 characters',
      8,
      { ...fields, description: 'a'.repeat(7001) },
    ],
    ['a description with U+0000', 8, { ...fields, description: 'Text\u0000' }],
    ['a day alone as start', 8, { ...fields, startDate: '2026-11-08' }],
    [
      'a time with an offset',
      8,
      { ...fields, endDate: '2026-11-08T10:00:00+01:00' },
    ],
    [
      'an end before the start',
      8,
      { ...fields, endDate: '2026-11-08T08:00:00Z' },
    ],
    ['an end at the start', 8, { ...fields, endDate: start }],
    [
      'a day that does not exist',
      8,
      {
        ...fields,
        startDate: '2026-02-30T09:00:00Z',
        endDate: '2026-02-30T10:00:00Z',
      },
    ],
    [
      'the 31st of a month of 30 days',
      8,
      { ...fields, endDate: '2026-04-31T10:00:00Z' },
    ],
    ['a start that is no text', 8, { ...fields, startDate: 1 }],
  ])(
    'refuses %s with validation before it asks ChurchTools',
    async (_, calendarId, given) => {
      const { double, writes, ctx, lines } = setup(6);
      const error = await errorOf(
        writes.createAppointment(
          ctx('https://other.example'),
          calendarId as number,
          given as typeof fields,
        ),
      );
      expect(error.code).toBe('validation');
      expect(error.message).toContain('A title has 1 to 255 characters');
      expect(double.calls()).toEqual([]);
      expect(lines).toEqual([
        {
          event: 'churchtools_calendar_write_refused',
          fields: { code: 'validation' },
        },
      ]);
    },
  );

  it('takes the longest title and description', async () => {
    const { double, writes, ctx } = setup();
    double
      .intercept({ path: calendarPath, method: 'POST' })
      .reply(201, JSON.stringify({ data: storedAppointment() }), json);
    await writes.createAppointment(ctx(), 8, {
      ...fields,
      title: 'T'.repeat(255),
      description: 'ä\n'.repeat(3500),
    });
    expect(double.calls()).toHaveLength(1);
  });

  // A throttle of 6 requests per minute has room for one at once.
  it('takes a place of the same throttle as a read, and asks nothing for another tenant', async () => {
    const { double, client, writes, ctx } = setup(6);
    expect(
      (
        await errorOf(
          writes.createAppointment(ctx('https://other.example'), 8, fields),
        )
      ).code,
    ).toBe('internal');
    double
      .intercept({ path: calendarPath, method: 'POST' })
      .reply(201, JSON.stringify({ data: storedAppointment() }), json);
    await writes.createAppointment(ctx(), 8, fields);
    expect((await errorOf(client.whoami(ctx()))).code).toBe('rate_limited');
    expect(double.calls()).toHaveLength(1);
  });
});

describe('changing an appointment', () => {
  const change = {
    ...fields,
    subtitle: 'Abendmahl',
    isInternal: true,
  };

  it('sends PUT with every field of the probe and reads nothing of the answer', async () => {
    const { double, writes, ctx, lines } = setup();
    double
      .intercept({ path: appointmentPath, method: 'PUT' })
      .reply(200, `not even JSON ${email.value}`, {
        headers: { 'content-type': 'text/plain' },
      });
    await writes.updateAppointment(ctx(), 8, 21, change);
    const [call] = double.calls();
    expect(call?.method).toBe('PUT');
    expect(call?.path).toBe(appointmentPath);
    expect(call?.searchParams).toEqual({});
    expect(call?.body).toBe(
      `{"title":"Gottesdienst","subtitle":"Abendmahl","description":"Mit Taufe","startDate":"${start}","endDate":"${end}","isInternal":true,"repeatId":0}`,
    );
    const sent = JSON.parse(call?.body ?? '') as Record<string, unknown>;
    expect(appointmentUpdateBodySchema.strict().safeParse(sent).success).toBe(
      true,
    );
    expect(lines).toEqual([]);
  });

  it('leaves a missing or empty subtitle and a missing description out', async () => {
    const { double, writes, ctx } = setup();
    double
      .intercept({ path: appointmentPath, method: 'PUT' })
      .reply(200, '{}', json)
      .times(2);
    await writes.updateAppointment(ctx(), 8, 21, {
      ...change,
      subtitle: null,
      description: null,
    });
    await writes.updateAppointment(ctx(), 8, 21, { ...change, subtitle: '' });
    expect(double.calls().map((call) => call.body)).toEqual([
      `{"title":"Gottesdienst","startDate":"${start}","endDate":"${end}","isInternal":true,"repeatId":0}`,
      `{"title":"Gottesdienst","description":"Mit Taufe","startDate":"${start}","endDate":"${end}","isInternal":true,"repeatId":0}`,
    ]);
  });

  // A subtitle goes back as it was read, whatever it holds.
  it('sends a subtitle back as read, also with a line break', async () => {
    const { double, writes, ctx } = setup();
    double
      .intercept({ path: appointmentPath, method: 'PUT' })
      .reply(200, '{}', json);
    await writes.updateAppointment(ctx(), 8, 21, {
      ...change,
      subtitle: ' Saal\n2 ',
    });
    expect(double.calls()[0]?.body).toContain('"subtitle":" Saal\\n2 "');
  });

  it.each([
    [404, 'churchtools_appointment_update_missing', 'not_found'],
    [403, 'churchtools_appointment_update_status', 'permission'],
    [201, 'churchtools_appointment_update_status', 'upstream'],
  ])('ends with the code of status %i', async (status, event, code) => {
    const { double, writes, ctx, lines } = setup();
    double
      .intercept({ path: appointmentPath, method: 'PUT' })
      .reply(status, JSON.stringify({ message: email.value }), json);
    expect(
      (await errorOf(writes.updateAppointment(ctx(), 8, 21, change))).code,
    ).toBe(code);
    expect(lines).toEqual([{ event, fields: { status, code } }]);
  });

  it.each([
    ['appointment 0', 0, change],
    [
      'a subtitle of 256 characters',
      21,
      { ...change, subtitle: 'S'.repeat(256) },
    ],
    ['a subtitle with U+0000', 21, { ...change, subtitle: 'S\u0000' }],
    ['a subtitle with a lone surrogate', 21, { ...change, subtitle: '\udc00' }],
    ['a visibility that is no boolean', 21, { ...change, isInternal: 'nein' }],
    [
      'a title with a space at the start',
      21,
      { ...change, title: ' Gottesdienst' },
    ],
  ])(
    'refuses %s with validation before it asks ChurchTools',
    async (_, id, given) => {
      const { double, writes, ctx } = setup();
      expect(
        (
          await errorOf(
            writes.updateAppointment(ctx(), 8, id, given as typeof change),
          )
        ).code,
      ).toBe('validation');
      expect(double.calls()).toEqual([]);
    },
  );
});

describe('deleting an appointment', () => {
  it('sends DELETE without body and query and takes 204', async () => {
    const { double, writes, ctx, lines } = setup();
    double
      .intercept({ path: appointmentPath, method: 'DELETE' })
      .reply(204, '');
    await writes.deleteAppointment(ctx(), 8, 21);
    const [call] = double.calls();
    expect(call?.method).toBe('DELETE');
    expect(call?.path).toBe(appointmentPath);
    expect(call?.searchParams).toEqual({});
    expect(call?.body).toBeUndefined();
    expect(lines).toEqual([]);
  });

  it.each([
    [404, 'churchtools_appointment_delete_missing', 'not_found'],
    [200, 'churchtools_appointment_delete_status', 'upstream'],
    [403, 'churchtools_appointment_delete_status', 'permission'],
  ])('ends with the code of status %i', async (status, event, code) => {
    const { double, writes, ctx, lines } = setup();
    double
      .intercept({ path: appointmentPath, method: 'DELETE' })
      .reply(status, JSON.stringify({ message: email.value }), json);
    expect((await errorOf(writes.deleteAppointment(ctx(), 8, 21))).code).toBe(
      code,
    );
    expect(lines).toEqual([{ event, fields: { status, code } }]);
  });

  it('refuses an appointment 0 before it asks ChurchTools', async () => {
    const { double, writes, ctx } = setup();
    expect((await errorOf(writes.deleteAppointment(ctx(), 8, 0))).code).toBe(
      'validation',
    );
    expect(double.calls()).toEqual([]);
  });
});

describe('the state of an appointment for a plan', () => {
  it('reads with include[] for events, bookings and invitations and gives the time of ChurchTools', async () => {
    const { double, writes, ctx, lines } = setup();
    const seen: string[] = [];
    double
      .intercept({ path: recording(appointmentPath, seen), method: 'GET' })
      .reply(
        200,
        JSON.stringify(stateAnswer()),
        dated('Sun, 08 Nov 2026 08:00:00 GMT'),
      );
    const state = await writes.appointmentState(ctx(), 8, 21);
    expect(state).toEqual({
      appointment: plainParts,
      serverTime: Date.UTC(2026, 10, 8, 8, 0, 0),
    });
    expect(Object.getPrototypeOf(state)).toBeNull();
    expect(Object.isFrozen(state)).toBe(true);
    expect([...new URL(seen.at(-1) ?? '', doubleOrigin).searchParams]).toEqual([
      ['include[]', 'event'],
      ['include[]', 'bookings'],
      ['include[]', 'meetingRequests'],
    ]);
    assertOnlyReads(double);
    assertNoCanary([state, lines], canaries, 'state and log');
  });

  it.each([
    ['a series', { repeatId: 7, repeatFrequency: 1 }, ['series']],
    ['additional dates', { additionals: [{ date: '2026-11-15' }] }, ['series']],
    ['exceptions', { exceptions: [{ date: '2026-11-15' }] }, ['series']],
    [
      'an address',
      { address: { name: 'Saal', street: phone.value } },
      ['address'],
    ],
    ['a link', { link: 'https://example.org' }, ['link']],
    ['an image', { image: { id: 3, fileUrl: email.value } }, ['image']],
    ['a group for sign-ups', { signup: { groupTypeId: 4 } }, ['signup']],
    ['a person on whose behalf', { onBehalfOfPid: 7 }, ['onBehalfOf']],
    [
      'everything',
      {
        repeatId: 1,
        address: { name: 'Saal' },
        link: 'https://example.org',
        image: { id: 3 },
        signup: { groupTypeId: 4 },
        onBehalfOfPid: 7,
      },
      ['series', 'address', 'link', 'image', 'signup', 'onBehalfOf'],
    ],
  ])('names %s in parts, never its value', async (_, data, parts) => {
    const { double, writes, ctx } = setup();
    double
      .intercept({ path: at(appointmentPath), method: 'GET' })
      .reply(200, JSON.stringify(stateAnswer(data)), json);
    const state = await writes.appointmentState(ctx(), 8, 21);
    expect(state.appointment.parts).toEqual(parts);
    assertNoCanary(state, canaries, 'state');
  });

  // What holds no value is no part: an empty address, link or list.
  it.each([
    [
      'an address of empty fields',
      { address: { name: null, street: '', latitude: null } },
    ],
    ['a link of spaces', { link: '  ' }],
    [
      'no optional field at all',
      {
        subtitle: undefined,
        description: undefined,
        additionals: undefined,
        exceptions: undefined,
        address: undefined,
        link: undefined,
        image: undefined,
        signup: undefined,
        onBehalfOfPid: undefined,
      },
    ],
  ])('names no part for %s', async (_, data) => {
    const { double, writes, ctx } = setup();
    double
      .intercept({ path: at(appointmentPath), method: 'GET' })
      .reply(200, JSON.stringify(stateAnswer(data)), json);
    expect(
      (await writes.appointmentState(ctx(), 8, 21)).appointment.parts,
    ).toEqual([]);
  });

  // The form of what include[] adds is not shown by a probe: any list or
  // object that holds a value, in a date or in the additions, counts as a
  // link, and text, numbers and empty values do not (ADR 0072).
  it.each([
    ['a booking in a date', { bookings: [{ id: 4 }] }, [], true],
    ['an event in a date', { event: { id: 5 } }, [], true],
    [
      'an invitation in a date',
      { meetingRequests: [{ personId: 6 }] },
      [],
      true,
    ],
    ['an unknown key with an object', { other: { id: 1 } }, [], true],
    [
      'invitations in the additions',
      {},
      { meetingRequests: [{ id: 6 }] },
      true,
    ],
    ['a list in the additions', {}, [{ id: 6 }], true],
    [
      'empty enrichments',
      { bookings: [], event: null, meetingRequests: [] },
      [],
      false,
    ],
    ['empty objects', { event: {} }, { meetingRequests: [] }, false],
    [
      'text and numbers in a date',
      { titleSuffix: 'Nachmittag', count: 2 },
      [],
      false,
    ],
    ['no additions at all', {}, undefined, false],
  ])('judges %s', async (_, date, additions, linked) => {
    const { double, writes, ctx } = setup();
    double
      .intercept({ path: at(appointmentPath), method: 'GET' })
      .reply(200, JSON.stringify(stateAnswer({}, date, additions)), json);
    expect(
      (await writes.appointmentState(ctx(), 8, 21)).appointment.parts,
    ).toEqual(linked ? ['linked'] : []);
  });

  // The document does not say where invitations go for one appointment;
  // on the reads of one date they stand beside the appointment. A key the
  // document does not describe, there or in the appointment, counts as a
  // link when it carries one, and the parts the document describes do not.
  it.each([
    [
      'invitations beside the appointment',
      { meetingRequests: [{ personId: 6 }] },
      {},
      true,
    ],
    ['bookings beside the appointment', { bookings: [{ id: 4 }] }, {}, true],
    [
      'invitations in the appointment',
      {},
      { meetingRequests: [{ personId: 6 }] },
      true,
    ],
    ['tags in the appointment', {}, { tags: [{ id: 2 }] }, true],
    [
      'an empty list beside the appointment',
      { meetingRequests: [] },
      {},
      false,
    ],
    ['text beside the appointment', { notice: 'Hinweis' }, {}, false],
    ['the described meta', {}, { meta: { createdPerson: { id: 3 } } }, false],
    // The legacy field mappings every answer carries are no part (F52);
    // anything else under that key, or such texts under another, is.
    [
      'the legacy field mappings in the appointment',
      {},
      {
        '@deprecated': {
          additions: 'Zusatz',
          caption: 'Titel',
          note: 'Notiz',
          information: 'Hinweis',
        },
      },
      false,
    ],
    [
      'legacy field mappings of the fields beside the appointment',
      { '@deprecated': { additionalInfos: 'Hinweise' } },
      {},
      false,
    ],
    [
      'texts under @deprecated that name no field of the object',
      {},
      { '@deprecated': { caption: 'Titel', eventUrl: 'x' } },
      true,
    ],
    [
      'texts under @deprecated that name a field of another object',
      { '@deprecated': { caption: 'Titel' } },
      {},
      true,
    ],
    [
      'an object in the legacy field mappings',
      {},
      { '@deprecated': { caption: { id: 3 } } },
      true,
    ],
    ['a list as legacy field mappings', {}, { '@deprecated': ['x'] }, true],
    ['texts under another unknown key', {}, { legacy: { caption: 'b' } }, true],
  ])('judges %s', async (_, beside, inside, linked) => {
    const { double, writes, ctx } = setup();
    const answer = stateAnswer(inside);
    double
      .intercept({ path: at(appointmentPath), method: 'GET' })
      .reply(
        200,
        JSON.stringify({ data: { ...answer.data, ...beside } }),
        json,
      );
    expect(
      (await writes.appointmentState(ctx(), 8, 21)).appointment.parts,
    ).toEqual(linked ? ['linked'] : []);
  });

  // ChurchTools may keep a description or subtitle as empty text; it is
  // none, so that a change can send it back as missing.
  it('reads an empty description or subtitle as none, and sends it back as missing', async () => {
    const { double, writes, ctx } = setup();
    double
      .intercept({ path: at(appointmentPath), method: 'GET' })
      .reply(
        200,
        JSON.stringify(stateAnswer({ description: '', subtitle: ' ' })),
        json,
      );
    double
      .intercept({ path: appointmentPath, method: 'PUT' })
      .reply(200, '{}', json);
    const { appointment } = await writes.appointmentState(ctx(), 8, 21);
    expect(appointment.description).toBeNull();
    expect(appointment.subtitle).toBeNull();
    await writes.updateAppointment(ctx(), 8, 21, {
      title: appointment.title,
      subtitle: appointment.subtitle,
      description: appointment.description,
      startDate: appointment.startDate,
      endDate: appointment.endDate,
      isInternal: appointment.isInternal,
    });
    expect(double.calls().at(-1)?.body).toBe(
      `{"title":"Gottesdienst","startDate":"${start}","endDate":"${end}","isInternal":false,"repeatId":0}`,
    );
  });

  // F44: the creator is the account that wrote; without it, the write
  // guard moves no appointment.
  it.each([
    ['no meta', { meta: undefined }],
    ['no creator', { meta: { createdDate: start } }],
    ['a creator of null', { meta: { createdPerson: null } }],
  ])('gives no creator for %s', async (_, data) => {
    const { double, writes, ctx } = setup();
    double
      .intercept({ path: at(appointmentPath), method: 'GET' })
      .reply(200, JSON.stringify(stateAnswer(data)), json);
    expect(
      (await writes.appointmentState(ctx(), 8, 21)).appointment.createdBy,
    ).toBeNull();
  });

  it('takes the dates as a list as well', async () => {
    const { double, writes, ctx } = setup();
    const answer = stateAnswer();
    double.intercept({ path: at(appointmentPath), method: 'GET' }).reply(
      200,
      JSON.stringify({
        data: {
          ...answer.data,
          calculatedDates: [
            { startDate: start, endDate: end, bookings: [{ id: 1 }] },
          ],
        },
      }),
      json,
    );
    expect(
      (await writes.appointmentState(ctx(), 8, 21)).appointment.parts,
    ).toEqual(['linked']);
  });

  it.each([
    ['another calendar', { calendar: { id: 9 } }],
    ['another ID', { id: 22 }],
  ])('ends with upstream for an appointment of %s', async (_, data) => {
    const { double, writes, ctx, lines } = setup();
    double
      .intercept({ path: at(appointmentPath), method: 'GET' })
      .reply(200, JSON.stringify(stateAnswer(data)), json);
    expect((await errorOf(writes.appointmentState(ctx(), 8, 21))).code).toBe(
      'upstream',
    );
    expect(lines).toEqual([
      {
        event: 'churchtools_appointment_foreign',
        fields: { code: 'upstream' },
      },
    ]);
  });

  it.each([
    ['no dates', { data: { appointment: storedAppointment() } }],
    [
      'dates that are no objects',
      { data: { ...stateAnswer().data, calculatedDates: { a: 1 } } },
    ],
    ['no version', stateAnswer({ version: undefined })],
    ['no data', {}],
  ])('ends with upstream for an answer with %s', async (_, answer) => {
    const { double, writes, ctx, lines } = setup();
    double
      .intercept({ path: at(appointmentPath), method: 'GET' })
      .reply(200, JSON.stringify(answer), json);
    expect((await errorOf(writes.appointmentState(ctx(), 8, 21))).code).toBe(
      'upstream',
    );
    expect(lines).toEqual([
      {
        event: 'churchtools_appointment_refused',
        fields: { code: 'upstream' },
      },
    ]);
  });

  it('ends with not_found for a missing appointment and refuses an ID 0', async () => {
    const { double, writes, ctx, lines } = setup();
    double
      .intercept({ path: at(appointmentPath), method: 'GET' })
      .reply(404, '{}');
    expect((await errorOf(writes.appointmentState(ctx(), 8, 21))).code).toBe(
      'not_found',
    );
    expect((await errorOf(writes.appointmentState(ctx(), 0, 21))).code).toBe(
      'validation',
    );
    expect(lines.map((line) => line.event)).toEqual([
      'churchtools_appointment_missing',
      'churchtools_calendar_write_refused',
    ]);
  });
});

describe('the days of a calendar and of a resource for a plan', () => {
  const listed = {
    data: [
      {
        appointment: {
          base: storedAppointment(),
          calculated: { startDate: start, endDate: end },
        },
      },
    ],
  };

  it('gives the appointments of the days with the time of ChurchTools', async () => {
    const { double, writes, ctx } = setup();
    const seen: string[] = [];
    double
      .intercept({
        path: recording('/api/calendars/appointments', seen),
        method: 'GET',
      })
      .reply(
        200,
        JSON.stringify(listed),
        dated('Sun, 08 Nov 2026 08:00:00 GMT'),
      );
    const state = await writes.calendarDayState(
      ctx(),
      8,
      '2026-11-07',
      '2026-11-09',
    );
    expect(state.serverTime).toBe(Date.UTC(2026, 10, 8, 8, 0, 0));
    expect(state.appointments.appointments.map((entry) => entry.id)).toEqual([
      21,
    ]);
    expect(Object.getPrototypeOf(state)).toBeNull();
    expect([...new URL(seen.at(-1) ?? '', doubleOrigin).searchParams]).toEqual([
      ['calendar_ids[]', '8'],
      ['from', '2026-11-07'],
      ['to', '2026-11-09'],
    ]);
    assertOnlyReads(double);
  });

  it('gives the bookings of the days with the time of ChurchTools', async () => {
    const { double, writes, ctx } = setup();
    const seen: string[] = [];
    double
      .intercept({ path: recording('/api/bookings', seen), method: 'GET' })
      .reply(
        200,
        JSON.stringify({
          data: [
            {
              booking: {
                base: storedBooking(),
                calculated: { startDate: start, endDate: end },
              },
            },
          ],
        }),
        dated('Sun, 08 Nov 2026 08:00:00 GMT'),
      );
    const state = await writes.resourceDayState(
      ctx(),
      13,
      '2026-11-08',
      '2026-11-08',
    );
    expect(state.serverTime).toBe(Date.UTC(2026, 10, 8, 8, 0, 0));
    expect(state.bookings.bookings.map((entry) => entry.id)).toEqual([31]);
    expect([...new URL(seen.at(-1) ?? '', doubleOrigin).searchParams]).toEqual([
      ['resource_ids[]', '13'],
      ['from', '2026-11-08'],
      ['to', '2026-11-08'],
    ]);
  });

  it('gives no time without a date header', async () => {
    const { double, writes, ctx } = setup();
    double
      .intercept({ path: at('/api/bookings'), method: 'GET' })
      .reply(200, JSON.stringify({ data: [] }), json);
    expect(
      (await writes.resourceDayState(ctx(), 13, '2026-11-08', '2026-11-08'))
        .serverTime,
    ).toBeNull();
  });

  it('refuses a span the lists do not take', async () => {
    const { double, writes, ctx } = setup();
    expect(
      (
        await errorOf(
          writes.calendarDayState(ctx(), 8, '2026-11-09', '2026-11-07'),
        )
      ).code,
    ).toBe('validation');
    expect(
      (
        await errorOf(
          writes.resourceDayState(ctx(), 0, '2026-11-08', '2026-11-08'),
        )
      ).code,
    ).toBe('validation');
    expect(double.calls()).toEqual([]);
  });
});

describe('requesting a booking', () => {
  it('sends POST with statusId 1 and showInCal false and gives the stored booking', async () => {
    const { double, writes, ctx, lines } = setup();
    double
      .intercept({ path: '/api/bookings', method: 'POST' })
      .reply(201, JSON.stringify({ data: storedBooking() }), json);
    const created = await writes.createBooking(ctx(), 13, {
      ...fields,
      title: 'Probe',
      description: 'Chor',
    });
    expect(created).toEqual(bookingParts);
    expect(Object.getPrototypeOf(created)).toBeNull();
    expect(Object.isFrozen(created)).toBe(true);
    const [call] = double.calls();
    expect(call?.method).toBe('POST');
    expect(call?.searchParams).toEqual({});
    expect(call?.body).toBe(
      `{"resourceId":13,"title":"Probe","description":"Chor","startDate":"${start}","endDate":"${end}","statusId":1,"showInCal":false}`,
    );
    const sent = JSON.parse(call?.body ?? '') as Record<string, unknown>;
    expect(bookingCreateBodySchema.strict().safeParse(sent).success).toBe(true);
    assertNoCanary([created, lines], canaries, 'result and log');
    expect(lines).toEqual([]);
  });

  // A resource may approve requests by itself, and a conflict may change
  // the state (OpenAPI document of 3.138): the write guard judges it.
  it('gives back the state ChurchTools stored, and a series or an appointment as linked', async () => {
    const { double, writes, ctx } = setup();
    double.intercept({ path: '/api/bookings', method: 'POST' }).reply(
      201,
      JSON.stringify({
        data: storedBooking({ statusId: 2, appointmentId: 21 }),
      }),
      json,
    );
    const created = await writes.createBooking(ctx(), 13, fields);
    expect(created.statusId).toBe(2);
    expect(created.linked).toBe(true);
  });

  it('counts a booking of a series as linked', async () => {
    const { double, writes, ctx } = setup();
    double.intercept({ path: '/api/bookings', method: 'POST' }).reply(
      201,
      JSON.stringify({
        data: storedBooking({ repeatId: 7, appointmentId: null }),
      }),
      json,
    );
    expect((await writes.createBooking(ctx(), 13, fields)).linked).toBe(true);
  });

  it('ends with validation and a sentence for a resource that needs an appointment', async () => {
    const { double, writes, ctx, lines } = setup();
    double
      .intercept({ path: '/api/bookings', method: 'POST' })
      .reply(422, JSON.stringify({ message: email.value }), json);
    const error = await errorOf(writes.createBooking(ctx(), 13, fields));
    expect(error).toEqual({
      code: 'validation',
      message:
        'ChurchTools books this resource only together with an appointment. Ecclium does not request such a booking: ask the managers of the resource.',
    });
    expect(lines).toEqual([
      {
        event: 'churchtools_booking_create_status',
        fields: { status: 422, code: 'validation' },
      },
    ]);
  });

  it.each([
    ['another resource', { resourceId: 14 }],
    ['no ID', { id: undefined }],
    ['no state', { statusId: undefined }],
  ])('ends with upstream for an answer 201 with %s', async (_, data) => {
    const { double, writes, ctx, lines } = setup();
    double
      .intercept({ path: '/api/bookings', method: 'POST' })
      .reply(201, JSON.stringify({ data: storedBooking(data) }), json);
    expect((await errorOf(writes.createBooking(ctx(), 13, fields))).code).toBe(
      'upstream',
    );
    expect(lines).toEqual([
      {
        event: 'churchtools_booking_create_refused',
        fields: { code: 'upstream' },
      },
    ]);
  });

  it.each([
    [403, 'churchtools_booking_create_status', 'permission'],
    [404, 'churchtools_booking_create_missing', 'not_found'],
    [400, 'churchtools_booking_create_status', 'internal'],
  ])('ends with the code of status %i', async (status, event, code) => {
    const { double, writes, ctx, lines } = setup();
    double
      .intercept({ path: '/api/bookings', method: 'POST' })
      .reply(status, '{}', json);
    expect((await errorOf(writes.createBooking(ctx(), 13, fields))).code).toBe(
      code,
    );
    expect(lines).toEqual([{ event, fields: { status, code } }]);
  });

  it('refuses a resource 0 and a day alone before it asks ChurchTools', async () => {
    const { double, writes, ctx } = setup();
    expect((await errorOf(writes.createBooking(ctx(), 0, fields))).code).toBe(
      'validation',
    );
    expect(
      (
        await errorOf(
          writes.createBooking(ctx(), 13, { ...fields, endDate: '2026-11-09' }),
        )
      ).code,
    ).toBe('validation');
    expect(double.calls()).toEqual([]);
  });
});

describe('the state of a booking for a plan', () => {
  it('reads the booking with the time of ChurchTools', async () => {
    const { double, writes, ctx } = setup();
    double.intercept({ path: '/api/bookings/31', method: 'GET' }).reply(
      200,
      JSON.stringify({
        data: { booking: storedBooking(), calculatedDates: [] },
      }),
      dated('Sun, 08 Nov 2026 08:00:00 GMT'),
    );
    const state = await writes.bookingState(ctx(), 13, 31);
    expect(state).toEqual({
      booking: bookingParts,
      serverTime: Date.UTC(2026, 10, 8, 8, 0, 0),
    });
    expect(double.calls()[0]?.searchParams).toEqual({});
    assertOnlyReads(double);
  });

  // The path names no resource: a booking of another one is no answer the
  // client knows.
  it.each([
    ['another resource', { resourceId: 14 }],
    ['another ID', { id: 32 }],
  ])('ends with upstream for a booking of %s', async (_, data) => {
    const { double, writes, ctx, lines } = setup();
    double
      .intercept({ path: '/api/bookings/31', method: 'GET' })
      .reply(
        200,
        JSON.stringify({ data: { booking: storedBooking(data) } }),
        json,
      );
    expect((await errorOf(writes.bookingState(ctx(), 13, 31))).code).toBe(
      'upstream',
    );
    expect(lines).toEqual([
      { event: 'churchtools_booking_foreign', fields: { code: 'upstream' } },
    ]);
  });

  // F47: a deleted booking answers 500.
  it.each([
    [404, 'churchtools_booking_missing', 'not_found'],
    [500, 'churchtools_booking_status', 'upstream'],
  ])('ends with the code of status %i', async (status, event, code) => {
    const { double, writes, ctx, lines } = setup();
    double
      .intercept({ path: '/api/bookings/31', method: 'GET' })
      .reply(status, JSON.stringify({ message: email.value }), json);
    expect((await errorOf(writes.bookingState(ctx(), 13, 31))).code).toBe(code);
    expect(lines).toEqual([{ event, fields: { status, code } }]);
  });

  it('ends with upstream for an answer without the booking', async () => {
    const { double, writes, ctx, lines } = setup();
    double
      .intercept({ path: '/api/bookings/31', method: 'GET' })
      .reply(200, JSON.stringify({ data: storedBooking() }), json);
    expect((await errorOf(writes.bookingState(ctx(), 13, 31))).code).toBe(
      'upstream',
    );
    expect(lines).toEqual([
      { event: 'churchtools_booking_refused', fields: { code: 'upstream' } },
    ]);
  });
});

describe('deleting a booking', () => {
  it('sends DELETE without body and query and takes 204', async () => {
    const { double, writes, ctx } = setup();
    double
      .intercept({ path: '/api/bookings/31', method: 'DELETE' })
      .reply(204, '');
    await writes.deleteBooking(ctx(), 31);
    const [call] = double.calls();
    expect(call?.method).toBe('DELETE');
    expect(call?.searchParams).toEqual({});
    expect(call?.body).toBeUndefined();
  });

  it.each([
    [404, 'churchtools_booking_delete_missing', 'not_found'],
    [500, 'churchtools_booking_delete_status', 'upstream'],
  ])('ends with the code of status %i', async (status, event, code) => {
    const { double, writes, ctx, lines } = setup();
    double
      .intercept({ path: '/api/bookings/31', method: 'DELETE' })
      .reply(status, '{}', json);
    expect((await errorOf(writes.deleteBooking(ctx(), 31))).code).toBe(code);
    expect(lines).toEqual([{ event, fields: { status, code } }]);
  });

  it('refuses a booking 0 before it asks ChurchTools', async () => {
    const { double, writes, ctx } = setup();
    expect((await errorOf(writes.deleteBooking(ctx(), 0))).code).toBe(
      'validation',
    );
    expect(double.calls()).toEqual([]);
  });
});

describe('the names of calendars and resources for the policy', () => {
  it('gives name and visibility of a calendar, or nothing for one not listed', async () => {
    const { double, writes, ctx } = setup();
    double
      .intercept({ path: '/api/calendars', method: 'GET' })
      .reply(
        200,
        JSON.stringify({
          data: [
            {
              id: 8,
              name: 'Gottesdienste',
              isPublic: true,
              isPrivate: false,
              randomUrl: email.value,
            },
          ],
        }),
        json,
      )
      .times(2);
    const facts = await writes.calendarFacts(ctx(), 8);
    expect(facts).toEqual({ name: 'Gottesdienste', isPublic: true });
    expect(Object.getPrototypeOf(facts)).toBeNull();
    expect(await writes.calendarFacts(ctx(), 9)).toBeUndefined();
    assertNoCanary(facts, canaries, 'facts');
  });

  it('gives the name of a resource, or nothing for one not listed', async () => {
    const { double, writes, ctx } = setup();
    double
      .intercept({ path: '/api/resources', method: 'GET' })
      .reply(
        200,
        JSON.stringify({ data: [{ id: 13, name: 'Saal', resourceTypeId: 2 }] }),
        json,
      )
      .times(2);
    double
      .intercept({ path: '/api/resourcetypes', method: 'GET' })
      .reply(200, JSON.stringify({ data: [{ id: 2, name: 'Räume' }] }), json)
      .times(2);
    expect(await writes.resourceName(ctx(), 13)).toBe('Saal');
    expect(await writes.resourceName(ctx(), 14)).toBeUndefined();
  });

  it('refuses an ID 0 before it asks ChurchTools', async () => {
    const { double, writes, ctx } = setup();
    expect((await errorOf(writes.calendarFacts(ctx(), 0))).code).toBe(
      'validation',
    );
    expect((await errorOf(writes.resourceName(ctx(), 0))).code).toBe(
      'validation',
    );
    expect(double.calls()).toEqual([]);
  });
});

describe('holdsValue', () => {
  it.each([
    [null, false],
    [undefined, false],
    [false, false],
    ['', false],
    [' \n', false],
    [[], false],
    [{}, false],
    [{ name: null, street: '', list: [], inner: { a: undefined } }, false],
    ['Saal', true],
    [0, true],
    [true, true],
    [[[[{ id: 1 }]]], true],
  ])('judges %j as %s', (value, expected) => {
    expect(holdsValue(value)).toBe(expected);
  });

  it('reads a value deeper than the stack would allow', () => {
    let deep: unknown = 'tief';
    for (let index = 0; index < 100_000; index += 1) deep = [deep];
    expect(holdsValue(deep)).toBe(true);
  });
});
