// The guard of the test environment (ADR 0049). Every check has a test that
// makes it fail, and every failure must stop the probe before any write.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { probe as inventory } from '../../scripts/spike/00-inventory.mts';
import {
  SpikeError,
  hints,
  type HintKey,
} from '../../scripts/spike/lib/errors.mts';
import {
  autoPageTitle,
  checkInstance,
  checkWriteEnvironment,
  createWriteAccess,
  identificationCategoryName,
  passGate,
  rightsWithin,
  type GateContext,
  type GateOptions,
  type Input,
  type WriteAccess,
  type WriteSettings,
} from '../../scripts/spike/lib/gate.mts';
import { Guard } from '../../scripts/spike/lib/guard.mts';
import { createClient } from '../../scripts/spike/lib/http.mts';
import { exitCodes } from '../../scripts/spike/lib/output.mts';
import {
  runProbe,
  type ProbeDefinition,
} from '../../scripts/spike/lib/probe.mts';
import { capture, leaks, specification } from './support.mts';
import {
  initialState,
  makeGuid,
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

const createOnly: GateOptions = {
  writes: ['wikiPageCreate'],
  ownPages: new Set(),
};

/** A terminal that answers once and records the prompts. */
function terminal(answer: string | undefined): Input & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    isTerminal: true,
    readLine: (prompt) => {
      prompts.push(prompt);
      return Promise.resolve(answer);
    },
  };
}

function contextFor(
  setting: WriteSetting,
  instance: Pick<WriteInstance, 'fetch'>,
  document: unknown = specification,
): GateContext {
  return {
    client: createClient({
      origin: writeOrigin,
      token: setting.canaries.token,
      guard: new Guard(),
      fetch: instance.fetch,
    }),
    state: initialState(document),
  };
}

const settingsOf = (setting: WriteSetting): WriteSettings => ({
  writeCategory: setting.writeCategory,
  writeStatePath: setting.writeStateFile,
});

async function hintOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    if (error instanceof SpikeError) {
      return error.hint ?? error.code;
    }
    return 'no SpikeError';
  }
  return 'passed';
}

async function check(
  options: WriteInstanceOptions,
  gate: GateOptions = createOnly,
  tune: (setting: WriteSetting) => WriteSetting = (setting) => setting,
): Promise<{ hint: string; instance: WriteInstance }> {
  const setting = tune(writeSetup());
  const instance = writeInstance(setting, options);
  const hint = await hintOf(() =>
    checkInstance(
      contextFor(setting, instance, options.document),
      settingsOf(setting),
      gate,
    ),
  );
  return { hint, instance };
}

const writeMethods = (instance: WriteInstance): string[] =>
  instance.calls
    .map((call) => call.method)
    .filter((method) => method !== 'GET');

describe('checkWriteEnvironment', () => {
  const base = writeSetup().env;

  it('accepts the environment of the write account', () => {
    const settings = checkWriteEnvironment(base, writeOrigin);
    expect(settings.writeCategory).toBe(
      Number(base['ECCLIUM_SPIKE_WRITE_CATEGORY_ID']),
    );
    expect(settings.writeStatePath).toBe(
      base['ECCLIUM_SPIKE_WRITE_STATE_FILE'],
    );
    expect(
      checkWriteEnvironment(
        { ...base, ECCLIUM_SPIKE_ALLOW_WRITE: 'DEMO-TENANT' },
        writeOrigin,
      ).writeCategory,
    ).toBe(settings.writeCategory);
  });

  it.each<[string, Record<string, string | undefined>, string, HintKey]>([
    [
      'the placeholder of the README',
      {},
      'https://example.church.tools',
      'platzhalterHost',
    ],
    [
      'no switch',
      { ECCLIUM_SPIKE_ALLOW_WRITE: undefined },
      writeOrigin,
      'schalterFehlt',
    ],
    [
      'a switch for another host',
      { ECCLIUM_SPIKE_ALLOW_WRITE: 'demo' },
      writeOrigin,
      'schalterFalsch',
    ],
    [
      'the whole host as switch',
      { ECCLIUM_SPIKE_ALLOW_WRITE: 'demo-tenant.example' },
      writeOrigin,
      'schalterFalsch',
    ],
    ['a mistyped host', {}, 'https://demo-tenent.example', 'schalterFalsch'],
    [
      'the token variable of the read account',
      { ECCLIUM_SPIKE_TOKEN_FILE: '/tmp/token' },
      writeOrigin,
      'zweiTokenVariablen',
    ],
    [
      'no write area',
      { ECCLIUM_SPIKE_WRITE_CATEGORY_ID: undefined },
      writeOrigin,
      'schreibKategorieFehlt',
    ],
    [
      'a write area that is no ID',
      { ECCLIUM_SPIKE_WRITE_CATEGORY_ID: '0' },
      writeOrigin,
      'schreibKategorieFehlt',
    ],
    [
      'no write state path',
      { ECCLIUM_SPIKE_WRITE_STATE_FILE: undefined },
      writeOrigin,
      'schreibStateFehlt',
    ],
  ])('refuses %s', (_, change, origin, hint) => {
    let thrown: unknown;
    try {
      checkWriteEnvironment({ ...base, ...change }, origin);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SpikeError);
    expect((thrown as SpikeError).code).toBe('KONFIGURATION');
    expect((thrown as SpikeError).hint).toBe(hint);
  });
});

describe('rightsWithin', () => {
  const W = 11;
  const K = 22;
  type Rights = Record<string, Record<string, unknown>>;
  const narrow = (): Rights => ({
    churchwiki: {
      view: true,
      'view category': [K, W],
      'edit category': [W],
      'edit masterdata': false,
    },
    churchdb: { view: false, 'security level person': [] },
  });
  const wiki = (data: Rights, change: Record<string, unknown>): Rights => ({
    ...data,
    churchwiki: { ...data['churchwiki'], ...change },
  });

  it('accepts exactly the rights of the write account', () => {
    expect(rightsWithin(narrow(), W, K)).toBe(true);
  });

  it.each<[string, (data: Rights) => unknown]>([
    ['no churchwiki', (data) => ({ churchdb: data['churchdb'] })],
    ['view false', (data) => wiki(data, { view: false })],
    [
      'only the write area visible',
      (data) => wiki(data, { 'view category': [W] }),
    ],
    [
      'a third category visible',
      (data) => wiki(data, { 'view category': [W, K, 33] }),
    ],
    [
      'the identification category editable',
      (data) => wiki(data, { 'edit category': [W, K] }),
    ],
    ['no editable category', (data) => wiki(data, { 'edit category': [] })],
    [
      'an ID given as text',
      (data) => wiki(data, { 'edit category': [String(W)] }),
    ],
    ['an ID twice', (data) => wiki(data, { 'view category': [W, K, W] })],
    [
      'a negative ID, as «alle» could be written',
      (data) => wiki(data, { 'view category': [W, K, -1] }),
    ],
    ['edit masterdata true', (data) => wiki(data, { 'edit masterdata': true })],
    ['an unknown wiki right', (data) => wiki(data, { 'delete category': [W] })],
    [
      'a right in another module',
      (data) => ({ ...data, churchdb: { view: true } }),
    ],
    [
      'a list in another module',
      (data) => ({ ...data, churchcal: { 'view category': [1] } }),
    ],
    ['a number as a right', (data) => ({ ...data, churchdb: { view: 0 } })],
    ['text as a right', (data) => ({ ...data, churchdb: { view: 'false' } })],
    ['null as a right', (data) => ({ ...data, churchdb: { view: null } })],
    ['an object as a right', (data) => ({ ...data, churchdb: { view: {} } })],
    ['a module that is no object', (data) => ({ ...data, churchdb: true })],
    ['no object at all', (data) => [data]],
  ])('refuses %s', (_, change) => {
    expect(rightsWithin(change(narrow()), W, K)).toBe(false);
  });
});

describe('checkInstance', () => {
  it('passes the narrow write account on the test instance', async () => {
    const setting = writeSetup();
    const instance = writeInstance(setting);
    const result = await checkInstance(
      contextFor(setting, instance),
      settingsOf(setting),
      createOnly,
    );
    expect(result.identification).toBe(setting.identification);
    expect(result.writeCategory).toBe(setting.writeCategory);
    expect(result.pages.map((page) => page.title)).toEqual([autoPageTitle]);
    expect(
      instance.calls.map((call) => `${call.method} ${call.url.pathname}`),
    ).toEqual([
      'GET /api/wiki/categories',
      'GET /api/permissions/global',
      `GET /api/wiki/categories/${String(setting.writeCategory)}/pages`,
    ]);
  });

  it('passes own pages of the run, but no other page', async () => {
    const own = makeGuid();
    const page = {
      guid: own,
      title: 'spike-schreibprobe-00000000-1',
      onStartpage: false,
      versions: [
        {
          version: 1,
          text: 'x',
          isMarkdown: true,
          modifiedDate: '2026-01-01T00:00:00Z',
        },
      ],
    };
    expect(
      (
        await check(
          { extraPages: [page] },
          { writes: [], ownPages: new Set([own]) },
        )
      ).hint,
    ).toBe('passed');
    expect((await check({ extraPages: [page] })).hint).toBe('fremdeSeiten');
    expect(
      (
        await check({
          extraPages: [{ ...page, title: autoPageTitle }],
        })
      ).hint,
    ).toBe('fremdeSeiten');
  });

  const category = (
    id: number,
    name: string,
    canEdit: boolean,
    canDelete = false,
  ): Record<string, unknown> => ({
    id,
    name,
    nameTranslated: name,
    permissions: { canEdit, canDelete },
  });
  const list = (...entries: unknown[]): Record<string, unknown> => ({
    data: entries,
    meta: { count: entries.length },
    permissions: { editMasterData: false },
  });
  const K = (s: WriteSetting, canEdit = false, canDelete = false) =>
    category(s.identification, identificationCategoryName, canEdit, canDelete);
  const W = (s: WriteSetting, canEdit = true) =>
    category(s.writeCategory, 'x', canEdit);

  it.each<[string, (s: WriteSetting) => WriteInstanceOptions, HintKey]>([
    [
      'no identification category',
      (s) => ({ categories: list(W(s)) }),
      'kennkategorieFehlt',
    ],
    [
      'the identification name in another case',
      (s) => ({
        categories: list(
          category(
            s.identification,
            identificationCategoryName.toUpperCase(),
            false,
          ),
          W(s),
        ),
      }),
      'kennkategorieFehlt',
    ],
    [
      'two identification categories',
      (s) => ({
        categories: list(
          K(s),
          category(s.identification + 1, identificationCategoryName, false),
          W(s),
        ),
      }),
      'kennkategorieMehrfach',
    ],
    [
      'an editable identification category',
      (s) => ({ categories: list(K(s, true), W(s)) }),
      'kennkategorieBearbeitbar',
    ],
    [
      'a deletable identification category',
      (s) => ({ categories: list(K(s, false, true), W(s)) }),
      'kennkategorieBearbeitbar',
    ],
    [
      'a write area that is not visible',
      (s) => ({ categories: list(K(s)) }),
      'schreibKategorieNichtSichtbar',
    ],
    [
      'a write area that is not editable',
      (s) => ({ categories: list(K(s), W(s, false)) }),
      'schreibKategorieNichtBearbeitbar',
    ],
    [
      'a third visible category',
      (s) => ({
        categories: list(K(s), W(s), category(s.writeCategory + 7, 'y', false)),
      }),
      'weitereKategorien',
    ],
    [
      'the right to edit master data',
      (s) => ({
        categories: {
          ...list(K(s), W(s)),
          permissions: { editMasterData: true },
        },
      }),
      'zuWeitBerechtigt',
    ],
    [
      'a category without canEdit',
      (s) => ({
        categories: list({ ...K(s), permissions: { canDelete: false } }, W(s)),
      }),
      'waechterAntwortUnerwartet',
    ],
    [
      'a category list without editMasterData',
      (s) => ({ categories: { data: [K(s), W(s)] } }),
      'waechterAntwortUnerwartet',
    ],
    [
      'a category ID that is text',
      (s) => ({
        categories: list({ ...K(s), id: String(s.identification) }, W(s)),
      }),
      'waechterAntwortUnerwartet',
    ],
    [
      'a category list that is refused',
      () => ({ categoriesStatus: 403 }),
      'waechterAntwortUnerwartet',
    ],
    [
      'too wide rights',
      (s) => ({
        rights: {
          data: {
            churchwiki: {
              view: true,
              'view category': [s.writeCategory, s.identification],
              'edit category': [s.writeCategory],
            },
            churchcore: { 'administer settings': true },
          },
        },
      }),
      'zuWeitBerechtigt',
    ],
    [
      'rights without data',
      () => ({ rights: { churchwiki: {} } }),
      'waechterAntwortUnerwartet',
    ],
  ])('refuses %s', async (_, options, hint) => {
    const setting = writeSetup();
    const instance = writeInstance(setting, options(setting));
    expect(
      await hintOf(() =>
        checkInstance(
          contextFor(setting, instance),
          settingsOf(setting),
          createOnly,
        ),
      ),
    ).toBe(hint);
    expect(writeMethods(instance)).toEqual([]);
  });

  const narrowRights = (s: WriteSetting): unknown => ({
    data: {
      churchwiki: {
        view: true,
        'view category': [s.writeCategory, s.identification],
        'edit category': [s.writeCategory],
        'edit masterdata': false,
      },
    },
  });

  it.each<[string, (s: WriteSetting) => WriteInstanceOptions]>([
    [
      'narrow rights answered with 403',
      (s) => ({ rights: narrowRights(s), rightsStatus: 403 }),
    ],
    [
      'narrow rights answered as text',
      (s) => ({ rights: narrowRights(s), rightsAsText: true }),
    ],
    ['rights without a data object', () => ({ rights: { data: [] } })],
    ['a page list answered with 403', () => ({ pagesStatus: 403 })],
    ['a page list answered with 500', () => ({ pagesStatus: 500 })],
    ['a page list without data', () => ({ pageList: () => ({ meta: {} }) })],
    [
      'a page list without its count',
      () => ({ pageList: (entries) => ({ data: entries }) }),
    ],
    [
      'a page whose GUID has another form',
      () => ({
        pageList: (entries) => ({
          data: entries.map((entry) => ({ ...entry, guid: 'main' })),
          meta: { count: entries.length },
        }),
      }),
    ],
    [
      'a page without a title',
      () => ({
        pageList: (entries) => ({
          data: entries.map((entry) =>
            Object.fromEntries(
              Object.entries(entry).filter(([key]) => key !== 'title'),
            ),
          ),
          meta: { count: entries.length },
        }),
      }),
    ],
  ])('stops on %s, as on an answer it cannot check', async (_, options) => {
    const setting = writeSetup();
    const instance = writeInstance(setting, options(setting));
    expect(
      await hintOf(() =>
        checkInstance(
          contextFor(setting, instance),
          settingsOf(setting),
          createOnly,
        ),
      ),
    ).toBe('waechterAntwortUnerwartet');
    expect(writeMethods(instance)).toEqual([]);
  });

  it('counts a page with the titles of the run as its own, but no other', async () => {
    const page = {
      guid: makeGuid(),
      title: 'spike-schreibprobe-0a1b2c3d-2',
      onStartpage: false,
      versions: [
        {
          version: 1,
          text: 'x',
          isMarkdown: true,
          modifiedDate: '2026-01-01T00:00:00Z',
        },
      ],
    };
    const ownTitles = 'spike-schreibprobe-0a1b2c3d-';
    expect(
      (
        await check(
          { extraPages: [page] },
          { writes: [], ownPages: new Set(), ownTitles },
        )
      ).hint,
    ).toBe('passed');
    expect(
      (
        await check(
          { extraPages: [{ ...page, title: 'spike-schreibprobe-ffffffff-2' }] },
          { writes: [], ownPages: new Set(), ownTitles },
        )
      ).hint,
    ).toBe('fremdeSeiten');
  });

  it('refuses a write area that is the identification category', async () => {
    const { hint } = await check({}, createOnly, (setting) => ({
      ...setting,
      writeCategory: setting.identification,
    }));
    expect(hint).toBe('schreibKategorieIstKennung');
  });

  it('refuses an instance that does not document an operation it needs, before any request', async () => {
    const { paths } = specification;
    for (const removed of [
      '/wiki/categories',
      '/permissions/global',
      '/wiki/categories/{categoryId}/pages',
    ]) {
      const document = {
        ...specification,
        paths: Object.fromEntries(
          Object.entries(paths).filter(([path]) => path !== removed),
        ),
      };
      const { hint, instance } = await check({ document });
      expect(hint, removed).toBe('waechterOperationFehlt');
      expect(instance.calls, removed).toEqual([]);
    }
    const page = paths['/wiki/categories/{categoryId}/pages/{identifier}'];
    const withoutDelete = {
      ...specification,
      paths: {
        ...paths,
        '/wiki/categories/{categoryId}/pages/{identifier}': {
          get: page.get,
          patch: page.patch,
        },
      },
    };
    const { hint, instance } = await check(
      { document: withoutDelete },
      { writes: ['wikiPageDelete'], ownPages: new Set() },
    );
    expect(hint).toBe('waechterOperationFehlt');
    expect(instance.calls).toEqual([]);
  });

  it('needs the documented page list, even if the create on the same path is documented', async () => {
    const pagesPath =
      specification.paths['/wiki/categories/{categoryId}/pages'];
    const document = {
      ...specification,
      paths: {
        ...specification.paths,
        '/wiki/categories/{categoryId}/pages': { post: pagesPath.post },
      },
    };
    const { hint, instance } = await check({ document });
    expect(hint).toBe('waechterOperationFehlt');
    expect(instance.calls).toEqual([]);
  });

  it('stops on a category list whose data is no list', async () => {
    const { hint, instance } = await check({
      categories: {
        data: {},
        meta: { count: 0 },
        permissions: { editMasterData: false },
      },
    });
    expect(hint).toBe('waechterAntwortUnerwartet');
    expect(writeMethods(instance)).toEqual([]);
  });

  it('refuses a page list whose count is larger than the list', async () => {
    const setting = writeSetup();
    const instance = writeInstance(setting);
    const counted = {
      fetch: async (url: URL, init: RequestInit): Promise<Response> => {
        const response = await instance.fetch(url, init);
        if (!url.pathname.endsWith('/pages')) {
          return response;
        }
        const body = (await response.json()) as { data: unknown[] };
        return new Response(
          JSON.stringify({ data: body.data, meta: { count: 5 } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    };
    expect(
      await hintOf(() =>
        checkInstance(
          contextFor(setting, counted),
          settingsOf(setting),
          createOnly,
        ),
      ),
    ).toBe('waechterAntwortUnerwartet');
  });
});

describe('passGate', () => {
  async function run(
    input: Input,
    forged?: WriteAccess,
  ): Promise<{ hint: string; instance: WriteInstance }> {
    const setting = writeSetup();
    const instance = writeInstance(setting);
    const access =
      forged ??
      createWriteAccess(
        {
          origin: writeOrigin,
          token: setting.canaries.token,
          guard: new Guard(),
          fetch: instance.fetch,
        },
        input,
      );
    const hint = await hintOf(async () => {
      const { writer } = await passGate(
        contextFor(setting, instance),
        access,
        settingsOf(setting),
        { ...createOnly, summary: 'Zusammenfassung' },
      );
      await writer.send({
        operation: 'wikiPageCreate',
        parameters: [setting.writeCategory],
        body: { title: 'spike-schreibprobe-x', isMarkdown: true },
      });
    });
    return { hint, instance };
  }

  it('hands out the write client only after «ja» at a terminal', async () => {
    const input = terminal('ja');
    const { hint, instance } = await run(input);
    expect(hint).toBe('passed');
    expect(writeMethods(instance)).toEqual(['POST']);
    expect(input.prompts).toHaveLength(1);
    expect(input.prompts[0]).toContain('Zusammenfassung');
    expect(input.prompts[0]).toContain('«ja»');
  });

  it('refuses without a terminal, before any request', async () => {
    const { hint, instance } = await run({
      isTerminal: false,
      readLine: () => Promise.resolve('ja'),
    });
    expect(hint).toBe('keinTerminal');
    expect(instance.calls).toEqual([]);
  });

  it.each([['nein'], ['Ja'], ['ja '], [''], [undefined]])(
    'writes nothing after the answer %j',
    async (answer) => {
      const { hint, instance } = await run(terminal(answer));
      expect(hint).toBe('nichtBestaetigt');
      expect(writeMethods(instance)).toEqual([]);
    },
  );

  it('opens no client for a handle the common course did not create', async () => {
    const forged: WriteAccess = Object.freeze({ kind: 'Schreibkonto' });
    const { hint, instance } = await run(terminal('ja'), forged);
    expect(hint).toBe('INTERN');
    expect(instance.calls).toEqual([]);
  });
});

describe('the write account in the common course', () => {
  const writingProbe: ProbeDefinition = {
    name: 'test-write',
    state: 'read',
    account: 'write',
    async run({ client, guard, state, write }) {
      if (state === undefined || write === undefined) {
        throw new Error('INTERN');
      }
      const { writer, result } = await passGate(
        { client, state },
        write.access,
        write.settings,
        { ...createOnly, summary: 'Test' },
      );
      const created = await writer.send({
        operation: 'wikiPageCreate',
        parameters: [result.writeCategory],
        body: { title: 'spike-schreibprobe-y' },
      });
      guard.allowFixed('status', created.status);
      return { status: created.status };
    },
  };

  async function prepared(): Promise<{
    setting: WriteSetting;
    instance: WriteInstance;
  }> {
    const setting = writeSetup();
    const instance = writeInstance(setting);
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

  async function runWith(
    instance: WriteInstance,
    env: Readonly<Record<string, string | undefined>>,
    input?: Input,
  ): Promise<{ code: number; output: ReturnType<typeof capture> }> {
    const output = capture();
    const code = await runProbe(writingProbe, {
      env,
      fetch: instance.fetch,
      io: output.io,
      folder: spikeFolder,
      ...(input === undefined ? {} : { input }),
    });
    return { code, output };
  }

  it('reads the token from its own variable, passes the guard and writes, without leaking anything', async () => {
    const { setting, instance } = await prepared();
    const { code, output } = await runWith(
      instance,
      setting.env,
      terminal('ja'),
    );
    expect(code, output.stderr()).toBe(exitCodes.ok);
    expect(writeMethods(instance)).toEqual(['POST']);
    for (const call of instance.calls) {
      expect(call.headers.get('authorization')).toBe(
        `Login ${setting.canaries.token}`,
      );
    }
    expect(leaks(output, setting.forbidden)).toEqual([]);
  });

  it.each<[string, Record<string, string | undefined>, HintKey]>([
    [
      'without switch',
      { ECCLIUM_SPIKE_ALLOW_WRITE: undefined },
      'schalterFehlt',
    ],
    [
      'with a wrong switch',
      { ECCLIUM_SPIKE_ALLOW_WRITE: 'example' },
      'schalterFalsch',
    ],
    [
      'with the token variable of the read account',
      { ECCLIUM_SPIKE_TOKEN_FILE: 'x' },
      'zweiTokenVariablen',
    ],
    [
      'without its own token variable',
      { ECCLIUM_SPIKE_WRITE_TOKEN_FILE: undefined },
      'schreibTokenDateiFehlt',
    ],
    [
      'with the placeholder of the README',
      { ECCLIUM_SPIKE_BASE_URL: 'https://example.church.tools' },
      'platzhalterHost',
    ],
  ])('stops %s before any request', async (_, change, hint) => {
    const { setting, instance } = await prepared();
    const { code, output } = await runWith(
      instance,
      { ...setting.env, ...change },
      terminal('ja'),
    );
    expect(code).toBe(exitCodes.configuration);
    expect(output.stderr()).toContain(hints[hint]);
    expect(output.stdout()).toBe('');
    expect(instance.calls).toEqual([]);
  });

  it('confirms nothing without an input, so nothing is sent', async () => {
    const { setting, instance } = await prepared();
    const { code, output } = await runWith(instance, setting.env);
    expect(code).toBe(exitCodes.configuration);
    expect(output.stderr()).toContain(hints.keinTerminal);
    expect(instance.calls).toEqual([]);
  });
});

describe('the write client', () => {
  it('is created only by the guard', () => {
    const users = readdirSync(spikeFolder, {
      recursive: true,
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.mts'))
      .map((entry) => join(entry.parentPath, entry.name))
      .filter((file) =>
        readFileSync(file, 'utf8').includes('createWriteClient'),
      )
      .map((file) => file.slice(spikeFolder.length))
      .sort();
    expect(users).toEqual(['lib/gate.mts', 'lib/http.mts']);
  });
});
