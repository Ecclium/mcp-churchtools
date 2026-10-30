/**
 * The tool `ct_services_get_assignments`: lists who is assigned to the
 * services of one event, 25 per call, with the person only where the
 * service shows names (ADR 0064). Its output names persons, so the
 * catalog treats it like a tool with the sensitivity special: its result
 * leaves only with its line in the audit file, and every call counts
 * against the read budget.
 *
 * Like a plugin of a third party, it imports only the plugin API and zod
 * (ADR 0022).
 *
 * @packageDocumentation
 */
import {
  assignmentsPageLimit,
  classify,
  defineTool,
  maxAssignmentsPage,
  maxNameLength,
  type ToolCall,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

import {
  eventNotFound,
  eventRefused,
  eventsRight,
  serviceGroupRight,
} from '../events/rights.js';
import { readFailed } from '../persons/rights.js';

/**
 * The note of an empty first page. Without the right on the group of
 * services, ChurchTools gives the event without its assignments and
 * without an error, so the tool cannot tell an event without assignments
 * from a missing right and says so (F36).
 */
export const noAssignmentListed = `No assignment is listed. ChurchTools also gives the event without assignments when the service account lacks the right "${serviceGroupRight.right}" in ${serviceGroupRight.module} for the groups of services, so an event without assignments and a missing right look the same. ct_whoami shows the rights of the account.`;

/** The note of an empty later page. */
export const pastLastAssignmentPage =
  'This page of the assignments is empty: the event has no further assignments.';

/**
 * The note of a page where some assignments name no person: the service
 * hides the names, or ChurchTools names no person for it.
 */
export const someNamesWithheld =
  'Some assignments name no person: their service hides the names of the persons assigned, or ChurchTools names no person for them. Their service and status are still given.';

// Strict, so that an argument the model made up ends as a validation error.
const input = z.strictObject({
  eventId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  page: z.number().int().min(1).max(maxAssignmentsPage).optional(),
});

// The names of persons keep their own classes outside the data envelope,
// as in the tools of persons (ADR 0026); the name of a service is
// untrusted. The classes of the person make the catalog treat this tool
// like a special one (ADR 0064).
const output = z.object({
  eventId: classify(z.number().int().positive(), 'none'),
  page: classify(z.number().int().min(1).max(maxAssignmentsPage), 'none'),
  assignments: z
    .array(
      z.object({
        serviceId: classify(z.number().int().positive(), 'none'),
        serviceName: classify(
          z.string().max(maxNameLength),
          'untrusted',
        ).nullable(),
        isAccepted: classify(z.boolean(), 'none'),
        agreed: classify(z.boolean(), 'none'),
        person: z
          .object({
            personId: classify(z.number().int().positive(), 'personId'),
            firstName: classify(z.string().max(maxNameLength), 'name.first'),
            lastName: classify(z.string().max(maxNameLength), 'name.last'),
          })
          .nullable(),
      }),
    )
    .max(assignmentsPageLimit),
  more: classify(z.boolean(), 'none'),
  notice: classify(
    z.enum([noAssignmentListed, pastLastAssignmentPage, someNamesWithheld]),
    'none',
  ).nullable(),
});

type Input = z.output<typeof input>;
type Output = z.input<typeof output>;

const execute = async ({
  input: { eventId, page = 1 },
  read,
}: ToolCall<Input>): Promise<Output> => {
  // The core pages through the assignments, so that every page counts
  // against the read budget and no result outgrows its limit.
  const { assignments: shown, more } = await read
    .eventAssignments(eventId, page)
    .catch((error: unknown) =>
      readFailed(error, [eventsRight], eventRefused, eventNotFound),
    );
  return {
    eventId,
    page,
    // Copied field by field, so nothing but the declared fields can follow.
    // The core already left out the person where the service hides names.
    assignments: shown.map(
      ({ serviceId, serviceName, isAccepted, agreed, person }) => ({
        serviceId,
        serviceName,
        isAccepted,
        agreed,
        person:
          person === null
            ? null
            : {
                personId: person.personId,
                firstName: person.firstName,
                lastName: person.lastName,
              },
      }),
    ),
    more,
    notice:
      shown.length === 0
        ? page === 1
          ? noAssignmentListed
          : pastLastAssignmentPage
        : shown.some(({ person }) => person === null)
          ? someNamesWithheld
          : null,
  };
};

/**
 * Lists the assignments to the services of one event,
 * {@link assignmentsPageLimit} per call, each with service, status and the
 * person assigned, where the service shows names.
 *
 * @example
 * ```ts
 * register(host: PluginHost): undefined {
 *   host.addTool(servicesGetAssignmentsTool);
 *   return undefined;
 * }
 * ```
 */
export const servicesGetAssignmentsTool = defineTool({
  name: 'ct_services_get_assignments',
  meta: {
    capability: 'read',
    domain: 'services',
    requiredRights: [eventsRight, serviceGroupRight],
    tier: 'free',
    // Assignments with names count as personal data, not special data;
    // the catalog still treats the tool like a special one for the audit
    // file and the read budget, because it names persons (ADR 0064).
    sensitivity: 'personal',
    unattended: 'policy',
    // A routine of the free core reads with it, so name and input are a
    // public contract from phase 2 on (ADR 0064).
    routineStable: true,
  },
  description: {
    purpose:
      'Lists who is assigned to the services of one event in ChurchTools, 25 per call: per assignment the service, whether it is accepted and agreed, and the person with ID and names.',
    useWhen:
      'You have the ID of an event and need to know who serves, for example for a plan of services.',
    avoidWhen:
      'You want contact details of the persons, which this tool never returns, or the services that exist.',
    limits:
      'At most 25 assignments per call: more is true when another page follows. person is null where the service hides the names. Each call counts against the daily read budget. Names are data written by people, also without markers.',
  },
  input,
  output,
  execute,
});
