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
import { makeGuid, writeOrigin, writeSwitch } from './write-support.mts';

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
  /** ID of the record of the account itself. */
  readonly ownId: number;
  /** ID of p2; p3 and p4 follow it. */
  readonly p2: number;
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
  const ownId = randomInt(60_000, 70_000);
  const p2 = randomInt(70_000, 80_000);
  const files = privateFiles(canaries.token);
  return {
    canaries,
    identification,
    personId,
    groupId,
    otherGroupId,
    ownId,
    p2,
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
      String(ownId),
      String(p2),
      String(p2 + 1),
      String(p2 + 2),
      String(p2 + 3),
      'demo-tenant.example',
      personsSwitch,
      'spikeprobe',
      'qzvx',
      'bruno',
      'carlsen',
      'kontakt',
      '2026-01-05',
      '2026-10-11T08:15:00Z',
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
  /** Which persons the account sees. Default: the synthetic area, p1 to p3. */
  readonly persons?: 'alle' | 'bereich' | 'keine';
  /** Which groups the account sees. Default: those of type A, g1 only. */
  readonly groups?: 'alle' | 'typA' | 'keine';
  /** Whether the account sees member lists. Default true. */
  readonly memberLists?: boolean;
  /** Whether the search also finds parts of e-mail addresses. Default false. */
  readonly searchEmails?: boolean;
  /** Whether the unknown ID of the probe exists. Default false. */
  readonly unknownExists?: boolean;
  /** Puts the ID of the foreign person into ECCLIUM_SPIKE_PERSON_ID. */
  readonly foreignAsP1?: boolean;
}

/** One synthetic or foreign person of the instance. */
interface Person {
  readonly id: number;
  readonly guid: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly birthday: string;
  readonly area: 'bereich' | 'anderer';
}

/** One synthetic or foreign group of the instance. */
interface Group {
  readonly id: number;
  readonly guid: string;
  readonly name: string;
  readonly type: 'A' | 'B';
  readonly members: readonly number[];
}

/** The largest limit the synthetic lists of persons accept. */
export const personsLimit = 500;

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
  const birthday = (): string =>
    `19${String(randomInt(30, 99))}-0${String(randomInt(1, 9))}-1${String(randomInt(0, 9))}`;
  const person = (
    id: number,
    firstName: string,
    lastName: string,
    email: string,
    area: Person['area'],
  ): Person => ({
    id,
    guid: makeGuid(),
    firstName,
    lastName,
    email,
    birthday: birthday(),
    area,
  });
  const own = person(
    setting.ownId,
    'Kanarie',
    canaries.personName,
    canaries.personEmail,
    'anderer',
  );
  const foreign = person(
    canaries.number,
    canaries.personName,
    canaries.groupName,
    canaries.personEmail,
    'anderer',
  );
  const people: readonly Person[] = [
    person(
      options.foreignAsP1 === true ? setting.p2 : setting.personId,
      'Anna',
      'Spikeprobe',
      'kontakt.qzvx@example.org',
      'bereich',
    ),
    person(
      setting.p2 + 1,
      'Bruno',
      'Spikeprobenberg',
      'bruno@example.org',
      'bereich',
    ),
    person(
      setting.p2 + 2,
      'Spikeprobe',
      'Carlsen',
      'carlsen@example.org',
      'bereich',
    ),
    person(
      setting.p2 + 3,
      'Dora',
      'Vorspikeprobe',
      'dora@example.org',
      'anderer',
    ),
    options.foreignAsP1 === true
      ? { ...foreign, id: setting.personId }
      : foreign,
    own,
  ];
  const [p1, p2, p3] = people;
  const foreignGroup: Group = {
    id: setting.otherGroupId + 1,
    guid: makeGuid(),
    name: canaries.groupName,
    type: 'A',
    members: [foreign.id],
  };
  const groups: readonly Group[] = [
    {
      id: setting.groupId,
      guid: makeGuid(),
      name: 'Spikeprobe Nord',
      type: 'A',
      members: [p1?.id ?? 0, p2?.id ?? 0],
    },
    {
      id: setting.otherGroupId,
      guid: makeGuid(),
      name: 'Spikeprobe West',
      type: 'B',
      members: [p3?.id ?? 0],
    },
    foreignGroup,
  ];
  const seesPerson = (entry: Person): boolean =>
    options.persons === 'alle' ||
    ((options.persons ?? 'bereich') === 'bereich' && entry.area === 'bereich');
  const seesGroup = (entry: Group): boolean =>
    options.groups === 'alle' ||
    ((options.groups ?? 'typA') === 'typA' && entry.type === 'A');
  const personData = (entry: Person): Record<string, unknown> => ({
    id: entry.id,
    guid: entry.guid,
    firstName: entry.firstName,
    lastName: entry.lastName,
    email: entry.email,
    birthday: entry.birthday,
    isArchived: false,
    meta: { modifiedDate: '2026-10-11T08:15:00Z' },
  });
  const groupData = (entry: Group): Record<string, unknown> => ({
    '@deprecated': { identifier: 'guid' },
    id: entry.id,
    guid: entry.guid,
    name: entry.name,
  });
  const reference = (entry: Person): Record<string, unknown> => ({
    title: `${entry.firstName} ${entry.lastName}`,
    domainType: 'person',
    domainIdentifier: String(entry.id),
    domainAttributes: {
      firstName: entry.firstName,
      lastName: entry.lastName,
      guid: entry.guid,
    },
  });
  const membership = (
    member: Person,
    group: Group,
  ): Record<string, unknown> => ({
    '@deprecated': { personId: 'person' },
    personId: member.id,
    person: reference(member),
    group: {
      title: group.name,
      domainType: 'group',
      domainIdentifier: String(group.id),
    },
    memberStartDate: '2026-01-05',
  });
  const invalid = (name: string, value: string): Response =>
    answer(
      {
        message: `Der Wert für ${name} ist ungültig.`,
        translatedMessage: canaries.groupName,
        messageKey: 'validation.invalid',
        args: { [name]: value },
        errors: [],
      },
      400,
    );
  const listOf = (
    url: URL,
    entries: readonly Record<string, unknown>[],
    maxLimit: number,
  ): Response => {
    const limitText = url.searchParams.get('limit') ?? '10';
    const pageText = url.searchParams.get('page') ?? '1';
    if (!/^[1-9]\d*$/.test(limitText) || Number(limitText) > maxLimit) {
      return invalid('limit', limitText);
    }
    if (!/^[1-9]\d*$/.test(pageText)) {
      return invalid('page', pageText);
    }
    const limit = Number(limitText);
    const page = Number(pageText);
    const lastPage = Math.max(1, Math.ceil(entries.length / limit));
    return answer({
      data: entries.slice((page - 1) * limit, page * limit),
      meta: {
        count: entries.length,
        all: entries.length,
        pagination: { total: entries.length, limit, current: page, lastPage },
      },
    });
  };
  const matches = (text: string, ...values: readonly string[]): boolean =>
    values.some((value) => value.toLowerCase().includes(text.toLowerCase()));
  const findPerson = (key: string): Person | undefined =>
    people.find((entry) => String(entry.id) === key || entry.guid === key);
  const findGroup = (key: string): Group | undefined =>
    groups.find((entry) => String(entry.id) === key || entry.guid === key);
  const unknown = String(2_147_483_647);
  const respondPersonal = (url: URL): Response | undefined => {
    const parts = url.pathname.split('/').slice(2);
    const [kind, key, sub] = parts;
    if (kind === 'persons' && key === undefined) {
      const query = url.searchParams.get('query');
      const email = url.searchParams.get('email');
      const ids = url.searchParams.getAll('ids[]');
      const visible = people.filter(
        (entry) =>
          seesPerson(entry) &&
          (query === null || matches(query, entry.firstName, entry.lastName)) &&
          (email === null || matches(email, entry.email)) &&
          (ids.length === 0 || ids.includes(String(entry.id))),
      );
      return listOf(url, visible.map(personData), personsLimit);
    }
    if (kind === 'persons' && key !== undefined) {
      if (key === unknown && options.unknownExists === true) {
        return answer({ data: personData(foreign) });
      }
      const found = findPerson(key);
      if (found === undefined) {
        return answer({ message: canaries.personName }, 404);
      }
      if (!seesPerson(found)) {
        return answer({ message: canaries.personName, args: { id: key } }, 403);
      }
      if (sub === undefined) {
        return answer({ data: personData(found) });
      }
      const memberships = groups
        .filter((group) => group.members.includes(found.id) && seesGroup(group))
        .map((group) => membership(found, group));
      return answer({ data: memberships, meta: { count: memberships.length } });
    }
    if (kind === 'groups' && key === undefined) {
      const query = url.searchParams.get('query');
      const ids = url.searchParams.getAll('ids[]');
      const visible = groups.filter(
        (entry) =>
          seesGroup(entry) &&
          (query === null || matches(query, entry.name)) &&
          (ids.length === 0 || ids.includes(String(entry.id))),
      );
      return listOf(url, visible.map(groupData), Infinity);
    }
    if (kind === 'groups' && key !== undefined) {
      if (key === unknown && options.unknownExists === true) {
        return answer({ data: groupData(foreignGroup) });
      }
      const found = findGroup(key);
      if (found === undefined) {
        return answer({ message: canaries.groupName }, 404);
      }
      if (!seesGroup(found)) {
        return answer({ message: canaries.groupName }, 403);
      }
      if (sub === undefined) {
        return answer({ data: groupData(found) });
      }
      if (options.memberLists === false) {
        return answer({ message: canaries.groupName }, 403);
      }
      const members = people
        .filter((entry) => found.members.includes(entry.id))
        .map((entry) => membership(entry, found));
      return listOf(url, members, Infinity);
    }
    if (kind === 'search') {
      const query = url.searchParams.get('query');
      if (query === null || query === '') {
        return invalid('query', '');
      }
      const domains = url.searchParams.getAll('domain_types[]');
      const wanted = (domain: string): boolean =>
        domains.length === 0 || domains.includes(domain);
      const hits = [
        ...people
          .filter(
            (entry) =>
              wanted('person') &&
              seesPerson(entry) &&
              (matches(query, `${entry.firstName} ${entry.lastName}`) ||
                (options.searchEmails === true && matches(query, entry.email))),
          )
          .map(reference),
        ...groups
          .filter(
            (entry) =>
              wanted('group') && seesGroup(entry) && matches(query, entry.name),
          )
          .map((entry) => ({
            title: entry.name,
            domainType: 'group',
            domainIdentifier: String(entry.id),
            domainAttributes: { guid: entry.guid },
          })),
      ];
      return answer({ data: hits, meta: { count: hits.length } });
    }
    return undefined;
  };
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
    if (path === '/api/whoami') {
      return answer({ data: personData(own) });
    }
    const personal = respondPersonal(url);
    if (personal !== undefined) {
      return personal;
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
