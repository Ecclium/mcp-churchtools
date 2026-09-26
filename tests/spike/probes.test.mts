// Runs the five probes against a synthetic instance whose answers are full
// of canary values (see tests/fixtures/README.md). The probes must print
// the structure of every answer and none of its values, send only GET
// requests to the one origin, and stop before the first request when their
// environment is incomplete.
import { randomInt } from 'node:crypto';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  probe as inventory,
  versionOf,
} from '../../scripts/spike/00-inventory.mts';
import { probe as auth } from '../../scripts/spike/01-auth.mts';
import { probe as permissions } from '../../scripts/spike/02-permissions.mts';
import { probe as pagination } from '../../scripts/spike/03-pagination-errors.mts';
import {
  pageId,
  probe as wikiRead,
} from '../../scripts/spike/04-wiki-read.mts';
import type { Environment } from '../../scripts/spike/lib/env.mts';
import { hints } from '../../scripts/spike/lib/errors.mts';
import type { FetchFunction } from '../../scripts/spike/lib/http.mts';
import { exitCodes } from '../../scripts/spike/lib/output.mts';
import {
  runProbe,
  type ProbeDefinition,
} from '../../scripts/spike/lib/probe.mts';
import {
  capture,
  forbiddenTexts,
  leaks,
  makeCanaries,
  origin,
  privateFiles,
  specification,
  type Canaries,
  type Capture,
} from './support.mts';

const spikeFolder = fileURLToPath(
  new URL('../../scripts/spike/', import.meta.url),
);

const probes = [inventory, auth, permissions, pagination, wikiRead] as const;

/** The number of versions of every synthetic page. */
const versionCount = 3;
/** The largest `limit` the synthetic instance accepts. */
const maxLimit = 200;

/** One request the synthetic instance received. */
interface Call {
  readonly method: string;
  readonly url: URL;
  readonly authorization: string | null;
}

/** A synthetic instance: a fetch function and the requests it received. */
interface Instance {
  readonly fetch: FetchFunction;
  readonly calls: Call[];
}

/** Everything one test needs. */
interface Setup {
  readonly canaries: Canaries;
  readonly category: number;
  readonly forbiddenCategory: number;
  readonly env: Environment;
  readonly stateFile: string;
  readonly forbidden: readonly string[];
}

function setup(): Setup {
  const canaries = makeCanaries();
  const category = randomInt(10_000, 50_000);
  const forbiddenCategory = category + 1;
  const files = privateFiles(canaries.token);
  return {
    canaries,
    category,
    forbiddenCategory,
    stateFile: files.stateFile,
    env: {
      ECCLIUM_SPIKE_BASE_URL: origin,
      ECCLIUM_SPIKE_TOKEN_FILE: files.tokenFile,
      ECCLIUM_SPIKE_STATE_FILE: files.stateFile,
      ECCLIUM_SPIKE_WIKI_CATEGORY_ID: String(category),
      ECCLIUM_SPIKE_FORBIDDEN_CATEGORY_ID: String(forbiddenCategory),
    },
    forbidden: forbiddenTexts(
      canaries,
      files.folder,
      String(category),
      String(forbiddenCategory),
    ),
  };
}

type Page = Readonly<Record<string, unknown>>;

function syntheticPages(canaries: Canaries): Page[] {
  const tag = canaries.cookieValue.slice(0, 8);
  return [
    // An identifier that would leave the path; the probes must skip it.
    { identifier: '../geheim', title: canaries.personName },
    {
      identifier: `seite-${tag}-1`,
      title: canaries.personName,
      text: canaries.personEmail,
      version: versionCount,
      isMarkdown: true,
    },
    {
      identifier: `seite-${tag}-2`,
      title: canaries.groupName,
      text: '',
      version: versionCount - 1,
      isMarkdown: false,
    },
    {
      identifier: `seite-${tag}-3`,
      title: canaries.groupName,
      text: canaries.personId,
      version: versionCount,
    },
    {
      identifier: `seite-${tag}-4`,
      title: canaries.groupName,
      text: canaries.personId,
      version: versionCount,
      isMarkdown: true,
    },
  ];
}

function defaultRights(canaries: Canaries, category: number): unknown {
  return {
    data: {
      churchwiki: {
        view: true,
        'view category': [category, canaries.number],
        [canaries.groupName]: true,
      },
      churchdb: { view: false, 'security level person': [1, 2] },
      [String(canaries.number)]: { admin: true },
    },
  };
}

function answer(
  canaries: Canaries,
  body: unknown,
  status = 200,
  cookie?: string,
): Response {
  const headers = new Headers({
    'content-type': 'application/json',
    date: new Date(0).toUTCString(),
    'x-ratelimit-remaining': '59',
    'x-kanarie': canaries.headerValue,
  });
  if (cookie !== undefined) {
    headers.append('set-cookie', cookie);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

const notFound = (): Response =>
  new Response('<html></html>', {
    status: 404,
    headers: { 'content-type': 'text/html' },
  });

function pageList(
  pages: readonly Page[],
  page: number,
  limit: number,
): unknown {
  const effective = Math.min(limit, maxLimit);
  return {
    data: pages.slice((page - 1) * effective, page * effective),
    meta: {
      pagination: {
        total: pages.length,
        limit: effective,
        current: page,
        lastPage: Math.ceil(pages.length / effective),
      },
    },
  };
}

interface InstanceOptions {
  /** The OpenAPI document, `null` for an instance that publishes none. */
  readonly document?: unknown;
  /** The body of `GET /api/permissions/global`. */
  readonly rights?: unknown;
}

function syntheticInstance(
  { canaries, category, forbiddenCategory }: Setup,
  options: InstanceOptions = {},
): Instance {
  const pages = syntheticPages(canaries);
  const calls: Call[] = [];
  const denied = (): Response =>
    answer(
      canaries,
      { message: 'Keine Berechtigung', translatedMessage: canaries.personName },
      403,
    );

  const respond = (url: URL, authorization: string | null): Response => {
    const path = url.pathname;
    const query = url.searchParams;
    if (path === '/system/runtime/swagger/openapi.json') {
      return options.document === null
        ? notFound()
        : answer(canaries, options.document ?? specification);
    }
    if (path === '/api/info') {
      return answer(canaries, {
        version: '3.136.2',
        siteName: canaries.groupName,
        shortName: canaries.personId,
        build: canaries.number,
      });
    }
    if (path === '/api/whoami') {
      if (authorization === `Login ${canaries.token}`) {
        return answer(
          canaries,
          {
            data: {
              id: canaries.number,
              firstName: 'Max',
              lastName: canaries.personName,
              email: canaries.personEmail,
              [canaries.personEmail]: canaries.personId,
            },
          },
          200,
          `${canaries.cookieName}=${canaries.cookieValue}; Path=/; Secure; HttpOnly; SameSite=Lax`,
        );
      }
      if (
        authorization !== null ||
        query.get('only_allow_authenticated') === 'true'
      ) {
        return answer(
          canaries,
          { message: 'Session expired!', args: { token: authorization } },
          401,
        );
      }
      return answer(canaries, {
        data: { id: -1, firstName: '', lastName: '', email: '' },
      });
    }
    if (path === '/api/permissions/global') {
      return answer(
        canaries,
        options.rights ?? defaultRights(canaries, category),
      );
    }
    if (path === '/api/wiki/pages') {
      const page = query.get('page') ?? '';
      const limit = query.get('limit') ?? '';
      if (!/^[1-9]\d*$/.test(page) || !/^[1-9]\d*$/.test(limit)) {
        return answer(
          canaries,
          { message: 'Ungültiger Wert', args: { page, limit } },
          400,
        );
      }
      return Number(query.get('wiki_category_ids[]')) === category
        ? answer(canaries, pageList(pages, Number(page), Number(limit)))
        : denied();
    }
    const match =
      /^\/api\/wiki\/categories\/(\d+)\/pages(?:\/([^/]+)(\/versions(?:\/(\d+))?)?)?$/.exec(
        path,
      );
    if (match === null) {
      return notFound();
    }
    const [, requested, identifier, versions, version] = match;
    if (Number(requested) !== category) {
      return Number(requested) === forbiddenCategory ? denied() : notFound();
    }
    if (identifier === undefined) {
      return answer(canaries, pageList(pages, 1, maxLimit));
    }
    const found = pages.find((entry) => entry['identifier'] === identifier);
    if (found === undefined) {
      return answer(
        canaries,
        { message: 'Seite nicht gefunden', args: { identifier } },
        404,
      );
    }
    if (versions === undefined) {
      return answer(canaries, { data: found });
    }
    const history = Array.from({ length: versionCount }, (_, index) => ({
      ...found,
      version: index + 1,
    }));
    return answer(canaries, {
      data:
        version === undefined
          ? history
          : history.find((entry) => entry.version === Number(version)),
    });
  };

  return {
    calls,
    fetch: (url, init) => {
      const authorization = new Headers(init.headers).get('authorization');
      calls.push({ method: init.method ?? 'fehlt', url, authorization });
      return Promise.resolve(respond(url, authorization));
    },
  };
}

/** One run of one probe. */
interface ProbeRun {
  readonly code: number;
  readonly output: Capture;
  /** Parsed stdout, `undefined` if the probe printed nothing. */
  readonly result: unknown;
  /** The requests of this run. */
  readonly calls: readonly Call[];
}

async function runOne(
  definition: ProbeDefinition,
  env: Environment,
  instance: Instance,
): Promise<ProbeRun> {
  const output = capture();
  const before = instance.calls.length;
  const code = await runProbe(definition, {
    env,
    fetch: instance.fetch,
    io: output.io,
    folder: spikeFolder,
  });
  const text = output.stdout();
  return {
    code,
    output,
    result: text === '' ? undefined : JSON.parse(text),
    calls: instance.calls.slice(before),
  };
}

async function runAll(
  { env }: Setup,
  instance: Instance,
): Promise<
  Record<'inventory' | 'auth' | 'rights' | 'pages' | 'wiki', ProbeRun>
> {
  return {
    inventory: await runOne(inventory, env, instance),
    auth: await runOne(auth, env, instance),
    rights: await runOne(permissions, env, instance),
    pages: await runOne(pagination, env, instance),
    wiki: await runOne(wikiRead, env, instance),
  };
}

const text = { typ: 'Text', inhalt: 'nicht leer' };
const emptyText = { typ: 'Text', inhalt: 'leer' };
const number = { typ: 'Zahl' };
const truthValue = { typ: 'Wahrheitswert' };
const knownHeaders = {
  'content-type': 'Text',
  date: 'Datum',
  'x-ratelimit-remaining': 'Zahl',
};
const errorShape = (args: Record<string, unknown>): unknown => ({
  typ: 'Objekt',
  felder: { message: text, args: { typ: 'Objekt', felder: args } },
});

describe('the probes against a synthetic instance', () => {
  it('print the structure of every answer and none of its values', async () => {
    const setting = setup();
    const runs = await runAll(setting, syntheticInstance(setting));
    for (const [name, run] of Object.entries(runs)) {
      expect(run.code, `${name}: ${run.output.stdout()}`).toBe(exitCodes.ok);
      expect(leaks(run.output, setting.forbidden), name).toEqual([]);
      expect(run.output.stderr()).toMatch(
        /^[0-9a-f]{64} {2}00-inventory\.mts$/m,
      );
    }
    expect(statSync(setting.stateFile).mode & 0o777).toBe(0o600);
  });

  it('send only GET requests to the one origin, with the token only in its header', async () => {
    const setting = setup();
    const instance = syntheticInstance(setting);
    const runs = await runAll(setting, instance);
    const login = `Login ${setting.canaries.token}`;
    for (const call of instance.calls) {
      expect(call.method).toBe('GET');
      expect(call.url.origin).toBe(origin);
      expect(decodeURIComponent(call.url.href)).not.toContain(
        setting.canaries.token,
      );
      expect(call.url.pathname).not.toMatch(/\.\.|geheim/);
    }
    for (const run of [runs.inventory, runs.rights, runs.pages, runs.wiki]) {
      expect(run.calls.map((call) => call.authorization)).toEqual(
        run.calls.map(() => login),
      );
    }
    const sent = runs.auth.calls.map((call) => call.authorization);
    const invalid = sent.filter((value) => value !== login && value !== null);
    expect(sent.filter((value) => value === login)).toHaveLength(2);
    expect(sent.filter((value) => value === null)).toHaveLength(2);
    expect(invalid).toHaveLength(2);
    expect(invalid[0]).toMatch(/^Login [0-9a-f]{48}$/);
    expect(invalid[1]).toBe(invalid[0]);
  });

  it('report the version, the documented operations and the info answer', async () => {
    const setting = setup();
    const { inventory: run } = await runAll(
      setting,
      syntheticInstance(setting),
    );
    expect(run.result).toEqual({
      probe: '00-inventory',
      churchtoolsVersion: '3.136',
      spezifikation: { status: 200, format: 'OpenAPI 3' },
      info: {
        status: 200,
        format: 'JSON',
        kopfzeilen: { bekannt: knownHeaders, weitere: '1' },
        cookies: { anzahl: '0', attribute: [] },
        struktur: {
          typ: 'Objekt',
          felder: {
            version: text,
            siteName: text,
            '<key#1>': text,
            '<key#2>': number,
          },
        },
      },
      operationen: {
        info: 'dokumentiert',
        whoami: 'dokumentiert',
        permissionsGlobal: 'dokumentiert',
        wikiPages: 'dokumentiert',
        wikiCategoryPages: 'dokumentiert',
        wikiPage: 'dokumentiert',
        wikiPageVersions: 'dokumentiert',
        wikiPageVersion: 'dokumentiert',
        wikiPageCreate: 'dokumentiert',
        wikiPageUpdate: 'dokumentiert',
      },
      state: 'angelegt',
    });
    expect(run.calls.map((call) => call.url.pathname)).toEqual([
      '/system/runtime/swagger/openapi.json',
      '/api/info',
    ]);
  });

  it('describe whoami with, without and with a wrong token', async () => {
    const setting = setup();
    const { auth: run } = await runAll(setting, syntheticInstance(setting));
    expect(run.result).toMatchObject({
      probe: '01-auth',
      parameterDokumentiert: { only_allow_authenticated: 'ja' },
      anfragen: {
        mitToken: {
          status: 200,
          format: 'JSON',
          kopfzeilen: { bekannt: knownHeaders, weitere: '1' },
          cookies: {
            anzahl: '1',
            attribute: [
              {
                httpOnly: 'ja',
                secure: 'ja',
                sameSite: 'Lax',
                ablauf: 'Sitzung',
              },
            ],
          },
          struktur: {
            typ: 'Objekt',
            felder: {
              data: {
                typ: 'Objekt',
                felder: {
                  id: number,
                  firstName: text,
                  lastName: text,
                  email: text,
                  '<key#1>': text,
                },
              },
            },
          },
        },
        mitTokenNurAngemeldet: { status: 200 },
        ohneToken: {
          status: 200,
          cookies: { anzahl: '0' },
          struktur: {
            typ: 'Objekt',
            felder: {
              data: {
                typ: 'Objekt',
                felder: {
                  id: number,
                  firstName: emptyText,
                  lastName: emptyText,
                  email: emptyText,
                },
              },
            },
          },
        },
        ohneTokenNurAngemeldet: {
          status: 401,
          struktur: errorShape({ '<key#1>': { typ: 'null' } }),
        },
        falschesToken: {
          status: 401,
          struktur: errorShape({ '<key#1>': text }),
        },
        falschesTokenNurAngemeldet: { status: 401 },
      },
    });
    expect(run.calls.map((call) => call.url.searchParams.toString())).toEqual([
      '',
      'only_allow_authenticated=true',
      '',
      'only_allow_authenticated=true',
      '',
      'only_allow_authenticated=true',
    ]);
  });

  it('show the global rights as truth values and counts, without IDs or names', async () => {
    const setting = setup();
    const { rights: run } = await runAll(setting, syntheticInstance(setting));
    const list = { typ: 'Liste', anzahl: '2–9', formen: [number] };
    expect(run.result).toMatchObject({
      probe: '02-permissions',
      antwort: {
        status: 200,
        struktur: {
          typ: 'Objekt',
          felder: {
            data: {
              typ: 'Objekt',
              felder: {
                '<key#1>': {
                  typ: 'Objekt',
                  felder: { admin: { ...truthValue, wert: 'wahr' } },
                },
                churchwiki: {
                  typ: 'Objekt',
                  felder: {
                    view: { ...truthValue, wert: 'wahr' },
                    'view category': list,
                    '<key#1>': { ...truthValue, wert: 'wahr' },
                  },
                },
                churchdb: {
                  typ: 'Objekt',
                  felder: {
                    view: { ...truthValue, wert: 'falsch' },
                    'security level person': list,
                  },
                },
              },
            },
          },
        },
      },
    });
  });

  it('measure pagination and the format of errors', async () => {
    const setting = setup();
    const { pages: run } = await runAll(setting, syntheticInstance(setting));
    const pagination = {
      typ: 'Objekt',
      felder: {
        total: number,
        limit: number,
        current: number,
        lastPage: number,
      },
    };
    expect(run.result).toMatchObject({
      probe: '03-pagination-errors',
      parameterDokumentiert: {
        page: 'ja',
        limit: 'ja',
        'wiki_category_ids[]': 'ja',
      },
      limitTest: [
        {
          angefragt: 1,
          eintraege: 1,
          limitEcho: 1,
          antwort: {
            status: 200,
            struktur: {
              typ: 'Objekt',
              felder: {
                data: {
                  typ: 'Liste',
                  anzahl: '1',
                  formen: [
                    {
                      typ: 'Objekt',
                      felder: { identifier: text, title: text },
                    },
                  ],
                },
                meta: { typ: 'Objekt', felder: { pagination } },
              },
            },
          },
        },
        { angefragt: 2, eintraege: 2, limitEcho: 2 },
        { angefragt: 100, eintraege: 5, limitEcho: 100 },
        { angefragt: 1000, eintraege: 5, limitEcho: maxLimit },
      ],
      hinterLetzterSeite: { eintraege: 0, antwort: { status: 200 } },
      ungueltigeWerte: [
        ['page', '0'],
        ['page', '-1'],
        ['page', 'x'],
        ['limit', '0'],
        ['limit', '-1'],
        ['limit', 'x'],
      ].map(([parameter, wert]) => ({
        parameter,
        wert,
        antwort: {
          status: 400,
          struktur: errorShape({ '<key#1>': text, '<key#2>': text }),
        },
      })),
      unbekannteSeite: {
        status: 404,
        struktur: errorShape({ '<key#1>': text }),
      },
      gesperrteKategorie: {
        liste: {
          status: 403,
          struktur: {
            typ: 'Objekt',
            felder: { message: text, '<key#1>': text },
          },
        },
        seitenliste: { status: 403 },
      },
    });
    const behind = run.calls[4]?.url.searchParams.get('page');
    expect(behind).toBe('6');
  });

  it('read at most three pages, their versions and their newest version', async () => {
    const setting = setup();
    const { wiki: run } = await runAll(setting, syntheticInstance(setting));
    const page = {
      status: 200,
      struktur: {
        typ: 'Objekt',
        felder: {
          data: {
            typ: 'Objekt',
            felder: {
              identifier: text,
              title: text,
              text,
              version: number,
              isMarkdown: truthValue,
            },
          },
        },
      },
    };
    expect(run.result).toMatchObject({
      probe: '04-wiki-read',
      liste: { status: 200 },
      kennung: 'identifier',
      seiten: [
        {
          seite: page,
          isMarkdown: 'wahr',
          versionen: { status: 200 },
          anzahlVersionen: '2–9',
          versionGleichNeuester: 'ja',
          neuesteVersion: page,
        },
        { isMarkdown: 'falsch', versionGleichNeuester: 'nein' },
        { isMarkdown: 'fehlt', versionGleichNeuester: 'ja' },
      ],
    });
    const paths = run.calls.map((call) => call.url.pathname);
    expect(paths.filter((path) => /\/pages\/[^/]+$/.test(path))).toHaveLength(
      3,
    );
    expect(
      paths.filter((path) =>
        path.endsWith(`/versions/${String(versionCount)}`),
      ),
    ).toHaveLength(3);
  });

  it('report operations the instance does not document, and call none of them', async () => {
    const setting = setup();
    const { paths, ...rest } = specification;
    const document = {
      ...rest,
      paths: { '/info': paths['/info'], '/whoami': paths['/whoami'] },
    };
    const runs = await runAll(
      setting,
      syntheticInstance(setting, { document }),
    );
    expect(runs.inventory.result).toMatchObject({
      operationen: {
        info: 'dokumentiert',
        whoami: 'dokumentiert',
        permissionsGlobal: 'nicht dokumentiert',
        wikiPages: 'nicht dokumentiert',
        wikiPageCreate: 'nicht dokumentiert',
      },
    });
    expect(runs.rights.result).toEqual({
      probe: '02-permissions',
      permissionsGlobal: 'nicht dokumentiert',
    });
    expect(runs.pages.result).toEqual({
      probe: '03-pagination-errors',
      wikiPages: 'nicht dokumentiert',
      wikiPage: 'nicht dokumentiert',
      gesperrteKategorie: {
        liste: 'nicht dokumentiert',
        seitenliste: 'nicht dokumentiert',
      },
    });
    expect(runs.wiki.result).toEqual({
      probe: '04-wiki-read',
      wikiCategoryPages: 'nicht dokumentiert',
    });
    for (const run of [runs.rights, runs.pages, runs.wiki]) {
      expect(run.code).toBe(exitCodes.ok);
      expect(run.calls).toEqual([]);
    }
  });

  it('withhold the output if the name of a right matches a part of the host', async () => {
    const setting = setup();
    const instance = syntheticInstance(setting, {
      rights: { data: { example: { view: true } } },
    });
    expect((await runOne(inventory, setting.env, instance)).code).toBe(
      exitCodes.ok,
    );
    const run = await runOne(permissions, setting.env, instance);
    expect(run.code).toBe(exitCodes.withheld);
    expect(run.result).toEqual({
      zurueckgehalten: true,
      stellen: ['/antwort/struktur/felder/#0/felder/#0'],
    });
    expect(leaks(run.output, [...setting.forbidden, 'example'])).toEqual([]);
  });
});

describe('the probes stop before the first request', () => {
  for (const definition of probes) {
    it(`${definition.name}, without environment`, async () => {
      const setting = setup();
      const instance = syntheticInstance(setting);
      const run = await runOne(definition, {}, instance);
      expect(run.code).toBe(exitCodes.configuration);
      expect(run.output.stdout()).toBe('');
      expect(run.output.stderr()).toContain(hints.basisUrlFehlt);
      expect(instance.calls).toEqual([]);
    });
  }

  it('01 to 04, without the state of 00-inventory', async () => {
    for (const definition of probes.slice(1)) {
      const setting = setup();
      const instance = syntheticInstance(setting);
      const run = await runOne(definition, setting.env, instance);
      expect(run.code, definition.name).toBe(exitCodes.configuration);
      expect(run.output.stderr()).toContain(hints.stateDateiNichtGefunden);
      expect(instance.calls).toEqual([]);
    }
  });

  it('00-inventory, if the state file exists', async () => {
    const setting = setup();
    writeFileSync(setting.stateFile, '{}', { mode: 0o600 });
    const instance = syntheticInstance(setting);
    const run = await runOne(inventory, setting.env, instance);
    expect(run.code).toBe(exitCodes.configuration);
    expect(run.output.stderr()).toContain(hints.stateDateiVorhanden);
    expect(instance.calls).toEqual([]);
  });

  it('03 and 04, without a valid category', async () => {
    const setting = setup();
    const instance = syntheticInstance(setting);
    expect((await runOne(inventory, setting.env, instance)).code).toBe(
      exitCodes.ok,
    );
    const cases = [
      [
        pagination,
        { ECCLIUM_SPIKE_WIKI_CATEGORY_ID: undefined },
        'kategorieFehlt',
      ],
      [wikiRead, { ECCLIUM_SPIKE_WIKI_CATEGORY_ID: '0' }, 'kategorieFehlt'],
      [
        pagination,
        { ECCLIUM_SPIKE_FORBIDDEN_CATEGORY_ID: 'x' },
        'gesperrteKategorieUngueltig',
      ],
    ] as const;
    for (const [definition, change, hint] of cases) {
      const run = await runOne(
        definition,
        { ...setting.env, ...change },
        instance,
      );
      expect(run.code, definition.name).toBe(exitCodes.configuration);
      expect(run.output.stderr()).toContain(hints[hint]);
      expect(run.calls).toEqual([]);
    }
  });
});

describe('00-inventory', () => {
  it('writes no state if the instance publishes no OpenAPI document', async () => {
    const setting = setup();
    const instance = syntheticInstance(setting, { document: null });
    const run = await runOne(inventory, setting.env, instance);
    expect(run.code).toBe(exitCodes.network);
    expect(run.output.stderr()).toContain(hints.spezifikationUngueltig);
    expect(run.calls).toHaveLength(1);
    expect(existsSync(setting.stateFile)).toBe(false);
  });
});

describe('versionOf', () => {
  it('takes major and minor number only', () => {
    expect(versionOf({ version: '3.136.2' })).toBe('3.136');
    expect(versionOf({ version: '3.136.2-rc1' })).toBe('3.136');
    expect(versionOf({ data: { version: '3.99' } })).toBe('3.99');
    for (const body of [
      { version: 'Demo 3.1' },
      { version: 3.1 },
      { version: '3' },
      'x',
      null,
    ]) {
      expect(versionOf(body)).toBeNull();
    }
  });
});

describe('pageId', () => {
  it('takes an ID only if it has the form of one', () => {
    expect(pageId({ identifier: 'a1-b_2.c~' })).toEqual([
      'identifier',
      'a1-b_2.c~',
    ]);
    expect(pageId({ identifier: '../x', id: 12 })).toEqual(['id', '12']);
    for (const entry of [
      { identifier: 'a/b' },
      { identifier: '.x' },
      { identifier: '' },
      { id: 0 },
      { id: 1.5 },
      { id: '7?' },
      'x',
      null,
    ]) {
      expect(pageId(entry)).toBeUndefined();
    }
  });
});
