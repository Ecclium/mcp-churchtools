import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type AppointmentEntry,
  type BookingEntry,
  EccliumError,
  isEccliumError,
  type IsoDate,
  type Permissions,
  type PlannedWrite,
  type TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  createMemoryQuotaStore,
  createTestClock,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HttpTransportError } from '../http/index.js';
import { checkPolicy, defaultPolicy } from '../policy/check.js';
import type { SnapshotToSeal } from '../snapshots/seal.js';
import { calendarSentences } from './calendar-plan.js';
import {
  createWriteGuard,
  type PlanRequest,
  type PlanResult,
  type WriteClient,
  type WriteSnapshots,
  writeSentences,
} from './guard.js';
import { issueProof } from './proof.js';
import { readPlan } from './sealed-plan.js';

// The types of the client through the write guard, since only listed
// modules import the raw client (ADR 0024).
type ChurchToolsWrites = WriteClient['writes'];
type StoredAppointment = Awaited<
  ReturnType<ChurchToolsWrites['appointmentState']>
>['appointment'];
type StoredBooking = Awaited<
  ReturnType<ChurchToolsWrites['bookingState']>
>['booking'];

// The write guard with appointments and bookings (ADR 0029, ADR 0072),
// over a ChurchTools in memory: one calendar 8 with appointment 21, one
// resource 13. The wiki has its own tests in guard.test.ts.

const now = Date.UTC(2026, 10, 6, 8, 0, 0);
const start = '2026-11-08T09:00:00Z';
const end = '2026-11-08T10:00:00Z';

const contextOf = (logged: string[]): TenantContext => {
  const log = (event: string) => {
    logged.push(event);
  };
  return {
    tenantId: 'demo-tenant',
    actor: { kind: 'service', id: 'stdio:local-stdio' },
    readOnly: false,
    mode: 'interactive',
    log: { debug: log, info: log, warn: log, error: log },
  } as unknown as TenantContext;
};

/** A ChurchTools of one calendar and one resource, in memory. */
interface Fake {
  appointment: StoredAppointment;
  /** The appointments the list of the days gives. */
  days: AppointmentEntry[];
  /** The bookings the list of the days gives. */
  bookings: BookingEntry[];
  permissions: Permissions;
  time: number | null;
  /** The ID of the account of the server. */
  accountId: number;
  /** Writes as `method target`, in their order. */
  readonly sent: string[];
  /** Reads of ChurchTools as `what from to`, in their order. */
  readonly reads: string[];
  /** Whether the day lists end before their last entry. */
  more?: boolean;
  /** What a new appointment or booking answers instead of the fields sent. */
  created?: Partial<StoredAppointment>;
  booked?: Partial<StoredBooking>;
  /** What a write fails with instead of writing. */
  writeFails?: Error;
  /** Whether a change that fails still lands. */
  writeLands?: boolean;
  readFails?: Error;
  /** What the read after a write fails with, or changes. */
  readFailsAfterWrite?: Error;
  afterWrite?: Partial<StoredAppointment>;
  bookingAfter?: Partial<StoredBooking>;
  /** Name and visibility of the calendar, none when null. */
  facts?: { readonly name: string; readonly isPublic: boolean } | null;
  /** The name of the resource, none when null. */
  resource?: string | null;
}

const stored = (data: Partial<StoredAppointment> = {}): StoredAppointment => ({
  id: 21,
  calendarId: 8,
  version: 2,
  title: 'Gottesdienst',
  subtitle: 'Abendmahl',
  description: 'Mit Taufe',
  startDate: start,
  endDate: end,
  allDay: false,
  isInternal: false,
  createdBy: 41,
  parts: [],
  ...data,
});

const fakeOf = (): Fake => ({
  appointment: stored(),
  days: [],
  bookings: [],
  permissions: {
    kind: 'known',
    granted: {
      churchcal: { 'edit category': [8], 'view category': [8] },
      churchresource: { 'create bookings': [13], 'view resource': [13] },
    },
  } as unknown as Permissions,
  time: now,
  accountId: 41,
  sent: [],
  reads: [],
});

const wikiUnused = (): Promise<never> =>
  Promise.reject(new Error('not used by appointments'));

const writesOf = (fake: Fake): ChurchToolsWrites => {
  let booking: StoredBooking | undefined;
  return {
    createWikiPage: wikiUnused,
    updateWikiPage: wikiUnused,
    wikiPageState: wikiUnused,
    wikiCategoryState: wikiUnused,
    wikiCategoryName: wikiUnused,
    appointmentState: () => {
      fake.reads.push('appointment');
      if (fake.readFails !== undefined) return Promise.reject(fake.readFails);
      const written = fake.sent.length > 0;
      if (written && fake.readFailsAfterWrite !== undefined) {
        return Promise.reject(fake.readFailsAfterWrite);
      }
      return Promise.resolve({
        appointment: written
          ? { ...fake.appointment, ...fake.afterWrite }
          : fake.appointment,
        serverTime: fake.time,
      });
    },
    calendarDayState: (_ctx, _calendarId, from, to) => {
      fake.reads.push(`calendar ${from} ${to}`);
      return Promise.resolve({
        appointments: { appointments: fake.days, more: fake.more === true },
        serverTime: fake.time,
      });
    },
    createAppointment: (_ctx, calendarId, fields) => {
      fake.sent.push(`POST calendar ${String(calendarId)}`);
      if (fake.writeFails !== undefined) return Promise.reject(fake.writeFails);
      fake.appointment = stored({
        id: 31,
        version: 0,
        subtitle: null,
        ...fields,
        ...fake.created,
      });
      return Promise.resolve(fake.appointment);
    },
    updateAppointment: (_ctx, _calendarId, appointmentId, change) => {
      fake.sent.push(`PUT appointment ${String(appointmentId)}`);
      if (fake.writeFails === undefined || fake.writeLands === true) {
        fake.appointment = stored({
          ...fake.appointment,
          ...change,
          version: fake.appointment.version + 1,
        });
      }
      return fake.writeFails === undefined
        ? Promise.resolve()
        : Promise.reject(fake.writeFails);
    },
    deleteAppointment: wikiUnused,
    bookingState: () =>
      booking === undefined
        ? Promise.reject(new EccliumError('not_found'))
        : fake.readFailsAfterWrite === undefined
          ? Promise.resolve({
              booking: { ...booking, ...fake.bookingAfter },
              serverTime: fake.time,
            })
          : Promise.reject(fake.readFailsAfterWrite),
    resourceDayState: (_ctx, _resourceId, from, to) => {
      fake.reads.push(`resource ${from} ${to}`);
      return Promise.resolve({
        bookings: { bookings: fake.bookings, more: fake.more === true },
        serverTime: fake.time,
      });
    },
    createBooking: (_ctx, resourceId, fields) => {
      fake.sent.push(`POST booking ${String(resourceId)}`);
      if (fake.writeFails !== undefined) return Promise.reject(fake.writeFails);
      booking = {
        id: 51,
        resourceId,
        version: 0,
        statusId: 1,
        linked: false,
        ...fields,
        ...fake.booked,
      };
      return Promise.resolve(booking);
    },
    deleteBooking: wikiUnused,
    calendarFacts: () =>
      Promise.resolve(
        fake.facts === null
          ? undefined
          : (fake.facts ?? { name: 'Gottesdienste', isPublic: true }),
      ),
    resourceName: () =>
      Promise.resolve(
        fake.resource === null ? undefined : (fake.resource ?? 'Saal'),
      ),
  };
};

const clientOf = (fake: Fake): WriteClient => ({
  permissions: () => Promise.resolve(fake.permissions),
  whoami: () => Promise.resolve({ id: fake.accountId }),
  writes: writesOf(fake),
});

let dir: string;
let logged: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ecclium-guard-calendar-'));
  logged = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const meta = { sensitivity: 'personal', unattended: 'policy' } as const;

const setup = (fake = fakeOf(), snapshots?: WriteSnapshots) => {
  const guard = createWriteGuard({
    client: clientOf(fake),
    clock: createTestClock(now),
    killSwitchDir: dir,
    policy: defaultPolicy,
    quota: createMemoryQuotaStore(),
    snapshots,
  });
  const ctx = contextOf(logged);
  const request = (tool: string): PlanRequest => ({
    ctx,
    tool,
    origin: 'core',
    meta,
  });
  return { fake, guard, ctx, request };
};

// A keeper of snapshots that keeps what it is given.
const keeper = (): { snapshots: WriteSnapshots; saved: SnapshotToSeal[] } => {
  const saved: SnapshotToSeal[] = [];
  return {
    saved,
    snapshots: {
      save: (_ctx, snapshot) => {
        saved.push(snapshot);
        return Promise.resolve();
      },
      load: () => Promise.resolve({ kind: 'missing' }),
    },
  };
};

const refusalOf = async (promise: Promise<unknown>): Promise<EccliumError> => {
  try {
    await promise;
  } catch (error) {
    if (isEccliumError(error)) return error;
  }
  throw new Error('expected a refusal');
};

const planOf = ({ outcome }: PlanResult): PlannedWrite => {
  if (outcome.kind !== 'planned') throw new Error('expected a plan');
  return outcome.plan;
};

const create = {
  kind: 'appointmentCreate',
  calendarId: 8,
  title: 'Probe',
  startDate: start,
  endDate: end,
  description: 'Chor',
};
const update = {
  kind: 'appointmentUpdate',
  calendarId: 8,
  appointmentId: 21,
  baseVersion: 2,
  title: 'Gottesdienst mit Chor',
  startDate: start,
  endDate: end,
};
const booking = {
  kind: 'bookingCreate',
  resourceId: 13,
  title: 'Probe',
  startDate: start,
  endDate: end,
  description: 'Chor',
};

// Plans and commits with a proof of a question in the client.
const commitOf = async (parts: ReturnType<typeof setup>, intent: object) => {
  const tool =
    (intent as { kind: string }).kind === 'bookingCreate'
      ? 'ct_bookings_create'
      : 'ct_appointments_write';
  const plan = planOf(await parts.guard.plan(parts.request(tool), intent));
  return parts.guard.commit(
    parts.ctx,
    plan,
    issueProof(plan, 'elicitation', now),
    '00000000-0000-4000-8000-000000000001',
  );
};

describe('planning an appointment', () => {
  it('seals a new appointment with a text in German that names the public calendar', async () => {
    const parts = setup(fakeOf(), keeper().snapshots);
    const result = await parts.guard.plan(parts.request('ct_x'), create);
    expect(result.target).toEqual({ kind: 'calendar', key: '8' });
    expect(result.text?.summary).toBe(
      'Einen Termin «Probe» im Kalender «Gottesdienste» anlegen: Sonntag, 08.11.2026, 09:00 bis 10:00 (UTC). Der Kalender ist öffentlich: Den Termin sieht auch, wer nicht angemeldet ist.',
    );
    expect(result.text?.diff).toContain('+Titel: Probe');
    expect(result.text?.diff).toContain('+Beschreibung: Chor');
    // An appointment is taken back from its snapshot, and the echo may
    // confirm it (ADR 0029); without snapshots it may not.
    expect(readPlan(planOf(result))?.echo).toBe(true);
    const bare = setup();
    expect(
      readPlan(planOf(await bare.guard.plan(bare.request('ct_x'), create)))
        ?.echo,
    ).toBe(false);
    expect(parts.fake.sent).toEqual([]);
  });

  it('skips an appointment of the same title and time on the calendar', async () => {
    const fake = fakeOf();
    fake.days = [
      {
        id: 22,
        calendarId: 8,
        title: 'Probe',
        subtitle: null,
        allDay: false,
        locationName: null,
        startDate: start,
        endDate: end,
      },
    ];
    const parts = setup(fake);
    expect(
      (await parts.guard.plan(parts.request('ct_x'), create)).outcome,
    ).toEqual({ kind: 'skipped', reason: 'already_written' });
  });

  const wrongFields: readonly [string, object][] = [
    ['a title of 256 characters', { title: 'T'.repeat(256) }],
    ['an end before the start', { endDate: '2026-11-08T08:00:00Z' }],
    ['a day alone', { startDate: '2026-11-08' }],
    ['a start with seconds', { startDate: '2026-11-08T09:00:30Z' }],
    ['an end with seconds', { endDate: '2026-11-08T10:00:30Z' }],
    ['a description of 2001 characters', { description: 'D'.repeat(2001) }],
  ];
  it.each(
    [create, update, booking].flatMap((intent) =>
      wrongFields.map(
        ([name, change]) =>
          [`${intent.kind} with ${name}`, intent, change] as const,
      ),
    ),
  )('refuses %s before it reads', async (_, intent, change) => {
    const parts = setup();
    const error = await refusalOf(
      parts.guard.plan(parts.request('ct_x'), { ...intent, ...change }),
    );
    expect(error).toMatchObject({
      code: 'validation',
      message: calendarSentences.datedFields,
    });
    expect(parts.fake.reads).toEqual([]);
  });

  it('reads the days around it and refuses more days than the lists read', async () => {
    const parts = setup();
    await parts.guard.plan(parts.request('ct_x'), create);
    expect(parts.fake.reads).toEqual(['calendar 2026-11-07 2026-11-09']);
    // 28 days after the start the lists still take the days around it.
    const longest = { endDate: '2026-12-06T10:00:00Z' };
    for (const intent of [create, booking]) {
      expect(
        (
          await parts.guard.plan(parts.request('ct_x'), {
            ...intent,
            ...longest,
          })
        ).outcome.kind,
      ).toBe('planned');
    }
    const own = setup();
    expect(
      (await own.guard.plan(own.request('ct_x'), { ...update, ...longest }))
        .outcome.kind,
    ).toBe('planned');
    for (const intent of [create, update, booking]) {
      const error = await refusalOf(
        parts.guard.plan(parts.request('ct_x'), {
          ...intent,
          endDate: '2026-12-07T10:00:00Z',
        }),
      );
      expect(error).toMatchObject({
        code: 'validation',
        message: calendarSentences.datedSpan,
      });
    }
  });

  it('plans an appointment of the same title at another time, and of another title at the same time', async () => {
    const day = (data: Partial<AppointmentEntry>): AppointmentEntry => ({
      id: 22,
      calendarId: 8,
      title: 'Probe',
      subtitle: null,
      allDay: false,
      locationName: null,
      startDate: start,
      endDate: end,
      ...data,
    });
    for (const entry of [
      day({ startDate: '2026-11-08T08:00:00Z' }),
      day({ endDate: '2026-11-08T11:00:00Z' }),
      day({ title: 'Andere Probe' }),
    ]) {
      const parts = setup({ ...fakeOf(), days: [entry] });
      expect(
        (await parts.guard.plan(parts.request('ct_x'), create)).outcome.kind,
      ).toBe('planned');
    }
  });

  it('refuses a plan when a day list ends before its last entry', async () => {
    for (const intent of [create, booking]) {
      const parts = setup({ ...fakeOf(), more: true });
      const error = await refusalOf(
        parts.guard.plan(parts.request('ct_x'), intent),
      );
      expect(error).toMatchObject({
        code: 'policy_denied',
        message: calendarSentences.dayListFull,
      });
    }
  });

  it('names the missing rights of the calendar', async () => {
    const fake = fakeOf();
    fake.permissions = {
      kind: 'known',
      granted: { churchcal: { 'view category': [8] } },
    } as unknown as Permissions;
    const parts = setup(fake);
    const error = await refusalOf(
      parts.guard.plan(parts.request('ct_x'), create),
    );
    expect(error.code).toBe('permission');
    expect(error.message).toBe(writeSentences.calendarRight);
  });

  it('refuses a description with a link', async () => {
    const parts = setup();
    await expect(
      parts.guard.plan(parts.request('ct_x'), {
        ...create,
        description: 'Siehe [hier](https://example.org)',
      }),
    ).rejects.toMatchObject({ name: 'ContentRefusal' });
  });
});

describe('planning a change of an appointment', () => {
  it('seals a change of the title and names what changes', async () => {
    const parts = setup();
    const result = await parts.guard.plan(parts.request('ct_x'), update);
    expect(result.target).toEqual({ kind: 'appointment', key: '8/21' });
    expect(result.text?.summary).toContain(
      'Beim Termin «Gottesdienst» im Kalender «Gottesdienste» Titel ändern',
    );
    expect(result.text?.diff).toEqual(
      expect.arrayContaining([
        '-Titel: Gottesdienst',
        '+Titel: Gottesdienst mit Chor',
      ]),
    );
  });

  it('keeps a description the change does not name, also one longer than a tool may give', async () => {
    const parts = setup();
    const result = await parts.guard.plan(parts.request('ct_x'), update);
    expect(result.text?.diff.join('\n')).not.toContain('-Beschreibung');
    const long = setup({
      ...fakeOf(),
      appointment: stored({ description: 'D'.repeat(3000) }),
    });
    expect(
      (await long.guard.plan(long.request('ct_x'), update)).outcome.kind,
    ).toBe('planned');
  });

  it('says nothing of the public for an internal appointment, and allows no echo', async () => {
    const parts = setup(
      { ...fakeOf(), appointment: stored({ isInternal: true }) },
      keeper().snapshots,
    );
    const result = await parts.guard.plan(parts.request('ct_x'), update);
    expect(result.text?.summary).not.toContain('öffentlich');
    // ChurchTools may mail the person who created it (ADR 0029).
    expect(readPlan(planOf(result))?.echo).toBe(false);
  });

  it('skips a change that changes nothing, since every PUT raises the version (F42)', async () => {
    const parts = setup();
    expect(
      (
        await parts.guard.plan(parts.request('ct_x'), {
          ...update,
          title: 'Gottesdienst',
        })
      ).outcome,
    ).toEqual({ kind: 'skipped', reason: 'unchanged' });
  });

  it.each([
    [
      'another version',
      { appointment: stored({ version: 3 }) },
      'conflict',
      calendarSentences.appointmentChanged,
    ],
    [
      'a series',
      { appointment: stored({ parts: ['series'] }) },
      'policy_denied',
      calendarSentences.appointmentParts,
    ],
    [
      'a linked part',
      { appointment: stored({ parts: ['linked'] }) },
      'policy_denied',
      calendarSentences.appointmentParts,
    ],
    [
      'whole days',
      { appointment: stored({ allDay: true }) },
      'policy_denied',
      calendarSentences.wholeDays,
    ],
  ])('refuses an appointment with %s', async (_, change, code, message) => {
    const parts = setup({ ...fakeOf(), ...change });
    const error = await refusalOf(
      parts.guard.plan(parts.request('ct_x'), update),
    );
    expect(error).toMatchObject({ code, message });
  });

  // ADR 0029: start and end move only for an appointment the account
  // created, a move of either end as well as of both.
  it('moves an appointment only when the account of the server created it', async () => {
    const later = {
      ...update,
      startDate: '2026-11-08T10:00:00Z',
      endDate: '2026-11-08T11:00:00Z',
    };
    const longer = { ...update, endDate: '2026-11-08T11:00:00Z' };
    const earlier = { ...update, startDate: '2026-11-08T08:00:00Z' };
    const own = setup();
    for (const moved of [later, longer, earlier]) {
      expect(
        (await own.guard.plan(own.request('ct_x'), moved)).outcome.kind,
      ).toBe('planned');
    }
    for (const createdBy of [42, null]) {
      const foreign = setup({
        ...fakeOf(),
        appointment: stored({ createdBy }),
      });
      for (const moved of [later, longer, earlier]) {
        const error = await refusalOf(
          foreign.guard.plan(foreign.request('ct_x'), moved),
        );
        expect(error).toMatchObject({
          code: 'policy_denied',
          message: calendarSentences.notOwnTime,
        });
      }
      // The title of a foreign appointment still changes.
      expect(
        (await foreign.guard.plan(foreign.request('ct_x'), update)).outcome
          .kind,
      ).toBe('planned');
    }
  });
});

describe('planning a booking', () => {
  it('seals a request, says the mail goes to the managers and allows no echo (F48)', async () => {
    const parts = setup(fakeOf(), keeper().snapshots);
    const result = await parts.guard.plan(
      parts.request('ct_bookings_create'),
      booking,
    );
    expect(result.target).toEqual({ kind: 'resource', key: '13' });
    expect(result.text?.summary).toBe(
      'Eine Buchung der Ressource «Saal» anfragen: «Probe», Sonntag, 08.11.2026, 09:00 bis 10:00 (UTC). ChurchTools schickt Titel und Beschreibung per Mail an die Verwalter der Ressource.',
    );
    expect(readPlan(planOf(result))?.echo).toBe(false);
    expect(parts.fake.reads).toEqual(['resource 2026-11-07 2026-11-09']);
  });

  it('skips a request of the same title and time, and counts other bookings at the time', async () => {
    const entry = (data: Partial<BookingEntry>): BookingEntry => ({
      id: 60,
      title: 'Probe',
      resourceId: 13,
      statusId: 1,
      appointmentId: null,
      startDate: start,
      endDate: end,
      ...data,
    });
    const same = setup({ ...fakeOf(), bookings: [entry({})] });
    expect(
      (await same.guard.plan(same.request('ct_bookings_create'), booking))
        .outcome,
    ).toEqual({ kind: 'skipped', reason: 'already_written' });
    const busy = setup({
      ...fakeOf(),
      bookings: [
        entry({ id: 61, title: 'Andere', statusId: 2 }),
        entry({ id: 62, title: 'Abgelehnt', statusId: 3 }),
        entry({
          id: 63,
          title: 'Später',
          startDate: end,
          endDate: '2026-11-08T11:00:00Z',
        }),
        // A rejected request with the same title is no request of it.
        entry({ id: 64, statusId: 3 }),
        // Bookings that end when it starts or before do not overlap.
        entry({
          id: 65,
          title: 'Davor',
          startDate: '2026-11-08T08:00:00Z',
          endDate: start,
        }),
        entry({
          id: 66,
          title: 'Früh',
          startDate: '2026-11-08T06:00:00Z',
          endDate: '2026-11-08T07:00:00Z',
        }),
        // The same title at another time is another request.
        entry({
          id: 67,
          startDate: '2026-11-08T07:00:00Z',
          endDate: '2026-11-08T08:00:00Z',
        }),
        entry({
          id: 68,
          startDate: '2026-11-08T11:00:00Z',
          endDate: '2026-11-08T12:00:00Z',
        }),
      ],
    });
    const result = await busy.guard.plan(
      busy.request('ct_bookings_create'),
      booking,
    );
    expect(result.outcome.kind).toBe('planned');
    expect(result.text?.summary).toContain(
      'Zur selben Zeit hat die Ressource eine weitere Buchung.',
    );
  });

  it('names the missing rights of the resource', async () => {
    const fake = fakeOf();
    fake.permissions = {
      kind: 'known',
      granted: { churchresource: { 'view resource': true } },
    } as unknown as Permissions;
    const parts = setup(fake);
    const error = await refusalOf(
      parts.guard.plan(parts.request('ct_bookings_create'), booking),
    );
    expect(error.message).toBe(writeSentences.resourceRight);
  });
});

describe('committing', () => {
  it('creates an appointment, reads it back and keeps both parts of its snapshot', async () => {
    const { snapshots, saved } = keeper();
    const parts = setup(fakeOf(), snapshots);
    const result = await commitOf(parts, create);
    expect(result).toMatchObject({
      ok: true,
      state: 'verified',
      target: { kind: 'appointment', key: '8/31' },
      version: 0,
    });
    expect(parts.fake.sent).toEqual(['POST calendar 8']);
    expect(saved.map((part) => [part.part, part.content.kind])).toEqual([
      ['before', 'appointmentCreate'],
      ['after', 'appointmentCreated'],
    ]);
    expect(saved[1]?.content).toEqual({
      kind: 'appointmentCreated',
      id: 31,
      version: 0,
    });
  });

  it('changes an appointment, keeps what the change does not name and checks that the version rose by one', async () => {
    const { snapshots, saved } = keeper();
    const parts = setup(
      { ...fakeOf(), appointment: stored({ isInternal: true }) },
      snapshots,
    );
    const result = await commitOf(parts, update);
    expect(result).toMatchObject({ ok: true, version: 3 });
    expect(parts.fake.appointment).toMatchObject({
      title: 'Gottesdienst mit Chor',
      subtitle: 'Abendmahl',
      description: 'Mit Taufe',
      isInternal: true,
    });
    expect(saved[0]?.content).toEqual({
      kind: 'appointmentFields',
      tool: 'ct_appointments_write',
      calendarId: 8,
      appointmentId: 21,
      before: {
        version: 2,
        title: 'Gottesdienst',
        subtitle: 'Abendmahl',
        description: 'Mit Taufe',
        startDate: start,
        endDate: end,
        isInternal: true,
      },
      after: { version: 3, fieldsHash: expect.any(String) as string },
    });
  });

  it('requests a booking and takes one the resource approved by itself', async () => {
    const fake = fakeOf();
    fake.booked = { statusId: 2, version: 1 };
    const parts = setup(fake);
    expect(await commitOf(parts, booking)).toMatchObject({
      ok: true,
      target: { kind: 'booking', key: '13/51' },
      version: 1,
    });
  });

  it.each([
    ['a rejected booking', { statusId: 3 }],
    ['a booking of a series', { linked: true }],
    ['another title', { title: 'Anders' }],
  ])('ends a request in a conflict for %s', async (_, booked) => {
    const fake = fakeOf();
    fake.booked = booked;
    const parts = setup(fake);
    expect(await commitOf(parts, booking)).toMatchObject({
      ok: false,
      state: 'conflict',
      sent: true,
      error: { message: writeSentences.notAsPlanned },
    });
  });

  it('ends a new appointment that does not read back as sent in a conflict', async () => {
    const fake = fakeOf();
    fake.created = { version: 1 };
    const parts = setup(fake);
    expect(await commitOf(parts, create)).toMatchObject({
      state: 'conflict',
      target: { kind: 'appointment', key: '8/31' },
    });
  });

  it.each([
    [
      'refused before any socket',
      new HttpTransportError('refused'),
      false,
      writeSentences.notSent,
    ],
    [
      'refused by ChurchTools',
      new EccliumError('permission'),
      false,
      undefined,
    ],
    [
      'failed on the way',
      new HttpTransportError('connect'),
      true,
      writeSentences.unknown,
    ],
  ])('tells a send %s', async (_, error, sent, message) => {
    const fake = fakeOf();
    fake.writeFails = error;
    const parts = setup(fake);
    const result = await commitOf(parts, booking);
    expect(result).toMatchObject({ ok: false, state: 'failed', sent });
    if (message !== undefined && !result.ok) {
      expect(result.error.message).toBe(message);
    }
  });

  it('decides a failed change by the read after it', async () => {
    const landed = fakeOf();
    landed.writeFails = new HttpTransportError('timeout');
    landed.writeLands = true;
    expect(await commitOf(setup(landed), update)).toMatchObject({
      ok: true,
      version: 3,
    });
    const refused = fakeOf();
    refused.writeFails = new EccliumError('validation');
    const result = await commitOf(setup(refused), update);
    expect(result).toMatchObject({
      ok: false,
      state: 'failed',
      sent: false,
      error: { code: 'validation' },
    });
    if (!result.ok)
      expect(result.error.message).not.toBe(writeSentences.notSent);
    // A timeout that did not land may still land: the outcome is unknown.
    const lost = fakeOf();
    lost.writeFails = new HttpTransportError('timeout');
    expect(await commitOf(setup(lost), update)).toMatchObject({
      ok: false,
      state: 'failed',
      sent: true,
      error: { message: writeSentences.unknown },
    });
  });

  it('writes nothing when the same appointment appeared between plan and commit', async () => {
    const parts = setup();
    const plan = planOf(await parts.guard.plan(parts.request('ct_x'), create));
    parts.fake.days = [
      {
        id: 22,
        calendarId: 8,
        title: 'Probe',
        subtitle: null,
        allDay: false,
        locationName: null,
        startDate: start,
        endDate: end,
      },
    ];
    const result = await parts.guard.commit(
      parts.ctx,
      plan,
      issueProof(plan, 'elicitation', now),
    );
    expect(result).toMatchObject({
      ok: false,
      state: 'denied',
      error: { code: 'conflict', message: writeSentences.changedSincePlan },
    });
    expect(parts.fake.sent).toEqual([]);
  });

  it('writes nothing when the day list is full at the commit', async () => {
    const parts = setup();
    const plan = planOf(await parts.guard.plan(parts.request('ct_x'), create));
    parts.fake.more = true;
    const result = await parts.guard.commit(
      parts.ctx,
      plan,
      issueProof(plan, 'elicitation', now),
    );
    expect(result).toMatchObject({
      ok: false,
      state: 'denied',
      error: { message: calendarSentences.dayListFull },
    });
    expect(parts.fake.sent).toEqual([]);
  });

  it('writes nothing when the appointment changed between plan and commit', async () => {
    const parts = setup();
    const plan = planOf(await parts.guard.plan(parts.request('ct_x'), update));
    parts.fake.appointment = stored({ version: 3 });
    const result = await parts.guard.commit(
      parts.ctx,
      plan,
      issueProof(plan, 'elicitation', now),
    );
    expect(result).toMatchObject({
      state: 'denied',
      error: { code: 'conflict' },
    });
    expect(parts.fake.sent).toEqual([]);
  });
});

describe('the edges of a write of an appointment or a booking', () => {
  it('names a calendar and a resource it cannot read by their IDs', async () => {
    const parts = setup({ ...fakeOf(), facts: null, resource: null });
    expect(
      (await parts.guard.plan(parts.request('ct_x'), create)).text?.summary,
    ).toContain('im Kalender 8 anlegen');
    expect(
      (await parts.guard.plan(parts.request('ct_x'), update)).text?.summary,
    ).toContain('im Kalender 8 Titel ändern');
    expect(
      (await parts.guard.plan(parts.request('ct_b'), booking)).text?.summary,
    ).toContain('Eine Buchung der Ressource 13 anfragen');
  });

  it('writes an appointment and a booking without a description', async () => {
    const parts = setup();
    expect(
      await commitOf(parts, { ...create, description: undefined }),
    ).toMatchObject({ ok: true });
    expect(parts.fake.appointment.description).toBeNull();
    expect(
      await commitOf(setup(), { ...booking, description: undefined }),
    ).toMatchObject({ ok: true });
  });

  it('shows each line of a description, and a change of it', async () => {
    const parts = setup({
      ...fakeOf(),
      appointment: stored({ subtitle: null }),
    });
    const result = await parts.guard.plan(parts.request('ct_x'), {
      ...update,
      description: 'Mit Taufe\nund Chor',
    });
    expect(result.text?.summary).toContain('Titel und Beschreibung ändern');
    expect(result.text?.diff).toEqual(
      expect.arrayContaining([' Beschreibung: Mit Taufe', '+  und Chor']),
    );
    expect(
      await commitOf(
        setup({ ...fakeOf(), appointment: stored({ subtitle: null }) }),
        {
          ...update,
          description: 'Mit Taufe\nund Chor',
        },
      ),
    ).toMatchObject({ ok: true });
  });

  it.each([
    [
      'a failed send of a new appointment',
      { writeFails: new EccliumError('upstream') },
      create,
      'failed',
    ],
    [
      'a failed read after a new appointment',
      { readFailsAfterWrite: new HttpTransportError('connect') },
      create,
      'failed',
    ],
    [
      'a new appointment that reads back otherwise',
      { afterWrite: { title: 'Anders' } },
      create,
      'conflict',
    ],
    [
      'a new appointment ChurchTools took as one of whole days',
      { created: { allDay: true } },
      create,
      'conflict',
    ],
    [
      'a new appointment that reads back as one of whole days',
      { afterWrite: { allDay: true } },
      create,
      'conflict',
    ],
    [
      'a change that reads back as one of whole days',
      { afterWrite: { allDay: true } },
      update,
      'conflict',
    ],
    [
      'a change that lost the subtitle',
      { afterWrite: { subtitle: null } },
      update,
      'conflict',
    ],
    [
      'a change that changed the visibility',
      { afterWrite: { isInternal: true } },
      update,
      'conflict',
    ],
    [
      'a failed read after a change',
      { readFailsAfterWrite: new HttpTransportError('timeout') },
      update,
      'failed',
    ],
    [
      'a change that reads back otherwise',
      { afterWrite: { version: 5 } },
      update,
      'conflict',
    ],
    [
      'a failed read after a booking',
      { readFailsAfterWrite: new EccliumError('upstream') },
      booking,
      'failed',
    ],
    [
      'a booking that reads back otherwise',
      { bookingAfter: { statusId: 3 } },
      booking,
      'conflict',
    ],
  ])('tells %s', async (_, change, intent, state) => {
    const parts = setup({ ...fakeOf(), ...change });
    const result = await commitOf(parts, intent);
    expect(result).toMatchObject({
      ok: false,
      state,
      sent: true,
    });
  });

  it('tells a send that failed with an error of no kind it knows', async () => {
    const fake = fakeOf();
    fake.writeFails = new Error('boom');
    expect(await commitOf(setup(fake), booking)).toMatchObject({
      ok: false,
      state: 'failed',
      sent: true,
      error: { code: 'internal', message: writeSentences.unknown },
    });
  });

  it('changes an appointment without a description and keeps it without one', async () => {
    const parts = setup({
      ...fakeOf(),
      appointment: stored({ description: null }),
    });
    expect(await commitOf(parts, update)).toMatchObject({ ok: true });
    expect(parts.fake.appointment.description).toBeNull();
  });

  it('ends a change that the transport refused before any socket', async () => {
    const fake = fakeOf();
    fake.writeFails = new HttpTransportError('refused');
    expect(await commitOf(setup(fake), update)).toMatchObject({
      ok: false,
      state: 'failed',
      sent: false,
      error: { message: writeSentences.notSent },
    });
  });

  it('keeps the write when the part after of its snapshot cannot be kept', async () => {
    const saved: SnapshotToSeal[] = [];
    const snapshots: WriteSnapshots = {
      save: (_ctx, snapshot) => {
        if (snapshot.part === 'after') return Promise.reject(new Error('disk'));
        saved.push(snapshot);
        return Promise.resolve();
      },
      load: () => Promise.resolve({ kind: 'missing' }),
    };
    const parts = setup(fakeOf(), snapshots);
    expect(await commitOf(parts, booking)).toMatchObject({ ok: true });
    expect(saved).toHaveLength(1);
    expect(logged).toContain('snapshot_incomplete');
  });

  it('seals a plan without a day when the clock gives none', async () => {
    const guard = createWriteGuard({
      client: clientOf(fakeOf()),
      clock: createTestClock(Number.NaN),
      killSwitchDir: dir,
      policy: defaultPolicy,
      quota: createMemoryQuotaStore(),
    });
    const ctx = contextOf(logged);
    const result = await guard.plan(
      { ctx, tool: 'ct_x', origin: 'core', meta },
      create,
    );
    expect(result.outcome.kind).toBe('planned');
    expect(readPlan(planOf(result))?.day).toBeUndefined();
  });

  // The policy names calendars and resources with the IDs and names the
  // operator expects (ADR 0032).
  it('checks the names of the calendar and the resource the policy names', async () => {
    const checked = checkPolicy({
      schema: 'policy.v1',
      interactive: {
        targets: [
          {
            target: { kind: 'calendar', id: 8, name: 'Gottesdienste' },
            tools: ['ct_x'],
            maxPerDay: 5,
          },
          {
            target: { kind: 'resource', id: 13, name: 'Probenraum' },
            tools: ['ct_b'],
            maxPerDay: 5,
          },
        ],
      },
    });
    if (!checked.ok) throw new Error(checked.code);
    const guard = createWriteGuard({
      client: clientOf(fakeOf()),
      clock: createTestClock(now),
      killSwitchDir: dir,
      policy: checked.policy,
      quota: createMemoryQuotaStore(),
    });
    const ctx = contextOf(logged);
    const request = (tool: string): PlanRequest => ({
      ctx,
      tool,
      origin: 'core',
      meta,
    });
    expect((await guard.plan(request('ct_x'), create)).queue).toBeUndefined();
    expect((await guard.plan(request('ct_b'), booking)).queue).toBe(
      'name_changed',
    );
  });
});

describe('the operator', () => {
  it('writes an approved booking request of the queue', async () => {
    const parts = setup();
    const plan = planOf(
      await parts.guard.plan(parts.request('ct_bookings_create'), booking),
    );
    const view = readPlan(plan);
    if (view === undefined) throw new Error('expected a plan');
    const result = await parts.guard.approve({
      ctx: parts.ctx,
      eventId: '00000000-0000-4000-8000-000000000002',
      entry: {
        tool: 'ct_bookings_create',
        origin: 'core',
        toolMeta: meta,
        intent: booking,
        planHash: view.planHash,
        plannedOn: '2026-11-06' as IsoDate,
      },
      decide: () => Promise.resolve(true),
    });
    expect(result).toMatchObject({
      kind: 'committed',
      result: { ok: true, target: { kind: 'booking' } },
    });
    if (result.kind === 'committed') {
      expect(result.change.from).toBe('');
      expect(result.change.to).toContain('Titel: Probe');
    }
  });

  it('writes nothing when the request stands there since it was queued', async () => {
    const parts = setup();
    const plan = planOf(
      await parts.guard.plan(parts.request('ct_bookings_create'), booking),
    );
    const view = readPlan(plan);
    if (view === undefined) throw new Error('expected a plan');
    parts.fake.bookings = [
      {
        id: 60,
        title: 'Probe',
        resourceId: 13,
        statusId: 1,
        appointmentId: null,
        startDate: start,
        endDate: end,
      },
    ];
    const result = await parts.guard.approve({
      ctx: parts.ctx,
      eventId: '00000000-0000-4000-8000-000000000004',
      entry: {
        tool: 'ct_bookings_create',
        origin: 'core',
        toolMeta: meta,
        intent: booking,
        planHash: view.planHash,
        plannedOn: '2026-11-06' as IsoDate,
      },
      decide: () => Promise.resolve(true),
    });
    expect(result).toMatchObject({
      kind: 'refused',
      error: { code: 'conflict', message: writeSentences.changedSinceQueued },
    });
    expect(parts.fake.sent).toEqual([]);
  });

  it('takes back no appointment yet', async () => {
    const parts = setup();
    const result = await parts.guard.undo({
      ctx: parts.ctx,
      eventId: '00000000-0000-4000-8000-000000000003',
      snapshot: {
        before: {
          kind: 'appointmentCreate',
          tool: 'ct_x',
          placeId: 8,
          fieldsHash: 'a'.repeat(64),
        },
        day: '2026-11-06' as IsoDate,
      },
      overwrite: false,
    });
    expect(result).toMatchObject({
      kind: 'refused',
      error: { code: 'policy_denied', message: writeSentences.notRun },
    });
  });
});
