/**
 * Probe 09: events, services, agendas, calendars, appointments, resources,
 * bookings, songs, the search of the wiki and the global search.
 *
 * Runs only on the test instance, behind the guard for personal data
 * (`lib/persons-gate.mts`, ADR 0049), which here lets the read rights on
 * services, calendars and resources through as well. Before that guard has
 * passed, the probe reaches nothing but the two reads of the guard.
 *
 * Reads, all with GET, only operations the instance documents and only
 * parameters it declares:
 * - the global rights, through the guard;
 * - the lists of calendars, services, service groups, resource types and
 *   resources;
 * - the appointments of the synthetic calendar and the bookings of the
 *   synthetic resource from today for six weeks, and both synthetic
 *   appointments one by one;
 * - the events of the same six weeks, the synthetic event, its agenda and
 *   the songs of its agenda;
 * - the songs of the synthetic category, the songs that match a fixed
 *   term, both synthetic songs and their arrangements;
 * - the events and the songs with `page` and `limit`, to see how they page
 *   and where `limit` ends;
 * - the search of the wiki with the marker, once in the identification
 *   category and once without a category, which the guard narrows to that
 *   one, and the global search with a fixed term, once per domain type the
 *   instance declares;
 * - one unknown event, song and appointment.
 * Writes: nothing.
 * Answers: which operations and parameters the instance documents, how the
 * answers are built and how their dates look, whether the synthetic
 * objects appear and whether an answer names persons, how the lists page,
 * how an unknown ID fails, whether a hidden name in an assignment is the
 * real one, and, over the stages of the run, which right each operation
 * needs. Names, IDs, dates and search terms never appear:
 * the synthetic objects appear only as the labels of
 * {@link domainLabels}, the synthetic person only as `p1`, the domain types
 * as `d1`, `d2` and so on.
 *
 * Usage: see README.md in this folder.
 *
 * @packageDocumentation
 */
import {
  readObjectId,
  type Environment,
  type ObjectIdVariable,
} from './lib/env.mts';
import { SpikeError } from './lib/errors.mts';
import type { Guard, Json } from './lib/guard.mts';
import { pathFor, type Client, type ProbeResponse } from './lib/http.mts';
import { entries, exact, pagination } from './lib/listing.mts';
import { operations, type OperationName } from './lib/operations.mts';
import { domainReadRights, passPersonsGate } from './lib/persons-gate.mts';
import { main, type ProbeDefinition } from './lib/probe.mts';
import { describeResponse, reportWords } from './lib/report.mts';
import { describeEcho, describeErrorKeys } from './lib/response-flags.mts';
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
import { domainsQuery, hiddenNameIn, marker } from './lib/synthetic.mts';

/** The labels under which the synthetic objects appear in the output. */
export const domainLabels = [
  'c1',
  't1',
  't2',
  'rt1',
  'r1',
  'sg1',
  's1',
  's2',
  'e1',
  'sc1',
  'l1',
  'l2',
] as const;

/** One label of a synthetic object of the domains. */
export type DomainLabel = (typeof domainLabels)[number];

/** The variable that names each synthetic object. */
export const domainVariables: Readonly<Record<DomainLabel, ObjectIdVariable>> =
  {
    c1: 'ECCLIUM_SPIKE_CALENDAR_ID',
    t1: 'ECCLIUM_SPIKE_APPOINTMENT_ID',
    t2: 'ECCLIUM_SPIKE_SERIES_APPOINTMENT_ID',
    rt1: 'ECCLIUM_SPIKE_RESOURCE_TYPE_ID',
    r1: 'ECCLIUM_SPIKE_RESOURCE_ID',
    sg1: 'ECCLIUM_SPIKE_SERVICE_GROUP_ID',
    s1: 'ECCLIUM_SPIKE_SERVICE_ID',
    s2: 'ECCLIUM_SPIKE_OTHER_SERVICE_ID',
    e1: 'ECCLIUM_SPIKE_EVENT_ID',
    sc1: 'ECCLIUM_SPIKE_SONG_CATEGORY_ID',
    l1: 'ECCLIUM_SPIKE_SONG_ID',
    l2: 'ECCLIUM_SPIKE_OTHER_SONG_ID',
  };

/** The IDs of the synthetic objects, by label. */
export type DomainIds = Readonly<Record<DomainLabel, number>>;

/**
 * Reads the IDs of the synthetic objects, before any request.
 *
 * @param env - Environment of the process.
 * @returns The ID of each synthetic object.
 * @throws {SpikeError} If an ID is missing or invalid, or two objects of the same kind share one.
 */
export function readDomainIds(env: Environment): DomainIds {
  const ids = Object.fromEntries(
    domainLabels.map((label) => [
      label,
      readObjectId(env, domainVariables[label]),
    ]),
  ) as Record<DomainLabel, number>;
  // Two objects of one kind under one ID could not be told apart.
  for (const [one, other] of [
    ['t1', 't2'],
    ['s1', 's2'],
    ['l1', 'l2'],
  ] as const) {
    if (ids[one] === ids[other]) {
      throw new SpikeError('KONFIGURATION', 'bereichsIdsGleich');
    }
  }
  return ids;
}

/** The operations this probe reads, by the name the output uses. */
const domainOperations = [
  'calendars',
  'calendarAppointments',
  'calendarAppointment',
  'events',
  'event',
  'eventAgenda',
  'eventAgendaSongs',
  'services',
  'serviceGroups',
  'resourceTypes',
  'resources',
  'bookings',
  'songs',
  'song',
  'songArrangements',
  'wikiSearch',
  'search',
] as const satisfies readonly OperationName[];

type DomainOperation = (typeof domainOperations)[number];

/**
 * The synthetic objects an answer of each operation can name. IDs of
 * different kinds can be equal, so an operation reports only the objects
 * of the kinds it answers with. The global search names its hits by
 * `domainIdentifier` instead; which objects it checks depends on the
 * searched type, see {@link labelsForDomainType}.
 */
const expectedLabels: Readonly<
  Record<DomainOperation, readonly DomainLabel[]>
> = {
  calendars: ['c1'],
  calendarAppointments: ['c1', 't1', 't2'],
  calendarAppointment: ['c1', 't1', 't2'],
  events: ['e1'],
  event: ['e1'],
  eventAgenda: ['l1', 'l2'],
  eventAgendaSongs: ['l1', 'l2'],
  services: ['s1', 's2'],
  serviceGroups: ['sg1'],
  resourceTypes: ['rt1'],
  resources: ['rt1', 'r1'],
  bookings: ['r1'],
  songs: ['sc1', 'l1', 'l2'],
  song: ['sc1', 'l1', 'l2'],
  songArrangements: [],
  wikiSearch: [],
  search: [],
};

/**
 * Which labels a domain type of the global search can name, by a part of
 * its value. IDs of different kinds can be equal on a test instance, such
 * as an event and a song with the same number, so a hit counts only for
 * the objects of the kind its type names.
 */
const searchKinds: readonly (readonly [string, readonly DomainLabel[]])[] = [
  ['song', ['l1', 'l2']],
  ['appointment', ['t1', 't2']],
  ['event', ['e1']],
  ['calendar', ['c1']],
  ['resource', ['r1']],
  ['service', ['s1', 's2']],
];

/**
 * Tells which synthetic objects a search for one domain type checks. A
 * type that names services and groups also checks the service group; every
 * type without a part of {@link searchKinds} checks none.
 *
 * @param value - The domain type, as the document of the instance names it.
 * @returns The labels, in the order of {@link domainLabels}.
 */
export function labelsForDomainType(value: string): readonly DomainLabel[] {
  const type = value.toLowerCase();
  const found = new Set<DomainLabel>();
  for (const [part, labels] of searchKinds) {
    if (type.includes(part)) {
      for (const label of labels) {
        found.add(label);
      }
    }
  }
  if (type.includes('service') && type.includes('group')) {
    found.add('sg1');
  }
  return domainLabels.filter((label) => found.has(label));
}

/**
 * The lists over the window of dates. Here an object can appear more than
 * once, as each date of a series does, so they also tell how often.
 */
const countedOperations: ReadonlySet<DomainOperation> = new Set([
  'calendarAppointments',
  'events',
  'bookings',
]);

/**
 * An ID that no object of a test instance has: the largest signed 32-bit
 * number, as in probe 08. A random ID could hit a real object.
 */
export const unknownId = 2_147_483_647;

/** How many days after today the window for dates ends. */
export const windowDays = 42;

/**
 * The window of dates the probe asks for: today in UTC and the day
 * `windowDays` later, as `JJJJ-MM-TT`. Neither date reaches the output.
 *
 * @param now - The time of the run.
 * @returns The first and the last day.
 */
export function timeWindow(now: Date): {
  readonly from: string;
  readonly to: string;
} {
  const day = (offset: number): string =>
    new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + offset,
      ),
    )
      .toISOString()
      .slice(0, 10);
  return { from: day(0), to: day(windowDays) };
}

/**
 * The calls that show how a list pages: `page` and `limit`, or `limit`
 * alone where `page` is `undefined`.
 */
export const pagingSteps = [
  [1, 1],
  [2, 1],
  [undefined, 100],
  [undefined, 1000],
] as const;

/**
 * At most this many domain types of the global search are searched. The
 * public document of ChurchTools declares fewer.
 */
const maxDomainTypes = 30;

/** How many fields of one object the structures name, as in probe 08. */
const maxFields = 200;

/** How deep the probe looks for IDs in an answer. */
const maxScanDepth = 32;

/**
 * The parameter names the probe expects from the public OpenAPI document of
 * ChurchTools for these operations. Only these appear by name; every other
 * parameter an instance declares appears as a count class.
 */
export const knownParameters = [
  'calendar_ids[]',
  'resource_ids[]',
  'song_category_ids[]',
  'wiki_category_ids[]',
  'domain_types[]',
  'ids[]',
  'from',
  'to',
  'page',
  'limit',
  'canceled',
  'direction',
  'include',
  'include[]',
  'query',
  'name',
  'calendarId',
  'appointmentId',
  'eventId',
  'songId',
] as const;

/** What one call may end in, as the stages of the run compare it. */
const resultWords = [
  'verweigert',
  'erlaubt mit Einträgen',
  'erlaubt leer',
  'nicht gefunden',
  'Fehler',
  'nicht dokumentiert',
  'nicht deklariert',
  'nicht aufgerufen',
  'unbekannte ID vorhanden',
  'nicht geprüft',
] as const;

type ResultWord = (typeof resultWords)[number];

const words = [
  ...reportWords,
  ...countClasses,
  ...resultWords,
  ...domainLabels,
  ...domainOperations,
  ...parameterTypes,
  'p1',
  'probe',
  '09-domains-read',
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
  'domaenentypen',
  'keine Aufzählung',
  'anderer Wert',
  'weitereWerte',
  'ergebnisse',
  'sichtbar',
  'vorkommen',
  'treffer',
  'personP1',
  'personen',
  'meta',
  'count',
  'all',
  'pagination',
  'listen',
  'anfragen',
  'seite',
  'limit',
  'limitEcho',
  'kein Echo',
  'keiner',
  'keine Liste',
  'nicht gesendet',
  'strukturen',
  'fehler',
  'antwort',
  'fehlerschluessel',
  'echo',
  'verborgen',
  'anzahl',
  'kennung',
  'keine',
  'echt',
  'Platzhalter',
  'nicht vergleichbar',
  'positive Zahl',
  'keine positive Zahl',
];

/** One query of a request, in order. */
type Query = readonly (readonly [string, string])[];

/** A domain type the probe sends: a word of the product, never free text. */
const domainTypePattern = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

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

// An ID as a whole number or as the text of one; the global search names
// objects by text.
const idText = (value: unknown): string | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value)
      ? value
      : undefined;

/** What one answer holds of IDs and persons, never shown as such. */
interface Scan {
  /** How many objects carry each `id`. */
  readonly ids: ReadonlyMap<string, number>;
  /** Every `domainIdentifier` that is an ID, as the global search names its hits. */
  readonly identifiers: ReadonlySet<string>;
  /** IDs of persons: every `personId`, and the identifier of an object of the type person. */
  readonly personIds: ReadonlySet<string>;
  /** How many objects have the domain type person. */
  readonly persons: number;
}

/**
 * Walks through the whole answer. An object «shows» a synthetic object if
 * its `id` is the ID of that object, wherever it sits: an event names its
 * services and an appointment its calendar in nested objects.
 *
 * @param body - Parsed body of an answer.
 * @returns The IDs and persons it holds.
 */
function scan(body: unknown): Scan {
  const ids = new Map<string, number>();
  const identifiers = new Set<string>();
  const personIds = new Set<string>();
  let persons = 0;
  const visit = (value: unknown, depth: number): void => {
    if (depth > maxScanDepth) {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value as readonly unknown[]) {
        visit(item, depth + 1);
      }
      return;
    }
    if (!isObject(value)) {
      return;
    }
    const id = idText(value['id']);
    if (id !== undefined) {
      ids.set(id, (ids.get(id) ?? 0) + 1);
    }
    const personId = idText(value['personId']);
    if (personId !== undefined) {
      personIds.add(personId);
    }
    const identifier = idText(value['domainIdentifier']);
    if (identifier !== undefined) {
      identifiers.add(identifier);
    }
    if (value['domainType'] === 'person') {
      persons += 1;
      if (identifier !== undefined) {
        personIds.add(identifier);
      }
    }
    for (const item of Object.values(value)) {
      visit(item, depth + 1);
    }
  };
  visit(body, 0);
  return { ids, identifiers, personIds, persons };
}

/**
 * What the assignments of an event show of a person whose name a service
 * hides. On the test instance such an assignment carried a person without
 * a first name (`docs/research/churchtools-api.md`, F37). The rest is
 * compared in memory with the names of the synthetic persons; only the
 * outcome for the first such assignment appears, never a name or an ID.
 *
 * @param response - The answer of `GET /api/events/{eventId}`, if any.
 * @returns «unbekannt» without an answer 200, «keine» without such an
 *   assignment, else how many there are, whether the name is real and
 *   whether the person carries a positive ID.
 */
function describeHidden(response: ProbeResponse | undefined): Json {
  if (response?.status !== 200 || response.kind !== 'JSON') {
    return 'unbekannt';
  }
  const data = dataOf(response);
  const assignments = isObject(data) ? data['eventServices'] : undefined;
  if (!Array.isArray(assignments)) {
    return 'unbekannt';
  }
  const reduced = (assignments as readonly unknown[]).filter((entry) => {
    const person = isObject(entry) ? entry['person'] : undefined;
    const attributes = isObject(person)
      ? person['domainAttributes']
      : undefined;
    return isObject(attributes) && attributes['firstName'] === '';
  });
  const [first] = reduced;
  if (!isObject(first)) {
    return 'keine';
  }
  const id = first['personId'];
  return {
    anzahl: countClass(reduced.length),
    name: hiddenNameIn(first['person']),
    kennung:
      typeof id === 'number' && Number.isInteger(id) && id > 0
        ? 'positive Zahl'
        : 'keine positive Zahl',
  };
}

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

interface Documented {
  readonly operation: JsonObject;
  readonly pathItem: JsonObject | undefined;
  readonly query: ReadonlySet<string>;
}

// The parameters of an operation together with those of its path item.
function parametersOf(schemas: Schemas, entry: Documented): JsonObject[] {
  const found: JsonObject[] = [];
  for (const source of [
    entry.pathItem?.['parameters'],
    entry.operation['parameters'],
  ]) {
    if (Array.isArray(source)) {
      for (const item of source) {
        const parameter = schemas.resolve(item);
        if (parameter !== undefined) {
          found.push(parameter);
        }
      }
    }
  }
  return found;
}

function declaredMaximum(
  schemas: Schemas,
  entry: Documented,
  name: string,
): number | undefined {
  const parameter = parametersOf(schemas, entry).find(
    (item) => item['name'] === name && item['in'] === 'path',
  );
  if (parameter === undefined) {
    return undefined;
  }
  const maximum = (schemas.resolve(parameter['schema']) ?? parameter)[
    'maximum'
  ];
  return typeof maximum === 'number' ? maximum : undefined;
}

/**
 * Reads the values the instance declares for a query parameter that takes
 * a list, such as `domain_types[]`.
 *
 * @param schemas - The schemas of the instance.
 * @param entry - The documented operation.
 * @param name - Name of the query parameter.
 * @returns The values, or `undefined` without an enumeration.
 */
function enumValues(
  schemas: Schemas,
  entry: Documented,
  name: string,
): readonly unknown[] | undefined {
  const parameter = parametersOf(schemas, entry)
    .filter((item) => item['name'] === name && item['in'] === 'query')
    .at(-1);
  if (parameter === undefined) {
    return undefined;
  }
  const schema = schemas.resolve(parameter['schema']) ?? parameter;
  const items = schemas.resolve(schema['items']);
  const values: unknown = schema['enum'] ?? items?.['enum'];
  return Array.isArray(values) && values.length > 0
    ? (values as readonly unknown[])
    : undefined;
}

function fixedStatus(guard: Guard, status: number): number {
  guard.allowFixed(status);
  return status;
}

/**
 * Sends the calls of {@link pagingSteps} and tells, for each, the status,
 * the class of the entries and the echo of `limit`.
 *
 * @param reader - The client for personal data.
 * @param guard - The guard of the run.
 * @param entry - The documented list, if the instance documents it.
 * @param path - Path of the list.
 * @param base - The filter every call of the list carries.
 * @param onAnswer - Receives every answer, for its errors.
 * @returns The form of meta and one entry per call, or why there is none.
 */
async function describePaging(
  reader: Client,
  guard: Guard,
  entry: Documented | undefined,
  path: string,
  base: Query,
  onAnswer: (response: ProbeResponse) => void,
): Promise<Json> {
  if (entry === undefined) {
    return 'nicht dokumentiert';
  }
  if (!entry.query.has('page') || !entry.query.has('limit')) {
    return 'nicht deklariert';
  }
  let meta: Json = 'unbekannt';
  const anfragen: Json[] = [];
  for (const [page, limit] of pagingSteps) {
    const response = await reader.get({
      path,
      query: [
        ...base,
        ...(page === undefined ? [] : [['page', String(page)] as const]),
        ['limit', String(limit)],
      ],
    });
    onAnswer(response);
    if (meta === 'unbekannt' && response.status === 200) {
      meta = metaForm(response);
    }
    const echo = pagination(response.body)?.['limit'];
    const count = entries(response.body);
    anfragen.push({
      seite: exact(guard, page, 'nicht gesendet'),
      limit: exact(guard, limit, 'keiner'),
      status: fixedStatus(guard, response.status),
      eintraege: count === undefined ? 'keine Liste' : countClass(count),
      limitEcho: exact(
        guard,
        typeof echo === 'number' && Number.isSafeInteger(echo)
          ? echo
          : undefined,
        'kein Echo',
      ),
    });
  }
  return { meta, anfragen };
}

/** The probe, for tests and for {@link main}. */
export const probe: ProbeDefinition = {
  name: '09-domains-read',
  state: 'read',
  personalData: true,
  async run({ guard, state, persons, env }): Promise<Json> {
    guard.allowFixed(...words, ...knownParameters);
    if (state === undefined || persons === undefined) {
      throw new SpikeError('INTERN');
    }
    // Every ID before the first request, so a missing one sends nothing.
    const ids = readDomainIds(env);
    const { personId } = persons.settings;
    const pass = await passPersonsGate(
      { state, readRights: domainReadRights },
      persons.access,
    );
    const reader = pass.client;
    const document = state.specification;
    const schemas = new Schemas(document);
    const { from, to } = timeWindow(new Date());
    // The dates are values of the run, as the IDs are; they stay out too.
    guard.block(from);
    guard.block(to);

    const documented = new Map<DomainOperation, Documented>();
    for (const name of domainOperations) {
      const { method, template } = operations[name];
      const operation = findOperation(document, method, template);
      if (operation !== undefined) {
        const pathItem = findPathItem(document, method, template);
        documented.set(name, {
          operation,
          pathItem,
          query: new Set(
            schemas
              .parameterDetails(operation, pathItem)
              .filter((detail) => detail.location === 'query')
              .map((detail) => detail.name),
          ),
        });
      }
    }

    const ergebnisse: Record<string, Json> = {};
    const sichtbar: Record<string, Json> = {};
    const vorkommen: Record<string, Json> = {};
    const treffer: Record<string, Json> = {};
    const personP1: Record<string, Json> = {};
    const personen: Record<string, Json> = {};
    const meta: Record<string, Json> = {};
    const strukturen: Record<string, Json> = {};
    const fehler: Record<string, Json> = {};
    const unbekannt: Record<string, Json> = {};

    const fixed = (text: string): string => {
      guard.allowFixed(text);
      return text;
    };
    const skip = (target: string, word: ResultWord): void => {
      ergebnisse[fixed(target)] = word;
    };
    const describe = (name: DomainOperation, response: ProbeResponse): Json =>
      describeResponse(response, {
        guard,
        schemas,
        operation: documented.get(name)?.operation,
        textFormats: true,
        maxFields,
      });
    // The first error answer per operation and status, with its structure.
    const recordError = (
      name: DomainOperation,
      response: ProbeResponse,
      sent?: string,
    ): void => {
      if (response.status < 400) {
        return;
      }
      const errorKey = fixed(`${name} ${String(response.status)}`);
      if (fehler[errorKey] !== undefined) {
        return;
      }
      fehler[errorKey] = {
        antwort: describe(name, response),
        fehlerschluessel: describeErrorKeys(response.body, guard),
        ...(sent === undefined
          ? {}
          : { echo: describeEcho(response.body, sent, guard) }),
      };
    };
    // The parameters of a call the operation declares; the others stay out.
    const declared = (name: DomainOperation, query: Query): Query =>
      query.filter(([key]) => documented.get(name)?.query.has(key) === true);
    // Whether the operation declares what a call cannot do without.
    const needs = (
      target: string,
      name: DomainOperation,
      keys: readonly string[],
    ): boolean => {
      const entry = documented.get(name);
      if (entry === undefined || keys.every((key) => entry.query.has(key))) {
        return true;
      }
      skip(target, 'nicht deklariert');
      return false;
    };
    const withoutEntries = new Set<DomainOperation>();

    // Sends one call and records its result, which synthetic objects and
    // persons it shows, the form of its meta and the structure of one 200
    // per operation: the first with entries, or else the first.
    const call = async (
      target: string,
      name: DomainOperation,
      path: string,
      query: Query = [],
      options: {
        readonly sent?: string;
        readonly unknown?: boolean;
        /** For the global search: the labels its type checks, by `domainIdentifier`. */
        readonly identifiers?: readonly DomainLabel[];
      } = {},
    ): Promise<ProbeResponse | undefined> => {
      if (!documented.has(name)) {
        skip(target, 'nicht dokumentiert');
        return undefined;
      }
      const response = await reader.get({ path, query });
      const key = fixed(target);
      if (options.unknown === true) {
        // An unknown ID that exists names an object nobody chose; nothing
        // of it is read.
        if (response.status === 200) {
          ergebnisse[key] = 'unbekannte ID vorhanden';
          return undefined;
        }
        ergebnisse[key] = resultOf(response);
        unbekannt[fixed(name)] = {
          antwort: describe(name, response),
          fehlerschluessel: describeErrorKeys(response.body, guard),
        };
        return undefined;
      }
      ergebnisse[key] = resultOf(response);
      const read = response.status === 200 && response.kind === 'JSON';
      const found = read ? scan(response.body) : undefined;
      const expected = options.identifiers ?? expectedLabels[name];
      const shows = (label: DomainLabel): boolean =>
        (options.identifiers === undefined
          ? found?.ids.has(String(ids[label]))
          : found?.identifiers.has(String(ids[label]))) === true;
      if (expected.length > 0) {
        sichtbar[key] = Object.fromEntries(
          expected.map((label) => [
            label,
            found === undefined ? 'unbekannt' : shows(label) ? 'ja' : 'nein',
          ]),
        );
      }
      if (name === 'search' || name === 'wikiSearch') {
        const data = dataOf(response);
        treffer[key] =
          found === undefined
            ? 'unbekannt'
            : Array.isArray(data)
              ? countClass(data.length)
              : 'keine Liste';
      }
      if (countedOperations.has(name)) {
        vorkommen[key] = Object.fromEntries(
          expected.map((label) => [
            label,
            found === undefined
              ? 'unbekannt'
              : countClass(found.ids.get(String(ids[label])) ?? 0),
          ]),
        );
      }
      const own = String(personId);
      personP1[key] =
        found === undefined
          ? 'unbekannt'
          : found.ids.has(own) || found.personIds.has(own)
            ? 'ja'
            : 'nein';
      personen[key] =
        found === undefined ? 'unbekannt' : countClass(found.persons);
      if (read && meta[name] === undefined && Array.isArray(dataOf(response))) {
        meta[name] = metaForm(response);
      }
      const hasEntries = ergebnisse[key] === 'erlaubt mit Einträgen';
      if (
        response.status === 200 &&
        (strukturen[name] === undefined ||
          (hasEntries && withoutEntries.has(name)))
      ) {
        strukturen[name] = describe(name, response);
        if (hasEntries) {
          withoutEntries.delete(name);
        } else {
          withoutEntries.add(name);
        }
      }
      recordError(name, response, options.sent);
      return response;
    };

    const window: Query = [
      ['from', from],
      ['to', to],
    ];

    // Calendars and appointments.
    await call('calendars', 'calendars', operations.calendars.template);
    if (
      needs('calendarAppointments', 'calendarAppointments', ['calendar_ids[]'])
    ) {
      await call(
        'calendarAppointments',
        'calendarAppointments',
        operations.calendarAppointments.template,
        [
          ['calendar_ids[]', String(ids.c1)],
          ...declared('calendarAppointments', window),
        ],
      );
    }
    for (const label of ['t1', 't2'] as const) {
      await call(
        `calendarAppointment:${label}`,
        'calendarAppointment',
        pathFor(operations.calendarAppointment.template, ids.c1, ids[label]),
      );
    }

    // Events, the synthetic event, its agenda and the songs of its agenda.
    await call(
      'events',
      'events',
      operations.events.template,
      declared('events', window),
    );
    const verborgen = describeHidden(
      await call(
        'event:e1',
        'event',
        pathFor(operations.event.template, ids.e1),
      ),
    );
    await call(
      'eventAgenda:e1',
      'eventAgenda',
      pathFor(operations.eventAgenda.template, ids.e1),
    );
    await call(
      'eventAgendaSongs:e1',
      'eventAgendaSongs',
      pathFor(operations.eventAgendaSongs.template, ids.e1),
    );

    // Services, resources and bookings.
    await call('services', 'services', operations.services.template);
    await call(
      'serviceGroups',
      'serviceGroups',
      operations.serviceGroups.template,
    );
    await call(
      'resourceTypes',
      'resourceTypes',
      operations.resourceTypes.template,
    );
    await call('resources', 'resources', operations.resources.template);
    if (needs('bookings', 'bookings', ['resource_ids[]'])) {
      await call('bookings', 'bookings', operations.bookings.template, [
        ['resource_ids[]', String(ids.r1)],
        ...declared('bookings', window),
      ]);
    }

    // Songs of the synthetic category, both songs and their arrangements.
    const songFilter = declared('songs', [
      ['song_category_ids[]', String(ids.sc1)],
    ]);
    await call('songs', 'songs', operations.songs.template, songFilter);
    // The search a tool for songs needs: the fixed term, no category.
    if (needs('songsQuery', 'songs', ['query'])) {
      await call(
        'songsQuery',
        'songs',
        operations.songs.template,
        [['query', domainsQuery]],
        { sent: domainsQuery },
      );
    }
    for (const label of ['l1', 'l2'] as const) {
      await call(
        `song:${label}`,
        'song',
        pathFor(operations.song.template, ids[label]),
      );
      await call(
        `songArrangements:${label}`,
        'songArrangements',
        pathFor(operations.songArrangements.template, ids[label]),
      );
    }

    // The search of the wiki, in the identification category, and once
    // without a category: the guard has made sure the account sees no
    // other one, so this shows whether the search needs the filter.
    if (needs('wikiSearch', 'wikiSearch', ['query'])) {
      await call(
        'wikiSearch',
        'wikiSearch',
        operations.wikiSearch.template,
        [
          ['query', marker],
          ...declared('wikiSearch', [
            ['wiki_category_ids[]', String(pass.identification)],
          ]),
        ],
        { sent: marker },
      );
      await call(
        'wikiSearchAll',
        'wikiSearch',
        operations.wikiSearch.template,
        [['query', marker]],
        { sent: marker },
      );
    }

    // The global search, once per domain type the instance declares.
    const searchEntry = documented.get('search');
    let domaenentypen: Json;
    if (searchEntry === undefined) {
      skip('search', 'nicht dokumentiert');
      domaenentypen = 'nicht dokumentiert';
    } else if (!needs('search', 'search', ['query'])) {
      domaenentypen = 'nicht aufgerufen';
    } else {
      const values = searchEntry.query.has('domain_types[]')
        ? enumValues(schemas, searchEntry, 'domain_types[]')
        : undefined;
      if (values === undefined) {
        domaenentypen = searchEntry.query.has('domain_types[]')
          ? 'keine Aufzählung'
          : 'nicht deklariert';
        await call(
          'search',
          'search',
          operations.search.template,
          [['query', domainsQuery]],
          { sent: domainsQuery },
        );
      } else {
        const types: Record<string, Json> = {};
        for (const [index, value] of values
          .slice(0, maxDomainTypes)
          .entries()) {
          const label = fixed(`d${String(index + 1)}`);
          if (typeof value !== 'string' || !domainTypePattern.test(value)) {
            types[label] = 'anderer Wert';
            skip(`search:${label}`, 'nicht aufgerufen');
            continue;
          }
          // A word of the document, like a key it declares: the answers
          // carry it as a value, which must not withhold it.
          guard.allowDeclared(value);
          types[label] = value;
          await call(
            `search:${label}`,
            'search',
            operations.search.template,
            [
              ['query', domainsQuery],
              ['domain_types[]', value],
            ],
            { sent: domainsQuery, identifiers: labelsForDomainType(value) },
          );
        }
        if (values.length > maxDomainTypes) {
          types['weitereWerte'] = countClass(values.length - maxDomainTypes);
        }
        domaenentypen = types;
      }
    }

    // Unknown objects: a fixed ID no test instance reaches.
    const taken = [
      personId,
      persons.settings.groupId,
      persons.settings.otherGroupId,
      ...Object.values(ids),
    ].includes(unknownId);
    for (const [target, name, parameter, path] of [
      [
        'event:unbekannt',
        'event',
        'eventId',
        () => pathFor(operations.event.template, unknownId),
      ],
      [
        'song:unbekannt',
        'song',
        'songId',
        () => pathFor(operations.song.template, unknownId),
      ],
      [
        'calendarAppointment:unbekannt',
        'calendarAppointment',
        'appointmentId',
        () =>
          pathFor(operations.calendarAppointment.template, ids.c1, unknownId),
      ],
    ] as const) {
      const entry = documented.get(name);
      const maximum =
        entry === undefined
          ? undefined
          : declaredMaximum(schemas, entry, parameter);
      if (taken || (maximum !== undefined && maximum < unknownId)) {
        skip(target, 'nicht geprüft');
        continue;
      }
      await call(target, name, path(), [], { unknown: true });
    }

    // How events and songs page, and where limit ends.
    const listen: Record<string, Json> = {
      events: await describePaging(
        reader,
        guard,
        documented.get('events'),
        operations.events.template,
        declared('events', window),
        (response) => {
          recordError('events', response);
        },
      ),
      songs: await describePaging(
        reader,
        guard,
        documented.get('songs'),
        operations.songs.template,
        songFilter,
        (response) => {
          recordError('songs', response);
        },
      ),
    };

    return {
      probe: '09-domains-read',
      waechter: 'bestanden',
      rechte: describeEffectiveRights(pass.rights, guard, domainReadRights),
      operationen: Object.fromEntries(
        domainOperations.map((name) => [
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
      domaenentypen,
      ergebnisse,
      verborgen,
      sichtbar,
      vorkommen,
      treffer,
      personP1,
      personen,
      meta,
      listen,
      unbekannt,
      strukturen,
      fehler,
    };
  },
};

if (import.meta.main) {
  process.exitCode = await main(probe, import.meta.url);
}
