/**
 * The tool `ct_groups_get`: reads one group by ID with its name and the
 * details the lowest security level of groups adds, such as meeting time
 * and note (ADR 0064). Members and leaders come only from the list of
 * members.
 *
 * Like a plugin of a third party, it imports only the plugin API and zod
 * (ADR 0022).
 *
 * @packageDocumentation
 */
import {
  calendarDatePattern,
  classify,
  defineTool,
  maxGroupMeetingTimeLength,
  maxGroupNoteLength,
  maxNameLength,
  type ToolCall,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

import {
  groupLevelRight,
  groupNotFound,
  groupRefused,
  groupTypeRight,
  readFailed,
} from '../persons/rights.js';

/**
 * The note of a group without details. ChurchTools leaves them out without
 * an error when the account lacks the lowest security level of groups, so
 * the tool names that right (F32).
 */
export const noGroupDetails = `ChurchTools sent no details of this group, such as its meeting time or note. The service account needs the right "${groupLevelRight.right}" in ${groupLevelRight.module} at the lowest level for them; ct_whoami shows the rights of the account.`;

// Strict, so that an argument the model made up ends as a validation error.
const input = z.strictObject({
  groupId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

// Name, meeting time and note are text people of the congregation write,
// so they stand in the data envelope. A group is no person: its ID has the
// class groupId, which no level of redaction changes and the audit records
// (ADR 0028), and the numbers and dates of its details carry no class of
// personal data.
const output = z.object({
  id: classify(z.number().int().positive(), 'groupId'),
  name: classify(z.string().max(maxNameLength), 'untrusted'),
  details: z
    .object({
      meetingTime: classify(
        z.string().max(maxGroupMeetingTimeLength),
        'untrusted',
      ).nullable(),
      note: classify(
        z.string().max(maxGroupNoteLength),
        'untrusted',
      ).nullable(),
      maxMembers: classify(z.number().int().nonnegative(), 'none').nullable(),
      targetGroupId: classify(z.number().int().positive(), 'none').nullable(),
      dateOfFoundation: classify(
        z.string().regex(calendarDatePattern),
        'none',
      ).nullable(),
      endDate: classify(
        z.string().regex(calendarDatePattern),
        'none',
      ).nullable(),
    })
    .nullable(),
  notice: classify(z.enum([noGroupDetails]), 'none').nullable(),
});

type Input = z.output<typeof input>;
type Output = z.input<typeof output>;

const execute = async ({
  input: { groupId },
  read,
}: ToolCall<Input>): Promise<Output> => {
  const { id, name, details } = await read
    .group(groupId)
    .catch((error: unknown) =>
      readFailed(error, [groupTypeRight], groupRefused, groupNotFound),
    );
  return {
    id,
    name,
    // Copied field by field, so nothing but the six details can follow.
    details:
      details === null
        ? null
        : {
            meetingTime: details.meetingTime,
            note: details.note,
            maxMembers: details.maxMembers,
            targetGroupId: details.targetGroupId,
            dateOfFoundation: details.dateOfFoundation,
            endDate: details.endDate,
          },
    notice: details === null ? noGroupDetails : null,
  };
};

/**
 * Reads one group by ID with its name and, with the lowest security level
 * of groups, meeting time, note, maximum of members, target group,
 * founding and end.
 *
 * @example
 * ```ts
 * register(host: PluginHost): undefined {
 *   host.addTool(groupsGetTool);
 *   return undefined;
 * }
 * ```
 */
export const groupsGetTool = defineTool({
  name: 'ct_groups_get',
  meta: {
    capability: 'read',
    domain: 'groups',
    requiredRights: [groupTypeRight, groupLevelRight],
    tier: 'free',
    // Groups of a congregation reveal religious affiliation.
    sensitivity: 'special',
    unattended: 'never',
    routineStable: false,
  },
  description: {
    purpose:
      'Reads one group in ChurchTools by ID and returns its name, meeting time, note, maximum number of members, target group ID, founding date and end date.',
    useWhen:
      'You have the ID of a group, for example from a search or the groups of a person, and need to know when it meets or what its note says.',
    avoidWhen:
      'You only know a name: search first. You want the members or leaders, which come from the members of the group.',
    limits:
      'One group per call, only by the numeric ID. ChurchTools refuses a group of a type the service account may not see. Without the lowest security level of groups the details are null and the result says so. Dates are days without time.',
  },
  input,
  output,
  execute,
});
