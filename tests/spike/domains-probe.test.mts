// Runs probe 09 against a synthetic instance whose answers carry the
// synthetic calendar, appointments, event, services, resources and songs,
// foreign canary objects and persons. The probe must print how the API
// behaves and none of the values: no name, ID, date or search term. Its
// guard must let the read rights on the domains through and nothing more,
// while the guard of probe 08 stays as narrow as before.
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  labelsForDomainType,
  pagingSteps,
  probe,
  timeWindow,
  unknownId,
  windowDays,
  type DomainLabel,
} from '../../scripts/spike/09-domains-read.mts';
import { probe as personsProbe } from '../../scripts/spike/08-persons-groups-read.mts';
import { createState } from '../../scripts/spike/lib/env.mts';
import { SpikeError, hints } from '../../scripts/spike/lib/errors.mts';
import { Guard } from '../../scripts/spike/lib/guard.mts';
import {
  createClient,
  createPersonsClient,
  isPersonalPath,
  type FetchFunction,
} from '../../scripts/spike/lib/http.mts';
import { exitCodes } from '../../scripts/spike/lib/output.mts';
import {
  domainReadRights,
  personsRightsWithin,
} from '../../scripts/spike/lib/persons-gate.mts';
import { runProbe } from '../../scripts/spike/lib/probe.mts';
import { capture, leaks, type Capture } from './support.mts';
import {
  domainRights,
  domainsInstance,
  domainsSetup,
  type DomainsCall,
  type DomainsInstanceOptions,
  type DomainsSetting,
} from './domains-support.mts';
import {
  narrowRights,
  personsInstance,
  personsOrigin,
  personsSetup,
  personsState,
} from './persons-support.mts';

const spikeFolder = fileURLToPath(
  new URL('../../scripts/spike/', import.meta.url),
);

const gatePaths = ['/api/wiki/categories', '/api/permissions/global'];

// Forms of values the instance makes up: GUIDs and dates.
const valueForms = [
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  /\d{4}-\d{2}-\d{2}/,
];

interface Run {
  readonly code: number;
  readonly result: Record<string, unknown>;
  readonly calls: readonly DomainsCall[];
  readonly output: Capture;
  readonly setting: DomainsSetting;
}

/**
 * Checks what holds for every run: no value of the instance or of the run
 * in the output, only GET with the token in its header, and no search term
 * but the two fixed ones.
 */
function expectNothingBeyond(
  setting: DomainsSetting,
  instance: {
    readonly calls: readonly DomainsCall[];
    readonly generated: readonly string[];
  },
  output: Capture,
): void {
  expect(leaks(output, [...setting.forbidden, ...instance.generated])).toEqual(
    [],
  );
  for (const form of valueForms) {
    expect(output.stdout()).not.toMatch(form);
  }
  for (const call of instance.calls) {
    expect(call.method).toBe('GET');
    expect(call.url.origin).toBe(personsOrigin);
    expect(call.authorization).toBe(`Login ${setting.canaries.token}`);
    for (const value of call.url.searchParams.getAll('query')) {
      expect(['Spikeprobe', 'Synthetisch']).toContain(value);
    }
  }
}

async function run(
  make:
    | DomainsInstanceOptions
    | ((setting: DomainsSetting) => DomainsInstanceOptions) = {},
  document?: unknown,
  changes: Readonly<Record<string, string | undefined>> = {},
  shared: readonly (readonly [DomainLabel, DomainLabel])[] = [],
): Promise<Run> {
  const setting = domainsSetup(shared);
  const options = typeof make === 'function' ? make(setting) : make;
  createState(setting.stateFile, personsState(document));
  const instance = domainsInstance(setting, {
    ...options,
    ...(document === undefined ? {} : { document }),
  });
  const output = capture();
  const code = await runProbe(probe, {
    env: { ...setting.env, ...changes },
    fetch: instance.fetch,
    io: output.io,
    folder: spikeFolder,
  });
  expectNothingBeyond(setting, instance, output);
  const result =
    code === exitCodes.ok
      ? (JSON.parse(output.stdout()) as Record<string, unknown>)
      : {};
  return { code, result, calls: instance.calls, output, setting };
}

const section = (
  result: Record<string, unknown>,
  key: string,
): Record<string, unknown> => result[key] as Record<string, unknown>;

const seen = (
  result: Record<string, unknown>,
  target: string,
): Record<string, unknown> => section(section(result, 'sichtbar'), target);

const withoutPaths = (...paths: readonly string[]): unknown => {
  const document = structuredClone(personsState().specification) as {
    paths: Record<string, unknown>;
  };
  return {
    ...document,
    paths: Object.fromEntries(
      Object.entries(document.paths).filter(([path]) => !paths.includes(path)),
    ),
  };
};

describe('probe 09', () => {
  it('reads the domains behind its guard and prints none of the values', async () => {
    const { code, result, calls } = await run();
    expect(code).toBe(exitCodes.ok);
    expect(result['probe']).toBe('09-domains-read');
    expect(result['waechter']).toBe('bestanden');
    expect(calls.slice(0, 2).map((call) => call.url.pathname)).toEqual(
      gatePaths,
    );
    const ergebnisse = section(result, 'ergebnisse');
    for (const target of [
      'calendars',
      'calendarAppointments',
      'calendarAppointment:t1',
      'calendarAppointment:t2',
      'events',
      'event:e1',
      'eventAgenda:e1',
      'eventAgendaSongs:e1',
      'services',
      'serviceGroups',
      'resourceTypes',
      'resources',
      'bookings',
      'songs',
      'song:l1',
      'song:l2',
      'songArrangements:l1',
      'songArrangements:l2',
      'wikiSearch',
      'search:d3',
    ]) {
      expect(ergebnisse[target]).toBe('erlaubt mit Einträgen');
    }
    expect(ergebnisse['search:d1']).toBe('erlaubt leer');
    const rechte = JSON.stringify(result['rechte']);
    for (const right of ['churchservice', 'view agenda', 'churchresource']) {
      expect(rechte).toContain(right);
    }
  });

  it('tells which synthetic objects an answer shows, from their IDs alone', async () => {
    const { result } = await run({ hidden: ['s2', 't1'] });
    expect(seen(result, 'calendars')).toEqual({ c1: 'ja' });
    expect(seen(result, 'calendarAppointments')).toEqual({
      c1: 'ja',
      t1: 'nein',
      t2: 'ja',
    });
    expect(seen(result, 'services')).toEqual({ s1: 'ja', s2: 'nein' });
    expect(seen(result, 'serviceGroups')).toEqual({ sg1: 'ja' });
    expect(seen(result, 'resources')).toEqual({ rt1: 'nein', r1: 'ja' });
    expect(seen(result, 'bookings')).toEqual({ r1: 'ja' });
    expect(seen(result, 'event:e1')).toEqual({ e1: 'ja' });
    expect(seen(result, 'eventAgendaSongs:e1')).toEqual({
      l1: 'ja',
      l2: 'nein',
    });
    expect(seen(result, 'songs')).toEqual({ sc1: 'ja', l1: 'ja', l2: 'ja' });
    expect(seen(result, 'song:l2')).toEqual({
      sc1: 'ja',
      l1: 'nein',
      l2: 'ja',
    });
    // The weekly appointment appears on each week of the window.
    expect(
      section(section(result, 'vorkommen'), 'calendarAppointments'),
    ).toEqual({ c1: '2–9', t1: '0', t2: '2–9' });
    expect(section(result, 'ergebnisse')['calendarAppointment:t1']).toBe(
      'nicht gefunden',
    );
  });

  it('tells where p1 and other persons appear', async () => {
    const { result } = await run();
    const personP1 = section(result, 'personP1');
    const personen = section(result, 'personen');
    expect(personP1['event:e1']).toBe('ja');
    expect(personen['event:e1']).toBe('2–9');
    expect(personP1['bookings']).toBe('ja');
    expect(personen['bookings']).toBe('1');
    expect(personP1['eventAgenda:e1']).toBe('ja');
    expect(personP1['services']).toBe('nein');
    expect(personen['services']).toBe('0');
    // The songs name only the person who changed them last, p2.
    expect(personP1['songs']).toBe('nein');
    expect(personen['songs']).toBe('2–9');
  });

  it('reports «unbekannt» where an answer is refused', async () => {
    const { result } = await run({ denied: ['services', 'event'] });
    expect(section(result, 'ergebnisse')['services']).toBe('verweigert');
    expect(seen(result, 'services')).toEqual({
      s1: 'unbekannt',
      s2: 'unbekannt',
    });
    expect(section(result, 'personP1')['event:e1']).toBe('unbekannt');
    expect(section(result, 'fehler')['services 403']).toMatchObject({
      antwort: { status: 403 },
      fehlerschluessel: { message: 'ja' },
    });
  });

  it('describes the answers with the features of dates', async () => {
    const { result } = await run();
    const strukturen = section(result, 'strukturen');
    const events = JSON.stringify(strukturen['events']);
    expect(events).toContain('"format":"Datum mit Zeit"');
    expect(events).toContain('eventServices');
    expect(JSON.stringify(strukturen['calendarAppointments'])).toContain(
      '"zone":"Z"',
    );
    expect(section(result, 'meta')['events']).toEqual({
      count: 'ja',
      all: 'nein',
      pagination: 'ja',
    });
    expect(section(result, 'meta')['calendars']).toEqual({
      count: 'ja',
      all: 'nein',
      pagination: 'nein',
    });
  });

  it('pages events and songs with exactly the fixed values of page and limit', async () => {
    const { result, calls, setting } = await run();
    const { from, to } = timeWindow(new Date());
    const sent = (path: string): string[] =>
      calls
        .filter(
          (call) =>
            call.url.pathname === path &&
            (call.url.searchParams.has('page') ||
              call.url.searchParams.has('limit')),
        )
        .map((call) => call.url.search);
    const steps = pagingSteps.map(([page, limit]) =>
      [
        ...(page === undefined ? [] : [`page=${String(page)}`]),
        `limit=${String(limit)}`,
      ].join('&'),
    );
    expect(sent('/api/events')).toEqual(
      steps.map((step) => `?from=${from}&to=${to}&${step}`),
    );
    expect(sent('/api/songs')).toEqual(
      steps.map(
        (step) =>
          `?${encodeURIComponent('song_category_ids[]')}=${String(setting.ids.sc1)}&${step}`,
      ),
    );
    const events = section(section(result, 'listen'), 'events');
    expect(events['meta']).toEqual({
      count: 'ja',
      all: 'nein',
      pagination: 'ja',
    });
    expect(events['anfragen']).toEqual([
      { seite: 1, limit: 1, status: 200, eintraege: '1', limitEcho: 1 },
      { seite: 2, limit: 1, status: 200, eintraege: '1', limitEcho: 1 },
      {
        seite: 'nicht gesendet',
        limit: 100,
        status: 200,
        eintraege: '2–9',
        limitEcho: 100,
      },
      {
        seite: 'nicht gesendet',
        limit: 1000,
        status: 400,
        eintraege: 'keine Liste',
        limitEcho: 'kein Echo',
      },
    ]);
    expect(section(result, 'fehler')['events 400']).toMatchObject({
      fehlerschluessel: { message: 'ja', args: 'ja' },
    });
  });

  it('tells a cut limit by its echo', async () => {
    const { result } = await run({ echoCap: 50 });
    const songs = section(section(result, 'listen'), 'songs');
    expect((songs['anfragen'] as Record<string, unknown>[])[2]).toEqual({
      seite: 'nicht gesendet',
      limit: 100,
      status: 200,
      eintraege: '2–9',
      limitEcho: 50,
    });
  });

  it('asks for six weeks from today, and names neither date', async () => {
    const { calls } = await run();
    const { from, to } = timeWindow(new Date());
    expect(Date.parse(to) - Date.parse(from)).toBe(windowDays * 86_400_000);
    for (const path of [
      '/api/events',
      '/api/calendars/appointments',
      '/api/bookings',
    ]) {
      const first = calls.find((call) => call.url.pathname === path);
      expect(first?.url.searchParams.get('from')).toBe(from);
      expect(first?.url.searchParams.get('to')).toBe(to);
    }
  });

  it('describes how unknown IDs fail, and reads nothing of one that exists', async () => {
    const plain = await run();
    const unbekannt = section(plain.result, 'unbekannt');
    for (const name of ['event', 'song', 'calendarAppointment']) {
      expect(unbekannt[name]).toMatchObject({
        antwort: { status: 404, format: 'JSON', struktur: { typ: 'Objekt' } },
        fehlerschluessel: {
          message: 'ja',
          translatedMessage: 'nein',
          weitereSchluessel: '0',
        },
      });
    }
    expect(section(plain.result, 'ergebnisse')['event:unbekannt']).toBe(
      'nicht gefunden',
    );
    const unknownPaths = plain.calls
      .map((call) => call.url.pathname)
      .filter((path) => path.endsWith(`/${String(unknownId)}`));
    expect(unknownPaths).toEqual([
      `/api/events/${String(unknownId)}`,
      `/api/songs/${String(unknownId)}`,
      `/api/calendars/${String(plain.setting.ids.c1)}/appointments/${String(unknownId)}`,
    ]);
    const exists = await run({ unknownExists: true });
    expect(section(exists.result, 'ergebnisse')).toMatchObject({
      'event:unbekannt': 'unbekannte ID vorhanden',
      'song:unbekannt': 'unbekannte ID vorhanden',
      'calendarAppointment:unbekannt': 'unbekannte ID vorhanden',
    });
    expect(section(exists.result, 'unbekannt')).toEqual({});
  });

  it('searches the wiki with the marker in the identification category only', async () => {
    const { result, calls, setting } = await run();
    const wiki = calls.filter(
      (call) => call.url.pathname === '/api/wiki/search',
    );
    expect(wiki).toHaveLength(1);
    expect(wiki[0]?.url.searchParams.get('query')).toBe('Spikeprobe');
    expect(wiki[0]?.url.searchParams.getAll('wiki_category_ids[]')).toEqual([
      String(setting.identification),
    ]);
    expect(section(result, 'personen')['wikiSearch']).toBe('0');
  });

  it('searches once per domain type the document declares, and names each by a label', async () => {
    const { result, calls } = await run();
    expect(result['domaenentypen']).toEqual({
      d1: 'person',
      d2: 'group',
      d3: 'song',
    });
    const searches = calls.filter(
      (call) => call.url.pathname === '/api/search',
    );
    expect(
      searches.map((call) => call.url.searchParams.getAll('domain_types[]')),
    ).toEqual([['person'], ['group'], ['song']]);
    for (const call of searches) {
      expect(call.url.searchParams.get('query')).toBe('Synthetisch');
    }
  });

  it('matches a hit of the global search by domainIdentifier, only for the kind of the searched type', async () => {
    // The song l1 and the event e1 share one ID, as IDs of different kinds
    // do on a test instance.
    const { result, setting } = await run({ hidden: ['l2'] }, undefined, {}, [
      ['l1', 'e1'],
    ]);
    expect(setting.ids.l1).toBe(setting.ids.e1);
    expect(section(result, 'domaenentypen')['d3']).toBe('song');
    expect(seen(result, 'search:d3')).toEqual({ l1: 'ja', l2: 'nein' });
    expect(section(result, 'treffer')['search:d3']).toBe('1');
    // Every other operation still matches by id.
    expect(seen(result, 'event:e1')).toEqual({ e1: 'ja' });
  });

  it('checks no object for a searched type without a kind, and tells only the class of its hits', async () => {
    const { result } = await run();
    const sichtbar = section(result, 'sichtbar');
    expect(sichtbar['search:d1']).toBeUndefined();
    expect(sichtbar['search:d2']).toBeUndefined();
    expect(section(result, 'treffer')).toEqual({
      wikiSearch: '1',
      'search:d1': '0',
      'search:d2': '0',
      'search:d3': '2–9',
    });
  });

  it.each([
    ['song', ['l1', 'l2']],
    ['appointment', ['t1', 't2']],
    ['event', ['e1']],
    ['calendar', ['c1']],
    ['resource', ['r1']],
    ['service', ['s1', 's2']],
    ['service_group', ['sg1', 's1', 's2']],
    ['person', []],
    ['group', []],
    ['wiki_page', []],
  ])('lets the domain type %s check %j', (type, labels) => {
    expect(labelsForDomainType(type)).toEqual(labels);
  });

  it('searches once without domain types where the document declares no enumeration', async () => {
    const document = structuredClone(personsState().specification) as {
      paths: Record<
        string,
        Record<string, { parameters: Record<string, unknown>[] }>
      >;
    };
    const parameter = document.paths['/search']?.['get']?.parameters.find(
      (item) => item['name'] === 'domain_types[]',
    );
    if (parameter === undefined) {
      throw new Error('synthetic document changed');
    }
    parameter['schema'] = { type: 'array', items: { type: 'string' } };
    const { result, calls } = await run({}, document);
    expect(result['domaenentypen']).toBe('keine Aufzählung');
    const searches = calls.filter(
      (call) => call.url.pathname === '/api/search',
    );
    expect(searches).toHaveLength(1);
    expect(searches[0]?.url.searchParams.has('domain_types[]')).toBe(false);
    expect(section(result, 'ergebnisse')['search']).toBe(
      'erlaubt mit Einträgen',
    );
  });

  it('reports operations the instance does not document and calls nothing for them', async () => {
    const { code, result, calls } = await run(
      {},
      withoutPaths('/songs', '/wiki/search'),
    );
    expect(code).toBe(exitCodes.ok);
    expect(section(result, 'operationen')).toMatchObject({
      songs: 'nicht dokumentiert',
      wikiSearch: 'nicht dokumentiert',
      song: 'dokumentiert',
    });
    expect(section(result, 'ergebnisse')).toMatchObject({
      songs: 'nicht dokumentiert',
      wikiSearch: 'nicht dokumentiert',
    });
    expect(section(result, 'listen')['songs']).toBe('nicht dokumentiert');
    expect(
      calls.filter((call) =>
        ['/api/songs', '/api/wiki/search'].includes(call.url.pathname),
      ),
    ).toEqual([]);
  });

  it('leaves out a call whose required parameter the instance does not declare', async () => {
    const document = structuredClone(personsState().specification) as {
      paths: Record<
        string,
        Record<string, { parameters: Record<string, unknown>[] }>
      >;
    };
    const bookings = document.paths['/bookings']?.['get'];
    if (bookings === undefined) {
      throw new Error('synthetic document changed');
    }
    bookings.parameters = bookings.parameters.filter(
      (item) => item['name'] !== 'resource_ids[]',
    );
    const { result, calls } = await run({}, document);
    expect(section(result, 'ergebnisse')['bookings']).toBe('nicht deklariert');
    expect(
      calls.filter((call) => call.url.pathname === '/api/bookings'),
    ).toEqual([]);
  });

  it('names the known parameters and counts the others', async () => {
    const { result } = await run();
    const events = section(section(result, 'parameter'), 'events');
    expect(
      (events['benannt'] as Record<string, unknown>[]).map(
        (item) => item['name'],
      ),
    ).toEqual([
      'from',
      'to',
      'canceled',
      'direction',
      'include',
      'page',
      'limit',
    ]);
    expect(events['weitere']).toBe('0');
  });

  it('stops before any request without the ID of a synthetic object', async () => {
    const { code, calls, output } = await run({}, undefined, {
      ECCLIUM_SPIKE_EVENT_ID: undefined,
    });
    expect(code).toBe(exitCodes.configuration);
    expect(output.stderr()).toContain(hints.eventIdFehlt);
    expect(calls).toEqual([]);
  });

  it('stops before any request where two songs share one ID', async () => {
    const { code, calls, output } = await run({}, undefined, {
      ECCLIUM_SPIKE_OTHER_SONG_ID: '91234',
      ECCLIUM_SPIKE_SONG_ID: '91234',
    });
    expect(code).toBe(exitCodes.configuration);
    expect(output.stderr()).toContain(hints.bereichsIdsGleich);
    expect(calls).toEqual([]);
  });
});

describe('the guard of probe 09', () => {
  it('accepts every read right on the domains, with any value', async () => {
    const { code, result } = await run((setting) => ({
      rights: domainRights(setting, {
        churchservice: { 'view agenda': true, 'view songcategory': [-1] },
        churchresource: { 'view resource': ['alle'] },
      }),
    }));
    expect(code).toBe(exitCodes.ok);
    expect(JSON.stringify(result['rechte'])).toContain('view songcategory');
  });

  it.each([
    ['churchservice', 'edit events'],
    ['churchservice', 'edit agenda'],
    ['churchcal', 'edit category'],
    ['churchresource', 'administer bookings'],
    ['churchwiki', 'edit category'],
    ['churchcore', 'administer settings'],
  ])('refuses %s: %s and reads nothing behind it', async (module, right) => {
    const { code, calls, output } = await run((setting) => ({
      rights: domainRights(setting, { [module]: { [right]: [1] } }),
    }));
    expect(code).toBe(exitCodes.configuration);
    expect(output.stderr()).toContain(hints.personenZuWeitBerechtigt);
    expect(calls.map((call) => call.url.pathname)).toEqual(gatePaths);
  });

  it('keeps the guard of probe 08 as narrow as before', async () => {
    const setting = personsSetup();
    const wide = {
      ...narrowRights(setting.identification),
      churchservice: { view: true },
    };
    expect(personsRightsWithin(wide, setting.identification)).toBe(false);
    expect(
      personsRightsWithin(wide, setting.identification, domainReadRights),
    ).toBe(true);
    createState(setting.stateFile, personsState());
    const instance = personsInstance(setting, { rights: wide });
    const output = capture();
    const code = await runProbe(personsProbe, {
      env: setting.env,
      fetch: instance.fetch,
      io: output.io,
      folder: spikeFolder,
    });
    expect(code).toBe(exitCodes.configuration);
    expect(output.stderr()).toContain(hints.personenZuWeitBerechtigt);
    expect(instance.calls.map((call) => call.url.pathname)).toEqual(gatePaths);
  });

  it('never lets the read rights of a probe open the wiki', () => {
    const identification = 4242;
    const rights = {
      ...narrowRights(identification),
      churchwiki: {
        view: true,
        'view category': [identification],
        'edit category': [identification],
      },
    };
    expect(
      personsRightsWithin(rights, identification, {
        ...domainReadRights,
        churchwiki: ['edit category'],
      }),
    ).toBe(false);
    expect(
      personsRightsWithin(
        { ...narrowRights(identification), constructor: { view: true } },
        identification,
        domainReadRights,
      ),
    ).toBe(false);
  });
});

describe('the paths of the domains', () => {
  const setting = personsSetup();
  const options = (instance: { readonly fetch: FetchFunction }) => ({
    origin: personsOrigin,
    token: setting.canaries.token,
    guard: new Guard(),
    fetch: instance.fetch,
  });
  const personal = [
    '/api/events',
    '/api/events/7',
    '/api/events/7/agenda',
    '/api/events/7/agenda/songs',
    '/api/services',
    '/api/bookings',
    '/api/songs',
    '/api/songs/7/arrangements',
    '/api/wiki/search',
    '/api/calendars/appointments',
    '/api/calendars/7/appointments',
    '/api/calendars/7/appointments/8',
    '/API/Calendars//7/Appointments',
    '/api/calendars/7/appointments.json',
  ];
  const general = [
    '/api/calendars',
    '/api/calendars/7',
    '/api/servicegroups',
    '/api/resourcetypes',
    '/api/resources',
    '/api/wiki/pages',
    '/api/wiki/searchx',
    '/api/eventsx',
    '/api/calendars/7/appointmentsx',
  ];

  it.each(personal)('count %s as personal', (path) => {
    expect(isPersonalPath(path)).toBe(true);
  });

  it.each(general)('do not count %s', (path) => {
    expect(isPersonalPath(path)).toBe(false);
  });

  it('are refused by the general client before any request, and reached by the client for personal data', async () => {
    const instance = personsInstance(setting);
    const client = createClient(options(instance));
    for (const path of personal) {
      let code = 'no error';
      try {
        await client.get({ path });
      } catch (error) {
        code = error instanceof SpikeError ? error.code : 'no SpikeError';
      }
      expect(code).toBe('INTERN');
    }
    expect(instance.calls).toEqual([]);
    for (const path of ['/api/calendars', '/api/servicegroups']) {
      await client.get({ path });
    }
    const reader = createPersonsClient(options(instance));
    await reader.get({ path: '/api/events' });
    expect(instance.calls.map((call) => call.url.pathname)).toEqual([
      '/api/calendars',
      '/api/servicegroups',
      '/api/events',
    ]);
  });
});
