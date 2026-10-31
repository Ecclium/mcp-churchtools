/**
 * The tool `ct_persons_get_groups`: lists the groups of one person with
 * role and status of each membership, at most 50 (ADR 0064).
 *
 * Like a plugin of a third party, it imports only the plugin API and zod
 * (ADR 0022).
 *
 * @packageDocumentation
 */
import {
  classify,
  defineTool,
  groupMemberStatusPattern,
  maxNameLength,
  maxPersonGroups,
  type ToolCall,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

import {
  groupTypeRight,
  personAreaRight,
  personNotFound,
  personRefused,
  readFailed,
} from './rights.js';

/**
 * The note of an empty result. ChurchTools answers with an empty list,
 * not with an error, both for a person the account may not see and for
 * groups of a type it may not see, so the tool cannot tell these apart
 * from a person without groups and says so (F29, F34).
 */
export const noGroupListed = `No group is listed for this person. ChurchTools also returns none when the service account lacks the right "${personAreaRight.right}" in ${personAreaRight.module} for the area of the person or the right "${groupTypeRight.right}" in ${groupTypeRight.module} for the type of a group, so no membership and a missing right look the same. ct_whoami shows the rights of the account.`;

/** The note of a result with more groups than it lists. */
export const moreGroupsListed = `The person belongs to more than ${String(maxPersonGroups)} groups; this list holds the first ${String(maxPersonGroups)}.`;

// Strict, so that an argument the model made up ends as a validation error.
const input = z.strictObject({
  personId: classify(
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    'personId',
  ),
});

// People of the congregation name their groups, so the name stands in the
// data envelope. Role and status are numbers and words of ChurchTools. The
// ID of a group is null when ChurchTools names the group otherwise.
const output = z.object({
  personId: classify(z.number().int().positive(), 'personId'),
  groups: z
    .array(
      z.object({
        groupId: classify(z.number().int().positive(), 'groupId').nullable(),
        groupName: classify(z.string().max(maxNameLength), 'untrusted'),
        groupTypeRoleId: classify(z.number().int().positive(), 'none'),
        groupMemberStatus: classify(
          z.string().regex(groupMemberStatusPattern),
          'none',
        ),
      }),
    )
    .max(maxPersonGroups),
  more: classify(z.boolean(), 'none'),
  notice: classify(
    z.enum([noGroupListed, moreGroupsListed]),
    'none',
  ).nullable(),
});

type Input = z.output<typeof input>;
type Output = z.input<typeof output>;

const execute = async ({
  input: { personId },
  read,
}: ToolCall<Input>): Promise<Output> => {
  const { groups, more } = await read
    .personGroups(personId)
    .catch((error: unknown) =>
      readFailed(
        error,
        [personAreaRight, groupTypeRight],
        personRefused,
        personNotFound,
      ),
    );
  return {
    personId,
    // Copied field by field, so nothing but the four fields can follow.
    groups: groups.map(
      ({ groupId, groupName, groupTypeRoleId, groupMemberStatus }) => ({
        groupId,
        groupName,
        groupTypeRoleId,
        groupMemberStatus,
      }),
    ),
    more,
    notice:
      groups.length === 0 ? noGroupListed : more ? moreGroupsListed : null,
  };
};

/**
 * Lists the groups of one person, at most {@link maxPersonGroups}, with
 * ID and name of each group and the role and status of the membership.
 *
 * @example
 * ```ts
 * register(host: PluginHost): undefined {
 *   host.addTool(personsGetGroupsTool);
 *   return undefined;
 * }
 * ```
 */
export const personsGetGroupsTool = defineTool({
  name: 'ct_persons_get_groups',
  meta: {
    capability: 'read',
    domain: 'persons',
    requiredRights: [personAreaRight, groupTypeRight],
    tier: 'free',
    // Memberships of a congregation reveal religious affiliation.
    sensitivity: 'special',
    unattended: 'never',
    routineStable: false,
  },
  description: {
    purpose:
      'Lists the groups one person in ChurchTools belongs to, at most 50, each with the group ID and name, the role ID and the status of the membership.',
    useWhen:
      'You have the ID of a person and need to know in which groups the person is and with which role or status.',
    avoidWhen:
      'You want the members of a group: read the members of the group instead.',
    limits:
      'At most 50 groups and no further pages: more is true when the person belongs to more groups. It lists the memberships ChurchTools shows by default, without its switches for past, inactive, requested or deleted ones, and only groups of the types the service account may see. An empty result can also mean a missing right.',
  },
  input,
  output,
  execute,
});
