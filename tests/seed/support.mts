// A synthetic instance for the seed of the test instance. It keeps every
// object in memory, answers the operations the seed uses, and fills its
// answers with canary values that must never reach an output. Everything is
// made up at run time (see tests/fixtures/README.md); no real answer is
// copied.
import { randomInt, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { identificationCategoryName } from '../../scripts/spike/lib/gate.mts';
import type { FetchFunction } from '../../scripts/spike/lib/http.mts';
import {
  operations,
  seedOperations,
} from '../../scripts/spike/lib/operations.mts';
import {
  seedOwnReadParameters,
  seedReadParameters,
  seedWikiCategoryName,
} from '../../scripts/spike/lib/seed-gate.mts';
import {
  makeCanaries,
  privateFiles,
  type Canaries,
} from '../spike/support.mts';

/** The placeholder instance of the seed tests, on a reserved domain. */
export const seedOrigin = 'https://demo-tenant.example';

/** The switch that fits {@link seedOrigin}. */
export const seedSwitch = 'demo-tenant';

/** One request the synthetic instance received. */
export interface Call {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
}

type Item = Record<string, unknown>;

/** How the synthetic instance behaves. */
export interface InstanceOptions {
  /** Whether the identification category exists. Default: yes. */
  readonly identification?: boolean;
  /** Whether the account may edit the identification category. */
  readonly identificationEditable?: boolean;
  /** A further category the account can see. */
  readonly extraCategory?: string;
  /** Replaces `data` of the rights answer, given the identification category. */
  readonly rights?: (
    identification: number,
  ) => Record<string, Record<string, unknown>>;
  /** Operations the OpenAPI document leaves out, as `method path` without `/api`. */
  readonly undocumented?: readonly string[];
  /** Query parameters the document leaves out, as `method path name`. */
  readonly undeclared?: readonly string[];
  /** Whether a new group gets the account that created it as a member. */
  readonly creatorJoinsGroups?: boolean;
  /** Requests the instance refuses, as `METHOD /api/path` with `{}` for IDs. */
  readonly refuse?: ReadonlyMap<string, number>;
  /** A write at which the network fails, in the same form. */
  readonly failAt?: string;
  /** Whether a new service sends mails, whatever the seed asks for. */
  readonly servicesSendMails?: boolean;
}

/** The seed account of the synthetic instance. */
export const accountId = 38;

/** The department of the seed in the tests. */
export const departmentId = 2;

const pathOf = (template: string): string => template.slice('/api'.length);

/**
 * Builds the OpenAPI document of the synthetic instance: every operation
 * the seed reads or writes, with the query parameters it sends.
 *
 * @param options - What the document leaves out.
 * @returns The document.
 */
export function seedDocument(options: InstanceOptions = {}): unknown {
  const paths: Record<string, Record<string, unknown>> = {};
  const add = (
    method: string,
    template: string,
    query: readonly string[],
  ): void => {
    const path = pathOf(template);
    if (options.undocumented?.includes(`${method} ${path}`) === true) {
      return;
    }
    paths[path] ??= {};
    paths[path][method] = {
      parameters: query
        .filter(
          (name) =>
            options.undeclared?.includes(`${method} ${path} ${name}`) !== true,
        )
        .map((name) => ({ name, in: 'query', schema: { type: 'string' } })),
      responses: {},
    };
  };
  add('get', operations.info.template, []);
  add('get', operations.whoami.template, ['only_allow_authenticated']);
  add('get', operations.wikiCategories.template, []);
  add('get', operations.permissionsGlobal.template, []);
  for (const [name, query] of Object.entries(seedReadParameters)) {
    const entry = operations[name as keyof typeof seedReadParameters];
    add(entry.method, entry.template, query);
  }
  for (const [name, entry] of Object.entries(seedOperations)) {
    const fixed: readonly (readonly [string, string])[] =
      'query' in entry ? entry.query : [];
    const own: readonly string[] = Object.hasOwn(seedOwnReadParameters, name)
      ? seedOwnReadParameters[name as keyof typeof seedOwnReadParameters]
      : [];
    add(entry.method, entry.template, [
      ...fixed.map(([parameter]) => parameter),
      ...own,
    ]);
  }
  return {
    openapi: '3.0.3',
    info: { title: 'Synthetic document of the seed', version: '0.0.0' },
    servers: [{ url: '/api' }],
    paths,
  };
}

/**
 * The rights the seed account holds on ChurchTools 3.138, as
 * `GET /api/permissions/global` reports them, with made-up IDs.
 *
 * @param identification - ID of the identification category.
 * @param seedCategory - ID of the category of the seed, once the account sees it.
 * @returns The `data` of the rights answer.
 */
export function seedAccountRights(
  identification: number,
  seedCategory?: number,
): Record<string, Record<string, unknown>> {
  const all = [3, 5, 8];
  return {
    churchcore: { 'administer settings': false, 'view links': [] },
    churchdb: {
      view: true,
      'view alldata': [departmentId],
      'security level person': [1],
      'create person': true,
      'write access': true,
      'delete persons': false,
      'edit masterdata': true,
      'create groups of grouptype': all,
      'view groups of grouptype': all,
      'edit group memberships of grouptype': all,
      'edit group memberships': true,
      'administer groups': false,
    },
    churchgroup: {
      view: true,
      'create groups of grouptype': all,
      'view groups of grouptype': all,
      'edit group memberships of grouptype': all,
      'delete group': [],
      'edit masterdata': true,
    },
    churchcal: {
      view: true,
      'view category': all,
      'edit category': all,
      'admin church category': true,
      'admin personal category': false,
    },
    churchresource: {
      view: true,
      'view resource': all,
      'create bookings': all,
      'administer bookings': all,
      'edit masterdata': true,
    },
    churchservice: {
      view: true,
      'view servicegroup': all,
      'edit servicegroup': all,
      'view events': all,
      'edit events': all,
      'view agenda': all,
      'edit agenda': all,
      'view songcategory': all,
      'edit songcategory': all,
      'edit masterdata': true,
      'edit template': false,
    },
    churchwiki: {
      view: true,
      'view category':
        seedCategory === undefined
          ? [identification]
          : [identification, seedCategory],
      'edit category': seedCategory === undefined ? [] : [seedCategory],
      'edit masterdata': true,
    },
    finance: { view: false, 'view accounting period': [] },
  };
}

/** The synthetic instance and what it records. */
export class SeedInstance {
  readonly calls: Call[] = [];
  readonly canaries: Canaries;
  readonly identification: number;
  private nextId = randomInt(1000, 5000);
  private options: InstanceOptions;

  /** The category of the seed, once created, and whether the account has rights on it. */
  seedCategory: { id: number; visible: boolean } | undefined;

  readonly store = {
    statuses: [] as Item[],
    groupTypes: [] as Item[],
    calendars: [] as Item[],
    resourceTypes: [] as Item[],
    resources: [] as Item[],
    serviceGroups: [] as Item[],
    services: [] as Item[],
    songCategories: [] as Item[],
    persons: [] as Item[],
    groups: [] as Item[],
    members: new Map<number, Set<number>>(),
    appointments: [] as Item[],
    events: [] as Item[],
    bookings: [] as Item[],
    songs: [] as Item[],
    pages: [] as Item[],
    agendas: new Map<number, Item[]>(),
  };

  /**
   * Builds an instance, empty apart from the identification category and
   * objects made by hand that the seed must never touch.
   *
   * @param options - How the instance behaves.
   */
  constructor(options: InstanceOptions = {}) {
    this.options = options;
    this.canaries = makeCanaries();
    this.identification = this.id();
    // Objects made by hand for the probes, in their own calendar and song
    // category, some with titles of the seed.
    const otherCalendar = this.id();
    this.store.calendars.push({
      id: otherCalendar,
      name: 'Synthetischer Kalender',
    });
    this.store.appointments.push({
      id: this.id(),
      calendarId: otherCalendar,
      title: 'Seedprobe Gottesdienst',
    });
    const otherCategory = this.id();
    this.store.songCategories.push({ id: otherCategory, name: 'Synthetisch' });
    this.store.songs.push({
      id: this.id(),
      name: 'Seedprobe Lied A',
      categoryId: otherCategory,
      arrangements: [],
    });
    this.store.persons.push({
      id: this.id(),
      firstName: 'Anna',
      lastName: 'Spikeprobe',
      email: this.canaries.personEmail,
    });
  }

  private id(): number {
    this.nextId += randomInt(1, 7);
    return this.nextId;
  }

  /**
   * Changes how the instance behaves from now on, as between two runs.
   *
   * @param options - The options that change.
   */
  behave(options: InstanceOptions): void {
    this.options = { ...this.options, ...options };
  }

  /**
   * Gives the account the rights on the category of the seed, as a person
   * does after the first run.
   */
  grantSeedCategory(): void {
    if (this.seedCategory !== undefined) {
      this.seedCategory.visible = true;
    }
  }

  /**
   * Lists the writes the instance received.
   *
   * @returns Every request that is no GET.
   */
  writes(): Call[] {
    return this.calls.filter((call) => call.method !== 'GET');
  }

  private answer(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        'content-type': 'application/json',
        'x-kanarie': this.canaries.headerValue,
      },
    });
  }

  private list(items: readonly Item[]): Response {
    return this.answer({
      data: items.map((item) => ({ ...item, notiz: this.canaries.personName })),
      meta: { count: items.length, pagination: { current: 1, lastPage: 1 } },
    });
  }

  private created(item: Item, status = 201): Response {
    return this.answer(
      { data: { ...item, notiz: this.canaries.groupName } },
      status,
    );
  }

  private gone(): Response {
    return new Response(null, { status: 204 });
  }

  private categories(): Item[] {
    const list: Item[] = [];
    if (this.options.identification !== false) {
      const editable = this.options.identificationEditable === true;
      list.push({
        id: this.identification,
        name: identificationCategoryName,
        permissions: { canEdit: editable, canDelete: editable },
      });
    }
    if (this.seedCategory?.visible === true) {
      list.push({
        id: this.seedCategory.id,
        name: seedWikiCategoryName,
        permissions: { canEdit: true, canDelete: false },
      });
    }
    if (this.options.extraCategory !== undefined) {
      list.push({
        id: this.identification + 1,
        name: this.options.extraCategory,
        permissions: { canEdit: false, canDelete: false },
      });
    }
    return list;
  }

  /** The fetch function the seed uses in the tests. */
  readonly fetch: FetchFunction = (input, init) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const body: unknown =
      typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const path = url.pathname;
    this.calls.push({ method, path, query: url.searchParams, body });
    const key = `${method} ${path
      .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27}$/i, '/{}')
      .replace(/\/\d+/g, '/{}')}`;
    if (this.options.failAt === key) {
      return Promise.reject(
        Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      );
    }
    const refused = this.options.refuse?.get(key);
    if (refused !== undefined) {
      return Promise.resolve(
        this.answer({ message: this.canaries.personName }, refused),
      );
    }
    return Promise.resolve(this.route(method, path, url.searchParams, body));
  };

  private route(
    method: string,
    path: string,
    query: URLSearchParams,
    rawBody: unknown,
  ): Response {
    const body = (rawBody ?? {}) as Item;
    const parts = path.split('/').slice(2);
    const num = (index: number): number => Number(parts[index]);
    const s = this.store;
    if (path === '/system/runtime/swagger/openapi.json') {
      return this.answer(seedDocument(this.options));
    }
    if (path === '/api/info') {
      return this.answer({
        version: '3.138.0',
        siteName: this.canaries.groupName,
      });
    }
    if (path === '/api/whoami') {
      return this.answer({
        data: { id: accountId, firstName: this.canaries.personName },
      });
    }
    if (path === '/api/permissions/global') {
      return this.answer({
        data:
          this.options.rights?.(this.identification) ??
          seedAccountRights(
            this.identification,
            this.seedCategory?.visible === true
              ? this.seedCategory.id
              : undefined,
          ),
      });
    }
    if (path === '/api/wiki/categories') {
      if (method === 'GET') {
        return this.answer({
          data: this.categories(),
          meta: { count: 1 },
          permissions: { editMasterData: true },
        });
      }
      const id = this.id();
      this.seedCategory = { id, visible: false };
      return this.created({ id, name: body['name'] });
    }
    const simple: Record<string, Item[]> = {
      '/api/statuses': s.statuses,
      '/api/group/grouptypes': s.groupTypes,
      '/api/calendars': s.calendars,
      '/api/resourcetypes': s.resourceTypes,
      '/api/resources': s.resources,
      '/api/servicegroups': s.serviceGroups,
      '/api/services': s.services,
      '/api/song/categories': s.songCategories,
    };
    const collection = simple[path];
    if (collection !== undefined) {
      if (method === 'GET') {
        return this.list(collection);
      }
      const item: Item = { ...body, id: this.id() };
      if (path === '/api/services' && this.options.servicesSendMails === true) {
        item['sendServiceRequestEmails'] = true;
      }
      collection.push(item);
      return this.created(item);
    }
    if (path === '/api/persons') {
      if (method === 'GET') {
        const last = query.get('lastName');
        return this.list(
          s.persons.filter(
            (person) => last === null || person['lastName'] === last,
          ),
        );
      }
      const item: Item = { ...body, id: this.id() };
      s.persons.push(item);
      return this.created(item, 200);
    }
    if (path === '/api/groups') {
      if (method === 'GET') {
        const type = Number(query.get('group_type_ids[]'));
        return this.list(
          s.groups.filter((group) => group['groupTypeId'] === type),
        );
      }
      const id = this.id();
      const item: Item = { ...body, id };
      s.groups.push(item);
      s.members.set(
        id,
        new Set(this.options.creatorJoinsGroups === true ? [accountId] : []),
      );
      return this.created(item);
    }
    if (parts[0] === 'groups' && parts[2] === 'members') {
      const members = s.members.get(num(1));
      if (members === undefined) {
        return this.answer({}, 404);
      }
      if (method === 'GET') {
        return this.list([...members].map((personId) => ({ personId })));
      }
      if (method === 'PUT') {
        members.add(num(3));
        return this.created({ personId: num(3) }, 200);
      }
      members.delete(num(3));
      return this.gone();
    }
    if (parts[0] === 'calendars' && parts[2] === 'appointments') {
      return this.appointments(method, num(1), num(3), body);
    }
    if (path === '/api/events' && method === 'GET') {
      // As on the instance, the list leaves the service requests out; only
      // the single event carries them.
      return this.list(
        s.events.map((event) =>
          Object.fromEntries(
            Object.entries(event).filter(([key]) => key !== 'eventServices'),
          ),
        ),
      );
    }
    if (parts[0] === 'events') {
      return this.event(method, parts, body);
    }
    if (path === '/api/bookings') {
      if (method === 'GET') {
        const resource = Number(query.get('resource_ids[]'));
        return this.list(
          s.bookings
            .filter((item) => item['resourceId'] === resource)
            .map((item) => ({ booking: { base: item } })),
        );
      }
      const item: Item = { ...body, id: this.id() };
      s.bookings.push(item);
      return this.created(item);
    }
    if (parts[0] === 'bookings' && method === 'DELETE') {
      return this.remove(s.bookings, (item) => item['id'] === num(1));
    }
    if (path === '/api/songs') {
      if (method === 'GET') {
        const category = Number(query.get('song_category_ids[]'));
        return this.list(
          s.songs.filter((item) => item['categoryId'] === category),
        );
      }
      const item: Item = { ...body, id: this.id(), arrangements: [] };
      s.songs.push(item);
      return this.created(item);
    }
    if (parts[0] === 'songs') {
      if (method === 'DELETE') {
        return this.remove(s.songs, (item) => item['id'] === num(1));
      }
      const song = s.songs.find((item) => item['id'] === num(1));
      if (song === undefined) {
        return this.answer({}, 404);
      }
      const item = { ...body, id: this.id() };
      (song['arrangements'] as Item[]).push(item);
      return this.created(item);
    }
    if (
      parts[0] === 'wiki' &&
      parts[1] === 'categories' &&
      parts[3] === 'pages'
    ) {
      const categoryId = num(2);
      if (method === 'GET') {
        return this.list(
          s.pages.filter((item) => item['categoryId'] === categoryId),
        );
      }
      if (method === 'DELETE') {
        return this.remove(s.pages, (item) => item['guid'] === parts[4]);
      }
      const guid = randomUUID();
      s.pages.push({ ...body, guid, categoryId });
      return this.created({ guid, title: body['title'] });
    }
    return this.answer({ message: this.canaries.personName }, 404);
  }

  private remove(items: Item[], matches: (item: Item) => boolean): Response {
    const index = items.findIndex(matches);
    if (index < 0) {
      return this.answer({}, 404);
    }
    items.splice(index, 1);
    return this.gone();
  }

  private appointments(
    method: string,
    calendarId: number,
    appointmentId: number,
    body: Item,
  ): Response {
    const s = this.store;
    if (method === 'GET') {
      return this.list(
        s.appointments
          .filter((item) => item['calendarId'] === calendarId)
          .flatMap((item) => [{ base: item }, { appointment: { base: item } }]),
      );
    }
    if (method === 'DELETE') {
      return this.remove(
        s.appointments,
        (item) => item['id'] === appointmentId,
      );
    }
    const id = this.id();
    const item: Item = {
      id,
      calendarId,
      title: body['title'],
      startDate: body['startDate'],
      endDate: body['endDate'],
    };
    s.appointments.push(item);
    for (const event of (body['events'] as Item[] | undefined) ?? []) {
      const services = (event['services'] as Item[] | undefined) ?? [];
      s.events.push({
        id: this.id(),
        appointmentId: id,
        name: body['title'],
        calendar: { domainIdentifier: String(calendarId) },
        eventServices: services.flatMap((service) =>
          Array.from({ length: Number(service['count']) }, () => ({
            id: this.id(),
            serviceId: service['serviceId'],
            personId: null,
          })),
        ),
      });
    }
    for (const booking of (body['bookings'] as Item[] | undefined) ?? []) {
      s.bookings.push({
        id: this.id(),
        resourceId: booking['resourceId'],
        title: body['title'],
      });
    }
    return this.created(item);
  }

  private event(
    method: string,
    parts: readonly string[],
    body: Item,
  ): Response {
    const s = this.store;
    const eventId = Number(parts[1]);
    const event = s.events.find((item) => item['id'] === eventId);
    if (event === undefined) {
      return this.answer({}, 404);
    }
    if (parts.length === 2 && method === 'GET') {
      return this.answer({ data: event });
    }
    if (parts.length === 2 && method === 'DELETE') {
      // As on ChurchTools 3.138, the appointment of the event stays.
      s.events.splice(s.events.indexOf(event), 1);
      return this.gone();
    }
    if (parts[2] === 'servicerequests') {
      const request = (event['eventServices'] as Item[]).find(
        (item) => item['id'] === Number(parts[3]),
      );
      if (request === undefined) {
        return this.answer({}, 404);
      }
      // As on ChurchTools 3.138, the update needs isAccepted and replaces
      // the request with a new record.
      if (typeof body['isAccepted'] !== 'boolean') {
        return this.answer({}, 400);
      }
      request['id'] = this.id();
      request['personId'] = body['personId'];
      request['isAccepted'] = body['isAccepted'];
      return this.created(request, 200);
    }
    const items = s.agendas.get(eventId) ?? [];
    s.agendas.set(eventId, items);
    if (parts[3] === 'items') {
      const item = { ...body, id: this.id() };
      items.push(item);
      return this.created(item);
    }
    return this.created({ id: this.id(), calendarId: body['calendarId'] }, 200);
  }
}

/** Everything one seed test needs. */
export interface SeedSetting {
  readonly instance: SeedInstance;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly scriptsFolder: string;
}

/**
 * Makes the files, environment and instance of one seed test.
 *
 * @param options - How the instance behaves.
 * @returns A fresh setting.
 */
export function seedSetup(options: InstanceOptions = {}): SeedSetting {
  const instance = new SeedInstance(options);
  const files = privateFiles(instance.canaries.token);
  return {
    instance,
    scriptsFolder: join(import.meta.dirname, '..', '..', 'scripts'),
    env: {
      ECCLIUM_SEED_BASE_URL: seedOrigin,
      ECCLIUM_SEED_TOKEN_FILE: files.tokenFile,
      ECCLIUM_SEED_ALLOW_WRITE: seedSwitch,
      ECCLIUM_SEED_DEPARTMENT_ID: String(departmentId),
      ECCLIUM_SEED_STATUS_ID: '0',
      ECCLIUM_SEED_PRIVACY_TYPE_ID: '3',
      ECCLIUM_SEED_PRIVACY_WHO_ID: '1',
      ECCLIUM_SEED_GROUP_STATUS_ID: '1',
      ECCLIUM_SEED_CAMPUS_ID: '2',
    },
  };
}
