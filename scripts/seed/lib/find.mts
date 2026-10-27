/**
 * Finds the objects of the seed on the instance.
 *
 * The seed keeps no state file. Each command reads the lists again and
 * recognises its objects by the exact names of the data set, which all
 * carry the marker. Content it looks for only inside the structure it
 * made itself: appointments in its calendar, bookings of its resource,
 * songs in its song category, pages in its category of the wiki. An object
 * that appears twice is reported as «mehrfach» and left alone, so the seed
 * never guesses which one is its own.
 *
 * @packageDocumentation
 */
import { isId } from '../../spike/lib/gate.mts';
import { pathFor } from '../../spike/lib/http.mts';
import { pagination } from '../../spike/lib/listing.mts';
import { operations, seedOperations } from '../../spike/lib/operations.mts';
import { isObject, type JsonObject } from '../../spike/lib/spec.mts';
import {
  groups,
  marker,
  pages,
  persons,
  services,
  songs,
  structure,
  type GroupSpec,
  type PageSpec,
  type PersonSpec,
  type SongSpec,
} from './data.mts';
import { dateOnly } from './dates.mts';
import type { SeedRun } from './run.mts';

/** Entries per page when the seed reads a list that pages. */
export const pageLimit = 100;

/** The most pages the seed reads of one list. */
export const maxPages = 20;

/** What the seed found for one object of the data set. */
export type Found =
  { readonly id: number; readonly entry: JsonObject } | 'mehrfach' | undefined;

/** The days the seed reads appointments, events and bookings in. */
export interface Window {
  readonly from: string;
  readonly to: string;
}

/**
 * The days around a run in which the seed looks for its dated objects:
 * 90 days back and 120 days ahead, so a reset weeks after the run still
 * finds them.
 *
 * @param now - The time of the run.
 * @returns The first and the last day, in UTC.
 */
export function searchWindow(now: Date): Window {
  const day = 24 * 60 * 60 * 1000;
  return {
    from: dateOnly(new Date(now.getTime() - 90 * day)),
    to: dateOnly(new Date(now.getTime() + 120 * day)),
  };
}

/**
 * Reads a list, page by page if it pages.
 *
 * @param run - The run.
 * @param path - Filled path of the list.
 * @param query - Query parameters besides `limit` and `page`.
 * @param paged - Whether the list takes `limit` and `page`.
 * @returns The entries, or `undefined` if an answer had another form or the run stopped.
 */
export async function readList(
  run: SeedRun,
  path: string,
  query: readonly (readonly [string, string])[],
  paged: boolean,
): Promise<readonly JsonObject[] | undefined> {
  const all: JsonObject[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const response = await run.read(
      path,
      paged
        ? [...query, ['limit', String(pageLimit)], ['page', String(page)]]
        : query,
    );
    const data = isObject(response?.body) ? response.body['data'] : undefined;
    if (
      response?.status !== 200 ||
      !Array.isArray(data) ||
      !data.every(isObject)
    ) {
      return undefined;
    }
    all.push(...data);
    const lastPage = pagination(response.body)?.['lastPage'];
    if (!paged || typeof lastPage !== 'number' || page >= lastPage) {
      return all;
    }
  }
  return undefined;
}

/**
 * Picks the one entry that matches.
 *
 * @param entries - The entries of a list.
 * @param matches - Whether an entry is the object looked for.
 * @returns The entry with its ID, «mehrfach», or `undefined` if none matches.
 */
export function findOne(
  entries: readonly JsonObject[],
  matches: (entry: JsonObject) => boolean,
): Found {
  const ids = new Map<number, JsonObject>();
  for (const entry of entries) {
    const id = entry['id'];
    if (isId(id) && matches(entry)) {
      ids.set(id, entry);
    }
  }
  if (ids.size > 1) {
    return 'mehrfach';
  }
  const [first] = ids;
  return first === undefined ? undefined : { id: first[0], entry: first[1] };
}

/**
 * Takes the ID of a found object, if there is exactly one.
 *
 * @param found - What the seed found.
 * @returns The ID, or `undefined`.
 */
export function idOf(found: Found): number | undefined {
  return typeof found === 'object' ? found.id : undefined;
}

const named =
  (name: string) =>
  (entry: JsonObject): boolean =>
    entry['name'] === name;

/** The structure of the seed as found on the instance. */
export interface Structure {
  status: Found;
  groupType: Found;
  calendar: Found;
  resourceType: Found;
  resource: Found;
  serviceGroup: Found;
  services: Map<'s1' | 's2', Found>;
  songCategory: Found;
}

/**
 * Reads the lists of the structure and finds the objects of the seed.
 * A list that cannot be read leaves its objects `undefined`.
 *
 * @param run - The run.
 * @returns What the seed found.
 */
export async function findStructure(run: SeedRun): Promise<Structure> {
  const read = (path: string): Promise<readonly JsonObject[] | undefined> =>
    readList(run, path, [], false);
  const one = (
    entries: readonly JsonObject[] | undefined,
    matches: (entry: JsonObject) => boolean,
  ): Found => (entries === undefined ? undefined : findOne(entries, matches));

  const statuses = await read(seedOperations.statuses.template);
  const groupTypes = await read(seedOperations.groupTypes.template);
  const calendars = await read(operations.calendars.template);
  const resourceTypes = await read(operations.resourceTypes.template);
  const resources = await read(operations.resources.template);
  const serviceGroups = await read(operations.serviceGroups.template);
  const serviceList = await read(operations.services.template);
  const songCategories = await read(seedOperations.songCategories.template);

  const resourceType = one(resourceTypes, named(structure.resourceType.name));
  const serviceGroup = one(serviceGroups, named(structure.serviceGroup.name));
  const typeId = idOf(resourceType);
  const groupId = idOf(serviceGroup);
  return {
    status: one(statuses, named(structure.status.name)),
    groupType: one(groupTypes, named(structure.groupType.name)),
    calendar: one(calendars, named(structure.calendar.name)),
    resourceType,
    resource:
      typeId === undefined
        ? undefined
        : one(
            resources,
            (entry) =>
              entry['name'] === structure.resource.name &&
              entry['resourceTypeId'] === typeId,
          ),
    serviceGroup,
    services: new Map(
      services.map((spec) => [
        spec.label,
        groupId === undefined
          ? undefined
          : one(
              serviceList,
              (entry) =>
                entry['name'] === spec.name &&
                entry['serviceGroupId'] === groupId,
            ),
      ]),
    ),
    songCategory: one(songCategories, named(structure.songCategory.name)),
  };
}

/**
 * Finds the persons of the seed by first and last name.
 *
 * @param run - The run.
 * @returns What the seed found per person, or `undefined` if the list cannot be read.
 */
export async function findPersons(
  run: SeedRun,
): Promise<Map<PersonSpec['label'], Found> | undefined> {
  const entries = await readList(
    run,
    operations.persons.template,
    [['lastName', marker]],
    true,
  );
  if (entries === undefined) {
    return undefined;
  }
  return new Map(
    persons.map((spec) => [
      spec.label,
      findOne(
        entries,
        (entry) =>
          entry['firstName'] === spec.firstName &&
          entry['lastName'] === spec.lastName,
      ),
    ]),
  );
}

/**
 * Finds the groups of the seed in its group type.
 *
 * @param run - The run.
 * @param groupTypeId - The group type of the seed.
 * @returns What the seed found per group, or `undefined` if the list cannot be read.
 */
export async function findGroups(
  run: SeedRun,
  groupTypeId: number,
): Promise<Map<GroupSpec['label'], Found> | undefined> {
  const entries = await readList(
    run,
    operations.groups.template,
    [
      ['query', marker],
      ['group_type_ids[]', String(groupTypeId)],
    ],
    true,
  );
  if (entries === undefined) {
    return undefined;
  }
  return new Map(
    groups.map((spec) => [spec.label, findOne(entries, named(spec.name))]),
  );
}

/**
 * Reads the persons in a group.
 *
 * @param run - The run.
 * @param groupId - The group.
 * @returns The IDs of its members, or `undefined` if the list cannot be read.
 */
export async function readMembers(
  run: SeedRun,
  groupId: number,
): Promise<ReadonlySet<number> | undefined> {
  const entries = await readList(
    run,
    pathFor(operations.groupMembers.template, groupId),
    [],
    true,
  );
  if (entries === undefined) {
    return undefined;
  }
  return new Set(
    entries.map((entry) => entry['personId']).filter((id) => isId(id)),
  );
}

/**
 * Finds the songs of the seed in its song category.
 *
 * @param run - The run.
 * @param categoryId - The song category of the seed.
 * @returns What the seed found per song, or `undefined` if the list cannot be read.
 */
export async function findSongs(
  run: SeedRun,
  categoryId: number,
): Promise<Map<SongSpec['label'], Found> | undefined> {
  const entries = await readList(
    run,
    operations.songs.template,
    [['song_category_ids[]', String(categoryId)]],
    true,
  );
  if (entries === undefined) {
    return undefined;
  }
  return new Map(
    songs.map((spec) => [spec.label, findOne(entries, named(spec.name))]),
  );
}

/**
 * Takes the base of an appointment or booking from an entry of its list,
 * which carries it as `base` or inside `appointment` or `booking`.
 *
 * @param entry - One entry of the list.
 * @returns The base object, or `undefined`.
 */
export function baseOf(entry: JsonObject): JsonObject | undefined {
  for (const value of [
    entry['base'],
    isObject(entry['appointment']) ? entry['appointment']['base'] : undefined,
    isObject(entry['booking']) ? entry['booking']['base'] : undefined,
  ]) {
    if (isObject(value)) {
      return value;
    }
  }
  return undefined;
}

/**
 * Reads the appointments of a calendar in the window, by the base object of
 * each entry. A series appears once per date; {@link findOne} counts it once.
 *
 * @param run - The run.
 * @param calendarId - The calendar of the seed.
 * @param window - The days to read.
 * @returns The base objects, or `undefined` if the list cannot be read.
 */
export async function readAppointments(
  run: SeedRun,
  calendarId: number,
  window: Window,
): Promise<readonly JsonObject[] | undefined> {
  const entries = await readList(
    run,
    pathFor(seedOperations.calendarAppointmentList.template, calendarId),
    [
      ['from', window.from],
      ['to', window.to],
    ],
    false,
  );
  return entries?.map(baseOf).filter((base) => base !== undefined);
}

/**
 * Reads the bookings of a resource in the window, by the base object of
 * each entry.
 *
 * @param run - The run.
 * @param resourceId - The resource of the seed.
 * @param window - The days to read.
 * @returns The base objects, or `undefined` if the list cannot be read.
 */
export async function readBookings(
  run: SeedRun,
  resourceId: number,
  window: Window,
): Promise<readonly JsonObject[] | undefined> {
  const entries = await readList(
    run,
    operations.bookings.template,
    [
      ['resource_ids[]', String(resourceId)],
      ['from', window.from],
      ['to', window.to],
    ],
    false,
  );
  return entries?.map(baseOf).filter((base) => base !== undefined);
}

/**
 * Reads the events in the window.
 *
 * @param run - The run.
 * @param window - The days to read.
 * @returns The events, or `undefined` if the list cannot be read.
 */
export async function readEvents(
  run: SeedRun,
  window: Window,
): Promise<readonly JsonObject[] | undefined> {
  return readList(
    run,
    operations.events.template,
    [
      ['from', window.from],
      ['to', window.to],
    ],
    true,
  );
}

/** A page of the wiki as the seed finds it, by its GUID. */
export type FoundPage = { readonly guid: string } | 'mehrfach' | undefined;

/**
 * Finds the pages of the seed in its category of the wiki.
 *
 * @param run - The run.
 * @param categoryId - The category of the seed.
 * @returns What the seed found per page, or `undefined` if the list cannot be read.
 */
export async function findPages(
  run: SeedRun,
  categoryId: number,
): Promise<Map<PageSpec['label'], FoundPage> | undefined> {
  const entries = await readList(
    run,
    pathFor(operations.wikiCategoryPages.template, categoryId),
    [],
    false,
  );
  if (entries === undefined) {
    return undefined;
  }
  return new Map(
    pages.map((spec) => {
      const guids = entries
        .filter((entry) => entry['title'] === spec.title)
        .map((entry) => entry['guid'])
        .filter((guid) => typeof guid === 'string');
      const found: FoundPage =
        guids.length > 1
          ? 'mehrfach'
          : guids[0] === undefined
            ? undefined
            : { guid: guids[0] };
      return [spec.label, found];
    }),
  );
}
