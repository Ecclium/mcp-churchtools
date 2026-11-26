import { Buffer } from 'node:buffer';
import * as crypto from 'node:crypto';
import { crc32 } from 'node:zlib';

import { describe, expect, it, vi } from 'vitest';

import {
  type BearerTokenEntry,
  bearerTokenBodyLength,
  bearerTokenChecksumLength,
  bearerTokenFormProblem,
  bearerTokenLength,
  bearerTokenPrefix,
  createBearerToken,
  findBearerToken,
  hashBearerToken,
  isBearerTokenName,
} from './token.js';

// Counts the comparisons of the lookup, which must not stop at a match.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

// No token stands in this file as a literal: the rule of .gitleaks.toml
// would find it. Every token comes into being at run time.
const fixed = (byte: number) => (size: number) =>
  new Uint8Array(size).fill(byte);

const alphabet =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

// Base62 written out a second way, for the expected checksum.
const base62 = (value: number, length: number): string => {
  let rest = value;
  let text = '';
  do {
    text = alphabet.charAt(rest % 62) + text;
    rest = Math.floor(rest / 62);
  } while (rest > 0);
  return text.padStart(length, '0');
};

const entry = (
  token: string,
  overrides: Partial<BearerTokenEntry> = {},
): BearerTokenEntry => ({
  name: 'claude-code-office',
  sha256: hashBearerToken(token),
  scopes: ['read'],
  createdAt: '2026-11-26',
  expiresAt: '2027-05-25',
  ...overrides,
});

// The same token with one character of its random part changed.
const changed = (token: string, at: number): string => {
  const index = bearerTokenPrefix.length + at;
  const old = token.charAt(index);
  const next = old === 'a' ? 'b' : 'a';
  return token.slice(0, index) + next + token.slice(index + 1);
};

describe('createBearerToken', () => {
  it('writes the prefix, 43 characters of Base62 and 6 of the checksum', () => {
    const token = createBearerToken();
    expect(token).toHaveLength(bearerTokenLength);
    expect(bearerTokenLength).toBe(12 + 43 + 6);
    expect(token.startsWith(bearerTokenPrefix)).toBe(true);
    expect(token.slice(bearerTokenPrefix.length)).toMatch(/^[0-9A-Za-z]{49}$/);
  });

  it('turns 32 zero bytes into zeros and 32 bytes of 255 into 43 characters', () => {
    const zeros = createBearerToken(fixed(0));
    const body = '0'.repeat(bearerTokenBodyLength);
    expect(zeros).toBe(
      `${bearerTokenPrefix}${body}${base62(crc32(body), bearerTokenChecksumLength)}`,
    );
    const ones = createBearerToken(fixed(255));
    // 2^256 - 1 needs all 43 characters and no more.
    expect(ones).toHaveLength(bearerTokenLength);
    expect(ones.charAt(bearerTokenPrefix.length)).not.toBe('0');
    expect(bearerTokenFormProblem(ones)).toBeUndefined();
  });

  it('asks for 32 bytes and refuses a source that gives another number', () => {
    const asked: number[] = [];
    createBearerToken((size) => {
      asked.push(size);
      return new Uint8Array(size);
    });
    expect(asked).toEqual([32]);
    expect(() => createBearerToken(() => new Uint8Array(31))).toThrow(
      TypeError,
    );
    expect(() =>
      createBearerToken(() => [1, 2, 3] as unknown as Uint8Array),
    ).toThrow(TypeError);
  });

  it('gives a new token on every call', () => {
    const tokens = new Set(
      Array.from({ length: 200 }, () => createBearerToken()),
    );
    expect(tokens.size).toBe(200);
  });
});

describe('bearerTokenFormProblem', () => {
  it('takes every token it made', () => {
    for (let index = 0; index < 200; index += 1) {
      expect(bearerTokenFormProblem(createBearerToken())).toBeUndefined();
    }
  });

  it('refuses another type, length, prefix or character as form', () => {
    const token = createBearerToken();
    const tail = token.slice(bearerTokenPrefix.length);
    for (const text of [
      undefined,
      null,
      42,
      { toString: () => token },
      '',
      token.slice(0, -1),
      `${token}0`,
      ` ${token}`,
      `ecclium_mcq_${tail}`,
      `ECCLIUM_MCP_${tail}`,
      `${bearerTokenPrefix}${tail.slice(0, -1)}_`,
      `${bearerTokenPrefix}${tail.slice(0, -1)}-`,
      `${bearerTokenPrefix}${tail.slice(0, -1)}ä`,
    ]) {
      expect(bearerTokenFormProblem(text)).toBe('form');
    }
  });

  it('refuses a token with one changed character as checksum, in every place', () => {
    const token = createBearerToken();
    for (
      let at = 0;
      at < bearerTokenBodyLength + bearerTokenChecksumLength;
      at += 1
    ) {
      expect(bearerTokenFormProblem(changed(token, at))).toBe('checksum');
    }
  });
});

describe('hashBearerToken', () => {
  it('is the SHA-256 of the characters in lowercase hex', () => {
    const token = createBearerToken();
    expect(hashBearerToken(token)).toBe(
      crypto.createHash('sha256').update(Buffer.from(token)).digest('hex'),
    );
    expect(hashBearerToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a text that is no token, without naming it', () => {
    const text = `${createBearerToken()}x`;
    expect(() => hashBearerToken(text)).toThrow(TypeError);
    try {
      hashBearerToken(text);
    } catch (error) {
      expect(String(error)).not.toContain(text.slice(12, 30));
    }
  });
});

describe('the name of a token', () => {
  it('is neutral: lowercase letters, digits and hyphens, at most 32 characters', () => {
    for (const name of ['a', 'claude-code-office', `a${'b'.repeat(31)}`]) {
      expect(isBearerTokenName(name)).toBe(true);
    }
    for (const name of [
      undefined,
      42,
      '',
      '1claude',
      '-claude',
      'Claude',
      'claude code',
      'claude.code',
      'claude@office',
      'claude_code',
      `a${'b'.repeat(32)}`,
    ]) {
      expect(isBearerTokenName(name)).toBe(false);
    }
  });
});

describe('findBearerToken', () => {
  const today = '2026-11-26';

  it('finds the entry of a known token', () => {
    const token = createBearerToken();
    const other = createBearerToken();
    const entries = [entry(other, { name: 'other' }), entry(token)];
    const found = findBearerToken(entries, token, today);
    expect(found).toEqual({ ok: true, entry: entries[1] });
  });

  it('refuses form and checksum before it hashes anything', () => {
    const token = createBearerToken();
    const entries = [entry(token)];
    const compare = vi.mocked(crypto.timingSafeEqual);
    compare.mockClear();
    expect(findBearerToken(entries, 'Bearer x', today)).toEqual({
      ok: false,
      reason: 'form',
    });
    expect(findBearerToken(entries, changed(token, 3), today)).toEqual({
      ok: false,
      reason: 'checksum',
    });
    expect(compare).not.toHaveBeenCalled();
  });

  it('refuses a token of the right form that no entry has as unknown', () => {
    const entries = [entry(createBearerToken())];
    expect(findBearerToken(entries, createBearerToken(), today)).toEqual({
      ok: false,
      reason: 'unknown',
    });
    expect(findBearerToken([], createBearerToken(), today)).toEqual({
      ok: false,
      reason: 'unknown',
    });
  });

  it('holds until the end of the day expiresAt and refuses the day after as expired', () => {
    const token = createBearerToken();
    const entries = [entry(token, { expiresAt: '2026-11-26' })];
    expect(findBearerToken(entries, token, '2026-11-26').ok).toBe(true);
    expect(findBearerToken(entries, token, '2026-11-27')).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('refuses an entry whose first day lies ahead as not yet valid', () => {
    const token = createBearerToken();
    const entries = [
      entry(token, { createdAt: '2026-11-27', expiresAt: '2027-05-26' }),
    ];
    expect(findBearerToken(entries, token, '2026-11-26')).toEqual({
      ok: false,
      reason: 'not_yet_valid',
    });
    expect(findBearerToken(entries, token, '2026-11-27').ok).toBe(true);
  });

  it('refuses a day that is none, so that an expired token never passes', () => {
    const token = createBearerToken();
    const entries = [entry(token, { expiresAt: '2026-11-25' })];
    for (const day of ['', '26.11.2026', '2026-02-30', 20261126, new Date()]) {
      expect(() =>
        findBearerToken(entries, token, day as unknown as string),
      ).toThrow(TypeError);
    }
  });

  it('compares the hash with every entry, also after a match', () => {
    const token = createBearerToken();
    const entries = [
      entry(token),
      ...Array.from({ length: 9 }, (_, index) =>
        entry(createBearerToken(), { name: `other-${String(index)}` }),
      ),
    ];
    const compare = vi.mocked(crypto.timingSafeEqual);
    compare.mockClear();
    expect(findBearerToken(entries, token, today).ok).toBe(true);
    expect(compare).toHaveBeenCalledTimes(10);
    compare.mockClear();
    expect(findBearerToken(entries, createBearerToken(), today).ok).toBe(false);
    expect(compare).toHaveBeenCalledTimes(10);
  });

  it('returns frozen results without a prototype', () => {
    const token = createBearerToken();
    const found = findBearerToken([entry(token)], token, today);
    const refused = findBearerToken([], token, today);
    for (const result of [found, refused]) {
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.getPrototypeOf(result)).toBeNull();
    }
  });
});
