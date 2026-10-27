/**
 * The guard of the seed account (ADR 0049, ADR 0061).
 *
 * The seed of the test instance writes persons, groups, appointments,
 * events, bookings, songs and pages of the wiki, and the structure they
 * live in. Before its first request it passes the checks of the guard of
 * the test environment, extended for its own account:
 *
 * From the environment alone:
 * - the switch `ECCLIUM_SEED_ALLOW_WRITE` equals the first label of the
 *   host, and the base URL is not the placeholder of the README;
 * - no other token variable is set, the token comes only from
 *   `ECCLIUM_SEED_TOKEN_FILE`;
 * - the IDs of department, group status and campus are positive whole
 *   numbers. The API cannot create departments or group statuses.
 *
 * Then, by reading:
 * - the instance documents every operation of the seed and every fixed
 *   query parameter it sends, such as `sendMail` when deleting an event;
 * - exactly one category the account can see has the fixed name of the
 *   identification category, and the account can neither edit nor delete
 *   it. Besides it, the account sees at most the category of the seed;
 * - the global rights hold only names from {@link seedRights}. In the wiki
 *   the account sees the wiki, sees at most the two categories and edits
 *   at most the one of the seed. It may see persons only in the department
 *   from the environment. Every other right is false or empty.
 *
 * Last, for every command that writes, a person at a terminal confirms
 * with «ja». Only then does the guard hand out the client that writes.
 *
 * In the modules other than the wiki the account holds its rights on
 * «Alle», because the seed creates the calendar, resource, service group
 * and song category it then writes in. The guard can therefore check only
 * the names of these rights, not single IDs. What the seed touches there,
 * it finds by the marker in the structure it made itself.
 *
 * @packageDocumentation
 */
import { readToken, type Environment } from './env.mts';
import { SpikeError, type HintKey } from './errors.mts';
import {
  checkSwitch,
  findIdentification,
  isId,
  readCategories,
  type Category,
  type Input,
} from './gate.mts';
import {
  createGateClient,
  createPersonsClient,
  createSeedClient,
  type Client,
  type ClientOptions,
  type SeedClient,
} from './http.mts';
import {
  operations,
  seedOperations,
  type OperationName,
  type SeedOperationName,
} from './operations.mts';
import type { ReadRights } from './persons-gate.mts';
import {
  Schemas,
  findOperation,
  isObject,
  type Method,
  type OpenApiDocument,
} from './spec.mts';

/** The fixed name of the wiki category the seed creates and writes in. */
export const seedWikiCategoryName = 'Seedprobe';

/**
 * The rights the seed account may hold outside the wiki, by module, with
 * any value. Names as `GET /api/permissions/global` reports them on
 * ChurchTools 3.138: `churchdb` repeats the rights on groups, together with
 * `edit group memberships`, which ChurchTools derives from them.
 */
export const seedRights = {
  churchdb: [
    'view',
    'view alldata',
    'create person',
    'write access',
    'edit masterdata',
    'create groups of grouptype',
    'view groups of grouptype',
    'edit group memberships of grouptype',
    'edit group memberships',
  ],
  churchgroup: [
    'view',
    'create groups of grouptype',
    'view groups of grouptype',
    'edit group memberships of grouptype',
    'edit masterdata',
  ],
  churchcal: [
    'view',
    'view category',
    'edit category',
    'admin church category',
  ],
  churchresource: [
    'view',
    'view resource',
    'create bookings',
    'administer bookings',
    'edit masterdata',
  ],
  churchservice: [
    'view',
    'view servicegroup',
    'edit servicegroup',
    'view events',
    'edit events',
    'view agenda',
    'edit agenda',
    'view songcategory',
    'edit songcategory',
    'edit masterdata',
  ],
} as const satisfies ReadRights;

/** The variables that hold a token for another account. */
const foreignTokenVariables = [
  'ECCLIUM_SPIKE_TOKEN_FILE',
  'ECCLIUM_SPIKE_WRITE_TOKEN_FILE',
  'ECCLIUM_CHURCHTOOLS_TOKEN_FILE',
  'ECCLIUM_CHURCHTOOLS_TOKEN',
] as const;

/** The variables the seed reads. Their values go onto the block list. */
export const seedVariables = [
  'ECCLIUM_SEED_BASE_URL',
  'ECCLIUM_SEED_TOKEN_FILE',
  'ECCLIUM_SEED_ALLOW_WRITE',
  'ECCLIUM_SEED_DEPARTMENT_ID',
  'ECCLIUM_SEED_GROUP_STATUS_ID',
  'ECCLIUM_SEED_CAMPUS_ID',
] as const;

/** What the seed reads from the environment besides address and token. */
export interface SeedSettings {
  /** The department the persons of the seed belong to. */
  readonly departmentId: number;
  /** The status the groups of the seed get. */
  readonly groupStatusId: number;
  /** The campus of the persons and groups of the seed. */
  readonly campusId: number;
}

function readId(env: Environment, name: string, hint: HintKey): number {
  const raw = env[name] ?? '';
  if (!/^[1-9]\d{0,9}$/.test(raw)) {
    throw new SpikeError('KONFIGURATION', hint);
  }
  return Number(raw);
}

/**
 * Checks the environment of the seed, before any request.
 *
 * @param env - Environment of the process.
 * @param origin - Origin from the base URL.
 * @returns Department, group status and campus.
 * @throws {SpikeError} If the base URL is the placeholder, the switch is missing or does not fit the host, another token variable is set, or an ID is missing or invalid.
 */
export function checkSeedEnvironment(
  env: Environment,
  origin: string,
): SeedSettings {
  checkSwitch(env, origin, {
    variable: 'ECCLIUM_SEED_ALLOW_WRITE',
    missing: 'seedSchalterFehlt',
    wrong: 'seedSchalterFalsch',
  });
  if (foreignTokenVariables.some((name) => (env[name] ?? '') !== '')) {
    throw new SpikeError('KONFIGURATION', 'seedFremdeTokenVariable');
  }
  return {
    departmentId: readId(env, 'ECCLIUM_SEED_DEPARTMENT_ID', 'seedBereichFehlt'),
    groupStatusId: readId(
      env,
      'ECCLIUM_SEED_GROUP_STATUS_ID',
      'seedGruppenstatusFehlt',
    ),
    campusId: readId(env, 'ECCLIUM_SEED_CAMPUS_ID', 'seedStandortFehlt'),
  };
}

/**
 * Reads the token of the seed account, from its own variable only.
 *
 * @param env - Environment of the process.
 * @returns The token.
 * @throws {SpikeError} If the file is missing, unsafe or no single line of printable ASCII.
 */
export function readSeedToken(env: Environment): string {
  return readToken(env, 'ECCLIUM_SEED_TOKEN_FILE');
}

/** What the course of the seed hands its guard. */
export interface SeedAccess {
  readonly kind: 'Seed-Konto';
}

const secrets = new WeakMap<
  SeedAccess,
  { readonly options: ClientOptions; readonly input: Input }
>();

/**
 * Wraps what the clients of the seed need, so that only
 * {@link passSeedGate} can open it.
 *
 * @param options - Origin, token, guard and fetch of the run.
 * @param input - Where the confirmation comes from.
 * @returns An opaque handle.
 */
export function createSeedAccess(
  options: ClientOptions,
  input: Input,
): SeedAccess {
  const access: SeedAccess = Object.freeze({ kind: 'Seed-Konto' });
  secrets.set(access, { options, input });
  return access;
}

function refuse(hint: HintKey): SpikeError {
  return new SpikeError('KONFIGURATION', hint);
}

/** The operations the guard reads with, before it hands out any client. */
const gateReads = ['wikiCategories', 'permissionsGlobal', 'whoami'] as const;

/**
 * The lists of the probes the seed reads to find its objects, with the
 * query parameters it sends there. The guard checks that the instance
 * declares each of them, so no filter is silently ignored.
 */
export const seedReadParameters = {
  calendars: [],
  resourceTypes: [],
  resources: [],
  serviceGroups: [],
  services: [],
  wikiCategoryPages: [],
  persons: ['lastName', 'limit', 'page'],
  groups: ['query', 'group_type_ids[]', 'limit', 'page'],
  groupMembers: ['limit', 'page'],
  events: ['from', 'to', 'limit', 'page'],
  bookings: ['resource_ids[]', 'from', 'to'],
  songs: ['song_category_ids[]', 'limit', 'page'],
} as const satisfies Partial<Record<OperationName, readonly string[]>>;

/** The query parameters of the lists of the seed beyond the probes. */
export const seedOwnReadParameters = {
  statuses: [],
  groupTypes: [],
  songCategories: [],
  calendarAppointmentList: ['from', 'to'],
} as const satisfies Partial<Record<SeedOperationName, readonly string[]>>;

/**
 * Tells whether a value is a list of IDs, each from `allowed`, without
 * repeats.
 *
 * @param value - Any value.
 * @param allowed - The IDs the list may hold.
 * @returns Whether the value is such a list. An empty list is one.
 */
function idsWithin(value: unknown, allowed: readonly number[]): boolean {
  return (
    Array.isArray(value) &&
    value.every((id) => isId(id) && allowed.includes(id)) &&
    new Set(value).size === value.length
  );
}

/**
 * Tells whether the global rights stay inside what the seed account may
 * hold.
 *
 * In `churchwiki`: `view` true, `view category` the identification category
 * and at most the category of the seed, `edit category` at most the
 * category of the seed, `edit masterdata` any value, to create that
 * category. In `churchdb`, `view alldata` only the department of the seed.
 * Every other right of {@link seedRights} any value. Every other right of
 * every module false or an empty list.
 *
 * @param data - `data` of `GET /api/permissions/global`.
 * @param identification - ID of the identification category.
 * @param seedCategory - ID of the category of the seed, if the account sees it.
 * @param departmentId - The department of the seed.
 * @returns Whether the rights are narrow enough.
 */
export function seedRightsWithin(
  data: unknown,
  identification: number,
  seedCategory: number | undefined,
  departmentId: number,
): boolean {
  if (!isObject(data)) {
    return false;
  }
  const own = seedCategory === undefined ? [] : [seedCategory];
  const wiki = data['churchwiki'];
  const viewCategory = isObject(wiki) ? wiki['view category'] : undefined;
  if (
    !isObject(wiki) ||
    wiki['view'] !== true ||
    !idsWithin(viewCategory, [identification, ...own]) ||
    !(viewCategory as readonly number[]).includes(identification) ||
    !idsWithin(wiki['edit category'] ?? [], own)
  ) {
    return false;
  }
  const people = data['churchdb'];
  if (
    isObject(people) &&
    !idsWithin(people['view alldata'] ?? [], [departmentId])
  ) {
    return false;
  }
  for (const [module, rights] of Object.entries(data)) {
    if (!isObject(rights)) {
      return false;
    }
    // Only own entries count, so a module named like a property of every
    // object finds nothing.
    const allowed: readonly string[] =
      module === 'churchwiki'
        ? ['view', 'view category', 'edit category', 'edit masterdata']
        : Object.hasOwn(seedRights, module)
          ? seedRights[module as keyof typeof seedRights]
          : [];
    for (const [name, value] of Object.entries(rights)) {
      if (allowed.includes(name)) {
        continue;
      }
      if (value !== false && !(Array.isArray(value) && value.length === 0)) {
        return false;
      }
    }
  }
  return true;
}

/** What the guard needs besides the handle. */
export interface SeedGateContext {
  /** The OpenAPI document of the instance, as the seed fetched it. */
  readonly document: OpenApiDocument;
  readonly settings: SeedSettings;
}

/** What the command asks of the guard. */
export interface SeedGateOptions {
  /** Whether the command writes. Then a person must confirm with «ja». */
  readonly write: boolean;
  /** Fixed text shown before the question. */
  readonly summary: string;
}

/** What the seed gets once the guard lets it pass. */
export interface SeedPass {
  /** ID of the identification category. */
  readonly identification: number;
  /** The category of the seed, if the account sees it. */
  readonly seedCategory: Category | undefined;
  /** ID of the seed account itself, so it can keep out of its groups. */
  readonly accountId: number;
  /** The client that reads, also persons, groups, events and songs. */
  readonly client: Client;
  /** The client that writes, only for a command that writes. */
  readonly writer: SeedClient | undefined;
}

/**
 * Checks that the instance documents every operation of the seed and every
 * query parameter it sends, the fixed ones of the writes and those of the
 * lists it reads.
 *
 * @param document - The OpenAPI document of the instance.
 * @returns Whether everything is documented.
 */
export function seedOperationsDocumented(document: OpenApiDocument): boolean {
  const schemas = new Schemas(document);
  const entries: {
    readonly method: Method;
    readonly template: string;
    readonly query: readonly string[];
  }[] = [
    ...gateReads.map((name) => ({ ...operations[name], query: [] })),
    ...Object.entries(seedReadParameters).map(([name, query]) => ({
      ...operations[name as keyof typeof seedReadParameters],
      query,
    })),
    ...Object.entries(seedOperations).map(([name, entry]) => {
      const fixed: readonly (readonly [string, string])[] =
        'query' in entry ? entry.query : [];
      const own: readonly string[] = Object.hasOwn(seedOwnReadParameters, name)
        ? seedOwnReadParameters[name as keyof typeof seedOwnReadParameters]
        : [];
      return {
        method: entry.method,
        template: entry.template,
        query: [...fixed.map(([parameter]) => parameter), ...own],
      };
    }),
  ];
  return entries.every((entry) => {
    const operation = findOperation(document, entry.method, entry.template);
    if (operation === undefined) {
      return false;
    }
    const declared = schemas.queryParameters(operation);
    return entry.query.every((name) => declared.has(name));
  });
}

/**
 * Runs every check, asks for the confirmation if the command writes, and
 * only then hands out the clients of the seed.
 *
 * @param context - The OpenAPI document and the settings of the run.
 * @param access - The handle from the course of the seed.
 * @param options - Whether the command writes, and the summary for the question.
 * @returns The IDs the checks found and the clients.
 * @throws {SpikeError} If one check fails, stdin is no terminal for a command that writes, or the answer is not exactly «ja».
 */
export async function passSeedGate(
  context: SeedGateContext,
  access: SeedAccess,
  options: SeedGateOptions,
): Promise<SeedPass> {
  const secret = secrets.get(access);
  if (secret === undefined) {
    throw new SpikeError('INTERN');
  }
  if (options.write && !secret.input.isTerminal) {
    throw refuse('keinTerminal');
  }
  if (!seedOperationsDocumented(context.document)) {
    throw refuse('seedOperationFehlt');
  }

  const reads = createGateClient(
    secret.options,
    gateReads.map((name) => operations[name].template),
  );
  const { categories } = readCategories(
    await reads.get({ path: operations.wikiCategories.template }),
    'seedWaechterAntwortUnerwartet',
  );
  const identification = findIdentification(categories, {
    missing: 'kennkategorieFehlt',
    multiple: 'kennkategorieMehrfach',
    editable: 'kennkategorieBearbeitbar',
  });
  const others = categories.filter(
    (category) => category.id !== identification.id,
  );
  const [seedCategory] = others;
  if (
    others.length > 1 ||
    (seedCategory !== undefined && seedCategory.name !== seedWikiCategoryName)
  ) {
    throw refuse('seedWeitereKategorien');
  }

  const whoami = await reads.get({
    path: operations.whoami.template,
    query: [['only_allow_authenticated', 'true']],
  });
  const me = isObject(whoami.body) ? whoami.body['data'] : undefined;
  const accountId = isObject(me) ? me['id'] : undefined;
  if (whoami.status !== 200 || !isId(accountId)) {
    throw refuse('seedWaechterAntwortUnerwartet');
  }

  const rights = await reads.get({
    path: operations.permissionsGlobal.template,
  });
  const data = isObject(rights.body) ? rights.body['data'] : undefined;
  if (rights.status !== 200 || rights.kind !== 'JSON' || !isObject(data)) {
    throw refuse('seedWaechterAntwortUnerwartet');
  }
  if (
    !seedRightsWithin(
      data,
      identification.id,
      seedCategory?.id,
      context.settings.departmentId,
    )
  ) {
    throw refuse('seedZuWeitBerechtigt');
  }

  if (options.write) {
    const answer = await secret.input.readLine(
      `${options.summary}\nAlle Prüfungen des Wächters sind bestanden. Vergleichen Sie die SHA-256 oben mit dem Pull Request.\nWeiter? Tippen Sie «ja»: `,
    );
    if (answer !== 'ja') {
      throw refuse('nichtBestaetigt');
    }
  }
  return {
    identification: identification.id,
    seedCategory,
    accountId,
    client: createPersonsClient(secret.options),
    writer: options.write ? createSeedClient(secret.options) : undefined,
  };
}
