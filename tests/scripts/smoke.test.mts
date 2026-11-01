import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { eventSpans } from '../../scripts/smoke/course.mts';
import {
  runSmoke,
  smokeExitCodes,
  type ServerStart,
} from '../../scripts/smoke/main.mts';
import { hints } from '../../scripts/spike/lib/errors.mts';
import { findOpenssl, makeCertificate } from '../support/certificates.mts';
import { guardPreload } from '../support/no-network.mts';

// The smoke test against a stand-in of the server that breaks one thing at
// a time, and once against the real server from source with ChurchTools
// played by a server of this test over TLS. The reads of its guard go to
// a fetch of this test, so no request leaves the machine (ADR 0052). Every
// name and the token are canaries; none may reach the output.

const fake = fileURLToPath(
  new URL('../fixtures/smoke/fake-server.mts', import.meta.url),
);
const host = 'demo.example';
const token = `t${randomBytes(20).toString('hex')}`;
const canary = `c${randomBytes(6).toString('hex')}`;
const query = `Suchprobe${randomBytes(3).toString('hex')}`;
const songQuery = `Liedprobe${randomBytes(3).toString('hex')}`;
// Made for each run, never written in the source.
const pseudonymKey = randomBytes(32).toString('hex');
const pageGuid = '00000000-0000-4000-8000-000000000001';

// The calls after the bookings: the songs, the first song, the categories
// of the wiki, the pages of the first, the search in the wiki, the first
// page it found, and the global search for each type.
const songsAndSearches = [
  'ct_songs_search',
  'ct_songs_get',
  'ct_wiki_categories_list',
  'ct_wiki_pages_list',
  'ct_wiki_search',
  'ct_wiki_page_get',
  'ct_search',
  'ct_search',
  'ct_search',
  'ct_search',
] as const;
// The calls of the docs tools after ct_whoami, in every run: a search and a
// read of each source, which reach no ChurchTools.
const docsCalls = [
  'ct_docs_search_api',
  'ct_docs_get_operation',
  'ct_docs_search_rights',
  'ct_docs_get_right',
  'ct_docs_search_academy',
  'ct_docs_read_academy',
] as const;
// The calls of the escape hatch at the end, with its switch: the search,
// two reads and three refusals.
const apiCalls = [
  'ct_api_search_actions',
  'ct_api_execute_read',
  'ct_api_execute_read',
  'ct_api_execute_read',
  'ct_api_execute_read',
  'ct_api_execute_read',
] as const;
const missTerm = 'zqmissingterm';
const timeout = 120_000;

let folder = '';
let tokenFile = '';
let keyFile = '';

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), 'ecclium-smoke-test-'));
  tokenFile = join(folder, 'token');
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  keyFile = join(folder, 'pseudonym-key');
  writeFileSync(keyFile, `${pseudonymKey}\n`, { mode: 0o600 });
  chmodSync(keyFile, 0o600);
});

afterAll(() => {
  if (folder !== '') rmSync(folder, { recursive: true, force: true });
});

const identification = {
  id: 12,
  name: 'testinstanz-kennung',
  permissions: { canEdit: false, canDelete: false },
};

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

interface Fetched {
  readonly path: string;
  readonly authorization: string | null;
  readonly method: string;
}

interface Recorded {
  readonly variables: { readonly [name: string]: string };
  readonly calls: readonly string[];
}

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly fetched: readonly Fetched[];
  readonly records: readonly Recorded[];
}

interface Options {
  readonly origin?: string;
  readonly env?: { readonly [name: string]: string };
  readonly scenario?: string;
  readonly categories?: unknown;
  /** The reads of the guard fail on the network or get a 401. */
  readonly guardAnswer?: 'network' | 'refused';
  readonly args?: readonly string[];
  readonly platform?: string;
  readonly server?: ServerStart;
}

const run = async (options: Options = {}): Promise<Run> => {
  const recordDir = mkdtempSync(join(folder, 'record-'));
  let stdout = '';
  let stderr = '';
  const fetched: Fetched[] = [];
  const code = await runSmoke({
    env: {
      ECCLIUM_CHURCHTOOLS_URL: options.origin ?? `https://${host}`,
      ECCLIUM_CHURCHTOOLS_TOKEN_FILE: tokenFile,
      ...options.env,
    },
    args: options.args ?? [],
    io: {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    },
    fetch: (input, init) => {
      fetched.push({
        path: input.pathname,
        authorization: new Headers(init.headers).get('authorization'),
        method: init.method ?? 'GET',
      });
      if (options.guardAnswer === 'network') {
        return Promise.reject(new TypeError('fetch failed'));
      }
      if (options.guardAnswer === 'refused') {
        return Promise.resolve(new Response('', { status: 401 }));
      }
      if (input.pathname === '/api/wiki/categories') {
        return Promise.resolve(
          jsonResponse({
            data: options.categories ?? [identification],
            permissions: { editMasterData: false },
          }),
        );
      }
      if (input.pathname === '/api/info') {
        return Promise.resolve(jsonResponse({ version: '3.137.0' }));
      }
      return Promise.resolve(new Response('', { status: 404 }));
    },
    platform: options.platform ?? process.platform,
    tmpdir: folder,
    server: options.server ?? {
      executable: process.execPath,
      preArgs: [],
      entry: fake,
      env: {
        FAKE_SCENARIO: options.scenario ?? 'normal',
        FAKE_CANARY: canary,
        FAKE_RECORD: recordDir,
      },
    },
    deadlines: { answer: 20_000, end: 20_000 },
    missTerm: () => missTerm,
  });
  const records = readdirSync(recordDir).map(
    (name) =>
      JSON.parse(readFileSync(join(recordDir, name), 'utf8')) as Recorded,
  );
  return { code, stdout, stderr, fetched, records };
};

const search = {
  ECCLIUM_SMOKE_ALLOW_SEARCH: 'demo',
  ECCLIUM_SMOKE_QUERY: query,
};

const withApi = { ...search, ECCLIUM_SMOKE_ALLOW_API: 'demo' };

/** Nothing from the instance, the token or the term reaches the output. */
const expectClean = (result: Run): void => {
  const output = result.stdout + result.stderr;
  for (const value of [
    canary,
    token,
    query,
    songQuery,
    host,
    tokenFile,
    pseudonymKey,
    keyFile,
    folder,
  ]) {
    expect(output).not.toContain(value);
  }
};

const report = (result: Run): { readonly [key: string]: unknown } =>
  JSON.parse(result.stdout) as { readonly [key: string]: unknown };

const stateDirsLeft = (): string[] =>
  readdirSync(folder).filter((name) => name.startsWith('ecclium-smoke-'));

describe('the spans of the events', () => {
  it('cover three spans of 31 days from a week before the UTC day of the run', () => {
    expect(eventSpans(new Date('2026-10-26T23:30:00Z'))).toEqual([
      { from: '2026-10-19', to: '2026-11-18' },
      { from: '2026-11-19', to: '2026-12-19' },
      { from: '2026-12-20', to: '2027-01-19' },
    ]);
  });
});

describe('the smoke test against a stand-in of the server', { timeout }, () => {
  it('calls only ct_whoami and the docs tools without the switch, in both eras, and sends nothing itself', async () => {
    const result = await run();
    expect(result.code).toBe(smokeExitCodes.ok);
    expect(report(result)).toMatchObject({
      suchtools: 'nein',
      api: 'nein',
      fehler: [],
      befunde: [],
      ergebnis: 'bestanden',
    });
    expect(report(result)['aeren']).toHaveLength(2);
    expect(result.records).toHaveLength(2);
    for (const record of result.records) {
      expect(record.variables['ECCLIUM_TOOLSETS']).toBe('docs');
      expect(record.calls).toEqual(['ct_whoami', ...docsCalls]);
    }
    expect(result.fetched).toEqual([]);
    expect(stateDirsLeft()).toEqual([]);
    expectClean(result);
  });

  it('gives the server only its variables, read-only whatever the shell says', async () => {
    const result = await run({
      env: {
        ECCLIUM_READ_ONLY: 'false',
        ECCLIUM_SPIKE_TOKEN_FILE: tokenFile,
        ECCLIUM_LOG_LEVEL: 'debug',
        PATH: '/usr/bin',
        HOME: folder,
      },
    });
    expect(result.code).toBe(smokeExitCodes.ok);
    expect(result.records).toHaveLength(2);
    for (const record of result.records) {
      // macOS adds __CF_USER_TEXT_ENCODING to the environment of every
      // child process itself.
      const names = Object.keys(record.variables).filter(
        (name) => name !== '__CF_USER_TEXT_ENCODING',
      );
      expect(names).toEqual([
        'ECCLIUM_CHURCHTOOLS_TOKEN_FILE',
        'ECCLIUM_CHURCHTOOLS_URL',
        'ECCLIUM_READ_ONLY',
        'ECCLIUM_STATE_DIR',
        'ECCLIUM_TOOLSETS',
        'FAKE_CANARY',
        'FAKE_RECORD',
        'FAKE_SCENARIO',
      ]);
      expect(record.variables['ECCLIUM_READ_ONLY']).toBe('true');
    }
  });

  it('with the switch reads the identification category first, then calls all tools', async () => {
    const result = await run({ env: search });
    expect(result.code).toBe(smokeExitCodes.ok);
    expect(report(result)).toMatchObject({
      suchtools: 'ja',
      churchtools: '3.137',
      kennkategorie: 'gefunden',
      ergebnis: 'bestanden',
    });
    expect(result.fetched).toEqual([
      {
        path: '/api/wiki/categories',
        authorization: `Login ${token}`,
        method: 'GET',
      },
      { path: '/api/info', authorization: `Login ${token}`, method: 'GET' },
    ]);
    expect(result.records).toHaveLength(2);
    for (const record of result.records) {
      expect(
        Object.keys(record.variables).filter((name) =>
          name.startsWith('ECCLIUM_'),
        ),
      ).toEqual([
        'ECCLIUM_CHURCHTOOLS_TOKEN_FILE',
        'ECCLIUM_CHURCHTOOLS_URL',
        'ECCLIUM_READ_ONLY',
        'ECCLIUM_STATE_DIR',
        'ECCLIUM_TOOLSETS',
      ]);
      expect(record.variables['ECCLIUM_TOOLSETS']).toBe(
        'persons,events,calendars,wiki,songs,docs',
      );
      expect(record.calls).toEqual([
        'ct_whoami',
        ...docsCalls,
        'ct_persons_search',
        'ct_groups_search',
        'ct_persons_search',
        'ct_persons_search',
        'ct_persons_get',
        'ct_persons_get_groups',
        'ct_groups_get',
        'ct_groups_get_members',
        'ct_events_list',
        'ct_events_get',
        'ct_events_get_agenda',
        'ct_services_get_assignments',
        'ct_services_list',
        'ct_calendars_list',
        'ct_appointments_list',
        'ct_appointments_get',
        'ct_resources_list',
        'ct_bookings_list',
        ...songsAndSearches,
      ]);
    }
    // The list of appointments of the stand-in holds one of whole days,
    // as a day alone. The hits of the wiki carry a GUID, and no search
    // gave a hit of another type.
    for (const era of report(result)['aeren'] as {
      aufrufe: { tool: string; ganztaegig?: string }[];
    }[]) {
      expect(
        era.aufrufe.find((call) => call.tool === 'ct_appointments_list')
          ?.ganztaegig,
      ).toBe('nur Tag');
    }
    for (const era of report(result)['aeren'] as {
      artfremd: string;
      ohneAufruf: string[];
      aufrufe: { tool: string; guid?: string; quelle?: string }[];
    }[]) {
      expect(era.artfremd).toBe('nein');
      // Every listed tool had its call, the page read with the GUID of the
      // search.
      expect(era.ohneAufruf).toEqual([]);
      expect(
        era.aufrufe.find((call) => call.tool === 'ct_wiki_page_get')?.quelle,
      ).toBe('suche');
      expect(
        era.aufrufe
          .filter((call) => call.guid !== undefined)
          .map((call) => [call.tool, call.guid]),
      ).toEqual([
        ['ct_wiki_search', 'ja'],
        ['ct_search wiki_page', 'ja'],
      ]);
    }
    expect(stateDirsLeft()).toEqual([]);
    expectClean(result);
  });

  it('with the second switch also calls the escape hatch, behind the guard', async () => {
    const result = await run({ env: withApi });
    expect(result.code).toBe(smokeExitCodes.ok);
    expect(report(result)).toMatchObject({
      suchtools: 'ja',
      api: 'ja',
      kennkategorie: 'gefunden',
      fehler: [],
      ergebnis: 'bestanden',
    });
    expect(result.fetched.map((fetched) => fetched.path)).toEqual([
      '/api/wiki/categories',
      '/api/info',
    ]);
    expect(result.records).toHaveLength(2);
    for (const record of result.records) {
      expect(record.variables['ECCLIUM_TOOLSETS']).toBe(
        'persons,events,calendars,wiki,songs,docs,api',
      );
      expect(record.calls.slice(-apiCalls.length)).toEqual([...apiCalls]);
    }
    for (const era of report(result)['aeren'] as {
      warnung: string;
      ohneAufruf: string[];
      aufrufe: { tool: string; ergebnis: string }[];
    }[]) {
      expect(era.warnung).toBe('ja');
      expect(era.ohneAufruf).toEqual([]);
      expect(
        era.aufrufe
          .filter((call) => call.tool.startsWith('ct_api_'))
          .map((call) => call.ergebnis),
      ).toEqual(['ok', 'ok', 'ok', 'abgewiesen', 'abgewiesen', 'abgewiesen']);
    }
    expect(stateDirsLeft()).toEqual([]);
    expectClean(result);
  });

  it('refuses a second switch that does not fit the host, before any request', async () => {
    const result = await run({
      env: { ...withApi, ECCLIUM_SMOKE_ALLOW_API: 'example' },
    });
    expect(result.code).toBe(smokeExitCodes.refused);
    expect(result.stderr).toContain(hints.smokeApiSchalterFalsch);
    expect(result.fetched).toEqual([]);
    expect(result.records).toEqual([]);
  });

  it.each([
    [
      'without the identification category',
      [{ ...identification, name: 'andere' }],
      'smokeKennkategorieFehlt',
    ],
    [
      'with the category twice',
      [identification, { ...identification, id: 13 }],
      'smokeKennkategorieMehrfach',
    ],
    [
      'with an editable category',
      [{ ...identification, permissions: { canEdit: true, canDelete: false } }],
      'smokeKennkategorieBearbeitbar',
    ],
    [
      'with a category the account may delete',
      [{ ...identification, permissions: { canEdit: false, canDelete: true } }],
      'smokeKennkategorieBearbeitbar',
    ],
    [
      'with an answer of another form',
      { unexpected: true },
      'smokeWaechterAntwortUnerwartet',
    ],
  ] as const)(
    'refuses %s and starts no server',
    async (_, categories, hint) => {
      const result = await run({ env: search, categories });
      expect(result.code).toBe(smokeExitCodes.refused);
      expect(result.stderr).toContain(hints[hint]);
      expect(result.records).toEqual([]);
      expect(result.stdout).toBe('');
      expectClean(result);
    },
  );

  it('ends with 78 when ChurchTools refuses the token, and with 69 without the network, starting no server', async () => {
    const refused = await run({ env: search, guardAnswer: 'refused' });
    expect(refused.code).toBe(smokeExitCodes.configuration);
    expect(refused.stderr).toContain(hints.smokeTokenAbgewiesen);
    expect(refused.records).toEqual([]);
    const offline = await run({ env: search, guardAnswer: 'network' });
    expect(offline.code).toBe(smokeExitCodes.unavailable);
    expect(offline.stderr).toContain(hints.smokeNetz);
    expect(offline.records).toEqual([]);
    expectClean(refused);
    expectClean(offline);
  });

  it('refuses a switch that does not fit the host, before any request', async () => {
    const result = await run({
      env: { ...search, ECCLIUM_SMOKE_ALLOW_SEARCH: 'example' },
    });
    expect(result.code).toBe(smokeExitCodes.refused);
    expect(result.stderr).toContain(hints.smokeSchalterFalsch);
    expect(result.fetched).toEqual([]);
    expect(result.records).toEqual([]);
  });

  it.each([
    [
      'a term without the switch',
      { ECCLIUM_SMOKE_QUERY: query },
      'smokeSuchbegriffOhneSchalter',
    ],
    [
      'the switch without a term',
      { ECCLIUM_SMOKE_ALLOW_SEARCH: 'demo' },
      'smokeSuchbegriffFehlt',
    ],
    [
      'a term with a space at the end',
      { ...search, ECCLIUM_SMOKE_QUERY: `${query} ` },
      'smokeSuchbegriffUngueltig',
    ],
    [
      'a term with a control character',
      { ...search, ECCLIUM_SMOKE_QUERY: 'a\u0007b' },
      'smokeSuchbegriffUngueltig',
    ],
    [
      'a term for songs without the switch',
      { ECCLIUM_SMOKE_SONG_QUERY: songQuery },
      'smokeLiedbegriffOhneSchalter',
    ],
    [
      'a term for songs with a space at the end',
      { ...search, ECCLIUM_SMOKE_SONG_QUERY: `${songQuery} ` },
      'smokeLiedbegriffUngueltig',
    ],
    [
      'the switch of the escape hatch without the one of the search tools',
      { ECCLIUM_SMOKE_ALLOW_API: 'demo' },
      'smokeApiOhneSuchschalter',
    ],
    [
      'the token in a variable',
      { ECCLIUM_CHURCHTOOLS_TOKEN: token },
      'smokeTokenVariable',
    ],
    ['NODE_OPTIONS', { NODE_OPTIONS: guardPreload }, 'smokeUmgebungUnsicher'],
    ['a proxy for fetch', { NODE_USE_ENV_PROXY: '1' }, 'smokeUmgebungUnsicher'],
    [
      'other certificates',
      { SSL_CERT_FILE: '/etc/ssl/cert.pem' },
      'smokeUmgebungUnsicher',
    ],
    [
      'a relative token file',
      { ECCLIUM_CHURCHTOOLS_TOKEN_FILE: 'token' },
      'smokeTokenDateiRelativ',
    ],
    [
      'the placeholder address',
      { ECCLIUM_CHURCHTOOLS_URL: 'https://example.church.tools' },
      'smokePlatzhalter',
    ],
    [
      'an address with a path',
      { ECCLIUM_CHURCHTOOLS_URL: `https://${host}/api` },
      'smokeAdresseUngueltig',
    ],
    [
      'an address over http',
      { ECCLIUM_CHURCHTOOLS_URL: `http://${host}` },
      'smokeAdresseUngueltig',
    ],
  ] as const)(
    'ends with 78 for %s, before any request',
    async (_, env, hint) => {
      const result = await run({ env });
      expect(result.code).toBe(smokeExitCodes.configuration);
      expect(result.stderr).toContain(hints[hint]);
      expect(result.fetched).toEqual([]);
      expect(result.records).toEqual([]);
      expectClean(result);
    },
  );

  it('ends with 78 for a token file others may read', async () => {
    const open = join(folder, 'token-offen');
    writeFileSync(open, `${token}\n`, { mode: 0o644 });
    chmodSync(open, 0o644);
    const result = await run({ env: { ECCLIUM_CHURCHTOOLS_TOKEN_FILE: open } });
    expect(result.code).toBe(smokeExitCodes.configuration);
    expect(result.stderr).toContain(hints.smokeTokenDateiUnsicher);
    expect(result.records).toEqual([]);
  });

  it('ends with 78 without the built server, 64 with an argument and 78 under Windows', async () => {
    const missing = await run({
      server: {
        executable: process.execPath,
        preArgs: [],
        entry: join(folder, 'fehlt.js'),
      },
    });
    expect(missing.code).toBe(smokeExitCodes.configuration);
    expect(missing.stderr).toContain(hints.smokeBuildFehlt);
    const argument = await run({ args: ['--hilfe'] });
    expect(argument.code).toBe(smokeExitCodes.usage);
    expect(argument.records).toEqual([]);
    const windows = await run({ platform: 'win32' });
    expect(windows.code).toBe(smokeExitCodes.configuration);
    expect(windows.records).toEqual([]);
  });

  it.each([
    ['write-tool', 'tools_list'],
    ['extra-field', 'personensuche'],
    ['no-envelope', 'gruppensuche'],
    ['blank-request', 'anfragen'],
    ['audit-gap', 'audit'],
    ['chain-broken', 'kette'],
    ['leak-log', 'protokoll'],
    ['foreign-stdout', 'stdout'],
    ['token-stderr', 'token'],
    ['text-stderr', 'stderr'],
    ['text-mismatch', 'whoami'],
    ['person-extra', 'person'],
    ['membership-no-envelope', 'gruppen_der_person'],
    ['group-bare-note', 'gruppe'],
    ['member-status', 'mitglieder'],
    ['events-bad-date', 'events'],
    ['event-bare-note', 'event'],
    ['agenda-bad-type', 'ablauf'],
    ['agenda-refused', 'ablauf'],
    ['assignment-extra', 'einteilungen'],
    ['services-bare-name', 'dienste'],
    ['calendars-bare-name', 'kalender'],
    ['appointments-bad-date', 'termine'],
    ['appointment-extra', 'termin'],
    ['appointments-bare-title', 'termine'],
    ['appointment-bare-link', 'termin'],
    ['bookings-bare-title', 'buchungen'],
    ['resources-bare-type', 'ressourcen'],
    ['bookings-bad-status', 'buchungen'],
    ['songs-bare-name', 'lieder'],
    ['song-extra', 'lied'],
    ['categories-bare-name', 'wikikategorien'],
    ['pages-bad-guid', 'wikiseiten'],
    ['extra-tool', 'nicht_aufgerufen'],
    ['tools-cursor', 'tools_list'],
    ['prompts-cursor', 'prompts'],
    ['wiki-bare-title', 'wikisuche'],
    ['wiki-bad-guid', 'wikisuche'],
    ['page-bare-text', 'seite'],
    ['search-bare-title', 'globale_suche'],
    ['search-person-enveloped', 'globale_suche'],
    ['search-other-list', 'globale_suche'],
    ['search-foreign', 'globale_suche'],
    ['prompt-unfilled', 'prompts'],
    ['prompt-optional', 'prompts'],
    ['prompt-no-sentence', 'prompts'],
    ['prompt-friday', 'prompts'],
    ['prompt-no-log', 'prompts'],
    ['prompt-leak-log', 'protokoll'],
    ['prompt-no-diagnosis', 'prompts'],
    ['prompt-empty-access', 'prompts'],
    ['docs-bare-summary', 'doku_operationen'],
    ['docs-license', 'doku_operationen'],
    ['docs-unmapped', 'doku_operation'],
    ['docs-no-needs', 'doku_operation'],
    ['docs-bare-label', 'doku_rechte'],
    ['docs-right-unused', 'doku_recht'],
    ['docs-foreign-link', 'doku_academy'],
    ['docs-no-pages', 'doku_academy'],
    ['docs-bare-text', 'doku_hilfeseite'],
    ['docs-request', 'anfragen'],
    ['docs-missing-tool', 'tools_list'],
    ['exit-1', 'ende'],
  ] as const)(
    'fails when the server breaks it: %s',
    async (scenario, failure) => {
      const result = await run({ env: search, scenario });
      expect(result.code).toBe(smokeExitCodes.failed);
      expect(report(result)['ergebnis']).toBe('gescheitert');
      expect(report(result)['fehler']).toContain(failure);
      expect(stateDirsLeft()).toEqual([]);
      expectClean(result);
    },
  );

  // The docs tools run without the switch as well, so their checks hold
  // there too.
  it.each([
    ['docs-bare-text', 'doku_hilfeseite'],
    ['docs-request', 'anfragen'],
    ['prompt-empty-access', 'prompts'],
    // The value of the rights diagnosis, the only prompt without the switch.
    ['prompt-leak-log', 'protokoll'],
  ] as const)(
    'fails without the switch when the server breaks it: %s',
    async (scenario, failure) => {
      const result = await run({ scenario });
      expect(result.code).toBe(smokeExitCodes.failed);
      expect(report(result)['fehler']).toContain(failure);
      expectClean(result);
    },
  );

  it.each([
    ['api-search-bare', 'api_suche'],
    ['api-broken-json', 'api_kategorien'],
    ['api-no-categories', 'api_kategorien'],
    ['api-rights-list', 'api_rechte'],
    ['api-csrf-read', 'api_ausgeschlossen'],
    ['api-unknown-read', 'api_unbekannt'],
    ['api-path-read', 'api_pfad'],
    ['api-no-warning', 'api_warnung'],
    ['api-refusal-request', 'anfragen'],
  ] as const)(
    'fails when the server breaks the escape hatch: %s',
    async (scenario, failure) => {
      const result = await run({ env: withApi, scenario });
      expect(result.code).toBe(smokeExitCodes.failed);
      expect(report(result)['ergebnis']).toBe('gescheitert');
      expect(report(result)['fehler']).toContain(failure);
      expect(stateDirsLeft()).toEqual([]);
      expectClean(result);
    },
  );

  it('names the help page it had no hit to read with', async () => {
    const result = await run({ env: search, scenario: 'docs-no-pages' });
    expect(report(result)['fehler']).toEqual(['doku_academy']);
    for (const era of report(result)['aeren'] as { ohneAufruf: string[] }[]) {
      expect(era.ohneAufruf).toEqual(['ct_docs_read_academy']);
    }
    for (const record of result.records) {
      expect(record.calls).not.toContain('ct_docs_read_academy');
    }
  });

  // Which type ChurchTools names in its hits is shown only for persons: the
  // result says when the log names a hit of another type (ADR 0064).
  it('says when a search gave a hit of another type than the one asked for', async () => {
    const result = await run({ env: search, scenario: 'search-foreign' });
    expect(result.code).toBe(smokeExitCodes.failed);
    for (const era of report(result)['aeren'] as { artfremd: string }[]) {
      expect(era.artfremd).toBe('ja');
    }
    expectClean(result);
  });

  it.each(['masked-letter', 'masked-star', 'masked-literal', 'lone-surrogate'])(
    'passes with every form the server gives an account: %s',
    async (scenario) => {
      const result = await run({ scenario });
      expect(result.code).toBe(smokeExitCodes.ok);
      expect(stateDirsLeft()).toEqual([]);
      expectClean(result);
    },
  );

  it('raises no false alarm for a term that is a fixed word of the log', async () => {
    const result = await run({
      env: { ...search, ECCLIUM_SMOKE_QUERY: 'interactive' },
    });
    expect(result.code).toBe(smokeExitCodes.ok);
    expect(report(result)['fehler']).toEqual([]);
  });

  it('passes with a finding when the account holds a security level of persons or finds nobody', async () => {
    const level = await run({ scenario: 'security-level' });
    expect(level.code).toBe(smokeExitCodes.ok);
    expect(report(level)['befunde']).toEqual(['sicherheitsstufe']);
    // The lowest level of groups belongs to the rights of ct_groups_get.
    const groupLevel = await run({ env: search, scenario: 'group-level' });
    expect(groupLevel.code).toBe(smokeExitCodes.ok);
    expect(report(groupLevel)['befunde']).toEqual([]);
    // A group without details passes with its note on the level.
    const bare = await run({ env: search, scenario: 'group-no-details' });
    expect(bare.code).toBe(smokeExitCodes.ok);
    expect(report(bare)['fehler']).toEqual([]);
    const nobody = await run({ env: search, scenario: 'no-hits' });
    expect(nobody.code).toBe(smokeExitCodes.ok);
    expect(report(nobody)['befunde']).toEqual(['keine_personen_gefunden']);
    for (const era of report(nobody)['aeren'] as { ohneAufruf: string[] }[]) {
      expect(era.ohneAufruf).toEqual([
        'ct_persons_get',
        'ct_persons_get_groups',
      ]);
    }
  });

  it('passes with a finding when no span holds an event or the event has no agenda', async () => {
    const noEvents = await run({ env: search, scenario: 'no-events' });
    expect(noEvents.code).toBe(smokeExitCodes.ok);
    expect(report(noEvents)['befunde']).toEqual(['kein_event_gefunden']);
    for (const era of report(noEvents)['aeren'] as {
      ohneAufruf: string[];
    }[]) {
      expect(era.ohneAufruf).toEqual([
        'ct_events_get',
        'ct_events_get_agenda',
        'ct_services_get_assignments',
      ]);
    }
    // Three spans of 31 days, then the services; no read of an event.
    for (const record of noEvents.records) {
      expect(record.calls.slice(9 + docsCalls.length)).toEqual([
        'ct_events_list',
        'ct_events_list',
        'ct_events_list',
        'ct_services_list',
        'ct_calendars_list',
        'ct_appointments_list',
        'ct_appointments_get',
        'ct_resources_list',
        'ct_bookings_list',
        ...songsAndSearches,
      ]);
    }
    const noAgenda = await run({ env: search, scenario: 'event-no-agenda' });
    expect(noAgenda.code).toBe(smokeExitCodes.ok);
    expect(report(noAgenda)['befunde']).toEqual(['kein_ablauf']);
    expect(report(noAgenda)['fehler']).toEqual([]);
    expectClean(noAgenda);
  });

  it.each([
    [
      'no-calendars',
      'kein_kalender_gefunden',
      [
        'ct_calendars_list',
        'ct_resources_list',
        'ct_bookings_list',
        ...songsAndSearches,
      ],
    ],
    [
      'no-appointments',
      'kein_termin_gefunden',
      [
        'ct_calendars_list',
        'ct_appointments_list',
        'ct_appointments_list',
        'ct_appointments_list',
        'ct_resources_list',
        'ct_bookings_list',
        ...songsAndSearches,
      ],
    ],
    [
      'no-resources',
      'keine_ressource_gefunden',
      [
        'ct_calendars_list',
        'ct_appointments_list',
        'ct_appointments_get',
        'ct_resources_list',
        ...songsAndSearches,
      ],
    ],
    [
      'no-bookings',
      'keine_buchung_gefunden',
      [
        'ct_calendars_list',
        'ct_appointments_list',
        'ct_appointments_get',
        'ct_resources_list',
        'ct_bookings_list',
        'ct_bookings_list',
        'ct_bookings_list',
        ...songsAndSearches,
      ],
    ],
    [
      'no-songs',
      'kein_lied_gefunden',
      [
        'ct_calendars_list',
        'ct_appointments_list',
        'ct_appointments_get',
        'ct_resources_list',
        'ct_bookings_list',
        ...songsAndSearches.filter((call) => call !== 'ct_songs_get'),
      ],
    ],
    [
      'no-categories',
      'keine_kategorie_gefunden',
      [
        'ct_calendars_list',
        'ct_appointments_list',
        'ct_appointments_get',
        'ct_resources_list',
        'ct_bookings_list',
        ...songsAndSearches.filter((call) => call !== 'ct_wiki_pages_list'),
      ],
    ],
    [
      'no-wiki-pages',
      'keine_wikiseite_gefunden',
      [
        'ct_calendars_list',
        'ct_appointments_list',
        'ct_appointments_get',
        'ct_resources_list',
        'ct_bookings_list',
        ...songsAndSearches,
      ],
    ],
    // Without a hit of the search the page comes from the list.
    [
      'no-pages',
      'keine_seite_gefunden',
      [
        'ct_calendars_list',
        'ct_appointments_list',
        'ct_appointments_get',
        'ct_resources_list',
        'ct_bookings_list',
        ...songsAndSearches,
      ],
    ],
    [
      'page-no-guid',
      'seite_ohne_guid',
      [
        'ct_calendars_list',
        'ct_appointments_list',
        'ct_appointments_get',
        'ct_resources_list',
        'ct_bookings_list',
        ...songsAndSearches,
      ],
    ],
    [
      'search-empty',
      'globale_suche_ohne_treffer',
      [
        'ct_calendars_list',
        'ct_appointments_list',
        'ct_appointments_get',
        'ct_resources_list',
        'ct_bookings_list',
        ...songsAndSearches,
      ],
    ],
  ] as const)(
    'passes with a finding for %s',
    async (scenario, finding, calls) => {
      const result = await run({ env: search, scenario });
      expect(result.code).toBe(smokeExitCodes.ok);
      expect(report(result)['befunde']).toEqual([finding]);
      expect(report(result)['fehler']).toEqual([]);
      for (const record of result.records) {
        expect(record.calls.slice(14 + docsCalls.length)).toEqual(calls);
      }
      // The tools that had nothing to be called with.
      const withoutCall: Readonly<Record<string, readonly string[]>> = {
        'no-calendars': ['ct_appointments_get', 'ct_appointments_list'],
        'no-appointments': ['ct_appointments_get'],
        'no-resources': ['ct_bookings_list'],
        'no-songs': ['ct_songs_get'],
        'no-categories': ['ct_wiki_pages_list'],
      };
      for (const era of report(result)['aeren'] as {
        ohneAufruf: string[];
      }[]) {
        expect(era.ohneAufruf).toEqual(withoutCall[scenario] ?? []);
      }
      expectClean(result);
    },
  );

  it('reads the first listed page without a hit of the search', async () => {
    const result = await run({ env: search, scenario: 'no-pages' });
    for (const era of report(result)['aeren'] as {
      aufrufe: { tool: string; quelle?: string }[];
    }[]) {
      expect(
        era.aufrufe.find((call) => call.tool === 'ct_wiki_page_get')?.quelle,
      ).toBe('liste');
    }
  });

  it('names a tool it had nothing to call with, and passes', async () => {
    const result = await run({ env: search, scenario: 'no-page-anywhere' });
    expect(result.code).toBe(smokeExitCodes.ok);
    expect(report(result)['befunde']).toEqual([
      'keine_wikiseite_gefunden',
      'keine_seite_gefunden',
    ]);
    expect(report(result)['fehler']).toEqual([]);
    for (const era of report(result)['aeren'] as { ohneAufruf: string[] }[]) {
      expect(era.ohneAufruf).toEqual(['ct_wiki_page_get']);
    }
    for (const record of result.records) {
      expect(record.calls).not.toContain('ct_wiki_page_get');
    }
    expectClean(result);
  });
});

// The level strict: the smoke test hands the level and the key file to the
// server and checks pseudonyms, shortened last names and the refusal of a
// number in place of a pseudonym (ADR 0069).
describe('the smoke test with the level strict', { timeout }, () => {
  const strict = () => ({
    ECCLIUM_REDACTION: 'strict',
    ECCLIUM_PSEUDONYM_KEY_FILE: keyFile,
  });
  const failures = (result: Run): unknown => report(result)['fehler'];

  it('hands level and key file to the server only with strict', async () => {
    const plain = await run();
    expect(plain.code).toBe(smokeExitCodes.ok);
    expect(report(plain)).toMatchObject({ maskierung: 'standard' });
    for (const record of plain.records) {
      expect(record.variables).not.toHaveProperty('ECCLIUM_REDACTION');
      expect(record.variables).not.toHaveProperty('ECCLIUM_PSEUDONYM_KEY_FILE');
    }
    const result = await run({ env: strict() });
    expect(result.code).toBe(smokeExitCodes.ok);
    expect(report(result)).toMatchObject({
      maskierung: 'strict',
      fehler: [],
      ergebnis: 'bestanden',
    });
    expect(result.records).toHaveLength(2);
    for (const record of result.records) {
      expect(record.variables['ECCLIUM_REDACTION']).toBe('strict');
      expect(record.variables['ECCLIUM_PSEUDONYM_KEY_FILE']).toBe(keyFile);
      expect(record.calls).toEqual(['ct_whoami', ...docsCalls]);
    }
    expectClean(result);
  });

  it('passes with the switch, reads by pseudonym and sees a number refused', async () => {
    const result = await run({ env: { ...search, ...strict() } });
    expect(result.code).toBe(smokeExitCodes.ok);
    expect(report(result)).toMatchObject({
      maskierung: 'strict',
      fehler: [],
      ergebnis: 'bestanden',
    });
    for (const record of result.records) {
      // The probe with a number, then the read with the pseudonym.
      expect(
        record.calls.filter((call) => call === 'ct_persons_get'),
      ).toHaveLength(2);
    }
    const eras = report(result)['aeren'] as {
      aufrufe: { tool: string; ergebnis: string }[];
    }[];
    for (const era of eras) {
      expect(era.aufrufe).toContainEqual({
        tool: 'ct_persons_get rohe Kennung',
        ergebnis: 'abgewiesen',
      });
    }
    expectClean(result);
  });

  it.each([
    [
      'numbers in place of pseudonyms',
      'strict-raw-id',
      ['whoami', 'personensuche'],
    ],
    [
      'last names that are not shortened',
      'strict-long-name',
      ['whoami', 'personensuche'],
    ],
    [
      'a number that is not refused',
      'strict-raw-accepted',
      ['anfragen', 'rohe_kennung'],
    ],
    ['the key on stderr', 'key-stderr', ['schluessel']],
    ['a pseudonym in the log', 'pseudonym-log', ['protokoll']],
  ] as const)('fails for %s', async (_, scenario, codes) => {
    const result = await run({ scenario, env: { ...search, ...strict() } });
    expect(result.code).toBe(smokeExitCodes.failed);
    expect(failures(result)).toEqual(expect.arrayContaining([...codes]));
    expectClean(result);
  });

  it.each([
    ['the level off', { ECCLIUM_REDACTION: 'off' }, 'smokeMaskierungUngueltig'],
    [
      'strict without a key file',
      { ECCLIUM_REDACTION: 'strict' },
      'smokeSchluesselFehlt',
    ],
    [
      'a key file without strict',
      { ECCLIUM_PSEUDONYM_KEY_FILE: '/pfad/zur/schluessel-datei' },
      'smokeSchluesselOhneStrict',
    ],
    [
      'a relative key file',
      { ECCLIUM_REDACTION: 'strict', ECCLIUM_PSEUDONYM_KEY_FILE: 'key' },
      'smokeSchluesselRelativ',
    ],
    [
      'a key file that is not there',
      {
        ECCLIUM_REDACTION: 'strict',
        ECCLIUM_PSEUDONYM_KEY_FILE: '/pfad/zur/schluessel-datei',
      },
      'smokeSchluesselNichtGefunden',
    ],
  ] as const)(
    'ends with 78 for %s, before any request',
    async (_, env, hint) => {
      const result = await run({ env });
      expect(result.code).toBe(smokeExitCodes.configuration);
      expect(result.stderr).toContain(hints[hint]);
      expect(result.fetched).toEqual([]);
      expect(result.records).toEqual([]);
      expectClean(result);
    },
  );

  it('ends with 78 for strict together with the escape hatch, before any request', async () => {
    const result = await run({ env: { ...withApi, ...strict() } });
    expect(result.code).toBe(smokeExitCodes.configuration);
    expect(result.stderr).toContain(hints.smokeApiMitStrict);
    expect(result.fetched).toEqual([]);
    expect(result.records).toEqual([]);
  });

  it('ends with 78 for a key file others may read or that holds no key', async () => {
    const open = join(folder, 'key-offen');
    writeFileSync(open, `${pseudonymKey}\n`, { mode: 0o644 });
    chmodSync(open, 0o644);
    const readable = await run({
      env: { ECCLIUM_REDACTION: 'strict', ECCLIUM_PSEUDONYM_KEY_FILE: open },
    });
    expect(readable.code).toBe(smokeExitCodes.configuration);
    expect(readable.stderr).toContain(hints.smokeSchluesselUnsicher);
    const short = join(folder, 'key-kurz');
    writeFileSync(short, `${pseudonymKey.slice(2)}\n`, { mode: 0o600 });
    chmodSync(short, 0o600);
    const invalid = await run({
      env: { ECCLIUM_REDACTION: 'strict', ECCLIUM_PSEUDONYM_KEY_FILE: short },
    });
    expect(invalid.code).toBe(smokeExitCodes.configuration);
    expect(invalid.stderr).toContain(hints.smokeSchluesselUngueltig);
    for (const result of [readable, invalid]) {
      expect(result.records).toEqual([]);
      expectClean(result);
    }
  });
});

// The real `ecclium stdio` from source, as in tests/stdio-start.test.mts:
// the resolution hook, the network guard in NODE_OPTIONS, a preload that
// sends demo.example to a server of this test on 127.0.0.1, and its
// certificate through NODE_EXTRA_CA_CERTS. These variables come only from
// the seam of the test; a real run passes none of them.
describe.skipIf(process.getuid?.() === 0)(
  'the smoke test against the real server',
  { timeout },
  () => {
    let origin = '';
    let close: () => Promise<void> = () => Promise.resolve();
    let server: ServerStart | undefined;
    const requests: string[] = [];
    // The term each search of songs got, by its operation.
    const songTerms: string[] = [];

    const json = (response: ServerResponse, body: unknown): void => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    const churchTools = (
      request: IncomingMessage,
      response: ServerResponse,
    ): void => {
      const url = new URL(request.url ?? '/', `https://${host}`);
      requests.push(url.pathname);
      const term = url.searchParams.get('query') ?? '';
      if (url.pathname === '/api/whoami') {
        json(response, {
          data: {
            id: 7,
            guid: '00000000-0000-0000-0000-000000000007',
            firstName: `${canary}Vorname`,
            lastName: `${canary}Nachname`,
            email: `${canary}@example.org`,
          },
        });
      } else if (url.pathname === '/api/permissions/global') {
        json(response, {
          data: {
            churchdb: { 'view alldata': [2] },
            churchgroup: {
              'view groups of grouptype': [3],
              'security level group': [1],
            },
            churchwiki: { view: true, 'view category': [12] },
          },
        });
      } else if (url.pathname === '/api/persons/11') {
        json(response, {
          data: {
            id: 11,
            guid: '00000000-0000-0000-0000-000000000011',
            firstName: `${canary}Erika`,
            lastName: `${canary}Muster`,
            isArchived: false,
          },
        });
      } else if (url.pathname === '/api/persons/11/groups') {
        json(response, {
          data: [
            {
              group: { domainIdentifier: '21', title: `${canary}Gruppe` },
              person: { title: '' },
              groupTypeRoleId: 8,
              groupMemberStatus: 'active',
            },
          ],
          meta: { count: 1 },
        });
      } else if (url.pathname === '/api/groups/21') {
        json(response, {
          data: {
            id: 21,
            name: `${canary}Gruppe`,
            information: {
              meetingTime: `${canary}Dienstag`,
              note: '',
              maxMembers: null,
              targetGroupId: null,
              dateOfFoundation: null,
              endDate: null,
            },
          },
        });
      } else if (url.pathname === '/api/groups/21/members') {
        json(response, {
          data: [
            {
              personId: 11,
              person: {
                domainAttributes: {
                  firstName: `${canary}Erika`,
                  lastName: `${canary}Muster`,
                },
              },
              groupTypeRoleId: 8,
              groupMemberStatus: 'active',
            },
          ],
          meta: {
            pagination: { total: 1, limit: 50, current: 1, lastPage: 1 },
          },
        });
      } else if (url.pathname === '/api/events') {
        json(response, {
          data: [
            {
              id: 31,
              name: `${canary}Gottesdienst`,
              startDate: '2026-10-25T09:00:00Z',
              endDate: '2026-10-25T10:30:00Z',
              isCanceled: false,
              calendar: { domainIdentifier: '8', title: `${canary}Kalender` },
            },
          ],
          meta: { count: 1 },
        });
      } else if (url.pathname === '/api/events/31') {
        // One answer for the event and for its assignments, as ChurchTools
        // gives it: the assignment of a service that hides the names
        // carries a placeholder and no positive ID (F37).
        json(response, {
          data: {
            id: 31,
            name: `${canary}Gottesdienst`,
            startDate: '2026-10-25T09:00:00Z',
            endDate: '2026-10-25T10:30:00Z',
            isCanceled: false,
            calendar: { domainIdentifier: '8', title: `${canary}Kalender` },
            note: `${canary}Notiz`,
            description: null,
            eventServices: [
              {
                serviceId: 11,
                isAccepted: true,
                agreed: true,
                personId: 11,
                person: {
                  domainAttributes: {
                    firstName: `${canary}Erika`,
                    lastName: `${canary}Muster`,
                  },
                },
                requesterPerson: {
                  domainAttributes: {
                    firstName: `${canary}Anfrage`,
                    lastName: `${canary}Person`,
                  },
                },
              },
              {
                serviceId: 14,
                isAccepted: false,
                agreed: false,
                personId: 0,
                person: {
                  domainAttributes: {
                    firstName: '',
                    lastName: `${canary}Platzhalter`,
                  },
                },
              },
            ],
          },
        });
      } else if (url.pathname === '/api/events/31/agenda') {
        json(response, {
          data: {
            name: `${canary}Ablauf`,
            isFinal: false,
            items: [
              {
                position: 1,
                type: 'song',
                title: `${canary}Punkt`,
                start: '2026-10-25T09:00:00Z',
                duration: 300,
                isBeforeEvent: false,
                note: null,
                song: {
                  songId: 2,
                  arrangementId: 3,
                  title: `${canary}Lied`,
                  arrangement: null,
                },
                responsible: { text: `${canary}Verantwortlich`, persons: [] },
              },
            ],
          },
        });
      } else if (url.pathname === '/api/services') {
        json(response, {
          data: [
            {
              id: 11,
              name: `${canary}DienstA`,
              serviceGroupId: 5,
              hidePersonName: false,
            },
            {
              id: 14,
              name: `${canary}DienstB`,
              serviceGroupId: 5,
              hidePersonName: true,
            },
          ],
          meta: { count: 2 },
        });
      } else if (url.pathname === '/api/servicegroups') {
        json(response, {
          data: [{ id: 5, name: `${canary}Dienstgruppe` }],
          meta: { count: 1 },
        });
      } else if (url.pathname === '/api/calendars') {
        json(response, {
          data: [
            {
              id: 8,
              name: `${canary}Kalender`,
              randomUrl: `${canary}Abo`,
              isPublic: false,
              isPrivate: false,
            },
          ],
          meta: { count: 1 },
        });
      } else if (url.pathname === '/api/calendars/appointments') {
        // One appointment with a place and one of whole days, as a day
        // alone; the street of the place and the copies above appointment
        // reach no output.
        const base = {
          id: 5,
          title: `${canary}Termin`,
          subtitle: null,
          allDay: false,
          calendar: { id: 8, randomUrl: `${canary}Abo` },
          address: { name: `${canary}Saal`, street: `${canary}Strasse` },
        };
        json(response, {
          data: [
            {
              appointment: {
                base,
                calculated: {
                  startDate: '2026-10-25T18:00:00Z',
                  endDate: '2026-10-25T19:00:00Z',
                },
              },
              base,
            },
            {
              appointment: {
                base: {
                  ...base,
                  id: 6,
                  allDay: true,
                  address: null,
                },
                calculated: {
                  startDate: '2026-10-26',
                  endDate: '2026-10-26',
                },
              },
            },
          ],
          meta: { count: 2 },
        });
      } else if (url.pathname === '/api/calendars/8/appointments/5') {
        json(response, {
          data: {
            appointment: {
              id: 5,
              title: `${canary}Termin`,
              subtitle: null,
              allDay: false,
              calendar: { id: 8, randomUrl: `${canary}Abo` },
              address: { name: `${canary}Saal`, street: `${canary}Strasse` },
              description: `${canary}Beschreibung`,
              link: null,
              onBehalfOfPid: 11,
            },
            additionalInfos: [],
            calculatedDates: {
              '2026-10-25': {
                startDate: '2026-10-25T18:00:00Z',
                endDate: '2026-10-25T19:00:00Z',
                iCalUid: `${canary}Uid`,
              },
            },
          },
        });
      } else if (url.pathname === '/api/resources') {
        json(response, {
          data: [
            {
              id: 8,
              name: `${canary}Raum`,
              resourceTypeId: 5,
              randomString: `${canary}Zufall`,
            },
          ],
          meta: { count: 1 },
        });
      } else if (url.pathname === '/api/resourcetypes') {
        json(response, {
          data: [{ id: 5, name: `${canary}Raeume` }],
          meta: { count: 1 },
        });
      } else if (url.pathname === '/api/bookings') {
        json(response, {
          data: [
            {
              booking: {
                base: {
                  id: 2,
                  title: `${canary}Buchung`,
                  resourceId: 8,
                  statusId: 2,
                  appointmentId: 5,
                  answeredPid: 11,
                  caption: `${canary}Beschriftung`,
                },
                calculated: {
                  startDate: '2026-10-25T18:00:00Z',
                  endDate: '2026-10-25T19:00:00Z',
                },
              },
            },
          ],
          meta: { count: 1 },
        });
      } else if (
        url.pathname === '/api/songs' ||
        url.pathname === '/api/songs/2'
      ) {
        // A song with its whole category, the files and the note of its
        // arrangement, which reach no output.
        const song = {
          id: 2,
          name: `${canary}Lied`,
          category: { id: 4, name: `${canary}Kategorie` },
          author: null,
          copyright: `${canary}Verlag`,
          ccli: null,
          arrangements: [
            {
              id: 3,
              name: `${canary}Standard`,
              key: 'G',
              isDefault: true,
              files: [{ name: `${canary}Datei` }],
            },
          ],
          note: `${canary}Notiz`,
        };
        if (url.pathname === '/api/songs') {
          songTerms.push(`songs ${term}`);
          json(response, {
            data: [song],
            meta: {
              count: 1,
              pagination: { total: 1, limit: 10, current: 1, lastPage: 1 },
            },
          });
        } else {
          json(response, { data: song });
        }
      } else if (url.pathname === '/api/wiki/categories') {
        json(response, {
          data: [
            {
              id: 12,
              name: `${canary}Kategorie`,
              permissions: { canEdit: false, canDelete: false },
            },
          ],
        });
      } else if (url.pathname === '/api/wiki/pages') {
        json(response, {
          data: [
            {
              guid: pageGuid,
              title: `${canary}Liste`,
              isMarkdown: true,
              version: 2,
              meta: { createdPerson: { title: `${canary}Autor` } },
            },
          ],
          meta: {
            pagination: { total: 1, limit: 25, current: 1, lastPage: 1 },
          },
        });
      } else if (url.pathname === '/api/wiki/search') {
        json(response, {
          data: [
            {
              title: `${canary}Seite`,
              domainType: 'wiki_page',
              domainIdentifier: pageGuid,
              frontendUrl: `${canary}Verweis`,
              domainAttributes: { wikiCategoryId: 12 },
              preview: `${canary}Vorschau`,
            },
          ],
          meta: { count: 1 },
        });
      } else if (url.pathname === `/api/wiki/categories/12/pages/${pageGuid}`) {
        json(response, {
          data: {
            title: `${canary}Seite`,
            isMarkdown: true,
            version: 2,
            text: `${canary}Text`,
          },
        });
      } else if (url.pathname === '/api/search') {
        // One hit of the type asked for, with the names of a person under
        // domainAttributes, which reach no output.
        const type = url.searchParams.get('domain_types[]') ?? '';
        if (type === 'song') songTerms.push(`search ${term}`);
        const hits: Readonly<Record<string, Record<string, unknown>>> = {
          person: {
            domainIdentifier: '11',
            title: `${canary}Erika ${canary}Muster`,
            domainAttributes: {
              firstName: `${canary}Erika`,
              lastName: `${canary}Muster`,
            },
          },
          group: { domainIdentifier: '21', title: `${canary}Gruppe` },
          song: {
            domainIdentifier: '2',
            title: `${canary}Lied`,
            domainAttributes: [],
          },
          wiki_page: {
            domainIdentifier: pageGuid,
            title: `${canary}Seite`,
            domainAttributes: { wikiCategoryId: 12 },
          },
        };
        const hit = hits[type];
        json(response, {
          data:
            hit === undefined
              ? []
              : [{ ...hit, domainType: type, apiUrl: `${canary}Api` }],
          meta: { count: 1 },
        });
      } else if (url.pathname === '/api/persons') {
        json(response, {
          data: term.startsWith('zq')
            ? []
            : [
                {
                  id: 11,
                  firstName: `${canary}Erika`,
                  lastName: `${canary}Muster`,
                  email: `${canary}.person@example.org`,
                },
              ],
          meta: { count: 1 },
        });
      } else if (url.pathname === '/api/groups') {
        json(response, {
          data: [{ id: 21, name: `${canary}Gruppe` }],
          meta: { count: 1 },
        });
      } else {
        response.writeHead(404);
        response.end();
      }
    };

    beforeAll(async () => {
      const certificate = makeCertificate(findOpenssl(), folder, 'demo', host);
      const https = createServer(
        {
          key: readFileSync(certificate.key),
          cert: readFileSync(certificate.cert),
        },
        churchTools,
      );
      await new Promise<void>((resolve) => {
        https.listen(0, '127.0.0.1', resolve);
      });
      const address = https.address();
      const port =
        typeof address === 'object' && address !== null ? address.port : 0;
      origin = `https://${host}:${String(port)}`;
      close = () =>
        new Promise((resolve) => {
          https.closeAllConnections();
          https.close(() => {
            resolve();
          });
        });
      server = {
        executable: process.execPath,
        preArgs: [
          '--conditions=@ecclium/source',
          `--import=${new URL('../fixtures/stdio/hooks.mts', import.meta.url).href}`,
          `--import=${new URL('../fixtures/start/redirect.mts', import.meta.url).href}`,
        ],
        entry: fileURLToPath(
          new URL('../../packages/cli/src/bin.ts', import.meta.url),
        ),
        env: {
          NODE_OPTIONS: guardPreload,
          NODE_EXTRA_CA_CERTS: certificate.cert,
        },
      };
    }, timeout);

    afterAll(async () => {
      await close();
    });

    it('passes without the switch, with ct_whoami and the docs tools', async () => {
      // The docs tools read the docs index that pnpm build writes, as in
      // CI; without it the server stops at the start.
      expect(
        existsSync(
          new URL(
            '../../packages/docs-index/dist/docs-index.json',
            import.meta.url,
          ),
        ),
        'pnpm build writes the docs index',
      ).toBe(true);
      requests.length = 0;
      const result = await run({ origin, server });
      expect(result.stderr).toBe('');
      expect(result.code).toBe(smokeExitCodes.ok);
      expect(report(result)).toMatchObject({
        suchtools: 'nein',
        fehler: [],
        ergebnis: 'bestanden',
      });
      expect([...new Set(requests)].sort()).toEqual([
        '/api/permissions/global',
        '/api/whoami',
      ]);
      expectClean(result);
    });

    it('passes with the switch, with the search tools in both eras', async () => {
      requests.length = 0;
      songTerms.length = 0;
      const result = await run({ origin, server, env: search });
      expect(result.stderr).toBe('');
      expect(result.code).toBe(smokeExitCodes.ok);
      expect(report(result)).toMatchObject({
        suchtools: 'ja',
        churchtools: '3.137',
        befunde: [],
        fehler: [],
        ergebnis: 'bestanden',
      });
      // Per era: two for ct_whoami, one for each search with a term, each
      // read by ID and each list of events, calendars, appointments and
      // bookings, none for the term of spaces, and two each for the
      // assignments, the services and the resources; then one each for the
      // songs, the first song, the categories and the pages of the wiki,
      // the search in it, its first page and the four types of the global
      // search.
      expect(requests).toHaveLength(64);
      // Without a term of its own the songs take the term of the persons.
      expect(songTerms).toEqual(
        Array.from({ length: 2 }, () => [
          `songs ${query}`,
          `search ${query}`,
        ]).flat(),
      );
      expect(stateDirsLeft()).toEqual([]);
      expectClean(result);
    });

    it('passes with both switches, with the escape hatch reading two operations', async () => {
      requests.length = 0;
      const result = await run({ origin, server, env: withApi });
      expect(result.stderr).toBe('');
      expect(result.code).toBe(smokeExitCodes.ok);
      expect(report(result)).toMatchObject({
        suchtools: 'ja',
        api: 'ja',
        befunde: [],
        fehler: [],
        ergebnis: 'bestanden',
      });
      // Per era the 32 of the run with the switch, then one each for the
      // categories of the wiki and the rights of the account; the three
      // refusals send nothing.
      expect(requests).toHaveLength(68);
      expect(requests).not.toContain('/api/csrftoken');
      // Per era the categories once for the tool of the wiki and once for
      // the escape hatch, the rights once for ct_whoami and once for it.
      for (const path of ['/api/wiki/categories', '/api/permissions/global']) {
        expect(
          requests.filter((request) => request === path),
          path,
        ).toHaveLength(4);
      }
      expect(stateDirsLeft()).toEqual([]);
      expectClean(result);
    });

    it('passes with the switch in strict, with pseudonyms of the real server', async () => {
      requests.length = 0;
      const result = await run({
        origin,
        server,
        env: {
          ...search,
          ECCLIUM_REDACTION: 'strict',
          ECCLIUM_PSEUDONYM_KEY_FILE: keyFile,
        },
      });
      expect(result.stderr).toBe('');
      expect(result.code).toBe(smokeExitCodes.ok);
      expect(report(result)).toMatchObject({
        maskierung: 'strict',
        befunde: [],
        fehler: [],
        ergebnis: 'bestanden',
      });
      // As without strict: the number in place of a pseudonym sends nothing.
      expect(requests).toHaveLength(64);
      expect(stateDirsLeft()).toEqual([]);
      expectClean(result);
    });

    it('gives the searches of songs their own term when there is one', async () => {
      songTerms.length = 0;
      const result = await run({
        origin,
        server,
        env: { ...search, ECCLIUM_SMOKE_SONG_QUERY: songQuery },
      });
      expect(result.code).toBe(smokeExitCodes.ok);
      expect(songTerms).toEqual(
        Array.from({ length: 2 }, () => [
          `songs ${songQuery}`,
          `search ${songQuery}`,
        ]).flat(),
      );
      expectClean(result);
    });
  },
);
