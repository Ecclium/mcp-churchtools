// Runs probe 11 against a synthetic instance full of canary values (see
// tests/fixtures/README.md). It must write only in the probe calendar and
// for the probe resource, only after «ja», record every object at once,
// delete what it created even after an error, and print no value from the
// instance.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  namesId,
  probe as calendarWrite,
  probeTimes,
  readView,
  statusWord,
} from '../../scripts/spike/11-calendar-write.mts';
import { probe as inventory } from '../../scripts/spike/00-inventory.mts';
import { hints } from '../../scripts/spike/lib/errors.mts';
import type { Input } from '../../scripts/spike/lib/gate.mts';
import type { ProbeResponse } from '../../scripts/spike/lib/http.mts';
import { exitCodes } from '../../scripts/spike/lib/output.mts';
import { runProbe } from '../../scripts/spike/lib/probe.mts';
import { readCalendarState } from '../../scripts/spike/lib/write-state.mts';
import { capture, leaks, type Capture } from './support.mts';
import {
  writeInstance,
  writeOrigin,
  writeSetup,
  type CalendarOptions,
  type WriteInstance,
  type WriteSetting,
} from './write-support.mts';

const spikeFolder = fileURLToPath(
  new URL('../../scripts/spike/', import.meta.url),
);

/** A terminal that answers «ja» and notes how many calls came before. */
function confirming(instance: WriteInstance): Input & { before: number[] } {
  const before: number[] = [];
  return {
    before,
    isTerminal: true,
    readLine: () => {
      before.push(instance.calls.length);
      return Promise.resolve('ja');
    },
  };
}

async function prepared(
  calendar: CalendarOptions = {},
  extra: { readonly failOnCall?: number } = {},
): Promise<{ setting: WriteSetting; instance: WriteInstance }> {
  const setting = writeSetup();
  const instance = writeInstance(setting, { calendar, ...extra });
  const output = capture();
  const code = await runProbe(inventory, {
    env: setting.inventoryEnv,
    fetch: instance.fetch,
    io: output.io,
    folder: spikeFolder,
  });
  expect(code, output.stderr()).toBe(exitCodes.ok);
  instance.calls.length = 0;
  return { setting, instance };
}

async function runCalendar(
  instance: WriteInstance,
  env: Readonly<Record<string, string | undefined>>,
  input?: Input,
): Promise<{ code: number; output: Capture; result: unknown }> {
  const output = capture();
  const code = await runProbe(calendarWrite, {
    env,
    fetch: instance.fetch,
    io: output.io,
    folder: spikeFolder,
    wait: () => Promise.resolve(),
    ...(input === undefined ? {} : { input }),
  });
  const text = output.stdout();
  return {
    code,
    output,
    result: text === '' ? undefined : JSON.parse(text),
  };
}

const writes = (instance: WriteInstance): string[] =>
  instance.calls
    .filter((call) => call.method !== 'GET')
    .map(
      (call) =>
        `${call.method} ${call.url.pathname.replace(/\/\d+(?=\/|$)/g, '/{}')}`,
    );

describe('11-calendar-write', () => {
  it('writes an appointment and two bookings, deletes them, and prints no value of the instance', async () => {
    const { setting, instance } = await prepared();
    const input = confirming(instance);
    const run = await runCalendar(instance, setting.calendarEnv, input);
    expect(run.code, run.output.stderr()).toBe(exitCodes.ok);
    expect(leaks(run.output, setting.forbidden)).toEqual([]);
    // Nothing is written before the person confirms.
    expect(input.before).toHaveLength(1);
    expect(
      instance.calls
        .slice(0, input.before[0])
        .every((call) => call.method === 'GET'),
    ).toBe(true);
    expect(writes(instance)).toEqual([
      'POST /api/calendars/{}/appointments',
      ...Array.from(
        { length: 6 },
        () => 'PUT /api/calendars/{}/appointments/{}',
      ),
      'DELETE /api/calendars/{}/appointments/{}',
      'POST /api/bookings/conflicts',
      'POST /api/bookings',
      'POST /api/bookings/conflicts',
      'POST /api/bookings',
      ...Array.from({ length: 5 }, () => 'PUT /api/bookings/{}'),
      'DELETE /api/bookings/{}',
      'DELETE /api/bookings/{}',
    ]);
    // Every request goes to the probe calendar or the probe resource.
    for (const call of instance.calls) {
      if (call.url.pathname.startsWith('/api/calendars/')) {
        expect(call.url.pathname).toContain(
          `/api/calendars/${String(setting.calendarArea.calendar)}/`,
        );
      }
      if (call.method === 'POST' && call.url.pathname === '/api/bookings') {
        expect(JSON.parse(call.body ?? '{}')).toMatchObject({
          resourceId: setting.calendarArea.resource,
          showInCal: false,
        });
      }
      expect(call.headers.has('cookie')).toBe(false);
    }
    expect(instance.appointments.size).toBe(0);
    expect(instance.bookings.size).toBe(0);
    const result = run.result as Record<string, Record<string, unknown>>;
    expect(result['modus']).toBe('proben');
    expect(result['termin']).toMatchObject({
      angelegt: 'ja',
      versionBeimAnlegen: '1',
      angelegtVomSchreibkonto: 'ja',
      titelGleich: 'ja',
      vollstaendig: {
        status: 200,
        versionGestiegen: 'ja',
        versionDifferenz: 'eins',
        uebernommen: 'ja',
        geaendertVomSchreibkonto: 'ja',
      },
      gleicherKoerper: { versionGestiegen: 'nein', uebernommen: 'ja' },
      ohneOptionaleFelder: {
        uebernommen: 'ja',
        untertitelGeleert: 'ja',
        beschreibungGeleert: 'ja',
      },
      veralteteVersion: { status: 200, uebernommen: 'ja' },
      ifMatch: { status: 200, uebernommen: 'ja' },
      ifUnmodifiedSince: { status: 200, uebernommen: 'ja' },
      loeschen: { status: 204, danachLesen: 404 },
    });
    expect(result['buchungen']).toMatchObject({
      konflikteVorher: { status: 200, anzahl: '0' },
      ersteBuchung: { statusGesendet: 'angefragt', statusGelesen: 'angefragt' },
      konflikteNachher: { anzahl: '1', nenntEigeneBuchung: 'ja' },
      zweiteBuchung: {
        statusGesendet: 'genehmigt',
        statusGelesen: 'angefragt',
      },
      faelle: {
        vollstaendig: { uebernommen: 'ja', statusGelesen: 'angefragt' },
        statusGenehmigt: { statusGelesen: 'angefragt' },
      },
      loeschen: {
        ersteBuchung: { status: 204, danachLesen: 404 },
        zweiteBuchung: { status: 204, danachLesen: 404 },
      },
    });
    expect(result['aufraeumen']).toEqual({
      termine: { geloescht: '0', uebrig: '0' },
      buchungen: { geloescht: '0', uebrig: '0' },
    });
    expect(result['rechteUnveraendert']).toBe('ja');
    const state = readCalendarState(
      setting.writeStateFile,
      writeOrigin,
      setting.calendarArea,
    );
    expect(state.appointments).toEqual([]);
    expect(state.bookings).toEqual([]);
  });

  it('reports an instance that keeps missing fields, honours a stale version and approves on request', async () => {
    const { setting, instance } = await prepared({
      putKeepsMissing: true,
      honourVersion: true,
      approvedBecomes: 2,
    });
    const run = await runCalendar(
      instance,
      setting.calendarEnv,
      confirming(instance),
    );
    expect(run.code, run.output.stderr()).toBe(exitCodes.ok);
    expect(leaks(run.output, setting.forbidden)).toEqual([]);
    expect(run.result).toMatchObject({
      termin: {
        ohneOptionaleFelder: {
          untertitelGeleert: 'nein',
          beschreibungGeleert: 'nein',
        },
        veralteteVersion: { status: 409, uebernommen: 'nein' },
      },
      buchungen: { zweiteBuchung: { statusGelesen: 'genehmigt' } },
    });
  });

  it('deletes what it created after an error that follows a write, and a second run finds nothing left', async () => {
    // Calls 1 to 7 are the reads of the guard, 8 whoami, 9 the first
    // create, 10 its read-back, 11 the first change.
    const { setting, instance } = await prepared({}, { failOnCall: 11 });
    const run = await runCalendar(
      instance,
      setting.calendarEnv,
      confirming(instance),
    );
    expect(run.code).not.toBe(exitCodes.ok);
    expect(run.output.stderr()).toContain(hints.kalenderSchreibenAbgebrochen);
    expect(leaks(run.output, setting.forbidden)).toEqual([]);
    expect(instance.appointments.size).toBe(0);
    const state = readCalendarState(
      setting.writeStateFile,
      writeOrigin,
      setting.calendarArea,
    );
    expect(state.appointments).toEqual([]);
  });

  it('deletes with the write state of an earlier run what that run left behind, by ID and by title', async () => {
    const { setting, instance } = await prepared({ deleteStatus: 500 });
    const first = await runCalendar(
      instance,
      setting.calendarEnv,
      confirming(instance),
    );
    expect(first.code, first.output.stderr()).toBe(exitCodes.ok);
    expect(instance.appointments.size).toBe(1);
    expect(instance.bookings.size).toBe(2);
    const left = readCalendarState(
      setting.writeStateFile,
      writeOrigin,
      setting.calendarArea,
    );
    expect(left.appointments).toHaveLength(1);
    expect(left.bookings).toHaveLength(2);

    // The same instance, now deleting, and a booking of the run whose
    // create answer was lost: only its title names it.
    const healed = writeInstance(setting, { calendar: {} });
    for (const [id, object] of instance.appointments) {
      healed.appointments.set(id, object);
    }
    for (const [id, object] of instance.bookings) {
      healed.bookings.set(id, object);
    }
    const [model] = instance.bookings.values();
    if (model === undefined) {
      throw new Error('no booking left');
    }
    const lost = { ...model, id: 999_001 };
    lost.fields = { ...lost.fields };
    healed.bookings.set(lost.id, lost);
    const second = await runCalendar(
      healed,
      setting.calendarEnv,
      confirming(healed),
    );
    expect(second.code, second.output.stderr()).toBe(exitCodes.ok);
    expect(second.result).toMatchObject({
      modus: 'aufraeumen',
      aufraeumen: {
        termine: { geloescht: '1', uebrig: '0' },
        buchungen: { geloescht: '2–9', uebrig: '0' },
      },
    });
    expect(healed.appointments.size).toBe(0);
    expect(healed.bookings.size).toBe(0);
    expect(writes(healed).every((call) => call.startsWith('DELETE'))).toBe(
      true,
    );
  });

  it.each<[string, CalendarOptions]>([
    ['a foreign appointment', { appointments: ['Synthetischer Termin'] }],
    ['a foreign booking', { bookings: ['Synthetische Buchung'] }],
  ])('writes nothing beside %s', async (_, calendar) => {
    const { setting, instance } = await prepared(calendar);
    const run = await runCalendar(
      instance,
      setting.calendarEnv,
      confirming(instance),
    );
    expect(run.code).toBe(exitCodes.configuration);
    expect(run.output.stderr()).toContain(hints.fremdeTermine);
    expect(writes(instance)).toEqual([]);
  });

  it('stops before any request without calendar and resource', async () => {
    const { setting, instance } = await prepared();
    const run = await runCalendar(instance, setting.env, confirming(instance));
    expect(run.code).toBe(exitCodes.configuration);
    expect(run.output.stderr()).toContain(hints.kalenderprobeOhneBereich);
    expect(instance.calls).toEqual([]);
  });

  it('stops after a create that names no ID, and deletes it by its title', async () => {
    const { setting, instance } = await prepared({ createWithoutId: true });
    const run = await runCalendar(
      instance,
      setting.calendarEnv,
      confirming(instance),
    );
    expect(run.code).not.toBe(exitCodes.ok);
    expect(run.output.stderr()).toContain(hints.kalenderSchreibenAbgebrochen);
    expect(instance.appointments.size).toBe(0);
    expect(readFileSync(setting.writeStateFile, 'utf8')).not.toContain(
      '"termin"',
    );
  });
});

describe('the helpers of 11-calendar-write', () => {
  it('writes thirty days ahead, never at midnight', () => {
    const times = probeTimes(new Date('2026-11-01T23:30:00Z'));
    expect(times.day).toBe('2026-12-01');
    expect(times.at('03:00')).toBe('2026-12-01T03:00:00Z');
  });

  it('reads only fields of the documented type', () => {
    const response = (body: unknown, status = 200): ProbeResponse => ({
      status,
      headers: new Headers(),
      setCookies: [],
      body,
      kind: 'JSON',
    });
    expect(
      readView(
        response({
          data: {
            booking: {
              version: '2',
              statusId: 1,
              title: 7,
              description: null,
              meta: { modifiedPerson: { id: 'x' }, createdPerson: { id: 3 } },
            },
          },
        }),
        'booking',
      ),
    ).toEqual({ status: 200, statusId: 1, description: null, createdBy: 3 });
    expect(readView(response({}, 404), 'booking')).toEqual({ status: 404 });
    expect(readView(response({ data: {} }), 'appointment')).toEqual({
      status: 200,
    });
  });

  it('names the statuses of a booking', () => {
    expect([1, 2, 3, 4, undefined].map(statusWord)).toEqual([
      'angefragt',
      'genehmigt',
      'abgelehnt',
      'andere',
      'fehlt',
    ]);
  });

  it('finds an ID only as the value of a key id or bookingId, and not too deep', () => {
    expect(namesId([{ booking: { base: { id: 5 } } }], 5)).toBe(true);
    expect(namesId([{ bookingId: 5, statusId: 1 }], 5)).toBe(true);
    expect(namesId([{ booking: { base: { resourceId: 5 } } }], 5)).toBe(false);
    expect(namesId({ a: { b: { id: 5 } } }, 5, 1)).toBe(false);
  });
});
