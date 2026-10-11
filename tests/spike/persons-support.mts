// A synthetic instance for the guard for personal data and the probe that
// reads persons. It answers the two reads of the guard and, behind them,
// the operations on persons, groups and search, with canary values in
// every answer. Everything is made up at run time (see
// tests/fixtures/README.md); no real answer is copied.
import { randomInt } from 'node:crypto';

import { instanceId, type SpikeState } from '../../scripts/spike/lib/env.mts';
import { identificationCategoryName } from '../../scripts/spike/lib/gate.mts';
import type { FetchFunction } from '../../scripts/spike/lib/http.mts';
import { asOpenApi } from '../../scripts/spike/lib/spec.mts';
import {
  forbiddenTexts,
  makeCanaries,
  privateFiles,
  specification,
  type Canaries,
} from './support.mts';
import { writeOrigin, writeSwitch } from './write-support.mts';

/**
 * The instance of these tests. The README placeholder under church.tools
 * is refused by the guard, so they use a reserved top-level domain, like
 * the tests of the write account.
 */
export const personsOrigin = writeOrigin;

/** The switch that fits {@link personsOrigin}. */
export const personsSwitch = writeSwitch;

/** Everything one test of the guard for personal data needs. */
export interface PersonsSetting {
  readonly canaries: Canaries;
  readonly identification: number;
  readonly personId: number;
  readonly groupId: number;
  readonly otherGroupId: number;
  readonly folder: string;
  readonly tokenFile: string;
  readonly stateFile: string;
  /** Environment of the probe that reads persons. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly forbidden: readonly string[];
}

/**
 * Makes the files and environment of one test.
 *
 * The IDs lie between 10 000 and 50 000, so that none of them is part of
 * a count class such as «100–999» in an output.
 *
 * @returns A fresh setting with random IDs and canaries.
 */
export function personsSetup(): PersonsSetting {
  const canaries = makeCanaries();
  const identification = randomInt(10_000, 20_000);
  const personId = randomInt(20_000, 30_000);
  const groupId = randomInt(30_000, 40_000);
  const otherGroupId = randomInt(40_000, 50_000);
  const files = privateFiles(canaries.token);
  return {
    canaries,
    identification,
    personId,
    groupId,
    otherGroupId,
    folder: files.folder,
    tokenFile: files.tokenFile,
    stateFile: files.stateFile,
    env: {
      ECCLIUM_SPIKE_BASE_URL: personsOrigin,
      ECCLIUM_SPIKE_ALLOW_PERSONS: personsSwitch,
      ECCLIUM_SPIKE_TOKEN_FILE: files.tokenFile,
      ECCLIUM_SPIKE_STATE_FILE: files.stateFile,
      ECCLIUM_SPIKE_PERSON_ID: String(personId),
      ECCLIUM_SPIKE_GROUP_ID: String(groupId),
      ECCLIUM_SPIKE_OTHER_GROUP_ID: String(otherGroupId),
    },
    forbidden: forbiddenTexts(
      canaries,
      files.folder,
      String(identification),
      String(personId),
      String(groupId),
      String(otherGroupId),
      'demo-tenant.example',
      personsSwitch,
    ),
  };
}

/**
 * The state 00-inventory would write for the synthetic instance.
 *
 * @param document - The OpenAPI document, by default the synthetic one.
 * @returns A state for {@link personsOrigin}.
 */
export function personsState(document: unknown = specification): SpikeState {
  const parsed = asOpenApi(document);
  if (parsed === undefined) {
    throw new Error('synthetic document is not accepted');
  }
  return {
    format: 'ecclium-spike-state.v1',
    instance: instanceId(personsOrigin),
    version: '3.137',
    specification: parsed,
  };
}

/**
 * The narrow rights the guard accepts: the wiki and the identification
 * category, and the read rights on persons and groups set to `values`.
 *
 * @param identification - ID of the identification category.
 * @param values - Values of read rights on persons and groups, by name.
 * @returns `data` of a rights response.
 */
export function narrowRights(
  identification: number,
  values: Readonly<Record<string, unknown>> = {},
): Record<string, Record<string, unknown>> {
  return {
    churchwiki: {
      view: true,
      'view category': [identification],
      'edit category': [],
      'edit masterdata': false,
    },
    churchdb: {
      view: false,
      'view alldata': [],
      'security level person': [],
      'view hidden persons': false,
      'view archive': false,
      ...values,
    },
    churchgroup: { view: false, 'view groups of grouptype': [] },
    churchcal: { view: false },
  };
}

/** One request the synthetic instance received. */
export interface PersonsCall {
  readonly method: string;
  readonly url: URL;
  readonly authorization: string | null;
}

/** How the synthetic instance behaves. */
export interface PersonsInstanceOptions {
  /** Body of `GET /api/wiki/categories`, instead of the identification category alone. */
  readonly categories?: unknown;
  /** `data` of `GET /api/permissions/global`, instead of {@link narrowRights}. */
  readonly rights?: unknown;
  /** Status of `GET /api/permissions/global`. Default 200. */
  readonly rightsStatus?: number;
  /** The OpenAPI document. */
  readonly document?: unknown;
}

/** A synthetic instance: fetch and the requests it received. */
export interface PersonsInstance {
  readonly fetch: FetchFunction;
  readonly calls: PersonsCall[];
}

/**
 * Creates the synthetic instance for one setting.
 *
 * @param setting - The setting of the test.
 * @param options - How the instance behaves.
 * @returns The instance.
 */
export function personsInstance(
  setting: PersonsSetting,
  options: PersonsInstanceOptions = {},
): PersonsInstance {
  const { canaries, identification } = setting;
  const calls: PersonsCall[] = [];
  const answer = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        'content-type': 'application/json',
        'x-kanarie': canaries.headerValue,
      },
    });
  const respond = (url: URL): Response => {
    const path = url.pathname;
    if (path === '/system/runtime/swagger/openapi.json') {
      return answer(options.document ?? specification);
    }
    if (path === '/api/info') {
      return answer({ version: '3.137.1', siteName: canaries.groupName });
    }
    if (path === '/api/wiki/categories') {
      return answer(
        options.categories ?? {
          data: [
            {
              id: identification,
              name: identificationCategoryName,
              permissions: { canEdit: false, canDelete: false },
            },
          ],
          meta: { count: 1 },
          permissions: { editMasterData: false },
        },
      );
    }
    if (path === '/api/permissions/global') {
      return answer(
        { data: options.rights ?? narrowRights(identification) },
        options.rightsStatus ?? 200,
      );
    }
    if (/^\/api\/(persons|groups|search)(\/|$)/.test(path)) {
      return answer({
        data: [{ id: canaries.number, firstName: canaries.personName }],
        meta: { count: 1 },
      });
    }
    return answer({ message: canaries.personName }, 404);
  };
  return {
    calls,
    fetch: (url, init) => {
      const headers = new Headers(init.headers);
      calls.push({
        method: init.method ?? 'fehlt',
        url,
        authorization: headers.get('authorization'),
      });
      return Promise.resolve(respond(url));
    },
  };
}
