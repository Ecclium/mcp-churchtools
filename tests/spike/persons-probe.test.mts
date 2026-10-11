// Runs probe 08 against a synthetic instance whose answers carry
// synthetic persons and groups, a foreign canary person and the record of
// the account itself. The probe must print how the API behaves and none of
// the values: no name, ID, e-mail address, date or search term.
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  probe,
  unknownId,
} from '../../scripts/spike/08-persons-groups-read.mts';
import { createState } from '../../scripts/spike/lib/env.mts';
import { isPersonalPath } from '../../scripts/spike/lib/http.mts';
import { exitCodes } from '../../scripts/spike/lib/output.mts';
import { runProbe } from '../../scripts/spike/lib/probe.mts';
import { capture, leaks, type Capture } from './support.mts';
import {
  narrowRights,
  personsInstance,
  personsOrigin,
  personsSetup,
  personsState,
  type PersonsCall,
  type PersonsInstanceOptions,
  type PersonsSetting,
} from './persons-support.mts';

const spikeFolder = fileURLToPath(
  new URL('../../scripts/spike/', import.meta.url),
);

interface Run {
  readonly code: number;
  readonly result: Record<string, unknown>;
  readonly calls: readonly PersonsCall[];
  readonly output: Capture;
  readonly setting: PersonsSetting;
}

// Forms of values the instance makes up at random: GUIDs, the random
// search term, birthdays and other dates.
const valueForms = [
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  /\d{4}-\d{2}-\d{2}/,
];

/**
 * Checks what holds for every run: no value of the instance in the output,
 * and no single read beyond the IDs of the environment, the unknown values
 * and the GUIDs of `p1` and `g1`. The instance tags each single read with
 * the object it addressed, so a GUID taken from a list fails here.
 */
function expectNothingBeyond(
  setting: PersonsSetting,
  instance: {
    readonly calls: readonly PersonsCall[];
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
  const environment = new Set(
    [setting.personId, setting.groupId, setting.otherGroupId, unknownId].map(
      String,
    ),
  );
  for (const call of instance.calls) {
    // No value the instance made up goes back to it, not even as a term.
    for (const [, value] of call.url.searchParams) {
      expect(instance.generated).not.toContain(value.toLowerCase());
    }
    for (const name of ['ids[]', 'ids']) {
      for (const value of call.url.searchParams.getAll(name)) {
        expect(environment.has(value)).toBe(true);
      }
    }
    if (call.resolved === undefined) {
      continue;
    }
    const key = call.url.pathname.split('/')[3] ?? '';
    if (!environment.has(key)) {
      expect(['p1', 'g1', 'none']).toContain(call.resolved);
    }
  }
}

async function run(
  make:
    | PersonsInstanceOptions
    | ((setting: PersonsSetting) => PersonsInstanceOptions) = {},
  document?: unknown,
  changes: Readonly<Record<string, string | undefined>> = {},
): Promise<Run> {
  const setting = personsSetup();
  const options = typeof make === 'function' ? make(setting) : make;
  createState(setting.stateFile, personsState(document));
  const instance = personsInstance(setting, {
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

describe('probe 08', () => {
  it('reads the synthetic objects and prints none of the values', async () => {
    const { code, result, output, setting } = await run();
    expect(code).toBe(exitCodes.ok);
    expect(leaks(output, setting.forbidden)).toEqual([]);
    expect(result['waechter']).toBe('bestanden');
    const ergebnisse = section(result, 'ergebnisse');
    expect(ergebnisse['persons']).toBe('erlaubt mit Einträgen');
    expect(seen(result, 'persons')).toEqual({
      p1: 'ja',
      p2: 'ja',
      p3: 'ja',
      p4: 'nein',
      g1: 'nein',
      g2: 'nein',
    });
    expect(ergebnisse['group:g2-id']).toBe('verweigert');
    expect(ergebnisse['person:p1-guid']).toBe('erlaubt mit Einträgen');
    expect(ergebnisse['group:g1-guid']).toBe('erlaubt mit Einträgen');
    expect(result['kennungSynthetisch']).toEqual({
      p1: 'ja',
      g1: 'ja',
      g2: 'nicht geprüft',
    });
    const persons = section(section(result, 'listen'), 'persons');
    expect(persons['grenze']).toMatchObject({
      ergebnis: 'genau',
      groesstesAngenommen: 500,
      kleinstesAbgelehnt: 501,
      kuerzung: 'nein',
      anfragen: expect.arrayContaining([
        { angefragt: 1, status: 200, limitEcho: 1 },
      ]) as unknown,
    });
    expect(persons['hinterLetzterSeite']).toEqual({
      status: 200,
      eintraege: '0',
    });
    expect(persons['weitereSeiten']).toBe('ja');
    expect(persons['meta']).toEqual({
      count: 'ja',
      all: 'ja',
      pagination: 'ja',
    });
    const only = (...labels: readonly string[]): Record<string, string> =>
      Object.fromEntries(
        ['p1', 'p2', 'p3', 'p4', 'g1', 'g2'].map((label) => [
          label,
          labels.includes(label) ? 'ja' : 'nein',
        ]),
      );
    expect(seen(result, 'groups')).toEqual(only('g1'));
    expect(seen(result, 'search:q1')).toEqual(only('p1', 'p2', 'p3', 'g1'));
    expect(seen(result, 'persons:ids')).toEqual(only('p1'));
    expect(seen(result, 'groups:ids')).toEqual(only('g1'));
    expect(seen(result, 'personGroups:p1')).toEqual(only('p1', 'g1'));
    expect(ergebnisse['groupMembers:g1']).toBe('erlaubt mit Einträgen');
    // g2 is refused, so it is not checked, and its members are read anyway.
    expect(ergebnisse['groupMembers:g2']).toBe('verweigert');
  });

  it('shows g2 where the account sees every group, and no member list where it may not', async () => {
    const alle = await run({ groups: 'alle' });
    expect(seen(alle.result, 'groups')['g2']).toBe('ja');
    expect(seen(alle.result, 'search:q1')['g2']).toBe('ja');
    expect(seen(alle.result, 'groups:ids')).toMatchObject({
      g1: 'ja',
      g2: 'ja',
    });
    expect(section(alle.result, 'kennungSynthetisch')['g2']).toBe('ja');
    expect(seen(alle.result, 'groupMembers:g2')['p3']).toBe('ja');
    const closed = await run({ memberLists: false });
    const ergebnisse = section(closed.result, 'ergebnisse');
    expect(ergebnisse['group:g1-id']).toBe('erlaubt mit Einträgen');
    expect(ergebnisse['groupMembers:g1']).toBe('verweigert');
    expect(ergebnisse['groupMembers:g1-guid']).toBe('verweigert');
  });

  it('tells a cut limit and searches the bound in an empty list as well', async () => {
    const cut = await run({ echoCap: 100 });
    const persons = (run: Run): Record<string, unknown> =>
      section(section(section(run.result, 'listen'), 'persons'), 'grenze');
    expect(persons(cut)['kuerzung']).toBe('ja');
    // The bound comes from the check of the parameters, not from the data.
    const empty = await run({ persons: 'keine' });
    expect(section(empty.result, 'ergebnisse')['persons']).toBe('erlaubt leer');
    expect(persons(empty)).toMatchObject({
      ergebnis: 'genau',
      groesstesAngenommen: 500,
    });
  });

  it('sends the spelling ids where the instance declares it', async () => {
    const document = structuredClone(personsState().specification) as {
      paths: Record<
        string,
        Record<string, { parameters: { name?: string }[] }>
      >;
    };
    const listing = document.paths['/persons']?.['get'];
    const ids = listing?.parameters.find((item) => item.name === 'ids[]');
    if (ids === undefined) {
      throw new Error('synthetic document changed');
    }
    ids.name = 'ids';
    const { code, calls, setting } = await run({}, document);
    expect(code).toBe(exitCodes.ok);
    const byIds = calls.filter(
      (call) =>
        call.url.pathname === '/api/persons' &&
        call.url.searchParams.get('ids') === String(setting.personId),
    );
    expect(byIds).toHaveLength(1);
    expect(byIds[0]?.url.searchParams.has('ids[]')).toBe(false);
  });

  it('leaves out the unknown ID where the instance cannot reach it or it is in use', async () => {
    const document = structuredClone(personsState().specification) as {
      paths: Record<
        string,
        Record<string, { parameters: { schema: Record<string, unknown> }[] }>
      >;
    };
    const parameter =
      document.paths['/persons/{personId}']?.['get']?.parameters[0];
    if (parameter === undefined) {
      throw new Error('synthetic document changed');
    }
    parameter.schema['maximum'] = 99_999_999;
    const bounded = await run({}, document);
    const unknownPath = `/api/persons/${String(unknownId)}`;
    expect(section(bounded.result, 'ergebnisse')['person:unbekannt']).toBe(
      'nicht geprüft',
    );
    expect(section(bounded.result, 'ergebnisse')['group:unbekannt']).toBe(
      'nicht gefunden',
    );
    expect(
      bounded.calls.filter((call) => call.url.pathname === unknownPath),
    ).toEqual([]);
    const taken = await run({}, undefined, {
      ECCLIUM_SPIKE_PERSON_ID: String(unknownId),
    });
    expect(taken.code).toBe(exitCodes.ok);
    const ergebnisse = section(taken.result, 'ergebnisse');
    expect(ergebnisse['person:unbekannt']).toBe('nicht geprüft');
    expect(ergebnisse['group:unbekannt']).toBe('nicht geprüft');
    expect(
      taken.calls.filter((call) => call.url.pathname === unknownPath),
    ).toHaveLength(1);
    const takenByGroup = await run({}, undefined, {
      ECCLIUM_SPIKE_OTHER_GROUP_ID: String(unknownId),
    });
    expect(section(takenByGroup.result, 'ergebnisse')).toMatchObject({
      'person:unbekannt': 'nicht geprüft',
      'group:unbekannt': 'nicht geprüft',
    });
  });

  it('names the known parameters and counts the others', async () => {
    const document = structuredClone(personsState().specification) as {
      paths: Record<
        string,
        Record<string, { parameters: Record<string, unknown>[] }>
      >;
    };
    const listing = document.paths['/persons']?.['get'];
    if (listing === undefined) {
      throw new Error('synthetic document changed');
    }
    listing.parameters.push({
      name: 'kanarie_feld',
      in: 'query',
      deprecated: true,
      schema: { type: 'string', enum: ['a', 'b'] },
    });
    const email = listing.parameters.find((item) => item['name'] === 'email');
    if (email === undefined) {
      throw new Error('synthetic document changed');
    }
    email['deprecated'] = true;
    const { code, result } = await run({}, document);
    expect(code).toBe(exitCodes.ok);
    const parameter = section(result, 'parameter');
    const persons = section(parameter, 'persons');
    expect(persons['weitere']).toBe('1');
    const named = persons['benannt'] as Record<string, unknown>[];
    expect(named.map((item) => item['name'])).toEqual([
      'ids[]',
      'query',
      'email',
      'page',
      'limit',
    ]);
    expect(named.find((item) => item['name'] === 'email')).toMatchObject({
      veraltet: 'ja',
    });
    expect(named.find((item) => item['name'] === 'ids[]')).toEqual({
      name: 'ids[]',
      ort: 'query',
      pflicht: 'nein',
      typ: 'Liste',
      eintraege: 'ganze Zahl',
      veraltet: 'nein',
      aufzaehlung: 'nein',
    });
    const search = section(parameter, 'search')['benannt'] as Record<
      string,
      unknown
    >[];
    expect(search.find((item) => item['name'] === 'query')).toMatchObject({
      pflicht: 'ja',
    });
    expect(
      search.find((item) => item['name'] === 'domain_types[]'),
    ).toMatchObject({ aufzaehlung: '2–9' });
    const person = section(parameter, 'person')['benannt'];
    expect(person).toEqual([
      expect.objectContaining({ name: 'personId', ort: 'path', pflicht: 'ja' }),
    ]);
  });

  it('sends only GET to the one origin, with the token only in its header', async () => {
    const { calls, setting } = await run();
    expect(calls.length).toBeGreaterThan(20);
    for (const call of calls) {
      expect(call.method).toBe('GET');
      expect(call.url.origin).toBe(personsOrigin);
      expect(call.authorization).toBe(`Login ${setting.canaries.token}`);
      expect(call.url.search).not.toContain(setting.canaries.token);
      expect(call.url.searchParams.has('personFields[]')).toBe(false);
    }
  });

  it('fetches single objects only by the IDs of the environment, their own GUIDs and the unknown values', async () => {
    // run() checks every single read; here it sees foreign GUIDs in every list.
    const { calls, setting } = await run({ persons: 'alle', groups: 'alle' });
    const environment = new Set(
      [setting.personId, setting.groupId, setting.otherGroupId].map(String),
    );
    const byGuid = calls
      .filter((call) => call.resolved !== undefined)
      .filter(
        (call) =>
          !environment.has(call.url.pathname.split('/')[3] ?? '') &&
          call.resolved !== 'none',
      )
      .map(
        (call) =>
          `${call.resolved ?? ''} ${call.url.pathname.split('/')[4] ?? ''}`,
      );
    expect(byGuid.sort()).toEqual(['g1 ', 'g1 members', 'p1 ']);
  });

  it('stops at a group that is not synthetic and reads nothing more about it', async () => {
    const { code, result, calls, setting } = await run({ foreignAsG1: true });
    expect(code).toBe(exitCodes.ok);
    expect(section(result, 'kennungSynthetisch')['g1']).toBe('nein');
    expect(section(result, 'ergebnisse')['groupMembers:g1']).toBe(
      'nicht aufgerufen',
    );
    expect(
      calls.filter((call) =>
        call.url.pathname.startsWith(`/api/groups/${String(setting.groupId)}/`),
      ),
    ).toEqual([]);
    expect(
      calls.filter((call) => call.resolved === 'foreignGroup'),
    ).toHaveLength(1);
  });

  it('tells the echo of a search term in an error, never the term', async () => {
    const { code, result } = await run({ refusedQuery: 'Spikepro' });
    expect(code).toBe(exitCodes.ok);
    expect(section(result, 'ergebnisse')['search:q3']).toBe('Fehler');
    expect(section(result, 'fehler')['search 400']).toMatchObject({
      fehlerschluessel: { message: 'ja', args: 'ja', errors: 'ja' },
      echo: { echo: 'ja', unter: ['args'] },
    });
  });

  it('shows the change between a stage without rights and one with', async () => {
    const before = await run({ persons: 'keine', groups: 'keine' });
    const after = await run();
    const was = section(before.result, 'ergebnisse');
    const is = section(after.result, 'ergebnisse');
    expect(was['persons']).toBe('erlaubt leer');
    expect(was['person:p1-id']).toBe('verweigert');
    expect(was['group:g1-id']).toBe('verweigert');
    expect(is['persons']).toBe('erlaubt mit Einträgen');
    expect(is['person:p1-id']).toBe('erlaubt mit Einträgen');
    expect(is['group:g1-id']).toBe('erlaubt mit Einträgen');
  });

  it('stops at a person that is not synthetic and reads nothing more about it', async () => {
    const { code, result, calls, setting } = await run({
      persons: 'alle',
      foreignAsP1: true,
    });
    expect(code).toBe(exitCodes.ok);
    expect(section(result, 'kennungSynthetisch')['p1']).toBe('nein');
    const ergebnisse = section(result, 'ergebnisse');
    expect(ergebnisse['person:p1-guid']).toBe('nicht aufgerufen');
    expect(ergebnisse['personGroups:p1']).toBe('nicht aufgerufen');
    expect(
      calls.filter(
        (call) =>
          call.url.pathname ===
          `/api/persons/${String(setting.personId)}/groups`,
      ),
    ).toEqual([]);
  });

  it('reports an operation the instance does not document and calls nothing for it', async () => {
    const document = structuredClone(personsState().specification) as {
      paths: Record<string, unknown>;
    };
    delete document.paths['/search'];
    const { code, result, calls } = await run({}, document);
    expect(code).toBe(exitCodes.ok);
    expect(section(result, 'operationen')['search']).toBe('nicht dokumentiert');
    expect(section(result, 'listen')['search']).toBe('nicht dokumentiert');
    expect(section(result, 'ergebnisse')['search:q1']).toBe(
      'nicht dokumentiert',
    );
    expect(calls.filter((call) => call.url.pathname === '/api/search')).toEqual(
      [],
    );
  });

  it('tells the echo of the marker and the known error keys, never the values', async () => {
    const { result, output, setting } = await run();
    const persons = section(section(result, 'listen'), 'persons');
    const invalid = persons['ungueltigeWerte'] as Record<string, unknown>[];
    const markerEntry = invalid.find((entry) => entry['wert'] === 'Marke');
    expect(markerEntry).toMatchObject({
      parameter: 'limit',
      status: 400,
      fehlerschluessel: { message: 'ja', args: 'ja', errors: 'ja' },
      echo: { echo: 'ja', unter: ['args'] },
    });
    expect(leaks(output, setting.forbidden)).toEqual([]);
  });

  it('keeps the names of rights although answers carry «person» and «group»', async () => {
    const { code, result } = await run((setting) => ({
      rights: narrowRights(setting.identification, {
        view: true,
        'security level person': [1],
        'view groups of grouptype': [-1],
      }),
    }));
    expect(code).toBe(exitCodes.ok);
    const rechte = JSON.stringify(result['rechte']);
    expect(rechte).toContain('security level person');
    expect(rechte).toContain('Zahl negativ');
  });

  it('names an unknown ID that exists without reading it', async () => {
    const { result } = await run({ unknownExists: true });
    const ergebnisse = section(result, 'ergebnisse');
    expect(ergebnisse['person:unbekannt']).toBe('unbekannte ID vorhanden');
    expect(ergebnisse['group:unbekannt']).toBe('unbekannte ID vorhanden');
    expect(section(result, 'sichtbar')['person:unbekannt']).toBeUndefined();
  });

  it('stops before any personal data when the rights are too wide', async () => {
    const { code, calls } = await run((setting) => ({
      rights: narrowRights(setting.identification, { 'view archive': true }),
    }));
    expect(code).toBe(exitCodes.configuration);
    expect(calls.filter((call) => isPersonalPath(call.url.pathname))).toEqual(
      [],
    );
  });

  it('finds p1 by a part of its e-mail address only where the instance does', async () => {
    const plain = await run();
    const withEmails = await run({ searchEmails: true });
    expect(seen(plain.result, 'search:q6')['p1']).toBe('nein');
    expect(seen(withEmails.result, 'search:q6')['p1']).toBe('ja');
    expect(seen(plain.result, 'persons:email:q6')['p1']).toBe('ja');
  });

  it('describes persons with the features of dates and without truth values', async () => {
    const { result } = await run();
    const persons = JSON.stringify(section(result, 'strukturen')['persons']);
    expect(persons).toContain('"format":"Datum"');
    expect(persons).toContain('"format":"Datum mit Zeit"');
    expect(persons).not.toContain('"wert"');
  });

  it('recognises the record of the account itself', async () => {
    const alle = await run({ persons: 'alle' });
    const bereich = await run();
    expect(section(alle.result, 'eigenerDatensatz')['persons']).toBe('ja');
    expect(section(bereich.result, 'eigenerDatensatz')['persons']).toBe('nein');
    // The foreign canary person; the synthetic ones and the own record do not count.
    expect(section(alle.result, 'andereEintraege')['persons']).toBe('1');
  });

  it('counts answers without names apart and reads nothing more on them', async () => {
    const { code, result, calls, setting } = await run({
      withoutNames: true,
    });
    expect(code).toBe(exitCodes.ok);
    const ergebnisse = section(result, 'ergebnisse');
    expect(ergebnisse['persons']).toBe('erlaubt mit Einträgen');
    const unknownAll = {
      p1: 'unbekannt',
      p2: 'unbekannt',
      p3: 'unbekannt',
      p4: 'unbekannt',
      g1: 'unbekannt',
      g2: 'unbekannt',
    };
    expect(seen(result, 'persons')).toEqual(unknownAll);
    expect(seen(result, 'search:q1')).toEqual(unknownAll);
    expect(section(result, 'andereEintraege')['persons']).toBe('0');
    expect(section(result, 'nichtVergleichbar')['persons']).toBe('2–9');
    expect(result['kennungSynthetisch']).toEqual({
      p1: 'nicht vergleichbar',
      g1: 'nicht vergleichbar',
      g2: 'nicht geprüft',
    });
    for (const target of [
      'person:p1-guid',
      'personGroups:p1',
      'groupMembers:g1',
      'group:g1-guid',
      'groupMembers:g1-guid',
    ]) {
      expect(ergebnisse[target]).toBe('nicht aufgerufen');
    }
    expect(
      calls.filter((call) =>
        [
          `/api/persons/${String(setting.personId)}/groups`,
          `/api/groups/${String(setting.groupId)}/members`,
        ].includes(call.url.pathname),
      ),
    ).toEqual([]);
    expect(section(result, 'veraltet')['person']).toBeUndefined();
  });

  it('takes empty names for no names', async () => {
    const { code, result } = await run({ emptyNames: true });
    expect(code).toBe(exitCodes.ok);
    expect(section(result, 'kennungSynthetisch')['p1']).toBe(
      'nicht vergleichbar',
    );
    expect(section(result, 'andereEintraege')['persons']).toBe('0');
    expect(section(result, 'nichtVergleichbar')['persons']).toBe('2–9');
    expect(seen(result, 'persons')['p1']).toBe('unbekannt');
  });

  it('recognises a person by the full name in a title', async () => {
    const { result } = await run({ titlesOnly: true });
    expect(seen(result, 'search:q1')).toMatchObject({
      p1: 'ja',
      p2: 'ja',
      p3: 'ja',
      p4: 'nein',
    });
  });

  it('cannot tell a member without a name from a missing one', async () => {
    const { result } = await run({ unnamedMember: true });
    expect(seen(result, 'groupMembers:g1')).toMatchObject({
      p1: 'ja',
      p2: 'ja',
      p4: 'unbekannt',
      g1: 'ja',
    });
    expect(section(result, 'nichtVergleichbar')['groupMembers:g1']).toBe('1');
    expect(section(result, 'andereEintraege')['groupMembers:g1']).toBe('0');
  });

  it('counts a foreign member of g1 and a foreign group of p1 as other entries', async () => {
    const plain = await run();
    const crossed = await run({ crossMembers: true });
    const others = (run: Run, target: string): unknown =>
      section(run.result, 'andereEintraege')[target];
    expect(others(plain, 'groupMembers:g1')).toBe('0');
    expect(others(plain, 'personGroups:p1')).toBe('0');
    expect(others(crossed, 'groupMembers:g1')).toBe('1');
    expect(others(crossed, 'personGroups:p1')).toBe('1');
    expect(seen(crossed.result, 'groupMembers:g1')).toMatchObject({
      p1: 'ja',
      p2: 'ja',
      g1: 'ja',
    });
  });

  it('searches the echo of the marker only in an error, sent without the search term', async () => {
    const plain = await run();
    const lenient = await run({ lenientLimit: true });
    const markerEntry = (result: Record<string, unknown>): unknown =>
      (
        section(section(result, 'listen'), 'persons')[
          'ungueltigeWerte'
        ] as Record<string, unknown>[]
      ).find((entry) => entry['wert'] === 'Marke');
    expect(markerEntry(plain.result)).toMatchObject({
      status: 400,
      echo: { echo: 'ja', unter: ['args'] },
    });
    // The list ignores the value and answers 200 with the synthetic names.
    expect(markerEntry(lenient.result)).toMatchObject({
      status: 200,
      echo: 'nicht geprüft',
    });
    const markerCalls = plain.calls.filter(
      (call) => call.url.searchParams.get('limit') === 'Spikeprobe',
    );
    expect(markerCalls.length).toBeGreaterThan(0);
    for (const call of markerCalls) {
      // The random term of the run replaces the marker as search term.
      expect(call.url.searchParams.get('query')).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
  });

  it('takes parameters of the path item into account and leaves out a search without query', async () => {
    const document = structuredClone(personsState().specification) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const personsPath = document.paths['/persons'] ?? {};
    const listing = (personsPath['get'] ?? {}) as Record<string, unknown>;
    const parameters = listing['parameters'] as Record<string, unknown>[];
    personsPath['parameters'] = parameters.filter(
      (parameter) => parameter['name'] === 'query',
    );
    listing['parameters'] = parameters.filter(
      (parameter) => parameter['name'] !== 'query',
    );
    const searching = (document.paths['/search']?.['get'] ?? {}) as Record<
      string,
      unknown
    >;
    searching['parameters'] = (
      searching['parameters'] as Record<string, unknown>[]
    ).filter((parameter) => parameter['name'] !== 'query');
    const { code, result, calls } = await run({}, document);
    expect(code).toBe(exitCodes.ok);
    expect(section(result, 'ergebnisse')['persons:q1']).toBe(
      'erlaubt mit Einträgen',
    );
    expect(section(result, 'ergebnisse')['search:q1']).toBeUndefined();
    expect(section(result, 'listen')['search']).toBe('nicht deklariert');
    expect(calls.filter((call) => call.url.pathname === '/api/search')).toEqual(
      [],
    );
  });

  it('tells the form of meta only from a 200, for search as well', async () => {
    const plain = await run();
    expect(section(section(plain.result, 'listen'), 'search')).toEqual({
      grenze: 'nicht deklariert',
      meta: { count: 'ja', all: 'nein', pagination: 'nein' },
      ungueltigeWerte: [],
    });
    const refused = await run({ refusedLists: true });
    expect(refused.code).toBe(exitCodes.ok);
    expect(section(section(refused.result, 'listen'), 'persons')['meta']).toBe(
      'unbekannt',
    );
  });

  it('describes the first answer with entries, and the error answers of the lists', async () => {
    const { result } = await run({ emptyQuery: 'Spikeprobe' });
    const ergebnisse = section(result, 'ergebnisse');
    expect(ergebnisse['search:q1']).toBe('erlaubt leer');
    expect(ergebnisse['search:q2']).toBe('erlaubt mit Einträgen');
    expect(JSON.stringify(section(result, 'strukturen')['search'])).toContain(
      'domainType',
    );
    expect(section(result, 'fehler')['persons 400']).toMatchObject({
      antwort: { status: 400, struktur: { typ: 'Objekt' } },
      fehlerschluessel: { message: 'ja', args: 'ja', errors: 'ja' },
    });
  });

  it('names more than 50 fields of a person', async () => {
    const { result } = await run({ manyFields: true });
    const person = JSON.stringify(section(result, 'strukturen')['person']);
    expect(person).toContain('<key#60>');
    expect(person).not.toContain('weitereFelder');
  });

  it('finds the marker inside a word only where the instance does', async () => {
    const plain = await run();
    const starts = await run({ wordStartsOnly: true });
    expect(seen(plain.result, 'search:q7')).toMatchObject({
      p1: 'ja',
      p3: 'ja',
    });
    expect(seen(plain.result, 'persons:q7')['p1']).toBe('ja');
    expect(seen(plain.result, 'groups:q7')['g1']).toBe('ja');
    expect(seen(starts.result, 'search:q7')).toMatchObject({
      p1: 'nein',
      p3: 'nein',
    });
    expect(seen(starts.result, 'search:q1')['p2']).toBe('ja');
    expect(section(plain.result, 'ergebnisse')['search:q8']).toBe(
      'erlaubt leer',
    );
  });

  it('shows the hints on deprecated fields of persons, groups and memberships', async () => {
    const { result } = await run();
    const membership = {
      veraltet: 'vorhanden',
      ersetzt: [{ veraltet: 'personId', ersatz: 'person' }],
      andere: '0',
    };
    expect(result['veraltet']).toEqual({
      person: {
        veraltet: 'vorhanden',
        ersetzt: [{ veraltet: 'email', ersatz: 'guid' }],
        andere: '0',
      },
      personGroups: membership,
      group: {
        veraltet: 'vorhanden',
        ersetzt: [{ veraltet: 'identifier', ersatz: 'guid' }],
        andere: '0',
      },
      groupMembers: membership,
    });
  });

  it('shows the member of g1 outside the visible area', async () => {
    const { result } = await run();
    expect(seen(result, 'groupMembers:g1')).toEqual({
      p1: 'ja',
      p2: 'ja',
      p3: 'nein',
      p4: 'ja',
      g1: 'ja',
      g2: 'nein',
    });
    expect(section(result, 'andereEintraege')['groupMembers:g1']).toBe('0');
  });

  it('never takes a group for the record of the account', async () => {
    const onForeign = await run((setting) => ({
      groups: 'alle',
      ownId: setting.otherGroupId + 1,
    }));
    expect(
      section(onForeign.result, 'eigenerDatensatz')['groups'],
    ).toBeUndefined();
    expect(section(onForeign.result, 'andereEintraege')['groups']).toBe('1');
    const onG1 = await run((setting) => ({ ownId: setting.groupId }));
    expect(
      section(onG1.result, 'eigenerDatensatz')['group:g1-id'],
    ).toBeUndefined();
    expect(section(onG1.result, 'eigenerDatensatz')['persons']).toBe('nein');
    expect(section(onG1.result, 'eigenerDatensatz')['groupMembers:g1']).toBe(
      'nein',
    );
    const onP1 = await run((setting) => ({ ownId: setting.personId }));
    expect(section(onP1.result, 'eigenerDatensatz')['person:p1-id']).toBe('ja');
  });
});
