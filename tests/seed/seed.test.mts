// Tests of the seed of the test instance against a synthetic instance.
// No test reaches a network: the instance lives in memory (support.mts).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runSeed } from '../../scripts/seed/lib/course.mts';
import { pages } from '../../scripts/seed/lib/data.mts';
import { anchorSaturday } from '../../scripts/seed/lib/dates.mts';
import { hints, type HintKey } from '../../scripts/spike/lib/errors.mts';
import { Guard } from '../../scripts/spike/lib/guard.mts';
import {
  createSeedClient,
  createWriteClient,
} from '../../scripts/spike/lib/http.mts';
import { exitCodes } from '../../scripts/spike/lib/output.mts';
import { seedRightsWithin } from '../../scripts/spike/lib/seed-gate.mts';
import { capture, forbiddenTexts, leaks } from '../spike/support.mts';
import {
  accountId,
  departmentId,
  seedAccountRights,
  seedOrigin,
  seedSetup,
  type InstanceOptions,
  type SeedSetting,
} from './support.mts';

const now = new Date('2026-10-27T20:00:00Z');

interface SeedResult {
  readonly code: number;
  readonly output: ReturnType<typeof capture>;
  readonly result: Record<string, unknown>;
  readonly waits: number;
}

async function run(
  setting: SeedSetting,
  command: string,
  options: { readonly answer?: string; readonly terminal?: boolean } = {},
): Promise<SeedResult> {
  const output = capture();
  let waits = 0;
  const code = await runSeed({
    args: [command],
    env: setting.env,
    fetch: setting.instance.fetch,
    io: output.io,
    scriptsFolder: setting.scriptsFolder,
    input: {
      isTerminal: options.terminal ?? true,
      readLine: () => Promise.resolve(options.answer ?? 'ja'),
    },
    wait: () => {
      waits += 1;
      return Promise.resolve();
    },
    now: () => now,
  });
  const text = output.stdout();
  return {
    code,
    output,
    result: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
    waits,
  };
}

function forbidden(setting: SeedSetting): string[] {
  const { instance } = setting;
  return forbiddenTexts(
    instance.canaries,
    'demo-tenant',
    setting.env['ECCLIUM_SEED_TOKEN_FILE'] ?? '',
    // Every ID of the instance stays out of the output.
    ...instance.calls
      .flatMap((call) => call.path.split('/'))
      .filter((part) => /^\d{4,}$/.test(part)),
  );
}

function expectRefusal(result: SeedResult, hint: HintKey): void {
  expect(result.code).toBe(exitCodes.configuration);
  expect(result.output.stderr()).toContain(hints[hint]);
}

describe('the guard of the seed, from the environment', () => {
  const cases: readonly (readonly [
    string,
    Readonly<Record<string, string | undefined>>,
    HintKey,
  ])[] = [
    [
      'without the switch',
      { ECCLIUM_SEED_ALLOW_WRITE: undefined },
      'seedSchalterFehlt',
    ],
    [
      'with a switch for another host',
      { ECCLIUM_SEED_ALLOW_WRITE: 'anderer' },
      'seedSchalterFalsch',
    ],
    [
      'with the placeholder host',
      {
        ECCLIUM_SEED_BASE_URL: 'https://example.church.tools',
        ECCLIUM_SEED_ALLOW_WRITE: 'example',
      },
      'platzhalterHost',
    ],
    [
      'with the token variable of the probes',
      { ECCLIUM_SPIKE_TOKEN_FILE: '/tmp/x' },
      'seedFremdeTokenVariable',
    ],
    [
      'with the token variable of the write probes',
      { ECCLIUM_SPIKE_WRITE_TOKEN_FILE: '/tmp/x' },
      'seedFremdeTokenVariable',
    ],
    [
      'with the token file of the server',
      { ECCLIUM_CHURCHTOOLS_TOKEN_FILE: '/tmp/x' },
      'seedFremdeTokenVariable',
    ],
    [
      'with a token in a variable',
      { ECCLIUM_CHURCHTOOLS_TOKEN: 'x' },
      'seedFremdeTokenVariable',
    ],
    [
      'without a department',
      { ECCLIUM_SEED_DEPARTMENT_ID: undefined },
      'seedBereichFehlt',
    ],
    [
      'without a status',
      { ECCLIUM_SEED_STATUS_ID: undefined },
      'seedStatusFehlt',
    ],
    [
      'with a status that is no whole number',
      { ECCLIUM_SEED_STATUS_ID: '-1' },
      'seedStatusFehlt',
    ],
    [
      'without the privacy fields',
      { ECCLIUM_SEED_PRIVACY_WHO_ID: undefined },
      'seedDatenschutzFehlt',
    ],
    [
      'with a group status that is no ID',
      { ECCLIUM_SEED_GROUP_STATUS_ID: '0' },
      'seedGruppenstatusFehlt',
    ],
    [
      'without a campus',
      { ECCLIUM_SEED_CAMPUS_ID: 'zwei' },
      'seedStandortFehlt',
    ],
    [
      'without the token file',
      { ECCLIUM_SEED_TOKEN_FILE: undefined },
      'seedTokenDateiFehlt',
    ],
    [
      'without the base URL',
      { ECCLIUM_SEED_BASE_URL: undefined },
      'seedBasisUrlFehlt',
    ],
  ];
  for (const [name, change, hint] of cases) {
    it(`stops before any request ${name}`, async () => {
      const setting = seedSetup();
      const result = await run(
        { ...setting, env: { ...setting.env, ...change } },
        'anlegen',
      );
      expectRefusal(result, hint);
      expect(setting.instance.calls).toEqual([]);
    });
  }

  it('stops before any request without a known command', async () => {
    for (const args of [[], ['loeschen'], ['anlegen', 'anlegen']]) {
      const setting = seedSetup();
      const output = capture();
      const code = await runSeed({
        args,
        env: setting.env,
        fetch: setting.instance.fetch,
        io: output.io,
        scriptsFolder: setting.scriptsFolder,
      });
      expect(code).toBe(exitCodes.configuration);
      expect(output.stderr()).toContain(hints.seedBefehl);
      expect(setting.instance.calls).toEqual([]);
    }
  });
});

describe('the guard of the seed, by reading', () => {
  it('stops without the identification category, before any write (counter-check)', async () => {
    for (const command of ['pruefen', 'anlegen', 'zuruecksetzen']) {
      const setting = seedSetup({ identification: false });
      const result = await run(setting, command);
      expectRefusal(result, 'kennkategorieFehlt');
      expect(setting.instance.writes()).toEqual([]);
    }
  });

  const cases: readonly (readonly [string, InstanceOptions, HintKey])[] = [
    [
      'if the account may edit the identification category',
      { identificationEditable: true },
      'kennkategorieBearbeitbar',
    ],
    [
      'if the account sees a third category',
      { extraCategory: 'Gemeinde' },
      'seedWeitereKategorien',
    ],
    [
      'if an operation is not documented',
      { undocumented: ['delete /events/{}'] },
      'seedOperationFehlt',
    ],
    [
      'if the instance does not declare sendMail',
      { undeclared: ['delete /events/{} sendMail'] },
      'seedOperationFehlt',
    ],
    [
      'if a list does not declare a filter of the seed',
      { undeclared: ['get /persons lastName'] },
      'seedOperationFehlt',
    ],
    [
      'if the instance does not declare the parameter the guard reads the account with',
      { undeclared: ['get /whoami only_allow_authenticated'] },
      'seedOperationFehlt',
    ],
    [
      'if the account holds one right too many',
      {
        rights: (identification) => ({
          ...seedAccountRights(identification),
          churchcore: { 'administer settings': true },
        }),
      },
      'seedZuWeitBerechtigt',
    ],
  ];
  for (const [name, options, hint] of cases) {
    it(`stops ${name}`, async () => {
      const setting = seedSetup(options);
      const result = await run(setting, 'anlegen');
      expectRefusal(result, hint);
      expect(setting.instance.writes()).toEqual([]);
    });
  }

  it('asks in the terminal and writes nothing without «ja» or without a terminal', async () => {
    const declined = seedSetup();
    expectRefusal(
      await run(declined, 'anlegen', { answer: 'Ja' }),
      'nichtBestaetigt',
    );
    expect(declined.instance.writes()).toEqual([]);
    const piped = seedSetup();
    expectRefusal(
      await run(piped, 'zuruecksetzen', { terminal: false }),
      'keinTerminal',
    );
    expect(piped.instance.writes()).toEqual([]);
  });

  it('checks without a terminal and writes nothing with pruefen', async () => {
    const setting = seedSetup();
    const result = await run(setting, 'pruefen', { terminal: false });
    expect(result.code).toBe(exitCodes.ok);
    expect(setting.instance.writes()).toEqual([]);
    expect(result.result['struktur']).toMatchObject({
      gy: 'fehlt',
      w: 'fehlt',
    });
    expect(result.result['personen']).toMatchObject({ pA: 'fehlt' });
    expect(leaks(result.output, forbidden(setting))).toEqual([]);
  });
});

describe('seedRightsWithin', () => {
  const identification = 12;
  const seedCategory = 40;

  it('lets the rights of the seed account pass, before and after the right on its category', () => {
    expect(
      seedRightsWithin(
        seedAccountRights(identification),
        identification,
        undefined,
        departmentId,
      ),
    ).toBe(true);
    expect(
      seedRightsWithin(
        seedAccountRights(identification, seedCategory),
        identification,
        seedCategory,
        departmentId,
      ),
    ).toBe(true);
  });

  it('refuses every widening', () => {
    const widen: readonly ((
      data: Record<string, Record<string, unknown>>,
    ) => void)[] = [
      (data) => {
        data['churchwiki'] = {
          ...data['churchwiki'],
          'edit category': [identification],
        };
      },
      (data) => {
        data['churchwiki'] = {
          ...data['churchwiki'],
          'view category': [identification, 99],
        };
      },
      (data) => {
        data['churchwiki'] = { ...data['churchwiki'], view: false };
      },
      (data) => {
        data['churchdb'] = {
          ...data['churchdb'],
          'view alldata': [departmentId, 9],
        };
      },
      (data) => {
        data['churchdb'] = { ...data['churchdb'], 'delete persons': true };
      },
      (data) => {
        data['churchdb'] = {
          ...data['churchdb'],
          'security level person': [2],
        };
      },
      (data) => {
        data['churchdb'] = {
          ...data['churchdb'],
          'security level person': [1, 2],
        };
      },
      (data) => {
        data['churchgroup'] = { ...data['churchgroup'], 'delete group': [3] };
      },
      (data) => {
        data['finance'] = { view: true };
      },
      (data) => {
        data['churchcore'] = { 'administer settings': true };
      },
      (data) => {
        data['toString'] = { view: true };
      },
    ];
    for (const change of widen) {
      const data = seedAccountRights(identification);
      change(data);
      expect(
        seedRightsWithin(data, identification, undefined, departmentId),
      ).toBe(false);
    }
  });
});

describe('anlegen', () => {
  it('creates the data set, without mails and without IDs in the output', async () => {
    const setting = seedSetup();
    const result = await run(setting, 'anlegen');
    expect(result.code).toBe(exitCodes.ok);
    expect(result.result).toMatchObject({
      seed: 'anlegen',
      churchtoolsVersion: '3.138',
      struktur: {
        gy: 'angelegt',
        c: 'angelegt',
        rt: 'angelegt',
        r: 'angelegt',
        sg: 'angelegt',
        s1: 'angelegt',
        s2: 'angelegt',
        sc: 'angelegt',
        w: 'angelegt',
      },
      personen: { pA: 'angelegt', pF: 'angelegt' },
      gruppen: { gH: 'angelegt', gT: 'angelegt' },
      mitglieder: { gHpA: 'angelegt', gTpF: 'angelegt' },
      lieder: { l1: 'angelegt', l2: 'angelegt' },
      arrangements: { l1a: 'angelegt', l1b: 'angelegt', l2a: 'angelegt' },
      termine: {
        a1: 'angelegt',
        a2: 'angelegt',
        a3: 'angelegt',
        a4: 'angelegt',
      },
      events: { e1: 'angelegt', e2: 'angelegt' },
      einteilungen: {
        e1s1pD: 'angelegt',
        e2s1pA: 'angelegt',
        e2s2pB: 'angelegt',
        e2s2pC: 'angelegt',
      },
      ablauf: {
        e2: 'angelegt',
        e2i1: 'angelegt',
        e2i2: 'angelegt',
        e2i3: 'angelegt',
      },
      buchungen: { b1: 'angelegt', a4: 'vorhanden' },
      seiten: { w1: 'uebersprungen', w2: 'uebersprungen', w3: 'uebersprungen' },
      pruefungen: { diensteOhneMails: 'ja', gHSeedkonto: 'nein' },
    });
    expect(result.result).not.toHaveProperty('abbruch');
    expect(result.waits).toBe(setting.instance.writes().length);
    expect(leaks(result.output, forbidden(setting))).toEqual([]);

    const writes = setting.instance.writes();
    for (const call of writes.filter((item) => item.path === '/api/persons')) {
      expect(call.body).not.toHaveProperty('email');
      expect(call.body).toMatchObject({
        lastName: 'Seedprobe',
        departmentIds: [departmentId],
        statusId: 0,
        privacyPolicyAgreementDate: '2026-10-27',
        privacyPolicyAgreementTypeId: 3,
        privacyPolicyAgreementWhoId: 1,
      });
    }
    for (const call of writes.filter((item) => item.path === '/api/services')) {
      expect(call.body).toMatchObject({
        sendServiceRequestEmails: false,
        sendReminderMails: false,
        allowChat: false,
      });
    }
    for (const call of writes.filter(
      (item) => item.method === 'PUT' && item.path.includes('/members/'),
    )) {
      expect(call.body).toMatchObject({ informLeader: false });
    }
    const assignments = writes.filter((item) =>
      item.path.includes('/servicerequests/'),
    );
    expect(assignments.map((item) => item.method)).toEqual([
      'PUT',
      'PUT',
      'PUT',
      'PUT',
    ]);
    expect(
      assignments.map(
        (item) => (item.body as Record<string, unknown>)['isAccepted'],
      ),
    ).toEqual([false, true, false, false]);
    expect(
      writes.some((item) => /invite|meetingrequests/.test(item.path)),
    ).toBe(false);
    // The appointment made by hand with a title of the seed stays.
    expect(
      setting.instance.store.appointments.filter(
        (item) => item['title'] === 'Seedprobe Gottesdienst',
      ),
    ).toHaveLength(2);
  });

  it('creates nothing twice, and the pages once the account has the right on its category', async () => {
    const setting = seedSetup();
    await run(setting, 'anlegen');
    const before = setting.instance.writes().length;
    const again = await run(setting, 'anlegen');
    expect(again.result['struktur']).toMatchObject({
      c: 'vorhanden',
      w: 'fehlt',
    });
    expect(again.result['termine']).toMatchObject({ a1: 'vorhanden' });
    expect(again.result['events']).toMatchObject({
      e1: 'vorhanden',
      e2: 'vorhanden',
    });
    expect(setting.instance.writes()).toHaveLength(before);

    setting.instance.grantSeedCategory();
    const third = await run(setting, 'anlegen');
    expect(third.result['struktur']).toMatchObject({ w: 'vorhanden' });
    expect(third.result['seiten']).toEqual({
      w1: 'angelegt',
      w2: 'angelegt',
      w3: 'angelegt',
    });
    expect(
      setting.instance
        .writes()
        .filter((item) => item.path === '/api/wiki/categories'),
    ).toHaveLength(1);
    expect(
      setting.instance.store.pages.find(
        (item) => item['title'] === 'Seedprobe HTML',
      ),
    ).toMatchObject({ isMarkdown: false });
  });

  it('uses only a resource of its own resource type', async () => {
    const setting = seedSetup();
    // The resource type of the seed exists, and a resource made by hand
    // with the name of the seed lies in another type.
    setting.instance.store.resourceTypes.push({
      id: 5,
      name: 'Seedprobe Räume',
    });
    setting.instance.store.resources.push({
      id: 7,
      name: 'Seedprobe Saal',
      resourceTypeId: 6,
    });
    const result = await run(setting, 'anlegen');
    expect(result.result['struktur']).toMatchObject({
      rt: 'vorhanden',
      r: 'angelegt',
    });
    const booking = setting.instance
      .writes()
      .find((call) => call.path === '/api/bookings');
    expect(booking?.body).toMatchObject({
      title: 'Seedprobe Technikprobe',
      statusId: 2,
      showInCal: false,
    });
    expect(booking?.body).not.toMatchObject({ resourceId: 7 });
  });

  it('takes the seed account out of a group the instance made it a member of', async () => {
    const setting = seedSetup({ creatorJoinsGroups: true });
    const result = await run(setting, 'anlegen');
    expect(result.result['pruefungen']).toMatchObject({
      gHSeedkonto: 'entfernt',
      gTSeedkonto: 'entfernt',
    });
    for (const members of setting.instance.store.members.values()) {
      expect(members.has(accountId)).toBe(false);
    }
  });

  it('assigns nobody if a service sends mails', async () => {
    const setting = seedSetup({ servicesSendMails: true });
    const result = await run(setting, 'anlegen');
    expect(result.result['pruefungen']).toMatchObject({
      diensteOhneMails: 'nein',
    });
    expect(result.result['einteilungen']).toMatchObject({
      e1s1pD: 'uebersprungen',
      e2s1pA: 'uebersprungen',
    });
    expect(
      setting.instance
        .writes()
        .some((item) => item.path.includes('/servicerequests/')),
    ).toBe(false);
  });

  it('assigns nobody if it cannot read the single event', async () => {
    const setting = seedSetup({
      refuse: new Map([['GET /api/events/{}', 403]]),
    });
    const result = await run(setting, 'anlegen');
    expect(result.result['events']).toMatchObject({
      e1: 'angelegt',
      e2: 'angelegt',
    });
    expect(result.result['einteilungen']).toEqual({
      e1s1pD: 'antwort unerwartet',
      e2s1pA: 'antwort unerwartet',
      e2s2pB: 'antwort unerwartet',
      e2s2pC: 'antwort unerwartet',
    });
    expect(result.result['ablauf']).toMatchObject({ e2: 'angelegt' });
    expect(
      setting.instance
        .writes()
        .some((item) => item.path.includes('/servicerequests/')),
    ).toBe(false);
  });

  it('notes a refused write, skips what depends on it and goes on', async () => {
    const setting = seedSetup({
      refuse: new Map([['POST /api/persons', 403]]),
    });
    const result = await run(setting, 'anlegen');
    expect(result.code).toBe(exitCodes.ok);
    expect(result.result['personen']).toMatchObject({ pA: { abgelehnt: 403 } });
    expect(result.result['mitglieder']).toMatchObject({
      gHpA: 'uebersprungen',
    });
    expect(result.result['lieder']).toMatchObject({ l1: 'angelegt' });
    expect(leaks(result.output, forbidden(setting))).toEqual([]);
  });

  it('stops after a network error on a write and sends nothing after it', async () => {
    const setting = seedSetup({ failAt: 'POST /api/songs' });
    const result = await run(setting, 'anlegen');
    // A stopped run must not read as success.
    expect(result.code).toBe(exitCodes.network);
    expect(result.result).toMatchObject({
      abbruch: 'NETZ_VERBINDUNG',
      lieder: { l1: 'ungewiss', l2: 'uebersprungen' },
    });
    const calls = setting.instance.calls;
    const failed = calls.findIndex(
      (call) => call.method === 'POST' && call.path === '/api/songs',
    );
    expect(failed).toBeGreaterThan(0);
    expect(calls.slice(failed + 1)).toEqual([]);
  });
});

describe('zuruecksetzen', () => {
  it('deletes the content of the seed only, events without mail, and keeps structure, persons and groups', async () => {
    const setting = seedSetup();
    await run(setting, 'anlegen');
    setting.instance.grantSeedCategory();
    await run(setting, 'anlegen');
    const result = await run(setting, 'zuruecksetzen');
    expect(result.code).toBe(exitCodes.ok);
    expect(result.result).toMatchObject({
      seiten: { w1: 'geloescht', w2: 'geloescht', w3: 'geloescht' },
      events: { e1: 'geloescht', e2: 'geloescht' },
      termine: {
        a1: 'geloescht',
        a2: 'geloescht',
        a3: 'geloescht',
        a4: 'geloescht',
      },
      lieder: { l1: 'geloescht', l2: 'geloescht' },
      buchungen: { b1: 'geloescht' },
    });
    const deletes = setting.instance
      .writes()
      .filter((call) => call.method === 'DELETE');
    const events = deletes.filter((item) =>
      /^\/api\/events\/\d+$/.test(item.path),
    );
    expect(events).toHaveLength(2);
    // Every event goes before the first appointment.
    const firstAppointment = deletes.findIndex((item) =>
      item.path.includes('/appointments/'),
    );
    expect(firstAppointment).toBeGreaterThan(
      deletes.indexOf(events[1] as (typeof deletes)[number]),
    );
    for (const call of events) {
      expect(call.query.get('sendMail')).toBe('false');
    }
    expect(
      deletes.some((call) => /^\/api\/(persons|groups)\//.test(call.path)),
    ).toBe(false);
    const { store } = setting.instance;
    expect(
      store.persons.filter((item) => item['lastName'] === 'Seedprobe'),
    ).toHaveLength(6);
    expect(store.groups).toHaveLength(2);
    expect(store.calendars).toHaveLength(2);
    // What was made by hand stays: an appointment and a song with titles of
    // the seed, elsewhere.
    expect(store.appointments).toHaveLength(1);
    expect(store.songs).toHaveLength(1);
    expect(leaks(result.output, forbidden(setting))).toEqual([]);
  });
});

describe('zuruecksetzen without its events', () => {
  it('keeps an appointment whose event it could not delete', async () => {
    const setting = seedSetup();
    await run(setting, 'anlegen');
    setting.instance.behave({
      refuse: new Map([['DELETE /api/events/{}', 403]]),
    });
    const result = await run(setting, 'zuruecksetzen');
    expect(result.result).toMatchObject({
      events: { e1: { abgelehnt: 403 }, e2: { abgelehnt: 403 } },
      termine: {
        a1: 'uebersprungen',
        a2: 'uebersprungen',
        a3: 'geloescht',
        a4: 'geloescht',
      },
    });
    expect(
      setting.instance.store.appointments.filter((item) =>
        String(item['title']).startsWith('Seedprobe'),
      ),
    ).toHaveLength(3);
  });
});

describe('the clients of the seed', () => {
  const options = {
    origin: seedOrigin,
    token: 'token',
    guard: new Guard(),
    fetch: () => Promise.reject(new Error('no network')),
  };

  it('send only operations of the seed, with IDs of the right form', async () => {
    const client = createSeedClient(options);
    const refused = [
      { operation: 'wikiPageUpdate' as never, parameters: [1, 'x'] },
      { operation: 'songDelete' as const, parameters: ['1'] },
      { operation: 'songDelete' as const, parameters: [0] },
      { operation: 'wikiPageDelete' as const, parameters: [1, 'main'] },
      { operation: 'songDelete' as const, parameters: [1, 2] },
    ];
    for (const request of refused) {
      await expect(client.send(request)).rejects.toMatchObject({
        code: 'INTERN',
      });
    }
  });

  it('keep the client of the write probes to its three operations', async () => {
    const client = createWriteClient(options);
    await expect(
      client.send({ operation: 'songCreate' as never, parameters: [] }),
    ).rejects.toMatchObject({ code: 'INTERN' });
  });

  it('are handed out only by the guard of the seed', () => {
    const folder = join(import.meta.dirname, '..', '..', 'scripts', 'seed');
    const users = readdirSync(folder, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.mts'))
      .map((entry) => join(entry.parentPath, entry.name))
      .filter((file) =>
        /create(Seed|Persons|Write)Client/.test(readFileSync(file, 'utf8')),
      );
    expect(users).toEqual([]);
  });
});

describe('the data set', () => {
  it('has a long page that the tool reads in parts', () => {
    const long = pages.find((page) => page.label === 'w3');
    expect(Buffer.byteLength(long?.text ?? '', 'utf8')).toBeGreaterThan(
      48 * 1024,
    );
  });

  it('hangs on the first Saturday at least two days after the run', () => {
    expect(anchorSaturday(new Date('2026-10-27T20:00:00Z')).toISOString()).toBe(
      '2026-10-31T00:00:00.000Z',
    );
    expect(anchorSaturday(new Date('2026-10-30T23:59:00Z')).toISOString()).toBe(
      '2026-11-07T00:00:00.000Z',
    );
    expect(anchorSaturday(new Date('2026-10-29T00:00:00Z')).toISOString()).toBe(
      '2026-10-31T00:00:00.000Z',
    );
  });
});
