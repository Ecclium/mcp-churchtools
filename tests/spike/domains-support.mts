// A synthetic instance for probe 09. It answers the two reads of the guard
// for personal data and, behind them, the operations on calendars, events,
// services, resources, bookings, songs and both searches, with canary
// values in every answer. Everything is made up at run time (see
// tests/fixtures/README.md); no real answer is copied.
import { randomInt } from 'node:crypto';

import {
  domainLabels,
  domainVariables,
  timeWindow,
  type DomainLabel,
} from '../../scripts/spike/09-domains-read.mts';
import { identificationCategoryName } from '../../scripts/spike/lib/gate.mts';
import type { FetchFunction } from '../../scripts/spike/lib/http.mts';
import {
  narrowRights,
  personsSetup,
  type PersonsSetting,
} from './persons-support.mts';
import { makeGuid } from './write-support.mts';

/** Everything one test of probe 09 needs. */
export interface DomainsSetting extends PersonsSetting {
  /** IDs of the synthetic objects, by label. */
  readonly ids: Readonly<Record<DomainLabel, number>>;
  /** Base of the IDs of foreign objects and of objects without a label. */
  readonly foreign: number;
}

const forms = (texts: readonly string[]): string[] =>
  texts.flatMap((text) => [
    text.toLowerCase(),
    encodeURIComponent(text).toLowerCase(),
  ]);

/**
 * Makes the files and environment of one test: those of the probe that
 * reads persons and the IDs of the synthetic objects of the domains.
 *
 * The IDs lie between 50 000 and 100 000, apart from those of the persons
 * and groups, so that none of them is part of a count class.
 *
 * @param shared - Pairs of objects of different kinds that share one ID,
 *   the first taking the ID of the second, as on a test instance.
 * @returns A fresh setting with random IDs and canaries.
 */
export function domainsSetup(
  shared: readonly (readonly [DomainLabel, DomainLabel])[] = [],
): DomainsSetting {
  const base = personsSetup();
  const ids = Object.fromEntries(
    domainLabels.map((label, index) => [
      label,
      81_000 + index * 1_500 + randomInt(0, 1_000),
    ]),
  ) as Record<DomainLabel, number>;
  for (const [label, other] of shared) {
    ids[label] = ids[other];
  }
  const foreign = randomInt(51_000, 58_000);
  const { from, to } = timeWindow(new Date());
  return {
    ...base,
    ids,
    foreign,
    env: {
      ...base.env,
      ...Object.fromEntries(
        domainLabels.map((label) => [
          domainVariables[label],
          String(ids[label]),
        ]),
      ),
    },
    forbidden: [
      ...base.forbidden,
      ...forms([
        ...Object.values(ids).map(String),
        ...Array.from({ length: 20 }, (_, offset) => String(foreign + offset)),
        // The two search terms, the dates sent and the names of the objects.
        'synthetisch',
        'spikeprobe',
        from,
        to,
        'kalender',
        'predigt',
        'beamer',
        'saal',
        'lieder',
        'gottesdienst',
        'raeume',
      ]),
    ],
  };
}

/**
 * The rights of a run of probe 09: the narrow rights of the probe that
 * reads persons and the read rights on services, calendars and resources.
 *
 * @param setting - The setting of the test.
 * @param extra - Further rights by module, set over the others.
 * @returns `data` of a rights response.
 */
export function domainRights(
  setting: DomainsSetting,
  extra: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {},
): Record<string, Record<string, unknown>> {
  const rights: Record<string, Record<string, unknown>> = {
    ...narrowRights(setting.identification, {
      view: true,
      'view alldata': [-1],
    }),
    churchservice: {
      view: true,
      'view events': [setting.ids.sg1],
      'view servicegroup': [setting.ids.sg1],
      'view agenda': [-2],
      'view songcategory': [setting.ids.sc1],
      'edit events': [],
      'edit agenda': false,
    },
    churchcal: {
      view: true,
      'view category': [setting.ids.c1],
      'edit category': [],
    },
    churchresource: {
      view: true,
      'view resource': [setting.ids.rt1],
      'administer bookings': false,
    },
  };
  for (const [module, values] of Object.entries(extra)) {
    rights[module] = { ...rights[module], ...values };
  }
  return rights;
}

/** One request the synthetic instance received. */
export interface DomainsCall {
  readonly method: string;
  readonly url: URL;
  readonly authorization: string | null;
}

/** How the synthetic instance behaves. */
export interface DomainsInstanceOptions {
  /** `data` of `GET /api/permissions/global`, instead of {@link domainRights}. */
  readonly rights?: unknown;
  /** The OpenAPI document. */
  readonly document?: unknown;
  /** Operations, by the name of the probe, that answer 403. */
  readonly denied?: readonly string[];
  /** Synthetic objects the lists leave out. */
  readonly hidden?: readonly DomainLabel[];
  /** Whether the unknown ID of the probe exists. Default false. */
  readonly unknownExists?: boolean;
  /** The largest `limit` the lists echo; larger ones are cut to it. */
  readonly echoCap?: number;
}

/** The largest limit the synthetic lists accept. */
export const domainsLimit = 500;

/** A synthetic instance: fetch and the requests it received. */
export interface DomainsInstance {
  readonly fetch: FetchFunction;
  readonly calls: DomainsCall[];
  /** Every GUID and date the instance made up, in lower case. */
  readonly generated: readonly string[];
}

/** The name the probe gives the operation of a path, if it has one. */
function operationOf(parts: readonly string[]): string | undefined {
  const [first, second, third, fourth] = parts;
  const routes: readonly (readonly [boolean, string])[] = [
    [first === 'calendars' && second === undefined, 'calendars'],
    [
      first === 'calendars' && second === 'appointments' && third === undefined,
      'calendarAppointments',
    ],
    [
      first === 'calendars' && third === 'appointments' && fourth !== undefined,
      'calendarAppointment',
    ],
    [first === 'events' && second === undefined, 'events'],
    [
      first === 'events' && second !== undefined && third === undefined,
      'event',
    ],
    [third === 'agenda' && fourth === undefined, 'eventAgenda'],
    [third === 'agenda' && fourth === 'songs', 'eventAgendaSongs'],
    [first === 'services', 'services'],
    [first === 'servicegroups', 'serviceGroups'],
    [first === 'resourcetypes', 'resourceTypes'],
    [first === 'resources', 'resources'],
    [first === 'bookings', 'bookings'],
    [first === 'songs' && second === undefined, 'songs'],
    [first === 'songs' && second !== undefined && third === undefined, 'song'],
    [first === 'songs' && third === 'arrangements', 'songArrangements'],
    [first === 'wiki' && second === 'search', 'wikiSearch'],
    [first === 'search', 'search'],
  ];
  return routes.find(([matches]) => matches)?.[1];
}

/**
 * Creates the synthetic instance for one setting.
 *
 * @param setting - The setting of the test.
 * @param options - How the instance behaves.
 * @returns The instance.
 */
export function domainsInstance(
  setting: DomainsSetting,
  options: DomainsInstanceOptions = {},
): DomainsInstance {
  const { canaries, identification, ids, foreign } = setting;
  const calls: DomainsCall[] = [];
  const generated: string[] = [];
  const answer = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        'content-type': 'application/json',
        'x-kanarie': canaries.headerValue,
        'set-cookie': `${canaries.cookieName}=${canaries.cookieValue}; Max-Age=86400; path=/; secure; HttpOnly; SameSite=None`,
      },
    });
  const made = (value: string): string => {
    generated.push(value.toLowerCase());
    return value;
  };
  const hidden = new Set(options.hidden ?? []);
  const shown = <T,>(label: DomainLabel, value: T): T[] =>
    hidden.has(label) ? [] : [value];
  const { from } = timeWindow(new Date());
  const start = Date.parse(`${from}T00:00:00Z`);
  // A date with time, some days after the first day of the window.
  const at = (days: number, hour: number): string =>
    made(
      new Date(start + days * 86_400_000 + hour * 3_600_000)
        .toISOString()
        .replace('.000Z', 'Z'),
    );
  const person = (id: number, title: string): Record<string, unknown> => ({
    title,
    domainType: 'person',
    domainIdentifier: String(id),
    domainAttributes: { guid: made(makeGuid()) },
  });
  const p1 = person(setting.personId, 'Anna Spikeprobe');
  const p2 = person(setting.p2 + 1, 'Bruno Spikeprobenberg');
  const calendar = {
    id: ids.c1,
    name: 'Synthetisch Kalender',
    isPublic: false,
  };
  const appointment = (
    id: number,
    days: number,
    repeat: number,
  ): Record<string, unknown> => ({
    base: {
      id,
      caption: 'Synthetisch Probe',
      startDate: at(days, 9),
      endDate: at(days, 10),
      allDay: false,
      repeatId: repeat,
      calendar,
      meta: { createdPerson: p1 },
    },
    calculated: { startDate: at(days, 9), endDate: at(days, 10) },
  });
  // The single appointment once, the weekly one on each week of the window.
  const appointments = [
    ...shown('t1', appointment(ids.t1, 3, 0)),
    ...(hidden.has('t2')
      ? []
      : [0, 7, 14, 21, 28, 35].map((days) => appointment(ids.t2, days, 1))),
  ];
  const arrangement = (id: number): Record<string, unknown> => ({
    id,
    name: 'Synthetisch Satz',
    isDefault: id === foreign + 10,
  });
  const songs: Readonly<Record<'l1' | 'l2', Record<string, unknown>>> = {
    l1: {
      id: ids.l1,
      name: 'Synthetisch Lieder Eins',
      category: { id: ids.sc1, name: 'Synthetisch Lieder' },
      arrangements: [arrangement(foreign + 10)],
      meta: { modifiedDate: at(1, 8), modifiedPerson: p2 },
    },
    l2: {
      id: ids.l2,
      name: 'Synthetisch Lieder Zwei',
      category: { id: ids.sc1, name: 'Synthetisch Lieder' },
      arrangements: [arrangement(foreign + 11), arrangement(foreign + 12)],
      meta: { modifiedDate: at(2, 8), modifiedPerson: p2 },
    },
  };
  const foreignSong = {
    id: foreign + 13,
    name: canaries.groupName,
    category: { id: foreign + 14, name: canaries.personName },
    arrangements: [],
  };
  const event = {
    id: ids.e1,
    guid: made(makeGuid()),
    name: 'Synthetisch Gottesdienst',
    startDate: at(6, 9),
    endDate: at(6, 11),
    eventServices: [
      {
        id: foreign + 1,
        personId: setting.personId,
        serviceId: ids.s1,
        agreed: true,
        person: p1,
      },
      {
        id: foreign + 2,
        personId: setting.p2 + 1,
        serviceId: ids.s2,
        agreed: false,
        person: p2,
      },
    ],
  };
  const foreignEvent = {
    id: foreign + 3,
    guid: made(makeGuid()),
    name: canaries.groupName,
    startDate: at(13, 9),
    endDate: at(13, 11),
    eventServices: [],
  };
  const agendaSong = {
    id: ids.l1,
    songId: ids.l1,
    arrangementId: foreign + 10,
    title: 'Synthetisch Lieder Eins',
  };
  const resource = {
    id: ids.r1,
    name: 'Synthetisch Saal',
    resourceTypeId: ids.rt1,
  };
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
  const missing = (): Response => answer({ message: canaries.personName }, 404);
  const plain = (data: readonly unknown[]): Response =>
    answer({ data, meta: { count: data.length } });
  const listOf = (url: URL, data: readonly unknown[]): Response => {
    const limitText = url.searchParams.get('limit') ?? '10';
    const pageText = url.searchParams.get('page') ?? '1';
    if (!/^[1-9]\d*$/.test(limitText) || Number(limitText) > domainsLimit) {
      return invalid('limit', limitText);
    }
    if (!/^[1-9]\d*$/.test(pageText)) {
      return invalid('page', pageText);
    }
    const limit = Number(limitText);
    const page = Number(pageText);
    return answer({
      data: data.slice((page - 1) * limit, page * limit),
      meta: {
        count: data.length,
        pagination: {
          total: data.length,
          limit: Math.min(limit, options.echoCap ?? limit),
          current: page,
          lastPage: Math.max(1, Math.ceil(data.length / limit)),
        },
      },
    });
  };
  const unknown = String(2_147_483_647);
  const respondDomain = (url: URL, parts: readonly string[]): Response => {
    const [, second, third, fourth] = parts;
    const query = url.searchParams;
    switch (operationOf(parts)) {
      case 'calendars':
        return plain([
          ...shown('c1', calendar),
          { id: foreign, name: canaries.groupName, isPublic: true },
        ]);
      case 'calendarAppointments':
        return query.getAll('calendar_ids[]').includes(String(ids.c1))
          ? plain(appointments)
          : invalid('calendar_ids', '');
      case 'calendarAppointment': {
        if (fourth === unknown && options.unknownExists === true) {
          return answer({ data: appointment(foreign + 4, 5, 0) });
        }
        const found =
          second === String(ids.c1)
            ? appointments.find(
                (entry) =>
                  String((entry['base'] as { id: number }).id) === fourth,
              )
            : undefined;
        return found === undefined ? missing() : answer({ data: found });
      }
      case 'events':
        return listOf(url, [...shown('e1', event), foreignEvent]);
      case 'event':
        if (second === unknown && options.unknownExists === true) {
          return answer({ data: foreignEvent });
        }
        return second === String(ids.e1) ? answer({ data: event }) : missing();
      case 'eventAgenda':
        return second === String(ids.e1)
          ? answer({
              data: {
                id: foreign + 5,
                name: 'Synthetisch Ablauf',
                isFinal: false,
                items: [
                  {
                    id: foreign + 6,
                    title: 'Synthetisch Lieder Eins',
                    type: 'song',
                    song: agendaSong,
                    responsible: { persons: [{ person: p1 }] },
                  },
                ],
              },
            })
          : missing();
      case 'eventAgendaSongs':
        return second === String(ids.e1) ? plain([agendaSong]) : missing();
      case 'services':
        return plain([
          ...shown('s1', {
            id: ids.s1,
            name: 'Synthetisch Predigt',
            serviceGroupId: ids.sg1,
          }),
          ...shown('s2', {
            id: ids.s2,
            name: 'Synthetisch Beamer',
            serviceGroupId: ids.sg1,
          }),
          {
            id: foreign + 7,
            name: canaries.groupName,
            serviceGroupId: foreign,
          },
        ]);
      case 'serviceGroups':
        return plain([
          ...shown('sg1', { id: ids.sg1, name: 'Synthetisch Dienste' }),
          { id: foreign + 8, name: canaries.groupName },
        ]);
      case 'resourceTypes':
        return plain([
          ...shown('rt1', { id: ids.rt1, name: 'Synthetisch Raeume' }),
        ]);
      case 'resources':
        return plain([
          ...shown('r1', resource),
          {
            id: foreign + 9,
            name: canaries.groupName,
            resourceTypeId: foreign,
          },
        ]);
      case 'bookings':
        return query.getAll('resource_ids[]').includes(String(ids.r1))
          ? plain([
              {
                base: {
                  id: foreign + 15,
                  caption: 'Synthetisch Probe',
                  resource,
                  person: p1,
                },
                calculated: { startDate: at(4, 18), endDate: at(4, 20) },
              },
            ])
          : invalid('resource_ids', '');
      case 'songs': {
        const filter = query.getAll('song_category_ids[]');
        const visible = [
          ...shown('l1', songs.l1),
          ...shown('l2', songs.l2),
          ...(filter.length === 0 ? [foreignSong] : []),
        ];
        return filter.length === 0 || filter.includes(String(ids.sc1))
          ? listOf(url, visible)
          : listOf(url, []);
      }
      case 'song':
      case 'songArrangements': {
        if (second === unknown && options.unknownExists === true) {
          return answer({ data: foreignSong });
        }
        const label =
          second === String(ids.l1)
            ? 'l1'
            : second === String(ids.l2)
              ? 'l2'
              : undefined;
        if (label === undefined) {
          return missing();
        }
        return third === undefined
          ? answer({ data: songs[label] })
          : plain(songs[label]['arrangements'] as unknown[]);
      }
      case 'wikiSearch': {
        const term = query.get('query');
        if (term === null || term === '') {
          return invalid('query', '');
        }
        const categories = query.getAll('wiki_category_ids[]');
        return term.toLowerCase() === 'spikeprobe' &&
          (categories.length === 0 ||
            categories.includes(String(identification)))
          ? plain([
              {
                title: 'Spikeprobe Seite',
                domainType: 'wiki_page',
                domainIdentifier: made(makeGuid()),
                domainAttributes: {},
              },
            ])
          : plain([]);
      }
      case 'search': {
        const term = query.get('query');
        if (term === null || term === '') {
          return invalid('query', '');
        }
        const types = query.getAll('domain_types[]');
        const wanted = (type: string): boolean =>
          types.length === 0 || types.includes(type);
        // Only songs carry the term in their names; the search names them
        // by text, as it does every object.
        const hits = wanted('song')
          ? (['l1', 'l2'] as const)
              .filter(
                (label) =>
                  !hidden.has(label) &&
                  String(songs[label]['name'])
                    .toLowerCase()
                    .includes(term.toLowerCase()),
              )
              .map((label) => ({
                title: songs[label]['name'],
                domainType: 'song',
                domainIdentifier: String(ids[label]),
                domainAttributes: {},
              }))
          : [];
        return plain(hits);
      }
      default:
        return missing();
    }
  };
  const respond = (url: URL): Response => {
    const path = url.pathname;
    if (path === '/api/wiki/categories') {
      return answer({
        data: [
          {
            id: identification,
            name: identificationCategoryName,
            permissions: { canEdit: false, canDelete: false },
          },
        ],
        meta: { count: 1 },
        permissions: { editMasterData: false },
      });
    }
    if (path === '/api/permissions/global') {
      return answer({ data: options.rights ?? domainRights(setting) });
    }
    const parts = path.split('/').slice(2);
    const name = operationOf(parts);
    if (name !== undefined && (options.denied ?? []).includes(name)) {
      return answer(
        { message: canaries.personName, args: { id: parts[1] } },
        403,
      );
    }
    return respondDomain(url, parts);
  };
  return {
    calls,
    generated,
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
