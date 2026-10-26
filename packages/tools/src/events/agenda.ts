/**
 * The tool `ct_events_get_agenda`: reads the agenda of one event, 10 items
 * per call, without the persons responsible for an item (ADR 0064).
 *
 * Like a plugin of a third party, it imports only the plugin API and zod
 * (ADR 0022).
 *
 * @packageDocumentation
 */
import {
  agendaItemTypePattern,
  classify,
  dateTimePattern,
  defineTool,
  maxAgendaItems,
  maxAgendaNoteLength,
  maxNameLength,
  type ToolCall,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

import { readFailed } from '../persons/rights.js';
import { agendaNotFound, agendaRefused, agendaRight } from './rights.js';

/**
 * The most items one call gives. 10 items with title, song and arrangement
 * of 255 letters and notes of 1000 letters fit into one result.
 */
export const agendaItemsPerCall = 10;

/** The last page a call may ask for. */
export const maxAgendaPage = Math.ceil(maxAgendaItems / agendaItemsPerCall);

/** The note of an agenda without items. */
export const noAgendaItem = 'The agenda has no items.';

/** The note of an empty later page. */
export const pastLastAgendaPage =
  'This page of the agenda is empty: the agenda has no further items.';

// Strict, so that an argument the model made up ends as a validation error.
const input = z.strictObject({
  eventId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  page: z.number().int().min(1).max(maxAgendaPage).optional(),
});

const text = (max: number) => classify(z.string().max(max), 'untrusted');

// Titles, notes and names of songs are text people of the congregation
// wrote: untrusted, in the data envelope. Type, times and IDs are words and
// numbers of ChurchTools. No field names a person.
const output = z.object({
  eventId: classify(z.number().int().positive(), 'none'),
  page: classify(z.number().int().min(1).max(maxAgendaPage), 'none'),
  name: text(maxNameLength),
  isFinal: classify(z.boolean(), 'none'),
  items: z
    .array(
      z.object({
        position: classify(z.number().int(), 'none'),
        type: classify(z.string().regex(agendaItemTypePattern), 'none'),
        title: text(maxNameLength),
        start: classify(z.string().regex(dateTimePattern), 'none').nullable(),
        duration: classify(z.number().int().nonnegative(), 'none').nullable(),
        isBeforeEvent: classify(z.boolean(), 'none'),
        note: text(maxAgendaNoteLength).nullable(),
        song: z
          .object({
            songId: classify(z.number().int().positive(), 'none'),
            arrangementId: classify(
              z.number().int().positive(),
              'none',
            ).nullable(),
            title: text(maxNameLength),
            arrangement: text(maxNameLength).nullable(),
          })
          .nullable(),
      }),
    )
    .max(agendaItemsPerCall),
  more: classify(z.boolean(), 'none'),
  notice: classify(
    z.enum([noAgendaItem, pastLastAgendaPage]),
    'none',
  ).nullable(),
});

type Input = z.output<typeof input>;
type Output = z.input<typeof output>;

const execute = async ({
  input: { eventId, page = 1 },
  read,
}: ToolCall<Input>): Promise<Output> => {
  const agenda = await read
    .eventAgenda(eventId)
    .catch((error: unknown) =>
      readFailed(error, [agendaRight], agendaRefused, agendaNotFound),
    );
  // ChurchTools gives the whole agenda in one answer; the tool pages
  // through it, so that no result outgrows its limit.
  const first = (page - 1) * agendaItemsPerCall;
  const items = agenda.items.slice(first, first + agendaItemsPerCall);
  return {
    eventId,
    page,
    name: agenda.name,
    isFinal: agenda.isFinal,
    // Copied field by field, so nothing but the declared fields can follow.
    items: items.map((item) => ({
      position: item.position,
      type: item.type,
      title: item.title,
      start: item.start,
      duration: item.duration,
      isBeforeEvent: item.isBeforeEvent,
      note: item.note,
      song:
        item.song === null
          ? null
          : {
              songId: item.song.songId,
              arrangementId: item.song.arrangementId,
              title: item.song.title,
              arrangement: item.song.arrangement,
            },
    })),
    more: agenda.items.length > first + agendaItemsPerCall,
    notice:
      items.length > 0 ? null : page === 1 ? noAgendaItem : pastLastAgendaPage,
  };
};

/**
 * Reads the agenda of one event, {@link agendaItemsPerCall} items per call,
 * each with position, type, title, start, duration, note and song.
 *
 * @example
 * ```ts
 * register(host: PluginHost): undefined {
 *   host.addTool(eventsGetAgendaTool);
 *   return undefined;
 * }
 * ```
 */
export const eventsGetAgendaTool = defineTool({
  name: 'ct_events_get_agenda',
  meta: {
    capability: 'read',
    domain: 'events',
    requiredRights: [agendaRight],
    tier: 'free',
    // Notes are free text that can name persons.
    sensitivity: 'personal',
    unattended: 'policy',
    routineStable: false,
  },
  description: {
    purpose:
      'Reads the agenda of one event in ChurchTools, 10 items per call: its name, whether it is final, and per item the position, type, title, start, duration, note and song with arrangement.',
    useWhen:
      'You have the ID of an event and need its order of service or the songs it plans.',
    avoidWhen:
      'You need who is responsible for an item, which this tool never returns, or who serves.',
    limits:
      'At most 10 items per call: more is true when further items follow, then ask again with the next page number. Start is in UTC, duration in seconds. A note longer than 1000 characters ends the call with an error.',
  },
  input,
  output,
  execute,
});
