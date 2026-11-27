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
import {
  bearerLastUseKey,
  type Clock,
  type IsoDate,
  type Logger,
  type QuotaStore,
} from '@ecclium/mcp-churchtools-plugin-api';

import type { ConfigFileSystem } from '../config/text-file.js';
import type { SignInRefusal, SignInResult } from '../identity/refusals.js';
import { quotaTimeoutMs } from '../quota/budget.js';
import { defaultTenantId, toTenantId } from '../tenant/tenant-id.js';
import { readBearerTokensFile } from './file.js';
import { bearerTokenFormProblem, findBearerToken } from './token.js';

/** Where a check of the sign-in notes the last use of each token. */
export interface BearerLastUse {
  /**
   * The store of quotas, which keeps one day per name of a token and
   * tenant (ADR 0074, ADR 0063).
   */
  readonly store: QuotaStore;
  /** Receives `http_last_use_failed` when the store fails. */
  readonly logger: Logger;
}

/** What {@link createBearerSignIn} needs. */
export interface BearerSignInOptions {
  /** The file of the tokens, an absolute normalised path. */
  readonly tokensFile: string;
  /** The clock; its UTC day decides whether a token holds. */
  readonly clock: Clock;
  /**
   * Where the check notes the day of each sign-in that holds, for the
   * tenant `default`, the one tenant of the free core. Without it nothing
   * is noted.
   */
  readonly lastUse?: BearerLastUse;
  /** The file functions of the reader, only for tests. */
  readonly fs?: ConfigFileSystem;
}

/**
 * Reads the day a token was last used, where the check of the sign-in
 * notes it: for the tenant `default` under `bearer:<name>` (ADR 0074).
 *
 * @param store - The store of quotas over the folder of state of the
 *   server.
 * @param name - The name of the token.
 * @returns The day, or `undefined` when none is kept. It rejects when the
 *   name has not the form of a name or the store fails.
 * @example
 * ```ts
 * await readBearerLastUse(store, 'claude-code-office'); // '2026-11-26'
 * ```
 */
export function readBearerLastUse(
  store: QuotaStore,
  name: string,
): Promise<IsoDate | undefined> {
  return Promise.resolve().then(() => {
    const tenantId = toTenantId(defaultTenantId);
    if (tenantId === undefined) throw new TypeError('no tenant');
    return store.readLastUse(tenantId, bearerLastUseKey(name));
  });
}

// The event of a store that could not note a last use. It carries no
// field: the name of the token stays out of the log.
const lastUseFailedEvent = 'http_last_use_failed';

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
 * With `lastUse` the check then notes the day in the store and waits for
 * it, at most five seconds, as the pipeline waits for the store, so that
 * the day stands once the request goes on. A store that fails or answers
 * too late never refuses the sign-in: the check writes
 * `http_last_use_failed` and lets it pass. The file store writes only when
 * the day changes and waits at most two seconds for the lock of another
 * process (ADR 0063).
 *
 * @param options - The file of the tokens, the clock, the store of the
 *   last use and, for tests, the file functions.
 * @returns The check. Its promise never rejects: a failure of the check
 *   itself is the reason `failed`.
 * @throws {TypeError} When the path is no string, the clock has no
 *   function `now`, or `lastUse` lacks its store or its logger.
 * @example
 * ```ts
 * const signIn = createBearerSignIn({ tokensFile, clock: systemClock,
 *   lastUse: { store, logger } });
 * const result = await signIn(request.headers.get('authorization'));
 * if (!result.ok) refuse(result.reason);
 * ```
 */
export function createBearerSignIn(options: BearerSignInOptions): BearerSignIn {
  const { tokensFile, clock, fs, lastUse } = options;
  if (
    typeof tokensFile !== 'string' ||
    typeof (clock as Partial<Clock> | null)?.now !== 'function' ||
    (lastUse !== undefined &&
      (typeof (lastUse.store as Partial<QuotaStore> | null)?.noteLastUse !==
        'function' ||
        typeof (lastUse.logger as unknown) !== 'object' ||
        (lastUse.logger as unknown) === null))
  ) {
    throw new TypeError(
      'The check of the sign-in needs the file of the tokens and a clock.',
    );
  }
  const tenantId = toTenantId(defaultTenantId);
  const check = (
    authorization: unknown,
  ): { readonly result: SignInResult; readonly today?: IsoDate } => {
    const presented = presentedOf(authorization);
    if (presented.kind !== 'token') return { result: refuse(presented.kind) };
    const problem = bearerTokenFormProblem(presented.text);
    if (problem !== undefined) return { result: refuse(problem) };
    // A time that is no date throws here, a day before 1970 in the lookup.
    const today = new Date(clock.now()).toISOString().slice(0, 10) as IsoDate;
    const read = readBearerTokensFile(tokensFile, fs);
    if (!read.ok) return { result: refuse('tokens_file') };
    const found = findBearerToken(read.entries, presented.text, today);
    if (!found.ok) return { result: refuse(found.reason) };
    return {
      today,
      result: Object.freeze({
        __proto__: null,
        ok: true,
        identity: Object.freeze({
          __proto__: null,
          source: 'bearer',
          subject: found.entry.name,
          scopes: found.entry.scopes,
        }),
      }),
    };
  };
  // Notes the day of a sign-in that holds, waiting at most as long as the
  // pipeline waits for the store of quotas (ADR 0063), so that a store
  // that never answers holds no request. Nothing here refuses it.
  const note = async (name: string, today: IsoDate): Promise<void> => {
    if (lastUse === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (tenantId === undefined) throw new TypeError('no tenant');
      const noted = Promise.resolve().then(() =>
        lastUse.store.noteLastUse(tenantId, bearerLastUseKey(name), today),
      );
      // A failure after the deadline must not end as an unhandled one.
      noted.catch(() => undefined);
      const late = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error('late'));
        }, quotaTimeoutMs);
      });
      await Promise.race([noted, late]);
    } catch {
      try {
        lastUse.logger.warn(lastUseFailedEvent);
      } catch {
        // The sign-in does not depend on the log.
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  return async (authorization) => {
    let checked: ReturnType<typeof check>;
    try {
      checked = check(authorization);
    } catch {
      return refuse('failed');
    }
    const { result, today } = checked;
    if (result.ok && today !== undefined) {
      await note(result.identity.subject, today);
    }
    return result;
  };
}
