/**
 * The rights the tools that read events, agendas and assignments need, and
 * the messages that name them (ADR 0064). Like a plugin of a third party,
 * it imports only the plugin API (ADR 0022).
 *
 * @packageDocumentation
 */
import type { RightRef } from '@ecclium/mcp-churchtools-plugin-api';

/**
 * The right that opens the events of the calendars it names
 * (`docs/research/churchtools-api.md`, F36). Without it, ChurchTools
 * refuses an event with 403 and leaves it out of the list.
 */
export const eventsRight: RightRef = Object.freeze({
  module: 'churchservice',
  right: 'view events',
});

/**
 * The right that opens the agendas of the calendars it names (F36), also
 * without the right to see the event. Without it, ChurchTools refuses an
 * agenda with 403.
 */
export const agendaRight: RightRef = Object.freeze({
  module: 'churchservice',
  right: 'view agenda',
});

/**
 * The right that opens the assignments of the groups of services it names
 * (F36). Without it, ChurchTools gives the event without its assignments
 * and without an error.
 */
export const serviceGroupRight: RightRef = Object.freeze({
  module: 'churchservice',
  right: 'view servicegroup',
});

/** The message of a refused event. */
export const eventRefused = `ChurchTools refused this event. The service account needs the right "${eventsRight.right}" in ${eventsRight.module} for the calendar of the event; ct_whoami shows the rights of the account.`;

/** The message of a refused agenda. */
export const agendaRefused = `ChurchTools refused this agenda. The service account needs the right "${agendaRight.right}" in ${agendaRight.module} for the calendar of the event; ct_whoami shows the rights of the account.`;

/** The message of an event that does not exist. */
export const eventNotFound =
  'There is no event with this ID. ct_events_list finds the ID of an event by its days.';

/**
 * The message of a missing agenda. ChurchTools answers with 404 both for an
 * event that does not exist and, as expected but not shown, for one
 * without an agenda.
 */
export const agendaNotFound =
  'There is no agenda for this ID: the event does not exist or has no agenda. ct_events_list finds the ID of an event by its days.';
