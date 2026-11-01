// A synthetic instance for the probes of the write account. It keeps the
// pages of the write area in memory, answers the documented write
// operations, and fills every answer with canary values. Everything is made
// up at run time (see tests/fixtures/README.md); no real answer is copied.
import { randomBytes, randomInt } from 'node:crypto';
import { join } from 'node:path';

import { instanceId, type SpikeState } from '../../scripts/spike/lib/env.mts';
import { identificationCategoryName } from '../../scripts/spike/lib/gate.mts';
import type {
  CalendarArea,
  FetchFunction,
} from '../../scripts/spike/lib/http.mts';
import { asOpenApi } from '../../scripts/spike/lib/spec.mts';
import {
  forbiddenTexts,
  makeCanaries,
  privateFiles,
  specification,
  type Canaries,
} from './support.mts';

/**
 * The placeholder instance of the write tests. The README placeholder under
 * church.tools is refused by the guard, so these tests use a reserved
 * top-level domain.
 */
export const writeOrigin = 'https://demo-tenant.example';

/** The switch that fits {@link writeOrigin}. */
export const writeSwitch = 'demo-tenant';

/** Everything one write test needs. */
export interface WriteSetting {
  readonly canaries: Canaries;
  readonly writeCategory: number;
  readonly identification: number;
  readonly folder: string;
  readonly tokenFile: string;
  readonly stateFile: string;
  readonly writeStateFile: string;
  /** Calendar and resource of the probes. */
  readonly calendarArea: CalendarArea;
  /** Environment of a probe of the write account. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Environment of a probe of the write account with calendar and resource. */
  readonly calendarEnv: Readonly<Record<string, string | undefined>>;
  /** Environment of 00-inventory with the token of the write account. */
  readonly inventoryEnv: Readonly<Record<string, string | undefined>>;
  readonly forbidden: readonly string[];
}

/**
 * Makes the files and environment of one write test.
 *
 * @returns A fresh setting with random IDs and canaries.
 */
export function writeSetup(): WriteSetting {
  const canaries = makeCanaries();
  const writeCategory = randomInt(10_000, 50_000);
  const identification = writeCategory + randomInt(1, 1000);
  const files = privateFiles(canaries.token);
  const writeStateFile = join(files.folder, 'schreib-state.jsonl');
  const calendarArea = {
    calendar: randomInt(50_001, 60_000),
    resource: randomInt(60_001, 70_000),
  };
  const env = {
    ECCLIUM_SPIKE_BASE_URL: writeOrigin,
    ECCLIUM_SPIKE_ALLOW_WRITE: writeSwitch,
    ECCLIUM_SPIKE_WRITE_TOKEN_FILE: files.tokenFile,
    ECCLIUM_SPIKE_STATE_FILE: files.stateFile,
    ECCLIUM_SPIKE_WRITE_CATEGORY_ID: String(writeCategory),
    ECCLIUM_SPIKE_WRITE_STATE_FILE: writeStateFile,
  };
  return {
    canaries,
    writeCategory,
    identification,
    folder: files.folder,
    tokenFile: files.tokenFile,
    stateFile: files.stateFile,
    writeStateFile,
    calendarArea,
    env,
    calendarEnv: {
      ...env,
      ECCLIUM_SPIKE_WRITE_CALENDAR_ID: String(calendarArea.calendar),
      ECCLIUM_SPIKE_WRITE_RESOURCE_ID: String(calendarArea.resource),
    },
    inventoryEnv: {
      ECCLIUM_SPIKE_BASE_URL: writeOrigin,
      ECCLIUM_SPIKE_TOKEN_FILE: files.tokenFile,
      ECCLIUM_SPIKE_STATE_FILE: files.stateFile,
    },
    forbidden: forbiddenTexts(
      canaries,
      files.folder,
      String(writeCategory),
      String(identification),
      String(calendarArea.calendar),
      String(calendarArea.resource),
      'demo-tenant.example',
      writeSwitch,
    ),
  };
}

/**
 * The state 00-inventory would write for the synthetic instance.
 *
 * @param document - The OpenAPI document, by default the synthetic one.
 * @returns A state for {@link writeOrigin}.
 */
export function initialState(document: unknown = specification): SpikeState {
  const parsed = asOpenApi(document);
  if (parsed === undefined) {
    throw new Error('synthetic document is not accepted');
  }
  return {
    format: 'ecclium-spike-state.v1',
    instance: instanceId(writeOrigin),
    version: '3.137',
    specification: parsed,
  };
}

/** One version of a synthetic page. */
export interface SyntheticVersion {
  readonly version: number;
  readonly text: string | null;
  readonly isMarkdown: boolean;
  readonly modifiedDate: string;
}

/** A synthetic page of the write area. */
export interface SyntheticPage {
  readonly guid: string;
  readonly title: string;
  onStartpage: boolean;
  readonly versions: SyntheticVersion[];
}

/** One request the synthetic instance received. */
export interface WriteCall {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: string | undefined;
}

/** An appointment or booking of the synthetic instance. */
export interface SyntheticObject {
  readonly id: number;
  fields: Record<string, unknown>;
  version: number;
  modifiedDate: string;
  readonly createdBy: number;
  modifiedBy: number;
}

/** How the calendar and the resource of the synthetic instance behave. */
export interface CalendarOptions {
  /** Body of `GET /api/calendars`, instead of the probe calendar. */
  readonly calendars?: unknown;
  /** Body of `GET /api/resources`, instead of the probe resource. */
  readonly resources?: unknown;
  /** Titles of appointments in the probe calendar before the run. */
  readonly appointments?: readonly string[];
  /** Titles of bookings of the probe resource before the run. */
  readonly bookings?: readonly string[];
  /** The status a booking asked as approved gets. Default 1. */
  readonly approvedBecomes?: number;
  /** Whether a PUT keeps the fields it does not get. Default: cleared. */
  readonly putKeepsMissing?: boolean;
  /** Whether a PUT with a stale `version` in the body is refused with 409. */
  readonly honourVersion?: boolean;
  /** Status of every deletion of an appointment or booking. Default 204. */
  readonly deleteStatus?: number;
  /** Whether a create answers 201 without an ID. */
  readonly createWithoutId?: boolean;
}

/** How the synthetic instance behaves. */
export interface WriteInstanceOptions {
  /** With calendar and resource of the probes, and the rights for them. */
  readonly calendar?: CalendarOptions;
  /** Body of `GET /api/wiki/categories`, instead of W and K. */
  readonly categories?: unknown;
  /** Status of `GET /api/wiki/categories`. */
  readonly categoriesStatus?: number;
  /** Body of `GET /api/permissions/global`, instead of the narrow rights. */
  readonly rights?: unknown;
  /** The OpenAPI document. */
  readonly document?: unknown;
  /** Pages in the write area before the run, besides the automatic page. */
  readonly extraPages?: readonly SyntheticPage[];
  /** Status for a POST with a title that exists. Default 400. */
  readonly duplicateStatus?: number;
  /** Whether a PATCH takes an undeclared `title`. Default: ignored. */
  readonly honourTitle?: boolean;
  /** Whether a PATCH with a precondition is refused with 412. Default: ignored. */
  readonly honourPreconditions?: boolean;
  /** Whether a PATCH with an unchanged text still creates a version. */
  readonly sameTextNewVersion?: boolean;
  /** Throw a network error on this call number (1-based), after counting it. */
  readonly failOnCall?: number;
  /** Status of the deletion of a page. Default 204. */
  readonly deleteStatus?: number;
  /** Status of `GET /api/permissions/global`. Default 200. */
  readonly rightsStatus?: number;
  /** Whether the rights come as text instead of JSON. */
  readonly rightsAsText?: boolean;
  /** Status of the page list of the write area. Default 200. */
  readonly pagesStatus?: number;
  /** Replaces the body of the page list of the write area. */
  readonly pageList?: (entries: Record<string, unknown>[]) => unknown;
  /** How the instance changes a text it receives on create. */
  readonly normalizeOnCreate?: (text: string) => string;
  /** Answer this call (1-based) normally, then lose the answer. */
  readonly loseAnswerOnCall?: number;
  /** Whether a deletion answers 204 but leaves the page. */
  readonly deleteKeepsPage?: boolean;
  /** How the instance changes a text it receives on change. */
  readonly normalizeOnUpdate?: (text: string) => string;
}

/** A synthetic instance: fetch, the calls it received and its pages. */
export interface WriteInstance {
  readonly fetch: FetchFunction;
  readonly calls: WriteCall[];
  readonly pages: Map<string, SyntheticPage>;
  /** The automatic page of the write area. */
  readonly autoPage: SyntheticPage;
  /** Appointments of the probe calendar, by ID. */
  readonly appointments: Map<number, SyntheticObject>;
  /** Bookings of the probe resource, by ID. */
  readonly bookings: Map<number, SyntheticObject>;
  /**
   * Saves a page as the web editor would: a new version with a changed text.
   *
   * @param guid - GUID of the page.
   * @param change - How the editor changes the text.
   */
  readonly editorSave: (guid: string, change: (text: string) => string) => void;
}

/**
 * Makes a random GUID in the documented form.
 *
 * @returns A GUID.
 */
export function makeGuid(): string {
  const hex = randomBytes(16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Creates the synthetic instance for one setting.
 *
 * @param setting - The setting of the test.
 * @param options - How the instance behaves.
 * @returns The instance.
 */
export function writeInstance(
  setting: WriteSetting,
  options: WriteInstanceOptions = {},
): WriteInstance {
  const { canaries, writeCategory, identification } = setting;
  const calls: WriteCall[] = [];
  let clock = 0;
  const now = (): string =>
    new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString();
  const autoPage: SyntheticPage = {
    guid: makeGuid(),
    title: 'main',
    onStartpage: false,
    versions: [{ version: 1, text: '', isMarkdown: true, modifiedDate: now() }],
  };
  const pages = new Map<string, SyntheticPage>([[autoPage.guid, autoPage]]);
  for (const page of options.extraPages ?? []) {
    pages.set(page.guid, page);
  }

  const person = {
    title: canaries.personName,
    domainType: 'person',
    domainIdentifier: canaries.personId,
    domainAttributes: {
      firstName: canaries.personName,
      lastName: canaries.groupName,
      guid: makeGuid(),
    },
  };
  const category = { id: writeCategory, name: canaries.groupName };
  const answer = (
    body: unknown,
    status = 200,
    contentType = 'application/json',
  ): Response =>
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: {
        'content-type': contentType,
        date: new Date(0).toUTCString(),
        'x-kanarie': canaries.headerValue,
        'set-cookie': `${canaries.cookieName}=${canaries.cookieValue}; Path=/; Secure; HttpOnly; SameSite=None`,
      },
    });
  const error = (status: number): Response =>
    answer(
      {
        message: canaries.personName,
        translatedMessage: canaries.groupName,
        messageKey: 'error',
        args: { id: canaries.personId },
        errors: [],
      },
      status,
    );
  const latest = (page: SyntheticPage): SyntheticVersion => {
    const last = page.versions.at(-1);
    if (last === undefined) {
      throw new Error('page without version');
    }
    return last;
  };
  const listEntry = (page: SyntheticPage): Record<string, unknown> => ({
    guid: page.guid,
    identifier: page.guid,
    title: page.title,
    version: latest(page).version,
    isMarkdown: latest(page).isMarkdown,
    onStartpage: page.onStartpage,
    wikiCategory: category,
    permissions: { canEdit: true, canDelete: page !== autoPage },
    meta: { modifiedDate: latest(page).modifiedDate, modifiedPerson: person },
  });
  const pageData = (
    page: SyntheticPage,
    version: SyntheticVersion = latest(page),
  ): Record<string, unknown> => ({
    ...listEntry(page),
    version: version.version,
    text: version.text,
    isMarkdown: version.isMarkdown,
    meta: {
      createdPerson: person,
      modifiedPerson: person,
      modifiedDate: version.modifiedDate,
    },
  });
  const find = (key: string | undefined): SyntheticPage | undefined =>
    key === undefined
      ? undefined
      : (pages.get(key) ??
        [...pages.values()].find((page) => page.title === key));

  const appointments = new Map<number, SyntheticObject>();
  const bookings = new Map<number, SyntheticObject>();
  let nextId = randomInt(100_000, 200_000);
  const self = canaries.number;
  const other = canaries.number + 1;
  const { calendar: calendarId, resource: resourceId } = setting.calendarArea;
  const objectFields = [
    'title',
    'subtitle',
    'description',
    'startDate',
    'endDate',
    'statusId',
    'showInCal',
    'isInternal',
    'resourceId',
  ];
  const addObject = (
    store: Map<number, SyntheticObject>,
    fields: Record<string, unknown>,
    by: number,
  ): SyntheticObject => {
    const object: SyntheticObject = {
      id: nextId++,
      fields,
      version: 1,
      modifiedDate: now(),
      createdBy: by,
      modifiedBy: by,
    };
    store.set(object.id, object);
    return object;
  };
  for (const title of options.calendar?.appointments ?? []) {
    addObject(appointments, { title, subtitle: canaries.groupName }, other);
  }
  for (const title of options.calendar?.bookings ?? []) {
    addObject(bookings, { title, statusId: 2 }, other);
  }
  const baseOf = (object: SyntheticObject): Record<string, unknown> => ({
    id: object.id,
    subtitle: null,
    description: null,
    note: canaries.personName,
    ...object.fields,
    version: object.version,
    meta: {
      createdDate: new Date(0).toISOString(),
      createdPerson: { id: object.createdBy, title: canaries.personName },
      modifiedDate: object.modifiedDate,
      modifiedPerson: { id: object.modifiedBy, title: canaries.personName },
    },
  });
  const respondCalendar = (
    call: WriteCall,
    calendar: CalendarOptions,
    fields: Record<string, unknown>,
  ): Response | undefined => {
    const path = call.url.pathname;
    if (path === '/api/whoami') {
      return answer({
        data: {
          id: self,
          firstName: canaries.personName,
          email: canaries.personEmail,
        },
      });
    }
    if (path === '/api/calendars') {
      return answer(
        calendar.calendars ?? {
          data: [{ id: calendarId, name: canaries.groupName, isPublic: true }],
          meta: { count: 1 },
        },
      );
    }
    if (path === '/api/resources') {
      return answer(
        calendar.resources ?? {
          data: [
            {
              id: resourceId,
              name: canaries.groupName,
              needsAppointment: false,
              adminIds: [other],
            },
          ],
          meta: { count: 1 },
        },
      );
    }
    const appointmentMatch =
      /^\/api\/calendars\/(\d+)\/appointments(?:\/(\d+))?$/.exec(path);
    const bookingMatch = /^\/api\/bookings(?:\/(\d+|conflicts))?$/.exec(path);
    if (appointmentMatch === null && bookingMatch === null) {
      return undefined;
    }
    if (
      appointmentMatch !== null &&
      Number(appointmentMatch[1]) !== calendarId
    ) {
      return error(403);
    }
    const isAppointment = appointmentMatch !== null;
    const store = isAppointment ? appointments : bookings;
    const kind = isAppointment ? 'appointment' : 'booking';
    const key = isAppointment ? appointmentMatch[2] : bookingMatch?.[1];
    const entry = (object: SyntheticObject): Record<string, unknown> => ({
      [kind]: { base: baseOf(object), calculated: {} },
      base: baseOf(object),
    });
    if (key === 'conflicts') {
      const overlapping = [...bookings.values()].filter(
        (object) =>
          object.fields['startDate'] === fields['startDate'] &&
          object.fields['statusId'] !== 3,
      );
      // An entry per overlapping occurrence, naming its booking as
      // bookingId, as the instance does.
      return answer({
        data: overlapping.map((object) => ({
          bookingId: object.id,
          title: object.fields['title'],
          statusId: object.fields['statusId'],
          startDate: object.fields['startDate'],
          endDate: object.fields['endDate'],
          isAnonymized: false,
        })),
      });
    }
    if (key === undefined) {
      if (call.method === 'GET') {
        if (
          !isAppointment &&
          call.url.searchParams.getAll('resource_ids[]').join() !==
            String(resourceId)
        ) {
          return error(403);
        }
        const list = [...store.values()].map(entry);
        return answer({ data: list, meta: { count: list.length } });
      }
      if (
        typeof fields['title'] !== 'string' ||
        typeof fields['startDate'] !== 'string' ||
        (!isAppointment && fields['resourceId'] !== resourceId)
      ) {
        return error(400);
      }
      const given = Object.fromEntries(
        Object.entries(fields).filter(([name]) => objectFields.includes(name)),
      );
      if (!isAppointment && fields['statusId'] === 2) {
        given['statusId'] = calendar.approvedBecomes ?? 1;
      }
      const object = addObject(store, given, self);
      const data = baseOf(object);
      if (calendar.createWithoutId === true) {
        delete data['id'];
      }
      return answer({ data }, 201);
    }
    const object = store.get(Number(key));
    if (object === undefined) {
      return error(404);
    }
    if (call.method === 'GET') {
      return answer({ data: { [kind]: baseOf(object), calculatedDates: {} } });
    }
    if (call.method === 'DELETE') {
      const status = calendar.deleteStatus ?? 204;
      if (status === 204) {
        store.delete(object.id);
        return answer(null, 204);
      }
      return error(status);
    }
    if (call.method === 'PUT') {
      if (
        calendar.honourVersion === true &&
        typeof fields['version'] === 'number' &&
        fields['version'] !== object.version
      ) {
        return error(409);
      }
      const next: Record<string, unknown> =
        calendar.putKeepsMissing === true ? { ...object.fields } : {};
      for (const name of objectFields) {
        if (name in fields) {
          next[name] =
            name === 'statusId' && fields[name] === 2
              ? (calendar.approvedBecomes ?? 1)
              : fields[name];
        }
      }
      if (JSON.stringify(next) !== JSON.stringify(object.fields)) {
        object.fields = next;
        object.version += 1;
        object.modifiedDate = now();
        object.modifiedBy = self;
      }
      return answer({ data: baseOf(object) });
    }
    return error(405);
  };

  const respond = (call: WriteCall): Response => {
    const path = call.url.pathname;
    const body: unknown =
      call.body === undefined ? undefined : JSON.parse(call.body);
    const fields = (
      typeof body === 'object' && body !== null ? body : {}
    ) as Record<string, unknown>;
    if (path === '/system/runtime/swagger/openapi.json') {
      return answer(options.document ?? specification);
    }
    if (options.calendar !== undefined) {
      const handled = respondCalendar(call, options.calendar, fields);
      if (handled !== undefined) {
        return handled;
      }
    }
    if (path === '/api/info') {
      return answer({ version: '3.137.1', siteName: canaries.groupName });
    }
    if (path === '/api/wiki/categories' && call.method === 'GET') {
      return answer(
        options.categories ?? {
          data: [
            {
              id: identification,
              name: identificationCategoryName,
              nameTranslated: identificationCategoryName,
              permissions: { canEdit: false, canDelete: false },
            },
            {
              ...category,
              nameTranslated: canaries.groupName,
              permissions: { canEdit: true, canDelete: false },
            },
          ],
          meta: { count: 2 },
          permissions: { editMasterData: false },
        },
        options.categoriesStatus ?? 200,
      );
    }
    if (path === '/api/permissions/global') {
      return answer(
        options.rights ?? {
          data: {
            churchwiki: {
              view: true,
              'view category': [writeCategory, identification],
              'edit category': [writeCategory],
              'edit masterdata': false,
            },
            churchdb: { view: false, 'security level person': [] },
            ...(options.calendar === undefined
              ? {}
              : {
                  churchcal: {
                    view: false,
                    'view category': [setting.calendarArea.calendar],
                    'edit category': [setting.calendarArea.calendar],
                    'admin church category': false,
                  },
                  churchresource: {
                    'view resource': [setting.calendarArea.resource],
                    'create bookings': [setting.calendarArea.resource],
                    'administer bookings': [],
                  },
                }),
          },
        },
        options.rightsStatus ?? 200,
        options.rightsAsText === true ? 'text/plain' : 'application/json',
      );
    }
    const match =
      /^\/api\/wiki\/categories\/(\d+)\/pages(?:\/([^/]+)(\/versions(?:\/(\d+))?)?)?$/.exec(
        path,
      );
    if (match === null) {
      return error(404);
    }
    const [, requested, key, versions, version] = match;
    if (Number(requested) !== writeCategory) {
      return error(403);
    }
    if (key === undefined) {
      if (call.method === 'POST') {
        const title = fields['title'];
        if (typeof title !== 'string' || title === '') {
          return error(400);
        }
        if ([...pages.values()].some((page) => page.title === title)) {
          const status = options.duplicateStatus ?? 400;
          if (status !== 201) {
            return error(status);
          }
        }
        const sent = fields['text'];
        const text =
          typeof sent === 'string' && options.normalizeOnCreate !== undefined
            ? options.normalizeOnCreate(sent)
            : sent;
        const page: SyntheticPage = {
          guid: makeGuid(),
          title,
          onStartpage: fields['onStartpage'] === true,
          versions: [
            {
              version: 1,
              text: typeof text === 'string' ? text : null,
              isMarkdown: fields['isMarkdown'] === true,
              modifiedDate: now(),
            },
          ],
        };
        pages.set(page.guid, page);
        return answer({ data: pageData(page) }, 201);
      }
      const list = [...pages.values()].map(listEntry);
      return answer(
        options.pageList?.(list) ?? {
          data: list,
          meta: { count: list.length },
        },
        options.pagesStatus ?? 200,
      );
    }
    const page = call.method === 'GET' ? find(key) : pages.get(key);
    if (page === undefined) {
      return error(404);
    }
    if (call.method === 'DELETE') {
      if (page === autoPage) {
        return error(403);
      }
      const status = options.deleteStatus ?? 204;
      if (status === 204 && options.deleteKeepsPage !== true) {
        pages.delete(page.guid);
      }
      return status === 204 ? answer(null, 204) : error(status);
    }
    if (call.method === 'PATCH') {
      if (
        options.honourPreconditions === true &&
        (call.headers.has('if-match') ||
          call.headers.has('if-unmodified-since'))
      ) {
        return error(412);
      }
      const current = latest(page);
      let next: SyntheticVersion = { ...current, modifiedDate: now() };
      if (typeof fields['isMarkdown'] === 'boolean') {
        next = { ...next, isMarkdown: fields['isMarkdown'] };
      }
      if (typeof fields['onStartpage'] === 'boolean') {
        page.onStartpage = fields['onStartpage'];
      }
      const received = fields['text'];
      const text =
        typeof received === 'string' && options.normalizeOnUpdate !== undefined
          ? options.normalizeOnUpdate(received)
          : received;
      if (
        typeof text === 'string' &&
        (text !== current.text || options.sameTextNewVersion === true)
      ) {
        page.versions.push({ ...next, version: current.version + 1, text });
      } else {
        page.versions[page.versions.length - 1] = next;
      }
      if (options.honourTitle === true && typeof fields['title'] === 'string') {
        const renamed: SyntheticPage = { ...page, title: fields['title'] };
        pages.set(page.guid, renamed);
        return answer({ data: pageData(renamed) });
      }
      return answer({ data: pageData(page) });
    }
    if (versions === undefined) {
      return answer({ data: pageData(page) });
    }
    if (version === undefined) {
      return answer({
        data: page.versions.map((entry) => pageData(page, entry)),
        meta: { count: page.versions.length },
      });
    }
    const found = page.versions.find(
      (entry) => entry.version === Number(version),
    );
    return found === undefined
      ? error(404)
      : answer({ data: pageData(page, found) });
  };

  return {
    calls,
    pages,
    autoPage,
    appointments,
    bookings,
    editorSave: (guid, change) => {
      const page = pages.get(guid);
      if (page === undefined) {
        throw new Error('unknown page');
      }
      const current = latest(page);
      page.versions.push({
        ...current,
        version: current.version + 1,
        text: change(current.text ?? ''),
        modifiedDate: now(),
      });
    },
    fetch: (url, init) => {
      const call: WriteCall = {
        method: init.method ?? 'fehlt',
        url,
        headers: new Headers(init.headers),
        body: typeof init.body === 'string' ? init.body : undefined,
      };
      calls.push(call);
      if (options.failOnCall === calls.length) {
        return Promise.reject(
          new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }),
        );
      }
      const response = respond(call);
      if (options.loseAnswerOnCall === calls.length) {
        return Promise.reject(
          new DOMException('The operation timed out.', 'TimeoutError'),
        );
      }
      return Promise.resolve(response);
    },
  };
}
