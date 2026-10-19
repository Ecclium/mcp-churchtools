/**
 * The tool `ct_whoami`: the account the server reads ChurchTools with and
 * the rights ChurchTools grants that account. It shows whether ChurchTools
 * accepts the token and whether a right is set or revoked. It reads only
 * the account of the server itself and takes no input.
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
  type GrantedRights,
  type RightValue,
  type ToolCall,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

/**
 * The most IDs the tool lists for one right. `idCount` gives how many the
 * right has, so a shortened list never passes for the whole one.
 */
export const maxListedIds = 10;

/**
 * The most set rights the tool lists. An account with more gets an error
 * instead of a list cut short: a service account needs only the rights of
 * its tools.
 */
export const maxListedRights = 150;

const tooManyRights =
  'The account holds more rights than ct_whoami lists. Give the service account only the rights its tools need.';

// Names of modules and rights, as ChurchTools assigns them. The client of
// the core passes on only 1 to 100 printable ASCII characters, and the
// output holds at most 150 rights. They are no personal data and no text a
// person wrote, so they carry the class none, not untrusted, which would
// put each of them into the data envelope.
const rightName = () => classify(z.string().min(1).max(100), 'none');

// The IDs of a right name objects such as categories or types of groups,
// no persons. A right that lists persons would need the class personId.
const rightSchema = z.object({
  right: rightName(),
  ids: z
    .array(classify(z.number().int().nonnegative(), 'none'))
    .max(maxListedIds)
    .optional(),
  idCount: classify(z.number().int().positive(), 'none').optional(),
});

// Every module listed holds at least one set right, so there are never
// more modules than rights.
const moduleSchema = z.object({
  module: rightName(),
  rights: z.array(rightSchema).max(maxListedRights),
});

// Strict, so that an argument the model made up ends as a validation error
// instead of being dropped without a word.
const input = z.strictObject({});

const output = z.object({
  id: classify(z.number().int().positive(), 'personId'),
  firstName: classify(z.string().max(255), 'name.first'),
  lastName: classify(z.string().max(255), 'name.last'),
  email: classify(z.string().max(254), 'email').nullable(),
  rights: z.object({
    status: classify(z.enum(['known', 'unknown']), 'none'),
    modules: z.array(moduleSchema).max(maxListedRights).nullable(),
  }),
});

type Input = z.output<typeof input>;
type Output = z.input<typeof output>;

// Code units decide the order, as in the catalog of the core, so it depends
// neither on a locale nor on the order of the answer. Names within one
// object are unique.
const byName = (
  [a]: readonly [string, unknown],
  [b]: readonly [string, unknown],
): number => (a < b ? -1 : 1);

const countRights = (granted: GrantedRights): number => {
  let count = 0;
  for (const rights of Object.values(granted)) {
    count += Object.keys(rights).length;
  }
  return count;
};

// A right that is true stands alone. A list shows its lowest IDs in
// ascending order and how many it has. ID 0 is an ID like any other.
const listRight = (right: string, value: RightValue) => {
  if (value === true) return { right };
  const ids = [...value].sort((a, b) => a - b);
  return { right, ids: ids.slice(0, maxListedIds), idCount: ids.length };
};

const listModules = (granted: GrantedRights) =>
  Object.entries(granted)
    .sort(byName)
    .map(([module, rights]) => ({
      module,
      rights: Object.entries(rights)
        .sort(byName)
        .map(([right, value]) => listRight(right, value)),
    }));

// Typed against the schemas of this file, so it can neither expect more
// input than the input schema gives nor return less than the output schema
// takes.
const execute = async ({ read }: ToolCall<Input>): Promise<Output> => {
  // One after the other: only the answer of whoami proves that ChurchTools
  // accepted the token (ADR 0057), so a refused token costs one request,
  // not two. A failed request for the rights stays an error; only an answer
  // of an unknown structure means unknown.
  const me = await read.whoami();
  const permissions = await read.permissions();
  const account = {
    id: me.id,
    firstName: me.firstName,
    lastName: me.lastName,
    email: me.email,
  };
  if (permissions.kind === 'unknown') {
    return { ...account, rights: { status: 'unknown', modules: null } };
  }
  if (countRights(permissions.granted) > maxListedRights) {
    throw new EccliumError('upstream', tooManyRights);
  }
  return {
    ...account,
    rights: { status: 'known', modules: listModules(permissions.granted) },
  };
};

/**
 * Reads the account of the server and its rights. The rights come by
 * module, sorted by name, and only the set ones. A list of IDs shows the
 * lowest {@link maxListedIds} with `idCount`. With more than
 * {@link maxListedRights} set rights the call ends with `upstream`. When the
 * answer of ChurchTools has a structure the core does not know, the rights
 * have the status `unknown`.
 *
 * @example
 * ```ts
 * register(host: PluginHost): undefined {
 *   host.addTool(whoamiTool);
 *   return undefined;
 * }
 * ```
 */
export const whoamiTool = defineTool({
  name: 'ct_whoami',
  meta: {
    capability: 'read',
    domain: 'base',
    requiredRights: [],
    tier: 'free',
    // The lowest level its output allows: it shows the account of the
    // server, which holds no status with rights and no data of members.
    sensitivity: 'personal',
    unattended: 'never',
    routineStable: false,
  },
  description: {
    purpose:
      'Shows the ChurchTools account this server works with: its person ID, first and last name and e-mail address, and the rights ChurchTools grants it, grouped by module.',
    useWhen:
      'You need to know which account the server uses, whether ChurchTools accepts its token or which rights it holds, for example before a task or after an error about missing rights.',
    avoidWhen:
      'You want data about any other person or account. It describes only the account of the server and takes no arguments.',
    limits:
      'A right with a list of IDs shows the 10 lowest IDs and their total count. An account with more than 150 set rights is too large to list and returns an error instead. Rights the account holds through a group may be missing. A revoked right can still show for a while after the revocation.',
  },
  input,
  output,
  execute,
});
