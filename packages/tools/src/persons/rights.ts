/**
 * The rights the tools that read persons and groups by ID need, and the
 * errors that name them (ADR 0064). Like a plugin of a third party, it
 * imports only the plugin API (ADR 0022).
 *
 * @packageDocumentation
 */
import {
  EccliumError,
  isEccliumError,
  type RightRef,
} from '@ecclium/mcp-churchtools-plugin-api';

/**
 * The right that opens the persons of the areas it names
 * (`docs/research/churchtools-api.md`, F29). Without it, ChurchTools
 * refuses a person with 403 and leaves the person out of every list.
 */
export const personAreaRight: RightRef = Object.freeze({
  module: 'churchdb',
  right: 'view alldata',
});

/**
 * The right that opens the groups of the group types it names (F29).
 * Without it, ChurchTools refuses a group and its members with 403 and
 * leaves the group out of the groups of a person.
 */
export const groupTypeRight: RightRef = Object.freeze({
  module: 'churchgroup',
  right: 'view groups of grouptype',
});

/**
 * The right whose lowest level adds the details a group passes on, such as
 * its meeting time and note (F32). Without it, ChurchTools leaves them out
 * and answers without an error.
 */
export const groupLevelRight: RightRef = Object.freeze({
  module: 'churchgroup',
  right: 'security level group',
});

/** The message of a refused person. */
export const personRefused = `ChurchTools refused this person. The service account needs the right "${personAreaRight.right}" in ${personAreaRight.module} for the area of the person; ct_whoami shows the rights of the account.`;

/** The message of a refused group or list of members. */
export const groupRefused = `ChurchTools refused this group. The service account needs the right "${groupTypeRight.right}" in ${groupTypeRight.module} for the type of the group; ct_whoami shows the rights of the account.`;

/** The message of a person that does not exist. */
export const personNotFound =
  'There is no person with this ID. ct_persons_search finds the ID of a person by name.';

/** The message of a group that does not exist. */
export const groupNotFound =
  'There is no group with this ID. ct_groups_search finds the ID of a group by name.';

/**
 * Ends a call whose read failed with an error that names what the model
 * can do: a missing object with its own message, a refusal with the
 * rights the read needs. Every other error goes on as it is.
 *
 * @param error - What the read threw.
 * @param rights - The rights the read needs.
 * @param refused - The message of a refusal.
 * @param notFound - The message of a missing object.
 * @throws {EccliumError} `not_found` or `permission` with the message, or
 *   the error as it was.
 * @example
 * ```ts
 * const person = await read.person(7).catch((error: unknown) =>
 *   readFailed(error, [personAreaRight], personRefused, personNotFound));
 * ```
 */
export function readFailed(
  error: unknown,
  rights: readonly RightRef[],
  refused: string,
  notFound: string,
): never {
  if (isEccliumError(error) && error.code === 'not_found') {
    throw new EccliumError('not_found', notFound);
  }
  if (isEccliumError(error) && error.code === 'permission') {
    throw new EccliumError('permission', refused, { missingRights: rights });
  }
  throw error;
}
