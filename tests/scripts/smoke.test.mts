import { randomBytes } from 'node:crypto';
import {
  chmodSync,
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
const missTerm = 'zqmissingterm';
const timeout = 120_000;

let folder = '';
let tokenFile = '';

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), 'ecclium-smoke-test-'));
  tokenFile = join(folder, 'token');
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
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

/** Nothing from the instance, the token or the term reaches the output. */
const expectClean = (result: Run): void => {
  const output = result.stdout + result.stderr;
  for (const value of [canary, token, query, host, tokenFile, folder]) {
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
  it('calls only ct_whoami without the switch, in both eras, and sends nothing itself', async () => {
    const result = await run();
    expect(result.code).toBe(smokeExitCodes.ok);
    expect(report(result)).toMatchObject({
      suchtools: 'nein',
      fehler: [],
      befunde: [],
      ergebnis: 'bestanden',
    });
    expect(report(result)['aeren']).toHaveLength(2);
    expect(result.records).toHaveLength(2);
    for (const record of result.records) {
      expect(record.calls).toEqual(['ct_whoami']);
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
      expect(record.variables['ECCLIUM_TOOLSETS']).toBe('persons,events');
      expect(record.calls).toEqual([
        'ct_whoami',
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
      ]);
    }
    expect(stateDirsLeft()).toEqual([]);
    expectClean(result);
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
  });

  it('passes with a finding when no span holds an event or the event has no agenda', async () => {
    const noEvents = await run({ env: search, scenario: 'no-events' });
    expect(noEvents.code).toBe(smokeExitCodes.ok);
    expect(report(noEvents)['befunde']).toEqual(['kein_event_gefunden']);
    // Three spans of 31 days, then the services; no read of an event.
    for (const record of noEvents.records) {
      expect(record.calls.slice(9)).toEqual([
        'ct_events_list',
        'ct_events_list',
        'ct_events_list',
        'ct_services_list',
      ]);
    }
    const noAgenda = await run({ env: search, scenario: 'event-no-agenda' });
    expect(noAgenda.code).toBe(smokeExitCodes.ok);
    expect(report(noAgenda)['befunde']).toEqual(['kein_ablauf']);
    expect(report(noAgenda)['fehler']).toEqual([]);
    expectClean(noAgenda);
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

    it('passes without the switch, with ct_whoami alone', async () => {
      requests.length = 0;
      const result = await run({ origin, server });
      expect(result.stderr).toBe('');
      expect(result.code).toBe(smokeExitCodes.ok);
      expect(report(result)).toMatchObject({
        suchtools: 'nein',
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
      // read by ID and the list of events, none for the term of spaces,
      // and two each for the assignments and the services.
      expect(requests).toHaveLength(32);
      expect(stateDirsLeft()).toEqual([]);
      expectClean(result);
    });
  },
);
