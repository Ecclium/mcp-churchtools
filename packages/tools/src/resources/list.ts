/**
 * The tool `ct_resources_list`: lists the resources of ChurchTools the
 * service account may see, such as rooms, 25 per call, each with ID, name
 * and type (ADR 0064).
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
  maxResources,
  type ToolCall,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

import { resourceRight } from './rights.js';

/**
 * The most resources one call gives. 25 resources with names of their own
 * and of their type of 255 letters fit into one result.
 */
export const resourcesPerCall = 25;

/** The last page a call may ask for. */
export const maxResourcePage = Math.ceil(maxResources / resourcesPerCall);

/**
 * The note of an empty list. ChurchTools lists only the resources the
 * account may see and answers with an empty list without the right, so
 * the tool cannot tell an instance without resources from a missing right
 * and says so (F36).
 */
export const noResourceListed = `No resource is listed. ChurchTools also lists no resource for which the service account lacks the right "${resourceRight.right}" in ${resourceRight.module}, so no resources and a missing right look the same. ct_whoami shows the rights of the account.`;

/** The note of an empty later page. */
export const pastLastResourcePage =
  'This page of the resources is empty: the list has no further pages.';

// Strict, so that an argument the model made up ends as a validation error.
const input = z.strictObject({
  page: classify(
    z.number().int().min(1).max(maxResourcePage),
    'none',
  ).optional(),
});

// People of the congregation name resources and their types, so the names
// are untrusted and stand in the data envelope. A resource is no person.
const output = z.object({
  page: classify(z.number().int().min(1).max(maxResourcePage), 'none'),
  resources: z
    .array(
      z.object({
        id: classify(z.number().int().positive(), 'none'),
        name: classify(z.string().max(maxNameLength), 'untrusted'),
        resourceTypeId: classify(z.number().int().positive(), 'none'),
        resourceTypeName: classify(
          z.string().max(maxNameLength),
          'untrusted',
        ).nullable(),
      }),
    )
    .max(resourcesPerCall),
  more: classify(z.boolean(), 'none'),
  notice: classify(
    z.enum([noResourceListed, pastLastResourcePage]),
    'none',
  ).nullable(),
});

type Input = z.output<typeof input>;
type Output = z.input<typeof output>;

const execute = async ({
  input: { page = 1 },
  read,
}: ToolCall<Input>): Promise<Output> => {
  const { resources, resourceTypes } = await read.resources();
  const typeNames = new Map(resourceTypes.map(({ id, name }) => [id, name]));
  // ChurchTools gives every resource in one answer, sorted by ID by the
  // core; the tool pages through it, so that no result outgrows its limit.
  const first = (page - 1) * resourcesPerCall;
  const shown = resources.slice(first, first + resourcesPerCall);
  return {
    page,
    // Copied field by field, so nothing but the four fields can follow.
    resources: shown.map(({ id, name, resourceTypeId }) => ({
      id,
      name,
      resourceTypeId,
      resourceTypeName: typeNames.get(resourceTypeId) ?? null,
    })),
    more: resources.length > first + resourcesPerCall,
    notice:
      shown.length > 0
        ? null
        : page === 1
          ? noResourceListed
          : pastLastResourcePage,
  };
};

/**
 * Lists the resources the service account may see,
 * {@link resourcesPerCall} per call, each with ID, name and type.
 *
 * @example
 * ```ts
 * register(host: PluginHost): undefined {
 *   host.addTool(resourcesListTool);
 *   return undefined;
 * }
 * ```
 */
export const resourcesListTool = defineTool({
  name: 'ct_resources_list',
  meta: {
    capability: 'read',
    domain: 'resources',
    requiredRights: [resourceRight],
    tier: 'free',
    sensitivity: 'none',
    unattended: 'policy',
    routineStable: false,
  },
  description: {
    purpose:
      'Lists the resources of ChurchTools the service account may see, such as rooms or devices, 25 per call, each with ID, name and its type of resources.',
    useWhen:
      'You need the ID of a resource to list its bookings, or want to know which resources exist.',
    avoidWhen:
      'You need the bookings themselves, which another tool lists by resource.',
    limits:
      'At most 25 resources per call: more is true when another page follows. Resources the service account may not see are left out without a trace.',
  },
  input,
  output,
  execute,
});
