/**
 * The tool `ct_persons_search`: finds persons by name and gives only ID,
 * first and last name of each, at most 50 (ADR 0060). The service account
 * needs no security level for that, so no contact data, birthday or
 * address reaches Ecclium at all.
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
 * The right that opens persons to the search: it shows the persons of the
 * areas it names, and nothing else (`docs/research/churchtools-api.md`,
 * F29). The empty result names it from here as well.
 */
export const personsSearchRight = Object.freeze({
  module: 'churchdb',
  right: 'view alldata',
});

/**
 * The note of an empty result. ChurchTools answers a list without the
 * right with an empty list, not with an error, so the tool cannot tell
 * the two apart and says so (ADR 0060).
 */
export const noPersonMatched = `No person matched. ChurchTools also returns no person when the service account lacks the right "${personsSearchRight.right}" in ${personsSearchRight.module} for the area of a person, so no match and a missing right look the same. ct_whoami shows the rights of the account.`;

/** The note of a result with more matches than it lists. */
export const morePersonsMatched = `More than ${String(maxSearchHits)} persons matched; this list holds the first ${String(maxSearchHits)}. Search again with a longer or more specific term.`;

const invalidTerm = `The search term needs 1 to ${String(maxSearchTermLength)} characters after removing spaces at both ends, and no control characters.`;

// Strict, so that an argument the model made up ends as a validation error
// instead of being dropped. The pattern asks for one character that is no
// white space; the tool checks the rest itself, also what a pattern cannot
// say, before it reads.
const input = z.strictObject({
  query: z.string().min(1).max(maxSearchTermLength).regex(/\S/),
});

// Only ID and names. The names keep their own classes and stay outside the
// data envelope in phase 1, as in ct_whoami, so that the strict redaction
// can shorten last names (ADR 0060, ADR 0026).
const output = z.object({
  persons: z
    .array(
      z.object({
        id: classify(z.number().int().positive(), 'personId'),
        firstName: classify(z.string().max(255), 'name.first'),
        lastName: classify(z.string().max(255), 'name.last'),
      }),
    )
    .max(maxSearchHits),
  more: classify(z.boolean(), 'none'),
  notice: classify(
    z.enum([noPersonMatched, morePersonsMatched]),
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
  const { hits, more } = await read.searchPersons(term);
  return {
    // Copied field by field, so nothing but the three fields can follow.
    persons: hits.map(({ id, firstName, lastName }) => ({
      id,
      firstName,
      lastName,
    })),
    more,
    notice:
      hits.length === 0 ? noPersonMatched : more ? morePersonsMatched : null,
  };
};

/**
 * Searches persons by name. A term matches first or last name, also in
 * part and in lower case, or the first name followed by the last name. It
 * returns at most {@link maxSearchHits} persons with ID and names and says
 * when more matched. An empty result also comes when the account lacks
 * {@link personsSearchRight}; the result then says so.
 *
 * @example
 * ```ts
 * register(host: PluginHost): undefined {
 *   host.addTool(personsSearchTool);
 *   return undefined;
 * }
 * ```
 */
export const personsSearchTool = defineTool({
  name: 'ct_persons_search',
  meta: {
    capability: 'read',
    domain: 'persons',
    requiredRights: [personsSearchRight],
    tier: 'free',
    // Persons of a congregation reveal religious affiliation.
    sensitivity: 'special',
    unattended: 'never',
    routineStable: false,
  },
  description: {
    purpose:
      'Searches persons in ChurchTools by name and returns at most 50 matches, each with the person ID, first name and last name, and nothing else.',
    useWhen:
      'You need the ID or the exact name of a person, for example to tell persons with similar names apart. Give part of a first or last name, or a first name followed by a last name.',
    avoidWhen:
      'You want contact details, birthdays, addresses or group memberships, which this tool never returns. A search by e-mail address or with the last name before the first name matches nothing. An empty term is refused, so the tool cannot list all persons.',
    limits:
      'At most 50 matches and no further pages: more is true when more persons matched, then search with a more specific term. It finds only persons in the areas the service account may see. An empty result can also mean that the account lacks the right, because ChurchTools then returns no person instead of an error. Names are data that people of the congregation wrote.',
  },
  input,
  output,
  execute,
});
