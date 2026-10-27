/**
 * The command `anlegen`: creates every object of the data set that is
 * missing and leaves every object that is already there.
 *
 * The order follows what depends on what: the structure first, then
 * persons, groups and their members, songs, appointments with their
 * events, the assignments and the agenda, bookings, and last the pages of
 * the wiki. What depends on an object that is missing or was refused is
 * skipped and noted as such.
 *
 * One spot is coarse: if an appointment is already there, the seed also
 * leaves its event, assignments and agenda as they are. An event left half
 * done by an earlier run therefore needs `zuruecksetzen` first.
 *
 * Nothing it does sends a mail: persons have no address and no invitation,
 * members are added with `informLeader: false`, the services of the seed
 * send neither requests nor reminders, and the seed assigns persons only
 * after it has read back that they do not.
 *
 * @packageDocumentation
 */
import { isId } from '../../spike/lib/gate.mts';
import type { Json } from '../../spike/lib/guard.mts';
import { pathFor, type SeedRequest } from '../../spike/lib/http.mts';
import { operations } from '../../spike/lib/operations.mts';
import type { SeedPass, SeedSettings } from '../../spike/lib/seed-gate.mts';
import { isObject, type JsonObject } from '../../spike/lib/spec.mts';
import {
  datedData,
  groups,
  pages,
  persons,
  services,
  songs,
  structure,
  type AppointmentSpec,
  type PersonLabel,
} from './data.mts';
import { dateOnly, dateTime } from './dates.mts';
import {
  findGroups,
  findOne,
  findPages,
  findPersons,
  findSongs,
  findStructure,
  readAppointments,
  readBookings,
  readEvents,
  readMembers,
  searchWindow,
  type Found,
} from './find.mts';
import {
  dataObject,
  type Outcome,
  type SeedRun,
  type Section,
} from './run.mts';

/** What a command of the seed works with. */
export interface CommandContext {
  readonly run: SeedRun;
  readonly settings: SeedSettings;
  readonly pass: SeedPass;
  readonly now: Date;
}

/** The sort key of every object of the structure, so they stay at the end. */
const sortKey = 990;

/**
 * Notes the same outcome for several objects.
 *
 * @param run - The run.
 * @param section - The section of the report.
 * @param labels - The labels of the objects.
 * @param outcome - A fixed word.
 */
export function noteAll(
  run: SeedRun,
  section: Section,
  labels: readonly string[],
  outcome: Outcome,
): void {
  for (const label of labels) {
    run.note(section, label, outcome);
  }
}

/**
 * The word for a list that could not be read: «uebersprungen» once the run
 * has stopped, otherwise «antwort unerwartet».
 *
 * @param run - The run.
 * @returns The word.
 */
export function unreadable(run: SeedRun): Outcome {
  return run.stopped === undefined ? 'antwort unerwartet' : 'uebersprungen';
}

async function created(
  run: SeedRun,
  section: Section,
  label: string,
  request: SeedRequest,
): Promise<number | undefined> {
  const response = await run.write(section, label, request);
  if (response === undefined) {
    return undefined;
  }
  const id = dataObject(response)?.['id'];
  if (!isId(id)) {
    run.note(section, label, 'antwort unerwartet');
    return undefined;
  }
  run.note(section, label, 'angelegt');
  return id;
}

async function ensure(
  run: SeedRun,
  section: Section,
  label: string,
  found: Found,
  create: (() => Promise<number | undefined>) | undefined,
): Promise<number | undefined> {
  if (found === 'mehrfach') {
    run.note(section, label, 'mehrfach');
    return undefined;
  }
  if (found !== undefined) {
    run.note(section, label, 'vorhanden');
    return found.id;
  }
  if (create === undefined) {
    run.note(section, label, 'uebersprungen');
    return undefined;
  }
  return create();
}

/** The IDs of the structure, where the seed found or made it. */
interface StructureIds {
  readonly groupType: number | undefined;
  readonly calendar: number | undefined;
  readonly resource: number | undefined;
  readonly services: ReadonlyMap<'s1' | 's2', number>;
  readonly songCategory: number | undefined;
  /** Whether the seed made the calendar in this run, its very first. */
  readonly fresh: boolean;
  /** Whether both services are known not to send mails. */
  readonly quiet: boolean;
}

function sendsNoMail(entry: JsonObject | undefined): boolean {
  return (
    entry !== undefined &&
    entry['sendServiceRequestEmails'] === false &&
    entry['sendReminderMails'] === false
  );
}

async function ensureService(
  run: SeedRun,
  spec: (typeof services)[number],
  before: Found,
  serviceGroup: number | undefined,
): Promise<{ readonly id: number | undefined; readonly quiet: boolean }> {
  if (before === 'mehrfach' || before !== undefined) {
    const id = await ensure(run, 'struktur', spec.label, before, undefined);
    return {
      id,
      quiet: typeof before === 'object' && sendsNoMail(before.entry),
    };
  }
  if (serviceGroup === undefined) {
    run.note('struktur', spec.label, 'uebersprungen');
    return { id: undefined, quiet: false };
  }
  const response = await run.write('struktur', spec.label, {
    operation: 'serviceCreate',
    parameters: [],
    body: {
      name: spec.name,
      serviceGroupId: serviceGroup,
      hidePersonName: spec.hidePersonName,
      sendServiceRequestEmails: false,
      sendReminderMails: false,
      allowChat: false,
      allowDecline: true,
      allowExchange: false,
      allowCommentOnConfirmation: false,
      allowControlLiveAgenda: false,
      onlyAssignFromGroups: false,
      standard: false,
      sortKey,
      groupIds: [],
      tagIds: [],
    },
  });
  if (response === undefined) {
    return { id: undefined, quiet: false };
  }
  const entry = dataObject(response);
  const id = entry?.['id'];
  if (!isId(id)) {
    run.note('struktur', spec.label, 'antwort unerwartet');
    return { id: undefined, quiet: false };
  }
  run.note('struktur', spec.label, 'angelegt');
  // Checked as the instance reports the service, not as the seed asked.
  return { id, quiet: sendsNoMail(entry) };
}

async function ensureStructure(context: CommandContext): Promise<StructureIds> {
  const { run } = context;
  const found = await findStructure(run);
  const section = 'struktur';
  const groupType = await ensure(
    run,
    section,
    structure.groupType.label,
    found.groupType,
    () =>
      created(run, section, structure.groupType.label, {
        operation: 'groupTypeCreate',
        parameters: [],
        body: {
          name: structure.groupType.name,
          namePlural: structure.groupType.namePlural,
          shorty: structure.groupType.shorty,
          availableForNewPerson: false,
          color: 'basic',
          isLeaderNecessary: false,
          permissionDepth: 1,
          postsEnabled: false,
          sortKey,
        },
      }),
  );
  const calendar = await ensure(
    run,
    section,
    structure.calendar.label,
    found.calendar,
    () =>
      created(run, section, structure.calendar.label, {
        operation: 'calendarCreate',
        parameters: [],
        body: { name: structure.calendar.name, sortKey, type: 'church' },
      }),
  );
  const resourceType = await ensure(
    run,
    section,
    structure.resourceType.label,
    found.resourceType,
    () =>
      created(run, section, structure.resourceType.label, {
        operation: 'resourceTypeCreate',
        parameters: [],
        body: {
          name: structure.resourceType.name,
          namePlural: structure.resourceType.namePlural,
          sortKey,
        },
      }),
  );
  const resource = await ensure(
    run,
    section,
    structure.resource.label,
    found.resource,
    resourceType === undefined
      ? undefined
      : () =>
          created(run, section, structure.resource.label, {
            operation: 'resourceCreate',
            parameters: [],
            body: {
              name: structure.resource.name,
              resourceTypeId: resourceType,
              sortKey,
              isAutoAccept: true,
              isVirtual: false,
              needsAppointment: false,
            },
          }),
  );
  const serviceGroup = await ensure(
    run,
    section,
    structure.serviceGroup.label,
    found.serviceGroup,
    () =>
      created(run, section, structure.serviceGroup.label, {
        operation: 'serviceGroupCreate',
        parameters: [],
        body: {
          name: structure.serviceGroup.name,
          sortKey,
          viewAll: false,
          onlyVisibleInCampusFilter: false,
        },
      }),
  );
  const serviceIds = new Map<'s1' | 's2', number>();
  let quiet = true;
  for (const spec of services) {
    const result = await ensureService(
      run,
      spec,
      found.services.get(spec.label),
      serviceGroup,
    );
    if (result.id !== undefined) {
      serviceIds.set(spec.label, result.id);
    }
    quiet &&= result.quiet;
  }
  run.note('pruefungen', 'diensteOhneMails', quiet ? 'ja' : 'nein');
  const songCategory = await ensure(
    run,
    section,
    structure.songCategory.label,
    found.songCategory,
    () =>
      created(run, section, structure.songCategory.label, {
        operation: 'songCategoryCreate',
        parameters: [],
        body: { name: structure.songCategory.name, sortKey },
      }),
  );
  return {
    groupType,
    calendar,
    resource,
    services: serviceIds,
    songCategory,
    fresh: found.calendar === undefined && calendar !== undefined,
    quiet,
  };
}

async function ensureWikiCategory(
  context: CommandContext,
  fresh: boolean,
): Promise<void> {
  const { run, pass } = context;
  const label = structure.wikiCategory.label;
  if (pass.seedCategory !== undefined) {
    run.note('struktur', label, 'vorhanden');
    return;
  }
  // The account sees the category only once a person has given it the
  // right. The seed creates it only in the run that also made the
  // calendar, its first, so a later run cannot make it twice.
  if (!fresh) {
    run.note('struktur', label, 'fehlt');
    return;
  }
  await created(run, 'struktur', label, {
    operation: 'wikiCategoryCreate',
    parameters: [],
    body: {
      name: structure.wikiCategory.name,
      sortKey,
      inMenu: false,
      fileAccessWithoutPermission: false,
    },
  });
}

async function ensurePersons(
  context: CommandContext,
): Promise<Map<PersonLabel, number>> {
  const { run, settings } = context;
  const ids = new Map<PersonLabel, number>();
  const found = await findPersons(run);
  if (found === undefined) {
    noteAll(
      run,
      'personen',
      persons.map((spec) => spec.label),
      unreadable(run),
    );
    return ids;
  }
  for (const spec of persons) {
    const id = await ensure(
      run,
      'personen',
      spec.label,
      found.get(spec.label),
      () =>
        created(run, 'personen', spec.label, {
          operation: 'personCreate',
          parameters: [],
          body: {
            firstName: spec.firstName,
            lastName: spec.lastName,
            departmentIds: [settings.departmentId],
            campusId: settings.campusId,
            statusId: settings.statusId,
            privacyPolicyAgreementDate: dateOnly(context.now),
            privacyPolicyAgreementTypeId: settings.privacy.typeId,
            privacyPolicyAgreementWhoId: settings.privacy.whoId,
          },
        }),
    );
    if (id !== undefined) {
      ids.set(spec.label, id);
    }
  }
  return ids;
}

async function ensureMembers(
  context: CommandContext,
  spec: (typeof groups)[number],
  groupId: number,
  personIds: ReadonlyMap<PersonLabel, number>,
): Promise<void> {
  const { run, pass } = context;
  const own = `${spec.label}Seedkonto`;
  const members = await readMembers(run, groupId);
  if (members === undefined) {
    run.note('pruefungen', own, unreadable(run));
    noteAll(
      run,
      'mitglieder',
      spec.members.map((person) => `${spec.label}${person}`),
      'uebersprungen',
    );
    return;
  }
  // ChurchTools may make the account that creates a group its member. The
  // seed account belongs to no group (ADR 0049), so it leaves again.
  if (members.has(pass.accountId)) {
    const left = await run.write('pruefungen', own, {
      operation: 'groupMemberRemove',
      parameters: [groupId, pass.accountId],
    });
    if (left !== undefined) {
      run.note('pruefungen', own, 'entfernt');
    }
  } else {
    run.note('pruefungen', own, 'nein');
  }
  for (const person of spec.members) {
    const label = `${spec.label}${person}`;
    const personId = personIds.get(person);
    if (personId === undefined) {
      run.note('mitglieder', label, 'uebersprungen');
    } else if (members.has(personId)) {
      run.note('mitglieder', label, 'vorhanden');
    } else if (
      (await run.write('mitglieder', label, {
        operation: 'groupMemberAdd',
        parameters: [groupId, personId],
        body: { groupMemberStatus: 'active', informLeader: false },
      })) !== undefined
    ) {
      run.note('mitglieder', label, 'angelegt');
    }
  }
}

async function ensureGroups(
  context: CommandContext,
  groupType: number | undefined,
  personIds: ReadonlyMap<PersonLabel, number>,
): Promise<void> {
  const { run, settings } = context;
  const labels = groups.map((spec) => spec.label);
  if (groupType === undefined) {
    noteAll(run, 'gruppen', labels, 'uebersprungen');
    return;
  }
  const found = await findGroups(run, groupType);
  if (found === undefined) {
    noteAll(run, 'gruppen', labels, unreadable(run));
    return;
  }
  for (const spec of groups) {
    const groupId = await ensure(
      run,
      'gruppen',
      spec.label,
      found.get(spec.label),
      () =>
        created(run, 'gruppen', spec.label, {
          operation: 'groupCreate',
          parameters: [],
          body: {
            name: spec.name,
            groupTypeId: groupType,
            groupStatusId: settings.groupStatusId,
            campusId: settings.campusId,
            visibility: 'restricted',
          },
        }),
    );
    if (groupId !== undefined) {
      await ensureMembers(context, spec, groupId, personIds);
    }
  }
}

function defaultArrangement(entry: JsonObject): number | undefined {
  const list: unknown = entry['arrangements'];
  if (!Array.isArray(list)) {
    return undefined;
  }
  const chosen: unknown = list.find(
    (item) => isObject(item) && item['isDefault'] === true,
  );
  const id = isObject(chosen) ? chosen['id'] : undefined;
  return isId(id) ? id : undefined;
}

async function ensureSongs(
  context: CommandContext,
  category: number | undefined,
): Promise<Map<string, number>> {
  const { run } = context;
  const arrangementIds = new Map<string, number>();
  const labels = songs.map((spec) => spec.label);
  if (category === undefined) {
    noteAll(run, 'lieder', labels, 'uebersprungen');
    return arrangementIds;
  }
  const found = await findSongs(run, category);
  if (found === undefined) {
    noteAll(run, 'lieder', labels, unreadable(run));
    return arrangementIds;
  }
  for (const spec of songs) {
    const before = found.get(spec.label);
    const [first] = spec.arrangements;
    if (typeof before === 'object') {
      run.note('lieder', spec.label, 'vorhanden');
      const id = defaultArrangement(before.entry);
      if (id !== undefined && first !== undefined) {
        arrangementIds.set(first.label, id);
      }
      continue;
    }
    const songId = await ensure(run, 'lieder', spec.label, before, () =>
      created(run, 'lieder', spec.label, {
        operation: 'songCreate',
        parameters: [],
        body: {
          name: spec.name,
          categoryId: category,
          author: 'Seedprobe Autorin',
          copyright: 'Seedprobe',
          ccli: null,
          shouldPractice: false,
        },
      }),
    );
    for (const [index, arrangement] of spec.arrangements.entries()) {
      if (songId === undefined) {
        run.note('arrangements', arrangement.label, 'uebersprungen');
        continue;
      }
      const id = await created(run, 'arrangements', arrangement.label, {
        operation: 'arrangementCreate',
        parameters: [songId],
        body: {
          name: arrangement.name,
          key: arrangement.key,
          isDefault: index === 0,
        },
      });
      if (id !== undefined) {
        arrangementIds.set(arrangement.label, id);
      }
    }
  }
  return arrangementIds;
}

/**
 * Builds the body that creates an appointment, with its event and the
 * booking of the resource where the data set asks for them.
 *
 * @param spec - The appointment of the data set.
 * @param calendar - The calendar of the seed.
 * @param resource - The resource of the seed, if known.
 * @param serviceIds - The services of the seed that are known.
 * @returns The body of `POST /api/calendars/{id}/appointments`.
 */
export function appointmentBody(
  spec: AppointmentSpec,
  calendar: number,
  resource: number | undefined,
  serviceIds: ReadonlyMap<'s1' | 's2', number>,
): { readonly [key: string]: Json } {
  const body: Record<string, Json> = {
    calendarId: calendar,
    title: spec.title,
    isInternal: false,
    repeatId: spec.weeklyUntil === undefined ? 0 : 7,
  };
  if (spec.when.kind === 'time') {
    body['startDate'] = dateTime(spec.when.start);
    body['endDate'] = dateTime(spec.when.end);
  } else {
    body['startDate'] = dateOnly(spec.when.day);
    body['endDate'] = dateOnly(spec.when.day);
  }
  if (spec.weeklyUntil !== undefined) {
    body['repeatFrequency'] = 1;
    body['repeatUntil'] = dateOnly(spec.weeklyUntil);
  }
  if (spec.event !== undefined && spec.when.kind === 'time') {
    const wanted: Json[] = [];
    for (const { service, count } of spec.event.services) {
      const serviceId = serviceIds.get(service);
      if (serviceId !== undefined) {
        wanted.push({ serviceId, count });
      }
    }
    if (wanted.length === spec.event.services.length) {
      body['events'] = [
        { startDate: dateTime(spec.when.start), services: wanted },
      ];
    }
  }
  if (spec.booksResource && resource !== undefined) {
    body['bookings'] = [
      {
        resourceId: resource,
        statusId: 2,
        leadTimeMinutes: 0,
        afterwardMinutes: 0,
      },
    ];
  }
  return body;
}

interface EventWork {
  readonly spec: AppointmentSpec;
  readonly appointmentId: number;
  /** Whether the seed made the appointment in this run. */
  readonly fresh: boolean;
}

async function assign(
  context: CommandContext,
  ids: StructureIds,
  personIds: ReadonlyMap<PersonLabel, number>,
  spec: NonNullable<AppointmentSpec['event']>,
  eventId: number,
): Promise<void> {
  const { run } = context;
  // The list of events leaves the service requests out; only the single
  // event carries them, as the read tools of the server see it too.
  const response = await run.read(pathFor(operations.event.template, eventId));
  const event = response?.status === 200 ? dataObject(response) : undefined;
  if (event === undefined) {
    noteAll(
      run,
      'einteilungen',
      spec.assignments.map((assignment) => assignment.label),
      unreadable(run),
    );
    return;
  }
  const requests = Array.isArray(event['eventServices'])
    ? (event['eventServices'] as readonly unknown[]).filter(isObject)
    : [];
  const used = new Set<number>();
  for (const assignment of spec.assignments) {
    const serviceId = ids.services.get(assignment.service);
    const personId = personIds.get(assignment.person);
    const request = requests.find((entry) => {
      const id = entry['id'];
      return (
        entry['serviceId'] === serviceId &&
        (entry['personId'] === null || entry['personId'] === undefined) &&
        isId(id) &&
        !used.has(id)
      );
    });
    const requestId = request?.['id'];
    if (
      !ids.quiet ||
      serviceId === undefined ||
      personId === undefined ||
      !isId(requestId)
    ) {
      run.note('einteilungen', assignment.label, 'uebersprungen');
      continue;
    }
    used.add(requestId);
    const assigned = await run.write('einteilungen', assignment.label, {
      operation: 'serviceRequestAssign',
      parameters: [eventId, requestId],
      body: { personId },
    });
    if (assigned === undefined) {
      continue;
    }
    run.note('einteilungen', assignment.label, 'angelegt');
    if (!assignment.accept) {
      continue;
    }
    const accepted = await run.write(
      'einteilungen',
      `${assignment.label}Zusage`,
      {
        operation: 'serviceRequestAccept',
        parameters: [eventId, requestId],
        body: {},
      },
    );
    if (accepted !== undefined) {
      run.note('einteilungen', `${assignment.label}Zusage`, 'angelegt');
    }
  }
}

async function fillAgenda(
  context: CommandContext,
  calendar: number,
  arrangementIds: ReadonlyMap<string, number>,
  spec: NonNullable<AppointmentSpec['event']>,
  eventId: number,
): Promise<void> {
  const { run } = context;
  if (spec.agenda.length === 0) {
    return;
  }
  const agenda = await run.write('ablauf', spec.label, {
    operation: 'agendaCreate',
    parameters: [eventId],
    body: { calendarId: calendar, items: [] },
  });
  if (agenda === undefined) {
    noteAll(
      run,
      'ablauf',
      spec.agenda.map((item) => item.label),
      'uebersprungen',
    );
    return;
  }
  run.note('ablauf', spec.label, 'angelegt');
  for (const item of spec.agenda) {
    let body: { readonly [key: string]: Json };
    if (item.type === 'song') {
      const arrangementId = arrangementIds.get(`${item.song}a`);
      if (arrangementId === undefined) {
        run.note('ablauf', item.label, 'uebersprungen');
        continue;
      }
      body = { type: 'song', arrangementId, title: null };
    } else if (item.type === 'text') {
      body = { type: 'text', title: item.title, duration: item.duration };
    } else {
      body = { type: 'header', title: item.title };
    }
    if (
      (await run.write('ablauf', item.label, {
        operation: 'agendaItemCreate',
        parameters: [eventId],
        body,
      })) !== undefined
    ) {
      run.note('ablauf', item.label, 'angelegt');
    }
  }
}

async function ensureAppointments(
  context: CommandContext,
  ids: StructureIds,
  arrangementIds: ReadonlyMap<string, number>,
  personIds: ReadonlyMap<PersonLabel, number>,
): Promise<void> {
  const { run, now } = context;
  const data = datedData(now);
  const window = searchWindow(now);
  const labels = data.appointments.map((spec) => spec.label);
  const { calendar } = ids;
  if (calendar === undefined) {
    noteAll(run, 'termine', labels, 'uebersprungen');
    return;
  }
  const existing = await readAppointments(run, calendar, window);
  if (existing === undefined) {
    noteAll(run, 'termine', labels, unreadable(run));
    return;
  }
  const work: EventWork[] = [];
  for (const spec of data.appointments) {
    const before = findOne(existing, (base) => base['title'] === spec.title);
    const id = await ensure(run, 'termine', spec.label, before, () =>
      created(run, 'termine', spec.label, {
        operation: 'appointmentCreate',
        parameters: [calendar],
        body: appointmentBody(spec, calendar, ids.resource, ids.services),
      }),
    );
    if (id !== undefined && spec.event !== undefined) {
      work.push({ spec, appointmentId: id, fresh: before === undefined });
    }
  }
  if (work.length === 0) {
    return;
  }
  const events = await readEvents(run, window);
  for (const item of work) {
    const spec = item.spec.event;
    if (spec === undefined) {
      continue;
    }
    const event = events?.find(
      (entry) => entry['appointmentId'] === item.appointmentId,
    );
    const eventId = event?.['id'];
    if (event === undefined || !isId(eventId)) {
      run.note(
        'events',
        spec.label,
        events === undefined ? unreadable(run) : 'fehlt',
      );
      continue;
    }
    if (!item.fresh) {
      run.note('events', spec.label, 'vorhanden');
      continue;
    }
    run.note('events', spec.label, 'angelegt');
    await assign(context, ids, personIds, spec, eventId);
    await fillAgenda(context, calendar, arrangementIds, spec, eventId);
  }
}

async function ensureBookings(
  context: CommandContext,
  resource: number | undefined,
): Promise<void> {
  const { run, now } = context;
  const data = datedData(now);
  const labels = data.bookings.map((spec) => spec.label);
  if (resource === undefined) {
    noteAll(run, 'buchungen', labels, 'uebersprungen');
    return;
  }
  const existing = await readBookings(run, resource, searchWindow(now));
  if (existing === undefined) {
    noteAll(run, 'buchungen', labels, unreadable(run));
    return;
  }
  for (const spec of data.bookings) {
    await ensure(
      run,
      'buchungen',
      spec.label,
      findOne(existing, (base) => base['title'] === spec.title),
      () =>
        created(run, 'buchungen', spec.label, {
          operation: 'bookingCreate',
          parameters: [],
          body: {
            resourceId: resource,
            title: spec.title,
            startDate: dateTime(spec.start),
            endDate: dateTime(spec.end),
            statusId: 2,
            showInCal: false,
          },
        }),
    );
  }
  // The appointment over a whole day books the resource itself. Whether
  // that booking exists shows only in this list.
  for (const spec of data.appointments.filter((item) => item.booksResource)) {
    const booking = findOne(existing, (base) => base['title'] === spec.title);
    run.note(
      'buchungen',
      spec.label,
      booking === undefined
        ? 'fehlt'
        : booking === 'mehrfach'
          ? 'mehrfach'
          : 'vorhanden',
    );
  }
}

async function ensurePages(context: CommandContext): Promise<void> {
  const { run, pass } = context;
  const category = pass.seedCategory;
  const labels = pages.map((spec) => spec.label);
  if (category === undefined) {
    noteAll(run, 'seiten', labels, 'uebersprungen');
    return;
  }
  if (!category.canEdit) {
    noteAll(run, 'seiten', labels, 'ohne Recht');
    return;
  }
  const found = await findPages(run, category.id);
  if (found === undefined) {
    noteAll(run, 'seiten', labels, unreadable(run));
    return;
  }
  for (const spec of pages) {
    const before = found.get(spec.label);
    if (before !== undefined) {
      run.note(
        'seiten',
        spec.label,
        before === 'mehrfach' ? 'mehrfach' : 'vorhanden',
      );
      continue;
    }
    const response = await run.write('seiten', spec.label, {
      operation: 'wikiPageCreate',
      parameters: [category.id],
      body: {
        title: spec.title,
        isMarkdown: spec.isMarkdown,
        text: spec.text,
        onStartpage: false,
      },
    });
    if (response !== undefined) {
      run.note(
        'seiten',
        spec.label,
        typeof dataObject(response)?.['guid'] === 'string'
          ? 'angelegt'
          : 'antwort unerwartet',
      );
    }
  }
}

/**
 * Runs `anlegen`: creates whatever of the data set is missing.
 *
 * @param context - Run, settings and what the guard found.
 * @returns Nothing; the run holds the report.
 */
export async function createAll(context: CommandContext): Promise<void> {
  const ids = await ensureStructure(context);
  await ensureWikiCategory(context, ids.fresh);
  const personIds = await ensurePersons(context);
  await ensureGroups(context, ids.groupType, personIds);
  const arrangementIds = await ensureSongs(context, ids.songCategory);
  await ensureAppointments(context, ids, arrangementIds, personIds);
  await ensureBookings(context, ids.resource);
  await ensurePages(context);
}
