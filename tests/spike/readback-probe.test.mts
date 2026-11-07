// Runs probe 13 against a synthetic instance full of canary values (see
// tests/fixtures/README.md). It must write only in the write area and the
// probe calendar, only after «ja», record the page and the appointment at
// once, delete both even after an error, name a key outside the document
// only when the block list lets it through, and print no value of the
// instance.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  caseText,
  classesOf,
  compareStored,
  coreFormText,
  createCase,
  probe as readback,
  readbackTimes,
  ruleOf,
  serverRules,
  textForm,
  trimLikePhp,
  unknownKeys,
  wikiCases,
} from '../../scripts/spike/13-write-readback.mts';
import { probe as inventory } from '../../scripts/spike/00-inventory.mts';
import { hints } from '../../scripts/spike/lib/errors.mts';
import type { Input } from '../../scripts/spike/lib/gate.mts';
import { exitCodes } from '../../scripts/spike/lib/output.mts';
import { runProbe } from '../../scripts/spike/lib/probe.mts';
import {
  readCalendarState,
  readWriteState,
} from '../../scripts/spike/lib/write-state.mts';
import { capture, leaks, type Capture } from './support.mts';
import {
  writeInstance,
  writeOrigin,
  writeSetup,
  type WriteInstance,
  type WriteInstanceOptions,
  type WriteSetting,
} from './write-support.mts';

const spikeFolder = fileURLToPath(
  new URL('../../scripts/spike/', import.meta.url),
);

// Written as code points, so that no tool turns them into the characters.
const nbsp = String.fromCodePoint(0xa0);
const ideographic = String.fromCodePoint(0x3000);
const verticalTab = String.fromCodePoint(0x0b);

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

// ChurchTools as the OpenAPI document describes it: the text trimmed.
const asStored: Pick<
  WriteInstanceOptions,
  'normalizeOnCreate' | 'normalizeOnUpdate'
> = { normalizeOnCreate: trimLikePhp, normalizeOnUpdate: trimLikePhp };

async function prepared(
  options: Omit<WriteInstanceOptions, 'calendar'> & {
    readonly calendar?: WriteInstanceOptions['calendar'];
  } = {},
): Promise<{
  setting: WriteSetting;
  instance: WriteInstance;
  env: Readonly<Record<string, string | undefined>>;
  calendarState: string;
}> {
  const setting = writeSetup();
  const instance = writeInstance(setting, {
    ...asStored,
    ...options,
    calendar: options.calendar ?? {},
  });
  const output = capture();
  const code = await runProbe(inventory, {
    env: setting.inventoryEnv,
    fetch: instance.fetch,
    io: output.io,
    folder: spikeFolder,
  });
  expect(code, output.stderr()).toBe(exitCodes.ok);
  instance.calls.length = 0;
  const calendarState = join(setting.folder, 'kalender-state.jsonl');
  return {
    setting,
    instance,
    calendarState,
    env: {
      ...setting.calendarEnv,
      ECCLIUM_SPIKE_WRITE_CALENDAR_STATE_FILE: calendarState,
    },
  };
}

async function runReadback(
  instance: WriteInstance,
  env: Readonly<Record<string, string | undefined>>,
  input?: Input,
): Promise<{ code: number; output: Capture; result: unknown }> {
  const output = capture();
  const code = await runProbe(readback, {
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
        `${call.method} ${call.url.pathname
          .replace(/\/[0-9a-f-]{36}$/i, '/{guid}')
          .replace(/\/\d+(?=\/|$)/g, '/{}')}`,
    );

describe('13-write-readback', () => {
  it('writes a page and an appointment, compares them, deletes both, and prints no value of the instance', async () => {
    const { setting, instance, env, calendarState } = await prepared({
      calendar: { undocumentedField: { name: 'urls' } },
    });
    const input = confirming(instance);
    const run = await runReadback(instance, env, input);
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
      'POST /api/wiki/categories/{}/pages',
      ...Array.from(
        { length: wikiCases.length },
        () => 'PATCH /api/wiki/categories/{}/pages/{guid}',
      ),
      'DELETE /api/wiki/categories/{}/pages/{guid}',
      'POST /api/calendars/{}/appointments',
      'PUT /api/calendars/{}/appointments/{}',
      'DELETE /api/calendars/{}/appointments/{}',
    ]);
    // The appointment is read as the server reads it before a change.
    const includes = instance.calls
      .filter((call) => /\/appointments\/\d+$/.test(call.url.pathname))
      .map((call) => call.url.searchParams.getAll('include[]').join());
    expect(includes).toContain('event,bookings,meetingRequests');
    expect(includes).toContain('');
    // The body of the change carries exactly the fields of the server.
    const change = instance.calls.find((call) => call.method === 'PUT');
    expect(Object.keys(JSON.parse(change?.body ?? '{}') as object)).toEqual([
      'title',
      'description',
      'startDate',
      'endDate',
      'isInternal',
      'repeatId',
    ]);
    expect(run.result).toMatchObject({
      probe: '13-write-readback',
      wiki: {
        anlegen: {
          status: 201,
          zurueckgelesen: 'ohne Leerraum an den Enden',
          entferntAnfang: [],
          entferntEnde: ['Zeilenumbruch'],
        },
        faelle: {
          endeLeerzeichenUndUmbrueche: {
            version: 'neu',
            entferntEnde: ['Leerzeichen', 'Zeilenumbruch'],
          },
          anfangUmbruchUndLeerzeichen: {
            entferntAnfang: ['Zeilenumbruch', 'Leerzeichen'],
          },
          endeVertikalerTabulator: { entferntEnde: ['vertikaler Tabulator'] },
          endeSeitenvorschub: { zurueckgelesen: 'wie gesendet' },
          endeGeschuetztesLeerzeichen: { zurueckgelesen: 'wie gesendet' },
          endeIdeografischesLeerzeichen: { zurueckgelesen: 'wie gesendet' },
          zeilenendenCrlf: { zurueckgelesen: 'wie gesendet' },
        },
        regel: 'wie trim in PHP',
        loeschen: { danachLesen: 404 },
      },
      termin: {
        angelegt: 'ja',
        lesen: {
          status: 200,
          unbekannt: [
            {
              ort: 'im Termin',
              name: 'urls',
              typ: 'Objekt',
              verweis: 'ja',
              alteFeldnamen: 'nein',
              felder: [
                {
                  name: 'self',
                  form: 'Adresse dieser Instanz',
                  nenntKennung: 'ja',
                },
                { name: 'ical', form: 'Adresse dieser Instanz' },
                { name: 'title', form: 'Text', gleichWie: 'title' },
              ],
            },
          ],
          regelnDesServers: {
            unbekanntImTermin: 'ja',
            zusatzinfos: 'nein',
            weitereTeile: [],
            verknuepft: 'ja',
          },
        },
        lesenOhneInclude: { unbekannt: [{ name: 'urls' }] },
        aendern: {
          status: 200,
          versionDifferenz: 'eins',
          nachAenderung: [
            {
              name: 'urls',
              ergebnis: 'anders',
              felder: [
                { name: 'self', ergebnis: 'gleich' },
                { name: 'ical', ergebnis: 'gleich' },
                { name: 'title', ergebnis: 'anders', folgtTitel: 'ja' },
              ],
            },
          ],
        },
        loeschen: { danachLesen: 404 },
      },
      aufraeumen: { seite: 'keine', termin: 'keine' },
      rechteUnveraendert: 'ja',
    });
    expect(instance.appointments.size).toBe(0);
    const pages = readWriteState(
      setting.writeStateFile,
      writeOrigin,
      setting.writeCategory,
    );
    expect(pages.pages.map((page) => page.role)).toEqual(['form']);
    expect(
      readCalendarState(calendarState, writeOrigin, setting.calendarArea)
        .appointments,
    ).toEqual([]);
  });

  it('says when a change loses the key and when ChurchTools stores the text as sent', async () => {
    const { setting, instance, env } = await prepared({
      normalizeOnCreate: (text) => text,
      normalizeOnUpdate: (text) => text,
      calendar: { undocumentedField: { name: 'urls', droppedByPut: true } },
    });
    const run = await runReadback(instance, env, confirming(instance));
    expect(run.code, run.output.stderr()).toBe(exitCodes.ok);
    expect(leaks(run.output, setting.forbidden)).toEqual([]);
    expect(run.result).toMatchObject({
      wiki: {
        anlegen: { zurueckgelesen: 'wie gesendet' },
        regel: 'keine der beiden',
      },
      termin: {
        aendern: {
          nachAenderung: [{ name: 'urls', ergebnis: 'fehlt', felder: [] }],
          regelnDesServers: { unbekanntImTermin: 'nein', verknuepft: 'nein' },
        },
      },
    });
  });

  it('names an appointment without unknown keys as not linked', async () => {
    const { instance, env } = await prepared();
    const run = await runReadback(instance, env, confirming(instance));
    expect(run.code, run.output.stderr()).toBe(exitCodes.ok);
    expect(run.result).toMatchObject({
      termin: {
        lesen: {
          unbekannt: [],
          regelnDesServers: { unbekanntImTermin: 'nein', verknuepft: 'nein' },
        },
        aendern: { nachAenderung: [] },
      },
    });
  });

  it('withholds a name the block list holds, and still prints the rest', async () => {
    // A part of the host of the synthetic instance.
    const { setting, instance, env } = await prepared({
      calendar: { undocumentedField: { name: 'example' } },
    });
    const run = await runReadback(instance, env, confirming(instance));
    expect(run.code, run.output.stderr()).toBe(exitCodes.ok);
    expect(leaks(run.output, setting.forbidden)).toEqual([]);
    expect(run.result).toMatchObject({
      termin: {
        lesen: {
          unbekannt: [
            {
              name: 'zurückgehalten',
              felder: [{ name: 'self' }, { name: 'ical' }, { name: 'title' }],
            },
          ],
        },
      },
    });
  });

  it('deletes the page and the appointment after an error that follows a write', async () => {
    // First a run without error, to find the call of the change.
    const first = await prepared({
      calendar: { undocumentedField: { name: 'urls' } },
    });
    expect(
      (await runReadback(first.instance, first.env, confirming(first.instance)))
        .code,
    ).toBe(exitCodes.ok);
    const put =
      first.instance.calls.findIndex((call) => call.method === 'PUT') + 1;
    const { setting, instance, env, calendarState } = await prepared({
      failOnCall: put,
      calendar: { undocumentedField: { name: 'urls' } },
    });
    const run = await runReadback(instance, env, confirming(instance));
    expect(run.code).not.toBe(exitCodes.ok);
    expect(run.output.stderr()).toContain(hints.zuruecklesenAbgebrochen);
    expect(leaks(run.output, setting.forbidden)).toEqual([]);
    expect(instance.appointments.size).toBe(0);
    expect(
      [...instance.pages.values()].filter((page) => page !== instance.autoPage),
    ).toEqual([]);
    expect(
      readCalendarState(calendarState, writeOrigin, setting.calendarArea)
        .appointments,
    ).toEqual([]);
  });

  it.each<[string, Readonly<Record<string, string | undefined>>, string]>([
    [
      'without calendar and resource',
      {
        ECCLIUM_SPIKE_WRITE_CALENDAR_ID: '',
        ECCLIUM_SPIKE_WRITE_RESOURCE_ID: '',
      },
      'zuruecklesenOhneBereich',
    ],
    [
      'without the calendar state file',
      { ECCLIUM_SPIKE_WRITE_CALENDAR_STATE_FILE: '' },
      'zuruecklesenKalenderStateFehlt',
    ],
  ])('refuses %s before anything is written', async (_name, change, hint) => {
    const { instance, env } = await prepared();
    const run = await runReadback(
      instance,
      { ...env, ...change },
      confirming(instance),
    );
    expect(run.code).not.toBe(exitCodes.ok);
    expect(run.output.stderr()).toContain(hints[hint as keyof typeof hints]);
    expect(writes(instance)).toEqual([]);
  });

  it('refuses one file for both write states before anything is written', async () => {
    const { setting, instance, env } = await prepared();
    const run = await runReadback(
      instance,
      {
        ...env,
        ECCLIUM_SPIKE_WRITE_CALENDAR_STATE_FILE: setting.writeStateFile,
      },
      confirming(instance),
    );
    expect(run.code).not.toBe(exitCodes.ok);
    expect(run.output.stderr()).toContain(hints.zuruecklesenStateGleich);
    expect(writes(instance)).toEqual([]);
  });

  it('writes nothing without «ja»', async () => {
    const { instance, env } = await prepared();
    const run = await runReadback(instance, env, {
      isTerminal: true,
      readLine: () => Promise.resolve('nein'),
    });
    expect(run.code).not.toBe(exitCodes.ok);
    expect(writes(instance)).toEqual([]);
  });
});

describe('the comparison of texts', () => {
  it('tells a text read back as sent, trimmed, with LF, or different', () => {
    expect(compareStored('Text', 'Text')).toEqual({
      zurueckgelesen: 'wie gesendet',
      entferntAnfang: [],
      entferntEnde: [],
    });
    expect(compareStored('\n Text \n', 'Text')).toEqual({
      zurueckgelesen: 'ohne Leerraum an den Enden',
      entferntAnfang: ['Zeilenumbruch', 'Leerzeichen'],
      entferntEnde: ['Leerzeichen', 'Zeilenumbruch'],
    });
    expect(compareStored('a\r\nb\r\n', 'a\nb')).toEqual({
      zurueckgelesen: 'Zeilenenden zu LF, ohne Leerraum an den Enden',
      entferntAnfang: [],
      entferntEnde: ['Zeilenumbruch'],
    });
    expect(compareStored('Text', 'Texte\r\nmehr')).toEqual({
      zurueckgelesen: 'anders',
      laengeDifferenz: '2–9',
      zeilenenden: 'CRLF',
    });
    // A word inside that is gone is a change, not white space.
    expect(compareStored('a b', 'ab').zurueckgelesen).toBe('anders');
    expect(compareStored('Text', undefined)).toEqual({
      zurueckgelesen: 'unbekannt',
    });
    // An empty text read back, from blank or from a text.
    expect(compareStored(' \n', '').zurueckgelesen).toBe(
      'ohne Leerraum an den Enden',
    );
    expect(compareStored('Text', null).zurueckgelesen).toBe('anders');
  });

  it('names the classes of the removed characters once each', () => {
    expect(classesOf(`\t${verticalTab}\f${nbsp}${ideographic}\r x`)).toEqual([
      'Tabulator',
      'vertikaler Tabulator',
      'Seitenvorschub',
      'geschütztes Leerzeichen',
      'ideografisches Leerzeichen',
      'Wagenrücklauf',
      'Leerzeichen',
      'anderes Zeichen',
    ]);
  });

  it('trims as PHP does, and tells the rule from what was read back', () => {
    expect(trimLikePhp(`\n Text${nbsp}\t\n`)).toBe(`Text${nbsp}`);
    expect(trimLikePhp(` ${verticalTab}`)).toBe('');
    const sent = [`a\n`, `b${nbsp}`, `c${ideographic}`];
    expect(
      ruleOf(sent.map((text) => ({ sent: text, stored: trimLikePhp(text) }))),
    ).toBe('wie trim in PHP');
    expect(
      ruleOf(sent.map((text) => ({ sent: text, stored: text.trim() }))),
    ).toBe('wie trim in JavaScript');
    expect(ruleOf(sent.map((text) => ({ sent: text, stored: text })))).toBe(
      'keine der beiden',
    );
    expect(ruleOf([{ sent: 'a', stored: undefined }])).toBe('unbekannt');
    expect(ruleOf([])).toBe('unbekannt');
  });

  it('writes the texts in the form of the server, each case different', () => {
    const day = '2026-11-07';
    const text = coreFormText(day, 'Fall 0');
    expect(text.endsWith('Rückfragen an Sekretariat.')).toBe(true);
    expect(text).toContain('Automatisch erstellt am 07.11.2026 durch Ecclium');
    expect(caseText(day, createCase, 0)).toBe(`${text}\n`);
    const texts = wikiCases.map((wikiCase, index) =>
      caseText(day, wikiCase, index + 1),
    );
    expect(new Set(texts.map(trimLikePhp)).size).toBe(wikiCases.length);
    expect(texts.at(-1)).toContain('\r\n');
  });

  it('writes fifteen days ahead, from noon to one in UTC', () => {
    expect(readbackTimes(new Date('2026-12-20T23:59:00Z'))).toEqual({
      day: '2027-01-04',
      start: '2027-01-04T12:00:00Z',
      end: '2027-01-04T13:00:00Z',
    });
  });
});

describe('the rules of the server for a read of an appointment', () => {
  const appointment = {
    id: 12,
    title: 'Probe',
    repeatId: 0,
    additionals: [],
    exceptions: [],
    address: null,
    onBehalfOfPid: null,
  };

  it('finds keys beside, in and below the appointment that the server does not know', () => {
    const found = unknownKeys({
      appointment: { ...appointment, urls: { self: 'x' } },
      additionalInfos: [],
      calculatedDates: [
        { startDate: 'a', endDate: 'b', bookings: [] },
        { startDate: 'c', endDate: 'd', bookings: [{ id: 3 }] },
      ],
      extra: 1,
    });
    expect(found.map((entry) => [entry.place, entry.key])).toEqual([
      ['neben dem Termin', 'extra'],
      ['im Termin', 'urls'],
      ['in einem Datum', 'bookings'],
    ]);
  });

  it('counts a link under an unknown key, in a date or in the infos, and other parts', () => {
    expect(serverRules({ appointment, calculatedDates: {} })).toEqual({
      zusatzinfos: 'nein',
      datumMitVerweis: 'nein',
      unbekanntNebenTermin: 'nein',
      unbekanntImTermin: 'nein',
      weitereTeile: [],
      verknuepft: 'nein',
    });
    expect(
      serverRules({
        appointment: { ...appointment, urls: { self: 'x' } },
        additionalInfos: { a: 'b' },
        calculatedDates: { one: { startDate: 'a', event: { id: 1 } } },
        beside: ['x'],
      }),
    ).toMatchObject({
      zusatzinfos: 'ja',
      datumMitVerweis: 'ja',
      unbekanntNebenTermin: 'ja',
      unbekanntImTermin: 'ja',
      verknuepft: 'ja',
    });
    // The legacy field mappings of the server pass (F52), but not under
    // another key, nor with a key that names no field of the appointment.
    const mappings = { caption: 'Titel', note: 'Notiz' };
    expect(
      serverRules({
        appointment: { ...appointment, '@deprecated': mappings },
      }),
    ).toMatchObject({ unbekanntImTermin: 'nein', verknuepft: 'nein' });
    for (const inside of [
      { legacy: mappings },
      { '@deprecated': { ...mappings, eventUrl: 'x' } },
      { '@deprecated': { caption: { id: 1 } } },
    ]) {
      expect(
        serverRules({ appointment: { ...appointment, ...inside } }),
      ).toMatchObject({ unbekanntImTermin: 'ja', verknuepft: 'ja' });
    }
    // Empty values link nothing; plain text beside the date is no link.
    expect(
      serverRules({
        appointment: { ...appointment, urls: { self: ' ' }, note: 'x' },
        additionalInfos: [],
        calculatedDates: [{ startDate: 'a', iCalUid: 'x' }],
      }),
    ).toMatchObject({ unbekanntImTermin: 'nein', verknuepft: 'nein' });
    expect(
      serverRules({
        appointment: {
          ...appointment,
          repeatId: 1,
          address: { street: 'x' },
          link: 'x',
          image: { id: 1 },
          signup: { id: 1 },
          onBehalfOfPid: 4,
        },
      }),
    ).toMatchObject({
      weitereTeile: [
        'Serie',
        'Adresse',
        'Link',
        'Bild',
        'Anmeldung',
        'im Auftrag',
      ],
      verknuepft: 'ja',
    });
  });

  it('describes a text by its form, never by its value', () => {
    const context = {
      origin: 'https://demo-tenant.example',
      appointment: { ...appointment, caption: 'Probe' },
      id: 12,
    };
    expect(
      textForm('https://demo-tenant.example/api/appointments/12', context),
    ).toEqual({
      form: 'Adresse dieser Instanz',
      gleichWie: 'keine',
      nenntKennung: 'ja',
    });
    expect(textForm('https://other.example/x/120', context)).toMatchObject({
      form: 'Adresse',
      nenntKennung: 'nein',
    });
    expect(textForm('/api/x', context)).toMatchObject({ form: 'Pfad' });
    expect(textForm('Probe', context)).toMatchObject({
      form: 'Text',
      gleichWie: 'caption',
    });
    expect(textForm('', context)).toEqual({ form: 'leer' });
  });
});
