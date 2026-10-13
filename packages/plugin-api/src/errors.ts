/**
 * Stable codes for every error the core reports.
 *
 * @packageDocumentation
 */

/**
 * The category of an error. The core translates every failure into one of
 * these, so the model, the audit and an operator see the same small set,
 * never a message of ChurchTools. A tool error reaches the model as a result
 * with a code and a short message in English.
 *
 * The codes are a contract: renaming or removing one breaks plugins and
 * every reader of the audit.
 */
export type ErrorCode =
  | 'config'
  | 'auth'
  | 'permission'
  | 'not_found'
  | 'validation'
  | 'conflict'
  | 'rate_limited'
  | 'upstream'
  | 'network'
  | 'policy_denied'
  | 'confirmation_required'
  | 'license_required'
  | 'internal';

/** Every {@link ErrorCode}, frozen, for checks at run time. */
export const errorCodes: readonly ErrorCode[] = Object.freeze([
  'config',
  'auth',
  'permission',
  'not_found',
  'validation',
  'conflict',
  'rate_limited',
  'upstream',
  'network',
  'policy_denied',
  'confirmation_required',
  'license_required',
  'internal',
]);
