/**
 * Probe 11: appointments and bookings written through the API, and what
 * the instance makes of them.
 *
 * Runs only with the write account, with the probe calendar and the probe
 * resource from the environment, and writes only after the guard of the
 * test environment has passed and a person has typed «ja» (ADR 0049).
 * Writes, all on one day thirty days ahead and never at midnight, so no
 * appointment counts as an all-day one:
 * - in the probe calendar one appointment without event and without
 *   series: `POST /api/calendars/{id}/appointments`, then `PUT` with a new
 *   title and every field, the same body again, a body without the
 *   optional fields, a stale `version` in the body, a stale `If-Match`, an
 *   `If-Unmodified-Since` in the past, and last `DELETE`;
 * - for the probe resource `POST /api/bookings/conflicts` before and after
 *   the first booking, and two bookings: the first asked as pending
 *   (`statusId` 1), the second asked as approved (`statusId` 2). For the
 *   first then `PUT` with a new time, the same body again, a body without
 *   the optional field, `statusId` 2 and a stale `version`, and last
 *   `DELETE` of both.
 * No request carries a CSRF token or a cookie.
 * Reads: what the guard reads, `GET /api/whoami`, and after each write the
 * appointment or the booking.
 * Records: every appointment and booking the instance creates, and every
 * deletion it confirms, in the write state file, at once. After an error
 * that follows a write it sends nothing more but the deletions of what the
 * run created. Started with the write state file of an earlier run, it
 * only deletes what that run left behind.
 * Answers, for the tools that write appointments and bookings: what `PUT`
 * does to fields it does not get, whether the API honours a stale
 * version, which field shows a change, who counts as author, what
 * `statusId` means for an account that may only request bookings, what the
 * conflict check returns, and whether a deleted object is gone. It prints
 * status codes, ja or nein, fixed words and count classes. For the first
 * create of each kind and for every refused write it also prints the
 * structure of the answer, as the other write probes do.
 *
 * Between two writes it waits a little longer than a second: the instance
 * gives the time of the last change in whole seconds, so two writes in the
 * same second would look like none.
 *
 * Usage: see README.md in this folder.
 *
 * @packageDocumentation
 */
import { SpikeError } from './lib/errors.mts';
import {
  allBookingStatuses,
  pageTitlePrefix,
  passGate,
  readCalendarEntries,
  rightsStillWithin,
} from './lib/gate.mts';
import type { Guard, Json } from './lib/guard.mts';
import {
  pastDate,
  pathFor,
  staleEntityTag,
  writeTemplate,
  type CalendarArea,
  type Client,
  type Precondition,
  type ProbeResponse,
  type WriteClient,
  type WriteOperation,
} from './lib/http.mts';
import { calendarOperations, operations } from './lib/operations.mts';
import { dataOf } from './lib/pages.mts';
import { main, type ProbeDefinition } from './lib/probe.mts';
import { describeResponse } from './lib/report.mts';
import {
  Schemas,
  findOperation,
  isObject,
  type OpenApiDocument,
} from './lib/spec.mts';
import { countClass, countClasses } from './lib/structure.mts';
import {
  CalendarStateFile,
  checkNewWriteState,
  readCalendarState,
  type CalendarObject,
} from './lib/write-state.mts';

const words = [
  'probe',
  '11-calendar-write',
  'status',
  'faelle',
  'modus',
  'proben',
  'aufraeumen',
  'termin',
  'buchungen',
  'konflikteVorher',
  'konflikteNachher',
  'ersteBuchung',
  'zweiteBuchung',
  'anlegen',
  'antwort',
  'angelegt',
  'leseStatus',
  'versionBeimAnlegen',
  'angelegtVomSchreibkonto',
  'statusGesendet',
  'statusGelesen',
  'titelGleich',
  'vollstaendig',
  'gleicherKoerper',
  'ohneOptionaleFelder',
  'veralteteVersion',
  'ifMatch',
  'ifUnmodifiedSince',
  'statusGenehmigt',
  'versionGestiegen',
  'versionDifferenz',
  'aenderungsdatumGeaendert',
  'uebernommen',
  'geaendertVomSchreibkonto',
  'untertitelGeleert',
  'beschreibungGeleert',
  'loeschen',
  'danachLesen',
  'anzahl',
  'nenntEigeneBuchung',
  'rechteUnveraendert',
  'geloescht',
  'uebrig',
  'termine',
  'nicht ausgeführt',
  'angefragt',
  'genehmigt',
  'abgelehnt',
  'andere',
  'ja',
  'nein',
  'fehlt',
  'unbekannt',
  'keine',
  'eins',
  'zwei',
  'mehr',
];

const summary =
  '11-calendar-write legt im Kalender der Proben einen Termin an, ändert ihn mehrmals und löscht ihn, und bei der Ressource der Proben zwei Buchungsanfragen, von denen es die erste mehrmals ändert, und löscht beide.';

const cleanupSummary =
  '11-calendar-write löscht die Termine und Buchungen, die ein früherer Lauf angelegt und nicht gelöscht hat.';

/** A little more than a second, see the module comment. */
const pauseBeforeWrite = 1100;

/** How many days ahead the probe writes. */
const daysAhead = 30;

/** The day of the probe and the times of its objects, all in UTC. */
export interface ProbeTimes {
  /** The day, `YYYY-MM-DD`. */
  readonly day: string;
  /**
   * A point in time on that day, as the API takes it.
   *
   * @param time - Hours and minutes, such as `03:30`.
   * @returns Text such as `2026-12-01T03:30:00Z`.
   */
  readonly at: (time: string) => string;
}

/**
 * Finds the day of the probe, thirty days after today in UTC. The times of
 * the probe lie between 03:00 and 09:00 UTC, so in the time zones of the
 * German-speaking countries no object starts at midnight, which the API
 * would read as an all-day one, and none crosses into another day.
 *
 * @param now - The current time.
 * @returns The day and a way to name a time on it.
 * @example
 * ```ts
 * probeTimes(new Date('2026-11-01T12:00:00Z')).at('03:00');
 * // '2026-12-01T03:00:00Z'
 * ```
 */
export function probeTimes(now: Date): ProbeTimes {
  const day = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + daysAhead,
    ),
  )
    .toISOString()
    .slice(0, 10);
  return { day, at: (time) => `${day}T${time}:00Z` };
}

/** What the probe reads back of an appointment or a booking. */
export interface ObjectView {
  readonly status: number;
  readonly version?: number;
  readonly modifiedDate?: string;
  readonly createdBy?: number;
  readonly modifiedBy?: number;
  readonly title?: string;
  readonly subtitle?: string | null;
  readonly description?: string | null;
  readonly startDate?: string;
  readonly statusId?: number;
}

const isPositive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const textOrNull = (value: unknown): string | null | undefined =>
  typeof value === 'string' || value === null ? value : undefined;

function personOf(value: unknown): number | undefined {
  return isObject(value) && isPositive(value['id']) ? value['id'] : undefined;
}

/**
 * Takes what the probe compares from the answer to a read of an
 * appointment or a booking. The stored object lies under `appointment` or
 * `booking` in `data`; fields of another type count as missing.
 *
 * @param response - Answer of `GET` on the appointment or booking.
 * @param kind - Which of the two it is.
 * @returns The fields the probe compares.
 */
export function readView(
  response: ProbeResponse,
  kind: 'appointment' | 'booking',
): ObjectView {
  const data = dataOf(response);
  const base = isObject(data) ? data[kind] : undefined;
  if (response.status !== 200 || !isObject(base)) {
    return { status: response.status };
  }
  const meta = isObject(base['meta']) ? base['meta'] : {};
  const fields: Record<string, unknown> = {
    status: response.status,
    version: Number.isSafeInteger(base['version'])
      ? base['version']
      : undefined,
    modifiedDate:
      typeof meta['modifiedDate'] === 'string'
        ? meta['modifiedDate']
        : undefined,
    createdBy: personOf(meta['createdPerson']),
    modifiedBy: personOf(meta['modifiedPerson']),
    title: typeof base['title'] === 'string' ? base['title'] : undefined,
    subtitle: textOrNull(base['subtitle']),
    description: textOrNull(base['description']),
    startDate:
      typeof base['startDate'] === 'string' ? base['startDate'] : undefined,
    statusId: isPositive(base['statusId']) ? base['statusId'] : undefined,
  };
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as unknown as ObjectView;
}

/**
 * Names a status of a booking with a fixed word: 1 «angefragt», 2
 * «genehmigt», 3 «abgelehnt», as the OpenAPI document describes them.
 *
 * @param statusId - The status read back.
 * @returns The fixed word.
 */
export function statusWord(statusId: number | undefined): string {
  return statusId === undefined
    ? 'fehlt'
    : statusId === 1
      ? 'angefragt'
      : statusId === 2
        ? 'genehmigt'
        : statusId === 3
          ? 'abgelehnt'
          : 'andere';
}

/**
 * Tells whether an answer names an ID anywhere as the value of a key `id`.
 * The conflict check answers with occurrences of other bookings; the probe
 * only wants to know whether its own is among them.
 *
 * @param value - A parsed answer.
 * @param id - The ID to look for.
 * @param depth - How deep the search may go.
 * @returns Whether the ID appears.
 */
export function namesId(value: unknown, id: number, depth = 8): boolean {
  if (depth < 0) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => namesId(entry, id, depth - 1));
  }
  if (!isObject(value)) {
    return false;
  }
  return Object.entries(value).some(
    ([key, entry]) =>
      (key === 'id' && entry === id) || namesId(entry, id, depth - 1),
  );
}

/** An appointment or booking of the run. */
interface Target {
  readonly kind: CalendarObject;
  readonly id: number;
}

/** Everything the steps of the probe share. */
interface Run {
  readonly client: Client;
  readonly reader: Client;
  readonly writer: WriteClient;
  readonly guard: Guard;
  readonly schemas: Schemas;
  readonly document: OpenApiDocument;
  readonly area: CalendarArea;
  readonly file: CalendarStateFile;
  readonly wait: (milliseconds: number) => Promise<void>;
  /** ID of the write account, if `whoami` named it. */
  readonly self: number | undefined;
  readonly times: ProbeTimes;
  /** Start of every title of the run. */
  readonly titles: string;
  /** What the run created and has not deleted yet. */
  readonly open: Record<CalendarObject, Set<number>>;
}

const yesNo = (value: boolean): string => (value ? 'ja' : 'nein');
const succeeded = (response: ProbeResponse): boolean =>
  response.status >= 200 && response.status < 300;

function compare<T>(
  before: T | undefined,
  after: T | undefined,
  test: (before: T, after: T) => boolean,
): string {
  return before === undefined || after === undefined
    ? 'unbekannt'
    : yesNo(test(before, after));
}

function difference(before: ObjectView, after: ObjectView): string {
  if (before.version === undefined || after.version === undefined) {
    return 'unbekannt';
  }
  const steps = after.version - before.version;
  return steps <= 0
    ? 'keine'
    : steps === 1
      ? 'eins'
      : steps === 2
        ? 'zwei'
        : 'mehr';
}

function bySelf(run: Run, person: number | undefined): string {
  return run.self === undefined || person === undefined
    ? 'unbekannt'
    : yesNo(person === run.self);
}

const updateOperation = (kind: CalendarObject): WriteOperation =>
  kind === 'termin' ? 'appointmentUpdate' : 'bookingUpdate';

const deleteOperation = (kind: CalendarObject): WriteOperation =>
  kind === 'termin' ? 'appointmentDelete' : 'bookingDelete';

function parametersOf(run: Run, target: Target): readonly number[] {
  return target.kind === 'termin'
    ? [run.area.calendar, target.id]
    : [target.id];
}

function describe(
  run: Run,
  response: ProbeResponse,
  operation: WriteOperation,
): Json {
  const { method, template } = writeTemplate(operation);
  return describeResponse(response, {
    guard: run.guard,
    schemas: run.schemas,
    operation: findOperation(run.document, method, template),
  });
}

async function read(run: Run, target: Target): Promise<ObjectView> {
  const response = await run.reader.get({
    path:
      target.kind === 'termin'
        ? pathFor(
            calendarOperations.calendarAppointment.template,
            run.area.calendar,
            target.id,
          )
        : pathFor(calendarOperations.booking.template, target.id),
  });
  run.guard.allowFixed(response.status);
  return readView(
    response,
    target.kind === 'termin' ? 'appointment' : 'booking',
  );
}

/** The answer to a create and the ID it names. */
interface Created {
  readonly response: ProbeResponse;
  readonly target: Target | undefined;
}

async function create(
  run: Run,
  kind: CalendarObject,
  body: Readonly<Record<string, Json>>,
): Promise<Created> {
  await run.wait(pauseBeforeWrite);
  const response = await run.writer.send(
    kind === 'termin'
      ? {
          operation: 'appointmentCreate',
          parameters: [run.area.calendar],
          body,
        }
      : { operation: 'bookingCreate', parameters: [], body },
  );
  run.guard.allowFixed(response.status);
  const data = dataOf(response);
  // The answer to a create is documented with the stored object at the top
  // of `data`, unlike a read, which wraps it.
  const id = isObject(data) ? data['id'] : undefined;
  if (isPositive(id)) {
    run.file.created(kind, id);
    run.open[kind].add(id);
    return { response, target: { kind, id } };
  }
  if (succeeded(response)) {
    // The instance says it created something but names no ID. The run
    // stops; a second run finds it by its title and deletes it.
    throw new SpikeError('ANTWORT_UNGUELTIG');
  }
  return { response, target: undefined };
}

function createReport(
  run: Run,
  created: Created,
  view: ObjectView | undefined,
  operation: WriteOperation,
  describeAnswer: boolean,
  title: string,
): Record<string, Json> {
  const anlegen: Record<string, Json> = { status: created.response.status };
  if (describeAnswer || !succeeded(created.response)) {
    anlegen['antwort'] = describe(run, created.response, operation);
  }
  const report: Record<string, Json> = {
    anlegen,
    angelegt: yesNo(created.target !== undefined),
  };
  if (view === undefined) {
    return report;
  }
  if (view.status !== 200) {
    return { ...report, leseStatus: view.status };
  }
  return {
    ...report,
    versionBeimAnlegen:
      view.version === undefined ? 'fehlt' : countClass(view.version),
    angelegtVomSchreibkonto: bySelf(run, view.createdBy),
    titelGleich:
      view.title === undefined ? 'fehlt' : yesNo(view.title === title),
  };
}

/** What a change sends, and what it expects to read back. */
interface Change {
  readonly body: Readonly<Record<string, Json>>;
  readonly precondition?: Precondition;
  /** Tells whether the change was taken, from the state read back. */
  readonly taken?: (after: ObjectView) => boolean;
}

async function update(
  run: Run,
  target: Target,
  before: ObjectView,
  change: Change,
): Promise<{
  readonly report: Record<string, Json>;
  readonly after: ObjectView;
}> {
  await run.wait(pauseBeforeWrite);
  const operation = updateOperation(target.kind);
  const response = await run.writer.send({
    operation,
    parameters: parametersOf(run, target),
    body: change.body,
    ...(change.precondition === undefined
      ? {}
      : { precondition: change.precondition }),
  });
  run.guard.allowFixed(response.status);
  const after = await read(run, target);
  const report: Record<string, Json> = {
    status: response.status,
    versionGestiegen: compare(before.version, after.version, (a, b) => b > a),
    versionDifferenz: difference(before, after),
    aenderungsdatumGeaendert: compare(
      before.modifiedDate,
      after.modifiedDate,
      (a, b) => a !== b,
    ),
    geaendertVomSchreibkonto: bySelf(run, after.modifiedBy),
  };
  if (change.taken !== undefined) {
    report['uebernommen'] =
      after.status === 200 ? yesNo(change.taken(after)) : 'unbekannt';
  }
  if (!succeeded(response)) {
    report['antwort'] = describe(run, response, operation);
  }
  if (after.status !== 200) {
    report['leseStatus'] = after.status;
  }
  return { report, after };
}

async function remove(run: Run, target: Target): Promise<Json> {
  await run.wait(pauseBeforeWrite);
  const operation = deleteOperation(target.kind);
  const response = await run.writer.send({
    operation,
    parameters: parametersOf(run, target),
  });
  run.guard.allowFixed(response.status);
  const after = await read(run, target);
  if (succeeded(response) || after.status === 404) {
    run.file.deleted(target.kind, target.id);
    run.open[target.kind].delete(target.id);
  }
  const report: Record<string, Json> = {
    status: response.status,
    danachLesen: after.status,
  };
  if (!succeeded(response)) {
    report['antwort'] = describe(run, response, operation);
  }
  return report;
}

const cleared = (value: string | null | undefined): string =>
  value === undefined ? 'unbekannt' : yesNo(value === null || value === '');

async function appointmentCases(run: Run): Promise<Json> {
  const title = `${run.titles}termin`;
  const start = run.times.at('03:00');
  const end = run.times.at('04:00');
  const full = (suffix: string): Readonly<Record<string, Json>> => ({
    title: `${title}-${suffix}`,
    subtitle: 'Schreibprobe',
    description: 'Synthetischer Termin der Schreibprobe',
    startDate: start,
    endDate: end,
    isInternal: false,
    repeatId: 0,
  });
  const created = await create(run, 'termin', full('a'));
  const target = created.target;
  const first = target === undefined ? undefined : await read(run, target);
  const anlegen = createReport(
    run,
    created,
    first,
    'appointmentCreate',
    true,
    `${title}-a`,
  );
  if (target === undefined || first === undefined || first.status !== 200) {
    return { ...anlegen, faelle: 'nicht ausgeführt' };
  }
  let before = first;
  const step = async (change: Change): Promise<Record<string, Json>> => {
    const { report, after } = await update(run, target, before, change);
    // After a failed read-back the next case has nothing to compare with,
    // so it says «unbekannt» rather than comparing with an older state.
    before = after;
    return report;
  };
  const titled =
    (suffix: string) =>
    (after: ObjectView): boolean =>
      after.title === `${title}-${suffix}`;

  const vollstaendig = await step({ body: full('b'), taken: titled('b') });
  const gleicherKoerper = await step({ body: full('b'), taken: titled('b') });
  const lean = await step({
    body: {
      title: `${title}-c`,
      startDate: start,
      endDate: end,
      isInternal: false,
    },
    taken: titled('c'),
  });
  const ohneOptionaleFelder = {
    ...lean,
    untertitelGeleert: cleared(before.subtitle),
    beschreibungGeleert: cleared(before.description),
  };
  const veralteteVersion = await step({
    body: { ...full('d'), version: 1 },
    taken: titled('d'),
  });
  const ifMatch = await step({
    body: full('e'),
    precondition: { ifMatch: staleEntityTag },
    taken: titled('e'),
  });
  const ifUnmodifiedSince = await step({
    body: full('f'),
    precondition: { ifUnmodifiedSince: pastDate },
    taken: titled('f'),
  });
  const loeschen = await remove(run, target);
  return {
    ...anlegen,
    vollstaendig,
    gleicherKoerper,
    ohneOptionaleFelder,
    veralteteVersion,
    ifMatch,
    ifUnmodifiedSince,
    loeschen,
  };
}

async function conflicts(
  run: Run,
  start: string,
  end: string,
  own: Target | undefined,
  describeAnswer: boolean,
): Promise<Json> {
  await run.wait(pauseBeforeWrite);
  const response = await run.writer.send({
    operation: 'bookingConflicts',
    parameters: [],
    body: { resourceId: run.area.resource, startDate: start, endDate: end },
  });
  run.guard.allowFixed(response.status);
  const data = dataOf(response);
  const report: Record<string, Json> = {
    status: response.status,
    anzahl: Array.isArray(data) ? countClass(data.length) : 'unbekannt',
  };
  if (own !== undefined) {
    report['nenntEigeneBuchung'] = succeeded(response)
      ? yesNo(namesId(data, own.id))
      : 'unbekannt';
  }
  if (describeAnswer || !succeeded(response)) {
    report['antwort'] = describe(run, response, 'bookingConflicts');
  }
  return report;
}

async function bookingCases(run: Run): Promise<Json> {
  const title = `${run.titles}buchung`;
  const booking = (
    suffix: string,
    start: string,
    end: string,
    statusId: number,
    description?: string,
  ): Readonly<Record<string, Json>> => ({
    resourceId: run.area.resource,
    title: `${title}-${suffix}`,
    startDate: run.times.at(start),
    endDate: run.times.at(end),
    statusId,
    showInCal: false,
    ...(description === undefined ? {} : { description }),
  });
  const konflikteVorher = await conflicts(
    run,
    run.times.at('05:00'),
    run.times.at('06:00'),
    undefined,
    true,
  );
  const created = await create(
    run,
    'buchung',
    booking('a', '05:00', '06:00', 1, 'Synthetische Buchung der Schreibprobe'),
  );
  const target = created.target;
  const first = target === undefined ? undefined : await read(run, target);
  const ersteBuchung: Record<string, Json> = {
    ...createReport(run, created, first, 'bookingCreate', true, `${title}-a`),
    statusGesendet: 'angefragt',
    statusGelesen:
      first?.status === 200 ? statusWord(first.statusId) : 'unbekannt',
  };
  const konflikteNachher = await conflicts(
    run,
    run.times.at('05:00'),
    run.times.at('06:00'),
    target,
    false,
  );

  const second = await create(
    run,
    'buchung',
    booking('z', '07:00', '08:00', 2),
  );
  const secondView =
    second.target === undefined ? undefined : await read(run, second.target);
  const zweiteBuchung: Record<string, Json> = {
    ...createReport(
      run,
      second,
      secondView,
      'bookingCreate',
      false,
      `${title}-z`,
    ),
    statusGesendet: 'genehmigt',
    statusGelesen:
      secondView?.status === 200
        ? statusWord(secondView.statusId)
        : 'unbekannt',
  };

  let faelle: Json = 'nicht ausgeführt';
  if (target !== undefined && first?.status === 200) {
    let before = first;
    const step = async (change: Change): Promise<Record<string, Json>> => {
      const { report, after } = await update(run, target, before, change);
      before = after;
      return {
        ...report,
        statusGelesen:
          after.status === 200 ? statusWord(after.statusId) : 'unbekannt',
      };
    };
    const moved = (after: ObjectView): boolean =>
      after.startDate !== undefined &&
      Date.parse(after.startDate) === Date.parse(run.times.at('05:30'));
    const later = (
      suffix: string,
      statusId = 1,
    ): Readonly<Record<string, Json>> =>
      booking(
        suffix,
        '05:30',
        '06:30',
        statusId,
        'Synthetische Buchung der Schreibprobe',
      );
    const titled =
      (suffix: string) =>
      (after: ObjectView): boolean =>
        after.title === `${title}-${suffix}`;
    const vollstaendig = await step({ body: later('b'), taken: moved });
    const gleicherKoerper = await step({ body: later('b'), taken: moved });
    const lean = await step({
      body: booking('c', '05:30', '06:30', 1),
      taken: titled('c'),
    });
    const ohneOptionaleFelder = {
      ...lean,
      beschreibungGeleert: cleared(before.description),
    };
    const statusGenehmigt = await step({
      body: later('d', 2),
      taken: titled('d'),
    });
    const veralteteVersion = await step({
      body: { ...later('e'), version: 1 },
      taken: titled('e'),
    });
    faelle = {
      vollstaendig,
      gleicherKoerper,
      ohneOptionaleFelder,
      statusGenehmigt,
      veralteteVersion,
    };
  }
  const loeschen: Record<string, Json> = {};
  if (target !== undefined) {
    loeschen['ersteBuchung'] = await remove(run, target);
  }
  if (second.target !== undefined) {
    loeschen['zweiteBuchung'] = await remove(run, second.target);
  }
  return {
    konflikteVorher,
    ersteBuchung,
    konflikteNachher,
    zweiteBuchung,
    faelle,
    loeschen,
  };
}

/**
 * Finds what the run left behind: every appointment and booking it
 * recorded and has not deleted, and every one in the calendar or of the
 * resource on the day of the probe whose title starts like the titles of
 * the run, as after a create whose answer was lost.
 *
 * @param run - The run.
 * @param day - The day the run wrote on.
 * @returns The appointments and bookings to delete.
 */
async function leftovers(run: Run, day: string): Promise<readonly Target[]> {
  const window: readonly (readonly [string, string])[] = [
    ['from', day],
    ['to', day],
  ];
  const listed = async (kind: CalendarObject): Promise<readonly number[]> => {
    const response = await run.reader.get(
      kind === 'termin'
        ? {
            path: pathFor(
              calendarOperations.calendarAppointmentList.template,
              run.area.calendar,
            ),
            query: window,
          }
        : {
            path: operations.bookings.template,
            query: [
              ['resource_ids[]', String(run.area.resource)],
              ...allBookingStatuses,
              ...window,
            ],
          },
    );
    run.guard.allowFixed(response.status);
    return readCalendarEntries(
      response,
      kind === 'termin' ? 'appointment' : 'booking',
    )
      .filter((entry) => entry.title.startsWith(run.titles))
      .map((entry) => entry.id);
  };
  const targets: Target[] = [];
  for (const kind of ['termin', 'buchung'] as const) {
    const ids = new Set([...run.open[kind], ...(await listed(kind))]);
    targets.push(...[...ids].map((id) => ({ kind, id })));
  }
  return targets;
}

/**
 * Deletes what the run left behind. Errors here end nothing: whatever
 * stays is still in the write state file for the next run.
 *
 * @param run - The run.
 * @param day - The day the run wrote on.
 * @returns How many were deleted and how many stay, per kind.
 */
async function cleanUp(run: Run, day: string): Promise<Json> {
  const count: Record<CalendarObject, { geloescht: number; uebrig: number }> = {
    termin: { geloescht: 0, uebrig: 0 },
    buchung: { geloescht: 0, uebrig: 0 },
  };
  const targets = new Map<string, Target>();
  try {
    for (const target of await leftovers(run, day)) {
      targets.set(`${target.kind}:${String(target.id)}`, target);
    }
  } catch {
    // Without the lists, the recorded IDs still count.
    for (const kind of ['termin', 'buchung'] as const) {
      for (const id of run.open[kind]) {
        targets.set(`${kind}:${String(id)}`, { kind, id });
      }
    }
  }
  for (const target of targets.values()) {
    try {
      const response = await run.writer.send({
        operation: deleteOperation(target.kind),
        parameters: parametersOf(run, target),
      });
      run.guard.allowFixed(response.status);
      if (succeeded(response) || response.status === 404) {
        if (run.open[target.kind].delete(target.id)) {
          run.file.deleted(target.kind, target.id);
        }
        count[target.kind].geloescht += 1;
        continue;
      }
    } catch {
      // Counted as left below.
    }
    count[target.kind].uebrig += 1;
  }
  return {
    termine: {
      geloescht: countClass(count.termin.geloescht),
      uebrig: countClass(count.termin.uebrig),
    },
    buchungen: {
      geloescht: countClass(count.buchung.geloescht),
      uebrig: countClass(count.buchung.uebrig),
    },
  };
}

async function whoAmI(
  client: Client,
  guard: Guard,
): Promise<number | undefined> {
  const response = await client.get({ path: operations.whoami.template });
  guard.allowFixed(response.status);
  const data = dataOf(response);
  return isObject(data) && isPositive(data['id']) ? data['id'] : undefined;
}

/** The probe, for tests and for {@link main}. */
export const probe: ProbeDefinition = {
  name: '11-calendar-write',
  state: 'read',
  account: 'write',
  async run({ client, guard, state, write, origin, wait }): Promise<Json> {
    guard.allowFixed(...words, ...countClasses);
    if (state === undefined || write === undefined) {
      throw new Error('INTERN');
    }
    const area = write.settings.calendarArea;
    if (area === undefined) {
      throw new SpikeError('KONFIGURATION', 'kalenderprobeOhneBereich');
    }
    const path = write.settings.writeStatePath;
    let earlier: ReturnType<typeof readCalendarState> | undefined;
    try {
      checkNewWriteState(path);
    } catch (error) {
      if (
        !(error instanceof SpikeError) ||
        error.hint !== 'schreibStateVorhanden'
      ) {
        throw error;
      }
      earlier = readCalendarState(path, origin, area);
    }
    const document = state.specification;
    const times = probeTimes(new Date());
    // A second run deletes on the day the earlier run wrote on.
    const day = earlier?.day ?? times.day;
    const { writer, reader, result } = await passGate(
      { client, state },
      write.access,
      write.settings,
      earlier === undefined
        ? {
            writes: [
              'appointmentCreate',
              'appointmentUpdate',
              'appointmentDelete',
              'bookingCreate',
              'bookingUpdate',
              'bookingDelete',
              'bookingConflicts',
            ],
            ownPages: new Set(),
            calendar: {
              ownAppointments: new Set(),
              ownBookings: new Set(),
              from: day,
              to: day,
            },
            summary,
          }
        : {
            writes: ['appointmentDelete', 'bookingDelete'],
            ownPages: new Set(),
            calendar: {
              ownAppointments: new Set(earlier.appointments),
              ownBookings: new Set(earlier.bookings),
              ownTitles: `${pageTitlePrefix}-${earlier.run}-`,
              from: day,
              to: day,
            },
            summary: cleanupSummary,
          },
    );
    if (reader === undefined) {
      throw new SpikeError('INTERN');
    }
    const file =
      earlier === undefined
        ? CalendarStateFile.create(path, origin, area, times.day)
        : CalendarStateFile.reopen(path, earlier.run);
    const run: Run = {
      client,
      reader,
      writer,
      guard,
      schemas: new Schemas(document),
      document,
      area,
      file,
      wait,
      self: await whoAmI(client, guard),
      times,
      titles: `${pageTitlePrefix}-${file.run}-`,
      open: {
        termin: new Set(earlier?.appointments ?? []),
        buchung: new Set(earlier?.bookings ?? []),
      },
    };
    const rights = async (): Promise<string> => {
      const within = await rightsStillWithin(
        client,
        write.settings,
        result.identification,
      );
      return within === undefined ? 'unbekannt' : yesNo(within);
    };
    try {
      if (earlier !== undefined) {
        const aufraeumen = await cleanUp(run, day);
        return {
          probe: '11-calendar-write',
          modus: 'aufraeumen',
          aufraeumen,
          rechteUnveraendert: await rights(),
        };
      }
      let completed = false;
      try {
        const termin = await appointmentCases(run);
        const buchungen = await bookingCases(run);
        completed = true;
        return {
          probe: '11-calendar-write',
          modus: 'proben',
          termin,
          buchungen,
          aufraeumen: await cleanUp(run, day),
          rechteUnveraendert: await rights(),
        };
      } finally {
        if (!completed) {
          await cleanUp(run, day);
        }
      }
    } catch (error) {
      throw error instanceof SpikeError
        ? new SpikeError(error.code, 'kalenderSchreibenAbgebrochen')
        : new SpikeError('INTERN', 'kalenderSchreibenAbgebrochen');
    } finally {
      file.close();
    }
  },
};

if (import.meta.main) {
  process.exitCode = await main(probe, import.meta.url);
}
