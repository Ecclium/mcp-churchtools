/**
 * The smoke test for writing against the test instance: its course from
 * the environment to the result.
 *
 * It runs only behind the guard of the test environment (ADR 0049): the
 * switch that equals the first label of the host, the token file of the
 * narrow write account and no token of another account, the
 * identification category, exactly the write area, the probe calendar and
 * the probe resource with exactly their rights, nothing foreign in them,
 * and a person at the terminal who types «ja». Then it starts the built
 * server with `ECCLIUM_READ_ONLY=false`, the toolsets `wiki` and
 * `calendars`, a folder of state, a folder of day keys and a key of the
 * check code of its own, and a policy whose part `interactive` names
 * exactly these three targets with the names the guard just read
 * (ADR 0032). Every write goes through the server (`course.mts`).
 *
 * Afterwards it checks the audit files, their chains against the anchors
 * in the logs, that the token is nowhere, that the rights of the account
 * are still narrow and what stays in calendar and resource. Its result is
 * JSON of fixed words, checked by the guard of the probes before it
 * leaves. Its folders it removes; the page and the changed appointment
 * stay for 07-wiki-cleanup and 11-calendar-write.
 *
 * @packageDocumentation
 */
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

import { spikeVariables, type Environment } from '../spike/lib/env.mts';
import { SpikeError, hints, type HintKey } from '../spike/lib/errors.mts';
import {
  allBookingStatuses,
  createWriteAccess,
  passSmokeGate,
  readCalendarEntries,
  readCategories,
  rightsStillWithin,
  type Input,
} from '../spike/lib/gate.mts';
import { Guard, type Json } from '../spike/lib/guard.mts';
import {
  createClient,
  pathFor,
  type Client,
  type FetchFunction,
  type WriteOperation,
} from '../spike/lib/http.mts';
import { calendarOperations, operations } from '../spike/lib/operations.mts';
import type { Io } from '../spike/lib/output.mts';
import { hostValues } from '../spike/lib/probe.mts';
import { isObject } from '../spike/lib/spec.mts';
import {
  CalendarStateFile,
  WriteStateFile,
} from '../spike/lib/write-state.mts';
import { defaultDeadlines, type Deadlines } from '../smoke/session.mts';
import { checkAudit, differenceWords } from './audit.mts';
import { chainsFit, runCommand, type CommandStart } from './commands.mts';
import {
  findingWords,
  readTools,
  reportOf,
  runWriteCourse,
  stepNames,
  writeTools,
  writtenTexts,
  type CourseOutcome,
} from './course.mts';
import { readSmokeWriteSettings } from './settings.mts';

/** Exit codes after sysexits, as `ecclium` uses them, 1 for a failed check. */
export const smokeWriteExitCodes = {
  ok: 0,
  failed: 1,
  usage: 64,
  unavailable: 69,
  internal: 70,
  refused: 77,
  configuration: 78,
} as const;

/** How the server starts; in tests from source with extra variables. */
export interface WriteServerStart extends CommandStart {
  /** More variables for the server and the commands, only in tests. */
  readonly env?: Readonly<Record<string, string>>;
}

/** What the smoke test for writing needs from outside. */
export interface SmokeWriteDependencies {
  readonly env: Environment;
  readonly args: readonly string[];
  readonly io: Io;
  /** For the reads of the guard. */
  readonly fetch: FetchFunction;
  /** Where the «ja» comes from. */
  readonly input: Input;
  readonly platform: string;
  /** The temporary folder for the folders of the run. */
  readonly tmpdir: string;
  readonly server: WriteServerStart;
  readonly deadlines?: Deadlines;
  /** Waits between two writes; tests wait not at all. */
  readonly wait?: (milliseconds: number) => Promise<void>;
  /** The clock, for the day the run writes on. */
  readonly now?: () => Date;
  /**
   * Learns of each folder of the run while it exists, so that the entry
   * can remove it after an interrupt, when no `finally` runs.
   */
  readonly track?: (folder: string, exists: boolean) => void;
}

// A refusal of the guard: the instance counts as productive, the account
// is not the narrow one, something foreign lies in the targets, or nobody
// confirmed.
const refusals: ReadonlySet<HintKey> = new Set<HintKey>([
  'schalterFehlt',
  'schalterFalsch',
  'platzhalterHost',
  'zweiTokenVariablen',
  'waechterOperationFehlt',
  'waechterAntwortUnerwartet',
  'kennkategorieFehlt',
  'kennkategorieMehrfach',
  'kennkategorieBearbeitbar',
  'schreibKategorieNichtSichtbar',
  'schreibKategorieIstKennung',
  'schreibKategorieNichtBearbeitbar',
  'weitereKategorien',
  'zuWeitBerechtigt',
  'fremdeSeiten',
  'schreibKalenderNichtSichtbar',
  'schreibRessourceNichtSichtbar',
  'ressourceBrauchtTermin',
  'fremdeTermine',
  'keinTerminal',
  'nichtBestaetigt',
  'schreibSmokeNamen',
]);

const exitCodeFor = (error: SpikeError): number => {
  if (error.hint === 'schreibSmokeAufruf') return smokeWriteExitCodes.usage;
  if (error.hint !== undefined && refusals.has(error.hint)) {
    return smokeWriteExitCodes.refused;
  }
  switch (error.code) {
    case 'KONFIGURATION':
    case 'DATEI':
      return smokeWriteExitCodes.configuration;
    case 'INTERN':
      return smokeWriteExitCodes.internal;
    default:
      return smokeWriteExitCodes.unavailable;
  }
};

/**
 * Reports an error with its fixed code and hint only, never its message.
 *
 * @param error - Whatever was thrown.
 * @param io - Where to write.
 * @param wrote - Whether the server may have written already.
 * @returns The exit code.
 */
export function writeSmokeWriteError(
  error: unknown,
  io: Io,
  wrote: boolean,
): number {
  const after = wrote ? `\n${hints.schreibSmokeAbgebrochen}` : '';
  if (!(error instanceof SpikeError)) {
    io.stderr(`Code: INTERN\n${hints.smokeIntern}${after}\n`);
    return smokeWriteExitCodes.internal;
  }
  // 77 says that nothing was written; after a write that no longer holds.
  const refused = exitCodeFor(error);
  const code =
    wrote && refused === smokeWriteExitCodes.refused
      ? smokeWriteExitCodes.internal
      : refused;
  const hint =
    error.hint ??
    (code === smokeWriteExitCodes.unavailable ? 'netz' : 'smokeIntern');
  io.stderr(`Code: ${error.code}\n${hints[hint]}${after}\n`);
  return code;
}

/** The fixed words of the result, for the allow list. */
export const resultWords = [
  'smoketest',
  'ecclium-schreiben',
  'churchtools',
  'unbekannt',
  'kennkategorie',
  'gefunden',
  'schritte',
  'schritt',
  'ergebnis',
  'wie erwartet',
  'abweichend',
  'audit',
  'aufrufe',
  'betreiber',
  'sauber',
  'kette',
  'token',
  'nirgends',
  'rechte',
  'eng',
  'zu weit',
  'reste',
  'seite',
  'termin',
  'buchung',
  'ja',
  'nein',
  'aufraeumen',
  '07-wiki-cleanup',
  '11-calendar-write',
  'befunde',
  'diagnose',
  'zuruecknahmen',
  'fehler',
  'bestanden',
  'gescheitert',
  ...stepNames,
  ...findingWords,
  ...differenceWords,
  ...readTools,
  ...writeTools,
] as const;

// The numbers the diagnosis may show: exit codes and the numbers of the
// calls, never a value of ChurchTools.
const resultNumbers = Array.from({ length: 256 }, (_, number) => number);

// The operations the server sends, each of which the instance must
// document (ADR 0049). Updates of a page are PATCH, as in the probes.
const serverWrites: readonly WriteOperation[] = [
  'wikiPageCreate',
  'wikiPageUpdate',
  'appointmentCreate',
  'appointmentUpdate',
  'appointmentDelete',
  'bookingCreate',
  'bookingDelete',
];

const summary =
  'Der Smoke-Test für das Schreiben startet den gebauten Server von Ecclium mit Schreibrechten. Der Server legt im Schreibbereich eine Seite an, ändert sie und nimmt das zurück, legt im Kalender der Proben Termine an und fragt bei der Ressource der Proben eine Buchung an. Die Buchungsanfrage schickt den Verwaltern der Ressource eine Mail. Danach bleiben eine Seite für 07-wiki-cleanup und ein Termin für 11-calendar-write.';

const blockLocal = (guard: Guard, env: Environment, origin: string): void => {
  for (const value of hostValues(origin)) guard.block(value);
  for (const name of spikeVariables) {
    const value = env[name];
    if (value !== undefined && value !== '') guard.block(value);
  }
  try {
    guard.block(userInfo().username);
  } catch {
    // Without a user name there is nothing to block.
  }
  guard.block(homedir());
};

// The name of the one entry with this ID in a list of the instance.
const nameIn = (body: unknown, id: number): string | undefined => {
  const data = isObject(body) ? body['data'] : undefined;
  if (!Array.isArray(data)) return undefined;
  const entry: unknown = data.find(
    (item: unknown) => isObject(item) && item['id'] === id,
  );
  const name = isObject(entry) ? entry['name'] : undefined;
  return typeof name === 'string' && name !== '' ? name : undefined;
};

/** The IDs of the three targets: write area, calendar and resource. */
export interface TargetIds {
  readonly category: number;
  readonly calendar: number;
  readonly resource: number;
}

/** The names of the three targets, for the policy. */
interface TargetNames {
  readonly category: string;
  readonly calendar: string;
  readonly resource: string;
}

async function readTargetNames(
  client: Client,
  area: TargetIds,
): Promise<TargetNames> {
  const { categories } = readCategories(
    await client.get({ path: operations.wikiCategories.template }),
    'schreibSmokeNamen',
  );
  const category = categories.find((entry) => entry.id === area.category)?.name;
  const calendar = nameIn(
    (await client.get({ path: operations.calendars.template })).body,
    area.calendar,
  );
  const resource = nameIn(
    (await client.get({ path: operations.resources.template })).body,
    area.resource,
  );
  if (
    category === undefined ||
    calendar === undefined ||
    resource === undefined
  ) {
    throw new SpikeError('KONFIGURATION', 'schreibSmokeNamen');
  }
  return { category, calendar, resource };
}

/**
 * The policy of the run: writes go only to these three targets, with the
 * names the guard read, each tool a few times a day (ADR 0032). JSON is
 * valid YAML, so the smoke test needs no library to write it.
 *
 * @param area - IDs of the targets.
 * @param names - Their names in ChurchTools.
 * @returns The text of the file.
 */
export function policyOf(area: TargetIds, names: TargetNames): string {
  return `${JSON.stringify(
    {
      schema: 'policy.v1',
      interactive: {
        targets: [
          {
            target: {
              kind: 'wiki_category',
              id: area.category,
              name: names.category,
            },
            tools: [
              'ct_wiki_page_create',
              'ct_wiki_page_update',
              'ct_wiki_page_append_section',
            ],
            maxPerDay: 50,
          },
          {
            target: {
              kind: 'calendar',
              id: area.calendar,
              name: names.calendar,
            },
            tools: ['ct_appointments_create', 'ct_appointments_update'],
            maxPerDay: 50,
          },
          {
            target: {
              kind: 'resource',
              id: area.resource,
              name: names.resource,
            },
            tools: ['ct_bookings_create'],
            maxPerDay: 10,
          },
        ],
        // A server that writes to the wiki ends the marking of each page
        // and section with whom to ask, and does not start without it
        // (ADR 0032).
        inquiriesTo: 'Betrieb des Smoke-Tests',
      },
    },
    null,
    2,
  )}\n`;
}

/**
 * The day the run writes on: fourteen days after today in UTC, so that no
 * real plan is near and the seed of the test instance, which looks 120
 * days ahead in its own calendar, is not touched.
 *
 * @param now - The time of the run.
 * @returns The day, `YYYY-MM-DD`.
 */
export function runDay(now: Date): string {
  return new Date(now.getTime() + 14 * 86_400_000).toISOString().slice(0, 10);
}

const makeFolder = (base: string, name: string): string => {
  try {
    // The resolved path: under macOS the temporary folder lies behind a
    // link, and the server takes only a folder it can check (ADR 0028).
    return mkdtempSync(join(realpathSync(base), name));
  } catch {
    throw new SpikeError('DATEI', 'smokeZustandsordner');
  }
};

// The bookings of the probe resource on the day of the run, in every
// status, with ID, title and status.
async function bookingsOn(
  reader: Client,
  resource: number,
  day: string,
): Promise<
  readonly {
    readonly id: number;
    readonly title: string;
    readonly statusId: unknown;
  }[]
> {
  const response = await reader.get({
    path: operations.bookings.template,
    query: [
      ['resource_ids[]', String(resource)],
      ...allBookingStatuses,
      ['from', day],
      ['to', day],
    ],
  });
  const entries = readCalendarEntries(response, 'booking');
  const data = isObject(response.body) ? response.body['data'] : undefined;
  return entries.map((entry, index) => {
    const item: unknown = Array.isArray(data) ? data[index] : undefined;
    const booking = isObject(item) ? item['booking'] : undefined;
    const base = isObject(booking) ? booking['base'] : undefined;
    return {
      id: entry.id,
      title: entry.title,
      statusId: isObject(base) ? base['statusId'] : undefined,
    };
  });
}

// What stays in calendar and resource after the course, read with all
// statuses of a booking, past what the tools of the server list.
async function remaining(
  reader: Client,
  area: { readonly calendar: number; readonly resource: number },
  day: string,
): Promise<{ readonly appointments: number; readonly bookings: number }> {
  const window: readonly (readonly [string, string])[] = [
    ['from', day],
    ['to', day],
  ];
  const appointments = readCalendarEntries(
    await reader.get({
      path: pathFor(
        calendarOperations.calendarAppointmentList.template,
        area.calendar,
      ),
      query: window,
    }),
    'appointment',
  );
  const bookings = readCalendarEntries(
    await reader.get({
      path: operations.bookings.template,
      query: [
        ['resource_ids[]', String(area.resource)],
        ...allBookingStatuses,
        ...window,
      ],
    }),
    'booking',
  );
  return { appointments: appointments.length, bookings: bookings.length };
}

/**
 * Runs the smoke test for writing.
 *
 * @param deps - Environment, input, output, the start of the server and what tests replace.
 * @returns The exit code, see {@link smokeWriteExitCodes}.
 */
export async function runSmokeWrite(
  deps: SmokeWriteDependencies,
): Promise<number> {
  const folders: string[] = [];
  const files: { close: () => void }[] = [];
  let wrote = false;
  try {
    if (deps.args.length > 0) {
      throw new SpikeError('KONFIGURATION', 'schreibSmokeAufruf');
    }
    if (deps.platform === 'win32') {
      throw new SpikeError('KONFIGURATION', 'smokeWindows');
    }
    const settings = readSmokeWriteSettings(deps.env);
    if (!existsSync(deps.server.entry)) {
      throw new SpikeError('KONFIGURATION', 'smokeBuildFehlt');
    }
    const { origin, token, state } = settings;
    const area: TargetIds = {
      category: settings.write.writeCategory,
      calendar: settings.write.calendarArea.calendar,
      resource: settings.write.calendarArea.resource,
    };
    const guard = new Guard();
    blockLocal(guard, deps.env, origin);
    guard.block(token);
    guard.blockAll({ instance: state.instance });
    if (state.version !== null) guard.allowVersion(state.version);
    guard.allowFixed(...resultWords, ...resultNumbers);

    const options = { origin, token, guard, fetch: deps.fetch };
    const client = createClient(options);
    const day = runDay(deps.now?.() ?? new Date());
    const { result, reader } = await passSmokeGate(
      { client, state },
      createWriteAccess(options, deps.input),
      settings.write,
      {
        writes: serverWrites,
        ownPages: new Set(),
        calendar: {
          ownAppointments: new Set(),
          ownBookings: new Set(),
          from: day,
          to: day,
        },
        summary,
      },
    );
    const names = await readTargetNames(client, area);
    guard.blockAll(names);

    const stateDir = makeFolder(deps.tmpdir, 'ecclium-smoke-write-');
    folders.push(stateDir);
    deps.track?.(stateDir, true);
    // The folder of the kill switches, empty: without it the server keeps
    // writing off (ADR 0029).
    mkdirSync(join(stateDir, 'stop'), { mode: 0o700 });
    const keysDir = makeFolder(deps.tmpdir, 'ecclium-smoke-keys-');
    folders.push(keysDir);
    deps.track?.(keysDir, true);
    const filesDir = makeFolder(deps.tmpdir, 'ecclium-smoke-files-');
    folders.push(filesDir);
    deps.track?.(filesDir, true);
    for (const folder of [stateDir, keysDir, filesDir]) guard.block(folder);
    const markerKey = randomBytes(32).toString('hex');
    guard.block(markerKey);
    const markerKeyFile = join(filesDir, 'pruefcode-schluessel');
    writeFileSync(markerKeyFile, `${markerKey}\n`, { mode: 0o600, flag: 'wx' });
    // The server and every command read a copy of the token the guard
    // checked, so that a file replaced during the run cannot give them the
    // token of another account.
    const tokenCopy = join(filesDir, 'token');
    writeFileSync(tokenCopy, `${token}\n`, { mode: 0o600, flag: 'wx' });
    const policyFile = join(filesDir, 'richtlinie.json');
    writeFileSync(policyFile, policyOf(area, names), {
      mode: 0o600,
      flag: 'wx',
    });

    // Only now, after the «ja», the state files: what the server creates
    // goes into them the moment the smoke test knows its ID.
    const pages = WriteStateFile.create(
      settings.write.writeStatePath,
      origin,
      area.category,
    );
    files.push(pages);
    const entries = CalendarStateFile.create(
      settings.calendarStatePath,
      origin,
      settings.write.calendarArea,
      day,
    );
    files.push(entries);
    const pageTitle = `spike-schreibprobe-${pages.run}-smoke`;
    const entryPrefix = `spike-schreibprobe-${entries.run}-`;
    guard.block(pages.run);
    guard.block(entries.run);

    const env: Record<string, string> = {
      ECCLIUM_CHURCHTOOLS_URL: origin,
      ECCLIUM_CHURCHTOOLS_TOKEN_FILE: tokenCopy,
      ECCLIUM_READ_ONLY: 'false',
      // Named one by one, so that a later toolset does not join unseen.
      ECCLIUM_TOOLSETS: 'wiki,calendars',
      ECCLIUM_STATE_DIR: stateDir,
      ECCLIUM_KEYS_DIR: keysDir,
      ECCLIUM_MARKER_KEY_FILE: markerKeyFile,
      ECCLIUM_POLICY_FILE: policyFile,
      ECCLIUM_TIME_ZONE: 'Europe/Zurich',
      ...deps.server.env,
    };
    wrote = true;
    const outcome: CourseOutcome = await runWriteCourse({
      start: deps.server,
      env,
      area,
      day,
      pageTitle,
      entryPrefix,
      pages,
      entries,
      deadlines: deps.deadlines ?? { ...defaultDeadlines, answer: 120_000 },
      wait:
        deps.wait ??
        ((milliseconds) =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, milliseconds);
          })),
      see: (value) => {
        guard.blockAll(value);
      },
      bookings: () =>
        bookingsOn(reader, area.resource, day).catch(() => undefined),
    });

    const banned = [token, ...writtenTexts(pageTitle, entryPrefix)];
    const expected = outcome.sessions.flatMap((record) => record.expected);
    const audit = checkAudit(
      stateDir,
      expected,
      outcome.undoes,
      outcome.approvals,
      banned,
      [...readTools, ...writeTools],
    );
    const logs = [
      ...outcome.sessions.map((record) => record.stderr),
      ...outcome.commands.map((run) => run.stderr),
    ].join('\n');
    const chains = chainsFit(
      runCommand(
        deps.server,
        ['audit', 'verify', '--log', '-'],
        { ...deps.server.env, ECCLIUM_STATE_DIR: stateDir },
        logs,
      ),
    );
    const outputs = [
      ...outcome.sessions.flatMap((record) => [record.stdout, record.stderr]),
      ...outcome.commands.flatMap((run) => [run.stdout, run.stderr]),
    ];
    const tokenNowhere = !outputs.some((text) => text.includes(token));
    // After the writes a refusal of the guard no longer means that nothing
    // was written: an answer of another form only leaves these unknown.
    const rights = await rightsStillWithin(
      client,
      settings.write,
      result.identification,
    ).catch(() => undefined);
    const left = await remaining(reader, area, day).catch(() => undefined);
    const leftAsExpected =
      left !== undefined &&
      left.bookings === 0 &&
      left.appointments === (outcome.left.appointment ? 1 : 0);

    const failures = [
      ...outcome.steps.filter((entry) => !entry.ok).map((entry) => entry.name),
      ...(audit.calls && audit.operator && audit.clean ? [] : ['audit']),
      ...(chains ? [] : ['kette']),
      ...(tokenNowhere ? [] : ['token']),
      ...(rights === true ? [] : ['rechte']),
      ...(leftAsExpected ? [] : ['reste']),
    ];
    const yesNo = (value: boolean): string => (value ? 'ja' : 'nein');
    const output: Json = {
      smoketest: 'ecclium-schreiben',
      churchtools: state.version ?? 'unbekannt',
      kennkategorie: 'gefunden',
      schritte: reportOf(outcome),
      audit: {
        aufrufe: audit.calls ? 'wie erwartet' : 'abweichend',
        betreiber: audit.operator ? 'wie erwartet' : 'abweichend',
        sauber: yesNo(audit.clean),
      },
      kette: chains ? 'wie erwartet' : 'abweichend',
      token: tokenNowhere ? 'nirgends' : 'gefunden',
      rechte:
        rights === true ? 'eng' : rights === false ? 'zu weit' : 'unbekannt',
      reste: {
        seite: yesNo(outcome.left.page),
        termin: left === undefined ? 'unbekannt' : yesNo(left.appointments > 0),
        buchung: left === undefined ? 'unbekannt' : yesNo(left.bookings > 0),
      },
      aufraeumen: [
        ...(outcome.left.page ? ['07-wiki-cleanup'] : []),
        ...(left === undefined || left.appointments > 0 || left.bookings > 0
          ? ['11-calendar-write']
          : []),
      ],
      befunde: [...outcome.findings],
      // What a failed run needs to be understood, as fixed words: the calls
      // whose audit line differs and the exit code of every undo.
      diagnose: {
        audit: audit.differences.map((difference): Json => ({
          zeile: difference.zeile,
          erwartet:
            typeof difference.erwartet === 'string'
              ? difference.erwartet
              : { ...difference.erwartet },
          ist:
            typeof difference.ist === 'string'
              ? difference.ist
              : { ...difference.ist },
        })),
        zuruecknahmen: outcome.undoes.map((run) => run.status ?? 'keiner'),
      },
      fehler: failures,
      ergebnis: failures.length === 0 ? 'bestanden' : 'gescheitert',
    };
    const withheld = guard.check(output);
    if (withheld.length > 0) {
      deps.io.stdout(
        `${JSON.stringify({ zurueckgehalten: true, stellen: withheld }, null, 2)}\n`,
      );
      deps.io.stderr(`${hints.smokeZurueckgehalten}\n`);
      return smokeWriteExitCodes.internal;
    }
    deps.io.stdout(`${JSON.stringify(output, null, 2)}\n`);
    return failures.length === 0
      ? smokeWriteExitCodes.ok
      : smokeWriteExitCodes.failed;
  } catch (error) {
    return writeSmokeWriteError(error, deps.io, wrote);
  } finally {
    for (const file of files) {
      try {
        file.close();
      } catch {
        // Closed already, or never open.
      }
    }
    for (const folder of folders) {
      try {
        rmSync(folder, { recursive: true, force: true });
        deps.track?.(folder, false);
      } catch {
        // A folder that cannot go stays, private to this user (0700); the
        // next one still goes.
      }
    }
  }
}
