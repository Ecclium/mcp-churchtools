/**
 * The two tools that write appointments: `ct_appointments_create` and
 * `ct_appointments_update`, and the parts of their input and description
 * the tool that requests bookings shares.
 *
 * Where they stand in the way of a write: they only plan. Each turns its
 * input into an intent of the core and hands it to the write port; the
 * core checks rights, policy, times and text, reads the calendar or the
 * appointment, seals the plan, gets it confirmed and commits it, and builds
 * the result (ADR 0029). A tool never writes and never shapes the result.
 *
 * They write only single appointments with a start and an end, since no
 * probe covered a series, an event, a place or whole days (ADR 0072). The
 * core refuses an appointment with such parts, and it moves an appointment
 * only if the account of the server created it, because linked events and
 * bookings follow a new time.
 *
 * Like a plugin of a third party, they import only the plugin API and zod
 * (ADR 0022).
 *
 * @packageDocumentation
 */
import {
  classify,
  dateTimePattern,
  defineWriteTool,
  maxNameLength,
  type PlanOutcome,
  refersTo,
  type ToolDescription,
  type WriteToolMeta,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

import { calendarEditRight, calendarRight } from '../calendars/rights.js';

/**
 * The longest description a tool takes, in UTF-16 code units: the limit
 * the core checks as well. A person reads the description whole before
 * confirming, and the managers of a resource get that of a booking request
 * by mail (`docs/research/churchtools-api.md`, F48).
 */
export const maxCalendarDescriptionLength = 2000;

const id = () => z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** A title from the model, one line, which the content policy checks. */
export const calendarTitle = classify(
  z.string().min(1).max(maxNameLength),
  'untrusted',
);

/**
 * A start or an end in UTC. The form is that of ChurchTools; that it lies
 * on the full minute and the end after the start, the core checks and
 * names in its sentence, which says more than a pattern could.
 */
export const calendarTime = classify(z.string().regex(dateTimePattern), 'none');

/** A description from the model, which the content policy checks. */
export const calendarDescription = classify(
  z.string().min(1).max(maxCalendarDescriptionLength),
  'untrusted',
).optional();

/** What every tool that writes says about the way of a write. */
export const confirmedSentence =
  'Writes only after a confirmation by the person or the operator; the result says whether it was written, skipped, or waits.';

/** What a write that tells people outside the client says of the echo. */
export const noEchoSentence = 'Never confirmed by echo.';

/** How the times are given. */
export const timesSentence =
  'Times in UTC on the full minute as YYYY-MM-DDTHH:MM:00Z: convert local times first. No whole days.';

/** What the content policy lets through in title and description. */
export const plainSentence = `Title on one line, description up to ${String(maxCalendarDescriptionLength)} characters, both plain text: no Markdown, links, web addresses or HTML, and contact data only as the operator allows.`;

// The metadata of both: what the core derives for an intent of an
// appointment anyway (ADR 0029), here so that the registry and the
// description name it. Not for routines yet: phase 6 decides which tool a
// routine of the core relies on.
const meta = (replayGuard: WriteToolMeta['replayGuard']): WriteToolMeta => ({
  capability: 'write',
  domain: 'appointments',
  requiredRights: [calendarEditRight, calendarRight],
  tier: 'free',
  sensitivity: 'personal',
  unattended: 'policy',
  routineStable: false,
  reversible: 'snapshot',
  replayGuard,
});

const calendarId = refersTo(id(), 'calendar');
// The number of a version of the appointment, no object of its own. A new
// appointment has version 0 (F42), so 0 is a version to change.
const baseVersion = classify(
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  'none',
);

const createDescription: ToolDescription = {
  purpose:
    'Creates a single appointment with a start and an end in a calendar of ChurchTools, with a title and an optional description.',
  useWhen:
    'A person asked for the appointment and agreed on its calendar, title, times and text.',
  avoidWhen:
    'It repeats, lasts whole days, or needs an event, a place or a link: create it in ChurchTools.',
  limits: `${confirmedSentence} ${timesSentence} ${plainSentence} The same title, start and end in the calendar is skipped.`,
};

const updateDescription: ToolDescription = {
  purpose:
    'Changes title, times or description of a single appointment of ChurchTools; the confirmation shows what changes.',
  useWhen:
    'A person asked to change an appointment you read. Send its version and the title, start and end it shall have, also unchanged ones.',
  avoidWhen:
    'It belongs to a series or has an address, a link, an image, sign-ups or a linked event, booking or invitation: change it in ChurchTools.',
  limits: `${confirmedSentence} ${noEchoSentence} If it changed since the version you read, nothing is written. Start and end change only where this server created the appointment. Without a description the current one stays. ${timesSentence} ${plainSentence}`,
};

/**
 * Creates a single appointment in a calendar. A repeat of the same
 * confirmation counts once (`replayGuard: nonce`), and an appointment of
 * the same title, start and end on that day of the calendar is skipped.
 *
 * @example
 * ```ts
 * register(host: PluginHost): undefined {
 *   host.addTool(appointmentsCreateTool);
 *   return undefined;
 * }
 * ```
 */
export const appointmentsCreateTool = defineWriteTool({
  name: 'ct_appointments_create',
  meta: meta('nonce'),
  description: createDescription,
  input: z.strictObject({
    calendarId,
    title: calendarTitle,
    startDate: calendarTime,
    endDate: calendarTime,
    description: calendarDescription,
  }),
  execute: ({ input, write }): Promise<PlanOutcome> =>
    write.plan({
      kind: 'appointmentCreate',
      calendarId: input.calendarId,
      title: input.title,
      startDate: input.startDate,
      endDate: input.endDate,
      ...(input.description === undefined
        ? {}
        : { description: input.description }),
    }),
});

/**
 * Changes a single appointment, planned on the version the model read. An
 * appointment of another version ends in a conflict, and a version once
 * written is used up (`replayGuard: baseVersion`). Title, start and end are
 * always given, because ChurchTools replaces an appointment as a whole
 * (F41); without a description the current one stays.
 *
 * @example
 * ```ts
 * host.addTool(appointmentsUpdateTool);
 * ```
 */
export const appointmentsUpdateTool = defineWriteTool({
  name: 'ct_appointments_update',
  meta: meta('baseVersion'),
  description: updateDescription,
  input: z.strictObject({
    calendarId,
    appointmentId: refersTo(id(), 'appointment'),
    baseVersion,
    title: calendarTitle,
    startDate: calendarTime,
    endDate: calendarTime,
    description: calendarDescription,
  }),
  execute: ({ input, write }): Promise<PlanOutcome> =>
    write.plan({
      kind: 'appointmentUpdate',
      calendarId: input.calendarId,
      appointmentId: input.appointmentId,
      baseVersion: input.baseVersion,
      title: input.title,
      startDate: input.startDate,
      endDate: input.endDate,
      ...(input.description === undefined
        ? {}
        : { description: input.description }),
    }),
});
