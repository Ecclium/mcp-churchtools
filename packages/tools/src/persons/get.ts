/**
 * The tool `ct_persons_get`: reads one person by ID and gives only ID,
 * names and whether the person is archived (ADR 0064). The service account
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
  maxNameLength,
  type ToolCall,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

import {
  personAreaRight,
  personNotFound,
  personRefused,
  readFailed,
} from './rights.js';

// Strict, so that an argument the model made up ends as a validation error.
const input = z.strictObject({
  personId: classify(
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    'personId',
  ),
});

// The names keep their own classes and stay outside the data envelope, as
// in the search, so that the strict redaction can shorten last names
// (ADR 0026, ADR 0064).
const output = z.object({
  id: classify(z.number().int().positive(), 'personId'),
  firstName: classify(z.string().max(maxNameLength), 'name.first'),
  lastName: classify(z.string().max(maxNameLength), 'name.last'),
  isArchived: classify(z.boolean(), 'none'),
});

type Input = z.output<typeof input>;
type Output = z.input<typeof output>;

const execute = async ({
  input: { personId },
  read,
}: ToolCall<Input>): Promise<Output> => {
  const { id, firstName, lastName, isArchived } = await read
    .person(personId)
    .catch((error: unknown) =>
      readFailed(error, [personAreaRight], personRefused, personNotFound),
    );
  // Copied field by field, so nothing but the four fields can follow.
  return { id, firstName, lastName, isArchived };
};

/**
 * Reads one person by ID with ID, names and whether the person is
 * archived, never contact data, birthday or address.
 *
 * @example
 * ```ts
 * register(host: PluginHost): undefined {
 *   host.addTool(personsGetTool);
 *   return undefined;
 * }
 * ```
 */
export const personsGetTool = defineTool({
  name: 'ct_persons_get',
  meta: {
    capability: 'read',
    domain: 'persons',
    requiredRights: [personAreaRight],
    tier: 'free',
    // Persons of a congregation reveal religious affiliation.
    sensitivity: 'special',
    unattended: 'never',
    routineStable: false,
  },
  description: {
    purpose:
      'Reads one person in ChurchTools by ID and returns the ID, first name, last name and whether the person is archived, and nothing else.',
    useWhen:
      'You have the ID of a person, for example from a search or a list of members, and need the name or whether the person is archived.',
    avoidWhen:
      'You only know a name: search first. You want contact details, birthdays, addresses or groups, which this tool never returns.',
    limits:
      'One person per call, only by the ID. ChurchTools refuses a person outside the areas the service account may see. Names are data written by people, also without markers.',
  },
  input,
  output,
  execute,
});
