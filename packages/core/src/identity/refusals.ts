/**
 * What a check of the sign-in over HTTP gives (ADR 0037, ADR 0074): the
 * identity, or the reason of the refusal from a fixed list. The server
 * answers every refusal with 401, the same for each reason that carried a
 * credential, and names the reason only in its log line, so that a client
 * learns nothing about which check failed.
 *
 * The list is fixed, so that a reason never carries a value of the
 * request: the logger takes no other text in the field `reason`.
 *
 * @packageDocumentation
 */
import type { Identity } from '@ecclium/mcp-churchtools-plugin-api';

/**
 * The reasons to refuse a sign-in, frozen:
 *
 * - `missing`: the request has no `Authorization` header;
 * - `scheme`: its scheme is not `Bearer`;
 * - `form`: what follows has not the form of a token;
 * - `checksum`: the checksum of the token is wrong;
 * - `unknown`: no entry has its hash, also after a revoke;
 * - `expired`: its last day is over;
 * - `not_yet_valid`: its first day lies ahead;
 * - `tokens_file`: the file of the tokens is missing, unreadable or
 *   invalid, so that no token holds until it is valid again;
 * - `failed`: the check itself failed, such as a clock without a day or
 *   a check that threw.
 */
export const signInRefusals = Object.freeze([
  'missing',
  'scheme',
  'form',
  'checksum',
  'unknown',
  'expired',
  'not_yet_valid',
  'tokens_file',
  'failed',
] as const);

/** A reason to refuse a sign-in. */
export type SignInRefusal = (typeof signInRefusals)[number];

/** What a check of the sign-in gives for one request. */
export type SignInResult =
  | { readonly ok: true; readonly identity: Identity }
  | { readonly ok: false; readonly reason: SignInRefusal };

/**
 * Tells whether a value is a reason of the list, compared exactly.
 *
 * @param value - Any value.
 * @returns Whether it is one.
 * @example
 * ```ts
 * isSignInRefusal('expired'); // true
 * isSignInRefusal('person-id-1'); // false
 * ```
 */
export function isSignInRefusal(value: unknown): value is SignInRefusal {
  return (signInRefusals as readonly unknown[]).includes(value);
}

/**
 * Tells whether a refused request presented a credential of the scheme
 * `Bearer`. RFC 6750 names no error in `WWW-Authenticate` for a request
 * without one: without a header, or with another scheme.
 *
 * @param reason - A reason of the list.
 * @returns Whether the request carried a credential.
 * @example
 * ```ts
 * presentedCredential('missing'); // false
 * presentedCredential('expired'); // true
 * ```
 */
export function presentedCredential(reason: SignInRefusal): boolean {
  return reason !== 'missing' && reason !== 'scheme';
}
