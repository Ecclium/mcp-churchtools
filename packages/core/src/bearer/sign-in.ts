/**
 * The check of a sign-in with a static bearer token over HTTP (ADR 0074):
 * from the value of the header `Authorization` to an identity, or to the
 * reason of the refusal from the fixed list.
 *
 * The file of the tokens is read anew for every request that presents a
 * token, without a cache, so that a revoke holds from the next request on
 * and no state lies between two requests (ADR 0073). A file that is
 * missing, unreadable or invalid refuses every token until it is valid
 * again, so that a damaged file never lifts a revoke.
 *
 * Nothing here logs, throws or returns the header, the token or a part of
 * either: a refusal is a reason of the list.
 *
 * @packageDocumentation
 */
import type { Clock } from '@ecclium/mcp-churchtools-plugin-api';

import type { ConfigFileSystem } from '../config/text-file.js';
import type { SignInRefusal, SignInResult } from '../identity/refusals.js';
import { readBearerTokensFile } from './file.js';
import { bearerTokenFormProblem, findBearerToken } from './token.js';

/** What {@link createBearerSignIn} needs. */
export interface BearerSignInOptions {
  /** The file of the tokens, an absolute normalised path. */
  readonly tokensFile: string;
  /** The clock; its UTC day decides whether a token holds. */
  readonly clock: Clock;
  /** The file functions of the reader, only for tests. */
  readonly fs?: ConfigFileSystem;
}

/** Checks the value of the header `Authorization` of one request. */
export type BearerSignIn = (
  authorization: string | null | undefined,
) => Promise<SignInResult>;

// The scheme of RFC 6750, compared without regard to case (RFC 9110).
const scheme = 'bearer';

const refuse = (reason: SignInRefusal): SignInResult =>
  Object.freeze({ __proto__: null, ok: false, reason });

// What a header presents: nothing, another scheme, or the text after the
// scheme and its spaces. Character by character, without a regular
// expression, whose legacy statics would keep the whole header.
const presentedOf = (
  header: unknown,
):
  | { readonly kind: 'missing' }
  | { readonly kind: 'scheme' }
  | { readonly kind: 'token'; readonly text: string } => {
  if (typeof header !== 'string' || header === '') return { kind: 'missing' };
  const space = header.indexOf(' ');
  const given = space === -1 ? header : header.slice(0, space);
  if (given.length !== scheme.length || given.toLowerCase() !== scheme) {
    return { kind: 'scheme' };
  }
  let start = space === -1 ? header.length : space;
  while (header.charCodeAt(start) === 0x20) start += 1;
  return { kind: 'token', text: header.slice(start) };
};

/**
 * Builds the check of the sign-in with a static bearer token. For each
 * request it reads, in this order: the scheme `Bearer`, then the form and
 * the checksum of what follows, before anything is read from disk, then
 * the UTC day of the clock, the file of the tokens and the entry of the
 * token with its days. A token that holds gives the identity of source
 * `bearer` with the name of its entry as subject and the scopes of its
 * entry.
 *
 * @param options - The file of the tokens, the clock and, for tests, the
 *   file functions.
 * @returns The check. Its promise never rejects: a failure of the check
 *   itself is the reason `failed`.
 * @throws {TypeError} When the path is no string or the clock has no
 *   function `now`.
 * @example
 * ```ts
 * const signIn = createBearerSignIn({ tokensFile, clock: systemClock });
 * const result = await signIn(request.headers.get('authorization'));
 * if (!result.ok) refuse(result.reason);
 * ```
 */
export function createBearerSignIn(options: BearerSignInOptions): BearerSignIn {
  const { tokensFile, clock, fs } = options;
  if (
    typeof tokensFile !== 'string' ||
    typeof (clock as Partial<Clock> | null)?.now !== 'function'
  ) {
    throw new TypeError(
      'The check of the sign-in needs the file of the tokens and a clock.',
    );
  }
  const check = (authorization: unknown): SignInResult => {
    const presented = presentedOf(authorization);
    if (presented.kind !== 'token') return refuse(presented.kind);
    const problem = bearerTokenFormProblem(presented.text);
    if (problem !== undefined) return refuse(problem);
    // A time that is no date throws here, a day before 1970 in the lookup.
    const today = new Date(clock.now()).toISOString().slice(0, 10);
    const read = readBearerTokensFile(tokensFile, fs);
    if (!read.ok) return refuse('tokens_file');
    const found = findBearerToken(read.entries, presented.text, today);
    if (!found.ok) return refuse(found.reason);
    return Object.freeze({
      __proto__: null,
      ok: true,
      identity: Object.freeze({
        __proto__: null,
        source: 'bearer',
        subject: found.entry.name,
        scopes: found.entry.scopes,
      }),
    });
  };
  return (authorization) => {
    try {
      return Promise.resolve(check(authorization));
    } catch {
      return Promise.resolve(refuse('failed'));
    }
  };
}
