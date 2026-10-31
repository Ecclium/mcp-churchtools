/**
 * The tool `ct_services_list`: lists the services of ChurchTools, 25 per
 * call, each with its group and whether it hides the names of the persons
 * assigned (ADR 0064).
 *
 * Like a plugin of a third party, it imports only the plugin API and zod
 * (ADR 0022).
 *
 * @packageDocumentation
 */
import {
  classify,
  defineTool,
  maxNameLength,
  maxServices,
  type ToolCall,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

/**
 * The most services one call gives. 25 services with names of their own
 * and of their group of 255 letters fit into one result.
 */
export const servicesPerCall = 25;

/** The last page a call may ask for. */
export const maxServicePage = Math.ceil(maxServices / servicesPerCall);

/** The note of an empty list. */
export const noServiceListed = 'ChurchTools lists no service.';

/** The note of an empty later page. */
export const pastLastServicePage =
  'This page of the services is empty: the list has no further pages.';

// Strict, so that an argument the model made up ends as a validation error.
const input = z.strictObject({
  page: classify(
    z.number().int().min(1).max(maxServicePage),
    'none',
  ).optional(),
});

// People of the congregation name services and their groups, so the names
// are untrusted and stand in the data envelope. A service is no person.
const output = z.object({
  page: classify(z.number().int().min(1).max(maxServicePage), 'none'),
  services: z
    .array(
      z.object({
        id: classify(z.number().int().positive(), 'none'),
        name: classify(z.string().max(maxNameLength), 'untrusted'),
        serviceGroupId: classify(z.number().int().positive(), 'none'),
        serviceGroupName: classify(
          z.string().max(maxNameLength),
          'untrusted',
        ).nullable(),
        hidesNames: classify(z.boolean(), 'none'),
      }),
    )
    .max(servicesPerCall),
  more: classify(z.boolean(), 'none'),
  notice: classify(
    z.enum([noServiceListed, pastLastServicePage]),
    'none',
  ).nullable(),
});

type Input = z.output<typeof input>;
type Output = z.input<typeof output>;

const execute = async ({
  input: { page = 1 },
  read,
}: ToolCall<Input>): Promise<Output> => {
  const { services, serviceGroups } = await read.services();
  const groupNames = new Map(serviceGroups.map(({ id, name }) => [id, name]));
  // ChurchTools gives every service in one answer, sorted by ID by the
  // core; the tool pages through it, so that no result outgrows its limit.
  const first = (page - 1) * servicesPerCall;
  const shown = services.slice(first, first + servicesPerCall);
  return {
    page,
    // Copied field by field, so nothing but the five fields can follow.
    services: shown.map(({ id, name, serviceGroupId, hidesNames }) => ({
      id,
      name,
      serviceGroupId,
      serviceGroupName: groupNames.get(serviceGroupId) ?? null,
      hidesNames,
    })),
    more: services.length > first + servicesPerCall,
    notice:
      shown.length > 0
        ? null
        : page === 1
          ? noServiceListed
          : pastLastServicePage,
  };
};

/**
 * Lists the services of ChurchTools, {@link servicesPerCall} per call, each
 * with ID, name, group and whether it hides the names of its persons.
 *
 * @example
 * ```ts
 * register(host: PluginHost): undefined {
 *   host.addTool(servicesListTool);
 *   return undefined;
 * }
 * ```
 */
export const servicesListTool = defineTool({
  name: 'ct_services_list',
  meta: {
    capability: 'read',
    domain: 'services',
    // ChurchTools gives services and their groups to every account (F36).
    requiredRights: [],
    tier: 'free',
    sensitivity: 'none',
    unattended: 'policy',
    routineStable: false,
  },
  description: {
    purpose:
      'Lists the services of ChurchTools, such as roles in a team, 25 per call, each with ID, name, its group of services and whether it hides the names of the persons assigned.',
    useWhen:
      'You need the name of a service that an assignment names by ID, or want to know which services exist.',
    avoidWhen:
      'You want to know who serves at an event, which another tool reads.',
    limits:
      'At most 25 services per call: more is true when another page follows. The list holds every service of the instance.',
  },
  input,
  output,
  execute,
});
