/**
 * The write state: which pages one run of 05-wiki-write created.
 *
 * 05-wiki-write creates the file before its first write and adds every page
 * the moment the instance confirms it, with a sync to disk before the next
 * request. A run that stops halfway therefore still names every page it
 * created, and 07-wiki-cleanup can remove exactly those. 06 reads the state
 * of each page after 05 from here, to tell changes of the web editor from
 * changes of the probe.
 *
 * The file is JSON Lines: a header with format, instance, write area and a
 * random tag of the run, then one line per page and one per recorded state
 * of a page. Like the state of 00-inventory, it is created exclusively with
 * mode 0600, outside every Git working tree, and read back only after the
 * same checks as the token file.
 *
 * 11-calendar-write keeps a file of its own format in the same way: a
 * header with format, instance, calendar, resource, the tag and the day of
 * the run,
 * then one line per appointment or booking it created and one per deletion
 * the instance confirmed.
 *
 * @packageDocumentation
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  writeSync,
} from 'node:fs';

import {
  instanceId,
  isInsideGitWorkTree,
  readPrivateFile,
  type Environment,
} from './env.mts';
import { SpikeError } from './errors.mts';
import { guidPattern, type CalendarArea } from './http.mts';
import { isObject } from './spec.mts';

const format = 'ecclium-spike-write-state.v1';
const maxWriteStateBytes = 1024 * 1024;

/**
 * What a page of the run is for: the three pages for the web editor, by
 * the name the output uses, or the cases of 05.
 */
export type PageRole = 'markdown1' | 'markdown2' | 'standardformat' | 'faelle';

const roles: readonly string[] = [
  'markdown1',
  'markdown2',
  'standardformat',
  'faelle',
] satisfies PageRole[];

/** The state of a page after 05-wiki-write, for the comparison in 06. */
export interface PageBaseline {
  readonly version: number;
  /** SHA-256 of the text, as hexadecimal text. */
  readonly textHash: string;
}

/** One page the run created. */
export interface WriteStatePage {
  readonly guid: string;
  readonly role: PageRole;
  readonly baseline: PageBaseline | undefined;
}

/** The write state as read back. */
export interface WriteState {
  readonly instance: string;
  readonly category: number;
  /** Random tag of the run, part of every page title. */
  readonly run: string;
  readonly pages: readonly WriteStatePage[];
}

/**
 * Reads the path of the write state file from the environment.
 *
 * @param env - Environment of the process.
 * @returns The path.
 * @throws {SpikeError} If the variable is missing.
 */
export function writeStatePath(env: Environment): string {
  const path = env['ECCLIUM_SPIKE_WRITE_STATE_FILE'] ?? '';
  if (path === '') {
    throw new SpikeError('KONFIGURATION', 'schreibStateFehlt');
  }
  return path;
}

/**
 * Checks, before the first request, that 05-wiki-write can create the write
 * state file.
 *
 * @param path - Path of the write state file.
 * @throws {SpikeError} If the path exists, even as a link, or lies inside a Git working tree.
 */
export function checkNewWriteState(path: string): void {
  if (isInsideGitWorkTree(path)) {
    throw new SpikeError('DATEI', 'schreibStateUnsicher');
  }
  let exists: boolean;
  try {
    exists = lstatSync(path, { throwIfNoEntry: false }) !== undefined;
  } catch {
    throw new SpikeError('DATEI', 'schreibStateUnsicher');
  }
  if (exists) {
    throw new SpikeError('DATEI', 'schreibStateVorhanden');
  }
}

/** The write state file while 05-wiki-write runs. */
export class WriteStateFile {
  readonly #descriptor: number;

  /** Random tag of the run, part of every page title. */
  readonly run: string;

  private constructor(descriptor: number, run: string) {
    this.#descriptor = descriptor;
    this.run = run;
  }

  /**
   * Creates the write state file with its header. It must not exist yet.
   *
   * @param path - Path of the write state file.
   * @param origin - Origin of the instance.
   * @param category - ID of the write area.
   * @returns The open file.
   * @throws {SpikeError} If the file exists or cannot be created safely.
   */
  static create(
    path: string,
    origin: string,
    category: number,
  ): WriteStateFile {
    const file = new WriteStateFile(
      createStateFile(path),
      randomBytes(4).toString('hex'),
    );
    file.#append({
      format,
      instance: instanceId(origin),
      category,
      run: file.run,
    });
    return file;
  }

  /**
   * Records a page the instance has just created.
   *
   * @param guid - GUID of the page.
   * @param role - What the page is for.
   * @throws {SpikeError} If the GUID has another form.
   */
  addPage(guid: string, role: PageRole): void {
    if (!guidPattern.test(guid)) {
      throw new SpikeError('INTERN');
    }
    this.#append({ page: guid, role });
  }

  /**
   * Records the state of a page after 05-wiki-write.
   *
   * @param guid - GUID of a recorded page.
   * @param baseline - Version and hash of the text.
   */
  setBaseline(guid: string, baseline: PageBaseline): void {
    this.#append({ baseline: guid, ...baseline });
  }

  /** Closes the file. */
  close(): void {
    closeSync(this.#descriptor);
  }

  #append(record: Readonly<Record<string, string | number>>): void {
    appendRecord(this.#descriptor, record);
  }
}

/**
 * Creates a state file exclusively with mode 0600, never through a link
 * and never inside a Git working tree.
 *
 * @param path - Path of the state file.
 * @returns The descriptor, open for appending.
 * @throws {SpikeError} If the file exists or cannot be created safely.
 */
function createStateFile(path: string): number {
  if (isInsideGitWorkTree(path)) {
    throw new SpikeError('DATEI', 'schreibStateUnsicher');
  }
  try {
    return openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_APPEND |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    const exists = isObject(error) && error['code'] === 'EEXIST';
    throw new SpikeError(
      'DATEI',
      exists ? 'schreibStateVorhanden' : 'schreibStateUnsicher',
    );
  }
}

/**
 * Appends one record and syncs it to disk before the next request, so a
 * run that stops halfway still names what it created.
 *
 * @param descriptor - The open state file.
 * @param record - The record, one line of JSON.
 */
function appendRecord(
  descriptor: number,
  record: Readonly<Record<string, string | number>>,
): void {
  writeSync(descriptor, `${JSON.stringify(record)}\n`);
  fsyncSync(descriptor);
}

/**
 * Reads the records of a state file, one JSON value per line.
 *
 * @param path - Path of the state file.
 * @param invalid - The error for a damaged file.
 * @returns The records in order.
 * @throws {SpikeError} If the file is unsafe, missing or damaged.
 */
function readRecords(path: string, invalid: () => SpikeError): unknown[] {
  const content = readPrivateFile(
    path,
    maxWriteStateBytes,
    'schreibStateUnsicher',
    'schreibStateNichtGefunden',
  );
  const lines = content.split('\n');
  if (lines.at(-1) !== '') {
    throw invalid();
  }
  return lines.slice(0, -1).map((line): unknown => {
    try {
      return JSON.parse(line);
    } catch {
      throw invalid();
    }
  });
}

function invalid(): SpikeError {
  return new SpikeError('DATEI', 'schreibStateUngueltig');
}

/**
 * Reads the write state of a run of 05-wiki-write.
 *
 * @param path - Path of the write state file.
 * @param origin - Origin of the instance the probe talks to.
 * @param category - ID of the write area from the environment.
 * @returns The state.
 * @throws {SpikeError} If the file is unsafe, damaged, or belongs to another instance or write area.
 */
export function readWriteState(
  path: string,
  origin: string,
  category: number,
): WriteState {
  const [header, ...rest] = readRecords(path, invalid);
  if (
    !isObject(header) ||
    header['format'] !== format ||
    header['instance'] !== instanceId(origin) ||
    header['category'] !== category ||
    typeof header['run'] !== 'string' ||
    !/^[0-9a-f]{8}$/.test(header['run'])
  ) {
    throw invalid();
  }
  const pages = new Map<string, WriteStatePage>();
  for (const record of rest) {
    if (!isObject(record)) {
      throw invalid();
    }
    const page = record['page'];
    const baseline = record['baseline'];
    if (typeof page === 'string') {
      const role = record['role'];
      if (
        !guidPattern.test(page) ||
        pages.has(page) ||
        typeof role !== 'string' ||
        !roles.includes(role)
      ) {
        throw invalid();
      }
      pages.set(page, {
        guid: page,
        role: role as PageRole,
        baseline: undefined,
      });
    } else if (typeof baseline === 'string') {
      const known = pages.get(baseline);
      const version = record['version'];
      const textHash = record['textHash'];
      if (
        known === undefined ||
        typeof version !== 'number' ||
        !Number.isSafeInteger(version) ||
        version < 1 ||
        typeof textHash !== 'string' ||
        !/^[0-9a-f]{64}$/.test(textHash)
      ) {
        throw invalid();
      }
      pages.set(baseline, { ...known, baseline: { version, textHash } });
    } else {
      throw invalid();
    }
  }
  return {
    instance: header['instance'],
    category,
    run: header['run'],
    pages: [...pages.values()],
  };
}

const calendarFormat = 'ecclium-spike-calendar-state.v1';

/** What 11-calendar-write creates: an appointment or a booking. */
export type CalendarObject = 'termin' | 'buchung';

/** What a run of 11-calendar-write left behind, as read back. */
export interface CalendarState {
  /** Random tag of the run, part of every title. */
  readonly run: string;
  /** The day the run wrote on, `YYYY-MM-DD`. */
  readonly day: string;
  /** Appointments the run created and has not deleted. */
  readonly appointments: readonly number[];
  /** Bookings the run created and has not deleted. */
  readonly bookings: readonly number[];
}

/**
 * The write state of 11-calendar-write while it runs: every appointment
 * and booking the moment the instance confirms it, and every deletion the
 * moment the instance confirms that. A second run with the same file
 * removes what the first created and did not delete.
 */
export class CalendarStateFile {
  readonly #descriptor: number;

  /** Random tag of the run, part of every title. */
  readonly run: string;

  private constructor(descriptor: number, run: string) {
    this.#descriptor = descriptor;
    this.run = run;
  }

  /**
   * Creates the file with its header. It must not exist yet.
   *
   * @param path - Path of the write state file.
   * @param origin - Origin of the instance.
   * @param area - Calendar and resource of the probes.
   * @param day - The day the run writes on, `YYYY-MM-DD`.
   * @returns The open file.
   * @throws {SpikeError} If the file exists or cannot be created safely.
   */
  static create(
    path: string,
    origin: string,
    area: CalendarArea,
    day: string,
  ): CalendarStateFile {
    const file = new CalendarStateFile(
      createStateFile(path),
      randomBytes(4).toString('hex'),
    );
    appendRecord(file.#descriptor, {
      format: calendarFormat,
      instance: instanceId(origin),
      calendar: area.calendar,
      resource: area.resource,
      run: file.run,
      day,
    });
    return file;
  }

  /**
   * Opens the file of an earlier run to record further deletions.
   *
   * @param path - Path of the write state file, already read back.
   * @param run - Tag of that run.
   * @returns The open file.
   * @throws {SpikeError} If the file cannot be opened safely.
   */
  static reopen(path: string, run: string): CalendarStateFile {
    let descriptor: number;
    try {
      descriptor = openSync(
        path,
        constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
      );
    } catch {
      throw new SpikeError('DATEI', 'schreibStateUnsicher');
    }
    return new CalendarStateFile(descriptor, run);
  }

  /**
   * Records an appointment or booking the instance has just created.
   *
   * @param kind - Appointment or booking.
   * @param id - Its ID.
   * @throws {SpikeError} If the ID is no positive whole number.
   */
  created(kind: CalendarObject, id: number): void {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new SpikeError('INTERN');
    }
    appendRecord(this.#descriptor, { [kind]: id });
  }

  /**
   * Records that the instance has deleted an appointment or booking.
   *
   * @param kind - Appointment or booking.
   * @param id - Its ID.
   */
  deleted(kind: CalendarObject, id: number): void {
    appendRecord(this.#descriptor, { geloescht: kind, id });
  }

  /** Closes the file. */
  close(): void {
    closeSync(this.#descriptor);
  }
}

function calendarInvalid(): SpikeError {
  return new SpikeError('DATEI', 'kalenderStateUngueltig');
}

const isPositiveId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/**
 * Reads the write state of a run of 11-calendar-write.
 *
 * @param path - Path of the write state file.
 * @param origin - Origin of the instance the probe talks to.
 * @param area - Calendar and resource from the environment.
 * @returns The tag of the run and what it has not deleted.
 * @throws {SpikeError} If the file is unsafe, damaged, or belongs to another instance, calendar or resource.
 */
export function readCalendarState(
  path: string,
  origin: string,
  area: CalendarArea,
): CalendarState {
  const [header, ...rest] = readRecords(path, calendarInvalid);
  if (
    !isObject(header) ||
    header['format'] !== calendarFormat ||
    header['instance'] !== instanceId(origin) ||
    header['calendar'] !== area.calendar ||
    header['resource'] !== area.resource ||
    typeof header['run'] !== 'string' ||
    !/^[0-9a-f]{8}$/.test(header['run']) ||
    typeof header['day'] !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(header['day'])
  ) {
    throw calendarInvalid();
  }
  const open: Record<CalendarObject, Set<number>> = {
    termin: new Set(),
    buchung: new Set(),
  };
  for (const record of rest) {
    if (!isObject(record) || Object.keys(record).length === 0) {
      throw calendarInvalid();
    }
    const deleted = record['geloescht'];
    if (deleted === 'termin' || deleted === 'buchung') {
      const id = record['id'];
      if (
        Object.keys(record).length !== 2 ||
        !isPositiveId(id) ||
        !open[deleted].delete(id)
      ) {
        throw calendarInvalid();
      }
      continue;
    }
    const [[kind, id] = []] = Object.entries(record);
    if (
      Object.keys(record).length !== 1 ||
      (kind !== 'termin' && kind !== 'buchung') ||
      !isPositiveId(id) ||
      open[kind].has(id)
    ) {
      throw calendarInvalid();
    }
    open[kind].add(id);
  }
  return {
    run: header['run'],
    day: header['day'],
    appointments: [...open.termin],
    bookings: [...open.buchung],
  };
}
