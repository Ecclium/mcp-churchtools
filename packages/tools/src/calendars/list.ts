/**
 * The tool `ct_calendars_list`: lists the calendars of ChurchTools the
 * service account may see, 25 per call, each with ID, name and whether it
 * is public or private (ADR 0064).
 *
 * Like a plugin of a third party, it imports only the plugin API and zod
 * (ADR 0022).
 *
 * @packageDocumentation
 */
import {
  classify,
  defineTool,
  maxCalendars,
  maxNameLength,
  type ToolCall,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

import { calendarRight } from './rights.js';

/**
 * The most calendars one call gives. 25 calendars with names of 255
 * letters fit into one result.
 */
export const calendarsPerCall = 25;

/** The last page a call may ask for. */
export const maxCalendarPage = Math.ceil(maxCalendars / calendarsPerCall);

/**
 * The note of an empty list. ChurchTools lists only the calendars the
 * account may see and answers with an empty list without the right, so
 * the tool cannot tell an instance without calendars from a missing right
 * and says so (F36).
 */
export const noCalendarListed = `No calendar is listed. ChurchTools also lists no calendar for which the service account lacks the right "${calendarRight.right}" in ${calendarRight.module}, so no calendars and a missing right look the same. ct_whoami shows the rights of the account.`;

/** The note of an empty later page. */
export const pastLastCalendarPage =
  'This page of the calendars is empty: the list has no further pages.';

// Strict, so that an argument the model made up ends as a validation error.
const input = z.strictObject({
  page: z.number().int().min(1).max(maxCalendarPage).optional(),
});

// People of the congregation name calendars, so the names are untrusted and
// stand in the data envelope. A calendar is no person; randomUrl, which may
// open the calendar to anyone, is never read.
const output = z.object({
  page: classify(z.number().int().min(1).max(maxCalendarPage), 'none'),
  calendars: z
    .array(
      z.object({
        id: classify(z.number().int().positive(), 'none'),
        name: classify(z.string().max(maxNameLength), 'untrusted'),
        isPublic: classify(z.boolean(), 'none'),
        isPrivate: classify(z.boolean(), 'none'),
      }),
    )
    .max(calendarsPerCall),
  more: classify(z.boolean(), 'none'),
  notice: classify(
    z.enum([noCalendarListed, pastLastCalendarPage]),
    'none',
  ).nullable(),
});

type Input = z.output<typeof input>;
type Output = z.input<typeof output>;

const execute = async ({
  input: { page = 1 },
  read,
}: ToolCall<Input>): Promise<Output> => {
  const calendars = await read.calendars();
  // ChurchTools gives every calendar in one answer, sorted by ID by the
  // core; the tool pages through it, so that no result outgrows its limit.
  const first = (page - 1) * calendarsPerCall;
  const shown = calendars.slice(first, first + calendarsPerCall);
  return {
    page,
    // Copied field by field, so nothing but the four fields can follow.
    calendars: shown.map(({ id, name, isPublic, isPrivate }) => ({
      id,
      name,
      isPublic,
      isPrivate,
    })),
    more: calendars.length > first + calendarsPerCall,
    notice:
      shown.length > 0
        ? null
        : page === 1
          ? noCalendarListed
          : pastLastCalendarPage,
  };
};

/**
 * Lists the calendars the service account may see,
 * {@link calendarsPerCall} per call, each with ID, name and whether it is
 * public or private.
 *
 * @example
 * ```ts
 * register(host: PluginHost): undefined {
 *   host.addTool(calendarsListTool);
 *   return undefined;
 * }
 * ```
 */
export const calendarsListTool = defineTool({
  name: 'ct_calendars_list',
  meta: {
    capability: 'read',
    domain: 'calendars',
    requiredRights: [calendarRight],
    tier: 'free',
    sensitivity: 'none',
    unattended: 'policy',
    routineStable: false,
  },
  description: {
    purpose:
      'Lists the calendars of ChurchTools the service account may see, 25 per call, each with ID, name and whether it is public or private.',
    useWhen:
      'You need the ID of a calendar to list its appointments, or want to know which calendars exist.',
    avoidWhen:
      'You need the appointments themselves, which another tool lists by calendar.',
    limits:
      'At most 25 calendars per call: more is true when another page follows. Calendars the service account may not see are left out without a trace.',
  },
  input,
  output,
  execute,
});
