// A stateful stand-in of ChurchTools for tests/scripts/smoke-write.test.mts.
// It keeps the pages of the write area with every version of their text,
// the appointments of the probe calendar and the bookings of the probe
// resource, and answers the reads of the guard and the reads and writes of
// the real server in the forms the core reads (packages/core/src/
// churchtools/schemas.ts) and the probes found (docs/research/
// churchtools-api.md): a new appointment and booking have version 0, every
// PUT raises it by one, also unchanged (F42), and replaces the whole
// appointment (F41); a page starts at version 1 and gets a new version only
// for a new text (F10, F16), and keeps a text without the white space
// `trim` of PHP removes at both ends (F51); a deleted appointment reads
// 404, a deleted booking 500 and is gone from the list (F47); a booking is
// a request with status 1 (F45), and the account created what it wrote
// (F44).
//
// Everything is made up at run time: the names carry a canary of the test,
// the IDs are random. No real answer is copied (tests/fixtures/README.md).
// The module only answers requests; serve.mts puts it behind TLS and a
// plain port on 127.0.0.1 in a process of its own.
import { randomUUID } from 'node:crypto';

// ChurchTools stores the text of a page without the white space `trim` of
// PHP removes at both ends (F51), written here apart from the core.
const asStored = (text: string): string =>
  text.replace(/^[ \t\n\r\v]+/u, '').replace(/[ \t\n\r\v]+$/u, '');

/** What the stand-in holds and how it misbehaves, from the test. */
export interface StandInConfig {
  /** The token of the write account; any other gets 401. */
  readonly token: string;
  /** A canary in every name and in texts the core never reads. */
  readonly canary: string;
  /** The ID of the account, as whoami gives it. */
  readonly account: number;
  /** Another person, the author of what was there before. */
  readonly other: number;
  readonly identification: number;
  readonly category: number;
  readonly calendar: number;
  readonly resource: number;
  readonly resourceType: number;
  /** Without it the identification category has another name. */
  readonly withIdentification?: boolean;
  /** A page of someone else in the write area. */
  readonly foreignPage?: boolean;
  /** A day, `YYYY-MM-DD`, with an appointment of someone else. */
  readonly foreignAppointmentOn?: string;
  /** A DELETE of an appointment answers 204 and keeps it. */
  readonly deleteKeepsAppointment?: boolean;
  /** The status a new booking gets, as a resource that approves itself. */
  readonly bookingStatus?: number;
  /**
   * The statuses the list of bookings holds without `status_ids[]`; every
   * status if not set.
   */
  readonly defaultBookingStatuses?: readonly number[];
}

/** One request as the stand-in sees it. */
export interface StandInRequest {
  readonly method: string;
  readonly url: URL;
  readonly authorization: string | undefined;
  readonly body: string;
}

/** One answer: a status and a JSON body, none for 204. */
export interface StandInAnswer {
  readonly status: number;
  readonly body?: unknown;
}

/** One request the stand-in answered, without its body. */
export interface StandInCall {
  /** Whether it came from the guard of the smoke test or from the server. */
  readonly via: 'guard' | 'server';
  readonly method: string;
  readonly path: string;
  readonly status: number;
}

/** What the stand-in holds, for the assertions of the test. */
export interface StandInState {
  readonly pages: readonly {
    readonly guid: string;
    readonly title: string;
    readonly version: number;
    readonly text: string;
  }[];
  readonly appointments: readonly {
    readonly id: number;
    readonly title: string;
    readonly version: number;
  }[];
  readonly bookings: readonly {
    readonly id: number;
    readonly title: string;
    readonly statusId: number;
  }[];
}

interface Version {
  readonly version: number;
  readonly text: string;
  readonly modifiedDate: string;
}

interface Page {
  readonly guid: string;
  readonly title: string;
  readonly versions: Version[];
}

interface Dated {
  readonly id: number;
  version: number;
  title: string;
  description: string | null;
  startDate: string;
  endDate: string;
  readonly createdBy: number;
  modifiedBy: number;
  readonly createdDate: string;
  modifiedDate: string;
}

interface Appointment extends Dated {
  subtitle: string | null;
  isInternal: boolean;
}

interface Booking extends Dated {
  statusId: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const textOf = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

const dayOf = (date: string): string => date.slice(0, 10);

/**
 * Creates the stand-in.
 *
 * @param config - IDs, names and misbehaviour from the test.
 * @returns The handler of one request, its log and its state.
 */
export function createChurchTools(config: StandInConfig): {
  readonly respond: (
    request: StandInRequest,
    via: StandInCall['via'],
  ) => StandInAnswer;
  readonly calls: () => readonly StandInCall[];
  readonly state: () => StandInState;
} {
  const { canary } = config;
  const calls: StandInCall[] = [];
  const now = (): string => new Date().toISOString();
  const names = {
    category: `Schreibbereich ${canary}`,
    identification:
      config.withIdentification === false
        ? `Kennung ${canary}`
        : 'testinstanz-kennung',
    calendar: `Probenkalender ${canary}`,
    resource: `Probenraum ${canary}`,
    resourceType: `Räume ${canary}`,
    person: `${canary} Person`,
  };
  const person = (id: number) => ({
    id,
    title: names.person,
    domainType: 'person',
    domainIdentifier: String(id),
  });

  const pages = new Map<string, Page>();
  const addPage = (title: string, text: string): Page => {
    // The test instance writes the GUID of a page in upper case.
    const page: Page = {
      guid: randomUUID().toUpperCase(),
      title,
      versions: [{ version: 1, text, modifiedDate: now() }],
    };
    pages.set(page.guid, page);
    return page;
  };
  // ChurchTools gives every new category an empty page «main» (F16).
  addPage('main', '');
  if (config.foreignPage === true) {
    addPage(`Fremde Seite ${canary}`, `Text ${canary}`);
  }
  const latest = (page: Page): Version => {
    const last = page.versions.at(-1);
    if (last === undefined) throw new Error('a page without a version');
    return last;
  };

  let nextId = 4000 + Math.floor(Math.random() * 1000);
  const appointments = new Map<number, Appointment>();
  const bookings = new Map<number, Booking>();
  const deletedBookings = new Set<number>();
  const dated = (
    fields: Pick<Dated, 'title' | 'description' | 'startDate' | 'endDate'>,
    by: number,
  ): Dated => {
    const created = now();
    return {
      id: nextId++,
      version: 0,
      ...fields,
      createdBy: by,
      modifiedBy: by,
      createdDate: created,
      modifiedDate: created,
    };
  };
  if (config.foreignAppointmentOn !== undefined) {
    const day = config.foreignAppointmentOn;
    const entry: Appointment = {
      ...dated(
        {
          title: `Fremder Termin ${canary}`,
          description: null,
          startDate: `${day}T12:00:00Z`,
          endDate: `${day}T13:00:00Z`,
        },
        config.other,
      ),
      subtitle: null,
      isInternal: false,
    };
    appointments.set(entry.id, entry);
  }

  const metaOf = (object: Dated) => ({
    createdDate: object.createdDate,
    createdPerson: person(object.createdBy),
    modifiedDate: object.modifiedDate,
    modifiedPerson: person(object.modifiedBy),
  });

  // An appointment as ChurchTools stores it: a single appointment with
  // nothing linked, so that no key the core does not know holds a value
  // (calendar-writes.ts, appointmentKeys).
  const storedAppointment = (entry: Appointment) => ({
    id: entry.id,
    version: entry.version,
    calendar: { id: config.calendar, name: names.calendar },
    title: entry.title,
    subtitle: entry.subtitle,
    description: entry.description,
    note: null,
    startDate: entry.startDate,
    endDate: entry.endDate,
    allDay: false,
    isInternal: entry.isInternal,
    repeatId: 0,
    repeatFrequency: null,
    repeatUntil: null,
    repeatOption: null,
    additionals: [],
    exceptions: [],
    address: null,
    link: null,
    image: null,
    signup: null,
    onBehalfOfPid: null,
    meta: metaOf(entry),
  });

  const storedBooking = (entry: Booking) => ({
    id: entry.id,
    version: entry.version,
    resourceId: config.resource,
    resource: { id: config.resource, name: names.resource },
    title: entry.title,
    caption: entry.title,
    description: entry.description,
    note: null,
    location: null,
    startDate: entry.startDate,
    endDate: entry.endDate,
    allDay: false,
    statusId: entry.statusId,
    quantity: 1,
    showInCal: false,
    repeatId: 0,
    additionals: [],
    exceptions: [],
    appointment: null,
    appointmentId: null,
    answeredPid: null,
    isAnonymized: false,
    meta: metaOf(entry),
  });

  // The span of the lists: every entry that touches a day from `from` to
  // `to`, both included, by the day of its start and end in UTC.
  const inWindow = (entry: Dated, url: URL): boolean => {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    return (
      (from === null || dayOf(entry.endDate) >= from) &&
      (to === null || dayOf(entry.startDate) <= to)
    );
  };

  const error = (status: number): StandInAnswer => ({
    status,
    // ChurchTools names the request in its errors; the core never reads them.
    body: {
      message: `Fehler ${canary}`,
      messageKey: 'error',
      args: {},
      errors: [],
    },
  });
  const ok = (body: unknown, status = 200): StandInAnswer => ({ status, body });

  const pageEntry = (page: Page) => ({
    guid: page.guid,
    identifier: page.guid,
    title: page.title,
    version: latest(page).version,
    isMarkdown: true,
    onStartpage: false,
    wikiCategory: { id: config.category, name: names.category },
    permissions: { canEdit: true, canDelete: page.title !== 'main' },
    meta: {
      modifiedDate: latest(page).modifiedDate,
      modifiedPerson: person(config.account),
    },
  });
  const pageData = (page: Page, version: Version = latest(page)) => ({
    ...pageEntry(page),
    version: version.version,
    text: version.text,
    meta: {
      createdPerson: person(config.account),
      modifiedPerson: person(config.account),
      modifiedDate: version.modifiedDate,
    },
  });
  const pageList = () => {
    const list = [...pages.values()].map(pageEntry);
    // The list of a category counts; the list of all pages has pages. Both
    // are read from the same pages, so each carries both.
    return {
      data: list,
      meta: {
        count: list.length,
        pagination: {
          total: list.length,
          limit: 25,
          current: 1,
          lastPage: 1,
        },
      },
    };
  };

  const wiki = (
    request: StandInRequest,
    fields: Record<string, unknown>,
  ): StandInAnswer | undefined => {
    const { method, url } = request;
    if (url.pathname === '/api/wiki/categories' && method === 'GET') {
      return ok({
        data: [
          {
            id: config.identification,
            name: names.identification,
            nameTranslated: names.identification,
            permissions: { canEdit: false, canDelete: false },
          },
          {
            id: config.category,
            name: names.category,
            nameTranslated: names.category,
            permissions: { canEdit: true, canDelete: false },
          },
        ],
        meta: { count: 2 },
        permissions: { editMasterData: false },
      });
    }
    if (url.pathname === '/api/wiki/pages' && method === 'GET') {
      const asked = url.searchParams.getAll('wiki_category_ids[]');
      return asked.join() === String(config.category)
        ? ok(pageList())
        : error(403);
    }
    const match =
      /^\/api\/wiki\/categories\/(\d+)\/pages(?:\/([^/]+)(\/versions(?:\/(\d+))?)?)?$/u.exec(
        url.pathname,
      );
    if (match === null) return undefined;
    const [, category, guid, versions, version] = match;
    // Only the write area holds pages; a page answers only under the path
    // of its own category (F49).
    if (Number(category) !== config.category) return error(403);
    if (guid === undefined) {
      if (method === 'GET') return ok(pageList());
      if (method !== 'POST') return error(405);
      const title = fields['title'];
      const text = fields['text'];
      if (
        typeof title !== 'string' ||
        title === '' ||
        typeof text !== 'string'
      ) {
        return error(400);
      }
      // A second page with the same title is refused (F12).
      if ([...pages.values()].some((page) => page.title === title)) {
        return error(400);
      }
      return ok({ data: pageData(addPage(title, asStored(text))) }, 201);
    }
    // A GUID in another case finds the same page, as a GUID is no text.
    const page = pages.get(guid.toUpperCase());
    if (page === undefined) return error(404);
    if (method === 'PATCH' && versions === undefined) {
      const sent = fields['text'];
      if (typeof sent !== 'string') return error(400);
      const text = asStored(sent);
      // Only a new text makes a new version (F10).
      if (text !== latest(page).text) {
        page.versions.push({
          version: latest(page).version + 1,
          text,
          modifiedDate: now(),
        });
      }
      return ok({ data: pageData(page) });
    }
    if (method !== 'GET') return error(405);
    if (versions === undefined) return ok({ data: pageData(page) });
    if (version === undefined) {
      return ok({
        data: page.versions.map((entry) => pageData(page, entry)),
        meta: { count: page.versions.length },
      });
    }
    const found = page.versions.find(
      (entry) => entry.version === Number(version),
    );
    return found === undefined
      ? error(404)
      : ok({ data: pageData(page, found) });
  };

  const appointmentEntry = (entry: Appointment) => {
    const base = storedAppointment(entry);
    const calculated = { startDate: entry.startDate, endDate: entry.endDate };
    return { appointment: { base, calculated }, base, calculated };
  };
  const appointmentList = (url: URL) => {
    const list = [...appointments.values()]
      .filter((entry) => inWindow(entry, url))
      .map(appointmentEntry);
    return ok({ data: list, meta: { count: list.length } });
  };

  const calendars = (
    request: StandInRequest,
    fields: Record<string, unknown>,
  ): StandInAnswer | undefined => {
    const { method, url } = request;
    if (url.pathname === '/api/calendars' && method === 'GET') {
      return ok({
        data: [
          {
            id: config.calendar,
            name: names.calendar,
            nameTranslated: names.calendar,
            isPublic: false,
            isPrivate: false,
            randomUrl: `abo-${canary}`,
          },
        ],
        meta: { count: 1 },
      });
    }
    if (url.pathname === '/api/calendars/appointments' && method === 'GET') {
      const asked = url.searchParams.getAll('calendar_ids[]');
      return asked.join() === String(config.calendar)
        ? appointmentList(url)
        : error(403);
    }
    const match = /^\/api\/calendars\/(\d+)\/appointments(?:\/(\d+))?$/u.exec(
      url.pathname,
    );
    if (match === null) return undefined;
    const [, calendar, id] = match;
    if (Number(calendar) !== config.calendar) return error(403);
    if (id === undefined) {
      if (method === 'GET') return appointmentList(url);
      if (method !== 'POST') return error(405);
      const title = textOf(fields['title']);
      const startDate = textOf(fields['startDate']);
      const endDate = textOf(fields['endDate']);
      if (title === null || startDate === null || endDate === null) {
        return error(400);
      }
      const entry: Appointment = {
        ...dated(
          {
            title,
            description: textOf(fields['description']),
            startDate,
            endDate,
          },
          config.account,
        ),
        subtitle: null,
        isInternal: fields['isInternal'] === true,
      };
      appointments.set(entry.id, entry);
      return ok({ data: storedAppointment(entry) }, 201);
    }
    const entry = appointments.get(Number(id));
    // A deleted appointment reads as unknown (F47).
    if (entry === undefined) return error(404);
    if (method === 'GET') {
      return ok({
        data: {
          appointment: storedAppointment(entry),
          additionalInfos: [],
          calculatedDates: {
            [dayOf(entry.startDate)]: {
              startDate: entry.startDate,
              endDate: entry.endDate,
              iCalUid: `uid-${canary}`,
            },
          },
        },
      });
    }
    if (method === 'PUT') {
      const title = textOf(fields['title']);
      const startDate = textOf(fields['startDate']);
      const endDate = textOf(fields['endDate']);
      if (title === null || startDate === null || endDate === null) {
        return error(400);
      }
      // The whole appointment is replaced, a field left out is emptied
      // (F41), and every stored PUT raises the version by one (F42).
      entry.title = title;
      entry.subtitle = textOf(fields['subtitle']);
      entry.description = textOf(fields['description']);
      entry.startDate = startDate;
      entry.endDate = endDate;
      entry.isInternal = fields['isInternal'] === true;
      entry.version += 1;
      entry.modifiedBy = config.account;
      entry.modifiedDate = now();
      return ok({ data: storedAppointment(entry) });
    }
    if (method === 'DELETE') {
      if (config.deleteKeepsAppointment !== true) appointments.delete(entry.id);
      return { status: 204 };
    }
    return error(405);
  };

  const bookingEntry = (entry: Booking) => {
    const base = storedBooking(entry);
    const calculated = { startDate: entry.startDate, endDate: entry.endDate };
    return { booking: { base, calculated }, base, calculated };
  };

  const resources = (
    request: StandInRequest,
    fields: Record<string, unknown>,
  ): StandInAnswer | undefined => {
    const { method, url } = request;
    if (url.pathname === '/api/resources' && method === 'GET') {
      return ok({
        data: [
          {
            id: config.resource,
            name: names.resource,
            resourceTypeId: config.resourceType,
            needsAppointment: false,
            adminIds: [config.other],
            randomString: `zufall-${canary}`,
          },
        ],
        meta: { count: 1 },
      });
    }
    if (url.pathname === '/api/resourcetypes' && method === 'GET') {
      return ok({
        data: [{ id: config.resourceType, name: names.resourceType }],
        meta: { count: 1 },
      });
    }
    const match = /^\/api\/bookings(?:\/(\d+))?$/u.exec(url.pathname);
    if (match === null) return undefined;
    const [, id] = match;
    if (id === undefined) {
      if (method === 'GET') {
        if (
          url.searchParams.getAll('resource_ids[]').join() !==
          String(config.resource)
        ) {
          return error(403);
        }
        // The document names no default of `status_ids[]`; without it the
        // list holds every status, so that a request shows as well, unless
        // a test names another default.
        const asked = url.searchParams.getAll('status_ids[]').map(Number);
        const statuses =
          asked.length === 0 ? (config.defaultBookingStatuses ?? []) : asked;
        const list = [...bookings.values()]
          .filter(
            (entry) =>
              inWindow(entry, url) &&
              (statuses.length === 0 || statuses.includes(entry.statusId)),
          )
          .map(bookingEntry);
        return ok({ data: list, meta: { count: list.length } });
      }
      if (method !== 'POST') return error(405);
      const title = textOf(fields['title']);
      const startDate = textOf(fields['startDate']);
      const endDate = textOf(fields['endDate']);
      if (title === null || startDate === null || endDate === null) {
        return error(400);
      }
      if (fields['resourceId'] !== config.resource) return error(403);
      // The account may only request (F45).
      if (fields['statusId'] !== 1) return error(403);
      const entry: Booking = {
        ...dated(
          {
            title,
            description: textOf(fields['description']),
            startDate,
            endDate,
          },
          config.account,
        ),
        statusId: config.bookingStatus ?? 1,
      };
      bookings.set(entry.id, entry);
      return ok({ data: storedBooking(entry) }, 201);
    }
    const entry = bookings.get(Number(id));
    if (entry === undefined) {
      // A deleted booking reads as an error of the server (F47).
      return error(deletedBookings.has(Number(id)) ? 500 : 404);
    }
    if (method === 'GET')
      return ok({ data: { booking: storedBooking(entry) } });
    if (method === 'DELETE') {
      bookings.delete(entry.id);
      deletedBookings.add(entry.id);
      return { status: 204 };
    }
    return error(405);
  };

  const account = (request: StandInRequest): StandInAnswer | undefined => {
    const { method, url } = request;
    if (method !== 'GET') return undefined;
    if (url.pathname === '/api/whoami') {
      return ok({
        data: {
          id: config.account,
          guid: randomUUID(),
          firstName: `${canary}Vorname`,
          lastName: `${canary}Nachname`,
          email: `${canary}@example.org`,
        },
      });
    }
    if (url.pathname === '/api/info') {
      return ok({ version: '3.138.0', siteName: `Gemeinde ${canary}` });
    }
    if (url.pathname === '/api/permissions/global') {
      // Exactly the narrow rights of the write account (ADR 0049).
      return ok({
        data: {
          churchwiki: {
            view: true,
            'view category': [config.category, config.identification],
            'edit category': [config.category],
            'edit masterdata': false,
          },
          churchdb: { view: false, 'security level person': [] },
          churchcal: {
            view: false,
            'view category': [config.calendar],
            'edit category': [config.calendar],
            'admin church category': false,
          },
          churchresource: {
            view: false,
            'view resource': [config.resource],
            'create bookings': [config.resource],
            'administer bookings': [],
          },
        },
      });
    }
    return undefined;
  };

  const respond = (
    request: StandInRequest,
    via: StandInCall['via'],
  ): StandInAnswer => {
    let answer: StandInAnswer;
    if (request.authorization !== `Login ${config.token}`) {
      answer = error(401);
    } else {
      let fields: Record<string, unknown> = {};
      try {
        const parsed: unknown =
          request.body === '' ? {} : JSON.parse(request.body);
        if (isRecord(parsed)) fields = parsed;
      } catch {
        fields = {};
      }
      answer =
        account(request) ??
        wiki(request, fields) ??
        calendars(request, fields) ??
        resources(request, fields) ??
        error(404);
    }
    calls.push({
      via,
      method: request.method,
      path: request.url.pathname,
      status: answer.status,
    });
    return answer;
  };

  return {
    respond,
    calls: () => [...calls],
    state: () => ({
      pages: [...pages.values()].map((page) => ({
        guid: page.guid,
        title: page.title,
        version: latest(page).version,
        text: latest(page).text,
      })),
      appointments: [...appointments.values()].map((entry) => ({
        id: entry.id,
        title: entry.title,
        version: entry.version,
      })),
      bookings: [...bookings.values()].map((entry) => ({
        id: entry.id,
        title: entry.title,
        statusId: entry.statusId,
      })),
    }),
  };
}
