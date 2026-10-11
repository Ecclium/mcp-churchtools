// The guard for personal data, against a synthetic instance. It must stop
// before the first request with personal data whenever the instance or the
// account is not the narrow one of the test instance, and the client that
// reaches persons must exist only behind it.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createState, readObjectId } from '../../scripts/spike/lib/env.mts';
import { SpikeError, hints } from '../../scripts/spike/lib/errors.mts';
import { identificationCategoryName } from '../../scripts/spike/lib/gate.mts';
import { Guard } from '../../scripts/spike/lib/guard.mts';
import {
  createClient,
  createGateClient,
  createPersonsClient,
  isPersonalPath,
  type Client,
} from '../../scripts/spike/lib/http.mts';
import { operations } from '../../scripts/spike/lib/operations.mts';
import { exitCodes } from '../../scripts/spike/lib/output.mts';
import {
  checkPersonsEnvironment,
  createPersonsAccess,
  passPersonsGate,
  personsRightsWithin,
  type PersonsAccess,
} from '../../scripts/spike/lib/persons-gate.mts';
import {
  runProbe,
  type ProbeDefinition,
} from '../../scripts/spike/lib/probe.mts';
import { capture } from './support.mts';
import {
  narrowRights,
  personsInstance,
  personsOrigin,
  personsSetup,
  personsState,
  type PersonsInstance,
  type PersonsInstanceOptions,
  type PersonsSetting,
} from './persons-support.mts';

const spikeFolder = fileURLToPath(
  new URL('../../scripts/spike/', import.meta.url),
);

const gatePaths = ['/api/wiki/categories', '/api/permissions/global'];

const personalPaths = (calls: PersonsInstance['calls']): string[] =>
  calls.map((call) => call.url.pathname).filter((path) => isPersonalPath(path));

const codeOf = async (action: () => Promise<unknown>): Promise<string> => {
  try {
    await action();
  } catch (error) {
    return error instanceof SpikeError
      ? `${error.code} ${error.hint ?? ''}`.trim()
      : 'no SpikeError';
  }
  return 'no error';
};

function options(setting: PersonsSetting, instance: PersonsInstance) {
  return {
    origin: personsOrigin,
    token: setting.canaries.token,
    guard: new Guard(),
    fetch: instance.fetch,
  };
}

async function gate(
  instanceOptions: PersonsInstanceOptions = {},
  access?: PersonsAccess,
): Promise<{
  readonly code: string;
  readonly instance: PersonsInstance;
  readonly client: Client | undefined;
}> {
  const setting = personsSetup();
  const instance = personsInstance(setting, instanceOptions);
  const clientOptions = options(setting, instance);
  let client: Client | undefined;
  const code = await codeOf(async () => {
    const pass = await passPersonsGate(
      { state: personsState(instanceOptions.document) },
      access ?? createPersonsAccess(clientOptions),
    );
    client = pass.client;
  });
  return { code, instance, client };
}

describe('the paths with personal data', () => {
  it.each([
    '/api/persons',
    '/api/persons/7',
    '/api/persons/7/devices',
    '/API/Persons',
    '/api//persons',
    '/api/%70ersons',
    '/api/persons.json',
    '/api/groups/1/members',
    '/api/search',
    '/api/%E0%A4%A',
  ])('count %s as personal', (path) => {
    expect(isPersonalPath(path)).toBe(true);
  });

  it('cover exactly the operations marked personal', () => {
    for (const operation of Object.values(operations)) {
      const path = operation.template.replaceAll('{}', '1');
      expect(isPersonalPath(path)).toBe('personal' in operation);
    }
  });

  it.each(['/api/whoami', '/api/wiki/pages', '/api/groupsx', '/api/info'])(
    'do not count %s',
    (path) => {
      expect(isPersonalPath(path)).toBe(false);
    },
  );
});

describe('the reach of the clients', () => {
  const setting = personsSetup();

  it('refuses personal paths in the general client, before any request', async () => {
    const instance = personsInstance(setting);
    const client = createClient(options(setting, instance));
    for (const path of ['/api/persons', '/api/GROUPS/1', '/api//search']) {
      expect(await codeOf(() => client.get({ path }))).toBe('INTERN');
    }
    expect(instance.calls).toEqual([]);
    expect((await client.get({ path: '/api/whoami' })).status).toBe(200);
  });

  it.each([
    '/api/wiki%2F..%2Fpersons',
    '/api/wiki%2f%2e%2e%2fpersons',
    '/api;x/persons',
    '/api/%2570ersons',
    '/api/wiki%5C..%5Cpersons',
    '/api/wiki/.well-known',
  ])('refuses %s in every client, before any request', async (path) => {
    const instance = personsInstance(setting);
    const clientOptions = options(setting, instance);
    for (const client of [
      createClient(clientOptions),
      createGateClient(clientOptions, [path]),
      createPersonsClient(clientOptions),
    ]) {
      expect(await codeOf(() => client.get({ path }))).toBe('INTERN');
    }
    expect(instance.calls).toEqual([]);
  });

  it('lets the gate client reach only the two reads of the guard', async () => {
    const instance = personsInstance(setting);
    const client = createGateClient(options(setting, instance), gatePaths);
    for (const path of ['/api/whoami', '/api/persons', '/api/wiki/pages']) {
      expect(await codeOf(() => client.get({ path }))).toBe('INTERN');
    }
    expect(instance.calls).toEqual([]);
    for (const path of gatePaths) {
      expect((await client.get({ path })).status).toBe(200);
    }
  });

  it('lets the client for personal data reach persons, groups and search', async () => {
    const instance = personsInstance(setting);
    const client = createPersonsClient(options(setting, instance));
    for (const path of ['/api/persons', '/api/groups/1', '/api/search']) {
      await client.get({ path });
    }
    expect(instance.calls.map((call) => call.url.pathname)).toEqual([
      '/api/persons',
      '/api/groups/1',
      '/api/search',
    ]);
  });

  it('is created only by the guard for personal data', () => {
    const users = readdirSync(spikeFolder, {
      recursive: true,
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.mts'))
      .map((entry) => join(entry.parentPath, entry.name))
      .filter((file) =>
        readFileSync(file, 'utf8').includes('createPersonsClient'),
      )
      .map((file) => file.slice(spikeFolder.length))
      .sort();
    expect(users).toEqual(['lib/http.mts', 'lib/persons-gate.mts']);
  });
});

describe('the environment of the probe that reads persons', () => {
  const { env } = personsSetup();
  const refused = (changes: Record<string, string | undefined>): string => {
    try {
      checkPersonsEnvironment({ ...env, ...changes }, personsOrigin);
    } catch (error) {
      return error instanceof SpikeError ? (error.hint ?? '') : 'other';
    }
    return 'accepted';
  };

  it('accepts the switch of the host and three IDs', () => {
    expect(refused({})).toBe('accepted');
  });

  it.each([
    [{ ECCLIUM_SPIKE_ALLOW_PERSONS: undefined }, 'personenSchalterFehlt'],
    [{ ECCLIUM_SPIKE_ALLOW_PERSONS: 'andere' }, 'personenSchalterFalsch'],
    [
      {
        ECCLIUM_SPIKE_ALLOW_WRITE: 'demo-tenant',
        ECCLIUM_SPIKE_ALLOW_PERSONS: '',
      },
      'personenSchalterFehlt',
    ],
    [{ ECCLIUM_SPIKE_PERSON_ID: undefined }, 'personIdFehlt'],
    [{ ECCLIUM_SPIKE_PERSON_ID: '0' }, 'personIdFehlt'],
    [{ ECCLIUM_SPIKE_GROUP_ID: '-3' }, 'gruppenIdFehlt'],
    [{ ECCLIUM_SPIKE_OTHER_GROUP_ID: 'x' }, 'andereGruppenIdFehlt'],
    [
      { ECCLIUM_SPIKE_OTHER_GROUP_ID: env['ECCLIUM_SPIKE_GROUP_ID'] },
      'gruppenGleich',
    ],
  ])('refuses %o with %s', (changes, hint) => {
    expect(refused(changes)).toBe(hint);
  });

  it('refuses the placeholder of the README', () => {
    expect(() =>
      checkPersonsEnvironment(
        { ...env, ECCLIUM_SPIKE_ALLOW_PERSONS: 'example' },
        'https://example.church.tools',
      ),
    ).toThrow(expect.objectContaining({ hint: 'platzhalterHost' }) as Error);
  });

  it('reads IDs of at most ten digits only', () => {
    expect(
      readObjectId(
        { ECCLIUM_SPIKE_PERSON_ID: '9999999999' },
        'ECCLIUM_SPIKE_PERSON_ID',
      ),
    ).toBe(9_999_999_999);
    expect(() =>
      readObjectId(
        { ECCLIUM_SPIKE_PERSON_ID: '12345678901' },
        'ECCLIUM_SPIKE_PERSON_ID',
      ),
    ).toThrow(SpikeError);
  });
});

describe('the rights the guard for personal data accepts', () => {
  const identification = 4242;

  it('accepts the wiki, the identification category and no other right', () => {
    expect(
      personsRightsWithin(narrowRights(identification), identification),
    ).toBe(true);
  });

  it.each([true, [-1], [0], ['alle'], [{}], 'alle', -1, {}, null, [7, 8]])(
    'accepts any value %o on a read right, since the probe asks how it looks',
    (value) => {
      expect(
        personsRightsWithin(
          narrowRights(identification, { 'view groups of grouptype': value }),
          identification,
        ),
      ).toBe(true);
    },
  );

  it.each([true, [-1], ['alle'], 'alle', 1, {}])(
    'refuses the value %o on a right outside the read list',
    (value) => {
      expect(
        personsRightsWithin(
          narrowRights(identification, { 'view hidden persons': value }),
          identification,
        ),
      ).toBe(false);
    },
  );

  it('refuses a right without a name of the product', () => {
    expect(
      personsRightsWithin(
        narrowRights(identification, { '<odd>': true }),
        identification,
      ),
    ).toBe(false);
  });

  it('keeps the wiki narrow', () => {
    const rights = narrowRights(identification);
    const wiki = rights['churchwiki'] ?? {};
    for (const change of [
      { view: false },
      { 'view category': [identification, identification + 1] },
      { 'view category': [] },
      { 'edit category': [identification] },
      { 'edit masterdata': true },
    ]) {
      expect(
        personsRightsWithin(
          { ...rights, churchwiki: { ...wiki, ...change } },
          identification,
        ),
      ).toBe(false);
    }
  });

  it('refuses a module or a response of another form', () => {
    expect(
      personsRightsWithin(
        { ...narrowRights(identification), churchcal: true },
        identification,
      ),
    ).toBe(false);
    expect(personsRightsWithin([], identification)).toBe(false);
  });
});

describe('the guard for personal data', () => {
  it('hands out the client for personal data after its two reads', async () => {
    const { code, instance, client } = await gate();
    expect(code).toBe('no error');
    expect(instance.calls.map((call) => call.url.pathname)).toEqual(gatePaths);
    expect(client).toBeDefined();
  });

  it.each<[string, (setting: PersonsSetting) => PersonsInstanceOptions]>([
    [
      'personenWeitereKategorien',
      ({ identification }) => ({
        categories: {
          data: [
            {
              id: identification,
              name: identificationCategoryName,
              permissions: { canEdit: false, canDelete: false },
            },
            {
              id: identification + 1,
              name: 'andere',
              permissions: { canEdit: false, canDelete: false },
            },
          ],
          permissions: { editMasterData: false },
        },
      }),
    ],
    [
      'personenKennkategorieFehlt',
      ({ identification }) => ({
        categories: {
          data: [
            {
              id: identification,
              name: 'andere',
              permissions: { canEdit: false, canDelete: false },
            },
          ],
          permissions: { editMasterData: false },
        },
      }),
    ],
    [
      'personenKennkategorieBearbeitbar',
      ({ identification }) => ({
        categories: {
          data: [
            {
              id: identification,
              name: identificationCategoryName,
              permissions: { canEdit: true, canDelete: false },
            },
          ],
          permissions: { editMasterData: false },
        },
      }),
    ],
    [
      'personenZuWeitBerechtigt',
      ({ identification }) => ({
        categories: {
          data: [
            {
              id: identification,
              name: identificationCategoryName,
              permissions: { canEdit: false, canDelete: false },
            },
          ],
          permissions: { editMasterData: true },
        },
      }),
    ],
    [
      'personenZuWeitBerechtigt',
      ({ identification }) => ({
        rights: narrowRights(identification, { 'view archive': true }),
      }),
    ],
    ['personenWaechterAntwortUnerwartet', () => ({ categories: { data: {} } })],
    ['personenWaechterAntwortUnerwartet', () => ({ rights: [] })],
    ['personenWaechterAntwortUnerwartet', () => ({ rightsStatus: 403 })],
  ])('stops with %s and reads no personal data', async (hint, make) => {
    const setting = personsSetup();
    const instance = personsInstance(setting, make(setting));
    const clientOptions = options(setting, instance);
    const code = await codeOf(() =>
      passPersonsGate(
        { state: personsState() },
        createPersonsAccess(clientOptions),
      ),
    );
    expect(code).toBe(`KONFIGURATION ${hint}`);
    expect(personalPaths(instance.calls)).toEqual([]);
  });

  it('stops before any request when the instance does not document a read of the guard', async () => {
    const document = structuredClone(personsState().specification) as {
      paths: Record<string, unknown>;
    };
    delete document.paths['/permissions/global'];
    const { code, instance } = await gate({ document });
    expect(code).toBe('KONFIGURATION personenWaechterOperationFehlt');
    expect(instance.calls).toEqual([]);
  });

  it('checks the answers of the instance of its handle, not those of a client it is handed', async () => {
    const setting = personsSetup();
    const instance = personsInstance(setting, {
      rights: narrowRights(setting.identification, { 'view archive': true }),
    });
    const narrow = personsInstance(setting);
    const context = {
      state: personsState(),
      client: createGateClient(options(setting, narrow), gatePaths),
    };
    const code = await codeOf(() =>
      passPersonsGate(context, createPersonsAccess(options(setting, instance))),
    );
    expect(code).toBe('KONFIGURATION personenZuWeitBerechtigt');
    expect(narrow.calls).toEqual([]);
    expect(instance.calls.map((call) => call.url.pathname)).toEqual(gatePaths);
  });

  it('refuses a handle it did not create, before any request', async () => {
    const forged: PersonsAccess = Object.freeze({ kind: 'Personendaten' });
    const { code, instance } = await gate({}, forged);
    expect(code).toBe('INTERN');
    expect(instance.calls).toEqual([]);
  });
});

describe('a probe that reads personal data', () => {
  async function run(
    definition: ProbeDefinition,
    changes: Record<string, string | undefined> = {},
  ): Promise<{
    readonly code: number;
    readonly instance: PersonsInstance;
    readonly stderr: string;
  }> {
    const setting = personsSetup();
    createState(setting.stateFile, personsState());
    const instance = personsInstance(setting);
    const output = capture();
    const code = await runProbe(definition, {
      env: { ...setting.env, ...changes },
      fetch: instance.fetch,
      io: output.io,
      folder: spikeFolder,
    });
    return { code, instance, stderr: output.stderr() };
  }

  it('cannot read persons before the guard has passed', async () => {
    const early: ProbeDefinition = {
      name: 'frueh',
      state: 'read',
      personalData: true,
      async run({ client }) {
        await client.get({ path: '/api/persons' });
        return {};
      },
    };
    const { code, instance } = await run(early);
    expect(code).toBe(exitCodes.internal);
    expect(instance.calls).toEqual([]);
  });

  it('reaches nothing but the two reads of the guard before it has passed', async () => {
    const early: ProbeDefinition = {
      name: 'frueh-whoami',
      state: 'read',
      personalData: true,
      async run({ client }) {
        await client.get({ path: '/api/whoami' });
        return {};
      },
    };
    const { code, instance } = await run(early);
    expect(code).toBe(exitCodes.internal);
    expect(instance.calls).toEqual([]);
  });

  it('reads persons only through the client of the guard', async () => {
    const proper: ProbeDefinition = {
      name: 'richtig',
      state: 'read',
      personalData: true,
      async run({ persons, state }) {
        if (persons === undefined || state === undefined) {
          throw new Error('INTERN');
        }
        const pass = await passPersonsGate({ state }, persons.access);
        await pass.client.get({ path: '/api/persons' });
        return {};
      },
    };
    const { code, instance } = await run(proper);
    expect(code).toBe(exitCodes.ok);
    expect(instance.calls.map((call) => call.url.pathname)).toEqual([
      ...gatePaths,
      '/api/persons',
    ]);
  });

  it('sends nothing without the switch', async () => {
    const probe: ProbeDefinition = {
      name: 'ohne-schalter',
      state: 'read',
      personalData: true,
      run: () => Promise.resolve({}),
    };
    const { code, instance, stderr } = await run(probe, {
      ECCLIUM_SPIKE_ALLOW_PERSONS: undefined,
    });
    expect(code).toBe(exitCodes.configuration);
    expect(stderr).toContain(hints.personenSchalterFehlt);
    expect(instance.calls).toEqual([]);
  });

  it('cannot run with the write account at the same time', async () => {
    const both: ProbeDefinition = {
      name: 'beides',
      state: 'read',
      account: 'write',
      personalData: true,
      run: () => Promise.resolve({}),
    };
    const { code, instance } = await run(both);
    expect(code).toBe(exitCodes.internal);
    expect(instance.calls).toEqual([]);
  });
});
