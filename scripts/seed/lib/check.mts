/**
 * The command `pruefen`: reports which objects of the data set are there,
 * without writing anything and without asking in the terminal.
 *
 * It runs the same checks of the guard as the commands that write, so a
 * person sees before the first write whether the guard lets the seed pass,
 * whether the account sees and may edit the category of the wiki, whether
 * the services of the seed send mails and whether the seed account is in
 * one of its groups.
 *
 * @packageDocumentation
 */
import {
  datedData,
  groups,
  pages,
  persons,
  services,
  songs,
  structure,
} from './data.mts';
import { noteAll, unreadable, type CommandContext } from './create.mts';
import {
  findGroups,
  findOne,
  findPages,
  findPersons,
  findSongs,
  findStructure,
  idOf,
  readAppointments,
  readBookings,
  readMembers,
  searchWindow,
  type Found,
  type FoundPage,
} from './find.mts';
import type { Outcome } from './run.mts';

function presence(found: Found | FoundPage): Outcome {
  if (found === 'mehrfach') {
    return 'mehrfach';
  }
  return found === undefined ? 'fehlt' : 'vorhanden';
}

function mails(found: Found): Outcome {
  if (typeof found !== 'object') {
    return 'fehlt';
  }
  return found.entry['sendServiceRequestEmails'] === false &&
    found.entry['sendReminderMails'] === false
    ? 'nein'
    : 'sendet Mails';
}

/**
 * Runs `pruefen`: notes for every object of the data set whether it is
 * there.
 *
 * @param context - Run, settings and what the guard found.
 * @returns Nothing; the run holds the report.
 */
export async function checkAll(context: CommandContext): Promise<void> {
  const { run, pass, now } = context;
  const found = await findStructure(run);
  const section = 'struktur';
  run.note(section, structure.status.label, presence(found.status));
  run.note(section, structure.groupType.label, presence(found.groupType));
  run.note(section, structure.calendar.label, presence(found.calendar));
  run.note(section, structure.resourceType.label, presence(found.resourceType));
  run.note(section, structure.resource.label, presence(found.resource));
  run.note(section, structure.serviceGroup.label, presence(found.serviceGroup));
  for (const spec of services) {
    const service = found.services.get(spec.label);
    run.note(section, spec.label, presence(service));
    run.note('pruefungen', `${spec.label}Mails`, mails(service));
  }
  run.note(section, structure.songCategory.label, presence(found.songCategory));
  const category = pass.seedCategory;
  run.note(
    section,
    structure.wikiCategory.label,
    category === undefined
      ? 'fehlt'
      : category.canEdit
        ? 'sichtbar und bearbeitbar'
        : 'sichtbar',
  );

  const people = await findPersons(run);
  for (const spec of persons) {
    run.note(
      'personen',
      spec.label,
      people === undefined ? unreadable(run) : presence(people.get(spec.label)),
    );
  }

  const groupType = idOf(found.groupType);
  const teams =
    groupType === undefined ? undefined : await findGroups(run, groupType);
  for (const spec of groups) {
    const group = teams?.get(spec.label);
    run.note(
      'gruppen',
      spec.label,
      teams === undefined && groupType !== undefined
        ? unreadable(run)
        : presence(group),
    );
    const groupId = idOf(group);
    if (groupId !== undefined) {
      const members = await readMembers(run, groupId);
      run.note(
        'pruefungen',
        `${spec.label}Seedkonto`,
        members === undefined
          ? unreadable(run)
          : members.has(pass.accountId)
            ? 'ja'
            : 'nein',
      );
    }
  }

  const songCategory = idOf(found.songCategory);
  const songList =
    songCategory === undefined ? undefined : await findSongs(run, songCategory);
  for (const spec of songs) {
    run.note('lieder', spec.label, presence(songList?.get(spec.label)));
  }

  const data = datedData(now);
  const window = searchWindow(now);
  const calendar = idOf(found.calendar);
  const appointments =
    calendar === undefined
      ? undefined
      : await readAppointments(run, calendar, window);
  for (const spec of data.appointments) {
    run.note(
      'termine',
      spec.label,
      appointments === undefined
        ? calendar === undefined
          ? 'fehlt'
          : unreadable(run)
        : presence(
            findOne(appointments, (base) => base['title'] === spec.title),
          ),
    );
  }

  const resource = idOf(found.resource);
  const bookings =
    resource === undefined
      ? undefined
      : await readBookings(run, resource, window);
  for (const spec of data.bookings) {
    run.note(
      'buchungen',
      spec.label,
      bookings === undefined
        ? 'fehlt'
        : presence(findOne(bookings, (base) => base['title'] === spec.title)),
    );
  }

  if (category === undefined) {
    noteAll(
      run,
      'seiten',
      pages.map((spec) => spec.label),
      'fehlt',
    );
    return;
  }
  const pageList = await findPages(run, category.id);
  for (const spec of pages) {
    run.note(
      'seiten',
      spec.label,
      pageList === undefined
        ? unreadable(run)
        : presence(pageList.get(spec.label)),
    );
  }
}
