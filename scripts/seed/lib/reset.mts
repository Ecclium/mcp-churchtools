/**
 * The command `zuruecksetzen`: deletes the content of the seed that carries
 * its marker, inside the structure the seed made.
 *
 * The order: pages of the wiki, then events, appointments, songs and
 * bookings. Events go before the songs, because the agenda of an event
 * names a song, and with `sendMail=false`, so nobody gets a mail. On
 * ChurchTools 3.138 deleting an event leaves its appointment, so the seed
 * deletes the appointment afterwards, and only once its event is gone:
 * deleting an appointment would take the event along without
 * `sendMail=false`. An object that is already gone answers 404 and counts
 * as such.
 *
 * Structure, persons and groups stay, so the seed account needs no right
 * to delete persons or groups.
 *
 * @packageDocumentation
 */
import { isId } from '../../spike/lib/gate.mts';
import { isObject, type JsonObject } from '../../spike/lib/spec.mts';
import { datedData, pages, songs } from './data.mts';
import { noteAll, unreadable, type CommandContext } from './create.mts';
import {
  findOne,
  findPages,
  findSongs,
  findStructure,
  idOf,
  readAppointments,
  readBookings,
  readEvents,
  searchWindow,
} from './find.mts';
import type { SeedRun } from './run.mts';

async function deleted(
  run: SeedRun,
  section: Parameters<SeedRun['note']>[0],
  label: string,
  request: Parameters<SeedRun['write']>[2],
): Promise<boolean> {
  if ((await run.write(section, label, request, true)) !== undefined) {
    run.note(section, label, 'geloescht');
    return true;
  }
  // A 404 counts as gone; the run has noted it so.
  return run.report.get(section)?.get(label) === 'nicht mehr vorhanden';
}

async function resetPages(context: CommandContext): Promise<void> {
  const { run, pass } = context;
  const category = pass.seedCategory;
  if (category === undefined) {
    return;
  }
  const labels = pages.map((spec) => spec.label);
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
    const page = found.get(spec.label);
    if (page === 'mehrfach') {
      run.note('seiten', spec.label, 'mehrfach');
    } else if (typeof page === 'object') {
      await deleted(run, 'seiten', spec.label, {
        operation: 'wikiPageDelete',
        parameters: [category.id, page.guid],
      });
    }
  }
}

function calendarOf(event: JsonObject): string | undefined {
  const calendar = event['calendar'];
  const id = isObject(calendar) ? calendar['domainIdentifier'] : undefined;
  return typeof id === 'string' ? id : undefined;
}

async function resetDated(
  context: CommandContext,
  calendar: number | undefined,
): Promise<void> {
  const { run, now } = context;
  const data = datedData(now);
  const window = searchWindow(now);
  if (calendar === undefined) {
    return;
  }
  const appointments = await readAppointments(run, calendar, window);
  if (appointments === undefined) {
    noteAll(
      run,
      'termine',
      data.appointments.map((spec) => spec.label),
      unreadable(run),
    );
    return;
  }
  const found = data.appointments.map((spec) => ({
    spec,
    found: findOne(appointments, (base) => base['title'] === spec.title),
  }));
  const events = await readEvents(run, window);
  // Appointments whose event is still there, or may be.
  const held = new Set<string>();
  for (const { spec, found: appointment } of found) {
    if (spec.event === undefined) {
      continue;
    }
    if (appointment === 'mehrfach') {
      // Which event goes with which appointment is unclear; both stay.
      run.note('events', spec.event.label, 'mehrfach');
      continue;
    }
    if (events === undefined) {
      run.note('events', spec.event.label, unreadable(run));
      held.add(spec.label);
      continue;
    }
    const appointmentId = idOf(appointment);
    // An event of the seed belongs to one of its appointments, or lies in
    // its calendar and carries the title of one.
    const own = events.filter(
      (event) =>
        (appointmentId !== undefined &&
          event['appointmentId'] === appointmentId) ||
        (calendarOf(event) === String(calendar) &&
          event['name'] === spec.title),
    );
    const ids = new Set(own.map((event) => event['id']).filter(isId));
    if (ids.size > 1) {
      run.note('events', spec.event.label, 'mehrfach');
      held.add(spec.label);
      continue;
    }
    const [eventId] = ids;
    if (
      eventId !== undefined &&
      !(await deleted(run, 'events', spec.event.label, {
        operation: 'eventDelete',
        parameters: [eventId],
      }))
    ) {
      held.add(spec.label);
    }
  }
  for (const { spec, found: appointment } of found) {
    if (appointment === 'mehrfach') {
      run.note('termine', spec.label, 'mehrfach');
    } else if (held.has(spec.label) && typeof appointment === 'object') {
      run.note('termine', spec.label, 'uebersprungen');
    } else if (typeof appointment === 'object') {
      await deleted(run, 'termine', spec.label, {
        operation: 'appointmentDelete',
        parameters: [calendar, appointment.id],
      });
    }
  }
}

async function resetSongs(
  context: CommandContext,
  category: number | undefined,
): Promise<void> {
  const { run } = context;
  if (category === undefined) {
    return;
  }
  const found = await findSongs(run, category);
  if (found === undefined) {
    noteAll(
      run,
      'lieder',
      songs.map((spec) => spec.label),
      unreadable(run),
    );
    return;
  }
  for (const spec of songs) {
    const song = found.get(spec.label);
    if (song === 'mehrfach') {
      run.note('lieder', spec.label, 'mehrfach');
    } else if (typeof song === 'object') {
      await deleted(run, 'lieder', spec.label, {
        operation: 'songDelete',
        parameters: [song.id],
      });
    }
  }
}

async function resetBookings(
  context: CommandContext,
  resource: number | undefined,
): Promise<void> {
  const { run, now } = context;
  if (resource === undefined) {
    return;
  }
  const data = datedData(now);
  // The booking of the appointment over a whole day usually goes with it.
  // If it is still there, the seed deletes it as well.
  const targets = [
    ...data.bookings.map(({ label, title }) => ({ label, title })),
    ...data.appointments
      .filter((spec) => spec.booksResource)
      .map(({ label, title }) => ({ label, title })),
  ];
  const bookings = await readBookings(run, resource, searchWindow(now));
  if (bookings === undefined) {
    noteAll(
      run,
      'buchungen',
      targets.map((target) => target.label),
      unreadable(run),
    );
    return;
  }
  for (const target of targets) {
    const booking = findOne(bookings, (base) => base['title'] === target.title);
    if (booking === 'mehrfach') {
      run.note('buchungen', target.label, 'mehrfach');
    } else if (typeof booking === 'object') {
      await deleted(run, 'buchungen', target.label, {
        operation: 'bookingDelete',
        parameters: [booking.id],
      });
    }
  }
}

/**
 * Runs `zuruecksetzen`: deletes the content of the seed and keeps
 * structure, persons and groups.
 *
 * @param context - Run, settings and what the guard found.
 * @returns Nothing; the run holds the report.
 */
export async function resetAll(context: CommandContext): Promise<void> {
  const found = await findStructure(context.run);
  await resetPages(context);
  await resetDated(context, idOf(found.calendar));
  await resetSongs(context, idOf(found.songCategory));
  await resetBookings(context, idOf(found.resource));
}
