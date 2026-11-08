import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { chainsFit } from '../../scripts/smoke-write/commands.mts';
import { stepNames } from '../../scripts/smoke-write/course.mts';
import {
  runDay,
  runSmokeWrite,
  smokeWriteExitCodes,
  type WriteServerStart,
} from '../../scripts/smoke-write/main.mts';
import {
  startServer,
  type ServerRequestHandler,
} from '../../scripts/smoke/session.mts';
import { hints, type HintKey } from '../../scripts/spike/lib/errors.mts';
import type { Input } from '../../scripts/spike/lib/gate.mts';
import {
  readCalendarState,
  readWriteState,
} from '../../scripts/spike/lib/write-state.mts';
import type {
  StandInCall,
  StandInConfig,
  StandInState,
} from '../fixtures/smoke-write/church-tools.mts';
import {
  prepareRun,
  smokeEnv,
  standInConfig,
  standInHost,
  startStandIn,
  type RunFiles,
} from '../fixtures/smoke-write/setup.mts';
import {
  findOpenssl,
  makeCertificate,
  type Certificate,
} from '../support/certificates.mts';
import { guardPreload } from '../support/no-network.mts';

// The smoke test for writing against a stand-in of ChurchTools that keeps
// what the server writes (tests/fixtures/smoke-write/). The guard reads
// through a fetch of this test, the real server from source writes over
// TLS, and both reach the same state in a process of the stand-in on
// 127.0.0.1, so no request leaves the machine (ADR 0052). Token and names
// are canaries; none may reach the output.

const token = `t${randomBytes(20).toString('hex')}`;
const canary = `c${randomBytes(6).toString('hex')}`;
// One clock for every run, so that a test knows the day the run writes on.
const now = new Date();
const day = runDay(now);
// Every `ecclium undo`, `queue` and `audit verify` of a run is a process of
// its own that loads the source, so a run takes a while.
const fullRun = 600_000;

let base = '';
let certificate: Certificate | undefined;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'ecclium-smoke-write-test-'));
  certificate = makeCertificate(findOpenssl(), base, 'demo', standInHost);
});

afterAll(() => {
  if (base !== '') rmSync(base, { recursive: true, force: true });
});

// The real `ecclium` from source, as in tests/scripts/smoke.test.mts: the
// resolution hook, the network guard in NODE_OPTIONS, the preload that
// sends demo.example to 127.0.0.1 and the certificate of the stand-in.
// These variables come only from the seam of the test.
const realServer = (): WriteServerStart => ({
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
    NODE_EXTRA_CA_CERTS: certificate?.cert ?? '',
    // The test waits not at all between two writes, where a real run waits
    // a second, and the throttle of the core would refuse the burst
    // (packages/core/src/throttle/token-bucket.ts); 500 is its highest rate.
    ECCLIUM_CHURCHTOOLS_REQUESTS_PER_MINUTE: '500',
  },
});

interface Options {
  /** How the stand-in holds and misbehaves. */
  readonly standIn?: Partial<StandInConfig>;
  /** Changes of the environment; `undefined` removes a variable. */
  readonly env?: (
    files: RunFiles,
  ) => Readonly<Record<string, string | undefined>>;
  readonly args?: readonly string[];
  /** What the person types; `undefined` is the end of the input. */
  readonly answer?: string | undefined;
  /** Whether stdin is a terminal. */
  readonly terminal?: boolean;
}

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly calls: readonly StandInCall[];
  readonly state: StandInState;
  readonly files: RunFiles;
  readonly config: StandInConfig;
  readonly origin: string;
  readonly prompts: readonly string[];
  readonly tracked: readonly {
    readonly folder: string;
    readonly exists: boolean;
  }[];
}

const run = async (options: Options = {}): Promise<Run> => {
  if (certificate === undefined) throw new Error('no certificate');
  const config = standInConfig(token, canary, options.standIn);
  const standIn = await startStandIn(config, certificate);
  try {
    const files = prepareRun(base, token, standIn.origin);
    const env: Record<string, string | undefined> = {
      ...smokeEnv(standIn.origin, files, config),
      ...options.env?.(files),
    };
    let stdout = '';
    let stderr = '';
    const prompts: string[] = [];
    const answer = 'answer' in options ? options.answer : 'ja';
    const input: Input = {
      isTerminal: options.terminal ?? true,
      readLine: (prompt) => {
        prompts.push(prompt);
        return Promise.resolve(answer);
      },
    };
    const tracked: { folder: string; exists: boolean }[] = [];
    const code = await runSmokeWrite({
      env: Object.fromEntries(
        Object.entries(env).filter(([, value]) => value !== undefined),
      ),
      args: options.args ?? [],
      io: {
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      },
      fetch: standIn.fetch,
      input,
      platform: process.platform,
      tmpdir: files.tmp,
      server: realServer(),
      deadlines: { answer: 120_000, end: 30_000 },
      wait: () => Promise.resolve(),
      now: () => now,
      track: (folder, exists) => {
        tracked.push({ folder, exists });
      },
    });
    return {
      code,
      stdout,
      stderr,
      calls: await standIn.calls(),
      state: await standIn.state(),
      files,
      config,
      origin: standIn.origin,
      prompts,
      tracked,
    };
  } finally {
    await standIn.stop();
  }
};

const report = (result: Run): Record<string, unknown> =>
  JSON.parse(result.stdout) as Record<string, unknown>;

/** Nothing of the stand-in, the token or the machine reaches the output. */
const expectClean = (result: Run): void => {
  const output = result.stdout + result.stderr;
  for (const value of [
    token,
    canary,
    standInHost,
    base,
    result.files.tokenFile,
    result.origin,
  ]) {
    expect(output).not.toContain(value);
  }
};

/** Neither the guard nor the server sent anything that writes. */
const expectNoWrite = (result: Run): void => {
  expect(result.calls.filter((call) => call.method !== 'GET')).toEqual([]);
  expect(existsSync(result.files.writeStateFile)).toBe(false);
  expect(existsSync(result.files.calendarStateFile)).toBe(false);
  expect(result.tracked).toEqual([]);
  expect(readdirSync(result.files.tmp)).toEqual([]);
};

/** Every folder of the run was announced, then removed. */
const expectFoldersGone = (result: Run): void => {
  const made = result.tracked.filter((entry) => entry.exists);
  expect(made).toHaveLength(3);
  for (const { folder } of made) {
    expect(result.tracked).toContainEqual({ folder, exists: false });
    expect(existsSync(folder)).toBe(false);
  }
  expect(readdirSync(result.files.tmp)).toEqual([]);
};

// The writes of a run by method and path, IDs and GUIDs replaced, counted.
const writesOf = (result: Run): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const call of result.calls) {
    if (call.method === 'GET') continue;
    const key = `${call.method} ${call.path}`
      .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27}/giu, '/{guid}')
      .replace(/\/\d+/gu, '/{id}');
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
};

// The end of the result, with the failures in the order of the smoke test:
// the steps, then the chain, then what stays.
const passed = (
  steps: readonly string[],
  leftovers: readonly string[] = [],
) => {
  const fehler = [...steps, ...leftovers];
  return {
    fehler,
    ergebnis: fehler.length === 0 ? 'bestanden' : 'gescheitert',
  };
};

const withdrawal =
  /^Diese Seite hat Ecclium am \d{2}\.\d{2}\.\d{4} angelegt und am \d{2}\.\d{2}\.\d{4} zurückgenommen\.\n?$/u;
const runTitle = /^spike-schreibprobe-[0-9a-f]{8}-/u;

describe.skipIf(process.getuid?.() === 0)(
  'the smoke test for writing against the real server',
  () => {
    it(
      'writes, confirms in every way, takes back and leaves the page and one appointment',
      async () => {
        const result = await run();
        expect(result.stderr).toBe('');
        // A server that writes logs an anchor after each write, and
        // audit verify takes every one of them (ADR 0028).
        expect(result.code, result.stdout).toBe(smokeWriteExitCodes.ok);
        expect(report(result)).toEqual({
          befunde: [],
          // Undo of the first section refused, the second taken back, the
          // first refused again and taken back with --overwrite; then the
          // appointments, the booking, the queued change, the appointment
          // changed since it was created refused, and the page.
          diagnose: {
            audit: [],
            zuruecknahmen: [65, 0, 65, 0, 0, 0, 0, 0, 0, 65, 0, 0, 0],
          },
          smoketest: 'ecclium-schreiben',
          churchtools: '3.138',
          kennkategorie: 'gefunden',
          schritte: stepNames.map((name) => ({
            schritt: name,
            ergebnis: 'wie erwartet',
          })),
          audit: {
            aufrufe: 'wie erwartet',
            betreiber: 'wie erwartet',
            sauber: 'ja',
          },
          kette: 'wie erwartet',
          token: 'nirgends',
          rechte: 'eng',
          reste: { seite: 'ja', termin: 'ja', buchung: 'nein' },
          aufraeumen: ['07-wiki-cleanup', '11-calendar-write'],
          ...passed([]),
        });
        // One question, after every check of the guard.
        expect(result.prompts).toHaveLength(1);
        // The guard only reads; every write comes from the server: the
        // page, nine changes of its text, three appointments with four
        // changes and two deletions, one booking and its deletion.
        expect(
          result.calls.filter(
            (call) => call.via === 'guard' && call.method !== 'GET',
          ),
        ).toEqual([]);
        expect(writesOf(result)).toEqual({
          'POST /api/wiki/categories/{id}/pages': 1,
          'PATCH /api/wiki/categories/{id}/pages/{guid}': 9,
          'POST /api/calendars/{id}/appointments': 3,
          'PUT /api/calendars/{id}/appointments/{id}': 4,
          'DELETE /api/calendars/{id}/appointments/{id}': 2,
          'POST /api/bookings': 1,
          'DELETE /api/bookings/{id}': 1,
        });
        expect(result.calls.filter((call) => call.status === 401)).toEqual([]);

        // The page stays with the sentence of the withdrawal, the second
        // appointment stays, the booking is gone.
        const page = result.state.pages.find((entry) =>
          runTitle.test(entry.title),
        );
        expect(page?.title).toMatch(/^spike-schreibprobe-[0-9a-f]{8}-smoke$/u);
        expect(page?.text).toMatch(withdrawal);
        expect(result.state.appointments).toHaveLength(1);
        expect(result.state.appointments[0]?.title).toMatch(
          /^spike-schreibprobe-[0-9a-f]{8}-termin-2$/u,
        );
        expect(result.state.bookings).toEqual([]);

        // Both state files name what stays, for 07 and 11.
        const pages = readWriteState(
          result.files.writeStateFile,
          result.origin,
          result.config.category,
        );
        expect(pages.pages).toEqual([
          { guid: page?.guid, role: 'smoke', baseline: undefined },
        ]);
        const entries = readCalendarState(
          result.files.calendarStateFile,
          result.origin,
          {
            calendar: result.config.calendar,
            resource: result.config.resource,
          },
        );
        expect(entries.day).toBe(day);
        expect(entries.appointments).toEqual([
          result.state.appointments[0]?.id,
        ]);
        expect(entries.bookings).toEqual([]);

        expectFoldersGone(result);
        expectClean(result);
      },
      fullRun,
    );

    it(
      'fails the undo of an appointment that a deletion left in place, and keeps all three for 11-calendar-write',
      async () => {
        const result = await run({ standIn: { deleteKeepsAppointment: true } });
        expect(result.stderr).toBe('');
        expect(result.code, result.stdout).toBe(smokeWriteExitCodes.failed);
        expect(report(result)).toMatchObject({
          reste: { seite: 'ja', termin: 'ja', buchung: 'nein' },
          aufraeumen: ['07-wiki-cleanup', '11-calendar-write'],
          ...passed(['termin_ruecknahme', 'termin_echo'], ['reste']),
        });
        // The diagnosis names the undo that did not end with 0 or 65.
        const { diagnose } = report(result) as {
          readonly diagnose: { readonly zuruecknahmen: readonly unknown[] };
        };
        expect(
          diagnose.zuruecknahmen.some((code) => code !== 0 && code !== 65),
        ).toBe(true);
        expect(result.state.appointments).toHaveLength(3);
        const entries = readCalendarState(
          result.files.calendarStateFile,
          result.origin,
          {
            calendar: result.config.calendar,
            resource: result.config.resource,
          },
        );
        expect([...entries.appointments].sort()).toEqual(
          result.state.appointments.map((entry) => entry.id).sort(),
        );
        expectFoldersGone(result);
        expectClean(result);
      },
      fullRun,
    );

    it(
      'passes with a finding when the list of bookings leaves the request out',
      async () => {
        const result = await run({
          standIn: { defaultBookingStatuses: [2, 3] },
        });
        expect(result.stderr).toBe('');
        // The request is found past the tool, in every status, and its undo
        // reads the booking itself, so only the finding tells of the list.
        expect(result.code, result.stdout).toBe(smokeWriteExitCodes.ok);
        expect(report(result)).toMatchObject({
          befunde: ['buchungsliste_ohne_anfrage'],
          ...passed([]),
        });
        expect(result.state.bookings).toEqual([]);
        expectFoldersGone(result);
        expectClean(result);
      },
      fullRun,
    );

    it(
      'fails the request of a booking that the resource approved by itself',
      async () => {
        const result = await run({ standIn: { bookingStatus: 2 } });
        expect(result.stderr).toBe('');
        expect(result.code, result.stdout).toBe(smokeWriteExitCodes.failed);
        expect(report(result)).toMatchObject({
          reste: { seite: 'ja', termin: 'ja', buchung: 'nein' },
          ...passed(['buchung_anfragen']),
        });
        expect(result.state.bookings).toEqual([]);
        expectFoldersGone(result);
        expectClean(result);
      },
      fullRun,
    );
  },
);

describe('the smoke test for writing refuses before anything is written', () => {
  const refusals: readonly (readonly [
    string,
    Options,
    number,
    HintKey,
    'none' | 'reads',
  ])[] = [
    [
      'without the switch',
      { env: () => ({ ECCLIUM_SPIKE_ALLOW_WRITE: undefined }) },
      smokeWriteExitCodes.refused,
      'schalterFehlt',
      'none',
    ],
    [
      'with a switch that is not the first label of the host',
      { env: () => ({ ECCLIUM_SPIKE_ALLOW_WRITE: 'andere' }) },
      smokeWriteExitCodes.refused,
      'schalterFalsch',
      'none',
    ],
    [
      'with the token variable of the read account set as well',
      { env: (files) => ({ ECCLIUM_SPIKE_TOKEN_FILE: files.tokenFile }) },
      smokeWriteExitCodes.refused,
      'zweiTokenVariablen',
      'none',
    ],
    [
      'without the calendar state file',
      { env: () => ({ ECCLIUM_SPIKE_WRITE_CALENDAR_STATE_FILE: undefined }) },
      smokeWriteExitCodes.configuration,
      'schreibSmokeKalenderStateFehlt',
      'none',
    ],
    [
      'with an argument',
      { args: ['--ja'] },
      smokeWriteExitCodes.usage,
      'schreibSmokeAufruf',
      'none',
    ],
    [
      'without a terminal',
      { terminal: false },
      smokeWriteExitCodes.refused,
      'keinTerminal',
      'none',
    ],
    [
      'without the identification category',
      { standIn: { withIdentification: false } },
      smokeWriteExitCodes.refused,
      'kennkategorieFehlt',
      'reads',
    ],
    [
      'with a foreign page in the write area',
      { standIn: { foreignPage: true } },
      smokeWriteExitCodes.refused,
      'fremdeSeiten',
      'reads',
    ],
    [
      'with a foreign appointment on the day of the run',
      { standIn: { foreignAppointmentOn: day } },
      smokeWriteExitCodes.refused,
      'fremdeTermine',
      'reads',
    ],
    [
      'with an answer other than «ja»',
      { answer: 'Ja' },
      smokeWriteExitCodes.refused,
      'nichtBestaetigt',
      'reads',
    ],
    [
      'at the end of the input',
      { answer: undefined },
      smokeWriteExitCodes.refused,
      'nichtBestaetigt',
      'reads',
    ],
  ];

  it.each(refusals)(
    'ends %s with its code and its hint',
    async (_name, options, code, hint, requests) => {
      const result = await run(options);
      expect(result.code).toBe(code);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(`Code: KONFIGURATION\n${hints[hint]}\n`);
      expectNoWrite(result);
      if (requests === 'none') {
        expect(result.calls).toEqual([]);
      } else {
        // Only the reads of the guard, before or after its one question.
        expect(result.calls.length).toBeGreaterThan(0);
        expect(result.calls.every((call) => call.via === 'guard')).toBe(true);
      }
      expect(result.prompts).toHaveLength(hint === 'nichtBestaetigt' ? 1 : 0);
      expectClean(result);
    },
    60_000,
  );
});

// A server that asks its client, as the server of Ecclium does in the 2025
// era before a write: the session answers with the handler of the smoke
// test, or with the error of an unknown method.
// The check of the audit files at the end of a run: every file anchored,
// fitting and closed (ADR 0028).
describe('the check of the chains of the smoke test for writing', () => {
  const fitting =
    'Prüfung der Audit-Dateien\n  Dateien mit einem Anker aus dem Log: 2, davon passend 2, nach Ablauf der Frist gelöscht 0\n';
  const run = (status: number | null, stdout: string) => ({
    status,
    stdout,
    stderr: '',
  });

  it('takes every file anchored, fitting and closed', () => {
    expect(chainsFit(run(0, fitting))).toBe(true);
  });

  it('refuses a file left open, one that does not fit, no anchor and a finding', () => {
    expect(
      chainsFit(
        run(
          0,
          `${fitting}  Davon ohne Anker beim Schliessen: 1. Ihr Server läuft noch.\n`,
        ),
      ),
    ).toBe(false);
    expect(chainsFit(run(0, fitting.replace('passend 2', 'passend 1')))).toBe(
      false,
    );
    expect(
      chainsFit(
        run(
          0,
          fitting.replace('Log: 2, davon passend 2', 'Log: 0, davon passend 0'),
        ),
      ),
    ).toBe(false);
    expect(chainsFit(run(65, fitting))).toBe(false);
  });
});

describe('the requests of a server in the session of the smoke test', () => {
  const asks = fileURLToPath(
    new URL('../fixtures/smoke-write/asks.mts', import.meta.url),
  );
  const ask = (handler?: ServerRequestHandler, answer = 20_000) =>
    startServer(
      { executable: process.execPath, args: [asks] },
      { NODE_OPTIONS: guardPreload },
      { answer, end: 20_000 },
      handler,
    );
  const question = { message: 'Schreiben?', mode: 'form' };
  const unknownMethod = {
    code: -32601,
    message: 'Method not found',
  };

  it('gives the result of the handler, also for the ID of a request of its own', async () => {
    const seen: unknown[] = [];
    const session = ask((method, params) => {
      seen.push({ method, params });
      return Promise.resolve({
        action: 'accept',
        content: { bestaetigen: true },
      });
    });
    try {
      // The first request of the session has the ID 1, and so has the
      // question of the server, which must settle nothing of the session.
      const answer = await session.request('frage', {
        method: 'elicitation/create',
        id: 1,
        params: question,
      });
      expect(answer).toEqual({
        kind: 'result',
        result: {
          answer: {
            jsonrpc: '2.0',
            id: 1,
            result: { action: 'accept', content: { bestaetigen: true } },
          },
        },
      });
      expect(seen).toEqual([
        { method: 'elicitation/create', params: question },
      ]);
    } finally {
      expect((await session.finish()).code).toBe(0);
    }
  });

  it('answers with the error of an unknown method when the handler gives nothing or throws', async () => {
    const session = ask((method) => {
      if (method === 'wirft') throw new Error('kaputt');
      return undefined;
    });
    try {
      for (const method of ['elicitation/create', 'wirft']) {
        const answer = await session.request('frage', {
          method,
          id: `frage-${method}`,
          params: question,
        });
        expect(answer).toEqual({
          kind: 'result',
          result: {
            answer: {
              jsonrpc: '2.0',
              id: `frage-${method}`,
              error: unknownMethod,
            },
          },
        });
      }
    } finally {
      expect((await session.finish()).code).toBe(0);
    }
  });

  it('leaves a request of the server unanswered without a handler', async () => {
    const session = ask(undefined, 1_000);
    try {
      const answer = await session.request('frage', {
        method: 'elicitation/create',
        id: 'frage',
        params: question,
      });
      expect(answer).toEqual({ kind: 'none' });
    } finally {
      expect((await session.finish()).code).toBe(0);
    }
  });
});
