/**
 * The guard for personal data (ADR 0049).
 *
 * The probe that reads persons, groups and search passes through here
 * before its first request with personal data. Persons and groups are data
 * of special categories, so this probe runs only on the test instance with
 * synthetic data. Whatever the guard cannot check, it treats as a reason
 * to stop: an operation the instance does not document, an answer of
 * another form, a right it does not know. The instance then counts as
 * productive, and no personal data is read.
 *
 * Before any request, from the environment alone:
 * - the base URL is not the placeholder of the README;
 * - the switch `ECCLIUM_SPIKE_ALLOW_PERSONS` equals the first label of the
 *   host, so a mistyped base URL stops the run;
 * - the IDs of the synthetic person and of the two synthetic groups are
 *   set and are IDs, and the two groups differ.
 *
 * Then, by reading the two operations the guard needs and nothing else:
 * - the account sees exactly one category, the identification category,
 *   and can neither edit nor delete it, nor edit master data;
 * - in the wiki the account may exactly see the wiki and the
 *   identification category;
 * - in the modules of persons and groups only the read rights of
 *   {@link personReadRights} may be set, with any value, since the probe
 *   asks how they look; every other right of every module is `false` or an
 *   empty list.
 *
 * Until then the probe holds a client for these two reads only. The client
 * that reaches persons, groups and search exists nowhere else: the token
 * reaches it only through the opaque {@link PersonsAccess} the common
 * course of a probe creates, and only {@link passPersonsGate} opens it.
 *
 * @packageDocumentation
 */
import { readObjectId, type Environment, type SpikeState } from './env.mts';
import { SpikeError, type HintKey } from './errors.mts';
import {
  checkSwitch,
  findIdentification,
  readCategories,
  sameIds,
} from './gate.mts';
import {
  createPersonsClient,
  type Client,
  type ClientOptions,
} from './http.mts';
import { operations, type OperationName } from './operations.mts';
import { findOperation, isObject, type JsonObject } from './spec.mts';

/**
 * The read rights on persons and groups the account may hold, by module.
 * They are words of the product, as the rights response of ChurchTools
 * names them (docs/research/churchtools-api.md).
 */
export const personReadRights = {
  churchdb: [
    'view',
    'view alldata',
    'view persons from campus',
    'security level person',
    'view group',
    'view groups of grouptype',
    'security level group',
    'view memberliste',
  ],
  churchgroup: [
    'view',
    'view group',
    'view groups of grouptype',
    'security level group',
  ],
} as const;

/** The operations the guard reads with before it lets the probe read persons. */
export const personsGateOperations: readonly OperationName[] = [
  'wikiCategories',
  'permissionsGlobal',
];

/** What the guard reads from the environment. */
export interface PersonsSettings {
  /** ID of the synthetic person the probe may fetch on its own. */
  readonly personId: number;
  /** ID of the synthetic group of the first group type. */
  readonly groupId: number;
  /** ID of the synthetic group of the second group type. */
  readonly otherGroupId: number;
}

/**
 * Checks the environment of the probe that reads persons, before any
 * request.
 *
 * @param env - Environment of the process.
 * @param origin - Origin from the base URL.
 * @returns The IDs of the synthetic person and groups.
 * @throws {SpikeError} If the base URL is the placeholder, the switch is missing or does not fit the host, or an ID is missing, invalid or the same for both groups.
 */
export function checkPersonsEnvironment(
  env: Environment,
  origin: string,
): PersonsSettings {
  checkSwitch(env, origin, {
    variable: 'ECCLIUM_SPIKE_ALLOW_PERSONS',
    missing: 'personenSchalterFehlt',
    wrong: 'personenSchalterFalsch',
  });
  const personId = readObjectId(env, 'ECCLIUM_SPIKE_PERSON_ID');
  const groupId = readObjectId(env, 'ECCLIUM_SPIKE_GROUP_ID');
  const otherGroupId = readObjectId(env, 'ECCLIUM_SPIKE_OTHER_GROUP_ID');
  if (groupId === otherGroupId) {
    throw new SpikeError('KONFIGURATION', 'gruppenGleich');
  }
  return { personId, groupId, otherGroupId };
}

/** What the common course hands the probe that reads persons. */
export interface PersonsAccess {
  readonly kind: 'Personendaten';
}

const secrets = new WeakMap<PersonsAccess, ClientOptions>();

/**
 * Wraps what the client for personal data needs, so that only
 * {@link passPersonsGate} can open it. The common course of a probe calls
 * this; a probe cannot reach the token inside.
 *
 * @param options - Origin, token, guard and fetch of the run.
 * @returns An opaque handle.
 */
export function createPersonsAccess(options: ClientOptions): PersonsAccess {
  const access: PersonsAccess = Object.freeze({ kind: 'Personendaten' });
  secrets.set(access, options);
  return access;
}

function refuse(hint: HintKey): SpikeError {
  return new SpikeError('KONFIGURATION', hint);
}

/**
 * Tells whether the global rights stay inside what the probe that reads
 * persons may hold.
 *
 * Allowed in `churchwiki` are exactly `view` true and `view category` the
 * identification category. In `churchdb` and `churchgroup` the rights of
 * {@link personReadRights} may hold any value. Every other right of every
 * module, `edit masterdata` included, must be `false` or an empty list.
 *
 * @param data - `data` of `GET /api/permissions/global`.
 * @param identification - ID of the identification category.
 * @returns Whether the rights are narrow enough.
 */
export function personsRightsWithin(
  data: unknown,
  identification: number,
): boolean {
  if (!isObject(data)) {
    return false;
  }
  const wiki = data['churchwiki'];
  if (
    !isObject(wiki) ||
    wiki['view'] !== true ||
    !sameIds(wiki['view category'], [identification])
  ) {
    return false;
  }
  for (const [module, rights] of Object.entries(data)) {
    if (!isObject(rights)) {
      return false;
    }
    const readable: readonly string[] =
      module === 'churchdb' || module === 'churchgroup'
        ? personReadRights[module]
        : [];
    for (const [name, value] of Object.entries(rights)) {
      if (
        readable.includes(name) ||
        (module === 'churchwiki' &&
          (name === 'view' || name === 'view category'))
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

/** What the probe needs for the checks by reading. */
export interface PersonsGateContext {
  /** The client for the two reads of the guard. */
  readonly client: Client;
  readonly state: SpikeState;
}

/** What the probe gets once the guard lets it read persons. */
export interface PersonsPass {
  /** `data` of the rights response the guard checked. */
  readonly rights: JsonObject;
  /** ID of the identification category. */
  readonly identification: number;
  /** The client that also reaches persons, groups and search. */
  readonly client: Client;
}

/**
 * Runs every check and only then hands out the client for personal data.
 *
 * @param context - The client for the reads of the guard and the state of 00-inventory.
 * @param access - The handle from the common course of the probe.
 * @returns The checked rights and the client for personal data.
 * @throws {SpikeError} If one check fails; then no personal data may be read.
 */
export async function passPersonsGate(
  context: PersonsGateContext,
  access: PersonsAccess,
): Promise<PersonsPass> {
  const options = secrets.get(access);
  if (options === undefined) {
    throw new SpikeError('INTERN');
  }
  const document = context.state.specification;
  for (const name of personsGateOperations) {
    const { method, template } = operations[name];
    if (findOperation(document, method, template) === undefined) {
      throw refuse('personenWaechterOperationFehlt');
    }
  }

  const { categories, editMasterData } = readCategories(
    await context.client.get({ path: operations.wikiCategories.template }),
    'personenWaechterAntwortUnerwartet',
  );
  const identification = findIdentification(categories, {
    missing: 'personenKennkategorieFehlt',
    multiple: 'personenKennkategorieMehrfach',
    editable: 'personenKennkategorieBearbeitbar',
  });
  if (categories.length !== 1) {
    throw refuse('personenWeitereKategorien');
  }
  if (editMasterData) {
    throw refuse('personenZuWeitBerechtigt');
  }

  const rights = await context.client.get({
    path: operations.permissionsGlobal.template,
  });
  const data = isObject(rights.body) ? rights.body['data'] : undefined;
  if (rights.status !== 200 || rights.kind !== 'JSON' || !isObject(data)) {
    throw refuse('personenWaechterAntwortUnerwartet');
  }
  if (!personsRightsWithin(data, identification.id)) {
    throw refuse('personenZuWeitBerechtigt');
  }
  return {
    rights: data,
    identification: identification.id,
    client: createPersonsClient(options),
  };
}
