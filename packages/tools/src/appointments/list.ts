/**
 * The tool `ct_appointments_list`: lists the appointments of up to 10
 * calendars between two days, 25 per call, one entry for each date, with
 * ID, calendar, title, subtitle, whole days, place, start and end
 * (ADR 0064).
 *
 * Like a plugin of a third party, it imports only the plugin API and zod
 * (ADR 0022).
 *
 * @packageDocumentation
 */
import {
  calendarDatePattern,
  classify,
  dateOrDateTimePattern,
  defineTool,
  EccliumError,
  isEventWindow,
  isListIds,
  maxAppointments,
  maxListIds,
  maxNameLength,
  type ToolCall,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

import {
  appointmentsRefused,
  calendarRight,
  invalidIds,
  listRefused,
} from '../calendars/rights.js';
import { invalidSpan } from '../events/list.js';

/**
 * The most appointments one call gives. 25 appointments with title,
 * subtitle and place of 255 letters fit into one result.
 */
export const appointmentsPerCall = 25;

/** The last page a call may ask for: the core reads at most 50. */
export const maxAppointmentPage = Math.ceil(
  maxAppointments / appointmentsPerCall,
);

/**
 * The note of an empty first page. ChurchTools refuses the appointments of
 * a calendar the account may not see instead of leaving them out (F36).
 * That is shown for one calendar; whether a list of calendars with and
 * without the right is refused as well or answered without the latter is
 * not, so the note does not claim more.
 */
export const noAppointmentListed =
  'No appointment is listed for the calendars named on these days. ChurchTools refuses the appointments of a single calendar the service account may not see; whether it leaves such a calendar out of a list of several instead is not verified.';

/** The note of an empty later page. */
export const pastLastAppointmentPage =
  'This page is empty: the calendars hold no further appointments on these days.';

/**
 * The note of the last page when ChurchTools holds more appointments than
 * the core reads for these calendars and days.
 */
export const fewerAppointmentsNeeded = `These calendars and days hold more than ${String(maxAppointments)} appointments, more than this tool lists. Ask for fewer days or fewer calendars.`;

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

// Strict, so that an argument the model made up ends as a validation error.
const input = z.strictObject({
  calendarIds: z.array(id).min(1).max(maxListIds),
  from: z.string().regex(calendarDatePattern),
  to: z.string().regex(calendarDatePattern),
  page: z.number().int().min(1).max(maxAppointmentPage).optional(),
});

// Title, subtitle and place are text people of the congregation wrote:
// untrusted, in the data envelope. An appointment names no person in a
// field of its own; street, town and coordinates of the place are never
// read.
const output = z.object({
  from: classify(z.string().regex(calendarDatePattern), 'none'),
  to: classify(z.string().regex(calendarDatePattern), 'none'),
  page: classify(z.number().int().min(1).max(maxAppointmentPage), 'none'),
  appointments: z
    .array(
      z.object({
        id: classify(z.number().int().positive(), 'none'),
        calendarId: classify(z.number().int().positive(), 'none'),
        title: classify(z.string().max(maxNameLength), 'untrusted'),
        subtitle: classify(
          z.string().max(maxNameLength),
          'untrusted',
        ).nullable(),
        allDay: classify(z.boolean(), 'none'),
        locationName: classify(
          z.string().max(maxNameLength),
          'untrusted',
        ).nullable(),
        startDate: classify(z.string().regex(dateOrDateTimePattern), 'none'),
        endDate: classify(z.string().regex(dateOrDateTimePattern), 'none'),
      }),
    )
    .max(appointmentsPerCall),
  more: classify(z.boolean(), 'none'),
  notice: classify(
    z.enum([
      noAppointmentListed,
      pastLastAppointmentPage,
      fewerAppointmentsNeeded,
    ]),
    'none',
  ).nullable(),
});

type Input = z.output<typeof input>;
type Output = z.input<typeof output>;

const execute = async ({
  input: { calendarIds, from, to, page = 1 },
  read,
}: ToolCall<Input>): Promise<Output> => {
  // Checked here as well, so that the model reads which part was wrong.
  if (!isListIds(calendarIds)) {
    throw new EccliumError('validation', invalidIds);
  }
  if (!isEventWindow(from, to)) {
    throw new EccliumError('validation', invalidSpan);
  }
  const list = await read
    .appointments(calendarIds, from, to)
    .catch((error: unknown) =>
      listRefused(error, [calendarRight], appointmentsRefused),
    );
  // The core gives up to 50 appointments, the earliest first; the tool
  // pages through them, so that no result outgrows its limit.
  const first = (page - 1) * appointmentsPerCall;
  const shown = list.appointments.slice(first, first + appointmentsPerCall);
  const later = list.appointments.length > first + appointmentsPerCall;
  return {
    from,
    to,
    page,
    // Copied field by field, so nothing but the eight fields can follow.
    appointments: shown.map(
      ({
        id: appointmentId,
        calendarId,
        title,
        subtitle,
        allDay,
        locationName,
        startDate,
        endDate,
      }) => ({
        id: appointmentId,
        calendarId,
        title,
        subtitle,
        allDay,
        locationName,
        startDate,
        endDate,
      }),
    ),
    // more promises a further page; that the days hold more than the core
    // reads is the notice, because no page holds those appointments.
    more: later,
    notice:
      shown.length === 0
        ? page === 1
          ? noAppointmentListed
          : pastLastAppointmentPage
        : !later && list.more
          ? fewerAppointmentsNeeded
          : null,
  };
};

/**
 * Lists the appointments of up to {@link maxListIds} calendars between two
 * days, {@link appointmentsPerCall} per call, the earliest first.
 *
 * @example
 * ```ts
 * register(host: PluginHost): undefined {
 *   host.addTool(appointmentsListTool);
 *   return undefined;
 * }
 * ```
 */
export const appointmentsListTool = defineTool({
  name: 'ct_appointments_list',
  meta: {
    capability: 'read',
    domain: 'appointments',
    requiredRights: [calendarRight],
    tier: 'free',
    // Titles and places are free text that can name persons.
    sensitivity: 'personal',
    unattended: 'policy',
    // A routine of the free core reads with it, so name and input are a
    // public contract from phase 2 on (ADR 0064).
    routineStable: true,
  },
  description: {
    purpose:
      'Lists the appointments of up to 10 calendars of ChurchTools between two days, 25 per call, the earliest first, each with ID, calendar, title, subtitle, whether it lasts whole days, place, start and end.',
    useWhen:
      'You need the appointments of a week or a month, or the IDs of an appointment and its calendar to read its description.',
    avoidWhen:
      'You do not know the IDs of the calendars, which another tool lists, or need events with services or agendas.',
    limits:
      'calendarIds names 1 to 10 calendars, each once. from and to are days as YYYY-MM-DD, at most 31 days with both ends; times are in UTC, and a day alone may stand for whole days. Each date of a series is its own entry with the ID of the series. At most 50, 25 per page: more is true when a further page follows, and a notice says when there are more than 50.',
  },
  input,
  output,
  execute,
});
