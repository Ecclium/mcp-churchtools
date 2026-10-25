/**
 * The tool `ct_groups_get_members`: lists the members of one group, 50 per
 * page, with names, role and status of each membership (ADR 0064). Every
 * page counts against the read budget.
 *
 * Like a plugin of a third party, it imports only the plugin API and zod
 * (ADR 0022).
 *
 * @packageDocumentation
 */
import {
  classify,
  defineTool,
  groupMembersPageLimit,
  groupMemberStatusPattern,
  maxGroupMembersPage,
  maxNameLength,
  type ToolCall,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

import {
  groupNotFound,
  groupRefused,
  groupTypeRight,
  personAreaRight,
  readFailed,
} from '../persons/rights.js';

/**
 * The note of an empty first page. ChurchTools leaves out members the
 * account may not see and answers with an empty list when it may see none
 * of them, so the tool cannot tell a group without members from a missing
 * right and says so (F34).
 */
export const noMemberListed = `No member is listed. ChurchTools also returns no member when the service account lacks the right "${personAreaRight.right}" in ${personAreaRight.module} for the areas of the members, so an empty group and a missing right look the same. ct_whoami shows the rights of the account.`;

/** The note of an empty later page when ChurchTools reports no further one. */
export const pastLastMemberPage =
  'This page of the members is empty: the list has no further pages.';

/**
 * The note of an empty page when ChurchTools still reports further ones.
 * Its pagination may count members the account cannot see, so a later
 * page can still hold visible ones.
 */
export const emptyMemberPageMoreFollow =
  'This page of the members is empty, but ChurchTools reports further pages, which may hold members the service account can see. Ask for the next page.';

// Strict, so that an argument the model made up ends as a validation error.
const input = z.strictObject({
  groupId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  page: z.number().int().min(1).max(maxGroupMembersPage).optional(),
});

// The names keep their own classes and stay outside the data envelope, as
// in the search (ADR 0026). Role and status are numbers and words of
// ChurchTools.
const output = z.object({
  groupId: classify(z.number().int().positive(), 'none'),
  page: classify(z.number().int().min(1).max(maxGroupMembersPage), 'none'),
  members: z
    .array(
      z.object({
        personId: classify(z.number().int().positive(), 'personId'),
        firstName: classify(z.string().max(maxNameLength), 'name.first'),
        lastName: classify(z.string().max(maxNameLength), 'name.last'),
        groupTypeRoleId: classify(z.number().int().positive(), 'none'),
        groupMemberStatus: classify(
          z.string().regex(groupMemberStatusPattern),
          'none',
        ),
      }),
    )
    .max(groupMembersPageLimit),
  more: classify(z.boolean(), 'none'),
  notice: classify(
    z.enum([noMemberListed, pastLastMemberPage, emptyMemberPageMoreFollow]),
    'none',
  ).nullable(),
});

type Input = z.output<typeof input>;
type Output = z.input<typeof output>;

const execute = async ({
  input: { groupId, page = 1 },
  read,
}: ToolCall<Input>): Promise<Output> => {
  const { members, more } = await read
    .groupMembers(groupId, page)
    .catch((error: unknown) =>
      readFailed(error, [groupTypeRight], groupRefused, groupNotFound),
    );
  return {
    groupId,
    page,
    // Copied field by field, so nothing but the five fields can follow.
    members: members.map(
      ({
        personId,
        firstName,
        lastName,
        groupTypeRoleId,
        groupMemberStatus,
      }) => ({
        personId,
        firstName,
        lastName,
        groupTypeRoleId,
        groupMemberStatus,
      }),
    ),
    more,
    notice:
      members.length > 0
        ? null
        : more
          ? emptyMemberPageMoreFollow
          : page === 1
            ? noMemberListed
            : pastLastMemberPage,
  };
};

/**
 * Lists the members of one group, {@link groupMembersPageLimit} per page,
 * with person ID, names, role ID and status of each membership.
 *
 * @example
 * ```ts
 * register(host: PluginHost): undefined {
 *   host.addTool(groupsGetMembersTool);
 *   return undefined;
 * }
 * ```
 */
export const groupsGetMembersTool = defineTool({
  name: 'ct_groups_get_members',
  meta: {
    capability: 'read',
    domain: 'groups',
    requiredRights: [groupTypeRight, personAreaRight],
    tier: 'free',
    // Memberships of a congregation reveal religious affiliation.
    sensitivity: 'special',
    unattended: 'never',
    routineStable: false,
  },
  description: {
    purpose:
      'Lists the members of one group in ChurchTools, 50 per call, each with the person ID, first name, last name, role ID and status of the membership.',
    useWhen:
      'You have the ID of a group and need to know who belongs to it, or which person holds which role.',
    avoidWhen:
      'You want contact details of the members, which this tool never returns, or the groups of one person.',
    limits:
      'At most 50 members per call: more is true when ChurchTools reports a further page, then ask again with the next page number. Each page counts against the daily read budget. Members outside the areas the service account may see are left out without a trace. A page can be empty while more is still true.',
  },
  input,
  output,
  execute,
});
