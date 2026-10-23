/**
 * The tool `ct_groups_search`: finds groups by name and gives only ID and
 * name of each, at most 50 (ADR 0060). The service account needs no
 * security level of groups for that, so no other information of a group
 * reaches Ecclium.
 *
 * Like a plugin of a third party, it imports only the plugin API and zod
 * (ADR 0022).
 *
 * @packageDocumentation
 */
import {
  classify,
  defineTool,
  EccliumError,
  maxSearchHits,
  maxSearchTermLength,
  normalizeSearchTerm,
  type ToolCall,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

/**
 * The right that opens groups of the visibility «restricted» to the
 * search: it shows the groups of the group types it names
 * (`docs/research/churchtools-api.md`, F29). The empty result names it
 * from here as well.
 */
export const groupsSearchRight = Object.freeze({
  module: 'churchgroup',
  right: 'view groups of grouptype',
});

/**
 * The note of an empty result. ChurchTools answers a list without the
 * right with an empty list, not with an error, so the tool cannot tell
 * the two apart and says so (ADR 0060).
 */
export const noGroupMatched = `No group matched. ChurchTools also returns no group when the service account lacks the right "${groupsSearchRight.right}" in ${groupsSearchRight.module} for the type of a group, so no match and a missing right look the same. ct_whoami shows the rights of the account.`;

/** The note of a result with more matches than it lists. */
export const moreGroupsMatched = `More than ${String(maxSearchHits)} groups matched; this list holds the first ${String(maxSearchHits)}. Search again with a longer or more specific term.`;

const invalidTerm = `The search term needs 1 to ${String(maxSearchTermLength)} characters after removing spaces at both ends, and no control characters.`;

// Strict, so that an argument the model made up ends as a validation error
// instead of being dropped. The pattern asks for one character that is no
// white space; the tool checks the rest itself before it reads.
const input = z.strictObject({
  query: z.string().min(1).max(maxSearchTermLength).regex(/\S/),
});

// Only ID and name. People of the congregation name their groups, so the
// name is untrusted and stands in the data envelope. A group is no person,
// so its ID carries no class of personal data (ADR 0060).
const output = z.object({
  groups: z
    .array(
      z.object({
        id: classify(z.number().int().positive(), 'none'),
        name: classify(z.string().max(255), 'untrusted'),
      }),
    )
    .max(maxSearchHits),
  more: classify(z.boolean(), 'none'),
  notice: classify(
    z.enum([noGroupMatched, moreGroupsMatched]),
    'none',
  ).nullable(),
});

type Input = z.output<typeof input>;
type Output = z.input<typeof output>;

const execute = async ({
  input: { query },
  read,
}: ToolCall<Input>): Promise<Output> => {
  const term = normalizeSearchTerm(query);
  if (term === undefined) throw new EccliumError('validation', invalidTerm);
  const { hits, more } = await read.searchGroups(term);
  return {
    // Copied field by field, so nothing but the two fields can follow.
    groups: hits.map(({ id, name }) => ({ id, name })),
    more,
    notice:
      hits.length === 0 ? noGroupMatched : more ? moreGroupsMatched : null,
  };
};

/**
 * Searches groups by name, also in part and in lower case. It returns at
 * most {@link maxSearchHits} groups with ID and name and says when more
 * matched. An empty result also comes when the account lacks
 * {@link groupsSearchRight}; the result then says so.
 *
 * @example
 * ```ts
 * register(host: PluginHost): undefined {
 *   host.addTool(groupsSearchTool);
 *   return undefined;
 * }
 * ```
 */
export const groupsSearchTool = defineTool({
  name: 'ct_groups_search',
  meta: {
    capability: 'read',
    domain: 'groups',
    requiredRights: [groupsSearchRight],
    tier: 'free',
    // Groups of a congregation reveal religious affiliation.
    sensitivity: 'special',
    unattended: 'never',
    routineStable: false,
  },
  description: {
    purpose:
      'Searches groups in ChurchTools by name and returns at most 50 matches, each with the group ID and name, and nothing else.',
    useWhen:
      'You need the ID or the exact name of a group. Give part of its name.',
    avoidWhen:
      'You want members, leaders, meeting times or other details of a group, which this tool never returns. An empty term is refused, so the tool cannot list all groups.',
    limits:
      'At most 50 matches and no further pages: more is true when more groups matched, then search with a more specific term. It finds groups of the group types the service account may see, and groups with the visibility internal even without that right. An empty result can also mean that the account lacks the right, because ChurchTools then returns no group instead of an error.',
  },
  input,
  output,
  execute,
});
