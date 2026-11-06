import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type BookingEntry,
  EccliumError,
  type IsoDate,
  type Permissions,
  type TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  createMemoryQuotaStore,
  createTestClock,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HttpTransportError } from '../http/index.js';
import { defaultPolicy } from '../policy/check.js';
import type { SnapshotState, SnapshotToSeal } from '../snapshots/seal.js';
import { calendarSentences } from './calendar-plan.js';
import {
  createWriteGuard,
  type UndoResult,
  type WriteClient,
  type WriteSnapshots,
  writeSentences,
} from './guard.js';
import { contentHashOf } from './plan-hash.js';
import type { SnapshotToUndo } from './undo.js';

// The write guard takes back writes of appointments and bookings for the
// operator (ADR 0031), over a ChurchTools in memory: calendar 8 with
// appointment 21, resource 13 with booking 51. No plan is sealed; the
// steps of every commit run all the same.

type ChurchToolsWrites = WriteClient['writes'];
type StoredAppointment = Awaited<
  ReturnType<ChurchToolsWrites['appointmentState']>
>['appointment'];
type StoredBooking = Awaited<
  ReturnType<ChurchToolsWrites['bookingState']>
>['booking'];

const now = Date.UTC(2026, 10, 6, 8, 0, 0);
const day = '2026-11-06' as IsoDate;
const start = '2026-11-08T09:00:00Z';
const end = '2026-11-08T10:00:00Z';
const undoId = '00000000-0000-4000-8000-000000000009';

const appointmentOf = (
  data: Partial<StoredAppointment> = {},
): StoredAppointment => ({
  id: 21,
  calendarId: 8,
  version: 3,
  title: 'Gottesdienst mit Chor',
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

const bookingOf = (data: Partial<StoredBooking> = {}): StoredBooking => ({
  id: 51,
  resourceId: 13,
  version: 0,
  title: 'Probe',
  description: 'Chor',
  startDate: start,
  endDate: end,
  statusId: 1,
  linked: false,
  ...data,
});

const entryOf = (booking: StoredBooking): BookingEntry => ({
  id: booking.id,
  title: booking.title,
  resourceId: booking.resourceId,
  statusId: booking.statusId,
  appointmentId: null,
  startDate: booking.startDate,
  endDate: booking.endDate,
});

// The hashes the write guard keeps, as `calendar-plan.ts` builds them.
const createdHash = (fields: {
  readonly title: string;
  readonly description: string | null;
}): string =>
  contentHashOf([fields.title, fields.description ?? '', start, end]);
const changeHash = (appointment: StoredAppointment): string =>
  contentHashOf([
    appointment.title,
    appointment.description ?? '',
    appointment.startDate,
    appointment.endDate,
    appointment.subtitle ?? '',
    String(appointment.isInternal),
  ]);

/** A ChurchTools of one appointment and one booking, in memory. */
interface Fake {
  /** The appointment; undefined reads as 404. */
  appointment: StoredAppointment | undefined;
  /** The booking; undefined reads as 500, as a deleted one does (F47). */
  booking: StoredBooking | undefined;
  /** Other bookings in the list of the days. */
  others: BookingEntry[];
  more: boolean;
  permissions: Permissions;
  time: number | null;
  accountId: number;
  readonly sent: string[];
  readonly reads: string[];
  /** What the first read fails with. */
  readFails?: Error;
  /** What a write fails with, and whether it lands all the same. */
  writeFails?: Error;
  writeLands?: boolean;
  /** What the list of the days fails with after a delete. */
  listFailsAfter?: Error;
  /** Done on each read of the target, such as switching writing off. */
  onRead?: () => void;
}

const fakeOf = (): Fake => ({
  appointment: appointmentOf(),
  booking: bookingOf(),
  others: [],
  more: false,
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

const unused = (): Promise<never> => Promise.reject(new Error('not used'));

const writesOf = (fake: Fake): ChurchToolsWrites => {
  const firstRead = (): Error | undefined => {
    fake.onRead?.();
    const failure = fake.sent.length === 0 ? fake.readFails : undefined;
    return failure;
  };
  // A write that fails lands only when asked to; one that works lands.
  const write = (effect: () => void): Promise<void> => {
    if (fake.writeFails === undefined || fake.writeLands === true) effect();
    return fake.writeFails === undefined
      ? Promise.resolve()
      : Promise.reject(fake.writeFails);
  };
  return {
    createWikiPage: unused,
    updateWikiPage: unused,
    wikiPageState: unused,
    wikiCategoryState: unused,
    wikiCategoryName: unused,
    calendarDayState: unused,
    createAppointment: unused,
    createBooking: unused,
    calendarFacts: unused,
    resourceName: unused,
    appointmentState: () => {
      fake.reads.push('appointment');
      const failure = firstRead();
      if (failure !== undefined) return Promise.reject(failure);
      return fake.appointment === undefined
        ? Promise.reject(new EccliumError('not_found'))
        : Promise.resolve({
            appointment: fake.appointment,
            serverTime: fake.time,
          });
    },
    updateAppointment: (_ctx, _calendarId, appointmentId, change) => {
      fake.sent.push(`PUT appointment ${String(appointmentId)}`);
      return write(() => {
        const appointment = fake.appointment as StoredAppointment;
        fake.appointment = {
          ...appointment,
          ...change,
          version: appointment.version + 1,
        };
      });
    },
    deleteAppointment: (_ctx, _calendarId, appointmentId) => {
      fake.sent.push(`DELETE appointment ${String(appointmentId)}`);
      return write(() => {
        fake.appointment = undefined;
      });
    },
    bookingState: () => {
      fake.reads.push('booking');
      const failure = firstRead();
      if (failure !== undefined) return Promise.reject(failure);
      return fake.booking === undefined
        ? Promise.reject(new EccliumError('upstream'))
        : Promise.resolve({ booking: fake.booking, serverTime: fake.time });
    },
    resourceDayState: (_ctx, _resourceId, from, to) => {
      fake.reads.push(`resource ${from} ${to}`);
      if (fake.sent.length > 0 && fake.listFailsAfter !== undefined) {
        return Promise.reject(fake.listFailsAfter);
      }
      return Promise.resolve({
        bookings: {
          bookings: [
            ...fake.others,
            ...(fake.booking === undefined ? [] : [entryOf(fake.booking)]),
          ],
          more: fake.more,
        },
        serverTime: fake.time,
      });
    },
    deleteBooking: (_ctx, bookingId) => {
      fake.sent.push(`DELETE booking ${String(bookingId)}`);
      return write(() => {
        fake.booking = undefined;
      });
    },
  };
};

let dir: string;
let logged: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ecclium-guard-calendar-undo-'));
  logged = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ctx = (): TenantContext => {
  const log = (event: string) => {
    logged.push(event);
  };
  return {
    tenantId: 'demo-tenant',
    actor: { kind: 'service', id: 'stdio:local-stdio' },
    readOnly: false,
    mode: 'operator',
    log: { debug: log, info: log, warn: log, error: log },
  } as unknown as TenantContext;
};

// A keeper of snapshots that keeps what it is given, or fails.
const keeper = (
  fails = false,
): { snapshots: WriteSnapshots; saved: SnapshotToSeal[] } => {
  const saved: SnapshotToSeal[] = [];
  return {
    saved,
    snapshots: {
      save: (_ctx, snapshot) => {
        if (fails) return Promise.reject(new Error('disk full'));
        saved.push(snapshot);
        return Promise.resolve();
      },
      load: () => Promise.resolve({ kind: 'missing' }),
    },
  };
};

const undo = (
  fake: Fake,
  snapshot: Omit<SnapshotToUndo, 'day'>,
  options: { overwrite?: boolean; snapshots?: WriteSnapshots } = {},
): Promise<UndoResult> =>
  createWriteGuard({
    client: {
      permissions: () => Promise.resolve(fake.permissions),
      whoami: () => Promise.resolve({ id: fake.accountId }),
      writes: writesOf(fake),
    },
    clock: createTestClock(now),
    killSwitchDir: dir,
    policy: defaultPolicy,
    quota: createMemoryQuotaStore(),
    snapshots: options.snapshots ?? keeper().snapshots,
  }).undo({
    ctx: ctx(),
    eventId: undoId,
    snapshot: { ...snapshot, day },
    overwrite: options.overwrite ?? false,
  });

// The snapshot of a change of the title from «Gottesdienst» and of the
// description, which the appointment as it is now left.
const before = {
  version: 2,
  title: 'Gottesdienst',
  subtitle: 'Abendmahl',
  description: null,
  startDate: start,
  endDate: end,
  isInternal: false,
};
const changed = (): { before: SnapshotState } => ({
  before: {
    kind: 'appointmentFields',
    tool: 'ct_appointments_update',
    calendarId: 8,
    appointmentId: 21,
    before,
    after: { version: 3, fieldsHash: changeHash(appointmentOf()) },
  },
});

// A new appointment 21 and a new booking 51, as their writes left them.
const createdAppointment = () =>
  ({
    before: {
      kind: 'appointmentCreate',
      tool: 'ct_appointments_create',
      placeId: 8,
      fieldsHash: createdHash(appointmentOf()),
    },
    after: { kind: 'appointmentCreated', id: 21, version: 0 },
  }) as const;
const createdBooking = () =>
  ({
    before: {
      kind: 'bookingCreate',
      tool: 'ct_bookings_create',
      placeId: 13,
      fieldsHash: createdHash(bookingOf()),
      startDate: start,
      endDate: end,
    },
    after: { kind: 'bookingCreated', id: 51, version: 0, statusId: 1 },
  }) as const;

const appointmentTarget = { kind: 'appointment', key: '8/21' };
const bookingTarget = { kind: 'booking', key: '13/51' };

describe('taking back the change of an appointment', () => {
  it('writes the fields from before back, keeps the others and a snapshot of its own', async () => {
    const fake = fakeOf();
    fake.appointment = appointmentOf({ isInternal: true });
    const { snapshots, saved } = keeper();
    // The snapshot names the appointment as the change left it, internal.
    const snapshot = changed();
    (snapshot.before as { after: object }).after = {
      version: 3,
      fieldsHash: changeHash(fake.appointment),
    };
    const result = await undo(fake, snapshot, { snapshots });
    expect(result).toMatchObject({
      kind: 'committed',
      target: appointmentTarget,
      result: {
        ok: true,
        state: 'verified',
        path: 'operator',
        version: 4,
        undoId,
      },
    });
    expect(fake.sent).toEqual(['PUT appointment 21']);
    expect(fake.appointment).toMatchObject({
      title: 'Gottesdienst',
      description: null,
      subtitle: 'Abendmahl',
      isInternal: true,
      version: 4,
    });
    expect(saved).toEqual([
      {
        eventId: undoId,
        part: 'before',
        day,
        content: {
          kind: 'appointmentFields',
          tool: 'ct_appointments_update',
          calendarId: 8,
          appointmentId: 21,
          before: {
            version: 3,
            title: 'Gottesdienst mit Chor',
            subtitle: 'Abendmahl',
            description: 'Mit Taufe',
            startDate: start,
            endDate: end,
            isInternal: true,
          },
          after: { version: 4, fieldsHash: expect.any(String) as string },
        },
      },
    ]);
    if (result.kind !== 'committed') throw new Error('expected a commit');
    expect(result.change.from).toContain('Titel: Gottesdienst mit Chor');
    expect(result.change.to).toContain('Titel: Gottesdienst');
    expect(result.change.to).not.toContain('Beschreibung');
  });

  it('writes nothing when the fields stand as before', async () => {
    const fake = fakeOf();
    fake.appointment = appointmentOf({
      title: 'Gottesdienst',
      description: null,
      version: 5,
    });
    expect(await undo(fake, changed())).toEqual({
      kind: 'unchanged',
      target: appointmentTarget,
    });
    expect(fake.sent).toEqual([]);
  });

  it('shows a later change and writes over it only with --overwrite', async () => {
    const fake = fakeOf();
    fake.appointment = appointmentOf({ version: 4, title: 'Später' });
    const result = await undo(fake, changed());
    expect(result).toMatchObject({
      kind: 'changed',
      target: appointmentTarget,
    });
    expect(fake.sent).toEqual([]);
    const over = await undo(fake, changed(), { overwrite: true });
    expect(over).toMatchObject({ kind: 'committed', result: { ok: true } });
    expect(fake.sent).toEqual(['PUT appointment 21']);
  });

  it('moves an appointment back only when the account of the server created it', async () => {
    const fake = fakeOf();
    fake.appointment = appointmentOf({
      version: 4,
      startDate: '2026-11-08T11:00:00Z',
      endDate: '2026-11-08T12:00:00Z',
      createdBy: 7,
    });
    // Without --overwrite the later change is shown first (65).
    expect(await undo(fake, changed())).toMatchObject({ kind: 'changed' });
    expect(await undo(fake, changed(), { overwrite: true })).toMatchObject({
      kind: 'refused',
      error: {
        code: 'policy_denied',
        message: calendarSentences.notOwnTime,
      },
    });
    fake.appointment = { ...fake.appointment, createdBy: null };
    expect(await undo(fake, changed(), { overwrite: true })).toMatchObject({
      kind: 'refused',
      error: { message: calendarSentences.notOwnTime },
    });
    fake.appointment = { ...fake.appointment, createdBy: 41 };
    expect(await undo(fake, changed(), { overwrite: true })).toMatchObject({
      kind: 'committed',
      result: { ok: true },
    });
    expect(fake.appointment).toMatchObject({ startDate: start, endDate: end });
  });

  it.each([
    [
      'parts',
      { parts: ['address'] },
      'policy_denied',
      calendarSentences.appointmentParts,
    ],
    [
      'whole days',
      { allDay: true },
      'policy_denied',
      calendarSentences.wholeDays,
    ],
  ] as const)(
    'refuses an appointment with %s',
    async (_, data, code, message) => {
      const fake = fakeOf();
      fake.appointment = appointmentOf(data);
      expect(await undo(fake, changed())).toMatchObject({
        kind: 'refused',
        error: { code, message },
      });
      expect(fake.sent).toEqual([]);
    },
  );

  it('asks for the creator only when the times move', async () => {
    const fake = fakeOf();
    fake.appointment = appointmentOf({ createdBy: 7 });
    expect(await undo(fake, changed())).toMatchObject({
      kind: 'committed',
      result: { ok: true },
    });
  });

  it('keeps the subtitle as it is now', async () => {
    const fake = fakeOf();
    fake.appointment = appointmentOf({ subtitle: 'Neu' });
    const snapshot = changed();
    (snapshot.before as { after: object }).after = {
      version: 3,
      fieldsHash: changeHash(fake.appointment),
    };
    expect(await undo(fake, snapshot)).toMatchObject({ kind: 'committed' });
    expect(fake.appointment).toMatchObject({
      title: 'Gottesdienst',
      subtitle: 'Neu',
    });
  });

  it('takes another version with the same fields as a change since', async () => {
    const fake = fakeOf();
    fake.appointment = appointmentOf({ version: 4 });
    expect(await undo(fake, changed())).toMatchObject({ kind: 'changed' });
    expect(fake.sent).toEqual([]);
  });

  it('refuses fields the client would not send', async () => {
    const fake = fakeOf();
    const snapshot = changed();
    (snapshot.before as { before: object }).before = { ...before, title: '' };
    expect(await undo(fake, snapshot)).toMatchObject({
      kind: 'refused',
      error: { code: 'validation', message: calendarSentences.datedFields },
    });
  });

  it('writes nothing with a clock that differs, or switched off during the read', async () => {
    const clockOff = fakeOf();
    clockOff.time = now + 10 * 60_000;
    expect(await undo(clockOff, changed())).toMatchObject({
      kind: 'committed',
      result: {
        ok: false,
        state: 'denied',
        error: { message: writeSentences.clock },
        path: 'operator',
      },
    });
    expect(clockOff.sent).toEqual([]);
    const off = fakeOf();
    off.onRead = () => {
      writeFileSync(join(dir, 'writes-off'), '');
    };
    expect(await undo(off, changed())).toMatchObject({
      kind: 'committed',
      result: { ok: false, error: { message: writeSentences.switchedOff } },
    });
    expect(off.sent).toEqual([]);
  });

  it('writes nothing when its own snapshot cannot be kept', async () => {
    const fake = fakeOf();
    const result = await undo(fake, changed(), {
      snapshots: keeper(true).snapshots,
    });
    expect(result).toMatchObject({
      kind: 'committed',
      result: { ok: false, error: { message: writeSentences.noSnapshot } },
    });
    expect(fake.sent).toEqual([]);
    expect(logged).toContain('snapshot_failed');
  });

  it('names an outcome that is not known', async () => {
    const fake = fakeOf();
    fake.writeFails = new EccliumError('network');
    fake.writeLands = true;
    expect(await undo(fake, changed())).toMatchObject({
      kind: 'committed',
      result: { ok: true, version: 4 },
    });
    const lost = fakeOf();
    lost.writeFails = new EccliumError('network');
    expect(await undo(lost, changed())).toMatchObject({
      kind: 'committed',
      result: { ok: false, sent: true, error: { code: 'network' } },
    });
  });
});

describe('taking back a new appointment', () => {
  it('deletes it as the write left it and reads it gone, without a snapshot', async () => {
    const fake = fakeOf();
    fake.appointment = appointmentOf({ version: 0 });
    const { snapshots, saved } = keeper();
    const result = await undo(fake, createdAppointment(), { snapshots });
    expect(result).toMatchObject({
      kind: 'deleted',
      target: appointmentTarget,
    });
    if (result.kind !== 'deleted') throw new Error('expected a delete');
    expect(result.change.to).toBe('');
    expect(result.change.from).toContain('Titel: Gottesdienst mit Chor');
    expect(fake.sent).toEqual(['DELETE appointment 21']);
    expect(saved).toEqual([]);
    expect(logged).toContain('write_committed');
  });

  it('has nothing to do for an appointment that is gone', async () => {
    const fake = fakeOf();
    fake.appointment = undefined;
    expect(await undo(fake, createdAppointment())).toEqual({
      kind: 'unchanged',
      target: appointmentTarget,
    });
  });

  it('ends with the code of a read that fails', async () => {
    const fake = fakeOf();
    fake.readFails = new EccliumError('network');
    expect(await undo(fake, createdAppointment())).toMatchObject({
      kind: 'refused',
      error: { code: 'network' },
    });
  });

  it('never deletes one someone changed, also not with --overwrite', async () => {
    const fake = fakeOf();
    fake.appointment = appointmentOf({ version: 1 });
    expect(
      await undo(fake, createdAppointment(), { overwrite: true }),
    ).toMatchObject({ kind: 'changed', change: { to: '' } });
    fake.appointment = appointmentOf({ version: 0, title: 'Anders' });
    expect(await undo(fake, createdAppointment())).toMatchObject({
      kind: 'changed',
    });
    expect(fake.sent).toEqual([]);
  });

  it('never deletes one with something linked to it', async () => {
    const fake = fakeOf();
    fake.appointment = appointmentOf({ version: 0, parts: ['linked'] });
    expect(await undo(fake, createdAppointment())).toMatchObject({
      kind: 'refused',
      error: { message: calendarSentences.appointmentParts },
    });
  });

  it.each([
    [
      'never sent',
      new HttpTransportError('refused'),
      false,
      { ok: false, sent: false, error: { message: writeSentences.notSent } },
    ],
    [
      'refused by ChurchTools',
      new EccliumError('permission'),
      false,
      { ok: false, sent: false, error: { code: 'permission' } },
    ],
    [
      'unknown and still there',
      new EccliumError('network'),
      false,
      { ok: false, sent: true, error: { message: writeSentences.unknown } },
    ],
  ] as const)('reports a delete %s', async (_, failure, lands, result) => {
    const fake = fakeOf();
    fake.appointment = appointmentOf({ version: 0 });
    fake.writeFails = failure;
    fake.writeLands = lands;
    expect(await undo(fake, createdAppointment())).toMatchObject({
      kind: 'committed',
      result,
    });
  });

  it('takes a delete that failed but landed as done', async () => {
    const fake = fakeOf();
    fake.appointment = appointmentOf({ version: 0 });
    fake.writeFails = new EccliumError('network');
    fake.writeLands = true;
    expect(await undo(fake, createdAppointment())).toMatchObject({
      kind: 'deleted',
    });
  });

  it('reports one that reads back still there, or not at all', async () => {
    const stays = fakeOf();
    stays.appointment = appointmentOf({ version: 0 });
    const writes = writesOf(stays);
    const guard = (
      fake: Fake,
      overrides: Partial<ChurchToolsWrites>,
    ): Promise<UndoResult> =>
      createWriteGuard({
        client: {
          permissions: () => Promise.resolve(fake.permissions),
          whoami: () => Promise.resolve({ id: fake.accountId }),
          writes: { ...writes, ...overrides },
        },
        clock: createTestClock(now),
        killSwitchDir: dir,
        policy: defaultPolicy,
        quota: createMemoryQuotaStore(),
      }).undo({
        ctx: ctx(),
        eventId: undoId,
        snapshot: { ...createdAppointment(), day },
        overwrite: false,
      });
    // ChurchTools answers 204 but keeps the appointment.
    expect(
      await guard(stays, { deleteAppointment: () => Promise.resolve() }),
    ).toMatchObject({
      kind: 'committed',
      result: {
        ok: false,
        state: 'conflict',
        error: { message: writeSentences.notAsPlanned },
      },
    });
    // The read after fails with another code than 404.
    let reads = 0;
    expect(
      await guard(stays, {
        appointmentState: (...args) => {
          reads += 1;
          return reads === 1
            ? writes.appointmentState(...args)
            : Promise.reject(new EccliumError('upstream'));
        },
      }),
    ).toMatchObject({
      kind: 'committed',
      result: { ok: false, sent: true, error: { code: 'upstream' } },
    });
  });

  it('asks for the right to change appointments in the calendar', async () => {
    const fake = fakeOf();
    fake.appointment = appointmentOf({ version: 0 });
    fake.permissions = {
      kind: 'known',
      granted: { churchcal: { 'edit category': [9], 'view category': [8] } },
    } as unknown as Permissions;
    expect(await undo(fake, createdAppointment())).toMatchObject({
      kind: 'refused',
      error: { code: 'permission', message: calendarSentences.calendarRight },
    });
    expect(fake.reads).toEqual([]);
  });
});

describe('taking back a new booking', () => {
  it('deletes it as the write left it and sees it gone in the list of its days', async () => {
    const fake = fakeOf();
    const result = await undo(fake, createdBooking());
    expect(result).toMatchObject({ kind: 'deleted', target: bookingTarget });
    expect(fake.sent).toEqual(['DELETE booking 51']);
    expect(fake.reads).toEqual(['booking', 'resource 2026-11-07 2026-11-09']);
  });

  it('has nothing to do when the read answers 404 and the list leaves it out', async () => {
    const fake = fakeOf();
    fake.booking = undefined;
    fake.readFails = new EccliumError('not_found');
    expect(await undo(fake, createdBooking())).toEqual({
      kind: 'unchanged',
      target: bookingTarget,
    });
  });

  // A deleted booking reads as 500 (F47), but so does one moved to another
  // resource, whose answer names that resource: the operator looks.
  it('names a booking it cannot read and the list leaves out, and writes nothing', async () => {
    const fake = fakeOf();
    fake.booking = undefined;
    expect(await undo(fake, createdBooking())).toMatchObject({
      kind: 'refused',
      error: { code: 'not_found', message: calendarSentences.bookingGone },
    });
    expect(fake.sent).toEqual([]);
  });

  it('keeps the error of the read when the list still names it, ends early or the read failed otherwise', async () => {
    const listed = fakeOf();
    listed.readFails = new EccliumError('upstream');
    expect(await undo(listed, createdBooking())).toMatchObject({
      kind: 'refused',
      error: { code: 'upstream' },
    });
    const full = fakeOf();
    full.booking = undefined;
    full.more = true;
    expect(await undo(full, createdBooking())).toMatchObject({
      kind: 'refused',
      error: { code: 'upstream' },
    });
    const network = fakeOf();
    network.readFails = new EccliumError('network');
    expect(await undo(network, createdBooking())).toMatchObject({
      kind: 'refused',
      error: { code: 'network' },
    });
    expect(network.reads).toEqual(['booking']);
  });

  it.each([
    ['approved without a new version', { statusId: 2 }],
    ['rejected', { statusId: 3 }],
    ['linked to an appointment', { linked: true }],
  ] as const)('never deletes one %s', async (_, data) => {
    const fake = fakeOf();
    fake.booking = bookingOf(data);
    expect(await undo(fake, createdBooking())).toMatchObject({
      kind: 'changed',
    });
    expect(fake.sent).toEqual([]);
  });

  it('deletes one the resource approved by itself, as the write left it', async () => {
    const fake = fakeOf();
    fake.booking = bookingOf({ statusId: 2 });
    const snapshot = createdBooking();
    expect(
      await undo(fake, {
        ...snapshot,
        after: { ...snapshot.after, statusId: 2 },
      }),
    ).toMatchObject({ kind: 'deleted' });
  });

  it('never deletes one someone changed or approved', async () => {
    const fake = fakeOf();
    fake.booking = bookingOf({ version: 1, statusId: 2 });
    expect(
      await undo(fake, createdBooking(), { overwrite: true }),
    ).toMatchObject({ kind: 'changed', target: bookingTarget });
    fake.booking = bookingOf({ title: 'Anders' });
    expect(await undo(fake, createdBooking())).toMatchObject({
      kind: 'changed',
    });
    expect(fake.sent).toEqual([]);
  });

  it.each([
    [
      'never sent',
      new HttpTransportError('refused'),
      false,
      undefined,
      { ok: false, sent: false, error: { message: writeSentences.notSent } },
    ],
    [
      'refused while the list still names it',
      new EccliumError('permission'),
      false,
      undefined,
      { ok: false, sent: false, error: { code: 'permission' } },
    ],
    [
      'with a list that fails after the send',
      undefined,
      true,
      new EccliumError('network'),
      { ok: false, sent: true, error: { message: writeSentences.unknown } },
    ],
  ] as const)(
    'reports a delete %s',
    async (_, failure, lands, listFails, result) => {
      const fake = fakeOf();
      if (failure !== undefined) fake.writeFails = failure;
      fake.writeLands = lands;
      if (listFails !== undefined) fake.listFailsAfter = listFails;
      expect(await undo(fake, createdBooking())).toMatchObject({
        kind: 'committed',
        result,
      });
    },
  );

  it('reports a booking still in the list after a delete, or a list too full to tell', async () => {
    const stays = fakeOf();
    const writes = writesOf(stays);
    const run = (overrides: Partial<ChurchToolsWrites>): Promise<UndoResult> =>
      createWriteGuard({
        client: {
          permissions: () => Promise.resolve(stays.permissions),
          whoami: () => Promise.resolve({ id: stays.accountId }),
          writes: { ...writes, ...overrides },
        },
        clock: createTestClock(now),
        killSwitchDir: dir,
        policy: defaultPolicy,
        quota: createMemoryQuotaStore(),
      }).undo({
        ctx: ctx(),
        eventId: undoId,
        snapshot: { ...createdBooking(), day },
        overwrite: false,
      });
    expect(await run({ deleteBooking: () => Promise.resolve() })).toMatchObject(
      {
        kind: 'committed',
        result: { ok: false, error: { message: writeSentences.notAsPlanned } },
      },
    );
    stays.more = true;
    expect(
      await run({
        deleteBooking: () => {
          stays.booking = undefined;
          return Promise.resolve();
        },
      }),
    ).toMatchObject({
      kind: 'committed',
      result: {
        ok: false,
        sent: true,
        error: { message: writeSentences.unknown },
      },
    });
  });

  it('asks for the right to request bookings of the resource', async () => {
    const fake = fakeOf();
    fake.permissions = {
      kind: 'known',
      granted: {
        churchresource: { 'create bookings': true, 'view resource': true },
      },
    } as unknown as Permissions;
    expect(await undo(fake, createdBooking())).toMatchObject({
      kind: 'deleted',
    });
    fake.booking = bookingOf();
    fake.permissions = {
      kind: 'known',
      granted: {},
    } as unknown as Permissions;
    expect(await undo(fake, createdBooking())).toMatchObject({
      kind: 'refused',
      error: { code: 'permission', message: calendarSentences.resourceRight },
    });
  });
});

describe('a new appointment or booking without its ID', () => {
  it('names only the calendar or the resource', async () => {
    const fake = fakeOf();
    const appointment = createdAppointment();
    expect(await undo(fake, { before: appointment.before })).toEqual({
      kind: 'incomplete',
      target: { kind: 'calendar', key: '8' },
    });
    const booking = createdBooking();
    expect(await undo(fake, { before: booking.before })).toEqual({
      kind: 'incomplete',
      target: { kind: 'resource', key: '13' },
    });
    expect(fake.reads).toEqual([]);
  });
});
