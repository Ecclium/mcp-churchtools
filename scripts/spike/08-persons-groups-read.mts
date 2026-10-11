/**
 * Probe 08: persons, groups and the global search.
 *
 * Runs only on the test instance, behind the guard for personal data
 * (`lib/persons-gate.mts`, ADR 0049). Before that guard has passed, the
 * probe reaches nothing but the two reads of the guard.
 *
 * Reads, all with GET and only operations the instance documents:
 * - the global rights, through the guard;
 * - `GET /api/whoami`, to recognise the record of the account itself;
 * - the lists of persons and groups and the global search, with the fixed
 *   search terms of `lib/synthetic.mts`, with `ids[]`, and with `limit`
 *   and `page` to find how the lists page and where `limit` ends;
 * - the synthetic person, its groups, the two synthetic groups and their
 *   members, by the IDs from the environment, and once more by the GUID
 *   their own answers carry;
 * - one unknown ID and one unknown GUID for persons and for groups.
 * Writes: nothing.
 * Answers: which operations and parameters the instance documents, how
 * the search hits, how lists page and where `limit` ends, how errors look,
 * which right each operation needs, how rights look, which fields persons
 * and groups have, and how persons and groups are addressed. Names, IDs,
 * e-mail addresses, dates and search terms never appear: the synthetic
 * objects appear only as `p1` to `p4` and `g1`, `g2`, the search terms as
 * `q1` to `q7`.
 *
 * Usage: see README.md in this folder.
 *
 * @packageDocumentation
 */
import { randomUUID } from 'node:crypto';

import { SpikeError } from './lib/errors.mts';
import type { Guard, Json } from './lib/guard.mts';
import {
  guidPattern,
  pathFor,
  type Client,
  type ProbeResponse,
} from './lib/http.mts';
import {
  boundWords,
  describeLimitBound,
  findLimitBound,
  invalidValues,
  pagination,
} from './lib/listing.mts';
import { operations, type OperationName } from './lib/operations.mts';
import { passPersonsGate } from './lib/persons-gate.mts';
import { main, type ProbeDefinition } from './lib/probe.mts';
import { describeResponse, reportWords } from './lib/report.mts';
import {
  describeDeprecation,
  describeEcho,
  describeErrorKeys,
} from './lib/response-flags.mts';
import { describeEffectiveRights } from './lib/rights.mts';
import {
  Schemas,
  findOperation,
  findPathItem,
  isObject,
  parameterTypes,
  type JsonObject,
} from './lib/spec.mts';
import { countClass, countClasses } from './lib/structure.mts';
import {
  emailToken,
  labels,
  marker,
  searchQueries,
  syntheticIn,
  unknownQueryLabel,
  type Label,
} from './lib/synthetic.mts';

/** The operations this probe reads, by the name the output uses. */
const personOperations = [
  'persons',
  'person',
  'personGroups',
  'groups',
  'group',
  'groupMembers',
  'search',
] as const satisfies readonly OperationName[];

type PersonOperation = (typeof personOperations)[number];

/**
 * An ID that no person or group of a test instance has: the largest
 * signed 32-bit number. A random ID could hit a real person.
 */
export const unknownId = 2_147_483_647;

/**
 * The parameter names the public OpenAPI document of ChurchTools declares
 * for these operations, read on 11.10.2026. Only these appear by name;
 * every other parameter an instance declares appears as a count class.
 */
export const knownParameters = [
  'ids[]',
  'ids',
  'status_ids[]',
  'campus_ids[]',
  'birthday_before',
  'birthday_after',
  'is_archived',
  'is_account_locked',
  'is_system_user',
  'firstName',
  'nickName',
  'lastName',
  'query',
  'email',
  'email-exact',
  'page',
  'limit',
  'include',
  'include[]',
  'personId',
  'groupId',
  'show_overdue_groups',
  'show_inactive_groups',
  'show_to_delete_memberships',
  'show_requested_or_waiting_memberships',
  'parent_id',
  'child_id',
  'agegroup_ids[]',
  'group_status_ids[]',
  'group_category_ids[]',
  'target_group_ids[]',
  'weekdays[]',
  'group_type_ids[]',
  'tag_ids[]',
  'is_open_for_members',
  'without_my_groups',
  'only_my_groups',
  'has_meeting_place',
  'allow_posts',
  'has_posts',
  'has_active_chat',
  'visibility',
  'order_fields',
  'order_directions',
  'role_ids[]',
  'person_id[]',
  'group_member_statuses[]',
  'allowed_chat_users_only',
  'allowed_chat_writers_only',
  'comment',
  'member_start_date_after',
  'member_start_date_before',
  'orderFields[]',
  'orderDirections[]',
  'personFields[]',
  'domain_types[]',
] as const;

/** What one call may end in, as the stages of the run compare it. */
const resultWords = [
  'verweigert',
  'erlaubt mit Einträgen',
  'erlaubt leer',
  'nicht gefunden',
  'Fehler',
  'nicht dokumentiert',
  'nicht aufgerufen',
  'unbekannte ID vorhanden',
  'nicht geprüft',
] as const;

type ResultWord = (typeof resultWords)[number];

const words = [
  ...reportWords,
  ...boundWords,
  ...countClasses,
  ...resultWords,
  ...labels,
  ...personOperations,
  ...parameterTypes,
  'probe',
  '08-persons-groups-read',
  'waechter',
  'bestanden',
  'rechte',
  'operationen',
  'dokumentiert',
  'parameter',
  'benannt',
  'weitere',
  'name',
  'ort',
  'pflicht',
  'typ',
  'eintraege',
  'veraltet',
  'aufzaehlung',
  'query',
  'path',
  'header',
  'cookie',
  'anderer Ort',
  'ja',
  'nein',
  'unbekannt',
  'strukturen',
  'listen',
  'grenze',
  'hinterLetzterSeite',
  'ungueltigeWerte',
  'wert',
  'antwort',
  'fehlerschluessel',
  'echo',
  'meta',
  'count',
  'all',
  'pagination',
  'weitereSeiten',
  'keine Liste',
  'nicht deklariert',
  'Marke',
  'fehler',
  'ergebnisse',
  'sichtbar',
  'andereEintraege',
  'eigenerDatensatz',
  'kennungSynthetisch',
  ...invalidValues.flat(),
];

/** The visibility of the synthetic objects in one call. */
type Visibility = Record<Label, 'ja' | 'nein' | 'unbekannt'>;

function dataOf(response: ProbeResponse): unknown {
  return isObject(response.body) ? response.body['data'] : undefined;
}

function resultOf(response: ProbeResponse): ResultWord {
  if (response.status === 401 || response.status === 403) {
    return 'verweigert';
  }
  if (response.status === 404) {
    return 'nicht gefunden';
  }
  if (response.status !== 200 || response.kind !== 'JSON') {
    return 'Fehler';
  }
  const data = dataOf(response);
  if (Array.isArray(data)) {
    return data.length > 0 ? 'erlaubt mit Einträgen' : 'erlaubt leer';
  }
  return data === undefined || data === null
    ? 'erlaubt leer'
    : 'erlaubt mit Einträgen';
}

function entriesOf(response: ProbeResponse): readonly unknown[] | undefined {
  if (response.status !== 200) {
    return undefined;
  }
  const data = dataOf(response);
  if (Array.isArray(data)) {
    return data as readonly unknown[];
  }
  return data === undefined || data === null ? [] : [data];
}

function isOwn(entry: unknown, ownId: number | undefined): boolean {
  if (ownId === undefined || !isObject(entry)) {
    return false;
  }
  const own = String(ownId);
  const person = entry['person'];
  return (
    (entry['domainType'] === undefined && String(entry['id']) === own) ||
    (entry['domainType'] === 'person' &&
      String(entry['domainIdentifier']) === own) ||
    String(entry['personId']) === own ||
    (isObject(person) && String(person['domainIdentifier']) === own)
  );
}

interface Seen {
  readonly sichtbar: Visibility;
  readonly andere: string;
  readonly eigener: 'ja' | 'nein' | 'unbekannt';
}

function seenIn(response: ProbeResponse, ownId: number | undefined): Seen {
  const unknownAll = Object.fromEntries(
    labels.map((label) => [label, 'unbekannt']),
  ) as Visibility;
  const entries = entriesOf(response);
  if (entries === undefined) {
    return { sichtbar: unknownAll, andere: 'unbekannt', eigener: 'unbekannt' };
  }
  const found = new Set<Label>();
  let comparable = entries.length === 0;
  let others = 0;
  let own = false;
  for (const entry of entries) {
    const result = syntheticIn(entry);
    comparable ||= result.comparable;
    for (const label of result.found) {
      found.add(label);
    }
    const mine = isOwn(entry, ownId);
    own ||= mine;
    if (result.found.size === 0 && !mine) {
      others += 1;
    }
  }
  return {
    sichtbar: comparable
      ? (Object.fromEntries(
          labels.map((label) => [label, found.has(label) ? 'ja' : 'nein']),
        ) as Visibility)
      : unknownAll,
    andere: countClass(others),
    eigener: ownId === undefined ? 'unbekannt' : own ? 'ja' : 'nein',
  };
}

function declaredMaximum(
  schemas: Schemas,
  operation: JsonObject,
  pathItem: JsonObject | undefined,
  name: string,
): number | undefined {
  for (const source of [operation['parameters'], pathItem?.['parameters']]) {
    if (!Array.isArray(source)) {
      continue;
    }
    for (const item of source) {
      const parameter = schemas.resolve(item);
      if (parameter?.['name'] === name && parameter['in'] === 'path') {
        const schema = schemas.resolve(parameter['schema']) ?? parameter;
        const maximum = schema['maximum'];
        return typeof maximum === 'number' ? maximum : undefined;
      }
    }
  }
  return undefined;
}

interface Documented {
  readonly operation: JsonObject;
  readonly pathItem: JsonObject | undefined;
  readonly query: ReadonlySet<string>;
}

/** The probe, for tests and for {@link main}. */
export const probe: ProbeDefinition = {
  name: '08-persons-groups-read',
  state: 'read',
  personalData: true,
  async run({ client, guard, state, persons }): Promise<Json> {
    guard.allowFixed(...words, ...knownParameters);
    if (state === undefined || persons === undefined) {
      throw new SpikeError('INTERN');
    }
    const pass = await passPersonsGate({ client, state }, persons.access);
    const { personId, groupId, otherGroupId } = persons.settings;
    const reader = pass.client;
    const document = state.specification;
    const schemas = new Schemas(document);

    const documented = new Map<PersonOperation, Documented>();
    for (const name of personOperations) {
      const { method, template } = operations[name];
      const operation = findOperation(document, method, template);
      if (operation !== undefined) {
        documented.set(name, {
          operation,
          pathItem: findPathItem(document, method, template),
          query: schemas.queryParameters(operation),
        });
      }
    }

    const ergebnisse: Record<string, Json> = {};
    const sichtbar: Record<string, Json> = {};
    const andereEintraege: Record<string, Json> = {};
    const eigenerDatensatz: Record<string, Json> = {};
    const strukturen: Record<string, Json> = {};
    const fehler: Record<string, Json> = {};

    const fixed = (text: string): string => {
      guard.allowFixed(text);
      return text;
    };
    const skip = (target: string, word: ResultWord): void => {
      ergebnisse[fixed(target)] = word;
    };

    const whoami = findOperation(
      document,
      operations.whoami.method,
      operations.whoami.template,
    );
    let ownId: number | undefined;
    if (whoami !== undefined) {
      const own = dataOf(
        await reader.get({ path: operations.whoami.template }),
      );
      const id = isObject(own) ? own['id'] : undefined;
      ownId = typeof id === 'number' ? id : undefined;
    }

    // Sends one call and records its result and the visibility of the
    // synthetic objects. Of the answers it describes only the first 200
    // per operation and the first answer per error status, so the output
    // stays short enough to read through.
    const call = async (
      target: string,
      name: PersonOperation,
      path: string,
      query: readonly (readonly [string, string])[] = [],
      options: { readonly sent?: string; readonly unknown?: boolean } = {},
    ): Promise<ProbeResponse | undefined> => {
      const entry = documented.get(name);
      if (entry === undefined) {
        skip(target, 'nicht dokumentiert');
        return undefined;
      }
      const response = await reader.get({ path, query });
      const key = fixed(target);
      if (options.unknown === true && response.status === 200) {
        ergebnisse[key] = 'unbekannte ID vorhanden';
        return response;
      }
      ergebnisse[key] = resultOf(response);
      const seen = seenIn(response, ownId);
      sichtbar[key] = seen.sichtbar;
      andereEintraege[key] = seen.andere;
      eigenerDatensatz[key] = seen.eigener;
      const describe = (): Json =>
        describeResponse(response, {
          guard,
          schemas,
          operation: entry.operation,
          textFormats: true,
        });
      if (response.status === 200 && strukturen[name] === undefined) {
        strukturen[name] = describe();
      }
      if (response.status >= 400) {
        const errorKey = fixed(`${name} ${String(response.status)}`);
        if (fehler[errorKey] === undefined) {
          fehler[errorKey] = {
            antwort: describe(),
            fehlerschluessel: describeErrorKeys(response.body, guard),
            ...(options.sent === undefined
              ? {}
              : { echo: describeEcho(response.body, options.sent, guard) }),
          };
        }
      }
      return response;
    };

    const output: Record<string, Json> = {
      probe: '08-persons-groups-read',
      waechter: 'bestanden',
      rechte: describeEffectiveRights(pass.rights, guard),
      operationen: Object.fromEntries(
        personOperations.map((name) => [
          name,
          documented.has(name) ? 'dokumentiert' : 'nicht dokumentiert',
        ]),
      ),
      parameter: Object.fromEntries(
        [...documented].map(([name, entry]) => {
          const details = schemas.parameterDetails(
            entry.operation,
            entry.pathItem,
          );
          const named = details.filter((detail) =>
            (knownParameters as readonly string[]).includes(detail.name),
          );
          return [
            name,
            {
              benannt: named.map((detail) => ({
                name: detail.name,
                ort: ['query', 'path', 'header', 'cookie'].includes(
                  detail.location,
                )
                  ? detail.location
                  : 'anderer Ort',
                pflicht: detail.required ? 'ja' : 'nein',
                typ: detail.type,
                ...(detail.itemType === undefined
                  ? {}
                  : { eintraege: detail.itemType }),
                veraltet: detail.deprecated ? 'ja' : 'nein',
                aufzaehlung:
                  detail.enumCount === undefined
                    ? 'nein'
                    : countClass(detail.enumCount),
              })),
              weitere: countClass(details.length - named.length),
            },
          ];
        }),
      ),
    };

    // The plain lists, then every search with the fixed terms.
    const unknownQuery = randomUUID();
    const queries = [
      ...searchQueries,
      { label: unknownQueryLabel, text: unknownQuery },
    ];
    await call('persons', 'persons', operations.persons.template);
    await call('groups', 'groups', operations.groups.template);
    for (const { label, text } of queries) {
      await call(
        `search:${label}`,
        'search',
        operations.search.template,
        [['query', text]],
        { sent: text },
      );
    }
    const search = documented.get('search');
    if (search?.query.has('domain_types[]') === true) {
      for (const domain of ['person', 'group']) {
        await call(
          `search:q1:${domain}`,
          'search',
          operations.search.template,
          [
            ['query', marker],
            ['domain_types[]', domain],
          ],
          { sent: marker },
        );
      }
    }
    const personsEntry = documented.get('persons');
    if (personsEntry?.query.has('query') === true) {
      for (const { label, text } of queries) {
        await call(
          `persons:${label}`,
          'persons',
          operations.persons.template,
          [['query', text]],
          { sent: text },
        );
      }
    }
    if (personsEntry?.query.has('email') === true) {
      await call(
        'persons:email:q6',
        'persons',
        operations.persons.template,
        [['email', emailToken]],
        { sent: emailToken },
      );
    }
    const groupsEntry = documented.get('groups');
    if (groupsEntry?.query.has('query') === true) {
      for (const { label, text } of searchQueries.slice(0, 3)) {
        await call(
          `groups:${label}`,
          'groups',
          operations.groups.template,
          [['query', text]],
          { sent: text },
        );
      }
    }

    // ids[] with the IDs from the environment only.
    const idsName = (entry: Documented | undefined): string | undefined =>
      entry?.query.has('ids[]') === true
        ? 'ids[]'
        : entry?.query.has('ids') === true
          ? 'ids'
          : undefined;
    const personIds = idsName(personsEntry);
    if (personIds === undefined) {
      skip('persons:ids', 'nicht dokumentiert');
    } else {
      await call('persons:ids', 'persons', operations.persons.template, [
        [personIds, String(personId)],
      ]);
    }
    const groupIds = idsName(groupsEntry);
    if (groupIds === undefined) {
      skip('groups:ids', 'nicht dokumentiert');
    } else {
      await call('groups:ids', 'groups', operations.groups.template, [
        [groupIds, String(groupId)],
        [groupIds, String(otherGroupId)],
      ]);
    }

    // Single reads: only the IDs from the environment, and a GUID only from
    // the answer to one of them that showed the synthetic object.
    const kennung: Record<string, Json> = {};
    const synthetic = (
      response: ProbeResponse | undefined,
      label: Label,
    ): 'ja' | 'nein' | 'nicht geprüft' => {
      if (response?.status !== 200) {
        return 'nicht geprüft';
      }
      return syntheticIn(dataOf(response)).found.has(label) ? 'ja' : 'nein';
    };
    const guidOf = (
      response: ProbeResponse | undefined,
    ): string | undefined => {
      const data = response === undefined ? undefined : dataOf(response);
      const guid = isObject(data) ? data['guid'] : undefined;
      return typeof guid === 'string' && guidPattern.test(guid)
        ? guid
        : undefined;
    };
    const dataSchema = (name: PersonOperation): unknown =>
      schemas
        .properties(
          schemas.responseSchema(documented.get(name)?.operation ?? {}, 200),
        )
        .get('data');
    const veraltet: Record<string, Json> = {};

    const p1 = await call(
      'person:p1-id',
      'person',
      pathFor(operations.person.template, personId),
    );
    kennung['p1'] = synthetic(p1, 'p1');
    const p1Guid = kennung['p1'] === 'ja' ? guidOf(p1) : undefined;
    if (p1Guid === undefined) {
      skip('person:p1-guid', 'nicht aufgerufen');
    } else {
      await call(
        'person:p1-guid',
        'person',
        pathFor(operations.person.template, p1Guid),
      );
    }
    if (kennung['p1'] === 'nein') {
      skip('personGroups:p1', 'nicht aufgerufen');
    } else {
      const memberships = await call(
        'personGroups:p1',
        'personGroups',
        pathFor(operations.personGroups.template, personId),
      );
      const first =
        memberships === undefined ? [] : (entriesOf(memberships) ?? []);
      veraltet['personGroups'] = describeDeprecation(
        first[0],
        schemas.items(dataSchema('personGroups')),
        schemas,
        guard,
      );
    }

    for (const [label, id] of [
      ['g1', groupId],
      ['g2', otherGroupId],
    ] as const) {
      const group = await call(
        `group:${label}-id`,
        'group',
        pathFor(operations.group.template, id),
      );
      kennung[label] = synthetic(group, label);
      if (kennung[label] === 'nein') {
        skip(`groupMembers:${label}`, 'nicht aufgerufen');
        continue;
      }
      await call(
        `groupMembers:${label}`,
        'groupMembers',
        pathFor(operations.groupMembers.template, id),
      );
      if (label !== 'g1') {
        continue;
      }
      veraltet['group'] = describeDeprecation(
        group === undefined ? undefined : dataOf(group),
        dataSchema('group'),
        schemas,
        guard,
      );
      const guid = kennung['g1'] === 'ja' ? guidOf(group) : undefined;
      if (guid === undefined) {
        skip('group:g1-guid', 'nicht aufgerufen');
        skip('groupMembers:g1-guid', 'nicht aufgerufen');
      } else {
        await call(
          'group:g1-guid',
          'group',
          pathFor(operations.group.template, guid),
        );
        await call(
          'groupMembers:g1-guid',
          'groupMembers',
          pathFor(operations.groupMembers.template, guid),
        );
      }
    }

    // Unknown objects: a fixed ID no test instance reaches, a random GUID.
    for (const [kind, parameter] of [
      ['person', 'personId'],
      ['group', 'groupId'],
    ] as const) {
      const entry = documented.get(kind);
      const maximum =
        entry === undefined
          ? undefined
          : declaredMaximum(
              schemas,
              entry.operation,
              entry.pathItem,
              parameter,
            );
      if (
        [personId, groupId, otherGroupId].includes(unknownId) ||
        (maximum !== undefined && maximum < unknownId)
      ) {
        skip(`${kind}:unbekannt`, 'nicht geprüft');
      } else {
        await call(
          `${kind}:unbekannt`,
          kind,
          pathFor(operations[kind].template, unknownId),
          [],
          { unknown: true },
        );
      }
      await call(
        `${kind}:unbekannt-guid`,
        kind,
        pathFor(operations[kind].template, randomUUID()),
        [],
        { unknown: true },
      );
    }

    // How the lists that can serve a search page, and where limit ends.
    const listen: Record<string, Json> = {};
    for (const name of ['search', 'persons', 'groups'] as const) {
      listen[name] = await describeList(
        reader,
        guard,
        documented.get(name),
        operations[name].template,
        [['query', marker]],
      );
    }

    return {
      ...output,
      strukturen,
      listen,
      fehler,
      veraltet,
      kennungSynthetisch: kennung,
      ergebnisse,
      sichtbar,
      andereEintraege,
      eigenerDatensatz,
    };
  },
};

function metaForm(response: ProbeResponse): Json {
  const meta = isObject(response.body) ? response.body['meta'] : undefined;
  const has = (key: string): string =>
    isObject(meta) && meta[key] !== undefined ? 'ja' : 'nein';
  return {
    count: has('count'),
    all: has('all'),
    pagination: has('pagination'),
  };
}

function fixedStatus(guard: Guard, status: number): number {
  guard.allowFixed(status);
  return status;
}

async function describeList(
  reader: Client,
  guard: Guard,
  entry: Documented | undefined,
  path: string,
  base: readonly (readonly [string, string])[],
): Promise<Json> {
  if (entry === undefined) {
    return 'nicht dokumentiert';
  }
  if (!base.every(([name]) => entry.query.has(name))) {
    return 'nicht deklariert';
  }
  const pages = entry.query.has('page');
  const withPage = (page: string): (readonly [string, string])[] =>
    pages ? [['page', page]] : [];
  const result: Record<string, Json> = {};
  if (entry.query.has('limit')) {
    let lastPage: number | undefined;
    let first: ProbeResponse | undefined;
    const bound = await findLimitBound(async (limit) => {
      const response = await reader.get({
        path,
        query: [...base, ...withPage('1'), ['limit', String(limit)]],
      });
      if (limit === 1) {
        first = response;
        const last = pagination(response.body)?.['lastPage'];
        lastPage =
          typeof last === 'number' && Number.isSafeInteger(last)
            ? last
            : undefined;
      }
      const echo = pagination(response.body)?.['limit'];
      return {
        limit,
        status: response.status,
        echo: typeof echo === 'number' ? echo : undefined,
      };
    });
    result['grenze'] = describeLimitBound(bound, guard);
    result['meta'] = first === undefined ? 'unbekannt' : metaForm(first);
    result['weitereSeiten'] =
      lastPage === undefined ? 'unbekannt' : lastPage > 1 ? 'ja' : 'nein';
    if (pages) {
      const behind = await reader.get({
        path,
        query: [
          ...base,
          ['page', String((lastPage ?? 999) + 1)],
          ['limit', '1'],
        ],
      });
      const data = isObject(behind.body) ? behind.body['data'] : undefined;
      result['hinterLetzterSeite'] = {
        status: fixedStatus(guard, behind.status),
        eintraege: Array.isArray(data)
          ? countClass(data.length)
          : 'keine Liste',
      };
    } else {
      result['hinterLetzterSeite'] = 'nicht deklariert';
    }
  } else {
    result['grenze'] = 'nicht deklariert';
  }
  const invalid: Json[] = [];
  for (const [name, value] of [...invalidValues, ['limit', marker] as const]) {
    if (!entry.query.has(name)) {
      continue;
    }
    const response = await reader.get({
      path,
      query: [
        ...base,
        ...(name === 'page' ? [] : withPage('1')),
        [name, value],
      ],
    });
    invalid.push({
      parameter: name,
      wert: value === marker ? 'Marke' : value,
      status: fixedStatus(guard, response.status),
      fehlerschluessel: describeErrorKeys(response.body, guard),
      ...(value === marker
        ? { echo: describeEcho(response.body, value, guard) }
        : {}),
    });
  }
  result['ungueltigeWerte'] = invalid;
  return result;
}

if (import.meta.main) {
  process.exitCode = await main(probe, import.meta.url);
}
