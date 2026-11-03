import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  type EchoClaims,
  maxEchoTokenLength,
  mintEchoToken,
  readEchoToken,
} from './echo-token.js';

const secret = new Uint8Array(32).fill(5);
const claims: EchoClaims = {
  v: 1,
  planHash: 'a'.repeat(64),
  nonce: 'b'.repeat(32),
  principal: 'c'.repeat(64),
  summary: 'd'.repeat(64),
  issuedAt: 1_000,
};

// A token over any body, signed as the core signs one.
const signed = (body: string): string =>
  `${body}.${createHmac('sha256', secret).update(`ecclium.echo.v1.${body}`).digest('base64url')}`;

describe('the token of the echo', () => {
  it('gives back its claims, frozen, and holds no content', () => {
    const token = mintEchoToken(secret, claims);
    expect(token.length).toBeLessThanOrEqual(maxEchoTokenLength);
    const read = readEchoToken(secret, token);
    expect(read).toEqual(claims);
    expect(Object.isFrozen(read)).toBe(true);
  });

  it('counts for no other key, as after a restart', () => {
    const token = mintEchoToken(secret, claims);
    expect(readEchoToken(new Uint8Array(32).fill(6), token)).toBeUndefined();
  });

  it('refuses a token whose claims or HMAC changed', () => {
    const token = mintEchoToken(secret, claims);
    const [body = '', mac = ''] = token.split('.');
    const other = mintEchoToken(secret, { ...claims, nonce: 'e'.repeat(32) });
    const [otherBody = ''] = other.split('.');
    for (const value of [
      `${otherBody}.${mac}`,
      `${body}.${mac.slice(0, -2)}AA`,
      `${body}.${mac}.x`,
      `${body}.`,
      `.${mac}`,
      `${body}=.${mac}`,
      `${body}.${mac}`.padEnd(maxEchoTokenLength + 1, 'A'),
    ]) {
      expect(readEchoToken(secret, value)).toBeUndefined();
    }
  });

  it('refuses a body with a valid HMAC that holds no claims of its form', () => {
    expect(
      readEchoToken(secret, signed(Buffer.from('{').toString('base64url'))),
    ).toBeUndefined();
    const wrong = mintEchoToken(secret, { ...claims, v: 2 } as never);
    expect(readEchoToken(secret, wrong)).toBeUndefined();
  });

  it.each([undefined, null, 1, {}, ['a.b']])('refuses %j', (value) => {
    expect(readEchoToken(secret, value)).toBeUndefined();
  });
});
