/**
 * The tool that requests bookings: `ct_bookings_create`.
 *
 * Where it stands in the way of a write: it only plans. It turns its input
 * into an intent of the core and hands it to the write port; the core
 * checks rights, policy, times and text, reads the bookings of the
 * resource on those days, seals the plan, gets it confirmed and commits
 * it, and builds the result (ADR 0029). The tool never writes and never
 * shapes the result.
 *
 * A booking is only ever requested: the managers of the resource approve
 * it in ChurchTools (`docs/research/churchtools-api.md`, F45), and
 * ChurchTools mails them its title and description at once (F48). Taking
 * the request back does not take the mail back, so the core never lets the
 * echo confirm it (ADR 0029).
 *
 * Like a plugin of a third party, it imports only the plugin API and zod
 * (ADR 0022).
 *
 * @packageDocumentation
 */
import {
  defineWriteTool,
  type PlanOutcome,
  refersTo,
  type ToolDescription,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

import {
  calendarDescription,
  calendarTime,
  calendarTitle,
  confirmedSentence,
  noEchoSentence,
  plainSentence,
  timesSentence,
} from '../appointments/write.js';
import { bookingRequestRight, resourceRight } from '../resources/rights.js';

const description: ToolDescription = {
  purpose:
    'Requests a booking of a resource of ChurchTools, such as a room, for a start and an end, with a title and an optional description.',
  useWhen:
    'A person asked for the booking and agreed on the resource, title, times and text.',
  avoidWhen:
    'The resource needs an appointment, or the booking lasts whole days: book it in ChurchTools.',
  limits: `${confirmedSentence} ${noEchoSentence} Only a request: the managers of the resource approve it and get its title and description by mail at once. ${timesSentence} ${plainSentence} A request or booking of the resource with the same title, start and end is skipped.`,
};

/**
 * Requests a booking of a resource. A repeat of the same confirmation
 * counts once (`replayGuard: nonce`), and a held request or booking of the
 * resource with the same title, start and end is skipped, whoever made
 * it: a booking names no creator to tell. The metadata are what the core
 * derives for the intent anyway (ADR 0029).
 *
 * @example
 * ```ts
 * register(host: PluginHost): undefined {
 *   host.addTool(bookingsCreateTool);
 *   return undefined;
 * }
 * ```
 */
export const bookingsCreateTool = defineWriteTool({
  name: 'ct_bookings_create',
  meta: {
    capability: 'write',
    domain: 'bookings',
    requiredRights: [bookingRequestRight, resourceRight],
    tier: 'free',
    sensitivity: 'personal',
    unattended: 'policy',
    routineStable: false,
    reversible: 'snapshot',
    replayGuard: 'nonce',
  },
  description,
  input: z.strictObject({
    resourceId: refersTo(
      z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      'resource',
    ),
    title: calendarTitle,
    startDate: calendarTime,
    endDate: calendarTime,
    description: calendarDescription,
  }),
  execute: ({ input, write }): Promise<PlanOutcome> =>
    write.plan({
      kind: 'bookingCreate',
      resourceId: input.resourceId,
      title: input.title,
      startDate: input.startDate,
      endDate: input.endDate,
      ...(input.description === undefined
        ? {}
        : { description: input.description }),
    }),
});
