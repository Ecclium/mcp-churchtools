/**
 * The tool `ct_bookings_list`: lists the bookings of up to 10 resources
 * between two days, 25 per call, each with ID, title, resource, state,
 * appointment, start and end (ADR 0064).
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
  maxBookings,
  maxListIds,
  maxNameLength,
  refersTo,
  type ToolCall,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

import { invalidIds, listRefused } from '../calendars/rights.js';
import { invalidSpan } from '../events/list.js';
import { bookingsRefused, resourceRight } from '../resources/rights.js';

/**
 * The most bookings one call gives. 25 bookings with titles of 255 letters
 * fit into one result.
 */
export const bookingsPerCall = 25;

/** The last page a call may ask for: the core reads at most 50. */
export const maxBookingPage = Math.ceil(maxBookings / bookingsPerCall);

/**
 * The note of an empty first page. ChurchTools refuses the bookings of a
 * resource the account may not see instead of leaving them out (F36).
 * That is shown for one resource; whether a list of resources with and
 * without the right is refused as well is not, so the note does not claim
 * more.
 */
export const noBookingListed =
  'No booking is listed for the resources named on these days. ChurchTools refuses the bookings of a single resource the service account may not see; whether it leaves such a resource out of a list of several instead is not verified.';

/** The note of an empty later page. */
export const pastLastBookingPage =
  'This page is empty: the resources have no further bookings on these days.';

/**
 * The note of the last page when ChurchTools holds more bookings than the
 * core reads for these resources and days.
 */
export const fewerBookingsNeeded = `These resources and days hold more than ${String(maxBookings)} bookings, more than this tool lists. Ask for fewer days or fewer resources.`;

const resourceId = refersTo(
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  'resource',
);

// Strict, so that an argument the model made up ends as a validation error.
const input = z.strictObject({
  resourceIds: z.array(resourceId).min(1).max(maxListIds),
  from: classify(z.string().regex(calendarDatePattern), 'none'),
  to: classify(z.string().regex(calendarDatePattern), 'none'),
  page: classify(
    z.number().int().min(1).max(maxBookingPage),
    'none',
  ).optional(),
});

// The title is text people of the congregation wrote: untrusted, in the
// data envelope. The person who answered a booking and the whole resource
// are never read.
const output = z.object({
  from: classify(z.string().regex(calendarDatePattern), 'none'),
  to: classify(z.string().regex(calendarDatePattern), 'none'),
  page: classify(z.number().int().min(1).max(maxBookingPage), 'none'),
  bookings: z
    .array(
      z.object({
        id: classify(z.number().int().positive(), 'none'),
        title: classify(z.string().max(maxNameLength), 'untrusted'),
        resourceId: classify(z.number().int().positive(), 'none'),
        statusId: classify(z.number().int().nonnegative(), 'none'),
        appointmentId: classify(z.number().int().positive(), 'none').nullable(),
        startDate: classify(z.string().regex(dateOrDateTimePattern), 'none'),
        endDate: classify(z.string().regex(dateOrDateTimePattern), 'none'),
      }),
    )
    .max(bookingsPerCall),
  more: classify(z.boolean(), 'none'),
  notice: classify(
    z.enum([noBookingListed, pastLastBookingPage, fewerBookingsNeeded]),
    'none',
  ).nullable(),
});

type Input = z.output<typeof input>;
type Output = z.input<typeof output>;

const execute = async ({
  input: { resourceIds, from, to, page = 1 },
  read,
}: ToolCall<Input>): Promise<Output> => {
  // Checked here as well, so that the model reads which part was wrong.
  if (!isListIds(resourceIds)) {
    throw new EccliumError('validation', invalidIds);
  }
  if (!isEventWindow(from, to)) {
    throw new EccliumError('validation', invalidSpan);
  }
  const list = await read
    .bookings(resourceIds, from, to)
    .catch((error: unknown) =>
      listRefused(error, [resourceRight], bookingsRefused),
    );
  // The core gives up to 50 bookings, the earliest first; the tool pages
  // through them, so that no result outgrows its limit.
  const first = (page - 1) * bookingsPerCall;
  const shown = list.bookings.slice(first, first + bookingsPerCall);
  const later = list.bookings.length > first + bookingsPerCall;
  return {
    from,
    to,
    page,
    // Copied field by field, so nothing but the seven fields can follow.
    bookings: shown.map(
      ({
        id: bookingId,
        title,
        resourceId,
        statusId,
        appointmentId,
        startDate,
        endDate,
      }) => ({
        id: bookingId,
        title,
        resourceId,
        statusId,
        appointmentId,
        startDate,
        endDate,
      }),
    ),
    // more promises a further page; that the days hold more than the core
    // reads is the notice, because no page holds those bookings.
    more: later,
    notice:
      shown.length === 0
        ? page === 1
          ? noBookingListed
          : pastLastBookingPage
        : !later && list.more
          ? fewerBookingsNeeded
          : null,
  };
};

/**
 * Lists the bookings of up to {@link maxListIds} resources between two
 * days, {@link bookingsPerCall} per call, the earliest first.
 *
 * @example
 * ```ts
 * register(host: PluginHost): undefined {
 *   host.addTool(bookingsListTool);
 *   return undefined;
 * }
 * ```
 */
export const bookingsListTool = defineTool({
  name: 'ct_bookings_list',
  meta: {
    capability: 'read',
    domain: 'bookings',
    requiredRights: [resourceRight],
    tier: 'free',
    // Titles are free text that can name persons.
    sensitivity: 'personal',
    unattended: 'policy',
    routineStable: false,
  },
  description: {
    purpose:
      'Lists the bookings of up to 10 resources of ChurchTools between two days, 25 per call, the earliest first, each with ID, title, resource, state, the ID of its appointment, start and end.',
    useWhen:
      'You need to know when a room or another resource is booked, for a week or a month.',
    avoidWhen:
      'You do not know the IDs of the resources, which another tool lists, or need appointments of a calendar.',
    limits:
      'resourceIds names 1 to 10 resources, each once. from and to are days as YYYY-MM-DD, at most 31 days with both ends; times are in UTC, and a day alone may stand for whole days. statusId is the number of the state in ChurchTools, whose meaning this tool does not know. At most 50, 25 per page: more is true when a further page follows, and a notice says when there are more than 50.',
  },
  input,
  output,
  execute,
});
