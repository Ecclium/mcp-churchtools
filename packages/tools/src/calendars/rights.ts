/**
 * The right the tools that read calendars and appointments need, and the
 * messages that name it (ADR 0064). Like a plugin of a third party, it
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
 * The right that opens the calendars it names and their appointments
 * (`docs/research/churchtools-api.md`, F36). Without it, ChurchTools leaves
 * a calendar out of the list and refuses its appointments with 403.
 */
export const calendarRight: RightRef = Object.freeze({
  module: 'churchcal',
  right: 'view category',
});

/** The message of a refused list of appointments. */
export const appointmentsRefused = `ChurchTools refused the appointments. The service account needs the right "${calendarRight.right}" in ${calendarRight.module} for each calendar named; ct_calendars_list lists the calendars the account may see.`;

/** The message of a refused appointment. */
export const appointmentRefused = `ChurchTools refused this appointment. The service account needs the right "${calendarRight.right}" in ${calendarRight.module} for its calendar; ct_calendars_list lists the calendars the account may see.`;

/** The message of an appointment that does not exist. */
export const appointmentNotFound =
  'There is no appointment with these IDs. ct_appointments_list finds the IDs of an appointment and of its calendar by its days.';

/** The message of a list of IDs that does not fit. */
export const invalidIds =
  'Name 1 to 10 IDs, each once, each a whole number from 1.';

/**
 * Ends a call whose list ChurchTools refused with an error that names the
 * rights the list needs. Every other error goes on as it is. A list of
 * appointments or bookings asks for IDs, so ChurchTools refuses it instead
 * of leaving entries out (F36).
 *
 * @param error - What the read threw.
 * @param rights - The rights the list needs.
 * @param refused - The message of a refusal.
 * @throws {EccliumError} `permission` with the message, or the error as it
 *   was.
 * @example
 * ```ts
 * const list = await read.appointments([8], from, to).catch((error: unknown) =>
 *   listRefused(error, [calendarRight], appointmentsRefused));
 * ```
 */
export function listRefused(
  error: unknown,
  rights: readonly RightRef[],
  refused: string,
): never {
  if (isEccliumError(error) && error.code === 'permission') {
    throw new EccliumError('permission', refused, { missingRights: rights });
  }
  throw error;
}
