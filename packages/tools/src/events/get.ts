/**
 * The tool `ct_events_get`: reads one event with its note and description,
 * never its assignments (ADR 0064).
 *
 * Like a plugin of a third party, it imports only the plugin API and zod
 * (ADR 0022).
 *
 * @packageDocumentation
 */
import {
  classify,
  dateTimePattern,
  defineTool,
  maxEventDescriptionLength,
  maxEventNoteLength,
  maxNameLength,
  refersTo,
  type ToolCall,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

import { readFailed } from '../persons/rights.js';
import { eventNotFound, eventRefused, eventsRight } from './rights.js';

// Strict, so that an argument the model made up ends as a validation error.
const input = z.strictObject({
  eventId: refersTo(
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    'event',
  ),
});

// Names, note and description are text people of the congregation wrote:
// untrusted, in the data envelope. An event names no person.
const output = z.object({
  id: classify(z.number().int().positive(), 'none'),
  name: classify(z.string().max(maxNameLength), 'untrusted'),
  startDate: classify(z.string().regex(dateTimePattern), 'none'),
  endDate: classify(z.string().regex(dateTimePattern), 'none'),
  isCanceled: classify(z.boolean(), 'none'),
  calendarId: classify(z.number().int().positive(), 'none').nullable(),
  calendarName: classify(z.string().max(maxNameLength), 'untrusted'),
  note: classify(z.string().max(maxEventNoteLength), 'untrusted').nullable(),
  description: classify(
    z.string().max(maxEventDescriptionLength),
    'untrusted',
  ).nullable(),
});

type Input = z.output<typeof input>;
type Output = z.input<typeof output>;

const execute = async ({
  input: { eventId },
  read,
}: ToolCall<Input>): Promise<Output> => {
  const event = await read
    .event(eventId)
    .catch((error: unknown) =>
      readFailed(error, [eventsRight], eventRefused, eventNotFound),
    );
  // Copied field by field, so nothing but the nine fields can follow.
  return {
    id: event.id,
    name: event.name,
    startDate: event.startDate,
    endDate: event.endDate,
    isCanceled: event.isCanceled,
    calendarId: event.calendarId,
    calendarName: event.calendarName,
    note: event.note,
    description: event.description,
  };
};

/**
 * Reads one event by its ID, with its calendar, note and description.
 *
 * @example
 * ```ts
 * register(host: PluginHost): undefined {
 *   host.addTool(eventsGetTool);
 *   return undefined;
 * }
 * ```
 */
export const eventsGetTool = defineTool({
  name: 'ct_events_get',
  meta: {
    capability: 'read',
    domain: 'events',
    requiredRights: [eventsRight],
    tier: 'free',
    // Note and description are free text that can name persons.
    sensitivity: 'personal',
    unattended: 'policy',
    routineStable: false,
  },
  description: {
    purpose:
      'Reads one event of ChurchTools by its ID: name, start, end, whether it is canceled, its calendar, its note and its description.',
    useWhen:
      'You have the ID of an event and need its note or description, or want to check its times.',
    avoidWhen: 'You need its agenda or who serves, which other tools read.',
    limits:
      'One event per call, by ID only. Start and end are in UTC. A note over 2000 or a description over 7000 characters ends the call with an error.',
  },
  input,
  output,
  execute,
});
