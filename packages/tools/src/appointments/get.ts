/**
 * The tool `ct_appointments_get`: reads one appointment with its
 * description, link and dates (ADR 0064).
 *
 * Like a plugin of a third party, it imports only the plugin API and zod
 * (ADR 0022).
 *
 * @packageDocumentation
 */
import {
  classify,
  dateOrDateTimePattern,
  defineTool,
  maxAppointmentDescriptionLength,
  maxAppointmentLinkLength,
  maxNameLength,
  refersTo,
  type ToolCall,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

import { readFailed } from '../persons/rights.js';
import {
  appointmentNotFound,
  appointmentRefused,
  calendarRight,
} from '../calendars/rights.js';

/**
 * The most dates one call gives, the earliest first. A series may have
 * hundreds; their days come from the list of appointments.
 */
export const datesPerCall = 25;

const id = () => z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

// Strict, so that an argument the model made up ends as a validation error.
const input = z.strictObject({
  calendarId: refersTo(id(), 'calendar'),
  appointmentId: refersTo(id(), 'appointment'),
});

// Title, subtitle, place, description and link are text people of the
// congregation wrote: untrusted, in the data envelope. Street, town and
// coordinates of the place are never read.
const output = z.object({
  id: classify(z.number().int().positive(), 'none'),
  calendarId: classify(z.number().int().positive(), 'none'),
  title: classify(z.string().max(maxNameLength), 'untrusted'),
  subtitle: classify(z.string().max(maxNameLength), 'untrusted').nullable(),
  allDay: classify(z.boolean(), 'none'),
  locationName: classify(z.string().max(maxNameLength), 'untrusted').nullable(),
  description: classify(
    z.string().max(maxAppointmentDescriptionLength),
    'untrusted',
  ).nullable(),
  link: classify(
    z.string().max(maxAppointmentLinkLength),
    'untrusted',
  ).nullable(),
  dates: z
    .array(
      z.object({
        startDate: classify(z.string().regex(dateOrDateTimePattern), 'none'),
        endDate: classify(z.string().regex(dateOrDateTimePattern), 'none'),
      }),
    )
    .max(datesPerCall),
  moreDates: classify(z.boolean(), 'none'),
});

type Input = z.output<typeof input>;
type Output = z.input<typeof output>;

const execute = async ({
  input: { calendarId, appointmentId },
  read,
}: ToolCall<Input>): Promise<Output> => {
  const appointment = await read
    .appointment(calendarId, appointmentId)
    .catch((error: unknown) =>
      readFailed(
        error,
        [calendarRight],
        appointmentRefused,
        appointmentNotFound,
      ),
    );
  // Copied field by field, so nothing but these fields can follow.
  return {
    id: appointment.id,
    calendarId: appointment.calendarId,
    title: appointment.title,
    subtitle: appointment.subtitle,
    allDay: appointment.allDay,
    locationName: appointment.locationName,
    description: appointment.description,
    link: appointment.link,
    // The core sorts the dates by start; the earliest come first.
    dates: appointment.dates
      .slice(0, datesPerCall)
      .map(({ startDate, endDate }) => ({ startDate, endDate })),
    moreDates: appointment.dates.length > datesPerCall,
  };
};

/**
 * Reads one appointment by the IDs of its calendar and of itself, with
 * description, link and the {@link datesPerCall} earliest dates.
 *
 * @example
 * ```ts
 * register(host: PluginHost): undefined {
 *   host.addTool(appointmentsGetTool);
 *   return undefined;
 * }
 * ```
 */
export const appointmentsGetTool = defineTool({
  name: 'ct_appointments_get',
  meta: {
    capability: 'read',
    domain: 'appointments',
    requiredRights: [calendarRight],
    tier: 'free',
    // Description and link are free text that can name persons.
    sensitivity: 'personal',
    unattended: 'policy',
    routineStable: false,
  },
  description: {
    purpose:
      'Reads one appointment of ChurchTools by the IDs of its calendar and of itself: title, subtitle, whether it lasts whole days, the name of its place, its description, its link and its dates.',
    useWhen:
      'You have the IDs of an appointment and its calendar and need its description or link, or the dates of a series.',
    avoidWhen:
      'You need the appointments of some days, which another tool lists with their IDs.',
    limits:
      'One appointment per call. Times are in UTC; a day alone may stand for whole days. dates holds at most the 25 earliest dates ChurchTools gives; moreDates is true when it gives more, then list the days you need. A description over 7000 or a link over 1000 characters ends the call with an error.',
  },
  input,
  output,
  execute,
});
