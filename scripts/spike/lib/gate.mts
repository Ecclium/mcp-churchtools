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
 *   variable of the read account is not set at the same time.
 *
 * Then, by reading:
 * - exactly one category the account can see has the fixed name of the
 *   identification category, and the account can neither edit nor delete
 *   it;
 * - the write area from the environment is a different category, visible
 *   and editable, and the account sees no third category;
 * - the global rights allow exactly this: see the wiki, see the write area
 *   and the identification category, edit the write area;
 * - the write area holds only its automatic page and the pages of the
 *   current run.
 *
 * Last, a person at a terminal confirms with «ja». Only then does the guard
 * hand out the client that writes. That client exists nowhere else: the
 * token reaches it only through the opaque {@link WriteAccess} the common
 * course of a probe creates.
 *
 * @packageDocumentation
 */
import { readCategoryId, type Environment, type SpikeState } from './env.mts';
import { SpikeError, type HintKey } from './errors.mts';
import {
  createWriteClient,
  guidPattern,
  pathFor,
  type Client,
  type ClientOptions,
  type ProbeResponse,
  type WriteClient,
  type WriteOperation,
} from './http.mts';
import { operations, type OperationName } from './operations.mts';
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
const placeholderHost = 'example.church.tools';

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
}

/**
 * Checks the environment of a probe of the write account, before any
 * request.
 *
 * @param env - Environment of the process.
 * @param origin - Origin from the base URL.
 * @returns The write area and the path of the write state file.
 * @throws {SpikeError} If the switch is missing or does not fit the host, the base URL is the placeholder, the variable of the read account is set, or a variable of the write account is missing.
 */
export function checkWriteEnvironment(
  env: Environment,
  origin: string,
): WriteSettings {
  const host = new URL(origin).hostname;
  if (host === placeholderHost) {
    throw new SpikeError('KONFIGURATION', 'platzhalterHost');
  }
  const switchValue = env['ECCLIUM_SPIKE_ALLOW_WRITE'] ?? '';
  if (switchValue === '') {
    throw new SpikeError('KONFIGURATION', 'schalterFehlt');
  }
  const [label] = host.split('.');
  if (label === undefined || switchValue.toLowerCase() !== label) {
    throw new SpikeError('KONFIGURATION', 'schalterFalsch');
  }
  if ((env['ECCLIUM_SPIKE_TOKEN_FILE'] ?? '') !== '') {
    throw new SpikeError('KONFIGURATION', 'zweiTokenVariablen');
  }
  return {
    writeCategory:
      readCategoryId(env, 'ECCLIUM_SPIKE_WRITE_CATEGORY_ID', true) ?? 0,
    writeStatePath: writeStatePath(env),
  };
}

function refuse(hint: HintKey): SpikeError {
  return new SpikeError('KONFIGURATION', hint);
}

function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function sameIds(value: unknown, expected: readonly number[]): boolean {
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
 * area. Every other right of every module, `edit masterdata` included, must
 * be `false` or an empty list. Anything else, a right of another type
 * included, is too much.
 *
 * @param data - `data` of `GET /api/permissions/global`.
 * @param writeCategory - ID of the write area.
 * @param identification - ID of the identification category.
 * @returns Whether the rights are narrow enough.
 */
export function rightsWithin(
  data: unknown,
  writeCategory: number,
  identification: number,
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
  for (const [module, rights] of Object.entries(data)) {
    if (!isObject(rights)) {
      return false;
    }
    for (const [name, value] of Object.entries(rights)) {
      if (
        module === 'churchwiki' &&
        ['view', 'view category', 'edit category'].includes(name)
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

interface Category {
  readonly id: number;
  readonly name: string;
  readonly canEdit: boolean;
  readonly canDelete: boolean;
}

function dataList(response: ProbeResponse): readonly unknown[] {
  const data = isObject(response.body) ? response.body['data'] : undefined;
  if (
    response.status !== 200 ||
    response.kind !== 'JSON' ||
    !Array.isArray(data)
  ) {
    throw refuse('waechterAntwortUnerwartet');
  }
  return data;
}

function readCategories(response: ProbeResponse): {
  readonly categories: readonly Category[];
  readonly editMasterData: boolean;
} {
  const entries = dataList(response);
  const body = response.body as JsonObject;
  const permissions = body['permissions'];
  const editMasterData = isObject(permissions)
    ? permissions['editMasterData']
    : undefined;
  if (typeof editMasterData !== 'boolean') {
    throw refuse('waechterAntwortUnerwartet');
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
      throw refuse('waechterAntwortUnerwartet');
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

/** A page of the write area, as the guard saw it. */
export interface PageEntry {
  readonly guid: string;
  readonly title: string;
}

function readPages(response: ProbeResponse): readonly PageEntry[] {
  const entries = dataList(response);
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
  const document = context.state.specification;
  const needed: readonly OperationName[] = [
    'wikiCategories',
    'permissionsGlobal',
    'wikiCategoryPages',
    ...options.writes,
  ];
  for (const name of needed) {
    const { method, template } = operations[name];
    if (findOperation(document, method, template) === undefined) {
      throw refuse('waechterOperationFehlt');
    }
  }

  const { categories, editMasterData } = readCategories(
    await context.client.get({ path: operations.wikiCategories.template }),
  );
  const named = categories.filter(
    (category) => category.name === identificationCategoryName,
  );
  const [identification] = named;
  if (identification === undefined) {
    throw refuse('kennkategorieFehlt');
  }
  if (named.length > 1) {
    throw refuse('kennkategorieMehrfach');
  }
  if (identification.canEdit || identification.canDelete) {
    throw refuse('kennkategorieBearbeitbar');
  }
  const { writeCategory } = settings;
  if (writeCategory === identification.id) {
    throw refuse('schreibKategorieIstKennung');
  }
  const area = categories.find((category) => category.id === writeCategory);
  if (area === undefined) {
    throw refuse('schreibKategorieNichtSichtbar');
  }
  if (!area.canEdit) {
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
  if (!rightsWithin(data, writeCategory, identification.id)) {
    throw refuse('zuWeitBerechtigt');
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
}

/**
 * Runs every check, asks for the confirmation, and only then hands out the
 * client that writes.
 *
 * @param context - The client that reads and the state of 00-inventory.
 * @param access - The handle from the common course of the probe.
 * @param settings - What the environment named.
 * @param options - Write operations and own pages of the probe, and the summary shown before the question.
 * @returns The result of the checks and the write client.
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
  const answer = await secret.input.readLine(
    `${options.summary}\nAlle Prüfungen des Wächters sind bestanden. Vergleichen Sie die SHA-256 oben mit dem Pull Request.\nWeiter? Tippen Sie «ja»: `,
  );
  if (answer !== 'ja') {
    throw refuse('nichtBestaetigt');
  }
  return { result, writer: createWriteClient(secret.options) };
}
