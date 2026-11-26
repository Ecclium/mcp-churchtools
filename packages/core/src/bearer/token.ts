/**
 * The static bearer tokens of the server over HTTP (ADR 0074): their form,
 * how one comes into being, its hash and the lookup of a presented token
 * among the entries of the file of the tokens.
 *
 * A token is `ecclium_mcp_`, then 43 characters of Base62 from 32 random
 * bytes (256 bits), then 6 characters of Base62 with the CRC32 of the 43.
 * The prefix lets a scanner of secrets find a token without context, and
 * the checksum lets the server refuse a mistyped or made-up token before
 * it looks anything up. The checksum is no protection: anyone can compute
 * it, and an unknown token with a valid one is refused all the same.
 *
 * The server keeps only the SHA-256 of a token. A lookup hashes the
 * presented token and compares the hash with every entry in constant
 * time, without stopping at the first match, so that the time of an
 * answer says nothing about which entry came close.
 *
 * Nothing here logs, throws or returns a token or a part of one, except
 * {@link createBearerToken}, whose caller hands it to the operator once.
 *
 * @packageDocumentation
 */
import { Buffer } from 'node:buffer';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { crc32 } from 'node:zlib';

import { isIsoDate } from '@ecclium/mcp-churchtools-plugin-api';

/** The prefix of every token, which `.gitleaks.toml` looks for. */
export const bearerTokenPrefix = 'ecclium_mcp_';

/** The characters of the random part: 32 bytes in Base62. */
export const bearerTokenBodyLength = 43;

/** The characters of the checksum: the CRC32 of the random part in Base62. */
export const bearerTokenChecksumLength = 6;

/** The length of a whole token. */
export const bearerTokenLength =
  bearerTokenPrefix.length + bearerTokenBodyLength + bearerTokenChecksumLength;

/** The bytes of randomness in a token: 256 bits. */
export const bearerTokenRandomBytes = 32;

// The name of a token: neutral, never the name of a person, because it
// becomes the actor `bearer:<name>` in the audit (ADR 0074). Anchored and
// bounded; the entry of core hands out no pattern, only the check below.
const namePattern = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Tells whether a value is a name of a token: a lowercase letter, then up
 * to 31 lowercase letters, digits and hyphens, such as `claude-code-office`.
 *
 * @param value - Any value.
 * @returns Whether it is such a name.
 * @example
 * ```ts
 * isBearerTokenName('claude-code-office'); // true
 * isBearerTokenName('max.mustermann@example.org'); // false
 * ```
 */
export function isBearerTokenName(value: unknown): value is string {
  return typeof value === 'string' && namePattern.test(value);
}

/** What a token may grant: reading, and writing as well. */
export type BearerScope = 'read' | 'write';

/** One entry of the file of the tokens, as the server reads it. */
export interface BearerTokenEntry {
  /** The neutral name, such as `claude-code-office`. */
  readonly name: string;
  /** The SHA-256 of the whole token, 64 lowercase hex characters. */
  readonly sha256: string;
  /** `['read']` or `['read', 'write']`. */
  readonly scopes: readonly BearerScope[];
  /** The UTC day the token came into being, `YYYY-MM-DD`. */
  readonly createdAt: string;
  /** The last UTC day the token holds, `YYYY-MM-DD`, until its end. */
  readonly expiresAt: string;
}

/**
 * Why a presented token is refused: it has not the form of a token, its
 * checksum is wrong, no entry has its hash, the entry has expired, or its
 * first day lies ahead. A revoked token has no entry any more, so it is
 * unknown.
 */
export type BearerRefusal =
  'form' | 'checksum' | 'unknown' | 'expired' | 'not_yet_valid';

/** The entry of a presented token, or why there is none. */
export type BearerLookup =
  | { readonly ok: true; readonly entry: BearerTokenEntry }
  | { readonly ok: false; readonly reason: BearerRefusal };

// Base62 in the order of ASCII, as most tokens of this form use it.
const alphabet =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const base = 62n;

// The characters after the prefix, 43 and 6: anchored, of a fixed length,
// so that it costs nothing on a long text. token.test.ts checks the number
// against the two lengths.
const tailPattern = /^[0-9A-Za-z]{49}$/;

// A whole number in Base62, left-padded with zeros to a fixed length. The
// callers pass numbers that fit: 62^43 is just above 2^256, and 62^6 above
// 2^32.
const toBase62 = (value: bigint, length: number): string => {
  let rest = value;
  let text = '';
  while (rest > 0n) {
    text = alphabet.charAt(Number(rest % base)) + text;
    rest /= base;
  }
  return text.padStart(length, '0');
};

// The checksum of a random part: its CRC32 over the ASCII characters.
const checksumOf = (body: string): string =>
  toBase62(BigInt(crc32(body)), bearerTokenChecksumLength);

/**
 * Makes a new token from 32 bytes of a secure random generator.
 *
 * @param random - The source of the bytes, only for tests; it must give
 *   exactly the bytes asked for.
 * @returns The token. It is a secret: the caller hands it to the operator
 *   once and keeps only its hash.
 * @throws {TypeError} When the source gives no 32 bytes.
 * @example
 * ```ts
 * const token = createBearerToken();
 * token.startsWith(bearerTokenPrefix); // true
 * token.length === bearerTokenLength; // true
 * ```
 */
export function createBearerToken(
  random: (size: number) => Uint8Array = randomBytes,
): string {
  const bytes = random(bearerTokenRandomBytes);
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length !== bearerTokenRandomBytes
  ) {
    throw new TypeError('The source of randomness gave no 32 bytes.');
  }
  const value = BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
  const body = toBase62(value, bearerTokenBodyLength);
  return `${bearerTokenPrefix}${body}${checksumOf(body)}`;
}

/**
 * Checks the form of a presented text before any lookup: prefix, length,
 * characters and checksum.
 *
 * @param text - What a client presented, of any type.
 * @returns `undefined` for the form of a token, else `form` or
 *   `checksum`. It never throws.
 * @example
 * ```ts
 * bearerTokenFormProblem(createBearerToken()); // undefined
 * bearerTokenFormProblem('ecclium_mcp_short'); // 'form'
 * ```
 */
export function bearerTokenFormProblem(
  text: unknown,
): 'form' | 'checksum' | undefined {
  if (
    typeof text !== 'string' ||
    text.length !== bearerTokenLength ||
    !text.startsWith(bearerTokenPrefix)
  ) {
    return 'form';
  }
  const tail = text.slice(bearerTokenPrefix.length);
  if (!tailPattern.test(tail)) return 'form';
  const body = tail.slice(0, bearerTokenBodyLength);
  const checksum = tail.slice(bearerTokenBodyLength);
  return checksum === checksumOf(body) ? undefined : 'checksum';
}

/**
 * The hash the file of the tokens keeps for a token: SHA-256 over its
 * characters, in lowercase hex.
 *
 * @param token - A token of the form of {@link createBearerToken}.
 * @returns 64 lowercase hex characters.
 * @throws {TypeError} When the text has not the form of a token; the
 *   message never holds it.
 * @example
 * ```ts
 * hashBearerToken(createBearerToken()).length; // 64
 * ```
 */
export function hashBearerToken(token: string): string {
  if (bearerTokenFormProblem(token) !== undefined) {
    throw new TypeError('The text has not the form of a bearer token.');
  }
  return createHash('sha256').update(token, 'ascii').digest('hex');
}

/**
 * Looks up a presented token among the entries of the file. The form comes
 * first, then the hash, compared with every entry in constant time, then
 * the days: a token holds from the UTC day `createdAt` until the end of
 * the UTC day `expiresAt`. An entry whose first day lies ahead, written on
 * a host whose clock ran ahead or by hand, holds not yet, so that neither
 * the limit of 365 days nor the one of a rotation can be stretched.
 *
 * @param entries - The entries of the file of the tokens, as read.
 * @param presented - What the client presented, of any type.
 * @param today - The current UTC day, `YYYY-MM-DD`.
 * @returns The entry, or the reason of the refusal. It never throws for a
 *   presented value, and never names it.
 * @throws {TypeError} When the day is no day of the calendar, so that a
 *   fault of the caller never lets an expired token pass.
 * @example
 * ```ts
 * const found = findBearerToken(entries, presented, '2026-11-26');
 * if (!found.ok) refuse(found.reason);
 * ```
 */
export function findBearerToken(
  entries: readonly BearerTokenEntry[],
  presented: unknown,
  today: string,
): BearerLookup {
  if (!isIsoDate(today)) {
    throw new TypeError('The current day is no day of the calendar.');
  }
  const problem = bearerTokenFormProblem(presented);
  if (problem !== undefined) {
    return Object.freeze({ __proto__: null, ok: false, reason: problem });
  }
  const digest = createHash('sha256')
    .update(presented as string, 'ascii')
    .digest();
  let found: BearerTokenEntry | undefined;
  // Every entry is compared, also after a match: the time of the lookup
  // depends only on the number of entries.
  for (const entry of entries) {
    const stored = Buffer.from(entry.sha256, 'hex');
    const equal =
      stored.length === digest.length && timingSafeEqual(stored, digest);
    if (equal && found === undefined) found = entry;
  }
  if (found === undefined) {
    return Object.freeze({ __proto__: null, ok: false, reason: 'unknown' });
  }
  if (today > found.expiresAt) {
    return Object.freeze({ __proto__: null, ok: false, reason: 'expired' });
  }
  if (today < found.createdAt) {
    return Object.freeze({
      __proto__: null,
      ok: false,
      reason: 'not_yet_valid',
    });
  }
  return Object.freeze({ __proto__: null, ok: true, entry: found });
}
