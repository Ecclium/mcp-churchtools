/**
 * The token of the echo (ADR 0029): what a write tool hands the model when
 * the person confirms by echo, and what `ct_write_confirm` brings back.
 *
 * Where it stands in the way of a write: planning ends with a sealed plan
 * that waits in the `PlanStore`. The result of the write tool carries this
 * token and the summary of the plan; the model sends both back with
 * `ct_write_confirm`, so that the person sees them in the approval dialog
 * of the client. The core then checks the token, uses up its nonce, takes
 * the plan and commits it with a proof of the echo.
 *
 * The token is the claims as base64url JSON, a dot and an HMAC-SHA256 over
 * them with a random key of the pipeline that never leaves the process, so
 * no token of another process or of before a restart counts. The claims
 * name the plan by its hash and hold a nonce, an HMAC of the principal and
 * one of the summary, so that the summary the model sends must be exactly
 * the one the core made, and the time it was made. They hold no content
 * and no personal data. That a token counts once comes from its nonce in
 * the `NonceStore`, not from the token itself.
 *
 * @packageDocumentation
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

/** How long a token counts: as long as its plan waits, 600 seconds. */
export const echoTokenTtlMs = 600_000;

/** The longest token the core reads. */
export const maxEchoTokenLength = 1024;

/** What a token says. */
export interface EchoClaims {
  /** The version of the form of the claims. */
  readonly v: 1;
  /** The hash of the sealed plan. */
  readonly planHash: string;
  /** A nonce of 32 hex digits, used up by `ct_write_confirm`. */
  readonly nonce: string;
  /** The HMAC of tenant and actor of the call that planned. */
  readonly principal: string;
  /** The HMAC of the summary of the plan. */
  readonly summary: string;
  /** When the token was made, in milliseconds since the Unix epoch. */
  readonly issuedAt: number;
}

const hex = (length: number): z.ZodString =>
  z.string().regex(new RegExp(`^[0-9a-f]{${String(length)}}$`));

const claimsSchema = z.strictObject({
  v: z.literal(1),
  planHash: hex(64),
  nonce: hex(32),
  principal: hex(64),
  summary: hex(64),
  issuedAt: z.int().min(0),
});

// The letters of base64url without padding; a part has at least one.
const isPart = (value: string): boolean => {
  if (value.length === 0) return false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charAt(index);
    const fits =
      (character >= 'A' && character <= 'Z') ||
      (character >= 'a' && character <= 'z') ||
      (character >= '0' && character <= '9') ||
      character === '-' ||
      character === '_';
    if (!fits) return false;
  }
  return true;
};

const macOf = (secret: Uint8Array, body: string): Buffer =>
  createHmac('sha256', secret).update(`ecclium.echo.v1.${body}`).digest();

/**
 * Makes a token from its claims.
 *
 * @param secret - The key of the pipeline, 32 random bytes.
 * @param claims - What the token says.
 * @returns The token: base64url claims, a dot and base64url HMAC.
 * @example
 * ```ts
 * const token = mintEchoToken(secret, claims); // 'eyJ2Ijox….Zm9v…'
 * ```
 */
export function mintEchoToken(secret: Uint8Array, claims: EchoClaims): string {
  const body = Buffer.from(JSON.stringify(claims), 'utf8').toString(
    'base64url',
  );
  return `${body}.${macOf(secret, body).toString('base64url')}`;
}

/**
 * Reads a token the model sent: its form, its HMAC and its claims. It does
 * not look at the time or the nonce, which the caller checks.
 *
 * @param secret - The key of the pipeline.
 * @param value - Any value, such as the token a call sent.
 * @returns The claims, frozen, or undefined for anything that is no token
 *   of this key.
 * @example
 * ```ts
 * readEchoToken(secret, 'forged.token'); // undefined
 * ```
 */
export function readEchoToken(
  secret: Uint8Array,
  value: unknown,
): EchoClaims | undefined {
  if (typeof value !== 'string' || value.length > maxEchoTokenLength) {
    return undefined;
  }
  const parts = value.split('.');
  const [body = '', mac = ''] = parts;
  if (parts.length !== 2 || !isPart(body) || !isPart(mac)) return undefined;
  const given = Buffer.from(mac, 'base64url');
  const expected = macOf(secret, body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  const claims = claimsSchema.safeParse(parsed);
  return claims.success ? Object.freeze(claims.data) : undefined;
}
