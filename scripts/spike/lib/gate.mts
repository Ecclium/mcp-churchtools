/**
 * The guard of the test environment (ADR 0049).
 *
 * Every probe that runs with the write account passes through here before
 * its first request, and every probe that writes before its first write.
 * The guard decides whether the instance counts as the test instance and
 * whether the account is the narrow write account. Whatever it cannot
 * check, it treats as a reason to stop: an operation the instance does not
 * document, an answer of another form, a field that is missing. The
 * instance then counts as productive, and nothing is written.
 *
 * Before any request, from the environment alone:
 * - the switch `ECCLIUM_SPIKE_ALLOW_WRITE` equals the first label of the
 *   host, so a mistyped base URL stops the run;
 * - the base URL is not the placeholder of the README;
 * - the token comes only from `ECCLIUM_SPIKE_WRITE_TOKEN_FILE`, and the
 *   variable of the read account is not set at the same time;
 * - `ECCLIUM_SPIKE_WRITE_CALENDAR_ID` and `ECCLIUM_SPIKE_WRITE_RESOURCE_ID`
 *   are both set or both missing.
 *
 * Then, by reading:
 * - exactly one category the account can see has the fixed name of the
 *   identification category, and the account can neither edit nor delete
 *   it;
 * - the write area from the environment is a different category, visible
 *   and editable, and the account sees no third category;
 * - the global rights allow exactly this: see the wiki, see the write area
 *   and the identification category, edit the write area, and with the two
 *   variables above also see the probe calendar and edit its appointments,
 *   see the probe resource and request bookings of it;
 * - with those variables, the account sees exactly that one calendar and
 *   that one resource, and the resource can be booked without an
 *   appointment;
 * - the write area holds only its automatic page and the pages of the
 *   current run, and for a probe that writes appointments and bookings,
 *   calendar and resource hold, in the time window of the probe, only
 *   those of the current run.
 *
 * Last, a person at a terminal confirms with «ja». Only then does the guard
 * hand out the client that writes. That client exists nowhere else: the
 * token reaches it only through the opaque {@link WriteAccess} the common
 * course of a probe creates. A probe that writes appointments and bookings
 * also gets a client that reads them back, and only them.
 *
 * @packageDocumentation
 */
import { readCategoryId, type Environment, type SpikeState } from './env.mts';
import { SpikeError, type HintKey } from './errors.mts';
import {
  createCalendarClient,
  createWriteClient,
  guidPattern,
  pathFor,
  writeTemplate,
  type CalendarArea,
  type Client,
  type ClientOptions,
  type ProbeResponse,
  type WriteClient,
  type WriteOperation,
} from './http.mts';
import {
  calendarOperations,
  operations,
  type OperationName,
} from './operations.mts';
import { findOperation, isObject, type JsonObject } from './spec.mts';
import { writeStatePath } from './write-state.mts';

/**
 * The fixed name of the identification category. Only an instance with
 * exactly one category of this name counts as the test instance (ADR 0049).
 */
export const identificationCategoryName = 'testinstanz-kennung';

/** The start of the title of every page the write probes create. */
export const pageTitlePrefix = 'spike-schreibprobe';

/** The title of the page ChurchTools creates in every new category. */
export const autoPageTitle = 'main';

/** The base URL of the README, never a real instance. */
export const placeholderHost = 'example.church.tools';

/** One line typed by the person who runs a probe. Replaceable in tests. */
export interface Input {
  /** Whether stdin is a terminal. */
  readonly isTerminal: boolean;
  /**
   * Shows a prompt on stderr and reads one line.
   *
   * @param prompt - Fixed text of the probe.
   * @returns The line without its line break, or `undefined` at the end of the input.
   */
  readLine(prompt: string): Promise<string | undefined>;
}

/** Input that never confirms, for a run without a terminal. */
export const noInput: Input = {
  isTerminal: false,
  readLine: () => Promise.resolve(undefined),
};

/** What the common course hands a probe of the write account. */
export interface WriteAccess {
  readonly kind: 'Schreibkonto';
}

const secrets = new WeakMap<
  WriteAccess,
  { readonly options: ClientOptions; readonly input: Input }
>();

/**
 * Wraps what the write client needs, so that only {@link passGate} can
 * open it. The common course of a probe calls this; a probe cannot reach
 * the token inside.
 *
 * @param options - Origin, token, guard and fetch of the run.
 * @param input - Where the confirmation comes from.
 * @returns An opaque handle.
 */
export function createWriteAccess(
  options: ClientOptions,
  input: Input,
): WriteAccess {
  const access: WriteAccess = Object.freeze({ kind: 'Schreibkonto' });
  secrets.set(access, { options, input });
  return access;
}

/** What the guard reads from the environment. */
export interface WriteSettings {
  /** ID of the write area. */
  readonly writeCategory: number;
  /** Path of the write state file. */
  readonly writeStatePath: string;
  /** Calendar and resource of the probes, if the environment names them. */
  readonly calendarArea?: CalendarArea;
}

function readAreaId(
  env: Environment,
  name: 'ECCLIUM_SPIKE_WRITE_CALENDAR_ID' | 'ECCLIUM_SPIKE_WRITE_RESOURCE_ID',
): number | undefined {
  const raw = env[name] ?? '';
  if (raw === '') {
    return undefined;
  }
  if (!/^[1-9]\d{0,9}$/.test(raw)) {
    throw new SpikeError('KONFIGURATION', 'schreibKalenderFehlt');
  }
  return Number(raw);
}

/**
 * Reads calendar and resource of the probes from the environment. Either
 * both variables are set or neither: a calendar without its resource would
 * leave the account with rights the guard no longer recognises.
 *
 * @param env - Environment of the process.
 * @returns Calendar and resource, or `undefined` if neither is set.
 * @throws {SpikeError} If only one is set, or one is no positive whole number.
 */
export function readCalendarArea(env: Environment): CalendarArea | undefined {
  const calendar = readAreaId(env, 'ECCLIUM_SPIKE_WRITE_CALENDAR_ID');
  const resource = readAreaId(env, 'ECCLIUM_SPIKE_WRITE_RESOURCE_ID');
  if (calendar === undefined && resource === undefined) {
    return undefined;
  }
  if (calendar === undefined || resource === undefined) {
    throw new SpikeError('KONFIGURATION', 'schreibKalenderFehlt');
  }
  return { calendar, resource };
}

/**
 * Checks the environment of a probe of the write account, before any
 * request.
 *
 * @param env - Environment of the process.
 * @param origin - Origin from the base URL.
 * @returns The write area, the path of the write state file, and calendar and resource if set.
 * @throws {SpikeError} If the switch is missing or does not fit the host, the base URL is the placeholder, the variable of the read account is set, a variable of the write account is missing, or only one of calendar and resource is set.
 */
export function checkWriteEnvironment(
  env: Environment,
  origin: string,
): WriteSettings {
  checkSwitch(env, origin, {
    variable: 'ECCLIUM_SPIKE_ALLOW_WRITE',
    missing: 'schalterFehlt',
    wrong: 'schalterFalsch',
  });
  if ((env['ECCLIUM_SPIKE_TOKEN_FILE'] ?? '') !== '') {
    throw new SpikeError('KONFIGURATION', 'zweiTokenVariablen');
  }
  const writeCategory =
    readCategoryId(env, 'ECCLIUM_SPIKE_WRITE_CATEGORY_ID', true) ?? 0;
  const path = writeStatePath(env);
  const calendarArea = readCalendarArea(env);
  return {
    writeCategory,
    writeStatePath: path,
    ...(calendarArea === undefined ? {} : { calendarArea }),
  };
}

/** The variable of a switch and the hints if it is missing or wrong. */
export interface SwitchHints {
  readonly variable:
    | 'ECCLIUM_SPIKE_ALLOW_WRITE'
    | 'ECCLIUM_SPIKE_ALLOW_PERSONS'
    | 'ECCLIUM_SMOKE_ALLOW_SEARCH'
    | 'ECCLIUM_SMOKE_ALLOW_API'
    | 'ECCLIUM_SEED_ALLOW_WRITE';
  readonly missing: HintKey;
  readonly wrong: HintKey;
}

/**
 * Checks that the base URL is not the placeholder of the README and that
 * a switch equals the first label of the host, so a mistyped base URL
 * stops the run before any request.
 *
 * @param env - Environment of the process.
 * @param origin - Origin from the base URL.
 * @param hints - The switch variable and its hints.
 * @throws {SpikeError} If the base URL is the placeholder, or the switch is missing or does not fit the host.
 */
export function checkSwitch(
  env: Environment,
  origin: string,
  hints: SwitchHints,
): void {
  const host = new URL(origin).hostname;
  if (host === placeholderHost) {
    throw new SpikeError('KONFIGURATION', 'platzhalterHost');
  }
  const switchValue = env[hints.variable] ?? '';
  if (switchValue === '') {
    throw new SpikeError('KONFIGURATION', hints.missing);
  }
  const [label] = host.split('.');
  if (label === undefined || switchValue.toLowerCase() !== label) {
    throw new SpikeError('KONFIGURATION', hints.wrong);
  }
}

function refuse(hint: HintKey): SpikeError {
  return new SpikeError('KONFIGURATION', hint);
}

/**
 * Tells whether a value is an ID: a positive safe whole number.
 *
 * @param value - Any value.
 * @returns Whether it is an ID.
 */
export function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * Tells whether a value is a list of exactly the given IDs, each once.
 *
 * @param value - Any value.
 * @param expected - The IDs the list must hold.
 * @returns Whether the list holds exactly these IDs.
 */
export function sameIds(value: unknown, expected: readonly number[]): boolean {
  if (!Array.isArray(value) || !value.every(isId)) {
    return false;
  }
  const ids = new Set(value);
  return (
    ids.size === value.length &&
    ids.size === expected.length &&
    expected.every((id) => ids.has(id))
  );
}

/**
 * Tells whether the global rights stay inside what the write account may
 * do.
 *
 * Allowed in `churchwiki` are exactly: `view` true, `view category` the
 * write area and the identification category, `edit category` the write
 * area. With a calendar area, also exactly: in `churchcal`, `view category`
 * and `edit category` the probe calendar; in `churchresource`, `view
 * resource` and `create bookings` the probe resource; and in both modules
 * `view` true or false, since the web interface may store it with the
 * others. Every other right of every module, `edit masterdata`,
 * `administer bookings` and the rights of other calendars included, must
 * be `false` or an empty list. Anything else, a right of another type
 * included, is too much.
 *
 * @param data - `data` of `GET /api/permissions/global`.
 * @param writeCategory - ID of the write area.
 * @param identification - ID of the identification category.
 * @param area - Calendar and resource of the probes, if the environment names them.
 * @returns Whether the rights are narrow enough.
 */
export function rightsWithin(
  data: unknown,
  writeCategory: number,
  identification: number,
  area?: CalendarArea,
): boolean {
  if (!isObject(data)) {
    return false;
  }
  const wiki = data['churchwiki'];
  if (
    !isObject(wiki) ||
    wiki['view'] !== true ||
    !sameIds(wiki['view category'], [writeCategory, identification]) ||
    !sameIds(wiki['edit category'], [writeCategory])
  ) {
    return false;
  }
  const granted: Readonly<Record<string, Readonly<Record<string, number>>>> =
    area === undefined
      ? {}
      : {
          churchcal: {
            'view category': area.calendar,
            'edit category': area.calendar,
          },
          churchresource: {
            'view resource': area.resource,
            'create bookings': area.resource,
          },
        };
  for (const [module, ids] of Object.entries(granted)) {
    const rights = data[module];
    if (
      !isObject(rights) ||
      !Object.entries(ids).every(([name, id]) => sameIds(rights[name], [id]))
    ) {
      return false;
    }
  }
  for (const [module, rights] of Object.entries(data)) {
    if (!isObject(rights)) {
      return false;
    }
    // Own keys only: a module named like a property of every object, such
    // as `constructor`, must not find something to allow.
    const allowed = Object.hasOwn(granted, module)
      ? granted[module]
      : undefined;
    for (const [name, value] of Object.entries(rights)) {
      if (
        (module === 'churchwiki' &&
          ['view', 'view category', 'edit category'].includes(name)) ||
        (allowed !== undefined && Object.hasOwn(allowed, name)) ||
        (allowed !== undefined && name === 'view' && typeof value === 'boolean')
      ) {
        continue;
      }
      if (value !== false && !(Array.isArray(value) && value.length === 0)) {
        return false;
      }
    }
  }
  return true;
}

/** A wiki category as a guard sees it. */
export interface Category {
  readonly id: number;
  readonly name: string;
  readonly canEdit: boolean;
  readonly canDelete: boolean;
}

function dataList(
  response: ProbeResponse,
  unexpected: HintKey,
): readonly unknown[] {
  const data = isObject(response.body) ? response.body['data'] : undefined;
  if (
    response.status !== 200 ||
    response.kind !== 'JSON' ||
    !Array.isArray(data)
  ) {
    throw refuse(unexpected);
  }
  return data;
}

/**
 * Reads the categories the account can see and whether it may edit master
 * data.
 *
 * @param response - Answer of `GET /api/wiki/categories`.
 * @param unexpected - Hint if the answer has another form.
 * @returns The categories and the right to edit master data.
 * @throws {SpikeError} If the answer has another form than documented.
 */
export function readCategories(
  response: ProbeResponse,
  unexpected: HintKey,
): {
  readonly categories: readonly Category[];
  readonly editMasterData: boolean;
} {
  const entries = dataList(response, unexpected);
  const body = response.body as JsonObject;
  const permissions = body['permissions'];
  const editMasterData = isObject(permissions)
    ? permissions['editMasterData']
    : undefined;
  if (typeof editMasterData !== 'boolean') {
    throw refuse(unexpected);
  }
  const categories = entries.map((entry): Category => {
    const rights = isObject(entry) ? entry['permissions'] : undefined;
    if (
      !isObject(entry) ||
      !isId(entry['id']) ||
      typeof entry['name'] !== 'string' ||
      !isObject(rights) ||
      typeof rights['canEdit'] !== 'boolean' ||
      typeof rights['canDelete'] !== 'boolean'
    ) {
      throw refuse(unexpected);
    }
    return {
      id: entry['id'],
      name: entry['name'],
      canEdit: rights['canEdit'],
      canDelete: rights['canDelete'],
    };
  });
  return { categories, editMasterData };
}

/** The hints if the identification category is missing, double or editable. */
export interface IdentificationHints {
  readonly missing: HintKey;
  readonly multiple: HintKey;
  readonly editable: HintKey;
}

/**
 * Finds the identification category among the visible categories. There
 * must be exactly one of its fixed name, and the account may neither edit
 * nor delete it.
 *
 * @param categories - The categories the account can see.
 * @param hints - The hints for each way the check fails.
 * @returns The identification category.
 * @throws {SpikeError} If it is missing, appears twice or may be edited or deleted.
 */
export function findIdentification(
  categories: readonly Category[],
  hints: IdentificationHints,
): Category {
  const named = categories.filter(
    (category) => category.name === identificationCategoryName,
  );
  const [identification] = named;
  if (identification === undefined) {
    throw refuse(hints.missing);
  }
  if (named.length > 1) {
    throw refuse(hints.multiple);
  }
  if (identification.canEdit || identification.canDelete) {
    throw refuse(hints.editable);
  }
  return identification;
}

/** A page of the write area, as the guard saw it. */
export interface PageEntry {
  readonly guid: string;
  readonly title: string;
}

function readPages(response: ProbeResponse): readonly PageEntry[] {
  const entries = dataList(response, 'waechterAntwortUnerwartet');
  const body = response.body as JsonObject;
  const meta = body['meta'];
  const count = isObject(meta) ? meta['count'] : undefined;
  // The list carries no pagination. Without the documented count, or with
  // a count beyond the list, the guard would not know it saw every page.
  if (typeof count !== 'number' || count !== entries.length) {
    throw refuse('waechterAntwortUnerwartet');
  }
  return entries.map((entry): PageEntry => {
    if (
      !isObject(entry) ||
      typeof entry['guid'] !== 'string' ||
      !guidPattern.test(entry['guid']) ||
      typeof entry['title'] !== 'string'
    ) {
      throw refuse('waechterAntwortUnerwartet');
    }
    return { guid: entry['guid'], title: entry['title'] };
  });
}

/** What a probe needs for the checks by reading. */
export interface GateContext {
  readonly client: Client;
  readonly state: SpikeState;
}

/** What a probe that writes appointments and bookings expects. */
export interface CalendarGateOptions {
  /** IDs of appointments of the current run that may lie in the calendar. */
  readonly ownAppointments: ReadonlySet<number>;
  /** IDs of bookings of the current run that the resource may have. */
  readonly ownBookings: ReadonlySet<number>;
  /**
   * Start of the titles of an earlier run, `spike-schreibprobe-<tag>-`,
   * whose leftovers a run deletes. An appointment or booking with such a
   * title counts as its own even without its ID, as after a create whose
   * answer was lost.
   */
  readonly ownTitles?: string;
  /** First day of the time window of the probe, `YYYY-MM-DD`. */
  readonly from: string;
  /** Last day of the time window of the probe, `YYYY-MM-DD`. */
  readonly to: string;
}

/** What the probe expects of the instance. */
export interface GateOptions {
  /** The write operations the probe will send; each must be documented. */
  readonly writes: readonly WriteOperation[];
  /** GUIDs of the current run that may lie in the write area. */
  readonly ownPages: ReadonlySet<string>;
  /**
   * Start of the titles of the current run, `spike-schreibprobe-<tag>-`.
   * A page with such a title counts as its own even without its GUID, as
   * after a create whose answer was lost.
   */
  readonly ownTitles?: string;
  /** Set for a probe that writes appointments and bookings. */
  readonly calendar?: CalendarGateOptions;
}

/** The read operations of a probe that writes appointments and bookings. */
const calendarReads = [
  'calendarAppointmentList',
  'calendarAppointment',
  'booking',
] as const;

/** Bookings of every status, so that a refused one counts as well. */
export const allBookingStatuses: readonly (readonly [string, string])[] = [
  ['status_ids[]', '1'],
  ['status_ids[]', '2'],
  ['status_ids[]', '3'],
];

function idList(
  response: ProbeResponse,
): readonly (JsonObject & { readonly id: number })[] {
  return dataList(response, 'waechterAntwortUnerwartet').map((entry) => {
    if (!isObject(entry) || !isId(entry['id'])) {
      throw refuse('waechterAntwortUnerwartet');
    }
    return entry as JsonObject & { readonly id: number };
  });
}

/**
 * Checks that the account sees exactly the probe calendar and the probe
 * resource, and that the resource can be booked without an appointment.
 * Both lists need no right beyond the one for the object and name no
 * person, so the client of every probe reads them.
 *
 * @param client - The client that reads.
 * @param area - Calendar and resource of the probes.
 * @throws {SpikeError} If the account sees another calendar or resource, misses one, or the resource needs an appointment.
 */
async function checkCalendarArea(
  client: Client,
  area: CalendarArea,
): Promise<void> {
  const calendars = idList(
    await client.get({ path: operations.calendars.template }),
  );
  if (calendars.length !== 1 || calendars[0]?.id !== area.calendar) {
    throw refuse('schreibKalenderNichtSichtbar');
  }
  const resources = idList(
    await client.get({ path: operations.resources.template }),
  );
  const [resource] = resources;
  if (resources.length !== 1 || resource?.id !== area.resource) {
    throw refuse('schreibRessourceNichtSichtbar');
  }
  const needsAppointment = resource['needsAppointment'];
  if (typeof needsAppointment !== 'boolean') {
    throw refuse('waechterAntwortUnerwartet');
  }
  if (needsAppointment) {
    throw refuse('ressourceBrauchtTermin');
  }
}

/** An appointment or a booking in a list, as the guard saw it. */
export interface CalendarEntry {
  readonly id: number;
  readonly title: string;
}

/**
 * Reads the entries of a list of appointments or bookings. Each entry
 * holds the stored object under `appointment.base` or `booking.base`; the
 * older `base` beside it is marked as deprecated and not read.
 *
 * @param response - Answer of the list.
 * @param kind - Which list it is.
 * @returns ID and title of each entry.
 * @throws {SpikeError} If the answer has another form.
 */
export function readCalendarEntries(
  response: ProbeResponse,
  kind: 'appointment' | 'booking',
): readonly CalendarEntry[] {
  return dataList(response, 'waechterAntwortUnerwartet').map((entry) => {
    const wrapped = isObject(entry) ? entry[kind] : undefined;
    const base = isObject(wrapped) ? wrapped['base'] : undefined;
    if (
      !isObject(base) ||
      !isId(base['id']) ||
      typeof base['title'] !== 'string'
    ) {
      throw refuse('waechterAntwortUnerwartet');
    }
    return { id: base['id'], title: base['title'] };
  });
}

/**
 * Checks that the probe calendar and the probe resource hold, in the time
 * window of the probe, only appointments and bookings of the current run.
 *
 * @param reader - The client limited to calendar and resource.
 * @param area - Calendar and resource of the probes.
 * @param options - Own IDs, own titles and the time window.
 * @throws {SpikeError} If anything else lies there, or an answer has another form.
 */
async function checkForeignEntries(
  reader: Client,
  area: CalendarArea,
  options: CalendarGateOptions,
): Promise<void> {
  const window: readonly (readonly [string, string])[] = [
    ['from', options.from],
    ['to', options.to],
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
  const { ownTitles } = options;
  const foreign = (
    entries: readonly CalendarEntry[],
    own: ReadonlySet<number>,
  ) =>
    entries.some(
      (entry) =>
        !own.has(entry.id) &&
        !(ownTitles !== undefined && entry.title.startsWith(ownTitles)),
    );
  if (
    foreign(appointments, options.ownAppointments) ||
    foreign(bookings, options.ownBookings)
  ) {
    throw refuse('fremdeTermine');
  }
}

/** What the checks by reading found. */
export interface GateResult {
  /** ID of the identification category. */
  readonly identification: number;
  /** ID of the write area. */
  readonly writeCategory: number;
  /** The pages of the write area. */
  readonly pages: readonly PageEntry[];
}

/**
 * Runs the checks by reading. Probes that only read with the write account
 * use this; probes that write use {@link passGate}.
 *
 * @param context - The client that reads and the state of 00-inventory.
 * @param settings - What the environment named.
 * @param options - Write operations and own pages of the probe.
 * @returns The IDs and the pages the checks saw.
 * @throws {SpikeError} If one check fails; then nothing may be written.
 */
export async function checkInstance(
  context: GateContext,
  settings: WriteSettings,
  options: GateOptions,
): Promise<GateResult> {
  const area = settings.calendarArea;
  if (options.calendar !== undefined && area === undefined) {
    throw new SpikeError('KONFIGURATION', 'kalenderprobeOhneBereich');
  }
  const document = context.state.specification;
  const reads: readonly OperationName[] = [
    'wikiCategories',
    'permissionsGlobal',
    'wikiCategoryPages',
    ...(area === undefined ? [] : (['calendars', 'resources'] as const)),
    ...(options.calendar === undefined ? [] : (['bookings'] as const)),
  ];
  const needed = [
    ...reads.map((name) => operations[name]),
    ...(options.calendar === undefined
      ? []
      : calendarReads.map((name) => calendarOperations[name])),
    ...options.writes.map(writeTemplate),
  ];
  for (const { method, template } of needed) {
    if (findOperation(document, method, template) === undefined) {
      throw refuse('waechterOperationFehlt');
    }
  }

  const { categories, editMasterData } = readCategories(
    await context.client.get({ path: operations.wikiCategories.template }),
    'waechterAntwortUnerwartet',
  );
  const identification = findIdentification(categories, {
    missing: 'kennkategorieFehlt',
    multiple: 'kennkategorieMehrfach',
    editable: 'kennkategorieBearbeitbar',
  });
  const { writeCategory } = settings;
  if (writeCategory === identification.id) {
    throw refuse('schreibKategorieIstKennung');
  }
  const writeArea = categories.find(
    (category) => category.id === writeCategory,
  );
  if (writeArea === undefined) {
    throw refuse('schreibKategorieNichtSichtbar');
  }
  if (!writeArea.canEdit) {
    throw refuse('schreibKategorieNichtBearbeitbar');
  }
  if (categories.length !== 2) {
    throw refuse('weitereKategorien');
  }
  if (editMasterData) {
    throw refuse('zuWeitBerechtigt');
  }

  const rights = await context.client.get({
    path: operations.permissionsGlobal.template,
  });
  if (rights.status !== 200 || rights.kind !== 'JSON') {
    throw refuse('waechterAntwortUnerwartet');
  }
  const data = isObject(rights.body) ? rights.body['data'] : undefined;
  if (!isObject(data)) {
    throw refuse('waechterAntwortUnerwartet');
  }
  if (!rightsWithin(data, writeCategory, identification.id, area)) {
    throw refuse('zuWeitBerechtigt');
  }
  if (area !== undefined) {
    await checkCalendarArea(context.client, area);
  }

  const pages = readPages(
    await context.client.get({
      path: pathFor(operations.wikiCategoryPages.template, writeCategory),
    }),
  );
  const automatic = pages.filter((page) => page.title === autoPageTitle);
  const { ownTitles } = options;
  const foreign = pages.filter(
    (page) =>
      page.title !== autoPageTitle &&
      !options.ownPages.has(page.guid) &&
      !(ownTitles !== undefined && page.title.startsWith(ownTitles)),
  );
  if (automatic.length > 1 || foreign.length > 0) {
    throw refuse('fremdeSeiten');
  }
  return { identification: identification.id, writeCategory, pages };
}

/** What a probe gets once the guard lets it write. */
export interface GatePass {
  readonly result: GateResult;
  readonly writer: WriteClient;
  /**
   * For a probe that writes appointments and bookings: the client that
   * reads them, limited to the probe calendar and the probe resource.
   */
  readonly reader?: Client;
}

/**
 * Runs every check, asks for the confirmation, and only then hands out the
 * client that writes.
 *
 * @param context - The client that reads and the state of 00-inventory.
 * @param access - The handle from the common course of the probe.
 * @param settings - What the environment named.
 * @param options - Write operations, own pages and, for appointments and bookings, own IDs and time window of the probe, and the summary shown before the question.
 * @returns The result of the checks, the write client and, for appointments and bookings, the client that reads them.
 * @throws {SpikeError} If stdin is no terminal, a check fails, or the answer is not exactly «ja».
 */
export async function passGate(
  context: GateContext,
  access: WriteAccess,
  settings: WriteSettings,
  options: GateOptions & { readonly summary: string },
): Promise<GatePass> {
  const secret = secrets.get(access);
  if (secret === undefined) {
    throw new SpikeError('INTERN');
  }
  if (!secret.input.isTerminal) {
    throw refuse('keinTerminal');
  }
  const result = await checkInstance(context, settings, options);
  const area = settings.calendarArea;
  let reader: Client | undefined;
  if (options.calendar !== undefined && area !== undefined) {
    // Only now, with calendar and resource checked, may a client reach
    // their appointments and bookings, which name persons.
    reader = createCalendarClient(secret.options, area);
    await checkForeignEntries(reader, area, options.calendar);
  }
  const answer = await secret.input.readLine(
    `${options.summary}\nAlle Prüfungen des Wächters sind bestanden. Vergleichen Sie die SHA-256 oben mit dem Pull Request.\nWeiter? Tippen Sie «ja»: `,
  );
  if (answer !== 'ja') {
    throw refuse('nichtBestaetigt');
  }
  return {
    result,
    writer: createWriteClient(secret.options),
    ...(reader === undefined ? {} : { reader }),
  };
}

/**
 * Checks after a run that the rights of the account are still the narrow
 * ones. ChurchTools can grant rights on its own, as it does to whoever
 * creates a group; the run then reports it instead of passing silently.
 *
 * @param client - The client that reads.
 * @param settings - What the environment named.
 * @param identification - ID of the identification category.
 * @returns Whether the rights are still narrow enough, or `undefined` if the answer had another form.
 */
export async function rightsStillWithin(
  client: Client,
  settings: WriteSettings,
  identification: number,
): Promise<boolean | undefined> {
  const rights = await client.get({
    path: operations.permissionsGlobal.template,
  });
  const data = isObject(rights.body) ? rights.body['data'] : undefined;
  if (rights.status !== 200 || !isObject(data)) {
    return undefined;
  }
  return rightsWithin(
    data,
    settings.writeCategory,
    identification,
    settings.calendarArea,
  );
}
