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
    env: setting.env,
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
  });
});
