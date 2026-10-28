/**
 * The tool `ct_events_list`: lists the events of a span of days, 25 per
 * call, each with ID, name, start, end, whether it is canceled and its
 * calendar (ADR 0064).
 *
 * Like a plugin of a third party, it imports only the plugin API and zod
 * (ADR 0022).
 *
 * @packageDocumentation
 */
import {
  calendarDatePattern,
  classify,
  dateTimePattern,
  defineTool,
  EccliumError,
  isEventWindow,
  maxEventDays,
  maxEvents,
  maxNameLength,
  type ToolCall,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

import { eventsRight } from './rights.js';

/**
 * The most events one call gives. 25 events with names of their own and of
 * their calendar of 255 letters fit into one result.
 */
export const eventsPerCall = 25;

/** The last page a call may ask for: the core reads at most 50 events. */
export const maxEventPage = Math.ceil(maxEvents / eventsPerCall);

/** The message of a span of days that does not fit. */
export const invalidSpan = `from and to are days as YYYY-MM-DD that exist, to not before from, at most ${String(maxEventDays)} days with both ends.`;

/**
 * The note of an empty first page. ChurchTools lists only the events of
 * calendars the account may see and answers with an empty list without
 * the right, so the tool cannot tell days without events from a missing
 * right and says so (F36).
 */
export const noEventListed = `No event is listed for these days. ChurchTools also returns no event when the service account lacks the right "${eventsRight.right}" in ${eventsRight.module} for the calendar, so days without events and a missing right look the same. ct_whoami shows the rights of the account.`;

/** The note of an empty later page. */
export const pastLastEventPage =
  'This page is empty: the days hold no further events.';

/**
 * The note of the last page when ChurchTools holds more events than the
 * core reads for these days.
 */
export const fewerDaysNeeded = `These days hold more than ${String(maxEvents)} events, more than this tool lists. Ask for fewer days.`;

// Strict, so that an argument the model made up ends as a validation error.
const input = z.strictObject({
  from: z.string().regex(calendarDatePattern),
  to: z.string().regex(calendarDatePattern),
  page: z.number().int().min(1).max(maxEventPage).optional(),
});

// People of the congregation name events and calendars, so both names are
// untrusted and stand in the data envelope. An event names no person.
const output = z.object({
  from: classify(z.string().regex(calendarDatePattern), 'none'),
  to: classify(z.string().regex(calendarDatePattern), 'none'),
  page: classify(z.number().int().min(1).max(maxEventPage), 'none'),
  events: z
    .array(
      z.object({
        id: classify(z.number().int().positive(), 'none'),
        name: classify(z.string().max(maxNameLength), 'untrusted'),
        startDate: classify(z.string().regex(dateTimePattern), 'none'),
        endDate: classify(z.string().regex(dateTimePattern), 'none'),
        isCanceled: classify(z.boolean(), 'none'),
        calendarId: classify(z.number().int().positive(), 'none').nullable(),
        calendarName: classify(z.string().max(maxNameLength), 'untrusted'),
      }),
    )
    .max(eventsPerCall),
  more: classify(z.boolean(), 'none'),
  notice: classify(
    z.enum([noEventListed, pastLastEventPage, fewerDaysNeeded]),
    'none',
  ).nullable(),
});

type Input = z.output<typeof input>;
type Output = z.input<typeof output>;

const execute = async ({
  input: { from, to, page = 1 },
  read,
}: ToolCall<Input>): Promise<Output> => {
  // Checked here as well, so that the model reads which part was wrong.
  if (!isEventWindow(from, to)) {
    throw new EccliumError('validation', invalidSpan);
  }
  const list = await read.events(from, to);
  // The core gives up to 50 events, the earliest first; the tool pages
  // through them, so that no result outgrows its limit.
  const first = (page - 1) * eventsPerCall;
  const events = list.events.slice(first, first + eventsPerCall);
  const later = list.events.length > first + eventsPerCall;
  return {
    from,
    to,
    page,
    // Copied field by field, so nothing but the seven fields can follow.
    events: events.map(
      ({
        id,
        name,
        startDate,
        endDate,
        isCanceled,
        calendarId,
        calendarName,
      }) => ({
        id,
        name,
        startDate,
        endDate,
        isCanceled,
        calendarId,
        calendarName,
      }),
    ),
    // more promises a further page; that the days hold more than the core
    // reads is the notice, because no page holds those events.
    more: later,
    notice:
      events.length === 0
        ? page === 1
          ? noEventListed
          : pastLastEventPage
        : !later && list.more
          ? fewerDaysNeeded
          : null,
  };
};

/**
 * Lists the events of up to {@link maxEventDays} days,
 * {@link eventsPerCall} per call, the earliest first.
 *
 * @example
 * ```ts
 * register(host: PluginHost): undefined {
 *   host.addTool(eventsListTool);
 *   return undefined;
 * }
 * ```
 */
export const eventsListTool = defineTool({
  name: 'ct_events_list',
  meta: {
    capability: 'read',
    domain: 'events',
    requiredRights: [eventsRight],
    tier: 'free',
    // Names of events can name persons; no field is a person.
    sensitivity: 'personal',
    unattended: 'policy',
    // A routine of the free core reads with it, so name and input are a
    // public contract from phase 2 on (ADR 0064).
    routineStable: true,
  },
  description: {
    purpose:
      'Lists the events of ChurchTools between two days, 25 per call, the earliest first, each with ID, name, start, end, whether it is canceled and its calendar.',
    useWhen:
      'You need the events of a week or a month, or the ID of an event to read it, its agenda or its assignments.',
    avoidWhen:
      'You need the services, the agenda or the note of an event, which other tools read.',
    limits:
      'from and to are days as YYYY-MM-DD, at most 31 days with both ends; times are in UTC. At most 50 events for the days, 25 per page: more is true when a further page follows, and a notice says when the days hold more than 50. Events of calendars the service account may not see are left out without a trace.',
  },
  input,
  output,
  execute,
});
